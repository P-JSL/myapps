"""Focused desktop 1.19.4 restoration checks, independent of previous suites.

    python -I -B desktop/test_v18_restore.py -v
    runtime/python/python.exe -I -B desktop/test_v18_restore.py --app-root APP --real-download -v

The default suite uses only the standard library and controlled downloader/media
boundaries. --real-download additionally requires pinned yt-dlp and real FFmpeg:
it downloads owned split media over loopback, probes, merges and publishes with
the actual engine. Extraction metadata is controlled; no YouTube is contacted.
Windows uses the selected bundle's dependencies. Linux development may extract
the pinned pure Python wheels into .cache/desktop-download-dev and use system
ffmpeg/ffprobe. Missing real prerequisites fail rather than skip.
"""
from __future__ import annotations

import argparse
import ast
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import importlib.metadata
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock
from urllib.parse import urlsplit


_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path)
_parser.add_argument("--real-download", action="store_true")
_arguments, _unittest_arguments = _parser.parse_known_args()
APP_ROOT = (_arguments.app_root or Path(__file__).resolve().parent.parent).resolve()
DESKTOP_DIR = APP_ROOT / "desktop"
if not all((DESKTOP_DIR / name).is_file() for name in ("engine.py", "storage.py", "activity.py")):
    raise SystemExit("--app-root must contain desktop/engine.py, storage.py and activity.py")


def _load(name):
    package_name = "_myvideoapp_v18_restore_validation"
    if package_name not in sys.modules:
        package = types.ModuleType(package_name)
        package.__path__ = [str(DESKTOP_DIR)]
        package.__package__ = package_name
        sys.modules[package_name] = package
    name = package_name + "." + name
    if name not in sys.modules:
        specification = importlib.util.spec_from_file_location(name, DESKTOP_DIR / (name.rsplit(".", 1)[-1] + ".py"))
        module = importlib.util.module_from_spec(specification)
        sys.modules[name] = module
        specification.loader.exec_module(module)
    return sys.modules[name]


engine = _load("engine")
storage = _load("storage")
activity = _load("activity")
VIDEO_ID = "abcdefghijk"
YOUTUBE = "https://www.youtube.com/watch?v=" + VIDEO_ID
SECRET = "v18-private-canary-7492"
REMOVED_PREFERENCES = {"http3_enabled", "parallel_downloads", "speed_limit_enabled", "speed_limit_kib"}
VIDEO_BYTES = b"\x00\x00\x00\x18ftypisom" + b"owned-video-packets" * 8
AUDIO_BYTES = b"\x00\x00\x00\x18ftypM4A " + b"owned-audio-packets" * 5


def _information(base="https://media.invalid", *, fragments=False, sizes=None):
    sizes = sizes or (len(VIDEO_BYTES), len(AUDIO_BYTES))
    video = {"format_id": "video", "url": base + "/video.mp4?token=" + SECRET,
             "ext": "mp4", "height": 720, "width": 1280, "vcodec": "avc1.64001f",
             "acodec": "none", "filesize": sizes[0], "tbr": 1000, "protocol": "https"}
    audio = {"format_id": "audio", "url": base + "/audio.m4a?token=" + SECRET,
             "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2",
             "filesize": sizes[1], "abr": 128, "protocol": "https"}
    if fragments:
        video.update(protocol="http_dash_segments", fragments=[{"url": base + "/fragment.mp4"}])
    return {"id": VIDEO_ID, "title": "Owned fixture", "duration": 2,
            "formats": [video, audio], "direct": True,
            "__postprocessors": [{"key": "DoNotPassToDl"}]}


