"""Standalone offline Qt checks for the 1.19.4 desktop flow restoration.

Development: PYTHONPATH=.cache/desktop-gui-dev python3 -B desktop/test_v18_restore_gui.py -v
Packaged: runtime/python/python.exe -I -B /tests/test_v18_restore_gui.py --app-root /MyVideoApp -v
Only the selected application's modules are loaded; no earlier test is imported.
External windows, downloads and processes are never opened by this suite.
"""
from __future__ import annotations

import argparse
from dataclasses import fields
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
DESKTOP_DIR = APP_ROOT / "desktop"
if not all((DESKTOP_DIR / name).is_file() for name in ("main.py", "engine.py", "activity.py")):
    raise SystemExit("--app-root must contain the desktop application modules")
sys.path.insert(0, str(DESKTOP_DIR))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QCoreApplication, QEvent
from PySide6.QtWidgets import QApplication, QCheckBox, QLabel, QSpinBox

import main as gui
from activity import ActivityLog
from engine import DownloadProgress, DownloadRequest, Engine


RETIRED_SETTINGS = {"http3_enabled", "parallel_downloads", "speed_limit_enabled", "speed_limit_kib"}


class ObservedPreferences(dict):
    """Simulate an older settings adapter and record all reads of stale keys."""

    def __init__(self, values):
        super().__init__({**values, "http3_enabled": True, "parallel_downloads": True,
                          "speed_limit_enabled": True, "speed_limit_kib": 64})
        self.reads = []

    def get(self, key, default=None):
        self.reads.append(key)
        return super().get(key, default)

    def __getitem__(self, key):
        self.reads.append(key)
        return super().__getitem__(key)


class RestoreGuiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setQuitOnLastWindowClosed(False)
        cls.app.setStyle("Fusion")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-v18-restore-gui-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.destination = self.root / "downloads"
        self.destination.mkdir()
        self.data = self.root / "data"
        self.activity = ActivityLog(self.data, version=gui.VERSION)
        self.addCleanup(self.activity.close)
        self.engine = Engine(APP_ROOT, self.data, activity=self.activity)
        self.initial_settings = {"download_folder": str(self.destination), "folder_confirmed": True,
                                 "theme": "light", "concurrent_downloads": 4,
                                 "host_concurrent_downloads": 2, "scan_after_download": False,
                                 "quality": "1080", "output": "mp4"}
        self.engine.save_settings(self.initial_settings)
        self.saved_file = self.destination / "existing.mp4"
        self.saved_file.write_bytes(b"existing offline fixture")
        for job_id, stage, title in (("a" * 32, "complete", "Saved fixture"),
                                     ("b" * 32, "error", "Retry fixture")):
            self.engine.store.insert({"job_id": job_id, "url": "https://media.example.test/" + stage + ".mp4",
                                      "title": title, "folder": str(self.destination), "quality": "1080",
                                      "output": "mp4", "stage": stage, "request_digest": job_id,
                                      "filepath": str(self.saved_file) if stage == "complete" else None,
                                      "message": "" if stage == "complete" else "Offline retry fixture",
                                      "scan": 0})
        self.initial_history = self.engine.history()
        self.preferences = ObservedPreferences(self.engine.settings())
        self.settings_patch = patch.object(self.engine, "settings", return_value=self.preferences)
        self.settings_patch.start()
        self.addCleanup(self.settings_patch.stop)
        self.save_patch = patch.object(self.engine, "save_settings", wraps=self.engine.save_settings)
        self.saved = self.save_patch.start()
        self.addCleanup(self.save_patch.stop)
        self.window = gui.MainWindow(self.engine)
        self.window.show()
        self.app.processEvents()

    def tearDown(self):
        self.window.cancel_for_shutdown()
        self.assertFalse(self.window.workers, "An offline GUI check unexpectedly started a worker")
        self.assertTrue(self.window.pool.waitForDone(1000))
        self.window.close()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()

    def choices(self, combo):
        return {combo.itemData(index) for index in range(combo.count())}

    def set_choice(self, combo, value):
        index = combo.findData(value)
        self.assertGreaterEqual(index, 0)
        combo.setCurrentIndex(index)

    def test_selected_app_release_and_v18_settings_only(self):
        self.assertEqual(gui.VERSION, "1.19.4")
        self.assertTrue(Path(gui.__file__).samefile(DESKTOP_DIR / "main.py"))
        self.window.navigate(2)
        for attribute in ("http3_checkbox", "parallel_checkbox", "speed_limit_checkbox",
                          "speed_limit_spin", "_speed_limit_toggled"):
            self.assertFalse(hasattr(self.window, attribute), attribute)
        self.assertFalse(self.window.findChildren(QSpinBox))
        controls = self.window.findChildren(QLabel) + self.window.findChildren(QCheckBox)
        text = "\n".join(widget.text() + " " + widget.accessibleName() for widget in controls)
        for retired in ("HTTP/3", "HTTP3", "파일별 병렬", "속도 제한", "KiB/s", "최대 4개 요청"):
            self.assertNotIn(retired, text)
        self.assertFalse(RETIRED_SETTINGS.intersection(self.preferences.reads))
        self.assertEqual(self.choices(self.window.concurrent_combo), set(range(17)))
        self.assertEqual(self.choices(self.window.host_concurrent_combo), set(range(1, 17)))
        self.assertEqual(self.window.pool.maxThreadCount(), 16)
        self.assertEqual(self.window.scan_checkbox.isEnabled(), sys.platform == "win32")

    def test_retained_preferences_persist_without_consuming_legacy_keys(self):
        self.set_choice(self.window.concurrent_combo, 16)
        self.set_choice(self.window.host_concurrent_combo, 3)
        self.set_choice(self.window.theme_combo, "dark")
        self.set_choice(self.window.quality_combo, "720")
        self.set_choice(self.window.output_combo, "mkv")
        self.window.scan_checkbox.setChecked(True)
        settings = self.engine.store.settings()
        for key, value in {"concurrent_downloads": 16, "host_concurrent_downloads": 3,
                           "theme": "dark", "quality": "720", "output": "mkv",
                           "scan_after_download": True, "folder_confirmed": True}.items():
            self.assertEqual(settings[key], value, key)
        self.assertTrue(Path(settings["download_folder"]).samefile(self.destination))
        self.assertTrue(self.saved.called)
        self.assertTrue(all(not RETIRED_SETTINGS.intersection(call.args[0]) for call in self.saved.call_args_list))
        self.assertFalse(RETIRED_SETTINGS.intersection(self.preferences.reads))
        self.assertEqual(self.engine.history(), self.initial_history)

    def test_existing_folder_history_and_unrelated_preferences_survive_restart(self):
        with self.engine.store.connect() as database:
            database.executemany("INSERT INTO preferences(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                 [(key, json.dumps(True if key != "speed_limit_kib" else 64))
                                  for key in RETIRED_SETTINGS])
            database.execute("INSERT INTO preferences(key,value) VALUES ('future_untouched', ?)",
                             (json.dumps({"preserve": "value"}),))
        reopened = Engine(APP_ROOT, self.data)
        settings = reopened.settings()
        self.assertFalse(RETIRED_SETTINGS.intersection(settings))
        for key, value in self.initial_settings.items():
            if key == "download_folder":
                self.assertTrue(Path(settings[key]).samefile(self.destination))
            else:
                self.assertEqual(settings[key], value, key)
        self.assertEqual(settings["future_untouched"], {"preserve": "value"})
        self.assertEqual(reopened.history(), self.initial_history)
        self.assertEqual(self.saved_file.read_bytes(), b"existing offline fixture")
        self.window.navigate(1)
        self.assertEqual(self.window.history_count.text(), "2개 기록")
        self.window._set_history_filter("complete")
        self.assertEqual(self.window.history_count.text(), "1개 기록")
        self.window._set_history_filter("stopped")
        self.assertEqual(self.window.history_count.text(), "1개 기록")
        self.window.history_search.setText("unmatched fixture title")
        self.assertEqual(self.window.history_count.text(), "0개 기록")

    def test_folder_selection_and_request_keep_v18_options(self):
        target = self.root / "new destination"
        target.mkdir()
        with patch.object(gui.QFileDialog, "getExistingDirectory", return_value=str(target)):
            self.assertTrue(self.window.choose_folder())
        self.assertTrue(self.window.folder.samefile(target))
        self.assertTrue(Path(self.window.settings_folder.text()).samefile(target))
        self.assertTrue(Path(self.engine.store.settings()["download_folder"]).samefile(target))
        self.assertEqual(self.choices(self.window.output_combo), {"original", "mp4", "webm", "mkv", "mp3", "m4a"})
        self.assertEqual(self.choices(self.window.quality_combo), {"highest", "2160", "1440", "1080", "720", "480"})
        self.set_choice(self.window.output_combo, "mp3")
        self.assertFalse(self.window.quality_combo.isEnabled())
        self.set_choice(self.window.output_combo, "webm")
        self.assertTrue(self.window.quality_combo.isEnabled())
        self.set_choice(self.window.quality_combo, "480")
        self.window.url_input.setText("https://media.example.test/new.webm")
        with patch.object(self.window, "_enqueue") as enqueue:
            self.window.add_download()
        enqueue.assert_called_once()
        request = enqueue.call_args.args[0]
        self.assertTrue(Path(request.folder).samefile(target))
        self.assertEqual((request.quality, request.output, request.scan), ("480", "webm", False))
        self.assertFalse(RETIRED_SETTINGS.intersection(vars(request)))
        options = self.engine._options(Path("deno.exe"), fragment_workers=3)
        self.assertEqual(options["concurrent_fragment_downloads"], 3)
        self.assertTrue(options["continuedl"])
        self.assertTrue(options["noplaylist"])
        self.assertFalse(options.get("nocheckcertificate", False))
        self.assertFalse({"ratelimit", "external_downloader", "http3_enabled", "parallel_downloads"}.intersection(options))

    def make_card(self, **progress_values):
        request = DownloadRequest("https://media.example.test/card.mp4", self.destination,
                                  output="mp4", job_id="c" * 32)
        progress = DownloadProgress("downloading", downloaded=2048, total=4096, speed=1024,
                                    eta=2, percent=50, **progress_values)
        item = gui.QueueItem(request=request, job_id=request.job_id, title="Card fixture",
                             stage="downloading", progress=progress)
        card = gui.JobCard(item, self.window)
        card.resize(1000, 200)
        card.show()
        self.app.processEvents()
        return item, card

    def test_v18_progress_fields_and_live_card_statistics(self):
        self.assertEqual({field.name for field in fields(DownloadProgress)},
                         {"stage", "percent", "downloaded", "total", "speed", "eta", "title", "filepath", "message"})
        item, card = self.make_card()
        self.assertEqual(card.stats.toolTip(), "2.0 KB / 4.0 KB   ·   1.0 KB/s   ·   약 2초 남음")
        self.assertEqual(card.percent.text(), "50%")
        self.assertEqual(card.progress_bar.value(), 500)
        # A stale producer may still supply diagnostic-only transfer fields.
        item.progress = SimpleNamespace(stage="downloading", downloaded=2048, total=4096,
                                        speed=1024, eta=2, percent=None, transport="h2",
                                        connections=4, transfer_mode="parallel")
        card.refresh()
        self.assertEqual(card.stats.toolTip(), "2.0 KB / 4.0 KB   ·   1.0 KB/s   ·   약 2초 남음")
        self.assertEqual(card.percent.text(), "")
        self.assertEqual((card.progress_bar.minimum(), card.progress_bar.maximum()), (0, 0))

    def test_log_page_navigation_theme_and_readable_filtered_copy_remain(self):
        self.assertEqual([button.text().strip() for button in self.window.nav_buttons],
                         ["다운로드", "다운로드 기록", "설정", "실행 로그"])
        self.assertEqual(self.window.pages.count(), 4)
        self.assertIn("Alt+4", {shortcut.key().toString() for shortcut in self.window.shortcuts})
        self.activity.emit("app.ready")
        self.activity.emit("app.previous_unclean", level="WARNING", reason="missing_shutdown")
        self.activity.exception("worker.failed", OSError(5, "https://private.invalid/?token=private-value"),
                                job_id="d" * 32, stage="downloading", http_status=403)
        self.window.nav_buttons[3].click()
        self.assertEqual(self.window.pages.currentIndex(), 3)
        self.assertTrue(self.window.activity_viewer.isReadOnly())
        self.assertEqual(self.window.activity_viewer.maximumBlockCount(), 500)
        self.assertTrue(self.window.activity_timer.isActive())
        self.assertTrue(Path(self.window.activity_path.text()).samefile(self.activity.path))
        self.window.activity_errors_only.setChecked(True)
        visible = self.window.activity_viewer.toPlainText()
        self.assertIn("[주의] 이전 실행의 종료 기록 없음", visible)
        self.assertIn("[오류] 다운로드 작업 오류", visible)
        self.assertIn("HTTP 403", visible)
        self.assertIn("작업 dddddddd", visible)
        self.assertNotIn('"timestamp":', visible)
        self.window.activity_copy.click()
        copied = QApplication.clipboard().text()
        records = [json.loads(line) for line in copied.splitlines()]
        self.assertEqual(records, self.activity.recent(limit=500, errors_only=True))
        self.assertEqual([record["event"] for record in records], ["app.previous_unclean", "worker.failed"])
        self.assertEqual(records[-1]["job_id"], "d" * 32)
        for private in ("private.invalid", "private-value"):
            self.assertNotIn(private, visible + copied)
        light_style = self.window.activity_viewer.styleSheet()
        self.window.toggle_theme()
        self.assertNotEqual(self.window.activity_viewer.styleSheet(), light_style)
        self.window.navigate(0)
        self.assertFalse(self.window.activity_timer.isActive())

    def test_log_viewer_stays_bounded_and_folder_open_uses_log_directory(self):
        for _ in range(510):
            self.activity.emit("queue.add", stage="queued")
        self.window.navigate(3)
        self.assertEqual(len(self.window.activity_viewer.toPlainText().splitlines()), 500)
        self.assertIn("500", self.window.activity_status.text())
        with patch.object(self.window, "open_folder") as opened:
            self.window.activity_open_folder.click()
        self.assertTrue(Path(opened.call_args.args[0]).samefile(self.activity.directory))
        with patch.object(self.activity, "recent", return_value=[{"event": "<b>literal</b>"}]):
            self.window.activity_refresh.click()
        self.assertIn("<b>literal</b>", self.window.activity_viewer.toPlainText())

    def test_queue_cancel_retry_and_shutdown_keep_activity_events(self):
        request = DownloadRequest("https://media.example.test/queued.mp4?token=private-value",
                                  self.destination, output="mp4", job_id="e" * 32)
        with patch.object(self.window, "_pump_queue"):
            self.window._enqueue(request)
            self.app.processEvents()
            self.window.cancel_download(request.job_id)
            self.window.retry_download(request.job_id)
            self.app.processEvents()
            self.window.cancel_for_shutdown()
        records = self.activity.recent(limit=500)
        self.assertEqual([record["event"] for record in records],
                         ["queue.add", "queue.cancelled", "download.retry_requested", "queue.add", "queue.cancelled"])
        self.assertFalse(self.window.pending)
        self.assertTrue(self.window.items[request.job_id].cancel.is_set())
        self.assertNotIn("private-value", json.dumps(records))

    def test_session_hooks_and_one_failed_shutdown_remain(self):
        prior_sys, prior_thread = Mock(), Mock()
        with patch.object(sys, "excepthook", prior_sys), patch.object(threading, "excepthook", prior_thread):
            session = gui.ActivitySession(self.activity)
            session.start()
            try:
                session.ready()
                error = RuntimeError("https://private.invalid/?token=private-value")
                sys.excepthook(type(error), error, None)
                threading.excepthook(SimpleNamespace(exc_type=type(error), exc_value=error,
                                                      exc_traceback=None, thread=None))
            finally:
                session.close()
                session.close()
            self.assertIs(sys.excepthook, prior_sys)
            self.assertIs(threading.excepthook, prior_thread)
        self.assertEqual((prior_sys.call_count, prior_thread.call_count), (1, 1))
        records = self.activity.recent(limit=500)
        self.assertEqual([record["event"] for record in records],
                         ["app.start", "app.ready", "app.unhandled_exception", "app.thread_exception", "app.shutdown"])
        self.assertEqual(records[-1]["detail"]["outcome"], "failed")
        self.assertNotIn("private-value", json.dumps(records))

    def test_second_instance_never_opens_writer(self):
        with patch.object(gui, "QApplication", return_value=self.app), \
                patch.object(gui, "acquire_app_lock", return_value=None), \
                patch.object(gui, "ActivityLog") as writer, \
                patch.object(gui.QMessageBox, "information"):
            self.assertEqual(gui.main(["--data-dir", str(self.data)]), 0)
        writer.assert_not_called()

    def test_event_loop_failure_keeps_writer_and_store_lock_through_worker_flush(self):
        data = self.root / "lifecycle"
        lock = Mock()
        order = []
        window = SimpleNamespace(show=Mock(), workers={"f" * 32: object()}, pool=SimpleNamespace(),
                                 cancel_for_shutdown=Mock(side_effect=lambda: order.append("cancel")))

        def finish_workers():
            self.assertFalse(lock.unlock.called)
            reader = ActivityLog(data)
            try:
                self.assertNotIn("app.shutdown", [record["event"] for record in reader.recent(limit=500)])
            finally:
                reader.close()
            order.append("workers finished")
            window.workers.clear()

        window.pool.waitForDone = Mock(side_effect=finish_workers)
        lock.unlock.side_effect = lambda: order.append("unlock")
        with patch.object(gui, "QApplication", return_value=self.app), \
                patch.object(gui, "acquire_app_lock", return_value=lock), \
                patch.object(gui, "Engine"), patch.object(gui, "MainWindow", return_value=window), \
                patch.object(self.app, "exec", side_effect=RuntimeError("private-value")), \
                patch.object(gui.QMessageBox, "critical"):
            self.assertEqual(gui.main(["--data-dir", str(data)]), 1)
        self.app.aboutToQuit.disconnect(window.cancel_for_shutdown)
        self.assertEqual(order, ["cancel", "workers finished", "unlock"])
        reader = ActivityLog(data)
        self.addCleanup(reader.close)
        records = reader.recent(limit=500)
        self.assertEqual([record["event"] for record in records],
                         ["app.start", "app.ready", "app.event_loop_failed", "app.shutdown"])
        self.assertEqual(records[-1]["detail"]["outcome"], "failed")
        self.assertNotIn("private-value", json.dumps(records))


if __name__ == "__main__":
    program = unittest.main(argv=[sys.argv[0], *_test_arguments], exit=False)
    raise SystemExit(0 if program.result.wasSuccessful() and not program.result.skipped else 1)
