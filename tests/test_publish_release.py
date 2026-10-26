"""New release contract checks; GitHub and gh are explicit offline doubles."""
import hashlib
from io import BytesIO
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from zipfile import ZipFile

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/publish-release.py'
spec = importlib.util.spec_from_file_location('release_subject', SCRIPT)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.artifacts = self.root / 'artifacts'; self.artifacts.mkdir()
        (self.root / 'desktop').mkdir()
        (self.root / 'desktop/main.py').write_text('print("owned fixture")\n')
        (self.root / 'package.json').write_text('{"version":"1.17.0"}')
        sources = {'desktop/main.py': release.sha256(self.root / 'desktop/main.py')}
        self.desktop_files = {'MyVideoApp/' + name: b'owned fixture' for name in ('My Video App.exe', 'desktop/main.py', 'desktop/engine.py', 'runtime/python/pythonw.exe', 'runtime/deno.exe', 'runtime/ffmpeg/ffmpeg.exe', 'runtime/ffmpeg/ffprobe.exe')}
        self.desktop_files['MyVideoApp/APPMANIFEST.json'] = json.dumps({'version': '1.17.0', 'sourceFiles': sources}).encode()
        self.zip(release.ASSETS[0], {'my-video-app/manifest.json': b'{"version":"1.17.0","permissions":[]}'})
        self.zip(release.ASSETS[1], self.desktop_files)
        self.zip(release.ASSETS[2], {'my-video-app-source/README.md': b'Owned source'})
        self.zip(release.ASSETS[3], {'my-video-app-antivirus-helper/README.ko.md': b'Owned AV fixture'})
        self.sums()
        self.commit = 'a' * 40
        (self.artifacts / 'WINDOWS-VALIDATION.json').write_text(json.dumps({'version': '1.17.0', 'commit': self.commit, 'platform': 'windows-x64', 'packagedGui': 'passed', 'guiQueueTests': 'passed', 'localMediaMp4Mp3M4a': 'passed'}))
        self.calls = []; self.api = {}
        self.addCleanup(patch.stopall)
        patch.object(release, 'ROOT', self.root).start()
        patch.dict(os.environ, {'GITHUB_REPOSITORY': 'P-JSL/myapps', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': self.commit, 'GH_TOKEN': 'offline-nonfunctional-fixture'}).start()
        patch.object(release.subprocess, 'run', side_effect=lambda args, **kwargs: self.calls.append(args)).start()
        patch.object(release, 'urlopen', side_effect=self.open).start()

    def zip(self, name, members):
        with ZipFile(self.artifacts / name, 'w') as archive:
            for path, body in members.items(): archive.writestr(path, body)

    def sums(self):
        (self.artifacts / 'SHA256SUMS').write_text(''.join(release.sha256(self.artifacts / name) + '  ' + name + '\n' for name in release.ASSETS if name != release.ASSETS[1]))

    def open(self, request, timeout=30):
        path = request.full_url.split('/repos/P-JSL/myapps', 1)[1]
        if path not in self.api: raise HTTPError(request.full_url, 404, 'Fixture', {}, None)
        return BytesIO(json.dumps(self.api[path]).encode())

    def test_valid_products(self):
        version, hashes = release.validate()
        self.assertEqual(version, '1.17.0'); self.assertEqual(set(hashes), set(release.ASSETS))

    def test_extension_hash_is_binding(self):
        self.zip(release.ASSETS[0], {'my-video-app/manifest.json': b'changed'})
        with self.assertRaisesRegex(ValueError, 'checksum'): release.validate()

    def test_stale_desktop_source_rejected(self):
        (self.root / 'desktop/main.py').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'stale'): release.validate()

    def test_desktop_traversal_rejected(self):
        self.desktop_files['../outside'] = b'bad'
        self.zip(release.ASSETS[1], self.desktop_files)
        with self.assertRaisesRegex(ValueError, 'Unsafe'): release.validate()

    def test_both_products_upload_before_publication(self):
        release.main()
        create, publish = self.calls
        self.assertIn('--draft', create); self.assertIn('--draft=false', publish)
        self.assertIn(str(self.artifacts / release.ASSETS[1]), create)
        self.assertIn(str(self.artifacts / release.ASSETS[0]), create)
        self.assertIn(self.commit, create)

    def test_existing_tag_cannot_move(self):
        self.api['/git/ref/tags/v1.17.0'] = {'object': {'type': 'commit', 'sha': 'b' * 40}}
        with self.assertRaisesRegex(SystemExit, 'Existing tag'): release.main()
        self.assertEqual(self.calls, [])

    def rollback_fixture(self):
        prior, first, second = 'b' * 40, 'c' * 40, 'd' * 40
        self.api['/git/ref/tags/v1.17.0'] = {'object': {'type': 'commit', 'sha': prior}}
        self.api['/releases/tags/v1.17.0'] = {'draft': False, 'prerelease': False, 'assets': [{'name': name, 'digest': 'sha256:' + release.sha256(self.artifacts / name)} for name in release.ASSETS]}
        self.api['/git/commits/' + prior] = {'tree': {'sha': first}}
        self.api['/git/commits/' + self.commit] = {'tree': {'sha': second}}
        original = [{'path': 'desktop/main.py', 'mode': '100644', 'type': 'blob', 'sha': 'e' * 40}, {'path': 'scripts/publish-release.py', 'mode': '100644', 'type': 'blob', 'sha': 'f' * 40}]
        current = [dict(item) for item in original]; current[1]['sha'] = '0' * 40
        self.api['/git/trees/' + first + '?recursive=1'] = {'truncated': False, 'tree': original}
        self.api['/git/trees/' + second + '?recursive=1'] = {'truncated': False, 'tree': current}
        return second

    def test_identical_rollback_skips_without_tag_move(self):
        self.rollback_fixture(); release.main(); self.assertEqual(self.calls, [])

    def test_rollback_rejects_changed_product(self):
        second = self.rollback_fixture(); self.api['/git/trees/' + second + '?recursive=1']['tree'][0]['sha'] = '1' * 40
        with self.assertRaisesRegex(SystemExit, 'differing tracked'): release.main()
        self.assertEqual(self.calls, [])

    def test_rollback_rejects_truncated_tree(self):
        second = self.rollback_fixture(); self.api['/git/trees/' + second + '?recursive=1']['truncated'] = True
        with self.assertRaisesRegex(SystemExit, 'truncated'): release.main()

    def test_rollback_rejects_unverified_asset(self):
        self.rollback_fixture(); self.api['/releases/tags/v1.17.0']['assets'][0]['digest'] = None
        with self.assertRaisesRegex(SystemExit, 'asset digest'): release.main()

    def test_windows_verification_is_required(self):
        (self.artifacts / 'WINDOWS-VALIDATION.json').write_text('{"version":"1.16.0"}')
        with self.assertRaisesRegex(SystemExit, 'Windows verification'): release.main()
        self.assertEqual(self.calls, [])

    def test_wrong_repository_never_publishes(self):
        os.environ['GITHUB_REPOSITORY'] = 'other/repository'
        with self.assertRaisesRegex(SystemExit, 'restricted'): release.main()
        self.assertEqual(self.calls, [])


if __name__ == '__main__': unittest.main()