class _FakeYDL:
    def __init__(self, owner, options):
        self.owner = owner
        self.params = options
        self.closed = False
        with owner.observation_lock:
            owner.sessions.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True
        return False

    def dl(self, filename, item):
        owner = self.owner
        identifier = item["format_id"]
        workers = self.params["concurrent_fragment_downloads"]
        snapshot = owner.resources.snapshot()["network"]
        with owner.observation_lock:
            owner.calls.append((self, identifier, workers, dict(item), snapshot["used"]))
            owner.preexisting.append((identifier, Path(filename).read_bytes() if Path(filename).is_file() else None,
                                      Path(filename + ".part").read_bytes() if Path(filename + ".part").is_file() else None))
            owner.timeline.append("dl:" + identifier)
        if owner.barrier is not None and identifier == "video":
            owner.barrier.wait(timeout=10)
        if identifier == owner.fail_on:
            Path(filename + ".part").write_bytes(b"owned partial")
            raise RuntimeError("Source https://private.invalid/?token=" + SECRET)
        if identifier == owner.cancel_on:
            owner.cancel.set()
        if identifier == owner.incomplete_on:
            return False, False
        # yt-dlp trusts a pre-existing final filename. The migration tests must
        # detect an old native final being incorrectly retained before dl().
        payload = Path(filename).read_bytes() if Path(filename).is_file() else VIDEO_BYTES if identifier == "video" else AUDIO_BYTES
        Path(filename).write_bytes(payload)
        for hook in self.params["progress_hooks"]:
            hook({"status": "finished", "downloaded_bytes": len(payload),
                  "total_bytes": len(payload), "speed": 4096, "eta": 0})
        return True, True


