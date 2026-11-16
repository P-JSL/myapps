"""Focused release guards; never performs a network mutation."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('missav_release', ROOT / 'scripts/release-missav.py')
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_publication_requires_the_exact_authorized_ci_commit(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(release.subprocess, 'run') as command:
            with self.assertRaises(ValueError): release.publish(Path('.'), 'a' * 40, [])
            command.assert_not_called()

    def test_published_release_and_existing_tag_are_not_replaced(self):
        environment = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': release.REPO, 'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': 'a' * 40}
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.object(release, 'gh', return_value=[{'tag_name': release.TAG, 'draft': False}]), mock.patch.object(release.subprocess, 'run') as command:
            with self.assertRaisesRegex(ValueError, 'published release'): release.publish(Path('.'), 'a' * 40, [])
            command.assert_not_called()

    def test_archive_rejects_traversal_and_duplicate_members(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'test.zip'
            with ZipFile(file, 'w') as archive: archive.writestr('my-video-app/../private', b'bad')
            with self.assertRaisesRegex(ValueError, 'Unsafe'): release.zip_inventory(file, 'my-video-app/')

    def test_original_assets_cannot_be_substituted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            for name in release.PINNED: (path / name).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'Original asset changed'): release.verify(path, 'a' * 40)

    def test_tag_and_standard_assets_remain_fixed(self):
        self.assertEqual(release.TAG, 'v1.20.1-preview.1')
        self.assertEqual(release.PINNED['my-video-app-extension-standard.zip'], '70ebcc3a49788d8fd1c61263914b386b612e9253bd3d937c9d3dec3b6e776942')
        source = (ROOT / 'scripts/release-missav.py').read_text(encoding='utf-8')
        self.assertIn("'--latest=false'", source)
        self.assertNotIn('--clobber', source)

    def test_mocked_or_other_build_browser_evidence_cannot_pass_the_installed_gate(self):
        evidence = {'buildSha256': 'a' * 64, 'version': release.VERSION, 'extensionInstalled': True,
                    'chromeAPIsMocked': False, 'checks': ['passed'] * 6, 'errors': []}
        release.verify_installed_evidence(evidence, 'a' * 64)
        for changed in [{'chromeAPIsMocked': True}, {'extensionInstalled': False}, {'checks': ['passed'] * 5},
                        {'buildSha256': 'b' * 64}, {'errors': ['runtime failure']}]:
            with self.assertRaisesRegex(ValueError, 'installed-extension'):
                release.verify_installed_evidence({**evidence, **changed}, 'a' * 64)


if __name__ == '__main__': unittest.main()
