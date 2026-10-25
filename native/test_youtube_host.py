"""Harmless native protocol, format-selection and process-lifecycle fixtures."""
from __future__ import annotations

from copy import deepcopy
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("youtube_host", Path(__file__).with_name("youtube_host.py"))
HOST = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(HOST)
IDENTIFIER = "abcdefghijk"
BASE = "https://rr1---sn-example.googlevideo.com/videoplayback?itag="
REQUEST = {"version": 1, "requestId": "11111111-1111-4111-8111-111111111111", "action": "resolve",
           "url": "https://www.youtube.com/watch?v=" + IDENTIFIER, "quality": "highest", "output": "original", "userAgent": "Chrome harmless fixture"}


def media(identifier, *, kind="video", height=1080, ext="mp4", bitrate=1000, **extra):
    return {"format_id": str(identifier), "url": BASE + str(identifier), "protocol": "https", "ext": ext,
            "vcodec": "h264" if kind in ("video", "combined") else "none",
            "acodec": "aac" if kind in ("audio", "combined") else "none",
            "height": height if kind != "audio" else None, "tbr": bitrate, "has_drm": False, **extra}


def metadata(*formats, **extra):
    return {"id": IDENTIFIER, "title": "Harmless video", "duration": 3600.5, "live_status": "not_live", "formats": list(formats), **extra}