class _OfflineEngine(engine.Engine):
    def __init__(self, root, log):
        super().__init__(APP_ROOT, root / "data", resources=engine.ResourceBudget({"network": 4}), activity=log)
        self.folder = root / "downloads"
        self.folder.mkdir()
        self.info = _information()
        self.sessions = []
        self.calls = []
        self.preexisting = []
        self.timeline = []
        self.commands = []
        self.observation_lock = threading.Lock()
        self.cancel = threading.Event()
        self.fail_on = self.cancel_on = self.incomplete_on = None
        self.barrier = None

    def _dependencies(self, youtube, cancel):
        engine._check_cancel(cancel)
        module = types.SimpleNamespace(YoutubeDL=lambda options: _FakeYDL(self, options))
        return module, Path("deno.exe"), Path("ffmpeg.exe"), Path("ffprobe.exe")

    def _extract_isolated(self, *_):
        return copy.deepcopy(self.info)

    def _run(self, arguments, cancel, **_):
        engine._check_cancel(cancel)
        self.commands.append(arguments)
        if arguments[0] == "ffprobe.exe":
            self.timeline.append("probe:" + Path(arguments[-1]).name)
            return json.dumps({"streams": [{"codec_type": "video"}, {"codec_type": "audio"}]}).encode()
        if arguments[0] == "ffmpeg.exe":
            self.timeline.append("process")
            inputs = [Path(arguments[index + 1]) for index, value in enumerate(arguments) if value == "-i"]
            Path(arguments[-1]).write_bytes(b"".join(path.read_bytes() for path in inputs))
            return b""
        raise AssertionError("Unexpected process")

    def _publish(self, *arguments):
        self.timeline.append("publish")
        return super()._publish(*arguments)


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="v18-restore-")))
        self.enterContext(mock.patch.object(socket, "socket", side_effect=AssertionError("Default suite is offline")))
        self.enterContext(mock.patch.object(socket, "create_connection", side_effect=AssertionError("Default suite is offline")))
        self.enterContext(mock.patch.object(subprocess, "Popen", side_effect=AssertionError("Default suite uses controlled processes")))
        self.log = activity.ActivityLog(self.root / "data", version="1.19.4")
        self.addCleanup(self.log.close)
        self.subject = _OfflineEngine(self.root, self.log)

    def run_download(self, **changes):
        progress = []
        request = engine.DownloadRequest(changes.pop("url", YOUTUBE), self.subject.folder, **changes)
        result = self.subject.download(request, progress.append, self.subject.cancel)
        return result, progress

    def assert_released(self):
        self.assertTrue(all(value["used"] == value["waiting"] == 0 for value in self.subject.resources.snapshot().values()))
        self.assertFalse(self.subject._active)
        self.assertTrue(all(session.closed for session in self.subject.sessions))

    def test_engine_has_no_native_transport_or_bandwidth_routing(self):
        tree = ast.parse((DESKTOP_DIR / "engine.py").read_text(encoding="utf-8"))
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                imports.append(node.module or "")
            elif isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
        forbidden = {"transport", "transfer", "bandwidth", "curl_cffi"}
        self.assertFalse({name.rsplit(".", 1)[-1] for name in imports} & forbidden)
        names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
        self.assertFalse(names & {"NativeTransport", "download_file", "PROCESS_BANDWIDTH"})
        self.assertFalse(hasattr(self.subject, "bandwidth"))
        self.assertFalse(hasattr(self.subject, "_parallel_downloads"))

    def test_video_audio_complete_once_in_order_and_keep_output_bytes(self):
        result, progress = self.run_download()
        self.assertEqual([call[1] for call in self.subject.calls], ["video", "audio"])
        self.assertEqual(self.subject.timeline, ["dl:video", "probe:source-0.mp4", "dl:audio",
                                               "probe:source-1.m4a", "process", "probe:finished.mp4", "publish"])
        self.assertEqual(Path(result.filepath).read_bytes(), VIDEO_BYTES + AUDIO_BYTES)
        self.assertEqual(self.subject.store.get(result.job_id)["stage"], "complete")
        self.assertEqual(progress[-1].stage, "complete")
        self.assertEqual(progress[-1].downloaded, len(VIDEO_BYTES) + len(AUDIO_BYTES))
        self.assertEqual(progress[-1].percent, 100)
        self.assertFalse(any(self.subject.folder.glob(".myvideoapp-*.tmp")))
        for _, _, workers, item, used in self.subject.calls:
            self.assertEqual(workers, 1)
            self.assertEqual(used, workers)
            self.assertNotIn("__postprocessors", item)
        command = next(command for command in self.subject.commands if command[0] == "ffmpeg.exe")
        self.assertEqual(command[command.index("-c") + 1], "copy")
        self.assertIn("file,pipe", command)
        self.assert_released()

    def test_direct_http_media_uses_same_yt_dlp_path_without_fallback(self):
        result, _ = self.run_download(url="http://media.invalid/source.mp4")
        self.assertEqual([call[1] for call in self.subject.calls], ["video", "audio"])
        self.assertEqual(len(self.subject.sessions), 1)
        self.assertEqual(Path(result.filepath).read_bytes(), VIDEO_BYTES + AUDIO_BYTES)
        self.assertNotIn("transfer.fallback", [row["event"] for row in self.log.recent()])
        self.assert_released()

    def test_job_reuses_session_and_resets_fragment_limit_for_each_track(self):
        self.subject.info = _information(fragments=True)
        self.subject.save_settings({"concurrent_downloads": 2})
        self.run_download()
        self.assertEqual(len(self.subject.sessions), 1)
        self.assertIs(self.subject.calls[0][0], self.subject.calls[1][0])
        self.assertEqual([call[2] for call in self.subject.calls], [4, 1])
        self.assertEqual([call[4] for call in self.subject.calls], [4, 1])
        self.assert_released()

    def test_simultaneous_jobs_have_separate_sessions_and_progress_hooks(self):
        self.subject.barrier = threading.Barrier(2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: self.run_download(), range(2)))
        self.assertEqual(len(self.subject.sessions), 2)
        first, second = self.subject.sessions
        self.assertIsNot(first.params, second.params)
        self.assertIsNot(first.params["progress_hooks"][0], second.params["progress_hooks"][0])
        for session in self.subject.sessions:
            self.assertEqual([call[1] for call in self.subject.calls if call[0] is session], ["video", "audio"])
        self.assertEqual(len({result.job_id for result, _ in outcomes}), 2)
        self.assertEqual(len({result.filepath for result, _ in outcomes}), 2)
        for result, events in outcomes:
            self.assertEqual(Path(result.filepath).read_bytes(), VIDEO_BYTES + AUDIO_BYTES)
            self.assertEqual(events[-1].downloaded, len(VIDEO_BYTES) + len(AUDIO_BYTES))
        self.assert_released()

    def test_existing_preferences_and_finished_history_survive_migration(self):
        original = {"download_folder": str(self.subject.folder), "folder_confirmed": True, "theme": "dark",
                    "quality": "720", "output": "mp4", "scan_after_download": True,
                    "concurrent_downloads": 3, "host_concurrent_downloads": 2}
        self.subject.store.save_settings(original)
        result, _ = self.run_download()
        history = self.subject.store.get(result.job_id)
        with self.subject.store.connect() as database:
            database.executemany("INSERT INTO preferences(key,value) VALUES (?,?)",
                                 [(key, json.dumps(value)) for key, value in
                                  {"http3_enabled": True, "parallel_downloads": False,
                                   "speed_limit_enabled": True, "speed_limit_kib": 64}.items()])
        for _ in range(2):
            reopened = storage.Storage(self.root / "data")
            self.assertEqual(reopened.settings(), original)
            self.assertEqual(reopened.get(result.job_id), history)
            reopened.save_settings({key: True for key in REMOVED_PREFERENCES})
            with reopened.connect() as database:
                keys = {row[0] for row in database.execute("SELECT key FROM preferences")}
            self.assertFalse(keys & REMOVED_PREFERENCES)

    def test_old_native_final_is_discarded_once_without_losing_standard_partial(self):
        self.subject.fail_on = "audio"
        with self.assertRaises(engine.EngineError):
            self.run_download()
        job_id = self.subject.history()[0]["job_id"]
        directory = self.subject.folder / (".myvideoapp-" + job_id + ".tmp")
        selection = directory / "selection.json"
        fingerprint = selection.read_text(encoding="ascii").removeprefix("yt-dlp-v18:")
        selection.write_text(fingerprint, encoding="ascii")
        # Old native downloads could preallocate this final path before all
        # ranges finished. Its name and size do not prove completion.
        with (directory / "source-0.mp4").open("wb") as source:
            source.write(VIDEO_BYTES[:20])
            source.truncate(1024 * 1024)
        self.subject.fail_on = None
        self.subject.preexisting.clear()
        result, _ = self.run_download(job_id=job_id)
        self.assertEqual(self.subject.preexisting[0], ("video", None, None))
        self.assertEqual(self.subject.preexisting[1], ("audio", None, b"owned partial"))
        self.assertEqual(Path(result.filepath).read_bytes(), VIDEO_BYTES + AUDIO_BYTES)
        self.assertEqual(result.job_id, job_id)
        self.assert_released()

    def test_new_v18_selection_retry_retains_completed_final_and_standard_partial(self):
        self.subject.fail_on = "audio"
        with self.assertRaises(engine.EngineError):
            self.run_download()
        job_id = self.subject.history()[0]["job_id"]
        directory = self.subject.folder / (".myvideoapp-" + job_id + ".tmp")
        self.assertTrue((directory / "selection.json").read_text(encoding="ascii").startswith("yt-dlp-v18:"))
        self.subject.fail_on = None
        self.subject.preexisting.clear()
        result, _ = self.run_download(job_id=job_id)
        self.assertEqual(self.subject.preexisting, [("video", VIDEO_BYTES, None), ("audio", None, b"owned partial")])
        self.assertEqual(Path(result.filepath).read_bytes(), VIDEO_BYTES + AUDIO_BYTES)
        self.assertEqual(self.subject.store.get(job_id)["stage"], "complete")
        self.assert_released()

    def test_success_activity_has_all_phases_and_safe_operational_details(self):
        result, _ = self.run_download()
        rows = [row for row in self.log.recent() if row["job_id"] == result.job_id]
        events = [row["event"] for row in rows]
        for phase in ("preparation", "extraction", "track", "probe", "processing", "publish"):
            self.assertEqual(events.count(phase + ".begin"), events.count(phase + ".end"))
            self.assertGreater(events.count(phase + ".begin"), 0)
        self.assertEqual(events.count("track.end"), 2)
        self.assertEqual(events.count("probe.end"), 3)
        self.assertEqual(events.count("download.completed"), 1)
        self.assertEqual(events[-1], "download.finished")
        self.assertEqual(rows[-1]["detail"]["outcome"], "success")
        complete = next(row for row in rows if row["event"] == "download.completed")
        self.assertEqual(complete["detail"]["downloaded"], len(VIDEO_BYTES) + len(AUDIO_BYTES))
        self.assertTrue(complete["detail"]["published"])
        serialized = self.log.path.read_text(encoding="utf-8")
        for private in (SECRET, YOUTUBE, str(self.root), "Owned fixture"):
            self.assertNotIn(private, serialized)

    def test_audio_failure_does_not_publish_and_preserves_error_logging(self):
        self.subject.fail_on = "audio"
        with self.assertRaises(engine.EngineError) as caught:
            self.run_download()
        self.assertNotIn(SECRET, str(caught.exception))
        history = self.subject.history()[0]
        self.assertEqual(history["stage"], "error")
        self.assertIsNone(history["filepath"])
        self.assertNotIn("publish", self.subject.timeline)
        failed = [row for row in self.log.recent() if row["event"] == "download.failed"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["detail"]["error_type"], "RuntimeError")
        self.assertEqual(failed[0]["stage"], "downloading")
        self.assertEqual(self.log.recent()[-1]["detail"]["outcome"], "failed")
        self.assertNotIn(SECRET, self.log.path.read_text(encoding="utf-8"))
        self.assert_released()

    def test_cancel_during_audio_cleans_owned_files_and_logs_cancelled(self):
        self.subject.cancel_on = "audio"
        with self.assertRaises(engine.DownloadCancelled):
            self.run_download()
        self.assertEqual(self.subject.history()[0]["stage"], "cancelled")
        self.assertFalse(list(self.subject.folder.iterdir()))
        events = [row["event"] for row in self.log.recent()]
        self.assertIn("download.cancelled", events)
        self.assertNotIn("download.failed", events)
        self.assertEqual(self.log.recent()[-1]["detail"]["outcome"], "cancelled")
        self.assert_released()

    def test_incomplete_track_cannot_reach_merge_or_publication(self):
        self.subject.incomplete_on = "audio"
        with self.assertRaises(engine.EngineError):
            self.run_download()
        self.assertNotIn("process", self.subject.timeline)
        self.assertNotIn("publish", self.subject.timeline)
        self.assertEqual(self.subject.history()[0]["stage"], "error")
        self.assert_released()

    def test_options_keep_v18_retries_and_cancellable_keyword_callback(self):
        options = self.subject._options(Path("deno.exe"), cancel=self.subject.cancel)
        for name, expected in (("retries", 3), ("fragment_retries", 3), ("extractor_retries", 2),
                               ("continuedl", True), ("nopart", False), ("overwrites", False),
                               ("skip_unavailable_fragments", False), ("concurrent_fragment_downloads", 1)):
            self.assertEqual(options[name], expected)
        self.assertFalse(options.get("nocheckcertificate", False))
        self.assertNotIn("proxy", options)
        self.assertIsNone(options["cookiefile"])
        self.assertIsNone(options["cookiesfrombrowser"])
        for callback in options["retry_sleep_functions"].values():
            self.assertEqual(callback(n=0), 0)
        self.assertEqual([row["detail"]["attempt"] for row in self.log.recent()
                          if row["event"] == "download.retry"], [1, 1, 1])
        self.subject.cancel.set()
        with self.assertRaises(engine.DownloadCancelled):
            options["retry_sleep_functions"]["http"](n=1)
        worker = object.__new__(engine.Engine)
        worker.app_root = APP_ROOT
        self.assertEqual(worker._options(Path("deno.exe"))["retry_sleep_functions"]["http"](n=0), 0)


