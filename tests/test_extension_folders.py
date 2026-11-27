"""Check the actual archive writer keeps the two install folders separate."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile

WRITER = Path(__file__).resolve().parent.parent / 'scripts/archive.py'


class FolderArchiveTests(unittest.TestCase):
    def check_variant(self, variant):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ['standard', 'missav']:
                folder = root / 'extensions' / name
                folder.mkdir(parents=True)
                (folder / 'manifest.json').write_text(json.dumps({'version': '1.20.6'}))
                (folder / 'variant.txt').write_text(name)
            native = root / 'native'; native.mkdir()
            for name in ['README.ko.md', 'antivirus_host.py', 'windows_antivirus.py', 'internal_scan.py', 'install.py']:
                (native / name).write_text('Owned harmless packaging fixture')
            result = subprocess.run([sys.executable, '-B', str(WRITER)], cwd=root,
                env={**os.environ, 'MY_VIDEO_APP_EXTENSION_VARIANT': variant}, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            prefix = f'my-video-app-{variant}/'
            with ZipFile(root / 'artifacts/my-video-app-extension.zip') as archive:
                self.assertEqual(set(archive.namelist()), {prefix + 'manifest.json', prefix + 'variant.txt'})
                self.assertEqual(archive.read(prefix + 'variant.txt').decode(), variant)
            with ZipFile(root / 'artifacts/my-video-app-source.zip') as archive:
                self.assertFalse(any('/extensions/' in name for name in archive.namelist()))

    def test_standard_folder_is_the_only_standard_archive_root(self):
        self.check_variant('standard')

    def test_missav_folder_is_the_only_missav_archive_root(self):
        self.check_variant('missav')


if __name__ == '__main__':
    unittest.main()
