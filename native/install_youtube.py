#!/usr/bin/env python3
"""Current-user registration of the separate, resolver-only YouTube bridge."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import venv

NAME = "com.myvideoapp.youtube"
VERSIONS = {"yt-dlp": "2026.10.21", "yt-dlp-ejs": "0.8.0"}
MIN_DENO = (2, 3, 0)
OWN_FILES = ("youtube_host.py", "youtube-config.json", "youtube-requirements.txt", "launch.sh", "launch.cmd")


def safe_path(path: Path) -> Path:
    if not path.is_absolute() or ".." in path.parts or any(ord(char) < 32 for char in str(path)):
        raise ValueError("An absolute local path without parent traversal or control characters is required.")
    if sys.platform == "win32" and str(path).startswith("\\\\"):
        raise ValueError("Network shares and device paths are not supported.")
    for component in reversed((path, *path.parents)):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Symbolic links and reparse points are not accepted in installation paths.")
    return path


def locations(browser: str) -> tuple[Path, list[Path]]:
    if browser not in {"chrome", "chromium", "both"}:
        raise ValueError("Unsupported browser.")
    home = Path.home()
    browsers = ["chrome", "chromium"] if browser == "both" else [browser]
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local")) / "MyVideoApp" / "YouTube"
        return safe_path(base), [base / f"{item}-{NAME}.json" for item in browsers]
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support" / "My Video App" / "youtube"
        paths = [home / "Library" / "Application Support" / ("Google/Chrome" if item == "chrome" else "Chromium") / "NativeMessagingHosts" / f"{NAME}.json" for item in browsers]
    else:
        base = home / ".local" / "share" / "my-video-app-youtube"
        config = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
        paths = [config / ("google-chrome" if item == "chrome" else "chromium") / "NativeMessagingHosts" / f"{NAME}.json" for item in browsers]
    safe_path(base)
    for item in paths:
        safe_path(item)
    return base, paths


def write_private(path: Path, content: str, mode: int = 0o600) -> None:
    safe_path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".mva-youtube-", dir=path.parent)
    try:
        os.chmod(temporary, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            output.write(content)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def bounded_output(arguments: list[str], timeout: float = 5, limit: int = 64 * 1024) -> str:
    process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               shell=False, start_new_session=os.name != "nt",
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    output = bytearray()
    overflow = threading.Event()

    def stop() -> None:
        try:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass

    def read() -> None:
        assert process.stdout is not None
        while chunk := process.stdout.read(4096):
            if len(output) + len(chunk) > limit:
                overflow.set()
                stop()
                break
            output.extend(chunk)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        stop()
        process.wait(timeout=2)
        raise ValueError("The executable readiness check timed out.") from error
    finally:
        reader.join(timeout=2)
        if reader.is_alive():
            stop()
            reader.join(timeout=1)
        if not reader.is_alive() and process.stdout is not None:
            process.stdout.close()
    if reader.is_alive() or overflow.is_set() or process.returncode:
        raise ValueError("The executable readiness check failed or exceeded its output budget.")
    return output.decode("utf-8", errors="strict")


def validate_deno(value: str) -> Path:
    path = safe_path(Path(value))
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.name.lower() not in {"deno", "deno.exe"}:
        raise ValueError("--deno must name an existing absolute Deno executable.")
    if sys.platform != "win32":
        if not os.access(path, os.X_OK) or info.st_mode & 0o022 or info.st_uid not in {0, os.getuid()}:
            raise ValueError("Deno must be owned by this account or root, executable, and not writable by other users.")
        for parent in path.parents:
            directory = parent.stat()
            trusted_sticky = directory.st_mode & stat.S_ISVTX and directory.st_uid in {0, os.getuid()}
            if directory.st_mode & 0o022 and not trusted_sticky:
                raise ValueError("Other users must not be able to replace Deno through a writable parent directory.")
    output = bounded_output([str(path), "--version"])
    match = re.match(r"deno (\d+)\.(\d+)\.(\d+)(?:\s|$)", output)
    if match is None or tuple(map(int, match.groups())) < MIN_DENO:
        raise ValueError("Deno 2.3.0 or later is required (2.9.8 is the reviewed release).")
    return path


def python_for(base: Path) -> Path:
    return base / "venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def dependency_command(python: Path, requirements: Path) -> list[str]:
    return [str(python), "-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "--no-input", "install",
            "--index-url", "https://pypi.org/simple", "--require-hashes", "--no-deps", "--only-binary=:all:", "-r", str(requirements)]


def dependency_check(python: Path) -> None:
    script = "import importlib.metadata as m; expected=" + repr(VERSIONS) + "; assert all(m.version(k)==v for k,v in expected.items()), 'Dependency version mismatch'"
    bounded_output([str(python), "-I", "-B", "-c", script], timeout=10)


def launcher_text(python: Path, host: Path) -> str:
    if sys.platform == "win32":
        if any(char in str(python) + str(host) for char in '\r\n"%!^&|<>'):
            raise ValueError("Unsupported shell characters in the installation path.")
        return f'@echo off\nsetlocal DisableDelayedExpansion\n"{python}" -I -B "{host}"\n'
    return f"#!/bin/sh\nexec {shlex.quote(str(python))} -I -B {shlex.quote(str(host))}\n"


def manifest_data(launcher: Path, extension_ids: list[str]) -> dict:
    if not extension_ids or any(not re.fullmatch(r"[a-p]{32}", item) for item in extension_ids):
        raise ValueError("Supply a valid 32-character extension ID from chrome://extensions.")
    return {"name": NAME, "description": "My Video App YouTube URL resolver", "path": str(launcher), "type": "stdio",
            "allowed_origins": [f"chrome-extension://{item}/" for item in sorted(set(extension_ids))]}


def registry_update(browser: str, manifest: Path | None) -> None:
    import winreg
    vendor = "Google\\Chrome" if browser == "chrome" else "Chromium"
    key = f"Software\\{vendor}\\NativeMessagingHosts\\{NAME}"
    if manifest is None:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
        except FileNotFoundError:
            pass
    else:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as handle:
            winreg.SetValueEx(handle, "", 0, winreg.REG_SZ, str(manifest))


def uninstall(browser: str) -> None:
    base, manifests = locations(browser)
    browsers = ["chrome", "chromium"] if browser == "both" else [browser]
    for name, manifest in zip(browsers, manifests):
        safe_path(manifest)
        if sys.platform == "win32":
            registry_update(name, None)
        manifest.unlink(missing_ok=True)
    if any(item.exists() for item in locations("both")[1]):
        print("Selected registration removed; companion files retained for the other registered browser.")
        return
    for name in OWN_FILES:
        target = safe_path(base / name)
        target.unlink(missing_ok=True)
    # Never recursively remove arbitrary data. The private venv can be removed
    # by its owner after uninstall; no browser credentials/media are stored here.
    print("YouTube resolver registration removed. The isolated dependency venv was retained.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the separate My Video App YouTube URL resolver for this OS account.")
    parser.add_argument("--extension-id", action="append", default=[])
    parser.add_argument("--browser", choices=("chrome", "chromium", "both"), default="chrome")
    parser.add_argument("--deno", help="Existing absolute Deno executable path; no commands or extra arguments")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    if sys.version_info < (3, 10):
        parser.error("Python 3.10 or later is required.")
    if args.uninstall:
        uninstall(args.browser)
        return 0
    if not args.deno:
        parser.error("Supply --deno with an existing absolute Deno executable path.")
    deno = validate_deno(args.deno)
    base, manifests = locations(args.browser)
    launcher = base / ("launch.cmd" if sys.platform == "win32" else "launch.sh")
    data = manifest_data(launcher, args.extension_id)
    # Validate launcher syntax before touching an existing installation.
    python = python_for(base)
    content = launcher_text(python, base / "youtube_host.py")
    safe_path(base)
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    if sys.platform != "win32":
        if base.stat().st_uid != os.getuid():
            raise ValueError("The installation directory must belong to the current OS account.")
        os.chmod(base, 0o700)
    source = Path(__file__).absolute().with_name("youtube_host.py")
    requirements = source.with_name("youtube-requirements.txt")
    safe_path(source)
    safe_path(requirements)
    host_text = source.read_text(encoding="utf-8")
    write_private(base / "youtube-requirements.txt", requirements.read_text(encoding="utf-8"))
    safe_path(base / "venv")
    if not (base / "venv").exists():
        venv.EnvBuilder(with_pip=True, symlinks=False).create(base / "venv")
    safe_path(python)
    if not python.is_file():
        raise ValueError("The isolated Python environment is incomplete; inspect it before retrying.")
    # Keep the inherited proxy/CA environment and normal TLS verification.
    subprocess.run(dependency_command(python, base / "youtube-requirements.txt"), check=True, timeout=300, shell=False,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    dependency_check(python)
    write_private(base / "youtube_host.py", host_text)
    write_private(base / "youtube-config.json", json.dumps({"deno": str(deno)}, ensure_ascii=True, indent=2) + "\n")
    write_private(launcher, content, 0o700)
    browsers = ["chrome", "chromium"] if args.browser == "both" else [args.browser]
    for name, manifest in zip(browsers, manifests):
        safe_path(manifest)
        manifest.parent.mkdir(parents=True, exist_ok=True)
        write_private(manifest, json.dumps(data, indent=2) + "\n")
        if sys.platform == "win32":
            registry_update(name, manifest)
    print("Installed the My Video App YouTube resolver for this OS account. Reload the extension and connect in settings.")
    print("Only public video URLs are resolved; media writes, browser cookies and antivirus settings are not accessed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"YouTube resolver installation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
