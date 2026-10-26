"""New offline concurrency contracts; runnable against an extracted desktop ZIP.

  python -I -B desktop/test_concurrency.py --app-root /path/to/MyVideoApp -v

Only dependency, extractor, downloader and child-process boundaries are faked.
The real Engine lifecycle, stage budgets, publication and SQLite store run here.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest


_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parent.parent)
_options, _test_arguments = _parser.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
if not (APP_ROOT / "desktop" / "engine.py").is_file():
    raise SystemExit("--app-root must contain desktop/engine.py")
sys.path.insert(0, str(APP_ROOT / "desktop"))

import concurrency as policy
import engine as subject
from storage import Storage


TIMEOUT = 12.0
MEDIA = b"\0\0\0\x18ftypisom" + b"\0" * 100


class ObservableBudget(policy.ResourceBudget):
    """Add test notifications without replacing any acquisition behavior."""
    def __init__(self, capacities=None):
        super().__init__(capacities)
        self.changed = threading.Condition()

    @contextmanager
    def hold(self, resource, cancel, units=1, *, on_wait=None):
        def waiting():
            if on_wait:
                on_wait()
            with self.changed:
                self.changed.notify_all()
        with super().hold(resource, cancel, units, on_wait=waiting) as granted:
            yield granted

    def wait_for_waiters(self, resource, count):
        with self.changed:
            if not self.changed.wait_for(lambda: self.snapshot()[resource]["waiting"] >= count, TIMEOUT):
                raise AssertionError(f"No {count} waiters for {resource}: {self.snapshot()}")


class Boundary:
    """Event/condition controlled fake external I/O, with measured overlap."""
    def __init__(self):
        self.condition = threading.Condition()
        self.blocked = set()
        self.released = set()
        self.active = {}
        self.peak = {}
        self.entered = {}
        self.options = []

    @contextmanager
    def enter(self, stage, key, cancel):
        with self.condition:
            self.active[stage] = self.active.get(stage, 0) + 1
            self.peak[stage] = max(self.peak.get(stage, 0), self.active[stage])
            self.entered.setdefault(stage, []).append(key)
            self.condition.notify_all()
        try:
            with self.condition:
                deadline = time.monotonic() + TIMEOUT
                while stage in self.blocked and (stage, key) not in self.released:
                    subject._check_cancel(cancel)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subject.EngineError("Offline boundary did not receive its release event.")
                    self.condition.wait(min(.05, remaining))
            subject._check_cancel(cancel)
            yield
        finally:
            with self.condition:
                self.active[stage] -= 1
                self.condition.notify_all()

    def wait_for(self, stage, count):
        with self.condition:
            if not self.condition.wait_for(lambda: len(self.entered.get(stage, [])) >= count, TIMEOUT):
                raise AssertionError(f"Expected {count} real {stage} calls, got {self.entered}")

    def release(self, stage=None, key=None):
        with self.condition:
            if stage is None:
                self.blocked.clear()
            elif key is None:
                self.blocked.discard(stage)
            else:
                self.released.add((stage, key))
            self.condition.notify_all()


class FakeDownloader:
    def __init__(self, owner, options):
        self.owner, self.options = owner, options
        with owner.boundary.condition:
            owner.boundary.options.append(options)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def dl(self, filename, info):
        with self.owner.boundary.enter("network", info["id"], self.owner.local.cancel):
            Path(filename).write_bytes(MEDIA)
            for hook in self.options["progress_hooks"]:
                hook({"status": "downloading", "downloaded_bytes": len(MEDIA), "total_bytes": len(MEDIA)})
        return True, True


class OfflineEngine(subject.Engine):
    def __init__(self, root, boundary, resources=None, protocol="https"):
        super().__init__(APP_ROOT, root / "data", resources=resources)
        self.boundary, self.protocol = boundary, protocol
        self.local = threading.local()
        self.folder = root / "downloads"
        self.folder.mkdir(parents=True)

    def _dependencies(self, youtube, cancel):
        self.local.cancel = cancel
        return SimpleNamespace(YoutubeDL=lambda options: FakeDownloader(self, options)), Path("deno.exe"), Path("ffmpeg.exe"), Path("ffprobe.exe")

    def _extract_isolated(self, url, youtube, quality, output, cancel):
        key = url.rsplit("/", 1)[-1].split("?", 1)[0]
        self.local.key = key
        with self.boundary.enter("metadata", key, cancel):
            return {"id": key, "title": key, "duration": 1, "formats": [{
                "format_id": "combined", "url": url, "ext": "mp4", "height": 720,
                "vcodec": "avc1.640028", "acodec": "mp4a.40.2", "filesize": len(MEDIA),
                "protocol": self.protocol}]}

    def _run(self, arguments, cancel, **_):
        subject._check_cancel(cancel)
        if arguments[0] == "ffprobe.exe":
            return json.dumps({"streams": [{"codec_type": "video"}, {"codec_type": "audio"}]}).encode()
        if arguments[0] == "ffmpeg.exe":
            with self.boundary.enter("processing", self.local.key, cancel):
                Path(arguments[-1]).write_bytes(MEDIA)
        return b""

    def _scan(self, path, cancel):
        with self.boundary.enter("scan", self.local.key, cancel):
            return "Offline scan completed."


class PolicyTests(unittest.TestCase):
    def test_strict_total_limits_keep_old_values_and_reject_malformed_values(self):
        self.assertEqual(policy.AUTO_CONCURRENT_DOWNLOADS, 0)
        self.assertEqual(policy.MAX_CONCURRENT_DOWNLOADS, 16)
        for value in range(17):
            self.assertEqual(policy.normalize_concurrency(value), value)
        for value in (None, True, False, "8", 8.0, -1, 17, [], {}):
            with self.subTest(value=value):
                self.assertEqual(policy.normalize_concurrency(value), 0)
                self.assertEqual(policy.normalize_concurrency(value, 2), 2)

    def test_auto_is_bounded_and_manual_choices_are_exact(self):
        for cpus in (1, 2, 3, 4, 8, 64, 256):
            self.assertGreaterEqual(policy.effective_concurrency(0, cpus), 2)
            self.assertLessEqual(policy.effective_concurrency(0, cpus), 4)
        for choice in (1, 2, 3, 8, 16):
            self.assertEqual(policy.effective_concurrency(choice, 1), choice)

    def test_fragment_budget_decreases_as_worker_count_increases(self):
        for setting, expected in ((1, 4), (2, 4), (4, 4), (8, 2), (16, 1)):
            self.assertEqual(policy.fragment_parallelism(setting), expected)

    def test_host_keys_share_youtube_aliases_and_preserve_other_hosts(self):
        aliases = ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be")
        self.assertEqual({policy.source_key(f"https://{host}/watch?v=abcdefghijk") for host in aliases}, {"youtube.com"})
        self.assertEqual(policy.source_key("https://MEDIA.Example.test.:8443/file.mp4"), "media.example.test")
        self.assertNotEqual(policy.source_key("https://a.example.test/file"), policy.source_key("https://b.example.test/file"))

    def test_settings_migrate_malformed_values_and_persist_legal_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Storage(Path(temporary))
            for total, host in ((True, 0), ("16", "4"), (1.5, 17), (100, None)):
                with self.subTest(total=total, host=host):
                    with store.connect() as database:
                        database.executemany("INSERT OR REPLACE INTO preferences(key,value) VALUES (?,?)", [
                            ("concurrent_downloads", json.dumps(total)), ("host_concurrent_downloads", json.dumps(host))])
                    self.assertEqual(store.settings()["concurrent_downloads"], 0)
                    self.assertEqual(store.settings()["host_concurrent_downloads"], 4)
            for total in (0, 1, 2, 8, 16):
                store.save_settings({"concurrent_downloads": total, "host_concurrent_downloads": 16})
                self.assertEqual(Storage(Path(temporary)).settings()["concurrent_downloads"], total)
                self.assertEqual(store.settings()["host_concurrent_downloads"], 16)

    def test_settings_save_rejects_non_integer_or_out_of_range_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = Storage(Path(temporary))
            for key, bad in (("concurrent_downloads", (True, 1.0, "2", -1, 17)), ("host_concurrent_downloads", (False, 4.0, "4", 0, 17))):
                for value in bad:
                    with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                        store.save_settings({key: value})


class BudgetTests(unittest.TestCase):
    def test_default_budgets_are_process_wide_and_snapshot_is_a_copy(self):
        budget = policy.ResourceBudget()
        self.assertEqual(budget.capacities, {"jobs": 16, "metadata": 2, "network": 16, "processing": 2, "scan": 1})
        capacities = budget.capacities
        capacities["network"] = 999
        self.assertEqual(budget.capacities["network"], 16)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = subject.Engine(APP_ROOT, root / "a")
            self.assertIs(first.resources, subject.Engine(APP_ROOT, root / "b").resources)
            self.assertIs(first.resources, policy.PROCESS_RESOURCES)
            self.assertIs(subject.ResourceCancelled, policy.ResourceCancelled)

    def test_weighted_fifo_does_not_partially_acquire_and_cancelled_head_unblocks(self):
        budget = policy.ResourceBudget({"network": 3})
        cancel = threading.Event()
        heavy_waiting, light_waiting, light_entered = (threading.Event() for _ in range(3))
        release_light = threading.Event()
        failures = []
        def heavy():
            try:
                with budget.hold("network", cancel, 2, on_wait=heavy_waiting.set):
                    failures.append("Cancelled heavy waiter entered.")
            except policy.ResourceCancelled:
                pass
        def light():
            try:
                with budget.hold("network", threading.Event(), 1, on_wait=light_waiting.set):
                    light_entered.set()
                    if not release_light.wait(TIMEOUT):
                        failures.append("Light waiter was not released.")
            except Exception as error:
                failures.append(repr(error))
        with budget.hold("network", threading.Event(), 2):
            a = threading.Thread(target=heavy)
            b = threading.Thread(target=light)
            a.start()
            self.assertTrue(heavy_waiting.wait(TIMEOUT))
            b.start()
            self.assertTrue(light_waiting.wait(TIMEOUT))
            try:
                self.assertFalse(light_entered.is_set())
                self.assertEqual(budget.snapshot()["network"]["used"], 2)
                cancel.set()
                self.assertTrue(light_entered.wait(TIMEOUT))
                self.assertEqual(budget.snapshot()["network"]["used"], 3)
            finally:
                cancel.set()
                release_light.set()
                a.join(TIMEOUT)
                b.join(TIMEOUT)
        self.assertFalse(a.is_alive() or b.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(budget.snapshot()["network"]["used"], 0)
        self.assertEqual(budget.snapshot()["network"]["waiting"], 0)

    def test_exception_and_pre_cancelled_acquisition_return_every_token(self):
        budget = policy.ResourceBudget({"processing": 1})
        with self.assertRaisesRegex(RuntimeError, "fixture"):
            with budget.hold("processing", threading.Event()):
                raise RuntimeError("fixture")
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(policy.ResourceCancelled):
            with budget.hold("processing", cancel):
                self.fail("Cancelled work entered its stage.")
        self.assertEqual(budget.snapshot()["processing"], {"capacity": 1, "used": 0, "waiting": 0})

    def test_invalid_weight_never_consumes_capacity(self):
        budget = policy.ResourceBudget({"network": 2})
        for units in (0, -1, 3, True, 1.5):
            with self.subTest(units=units), self.assertRaises(ValueError):
                with budget.hold("network", threading.Event(), units):
                    pass
        self.assertEqual(budget.snapshot()["network"]["used"], 0)


class EngineConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-new-concurrency-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.boundary = Boundary()
        self.threads = []
        self.cancels = {}
        self.outcomes = {}
        self.events = {}

    def tearDown(self):
        self.boundary.release()
        for cancel in self.cancels.values():
            cancel.set()
        for thread in self.threads:
            thread.join(TIMEOUT)
        self.assertFalse(any(thread.is_alive() for thread in self.threads), "A concurrency fixture leaked a worker.")

    def start(self, engine, count, *, scan=False):
        keys = []
        for index in range(count):
            key = f"job-{len(self.threads):02d}.mp4"
            cancel = self.cancels[key] = threading.Event()
            events = self.events[key] = []
            request = subject.DownloadRequest(f"https://media.example.test/{key}", engine.folder, scan=scan)
            def run(key=key, request=request, cancel=cancel, events=events):
                try:
                    self.outcomes[key] = engine.download(request, events.append, cancel)
                except Exception as error:
                    self.outcomes[key] = error
            thread = threading.Thread(target=run, name=key)
            self.threads.append(thread)
            keys.append(key)
            thread.start()
        return keys

    def finish(self, engines, expected):
        self.boundary.release()
        for thread in self.threads:
            thread.join(TIMEOUT)
        self.assertEqual(len(self.outcomes), expected)
        self.assertFalse(any(isinstance(value, Exception) for value in self.outcomes.values()), repr(self.outcomes))
        records = [row for engine in engines for row in engine.history()]
        self.assertEqual(len(records), expected)
        self.assertEqual({row["stage"] for row in records}, {"complete"})
        self.assertTrue(all(Path(row["filepath"]).is_file() for row in records))
        for engine in engines:
            self.assertTrue(all(row["used"] == row["waiting"] == 0 for row in engine.resources.snapshot().values()))

    def test_sixteen_actual_downloads_share_two_engines_and_seventeenth_waits(self):
        self.boundary.blocked.add("network")
        budget = ObservableBudget()
        engines = [OfflineEngine(self.root / name, self.boundary, budget) for name in ("first", "second")]
        for engine in engines:
            engine.save_settings({"concurrent_downloads": 16})
            self.start(engine, 8)
        self.boundary.wait_for("network", 16)
        self.start(engines[0], 1)
        budget.wait_for_waiters("jobs", 1)
        self.assertEqual(self.boundary.active["network"], 16)
        self.assertEqual(budget.snapshot()["jobs"]["used"], 16)
        self.assertEqual(budget.snapshot()["network"]["used"], 16)
        self.finish(engines, 17)
        self.assertEqual(self.boundary.peak["network"], 16)

    def test_metadata_processing_and_scan_have_independent_stage_caps(self):
        for stage, capacity in (("metadata", 2), ("processing", 2), ("scan", 1)):
            with self.subTest(stage=stage):
                boundary = self.boundary = Boundary()
                boundary.blocked.add(stage)
                budget = ObservableBudget()
                engine = OfflineEngine(self.root / stage, boundary, budget)
                before = len(self.threads)
                self.start(engine, 6, scan=stage == "scan")
                boundary.wait_for(stage, capacity)
                budget.wait_for_waiters(stage, 6 - capacity)
                self.assertEqual(boundary.active[stage], capacity)
                self.assertEqual(budget.snapshot()[stage]["used"], capacity)
                boundary.release()
                for thread in self.threads[before:]:
                    thread.join(TIMEOUT)
                self.assertEqual(boundary.peak[stage], capacity)
                self.assertEqual({row["stage"] for row in engine.history()}, {"complete"})
                self.assertEqual(len(engine.history()), 6)
                self.assertTrue(all(row["used"] == row["waiting"] == 0 for row in budget.snapshot().values()))

    def test_waiting_job_cancels_without_reaching_dependency_or_network_boundary(self):
        self.boundary.blocked.add("network")
        budget = ObservableBudget({"jobs": 2})
        engine = OfflineEngine(self.root, self.boundary, budget)
        keys = self.start(engine, 2)
        self.boundary.wait_for("network", 2)
        waiting = self.start(engine, 1)[0]
        budget.wait_for_waiters("jobs", 1)
        self.cancels[waiting].set()
        self.threads[-1].join(TIMEOUT)
        self.assertIsInstance(self.outcomes[waiting], subject.DownloadCancelled)
        self.assertNotIn(waiting, self.boundary.entered["metadata"])
        self.assertNotIn(waiting, self.boundary.entered["network"])
        self.assertEqual(budget.snapshot()["jobs"]["used"], 2)
        self.assertEqual(sum(row["stage"] == "cancelled" for row in engine.history()), 1)
        self.boundary.release()
        for thread in self.threads:
            thread.join(TIMEOUT)
        self.assertTrue(all(not isinstance(self.outcomes[key], Exception) for key in keys))
        self.assertTrue(all(row["used"] == row["waiting"] == 0 for row in budget.snapshot().values()))

    def test_fragment_leases_are_weighted_and_cancelling_a_waiter_returns_tokens(self):
        self.boundary.blocked.add("network")
        budget = ObservableBudget({"network": 4})
        engine = OfflineEngine(self.root, self.boundary, budget, protocol="m3u8_native")
        engine.save_settings({"concurrent_downloads": 1})
        first = self.start(engine, 1)[0]
        self.boundary.wait_for("network", 1)
        waiting = self.start(engine, 1)[0]
        budget.wait_for_waiters("network", 1)
        self.assertEqual(budget.snapshot()["network"]["used"], 4)
        self.assertEqual(self.boundary.options[0]["concurrent_fragment_downloads"], 4)
        self.cancels[waiting].set()
        self.threads[-1].join(TIMEOUT)
        self.assertIsInstance(self.outcomes[waiting], subject.DownloadCancelled)
        self.assertNotIn(waiting, self.boundary.entered["network"])
        self.boundary.release()
        self.threads[0].join(TIMEOUT)
        self.assertIsInstance(self.outcomes[first], subject.DownloadResult)
        self.assertTrue(any(event.stage == "waiting" for event in self.events[waiting]))
        self.assertTrue(all(row["used"] == row["waiting"] == 0 for row in budget.snapshot().values()))


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *_test_arguments])
