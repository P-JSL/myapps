#!/usr/bin/env python3
"""Local-only Chrome native messaging antivirus bridge (Python standard library)."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import threading
from typing import BinaryIO

HOST_NAME = "com.myvideoapp.antivirus"
MAX_MESSAGE = 64 * 1024
MAX_OUTPUT = 256 * 1024
MAX_FILE = 2 * 1024 * 1024 * 1024 - 1
SCAN_TIMEOUT = 120
REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}\Z")
CONFIG_PATH = Path(__file__).with_name("config.json")


def reply(request_id: str, status: str, engine: str = "none", **details: object) -> dict:
    return {"version": 1, "requestId": request_id, "status": status,
            "engine": engine, **details}


def clean_text(value: str, maximum: int = 500) -> str:
    return "".join(character for character in value if character >= " " and character != "\x7f")[:maximum]


def identity(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def validate_file(path: object) -> Path:
    if not isinstance(path, str) or not path or len(path) > 32768 or "\x00" in path:
        raise ValueError("An absolute regular file path is required.")
    candidate = Path(path)
    if sys.platform == "win32" and path.startswith("\\\\"):
        raise ValueError("Network shares and Windows device paths are not scanned.")
    if not candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError("Relative paths and parent traversal are not allowed.")
    # Reject links in every component, including Windows junction/reparse points.
    for component in reversed((candidate, *candidate.parents)):
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Symbolic links and reparse points are not scanned.")
    info = candidate.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Only regular files can be scanned.")
    if info.st_size > MAX_FILE:
        raise ValueError("The local scan limit is 2 GiB minus one byte; this file was not scanned.")
    return candidate


def run_tool(arguments: list[str], timeout: int = SCAN_TIMEOUT) -> tuple[int, str]:
    """Never invoke a shell; stop immediately at a bounded scanner-output limit."""
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, shell=False, bufsize=0,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    output = bytearray()
    exceeded = threading.Event()
    read_failed = threading.Event()

    def collect() -> None:
        try:
            while chunk := process.stdout.read(8192):
                if len(output) + len(chunk) > MAX_OUTPUT:
                    exceeded.set()
                    try:
                        process.kill()
                    except OSError:
                        pass
                    return
                output.extend(chunk)
        except (OSError, ValueError):
            read_failed.set()

    reader = threading.Thread(target=collect, name="local-antivirus-output", daemon=True)
    reader.start()
    try:
        code = process.wait(timeout=timeout)
        reader.join(timeout=2)
        if exceeded.is_set():
            raise RuntimeError("The scanner returned excessive output; no clean verdict was accepted.")
        if reader.is_alive() or read_failed.is_set():
            raise RuntimeError("Scanner output was incomplete; no clean verdict was accepted.")
        return code, output.decode("utf-8", errors="replace")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        reader.join(timeout=2)


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    if CONFIG_PATH.stat().st_size > MAX_MESSAGE:
        raise ValueError("Invalid native host configuration.")
    value = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) - {"clamav", "scanner"}:
        raise ValueError("Invalid native host configuration.")
    if value.get("scanner", "auto") not in {"auto", "defender", "clamav"}:
        raise ValueError("Unsupported antivirus selection mode.")
    return value


def clamav_path(config: dict) -> Path | None:
    configured = config.get("clamav")
    if configured is not None:
        if not isinstance(configured, str) or not Path(configured).is_absolute():
            raise ValueError("The configured ClamAV executable must have an absolute path.")
        candidates = [Path(configured)]
    elif sys.platform == "win32":
        candidates = [Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "ClamAV" / "clamscan.exe"]
    else:
        candidates = [Path(name) for name in ("/usr/bin/clamscan", "/usr/local/bin/clamscan", "/opt/homebrew/bin/clamscan")]
    for candidate in candidates:
        if candidate.is_file():
            resolved = candidate.resolve(strict=True)
            if resolved.name.lower() not in {"clamscan", "clamscan.exe"}:
                raise ValueError("Only the installed clamscan executable can be configured.")
            return resolved
    if configured:
        raise ValueError("The configured ClamAV executable does not exist.")
    return None


def scan_clamav(executable: Path, snapshot: Path) -> dict:
    code, output = run_tool([str(executable), "--no-summary", "--stdout",
                             "--scan-archive=yes", "--alert-exceeds-max=yes",
                             "--follow-dir-symlinks=0", "--follow-file-symlinks=0",
                             f"--max-filesize={MAX_FILE}", f"--max-scansize={MAX_FILE}",
                             "--", str(snapshot)])
    threats = [clean_text(match, 240) for match in re.findall(r":\s+([^\r\n]+?) FOUND(?:\r?$)", output, re.MULTILINE)][:16]
    if any("Limits.Exceeded" in threat for threat in threats):
        return {"status": "error", "engine": "ClamAV", "message": "ClamAV could not completely scan this file because an engine limit was reached."}
    if code not in (0, 1) or re.search(r"\b(?:ERROR|WARNING)(?:[:\s]|$)", output):
        return {"status": "error", "engine": "ClamAV", "message": "ClamAV did not complete a successful scan. Check its local signature database and logs."}
    if code == 1 or threats:
        return {"status": "infected", "engine": "ClamAV", "threats": threats or ["ClamAV malware detection"]}
    if str(snapshot) + ": OK" not in output.splitlines():
        return {"status": "error", "engine": "ClamAV", "message": "ClamAV did not confirm that the requested file was scanned; no clean verdict was accepted."}
    return {"status": "clean", "engine": "ClamAV"}


def windows_defender_paths() -> tuple[Path, Path] | None:
    windows = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    powershell = windows / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    base = Path(os.environ.get("ProgramData", r"C:\ProgramData")) / "Microsoft" / "Windows Defender" / "Platform"
    platforms = sorted(base.glob("*/MpCmdRun.exe"), key=lambda path: tuple(int(part) for part in re.findall(r"\d+", path.parent.name)), reverse=True) if base.is_dir() else []
    platforms.append(Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Windows Defender" / "MpCmdRun.exe")
    for executable in platforms:
        if powershell.is_file() and executable.is_file():
            return powershell, executable
    return None


def scan_defender(powershell: Path, executable: Path, snapshot: Path) -> dict:
    # Honor the installed Windows protection policy, including its cloud settings.
    # Passive/disabled Defender must not impersonate the user's active antivirus.
    script = ("$ErrorActionPreference='Stop'; $s=Get-MpComputerStatus; "
              "@{enabled=[bool]$s.AntivirusEnabled; service=[bool]$s.AMServiceEnabled; "
              "mode=[string]$s.AMRunningMode}|ConvertTo-Json -Compress")
    code, output = run_tool([str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], 15)
    try:
        state = json.loads(output.lstrip("\ufeff")) if code == 0 else None
    except (ValueError, TypeError):
        state = None
    if (not isinstance(state, dict) or state.get("enabled") is not True
            or state.get("service") is not True or state.get("mode") != "Normal"):
        return {"status": "unavailable", "engine": "Microsoft Defender", "message": "Microsoft Defender가 활성 보호 모드가 아니거나 상태를 확인할 수 없습니다. Windows 보안에서 사용 중인 백신을 확인하세요."}
    before = identity(snapshot.stat())
    code, output = run_tool([str(executable), "-Scan", "-ScanType", "3", "-File", str(snapshot), "-DisableRemediation"])
    threats = [clean_text(value, 240) for value in re.findall(r"(?:Threat\s*[:=]|Threat\s+detected\s*[:=])\s*([^\r\n]+)", output, re.IGNORECASE)][:16]
    if threats:
        return {"status": "infected", "engine": "Microsoft Defender", "threats": threats}
    # Exit 2 can mean detection OR an incomplete/error scan. Without an explicit
    # detection marker, report error rather than guessing either infected or clean.
    if (code != 0 or not snapshot.is_file() or identity(snapshot.stat()) != before
            or re.search(r"\b(?:error|failed|failure|0x[89a-fA-F][0-9a-fA-F]{7})\b", output, re.IGNORECASE)):
        return {"status": "error", "engine": "Microsoft Defender", "message": "Microsoft Defender did not provide an unambiguous completed scan. Check Windows Security; this file has not been marked clean."}
    return {"status": "clean", "engine": "Microsoft Defender"}


def windows_adapter():
    path = Path(__file__).with_name("windows_antivirus.py")
    spec = importlib.util.spec_from_file_location("my_video_app_windows_antivirus", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Windows antivirus integration module is unavailable.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def scan_windows_amsi(snapshot: Path, products: str) -> dict:
    adapter = Path(__file__).with_name("windows_antivirus.py")
    code, output = run_tool([sys.executable, "-I", str(adapter), "--amsi-scan", str(snapshot), products])
    try:
        result = json.loads(output) if code == 0 else None
    except ValueError:
        result = None
    if (not isinstance(result, dict) or result.get("engine") != "Windows AMSI"
            or result.get("status") not in {"clean", "infected", "unavailable", "error"}):
        return {"status": "error", "engine": "Windows AMSI", "message": "Windows 백신 인터페이스의 검사 결과를 확인하지 못했습니다."}
    return result


def select_scanner(config: dict):
    mode = config.get("scanner", "auto")
    # An explicitly configured ClamAV path remains an intentional user override.
    if mode == "clamav" or (mode == "auto" and "clamav" in config):
        executable = clamav_path(config)
        return (lambda snapshot: scan_clamav(executable, snapshot)) if executable else None
    if sys.platform != "win32":
        if mode == "defender":
            return lambda snapshot: {"status": "unavailable", "engine": "Microsoft Defender", "message": "Microsoft Defender 연동은 Windows에서만 지원합니다."}
        executable = clamav_path(config)
        return (lambda snapshot: scan_clamav(executable, snapshot)) if executable else None
    paths = windows_defender_paths()
    if mode == "defender":
        return (lambda snapshot: scan_defender(*paths, snapshot)) if paths else None
    powershell = paths[0] if paths else Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    adapter = windows_adapter()
    discovered = adapter.discover_windows_antivirus(run_tool, powershell)
    if discovered.get("status") != "ok":
        # Defender still verifies its own active Normal mode before scanning.
        if paths:
            return lambda snapshot: scan_defender(*paths, snapshot)
        return lambda snapshot: {"status": "unavailable", "engine": "Windows Security Center", "message": "Windows에서 사용 중인 백신을 확인하지 못했습니다."}
    active = [product for product in discovered["products"] if product["state"] == "on"]
    others = [product for product in active if not adapter.is_defender(product["name"])]
    if others:
        names = ", ".join(product["name"] for product in others)[:300]
        if not all(adapter.provider_for_product(product["name"], discovered["providers"]) for product in others):
            return lambda snapshot: {"status": "unavailable", "engine": "Windows AMSI", "message": f"사용 중인 백신({names})의 Windows 표준 검사 연동을 확인하지 못했습니다. 해당 제품의 수동 검사를 사용하거나 지원되는 검사기를 직접 선택하세요."}
        return lambda snapshot: scan_windows_amsi(snapshot, names)
    if paths:
        return lambda snapshot: scan_defender(*paths, snapshot)
    return lambda snapshot: {"status": "unavailable", "engine": "Microsoft Defender", "message": "Windows 기본 백신의 검사 도구를 찾을 수 없습니다."}


def scan_request(request: object) -> dict:
    request_id = request.get("requestId", "") if isinstance(request, dict) else ""
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        request_id = ""
    if (not isinstance(request, dict) or set(request) != {"version", "action", "requestId", "path"}
            or type(request.get("version")) is not int or request["version"] != 1
            or request.get("action") != "scan" or not request_id):
        return reply(request_id, "error", message="Unsupported or invalid scan request.")
    try:
        source = validate_file(request["path"])
        scanner = select_scanner(load_config())
        if scanner is None:
            return reply(request_id, "unavailable", message="No supported local antivirus scanner is installed. Install ClamAV with a current local signature database. Chrome download protection still applies.")
        flags = (os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
                 | getattr(os, "O_NONBLOCK", 0))
        descriptor = os.open(source, flags)
        with os.fdopen(descriptor, "rb") as original, tempfile.TemporaryDirectory(prefix="my-video-app-av-") as directory:
            before = os.fstat(original.fileno())
            if not stat.S_ISREG(before.st_mode) or identity(before) != identity(source.lstat()):
                raise ValueError("The file changed before scanning.")
            if before.st_size > MAX_FILE:
                raise ValueError("The file exceeds the local antivirus scan size limit.")
            if shutil.disk_usage(directory).free < before.st_size + 16 * 1024 * 1024:
                raise ValueError("Insufficient temporary disk space for an isolated local scan.")
            suffix = source.suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,10}", source.suffix) else ".bin"
            snapshot = Path(directory) / ("download" + suffix)
            digest = hashlib.sha256()
            copied = 0
            with snapshot.open("xb") as destination:
                os.chmod(snapshot, 0o600)
                while chunk := original.read(1024 * 1024):
                    copied += len(chunk)
                    if copied > MAX_FILE or copied > before.st_size:
                        raise ValueError("The file changed or exceeded the scan limit.")
                    digest.update(chunk)
                    destination.write(chunk)
            if copied != before.st_size or identity(before) != identity(os.fstat(original.fileno())):
                raise ValueError("The file changed while preparing the local scan.")
            result = scanner(snapshot)
            # Check the actual current path, not only the original open descriptor.
            validate_file(str(source))
            if identity(before) != identity(source.lstat()):
                raise ValueError("The downloaded file changed during scanning; scan it again.")
            if result["status"] in ("clean", "infected"):
                original.seek(0)
                current = hashlib.file_digest(original, "sha256").hexdigest()
                if current != digest.hexdigest() or identity(before) != identity(os.fstat(original.fileno())):
                    raise ValueError("The downloaded bytes changed during scanning; scan them again.")
                validate_file(str(source))
                if identity(before) != identity(source.lstat()):
                    raise ValueError("The downloaded path changed during verification; scan it again.")
                result.update(sha256=current, size=copied)
            return reply(request_id, **result)
    except subprocess.TimeoutExpired:
        return reply(request_id, "error", message="The local antivirus scan timed out; the file has not been marked clean.")
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        return reply(request_id, "error", message=clean_text(str(error)) or "The local scan failed.")


def read_exact(stream: BinaryIO, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        part = stream.read(length - len(chunks))
        if not part:
            raise EOFError("Truncated native message.")
        chunks.extend(part)
    return bytes(chunks)


def write_message(stream: BinaryIO, message: dict) -> None:
    encoded = json.dumps(message, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_MESSAGE:
        encoded = json.dumps(reply("", "error", message="Native response limit exceeded.")).encode("utf-8")
    stream.write(struct.pack("<I", len(encoded)))
    stream.write(encoded)
    stream.flush()


def serve(source: BinaryIO, destination: BinaryIO) -> None:
    while True:
        header = source.read(4)
        if not header:
            return
        try:
            if len(header) != 4:
                header += read_exact(source, 4 - len(header))
            length = struct.unpack("<I", header)[0]
            if not 0 < length <= MAX_MESSAGE:
                write_message(destination, reply("", "error", message="Native request limit exceeded."))
                return
            request = json.loads(read_exact(source, length).decode("utf-8"))
            write_message(destination, scan_request(request))
        except (EOFError, UnicodeError, ValueError):
            write_message(destination, reply("", "error", message="Malformed native message."))
            return


if __name__ == "__main__":
    # Windows CRT text mode would corrupt the native messaging length prefix.
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    serve(sys.stdin.buffer, sys.stdout.buffer)
