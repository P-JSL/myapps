"""Offline checks for the 1.19.2 activity page and application lifecycle.

Development: PYTHONPATH=.cache/desktop-gui-dev python desktop/test_activity_gui.py -v
Packaged: runtime/python/python.exe -I -B /tests/test_activity_gui.py --app-root /MyVideoApp -v
The suite imports no older tests and treats skipped checks as a failure.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parent.parent)
_options, _test_arguments = _parser.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
if not (APP_ROOT / "desktop" / "main.py").is_file():
    raise SystemExit("--app-root must contain desktop/main.py")
sys.path.insert(0, str(APP_ROOT / "desktop"))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QCoreApplication, QEvent
from PySide6.QtWidgets import QApplication

import main as gui
from activity import ActivityLog
from engine import DownloadRequest


class FakeEngine:
    def __init__(self, directory: Path, activity=None):
        self.activity = activity
        self.directory = directory
        self.preferences = {"download_folder": str(directory), "folder_confirmed": True}
        self.history_error = False
        self.settings_error = False

    def settings(self):
        return dict(self.preferences)

    def save_settings(self, values):
        if self.settings_error:
            raise OSError("https://private.invalid/?token=secret /private/folder")
        self.preferences.update(values)

    def history(self):
        if self.history_error:
            raise OSError("https://private.invalid/?token=secret /private/folder")
        return []

    def download(self, *_):
        raise RuntimeError("https://private.invalid/?token=secret /private/folder")


class ActivityGuiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setQuitOnLastWindowClosed(False)
        cls.app.setStyle("Fusion")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-activity-gui-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.activity = ActivityLog(self.root)
        self.addCleanup(self.activity.close)
        self.engine = FakeEngine(self.root, self.activity)
        self.window = gui.MainWindow(self.engine)
        self.window.show()
        self.app.processEvents()

    def tearDown(self):
        self.window.cancel_for_shutdown()
        self.window.close()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()

    def records(self):
        return self.activity.recent(limit=500)

    def test_fourth_navigation_and_bounded_readonly_plain_text(self):
        self.assertEqual([button.text().strip() for button in self.window.nav_buttons],
                         ["다운로드", "다운로드 기록", "설정", "실행 로그"])
        self.assertEqual(self.window.pages.count(), 4)
        self.assertTrue(self.window.activity_viewer.isReadOnly())
        self.assertEqual(self.window.activity_viewer.maximumBlockCount(), 500)
        for _ in range(510):
            self.activity.emit("queue.add", stage="queued")
        self.window.nav_buttons[3].click()
        self.assertEqual(self.window.pages.currentIndex(), 3)
        self.assertIn("실행 로그", self.window.breadcrumb.text())
        self.assertEqual(len(self.window.activity_viewer.toPlainText().splitlines()), 500)
        self.assertEqual(self.window.activity_path.text(), str(self.activity.path))
        self.assertEqual(self.window.activity_path.textFormat(), gui.Qt.TextFormat.PlainText)
        self.assertIn("500", self.window.activity_status.text())
        with patch.object(self.activity, "recent", return_value=[{"event": "<b>literal</b>"}]):
            self.window._refresh_activity()
        self.assertIn("<b>literal</b>", self.window.activity_viewer.toPlainText())

    def test_error_filter_and_copy_use_only_visible_records(self):
        self.activity.emit("app.ready")
        self.activity.emit("app.previous_unclean", level="WARNING", reason="missing_shutdown")
        self.activity.exception("worker.failed", OSError(5, "token=do-not-copy"), http_status=403,
                                job_id="d" * 32, stage="downloading")
        self.window.navigate(3)
        self.window.activity_errors_only.setChecked(True)
        self.assertEqual(self.window.activity_errors_only.text(), "주의·오류만 표시")
        visible = self.window.activity_viewer.toPlainText()
        self.assertEqual(len(visible.splitlines()), 2)
        self.assertIn("[주의] 이전 실행의 종료 기록 없음", visible)
        self.assertIn("[오류] 다운로드 작업 오류", visible)
        self.assertIn("작업 dddddddd", visible)
        self.assertIn("단계 다운로드 중", visible)
        self.assertIn("HTTP 403", visible)
        self.assertIn("OS 5", visible)
        self.assertNotIn('"timestamp":', visible)
        self.assertNotIn("dddddddddddddddddddddddddddddddd", visible)
        self.window.activity_copy.click()
        records = [json.loads(line) for line in QApplication.clipboard().text().splitlines()]
        self.assertEqual(records, self.activity.recent(limit=500, errors_only=True))
        self.assertEqual([record["event"] for record in records], ["app.previous_unclean", "worker.failed"])
        self.assertTrue(all(record["level"] in {"WARNING", "ERROR", "CRITICAL"} for record in records))
        self.assertEqual(records[-1]["job_id"], "d" * 32)
        self.assertEqual(records[-1]["detail"]["http_status"], 403)
        self.assertNotIn("do-not-copy", visible)
        self.assertNotIn("do-not-copy", QApplication.clipboard().text())
        self.window.activity_errors_only.setChecked(False)
        self.assertIn("앱 준비 완료", self.window.activity_viewer.toPlainText())

    def test_readable_start_and_compact_typed_diagnostics_keep_one_block(self):
        self.activity.emit("app.start", pid=1234)
        self.activity.emit("download.progress", job_id="e" * 32, stage="downloading",
                           downloaded=2048, total=4096, speed=1024, percent=50, duration_ms=25)
        try:
            raise RuntimeError("excluded input")
        except RuntimeError as error:
            self.activity.exception("worker.failed", error)
        self.window.navigate(3)
        lines = self.window.activity_viewer.toPlainText().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertRegex(lines[0], r"^\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[정보\] 앱 시작")
        self.assertIn("실행 " + self.activity.session_id[:8], lines[0])
        self.assertIn("프로세스 1234", lines[0])
        self.assertIn("수신 2.0 KB", lines[1])
        self.assertIn("전체 4.0 KB", lines[1])
        self.assertIn("속도 1.0 KB/s", lines[1])
        self.assertIn("진행률 50%", lines[1])
        self.assertIn("소요 25 ms", lines[1])
        self.assertIn("오류 RuntimeError", lines[2])
        self.assertIn("위치 ", lines[2])
        self.assertNotIn("excluded input", "\n".join(lines))
        unknown = gui.activity_line({"event": "<b>unknown</b>\n" + "x" * 200})
        self.assertIn("<b>unknown</b>", unknown)
        self.assertNotIn("\n", unknown)
        self.assertLess(len(unknown), 100)

    def test_refresh_button_and_visible_only_timer(self):
        self.assertEqual(self.window.activity_timer.interval(), 2000)
        self.assertFalse(self.window.activity_timer.isActive())
        self.window.navigate(3)
        self.assertTrue(self.window.activity_timer.isActive())
        with patch.object(self.activity, "recent", wraps=self.activity.recent) as recent:
            self.activity.emit("app.ready")
            self.window.activity_refresh.click()
            self.assertEqual(recent.call_count, 1)
            self.window.activity_timer.timeout.emit()
            self.assertEqual(recent.call_count, 2)
            self.window.navigate(0)
            self.assertFalse(self.window.activity_timer.isActive())
            self.window.activity_timer.timeout.emit()
            self.assertEqual(recent.call_count, 2)
            self.window.navigate(3)
            self.assertEqual(recent.call_count, 3)
            self.window.hide()
            self.assertFalse(self.window.activity_timer.isActive())
            self.window.activity_timer.timeout.emit()
            self.assertEqual(recent.call_count, 3)
            self.window.show()
            self.assertTrue(self.window.activity_timer.isActive())
        self.assertIn("앱 준비 완료", self.window.activity_viewer.toPlainText())

    def test_open_folder_targets_local_log_directory(self):
        self.window.navigate(3)
        with patch.object(gui.QDesktopServices, "openUrl", return_value=True) as opened:
            self.window.activity_open_folder.click()
        self.assertEqual(opened.call_count, 1)
        self.assertEqual(Path(opened.call_args.args[0].toLocalFile()), self.activity.directory.resolve())

    def test_storage_failure_is_visible_even_without_records(self):
        unavailable = SimpleNamespace(path=self.root / "logs" / "activity.jsonl", directory=self.root / "logs",
                                      available=False, failure="로그 저장 공간을 확인해 주세요.",
                                      recent=lambda **_: [])
        self.window.activity = unavailable
        self.window.navigate(3)
        self.assertIn("저장하거나 읽지 못", self.window.activity_status.text())
        self.assertNotIn("아직 실행 로그", self.window.activity_status.text())
        self.assertFalse(self.window.activity_copy.isEnabled())
        unavailable.available = True
        unavailable.failure = ""
        unavailable.recent = Mock(side_effect=OSError("private detail"))
        self.window.activity_refresh.click()
        self.assertIn("저장하거나 읽지 못", self.window.activity_status.text())
        self.assertNotIn("private detail", self.window.activity_status.text())

    def test_engine_without_activity_still_opens(self):
        engine = FakeEngine(self.root)
        del engine.activity
        window = gui.MainWindow(engine)
        try:
            window.navigate(3)
            self.assertIn("저장하거나 읽지 못", window.activity_status.text())
            self.assertFalse(window.activity_open_folder.isEnabled())
        finally:
            window.close()
            window.deleteLater()

    def test_queue_cancel_retry_and_shutdown_events(self):
        request = DownloadRequest(url="https://private.invalid/?token=secret", folder=str(self.root),
                                  quality="highest", output="mp4", scan=False, job_id="a" * 32)
        with patch.object(self.window, "_pump_queue"):
            self.window._enqueue(request)
            self.app.processEvents()
            self.window.cancel_download(request.job_id)
            self.window.retry_download(request.job_id)
            self.app.processEvents()
            self.window.cancel_for_shutdown()
        events = [record["event"] for record in self.records()]
        self.assertEqual(events, ["queue.add", "queue.cancelled", "download.retry_requested", "queue.add", "queue.cancelled"])
        self.assertFalse(self.window.pending)
        self.assertTrue(self.window.items[request.job_id].cancel.is_set())
        self.assertNotIn("private.invalid", json.dumps(self.records()))

    def test_ui_and_worker_failures_are_safe_and_diagnostic(self):
        self.engine.settings_error = True
        self.engine.history_error = True
        self.window._save_preferences(theme="light")
        self.window._refresh_history()
        request = DownloadRequest(url="https://private.invalid/?token=secret", folder=str(self.root),
                                  quality="highest", output="mp4", scan=False, job_id="b" * 32)
        item = gui.QueueItem(request=request, job_id=request.job_id)
        worker = gui.DownloadWorker(self.engine, item)
        failures = []
        worker.signals.failed.connect(lambda *arguments: failures.append(arguments))
        worker.run()
        self.assertEqual([record["event"] for record in self.records()],
                         ["settings.save_failed", "history.read_failed", "worker.failed"])
        self.assertEqual(len(failures), 1)
        self.assertFalse(failures[0][2])
        serialized = json.dumps(self.records())
        self.assertNotIn("private.invalid", serialized)
        self.assertNotIn("/private/folder", serialized)

    def test_session_hooks_capture_restore_and_failed_shutdown(self):
        original_sys, original_thread = sys.excepthook, threading.excepthook
        prior_sys, prior_thread = Mock(), Mock()
        with patch.object(sys, "excepthook", prior_sys), patch.object(threading, "excepthook", prior_thread):
            session = gui.ActivitySession(self.activity)
            session.start()
            try:
                session.ready()
                error = RuntimeError("https://private.invalid/?token=secret")
                sys.excepthook(type(error), error, None)
                arguments = SimpleNamespace(exc_type=type(error), exc_value=error, exc_traceback=None, thread=None)
                threading.excepthook(arguments)
                self.assertTrue(session.failed)
            finally:
                session.close()
                session.close()
            self.assertIs(sys.excepthook, prior_sys)
            self.assertIs(threading.excepthook, prior_thread)
        self.assertIs(sys.excepthook, original_sys)
        self.assertIs(threading.excepthook, original_thread)
        self.assertEqual(prior_sys.call_count, 1)
        self.assertEqual(prior_thread.call_count, 1)
        records = self.records()
        self.assertEqual([record["event"] for record in records],
                         ["app.start", "app.ready", "app.unhandled_exception", "app.thread_exception", "app.shutdown"])
        self.assertEqual(records[-1]["detail"]["outcome"], "failed")
        self.assertNotIn("private.invalid", json.dumps(records))

    def test_missing_previous_shutdown_warns_and_clean_shutdown_does_not(self):
        directory = self.root / "sessions"
        prior = ActivityLog(directory)
        prior.emit("app.start")
        prior.emit("app.ready")
        prior.close()
        current = ActivityLog(directory)
        session = gui.ActivitySession(current)
        session.start()
        session.ready()
        session.close()
        events = current.recent(limit=500)
        self.assertEqual(sum(record["event"] == "app.previous_unclean" for record in events), 1)
        warning = next(record for record in events if record["event"] == "app.previous_unclean")
        self.assertEqual(warning["level"], "WARNING")
        next_activity = ActivityLog(directory)
        next_session = gui.ActivitySession(next_activity)
        next_session.start()
        next_session.close()
        self.assertEqual(sum(record["event"] == "app.previous_unclean" for record in next_activity.recent(limit=500)), 1)

    def test_already_running_never_opens_log_writer(self):
        with patch.object(gui, "QApplication", return_value=self.app), \
                patch.object(gui, "acquire_app_lock", return_value=None), \
                patch.object(gui, "ActivityLog") as logger, \
                patch.object(gui.QMessageBox, "information"):
            self.assertEqual(gui.main(["--data-dir", str(self.root)]), 0)
        logger.assert_not_called()

    def test_initialization_failure_records_shutdown_and_releases_lock(self):
        lock = Mock()
        with patch.object(gui, "QApplication", return_value=self.app), \
                patch.object(gui, "acquire_app_lock", return_value=lock), \
                patch.object(gui, "Engine", side_effect=RuntimeError("private-token")), \
                patch.object(gui.QMessageBox, "critical"):
            self.assertEqual(gui.main(["--data-dir", str(self.root / "initialization")]), 1)
        lock.unlock.assert_called_once_with()
        records = ActivityLog(self.root / "initialization")
        self.addCleanup(records.close)
        events = records.recent(limit=500)
        self.assertEqual([record["event"] for record in events],
                         ["app.start", "app.initialization_failed", "app.shutdown"])
        self.assertEqual(events[-1]["detail"]["outcome"], "failed")

    def test_event_loop_failure_keeps_lock_until_cancelled_workers_finish(self):
        directory = self.root / "event-loop"
        lock = Mock()
        lifecycle = []
        window = SimpleNamespace(show=Mock(), workers={"c" * 32: object()},
                                 cancel_for_shutdown=Mock(side_effect=lambda: lifecycle.append("cancel")),
                                 pool=SimpleNamespace())

        def finish_workers():
            self.assertFalse(lock.unlock.called)
            reading = ActivityLog(directory)
            try:
                self.assertNotIn("app.shutdown", [record["event"] for record in reading.recent(limit=500)])
            finally:
                reading.close()
            lifecycle.append("finished")
            window.workers.clear()

        window.pool.waitForDone = Mock(side_effect=finish_workers)
        lock.unlock.side_effect = lambda: lifecycle.append("unlock")
        with patch.object(gui, "QApplication", return_value=self.app), \
                patch.object(gui, "acquire_app_lock", return_value=lock), \
                patch.object(gui, "Engine"), patch.object(gui, "MainWindow", return_value=window), \
                patch.object(self.app, "exec", side_effect=RuntimeError("private-token")), \
                patch.object(gui.QMessageBox, "critical"):
            self.assertEqual(gui.main(["--data-dir", str(directory)]), 1)
        self.app.aboutToQuit.disconnect(window.cancel_for_shutdown)
        window.pool.waitForDone.assert_called_once_with()
        self.assertEqual(lifecycle, ["cancel", "finished", "unlock"])
        reading = ActivityLog(directory)
        self.addCleanup(reading.close)
        events = reading.recent(limit=500)
        self.assertEqual([record["event"] for record in events],
                         ["app.start", "app.ready", "app.event_loop_failed", "app.shutdown"])
        self.assertEqual(events[-1]["detail"]["outcome"], "failed")


if __name__ == "__main__":
    program = unittest.main(argv=[sys.argv[0], *_test_arguments], exit=False)
    raise SystemExit(0 if program.result.wasSuccessful() and not program.result.skipped else 1)