class _FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, files):
        self.files = files
        self.requests = []
        self.request_lock = threading.Lock()
        super().__init__(("127.0.0.1", 0), _FixtureHandler)


class _FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self._respond(False)

    def do_GET(self):
        self._respond(True)

    def _respond(self, body):
        path = urlsplit(self.path).path
        payload = self.server.files.get(path)
        if payload is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        start, end = 0, len(payload) - 1
        status = 200
        requested_range = self.headers.get("Range")
        if requested_range:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested_range)
            if match and any(match.groups()):
                if match[1]:
                    start = int(match[1])
                    end = min(end, int(match[2])) if match[2] else end
                else:
                    start = max(0, len(payload) - int(match[2]))
                status = 206
            if not match or not any(match.groups()) or start > end or start >= len(payload):
                self.send_response(416)
                self.send_header("Content-Range", "bytes */" + str(len(payload)))
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        with self.server.request_lock:
            self.server.requests.append((self.command, path, requested_range, status))
        self.send_response(status)
        self.send_header("Content-Type", "audio/mp4" if path.endswith(".m4a") else "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(payload)}")
        self.end_headers()
        if body:
            self.wfile.write(payload[start:end + 1])


def _real_prerequisites():
    candidates = [APP_ROOT / "runtime" / "python" / "Lib" / "site-packages"]
    if os.name != "nt":
        candidates.append(APP_ROOT / ".cache" / "desktop-download-dev")
    package_root = next((path for path in candidates if (path / "yt_dlp" / "__init__.py").is_file()), None)
    if package_root is None:
        raise AssertionError("--real-download requires the packaged pinned yt-dlp; Linux may extract its wheels into .cache/desktop-download-dev")
    sys.path.insert(0, str(package_root))
    importlib.invalidate_caches()
    module = importlib.import_module("yt_dlp")
    if not Path(module.__file__).resolve().is_relative_to(package_root.resolve()):
        raise AssertionError("Real test imported yt-dlp outside the selected runtime")
    for name, expected in (("yt-dlp", engine.YT_DLP_VERSION), ("yt-dlp-ejs", engine.EJS_VERSION)):
        if importlib.metadata.version(name) != expected:
            raise AssertionError("Real test dependency pin mismatch: " + name)
    if os.name == "nt":
        binaries = tuple(APP_ROOT / "runtime" / "ffmpeg" / name for name in ("ffmpeg.exe", "ffprobe.exe"))
    else:
        binaries = tuple(Path(shutil.which(name) or "/missing/" + name) for name in ("ffmpeg", "ffprobe"))
    if not all(path.is_file() for path in binaries):
        raise AssertionError("--real-download requires actual ffmpeg and ffprobe")
    fixtures = [APP_ROOT / "tests" / "fixtures" / "desktop-source.mp4",
                Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "desktop-source.mp4"]
    fixture = next((path for path in fixtures if path.is_file()), None)
    if fixture is None:
        raise AssertionError("Owned tests/fixtures/desktop-source.mp4 is required")
    return module, *binaries, fixture


