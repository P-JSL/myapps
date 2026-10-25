#!/usr/bin/env python3
"""Single-request, resolver-only native host. Media bytes stay in Chrome."""
from __future__ import annotations

import ctypes
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import struct
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit

VERSION = "2026.10.21"
EJS_VERSION = "0.8.0"
MAX_MESSAGE = 64 * 1024
MAX_CHILD_OUTPUT = 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
EXTRACTION_TIMEOUT = 120
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
REQUEST_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
QUALITIES = ("highest", "2160", "1080", "720", "480")
OUTPUTS = ("original", "mp3", "m4a")


class HostError(Exception):
    """Only these fixed messages may cross the native messaging boundary."""


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def decode_json(data):
    return json.loads(data.decode("utf-8"), object_pairs_hook=object_pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))


def youtube_url(value):
    if not isinstance(value, str) or len(value) > 256 or not value.isascii():
        raise HostError("유튜브 동영상 주소가 올바르지 않습니다.")
    try:
        parts = urlsplit(value)
        query = parse_qs(parts.query, strict_parsing=True)
        video_id = query.get("v", [None])[0]
        if (parts.scheme != "https" or parts.netloc != "www.youtube.com"
                or parts.path != "/watch" or parts.fragment
                or set(query) != {"v"} or len(query["v"]) != 1
                or not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id)):
            raise ValueError("Not a canonical single-video URL")
        return "https://www.youtube.com/watch?v=" + video_id, video_id
    except (ValueError, TypeError):
        raise HostError("유튜브 동영상 주소가 올바르지 않습니다.") from None


def request(value):
    if not isinstance(value, dict):
        raise HostError("유튜브 도우미 요청 형식이 올바르지 않습니다.")
    common = {"version", "requestId", "action"}
    if (type(value.get("version")) is not int or value["version"] != 1
            or not isinstance(value.get("requestId"), str)
            or not REQUEST_ID.fullmatch(value["requestId"])):
        raise HostError("유튜브 도우미 요청 식별자가 올바르지 않습니다.")
    if value.get("action") == "status" and set(value) == common:
        return dict(value)
    if value.get("action") != "resolve" or set(value) != common | {"url", "quality", "output", "userAgent"}:
        raise HostError("지원하지 않는 유튜브 도우미 요청입니다.")
    if value["quality"] not in QUALITIES or value["output"] not in OUTPUTS:
        raise HostError("유튜브 화질 또는 저장 형식이 올바르지 않습니다.")
    agent = value["userAgent"]
    if not isinstance(agent, str) or not 1 <= len(agent) <= 512 or any(not 32 <= ord(c) <= 126 for c in agent):
        raise HostError("브라우저 연결 정보가 올바르지 않습니다.")
    canonical, _ = youtube_url(value["url"])
    return {**value, "url": canonical}


def _safe_file(path, *, private=False, executable=False):
    if not isinstance(path, Path) or not path.is_absolute():
        raise HostError("유튜브 도우미의 로컬 파일 경로를 확인하세요.")
    try:
        for parent in (path, *path.parents):
            info = parent.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("Symbolic link or reparse point")
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or (executable and os.name != "nt" and not os.access(path, os.X_OK)):
            raise ValueError("Not a regular executable/file")
        if private and os.name != "nt" and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
            raise ValueError("Untrusted private file")
        if executable and os.name != "nt":
            if info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022:
                raise ValueError("Executable writable by another account")
            for parent in path.parents:
                directory = parent.lstat()
                trusted_sticky = directory.st_mode & stat.S_ISVTX and directory.st_uid in (0, os.getuid())
                if directory.st_mode & 0o022 and not trusted_sticky:
                    raise ValueError("Executable replaceable through its parent")
        return info
    except (OSError, ValueError):
        raise HostError("유튜브 도우미의 파일 권한과 설치 상태를 확인하세요.") from None


