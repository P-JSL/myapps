"""Focused release-integrity checks, independent of the earlier application suites."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release_bundle', ROOT / 'scripts/assemble-release-bundle.py')
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class BundleTests(unittest.TestCase):
    def evidence(self):
        return {'version': '1.19.4', 'commit': bundle.DESKTOP_COMMIT,
                'desktopSha256': 'a' * 64, 'platform': 'windows-x64',
                'validationMode': 'focused-desktop-v18-restore',
                'v18RestoreTests': 'passed', 'v18RestoreGuiTests': 'passed', 'releaseScopeTests': 'passed'}

    def test_original_windows_evidence_is_accepted(self):
        bundle.verify_windows_evidence(self.evidence(), 'a' * 64)

    def test_evidence_from_a_different_binary_or_commit_is_rejected(self):
        for key, value in [('desktopSha256', 'b' * 64), ('commit', 'b' * 40), ('version', '1.19.3'), ('platform', 'linux')]:
            changed = copy.deepcopy(self.evidence())
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                bundle.verify_windows_evidence(changed, 'a' * 64)

    def test_skipped_or_missing_windows_checks_cannot_be_called_passed(self):
        for key in ('v18RestoreTests', 'v18RestoreGuiTests', 'releaseScopeTests'):
            changed = self.evidence()
            changed[key] = 'skipped'
            with self.subTest(key=key), self.assertRaises(ValueError):
                bundle.verify_windows_evidence(changed, 'a' * 64)

    def test_changed_original_asset_is_rejected_before_archive_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p / 'example.zip').write_bytes(b'altered payload')
            with patch.object(bundle, 'PINNED', {'example.zip': ('source-tag', 'a' * 64)}), self.assertRaisesRegex(ValueError, 'SHA-256'):
                bundle.verify_files(p)

    def test_missing_original_asset_cannot_be_published(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, 'Missing'):
            bundle.verify_files(Path(directory))

    def test_local_or_wrong_repository_publication_is_blocked(self):
        with patch.dict(bundle.os.environ, {'GITHUB_ACTIONS': 'false'}, clear=True), self.assertRaisesRegex(ValueError, 'authorized'):
            bundle.publish(Path('/not-used'), 'c' * 40, [])


if __name__ == '__main__':
    unittest.main()