class _RealEngine(engine.Engine):
    def __init__(self, root, log, module, ffmpeg, ffprobe, info):
        super().__init__(APP_ROOT, root / "data", resources=engine.ResourceBudget(), activity=log)
        self.real_module, self.ffmpeg, self.ffprobe = module, ffmpeg, ffprobe
        self.info = info
        self.sessions = []
        self.calls = []
        self.probes = []
        self.commands = []

    def _dependencies(self, youtube, cancel):
        if os.name == "nt":
            module, deno, ffmpeg, ffprobe = super()._dependencies(youtube, cancel)
        else:
            module, deno, ffmpeg, ffprobe = self.real_module, Path("deno.exe"), self.ffmpeg, self.ffprobe
        owner = self

        class ActualYDL:
            def __init__(self, options):
                self.inner = module.YoutubeDL(options)
                self.params = self.inner.params
                owner.sessions.append(self)

            def __enter__(self):
                self.inner.__enter__()
                return self

            def __exit__(self, *arguments):
                return self.inner.__exit__(*arguments)

            def dl(self, filename, information):
                owner.calls.append((self, information["format_id"], self.params["concurrent_fragment_downloads"]))
                return self.inner.dl(filename, information)

        return types.SimpleNamespace(YoutubeDL=ActualYDL), deno, ffmpeg, ffprobe

    def _extract_isolated(self, *_):
        return copy.deepcopy(self.info)

    def _run(self, arguments, cancel, **options):
        self.commands.append(arguments)
        return super()._run(arguments, cancel, **options)

    def _probe(self, path, ffprobe, cancel):
        self.probes.append((path.name, hashlib.sha256(path.read_bytes()).hexdigest()))
        return super()._probe(path, ffprobe, cancel)


