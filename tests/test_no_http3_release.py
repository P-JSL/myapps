"""Only the 1.19.3 desktop HTTP/3 removal publication scope; no prior suites run."""
import hashlib
import importlib.util
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.19.3'
COMMIT = 'a' * 40
DIGEST = 'b' * 64
BASELINE = 'v1.19.2'
BASELINE_COMMIT = 'dd3187fcfab45cad89fb95ad1cb24c3edd2c6365'


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load_script('no_http3_release', 'publish-release.py')
build = load_script('no_http3_build', 'build-desktop.py')


def evidence(digest=DIGEST):
    return {'version': VERSION, 'commit': COMMIT, 'platform': 'windows-x64',
            'validationMode': 'focused-desktop-no-http3', 'baseline': BASELINE,
            'baselineCommit': BASELINE_COMMIT, 'desktopSha256': digest,
            'noHttp3Tests': 'passed', 'noHttp3GuiTests': 'passed',
            'releaseScopeTests': 'passed', 'priorChecks': 'skipped-per-user',
            'liveYouTubeVerified': False}


class NoHttp3ReleaseTests(unittest.TestCase):
    def verify(self, value, digest=DIGEST):
        return release.validate_windows_evidence(VERSION, COMMIT, value, digest)

    def test_accepts_new_scope_without_historical_protocol_reports(self):
        with patch.object(release, 'validate_transport_report', side_effect=AssertionError('Old proof was reused')):
            self.assertIsNone(self.verify(evidence()))

    def test_every_no_http3_evidence_field_is_required(self):
        for key in evidence():
            with self.subTest(field=key):
                proof = evidence()
                del proof[key]
                with self.assertRaises(SystemExit):
                    self.verify(proof)

    def test_evidence_is_bound_to_version_commit_platform_and_current_archive(self):
        for key, value in (('version', '1.19.2'), ('commit', 'c' * 40),
                           ('platform', 'linux-x64'), ('desktopSha256', 'd' * 64)):
            with self.subTest(field=key):
                proof = evidence()
                proof[key] = value
                with self.assertRaises(SystemExit):
                    self.verify(proof)
        with self.assertRaises(SystemExit):
            self.verify(evidence(), digest='e' * 64)

    def test_wrong_scope_baseline_skipped_tests_and_live_claims_are_rejected(self):
        for key, value in (('validationMode', 'focused-desktop-activity'),
                           ('baseline', 'v1.19.1'), ('baselineCommit', 'c' * 40),
                           ('noHttp3Tests', 'skipped'), ('noHttp3GuiTests', True),
                           ('releaseScopeTests', 'failed'), ('priorChecks', 'passed'),
                           ('liveYouTubeVerified', True), ('liveYouTubeVerified', 0)):
            with self.subTest(field=key, value=value):
                proof = evidence()
                proof[key] = value
                with self.assertRaises(SystemExit):
                    self.verify(proof)

    def test_old_test_results_do_not_substitute_for_new_test_results(self):
        old = {'activityTests': 'passed', 'activityGuiTests': 'passed',
               'recoveryTests': 'passed', 'transportTests': 'passed',
               'engineTransportTests': 'passed', 'bandwidthTests': 'passed',
               'rangeTests': 'passed', 'actualProtocols': ['h3', 'h2', 'http/1.1'],
               'transportReportSha256': DIGEST}
        for missing in ('noHttp3Tests', 'noHttp3GuiTests', 'releaseScopeTests'):
            with self.subTest(missing=missing):
                proof = evidence() | old
                del proof[missing]
                with self.assertRaises(SystemExit):
                    self.verify(proof)

    def products(self, *, missing_module=False, missing_identity=False,
                 stale_module=False, stale_source=False, missing_runtime=None):
        temporary = tempfile.TemporaryDirectory(prefix='myvideoapp-no-http3-release-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / 'artifacts').mkdir()
        (root / 'desktop').mkdir()
        (root / 'package.json').write_text(json.dumps({'version': VERSION}), encoding='utf-8')
        source = b'"""Preserved activity logging source identity fixture."""\n'
        (root / 'desktop/activity.py').write_bytes(source)
        source_digest = hashlib.sha256(source).hexdigest()
        sums = []
        for name in release.ASSETS:
            with ZipFile(root / 'artifacts' / name, 'w') as archive:
                if name == release.ASSETS[0]:
                    archive.writestr('my-video-app/manifest.json', json.dumps({'version': VERSION}))
                elif name == release.ASSETS[1]:
                    sources = {'desktop/activity.py': source_digest} if not missing_identity else {
                        'package.json': release.sha256(root / 'package.json')}
                    archive.writestr('MyVideoApp/APPMANIFEST.json', json.dumps({'version': VERSION, 'sourceFiles': sources}))
                    required = ('My Video App.exe', 'desktop/main.py', 'desktop/engine.py',
                                'desktop/concurrency.py', 'desktop/transport.py', 'desktop/transfer.py',
                                'desktop/bandwidth.py', 'runtime/python/pythonw.exe',
                                'runtime/python/python.exe', 'runtime/deno.exe',
                                'runtime/ffmpeg/ffmpeg.exe', 'runtime/ffmpeg/ffprobe.exe',
                                'runtime/python/Lib/site-packages/curl_cffi/__init__.py')
                    for member in required:
                        if member != missing_runtime:
                            archive.writestr('MyVideoApp/' + member, b'fixture')
                    if not missing_module:
                        archive.writestr('MyVideoApp/desktop/activity.py', b'stale source' if stale_module else source)
                else:
                    archive.writestr('source.txt', b'fixture')
            sums.append(release.sha256(root / 'artifacts' / name) + '  ' + name + '\n')
        (root / 'artifacts/SHA256SUMS').write_text(''.join(sums), encoding='utf-8')
        if stale_source:
            (root / 'desktop/activity.py').write_bytes(b'changed after packaging\n')
        return root

    def test_publisher_accepts_preserved_activity_module_with_current_identity(self):
        root = self.products()
        with patch.object(release, 'ROOT', root):
            version, hashes = release.validate()
        self.assertEqual(version, VERSION)
        self.assertEqual(set(hashes), set(release.ASSETS))

    def test_publisher_requires_activity_module_and_current_packaged_source(self):
        for options in ({'missing_module': True}, {'missing_identity': True},
                        {'stale_module': True}, {'stale_source': True}):
            with self.subTest(options=options):
                root = self.products(**options)
                with patch.object(release, 'ROOT', root), self.assertRaises(ValueError):
                    release.validate()

    def test_no_http3_release_retains_transport_and_other_required_runtimes(self):
        for name in ('desktop/concurrency.py', 'desktop/transport.py', 'desktop/transfer.py',
                     'desktop/bandwidth.py', 'runtime/python/python.exe',
                     'runtime/python/Lib/site-packages/curl_cffi/__init__.py',
                     'runtime/deno.exe', 'runtime/ffmpeg/ffmpeg.exe', 'runtime/ffmpeg/ffprobe.exe'):
            with self.subTest(runtime=name):
                root = self.products(missing_runtime=name)
                with patch.object(release, 'ROOT', root), self.assertRaisesRegex(ValueError, 'runtime missing'):
                    release.validate()

    def test_build_requires_activity_module_before_packaging_1_19_3(self):
        temporary = tempfile.TemporaryDirectory(prefix='myvideoapp-no-http3-build-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / 'desktop').mkdir()
        (root / 'package.json').write_text(json.dumps({'version': VERSION}), encoding='utf-8')
        for name in ('main.py', 'engine.py', 'README.ko.md', 'THIRD_PARTY_NOTICES.md'):
            (root / 'desktop' / name).write_text('fixture\n', encoding='utf-8')
        with patch.object(build, 'load_lock', return_value={'version': VERSION, 'inputs': []}), \
                self.assertRaisesRegex(ValueError, 'activity.py'):
            build.build_bundle(root, root / 'unused-lock.json', root / 'cache', root / 'out.zip', offline=True)

    def test_workflow_runs_exactly_three_new_suites_with_isolated_bundled_python(self):
        text = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        tests = re.findall(r'& \$python -I -B (\S+test\S+\.py)', text)
        self.assertEqual(tests, ['tests/test_no_http3_release.py', 'desktop/test_no_http3.py',
                                 'desktop/test_no_http3_gui.py'])
        self.assertEqual(len(re.findall(r'(?m)^\s*& \$python\b', text)), 3)
        self.assertIn('$python = "$appRoot/runtime/python/python.exe"', text)
        self.assertIn('desktop/test_no_http3.py --app-root "$appRoot" --real-http1 -v', text)
        self.assertIn('desktop/test_no_http3_gui.py --app-root "$appRoot" -v', text)
        self.assertIn('- tests/test_no_http3_release.py', text)
        self.assertEqual(text.count('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'), 3)
        self.assertNotIn('-m pip install', text)
        self.assertNotRegex(text, r'(?m)^\s*(?:python|& \$python).*\b(?:unittest discover|pytest)\b')

    def test_workflow_writes_only_current_scope_evidence_after_success(self):
        text = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        for item in ('version=(Get-Content -Encoding utf8 package.json | ConvertFrom-Json).version',
                     'commit=$env:GITHUB_SHA', 'platform="windows-x64"',
                     'validationMode="focused-desktop-no-http3"', 'baseline="' + BASELINE + '"',
                     'baselineCommit="' + BASELINE_COMMIT + '"',
                     'desktopSha256=(Get-FileHash artifacts/my-video-app-desktop-windows-x64.zip -Algorithm SHA256)',
                     'noHttp3Tests="passed"', 'noHttp3GuiTests="passed"', 'releaseScopeTests="passed"',
                     'priorChecks="skipped-per-user"', 'liveYouTubeVerified=$false'):
            with self.subTest(field=item):
                self.assertIn(item, text)
        self.assertLess(text.index('desktop/test_no_http3_gui.py --app-root'), text.index('@{version='))
        self.assertNotIn('actualProtocols=', text)
        self.assertNotIn('activityTests="passed"', text)

    def test_packager_requires_positive_new_checks_and_current_source_zip_identity(self):
        text = (ROOT / 'scripts/package.mjs').read_text(encoding='utf-8')
        for required in ("noHttp3Mode ? ['noHttp3', 'noHttp3Gui', 'releaseScope']",
                         'Number.isInteger(report.checks?.[name]) && report.checks[name] > 0',
                         "assert.equal(version, '1.19.3')", "assert.equal(report.baseline, 'v1.19.2')",
                         "assert.equal(report.baselineCommit, '" + BASELINE_COMMIT + "')",
                         "assert.equal(report.priorChecks, 'skipped-per-user')", 'await sourceIdentity()',
                         'if (noHttp3Mode || activityMode || recoveryMode || transportMode || concurrencyMode)',
                         "['diff', '--name-only', report.baselineCommit",
                         "assert.deepEqual(currentManifest, beforeManifest",
                         "assert.equal(report.liveYouTubeVerified, false)", "await treeIdentity('dist')",
                         'report.desktop?.sha256', "hash(await readFile(desktop.artifact))",
                         "set(names)=={'MyVideoApp/'+name for name in manifest['files']}",
                         "hashlib.sha256(bundle.read('MyVideoApp/'+name)).hexdigest()==digest",
                         "hashlib.sha256((root/name).read_bytes()).hexdigest()==digest",
                         "manifest['version'] in ('1.19.2', '1.19.3')",
                         "required='desktop/activity.py'", "assert required in manifest['sourceFiles']"):
            with self.subTest(requirement=required):
                self.assertIn(required, text)

    def publish_fixture(self):
        root = self.products()
        digest = release.sha256(root / 'artifacts' / release.ASSETS[1])
        (root / 'artifacts/WINDOWS-VALIDATION.json').write_text(json.dumps(evidence(digest)), encoding='utf-8')
        return root, {name: release.sha256(root / 'artifacts' / name) for name in release.ASSETS}

    def publish(self, root, responses, command=None):
        requests = []

        class Response:
            def __init__(self, body):
                self.body = body

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self):
                return self.body

        def offline_response(request, **_):
            prefix = 'https://api.github.com/repos/P-JSL/myapps'
            self.assertTrue(request.full_url.startswith(prefix))
            requests.append(request)
            path = request.full_url[len(prefix):]
            self.assertIn(path, responses)
            return Response(json.dumps(responses[path]).encode('utf-8'))

        environment = {'GITHUB_REPOSITORY': 'P-JSL/myapps', 'GITHUB_REF': 'refs/heads/main',
                       'GITHUB_SHA': COMMIT, 'GH_TOKEN': 'offline-fixture'}
        with patch.object(release, 'ROOT', root), patch.dict(os.environ, environment, clear=True), \
                patch.object(release, 'urlopen', side_effect=offline_response), \
                patch.object(release, 'validate_transport_report', side_effect=AssertionError('Old proof was reused')), \
                patch.object(release.subprocess, 'run', side_effect=command) as commands:
            try:
                with redirect_stdout(io.StringIO()):
                    release.main()
            finally:
                self.assertTrue(all(request.get_method() == 'GET' for request in requests))
                if command is None:
                    commands.assert_not_called()

    def existing_release(self, hashes, *, changed=False, bad_digest=False):
        before_commit, before_tree, current_tree = 'c' * 40, 'd' * 40, 'e' * 40
        assets = [{'name': name, 'digest': 'sha256:' + ('0' * 64 if bad_digest else digest)}
                  for name, digest in hashes.items()]
        return {
            '/git/ref/tags/v' + VERSION: {'object': {'type': 'commit', 'sha': before_commit}},
            '/releases/tags/v' + VERSION: {'draft': False, 'prerelease': False, 'assets': assets},
            '/git/commits/' + before_commit: {'tree': {'sha': before_tree}},
            '/git/commits/' + COMMIT: {'tree': {'sha': current_tree}},
            '/git/trees/' + before_tree + '?recursive=1': {'truncated': False, 'tree': [
                {'path': 'desktop/transport.py', 'mode': '100644', 'type': 'blob', 'sha': '1' * 40}]},
            '/git/trees/' + current_tree + '?recursive=1': {'truncated': False, 'tree': [
                {'path': 'desktop/transport.py', 'mode': '100644', 'type': 'blob',
                 'sha': ('2' if changed else '1') * 40}]},
        }

    def test_existing_no_http3_tag_cannot_move_for_changed_product(self):
        root, hashes = self.publish_fixture()
        with self.assertRaisesRegex(SystemExit, 'differing tracked content'):
            self.publish(root, self.existing_release(hashes, changed=True))

    def test_existing_identical_release_skips_without_tag_or_asset_mutation(self):
        root, hashes = self.publish_fixture()
        self.publish(root, self.existing_release(hashes))
        self.assertFalse((root / 'artifacts/SHA256SUMS-RELEASE.txt').exists())

    def test_existing_no_http3_release_rejects_mismatched_asset_digest(self):
        root, hashes = self.publish_fixture()
        with self.assertRaisesRegex(SystemExit, 'asset digest differs'):
            self.publish(root, self.existing_release(hashes, bad_digest=True))

    def test_new_publication_uses_only_new_evidence_and_describes_limited_scope(self):
        root, _ = self.publish_fixture()
        commands, notes = [], []

        def capture(command, **kwargs):
            commands.append(command)
            self.assertFalse(kwargs['shell'])
            if '--notes-file' in command:
                notes.append(Path(command[command.index('--notes-file') + 1]).read_text(encoding='utf-8'))

        self.publish(root, {'/git/ref/tags/v' + VERSION: None, '/releases/tags/v' + VERSION: None}, capture)
        self.assertEqual([command[1:3] for command in commands], [['release', 'create'], ['release', 'edit']])
        self.assertIn('--target', commands[0])
        self.assertIn(COMMIT, commands[0])
        self.assertNotIn('--force', commands[0])
        self.assertNotIn(release.TRANSPORT_REPORT, ' '.join(commands[0]))
        self.assertEqual(notes[0], notes[1])
        for required in ('HTTP/3 전송과 관련 설정을 제거', 'HTTP/2·HTTP/1.1', '병렬 다운로드',
                         '속도 제한', '실행·활동 로그', '이전 검사는 사용자 요청으로 건너뛰',
                         '실제 YouTube 다운로드는 재검증하지 않았', '성능 향상을 보장하지 않습니다'):
            with self.subTest(note=required):
                self.assertIn(required, notes[0])


if __name__ == '__main__':
    result = unittest.main(exit=False).result
    raise SystemExit(0 if result.wasSuccessful() and not result.skipped else 1)
