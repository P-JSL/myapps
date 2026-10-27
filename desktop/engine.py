"""Qt-independent download engine. Call blocking methods from a GUI worker thread.

Only public single YouTube videos and direct HTTP(S) media are accepted. Source
URLs, extractor messages, cookies and HTTP headers are never written to logs.
Every media write occurs in an application-owned job directory until publication.
"""
from __future__ import annotations

from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
import hashlib
import importlib.metadata
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import time
from typing import Callable
from urllib.parse import parse_qs, unquote, urlsplit, urlunsplit
import uuid

try:
    from .concurrency import (FFMPEG_THREADS, PROCESS_RESOURCES, ResourceBudget, ResourceCancelled,
                              fragment_parallelism, normalize_concurrency)
    from .storage import Storage
except ImportError:
    # Isolated Python does not put the script directory on sys.path.
    _policy_name = "_myvideoapp_concurrency"
    if _policy_name not in sys.modules:
        _policy_spec = importlib.util.spec_from_file_location(_policy_name, Path(__file__).absolute().with_name("concurrency.py"))
        _policy_module = importlib.util.module_from_spec(_policy_spec)
        sys.modules[_policy_name] = _policy_module
        _policy_spec.loader.exec_module(_policy_module)
    _policy = sys.modules[_policy_name]
    FFMPEG_THREADS = _policy.FFMPEG_THREADS
    PROCESS_RESOURCES = _policy.PROCESS_RESOURCES
    ResourceBudget = _policy.ResourceBudget
    ResourceCancelled = _policy.ResourceCancelled
    fragment_parallelism = _policy.fragment_parallelism
    normalize_concurrency = _policy.normalize_concurrency
    _storage_spec = importlib.util.spec_from_file_location("_myvideoapp_storage", Path(__file__).absolute().with_name("storage.py"))
    _storage_module = importlib.util.module_from_spec(_storage_spec)
    _storage_spec.loader.exec_module(_storage_module)
    Storage = _storage_module.Storage

try:
    from .bandwidth import BandwidthCancelled, PROCESS_BANDWIDTH
    from .transport import NativeTransport
    from .transfer import TransferCancelled, download_file
except ImportError:
    # Metadata workers use -I and therefore have no sibling import directory.
    for _name in ("bandwidth", "transport", "transfer"):
        if _name not in sys.modules:
            _spec = importlib.util.spec_from_file_location(_name, Path(__file__).absolute().with_name(_name + ".py"))
            _module = importlib.util.module_from_spec(_spec)
            sys.modules[_name] = _module
            _spec.loader.exec_module(_module)
    NativeTransport = sys.modules["transport"].NativeTransport
    BandwidthCancelled = sys.modules["bandwidth"].BandwidthCancelled
    PROCESS_BANDWIDTH = sys.modules["bandwidth"].PROCESS_BANDWIDTH
    TransferCancelled = sys.modules["transfer"].TransferCancelled
    download_file = sys.modules["transfer"].download_file

YT_DLP_VERSION = "2026.10.21"
EJS_VERSION = "0.8.0"
DENO_VERSION = "2.9.8"
FFMPEG_VERSION = "9.0.2-36-g6882969ce9"
QUALITIES = ("highest", "2160", "1440", "1080", "720", "480")
OUTPUTS = ("original", "mp4", "webm", "mkv", "mp3", "m4a")
MEDIA_EXTENSIONS = frozenset(("mp4", "m4v", "mov", "webm", "mkv", "avi", "mp3", "m4a", "aac", "flac", "ogg", "opus", "wav", "ts", "mpeg", "mpg"))
AUDIO_EXTENSIONS = frozenset(("mp3", "m4a", "aac", "flac", "ogg", "opus", "wav"))
MANIFEST_EXTENSIONS = frozenset(("m3u8", "mpd"))
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
JOB_ID = re.compile(r"[0-9a-f]{32}\Z")
_DEPENDENCY_LOCK = threading.Lock()


class EngineError(Exception):
    """A fixed, safe message that can be shown directly in the GUI."""


class DownloadCancelled(EngineError):
    pass


@dataclass(frozen=True)
class DownloadRequest:
    url: str
    folder: str | Path
    quality: str = "highest"
    output: str = "original"
    scan: bool = False
    job_id: str | None = None


@dataclass(frozen=True)
class DownloadProgress:
    stage: str
    percent: float | None = None
    downloaded: int = 0
    total: int | None = None
    speed: float | None = None
    eta: float | None = None
    title: str = ""
    filepath: str | None = None
    message: str = ""
    transport: str | None = None
    connections: int | None = None
    transfer_mode: str | None = None


@dataclass(frozen=True)
class DownloadResult:
    job_id: str
    title: str
    filepath: str
    status: str = "complete"
    message: str = ""


class _SilentLogger:
    # Extractor diagnostics can contain signed URLs and authentication details.
    def debug(self, _message): pass
    def warning(self, _message): pass
    def error(self, _message): pass