class _RealDownloadChecks(unittest.TestCase):
    def test_owned_loopback_uses_actual_yt_dlp_ffmpeg_and_preserves_streams(self):
        module, ffmpeg, ffprobe, fixture = _real_prerequisites()
        with tempfile.TemporaryDirectory(prefix="v18-real-download-") as directory:
            root = Path(directory)
            video, audio = root / "video.mp4", root / "audio.m4a"

            def command(arguments):
                return subprocess.run([str(value) for value in arguments], check=True, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, timeout=30).stdout

            for mapping, destination in (("0:v:0", video), ("0:a:0", audio)):
                command([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-i", fixture,
                         "-map", mapping, "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1", destination])
            files = {"/video.mp4": video.read_bytes(), "/audio.m4a": audio.read_bytes()}
            server = _FixtureServer(files)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(lambda: thread.join(timeout=5))
            self.addCleanup(server.shutdown)
            base = "http://127.0.0.1:" + str(server.server_address[1])
            info = _information(base, sizes=(len(files["/video.mp4"]), len(files["/audio.m4a"])))
            for track in info["formats"]:
                track["protocol"] = "http"
            log = activity.ActivityLog(root / "data", version="1.19.4")
            self.addCleanup(log.close)
            subject = _RealEngine(root, log, module, ffmpeg, ffprobe, info)
            folder = root / "downloads"
            folder.mkdir()
            original_connect = socket.socket.connect
            original_connect_ex = socket.socket.connect_ex
            original_getaddrinfo = socket.getaddrinfo

            def only_fixture_connect(connection, address):
                if not isinstance(address, tuple) or address[:2] != server.server_address:
                    raise AssertionError("Real download must connect only to its owned loopback fixture")
                return original_connect(connection, address)

            def only_fixture_connect_ex(connection, address):
                if not isinstance(address, tuple) or address[:2] != server.server_address:
                    raise AssertionError("Real download must connect only to its owned loopback fixture")
                return original_connect_ex(connection, address)

            def only_loopback_resolution(host, *arguments, **keywords):
                if host != "localhost" and not ipaddress.ip_address(host).is_loopback:
                    raise AssertionError("Real download must resolve only loopback")
                return original_getaddrinfo(host, *arguments, **keywords)

            outputs = []
            # Bypass proxies only for loopback during this fixture. Production
            # options, proxy variables and TLS verification remain unchanged.
            with mock.patch.dict(os.environ, {"NO_PROXY": "127.0.0.1,localhost,::1", "no_proxy": "127.0.0.1,localhost,::1"}), \
                 mock.patch.object(socket.socket, "connect", only_fixture_connect), \
                 mock.patch.object(socket.socket, "connect_ex", only_fixture_connect_ex), \
                 mock.patch.object(socket, "getaddrinfo", only_loopback_resolution):
                for _ in range(2):
                    progress = []
                    result = subject.download(engine.DownloadRequest(base + "/source.mp4", folder),
                                              progress.append, threading.Event())
                    outputs.append(Path(result.filepath))
                    self.assertEqual(progress[-1].stage, "complete")
                    self.assertEqual(progress[-1].downloaded, sum(map(len, files.values())))
                    self.assertEqual(subject.store.get(result.job_id)["stage"], "complete")

            def codecs(path):
                metadata = json.loads(command([ffprobe, "-v", "error", "-show_entries", "stream=codec_type,codec_name",
                                               "-of", "json", path]))
                return [(stream["codec_type"], stream["codec_name"]) for stream in metadata["streams"]]

            def stream_hashes(path):
                output = command([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", path,
                                  "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-f", "streamhash",
                                  "-hash", "sha256", "-"]).decode("ascii")
                return [line.strip() for line in output.splitlines() if line.strip()]

            self.assertEqual(codecs(fixture), [("video", "h264"), ("audio", "aac")])
            expected_hashes = stream_hashes(fixture)
            self.assertEqual(len(expected_hashes), 2)
            for output in outputs:
                self.assertEqual(codecs(output), codecs(fixture))
                self.assertEqual(stream_hashes(output), expected_hashes)
            self.assertEqual(outputs[0].read_bytes(), outputs[1].read_bytes())
            self.assertEqual(len(subject.sessions), 2)
            self.assertEqual([call[1:] for call in subject.calls], [("video", 1), ("audio", 1)] * 2)
            self.assertIs(subject.calls[0][0], subject.calls[1][0])
            self.assertIsNot(subject.calls[0][0], subject.calls[2][0])
            for index in (0, 3):
                self.assertEqual(subject.probes[index], ("source-0.mp4", hashlib.sha256(files["/video.mp4"]).hexdigest()))
                self.assertEqual(subject.probes[index + 1], ("source-1.m4a", hashlib.sha256(files["/audio.m4a"]).hexdigest()))
                self.assertEqual(subject.probes[index + 2][1], hashlib.sha256(outputs[index // 3].read_bytes()).hexdigest())
            self.assertEqual(len(subject.probes), 6)
            gets = [request[1] for request in server.requests if request[0] == "GET"]
            self.assertEqual(gets, ["/video.mp4", "/audio.m4a"] * 2)
            self.assertFalse(any(folder.glob(".myvideoapp-*.tmp")))
            self.assertTrue(all(value["used"] == 0 for value in subject.resources.snapshot().values()))
            events = [row["event"] for row in log.recent()]
            self.assertEqual(events.count("download.completed"), 2)
            self.assertNotIn("download.failed", events)
            self.assertNotIn(SECRET, log.path.read_text(encoding="utf-8"))


def load_tests(loader, _tests, pattern):
    suite = loader.loadTestsFromTestCase(RestoreTests)
    if _arguments.real_download:
        suite.addTests(loader.loadTestsFromTestCase(_RealDownloadChecks))
    return suite


class _NoSkipResult(unittest.TextTestResult):
    def addSkip(self, test, reason):
        self.addFailure(test, (AssertionError, AssertionError("Validation must not skip: " + reason), None))


class _NoSkipRunner(unittest.TextTestRunner):
    resultclass = _NoSkipResult


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *_unittest_arguments], testRunner=_NoSkipRunner)
