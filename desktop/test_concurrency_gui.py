"""New bounded, offline Qt concurrency checks against source or an actual ZIP.

Development: PYTHONPATH=.cache/desktop-gui-dev python desktop/test_concurrency_gui.py -v
Packaged: runtime/python/python.exe -I -B /tests/test_concurrency_gui.py --app-root /MyVideoApp -v

The real window, QThreadPool workers, Engine and SQLite store run. Only external
dependency/extraction/download/process boundaries are replaced with fixtures.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit


_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parent.parent)
_options, _test_arguments = _parser.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
if not (APP_ROOT / "desktop" / "main.py").is_file():
    raise SystemExit("--app-root must contain desktop/main.py")
sys.path.insert(0, str(APP_ROOT / "desktop"))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QCoreApplication, QEvent, QEventLoop, QTimer
from PySide6.QtWidgets import QApplication

import main as gui
from concurrency import ResourceBudget, effective_concurrency, source_key
from engine import DownloadProgress, DownloadRequest, Engine, EngineError, _check_cancel


TIMEOUT_MS = 12000
MEDIA = b"\0\0\0\x18ftypisom" + b"\0" * 100


def process_until(predicate, message="The expected Qt transition did not occur."):
    """Run the Qt event loop until a condition or bounded timer fires."""
    if predicate():
        return
    loop = QEventLoop()
    poll = QTimer()
    poll.setInterval(2)
    deadline = QTimer()
    deadline.setSingleShot(True)
    poll.timeout.connect(lambda: loop.quit() if predicate() else None)
    deadline.timeout.connect(loop.quit)
    poll.start()
    deadline.start(TIMEOUT_MS)
    loop.exec()
    poll.stop()
    deadline.stop()
    if not predicate():
        raise AssertionError(message)


class MediaBoundary:
    def __init__(self):
        self.condition = threading.Condition()
        self.blocked = True
        self.released = set()
        self.entered = []
        self.active = set()
        self.peak = 0
        self.storm = 0

    @contextmanager
    def download(self, key, cancel):
        with self.condition:
            self.entered.append(key)
            self.active.add(key)
            self.peak = max(self.peak, len(self.active))
            self.condition.notify_all()
        try:
            with self.condition:
                deadline = time.monotonic() + TIMEOUT_MS / 1000
                while self.blocked and key not in self.released:
                    _check_cancel(cancel)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise EngineError("Offline GUI media boundary timed out.")
                    self.condition.wait(min(.05, remaining))
            _check_cancel(cancel)
            yield
        finally:
            with self.condition:
                self.active.discard(key)
                self.condition.notify_all()

    def release(self, key=None):
        with self.condition:
            if key is None:
                self.blocked = False
            else:
                self.released.add(key)
            self.condition.notify_all()


class OfflineDownloader:
    def __init__(self, engine, options):
        self.engine, self.options = engine, options

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def dl(self, filename, info):
        with self.engine.boundary.download(info["id"], self.engine.local.cancel):
            Path(filename).write_bytes(MEDIA)
            for index in range(self.engine.boundary.storm):
                for hook in self.options["progress_hooks"]:
                    hook({"status": "downloading", "downloaded_bytes": index, "total_bytes": self.engine.boundary.storm})
            for hook in self.options["progress_hooks"]:
                hook({"status": "finished", "downloaded_bytes": len(MEDIA), "total_bytes": len(MEDIA)})
        return True, True


class OfflineEngine(Engine):
    def __init__(self, data, destination, boundary, resources=None):
        super().__init__(APP_ROOT, data, resources=resources)
        self.destination, self.boundary = destination, boundary
        self.local = threading.local()
        self.save_settings({"download_folder": str(destination), "folder_confirmed": True})

    def _dependencies(self, youtube, cancel):
        self.local.cancel = cancel
        return SimpleNamespace(YoutubeDL=lambda options: OfflineDownloader(self, options)), Path("deno.exe"), Path("ffmpeg.exe"), Path("ffprobe.exe")

    def _extract_isolated(self, url, youtube, quality, output, cancel):
        key = urlsplit(url).path.rsplit("/", 1)[-1]
        return {"id": key, "title": key, "formats": [{"format_id": "combined", "url": url, "ext": "mp4", "height": 720,
            "vcodec": "avc1.640028", "acodec": "mp4a.40.2", "filesize": len(MEDIA), "protocol": "https"}]}

    def _run(self, arguments, cancel, **_):
        _check_cancel(cancel)
        if arguments[0] == "ffprobe.exe":
            return json.dumps({"streams": [{"codec_type": "video"}, {"codec_type": "audio"}]}).encode()
        if arguments[0] == "ffmpeg.exe":
            Path(arguments[-1]).write_bytes(MEDIA)
        return b""


class ConcurrencyGuiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.application = QApplication.instance() or QApplication([])
        cls.application.setQuitOnLastWindowClosed(False)
        cls.application.setStyle("Fusion")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-new-queue-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.destination = self.root / "downloads"
        self.destination.mkdir()
        self.boundary = MediaBoundary()
        self.budget = ResourceBudget()
        self.engine = OfflineEngine(self.root / "data", self.destination, self.boundary, self.budget)
        self.window = gui.MainWindow(self.engine)
        self.window.show()
        self.application.processEvents()

    def tearDown(self):
        self.boundary.release()
        self.window._closing = True
        self.window.pending.clear()
        for item in self.window.items.values():
            item.cancel.set()
        process_until(lambda: not self.window.workers, "A GUI fixture leaked a worker.")
        self.assertTrue(self.window.pool.waitForDone(1000))
        self.window.close()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.application.processEvents()
        self.assertTrue(all(stage["used"] == stage["waiting"] == 0 for stage in self.budget.snapshot().values()))

    def limits(self, total, host=16):
        self.window.host_concurrent_combo.setCurrentIndex(self.window.host_concurrent_combo.findData(host))
        self.window.concurrent_combo.setCurrentIndex(self.window.concurrent_combo.findData(total))

    def enqueue(self, key, host="media.example.test"):
        before = set(self.window.items)
        self.window.url_input.setText(f"https://{host}/{key}.mp4")
        self.window.add_download()
        added = set(self.window.items) - before
        self.assertEqual(len(added), 1)
        return added.pop()

    def wait_downloads(self, count):
        process_until(lambda: len(self.boundary.entered) >= count, f"Expected {count} actual download calls, got {self.boundary.entered}")

    def finish(self, count):
        self.boundary.release()
        process_until(lambda: not self.window.workers and not self.window.pending)
        self.assertEqual(len(self.engine.history()), count)
        self.assertEqual({row["stage"] for row in self.engine.history()}, {"complete"})
        self.assertEqual({item.stage for item in self.window.items.values()}, {"complete"})
        self.assertTrue(all(Path(row["filepath"]).is_file() for row in self.engine.history()))

    def test_auto_and_all_sixteen_manual_choices_persist_across_reopen(self):
        self.assertEqual(self.window.concurrent_combo.currentData(), 0)
        self.assertEqual(self.window.host_concurrent_combo.currentData(), 4)
        self.assertEqual(self.window.concurrency, effective_concurrency(0))
        self.assertEqual({self.window.concurrent_combo.itemData(i) for i in range(self.window.concurrent_combo.count())}, set(range(17)))
        self.assertEqual({self.window.host_concurrent_combo.itemData(i) for i in range(self.window.host_concurrent_combo.count())}, set(range(1, 17)))
        self.limits(16, 1)
        self.window.close()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.window = gui.MainWindow(Engine(APP_ROOT, self.root / "data"))
        self.window.show()
        self.assertEqual(self.window.concurrent_combo.currentData(), 16)
        self.assertEqual(self.window.host_concurrent_combo.currentData(), 1)
        self.assertEqual(self.window.pool.maxThreadCount(), 16)

    def test_eight_actual_workers_run_and_pending_jobs_do_not_exceed_total_limit(self):
        self.limits(8)
        for index in range(10):
            self.enqueue(f"eight-{index}")
        self.wait_downloads(8)
        self.assertEqual(len(self.window.workers), 8)
        self.assertEqual(len(self.window.pending), 2)
        self.assertEqual(len(self.boundary.active), 8)
        self.assertEqual(self.window.pool.maxThreadCount(), 16)
        self.finish(10)
        self.assertLessEqual(self.boundary.peak, 8)

    def test_busy_host_at_queue_head_does_not_block_other_hosts(self):
        self.limits(1, 1)
        first = self.enqueue("a0", "a.example.test")
        self.wait_downloads(1)
        a1 = self.enqueue("a1", "a.example.test")
        a2 = self.enqueue("a2", "a.example.test")
        b = self.enqueue("b0", "b.example.test")
        c = self.enqueue("c0", "c.example.test")
        d = self.enqueue("d0", "d.example.test")
        self.limits(4, 1)
        self.wait_downloads(4)
        self.assertEqual(set(self.window.workers), {first, b, c, d})
        self.assertEqual(self.window.pending, [a1, a2])
        self.finish(6)

    def test_least_active_host_then_oldest_fifo_admission(self):
        self.limits(1, 2)
        a0 = self.enqueue("a0", "a.example.test")
        self.wait_downloads(1)
        a1 = self.enqueue("a1", "a.example.test")
        b0 = self.enqueue("b0", "b.example.test")
        b1 = self.enqueue("b1", "b.example.test")
        c0 = self.enqueue("c0", "c.example.test")
        self.limits(3, 2)
        self.wait_downloads(3)
        self.assertEqual(set(self.window.workers), {a0, b0, c0})
        self.assertEqual(self.window.pending, [a1, b1])
        self.limits(4, 2)
        self.wait_downloads(4)
        self.assertIn(a1, self.window.workers)
        self.assertEqual(self.window.pending, [b1])
        self.finish(5)

    def test_lower_total_drains_existing_workers_and_increase_starts_pending_immediately(self):
        self.limits(4)
        identifiers = [self.enqueue(f"drain-{index}") for index in range(8)]
        self.wait_downloads(4)
        self.limits(2)
        self.assertEqual(len(self.window.workers), 4)
        self.assertEqual(len(self.window.pending), 4)
        self.assertTrue(all(not self.window.items[key].cancel.is_set() for key in identifiers[:4]))
        self.boundary.release("drain-0.mp4")
        process_until(lambda: identifiers[0] not in self.window.workers)
        self.assertEqual(len(self.window.workers), 3)
        self.assertEqual(len(self.boundary.entered), 4)
        self.boundary.release("drain-1.mp4")
        process_until(lambda: identifiers[1] not in self.window.workers)
        self.assertEqual(len(self.window.workers), 2)
        self.assertEqual(len(self.window.pending), 4)
        self.limits(6)
        self.wait_downloads(8)
        self.assertEqual(len(self.window.workers), 6)
        self.assertFalse(self.window.pending)
        self.finish(8)

    def test_lower_host_cap_drains_that_host_while_other_hosts_fill_slots(self):
        self.limits(3, 3)
        a = [self.enqueue(f"host-{index}", "a.example.test") for index in range(3)]
        self.wait_downloads(3)
        waiting = self.enqueue("host-next", "a.example.test")
        other = self.enqueue("other", "b.example.test")
        self.limits(4, 1)
        self.wait_downloads(4)
        self.assertIn(other, self.window.workers)
        self.assertIn(waiting, self.window.pending)
        self.assertEqual(sum(source_key(worker.item.request.url) == "a.example.test" for worker in self.window.workers.values()), 3)
        self.assertTrue(all(not self.window.items[key].cancel.is_set() for key in a))
        self.finish(5)

    def test_pending_and_engine_waiting_cancellation_preserve_slots_and_database_state(self):
        self.budget = ResourceBudget({"jobs": 1})
        self.engine.resources = self.budget
        self.limits(2)
        first = self.enqueue("running")
        self.wait_downloads(1)
        waiting = self.enqueue("engine-waiting")
        pending = self.enqueue("pending")
        process_until(lambda: self.window.items[waiting].stage == "waiting")
        self.assertEqual(len(self.window.workers), 2)
        self.assertIsNone(self.engine.store.get(pending))
        self.window.cancel_download(pending)
        self.assertNotIn(pending, self.window.pending)
        self.assertEqual(self.window.items[pending].stage, "cancelled")
        self.assertIsNone(self.engine.store.get(pending))
        self.window.cancel_download(waiting)
        process_until(lambda: waiting not in self.window.workers)
        self.assertEqual(self.engine.store.get(waiting)["stage"], "cancelled")
        self.assertEqual(self.window.items[waiting].stage, "cancelled")
        self.assertNotIn("engine-waiting.mp4", self.boundary.entered)
        self.assertEqual(set(self.window.workers), {first})
        self.assertEqual(self.budget.snapshot()["jobs"]["used"], 1)
        self.boundary.release()
        process_until(lambda: not self.window.workers)
        next_job = self.enqueue("after-cancel")
        process_until(lambda: not self.window.workers)
        self.assertEqual(self.window.items[next_job].stage, "complete")
        self.assertEqual(self.engine.store.get(next_job)["stage"], "complete")

    def test_progress_storm_is_reduced_and_final_delivery_reaches_card_and_sqlite(self):
        self.limits(1)
        self.boundary.storm = 10000
        with patch.object(gui, "time", SimpleNamespace(monotonic=lambda: 100.0)):
            job = self.enqueue("storm")
            self.wait_downloads(1)
            delivered = []
            self.window.workers[job].signals.progress.connect(lambda _job, event: delivered.append(event))
            self.boundary.release()
            process_until(lambda: not self.window.workers)
        self.assertLess(len(delivered), 20)
        self.assertTrue(any(event.stage == "downloading" and event.percent == 100 for event in delivered))
        self.assertEqual(delivered[-1].stage, "complete")
        self.assertEqual(self.window.items[job].stage, "complete")
        self.assertEqual(self.window.items[job].progress.percent, 100)
        self.assertEqual(self.window.cards[job].progress_bar.value(), 1000)
        self.assertEqual(self.engine.store.get(job)["stage"], "complete")

    def test_worker_progress_rate_uses_one_hundred_milliseconds_and_forwards_stage_changes(self):
        item = gui.QueueItem(DownloadRequest("https://media.example.test/progress.mp4", self.destination), "rate")
        worker = gui.DownloadWorker(self.engine, item)
        delivered = []
        worker.signals.progress.connect(lambda _job, event: delivered.append(event))
        clock = [10.0]
        with patch.object(gui, "time", SimpleNamespace(monotonic=lambda: clock[0])):
            worker._emit_progress(DownloadProgress("downloading", percent=1))
            clock[0] += .099
            worker._emit_progress(DownloadProgress("downloading", percent=2))
            self.assertEqual(len(delivered), 1)
            clock[0] += .002
            worker._emit_progress(DownloadProgress("downloading", percent=3))
            self.assertEqual(len(delivered), 2)
            worker._emit_progress(DownloadProgress("waiting", message="Resource busy"))
            worker._emit_progress(DownloadProgress("cancelled"))
        self.assertEqual([event.stage for event in delivered], ["downloading", "downloading", "waiting", "cancelled"])


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *_test_arguments])
