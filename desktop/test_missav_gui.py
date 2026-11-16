"""Focused UI smoke check using the extracted Windows package and native Qt."""
import argparse
import os
from pathlib import Path
import sys
import tempfile
import unittest

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument('--app-root', type=Path, required=True)
args, remaining = parser.parse_known_args()
sys.path.insert(0, str(args.app_root / 'desktop'))
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from PySide6.QtWidgets import QApplication, QLabel
import main as gui
from engine import Engine, canonical_url


class MissavGuiTests(unittest.TestCase):
    def test_packaged_window_accepts_missav_without_starting_a_download(self):
        app = QApplication.instance() or QApplication([])
        with tempfile.TemporaryDirectory() as directory:
            engine = Engine(args.app_root, Path(directory))
            window = gui.MainWindow(engine)
            try:
                window.show(); app.processEvents()
                self.assertEqual(gui.VERSION, '1.20.1')
                self.assertIn('MissAV', window.url_input.placeholderText())
                self.assertTrue(any('MissAV' in label.text() for label in window.findChildren(QLabel)))
                url = 'https://missav123.com/ko/owned-fixture'
                window.url_input.setText(url)
                self.assertEqual(canonical_url(window.url_input.text()), (url, False))
                self.assertFalse(window.workers)
            finally:
                window.cancel_for_shutdown(); window.close(); window.deleteLater(); app.processEvents()


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], *remaining])
