"""Only the 1.19.2 activity logging publication scope; no prior suites run."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.19.2'
COMMIT = 'a' * 40
DIGEST = 'b' * 64
BASELINE_COMMIT = 'c9d79dc393b76554d2b2144a52ae5085f11e0f54'


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load_script('activity_release', 'publish-release.py')
build = load_script('activity_build', 'build-desktop.py')


def evidence():
    return {'version': VERSION, 'commit': COMMIT, 'platform': 'windows-x64',
            'validationMode': 'focused-desktop-activity', 'baseline': 'v1.19.1',
            'baselineCommit': BASELINE_COMMIT, 'desktopSha256': DIGEST,
            'activityTests': 'passed', 'activityGuiTests': 'passed',
            'releaseScopeTests': 'passed', 'priorChecks': 'skipped-per-user',
            'liveYouTubeVerified': False}


class ActivityReleaseTests(unittest.TestCase):
    def verify(self, value, digest=DIGEST):
        return release.validate_windows_evidence(VERSION, COMMIT, value, digest)

    def test_accepts_only_new_activity_evidence_without_previous_reports(self):
        self.assertIsNone(self.verify(evidence()))

    def test_every_activity_evidence_field_is_required(self):
        for key in evidence():
            with self.subTest(field=key):
                value = evidence()
                del value[key]
                with self.assertRaises(SystemExit):
                    self.verify(value)

    def test_activity_evidence_is_bound_to_commit_version_platform_and_archive(self):
        for key, value in (('version', '1.19.1'), ('commit', 'c' * 40),
                           ('platform', 'linux-x64'), ('desktopSha256', 'd' * 64)):
            with self.subTest(field=key):
                proof = evidence()
                proof[key] = value
                with self.assertRaises(SystemExit):
                    self.verify(proof)

    def test_wrong_scope_or_unperformed_activity_checks_are_rejected(self):
        for key, value in (('validationMode', 'focused-download-recovery'),
                           ('baseline', 'v1.19.0'), ('baselineCommit', 'c' * 40),
                           ('activityTests', 'skipped'), ('activityGuiTests', 'skipped'),
                           ('releaseScopeTests', True), ('priorChecks', 'passed'),
                           ('liveYouTubeVerified', True), ('liveYouTubeVerified', 0)):
            with self.subTest(field=key, value=value):
                proof = evidence()
                proof[key] = value
                with self.assertRaises(SystemExit):
                    self.verify(proof)

    def products(self, *, missing_module=False, missing_identity=False, stale_module=False):
        temporary = tempfile.TemporaryDirectory(prefix='myvideoapp-activity-release-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / 'artifacts').mkdir()
        (root / 'desktop').mkdir()
        (root / 'package.json').write_text(json.dumps({'version': VERSION}), encoding='utf-8')
        source = b'"""Activity logging source identity fixture."""\n'
        (root / 'desktop/activity.py').write_bytes(source)
        source_digest = hashlib.sha256(source).hexdigest()
        sums = []
        for name in release.ASSETS:
            with ZipFile(root / 'artifacts' / name, 'w') as archive:
                if name == release.ASSETS[0]:
                    archive.writestr('my-video-app/manifest.json', json.dumps({'version': VERSION}))
                elif name == release.ASSETS[1]:
                    sources = {'desktop/activity.py': source_digest} if not missing_identity else {'package.json': release.sha256(root / 'package.json')}
                    archive.writestr('MyVideoApp/APPMANIFEST.json', json.dumps({'version': VERSION, 'sourceFiles': sources}))
                    required = ('My Video App.exe', 'desktop/main.py', 'desktop/engine.py',
                                'desktop/concurrency.py', 'desktop/transport.py', 'desktop/transfer.py',
                                'desktop/bandwidth.py', 'runtime/python/pythonw.exe',
                                'runtime/python/python.exe', 'runtime/deno.exe',
                                'runtime/ffmpeg/ffmpeg.exe', 'runtime/ffmpeg/ffprobe.exe',
                                'runtime/python/Lib/site-packages/curl_cffi/__init__.py')
                    for member in required:
                        archive.writestr('MyVideoApp/' + member, b'fixture')
                    if not missing_module:
                        archive.writestr('MyVideoApp/desktop/activity.py', b'stale source' if stale_module else source)
                else:
                    archive.writestr('source.txt', b'fixture')
            sums.append(release.sha256(root / 'artifacts' / name) + '  ' + name + '\n')
        (root / 'artifacts/SHA256SUMS').write_text(''.join(sums), encoding='utf-8')
        return root

    def test_publisher_accepts_packaged_activity_with_current_source_identity(self):
        root = self.products()
        with patch.object(release, 'ROOT', root):
            version, hashes = release.validate()
        self.assertEqual(version, VERSION)
        self.assertEqual(set(hashes), set(release.ASSETS))

    def test_publisher_requires_activity_module_and_its_packaged_source_identity(self):
        for options in ({'missing_module': True}, {'missing_identity': True}, {'stale_module': True}):
            with self.subTest(options=options):
                root = self.products(**options)
                with patch.object(release, 'ROOT', root), self.assertRaisesRegex(ValueError, 'activity'):
                    release.validate()

    def test_build_requires_activity_module_before_packaging(self):
        temporary = tempfile.TemporaryDirectory(prefix='myvideoapp-activity-build-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / 'desktop').mkdir()
        (root / 'package.json').write_text(json.dumps({'version': VERSION}), encoding='utf-8')
        for name in ('main.py', 'engine.py', 'README.ko.md', 'THIRD_PARTY_NOTICES.md'):
            (root / 'desktop' / name).write_text('fixture\n', encoding='utf-8')
        lock = {'version': VERSION, 'inputs': []}
        with patch.object(build, 'load_lock', return_value=lock), self.assertRaisesRegex(ValueError, 'activity.py'):
            build.build_bundle(root, root / 'unused-lock.json', root / 'cache', root / 'out.zip', offline=True)

    def test_workflow_runs_exactly_three_new_suites_with_bundled_isolated_python(self):
        text = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        tests = re.findall(r'& \$python -I -B (\S+test\S+\.py)', text)
        self.assertEqual(tests, ['tests/test_activity_release.py', 'desktop/test_activity.py', 'desktop/test_activity_gui.py'])
        self.assertIn('$python = "$appRoot/runtime/python/python.exe"', text)
        self.assertIn('desktop/test_activity.py --app-root "$appRoot"', text)
        self.assertIn('desktop/test_activity_gui.py --app-root "$appRoot"', text)
        self.assertIn('activityGuiTests="passed"', text)
        self.assertIn('- tests/test_activity_release.py', text)
        self.assertNotIn('-m pip install', text)
        self.assertNotRegex(text, r'(?m)^\s*(?:python|& \$python).*\b(?:unittest discover|pytest)\b')

    def test_packager_binds_activity_scope_to_current_sources_and_new_checks_only(self):
        text = (ROOT / 'scripts/package.mjs').read_text(encoding='utf-8')
        self.assertIn("activityMode ? ['activity', 'activityGui', 'releaseScope']", text)
        self.assertIn('await sourceIdentity()', text)
        self.assertIn("assert.equal(version, '1.19.2')", text)
        self.assertIn("assert.equal(report.baselineCommit, '" + BASELINE_COMMIT + "')", text)
        self.assertIn("assert.equal(report.priorChecks, 'skipped-per-user')", text)
        self.assertIn("required='desktop/activity.py'", text)
        self.assertIn("assert required in manifest['sourceFiles']", text)

    def test_publisher_refuses_to_move_existing_activity_tag_for_different_content(self):
        root = self.products()
        (root / 'artifacts/WINDOWS-VALIDATION.json').write_text(json.dumps(evidence()), encoding='utf-8')
        before_commit = 'c' * 40
        before_tree, current_tree = 'd' * 40, 'e' * 40
        responses = {
            '/git/ref/tags/v1.19.2': {'object': {'type': 'commit', 'sha': before_commit}},
            '/releases/tags/v1.19.2': {'draft': False, 'prerelease': False},
            '/git/commits/' + before_commit: {'tree': {'sha': before_tree}},
            '/git/commits/' + COMMIT: {'tree': {'sha': current_tree}},
            '/git/trees/' + before_tree + '?recursive=1': {'truncated': False, 'tree': [
                {'path': 'desktop/activity.py', 'mode': '100644', 'type': 'blob', 'sha': '1' * 40}]},
            '/git/trees/' + current_tree + '?recursive=1': {'truncated': False, 'tree': [
                {'path': 'desktop/activity.py', 'mode': '100644', 'type': 'blob', 'sha': '2' * 40}]},
        }
        requests = []

        def offline_response(request, **_):
            prefix = 'https://api.github.com/repos/P-JSL/myapps'
            self.assertTrue(request.full_url.startswith(prefix))
            requests.append(request)
            return Response(json.dumps(responses[request.full_url[len(prefix):]]).encode('utf-8'))

        class Response:
            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self):
                return self.body

        environment = {'GITHUB_REPOSITORY': 'P-JSL/myapps', 'GITHUB_REF': 'refs/heads/main',
                       'GITHUB_SHA': COMMIT, 'GH_TOKEN': 'offline-fixture'}
        with patch.object(release, 'ROOT', root), patch.object(release, 'validate', return_value=(VERSION, {name: DIGEST for name in release.ASSETS})), \
                patch.dict(os.environ, environment, clear=True), patch.object(release, 'urlopen', side_effect=offline_response), \
                patch.object(release.subprocess, 'run') as command:
            with self.assertRaisesRegex(SystemExit, 'differing tracked content'):
                release.main()
            command.assert_not_called()
        self.assertTrue(requests)
        self.assertTrue(all(request.get_method() == 'GET' for request in requests))


if __name__ == '__main__':
    result = unittest.main(exit=False).result
    raise SystemExit(0 if result.wasSuccessful() and not result.skipped else 1)