class YouTubeProtocolTests(unittest.TestCase):
    def test_valid_status_and_resolution_requests_have_fixed_fields(self):
        self.assertEqual(HOST.request(REQUEST), REQUEST)
        status = {key: REQUEST[key] for key in ("version", "requestId", "action")}; status["action"] = "status"
        self.assertEqual(HOST.request(status), status)

    def test_malformed_request_values_never_become_commands(self):
        for value in [None, [], {}, {**REQUEST, "version": True}, {**REQUEST, "action": "exec"},
                      {**REQUEST, "command": "echo test"}, {**REQUEST, "requestId": "wrong"},
                      {**REQUEST, "quality": "99999"}, {**REQUEST, "output": "exe"},
                      {**REQUEST, "userAgent": "x\r\nCookie: secret"}, {**REQUEST, "userAgent": "x" * 513},
                      {**REQUEST, "userAgent": "한글"}, {**REQUEST, "userAgent": ""}]:
            with self.subTest(value=value), self.assertRaises(HOST.HostError): HOST.request(value)

    def test_only_canonical_single_video_url_is_accepted(self):
        self.assertEqual(HOST.youtube_url(REQUEST["url"])[1], IDENTIFIER)
        for value in ["http://www.youtube.com/watch?v=" + IDENTIFIER,
                      "https://www.youtube.com.evil.test/watch?v=" + IDENTIFIER,
                      "https://user@www.youtube.com/watch?v=" + IDENTIFIER,
                      "https://www.youtube.com/playlist?list=PLabc", REQUEST["url"] + "&list=PLabc",
                      REQUEST["url"] + "&v=" + IDENTIFIER, REQUEST["url"] + "#fragment",
                      "file:///tmp/video", "https://www.youtube.com/watch?v=short"]:
            with self.subTest(value=value), self.assertRaises(HOST.HostError): HOST.youtube_url(value)

    def test_json_rejects_duplicate_fields_and_nonfinite_values(self):
        for data in [b'{"a":1,"a":2}', b'{"a":NaN}', b'\xff']:
            with self.assertRaises((ValueError, UnicodeError)): HOST.decode_json(data)

    def test_read_exact_and_native_output_have_bounded_utf8_framing(self):
        with self.assertRaises(EOFError): HOST.read_exact(io.BytesIO(b"ab"), 3)
        destination = io.BytesIO()
        HOST.write_message(destination, HOST.reply(REQUEST["requestId"], "error", message="안내"))
        data = destination.getvalue(); length = struct.unpack("<I", data[:4])[0]
        self.assertEqual(length, len(data) - 4); self.assertEqual(json.loads(data[4:])["message"], "안내")
        destination = io.BytesIO(); HOST.write_message(destination, HOST.reply(REQUEST["requestId"], "error", message="x" * (HOST.MAX_MESSAGE + 1)))
        self.assertLess(len(destination.getvalue()), 1024)

    def test_actual_native_process_frames_invalid_requests_without_exposing_payload(self):
        process = subprocess.Popen([sys.executable, "-I", "-B", str(Path(HOST.__file__).absolute())],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            data = b'{"version":99,"secret":"private URL must not be echoed"}'
            process.stdin.write(struct.pack("<I", len(data)) + data); process.stdin.flush()
            length = struct.unpack("<I", HOST.read_exact(process.stdout, 4))[0]
            answer = json.loads(HOST.read_exact(process.stdout, length))
            self.assertEqual(answer["status"], "error"); self.assertNotIn("secret", json.dumps(answer))
        finally:
            process.stdin.close(); process.wait(timeout=3); process.stdout.close(); process.stderr.close()

    def test_disconnect_cancels_inflight_extraction_and_sends_no_late_reply(self):
        source_fd, writer_fd = os.pipe()
        source = os.fdopen(source_fd, "rb"); destination = io.BytesIO(); entered = threading.Event()
        def fake_process(_argv, _payload, *, cancel):
            entered.set()
            self.assertTrue(cancel.wait(2))
            raise HOST.HostError("유튜브 정보 확인을 취소했습니다.")
        with patch.object(HOST, "readiness", return_value=(Path("/fixed/deno"), "Deno 2.9.8")), patch.object(HOST, "run_process", side_effect=fake_process):
            thread = threading.Thread(target=HOST.main, args=(source, destination)); thread.start()
            data = json.dumps(REQUEST).encode(); os.write(writer_fd, struct.pack("<I", len(data)) + data)
            self.assertTrue(entered.wait(2)); os.close(writer_fd); thread.join(3)
            self.assertFalse(thread.is_alive()); self.assertEqual(destination.getvalue(), b"")
        source.close()

    def test_actual_host_exits_cleanly_with_the_chrome_input_pipe_still_open(self):
        script = ("import importlib.util; s=importlib.util.spec_from_file_location('host'," + repr(str(Path(HOST.__file__).absolute())) + "); "
                  "h=importlib.util.module_from_spec(s); s.loader.exec_module(h); "
                  "h.handle=lambda value,cancel:h.reply(value['requestId'],'ready',ytDlpVersion=h.VERSION,runtime='Deno 2.9.8',message='fixture'); h.main()")
        process = subprocess.Popen([sys.executable, "-I", "-B", "-c", script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            value = {key: REQUEST[key] for key in ("version", "requestId", "action")}; value["action"] = "status"
            data = json.dumps(value).encode(); process.stdin.write(struct.pack("<I", len(data)) + data); process.stdin.flush()
            length = struct.unpack("<I", HOST.read_exact(process.stdout, 4))[0]
            self.assertEqual(json.loads(HOST.read_exact(process.stdout, length))["status"], "ready")
            self.assertEqual(process.wait(timeout=3), 0)
            self.assertNotIn(b"Fatal Python error", process.stderr.read())
        finally:
            process.stdin.close()
            if process.poll() is None: process.kill(); process.wait(timeout=2)
            process.stdout.close(); process.stderr.close()


class YouTubeSelectionTests(unittest.TestCase):
    def test_exact_googlevideo_https_playback_only(self):
        self.assertEqual(HOST.direct_url(BASE + "1"), BASE + "1")
        for value in ["http://rr1.googlevideo.com/videoplayback", "https://googlevideo.com/videoplayback",
                      "https://rr1.googlevideo.com.evil.test/videoplayback", "https://user@rr1.googlevideo.com/videoplayback",
                      "https://rr1.googlevideo.com:444/videoplayback", "https://rr1.googlevideo.com/other",
                      "https://rr1.googlevideo.com/videoplayback#fragment", BASE + "a\nb", BASE + "\\evil"]:
            with self.subTest(value=value), self.assertRaises(ValueError): HOST.direct_url(value)

    def test_unsafe_formats_and_required_credentials_are_excluded(self):
        self.assertIsNotNone(HOST.format_track(media(1)))
        for extra in [{"has_drm": True}, {"fragments": [{"url": BASE + "1"}]}, {"protocol": "m3u8_native"},
                      {"ext": "exe"}, {"url": "https://evil.test/video.mp4"}, {"cookies": "AUTH=private"},
                      {"http_headers": {"Cookie": "private"}}, {"http_headers": {"Authorization": "private"}},
                      {"format_id": "../escape"}, {"height": 0}, {"height": float("inf")}]:
            self.assertIsNone(HOST.format_track(media(1, **extra)))

    def test_highest_resolution_is_not_capped_to_combined_720p(self):
        result = HOST.select_result(metadata(media(18, kind="combined", height=720), media(313, height=2160, ext="webm"),
                                             media(140, kind="audio", ext="m4a"), media(251, kind="audio", ext="webm")), REQUEST)
        self.assertEqual([track["formatId"] for track in result["tracks"]], ["313", "251"])
        self.assertEqual([track["kind"] for track in result["tracks"]], ["video", "audio"])

    def test_quality_ceiling_and_lowest_available_fallback_match_existing_app(self):
        info = metadata(media(1, height=720), media(2, height=1080), media(3, height=2160), media(140, kind="audio"))
        self.assertEqual(HOST.select_result(info, {**REQUEST, "quality": "1080"})["tracks"][0]["height"], 1080)
        self.assertEqual(HOST.select_result(info, {**REQUEST, "quality": "480"})["tracks"][0]["height"], 720)

    def test_equal_resolution_prefers_higher_bitrate_and_combined_keeps_one_track(self):
        info = metadata(media(1, kind="combined", bitrate=400), media(2, kind="combined", bitrate=800))
        result = HOST.select_result(info, REQUEST)
        self.assertEqual(len(result["tracks"]), 1); self.assertEqual(result["tracks"][0]["formatId"], "2")

    def test_audio_modes_choose_one_audio_only_track_prefer_matching_mp4(self):
        info = metadata(media(1, kind="combined"), media(140, kind="audio", ext="m4a", bitrate=128),
                        media(141, kind="audio", ext="m4a", bitrate=192), media(251, kind="audio", ext="webm", bitrate=256))
        for output in ("mp3", "m4a"):
            result = HOST.select_result(info, {**REQUEST, "output": output})
            self.assertEqual(result["tracks"], [{"url": BASE + "141", "kind": "audio", "mime": "audio/mp4", "formatId": "141"}])

    def test_live_private_drm_age_and_playlist_results_are_rejected(self):
        for extra in [{"id": "other-id-123"}, {"_type": "playlist"}, {"is_live": True}, {"live_status": "is_upcoming"},
                      {"availability": "private"}, {"availability": "premium_only"}, {"age_limit": 18}]:
            with self.assertRaises(HOST.HostError): HOST.select_result(metadata(media(1, kind="combined"), **extra), REQUEST)
        with self.assertRaises(HOST.HostError): HOST.select_result(metadata(media(1, has_drm=True)), REQUEST)

    def test_missing_required_tracks_does_not_silently_download_a_different_kind(self):
        with self.assertRaises(HOST.HostError): HOST.select_result(metadata(media(1, kind="video")), REQUEST)
        with self.assertRaises(HOST.HostError): HOST.select_result(metadata(media(1, kind="combined")), {**REQUEST, "output": "mp3"})

    def test_metadata_is_bounded_without_signed_urls_or_cookie_fields(self):
        value = HOST.select_result(metadata(media(1, kind="combined", filesize=1000), title="한글🙂" * 100 + "\n", duration=4 * 3600), REQUEST)
        self.assertEqual(len(value["title"]), 200); self.assertEqual(value["duration"], 14400)
        self.assertEqual(set(value), {"videoId", "title", "tracks", "duration"}); self.assertEqual(value["tracks"][0]["size"], 1000)
        self.assertEqual(HOST.validate_result(value, REQUEST), value)

    def test_parent_revalidates_child_identity_urls_output_and_measurements(self):
        valid = HOST.select_result(metadata(media(1, kind="combined")), REQUEST)
        bad = []
        for field, value in [("videoId", "wrongwrong1"), ("title", "x" * 201), ("duration", float("nan")), ("extra", "unknown")]:
            modified = deepcopy(valid); modified[field] = value; bad.append(modified)
        for field, value in [("url", "https://evil.test/video"), ("kind", "audio"), ("height", True), ("size", -1), ("cookies", "secret")]:
            modified = deepcopy(valid); modified["tracks"][0][field] = value; bad.append(modified)
        for value in bad:
            with self.assertRaises(ValueError): HOST.validate_result(value, REQUEST)


class YouTubeProcessTests(unittest.TestCase):
    def test_real_child_echo_is_bounded_and_preserves_exact_bytes(self):
        command = [sys.executable, "-I", "-B", "-c", "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())"]
        self.assertEqual(HOST.run_process(command, b"harmless fixture"), b"harmless fixture")

    def test_child_failure_does_not_expose_raw_signed_url_or_stderr(self):
        with self.assertRaises(HOST.HostError) as error:
            HOST.run_process([sys.executable, "-I", "-B", "-c", "import sys;sys.stderr.write('private token not for UI');sys.exit(2)"])
        self.assertNotIn("private token", str(error.exception))

    def test_oversize_stdout_and_stderr_are_terminated(self):
        for stream in ("stdout", "stderr"):
            with self.assertRaises(HOST.HostError):
                HOST.run_process([sys.executable, "-I", "-B", "-c", f"import sys,time;sys.{stream}.write('x'*200000);sys.{stream}.flush();time.sleep(10)"], timeout=2, output_limit=1000)

    def test_timeout_and_cancellation_terminate_children(self):
        command = [sys.executable, "-I", "-B", "-c", "import time;time.sleep(20)"]
        started = time.monotonic()
        with self.assertRaises(HOST.HostError): HOST.run_process(command, timeout=0.08)
        self.assertLess(time.monotonic() - started, 3)
        cancel = threading.Event(); timer = threading.Timer(0.08, cancel.set); timer.start()
        try:
            with self.assertRaises(HOST.HostError): HOST.run_process(command, cancel=cancel)
        finally: timer.cancel()

    def test_already_cancelled_request_never_starts_a_process(self):
        cancel = threading.Event(); cancel.set()
        with patch.object(subprocess, "Popen", side_effect=AssertionError("Must not spawn")), self.assertRaises(HOST.HostError):
            HOST.run_process(["never"], cancel=cancel)

    @unittest.skipIf(os.name == "nt", "POSIX process-group fixture; real Windows Job Object requires Windows")
    def test_descendant_is_killed_even_when_parent_exits_before_it(self):
        program = "import subprocess,sys;p=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(20)']);print(p.pid,flush=True)"
        result = HOST.run_process([sys.executable, "-I", "-B", "-c", program], timeout=2)
        pid = int(result.strip()); process = Path(f"/proc/{pid}/stat")
        if process.exists(): self.assertEqual(process.read_text().split()[2], "Z")


class YouTubeReadinessTests(unittest.TestCase):
    def test_runtime_rechecks_executable_permissions_and_writable_parent(self):
        with tempfile.TemporaryDirectory(prefix="youtube-runtime-", dir=Path(__file__).parents[1] / ".cache") as directory:
            root = Path(directory); executable = root / "deno"
            executable.write_text("#!/bin/sh\nprintf 'deno 2.9.8\\n'\n"); executable.chmod(0o700)
            self.assertTrue(HOST._safe_file(executable, executable=True))
            executable.chmod(0o722)
            with self.assertRaises(HOST.HostError): HOST._safe_file(executable, executable=True)
            executable.chmod(0o700); root.chmod(0o777)
            try:
                with self.assertRaises(HOST.HostError): HOST._safe_file(executable, executable=True)
            finally: root.chmod(0o700)

    def test_configuration_requires_private_known_schema_and_safe_executable(self):
        with tempfile.TemporaryDirectory(prefix="youtube-config-", dir=Path(__file__).parents[1] / ".cache") as directory:
            root = Path(directory); executable = root / "deno"
            executable.write_text("#!/bin/sh\n"); executable.chmod(0o700)
            config = root / "youtube-config.json"; config.write_text(json.dumps({"deno": str(executable)})); config.chmod(0o600)
            with patch.object(HOST, "__file__", str(root / "youtube_host.py")):
                self.assertEqual(HOST.configuration(), executable)
                config.chmod(0o644)
                with self.assertRaises(HOST.HostError): HOST.configuration()
                config.chmod(0o600); config.write_text(json.dumps({"deno": str(executable), "command": "not accepted"}))
                with self.assertRaises(HOST.HostError): HOST.configuration()
                config.write_text(json.dumps({"deno": str(executable)})); executable.unlink(); executable.symlink_to(sys.executable)
                with self.assertRaises(HOST.HostError): HOST.configuration()

    def test_exact_dependencies_and_supported_deno_are_reported(self):
        with patch.object(HOST.importlib.metadata, "version", side_effect=lambda name: HOST.VERSION if name == "yt-dlp" else HOST.EJS_VERSION), \
                patch.object(HOST, "configuration", return_value=Path("/fixed/deno")), \
                patch.object(HOST, "run_process", return_value=b"deno 2.9.8\nv8 harmless fixture\n") as run:
            status = HOST.handle({"version": 1, "requestId": REQUEST["requestId"], "action": "status"})
            self.assertEqual(status["status"], "ready"); self.assertEqual(status["ytDlpVersion"], HOST.VERSION)
            self.assertEqual(status["runtime"], "Deno 2.9.8"); self.assertEqual(run.call_args.args[0], ["/fixed/deno", "--version"])

    def test_dependency_or_runtime_mismatch_is_unavailable(self):
        status = {"version": 1, "requestId": REQUEST["requestId"], "action": "status"}
        with patch.object(HOST.importlib.metadata, "version", return_value="wrong"):
            self.assertEqual(HOST.handle(status)["status"], "unavailable")
        with patch.object(HOST.importlib.metadata, "version", side_effect=lambda name: HOST.VERSION if name == "yt-dlp" else HOST.EJS_VERSION), \
                patch.object(HOST, "configuration", return_value=Path("/fixed/deno")), patch.object(HOST, "run_process", return_value=b"deno 1.0.0\n"):
            self.assertEqual(HOST.handle(status)["status"], "unavailable")

    def test_unknown_child_output_is_not_forwarded_to_the_extension(self):
        with patch.object(HOST, "readiness", return_value=(Path("/fixed/deno"), "Deno 2.9.8")), \
                patch.object(HOST, "run_process", return_value=b'{"private":"must not leak"}'):
            result = HOST.handle(REQUEST)
            self.assertEqual(result["status"], "error"); self.assertNotIn("private", json.dumps(result))


if __name__ == "__main__": unittest.main()
