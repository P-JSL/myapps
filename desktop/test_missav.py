"""Focused MissAV parser/transport/engine checks. Only owned loopback media is downloaded.

python desktop/test_missav.py [--app-root EXTRACTED/MyVideoApp] -v
The integration checks require pinned curl-cffi/yt-dlp, Node, OpenSSL and FFmpeg.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--app-root", type=Path)
args, rest = parser.parse_known_args()
REPO = Path(__file__).resolve().parent.parent
APP = (args.app_root or REPO).resolve()
package = types.ModuleType("_missav_validation")
package.__path__ = [str(APP / "desktop")]
sys.modules[package.__name__] = package
spec = importlib.util.spec_from_file_location(package.__name__ + ".engine", APP / "desktop/engine.py")
engine = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = engine
spec.loader.exec_module(engine)
missav = engine.missav
ID = "a1b2c3d4-1234-5678-abcd-1234567890ab"
ROOT = f"https://surrit.com/{ID}/"
PAGE = "https://missav123.com/ko/owned-fixture"


class ParserTests(unittest.TestCase):
    def test_explicit_path_and_signature_are_preserved(self):
        url = ROOT.replace(ID, ID.upper()) + '1080p//video.m3u8?sig=Keep%2FCase'
        self.assertEqual(missav.playlist_urls(f'<script>const src="{url}";</script>'), [url])
        self.assertTrue(missav.applies(url))

    def test_packed_and_seek_recognition_without_script_execution(self):
        self.assertEqual(missav.playlist_urls('<script>eval("m3u8|1234567890ab|abcd|5678|1234|a1b2c3d4|com|surrit|https")</script>'), [ROOT + 'playlist.m3u8'])
        self.assertEqual(missav.playlist_urls(f'<script>const campaign="{ID}";</script>'), [])
        self.assertEqual(missav.playlist_urls(f'<script>const url="{ROOT}seek";</script>'), [ROOT + 'playlist.m3u8'])

    def test_ambiguous_players_and_unknown_hosts_are_rejected(self):
        with self.assertRaises(missav.MissavError):
            missav.playlist_urls(f'<script>"{ROOT}playlist.m3u8" "{ROOT.replace(ID, "11111111-1111-1111-1111-111111111111")}playlist.m3u8"</script>')
        for url in [ROOT.replace('surrit.com', 'evil.test'), ROOT.replace('https:', 'http:'), ROOT.replace('surrit.com', 'surrit.com:8443'), ROOT.replace('surrit.com', 'user:secret@surrit.com')]:
            self.assertFalse(missav.applies(url + 'playlist.m3u8'))

    def test_html_encrypted_live_and_oversized_playlists_fail(self):
        for data in [b'<html>Challenge</html>', b'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST\n', b'#EXTM3U\n#EXTINF:1,\na.ts\n', b'x' * (missav.MAX_MANIFEST + 1)]:
            with self.assertRaises(missav.MissavError): missav.validate_playlist(data)
        missav.validate_playlist(b'#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST\n')

    def test_youtube_and_ordinary_direct_sources_do_not_install_a_handler(self):
        for url in ['https://www.youtube.com/watch?v=abcdefghijk', 'https://example.org/video.mp4']:
            downloader = types.SimpleNamespace(params={})
            self.assertIsNone(missav.configure(downloader, url))
            self.assertEqual(downloader.params, {})


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import yt_dlp
        from curl_cffi import requests, CurlOpt, ffi, lib
        cls.yt_dlp = yt_dlp
        cls.temporary = tempfile.TemporaryDirectory(prefix="missav-owned-")
        cls.root = Path(cls.temporary.name)
        openssl = shutil.which('openssl')
        if not openssl and os.name == 'nt':
            openssl = str(Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Git/usr/bin/openssl.exe')
        cert, key = cls.root / 'test-ca.pem', cls.root / 'test.key'
        subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', str(key), '-out', str(cert),
                        '-subj', '/CN=Owned MissAV loopback test', '-addext', 'subjectAltName=DNS:surrit.com,DNS:nineyu.com,DNS:missav123.com',
                        '-addext', 'basicConstraints=critical,CA:TRUE'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        runtime = APP / 'runtime/ffmpeg'
        cls.ffmpeg = runtime / 'ffmpeg.exe' if args.app_root else Path(shutil.which('ffmpeg'))
        cls.ffprobe = runtime / 'ffprobe.exe' if args.app_root else Path(shutil.which('ffprobe'))
        clip = cls.root / 'clip.ts'
        subprocess.run([str(cls.ffmpeg), '-v', 'error', '-i', str(REPO / 'tests/fixtures/desktop-source.mp4'), '-c', 'copy', '-f', 'mpegts', '-y', str(clip)], check=True)
        cls.log = cls.root / 'requests.jsonl'
        cls.server = subprocess.Popen([shutil.which('node'), str(REPO / 'tests/missav_fixture_server.mjs'), str(cert), str(key), str(clip), str(cls.log)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            port = json.loads(cls.server.stdout.readline())['port']
        except Exception:
            cls.server.terminate(); raise
        original_init = requests.Session.__init__
        cls.connect_lists = []
        cls.curl_lib = lib

        def initialize(session, *positional, **options):
            # Test process only: route the named fixture hosts to its owned TLS
            # loopback server. Product code has no DNS/proxy override or hook.
            original_init(session, *positional, **options)
            routes = ffi.NULL
            for host in ['surrit.com', 'nineyu.com', 'missav123.com']:
                routes = lib.curl_slist_append(routes, f'{host}:443:127.0.0.1:{port}'.encode())
            cls.connect_lists.append(routes)
            session.curl_options.update({CurlOpt.CONNECT_TO: routes, CurlOpt.PROXY: '', CurlOpt.CAINFO: str(cert)})
        cls.session_patch = mock.patch.object(requests.Session, '__init__', initialize)
        cls.session_patch.start()
        cls.environment = mock.patch.dict(os.environ, {'SSL_CERT_FILE': str(cert), 'REQUESTS_CA_BUNDLE': str(cert)})
        cls.environment.start()

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop(); cls.session_patch.stop()
        cls.server.terminate()
        try: cls.server.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            cls.server.kill(); cls.server.communicate(timeout=5)
        for routes in cls.connect_lists: cls.curl_lib.curl_slist_free_all(routes)
        cls.temporary.cleanup()

    def downloader(self):
        return self.yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True, 'socket_timeout': 3, 'retries': 0, 'fragment_retries': 0, 'skip_unavailable_fragments': False})

    def test_compatible_headers_and_http2_cover_manifests_and_segments(self):
        from curl_cffi import requests
        with requests.Session() as plain:
            self.assertEqual(plain.get(ROOT + '1080p/video.m3u8', timeout=3).status_code, 403)
        with self.downloader() as ydl:
            missav.configure(ydl, ROOT + 'playlist.m3u8')
            with ydl.urlopen(ROOT + 'playlist.m3u8') as response:
                self.assertTrue(response.read().startswith(b'#EXTM3U'))
            with ydl.urlopen(ROOT + '1080p/clip.ts') as response:
                self.assertGreater(len(response.read()), 188)
        requests = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertTrue(any(row['status'] == 403 for row in requests))
        self.assertTrue(any(row['path'].endswith('clip.ts') and row['http'] == '2.0' and row['status'] == 200 for row in requests))

    def test_page_extraction_uses_selected_quality_and_page_title(self):
        subject = object.__new__(engine.Engine)
        with self.downloader() as ydl:
            info = subject._extract(ydl, PAGE, False, threading.Event())
        tracks, container = engine.choose_tracks(info, '720', 'original')
        self.assertEqual(info['title'], 'Owned MissAV fixture')
        self.assertEqual(tracks[0]['height'], 720)
        self.assertEqual(container, 'mp4')

    def test_direct_variant_does_not_get_rejected_as_an_html_page(self):
        subject = object.__new__(engine.Engine)
        with self.downloader() as ydl:
            info = subject._extract(ydl, ROOT + '1080p/video.m3u8', False, threading.Event())
        self.assertEqual(engine.choose_tracks(info, 'highest', 'original')[0][0]['protocol'], 'm3u8_native')

    def test_normal_jobs_keep_the_original_handler_set_without_changing_global_handlers(self):
        from yt_dlp.networking.common import _REQUEST_HANDLERS
        with self.downloader() as ydl:
            self.assertIn('CurlCFFI', ydl._request_director.handlers)
            missav.ordinary_transport(ydl)
            self.assertNotIn('CurlCFFI', ydl._request_director.handlers)
            self.assertIn('Urllib', ydl._request_director.handlers)
            self.assertIn('CurlCFFI', _REQUEST_HANDLERS)

    def test_out_of_scope_requests_redirects_and_invalid_manifests_fail(self):
        with self.downloader() as ydl:
            missav.configure(ydl, ROOT + 'playlist.m3u8')
            for url in ['https://evil.invalid/private', ROOT.replace(ID, '11111111-1111-1111-1111-111111111111') + 'playlist.m3u8',
                        ROOT + 'redirect.m3u8', ROOT + 'encrypted.m3u8', ROOT + 'live.m3u8', ROOT + 'error.m3u8']:
                with self.assertRaises(Exception): ydl.urlopen(url)

    def test_owned_hls_download_remuxes_and_missing_segments_are_not_completed(self):
        outer = self
        class OwnedEngine(engine.Engine):
            def _dependencies(self, youtube, cancel):
                return outer.yt_dlp, Path('unused-deno'), outer.ffmpeg, outer.ffprobe
            def _extract_isolated(self, url, youtube, quality, output, cancel):
                with outer.downloader() as ydl: return self._extract(ydl, url, youtube, cancel)
            def _options(self, *positional, **keywords):
                options = super()._options(*positional, **keywords)
                options.update(retries=0, fragment_retries=0, socket_timeout=3)
                return options
        with tempfile.TemporaryDirectory(dir=self.root) as directory:
            folder = Path(directory)
            subject = OwnedEngine(APP, folder / 'data')
            progress = []
            result = subject.download(engine.DownloadRequest(ROOT + '1080p/video.m3u8', folder, scan=False), progress.append, threading.Event())
            self.assertTrue(Path(result.filepath).is_file())
            probe = json.loads(subprocess.check_output([str(self.ffprobe), '-v', 'error', '-show_streams', '-of', 'json', result.filepath]))
            self.assertEqual({stream['codec_type'] for stream in probe['streams']}, {'video', 'audio'})
            self.assertTrue(any(item.stage == 'complete' for item in progress))
            with self.assertRaises(engine.EngineError):
                subject.download(engine.DownloadRequest(ROOT + 'missing.m3u8', folder, scan=False), lambda _: None, threading.Event())
            self.assertEqual(len(list(folder.glob('*.mp4'))), 1)
            self.assertTrue(all(value['used'] == 0 for value in subject.resources.snapshot().values()))


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], *rest])
