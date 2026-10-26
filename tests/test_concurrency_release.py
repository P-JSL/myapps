"""Focused 1.18 release contracts; all GitHub and publication calls stay offline.

This suite is new for desktop concurrency. It does not discover or invoke any
previous publisher, GUI, media, launcher, or extension test suite.
"""
from io import BytesIO
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('concurrency_release_subject', ROOT / 'scripts/publish-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
VERSION = '1.18.0'
COMMIT = 'a' * 40
BASELINE_COMMIT = '252b452da32f16dc81cb36cca94231879d43c5f1'


def focused_evidence(desktop_sha256='d' * 64):
    return {
        'version': VERSION,
        'commit': COMMIT,
        'platform': 'windows-x64',
        'validationMode': 'focused-desktop-concurrency',
        'baseline': 'v1.17.0',
        'baselineCommit': BASELINE_COMMIT,
        'desktopSha256': desktop_sha256,
        'concurrencyTests': 'passed',
        'concurrencyGuiTests': 'passed',
        'releaseScopeTests': 'passed',
        'priorChecks': 'skipped-per-user',
        'liveYouTubeVerified': False,
    }


class ConcurrencyEvidenceTests(unittest.TestCase):
    def verify(self, evidence, version=VERSION, digest='d' * 64):
        return release.validate_windows_evidence(version, COMMIT, evidence, digest)

    def test_exact_focused_evidence_is_accepted(self):
        self.assertIsNone(self.verify(focused_evidence()))

    def test_identity_is_bound_to_current_version_commit_and_platform(self):
        for key, value in (('version', '1.17.0'), ('commit', 'b' * 40), ('platform', 'linux-x64')):
            with self.subTest(field=key):
                evidence = focused_evidence()
                evidence[key] = value
                with self.assertRaisesRegex(SystemExit, 'Windows verification'):
                    self.verify(evidence)

    def test_mode_baseline_and_requested_scope_cannot_be_changed(self):
        changes = {
            'validationMode': 'focused-architecture-change',
            'baseline': 'v1.16.0',
            'baselineCommit': 'b' * 40,
            'priorChecks': 'passed',
            'concurrencyTests': 'failed',
            'concurrencyGuiTests': 'skipped',
            'releaseScopeTests': True,
        }
        for key, value in changes.items():
            with self.subTest(field=key):
                evidence = focused_evidence()
                evidence[key] = value
                with self.assertRaisesRegex(SystemExit, 'wrong scope'):
                    self.verify(evidence)

    def test_every_focused_evidence_field_is_required(self):
        for key in focused_evidence():
            with self.subTest(field=key):
                evidence = focused_evidence()
                del evidence[key]
                with self.assertRaises(SystemExit):
                    self.verify(evidence)

    def test_verification_is_bound_to_the_actual_desktop_archive(self):
        with self.assertRaisesRegex(SystemExit, 'stale'):
            self.verify(focused_evidence(), digest='e' * 64)

    def test_live_youtube_claim_must_remain_explicitly_false(self):
        for value in (True, None, 0, 'false'):
            with self.subTest(value=value):
                evidence = focused_evidence()
                evidence['liveYouTubeVerified'] = value
                with self.assertRaises(SystemExit):
                    self.verify(evidence)

    def test_prior_release_proof_does_not_authorize_the_concurrency_release(self):
        evidence = {key: value for key, value in focused_evidence().items() if key in ('version', 'commit', 'platform')}
        evidence.update(packagedGui='passed', guiQueueTests='passed', localMediaMp4Mp3M4a='passed')
        with self.assertRaisesRegex(SystemExit, 'wrong scope'):
            self.verify(evidence)

    def test_legacy_proof_remains_limited_to_version_1_17(self):
        evidence = {'version': '1.17.0', 'commit': COMMIT, 'platform': 'windows-x64',
                    'packagedGui': 'passed', 'guiQueueTests': 'passed', 'localMediaMp4Mp3M4a': 'passed'}
        self.assertIsNone(self.verify(evidence, version='1.17.0'))
        for version in ('1.16.0', '1.19.0'):
            with self.subTest(version=version):
                evidence['version'] = version
                with self.assertRaisesRegex(SystemExit, 'authorized'):
                    self.verify(evidence, version=version)
        concurrency = focused_evidence()
        concurrency['version'] = '1.17.0'
        with self.assertRaisesRegex(SystemExit, 'Windows verification'):
            self.verify(concurrency, version='1.17.0')


class ConcurrencyPublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.artifacts = self.root / 'artifacts'
        self.artifacts.mkdir()
        (self.root / 'desktop').mkdir()
        (self.root / 'package.json').write_text(json.dumps({'version': VERSION}), encoding='utf-8')
        self.sources = {}
        for name in ('main.py', 'engine.py', 'concurrency.py'):
            source = self.root / 'desktop' / name
            source.write_text('# focused concurrency fixture\n', encoding='utf-8')
            self.sources['desktop/' + name] = release.sha256(source)
        required = ('My Video App.exe', 'desktop/main.py', 'desktop/engine.py', 'desktop/concurrency.py',
                    'runtime/python/python.exe', 'runtime/python/pythonw.exe', 'runtime/deno.exe',
                    'runtime/ffmpeg/ffmpeg.exe', 'runtime/ffmpeg/ffprobe.exe')
        self.desktop_files = {'MyVideoApp/' + name: b'owned concurrency fixture' for name in required}
        self.desktop_files['MyVideoApp/APPMANIFEST.json'] = json.dumps({'version': VERSION, 'sourceFiles': self.sources}).encode()
        self.zip(release.ASSETS[0], {'my-video-app/manifest.json': json.dumps({'version': VERSION, 'permissions': []})})
        self.zip(release.ASSETS[1], self.desktop_files)
        self.zip(release.ASSETS[2], {'my-video-app-source/README.md': 'Owned focused source fixture'})
        self.zip(release.ASSETS[3], {'my-video-app-antivirus-helper/README.ko.md': 'Owned helper fixture'})
        (self.artifacts / 'SHA256SUMS').write_text(''.join(
            release.sha256(self.artifacts / name) + '  ' + name + '\n'
            for name in release.ASSETS if name != release.ASSETS[1]), encoding='utf-8')
        self.write_evidence()
        self.calls, self.notes, self.api = [], [], {}
        patches = (
            patch.object(release, 'ROOT', self.root),
            patch.dict(os.environ, {'GITHUB_REPOSITORY': 'P-JSL/myapps', 'GITHUB_REF': 'refs/heads/main',
                                    'GITHUB_SHA': COMMIT, 'GH_TOKEN': 'offline-nonfunctional-fixture'}),
            patch.object(release.subprocess, 'run', side_effect=self.record_command),
            patch.object(release, 'urlopen', side_effect=self.open),
        )
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def zip(self, name, members):
        with ZipFile(self.artifacts / name, 'w') as archive:
            for path, body in members.items():
                archive.writestr(path, body)

    def write_evidence(self, evidence=None):
        evidence = evidence or focused_evidence(release.sha256(self.artifacts / release.ASSETS[1]))
        (self.artifacts / 'WINDOWS-VALIDATION.json').write_text(json.dumps(evidence), encoding='utf-8')

    def record_command(self, args, **kwargs):
        self.calls.append(args)
        if '--notes-file' in args:
            self.notes.append(Path(args[args.index('--notes-file') + 1]).read_text(encoding='utf-8'))

    def open(self, request, timeout=30):
        path = request.full_url.split('/repos/P-JSL/myapps', 1)[1]
        if path not in self.api:
            raise HTTPError(request.full_url, 404, 'Offline fixture', {}, None)
        return BytesIO(json.dumps(self.api[path]).encode())

    def test_focused_proof_uploads_new_version_and_records_skipped_scope(self):
        release.main()
        self.assertEqual(len(self.calls), 2)
        create, publish = self.calls
        self.assertIn('v1.18.0', create)
        self.assertIn('--draft', create)
        self.assertIn('--draft=false', publish)
        for name in release.ASSETS:
            self.assertIn(str(self.artifacts / name), create)
        self.assertIn(str(self.artifacts / 'WINDOWS-VALIDATION.json'), create)
        self.assertIn('1~16', self.notes[0])
        self.assertIn('사용자 요청으로 건너뛰', self.notes[0])
        self.assertIn('실제 YouTube 다운로드는 확인하지 않았', self.notes[0])

    def test_archive_changed_after_packaged_tests_cannot_be_published(self):
        self.desktop_files['MyVideoApp/desktop/concurrency.py'] = b'changed after verification'
        self.zip(release.ASSETS[1], self.desktop_files)
        with self.assertRaisesRegex(SystemExit, 'stale'):
            release.main()
        self.assertEqual(self.calls, [])

    def test_missing_concurrency_runtime_module_is_rejected(self):
        del self.desktop_files['MyVideoApp/desktop/concurrency.py']
        self.zip(release.ASSETS[1], self.desktop_files)
        with self.assertRaisesRegex(ValueError, 'concurrency runtime missing'):
            release.validate()

    def test_concurrency_module_source_identity_cannot_be_stale(self):
        (self.root / 'desktop/concurrency.py').write_text('# changed current source\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'stale application source'):
            release.validate()

    def test_existing_version_tag_cannot_move_for_the_new_scope(self):
        self.api['/git/ref/tags/v1.18.0'] = {'object': {'type': 'commit', 'sha': 'b' * 40}}
        with self.assertRaisesRegex(SystemExit, 'Existing tag'):
            release.main()
        self.assertEqual(self.calls, [])


class ConcurrencyWorkflowScopeTests(unittest.TestCase):
    def test_windows_job_runs_only_the_three_new_isolated_suites(self):
        workflow = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        commands = [line.strip() for line in workflow.splitlines() if re.match(r'\s*& ', line)]
        self.assertEqual(commands, [
            '& $python -I -B tests/test_concurrency_release.py -v',
            '& $python -I -B desktop/test_concurrency.py --app-root "$appRoot" -v',
            '& $python -I -B desktop/test_concurrency_gui.py --app-root "$appRoot" -v',
        ])
        self.assertIn('$python = "$appRoot/runtime/python/python.exe"', workflow)
        for previous in ('test_publish_release.py', 'test_gui.py', 'test_runtime.py', '--smoke-test', 'unittest discover'):
            with self.subTest(previous=previous):
                self.assertNotIn(previous, workflow)

    def test_ci_evidence_states_the_exact_scope_without_prior_pass_claims(self):
        workflow = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        for key, value in focused_evidence().items():
            if key in ('version', 'commit', 'desktopSha256'):
                continue
            expected = '$false' if value is False else '"' + value + '"'
            with self.subTest(field=key):
                self.assertIn(key + '=' + expected, workflow)
        self.assertIn('(Get-FileHash artifacts/my-video-app-desktop-windows-x64.zip -Algorithm SHA256)', workflow)
        for previous in ('packagedGui=', 'guiQueueTests=', 'localMediaMp4Mp3M4a='):
            self.assertNotIn(previous, workflow)


if __name__ == '__main__':
    unittest.main()