def configuration():
    path = Path(__file__).absolute().with_name("youtube-config.json")
    before = _safe_file(path, private=True)
    if before.st_size > 4096:
        raise HostError("유튜브 도우미 설정을 다시 설치하세요.")
    try:
        with path.open("rb") as source:
            current = os.fstat(source.fileno())
            if (current.st_dev, current.st_ino, current.st_size) != (before.st_dev, before.st_ino, before.st_size):
                raise ValueError("Configuration changed")
            value = decode_json(source.read(4097))
        if not isinstance(value, dict) or set(value) != {"deno"} or not isinstance(value["deno"], str):
            raise ValueError("Unknown configuration")
        deno = Path(value["deno"])
        if any(ord(c) < 32 for c in str(deno)):
            raise ValueError("Invalid executable path")
        _safe_file(deno, executable=True)
        return deno
    except (OSError, ValueError, UnicodeError, RecursionError):
        raise HostError("유튜브 도우미 설정을 다시 설치하세요.") from None


class _WindowsJob:
    """A suspended child joins a kill-on-close job before it can launch Deno."""
    def __init__(self):
        from ctypes import wintypes
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
        limit = Extended(); limit.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.handle or not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limit), ctypes.sizeof(limit)):
            self.close()
            raise HostError("유튜브 도우미의 프로세스 격리를 준비하지 못했습니다.")

    def attach_and_resume(self, process):
        if (not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle))
                or self.ntdll.NtResumeProcess(int(process._handle)) != 0):
            raise HostError("유튜브 도우미의 프로세스 격리를 준비하지 못했습니다.")

    def close(self):
        if getattr(self, "handle", None):
            self.kernel.CloseHandle(self.handle); self.handle = None


def run_process(argv, payload=b"", *, cancel=None, timeout=EXTRACTION_TIMEOUT, output_limit=MAX_CHILD_OUTPUT):
    cancel = cancel or threading.Event()
    if cancel.is_set():
        raise HostError("유튜브 정보 확인을 취소했습니다.")
    job = _WindowsJob() if os.name == "nt" else None
    process = None
    buffers = [bytearray(), bytearray()]
    overflow = threading.Event()
    readers = []
    group_cleared = False
    def clear_group():
        nonlocal group_cleared
        if process is not None and not group_cleared and os.name != "nt":
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            group_cleared = True
    def exited():
        # Observe POSIX exit without reaping: its PID stays reserved until all
        # descendants in this dedicated process group have been terminated.
        if os.name != "nt" and hasattr(os, "waitid") and hasattr(os, "WNOWAIT"):
            return os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
        return process.poll() is not None
    def collect(stream, target, limit):
        try:
            while data := stream.read(4096):
                if len(target) + len(data) > limit:
                    overflow.set()
                elif not overflow.is_set():
                    target.extend(data)
        except OSError:
            overflow.set()
        finally:
            stream.close()
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   shell=False, start_new_session=os.name != "nt",
                                   creationflags=(0x4 | 0x08000000) if os.name == "nt" else 0)
        if job:
            job.attach_and_resume(process)
        for stream, target, limit in [(process.stdout, buffers[0], output_limit), (process.stderr, buffers[1], MAX_MESSAGE)]:
            reader = threading.Thread(target=collect, args=(stream, target, limit), daemon=True)
            reader.start(); readers.append(reader)
        process.stdin.write(payload); process.stdin.close()
        deadline = time.monotonic() + timeout
        while not exited():
            if cancel.is_set():
                raise HostError("유튜브 정보 확인을 취소했습니다.")
            if overflow.is_set():
                raise HostError("유튜브 정보 응답이 허용 범위를 초과했습니다.")
            if time.monotonic() >= deadline:
                raise HostError("유튜브 정보 확인 시간이 초과되었습니다. 다시 시도하세요.")
            cancel.wait(0.04)
        clear_group()
        process.wait(timeout=2)
        for reader in readers:
            reader.join(1)
        if cancel.is_set():
            raise HostError("유튜브 정보 확인을 취소했습니다.")
        if overflow.is_set() or any(reader.is_alive() for reader in readers):
            raise HostError("유튜브 정보 응답이 허용 범위를 초과했습니다.")
        if process.returncode != 0:
            raise HostError("유튜브 정보를 가져오지 못했습니다. 공개 영상과 도우미 설치 상태를 확인하세요.")
        return bytes(buffers[0])
    except (OSError, subprocess.SubprocessError):
        raise HostError("유튜브 도우미 프로세스를 실행하지 못했습니다.") from None
    finally:
        if job:
            job.close()
        if process is not None:
            clear_group()
            if process.poll() is None:
                process.kill()
            try: process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=2)
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
            for reader in readers:
                reader.join(1)


