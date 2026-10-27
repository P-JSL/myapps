"""Only the 1.19.4 desktop v1.18 restore release scope; no prior suites run."""
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
VERSION = '1.19.4'
COMMIT = 'a' * 40
DIGEST = 'b' * 64
BASELINE = 'v1.19.3'
BASELINE_COMMIT = '2d11e5043fa403fbe373feb7c168e490f4ef0b69'
DOWNLOAD_BASELINE = 'v1.18.0'
DOWNLOAD_BASELINE_COMMIT = '1756c8dec1cb6e655fd486ab4a55fcc35641fd74'
# The complete v1.18.0 inputs array, serialized with sorted keys and compact JSON.
INPUTS_SHA256 = '0b1a0aac4c30abddc20788194cf53ece5a2a23038b6b60c6a52dca2f059e2501'
INPUT_IDS = ('python', 'yt-dlp', 'yt-dlp-ejs', 'deno', 'pyside6-essentials', 'shiboken6', 'ffmpeg')
CORE_SOURCES = ('desktop/main.py', 'desktop/engine.py', 'desktop/concurrency.py',
                'desktop/storage.py', 'desktop/theme.py', 'desktop/activity.py', 'desktop/dependencies-lock.json')
CORE_RUNTIME = ('My Video App.exe', 'runtime/python/pythonw.exe', 'runtime/python/python.exe',
                'runtime/deno.exe', 'runtime/ffmpeg/ffmpeg.exe', 'runtime/ffmpeg/ffprobe.exe',
                'runtime/python/Lib/site-packages/yt_dlp/__init__.py',
                'runtime/python/Lib/site-packages/yt_dlp_ejs/__init__.py',
                'runtime/python/Lib/site-packages/PySide6/__init__.py',
                'runtime/python/Lib/site-packages/shiboken6/__init__.py')


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load_script('v18_restore_release', 'publish-release.py')
build = load_script('v18_restore_build', 'build-desktop.py')


def evidence(digest=DIGEST):
    return {'version': VERSION, 'commit': COMMIT, 'platform': 'windows-x64',
            'validationMode': 'focused-desktop-v18-restore', 'baseline': BASELINE,
            'baselineCommit': BASELINE_COMMIT, 'downloadBaseline': DOWNLOAD_BASELINE,
            'downloadBaselineCommit': DOWNLOAD_BASELINE_COMMIT, 'desktopSha256': digest,
            'v18RestoreTests': 'passed', 'v18RestoreGuiTests': 'passed',
            'releaseScopeTests': 'passed', 'priorChecks': 'skipped-per-user',
            'liveYouTubeVerified': False}


