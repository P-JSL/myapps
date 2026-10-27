"""Focused offline checks for the two-track download failure and recovery path.

python -I -B desktop/test_download_recovery.py --app-root EXTRACTED_APP -v
The engine, transfer, SQLite history, owned files and publication are real.
HTTP and extraction are controlled boundaries; one test also runs real ffmpeg.
"""
from __future__ import annotations

import argparse
import copy
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch


_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parents[1])
_options, _test_arguments = _parser.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
SOURCE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT / "desktop"))

import engine as subject
from concurrency import ResourceBudget
import transfer
from transport import TransportError


YOUTUBE = "https://www.youtube.com/watch?v=LghCA95RphM"
VIDEO_URL = "https://media.example.test/video?signature=PRIVATE_VIDEO"
AUDIO_URL = "https://media.example.test/audio?signature=PRIVATE_AUDIO"
HEAD = b"\0\0\0\x18ftypisom" + b"\0" * 400
VIDEO = HEAD + bytes(1_610_000 - len(HEAD))
AUDIO = HEAD + bytes(96_000 - len(HEAD))


class Response:
    actual_protocol = "h2"

    def __init__(self, url, body=b"", *, status=200, headers=None,
                 fail_after=None, before_failure=None):
        self.url, self.status = url, status
        self.headers = {"content-length": str(len(body)), **(headers or {})}
        self.stream = io.BytesIO(body)
        self.fail_after, self.before_failure = fail_after, before_failure

    def read(self, count):
        if self.fail_after is not None:
            remaining = self.fail_after - self.stream.tell()
            if remaining <= 0:
                if self.before_failure is not None:
                    self.before_failure()
                raise TransportError("private native diagnostics " + self.url, code=56)
            count = min(count, remaining)
        return self.stream.read(count)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.stream.close()


class HTTPBoundary:
    def __init__(self, engine):
        self.engine = engine
        self.video, self.audio = VIDEO, AUDIO
        self.behavior = "normal"
        self.requests, self.transports = [], []
        self.before_failure = None

    def transport(self, **options):
        boundary = self

        class Transport:
            closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_):
                self.closed = True

            def open(self, url, headers, cancel, **_):
                boundary.requests.append({"url": url, "headers": dict(headers)})
                body = boundary.video if url == VIDEO_URL else boundary.audio
                is_audio = url == AUDIO_URL
                if is_audio and boundary.behavior == "probe403" and "Range" in headers:
                    return Response(url, status=403)
                if is_audio and boundary.behavior == "http403":
                    return Response(url, status=403)
                if is_audio and boundary.behavior == "http503":
                    return Response(url, status=503, headers={"retry-after": "0"})
                if is_audio and boundary.behavior == "network":
                    return Response(url, body, fail_after=min(65_536, len(body)),
                                    before_failure=boundary.before_failure)
                if boundary.behavior == "etag" and "Range" in headers:
                    start, end = map(int, headers["Range"].removeprefix("bytes=").split("-"))
                    end = min(end, len(body) - 1)
                    return Response(url, body[start:end + 1], status=206,
                                    headers={"content-range": f"bytes {start}-{end}/{len(body)}",
                                             "etag": '"changed"' if start else '"original"'})
                return Response(url, body)

        client = Transport()
        client.options = options
        boundary.transports.append(client)
        return client


