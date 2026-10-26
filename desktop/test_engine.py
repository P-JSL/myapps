"""Offline engine contract and lifecycle tests; no live YouTube or credentials."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

# Supports the bundled interpreter's isolated mode when this file is run directly.
if str(Path(__file__).absolute().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).absolute().parent))

try:
    from . import engine as subject
    from .storage import Storage
except ImportError:
    import engine as subject
    from storage import Storage


VIDEO_ID = "abcdefghijk"
YOUTUBE = "https://www.youtube.com/watch?v=" + VIDEO_ID
MEDIA = b"\0\0\0\x18ftypisom" + b"\0" * 100


def track(identifier="video", *, ext="mp4", height=1080, video="avc1.640028", audio="mp4a.40.2", size=112):
    return {"format_id": identifier, "url": "https://media.example.test/video?sig=PRIVATE_SOURCE",
            "ext": ext, "height": height, "vcodec": video, "acodec": audio,
            "filesize": size, "tbr": height, "abr": 128, "protocol": "https"}


class FakeDownloader:
    def __init__(self, owner, options):
        self.owner = owner
        self.options = options
        owner.seen_options.append(options)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def dl(self, filename, info):
        path = Path(filename)
        partial = Path(filename + ".part")
        self.owner.resumed.append(partial.exists())
        if self.owner.fail_once:
            self.owner.fail_once = False
            partial.write_bytes(b"partial bytes")
            raise RuntimeError("Signed source https://private.example/media?api_key=NEVER_LOG_THIS")
        path.write_bytes(self.owner.media)
        for hook in self.options["progress_hooks"]:
            hook({"status": "downloading", "downloaded_bytes": len(self.owner.media),
                  "total_bytes": len(self.owner.media), "speed": 1000, "eta": 0})
        partial.unlink(missing_ok=True)
        return True, True


class Harness(subject.Engine):
    def __init__(self, root):
        super().__init__(root / "app", root / "data")
        self.info = {"id": VIDEO_ID, "title": "Example video", "duration": 10, "formats": [track()]}
        self.media = MEDIA
        self.seen_options = []
        self.commands = []
        self.resumed = []
        self.fail_once = False
        self.extract_calls = 0
        self.folder = root / "downloads"
        self.folder.mkdir()

    def _dependencies(self, youtube, cancel):
        return SimpleNamespace(YoutubeDL=lambda options: FakeDownloader(self, options)), Path("deno.exe"), Path("ffmpeg.exe"), Path("ffprobe.exe")

    def _extract_isolated(self, url, youtube, quality, output, cancel):
        self.extract_calls += 1
        result = copy.deepcopy(self.info)
        for item in result["formats"]:
            item["url"] += f"&fresh={self.extract_calls}"
        return result

    def _run(self, arguments, cancel, **_):
        self.commands.append(arguments)
        subject._check_cancel(cancel)
        if arguments[0] == "ffprobe.exe":
            return json.dumps({"streams": [{"codec_type": "video"}, {"codec_type": "audio"}]}).encode()
        if arguments[0] == "ffmpeg.exe":
            Path(arguments[-1]).write_bytes(MEDIA)
        return b""


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-engine-")
        self.root = Path(self.temporary.name)
        self.engine = Harness(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def download(self, **values):
        progress = []
        request = subject.DownloadRequest(values.pop("url", YOUTUBE), self.engine.folder, **values)
        result = self.engine.download(request, progress.append, threading.Event())
        return result, progress

    def test_caller_selected_new_job_id_completes_actual_engine_lifecycle(self):
        selected = uuid.uuid4().hex
        result, events = self.download(job_id=selected)
        self.assertEqual(result.job_id, selected)
        self.assertEqual(self.engine.history()[0]["job_id"], selected)
        self.assertTrue(Path(result.filepath).is_file())
        self.assertEqual([event.stage for event in events], ["queued", "downloading", "downloading", "processing", "complete"])
        self.assertEqual(self.engine.history()[0]["stage"], "complete")
        self.assertFalse(list(self.engine.folder.glob(".myvideoapp-*")))
        self.assertIn("copy", self.engine.commands[-2])

    def test_output_publication_preserves_existing_files_and_uses_actual_extension(self):
        existing = self.engine.folder / "Example video.mp4"
        existing.write_bytes(b"do not overwrite")
        result, _events = self.download()
        self.assertEqual(Path(result.filepath).name, "Example video (2).mp4")
        self.assertEqual(existing.read_bytes(), b"do not overwrite")
        self.assertEqual(self.engine.history()[0]["filepath"], result.filepath)

    def test_titles_are_safe_for_windows_and_unicode_filesystems(self):
        for name in ("CON", "AUX.mp4", "COM1", "LPT9.txt", 'a/b\\c:*?"|<>', "movie.exe", "가" * 200):
            result = subject.safe_filename(name)
            self.assertLessEqual(len(result.encode("utf-8")), 220)
            self.assertNotRegex(result, r'[<>:"/\\|?*]')
            self.assertNotRegex(result.lower(), r"^(con|aux|com1|lpt9)(?:\.|$)")
        self.assertEqual(subject.safe_filename("movie.exe"), "movie_exe")

    def test_signed_direct_urls_and_extractor_errors_are_not_persisted(self):
        self.engine.fail_once = True
        request = subject.DownloadRequest("https://media.example/movie.mp4?api_key=NEVER_LOG_THIS", self.engine.folder)
        events = []
        with self.assertRaises(subject.EngineError) as raised:
            self.engine.download(request, events.append, threading.Event())
        serialized = json.dumps(self.engine.history()) + str(raised.exception) + repr(events)
        self.assertNotIn("NEVER_LOG_THIS", serialized)
        self.assertNotIn("PRIVATE_SOURCE", serialized)
        self.assertEqual(self.engine.history()[0]["url"], "https://media.example/movie.mp4")
        other = subject.Engine(self.root / "app", self.root / "data")
        with self.assertRaises(subject.EngineError):
            other.retry_request(self.engine.history()[0]["job_id"])

    def test_retry_resolves_fresh_source_and_resumes_matching_youtube_partial(self):
        self.engine.fail_once = True
        request = subject.DownloadRequest(YOUTUBE, self.engine.folder)
        with self.assertRaises(subject.EngineError):
            self.engine.download(request, lambda _: None, threading.Event())
        job = self.engine.history()[0]
        retry = self.engine.retry_request(job["job_id"])
        result = self.engine.download(retry, lambda _: None, threading.Event())
        self.assertEqual(result.job_id, job["job_id"])
        self.assertEqual(self.engine.extract_calls, 2)
        self.assertEqual(self.engine.resumed, [False, True])

    def test_retry_discards_partial_when_format_identity_changes(self):
        self.engine.fail_once = True
        with self.assertRaises(subject.EngineError):
            self.download()
        job = self.engine.history()[0]
        self.engine.info["formats"][0]["format_id"] = "different-format"
        self.engine.download(self.engine.retry_request(job["job_id"]), lambda _: None, threading.Event())
        self.assertEqual(self.engine.resumed, [False, False])

    def test_direct_retry_restarts_instead_of_resuming_unverified_resource(self):
        self.engine.fail_once = True
        with self.assertRaises(subject.EngineError):
            self.download(url="https://media.example/movie.mp4?signature=secret")
        job = self.engine.history()[0]
        self.engine.download(self.engine.retry_request(job["job_id"]), lambda _: None, threading.Event())
        self.assertEqual(self.engine.resumed, [False, False])

    def test_cancel_removes_only_owned_temporary_files(self):
        cancel = threading.Event()
        keep = self.engine.folder / "user-file.mp4.part"
        keep.write_text("keep")
        def callback(event):
            if event.stage == "downloading" and event.downloaded:
                cancel.set()
        with self.assertRaises(subject.DownloadCancelled):
            self.engine.download(subject.DownloadRequest(YOUTUBE, self.engine.folder), callback, cancel)
        self.assertEqual(self.engine.history()[0]["stage"], "cancelled")
        self.assertEqual(keep.read_text(), "keep")
        self.assertFalse(list(self.engine.folder.glob(".myvideoapp-*")))

    def test_rejected_html_masquerading_as_mp4_never_publishes(self):
        self.engine.media = b"<!doctype html><html>server error</html>"
        with self.assertRaises(subject.EngineError):
            self.download()
        self.assertFalse(list(self.engine.folder.glob("*.mp4")))
        self.assertEqual(self.engine.history()[0]["stage"], "error")

    def test_options_disable_auth_configuration_plugins_and_remote_components(self):
        self.download()
        options = self.engine.seen_options[-1]
        for key in ("cookiefile", "cookiesfrombrowser", "username", "password", "netrc_location"):
            self.assertIsNone(options[key])
        self.assertTrue(options["noplaylist"])
        self.assertTrue(options["ignoreconfig"])
        self.assertFalse(options["remote_components"])
        self.assertFalse(options["plugin_dirs"])
        self.assertEqual(options["concurrent_fragment_downloads"], 4)
        self.assertFalse(options["overwrites"])

    def test_audio_conversion_has_expected_codec_and_no_video(self):
        result, _ = self.download(output="mp3")
        command = next(command for command in self.engine.commands if command[0] == "ffmpeg.exe")
        self.assertIn("libmp3lame", command)
        self.assertIn("-vn", command)
        self.assertTrue(result.filepath.endswith(".mp3"))

    def test_get_info_returns_only_display_metadata(self):
        result = self.engine.get_info(subject.DownloadRequest(YOUTUBE, self.engine.folder))
        self.assertEqual(result["title"], "Example video")
        self.assertNotIn("PRIVATE_SOURCE", json.dumps(result))
        self.assertEqual(self.engine.history(), [])

    def test_cleanup_ignores_user_files_links_and_subdirectories_even_inside_job_folder(self):
        identifier = uuid.uuid4().hex
        directory = self.engine._owned_directory(self.engine.folder, identifier, "digest")
        (directory / "source-0.mp4.part").write_bytes(b"partial")
        (directory / "user.txt").write_text("preserve")
        (directory / "subfolder").mkdir()
        self.engine._clean_owned(directory, identifier, "digest", remove=True)
        self.assertFalse((directory / "source-0.mp4.part").exists())
        self.assertEqual((directory / "user.txt").read_text(), "preserve")
        self.assertTrue((directory / "subfolder").is_dir())

    def test_runtime_paths_reject_links_and_non_executables(self):
        runtime = self.root / "runtime"
        runtime.mkdir()
        executable = runtime / "deno.exe"
        executable.write_bytes(b"MZfixture")
        self.assertEqual(subject._trusted_file(executable, runtime, executable=True), executable)
        executable.write_bytes(b"not PE")
        with self.assertRaises(subject.EngineError):
            subject._trusted_file(executable, runtime, executable=True)
        executable.unlink()
        executable.symlink_to(self.root / "other.exe")
        with self.assertRaises(subject.EngineError):
            subject._trusted_file(executable, runtime, executable=True)


class InputAndSelectionTests(unittest.TestCase):
    def test_single_youtube_variants_canonicalize_without_tracking(self):
        for value in (YOUTUBE + "&t=10&si=tracking", "https://youtu.be/" + VIDEO_ID + "?si=tracking",
                      "https://m.youtube.com/shorts/" + VIDEO_ID, "https://www.youtube.com/embed/" + VIDEO_ID):
            self.assertEqual(subject.canonical_url(value), (YOUTUBE, True))

    def test_unsafe_or_non_single_youtube_urls_reject(self):
        for value in (YOUTUBE + "&list=PLsomething", "https://www.youtube.com/playlist?list=PLx", "file:///tmp/file.mp4",
                      "https://user:password@media.example/file.mp4", "https://youtube.com/@channel", "http://youtube.com/watch?v=" + VIDEO_ID,
                      "https://media.example:bad/file.mp4", "https://media.example/file\n.mp4", "https://youtube.com/watch?v=short"):
            with self.subTest(value=value), self.assertRaises(subject.EngineError):
                subject.canonical_url(value)

    def test_highest_and_quality_limit_choose_coherent_audio_video_without_length_cap(self):
        info = {"duration": 12 * 60 * 60, "formats": [track("high", ext="webm", height=2160, video="vp9", audio="none"),
                track("low", height=720, audio="none"), track("aac", ext="m4a", height=None, video="none"),
                track("opus", ext="webm", height=None, video="none", audio="opus")]}
        tracks, container = subject.choose_tracks(info, "highest", "original")
        self.assertEqual(([item["format_id"] for item in tracks], container), (["high", "opus"], "webm"))
        tracks, container = subject.choose_tracks(info, "720", "original")
        self.assertEqual(([item["format_id"] for item in tracks], container), (["low", "aac"], "mp4"))

    def test_original_falls_back_to_mkv_for_incompatible_native_containers(self):
        info = {"formats": [track(audio="none"), track("opus", ext="webm", height=None, video="none", audio="opus")]}
        self.assertEqual(subject.choose_tracks(info, "highest", "original")[1], "mkv")
        with self.assertRaises(subject.EngineError):
            subject.choose_tracks(info, "highest", "mp4")

    def test_drm_and_non_http_formats_cannot_be_selected(self):
        drm = {**track(), "has_drm": True}
        unsafe = {**track(), "url": "file:///tmp/video.mp4"}
        for value in (drm, unsafe, {**track(), "cookies": "private"}):
            with self.assertRaises(subject.EngineError):
                subject.choose_tracks({"formats": [value]}, "highest", "original")

    def test_no_video_above_selected_ceiling_is_silently_downloaded(self):
        with self.assertRaises(subject.EngineError):
            subject.choose_tracks({"formats": [track(height=1080)]}, "480", "original")

    def test_live_playlist_and_login_required_results_rejected_before_transfer(self):
        inspector = object.__new__(subject.Engine)
        for extra in ({"is_live": True}, {"live_status": "is_upcoming"}, {"_type": "playlist"},
                      {"availability": "premium_only"}, {"age_limit": 18}, {"has_drm": True}):
            info = {"id": VIDEO_ID, "title": "Video", "formats": [track()], **extra}
            downloader = SimpleNamespace(extract_info=lambda *_, **__: info)
            with self.assertRaises(subject.EngineError):
                inspector._extract(downloader, YOUTUBE, True, threading.Event())


class StorageTests(unittest.TestCase):
    def test_first_run_initializes_database_wal_schema_and_validated_preferences(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Storage(Path(directory) / "new")
            with store.connect() as database:
                self.assertEqual(database.execute("PRAGMA user_version").fetchone()[0], 1)
                self.assertEqual(database.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            values = {"download_folder": directory, "folder_confirmed": True, "theme": "dark", "concurrent_downloads": 2,
                      "quality": "1080", "output": "mp4", "scan_after_download": True}
            store.save_settings(values)
            self.assertEqual(store.settings(), values)
            with self.assertRaises(ValueError):
                store.save_settings({"concurrent_downloads": 100})

    def test_terminal_history_retains_two_hundred_and_reopen_marks_interrupted_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Storage(Path(directory))
            for index in range(205):
                store.insert({"job_id": str(index), "url": YOUTUBE, "folder": directory, "quality": "highest",
                              "output": "original", "stage": "complete", "request_digest": "hash"})
            self.assertEqual(len(store.history()), 200)
            self.assertEqual(store.history()[0]["job_id"], "204")
            store.update("204", stage="processing")
            self.assertEqual(Storage(Path(directory)).get("204")["stage"], "error")


class SubprocessCancellationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-child-")
        self.root = Path(self.temporary.name)
        self.engine = subject.Engine(self.root, self.root / "data")

    def tearDown(self):
        self.temporary.cleanup()

    def test_cancel_terminates_a_real_processing_child_promptly(self):
        cancel = threading.Event()
        timer = threading.Timer(0.2, cancel.set)
        timer.start()
        started = time.monotonic()
        try:
            with self.assertRaises(subject.DownloadCancelled):
                self.engine._run([sys.executable, "-I", "-c", "import time; time.sleep(60)"], cancel)
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - started, 3)

    @unittest.skipIf(os.name == "nt", "POSIX child-tree observation; Windows uses a kill-on-close JobObject")
    def test_cancel_kills_extraction_worker_descendants(self):
        child_pid = self.root / "pid.txt"
        script = ("import pathlib,subprocess,sys,time; "
                  "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']); "
                  "pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)")
        cancel = threading.Event()
        def stop_when_started():
            deadline = time.monotonic() + 3
            while not child_pid.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            cancel.set()
        observer = threading.Thread(target=stop_when_started)
        observer.start()
        with self.assertRaises(subject.DownloadCancelled):
            self.engine._run([sys.executable, "-I", "-c", script, str(child_pid)], cancel)
        observer.join(3)
        self.assertTrue(child_pid.exists())
        pid = int(child_pid.read_text())
        state_path = Path(f"/proc/{pid}/stat")
        if state_path.exists():
            self.assertEqual(state_path.read_text().split()[2], "Z")

    def test_runtime_timeout_and_output_limit_do_not_expose_child_diagnostics(self):
        for arguments, keywords in (([sys.executable, "-c", "import time;time.sleep(60)"], {"timeout": 0.1}),
                                     ([sys.executable, "-c", "print('SECRET_SIGNED_URL'*10000)"], {"limit": 32})):
            with self.assertRaises(subject.EngineError) as raised:
                self.engine._run(arguments, threading.Event(), **keywords)
            self.assertNotIn("SECRET_SIGNED_URL", str(raised.exception))




if __name__ == "__main__":
    unittest.main()
