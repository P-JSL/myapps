"""Focused offline Qt checks for the desktop HTTP/3 removal in 1.19.3.

Development: PYTHONPATH=.cache/desktop-gui-dev python desktop/test_no_http3_gui.py -v
Packaged: runtime/python/python.exe -I -B /tests/test_no_http3_gui.py --app-root /MyVideoApp -v
Only the explicitly selected application's modules are loaded. No older test
suite is imported, and any skipped check makes this command fail.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parent.parent)
_options, _test_arguments = _parser.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
DESKTOP_DIR = APP_ROOT / "desktop"
if not (DESKTOP_DIR / "main.py").is_file() or not (DESKTOP_DIR / "engine.py").is_file():
    raise SystemExit("--app-root must contain desktop/main.py and desktop/engine.py")

# The packaged interpreter uses -I. Add only the selected trusted application
# directory, never the tests directory or current working directory.
sys.path.insert(0, str(DESKTOP_DIR))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QCoreApplication, QEvent
from PySide6.QtWidgets import QApplication, QCheckBox, QLabel

import main as gui
from activity import ActivityLog
from engine import DownloadProgress, DownloadRequest, Engine


class LegacyPreferences(dict):
    """Expose an obsolete True value and observe whether the GUI consumes it."""

    def __init__(self, values):
        super().__init__({**values, "http3_enabled": True})
        self.reads = []

    def get(self, key, default=None):
        self.reads.append(key)
        return super().get(key, default)

    def __getitem__(self, key):
        self.reads.append(key)
        return super().__getitem__(key)


class NoHttp3GuiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setQuitOnLastWindowClosed(False)
        cls.app.setStyle("Fusion")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-no-http3-gui-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.destination = self.root / "downloads"
        self.destination.mkdir()
        self.activity = ActivityLog(self.root / "data", version=gui.VERSION)
        self.addCleanup(self.activity.close)
        self.engine = Engine(APP_ROOT, self.root / "data", activity=self.activity)
        self.engine.save_settings({"download_folder": str(self.destination), "folder_confirmed": True,
                                   "theme": "light", "concurrent_downloads": 4,
                                   "host_concurrent_downloads": 2, "parallel_downloads": True,
                                   "speed_limit_enabled": False, "speed_limit_kib": 10240,
                                   "scan_after_download": False})
        self.preferences = LegacyPreferences(self.engine.settings())
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
        self.assertFalse(self.window.workers)
        self.assertTrue(self.window.pool.waitForDone(1000))
        self.window.close()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()
        self.engine.bandwidth.configure(False, 10240)

    def control_text(self):
        return "\n".join(widget.text() + " " + widget.accessibleName()
                         for widget in self.window.findChildren(QLabel) + self.window.findChildren(QCheckBox))

    def make_card(self, transport, *, mode="parallel", connections=4, percent=50):
        request = DownloadRequest(url="https://media.example.test/video.mp4", folder=self.destination,
                                  quality="highest", output="mp4", job_id="a" * 32)
        progress = DownloadProgress(stage="downloading", percent=percent, downloaded=2048,
                                    total=4096, speed=1024, eta=2, transport=transport,
                                    connections=connections, transfer_mode=mode)
        item = gui.QueueItem(request=request, job_id=request.job_id, title="Offline fixture",
                             stage="downloading", progress=progress)
        card = gui.JobCard(item, self.window)
        card.resize(1000, 200)
        card.show()
        self.app.processEvents()
        return card

    def test_settings_have_no_http3_checkbox_or_explanation(self):
        self.window.nav_buttons[2].click()
        self.assertEqual(self.window.pages.currentIndex(), 2)
        self.assertFalse(hasattr(self.window, "http3_checkbox"))
        self.assertNotIn("HTTP/3", self.control_text())
        self.assertNotIn("HTTP3", self.control_text())
        self.assertNotIn("http3_enabled", self.preferences.reads)

    def test_obsolete_true_is_never_read_or_written_by_remaining_settings(self):
        self.window.parallel_checkbox.setChecked(False)
        self.window.speed_limit_checkbox.setChecked(True)
        self.window.speed_limit_spin.setValue(2048)
        self.window.concurrent_combo.setCurrentIndex(self.window.concurrent_combo.findData(8))
        self.window.host_concurrent_combo.setCurrentIndex(self.window.host_concurrent_combo.findData(3))
        self.window.theme_combo.setCurrentIndex(1)
        self.window.scan_checkbox.setChecked(True)
        self.app.processEvents()
        writes = [call.args[0] for call in self.saved.call_args_list]
        self.assertTrue(writes)
        self.assertTrue(all("http3_enabled" not in values for values in writes))
        self.assertNotIn("http3_enabled", self.preferences.reads)
        persisted = self.engine.store.settings()
        for key, value in {"parallel_downloads": False, "speed_limit_enabled": True,
                           "speed_limit_kib": 2048, "concurrent_downloads": 8,
                           "host_concurrent_downloads": 3, "theme": "dark",
                           "scan_after_download": True}.items():
            self.assertEqual(persisted[key], value, key)
        self.assertFalse(hasattr(self.window, "http3_checkbox"))

    def test_parallel_speed_concurrency_and_scan_controls_remain(self):
        self.assertEqual(self.window.parallel_checkbox.text(), "파일별 병렬 다운로드")
        self.assertTrue(self.window.parallel_checkbox.isChecked())
        self.assertEqual(self.window.speed_limit_checkbox.text(), "다운로드 속도 제한")
        self.assertFalse(self.window.speed_limit_spin.isEnabled())
        self.window.speed_limit_checkbox.setChecked(True)
        self.assertTrue(self.window.speed_limit_spin.isEnabled())
        self.assertEqual((self.window.speed_limit_spin.minimum(), self.window.speed_limit_spin.maximum()),
                         (64, 1048576))
        self.assertEqual({self.window.concurrent_combo.itemData(index)
                          for index in range(self.window.concurrent_combo.count())}, set(range(17)))
        self.assertEqual({self.window.host_concurrent_combo.itemData(index)
                          for index in range(self.window.host_concurrent_combo.count())}, set(range(1, 17)))
        self.assertEqual(self.window.scan_checkbox.text(), "Microsoft Defender로 저장한 파일 검사")
        self.assertEqual(self.window.scan_checkbox.isEnabled(), sys.platform == "win32")

    def test_download_form_and_four_page_navigation_remain(self):
        self.assertEqual([button.text().strip() for button in self.window.nav_buttons],
                         ["다운로드", "다운로드 기록", "설정", "실행 로그"])
        self.assertEqual(self.window.pages.count(), 4)
        for index in range(4):
            self.window.nav_buttons[index].click()
            self.assertEqual(self.window.pages.currentIndex(), index)
        self.assertEqual({self.window.output_combo.itemData(index)
                          for index in range(self.window.output_combo.count())},
                         {"mp4", "webm", "mkv", "mp3", "m4a", "original"})
        self.assertEqual({self.window.quality_combo.itemData(index)
                          for index in range(self.window.quality_combo.count())},
                         {"highest", "2160", "1440", "1080", "720", "480"})
        self.assertEqual(self.window.settings_folder.text(), str(self.destination))
        self.assertTrue(self.window.activity_viewer.isReadOnly())
        self.assertEqual(self.window.activity_viewer.maximumBlockCount(), 500)

    def test_native_http2_progress_keeps_parallel_speed_and_percent(self):
        card = self.make_card("h2")
        text = card.stats.toolTip()
        for expected in ("HTTP/2", "병렬 요청 4개", "2.0 KB / 4.0 KB", "1.0 KB/s"):
            self.assertIn(expected, text)
        self.assertEqual(card.percent.text(), "50%")
        self.assertEqual(card.progress_bar.value(), 500)
        self.assertNotIn("HTTP/3", text)

    def test_native_http11_progress_keeps_single_request_and_indeterminate_progress(self):
        card = self.make_card("http/1.1", mode="single", connections=1, percent=None)
        text = card.stats.toolTip()
        for expected in ("HTTP/1.1", "단일 요청", "2.0 KB / 4.0 KB", "1.0 KB/s"):
            self.assertIn(expected, text)
        self.assertEqual((card.progress_bar.minimum(), card.progress_bar.maximum()), (0, 0))
        self.assertEqual(card.percent.text(), "")
        self.assertNotIn("HTTP/3", text)

    def test_live_legacy_transport_has_no_http3_label(self):
        card = self.make_card("h3")
        self.assertNotIn("HTTP/3", card.stats.toolTip())
        self.assertIn("병렬 요청 4개", card.stats.toolTip())
        self.assertIn("1.0 KB/s", card.stats.toolTip())

    def test_recorded_old_h3_activity_remains_readable_and_copyable(self):
        historical = {"timestamp": "2026-10-20T12:34:56.000000Z", "level": "INFO",
                      "event": "download.progress", "session": "b" * 32, "version": "1.19.2",
                      "job_id": "c" * 32, "stage": "downloading",
                      "detail": {"transport": "h3", "track_kind": "audio", "transfer_mode": "single",
                                 "downloaded": 2048, "total": 4096, "speed": 1024}}
        with self.activity.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(historical) + "\n")
        self.window.nav_buttons[3].click()
        visible = self.window.activity_viewer.toPlainText()
        for expected in ("다운로드 진행", "작업 cccccccc", "연결 h3", "트랙 오디오", "속도 1.0 KB/s"):
            self.assertIn(expected, visible)
        self.window.activity_copy.click()
        copied = [json.loads(line) for line in QApplication.clipboard().text().splitlines()]
        self.assertEqual(len(copied), 1)
        self.assertEqual(copied[0]["version"], "1.19.2")
        self.assertEqual(copied[0]["detail"]["transport"], "h3")
        self.assertTrue(self.window.activity_timer.isActive())
        self.assertFalse(hasattr(self.window, "http3_checkbox"))
        self.assertNotIn("http3_enabled", self.preferences.reads)


if __name__ == "__main__":
    program = unittest.main(argv=[sys.argv[0], *_test_arguments], exit=False)
    raise SystemExit(0 if program.result.wasSuccessful() and not program.result.skipped else 1)