class V18RestoreReleaseTests(unittest.TestCase):
    def verify(self, value, digest=DIGEST):
        return release.validate_windows_evidence(VERSION, COMMIT, value, digest)

    def test_accepts_new_scope_without_historical_protocol_reports(self):
        with patch.object(release, 'validate_transport_report', side_effect=AssertionError('Old proof was reused')):
            self.assertIsNone(self.verify(evidence()))

    def test_every_restore_evidence_field_is_required(self):
        for key in evidence():
            with self.subTest(field=key):
                proof = evidence()
                del proof[key]
                with self.assertRaises(SystemExit):
                    self.verify(proof)

    def test_evidence_is_bound_to_version_commit_platform_and_current_archive(self):
        for key, value in (('version', '1.19.3'), ('commit', 'c' * 40),
                           ('platform', 'linux-x64'), ('desktopSha256', 'd' * 64)):
            with self.subTest(field=key):
                proof = evidence() | {key: value}
                with self.assertRaises(SystemExit):
                    self.verify(proof)
        with self.assertRaises(SystemExit):
            self.verify(evidence(), digest='e' * 64)

    def test_wrong_scope_baselines_skipped_tests_and_live_claims_are_rejected(self):
        for key, value in (('validationMode', 'focused-desktop-no-http3'),
                           ('baseline', 'v1.19.2'), ('baselineCommit', 'c' * 40),
                           ('downloadBaseline', 'v1.19.3'), ('downloadBaselineCommit', 'd' * 40),
                           ('v18RestoreTests', 'skipped'), ('v18RestoreGuiTests', True),
                           ('releaseScopeTests', 'failed'), ('priorChecks', 'passed'),
                           ('liveYouTubeVerified', True), ('liveYouTubeVerified', 0)):
            with self.subTest(field=key, value=value), self.assertRaises(SystemExit):
                self.verify(evidence() | {key: value})

    def test_old_test_results_do_not_substitute_for_new_test_results(self):
        old = {'noHttp3Tests': 'passed', 'noHttp3GuiTests': 'passed',
               'activityTests': 'passed', 'activityGuiTests': 'passed',
               'recoveryTests': 'passed', 'transportTests': 'passed',
               'engineTransportTests': 'passed', 'bandwidthTests': 'passed',
               'rangeTests': 'passed', 'actualProtocols': ['h3', 'h2', 'http/1.1'],
               'transportReportSha256': DIGEST}
        for missing in ('v18RestoreTests', 'v18RestoreGuiTests', 'releaseScopeTests'):
            with self.subTest(missing=missing):
                proof = evidence() | old
                del proof[missing]
                with self.assertRaises(SystemExit):
                    self.verify(proof)

    def products(self, *, missing_module=False, missing_identity=False, stale_module=False,
                 stale_source=False, missing_runtime=None, added_runtime=None,
                 wrong_inputs=False, native_match=False, stale_output=False, extra_output=False,
                 vendored_certifi=False):
        temporary = tempfile.TemporaryDirectory(prefix='myvideoapp-v18-restore-release-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / 'artifacts').mkdir()
        (root / 'desktop').mkdir()
        (root / 'package.json').write_text(json.dumps({'version': VERSION}), encoding='utf-8')
        lock = json.loads((ROOT / 'desktop/dependencies-lock.json').read_text(encoding='utf-8'))
        lock['version'] = VERSION
        if wrong_inputs:
            lock['inputs'][1]['version'] = '2099.01.01'
        if native_match:
            lock['nativeTransportMatch'] = {'wheel_member': 'curl_cffi/libcurl.dll'}
        source_data = {name: ('"""활동 로그 source fixture: ' + name + '."""\n').encode('utf-8')
                       for name in CORE_SOURCES}
        source_data['desktop/dependencies-lock.json'] = json.dumps(lock, ensure_ascii=False).encode('utf-8')
        for name, data in source_data.items():
            (root / name).write_bytes(data)
        sources = {name: hashlib.sha256(data).hexdigest() for name, data in source_data.items()}
        if missing_identity:
            del sources['desktop/activity.py']
        payloads = {name: b'runtime fixture' for name in CORE_RUNTIME}
        payloads.update(source_data)
        if vendored_certifi:
            payloads.update({
                'runtime/python/Lib/site-packages/pip/_vendor/certifi/cacert.pem': b'pinned pip CA fixture',
                'runtime/python/Lib/site-packages/pip-26.2.2.dist-info/licenses/src/pip/_vendor/certifi/LICENSE': b'pinned pip license fixture',
            })
        if missing_module:
            del payloads['desktop/activity.py']
        if missing_runtime:
            del payloads[missing_runtime]
        if stale_module:
            payloads['desktop/activity.py'] = b'stale packaged source\n'
        if added_runtime:
            payloads[added_runtime] = b'removed runtime fixture'
        files = {name: hashlib.sha256(data).hexdigest() for name, data in payloads.items()}
        if stale_output:
            files['runtime/deno.exe'] = '0' * 64
        manifest = {'version': VERSION, 'sourceFiles': sources, 'files': files, 'inputs': lock['inputs']}
        sums = []
        for name in release.ASSETS:
            with ZipFile(root / 'artifacts' / name, 'w') as archive:
                if name == release.ASSETS[0]:
                    archive.writestr('my-video-app/manifest.json', json.dumps({'version': VERSION}))
                elif name == release.ASSETS[1]:
                    archive.writestr('MyVideoApp/APPMANIFEST.json', json.dumps(manifest))
                    for member, data in payloads.items():
                        archive.writestr('MyVideoApp/' + member, data)
                    if extra_output:
                        archive.writestr('MyVideoApp/unlisted.txt', b'not in manifest')
                else:
                    archive.writestr('source.txt', b'fixture')
            sums.append(release.sha256(root / 'artifacts' / name) + '  ' + name + '\n')
        (root / 'artifacts/SHA256SUMS').write_text(''.join(sums), encoding='utf-8')
        if stale_source:
            (root / 'desktop/activity.py').write_bytes(b'changed after packaging\n')
        return root

    def test_publisher_accepts_v18_runtime_and_preserved_activity_with_current_identity(self):
        root = self.products()
        with patch.object(release, 'ROOT', root):
            version, hashes = release.validate()
        self.assertEqual(version, VERSION)
        self.assertEqual(set(hashes), set(release.ASSETS))

    def check_packager_native_runtime(self, names):
        text = (ROOT / 'scripts/package.mjs').read_text(encoding='utf-8')
        match = re.search(r"\n(        site_packages=.*?)(?=\n    if manifest\['version'\] in)", text, re.S)
        self.assertIsNotNone(match, 'The actual packager runtime guard is required')
        guard = '\n'.join(line[8:] for line in match.group(1).splitlines())
        exec(compile(guard, 'scripts/package.mjs:native-runtime-guard', 'exec'), {'names': names})

    def test_pinned_pip_vendored_certifi_and_license_remain_allowed(self):
        root = self.products(vendored_certifi=True)
        with patch.object(release, 'ROOT', root):
            version, hashes = release.validate()
        self.assertEqual(version, VERSION)
        self.assertEqual(set(hashes), set(release.ASSETS))
        with ZipFile(root / 'artifacts' / release.ASSETS[1]) as archive:
            self.check_packager_native_runtime(archive.namelist())
            manifest = json.loads(archive.read('MyVideoApp/APPMANIFEST.json'))
            for name in ('runtime/python/Lib/site-packages/pip/_vendor/certifi/cacert.pem',
                         'runtime/python/Lib/site-packages/pip-26.2.2.dist-info/licenses/src/pip/_vendor/certifi/LICENSE'):
                self.assertEqual(hashlib.sha256(archive.read('MyVideoApp/' + name)).hexdigest(),
                                 manifest['files'][name])

    def test_publisher_requires_activity_module_and_current_packaged_source(self):
        for options in ({'missing_module': True}, {'missing_identity': True},
                        {'stale_module': True}, {'stale_source': True}):
            with self.subTest(options=options):
                root = self.products(**options)
                with patch.object(release, 'ROOT', root), self.assertRaises(ValueError):
                    release.validate()

    def test_restore_requires_core_sources_and_original_runtime_packages(self):
        for name in (*CORE_SOURCES, *CORE_RUNTIME):
            with self.subTest(runtime=name):
                root = self.products(missing_runtime=name)
                with patch.object(release, 'ROOT', root), self.assertRaisesRegex(ValueError, 'runtime missing'):
                    release.validate()

    def test_restore_rejects_removed_native_packages_and_app_transport_modules(self):
        for name in ('desktop/bandwidth.py', 'desktop/transfer.py', 'desktop/transport.py',
                     'runtime/python/Lib/site-packages/curl_cffi/__init__.py',
                     'runtime/python/Lib/site-packages/cffi/__init__.py',
                     'runtime/python/Lib/site-packages/curl_cffi-0.13.0.dist-info/METADATA',
                     'runtime/python/Lib/site-packages/curl_cffi.libs/libcurl.dll',
                     'runtime/python/Lib/site-packages/cffi-2.0.0.dist-info/METADATA',
                     'runtime/python/Lib/site-packages/_cffi_backend.cp313-win_amd64.pyd',
                     'runtime/python/Lib/site-packages/certifi/cacert.pem',
                     'runtime/python/Lib/site-packages/certifi-2026.10.1.dist-info/METADATA',
                     'runtime/python/Lib/site-packages/pycparser-2.23.dist-info/METADATA',
                     'runtime/python/Lib/site-packages/pycparser/__init__.py'):
            with self.subTest(runtime=name):
                root = self.products(added_runtime=name)
                with patch.object(release, 'ROOT', root), self.assertRaisesRegex(ValueError, 'still bundled'):
                    release.validate()
                if '/site-packages/' in name:
                    with self.assertRaisesRegex(AssertionError, 'still bundled'):
                        self.check_packager_native_runtime(['MyVideoApp/' + name])

    def test_publisher_rejects_runtime_drift_native_matching_and_output_tampering(self):
        for options in ({'wrong_inputs': True}, {'native_match': True},
                        {'stale_output': True}, {'extra_output': True}):
            with self.subTest(options=options):
                root = self.products(**options)
                with patch.object(release, 'ROOT', root), self.assertRaises(ValueError):
                    release.validate()

    def test_lock_restores_exact_v18_runtime_inputs_without_git_history(self):
        lock = build.load_lock(ROOT / 'desktop/dependencies-lock.json')
        self.assertEqual(lock['version'], VERSION)
        self.assertEqual(tuple(item['id'] for item in lock['inputs']), INPUT_IDS)
        self.assertEqual(build.INPUT_IDS, INPUT_IDS)
        serialized = json.dumps(lock['inputs'], ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        self.assertEqual(hashlib.sha256(serialized.encode('utf-8')).hexdigest(), INPUTS_SHA256)
        self.assertNotIn('nativeTransportMatch', lock)
        self.assertEqual(release.V18_RUNTIME_INPUTS_SHA256, INPUTS_SHA256)

    def test_builder_rejects_removed_runtime_inputs_and_native_matching(self):
        lock = json.loads((ROOT / 'desktop/dependencies-lock.json').read_text(encoding='utf-8'))
        for mutate in ('input', 'match'):
            with self.subTest(mutation=mutate), tempfile.TemporaryDirectory() as directory:
                value = json.loads(json.dumps(lock))
                if mutate == 'input':
                    value['inputs'].insert(-1, {'id': 'curl-cffi'})
                else:
                    value['nativeTransportMatch'] = {'wheel_member': 'curl_cffi/libcurl.dll'}
                path = Path(directory) / 'lock.json'
                path.write_text(json.dumps(value), encoding='utf-8')
                with self.assertRaises(ValueError):
                    build.load_lock(path)

    def test_build_requires_activity_module_before_packaging_1_19_4(self):
        with tempfile.TemporaryDirectory(prefix='myvideoapp-v18-restore-build-') as directory:
            root = Path(directory)
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
        self.assertEqual(tests, ['tests/test_v18_restore_release.py', 'desktop/test_v18_restore.py',
                                 'desktop/test_v18_restore_gui.py'])
        self.assertEqual(len(re.findall(r'(?m)^\s*& \$python\b', text)), 3)
        self.assertIn('$python = "$appRoot/runtime/python/python.exe"', text)
        self.assertIn('desktop/test_v18_restore.py --app-root "$appRoot" --real-download -v', text)
        self.assertIn('desktop/test_v18_restore_gui.py --app-root "$appRoot" -v', text)
        self.assertIn('- tests/test_v18_restore_release.py', text)
        self.assertEqual(text.count('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'), 3)
        self.assertNotIn('-m pip install', text)
        self.assertNotIn('fetch-depth: 0', text)
        self.assertNotRegex(text, r'(?m)^\s*(?:python|& \$python).*\b(?:unittest discover|pytest)\b')

    def test_workflow_writes_only_current_scope_evidence_after_success(self):
        text = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        for item in ('version=(Get-Content -Encoding utf8 package.json | ConvertFrom-Json).version',
                     'commit=$env:GITHUB_SHA', 'platform="windows-x64"',
                     'validationMode="focused-desktop-v18-restore"', 'baseline="' + BASELINE + '"',
                     'baselineCommit="' + BASELINE_COMMIT + '"',
                     'downloadBaseline="' + DOWNLOAD_BASELINE + '"',
                     'downloadBaselineCommit="' + DOWNLOAD_BASELINE_COMMIT + '"',
                     'desktopSha256=(Get-FileHash artifacts/my-video-app-desktop-windows-x64.zip -Algorithm SHA256)',
                     'v18RestoreTests="passed"', 'v18RestoreGuiTests="passed"', 'releaseScopeTests="passed"',
                     'priorChecks="skipped-per-user"', 'liveYouTubeVerified=$false',
                     'Set-Content -Encoding utf8 artifacts/WINDOWS-VALIDATION.json'):
            with self.subTest(field=item):
                self.assertIn(item, text)
        self.assertLess(text.index('desktop/test_v18_restore_gui.py --app-root'), text.index('@{version='))
        for old in ('actualProtocols=', 'noHttp3Tests="passed"', 'activityTests="passed"', 'transportTests="passed"'):
            self.assertNotIn(old, text)

    def test_packager_requires_positive_new_checks_and_current_source_zip_identity(self):
        text = (ROOT / 'scripts/package.mjs').read_text(encoding='utf-8')
        for required in ("v18RestoreMode ? ['v18Restore', 'v18RestoreGui', 'releaseScope']",
                         'Number.isInteger(report.checks?.[name]) && report.checks[name] > 0',
                         "assert.equal(version, '1.19.4')", "assert.equal(report.baseline, 'v1.19.3')",
                         "assert.equal(report.baselineCommit, '" + BASELINE_COMMIT + "')",
                         "assert.equal(report.downloadBaseline, 'v1.18.0')",
                         "assert.equal(report.downloadBaselineCommit, '" + DOWNLOAD_BASELINE_COMMIT + "')",
                         "assert.equal(report.priorChecks, 'skipped-per-user')", 'await sourceIdentity()',
                         'if (v18RestoreMode || noHttp3Mode || activityMode || recoveryMode || transportMode || concurrencyMode)',
                         "['diff', '--name-only', report.baselineCommit",
                         'assert.deepEqual(currentManifest, beforeManifest',
                         'assert.equal(report.liveYouTubeVerified, false)', "await treeIdentity('dist')",
                         'report.desktop?.sha256', 'hash(await readFile(desktop.artifact))',
                         "set(names)=={'MyVideoApp/'+name for name in manifest['files']}",
                         "hashlib.sha256(bundle.read('MyVideoApp/'+name)).hexdigest()==digest",
                         "hashlib.sha256((root/name).read_bytes()).hexdigest()==digest",
                         "manifest['version'] in ('1.19.2', '1.19.3', '1.19.4')",
                         "required='desktop/activity.py'", "assert required in manifest['sourceFiles']",
                         "assert manifest['inputs']==lock['inputs']", INPUTS_SHA256):
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
                {'path': 'desktop/engine.py', 'mode': '100644', 'type': 'blob', 'sha': '1' * 40}]},
            '/git/trees/' + current_tree + '?recursive=1': {'truncated': False, 'tree': [
                {'path': 'desktop/engine.py', 'mode': '100644', 'type': 'blob',
                 'sha': ('2' if changed else '1') * 40}]},
        }

    def test_existing_restore_tag_cannot_move_for_changed_product(self):
        root, hashes = self.publish_fixture()
        with self.assertRaisesRegex(SystemExit, 'differing tracked content'):
            self.publish(root, self.existing_release(hashes, changed=True))

    def test_existing_identical_release_skips_without_tag_or_asset_mutation(self):
        root, hashes = self.publish_fixture()
        self.publish(root, self.existing_release(hashes))
        self.assertFalse((root / 'artifacts/SHA256SUMS-RELEASE.txt').exists())

    def test_existing_restore_release_rejects_mismatched_asset_digest(self):
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
        for required in ('v1.18.0', 'yt-dlp', 'FFmpeg', '실행·활동 로그', '동시성',
                         '**새 폴더에 ZIP 전체 압축 해제**', '사용자 DB·실행 로그·기본 저장 폴더 설정은 유지',
                         '한 번 다시 다운로드', '일반 `.part` 파일의 이어받기는 유지',
                         '이전 검사는 사용자 요청으로 건너뛰', '실제 로컬 미디어 다운로드·변환',
                         '실제 YouTube 다운로드는 재검증하지 않았', '속도 향상을 보장하지 않습니다'):
            with self.subTest(note=required):
                self.assertIn(required, notes[0])


if __name__ == '__main__':
    result = unittest.main(exit=False).result
    raise SystemExit(0 if result.wasSuccessful() and not result.skipped else 1)