def readiness(cancel=None):
    try:
        if importlib.metadata.version("yt-dlp") != VERSION or importlib.metadata.version("yt-dlp-ejs") != EJS_VERSION:
            raise HostError("고정 버전 유튜브 도우미를 다시 설치하세요.")
    except importlib.metadata.PackageNotFoundError:
        raise HostError("유튜브 도우미의 고정 의존성을 먼저 설치하세요.") from None
    deno = configuration()
    output = run_process([str(deno), "--version"], cancel=cancel, timeout=5, output_limit=4096)
    match = re.search(rb"\Adeno (\d+)\.(\d+)\.(\d+)(?:[^\r\n]*)?(?:\r?\n|\Z)", output)
    if not match or tuple(int(part) for part in match.groups()) < (2, 3, 0):
        raise HostError("Deno 2.3.0 이상을 설치하고 유튜브 도우미를 다시 연결하세요.")
    return deno, "Deno " + ".".join(part.decode("ascii") for part in match.groups())


def direct_url(value):
    if not isinstance(value, str) or len(value) > 8192 or any(not 33 <= ord(c) <= 126 for c in value):
        raise ValueError("Invalid media URL")
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
            or parsed.port not in (None, 443) or parsed.fragment or parsed.path != "/videoplayback"
            or not host.endswith(".googlevideo.com") or not re.fullmatch(r"[a-z0-9.-]+", host)
            or "\\" in value):
        raise ValueError("Untrusted media URL")
    return value


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 < value <= MAX_SAFE_INTEGER


def format_track(value):
    if not isinstance(value, dict) or value.get("has_drm") is not None and value.get("has_drm") is not False or value.get("fragments"):
        return None
    if value.get("protocol") not in ("https", "http") or value.get("ext") not in ("mp4", "m4a", "webm"):
        return None
    try:
        address = direct_url(value.get("url"))
    except (ValueError, TypeError):
        return None
    if value.get("cookies"):
        return None
    headers = value.get("http_headers") or {}
    if not isinstance(headers, dict) or any(str(key).lower() not in ("user-agent", "accept", "accept-language", "sec-fetch-mode") for key in headers):
        return None
    video = isinstance(value.get("vcodec"), str) and value["vcodec"] not in ("", "none")
    audio = isinstance(value.get("acodec"), str) and value["acodec"] not in ("", "none")
    if not video and not audio:
        return None
    if video and (type(value.get("height")) is not int or not 1 <= value["height"] <= 65535):
        return None
    identifier = value.get("format_id")
    if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", identifier):
        return None
    kind = "combined" if video and audio else "video" if video else "audio"
    mime = ("video/" if video else "audio/") + ("webm" if value["ext"] == "webm" else "mp4")
    track = {"url": address, "kind": kind, "mime": mime, "formatId": identifier}
    if video:
        track["height"] = int(value["height"])
    if positive(value.get("filesize")) and type(value["filesize"]) is int:
        track["size"] = value["filesize"]
    return track


