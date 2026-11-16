"""Focused release-integrity checks, independent of the earlier application suites."""
import copy
import importlib.util
import hashlib
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

    def test_empty_untagged_draft_uses_creation_upload_before_publication(self):
        commit = 'c' * 40
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'sample.zip').write_bytes(b'verified package')
            (directory / 'release-notes.md').write_text('test notes', encoding='utf-8')
            asset = {'name': 'sample.zip', 'size': len(b'verified package'),
                     'digest': 'sha256:' + hashlib.sha256(b'verified package').hexdigest()}
            state = {'created': False, 'published': False}
            old = {'tag_name': bundle.TAG, 'id': 1, 'draft': True, 'assets': []}

            def api(args):
                endpoint = args[-1]
                if endpoint.endswith('releases?per_page=100'):
                    return [dict(old, id=2, assets=[asset])] if state['created'] else [old]
                if endpoint.endswith('/releases/2'):
                    return {'assets': [asset], 'draft': not state['published'], 'prerelease': True, 'html_url': 'https://example.test/release'}
                if '/git/ref/tags/' in endpoint:
                    return {'object': {'sha': commit}}
                self.fail(endpoint)

            def command(args, **kwargs):
                if '/git/ref/tags/' in ' '.join(args):
                    return bundle.subprocess.CompletedProcess(args, 1, '', 'HTTP 404')
                self.assertNotEqual(args[1:3], ['release', 'upload'])
                if args[1:3] == ['release', 'create']:
                    self.assertIn(str(directory / 'sample.zip'), args)
                    self.assertIn('--draft', args)
                    state['created'] = True
                if 'PATCH' in args:
                    self.assertTrue(state['created'])
                    state['published'] = True
                return bundle.subprocess.CompletedProcess(args, 0, '', '')

            env = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': bundle.REPOSITORY,
                   'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': commit}
            with patch.dict(bundle.os.environ, env, clear=True), patch.object(bundle, 'gh_json', side_effect=api), \
                    patch.object(bundle.subprocess, 'run', side_effect=command), patch('builtins.print'):
                bundle.publish(directory, commit, ['sample.zip'])
            self.assertTrue(state['created'] and state['published'])


if __name__ == '__main__':
    unittest.main()