class Harness(subject.Engine):
    def __init__(self, root):
        super().__init__(APP_ROOT, root / "history", resources=ResourceBudget())
        self.destination = root / "저장 폴더 😀"
        self.destination.mkdir()
        self.extractions, self.legacy_calls, self.commands = 0, [], []
        self.legacy_failure = None
        self.boundary = HTTPBoundary(self)
        self.real_binaries = None
        self.info = {"id": "LghCA95RphM", "title": "공개 동영상 😀", "formats": [
            {"format_id": "137", "url": VIDEO_URL, "protocol": "https", "ext": "mp4",
             "vcodec": "avc1.640028", "acodec": "none", "height": 1080,
             "filesize": len(VIDEO), "http_headers": {"Referer": "https://www.youtube.com/"}},
            {"format_id": "140", "url": AUDIO_URL, "protocol": "https", "ext": "m4a",
             "vcodec": "none", "acodec": "mp4a.40.2", "abr": 128,
             "filesize": len(AUDIO), "http_headers": {"Referer": "https://www.youtube.com/"}}]}

    def _dependencies(self, youtube, cancel):
        owner = self

        class LegacyDownloader:
            def __init__(self, options):
                self.options = options

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def dl(self, filename, info):
                path = Path(filename)
                owner.legacy_calls.append({"url": info["url"], "info": copy.deepcopy(info),
                                           "path": path, "options": self.options,
                                           "leases": owner.resources.snapshot()["network"]["used"],
                                           "existing": path.exists(),
                                           "partial": Path(filename + ".part").exists()})
                if owner.legacy_failure is not None:
                    raise owner.legacy_failure
                body = owner.boundary.video if info["url"] == VIDEO_URL else owner.boundary.audio
                if not path.exists():
                    with path.open("xb") as destination:
                        destination.write(body)
                for callback in self.options["progress_hooks"]:
                    callback({"downloaded_bytes": len(body), "total_bytes": len(body)})
                return True, True

        ffmpeg, ffprobe = self.real_binaries or ("ffmpeg.exe", "ffprobe.exe")
        return SimpleNamespace(YoutubeDL=LegacyDownloader), Path("deno.exe"), Path(ffmpeg), Path(ffprobe)

    def _extract_isolated(self, *_):
        self.extractions += 1
        return copy.deepcopy(self.info)

    def _run(self, arguments, cancel, **options):
        self.commands.append(arguments)
        if self.real_binaries:
            return super()._run(arguments, cancel, **options)
        subject._check_cancel(cancel)
        if arguments[0] == "ffprobe.exe":
            return b'{"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}'
        sources = [Path(arguments[i + 1]) for i, argument in enumerate(arguments) if argument == "-i"]
        with Path(arguments[-1]).open("xb") as output:
            output.write(b"".join(source.read_bytes() for source in sources))
        return b""


class DownloadRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-download-recovery-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.engine = Harness(self.root)
        self.boundary = self.engine.boundary
        self.events = []
        self.cancel = threading.Event()
        replacement = patch.object(subject, "NativeTransport", self.boundary.transport)
        replacement.start()
        self.addCleanup(replacement.stop)

    def download(self, **options):
        request = subject.DownloadRequest(YOUTUBE, self.engine.destination, output="mp4", **options)
        return self.engine.download(request, self.events.append, self.cancel)

    def assertReleased(self):
        self.assertTrue(all(value["used"] == 0 and value["waiting"] == 0
                            for value in self.engine.resources.snapshot().values()))
        self.assertTrue(all(client.closed for client in self.boundary.transports))

    def assertPrivateDataAbsent(self, message=""):
        serialized = message + json.dumps(self.engine.history(), ensure_ascii=False)
        self.assertNotIn("PRIVATE_VIDEO", serialized)
        self.assertNotIn("PRIVATE_AUDIO", serialized)
        self.assertNotIn("private native diagnostics", serialized)

    def assertAudioFallback(self):
        self.assertEqual(len(self.engine.legacy_calls), 1)
        call = self.engine.legacy_calls[0]
        self.assertEqual(call["url"], AUDIO_URL)
        self.assertEqual(call["info"]["http_headers"], self.engine.info["formats"][1]["http_headers"])
        self.assertEqual(call["leases"], 1)
        self.assertFalse(call["existing"] or call["partial"])
        self.assertEqual(call["options"]["retries"], 0)
        self.assertEqual(self.engine.extractions, 1)
        self.assertEqual(sum(request["url"] == VIDEO_URL for request in self.boundary.requests), 1)

    def test_two_track_success_crosses_the_reported_94_percent_boundary(self):
        result = self.download()
        boundary = [event for event in self.events if event.downloaded == len(VIDEO) and event.percent]
        self.assertTrue(boundary)
        self.assertAlmostEqual(boundary[-1].percent, 94.3728018757)
        self.assertEqual(Path(result.filepath).read_bytes(), VIDEO + AUDIO)
        self.assertEqual(self.events[-1].stage, "complete")
        self.assertFalse(self.engine.legacy_calls)
        self.assertReleased()

    def test_reported_share_url_is_canonical_and_drops_tracking_data(self):
        value, youtube = subject.canonical_url("https://youtu.be/LghCA95RphM?si=share-tracking-fixture")
        self.assertEqual(value, YOUTUBE)
        self.assertTrue(youtube)
        self.assertNotIn("si=", value)

    def test_retry_preserves_the_completed_video_and_recovers_only_audio(self):
        self.boundary.behavior = "http403"
        with self.assertRaises(subject.EngineError):
            self.download()
        job = self.engine.history()[0]
        directory = next(self.engine.destination.glob(".myvideoapp-*.tmp"))
        completed = directory / "source-0.mp4"
        before = hashlib.sha256(completed.read_bytes()).digest()
        self.boundary.behavior = "probe403"
        result = self.engine.download(self.engine.retry_request(job["job_id"]), self.events.append, self.cancel)
        self.assertEqual(sum(request["url"] == VIDEO_URL for request in self.boundary.requests), 1)
        self.assertEqual(len(self.engine.legacy_calls), 1)
        self.assertEqual(self.engine.legacy_calls[0]["url"], VIDEO_URL)
        self.assertTrue(self.engine.legacy_calls[0]["existing"])
        self.assertEqual(hashlib.sha256(Path(result.filepath).read_bytes()[:len(VIDEO)]).digest(), before)
        self.assertEqual(Path(result.filepath).read_bytes(), VIDEO + AUDIO)
        self.assertEqual(self.engine.history()[0]["stage"], "complete")
        self.assertReleased()

    def test_audio_probe_403_retries_as_an_ordinary_full_get(self):
        self.boundary.behavior = "probe403"
        result = self.download()
        requests = [request for request in self.boundary.requests if request["url"] == AUDIO_URL]
        self.assertEqual(len(requests), 2)
        self.assertIn("Range", requests[0]["headers"])
        self.assertNotIn("Range", requests[1]["headers"])
        self.assertEqual(Path(result.filepath).read_bytes(), VIDEO + AUDIO)
        self.assertFalse(self.engine.legacy_calls)
        self.assertReleased()

    def test_audio_403_on_full_get_reports_the_track_and_http_status(self):
        self.boundary.behavior = "http403"
        with self.assertRaises(subject.EngineError) as caught:
            self.download()
        message = str(caught.exception)
        self.assertIn("오디오", message)
        self.assertIn("403", message)
        self.assertNotIn("저장 공간", message)
        progress = [event for event in self.events if event.percent is not None]
        self.assertAlmostEqual(progress[-1].percent, 94.3728018757)
        self.assertFalse(self.engine.legacy_calls)
        self.assertFalse(list(self.engine.destination.glob("*.mp4")))
        self.assertPrivateDataAbsent(message)
        self.assertReleased()

    def test_audio_midstream_network_error_falls_back_only_for_that_track(self):
        self.boundary.behavior = "network"
        result = self.download()
        self.assertAudioFallback()
        self.assertEqual(hashlib.sha256(Path(result.filepath).read_bytes()).digest(),
                         hashlib.sha256(VIDEO + AUDIO).digest())
        self.assertEqual(self.engine.history()[0]["stage"], "complete")
        self.assertFalse(list(self.engine.destination.glob(".myvideoapp-*")))
        self.assertPrivateDataAbsent(result.message)
        self.assertReleased()

    def test_http_503_never_uses_compatibility_fallback(self):
        self.boundary.behavior = "http503"
        with self.assertRaises(subject.EngineError):
            self.download()
        self.assertFalse(self.engine.legacy_calls)
        self.assertPrivateDataAbsent()
        self.assertReleased()

    def test_failed_compatibility_recovery_reports_network_phase_without_secrets(self):
        self.boundary.behavior = "network"
        self.engine.legacy_failure = RuntimeError("private native diagnostics " + AUDIO_URL)
        with self.assertRaises(subject.EngineError) as caught:
            self.download()
        self.assertIn("오디오", str(caught.exception))
        self.assertIn("호환", str(caught.exception))
        self.assertNotIn("공간", str(caught.exception))
        self.assertEqual(len(self.engine.legacy_calls), 1)
        self.assertPrivateDataAbsent(str(caught.exception))
        self.assertReleased()

    def test_changed_range_validator_never_uses_compatibility_fallback(self):
        self.boundary.behavior = "etag"
        self.boundary.video = HEAD + bytes(transfer.PARALLEL_THRESHOLD + 4096 - len(HEAD))
        self.engine.info["formats"][0]["filesize"] = len(self.boundary.video)
        with self.assertRaises(subject.EngineError) as caught:
            self.download()
        self.assertIn("변경", str(caught.exception))
        self.assertFalse(self.engine.legacy_calls)
        self.assertFalse(list(self.engine.destination.glob("*.mp4")))
        self.assertPrivateDataAbsent(str(caught.exception))
        self.assertReleased()

    def test_cancel_during_audio_transfer_never_uses_compatibility_fallback(self):
        self.boundary.behavior = "network"
        self.boundary.before_failure = self.cancel.set
        with self.assertRaises(subject.DownloadCancelled):
            self.download()
        self.assertFalse(self.engine.legacy_calls)
        self.assertEqual(self.engine.history()[0]["stage"], "cancelled")
        self.assertFalse(list(self.engine.destination.glob(".myvideoapp-*")))
        self.assertReleased()

    def test_fallback_refuses_a_preexisting_partial_file(self):
        self.boundary.behavior = "network"
        kept = []

        def leave_partial():
            directory = next(self.engine.destination.glob(".myvideoapp-*.tmp"))
            partial = directory / "source-1.m4a.part"
            partial.write_bytes(b"preserve existing partial")
            kept.append(partial)

        self.boundary.before_failure = leave_partial
        with self.assertRaises(subject.EngineError):
            self.download()
        self.assertFalse(self.engine.legacy_calls)
        self.assertEqual(kept[0].read_bytes(), b"preserve existing partial")
        self.assertReleased()

    def test_disk_full_and_permission_errors_have_distinct_safe_messages(self):
        messages = {}
        for number in (errno.ENOSPC, errno.EACCES, errno.EPERM, errno.EIO):
            with self.subTest(errno=number):
                with patch.object(transfer.os, "write", side_effect=OSError(number, VIDEO_URL)):
                    with self.assertRaises(subject.EngineError) as caught:
                        self.download()
                messages[number] = str(caught.exception)
                self.assertFalse(self.engine.legacy_calls)
                self.assertPrivateDataAbsent(messages[number])
                self.assertReleased()
        self.assertIn("공간", messages[errno.ENOSPC])
        self.assertIn("권한", messages[errno.EACCES])
        self.assertIn("권한", messages[errno.EPERM])
        self.assertNotIn("공간", messages[errno.EIO])
        self.assertNotEqual(messages[errno.ENOSPC], messages[errno.EACCES])

    def test_recovered_audio_publishes_real_media_with_both_original_tracks(self):
        binaries = tuple(str(APP_ROOT / "runtime" / "ffmpeg" / name)
                         if os.name == "nt" else shutil.which(name.removesuffix(".exe"))
                         for name in ("ffmpeg.exe", "ffprobe.exe"))
        fixture = SOURCE_ROOT / "tests" / "fixtures" / "desktop-source.mp4"
        if not all(binaries) or not fixture.is_file():
            self.skipTest("Local ffmpeg/ffprobe and the checked-in public media fixture are required.")
        video_path, audio_path = self.root / "video.mp4", self.root / "audio.m4a"
        for selector, destination in (("0:v:0", video_path), ("0:a:0", audio_path)):
            subprocess.run([binaries[0], "-v", "error", "-nostdin", "-i", str(fixture),
                            "-map", selector, "-c", "copy", str(destination)],
                           check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.engine.real_binaries = binaries
        self.boundary.video, self.boundary.audio = video_path.read_bytes(), audio_path.read_bytes()
        self.engine.info["formats"][0]["filesize"] = len(self.boundary.video)
        self.engine.info["formats"][1]["filesize"] = len(self.boundary.audio)
        self.boundary.behavior = "network"
        # Interrupt inside the real AAC file, after some bytes reach the owned file.
        original = self.boundary.audio
        self.assertGreater(len(original), 1)
        result = self.download()
        self.assertAudioFallback()
        published = Path(result.filepath)
        payload = subprocess.run([binaries[1], "-v", "error", "-show_entries", "stream=codec_type,codec_name",
                                  "-of", "json", str(published)], check=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
        streams = json.loads(payload)["streams"]
        self.assertEqual([(stream["codec_type"], stream["codec_name"]) for stream in streams],
                         [("video", "h264"), ("audio", "aac")])
        def stream_hash(path, selector):
            return subprocess.run([binaries[0], "-v", "error", "-nostdin", "-i", str(path),
                                   "-map", selector, "-c", "copy", "-f", "hash", "-hash", "sha256", "-"],
                                  check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()
        self.assertEqual(stream_hash(published, "0:v:0"), stream_hash(video_path, "0:v:0"))
        self.assertEqual(stream_hash(published, "0:a:0"), stream_hash(audio_path, "0:a:0"))
        self.assertReleased()


if __name__ == "__main__":
    result = unittest.main(argv=[sys.argv[0], *_test_arguments], exit=False).result
    raise SystemExit(0 if result.wasSuccessful() and not result.skipped else 1)