def select_result(info, value):
    _, video_id = youtube_url(value["url"])
    if (not isinstance(info, dict) or info.get("id") != video_id or info.get("_type", "video") != "video"
            or info.get("is_live") or info.get("live_status") not in (None, "not_live", "was_live")
            or info.get("availability") not in (None, "public", "unlisted")
            or positive(info.get("age_limit"))):
        raise HostError("공개된 일반 유튜브 영상만 지원합니다. 라이브·제한 영상·재생목록은 지원하지 않습니다.")
    formats = info.get("formats")
    if not isinstance(formats, list) or len(formats) > 4096:
        raise HostError("유튜브 미디어 형식을 확인하지 못했습니다.")
    usable = [(item, track) for item in formats if (track := format_track(item)) is not None]
    audio = [(item, track) for item, track in usable if track["kind"] == "audio"]
    def bitrate(item):
        return max((item.get(field) for field in ("abr", "vbr", "tbr") if positive(item.get(field))), default=0)
    def choose_audio(prefer_webm=False):
        preferred = [(item, track) for item, track in audio if track["mime"] == ("audio/webm" if prefer_webm else "audio/mp4")]
        return max(preferred or audio, key=lambda entry: bitrate(entry[0]))[1] if audio else None
    if value["output"] != "original":
        chosen = choose_audio()
        if chosen is None:
            raise HostError("다운로드할 수 있는 유튜브 오디오 트랙이 없습니다.")
        tracks = [chosen]
    else:
        videos = [(item, track) for item, track in usable if track["kind"] in ("video", "combined")]
        if not videos:
            raise HostError("다운로드할 수 있는 유튜브 영상 트랙이 없습니다. 사이트 또는 도우미 변경을 확인하세요.")
        heights = [track["height"] for _, track in videos]
        ceiling = None if value["quality"] == "highest" else int(value["quality"])
        eligible = [height for height in heights if ceiling is None or height <= ceiling]
        target = max(eligible) if eligible else min(heights)
        _, chosen = max((entry for entry in videos if entry[1]["height"] == target), key=lambda entry: bitrate(entry[0]))
        tracks = [chosen]
        if chosen["kind"] == "video":
            selected_audio = choose_audio(chosen["mime"] == "video/webm")
            if selected_audio is None:
                raise HostError("영상에 병합할 유튜브 오디오 트랙을 확인하지 못했습니다.")
            tracks.append(selected_audio)
    title = info.get("title")
    title = "".join(c for c in title if ord(c) >= 32 and ord(c) != 127)[:200] if isinstance(title, str) else ""
    result = {"videoId": video_id, "title": title or "YouTube " + video_id, "tracks": tracks}
    if positive(info.get("duration")):
        result["duration"] = info["duration"]
    return result


