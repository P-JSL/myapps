"""Controlled direct-HLS regression checks, runnable with the Windows bundle."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8', errors='backslashreplace')

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument('--app-root', type=Path, default=Path(__file__).resolve().parent.parent)
args, remaining = parser.parse_known_args()
sys.path.insert(0, str(args.app_root / 'desktop'))
from engine import Engine, EngineError, choose_tracks
import yt_dlp


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        kind = self.path.split('?', 1)[0]
        if kind == '/page.m3u8':
            body = b'<html><title>Not direct media</title><video src="track.mp4"></video></html>'
            mime = 'text/html'
        else:
            key = b'#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n' if kind == '/encrypted.m3u8' else b''
            ending = b'' if kind == '/live.m3u8' else b'#EXT-X-ENDLIST\n'
            body = b'#EXTM3U\n#EXT-X-TARGETDURATION:1\n' + key + b'#EXTINF:1,\nclip.ts\n' + ending
            mime = 'application/vnd.apple.mpegurl'
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


class DirectHLSTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def extract(self, name):
        source = f'http://127.0.0.1:{self.server.server_port}/{name}.m3u8'
        with yt_dlp.YoutubeDL({'quiet': True, 'no_warnings': True}) as downloader:
            return object.__new__(Engine)._extract(downloader, source, False, threading.Event())

    def test_direct_non_missav_variant_is_accepted_as_hls(self):
        info = self.extract('video')
        tracks, container = choose_tracks(info, 'highest', 'original')
        self.assertEqual(tracks[0]['protocol'], 'm3u8_native')
        self.assertEqual(container, 'mp4')

    def test_encrypted_variant_is_rejected_before_downloading(self):
        with self.assertRaisesRegex(EngineError, '암호화'):
            self.extract('encrypted')

    def test_live_variant_remains_unsupported(self):
        with self.assertRaisesRegex(EngineError, '라이브'):
            self.extract('live')

    def test_html_with_a_playlist_filename_does_not_become_direct_media(self):
        with self.assertRaisesRegex(EngineError, '웹 페이지'):
            self.extract('page')


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], *remaining])
