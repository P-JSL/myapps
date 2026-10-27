"""New native parallel transfer regressions using a real loopback origin.

python -I -B desktop/test_transfer.py --app-root EXTRACTED_APP -v
--benchmark-report PATH also persists the controlled local throughput results.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parents[1])
_parser.add_argument("--dependency-root", action="append", type=Path, default=[])
_parser.add_argument("--benchmark-report", type=Path)
_options, _test_arguments = _parser.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
for _root in reversed(_options.dependency_root):
    sys.path.insert(0, str(_root.resolve(strict=True)))
sys.path.insert(0, str(APP_ROOT / "desktop"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from desktop_transport_server import HTTPOrigin, MEDIA, ETAG
from concurrency import ResourceBudget
from transfer import download_file, TransferError, TransferCancelled
from transport import NativeTransport


_BENCHMARK_REPORT = {}


def save_benchmark(values):
    _BENCHMARK_REPORT.update(values)
    if _options.benchmark_report:
        _options.benchmark_report.parent.mkdir(parents=True, exist_ok=True)
        _options.benchmark_report.write_text(json.dumps(_BENCHMARK_REPORT, indent=2) + "\n", encoding="utf-8")


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="desktop-parallel-transfer-")
        self.directory = Path(self.temporary.name)
        self.resources = ResourceBudget()
        self.cancel = threading.Event()

    def tearDown(self):
        self.temporary.cleanup()

    def transfer(self, origin, path="/media", *, name="media.mp4", workers=4, **kwargs):
        destination = self.directory / name
        with NativeTransport(http3_enabled=False, max_connections=4) as client:
            result = download_file(origin.url + path, destination, transport=client,
                                   resources=self.resources, cancel=self.cancel, workers=workers, **kwargs)
        return destination, result

    def assertExact(self, destination, expected=MEDIA):
        self.assertEqual(destination.stat().st_size, len(expected))
        self.assertEqual(hashlib.sha256(destination.read_bytes()).digest(), hashlib.sha256(expected).digest())
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()), [destination.name])

    def assertBudgetReturned(self):
        snapshot = self.resources.snapshot()["network"]
        self.assertEqual(snapshot["used"], 0)
        self.assertEqual(snapshot["waiting"], 0)

    def test_real_four_range_download_has_exact_hash_and_monotonic_progress(self):
        progress, protocols, connections = [], [], []
        with HTTPOrigin(body_delay=.15) as origin:
            destination, result = self.transfer(origin, progress=lambda loaded, total: progress.append((loaded, total)),
                                                protocol=protocols.append, connections=connections.append)
            self.assertExact(destination)
            self.assertEqual(result.mode, "parallel")
            self.assertEqual(result.size, len(MEDIA))
            self.assertEqual(result.prefix, MEDIA[:65536])
            self.assertEqual(origin.state.range_peak, 4)
            worker_requests = [r for r in origin.state.requests if r["headers"].get("if-match")]
            self.assertGreaterEqual(len(worker_requests), 4)
            for request in worker_requests:
                self.assertEqual(request["headers"]["if-match"], ETAG)
                self.assertEqual(request["headers"]["if-range"], ETAG)
                self.assertEqual(request["headers"]["accept-encoding"], "identity")
            self.assertEqual([x[0] for x in progress], sorted(x[0] for x in progress))
            self.assertEqual(progress[-1], (len(MEDIA), len(MEDIA)))
            self.assertEqual(set(protocols), {"http/1.1"})
            self.assertIn(4, connections)
        self.assertBudgetReturned()

    def test_ignored_range_reuses_one_full_response_without_corruption(self):
        with HTTPOrigin() as origin:
            destination, result = self.transfer(origin, "/ignore")
            self.assertExact(destination)
            self.assertEqual(result.mode, "single")
            self.assertEqual(origin.state.counts["/ignore"], 1)
        self.assertBudgetReturned()

    def test_missing_or_weak_etag_falls_back_to_fresh_full_response(self):
        for path in ("/weak-etag", "/no-etag"):
            with self.subTest(path=path), HTTPOrigin() as origin:
                destination, result = self.transfer(origin, path)
                self.assertExact(destination)
                self.assertEqual(result.mode, "single")
                self.assertEqual(len([r for r in origin.state.requests if "range" not in r["headers"]]), 1)
                destination.unlink()
        self.assertBudgetReturned()

    def test_invalid_partial_responses_never_publish_a_file(self):
        for path in ("/bad-range", "/changed-etag", "/missing-etag", "/truncated", "/gzip", "/changed"):
            with self.subTest(path=path), HTTPOrigin() as origin:
                with self.assertRaises(TransferError):
                    self.transfer(origin, path)
                self.assertEqual(list(self.directory.iterdir()), [])
                self.assertBudgetReturned()

    def test_transient_503_and_429_retry_then_produce_exact_file(self):
        for path in ("/transient503", "/transient429"):
            with self.subTest(path=path), HTTPOrigin() as origin:
                destination, _ = self.transfer(origin, path)
                self.assertExact(destination)
                self.assertGreaterEqual(origin.state.counts[path], 3)
                destination.unlink()
        self.assertBudgetReturned()

    def test_cancel_during_retry_after_returns_tokens_promptly(self):
        with HTTPOrigin() as origin, ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.transfer, origin, "/wait429")
            self.assertTrue(origin.state.wait_for(lambda: origin.state.counts["/wait429"] >= 1))
            deadline = time.monotonic() + 2
            while self.resources.snapshot()["network"]["used"] and time.monotonic() < deadline:
                threading.Event().wait(.01)
            self.assertEqual(self.resources.snapshot()["network"]["used"], 0, "Retry backoff must release its request token")
            self.assertFalse(future.done(), "Fixture must exercise the retry wait")
            started = time.monotonic()
            self.cancel.set()
            with self.assertRaises(TransferCancelled):
                future.result(timeout=3)
            self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assertBudgetReturned()

    def test_cancel_while_global_budget_is_full_leaves_no_waiter(self):
        waiting = threading.Event()
        with HTTPOrigin() as origin, ThreadPoolExecutor(max_workers=1) as pool:
            with self.resources.hold("network", threading.Event(), units=16):
                future = pool.submit(self.transfer, origin, on_wait=waiting.set)
                self.assertTrue(waiting.wait(3))
                self.cancel.set()
                with self.assertRaises(TransferCancelled):
                    future.result(timeout=3)
                self.assertEqual(origin.state.requests, [])
            self.assertBudgetReturned()
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_four_files_share_global_sixteen_request_budget(self):
        observed = []
        stopped = threading.Event()
        def sample():
            while not stopped.wait(.002):
                observed.append(self.resources.snapshot()["network"]["used"])
        observer = threading.Thread(target=sample, daemon=True)
        observer.start()
        try:
            with HTTPOrigin(body_barrier=16) as origin, ThreadPoolExecutor(max_workers=4) as pool:
                futures = [pool.submit(self.transfer, origin, name=f"media-{n}.mp4") for n in range(4)]
                results = [future.result(timeout=20) for future in futures]
                for destination, result in results:
                    self.assertEqual(hashlib.sha256(destination.read_bytes()).digest(), hashlib.sha256(MEDIA).digest())
                    self.assertEqual(result.mode, "parallel")
                self.assertEqual(origin.state.range_peak, 16)
                self.assertLessEqual(origin.state.peak, 16)
        finally:
            stopped.set()
            observer.join(3)
        self.assertTrue(observed)
        self.assertEqual(max(observed), 16)
        self.assertBudgetReturned()

    def test_controlled_per_connection_rate_limit_benchmark(self):
        measurements = []
        rate = 4 * 1024 * 1024
        for workers in (1, 4):
            with HTTPOrigin(rate=rate) as origin:
                started = time.monotonic()
                destination, result = self.transfer(origin, workers=workers, name=f"rate-{workers}.mp4")
                elapsed = time.monotonic() - started
                self.assertEqual(hashlib.sha256(destination.read_bytes()).digest(), hashlib.sha256(MEDIA).digest())
                measurements.append({"workers": workers, "seconds": round(elapsed, 6), "bytes": len(MEDIA),
                                     "mib_per_second": round(len(MEDIA) / elapsed / 1024 ** 2, 4),
                                     "mode": result.mode, "peak_body_requests": origin.state.peak})
        report = {"fixture": "loopback HTTP/1.1", "per_connection_bytes_per_second": rate,
                  "scope": "Controlled local origin only; does not predict Internet download speed.",
                  "measurements": measurements, "parallel_speedup": round(measurements[0]["seconds"] / measurements[1]["seconds"], 4)}
        save_benchmark(report)
        print("DESKTOP_TRANSFER_BENCHMARK " + json.dumps(report, sort_keys=True), flush=True)
        self.assertLess(measurements[1]["seconds"], measurements[0]["seconds"] * .8)
        self.assertBudgetReturned()


    def test_controlled_simultaneous_four_file_benchmark(self):
        measurements = []
        rate = 4 * 1024 * 1024
        for workers in (1, 4):
            with HTTPOrigin(rate=rate) as origin, ThreadPoolExecutor(max_workers=4) as pool:
                started = time.monotonic()
                futures = [pool.submit(self.transfer, origin, workers=workers, name=f"concurrent-{workers}-{number}.mp4")
                           for number in range(4)]
                results = [future.result(timeout=20) for future in futures]
                elapsed = time.monotonic() - started
                for destination, result in results:
                    self.assertEqual(destination.stat().st_size, len(MEDIA))
                    self.assertEqual(hashlib.sha256(destination.read_bytes()).digest(), hashlib.sha256(MEDIA).digest())
                    self.assertEqual(result.mode, "single" if workers == 1 else "parallel")
                measurements.append({"files": 4, "per_file_workers": workers, "seconds": round(elapsed, 6),
                                     "total_bytes": 4 * len(MEDIA), "all_hashes_valid": True,
                                     "aggregate_mib_per_second": round(4 * len(MEDIA) / elapsed / 1024 ** 2, 4),
                                     "peak_body_requests": origin.state.peak,
                                     "peak_range_body_requests": origin.state.range_peak})
                self.assertLessEqual(origin.state.peak, 16)
                self.assertBudgetReturned()
        values = {"concurrent_measurements": measurements,
                  "concurrent_parallel_speedup": round(measurements[0]["seconds"] / measurements[1]["seconds"], 4),
                  "global_network_budget": 16}
        save_benchmark(values)
        print("DESKTOP_CONCURRENT_TRANSFER_BENCHMARK " + json.dumps(values, sort_keys=True), flush=True)
        self.assertLess(measurements[1]["seconds"], measurements[0]["seconds"] * .8)
        self.assertGreater(measurements[1]["peak_range_body_requests"], 4)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *_test_arguments])
