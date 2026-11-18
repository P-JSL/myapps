"""Focused release guards; never performs a network mutation."""
import importlib.util
import os
from pathlib import Path
import tempfile
import types
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
        environment = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': release.REPO, 'GITHUB_REF': release.RELEASE_REF, 'GITHUB_SHA': 'a' * 40}
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.object(release, 'gh', return_value=[{'tag_name': release.TAG, 'draft': False}]), mock.patch.object(release.subprocess, 'run') as command:
            with self.assertRaisesRegex(ValueError, 'published release'): release.publish(Path('.'), 'a' * 40, [])
            command.assert_not_called()

    def test_archive_rejects_traversal_and_duplicate_members(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'test.zip'
            with ZipFile(file, 'w') as archive: archive.writestr('my-video-app/../private', b'bad')
            with self.assertRaisesRegex(ValueError, 'Unsafe'): release.zip_inventory(file, 'my-video-app/')

    def test_existing_tag_on_a_different_commit_is_not_moved(self):
        environment = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': release.REPO,
                       'GITHUB_REF': release.RELEASE_REF, 'GITHUB_SHA': 'a' * 40}
        tag = types.SimpleNamespace(returncode=0, stdout='{"object":{"sha":"' + 'b' * 40 + '"}}', stderr='')
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.object(release, 'gh', return_value=[]), \
                mock.patch.object(release.subprocess, 'run', return_value=tag) as command:
            with self.assertRaisesRegex(ValueError, 'tag cannot be moved'):
                release.publish(Path('.'), 'a' * 40, [])
            self.assertEqual(command.call_count, 1)
            self.assertEqual(command.call_args.args[0][1], 'api')

    def test_original_assets_cannot_be_substituted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            for name in release.PINNED: (path / name).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'Original asset changed'): release.verify(path, 'a' * 40)

    def test_tag_and_unchanged_helper_remain_fixed(self):
        self.assertEqual(release.TAG, 'v1.20.5')
        self.assertNotIn('my-video-app-extension-standard.zip', release.PINNED)
        self.assertEqual(release.PINNED['my-video-app-antivirus-helper.zip'], '88818c9cc0ea443be213ac0c2c20cbeebf3796444026824ac3f9306aef55c959')
        source = (ROOT / 'scripts/release-missav.py').read_text(encoding='utf-8')
        self.assertIn("'--latest=false'", source)
        self.assertIn("'make_latest': 'true'", source)
        self.assertNotIn('--clobber', source)

    def test_mocked_or_other_build_browser_evidence_cannot_pass_the_installed_gate(self):
        evidence = {'buildSha256': 'a' * 64, 'version': release.VERSION, 'extensionInstalled': True,
                    'chromeAPIsMocked': False, 'checks': ['passed'] * 6, 'errors': []}
        release.verify_installed_evidence(evidence, 'a' * 64)
        for changed in [{'chromeAPIsMocked': True}, {'extensionInstalled': False}, {'checks': ['passed'] * 5},
                        {'buildSha256': 'b' * 64}, {'errors': ['runtime failure']}]:
            with self.assertRaisesRegex(ValueError, 'installed-extension'):
                release.verify_installed_evidence({**evidence, **changed}, 'a' * 64)

    def test_swapped_or_mocked_variant_ui_evidence_is_rejected(self):
        evidence = {'platform': 'win32', 'variant': 'standard', 'buildSha256': 'a' * 64,
                    'chromeAPIsMocked': False, 'startsAndRetriesUseUI': True,
                    'checks': ['passed'] * 3, 'errors': [],
                    'downloads': [{'state': 'complete', 'bytes': 100}] * 3}
        release.verify_ui_evidence(evidence, 'a' * 64, 'standard')
        for changed in [{'variant': 'missav'}, {'chromeAPIsMocked': True}, {'startsAndRetriesUseUI': False},
                        {'buildSha256': 'b' * 64}, {'errors': ['failure']}, {'downloads': []}]:
            with self.assertRaisesRegex(ValueError, 'UI evidence'):
                release.verify_ui_evidence({**evidence, **changed}, 'a' * 64, 'standard')

    def test_incomplete_or_fixture_live_download_cannot_pass(self):
        evidence = {'platform': 'win32', 'buildSha256': 'a' * 64, 'chromeAPIsMocked': False,
                    'responsesMocked': False, 'fullVideoVerified': True,
                    'manifest': {'status': 200, 'hls': True, 'vod': True, 'encrypted': False, 'segments': 10, 'durationSeconds': 60},
                    'savedMedia': {'bytes': 100, 'format': {'duration': '60'}, 'streams': [{'codec_type': 'video'}, {'codec_type': 'audio'}]}}
        release.verify_live_evidence(evidence, 'a' * 64)
        for changed in [{'fullVideoVerified': False}, {'responsesMocked': True}, {'chromeAPIsMocked': True},
                        {'failure': {'message': '403'}}, {'savedMedia': {'bytes': 0}}]:
            with self.assertRaises(ValueError):
                release.verify_live_evidence({**evidence, **changed}, 'a' * 64)


if __name__ == '__main__': unittest.main()
