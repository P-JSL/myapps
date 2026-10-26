"""Focused, offline Qt/Engine/SQLite integration checks for the desktop GUI.

Development:
  PYTHONPATH=.cache/desktop-gui-dev python desktop/test_gui.py -v
Packaged Windows runtime, with this test file kept outside the distribution:
  runtime/python/python.exe -I path/to/desktop/test_gui.py --app-root path/to/MyVideoApp -v

Only the dependency/network boundary is replaced. The window, worker pool,
queued signals, request validation, history and preferences are the real app.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


_arguments = argparse.ArgumentParser(add_help=False)
_arguments.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parent.parent)
_arguments.add_argument("--review-report", type=Path)
_arguments.add_argument("--screenshots-dir", type=Path)
_options, _unittest_arguments = _arguments.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
DESKTOP_DIR = APP_ROOT / "desktop"
if not (DESKTOP_DIR / "main.py").is_file() or not (DESKTOP_DIR / "engine.py").is_file():
    raise SystemExit("--app-root must contain the reviewed desktop/main.py and desktop/engine.py")

# -I deliberately ignores PYTHONPATH and the test script's own directory. Add
# only the explicitly selected application directory for its sibling modules.
sys.path.insert(0, str(DESKTOP_DIR))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6 import __version__ as PYSIDE_VERSION
from PySide6.QtCore import QCoreApplication, QEvent, qVersion
from PySide6.QtGui import QFont
from PySide6.QtWidgets import QApplication, QFileDialog

from main import MainWindow, VERSION, acquire_app_lock
from engine import DownloadCancelled, Engine, EngineError


VIDEO_A = "https://www.youtube.com/watch?v=abcdefghijk"
VIDEO_B = "https://www.youtube.com/watch?v=bcdefghijkl"
FIXTURE_FAILURE = "Offline GUI test: dependency boundary reached."


def process_until(application: QApplication, predicate, timeout: float = 8.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        application.processEvents()
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("The GUI did not complete the expected state transition before the deadline.")


class DesktopGuiTests(unittest.TestCase):
    def test_one_instance_owns_each_data_directory(self):
        with tempfile.TemporaryDirectory(prefix="myvideoapp-instance-") as temporary:
            directory = Path(temporary)
            first = acquire_app_lock(directory)
            self.assertIsNotNone(first)
            try:
                self.assertEqual(first.staleLockTime(), 0)
                self.assertIsNone(acquire_app_lock(directory))
            finally:
                first.unlock()
            replacement = acquire_app_lock(directory)
            self.assertIsNotNone(replacement)
            replacement.unlock()

    @classmethod
    def setUpClass(cls):
        cls.application = QApplication.instance() or QApplication([])
        cls.application.setQuitOnLastWindowClosed(False)
        cls.application.setApplicationName("MyVideoApp")
        cls.application.setStyle("Fusion")
        font = QFont("Segoe UI" if sys.platform == "win32" else "Noto Sans CJK KR")
        font.setPointSize(10)
        cls.application.setFont(font)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-gui-test-")
        self.addCleanup(self.temporary.cleanup)
        self.fixture_root = Path(self.temporary.name)
        self.destination = self.fixture_root / "영상 저장 폴더"
        self.destination.mkdir()
        self.data_dir = self.fixture_root / "app-data"
        self.engine = Engine(APP_ROOT, self.data_dir)
        self.dependency_handler = self._fail_dependencies
        boundary = patch.object(self.engine, "_dependencies", side_effect=self._dependencies)
        self.dependencies = boundary.start()
        self.addCleanup(boundary.stop)
        self.window = MainWindow(self.engine)
        self.window.show()
        self.application.processEvents()

    def tearDown(self):
        # Failure cleanup must never open the app's interactive close dialog.
        self.window._closing = True
        self.window.pending.clear()
        for item in self.window.items.values():
            item.cancel.set()
        process_until(self.application, lambda: not self.window.workers)
        self.assertTrue(self.window.pool.waitForDone(1000))
        self.window.close()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.application.processEvents()

    def _dependencies(self, youtube: bool, cancel: threading.Event):
        return self.dependency_handler(youtube, cancel)

    def _fail_dependencies(self, youtube: bool, cancel: threading.Event):
        raise EngineError(FIXTURE_FAILURE)

    def _wait_for_cancellation(self, youtube: bool, cancel: threading.Event):
        if not cancel.wait(12):
            raise EngineError("Offline GUI fixture timed out waiting for cancellation.")
        raise DownloadCancelled("Download cancelled.")

    def _select_destination(self):
        with patch.object(QFileDialog, "getExistingDirectory", return_value=str(self.destination)):
            self.assertTrue(self.window.choose_folder())

    def _add_video(self, url: str):
        before = set(self.window.items)
        self.window.url_input.setText(url)
        self.window.add_download()
        added = set(self.window.items) - before
        self.assertEqual(len(added), 1)
        return added.pop()

    def test_invalid_url_and_cancelled_first_folder_selection_do_not_enqueue(self):
        with patch.object(QFileDialog, "getExistingDirectory", return_value="") as dialog:
            self.window.url_input.setText("not a media URL")
            self.window.add_download()
            dialog.assert_not_called()
            self.assertTrue(self.window.url_input.property("error"))
            self.window.url_input.setText(VIDEO_A)
            self.window.add_download()
            dialog.assert_called_once()
        self.assertEqual(self.window.url_input.text(), VIDEO_A)
        self.assertFalse(self.window.folder_confirmed)
        self.assertFalse(self.window.items)
        self.assertFalse(self.window.workers)
        self.assertEqual(self.engine.history(), [])
        self.dependencies.assert_not_called()

    def test_first_uuid_worker_persists_selected_unicode_folder_and_error(self):
        self.assertFalse(self.window.folder_confirmed)
        with patch.object(QFileDialog, "getExistingDirectory", return_value=str(self.destination)) as dialog:
            job_id = self._add_video(VIDEO_A)
            dialog.assert_called_once()
        self.assertRegex(job_id, re.compile(r"[0-9a-f]{32}\Z"))
        self.assertEqual(self.window.items[job_id].request.job_id, job_id)
        process_until(self.application, lambda: not self.window.workers)
        self.dependencies.assert_called_once()
        record = self.engine.store.get(job_id)
        self.assertIsNotNone(record)
        self.assertEqual(record["job_id"], job_id)
        self.assertEqual(record["stage"], "error")
        self.assertEqual(record["message"], FIXTURE_FAILURE)
        self.assertEqual(Path(record["folder"]), self.destination.resolve())
        self.assertEqual(self.window.items[job_id].stage, "error")
        self.assertIn(FIXTURE_FAILURE, self.window.cards[job_id].message_label.text())
        self.assertTrue(self.engine.settings()["folder_confirmed"])
        self.assertEqual(Path(self.engine.settings()["download_folder"]), self.destination.resolve())

    def test_folder_format_quality_and_theme_survive_window_reopen(self):
        self._select_destination()
        self.window.output_combo.setCurrentIndex(self.window.output_combo.findData("mp3"))
        self.window.quality_combo.setCurrentIndex(self.window.quality_combo.findData("720"))
        self.window.theme_combo.setCurrentIndex(self.window.theme_combo.findData("dark"))
        self.assertFalse(self.window.quality_combo.isEnabled())
        self.window.close()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.window = MainWindow(Engine(APP_ROOT, self.data_dir))
        self.window.show()
        self.application.processEvents()
        self.assertTrue(self.window.folder_confirmed)
        self.assertEqual(self.window.folder, self.destination.resolve())
        self.assertEqual(self.window.output_combo.currentData(), "mp3")
        self.assertEqual(self.window.quality_combo.currentData(), "720")
        self.assertTrue(self.window.dark)
        self.assertFalse(self.window.quality_combo.isEnabled())

    def test_queue_cancellation_retry_advance_and_finished_card_cleanup(self):
        self._select_destination()
        self.dependency_handler = self._wait_for_cancellation
        first = self._add_video(VIDEO_A)
        process_until(self.application, lambda: self.engine.store.get(first) is not None)
        second = self._add_video(VIDEO_B)
        self.assertIn(second, self.window.pending)
        self.assertIsNone(self.engine.store.get(second))
        self.window.cancel_download(second)
        self.assertEqual(self.window.items[second].stage, "cancelled")
        self.assertNotIn(second, self.window.pending)
        self.window.retry_download(second)
        self.assertIn(second, self.window.pending)
        self.assertFalse(self.window.items[second].cancel.is_set())
        self.window.cancel_download(first)
        process_until(self.application, lambda: first not in self.window.workers and second in self.window.workers)
        self.window.cancel_download(second)
        process_until(self.application, lambda: not self.window.workers)
        self.assertFalse(self.window.pending)
        self.assertEqual({item.stage for item in self.window.items.values()}, {"cancelled"})
        self.assertEqual({record["stage"] for record in self.engine.history()}, {"cancelled"})
        self.assertEqual({record["job_id"] for record in self.engine.history()}, {first, second})
        self.window.clear_finished()
        self.application.processEvents()
        self.assertFalse(self.window.items)
        self.assertFalse(self.window.cards)
        self.assertEqual(self.window.queue_layout.count(), 1)
        self.assertFalse(self.window.empty_downloads.isHidden())
        self.assertEqual(len(self.engine.history()), 2)

    def test_failed_history_retry_reuses_existing_job_without_duplicate_row(self):
        self._select_destination()
        job_id = self._add_video(VIDEO_A)
        process_until(self.application, lambda: not self.window.workers)
        self.window.clear_finished()
        self.assertNotIn(job_id, self.window.items)
        self.window.retry_download(job_id)
        process_until(self.application, lambda: not self.window.workers)
        self.assertEqual(self.dependencies.call_count, 2)
        self.assertEqual(len(self.engine.history()), 1)
        self.assertEqual(self.engine.history()[0]["job_id"], job_id)
        self.assertEqual(self.window.items[job_id].stage, "error")
        self.assertEqual(self.window.pages.currentIndex(), 0)


class ReviewResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cases = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.cases.append({"test": test.id().split(".")[-1], "status": "passed"})

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.cases.append({"test": test.id().split(".")[-1], "status": "failed"})

    def addError(self, test, error):
        super().addError(test, error)
        self.cases.append({"test": test.id().split(".")[-1], "status": "error"})


def capture_previews(directory: Path) -> list[dict]:
    directory.mkdir(parents=True, exist_ok=True)
    previews = []
    with tempfile.TemporaryDirectory(prefix="myvideoapp-preview-") as temporary:
        # Empty first-use fixtures contain no user history, URL, account or path.
        engine = Engine(APP_ROOT, Path(temporary) / "app-data")
        engine.save_settings({"theme": "light", "scan_after_download": False})
        window = MainWindow(engine)
        window.show()
        try:
            for dark, name in ((False, "desktop-light.png"), (True, "desktop-dark.png")):
                window.theme_combo.setCurrentIndex(window.theme_combo.findData("dark" if dark else "light"))
                DesktopGuiTests.application.processEvents()
                pixmap = window.grab()
                target = directory / name
                if not pixmap.save(str(target)):
                    raise RuntimeError("The GUI preview could not be saved.")
                previews.append({"file": name, "width": pixmap.width(), "height": pixmap.height(),
                                 "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                                 "fixture": "Empty first-use window; no media request was made."})
        finally:
            window.close()
            window.deleteLater()
            QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
    return previews


def write_review_report(path: Path, result: ReviewResult, previews: list[dict]):
    evidence = {
        "schema": 1,
        "version": VERSION,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "status": "passed" if result.wasSuccessful() else "failed",
        "environment": {"os": platform.system(), "python": platform.python_version(),
                        "pyside": PYSIDE_VERSION, "qt": qVersion(), "qt_platform": "offscreen"},
        "command": "PYTHONPATH=.cache/desktop-gui-dev QT_QPA_PLATFORM=offscreen python desktop/test_gui.py -v --review-report test-results/desktop-gui-review.json --screenshots-dir reports/screenshots",
        "windows_ci_command": "runtime/python/python.exe -I <source>/desktop/test_gui.py --app-root <extracted>/MyVideoApp -v",
        "tests_run": result.testsRun,
        "cases": result.cases,
        "boundaries": {"real": ["MainWindow", "DownloadWorker", "Qt queued signals and thread pool", "Engine request validation and history transitions", "SQLite history and preferences"],
                       "mocked": ["Engine._dependencies before any media extraction or download", "Native folder chooser return value"],
                       "media_network_requests": 0},
        "reviewed_source_sha256": {name: hashlib.sha256((DESKTOP_DIR / name).read_bytes()).hexdigest()
                                    for name in ("main.py", "engine.py", "storage.py", "theme.py")},
        "screenshots": previews,
        "official_design_sources": [
            {"url": "https://github.com/jely2002/youtube-dl-gui", "observed": "Documented video/audio, quality/output selection, queue, light/dark and explicit errors."},
            {"url": "https://github.com/subhra74/xdm#-screenshots", "observed": "Official screenshots: sidebar/list, per-item folder actions, destination and one primary download action."},
            {"url": "https://github.com/oleksis/youtube-dl-gui#screenshots", "observed": "Official screenshot: URL input, visible destination/format and queue progress/status."},
            {"url": "https://github.com/axcore/tartube#4-quick-start-guide", "observed": "Documented destination-first setup and classic URL/destination/format/add/download sequence."},
        ],
        "design_review_scope": "Qualitative review of official public documentation and screenshots. No third-party application code copied; no universal usability ranking or user-study claim.",
        "known_limitations": [
            "This recorded execution used Linux Qt offscreen; actual Windows display, launcher and bundled runtime behavior require Windows CI or device testing.",
            "Live YouTube extraction, media downloads, format conversion and playback were not exercised by these GUI integration tests.",
            "Microsoft Defender execution, threat detection and scan results were not exercised.",
            "Native folder picker rendering and assistive technology were not exercised; only chooser results and resulting state were tested.",
            "Preview images use empty temporary fixtures and require visual review; offscreen rendering can differ from Windows fonts and display scaling.",
        ],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    runner = unittest.TextTestRunner(resultclass=ReviewResult, verbosity=2 if "-v" in _unittest_arguments else 1)
    program = unittest.main(argv=[sys.argv[0], *_unittest_arguments], testRunner=runner, exit=False)
    previews = capture_previews(_options.screenshots_dir) if program.result.wasSuccessful() and _options.screenshots_dir else []
    if _options.review_report:
        write_review_report(_options.review_report, program.result, previews)
    raise SystemExit(0 if program.result.wasSuccessful() else 1)