class _WindowsJob:
    """Attach a suspended child before it can launch Deno or another descendant."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self.ctypes = ctypes
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.ntdll = ctypes.WinDLL("ntdll")
        class Basic(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                        ("flags", wintypes.DWORD), ("minimum_working_set", ctypes.c_size_t),
                        ("maximum_working_set", ctypes.c_size_t), ("active_process_limit", wintypes.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
        class Counters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", Counters), ("process_memory", ctypes.c_size_t),
                        ("job_memory", ctypes.c_size_t), ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.SetInformationJobObject.restype = wintypes.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
        self.ntdll.NtResumeProcess.restype = ctypes.c_long
        self.handle = self.kernel.CreateJobObjectW(None, None)
        limit = Extended()
        limit.basic.flags = 0x2000
        if not self.handle or not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limit), ctypes.sizeof(limit)):
            self.close()
            raise EngineError("데스크톱 작업기를 격리하지 못했습니다. 앱을 다시 시작하세요.")

    def attach_and_resume(self, process):
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)) or self.ntdll.NtResumeProcess(int(process._handle)) != 0:
            raise EngineError("데스크톱 작업기를 격리하지 못했습니다. 앱을 다시 시작하세요.")

    def close(self):
        if getattr(self, "handle", None):
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def _check_cancel(cancel: threading.Event):
    if cancel.is_set():
        raise DownloadCancelled("다운로드를 취소했습니다.")


def _number(value) -> float | None:
    if type(value) in (float, int) and math.isfinite(value) and value >= 0:
        return value
    return None


def _title(value, fallback="Video") -> str:
    result = str(value) if isinstance(value, str) else fallback
    result = re.sub(r"https?://\S+", "[link]", result, flags=re.I)
    result = re.sub(r"(?i)\b(cookie|authorization|api[_-]?key|token|signature)\s*[:=]\s*\S+", r"\1=[redacted]", result)
    result = "".join(c for c in result if ord(c) >= 32 and ord(c) != 127)
    return result.strip()[:200] or fallback


def safe_filename(title: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", _title(title)).rstrip(" .")[:140].rstrip(" .")
    while len(name.encode("utf-8")) > 220:
        name = name[:-1]
    # A deceptive extension in a video title must not make the file look executable.
    name = re.sub(r"(?i)\.(exe|com|bat|cmd|msi|ps1|scr|pif|lnk|url|js|vbs)(?=\.|$)", r"_\1", name)
    if re.match(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", name):
        name = "_" + name
    return name or "Video"


def canonical_url(value: str) -> tuple[str, bool]:
    """Return (canonical source, is_youtube); never accept auth in a URL."""
    if not isinstance(value, str) or not 1 <= len(value) <= 16384 or any(ord(c) <= 32 or ord(c) == 127 for c in value) or "\\" in value:
        raise EngineError("올바른 YouTube 동영상 주소 또는 HTTP(S) 미디어 직접 주소를 입력하세요.")
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").lower().rstrip(".")
        if parts.scheme not in ("http", "https") or not host or parts.username is not None or parts.password is not None or parts.port == 0:
            raise ValueError()
        # Accessing .port above also rejects malformed ports.
        if any(c in unquote(parts.netloc) for c in ("\r", "\n", "\0")):
            raise ValueError()
        youtube = host in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be")
        if youtube:
            if parts.scheme != "https" or parts.port not in (None, 443):
                raise EngineError("HTTPS로 시작하는 YouTube 동영상 주소를 사용하세요.")
            query = parse_qs(parts.query, keep_blank_values=True)
            if "list" in query or "index" in query:
                raise EngineError("재생목록 정보가 없는 단일 YouTube 동영상 주소를 붙여 넣으세요.")
            if host in ("youtu.be", "www.youtu.be"):
                identifier = parts.path[1:] if parts.path.count("/") == 1 else ""
            elif parts.path == "/watch" and len(query.get("v", [])) == 1:
                identifier = query["v"][0]
            elif re.fullmatch(r"/(shorts|embed)/[^/]+/?", parts.path):
                identifier = parts.path.strip("/").split("/")[1]
            else:
                identifier = ""
            if not VIDEO_ID.fullmatch(identifier):
                raise EngineError("공개 YouTube 동영상 한 개의 주소를 붙여 넣으세요.")
            return "https://www.youtube.com/watch?v=" + identifier, True
        if host.endswith(".youtube.com") or host.endswith(".youtu.be") or host in ("youtube-nocookie.com", "www.youtube-nocookie.com"):
            raise EngineError("이 동영상의 공개 YouTube 시청 주소를 붙여 넣으세요.")
        # Fragments never identify an HTTP resource and may contain private data.
        return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, "")), False
    except (ValueError, TypeError):
        raise EngineError("올바른 YouTube 동영상 주소 또는 HTTP(S) 미디어 직접 주소를 입력하세요.") from None


def _public_source(url: str, youtube: bool) -> str:
    if youtube:
        return url
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _digest(url: str, folder: Path, quality: str, output: str) -> str:
    return hashlib.sha256(json.dumps([url, str(folder), quality, output], ensure_ascii=True).encode()).hexdigest()


def _trusted_file(path: Path, root: Path, *, executable=False) -> Path:
    """Only fixed bundled paths can be executed; reject links/reparse points."""
    try:
        path.relative_to(root)
        for current in (path, *path.parents):
            details = current.lstat()
            if stat.S_ISLNK(details.st_mode) or getattr(details, "st_file_attributes", 0) & 0x400:
                raise OSError()
            if current == root:
                break
        if not path.is_file():
            raise OSError()
        if executable:
            with path.open("rb") as source:
                if source.read(2) != b"MZ":
                    raise OSError()
        return path
    except (OSError, ValueError):
        raise EngineError("내장 실행 파일이 없거나 안전하지 않습니다. 데스크톱 ZIP 전체를 다시 압축 해제하세요.") from None


def _has_video(track: dict) -> bool:
    return track.get("vcodec") != "none" and track.get("ext") not in AUDIO_EXTENSIONS


def _has_audio(track: dict) -> bool:
    return track.get("acodec") != "none"


def _webm_video(track: dict) -> bool:
    codec = str(track.get("vcodec") or "").lower()
    return track.get("ext") == "webm" or codec.startswith(("vp8", "vp9", "vp0", "av01", "av1"))


def _mp4_video(track: dict) -> bool:
    codec = str(track.get("vcodec") or "").lower()
    return track.get("ext") in ("mp4", "m4v", "mov") or codec.startswith(("avc", "h264", "h265", "hev", "hvc", "av01", "av1", "mpeg4"))


def _audio_compatible(track: dict, container: str) -> bool:
    codec = str(track.get("acodec") or "").lower()
    if container == "webm":
        return codec.startswith(("opus", "vorbis")) or not codec and track.get("ext") in ("webm", "opus", "ogg")
    if container == "mp4":
        return codec.startswith(("mp4a", "aac", "alac", "ac3", "eac3")) or not codec and track.get("ext") in ("mp4", "m4a", "aac", "mov")
    return True


def _format_score(track: dict):
    return tuple(_number(track.get(key)) or 0 for key in ("height", "fps", "tbr", "vbr", "filesize"))


def choose_tracks(info: dict, quality: str, output: str) -> tuple[list[dict], str]:
    formats = info.get("formats") or ([info] if info.get("url") else [])
    usable = []
    for original in formats:
        if not isinstance(original, dict) or original.get("has_drm") not in (None, False) or original.get("cookies"):
            continue
        track = dict(original)
        ext = str(track.get("ext") or "").lower()
        if ext not in MEDIA_EXTENSIONS:
            continue
        try:
            _source, youtube = canonical_url(track.get("url"))
            if youtube:
                continue
        except EngineError:
            continue
        protocol = track.get("protocol") or ("http_dash_segments" if track.get("fragments") else urlsplit(track["url"]).scheme)
        if protocol not in ("http", "https", "m3u8", "m3u8_native", "http_dash_segments"):
            continue
        # Use the native HLS downloader, never ffmpeg's network downloader.
        track["protocol"] = "m3u8_native" if protocol == "m3u8" else protocol
        track["ext"] = ext
        track.setdefault("format_id", str(len(usable)))
        usable.append(track)
    if not usable:
        raise EngineError("이 주소에서 다운로드할 수 있는 공개·비암호화 미디어 형식을 찾지 못했습니다.")
    if output in ("mp3", "m4a"):
        audio = [track for track in usable if _has_audio(track)]
        if not audio:
            raise EngineError("이 미디어에는 오디오 트랙이 없습니다.")
        pure = [track for track in audio if not _has_video(track)]
        chosen = max(pure or audio, key=lambda track: (_number(track.get("abr")) or _number(track.get("tbr")) or 0, _number(track.get("asr")) or 0))
        return [chosen], output
    video = [track for track in usable if _has_video(track)]
    if output == "mp4":
        video = [track for track in video if _mp4_video(track) and (not _has_audio(track) or _audio_compatible(track, "mp4"))]
    elif output == "webm":
        video = [track for track in video if _webm_video(track) and (not _has_audio(track) or _audio_compatible(track, "webm"))]
    if quality != "highest":
        video = [track for track in video if not _number(track.get("height")) or track["height"] <= int(quality)]
    if not video:
        if output == "original" and not any(_has_video(track) for track in usable):
            chosen = max(usable, key=lambda track: _number(track.get("abr")) or _number(track.get("tbr")) or 0)
            return [chosen], chosen["ext"]
        raise EngineError("선택한 화질과 저장 형식에 맞는 영상이 없습니다. 원본 형식이나 더 높은 화질 상한을 선택하세요.")
    chosen = max(video, key=_format_score)
    container = output if output != "original" else (chosen["ext"] if chosen["ext"] in ("mp4", "webm", "mkv", "mov", "avi") else "mkv")
    tracks = [chosen]
    if not _has_audio(chosen):
        audio = [track for track in usable if not _has_video(track) and _has_audio(track)]
        compatible = [track for track in audio if _audio_compatible(track, container)]
        if not compatible and output == "original" and audio:
            container = "mkv"
            compatible = audio
        if not compatible:
            raise EngineError("호환되는 오디오 트랙이 없습니다. 원본 또는 MKV 형식을 선택하세요.")
        tracks.append(max(compatible, key=lambda track: (_number(track.get("abr")) or _number(track.get("tbr")) or 0, _number(track.get("asr")) or 0)))
    return tracks, container


def _media_signature(path: Path):
    try:
        with path.open("rb") as source:
            head = source.read(4096)
    except OSError:
        raise EngineError("다운로드한 미디어 파일을 읽지 못했습니다.") from None
    text = head.lstrip().lower()
    if not head or head.startswith((b"MZ", b"\x7fELF", b"#!")) or text.startswith((b"<", b"{", b"[", b"http/")):
        raise EngineError("서버가 오류 페이지나 미디어가 아닌 파일을 반환했습니다. 최종 파일은 저장하지 않았습니다.")
    media = (head.startswith((b"\x1aE\xdf\xa3", b"ID3", b"OggS", b"fLaC", b"RIFF", b"\x00\x00\x01"))
             or len(head) > 8 and head[4:8] in (b"ftyp", b"styp", b"moof", b"moov", b"free", b"wide", b"mdat")
             or len(head) > 1 and head[0] == 0xff and head[1] & 0xe0 == 0xe0
             or len(head) > 376 and head[0] == head[188] == head[376] == 0x47)
    if not media:
        raise EngineError("서버가 지원하지 않거나 올바르지 않은 미디어 파일을 반환했습니다. 최종 파일은 저장하지 않았습니다.")


class Engine:
    def __init__(self, app_root: str | Path, data_dir: str | Path | None = None, *, resources: ResourceBudget | None = None):
        self.app_root = Path(app_root).absolute()
        try:
            self.store = Storage(Path(data_dir) if data_dir is not None else None)
        except (OSError, RuntimeError) as error:
            raise EngineError("다운로드 기록을 준비하지 못했습니다. 현재 계정의 저장 공간 권한을 확인하세요.") from None
        self._active: set[str] = set()
        self._lock = threading.Lock()
        self._private_urls: dict[str, str] = {}
        self.resources = resources if resources is not None else PROCESS_RESOURCES
        self._settings_lock = threading.Lock()
        settings = self.store.settings()
        self._concurrency_setting = normalize_concurrency(settings.get("concurrent_downloads"))
        self._parallel_downloads = settings["parallel_downloads"]
        self._http3_enabled = settings["http3_enabled"]
        self._speed_limit_enabled = settings["speed_limit_enabled"]
        self._speed_limit_kib = settings["speed_limit_kib"]
        self.bandwidth = PROCESS_BANDWIDTH
        self.bandwidth.configure(self._speed_limit_enabled, self._speed_limit_kib)
        self._progress_local = threading.local()

    def history(self) -> list[dict]:
        return self.store.history()

    def settings(self) -> dict:
        return self.store.settings()

    def save_settings(self, values: dict):
        with self._settings_lock:
            self.store.save_settings(values)
            if "concurrent_downloads" in values:
                self._concurrency_setting = normalize_concurrency(values["concurrent_downloads"])
            if "parallel_downloads" in values:
                self._parallel_downloads = values["parallel_downloads"]
            if "http3_enabled" in values:
                self._http3_enabled = values["http3_enabled"]
            if "speed_limit_enabled" in values or "speed_limit_kib" in values:
                if "speed_limit_enabled" in values:
                    self._speed_limit_enabled = values["speed_limit_enabled"]
                if "speed_limit_kib" in values:
                    self._speed_limit_kib = values["speed_limit_kib"]
                self.bandwidth.configure(self._speed_limit_enabled, self._speed_limit_kib)

    @contextmanager
    def _resource(self, resource: str, cancel: threading.Event, units=1):
        """Expose an actual resource wait without changing persisted job state."""
        emit = getattr(self._progress_local, "emit", None)
        stage = getattr(self._progress_local, "stage", "queued")
        waiting = False
        labels = {"jobs": "다운로드", "metadata": "미디어 정보 확인", "network": "네트워크 다운로드",
                  "processing": "미디어 처리", "scan": "파일 검사"}

        def on_wait():
            nonlocal waiting
            waiting = True
            if emit is not None:
                emit("waiting", message=labels[resource] + " 순서를 기다리고 있습니다.")

        try:
            with self.resources.hold(resource, cancel, units, on_wait=on_wait):
                if waiting and emit is not None:
                    emit(stage, message=labels[resource] + " 작업을 시작합니다.")
                yield
        except ResourceCancelled:
            raise DownloadCancelled("다운로드를 취소했습니다.") from None

    def _fragment_workers(self, track: dict) -> int:
        if track.get("protocol") not in ("m3u8", "m3u8_native", "http_dash_segments"):
            return 1
        with self._settings_lock:
            workers = fragment_parallelism(self._concurrency_setting)
        # A smaller injected budget is useful for deterministic local checks.
        return min(workers, self.resources.capacities["network"])

    def remove_history(self, job_id: str):
        self.store.remove(job_id)
        self._private_urls.pop(job_id, None)

    def retry_request(self, job_id: str) -> DownloadRequest:
        job = self.store.get(job_id)
        if not job or job["stage"] not in ("error", "cancelled"):
            raise EngineError("실패하거나 취소된 다운로드만 다시 시도할 수 있습니다.")
        url = self._private_urls.get(job_id, job["url"])
        if job["requires_url"] and job_id not in self._private_urls:
            raise EngineError("새 미디어 직접 주소를 붙여 넣어 다시 시도하세요. 비공개 주소 매개변수는 저장하지 않았습니다.")
        return DownloadRequest(url, job["folder"], job["quality"], job["output"], bool(job["scan"]), job_id)

    def _validate_request(self, request: DownloadRequest) -> tuple[str, bool, Path, str]:
        if not isinstance(request, DownloadRequest) or request.quality not in QUALITIES or request.output not in OUTPUTS or type(request.scan) is not bool:
            raise EngineError("지원하는 다운로드 화질과 저장 형식을 선택하세요.")
        url, youtube = canonical_url(request.url)
        try:
            folder = Path(request.folder).expanduser()
            if not folder.is_absolute() or not folder.is_dir():
                raise OSError()
            folder = folder.resolve(strict=True)
        except (OSError, TypeError, ValueError):
            raise EngineError("실제로 존재하는 저장 폴더의 전체 경로를 선택하세요.") from None
        if request.job_id is not None and (not isinstance(request.job_id, str) or not JOB_ID.fullmatch(request.job_id)):
            raise EngineError("다운로드 기록 식별자가 올바르지 않습니다.")
        return url, youtube, folder, _digest(url, folder, request.quality, request.output)

    def _dependencies(self, youtube: bool, cancel: threading.Event):
        _check_cancel(cancel)
        try:
            if importlib.metadata.version("yt-dlp") != YT_DLP_VERSION or importlib.metadata.version("yt-dlp-ejs") != EJS_VERSION:
                raise EngineError("내장 다운로더 버전이 일치하지 않습니다. 데스크톱 ZIP 전체를 다시 압축 해제하세요.")
            with _DEPENDENCY_LOCK:
                import yt_dlp
                from yt_dlp.globals import plugin_dirs
                plugin_dirs.value = []
        except (ImportError, importlib.metadata.PackageNotFoundError):
            raise EngineError("내장 다운로더가 없습니다. 데스크톱 ZIP 전체를 다시 압축 해제하세요.") from None
        package = Path(yt_dlp.__file__).absolute()
        _trusted_file(package, self.app_root / "runtime" / "python" / "Lib" / "site-packages")
        deno = self.app_root / "runtime" / "deno.exe"
        if youtube:
            _trusted_file(deno, self.app_root, executable=True)
            output = self._run([str(deno), "--version"], cancel, timeout=8, limit=4096)
            if not re.match(rb"deno " + re.escape(DENO_VERSION.encode()) + rb"(?:\s|$)", output):
                raise EngineError("내장 JavaScript 실행기 버전이 일치하지 않습니다. 데스크톱 ZIP 전체를 다시 압축 해제하세요.")
        ffmpeg = _trusted_file(self.app_root / "runtime" / "ffmpeg" / "ffmpeg.exe", self.app_root, executable=True)
        ffprobe = _trusted_file(self.app_root / "runtime" / "ffmpeg" / "ffprobe.exe", self.app_root, executable=True)
        for executable, name in ((ffmpeg, b"ffmpeg"), (ffprobe, b"ffprobe")):
            version = self._run([str(executable), "-version"], cancel, timeout=8, limit=16384)
            if not re.match(name + rb" version n?" + re.escape(FFMPEG_VERSION.encode()) + rb"(?:[-\s]|$)", version):
                raise EngineError("내장 미디어 실행기 버전이 일치하지 않습니다. 데스크톱 ZIP 전체를 다시 압축 해제하세요.")
        return yt_dlp, deno, ffmpeg, ffprobe

    def _options(self, deno: Path, progress=None, *, fragment_workers: int = 1,
                 cancel: threading.Event | None = None) -> dict:
        def retry_sleep(attempt):
            delay = min(8, 2 ** max(0, min(3, attempt - 1)))
            if cancel is None:
                return delay
            if cancel.wait(delay):
                raise DownloadCancelled("다운로드를 취소했습니다.")
            # The delay already elapsed through the cancellable event; yt-dlp
            # must not sleep for it a second time.
            return 0

        return {"quiet": True, "no_warnings": True, "logger": _SilentLogger(), "noplaylist": True,
                "ignoreconfig": True, "cachedir": False, "cookiefile": None, "cookiesfrombrowser": None,
                "usenetrc": False, "netrc_location": None, "username": None, "password": None,
                "videopassword": None, "ap_mso": None, "client_certificate": None,
                "remote_components": [], "plugin_dirs": [], "js_runtimes": {"deno": {"path": str(deno)}},
                "ffmpeg_location": str(self.app_root / "runtime" / "ffmpeg"),
                "progress_hooks": [progress] if progress is not None else [],
                "socket_timeout": 15, "retries": 3, "fragment_retries": 3, "extractor_retries": 2,
                "retry_sleep_functions": {kind: retry_sleep for kind in ("http", "fragment", "extractor")},
                "concurrent_fragment_downloads": fragment_workers, "continuedl": True, "nopart": False,
                "overwrites": False, "keep_fragments": False, "skip_unavailable_fragments": False,
                "hls_prefer_native": True, "allow_unplayable_formats": False,
                "geo_bypass": False, "mark_watched": False, "windowsfilenames": True,
                "writethumbnail": False, "writeinfojson": False, "writesubtitles": False,
                "extractor_args": {"youtube": {"fetch_pot": ["never"]}, "youtube-ejs": {"jitless": ["true"]}}}

    def _extract(self, downloader, url: str, youtube: bool, cancel: threading.Event) -> dict:
        current = url
        for _ in range(6):
            _check_cancel(cancel)
            info = downloader.extract_info(current, download=False, process=False, ie_key="Youtube" if youtube else "Generic")
            _check_cancel(cancel)
            if not isinstance(info, dict):
                raise EngineError("원본에서 사용할 수 있는 동영상 정보를 받지 못했습니다.")
            if not youtube and info.get("_type") == "url" and info.get("ie_key") in (None, "Generic"):
                current, redirected_youtube = canonical_url(info.get("url"))
                if redirected_youtube:
                    raise EngineError("이 동영상의 공개 YouTube 시청 주소를 붙여 넣으세요.")
                continue
            break
        else:
            raise EngineError("미디어 주소의 리디렉션 횟수가 너무 많습니다.")
        if (info.get("_type", "video") != "video" or info.get("entries") is not None
                or info.get("is_live") or info.get("live_status") not in (None, "not_live", "was_live")
                or info.get("availability") not in (None, "public", "unlisted")
                or (_number(info.get("age_limit")) or 0) > 0
                or info.get("has_drm") not in (None, False)):
            raise EngineError("공개된 비암호화 영상만 지원합니다. 라이브·제한 영상·재생목록은 다운로드할 수 없습니다.")
        formats = info.get("formats") or ([info] if info.get("url") else [])
        if not isinstance(formats, list) or len(formats) > 8192:
            raise EngineError("원본이 올바르지 않은 미디어 정보를 반환했습니다.")
        if youtube:
            if info.get("id") != urlsplit(url).query.removeprefix("v="):
                raise EngineError("원본이 요청과 다른 YouTube 동영상을 반환했습니다.")
        else:
            manifest = any(isinstance(track, dict) and track.get("manifest_url") == current for track in formats)
            if info.get("direct") is not True and not manifest:
                raise EngineError("웹 페이지 주소입니다. 동영상·오디오·HLS·DASH 미디어 직접 주소를 붙여 넣으세요.")
        info["title"] = _title(info.get("title"), "YouTube video" if youtube else "Media")
        return info

    def get_info(self, request: DownloadRequest, cancel: threading.Event | None = None) -> dict:
        cancel = cancel or threading.Event()
        url, youtube, _folder, _request_digest = self._validate_request(request)
        try:
            with self._resource("metadata", cancel):
                self._dependencies(youtube, cancel)
                info = self._extract_isolated(url, youtube, request.quality, request.output, cancel)
            tracks, container = choose_tracks(info, request.quality, request.output)
            return {"title": info["title"], "duration": _number(info.get("duration")), "container": container,
                    "formats": [{key: track.get(key) for key in ("format_id", "ext", "height", "vcodec", "acodec", "filesize")} for track in tracks]}
        except EngineError:
            raise
        except Exception:
            _check_cancel(cancel)
            raise EngineError("공개 미디어 정보를 읽지 못했습니다. 주소와 인터넷 연결을 확인하세요. 제한된 영상은 지원하지 않습니다.") from None

    def _extract_isolated(self, url: str, youtube: bool, quality: str, output: str, cancel: threading.Event) -> dict:
        python = _trusted_file(self.app_root / "runtime" / "python" / "python.exe", self.app_root, executable=True)
        script = _trusted_file(self.app_root / "desktop" / "engine.py", self.app_root)
        payload = json.dumps({"url": url, "youtube": youtube, "quality": quality, "output": output}, ensure_ascii=True).encode()
        result = self._run([str(python), "-I", "-B", str(script), "--extract-worker"], cancel,
                           payload=payload, timeout=180, limit=32 * 1024 * 1024)
        try:
            info = json.loads(result)
            if not isinstance(info, dict):
                raise ValueError()
            if set(info) == {"error"} and isinstance(info["error"], str):
                # Only our bundled worker emits this field, never an extractor diagnostic.
                raise EngineError(info["error"])
            if (not {"id", "title", "formats"} <= set(info) or not isinstance(info["title"], str)
                    or not isinstance(info["formats"], list) or not 1 <= len(info["formats"]) <= 2):
                raise ValueError()
            if youtube and info["id"] != urlsplit(url).query.removeprefix("v="):
                raise ValueError()
            info["title"] = _title(info["title"])
            choose_tracks(info, quality, output)
            return info
        except (ValueError, TypeError, UnicodeError):
            raise EngineError("데스크톱 작업기가 올바르지 않은 미디어 정보를 반환했습니다.") from None

    def _run(self, arguments: list[str], cancel: threading.Event, *, payload: bytes | None = None,
             timeout: float | None = None, limit=1024 * 1024) -> bytes:
        """Drain child output while polling cancellation; never run a shell or print diagnostics."""
        _check_cancel(cancel)
        process = None
        chunks = bytearray()
        overflow = threading.Event()
        reader = None
        job = _WindowsJob() if os.name == "nt" else None
        try:
            process = subprocess.Popen(arguments, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, shell=False,
                                       start_new_session=os.name != "nt",
                                       creationflags=(0x08000000 | 0x4) if os.name == "nt" else 0)
            if job is not None:
                job.attach_and_resume(process)
            def collect():
                try:
                    while block := process.stdout.read(4096):
                        if len(chunks) + len(block) <= limit:
                            chunks.extend(block)
                        else:
                            overflow.set()
                except OSError:
                    overflow.set()
            reader = threading.Thread(target=collect, daemon=True)
            reader.start()
            if payload is not None:
                process.stdin.write(payload)
                process.stdin.close()
            deadline = time.monotonic() + timeout if timeout is not None else None
            while process.poll() is None:
                _check_cancel(cancel)
                if overflow.is_set() or deadline is not None and time.monotonic() >= deadline:
                    raise EngineError("내장 미디어 작업이 정상적으로 끝나지 않았습니다.")
                cancel.wait(0.05)
            reader.join(2)
            _check_cancel(cancel)
            if reader.is_alive() or overflow.is_set() or process.returncode:
                raise EngineError("내장 미디어 실행기가 이 파일을 처리하지 못했습니다.")
            return bytes(chunks)
        except OSError:
            raise EngineError("내장 미디어 실행기를 시작하지 못했습니다.") from None
        finally:
            if job is not None:
                job.close()
            if process is not None:
                if process.poll() is None:
                    if os.name != "nt":
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    else:
                        process.kill()
                process.wait()
                if process.stdin is not None and not process.stdin.closed:
                    process.stdin.close()
                if reader is not None:
                    reader.join(2)
                if process.stdout is not None:
                    process.stdout.close()

    def _probe(self, path: Path, ffprobe: Path, cancel: threading.Event):
        _media_signature(path)
        payload = self._run([str(ffprobe), "-v", "error", "-threads", str(FFMPEG_THREADS), "-protocol_whitelist", "file,pipe", "-show_entries",
                             "format=format_name:stream=codec_type", "-of", "json", str(path)], cancel, timeout=60)
        try:
            info = json.loads(payload)
            if not any(stream.get("codec_type") in ("video", "audio") for stream in info.get("streams", [])):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise EngineError("다운로드한 파일에 올바른 영상이나 오디오가 없습니다. 최종 파일은 저장하지 않았습니다.") from None

    def _process(self, sources: list[Path], tracks: list[dict], destination: Path, output: str,
                 ffmpeg: Path, cancel: threading.Event):
        arguments = [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
                     "-filter_threads", str(FFMPEG_THREADS), "-filter_complex_threads", str(FFMPEG_THREADS)]
        for source in sources:
            arguments.extend(["-threads", str(FFMPEG_THREADS), "-protocol_whitelist", "file,pipe", "-i", str(source)])
        if output in ("mp3", "m4a"):
            arguments.extend(["-map", "0:a:0", "-vn", "-c:a", "libmp3lame" if output == "mp3" else "aac", "-b:a", "192k"])
        else:
            if len(sources) == 2:
                arguments.extend(["-map", "0:v:0", "-map", "1:a:0"])
            elif _has_video(tracks[0]):
                arguments.extend(["-map", "0:v:0", "-map", "0:a:0?"])
            else:
                arguments.extend(["-map", "0:a:0"])
            arguments.extend(["-c", "copy"])
        arguments.extend(["-threads", str(FFMPEG_THREADS), "-map_metadata", "-1", "-map_chapters", "-1", str(destination)])
        self._run(arguments, cancel)

    def _owned_directory(self, folder: Path, job_id: str, request_digest: str) -> Path:
        directory = folder / (".myvideoapp-" + job_id + ".tmp")
        marker = directory / "owner.json"
        try:
            if directory.exists() or directory.is_symlink():
                if directory.is_symlink() or getattr(directory.lstat(), "st_file_attributes", 0) & 0x400:
                    raise ValueError()
                if marker.is_symlink() or not marker.is_file() or marker.stat().st_size > 32768:
                    raise ValueError()
                owner = json.loads(marker.read_text(encoding="utf-8"))
                if owner.get("job_id") != job_id or owner.get("request_digest") != request_digest:
                    raise ValueError()
            else:
                directory.mkdir(mode=0o700)
                marker.write_text(json.dumps({"job_id": job_id, "request_digest": request_digest}), encoding="utf-8")
            return directory
        except (OSError, ValueError, TypeError):
            raise EngineError("임시 다운로드 폴더를 사용할 수 없거나 다른 작업이 소유하고 있습니다. 다른 저장 폴더를 선택하세요.") from None

    def _clean_owned(self, directory: Path, job_id: str, request_digest: str, *, remove=False):
        # Never recurse, follow links or delete a file outside this exact owned directory.
        try:
            if self._owned_directory(directory.parent, job_id, request_digest) != directory:
                return
            for path in directory.iterdir():
                owned_name = (path.name == "selection.json" or re.fullmatch(r"(?:source-\d+|finished)\.[a-z0-9]+(?:\.part(?:-Frag\d+)?)?(?:\.ytdl)?", path.name))
                if owned_name and path.is_file() and not path.is_symlink() and not getattr(path.lstat(), "st_file_attributes", 0) & 0x400:
                    path.unlink()
            if remove and set(path.name for path in directory.iterdir()) == {"owner.json"}:
                (directory / "owner.json").unlink()
                directory.rmdir()
        except (OSError, EngineError):
            pass

    def _publish(self, source: Path, folder: Path, title: str, extension: str) -> Path:
        stem = safe_filename(title)
        for index in range(1, 100001):
            target = folder / (stem + (f" ({index})" if index > 1 else "") + "." + extension)
            try:
                if os.name == "nt":
                    # Windows rename refuses an existing destination, including empty files.
                    os.rename(source, target)
                else:
                    os.link(source, target)
                    source.unlink()
                return target
            except FileExistsError:
                continue
            except OSError:
                raise EngineError("완성된 파일을 저장하지 못했습니다. 저장 폴더 권한과 남은 공간을 확인하세요.") from None
        raise EngineError("같은 이름의 파일이 너무 많습니다. 다른 저장 폴더를 선택하세요.")

    def _scan(self, path: Path, cancel: threading.Event) -> str:
        if os.name != "nt":
            return "저장했습니다. Microsoft Defender 검사는 Windows에서 사용할 수 있습니다."
        defender = Path(r"C:\Program Files\Windows Defender\MpCmdRun.exe")
        try:
            _trusted_file(defender, Path(r"C:\Program Files\Windows Defender"), executable=True)
        except EngineError:
            return "저장했습니다. Microsoft Defender를 실행할 수 없어 검사하지 못했습니다. Windows 보안에서 파일을 검사하세요."
        try:
            self._run([str(defender), "-Scan", "-ScanType", "3", "-File", str(path)], cancel, timeout=600, limit=65536)
        except DownloadCancelled:
            raise
        except EngineError:
            raise EngineError("파일은 다운로드했지만 Microsoft Defender 검사 결과를 확인하지 못했습니다. 열기 전에 Windows 보안을 확인하세요.") from None
        return "저장하고 Microsoft Defender 검사를 마쳤습니다."

    def download(self, request: DownloadRequest, progress: Callable[[DownloadProgress], None],
                 cancel: threading.Event) -> DownloadResult:
        url, youtube, folder, request_digest = self._validate_request(request)
        job_id = request.job_id or uuid.uuid4().hex
        title = ""
        directory = None
        leases = ExitStack()
        published = None
        native_transport = None
        transfer_fields = {"transport": None, "connections": None, "transfer_mode": None}
        observed_protocols: set[str] = set()
        parallel_connections = 0
        progress_lock = threading.RLock()
        with self._lock:
            if job_id in self._active:
                raise EngineError("이 다운로드는 이미 진행 중입니다.")
            previous = self.store.get(job_id)
            if previous is not None:
                if previous["stage"] not in ("error", "cancelled") or previous["request_digest"] != request_digest:
                    raise EngineError("원래 다운로드와 다른 요청입니다. 새 다운로드로 추가하세요.")
                self.store.update(job_id, stage="queued", message="", filepath=None)
            else:
                self.store.insert({"job_id": job_id, "url": _public_source(url, youtube), "folder": str(folder),
                                   "quality": request.quality, "output": request.output, "stage": "queued",
                                   "requires_url": int(not youtube and bool(urlsplit(url).query)),
                                   "request_digest": request_digest, "scan": int(request.scan)})
            self._active.add(job_id)
            self._private_urls[job_id] = url

        def emit(stage, **fields):
            with progress_lock:
                if stage != "waiting":
                    self._progress_local.stage = stage
                progress(DownloadProgress(stage=stage, title=title, **{**transfer_fields, **fields}))

        self._progress_local.emit = emit
        try:
            emit("queued", message="시작을 기다리고 있습니다.")
            leases.enter_context(self._resource("jobs", cancel))
            directory = self._owned_directory(folder, job_id, request_digest)
            self.store.update(job_id, stage="downloading")
            emit("downloading", message="공개 미디어 정보를 확인하고 있습니다.")
            completed_bytes = 0
            track_index = 0
            tracks = []
            totals: list[int | None] = []
            legacy_downloaded = 0

            def hook(value, *, charge_bandwidth=True):
                nonlocal legacy_downloaded
                with progress_lock:
                    _check_cancel(cancel)
                    downloaded_value = _number(value.get("downloaded_bytes"))
                    downloaded = int(downloaded_value if downloaded_value is not None else _number(value.get("total_bytes")) or 0)
                    if charge_bandwidth:
                        delta = max(0, downloaded - legacy_downloaded)
                        legacy_downloaded = max(legacy_downloaded, downloaded)
                        try:
                            if delta:
                                self.bandwidth.consume(delta, cancel)
                        except BandwidthCancelled:
                            raise DownloadCancelled("다운로드를 취소했습니다.") from None
                    current_total = _number(value.get("total_bytes")) or _number(value.get("total_bytes_estimate"))
                    if current_total:
                        totals[track_index] = int(current_total)
                    total = sum(totals) if totals and all(item is not None for item in totals) else None
                    overall = completed_bytes + downloaded
                    percent = min(100.0, overall / total * 100) if total else None
                    emit("downloading", percent=percent, downloaded=overall, total=total,
                         speed=_number(value.get("speed")), eta=_number(value.get("eta")), message="미디어를 다운로드하고 있습니다.")

            def negotiated(protocol):
                # Only values reported by a completed protocol negotiation may
                # enter progress or history; settings never imply HTTP/3 use.
                if protocol in ("h3", "h2", "http/1.1"):
                    with progress_lock:
                        observed_protocols.add(protocol)
                        transfer_fields["transport"] = protocol

            def transfer_mode(mode):
                if mode in ("parallel", "single"):
                    with progress_lock:
                        transfer_fields["transfer_mode"] = mode

            def connections(count):
                nonlocal parallel_connections
                if type(count) is int and 1 <= count <= 4:
                    with progress_lock:
                        transfer_fields["connections"] = count
                        parallel_connections = max(parallel_connections, count)

            with self._resource("metadata", cancel):
                module, deno, ffmpeg, ffprobe = self._dependencies(youtube, cancel)
                info = self._extract_isolated(url, youtube, request.quality, request.output, cancel)
            title = info["title"]
            self.store.update(job_id, title=title)
            tracks, container = choose_tracks(info, request.quality, request.output)
            totals = [int(size) if (size := _number(track.get("filesize"))) else None for track in tracks]
            # Resume only the same immutable YouTube video and selected format identities.
            identity = [{key: track.get(key) for key in ("format_id", "ext", "filesize")} for track in tracks]
            fingerprint = hashlib.sha256(json.dumps([info.get("id"), identity], sort_keys=True).encode()).hexdigest()
            identity_path = directory / "selection.json"
            resume = False
            if youtube and identity_path.is_file() and not identity_path.is_symlink():
                try:
                    resume = identity_path.read_text(encoding="ascii") == fingerprint
                except OSError:
                    pass
            if not resume:
                self._clean_owned(directory, job_id, request_digest)
            identity_path.write_text(fingerprint, encoding="ascii")
            sources = []
            for track_index, track in enumerate(tracks):
                _check_cancel(cancel)
                path = directory / f"source-{track_index}.{track['ext']}"
                # __postprocessors, webpage data and metadata are deliberately not handed to dl().
                item = {**track, "id": info.get("id", job_id), "title": title,
                        "http_headers": track.get("http_headers") or info.get("http_headers") or {}}
                direct = track.get("protocol") in ("http", "https") and not track.get("fragments")
                # Preserve the old downloader's resumable layout. The native
                # transfer owns only files it creates exclusively for this run.
                legacy_resume = resume and (os.path.lexists(path) or os.path.lexists(str(path) + ".part"))
                if legacy_resume:
                    for existing in (path, Path(str(path) + ".part")):
                        if os.path.lexists(existing):
                            attributes = existing.lstat()
                            if not stat.S_ISREG(attributes.st_mode) or getattr(attributes, "st_file_attributes", 0) & 0x400:
                                raise EngineError("임시 다운로드 파일이 안전하지 않습니다. 다른 저장 폴더를 선택하세요.")
                if direct and not legacy_resume:
                    with self._settings_lock:
                        workers = min(4, self.resources.capacities["network"]) if self._parallel_downloads else 1
                        http3_enabled = self._http3_enabled
                    if native_transport is None:
                        native_transport = leases.enter_context(NativeTransport(http3_enabled=http3_enabled, max_connections=4,
                                                                              bandwidth_limiter=self.bandwidth))
                    started = time.monotonic()

                    def native_progress(downloaded, total):
                        elapsed = time.monotonic() - started
                        speed = downloaded / elapsed if elapsed > 0 else None
                        hook({"downloaded_bytes": downloaded, "total_bytes": total, "speed": speed,
                              "eta": (total - downloaded) / speed if total and speed else None}, charge_bandwidth=False)

                    try:
                        download_file(track["url"], path, transport=native_transport, resources=self.resources,
                                      cancel=cancel, workers=workers, headers=item["http_headers"], progress=native_progress,
                                      protocol=negotiated, mode=transfer_mode, connections=connections,
                                      on_wait=lambda: emit("waiting", message="네트워크 다운로드 순서를 기다리고 있습니다."))
                    except TransferCancelled:
                        raise DownloadCancelled("다운로드를 취소했습니다.") from None
                    success = True
                else:
                    with progress_lock:
                        transfer_fields.update(transport=None, connections=None, transfer_mode=None)
                    workers = self._fragment_workers(track)
                    legacy_downloaded = path.stat().st_size if path.is_file() else 0
                    if legacy_resume and not legacy_downloaded:
                        partial = Path(str(path) + ".part")
                        if partial.is_file():
                            legacy_downloaded = partial.stat().st_size
                    with self._resource("network", cancel, workers):
                        with module.YoutubeDL(self._options(deno, hook, fragment_workers=workers, cancel=cancel)) as downloader:
                            success = downloader.dl(str(path), item)
                if not (success[0] if isinstance(success, tuple) else success) or not path.is_file() or path.is_symlink():
                    raise EngineError("다운로드가 끝나지 않았습니다. 다시 시도하면 새 원본을 확인하고 안전하게 이어받습니다.")
                with self._resource("processing", cancel):
                    self._probe(path, ffprobe, cancel)
                completed_bytes += path.stat().st_size
                totals[track_index] = path.stat().st_size
                sources.append(path)
            _check_cancel(cancel)
            self.store.update(job_id, stage="processing")
            emit("processing", downloaded=completed_bytes, total=completed_bytes, message="오디오를 변환하고 있습니다." if request.output in ("mp3", "m4a") else "미디어 저장 형식을 준비하고 있습니다.")
            prepared = directory / ("finished." + container)
            if prepared.exists():
                if prepared.is_symlink() or not prepared.is_file():
                    raise EngineError("임시 출력 파일이 안전하지 않습니다. 다른 저장 폴더를 선택하세요.")
                prepared.unlink()
            with self._resource("processing", cancel):
                self._process(sources, tracks, prepared, request.output, ffmpeg, cancel)
                self._probe(prepared, ffprobe, cancel)
            _check_cancel(cancel)
            published = self._publish(prepared, folder, title, container)
            self.store.update(job_id, filepath=str(published))
            message = "저장했습니다."
            if request.scan:
                emit("scanning", filepath=str(published), message="Microsoft Defender로 저장한 파일을 검사하고 있습니다.")
                with self._resource("scan", cancel):
                    message = self._scan(published, cancel)
            if observed_protocols:
                names = {"h3": "HTTP/3", "h2": "HTTP/2", "http/1.1": "HTTP/1.1"}
                summary = " · ".join(names[value] for value in ("h3", "h2", "http/1.1") if value in observed_protocols)
                if parallel_connections > 1:
                    summary += f" · 파일당 최대 {parallel_connections}개 병렬 요청"
                message += " " + summary + "."
            self.store.update(job_id, stage="complete", filepath=str(published), message=message)
            self._clean_owned(directory, job_id, request_digest, remove=True)
            emit("complete", percent=100.0, downloaded=completed_bytes, total=completed_bytes, filepath=str(published), message=message)
            return DownloadResult(job_id, title, str(published), message=message)
        except DownloadCancelled:
            message = "다운로드를 취소했습니다." if published is None else "검사를 취소했습니다. 다운로드한 파일은 저장 폴더에 남아 있습니다."
            self.store.update(job_id, stage="cancelled", message=message)
            if directory is not None:
                self._clean_owned(directory, job_id, request_digest, remove=True)
            emit("cancelled", filepath=str(published) if published else None, message=message)
            raise DownloadCancelled(message) from None
        except Exception as error:
            if cancel.is_set():
                message = "다운로드를 취소했습니다."
                self.store.update(job_id, stage="cancelled", message=message)
                if directory is not None:
                    self._clean_owned(directory, job_id, request_digest, remove=True)
                emit("cancelled", message=message)
                raise DownloadCancelled(message) from None
            message = str(error) if isinstance(error, EngineError) else "다운로드에 실패했습니다. 공개 주소, 인터넷 연결, 남은 저장 공간을 확인하고 다시 시도하세요."
            self.store.update(job_id, stage="error", message=message)
            emit("error", filepath=str(published) if published else None, message=message)
            raise EngineError(message) from None
        finally:
            leases.close()
            self._progress_local.__dict__.clear()
            with self._lock:
                self._active.discard(job_id)


def _extract_worker() -> int:
    """Isolated metadata-only process; its entire Deno tree belongs to the parent job."""
    import contextlib
    result = None
    try:
        payload = sys.stdin.buffer.read(65537)
        if len(payload) > 65536:
            raise EngineError("미디어 주소가 너무 깁니다.")
        request = json.loads(payload)
        if (not isinstance(request, dict) or set(request) != {"url", "youtube", "quality", "output"}
                or request["quality"] not in QUALITIES or request["output"] not in OUTPUTS):
            raise EngineError("데스크톱 작업 요청이 올바르지 않습니다.")
        url, youtube = canonical_url(request["url"])
        if type(request["youtube"]) is not bool or youtube != request["youtube"]:
            raise EngineError("데스크톱 작업 요청이 올바르지 않습니다.")
        # Do not create a second database or mark the parent's active job interrupted.
        engine = object.__new__(Engine)
        engine.app_root = Path(__file__).absolute().parent.parent
        import yt_dlp
        from yt_dlp.globals import plugin_dirs
        plugin_dirs.value = []
        if importlib.metadata.version("yt-dlp") != YT_DLP_VERSION or importlib.metadata.version("yt-dlp-ejs") != EJS_VERSION:
            raise EngineError("내장 다운로더 버전이 일치하지 않습니다. 데스크톱 ZIP 전체를 다시 압축 해제하세요.")
        _trusted_file(Path(yt_dlp.__file__).absolute(), engine.app_root / "runtime" / "python" / "Lib" / "site-packages")
        # Any incidental console output is discarded; stdout is a JSON-only pipe.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with yt_dlp.YoutubeDL(engine._options(engine.app_root / "runtime" / "deno.exe")) as downloader:
                info = engine._extract(downloader, url, youtube, threading.Event())
                tracks, _container = choose_tracks(info, request["quality"], request["output"])
                result = downloader.sanitize_info({"id": info.get("id"), "title": info["title"],
                                                   "duration": info.get("duration"), "http_headers": info.get("http_headers"),
                                                   "formats": tracks}, remove_private_keys=True)
    except EngineError as error:
        result = {"error": str(error)}
    except Exception:
        result = {"error": "공개 미디어 정보를 읽지 못했습니다. 주소와 인터넷 연결을 확인하세요. 제한된 영상은 지원하지 않습니다."}
    sys.__stdout__.buffer.write(json.dumps(result, ensure_ascii=True, allow_nan=False).encode())
    sys.__stdout__.buffer.flush()
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--extract-worker"]:
        raise SystemExit(_extract_worker())
    raise SystemExit("Launch the desktop application with desktop/main.py.")