def validate_result(parsed, value):
    _, video_id = youtube_url(value["url"])
    if (not isinstance(parsed, dict) or set(parsed) not in ({"videoId", "title", "tracks"}, {"videoId", "title", "tracks", "duration"})
            or parsed.get("videoId") != video_id or not isinstance(parsed.get("title"), str)
            or not 1 <= len(parsed["title"]) <= 200 or any(ord(c) < 32 or ord(c) == 127 for c in parsed["title"])):
        raise ValueError("Invalid child metadata")
    tracks = parsed.get("tracks")
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= 2:
        raise ValueError("Invalid child tracks")
    seen = set(); identifiers = set()
    for track in tracks:
        if (not isinstance(track, dict) or not {"url", "kind", "mime", "formatId"} <= set(track)
                or set(track) - {"url", "kind", "mime", "formatId", "height", "size"}
                or track.get("kind") not in ("video", "audio", "combined")
                or track.get("mime") not in ("video/mp4", "video/webm", "audio/mp4", "audio/webm")
                or (track["kind"] == "audio") != track["mime"].startswith("audio/")
                or not isinstance(track.get("formatId"), str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", track["formatId"])):
            raise ValueError("Invalid child track metadata")
        address = direct_url(track.get("url"))
        if address in seen or track["formatId"] in identifiers:
            raise ValueError("Duplicate media URL")
        seen.add(address); identifiers.add(track["formatId"])
        for field in ("height", "size"):
            if field in track and (type(track[field]) is not int or not positive(track[field])):
                raise ValueError("Invalid child track measurement")
        if track["kind"] == "audio" and "height" in track:
            raise ValueError("Audio cannot have height")
        if "height" in track and track["height"] > 65535:
            raise ValueError("Invalid child height")
    if (len(tracks) == 2 and [track["kind"] for track in tracks] != ["video", "audio"]
            or len(tracks) == 1 and tracks[0]["kind"] not in (("audio",) if value["output"] != "original" else ("video", "combined"))
            or "duration" in parsed and not positive(parsed["duration"])):
        raise ValueError("Invalid child output selection")
    return parsed


def extract(value):
    deno = configuration()
    import yt_dlp
    from yt_dlp.globals import plugin_dirs
    plugin_dirs.value = []
    class Logger:
        def debug(self, _message): pass
        def warning(self, _message): pass
        def error(self, _message): pass
    options = {"quiet": True, "no_warnings": True, "logger": Logger(), "noplaylist": True,
               "skip_download": True, "cachedir": False, "cookiefile": None, "cookiesfrombrowser": None,
               "usenetrc": False, "netrc_location": None, "remote_components": [],
               "js_runtimes": {"deno": {"path": str(deno)}}, "http_headers": {"User-Agent": value["userAgent"]},
               "socket_timeout": 20, "retries": 1, "extractor_retries": 1, "check_formats": False,
               "allow_unplayable_formats": False, "geo_bypass": False, "mark_watched": False,
               "extractor_args": {"youtube": {"skip": ["hls", "dash"], "fetch_pot": ["never"]}, "youtube-ejs": {"jitless": ["true"]}}}
    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info(value["url"], download=False)
    return select_result(info, value)


def reply(request_id, status, **fields):
    return {"version": 1, "requestId": request_id, "status": status, **fields}


def handle(value, cancel=None):
    value = request(value)
    try:
        _, runtime = readiness(cancel)
        if value["action"] == "status":
            return reply(value["requestId"], "ready", ytDlpVersion=VERSION, runtime=runtime,
                         message="유튜브 도우미와 고정 추출기·Deno 준비를 확인했습니다. 실제 다운로드는 Chrome에서 수행합니다.")
        payload = json.dumps(value, ensure_ascii=True, allow_nan=False).encode("utf-8")
        output = run_process([sys.executable, "-I", "-B", str(Path(__file__).absolute()), "--extract"], payload, cancel=cancel)
        parsed = validate_result(decode_json(output), value)
        return reply(value["requestId"], "resolved", **parsed)
    except HostError as error:
        return reply(value["requestId"], "unavailable" if value["action"] == "status" else "error", message=str(error))
    except (ValueError, TypeError, UnicodeError, RecursionError):
        return reply(value["requestId"], "error", message="유튜브 도우미 응답을 확인하지 못했습니다.")


def read_exact(source, size):
    data = bytearray()
    while len(data) < size:
        part = source.read(size - len(data))
        if not part:
            raise EOFError("Truncated native message")
        data.extend(part)
    return bytes(data)


def write_message(destination, value):
    data = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_MESSAGE:
        data = json.dumps(reply(value.get("requestId", ""), "error", message="유튜브 미디어 정보가 허용 범위를 초과했습니다."), ensure_ascii=False).encode("utf-8")
    destination.write(struct.pack("<I", len(data)) + data); destination.flush()


def main(source=None, destination=None):
    class DescriptorReader:
        def __init__(self, descriptor): self.descriptor = descriptor
        def read(self, count): return os.read(self.descriptor, count)
    if source is None:
        source = DescriptorReader(sys.stdin.fileno())
    else:
        try: source = DescriptorReader(source.fileno())
        except (AttributeError, OSError): pass
    destination = destination or sys.stdout.buffer
    request_id = ""
    try:
        size = struct.unpack("<I", read_exact(source, 4))[0]
        if not 1 <= size <= MAX_MESSAGE:
            raise ValueError("Native request too large")
        value = decode_json(read_exact(source, size))
        value = request(value); request_id = value["requestId"]
        cancelled = threading.Event()
        def watch_disconnect():
            try: source.read(1)
            except OSError: pass
            finally: cancelled.set()
        threading.Thread(target=watch_disconnect, daemon=True).start()
        result = handle(value, cancelled)
        if not cancelled.is_set():
            write_message(destination, result)
    except (ValueError, TypeError, UnicodeError, RecursionError, EOFError, HostError, OSError):
        write_message(destination, reply(request_id, "error", message="유튜브 도우미 요청을 확인하지 못했습니다."))


if __name__ == "__main__":
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY); msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    if sys.argv[1:] == ["--extract"]:
        try:
            raw = sys.stdin.buffer.read(MAX_MESSAGE + 1)
            if len(raw) > MAX_MESSAGE: raise ValueError("Child input too large")
            result = extract(request(decode_json(raw)))
            sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False))
        except Exception:
            # Do not expose raw upstream errors, signed URLs, tokens or response bodies.
            sys.exit(1)
    else:
        main()
