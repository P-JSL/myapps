"""Local, bounded execution diagnostics with a deliberately small public schema.

No source, title, path, request header or exception message is accepted. Callers
provide fixed event codes and typed operational metadata; records read back from
disk pass through the same rules. Logging failure never interrupts a download.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import stat
import threading
import uuid


_EVENTS = frozenset("""
activity.unknown activity.unavailable
app.start app.ready app.shutdown app.previous_unclean app.initialization_failed
app.event_loop_failed app.unhandled_exception app.thread_exception
queue.add queue.cancelled queue cancel retry queued_cancel
download.queued download.requested download.started download.retry
download.retry_requested download.cancel_requested download.progress
download.completed download.cancelled download.failed download.finished
preparation.begin preparation.end extraction.begin extraction.end
track.begin track.end track.reused probe.begin probe.end processing.begin
processing.end publish.begin publish.end scan.begin scan.end transfer.fallback
settings.save_failed history.read_failed worker.failed storage.failed
metadata.requested metadata.completed metadata.failed metadata.cancelled
""".split())
_STAGES = frozenset(("queued", "waiting", "preparing", "extracting", "downloading",
                     "probing", "processing", "publishing", "scanning", "complete",
                     "cancelled", "error", "validation", "storage", "finished"))
_LEVELS = frozenset(("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"))
_ENUMS = {
    "source_kind": frozenset(("youtube", "direct")),
    "quality": frozenset(("highest", "2160", "1440", "1080", "720", "480")),
    "output": frozenset(("original", "mp4", "webm", "mkv", "mp3", "m4a")),
    "container": frozenset(("mp4", "webm", "mkv", "mp3", "m4a", "opus", "ogg", "wav", "flac", "aac", "ts", "m4v", "mov")),
    "track_kind": frozenset(("video", "audio")),
    "transport": frozenset(("h3", "h2", "http/1.1")),
    "transfer_mode": frozenset(("single", "parallel")),
    "operation": frozenset(("convert", "merge", "remux")),
    "phase": _STAGES,
    "outcome": frozenset(("success", "failed", "cancelled", "clean", "complete", "skipped", "unavailable", "not_supported")),
    "reason": frozenset(("missing_shutdown", "compatibility", "requested", "validation", "storage", "active", "mismatch", "unsupported_platform", "defender_unavailable")),
    "action": frozenset(("add", "cancel", "retry", "remove", "save", "start", "shutdown")),
}
_INTEGERS = frozenset(("downloaded", "total", "bytes", "byte_count", "track_index", "track_count",
                       "connections", "attempt", "count", "active_count", "queued_count", "pid",
                       "errno", "winerror", "http_status", "transport_code", "returncode"))
_NUMBERS = frozenset(("duration_ms", "duration", "percent", "speed", "eta", "delay"))
_BOOLEANS = frozenset(("scan", "retry", "reused", "resume", "published", "compatibility_used"))
_ERROR_TYPES = frozenset("""Exception BaseException RuntimeError ValueError TypeError
AttributeError KeyError IndexError AssertionError ImportError ModuleNotFoundError
FileNotFoundError FileExistsError PermissionError IsADirectoryError NotADirectoryError
OSError IOError TimeoutError ConnectionError BrokenPipeError ConnectionAbortedError
ConnectionRefusedError ConnectionResetError InterruptedError BlockingIOError
MemoryError UnicodeError UnicodeDecodeError UnicodeEncodeError JSONDecodeError
EngineError DownloadCancelled TransferError TransferHTTPError TransferFileError
TransferCancelled TransportError TransportCancelled ResourceCancelled BandwidthCancelled
HTTPError URLError CalledProcessError TimeoutExpired
""".split())
_FILES = frozenset(("activity.py", "engine.py", "main.py", "storage.py", "transfer.py",
                    "transport.py", "concurrency.py", "bandwidth.py", "threading.py",
                    "subprocess.py", "pathlib.py", "shutil.py", "json.py"))
_JOB = re.compile(r"[0-9a-f]{32}\Z")
_VERSION = re.compile(r"[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\Z")
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\Z")
_FUNCTION = re.compile(r"[A-Za-z_][A-Za-z_0-9]{0,63}\Z")
_ERROR_LEVEL = re.compile(rb'"level"\s*:\s*"(?:WARNING|ERROR|CRITICAL)"')
_FAILURE = "실행 로그를 파일에 기록하지 못했습니다. 최근 기록은 앱을 닫을 때까지 메모리에만 보관됩니다."


def _detail(fields: dict, *, trace=False) -> dict:
    result = {}
    for key, value in fields.items():
        if key in _ENUMS:
            if type(value) is str and value in _ENUMS[key]:
                result[key] = value
        elif key in _INTEGERS:
            if type(value) is int and -(1 << 31) <= value <= (1 << 63) - 1:
                if key not in ("errno", "winerror", "returncode") and value < 0:
                    continue
                if key == "http_status" and not 100 <= value <= 599:
                    continue
                result[key] = value
        elif key in _NUMBERS:
            if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1e18:
                result[key] = round(value, 3)
        elif key in _BOOLEANS:
            if type(value) is bool:
                result[key] = value
        elif key == "error_type" and type(value) is str:
            result[key] = value if value in _ERROR_TYPES else "Exception"
        elif key == "traceback" and trace and isinstance(value, list):
            frames = []
            for frame in value[-12:]:
                if not isinstance(frame, dict):
                    continue
                filename, function, line = frame.get("file"), frame.get("function"), frame.get("line")
                filename = filename if type(filename) is str and filename in _FILES else "external.py"
                function = function if (filename != "external.py" and type(function) is str and _FUNCTION.fullmatch(function)
                                        and not re.search(r"(?i)token|secret|key|cookie|auth|signature", function)) else "external"
                if type(line) is int and 0 <= line <= 10_000_000:
                    frames.append({"file": filename, "function": function, "line": line})
            result[key] = frames
    return result


class ActivityLog:
    """Thread-safe JSONL rotation and a bounded memory fallback; never uploads."""

    def __init__(self, data_dir: Path, *, version="1.19.2", max_bytes=2 * 1024 * 1024, backup_count=4):
        self.directory = Path(data_dir) / "logs"
        self.path = self.directory / "activity.jsonl"
        self.session_id = uuid.uuid4().hex
        self.version = version if type(version) is str and _VERSION.fullmatch(version) else "1.19.2"
        self.max_bytes = min(2 * 1024 * 1024, max(256, int(max_bytes)))
        self.backup_count = min(4, max(0, int(backup_count)))
        self._lock = threading.RLock()
        self._memory = deque(maxlen=1000)
        self._closed = False
        self.available = False
        self.failure = ""
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            if self.directory.is_symlink():
                raise OSError()
            with self._open(self.path, writing=True):
                pass
            self.available = True
        except Exception:
            self._failed()

    def _failed(self):
        first = not self.failure
        self.available = False
        self.failure = _FAILURE
        if first:
            self._memory.append(self._row("activity.unavailable", "WARNING", None, None, {}))

    @staticmethod
    def _open(path: Path, *, writing=False):
        if path.is_symlink():
            raise OSError()
        flags = (os.O_WRONLY | os.O_APPEND | os.O_CREAT) if writing else os.O_RDONLY
        flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise OSError()
            return os.fdopen(descriptor, "ab" if writing else "rb")
        except BaseException:
            os.close(descriptor)
            raise

    def _row(self, event, level, job_id, stage, fields):
        return {"timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                "level": level if type(level) is str and level in _LEVELS else "INFO",
                "event": event if type(event) is str and event in _EVENTS else "activity.unknown",
                "session": self.session_id, "version": self.version,
                "job_id": job_id if type(job_id) is str and _JOB.fullmatch(job_id) else None,
                "stage": stage if type(stage) is str and stage in _STAGES else None,
                "detail": _detail(fields, trace=True)}

    def _append(self, row):
        with self._lock:
            self._memory.append(row)
            if self._closed or not self.available:
                return
            try:
                encoded = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                # A diagnostic record never makes an individual file exceed its cap.
                if len(encoded) > self.max_bytes:
                    row = {**row, "detail": {key: value for key, value in row["detail"].items() if key != "traceback"}}
                    encoded = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                if len(encoded) > self.max_bytes:
                    row = {**row, "detail": {}}
                    encoded = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                if len(encoded) > self.max_bytes:
                    return
                if self.path.stat().st_size + len(encoded) > self.max_bytes:
                    self._rotate()
                with self._open(self.path, writing=True) as stream:
                    stream.write(encoded)
            except Exception:
                self._failed()

    def _rotate(self):
        if not self.backup_count:
            self.path.unlink(missing_ok=True)
            return
        oldest = self.directory / ("activity.jsonl." + str(self.backup_count))
        oldest.unlink(missing_ok=True)
        for index in range(self.backup_count - 1, 0, -1):
            source = self.directory / ("activity.jsonl." + str(index))
            if source.exists():
                os.replace(source, self.directory / ("activity.jsonl." + str(index + 1)))
        os.replace(self.path, self.directory / "activity.jsonl.1")

    def emit(self, event: str, *, level="INFO", job_id=None, stage=None, **fields):
        try:
            # Traceback structures are accepted exclusively from exception().
            fields.pop("traceback", None)
            self._append(self._row(event, level, job_id, stage, fields))
        except Exception:
            self._failed()

    def exception(self, event: str, error: BaseException, **fields):
        try:
            level = fields.pop("level", "ERROR")
            job_id, stage = fields.pop("job_id", None), fields.pop("stage", None)
            fields.pop("traceback", None)
            fields["error_type"] = type(error).__name__
            for key in ("errno", "winerror"):
                value = getattr(error, key, None)
                if type(value) is int:
                    fields[key] = value
            status = getattr(error, "status", None)
            if type(status) is int:
                fields["http_status"] = status
            code = getattr(error, "code", None)
            if type(code) is int:
                fields["transport_code"] = code
            frames, current = [], error.__traceback__
            while current is not None and len(frames) < 64:
                code = current.tb_frame.f_code
                frames.append({"file": code.co_filename.replace("\\", "/").rsplit("/", 1)[-1],
                               "function": code.co_name, "line": current.tb_lineno})
                current = current.tb_next
            fields["traceback"] = frames[-12:]
            self._append(self._row(event, level, job_id, stage, fields))
        except Exception:
            self._failed()

    @staticmethod
    def _read_row(value):
        if not isinstance(value, dict):
            return None
        timestamp, session, version = value.get("timestamp"), value.get("session"), value.get("version")
        if (type(timestamp) is not str or not _TIMESTAMP.fullmatch(timestamp)
                or type(session) is not str or not _JOB.fullmatch(session)
                or type(version) is not str or not _VERSION.fullmatch(version)
                or value.get("event") not in _EVENTS or value.get("level") not in _LEVELS):
            return None
        job_id, stage, detail = value.get("job_id"), value.get("stage"), value.get("detail")
        return {"timestamp": timestamp, "level": value["level"], "event": value["event"],
                "session": session, "version": version,
                "job_id": job_id if type(job_id) is str and _JOB.fullmatch(job_id) else None,
                "stage": stage if type(stage) is str and stage in _STAGES else None,
                "detail": _detail(detail if isinstance(detail, dict) else {}, trace=True)}

    def recent(self, limit=500, *, errors_only=False) -> list[dict]:
        try:
            limit = min(5000, max(0, int(limit)))
            if not limit:
                return []
            with self._lock:
                rows, seen = [], set()

                def collect(row):
                    row = self._read_row(row)
                    if row is None or (errors_only and row["level"] not in ("WARNING", "ERROR", "CRITICAL")):
                        return
                    identity = json.dumps(row, sort_keys=True)
                    if identity not in seen:
                        seen.add(identity)
                        rows.append(row)

                # Current-session memory entries are the newest candidates. Only
                # parse older on-disk lines until the requested view is filled.
                for row in reversed(self._memory):
                    collect(row)
                    if len(rows) >= limit:
                        break
                if len(rows) < limit:
                    for index in range(self.backup_count + 1):
                        path = self.path if not index else self.directory / ("activity.jsonl." + str(index))
                        try:
                            with self._open(path) as stream:
                                size = os.fstat(stream.fileno()).st_size
                                stream.seek(max(0, size - self.max_bytes))
                                data = stream.read(self.max_bytes)
                            for line in reversed(data.splitlines()):
                                if len(line) > 16384:
                                    continue
                                # Most retained records are INFO progress. Skip
                                # their JSON parsing in the error view. Escapes
                                # take the full parser path so encoded keys or
                                # level values keep their normal JSON meaning.
                                if errors_only and _ERROR_LEVEL.search(line) is None and b"\\" not in line:
                                    continue
                                try:
                                    collect(json.loads(line))
                                except (ValueError, TypeError, UnicodeError):
                                    continue
                                if len(rows) >= limit:
                                    break
                        except FileNotFoundError:
                            continue
                        except Exception:
                            self._failed()
                        if len(rows) >= limit:
                            break
                return sorted(rows, key=lambda row: row["timestamp"])[-limit:]
        except Exception:
            self._failed()
            return []

    def close(self):
        with self._lock:
            self._closed = True
