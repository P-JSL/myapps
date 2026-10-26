"""Regression for directory aliases in the packaged Windows runtime check."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('runtime_path_subject', Path(__file__).resolve().parents[1] / 'desktop/test_runtime.py')
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


class RuntimePathTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.destination = self.root / '영상 폴더'
        self.destination.mkdir()
        self.saved = self.destination / 'fixture.mp4'
        self.saved.write_bytes(b'owned media fixture' * 100)

    def test_directory_alias_is_same_destination(self):
        alias = self.root / 'alias'
        try:
            alias.symlink_to(self.destination, target_is_directory=True)
        except OSError:
            self.skipTest('Directory alias creation is unavailable on this host.')
        self.assertNotEqual(self.saved.parent, alias)
        subject.assert_saved_media(self.saved, alias)

    def test_different_directory_is_rejected(self):
        other = self.root / 'other'; other.mkdir()
        with self.assertRaisesRegex(AssertionError, 'outside'):
            subject.assert_saved_media(self.saved, other)

    def test_missing_file_is_rejected(self):
        self.saved.unlink()
        with self.assertRaisesRegex(AssertionError, 'missing'):
            subject.assert_saved_media(self.saved, self.destination)

    def test_truncated_file_is_rejected(self):
        self.saved.write_bytes(b'partial')
        with self.assertRaisesRegex(AssertionError, 'small'):
            subject.assert_saved_media(self.saved, self.destination)


if __name__ == '__main__': unittest.main()
