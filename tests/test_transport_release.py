"""New 1.19 release contracts; publication and remote identity stay offline.

Only this suite is run here. It neither imports nor invokes any prior suite.
The package-gate fixture executes the current gate with local Git boundaries;
it stops before packaging, and never builds an application or release asset.
"""
from io import BytesIO
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from zipfile import ZipFile


_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument('--app-root', type=Path)
_parser.add_argument('--dependency-root', action='append', type=Path, default=[])
_options, _test_arguments = _parser.parse_known_args()
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('transport_release_subject', ROOT / 'scripts/publish-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
VERSION = '1.19.0'
COMMIT = 'a' * 40
BASELINE_COMMIT = '1756c8dec1cb6e655fd486ab4a55fcc35641fd74'
REPORT_NAME = 'DESKTOP-TRANSPORT-TESTS.json'
PROTOCOLS = ['h2', 'h3', 'http/1.1']


def observed_report():
    return {'status': 'passed', 'protocols': PROTOCOLS.copy(), 'tests': 10,
            'scope': 'Controlled TLS loopback origins', 'liveYouTubeVerified': False}


def focused_evidence(desktop_sha256='d' * 64, report_sha256='e' * 64):
    return {
        'version': VERSION, 'commit': COMMIT, 'platform': 'windows-x64',
        'validationMode': 'focused-desktop-transport', 'baseline': 'v1.18.0',
        'baselineCommit': BASELINE_COMMIT, 'desktopSha256': desktop_sha256,
        'bandwidthTests': 'passed', 'rangeTests': 'passed', 'transportTests': 'passed',
        'engineTransportTests': 'passed', 'releaseScopeTests': 'passed',
        'actualProtocols': PROTOCOLS.copy(), 'transportReportSha256': report_sha256,
        'priorChecks': 'skipped-per-user', 'liveYouTubeVerified': False,
        'publicWANBenchmarked': False,
    }


class TransportEvidenceTests(unittest.TestCase):
    def verify(self, evidence, report=None, desktop_sha256='d' * 64, report_sha256='e' * 64):
        return release.validate_windows_evidence(VERSION, COMMIT, evidence, desktop_sha256,
                                                  observed_report() if report is None else report,
                                                  report_sha256)

    def test_observed_protocol_proof_and_focused_evidence_are_accepted(self):
        self.assertIsNone(self.verify(focused_evidence()))

    def test_every_identity_and_scope_field_is_required(self):
        for key in focused_evidence():
            with self.subTest(field=key):
                evidence = focused_evidence()
                del evidence[key]
                with self.assertRaises(SystemExit):
                    self.verify(evidence)

    def test_identity_scope_and_test_results_cannot_be_relabelled(self):
        changes = {
            'version': '1.18.0', 'commit': 'b' * 40, 'platform': 'linux-x64',
            'validationMode': 'focused-desktop-concurrency', 'baseline': 'v1.17.0',
            'baselineCommit': 'c' * 40, 'priorChecks': 'passed',
            'bandwidthTests': 'skipped', 'rangeTests': 'skipped', 'transportTests': 'failed',
            'engineTransportTests': True, 'releaseScopeTests': 1,
        }
        for key, value in changes.items():
            with self.subTest(field=key):
                evidence = focused_evidence()
                evidence[key] = value
                with self.assertRaises(SystemExit):
                    self.verify(evidence)

    def test_proof_is_bound_to_the_archive_and_raw_protocol_report(self):
        for change in ({'desktop_sha256': 'f' * 64}, {'report_sha256': 'f' * 64}):
            with self.subTest(change=change), self.assertRaisesRegex(SystemExit, 'stale'):
                self.verify(focused_evidence(), **change)

    def test_missing_bandwidth_proof_cannot_authorize_the_speed_limit_release(self):
        evidence = focused_evidence()
        del evidence['bandwidthTests']
        with self.assertRaisesRegex(SystemExit, 'wrong scope'):
            self.verify(evidence)

    def test_protocols_must_be_all_observed_without_duplicates(self):
        invalid = ([], ['h3'], ['h3', 'h2'], ['h2', 'h3', 'h3'],
                   ['h2', 'h3', 'http/1.1', 'spdy'], 'h3,h2,http/1.1', [2, 3, 1])
        for protocols in invalid:
            with self.subTest(protocols=protocols):
                report = observed_report()
                report['protocols'] = protocols
                with self.assertRaisesRegex(SystemExit, 'protocol proof'):
                    self.verify(focused_evidence(), report)

    def test_protocols_cannot_be_filled_in_only_in_windows_evidence(self):
        evidence = focused_evidence()
        evidence['actualProtocols'] = ['h3', 'h2', 'http/1.1']
        with self.assertRaisesRegex(SystemExit, 'wrong scope'):
            self.verify(evidence)
        with self.assertRaisesRegex(SystemExit, 'protocol proof'):
            release.validate_windows_evidence(VERSION, COMMIT, focused_evidence(), 'd' * 64)

    def test_failed_or_empty_protocol_suites_cannot_authorize_publication(self):
        for key, value in (('status', 'failed'), ('status', 'skipped'), ('liveYouTubeVerified', True),
                           ('tests', 0), ('tests', -1), ('tests', True), ('tests', '10')):
            with self.subTest(field=key, value=value):
                report = observed_report()
                report[key] = value
                with self.assertRaisesRegex(SystemExit, 'protocol proof'):
                    self.verify(focused_evidence(), report)

    def test_unverified_live_and_internet_claims_must_be_explicitly_false(self):
        for key in ('liveYouTubeVerified', 'publicWANBenchmarked'):
            for value in (True, None, 0, 'false'):
                with self.subTest(field=key, value=value):
                    evidence = focused_evidence()
                    evidence[key] = value
                    with self.assertRaises(SystemExit):
                        self.verify(evidence)

    def test_old_evidence_types_remain_limited_to_their_versions(self):
        concurrency = {
            'version': '1.18.0', 'commit': COMMIT, 'platform': 'windows-x64',
            'validationMode': 'focused-desktop-concurrency', 'baseline': 'v1.17.0',
            'baselineCommit': '252b452da32f16dc81cb36cca94231879d43c5f1',
            'desktopSha256': 'd' * 64, 'concurrencyTests': 'passed',
            'concurrencyGuiTests': 'passed', 'releaseScopeTests': 'passed',
            'priorChecks': 'skipped-per-user', 'liveYouTubeVerified': False,
        }
        architecture = {'version': '1.17.0', 'commit': COMMIT, 'platform': 'windows-x64',
                        'packagedGui': 'passed', 'guiQueueTests': 'passed',
                        'localMediaMp4Mp3M4a': 'passed'}
        for evidence in (concurrency, architecture):
            with self.subTest(version=evidence['version']):
                self.assertIsNone(release.validate_windows_evidence(evidence['version'], COMMIT, evidence, 'd' * 64))
                evidence['version'] = VERSION
                with self.assertRaises(SystemExit):
                    self.verify(evidence)


class TransportPublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.artifacts = self.root / 'artifacts'
        self.artifacts.mkdir()
        (self.root / 'desktop').mkdir()
        (self.root / 'package.json').write_text(json.dumps({'version': VERSION}), encoding='utf-8')
        self.sources = {}
        for name in ('main.py', 'engine.py', 'concurrency.py', 'bandwidth.py', 'transfer.py', 'transport.py'):
            source = self.root / 'desktop' / name
            source.write_text('# focused transport fixture\n', encoding='utf-8')
            self.sources['desktop/' + name] = release.sha256(source)
        required = ('My Video App.exe', 'desktop/main.py', 'desktop/engine.py',
                    'desktop/concurrency.py', 'desktop/bandwidth.py', 'desktop/transfer.py', 'desktop/transport.py',
                    'runtime/python/python.exe', 'runtime/python/pythonw.exe',
                    'runtime/python/Lib/site-packages/curl_cffi/__init__.py', 'runtime/deno.exe',
                    'runtime/ffmpeg/ffmpeg.exe', 'runtime/ffmpeg/ffprobe.exe')
        self.desktop_files = {'MyVideoApp/' + name: b'owned transport fixture' for name in required}
        self.desktop_files['MyVideoApp/APPMANIFEST.json'] = json.dumps({'version': VERSION, 'sourceFiles': self.sources}).encode()
        self.zip(release.ASSETS[0], {'my-video-app/manifest.json': json.dumps({'version': VERSION, 'permissions': []})})
        self.zip(release.ASSETS[1], self.desktop_files)
        self.zip(release.ASSETS[2], {'my-video-app-source/README.md': 'Owned focused source fixture'})
        self.zip(release.ASSETS[3], {'my-video-app-antivirus-helper/README.ko.md': 'Owned helper fixture'})
        (self.artifacts / 'SHA256SUMS').write_text(''.join(
            release.sha256(self.artifacts / name) + '  ' + name + '\n'
            for name in release.ASSETS if name != release.ASSETS[1]), encoding='utf-8')
        self.write_report()
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

    def write_report(self, report=None):
        (self.artifacts / REPORT_NAME).write_text(json.dumps(observed_report() if report is None else report), encoding='utf-8')

    def write_evidence(self, evidence=None):
        if evidence is None:
            evidence = focused_evidence(release.sha256(self.artifacts / release.ASSETS[1]),
                                         release.sha256(self.artifacts / REPORT_NAME))
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

    def test_observed_protocol_report_is_uploaded_and_hashed_with_windows_evidence(self):
        release.main()
        self.assertEqual(len(self.calls), 2)
        create, publish = self.calls
        self.assertIn('v1.19.0', create)
        self.assertIn('--draft', create)
        self.assertIn('--draft=false', publish)
        for name in (*release.ASSETS, REPORT_NAME, 'WINDOWS-VALIDATION.json', 'SHA256SUMS-RELEASE.txt'):
            self.assertIn(str(self.artifacts / name), create)
        checksums = (self.artifacts / 'SHA256SUMS-RELEASE.txt').read_text(encoding='utf-8')
        for name in (REPORT_NAME, 'WINDOWS-VALIDATION.json'):
            self.assertIn(release.sha256(self.artifacts / name) + '  ' + name + '\n', checksums)
        self.assertIn(', '.join(PROTOCOLS), self.notes[0])
        self.assertIn('HTTP/3', self.notes[0])
        self.assertIn('강한 Range', self.notes[0])
        self.assertIn('속도 제한', self.notes[0])
        self.assertIn('HTTP/2·HTTP/1.1로 대체', self.notes[0])
        self.assertIn('사용자 요청으로 건너뛰', self.notes[0])
        self.assertIn('통제된 로컬', self.notes[0])
        self.assertIn('실제 YouTube 다운로드와 공용 WAN 벤치마크는 확인하지 않았', self.notes[0])

    def test_report_changed_after_windows_verification_is_rejected(self):
        report = observed_report()
        report['scope'] = 'changed after verification'
        self.write_report(report)
        with self.assertRaisesRegex(SystemExit, 'stale'):
            release.main()
        self.assertEqual(self.calls, [])

    def test_http3_observation_cannot_be_omitted_even_with_a_fresh_report_hash(self):
        report = observed_report()
        report['protocols'].remove('h3')
        self.write_report(report)
        self.write_evidence()
        with self.assertRaisesRegex(SystemExit, 'protocol proof'):
            release.main()
        self.assertEqual(self.calls, [])

    def test_archive_changed_after_packaged_tests_is_rejected(self):
        self.desktop_files['MyVideoApp/desktop/transport.py'] = b'changed after verification'
        self.zip(release.ASSETS[1], self.desktop_files)
        with self.assertRaisesRegex(SystemExit, 'stale'):
            release.main()
        self.assertEqual(self.calls, [])

    def test_missing_native_transport_modules_and_bundled_client_are_rejected(self):
        for required in ('desktop/bandwidth.py', 'desktop/transfer.py', 'desktop/transport.py', 'runtime/python/Lib/site-packages/curl_cffi/__init__.py'):
            with self.subTest(required=required):
                members = dict(self.desktop_files)
                del members['MyVideoApp/' + required]
                self.zip(release.ASSETS[1], members)
                with self.assertRaisesRegex(ValueError, 'transport runtime missing'):
                    release.validate()

    def test_native_transport_source_identity_cannot_be_stale(self):
        (self.root / 'desktop/transport.py').write_text('# changed source\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'stale application source'):
            release.validate()

    def test_existing_version_tag_cannot_move(self):
        self.api['/git/ref/tags/v1.19.0'] = {'object': {'type': 'commit', 'sha': 'b' * 40}}
        with self.assertRaisesRegex(SystemExit, 'Existing tag'):
            release.main()
        self.assertEqual(self.calls, [])

    def test_missing_raw_observation_report_cannot_publish(self):
        (self.artifacts / REPORT_NAME).unlink()
        with self.assertRaises(FileNotFoundError):
            release.main()
        self.assertEqual(self.calls, [])


class TransportWorkflowScopeTests(unittest.TestCase):
    def test_windows_job_runs_only_the_five_new_isolated_suites(self):
        workflow = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        commands = [line.strip() for line in workflow.splitlines()
                    if re.match(r'\s*& \$python -I -B .*test_.*\.py', line)]
        self.assertEqual(commands, [
            '& $python -I -B tests/test_transport_release.py -v',
            '& $python -I -B desktop/test_bandwidth.py --app-root "$appRoot" -v',
            '& $python -I -B desktop/test_transfer.py --app-root "$appRoot" --dependency-root "$dependencyRoot" -v',
            '& $python -I -B desktop/test_transport.py --app-root "$appRoot" --dependency-root "$dependencyRoot" --report artifacts/DESKTOP-TRANSPORT-TESTS.json -v',
            '& $python -I -B desktop/test_transport_engine.py --app-root "$appRoot" -v',
        ])
        self.assertIn('$python = "$appRoot/runtime/python/python.exe"', workflow)
        for previous in ('test_concurrency', 'test_publish_release.py', 'test_gui.py',
                         'test_runtime.py', '--smoke-test', 'unittest discover', 'npm test'):
            with self.subTest(previous=previous):
                self.assertNotIn(previous, workflow)

    def test_fixture_packages_are_hash_pinned_binary_dependencies_of_the_bundled_python(self):
        workflow = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        self.assertIn('& $python -I -B -m pip install --require-hashes --no-deps --only-binary=:all: --target "$dependencyRoot" -r tests/requirements-desktop-transport.lock', workflow)
        self.assertIn('$dependencyRoot = "$env:RUNNER_TEMP/', workflow)
        self.assertNotIn('pip install curl_cffi', workflow)

    def test_ci_reads_real_protocol_observations_and_records_only_the_requested_scope(self):
        workflow = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        for key, value in focused_evidence().items():
            if key in ('version', 'commit', 'desktopSha256', 'transportReportSha256', 'actualProtocols'):
                continue
            expected = '$false' if value is False else '"' + value + '"'
            with self.subTest(field=key):
                self.assertIn(key + '=' + expected, workflow)
        self.assertIn('$transportProof = Get-Content artifacts/DESKTOP-TRANSPORT-TESTS.json | ConvertFrom-Json', workflow)
        self.assertIn('$transportProof.status -ne "passed"', workflow)
        self.assertIn('$_ -notin $transportProof.protocols', workflow)
        self.assertIn('actualProtocols=@($transportProof.protocols)', workflow)
        self.assertIn('transportReportSha256=(Get-FileHash artifacts/DESKTOP-TRANSPORT-TESTS.json -Algorithm SHA256)', workflow)
        self.assertIn('desktopSha256=(Get-FileHash artifacts/my-video-app-desktop-windows-x64.zip -Algorithm SHA256)', workflow)
        for previous in ('concurrencyTests=', 'concurrencyGuiTests=', 'packagedGui=',
                         'guiQueueTests=', 'localMediaMp4Mp3M4a='):
            self.assertNotIn(previous, workflow)


class TransportPackageGateTests(unittest.TestCase):
    """Execute the source/log/build gates without running archive.py or builds."""
    def setUp(self):
        self.node = shutil.which('node')
        self.assertIsNotNone(self.node, 'Node is required for the current package gate contract')
        temporary = tempfile.TemporaryDirectory(prefix='transport-package-gate-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ('scripts/lib', 'reports', 'dist', 'src/local', 'native', 'tests'):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        self.manifest = {'version': VERSION, 'version_name': VERSION + ' - desktop', 'permissions': []}
        self.before_manifest = dict(self.manifest, version='1.18.0', version_name='1.18.0 - desktop')
        self.write_json('package.json', {'version': VERSION})
        self.write_json('package-lock.json', {'lockfileVersion': 3})
        self.write_json('tsconfig.json', {})
        self.write_json('src/local/manifest.json', self.manifest)
        self.write_json('dist/manifest.json', self.manifest)
        (self.root / 'reports/new-tests.txt').write_text('New transport checks passed\n', encoding='utf-8')
        shutil.copyfile(ROOT / 'scripts/lib/artifacts.mjs', self.root / 'scripts/lib/artifacts.mjs')
        # Git contents are a controlled read-only boundary. Every actual report,
        # inventory, source, log and build digest check below remains unchanged.
        gate = (ROOT / 'scripts/package.mjs').read_text(encoding='utf-8').split("const desktop = await json('reports/desktop-build.json');", 1)[0]
        gate = gate.replace("import { spawnSync } from 'node:child_process';", '''
const spawnSync = (command, args) => {
  if (command !== 'git') throw Error('Only read-only Git boundaries may be replaced');
  if (args[0] === 'diff') return {status:0, stdout:process.env.TRANSPORT_FIXTURE_GIT_DIFF ?? '', stderr:''};
  if (args[0] === 'show') return {status:0, stdout:JSON.stringify(BASELINE_MANIFEST), stderr:''};
  throw Error('Unexpected Git boundary');
};
'''.replace('BASELINE_MANIFEST', json.dumps(self.before_manifest)))
        (self.root / 'scripts/package.mjs').write_text(gate, encoding='utf-8')
        self.report = {
            'release': VERSION, 'status': 'passed', 'validationMode': 'focused-desktop-transport',
            'baseline': 'v1.18.0', 'baselineCommit': BASELINE_COMMIT,
            'priorChecks': 'skipped-per-user', 'liveYouTubeVerified': False,
            'publicWANBenchmarked': False, 'userRequestedSkipPreviousChecks': True,
            'checks': {'bandwidth': 8, 'transfer': 21, 'transport': 10, 'engineTransport': 15,
                       'releaseScope': 25, 'build': 'passed'},
        }
        self.refresh_identity()

    def write_json(self, name, value):
        (self.root / name).write_text(json.dumps(value), encoding='utf-8')

    def refresh_identity(self):
        program = "import {sourceIdentity,treeIdentity,hash} from './scripts/lib/artifacts.mjs'; import {readFile} from 'node:fs/promises'; console.log(JSON.stringify({sourceSha256:await sourceIdentity(),buildSha256:await treeIdentity('dist'),log:hash(await readFile('reports/new-tests.txt'))}));"
        result = subprocess.run([self.node, '--input-type=module', '-e', program], cwd=self.root,
                                capture_output=True, text=True, check=True)
        identity = json.loads(result.stdout)
        self.report.update(sourceSha256=identity['sourceSha256'], buildSha256=identity['buildSha256'],
                           logSha256={'reports/new-tests.txt': identity['log']})
        self.write_json('reports/build.json', {'buildSha256': identity['buildSha256']})
        self.write_json('reports/release-validation.json', self.report)

    def gate(self, **environment):
        self.write_json('reports/release-validation.json', self.report)
        return subprocess.run([self.node, 'scripts/package.mjs'], cwd=self.root,
                              capture_output=True, text=True, env=dict(os.environ, **environment))

    def test_complete_focused_transport_gate_passes_without_prior_test_claims(self):
        result = self.gate()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_each_new_suite_requires_a_positive_integer_and_build_pass(self):
        for name in ('bandwidth', 'transfer', 'transport', 'engineTransport', 'releaseScope'):
            for value in (0, -1, True, 'passed'):
                with self.subTest(check=name, value=value):
                    before = self.report['checks'][name]
                    self.report['checks'][name] = value
                    self.assertNotEqual(self.gate().returncode, 0)
                    self.report['checks'][name] = before
        self.report['checks']['build'] = 'skipped'
        self.assertNotEqual(self.gate().returncode, 0)

    def test_scope_and_unverified_claims_cannot_be_changed(self):
        for key, value in (('baseline', 'v1.17.0'), ('baselineCommit', 'b' * 40),
                           ('priorChecks', 'passed'), ('publicWANBenchmarked', True),
                           ('liveYouTubeVerified', True), ('userRequestedSkipPreviousChecks', False)):
            with self.subTest(field=key):
                before = self.report[key]
                self.report[key] = value
                self.assertNotEqual(self.gate().returncode, 0)
                self.report[key] = before

    def test_source_log_and_built_output_are_bound_to_the_validation(self):
        for name in ('scripts/lib/artifacts.mjs', 'reports/new-tests.txt', 'dist/manifest.json'):
            with self.subTest(path=name):
                path = self.root / name
                before = path.read_bytes()
                path.write_bytes(before + b'\n')
                self.assertNotEqual(self.gate().returncode, 0)
                path.write_bytes(before)

    def test_extension_permissions_cannot_change_even_with_fresh_source_hashes(self):
        self.manifest['permissions'].append('downloads')
        self.write_json('src/local/manifest.json', self.manifest)
        self.refresh_identity()
        result = self.gate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Only extension version metadata may change', result.stderr)

    def test_other_extension_source_changes_are_rejected_by_baseline_comparison(self):
        result = self.gate(TRANSPORT_FIXTURE_GIT_DIFF='src/local/parallel-download.ts\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('requires unchanged extension sources', result.stderr)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], *_test_arguments])
