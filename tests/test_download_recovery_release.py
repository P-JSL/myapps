"""Only the 1.19.1 recovery publication scope; no prior suites are imported."""
import importlib.util
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('recovery_release', ROOT / 'scripts/publish-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
COMMIT = 'a' * 40
DIGEST = 'b' * 64


def evidence():
    return {'version': '1.19.1', 'commit': COMMIT, 'platform': 'windows-x64',
            'validationMode': 'focused-download-recovery', 'baseline': 'v1.19.0',
            'baselineCommit': 'b09935f7d1ce9fe6f4003bce4d8a87d8e09d826a',
            'desktopSha256': DIGEST, 'recoveryTests': 'passed', 'releaseScopeTests': 'passed',
            'priorChecks': 'skipped-per-user', 'liveYouTubeVerified': False}


class RecoveryReleaseTests(unittest.TestCase):
    def verify(self, value, digest=DIGEST):
        return release.validate_windows_evidence('1.19.1', COMMIT, value, digest)

    def test_accepts_only_the_new_recovery_evidence_without_old_protocol_proof(self):
        self.assertIsNone(self.verify(evidence()))

    def test_missing_required_recovery_proof_is_rejected(self):
        for key in evidence():
            with self.subTest(field=key):
                value = evidence()
                del value[key]
                with self.assertRaises(SystemExit):
                    self.verify(value)

    def test_evidence_is_bound_to_commit_version_platform_and_package(self):
        for key, value in (('version', '1.19.0'), ('commit', 'c' * 40),
                           ('platform', 'linux-x64'), ('desktopSha256', 'd' * 64)):
            with self.subTest(field=key):
                proof = evidence(); proof[key] = value
                with self.assertRaises(SystemExit):
                    self.verify(proof)

    def test_previous_full_transport_scope_cannot_be_reused(self):
        for key, value in (('validationMode', 'focused-desktop-transport'),
                           ('baseline', 'v1.18.0'), ('baselineCommit', 'c' * 40),
                           ('priorChecks', 'passed'), ('recoveryTests', 'skipped'),
                           ('releaseScopeTests', True), ('liveYouTubeVerified', True)):
            with self.subTest(field=key):
                proof = evidence(); proof[key] = value
                with self.assertRaises(SystemExit):
                    self.verify(proof)

    def test_workflow_executes_exactly_two_affected_suites_with_bundled_python(self):
        text = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        tests = re.findall(r'& \$python -I -B (\S+test\S+\.py)', text)
        self.assertEqual(tests, ['tests/test_download_recovery_release.py', 'desktop/test_download_recovery.py'])
        self.assertIn('desktop/test_download_recovery.py --app-root "$appRoot"', text)
        self.assertNotIn('-m pip install', text)
        self.assertNotIn('test_transport.py -', text)

    def test_packager_checks_recovery_source_identity_and_new_scope_only(self):
        text = (ROOT / 'scripts/package.mjs').read_text(encoding='utf-8')
        self.assertIn("recoveryMode ? ['recovery', 'releaseScope']", text)
        self.assertIn('await sourceIdentity()', text)
        self.assertIn("assert.equal(version, '1.19.1')", text)
        self.assertIn("assert.equal(report.priorChecks, 'skipped-per-user')", text)

    def test_existing_version_tags_are_not_moved_by_the_publisher(self):
        text = (ROOT / 'scripts/publish-release.py').read_text(encoding='utf-8')
        self.assertIn('never move a', text)
        self.assertNotIn('update-ref', text)
        self.assertNotIn("'--force'", text)


if __name__ == '__main__':
    unittest.main()
