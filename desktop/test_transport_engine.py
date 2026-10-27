"""Focused offline checks for native transfers, settings and actual protocol UI.

Run: PYTHONPATH=.cache/desktop-gui-dev python desktop/test_transport_engine.py -v
Only network, extraction and executable boundaries are replaced. Engine routing,
owned temporary files, publication, SQLite, Qt cards and workers are real.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid


_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parent.parent)
_options, _test_arguments = _parser.parse_known_args()
APP_ROOT = _options.app_root.resolve(strict=True)
sys.path.insert(0, str(APP_ROOT / "desktop"))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import engine as subject
from concurrency import ResourceBudget
from storage import Storage

REAL_DOWNLOAD_FILE = subject.download_file


YOUTUBE = "https://www.youtube.com/watch?v=abcdefghijk"
DIRECT = "https://media.example.test/movie.mp4?signature=PRIVATE_VALUE"
MEDIA = b"\0\0\0\x18ftypisom" + b"\0" * 400


class LegacyDownloader:
    def __init__(self, owner, options):
        self.owner, self.options = owner, options

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def dl(self, filename, info):
        path = Path(filename)
        partial = Path(filename + ".part")
        self.owner.legacy_calls.append({"info": info, "options": self.options,
                                       "partial": partial.read_bytes() if partial.is_file() else None,
                                       "existing": path.read_bytes() if path.is_file() else None,
                                       "leases": self.owner.resources.snapshot()["network"]["used"]})
        if not path.exists():
            with path.open("xb") as output:
                output.write(MEDIA)
        partial.unlink(missing_ok=True)
        for callback in self.options["progress_hooks"]:
            callback({"downloaded_bytes": len(MEDIA), "total_bytes": len(MEDIA)})
        return True, True


class Harness(subject.Engine):
    def __init__(self, root, resources=None):
        super().__init__(APP_ROOT, root / "data", resources=resources or ResourceBudget())
        self.destination = root / "downloads"
        self.destination.mkdir()
        self.legacy_calls = []
        self.commands = []
        self.scans = []
        self.info = {"id": "abcdefghijk", "title": "Example video", "formats": [{
            "format_id": "combined", "url": DIRECT, "protocol": "https", "ext": "mp4",
            "vcodec": "avc1.640028", "acodec": "mp4a.40.2", "height": 1080,
            "filesize": len(MEDIA), "http_headers": {"Referer": "https://media.example.test/"}}]}

    def _dependencies(self, youtube, cancel):
        subject._check_cancel(cancel)
        return SimpleNamespace(YoutubeDL=lambda options: LegacyDownloader(self, options)), Path("deno.exe"), Path("ffmpeg.exe"), Path("ffprobe.exe")

    def _extract_isolated(self, *args):
        return copy.deepcopy(self.info)

    def _run(self, arguments, cancel, **_):
        subject._check_cancel(cancel)
        self.commands.append(arguments)
        if arguments[0] == "ffprobe.exe":
            return json.dumps({"streams": [{"codec_type": "video"}, {"codec_type": "audio"}]}).encode()
        if arguments[0] == "ffmpeg.exe":
            with Path(arguments[-1]).open("xb") as output:
                output.write(MEDIA)
        return b""

    def _scan(self, path, cancel):
        subject._check_cancel(cancel)
        self.scans.append(path)
        return "저장하고 검사를 마쳤습니다."


class NativeBoundary:
    def __init__(self, engine):
        self.engine = engine
        self.transports = []
        self.calls = []
        self.protocols = ["h2"]
        self.media = MEDIA
        self.failure = None
        self.before_progress = None

    def transport(self, **options):
        boundary = self

        class Transport:
            closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_):
                self.closed = True

        result = Transport()
        result.options = options
        boundary.transports.append(result)
        return result

    def download(self, url, path, *, transport, resources, cancel, **options):
        # Per-request leases belong inside the transfer, so a one-unit budget
        # remains usable even when the caller selected per-file parallel mode.
        if resources.snapshot()["network"]["used"]:
            raise AssertionError("The engine took an outer network lease.")
        self.calls.append({"url": url, "path": path, "options": options, "transport": transport})
        options["mode"]("parallel" if options["workers"] > 1 else "single")
        options["connections"](2 if options["workers"] > 1 else 1)
        with resources.hold("network", cancel, on_wait=options["on_wait"]):
            if self.failure:
                raise self.failure
            if self.before_progress:
                self.before_progress(options, cancel)
            options["protocol"](self.protocols[min(len(self.calls) - 1, len(self.protocols) - 1)])
            options["progress"](0, len(self.media))
            with path.open("xb") as output:
                output.write(self.media)
            options["progress"](len(self.media), len(self.media))
            if cancel.is_set():
                raise subject.TransferCancelled("fixture cancellation")
        return SimpleNamespace(size=len(self.media), prefix=self.media[:4096], mode="single", protocols=("h2",))


class NativeEngineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-native-engine-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.engine = Harness(self.root)
        self.boundary = NativeBoundary(self.engine)
        for name, value in (("NativeTransport", self.boundary.transport), ("download_file", self.boundary.download)):
            replacement = patch.object(subject, name, value)
            replacement.start()
            self.addCleanup(replacement.stop)

    def download(self, url=DIRECT, **options):
        events = []
        result = self.engine.download(subject.DownloadRequest(url, self.engine.destination, **options), events.append, threading.Event())
        return result, events

    def seed_legacy(self, *, complete=False, matching=True):
        identifier = uuid.uuid4().hex
        request = subject.DownloadRequest(YOUTUBE, self.engine.destination, job_id=identifier)
        _, _, folder, digest = self.engine._validate_request(request)
        directory = self.engine._owned_directory(folder, identifier, digest)
        tracks, _ = subject.choose_tracks(self.engine.info, request.quality, request.output)
        identity = [{key: track.get(key) for key in ("format_id", "ext", "filesize")} for track in tracks]
        fingerprint = hashlib.sha256(json.dumps([self.engine.info["id"], identity], sort_keys=True).encode()).hexdigest()
        (directory / "selection.json").write_text(fingerprint if matching else "different", encoding="ascii")
        (directory / ("source-0.mp4" if complete else "source-0.mp4.part")).write_bytes(MEDIA if complete else b"old partial")
        return request

    def test_direct_and_youtube_http_tracks_use_native_with_observed_protocol(self):
        for url in (DIRECT, YOUTUBE):
            with self.subTest(url=url):
                result, events = self.download(url)
                call = self.boundary.calls[-1]
                self.assertEqual(call["options"]["workers"], 4)
                self.assertEqual(call["options"]["headers"], self.engine.info["formats"][0]["http_headers"])
                self.assertEqual(self.boundary.transports[-1].options, {"http3_enabled": True, "max_connections": 4,
                                                                      "bandwidth_limiter": self.engine.bandwidth})
                self.assertTrue(self.boundary.transports[-1].closed)
                self.assertTrue(Path(result.filepath).is_file())
                self.assertIn("HTTP/2", result.message)
                self.assertNotIn("HTTP/3", result.message)
                native = [event for event in events if event.transport]
                self.assertEqual((native[0].downloaded, native[0].percent), (0, 0))
                self.assertTrue(any(event.connections == 2 and event.transfer_mode == "parallel" for event in native))
                self.assertNotIn("PRIVATE_VALUE", json.dumps(self.engine.history()))
        self.assertFalse(self.engine.legacy_calls)
        self.assertFalse(list(self.engine.destination.glob(".myvideoapp-*")))

    def test_disabled_settings_keep_native_single_request_and_disable_http3(self):
        self.engine.save_settings({"parallel_downloads": False, "http3_enabled": False})
        result, events = self.download()
        self.assertEqual(self.boundary.calls[0]["options"]["workers"], 1)
        self.assertFalse(self.boundary.transports[0].options["http3_enabled"])
        self.assertTrue(any(event.connections == 1 and event.transfer_mode == "single" for event in events))
        self.assertNotIn("병렬", result.message)

    def test_engine_runs_real_transfer_against_streaming_response_boundary(self):
        owner = self

        class Response:
            status = 200
            headers = {"content-length": str(len(MEDIA))}
            actual_protocol = "http/1.1"
            url = DIRECT

            def __init__(self):
                self.stream = io.BytesIO(MEDIA)

            def __enter__(self):
                return self

            def __exit__(self, *_):
                self.stream.close()

            def read(self, count):
                return self.stream.read(count)

        class StreamingTransport:
            def __init__(self, **options):
                self.options = options
                self.closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_):
                self.closed = True

            def open(self, url, **options):
                owner.assertEqual(owner.engine.resources.snapshot()["network"]["used"], 1)
                owner.assertEqual(options["headers"]["Accept-Encoding"], "identity")
                return Response()

        with patch.object(subject, "download_file", REAL_DOWNLOAD_FILE), patch.object(subject, "NativeTransport", StreamingTransport):
            result, events = self.download()
        self.assertEqual(Path(result.filepath).read_bytes(), MEDIA)
        self.assertIn("HTTP/1.1", result.message)
        self.assertTrue(any(event.transport == "http/1.1" and event.transfer_mode == "single" and event.connections == 1 for event in events))
        self.assertFalse(self.boundary.calls)

    def test_small_injected_budget_has_no_outer_native_network_lease(self):
        self.engine.resources = ResourceBudget({"network": 1})
        self.download()
        self.assertEqual(self.boundary.calls[0]["options"]["workers"], 1)
        self.assertTrue(all(value["used"] == 0 for value in self.engine.resources.snapshot().values()))

    def test_native_receives_shared_limiter_and_progress_is_not_charged_twice(self):
        charges = []
        limiter = SimpleNamespace(consume=lambda count, cancel: charges.append(count))
        self.engine.bandwidth = limiter
        self.download()
        self.assertIs(self.boundary.transports[0].options["bandwidth_limiter"], limiter)
        self.assertEqual(charges, [])

    def test_legacy_hooks_charge_only_new_bytes_and_omit_per_downloader_limits(self):
        charges = []
        self.engine.bandwidth = SimpleNamespace(consume=lambda count, cancel: charges.append(count))
        self.engine.info["formats"][0].update(protocol="m3u8_native", fragments=[{"url": "https://media.example.test/segment"}])
        self.download()
        self.assertEqual(charges, [len(MEDIA)])
        self.assertNotIn("ratelimit", self.engine.legacy_calls[0]["options"])

    def test_legacy_hook_counts_cumulative_deltas_once_for_each_track(self):
        charges = []
        self.engine.bandwidth = SimpleNamespace(consume=lambda count, cancel: charges.append(count))
        first = self.engine.info["formats"][0]
        first.update(protocol="http_dash_segments", acodec="none", fragments=[{"url": "https://media.example.test/segment"}])
        self.engine.info["formats"].append({**first, "format_id": "audio", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2"})

        class IncrementalDownloader(LegacyDownloader):
            def dl(inner, filename, info):
                for count in (100, 80, 120, 120):
                    inner.options["progress_hooks"][0]({"downloaded_bytes": count, "total_bytes": len(MEDIA)})
                return super().dl(filename, info)

        dependencies = (SimpleNamespace(YoutubeDL=lambda options: IncrementalDownloader(self.engine, options)), Path("deno.exe"), Path("ffmpeg.exe"), Path("ffprobe.exe"))
        with patch.object(self.engine, "_dependencies", return_value=dependencies):
            self.download()
        self.assertEqual(charges, [100, 20, len(MEDIA) - 120] * 2)

    def test_matching_legacy_resume_charges_only_bytes_after_the_saved_prefix(self):
        charges = []
        self.engine.bandwidth = SimpleNamespace(consume=lambda count, cancel: charges.append(count))
        for complete in (False, True):
            request = self.seed_legacy(complete=complete)
            self.engine.download(request, lambda _: None, threading.Event())
        self.assertEqual(charges, [len(MEDIA) - len(b"old partial")])

    def test_speed_setting_changes_reconfigure_existing_process_limiter(self):
        configurations = []
        self.engine.bandwidth = SimpleNamespace(configure=lambda enabled, rate: configurations.append((enabled, rate)))
        self.engine.save_settings({"speed_limit_enabled": True})
        self.engine.save_settings({"speed_limit_kib": 2048})
        self.engine.save_settings({"speed_limit_enabled": False})
        self.assertEqual(configurations, [(True, 10240), (True, 2048), (False, 2048)])

    def test_multiple_engines_share_the_process_limiter(self):
        second = subject.Engine(APP_ROOT, self.root / "other-data")
        self.assertIs(self.engine.bandwidth, second.bandwidth)

    def test_matching_old_youtube_partial_and_track_stay_on_legacy_path(self):
        for complete in (False, True):
            with self.subTest(complete=complete):
                request = self.seed_legacy(complete=complete)
                self.engine.download(request, lambda _: None, threading.Event())
                call = self.engine.legacy_calls[-1]
                self.assertEqual(call["existing"] if complete else call["partial"], MEDIA if complete else b"old partial")
        self.assertFalse(self.boundary.calls)

    def test_changed_youtube_selection_discards_old_partial_before_native_transfer(self):
        self.engine.download(self.seed_legacy(matching=False), lambda _: None, threading.Event())
        self.assertEqual(len(self.boundary.calls), 1)
        self.assertFalse(self.engine.legacy_calls)

    @unittest.skipIf(os.name == "nt", "Creating symlinks requires an optional Windows privilege")
    def test_legacy_partial_symlink_is_rejected_without_touching_its_target(self):
        request = self.seed_legacy()
        partial = self.engine.destination / (".myvideoapp-" + request.job_id + ".tmp") / "source-0.mp4.part"
        target = self.engine.destination / "user-file"
        target.write_bytes(b"preserve")
        partial.unlink()
        partial.symlink_to(target)
        with self.assertRaises(subject.EngineError):
            self.engine.download(request, lambda _: None, threading.Event())
        self.assertEqual(target.read_bytes(), b"preserve")
        self.assertFalse(self.engine.legacy_calls)
        self.assertFalse(self.boundary.calls)

    def test_hls_and_dash_fragments_use_existing_bounded_downloader(self):
        for protocol in ("m3u8_native", "http_dash_segments"):
            self.engine.info["formats"][0].update(protocol=protocol, fragments=[{"url": "https://media.example.test/segment"}])
            self.download()
            call = self.engine.legacy_calls[-1]
            self.assertEqual(call["leases"], call["options"]["concurrent_fragment_downloads"])
            sleep = self.engine._options(Path("deno.exe"))["retry_sleep_functions"]["fragment"]
            self.assertEqual([sleep(attempt) for attempt in range(1, 7)], [1, 2, 4, 8, 8, 8])
        self.assertFalse(self.boundary.calls)

    def test_cancel_during_legacy_retry_backoff_prevents_another_request(self):
        entered = threading.Event()
        cancel = threading.Event()
        requests = []
        errors = []
        self.engine.info["formats"][0].update(protocol="m3u8_native", fragments=[{"url": "https://media.example.test/segment"}])

        class RetryingDownloader:
            def __init__(self, options):
                self.options = options

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def dl(self, filename, info):
                requests.append("first request")
                entered.set()
                self.options["retry_sleep_functions"]["fragment"](3)
                requests.append("retry request")
                return False

        def run():
            try:
                self.engine.download(subject.DownloadRequest(DIRECT, self.engine.destination), lambda _: None, cancel)
            except BaseException as error:
                errors.append(error)

        dependencies = (SimpleNamespace(YoutubeDL=RetryingDownloader), Path("deno.exe"), Path("ffmpeg.exe"), Path("ffprobe.exe"))
        with patch.object(self.engine, "_dependencies", return_value=dependencies):
            worker = threading.Thread(target=run)
            worker.start()
            try:
                self.assertTrue(entered.wait(2), "The first request did not reach retry backoff.")
                cancel.set()
                worker.join(1)
                self.assertFalse(worker.is_alive(), "Cancellation waited for the full retry delay.")
            finally:
                cancel.set()
                worker.join(5)
        self.assertEqual(requests, ["first request"])
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], subject.DownloadCancelled)
        self.assertEqual(self.engine.history()[0]["stage"], "cancelled")
        self.assertFalse(list(self.engine.destination.glob(".myvideoapp-*")))
        self.assertEqual(self.engine.resources.snapshot()["network"]["used"], 0)

    def test_http_track_with_fragments_does_not_enter_range_path(self):
        self.engine.info["formats"][0]["fragments"] = [{"url": "https://media.example.test/segment"}]
        self.download()
        self.assertFalse(self.boundary.calls)
        self.assertEqual(len(self.engine.legacy_calls), 1)

    def test_multi_track_uses_one_transport_and_safe_protocol_summary(self):
        video = self.engine.info["formats"][0]
        video["acodec"] = "none"
        self.engine.info["formats"].append({**video, "format_id": "audio", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2"})
        self.boundary.protocols = ["h3", "h2"]
        result, events = self.download()
        self.assertEqual(len(self.boundary.transports), 1)
        self.assertEqual(len(self.boundary.calls), 2)
        self.assertEqual(events[-1].downloaded, 2 * len(MEDIA))
        self.assertIn("HTTP/3 · HTTP/2", result.message)
        self.assertEqual(self.engine.store.get(result.job_id)["message"], result.message)

    def test_native_cancel_preserves_user_files_and_releases_resources(self):
        cancel = threading.Event()
        keep = self.engine.destination / "user.mp4.part"
        keep.write_bytes(b"preserve")
        events = []

        def progress(event):
            events.append(event)
            if event.stage == "downloading" and event.downloaded:
                cancel.set()

        with self.assertRaises(subject.DownloadCancelled):
            self.engine.download(subject.DownloadRequest(DIRECT, self.engine.destination), progress, cancel)
        self.assertEqual(self.engine.history()[0]["stage"], "cancelled")
        self.assertEqual(events[-1].stage, "cancelled")
        self.assertEqual(keep.read_bytes(), b"preserve")
        self.assertFalse(list(self.engine.destination.glob(".myvideoapp-*")))
        self.assertTrue(self.boundary.transports[0].closed)
        self.assertTrue(all(value["used"] == 0 for value in self.engine.resources.snapshot().values()))

    def test_waiting_is_visible_and_native_failure_is_sanitized(self):
        self.boundary.before_progress = lambda options, cancel: options["on_wait"]()
        _, events = self.download()
        self.assertIn("waiting", [event.stage for event in events])
        self.boundary.failure = RuntimeError(DIRECT)
        with self.assertRaises(subject.EngineError) as error:
            self.download()
        self.assertNotIn("PRIVATE_VALUE", str(error.exception) + json.dumps(self.engine.history()))
        self.assertTrue(self.boundary.transports[-1].closed)

    def test_probe_rejects_html_and_existing_publication_is_preserved(self):
        existing = self.engine.destination / "Example video.mp4"
        existing.write_bytes(b"user content")
        result, _ = self.download(scan=True)
        self.assertEqual(Path(result.filepath).name, "Example video (2).mp4")
        self.assertEqual(existing.read_bytes(), b"user content")
        self.assertEqual(self.engine.scans, [Path(result.filepath)])
        self.assertTrue(all(command[command.index("-protocol_whitelist") + 1] == "file,pipe" for command in self.engine.commands if "-protocol_whitelist" in command))
        self.boundary.media = b"<html>not media</html>"
        with self.assertRaises(subject.EngineError):
            self.download()
        self.assertEqual(len(list(self.engine.destination.glob("*.mp4"))), 2)


class TransportSettingsTests(unittest.TestCase):
    def test_speed_limit_defaults_off_and_validates_bounded_integer_rate(self):
        with tempfile.TemporaryDirectory(prefix="myvideoapp-bandwidth-settings-") as directory:
            store = Storage(Path(directory))
            self.assertFalse(store.settings()["speed_limit_enabled"])
            self.assertEqual(store.settings()["speed_limit_kib"], 10240)
            for invalid in (0, 1, "false", None, []):
                with self.subTest(enabled=invalid), self.assertRaises(ValueError):
                    store.save_settings({"speed_limit_enabled": invalid})
            for invalid in (False, True, 63, 1048577, 1024.0, "1024", None):
                with self.subTest(rate=invalid), self.assertRaises(ValueError):
                    store.save_settings({"speed_limit_kib": invalid})
            store.save_settings({"speed_limit_enabled": True, "speed_limit_kib": 1024})
            restored = Storage(Path(directory)).settings()
            self.assertTrue(restored["speed_limit_enabled"])
            self.assertEqual(restored["speed_limit_kib"], 1024)
            with store.connect() as database:
                database.execute("UPDATE preferences SET value='true' WHERE key='speed_limit_kib'")
                database.execute("UPDATE preferences SET value='1' WHERE key='speed_limit_enabled'")
            self.assertFalse(store.settings()["speed_limit_enabled"])
            self.assertEqual(store.settings()["speed_limit_kib"], 10240)

    def test_new_preferences_default_on_and_persist_strict_booleans_without_schema_change(self):
        with tempfile.TemporaryDirectory(prefix="myvideoapp-native-settings-") as directory:
            store = Storage(Path(directory))
            store.save_settings({"theme": "dark", "concurrent_downloads": 3})
            self.assertTrue(store.settings()["parallel_downloads"])
            self.assertTrue(store.settings()["http3_enabled"])
            for key in ("parallel_downloads", "http3_enabled"):
                for invalid in (0, 1, "false", None, []):
                    with self.subTest(key=key, value=invalid), self.assertRaises(ValueError):
                        store.save_settings({key: invalid})
            store.save_settings({"parallel_downloads": False, "http3_enabled": False})
            settings = Storage(Path(directory)).settings()
            self.assertFalse(settings["parallel_downloads"])
            self.assertFalse(settings["http3_enabled"])
            self.assertEqual((settings["theme"], settings["concurrent_downloads"]), ("dark", 3))
            with store.connect() as database:
                self.assertEqual(database.execute("PRAGMA user_version").fetchone()[0], 1)
                database.execute("UPDATE preferences SET value='1' WHERE key='http3_enabled'")
            self.assertTrue(store.settings()["http3_enabled"])


try:
    from PySide6.QtCore import QCoreApplication, QEvent, QEventLoop, QTimer
    from PySide6.QtWidgets import QApplication
    import main as gui
except ImportError:
    gui = None


def process_until(predicate):
    if predicate():
        return
    loop = QEventLoop()
    poll = QTimer()
    poll.setInterval(2)
    poll.timeout.connect(lambda: loop.quit() if predicate() else None)
    deadline = QTimer()
    deadline.setSingleShot(True)
    deadline.timeout.connect(loop.quit)
    poll.start()
    deadline.start(8000)
    loop.exec()
    poll.stop()
    deadline.stop()
    if not predicate():
        raise AssertionError("Qt worker did not finish within eight seconds.")


@unittest.skipIf(gui is None, "PySide6 is unavailable")
class NativeGuiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.application = QApplication.instance() or QApplication([])
        cls.application.setQuitOnLastWindowClosed(False)
        cls.application.setStyle("Fusion")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="myvideoapp-native-gui-")
        self.addCleanup(self.temporary.cleanup)
        self.engine = Harness(Path(self.temporary.name))
        self.engine.save_settings({"download_folder": str(self.engine.destination), "folder_confirmed": True})
        self.boundary = NativeBoundary(self.engine)
        for name, value in (("NativeTransport", self.boundary.transport), ("download_file", self.boundary.download)):
            replacement = patch.object(subject, name, value)
            replacement.start()
            self.addCleanup(replacement.stop)
        self.window = gui.MainWindow(self.engine)
        self.window.show()
        self.application.processEvents()

    def tearDown(self):
        self.window._closing = True
        self.window.pending.clear()
        for item in self.window.items.values():
            item.cancel.set()
        process_until(lambda: not self.window.workers)
        self.assertTrue(self.window.pool.waitForDone(1000))
        self.window.close()
        self.window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.application.processEvents()

    def test_toggles_default_on_save_and_restore_their_independent_choices(self):
        self.assertTrue(self.window.parallel_checkbox.isChecked())
        self.assertTrue(self.window.http3_checkbox.isChecked())
        self.window.parallel_checkbox.click()
        self.window.http3_checkbox.click()
        settings = subject.Engine(APP_ROOT, self.engine.store.directory).settings()
        self.assertFalse(settings["parallel_downloads"])
        self.assertFalse(settings["http3_enabled"])
        self.window.http3_checkbox.click()
        self.assertFalse(self.engine.settings()["parallel_downloads"])
        self.assertTrue(self.engine.settings()["http3_enabled"])

    def test_speed_limit_ui_defaults_off_and_updates_persisted_global_limit(self):
        self.assertFalse(self.window.speed_limit_checkbox.isChecked())
        self.assertFalse(self.window.speed_limit_spin.isEnabled())
        self.assertEqual(self.window.speed_limit_spin.value(), 10240)
        self.assertEqual((self.window.speed_limit_spin.minimum(), self.window.speed_limit_spin.maximum()), (64, 1048576))
        self.window.speed_limit_checkbox.click()
        self.assertTrue(self.window.speed_limit_spin.isEnabled())
        self.window.speed_limit_spin.setValue(1024)
        settings = self.engine.settings()
        self.assertTrue(settings["speed_limit_enabled"])
        self.assertEqual(settings["speed_limit_kib"], 1024)
        self.window.speed_limit_checkbox.click()
        self.assertFalse(self.window.speed_limit_spin.isEnabled())
        restored = subject.Engine(APP_ROOT, self.engine.store.directory).settings()
        self.assertFalse(restored["speed_limit_enabled"])
        self.assertEqual(restored["speed_limit_kib"], 1024)

    def test_turning_limit_off_releases_an_active_worker_immediately(self):
        entered = threading.Event()
        self.window.speed_limit_spin.setValue(64)
        self.window.speed_limit_checkbox.click()
        self.engine.bandwidth.consume(65536, threading.Event())

        def limited_body(options, cancel):
            entered.set()
            self.engine.bandwidth.consume(65536, cancel)

        self.boundary.before_progress = limited_body
        self.window.url_input.setText(DIRECT)
        self.window.add_download()
        process_until(entered.is_set)
        self.assertTrue(self.window.workers)
        self.window.speed_limit_checkbox.click()
        process_until(lambda: not self.window.workers)
        item = next(iter(self.window.items.values()))
        self.assertEqual(item.stage, "complete")
        self.assertFalse(self.engine.settings()["speed_limit_enabled"])

    def test_card_displays_only_actual_supported_protocol_values(self):
        item = gui.QueueItem(subject.DownloadRequest(DIRECT, self.engine.destination), "protocol-ui", stage="downloading")
        card = gui.JobCard(item)
        for protocol, expected in ((None, ""), ("h3", "HTTP/3"), ("h2", "HTTP/2"), ("http/1.1", "HTTP/1.1"), ("HTTP/3 enabled", "")):
            item.progress = subject.DownloadProgress("downloading", downloaded=1, transport=protocol, connections=2, transfer_mode="parallel")
            card.refresh()
            self.assertIn("병렬 요청 2개", card.stats.text())
            self.assertEqual("HTTP/" in card.stats.text(), bool(expected))
            if expected:
                self.assertIn(expected, card.stats.text())
        item.progress = subject.DownloadProgress("downloading", transport="h2", connections=1, transfer_mode="single")
        card.refresh()
        self.assertIn("단일 요청", card.stats.text())
        self.assertNotIn("HTTP/3", card.stats.text())
        card.deleteLater()

    def test_actual_worker_routes_native_completes_and_persists_observed_summary(self):
        self.boundary.protocols = ["h3"]
        self.window.url_input.setText(DIRECT)
        self.window.add_download()
        process_until(lambda: not self.window.workers)
        self.assertEqual(len(self.boundary.calls), 1)
        item = next(iter(self.window.items.values()))
        self.assertEqual(item.stage, "complete")
        self.assertIn("HTTP/3", self.window.cards[item.job_id].message_label.text())
        self.assertEqual(self.engine.store.get(item.job_id)["message"], item.message)
        self.assertTrue(self.boundary.transports[0].closed)

    def test_worker_cancellation_reaches_native_transfer_and_cleans_owned_files(self):
        entered = threading.Event()

        def wait_for_cancel(options, cancel):
            entered.set()
            if not cancel.wait(5):
                raise AssertionError("GUI cancellation did not reach the transfer.")
            raise subject.TransferCancelled("fixture cancellation")

        self.boundary.before_progress = wait_for_cancel
        self.window.url_input.setText(DIRECT)
        self.window.add_download()
        process_until(entered.is_set)
        item = next(iter(self.window.items.values()))
        self.window.cancel_download(item.job_id)
        process_until(lambda: not self.window.workers)
        self.assertEqual(item.stage, "cancelled")
        self.assertEqual(self.engine.store.get(item.job_id)["stage"], "cancelled")
        self.assertFalse(list(self.engine.destination.glob(".myvideoapp-*")))
        self.assertTrue(self.boundary.transports[0].closed)
        self.assertEqual(self.engine.resources.snapshot()["network"]["used"], 0)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *_test_arguments])
