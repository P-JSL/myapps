"""New offline checks for the app-wide, live desktop bandwidth limiter."""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import sys
import threading
import time
import unittest


_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parent.parent)
_options, _test_arguments = _parser.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
sys.path.insert(0, str(APP_ROOT / "desktop"))

import bandwidth as subject


BLOCK = 64 * 1024


class BandwidthTests(unittest.TestCase):
    def start_consumer(self, limiter, amount, cancel=None):
        started = threading.Event()
        finished = threading.Event()
        errors = []

        def consume():
            started.set()
            try:
                limiter.consume(amount, cancel)
            except BaseException as error:
                errors.append(error)
            finally:
                finished.set()

        worker = threading.Thread(target=consume)
        worker.start()
        self.assertTrue(started.wait(1))
        self.addCleanup(lambda: worker.join(2))
        self.addCleanup(lambda: limiter.configure(False, 64))
        return worker, finished, errors

    def test_default_off_and_strict_configuration(self):
        limiter = subject.BandwidthLimiter()
        self.assertFalse(limiter.enabled)
        self.assertEqual(limiter.rate_kib, 10240)
        started = time.monotonic()
        limiter.consume(256 * 1024 * 1024, threading.Event())
        self.assertLess(time.monotonic() - started, .5)
        for enabled in (None, 0, 1, "true"):
            with self.subTest(enabled=enabled), self.assertRaises(ValueError):
                limiter.configure(enabled, 64)
        for rate in (None, True, 0, 63, 1048577, "10240", 64.0):
            with self.subTest(rate=rate), self.assertRaises(ValueError):
                limiter.configure(True, rate)
        self.assertFalse(limiter.enabled)
        self.assertEqual(limiter.rate_kib, 10240)
        for count in (True, -1, "64", 1.0):
            with self.subTest(count=count), self.assertRaises(ValueError):
                limiter.consume(count)

    def test_two_downloads_share_one_rate_and_one_initial_burst(self):
        limiter = subject.BandwidthLimiter(True, 64)
        ready = threading.Barrier(3)
        finished = []
        errors = []

        def download(name):
            try:
                ready.wait(timeout=2)
                limiter.consume(2 * BLOCK, threading.Event())
                finished.append(name)
            except BaseException as error:
                errors.append(error)

        workers = [threading.Thread(target=download, args=(name,)) for name in ("video", "audio")]
        for worker in workers:
            worker.start()
        started = time.monotonic()
        ready.wait(timeout=2)
        for worker in workers:
            worker.join(6)
        elapsed = time.monotonic() - started
        limiter.configure(False, 64)
        for worker in workers:
            worker.join(1)
        self.assertFalse(errors)
        self.assertCountEqual(finished, ["video", "audio"])
        # 256 KiB together, less a single 64 KiB burst, needs three seconds.
        # Per-download buckets or an unbounded burst would finish much sooner.
        self.assertGreaterEqual(elapsed, 2.7)
        self.assertLess(elapsed, 5.5)

    def test_large_reservation_takes_fair_chunk_turns(self):
        limiter = subject.BandwidthLimiter(True, 64)
        limiter.consume(BLOCK)
        completed = []
        entered = threading.Event()

        def large():
            entered.set()
            limiter.consume(2 * BLOCK)
            completed.append("large")

        first = threading.Thread(target=large)
        first.start()
        self.assertTrue(entered.wait(1))
        # The first request is blocked behind an empty bucket. The smaller
        # request must get a FIFO turn before that request's second chunk.
        deadline = time.monotonic() + 1
        while True:
            with limiter._condition:
                queued = bool(limiter._waiters)
            if queued or time.monotonic() >= deadline:
                break
            time.sleep(.001)
        self.assertTrue(queued, "The large request did not enter its first chunk's queue.")
        second = threading.Thread(target=lambda: (limiter.consume(BLOCK), completed.append("small")))
        second.start()
        first.join(6)
        second.join(1)
        limiter.configure(False, 64)
        first.join(1)
        second.join(1)
        self.assertEqual(completed, ["small", "large"])

    def test_cancelled_waiter_exits_promptly_without_changing_other_callers(self):
        limiter = subject.BandwidthLimiter(True, 64)
        limiter.consume(BLOCK)
        cancel = threading.Event()
        worker, finished, errors = self.start_consumer(limiter, BLOCK, cancel)
        self.assertFalse(finished.wait(.03))
        cancel.set()
        self.assertTrue(finished.wait(.3), "Cancellation waited for another token reservation.")
        worker.join(1)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], subject.BandwidthCancelled)
        self.assertTrue(cancel.is_set())
        other = threading.Event()
        limiter.configure(False, 64)
        limiter.consume(BLOCK, other)
        self.assertFalse(other.is_set())

    def test_turning_limit_off_wakes_existing_waiter_immediately(self):
        limiter = subject.BandwidthLimiter(True, 64)
        limiter.consume(BLOCK)
        cancel = threading.Event()
        worker, finished, errors = self.start_consumer(limiter, 16 * BLOCK, cancel)
        second, second_finished, second_errors = self.start_consumer(limiter, 16 * BLOCK)
        self.assertFalse(finished.wait(.03))
        self.assertFalse(second_finished.is_set())
        limiter.configure(False, 64)
        self.assertTrue(finished.wait(.3), "Disabling retained the previous rate's wait.")
        self.assertTrue(second_finished.wait(.3), "Disabling left another download waiting.")
        worker.join(1)
        second.join(1)
        self.assertFalse(errors)
        self.assertFalse(second_errors)
        self.assertFalse(cancel.is_set())

    def test_live_rate_change_discards_old_wait_and_uses_new_rate(self):
        limiter = subject.BandwidthLimiter(True, 64)
        limiter.consume(BLOCK)
        worker, finished, errors = self.start_consumer(limiter, 4 * BLOCK)
        self.assertFalse(finished.wait(.03))
        limiter.configure(True, 10240)
        self.assertTrue(finished.wait(.3), "The new rate retained the old rate's reservation debt.")
        worker.join(1)
        self.assertFalse(errors)
        self.assertTrue(limiter.enabled)
        self.assertEqual(limiter.rate_kib, 10240)

    def test_reapplying_same_configuration_does_not_grant_a_new_burst(self):
        limiter = subject.BandwidthLimiter(True, 64)
        limiter.consume(BLOCK)
        limiter.configure(True, 64)
        worker, finished, errors = self.start_consumer(limiter, BLOCK)
        self.assertFalse(finished.wait(.1), "Creating another engine granted a new burst.")
        limiter.configure(False, 64)
        self.assertTrue(finished.wait(.3))
        worker.join(1)
        self.assertFalse(errors)

    def test_already_cancelled_event_rejects_even_when_disabled(self):
        limiter = subject.BandwidthLimiter()
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(subject.BandwidthCancelled):
            limiter.consume(0, cancel)
        with self.assertRaises(subject.BandwidthCancelled):
            limiter.consume(BLOCK, cancel)
        self.assertTrue(cancel.is_set())

    def test_package_and_isolated_imports_share_process_limiter_and_exception(self):
        name = "_bandwidth_isolated_identity_test"
        spec = importlib.util.spec_from_file_location(name, APP_ROOT / "desktop" / "bandwidth.py")
        imported = importlib.util.module_from_spec(spec)
        sys.modules[name] = imported
        self.addCleanup(lambda: sys.modules.pop(name, None))
        spec.loader.exec_module(imported)
        self.assertIs(sys.modules[name], subject)
        self.assertIs(imported.PROCESS_BANDWIDTH, subject.PROCESS_BANDWIDTH)
        self.assertIs(imported.BandwidthLimiter, subject.BandwidthLimiter)
        self.assertIs(imported.BandwidthCancelled, subject.BandwidthCancelled)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *_test_arguments])
