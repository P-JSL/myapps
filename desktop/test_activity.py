"""Offline regressions for the desktop 1.19.2 execution log.

Run with the standard library only::

    python desktop/test_activity.py -v
    runtime/python/python.exe -I desktop/test_activity.py --app-root C:\\MyVideoApp -v

``--app-root`` selects the reviewed source or extracted desktop bundle. Modules
are loaded from its desktop directory, independently of the working directory.
No existing test modules, Qt, downloader package, network or media executable is
needed. Skips are failures so a missing prerequisite cannot look like a pass.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import errno
import importlib.util
import json
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock


_arguments = argparse.ArgumentParser(add_help=False)
_arguments.add_argument("--app-root", type=Path)
_options, _unittest_arguments = _arguments.parse_known_args()
APP_ROOT = (_options.app_root or Path(__file__).resolve().parent.parent).resolve()
DESKTOP_DIR = APP_ROOT / "desktop"
if not all((DESKTOP_DIR / name).is_file() for name in ("activity.py", "engine.py")):
    raise SystemExit("--app-root must contain desktop/activity.py and desktop/engine.py")


def _load_sibling(name):
    package_name = "_myvideoapp_activity_regression"
    if package_name not in sys.modules:
        package = types.ModuleType(package_name)
        package.__path__ = [str(DESKTOP_DIR)]
        package.__package__ = package_name
        sys.modules[package_name] = package
    module_name = package_name + "." + name
    specification = importlib.util.spec_from_file_location(module_name, DESKTOP_DIR / (name + ".py"))
    module = importlib.util.module_from_spec(specification)
    sys.modules[module_name] = module
    specification.loader.exec_module(module)
    return module


activity = _load_sibling("activity")
engine = _load_sibling("engine")

SECRET = "private-canary-319b42"
PRIVATE_URL = "https://media.invalid/" + SECRET + ".mp4?token=" + SECRET + "#" + SECRET
PRIVATE_HEADER = "Authorization: Bearer " + SECRET
PRIVATE_TITLE = "Fixture title " + SECRET
REQUIRED_KEYS = {"timestamp", "level", "event", "session", "version", "job_id", "stage", "detail"}
MEDIA = b"\x00\x00\x00\x18ftypmp42" + b"offline-owned-fixture" * 4


class _HostileValue:
    def __str__(self):
        raise AssertionError("Untrusted __str__ must not run")

    def __repr__(self):
        raise AssertionError("Untrusted __repr__ must not run")


class _HostileError(Exception):
    def __str__(self):
        raise AssertionError("Exception messages must not be formatted")


class _OfflineCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="activity-tests-")))
        # Any accidental escape from the owned fixture must fail immediately.
        self.enterContext(mock.patch.object(socket, "socket", side_effect=AssertionError("This suite is offline")))
        self.enterContext(mock.patch.object(socket, "create_connection", side_effect=AssertionError("This suite is offline")))
        self.enterContext(mock.patch("subprocess.Popen", side_effect=AssertionError("This suite uses no external processes")))

    def make_log(self, name="data", **options):
        log = activity.ActivityLog(self.root / name, **options)
        self.addCleanup(log.close)
        return log

    def assert_private(self, value):
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True) if not isinstance(value, str) else value
        for private in (SECRET, PRIVATE_URL, PRIVATE_HEADER, PRIVATE_TITLE, str(self.root)):
            self.assertNotIn(private, rendered)

    def assert_schema(self, row):
        self.assertEqual(set(row), REQUIRED_KEYS)
        datetime.strptime(row["timestamp"], "%Y-%m-%dT%H:%M:%S.%fZ")
        self.assertRegex(row["session"], r"^[0-9a-f]{32}$")
        self.assertEqual(row["version"], "1.19.2")
        self.assertIn(row["level"], ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"))
        self.assertIsInstance(row["detail"], dict)
        if row["job_id"] is not None:
            self.assertRegex(row["job_id"], r"^[0-9a-f]{32}$")

    def disk_rows(self, log):
        rows = []
        for path in sorted(log.directory.glob("activity.jsonl*")):
            if path.is_file():
                content = path.read_bytes().decode("utf-8", errors="strict")
                self.assertTrue(not content or content.endswith("\n"), path.name)
                for line in content.splitlines():
                    row = json.loads(line)
                    self.assert_schema(row)
                    rows.append(row)
        return rows


class ActivityLogTests(_OfflineCase):
    def test_schema_sessions_and_persistence(self):
        log = self.make_log()
        self.assertTrue(log.available, log.failure)
        self.assertEqual(log.directory, self.root / "data" / "logs")
        self.assertEqual(log.path, log.directory / "activity.jsonl")
        log.emit("download.requested", job_id="a" * 32, stage="queued", source_kind="direct", output="mp4")
        original = log.recent()[0]
        self.assert_schema(original)
        self.assertEqual(original["session"], log.session_id)
        self.assertEqual(original["job_id"], "a" * 32)
        self.assertEqual(original["detail"], {"source_kind": "direct", "output": "mp4"})
        log.close()
        reopened = self.make_log()
        self.assertNotEqual(log.session_id, reopened.session_id)
        self.assertIn(original, reopened.recent())
        reopened.emit("app.ready")
        self.assertEqual(reopened.recent()[-1]["session"], reopened.session_id)
        self.assertEqual(len(self.disk_rows(reopened)), 2)

    def test_whitelist_rejects_urls_nested_fields_and_hostile_values(self):
        log = self.make_log(version=PRIVATE_URL)
        hostile = _HostileValue()
        log.emit(PRIVATE_URL, level=PRIVATE_HEADER, job_id=PRIVATE_URL, stage=PRIVATE_URL,
                 url=PRIVATE_URL, title=PRIVATE_TITLE, filepath=str(self.root / SECRET),
                 headers={"Authorization": PRIVATE_HEADER}, nested={"token": [PRIVATE_URL]},
                 downloaded={"value": PRIVATE_URL}, total=hostile, output=hostile,
                 error_type=SECRET, source_kind=PRIVATE_URL, unknown=hostile,
                 traceback=[{"file": PRIVATE_URL, "function": SECRET, "line": 1}])
        row = log.recent()[-1]
        self.assert_schema(row)
        self.assertEqual(row["event"], "activity.unknown")
        self.assertEqual(row["level"], "INFO")
        self.assertIsNone(row["job_id"])
        self.assertIsNone(row["stage"])
        self.assertEqual(row["detail"], {"error_type": "Exception"})
        self.assertTrue(log.available, log.failure)
        self.assert_private(log.path.read_text(encoding="utf-8"))

    def test_numeric_fields_reject_nonfinite_wrong_types_and_unbounded_values(self):
        log = self.make_log()
        log.emit("download.progress", downloaded=True, total=-1, count=10 ** 100,
                 duration_ms=float("nan"), speed=float("inf"), eta=-1,
                 percent="99", connections=1.5, scan=1, http_status=999)
        self.assertEqual(log.recent()[-1]["detail"], {})
        log.emit("download.progress", downloaded=12, total=24, percent=50.0,
                 duration_ms=1.25, connections=2, scan=False, http_status=206)
        detail = log.recent()[-1]["detail"]
        self.assertEqual(detail["downloaded"], 12)
        self.assertEqual(detail["percent"], 50.0)
        self.assertEqual(detail["http_status"], 206)
        self.disk_rows(log)

    def test_exception_preserves_codes_and_safe_frames_without_raw_message(self):
        log = self.make_log()
        scope = {"errno": errno, "private": PRIVATE_URL}
        source = "def fixed_failure():\n    raise OSError(errno.ENOSPC, private)\n"
        exec(compile(source, str(self.root / SECRET / "engine.py"), "exec"), scope)
        try:
            scope["fixed_failure"]()
        except OSError as error:
            error.winerror = 112
            log.exception("download.failed", error, job_id="b" * 32, stage="downloading")
        row = log.recent()[-1]
        self.assertEqual(row["level"], "ERROR")
        self.assertEqual(row["detail"]["error_type"], "OSError")
        self.assertEqual(row["detail"]["errno"], errno.ENOSPC)
        self.assertEqual(row["detail"]["winerror"], 112)
        frames = row["detail"]["traceback"]
        self.assertTrue(frames)
        self.assertLessEqual(len(frames), 12)
        for frame in frames:
            self.assertEqual(set(frame), {"file", "function", "line"})
            self.assertNotRegex(frame["file"], r"[/\\:]")
            self.assertRegex(frame["function"], r"^[A-Za-z_][A-Za-z_0-9]{0,63}$")
            self.assertIs(type(frame["line"]), int)
        self.assert_private(row)
        self.assert_private(log.path.read_text(encoding="utf-8"))

    def test_exception_never_formats_unknown_exception(self):
        log = self.make_log()
        log.exception("download.failed", _HostileError(PRIVATE_URL, {"headers": PRIVATE_HEADER}),
                      message=PRIVATE_URL, exception_args=[PRIVATE_URL])
        self.assertTrue(log.available, log.failure)
        row = log.recent()[-1]
        self.assertEqual(row["detail"]["error_type"], "Exception")
        self.assert_private(row)
        self.assert_private(log.path.read_text(encoding="utf-8"))

    def test_rotation_has_bounded_files_complete_json_and_valid_utf8(self):
        log = self.make_log(max_bytes=1024, backup_count=2)
        for index in range(80):
            log.emit("download.progress", downloaded=index, total=80,
                     title="비공개 " + SECRET, nested={"emoji": "🔒" + SECRET})
        self.assertTrue(log.available, log.failure)
        paths = sorted(log.directory.glob("activity.jsonl*"))
        self.assertEqual(len(paths), 3)
        self.assertTrue(all(path.stat().st_size <= 1024 for path in paths))
        rows = self.disk_rows(log)
        self.assertGreater(len(rows), 2)
        self.assertLess(len(rows), 80)
        self.assertEqual(max(row["detail"]["downloaded"] for row in rows), 79)
        log.close()
        reopened = self.make_log(max_bytes=1024, backup_count=2)
        self.assertEqual(reopened.recent()[-1]["detail"]["downloaded"], 79)
        self.assert_private(rows)

    def test_multiple_threads_write_one_complete_record_per_emit(self):
        log = self.make_log()
        barrier = threading.Barrier(6)

        def write(worker):
            barrier.wait(timeout=10)
            for index in range(40):
                log.emit("download.progress", job_id=f"{worker:032x}", stage="downloading",
                         downloaded=worker * 40 + index)

        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(write, range(6)))
        self.assertTrue(log.available, log.failure)
        rows = self.disk_rows(log)
        self.assertEqual(len(rows), 240)
        self.assertEqual({row["detail"]["downloaded"] for row in rows}, set(range(240)))
        self.assertEqual(len(log.recent()), 240)

    def test_recent_tolerates_invalid_utf8_oversized_truncated_and_forged_rows(self):
        log = self.make_log()
        log.emit("app.ready")
        base = log.recent()[-1]
        forged = {**base, "job_id": PRIVATE_URL, "stage": PRIVATE_URL,
                  "url": PRIVATE_URL,
                  "detail": {"count": 99, "url": PRIVATE_URL, "error_type": SECRET,
                             "output": PRIVATE_URL,
                             "traceback": [{"file": PRIVATE_URL, "function": SECRET, "line": 7}]}}
        valid = {**base, "detail": {"count": 12}}
        with log.path.open("ab") as stream:
            stream.write(b"not-json\n[]\n{\"bad\":true}\n\xff\xfe\n")
            stream.write(b"x" * 20000 + b"\n")
            stream.write((json.dumps(forged) + "\n").encode("utf-8"))
            stream.write((json.dumps(valid) + "\n").encode("utf-8"))
            stream.write(b'{"timestamp":')
        rows = log.recent()
        self.assertTrue(any(row["detail"].get("count") == 12 for row in rows))
        sanitized = next(row for row in rows if row["detail"].get("count") == 99)
        self.assertIsNone(sanitized["job_id"])
        self.assertIsNone(sanitized["stage"])
        self.assertEqual(sanitized["detail"]["error_type"], "Exception")
        self.assertEqual(sanitized["detail"]["traceback"], [{"file": "external.py", "function": "external", "line": 7}])
        for row in rows:
            self.assert_schema(row)
        self.assert_private(rows)

    def test_recent_limit_and_warning_error_filter(self):
        log = self.make_log()
        for index, level in enumerate(("INFO", "WARNING", "DEBUG", "ERROR", "INFO", "CRITICAL", "INFO")):
            log.emit("download.progress", level=level, downloaded=index)
        self.assertEqual([row["detail"]["downloaded"] for row in log.recent(limit=3)], [4, 5, 6])
        self.assertEqual([row["level"] for row in log.recent(errors_only=True)], ["WARNING", "ERROR", "CRITICAL"])
        self.assertEqual([row["level"] for row in log.recent(limit=2, errors_only=True)], ["ERROR", "CRITICAL"])
        self.assertEqual(log.recent(limit=0), [])
        self.assertEqual(log.recent(limit=-5), [])

    def test_error_filter_skips_info_parsing_and_accepts_noncompact_records(self):
        log = self.make_log()
        log.emit("app.ready")
        base = log.recent()[-1]
        log.close()
        rows = [{**base, "detail": {"count": index}} for index in range(100)]
        warning = {**base, "level": "WARNING", "detail": {"count": 101}}
        error = {**base, "level": "ERROR", "detail": {"count": 102}}
        critical = {**base, "level": "CRITICAL", "detail": {"count": 103}}
        started = datetime.strptime(base["timestamp"], "%Y-%m-%dT%H:%M:%S.%fZ")
        for index, row in enumerate((warning, error, critical), 1):
            row["timestamp"] = (started + timedelta(microseconds=index)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        with log.path.open("w", encoding="utf-8", newline="\n") as stream:
            for row in rows:
                stream.write(json.dumps(row, separators=(",", ":")) + "\n")
            # Existing JSONL may include spaces or tabs around its separators.
            stream.write(json.dumps(warning) + "\n")
            stream.write(json.dumps(error, separators=(", ", " \t: \t")) + "\n")
            # JSON escapes are valid in level names and receive the full parser.
            stream.write(json.dumps(critical).replace('"CRITICAL"', '"\\u0043RITICAL"') + "\n")
        reopened = self.make_log()
        with mock.patch.object(activity.json, "loads", wraps=json.loads) as parser:
            result = reopened.recent(errors_only=True)
        self.assertEqual([row["level"] for row in result], ["WARNING", "ERROR", "CRITICAL"])
        self.assertEqual([row["detail"]["count"] for row in result], [101, 102, 103])
        self.assertEqual(parser.call_count, 3, "Healthy INFO rows should bypass JSON parsing")

    def test_recent_caps_large_requested_result(self):
        log = self.make_log()
        log.emit("app.ready")
        base = log.recent()[-1]
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        with log.path.open("wb") as stream:
            for index in range(5010):
                row = {**base, "timestamp": (start + timedelta(microseconds=index)).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                       "detail": {"count": index}}
                stream.write((json.dumps(row, separators=(",", ":")) + "\n").encode("utf-8"))
        self.assertLess(log.path.stat().st_size, 2 * 1024 * 1024)
        self.assertEqual(len(log.recent()), 500)
        self.assertEqual(len(log.recent(limit=10 ** 9)), 5000)

    def test_recent_results_are_independent_copies(self):
        log = self.make_log()
        log.emit("download.progress", downloaded=1)
        result = log.recent()
        result[0]["event"] = PRIVATE_URL
        result[0]["detail"]["url"] = PRIVATE_URL
        later = log.recent()
        self.assertEqual(later[0]["event"], "download.progress")
        self.assertEqual(later[0]["detail"], {"downloaded": 1})
        self.assert_private(later)

    def test_unavailable_directory_has_safe_warning_and_memory_fallback(self):
        data = self.root / "blocked"
        data.mkdir()
        (data / "logs").write_text(SECRET, encoding="utf-8")
        log = self.make_log("blocked")
        self.assertFalse(log.available)
        self.assertTrue(log.failure)
        self.assert_private(log.failure)
        log.emit("download.started", job_id="c" * 32)
        log.exception("download.failed", OSError(errno.EACCES, PRIVATE_URL))
        rows = log.recent()
        warnings = [row for row in rows if row["event"] == "activity.unavailable"]
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["level"], "WARNING")
        self.assertEqual(warnings[0]["detail"], {})
        self.assertEqual([row["event"] for row in rows if row["event"] != "activity.unavailable"],
                         ["download.started", "download.failed"])
        self.assert_private(rows)
        log.close()
        log.close()

    def test_post_initialization_write_failure_preserves_recent_records(self):
        log = self.make_log()
        log.emit("app.ready")
        with mock.patch.object(activity.ActivityLog, "_open", side_effect=OSError(errno.EACCES, PRIVATE_URL)):
            log.emit("download.started", job_id="d" * 32)
            log.exception("download.failed", OSError(errno.ENOSPC, PRIVATE_URL))
            self.assertFalse(log.available)
            self.assertTrue(log.failure)
            self.assert_private(log.failure)
            rows = log.recent()
            warnings = [row for row in rows if row["event"] == "activity.unavailable"]
            self.assertEqual(len(warnings), 1)
            self.assertEqual(warnings[0]["level"], "WARNING")
            self.assertEqual(warnings[0]["detail"], {})
            self.assertEqual([row["event"] for row in rows if row["event"] != "activity.unavailable"],
                             ["app.ready", "download.started", "download.failed"])
        self.assert_private(log.recent())
        self.assertEqual(len(self.disk_rows(log)), 1)


class _FixtureEngine(engine.Engine):
    """Use real job/storage/publication flow with an owned, offline media source."""
    def __init__(self, app_root, data_dir, *, activity=None):
        super().__init__(app_root, data_dir,
                         resources=engine.ResourceBudget({"jobs": 2, "metadata": 2, "network": 2,
                                                          "processing": 2, "scan": 1}),
                         activity=activity)
        self.fixture_error = None
        self.hook_calls = 25
        self.save_settings({"speed_limit_enabled": False, "parallel_downloads": False})

    def _dependencies(self, youtube, cancel):
        engine._check_cancel(cancel)
        owner = self

        class OfflineDownloader:
            def __init__(self, options):
                self.options = options

            def __enter__(self):
                return self

            def __exit__(self, *arguments):
                return False

            def dl(self, filename, item):
                Path(filename).write_bytes(MEDIA)
                for index in range(1, owner.hook_calls + 1):
                    value = {"status": "downloading", "downloaded_bytes": len(MEDIA) * index // owner.hook_calls,
                             "total_bytes": len(MEDIA), "speed": 1000, "eta": 0,
                             "info_dict": item, "filename": filename,
                             "url": PRIVATE_URL, "http_headers": {"Authorization": PRIVATE_HEADER}}
                    for hook in self.options.get("progress_hooks", []):
                        hook(value)
                return True

        module = types.SimpleNamespace(YoutubeDL=OfflineDownloader)
        return module, Path("offline-deno"), Path("offline-ffmpeg"), Path("offline-ffprobe")

    def _extract_isolated(self, url, youtube, quality, output, cancel):
        engine._check_cancel(cancel)
        if self.fixture_error is not None:
            raise self.fixture_error
        return {"id": "fixture", "title": PRIVATE_TITLE,
                "http_headers": {"Authorization": PRIVATE_HEADER},
                "formats": [{"format_id": "owned", "url": PRIVATE_URL, "ext": "mp4",
                             "protocol": "m3u8_native", "vcodec": "avc1", "acodec": "mp4a",
                             "height": 720, "filesize": len(MEDIA)}]}

    def _probe(self, path, ffprobe, cancel):
        engine._check_cancel(cancel)
        engine._media_signature(path)

    def _process(self, sources, tracks, destination, output, ffmpeg, cancel):
        engine._check_cancel(cancel)
        shutil.copyfile(sources[0], destination)


class EngineActivityTests(_OfflineCase):
    def make_engine(self, activity_log=None):
        folder = self.root / "output"
        folder.mkdir(exist_ok=True)
        subject = _FixtureEngine(APP_ROOT, self.root / "engine-data", activity=activity_log)
        request = engine.DownloadRequest(PRIVATE_URL, folder, output="mp4")
        return subject, request

    def test_success_records_lifecycle_tracks_and_sampled_progress(self):
        log = self.make_log()
        subject, request = self.make_engine(log)
        callbacks = []
        result = subject.download(request, callbacks.append, threading.Event())
        self.assertEqual(Path(result.filepath).read_bytes(), MEDIA)
        self.assertEqual(subject.store.get(result.job_id)["stage"], "complete")
        rows = log.recent()
        events = [row["event"] for row in rows]
        for event in ("download.requested", "download.started", "extraction.begin", "extraction.end",
                      "track.begin", "track.end", "publish.begin", "publish.end",
                      "download.completed", "download.finished"):
            self.assertIn(event, events)
        self.assertLess(events.index("download.requested"), events.index("download.started"))
        self.assertLess(events.index("download.completed"), events.index("download.finished"))
        self.assertGreater(len([item for item in callbacks if item.stage == "downloading"]), 20)
        sampled = [row for row in rows if row["event"] == "download.progress" and row["stage"] == "downloading"]
        self.assertTrue(sampled)
        self.assertLess(len(sampled), subject.hook_calls)
        self.assertTrue({"queued", "downloading", "processing", "complete"}.issubset(
            {row["stage"] for row in rows if row["event"] == "download.progress"}))
        self.assertTrue(all(row["job_id"] == result.job_id for row in rows if row["event"].startswith("download.")))
        self.assert_private(rows)
        self.assert_private(log.path.read_text(encoding="utf-8"))

    def test_error_preserves_diagnostic_code_without_exception_args(self):
        log = self.make_log()
        subject, request = self.make_engine(log)
        subject.fixture_error = OSError(errno.ENOSPC, PRIVATE_URL, str(self.root / SECRET))
        with self.assertRaises(engine.EngineError):
            subject.download(request, lambda value: None, threading.Event())
        self.assertEqual(subject.history()[0]["stage"], "error")
        rows = log.recent()
        failures = [row for row in rows if row["event"] == "download.failed"]
        self.assertTrue(failures)
        self.assertEqual(failures[-1]["detail"]["errno"], errno.ENOSPC)
        self.assertEqual(failures[-1]["detail"]["error_type"], "OSError")
        self.assertIn("download.finished", [row["event"] for row in rows])
        self.assert_private(rows)
        self.assert_private(log.path.read_text(encoding="utf-8"))

    def test_cancellation_records_terminal_state_and_cleans_owned_media(self):
        log = self.make_log()
        subject, request = self.make_engine(log)
        cancel = threading.Event()

        def on_progress(value):
            if value.stage == "downloading" and value.downloaded:
                cancel.set()

        with self.assertRaises(engine.DownloadCancelled):
            subject.download(request, on_progress, cancel)
        self.assertEqual(subject.history()[0]["stage"], "cancelled")
        self.assertEqual(list(Path(request.folder).iterdir()), [])
        events = [row["event"] for row in log.recent()]
        self.assertIn("download.cancelled", events)
        self.assertIn("download.finished", events)
        self.assertNotIn("download.completed", events)
        self.assert_private(log.recent())

    def test_invalid_request_is_logged_before_job_registration(self):
        log = self.make_log()
        subject, _ = self.make_engine(log)
        invalid = engine.DownloadRequest("invalid://" + SECRET, self.root / "output")
        with self.assertRaises(engine.EngineError):
            subject.download(invalid, lambda value: None, threading.Event())
        rows = log.recent()
        self.assertIn("download.requested", [row["event"] for row in rows])
        self.assertTrue(any(row["event"] == "download.failed" and row["stage"] == "validation" for row in rows))
        self.assertEqual(subject.history(), [])
        self.assert_private(rows)

    def test_metadata_validation_failure_is_logged_before_extraction(self):
        log = self.make_log()
        subject, _ = self.make_engine(log)
        invalid = engine.DownloadRequest("invalid://" + SECRET, self.root / "output")
        with self.assertRaises(engine.EngineError):
            subject.get_info(invalid)
        rows = log.recent()
        events = [row["event"] for row in rows]
        self.assertIn("metadata.requested", events)
        self.assertIn("metadata.failed", events)
        self.assertLess(events.index("metadata.requested"), events.index("metadata.failed"))
        self.assertTrue(all(row["stage"] == "validation" for row in rows))
        self.assertNotIn("extraction.begin", events)
        self.assertEqual(subject.history(), [])
        self.assert_private(rows)

    def test_history_write_failure_is_logged_before_job_registration(self):
        log = self.make_log()
        subject, request = self.make_engine(log)
        with mock.patch.object(subject.store, "insert", side_effect=OSError(errno.EACCES, PRIVATE_URL)):
            with self.assertRaises(OSError):
                subject.download(request, lambda value: None, threading.Event())
        rows = log.recent()
        failure = next(row for row in rows if row["event"] == "download.failed")
        self.assertEqual(failure["stage"], "storage")
        self.assertEqual(failure["detail"]["errno"], errno.EACCES)
        self.assertIn("download.finished", [row["event"] for row in rows])
        self.assertEqual(subject.history(), [])
        self.assertEqual(list(Path(request.folder).iterdir()), [])
        self.assert_private(rows)

    def test_unavailable_log_does_not_change_successful_download(self):
        data = self.root / "blocked"
        data.mkdir()
        (data / "logs").write_bytes(b"blocked")
        log = self.make_log("blocked")
        self.assertFalse(log.available)
        subject, request = self.make_engine(log)
        result = subject.download(request, lambda value: None, threading.Event())
        self.assertEqual(Path(result.filepath).read_bytes(), MEDIA)
        self.assertEqual(subject.store.get(result.job_id)["stage"], "complete")
        self.assertIn("download.completed", [row["event"] for row in log.recent()])
        self.assert_private(log.recent())

    def test_log_write_failure_during_download_does_not_change_result(self):
        log = self.make_log()
        subject, request = self.make_engine(log)
        with mock.patch.object(activity.ActivityLog, "_open", side_effect=OSError(errno.EACCES, PRIVATE_URL)):
            result = subject.download(request, lambda value: None, threading.Event())
            rows = log.recent()
        self.assertFalse(log.available)
        self.assertEqual(Path(result.filepath).read_bytes(), MEDIA)
        self.assertEqual(subject.store.get(result.job_id)["stage"], "complete")
        self.assertIn("download.completed", [row["event"] for row in rows])
        self.assert_private(rows)

    def test_injected_logger_exception_cannot_interrupt_download(self):
        class BrokenLogger:
            def emit(self, *arguments, **fields):
                raise OSError(errno.EIO, PRIVATE_URL)

            def exception(self, *arguments, **fields):
                raise OSError(errno.EIO, PRIVATE_URL)

        subject, request = self.make_engine(BrokenLogger())
        result = subject.download(request, lambda value: None, threading.Event())
        self.assertEqual(Path(result.filepath).read_bytes(), MEDIA)
        self.assertEqual(subject.store.get(result.job_id)["stage"], "complete")

    def test_default_engine_runs_without_creating_log_directory(self):
        subject, request = self.make_engine()
        result = subject.download(request, lambda value: None, threading.Event())
        self.assertEqual(Path(result.filepath).read_bytes(), MEDIA)
        self.assertFalse((self.root / "engine-data" / "logs").exists())


class _NoSkippingResult(unittest.TextTestResult):
    def addSkip(self, test, reason):
        self.addFailure(test, (AssertionError, AssertionError("Unexpected skip: " + reason), None))


class _NoSkippingRunner(unittest.TextTestRunner):
    resultclass = _NoSkippingResult


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *_unittest_arguments], testRunner=_NoSkippingRunner)
