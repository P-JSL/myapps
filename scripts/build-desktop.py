#!/usr/bin/env python3
"""Build a deterministic portable Windows x64 app without running Windows code.

Only exact, hashed upstream inputs in desktop/dependencies-lock.json are used.
The cache may be populated online once; --offline never performs network I/O.
"""

import argparse
from contextlib import ExitStack
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import ssl
import stat
import struct
import tempfile
from urllib.parse import urlsplit
import urllib.request
import zipfile


PREFIX = "MyVideoApp/"
INPUT_IDS = ("python", "yt-dlp", "yt-dlp-ejs", "deno", "pyside6-essentials", "shiboken6",
             "ffmpeg")
MAX_FILES = 30_000
MAX_FILE_BYTES = 300 * 1024 * 1024
MAX_TOTAL_BYTES = 1200 * 1024 * 1024
SOURCE_SUFFIXES = {".py", ".qss", ".svg", ".png", ".ico"}
DOWNLOAD_HOSTS = {"api.nuget.org", "files.pythonhosted.org", "github.com", "raw.githubusercontent.com"}
REDIRECT_HOSTS = DOWNLOAD_HOSTS | {"release-assets.githubusercontent.com"}
# Essentials includes plugin stubs whose implementations live in Qt Addons or
# external database client installations. A Qt Widgets app does not use them.
QT_OMIT_PREFIXES = (
    "PySide6/qml/", "PySide6/plugins/designer/", "PySide6/plugins/qmltooling/",
    "PySide6/plugins/sqldrivers/", "PySide6/plugins/platforminputcontexts/",
)
QT_OMIT_FILES = {"PySide6/plugins/imageformats/qpdf.dll"}


def canonical_json(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def sha256_file(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def safe_name(name):
    """Reject traversal, Windows aliases, ADS, device names and ambiguous paths."""
    if not isinstance(name, str) or not name or "\\" in name or name.startswith("/"):
        raise ValueError(f"Unsafe archive path: {name!r}")
    parts = name.rstrip("/").split("/")
    for part in parts:
        if (not part or part in (".", "..") or part.endswith((".", " "))
                or re.search(r'[<>:"|?*\x00-\x1f]', part)
                or re.fullmatch(r"(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part)):
            raise ValueError(f"Unsafe archive path: {name!r}")
    return "/".join(parts)


def official_url(url, redirect=False):
    parsed = urlsplit(url)
    hosts = REDIRECT_HOSTS if redirect else DOWNLOAD_HOSTS
    if (parsed.scheme != "https" or parsed.hostname not in hosts
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or parsed.fragment or (parsed.query and parsed.hostname != "release-assets.githubusercontent.com")):
        raise ValueError(f"Only pinned official HTTPS package URLs are allowed: {url}")
    return url


def load_lock(path):
    lock = json.loads(Path(path).read_text(encoding="utf-8"))
    if lock.get("schema") != 1 or lock.get("platform") != "win32-x64":
        raise ValueError("Unsupported desktop bundle lock schema/platform")
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){2}", lock.get("version", "")):
        raise ValueError("Desktop lock must specify an application version")
    inputs = lock.get("inputs")
    if not isinstance(inputs, list) or [item.get("id") for item in inputs] != list(INPUT_IDS):
        raise ValueError("Desktop lock must contain the pinned runtime inputs in order")
    if "nativeTransportMatch" in lock:
        raise ValueError("The restored desktop runtime does not bundle a native HTTP transport")
    seen = set()
    for item in inputs + lock.get("notices", []):
        if (not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", ""))
                or type(item.get("size")) is not int or not 0 < item["size"] <= MAX_FILE_BYTES):
            raise ValueError(f"Invalid pinned input identity: {item.get('id', item.get('filename'))}")
        filename = item.get("filename")
        if safe_name(filename) != filename or "/" in filename or filename.casefold() in seen:
            raise ValueError("Pinned cache filenames must be unique basenames")
        seen.add(filename.casefold())
        official_url(item["url"])
        if not urlsplit(item["url"]).path.endswith("/" + filename) and "destination" not in item:
            raise ValueError("Pinned package URL does not match its filename")
        if "destination" in item:
            if not safe_name(item["destination"]).startswith("licenses/"):
                raise ValueError("Additional notices must be installed below licenses/")
        else:
            if not isinstance(item.get("version"), str) or not item["version"]:
                raise ValueError("Missing pinned package version")
            expected = "api.nuget.org" if item["id"] == "python" else "github.com" if item["id"] == "ffmpeg" else "files.pythonhosted.org"
            if urlsplit(item["url"]).hostname != expected:
                raise ValueError("Pinned package URL does not match its official source")
    if inputs[4]["version"] != inputs[5]["version"]:
        raise ValueError("PySide6 Essentials and shiboken6 versions must match")
    ffmpeg = inputs[-1]
    if safe_name(ffmpeg.get("archiveRoot", "")) != ffmpeg["filename"][:-4]:
        raise ValueError("FFmpeg archive root does not match its pinned ZIP")
    for item in lock.get("localNotices", []):
        if (not safe_name(item["source"]).startswith("licenses/")
                or not safe_name(item["destination"]).startswith("licenses/")
                or not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", ""))
                or type(item.get("size")) is not int or not 0 < item["size"] <= MAX_FILE_BYTES):
            raise ValueError("Invalid local runtime notice identity")
    return lock


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        official_url(newurl, redirect=True)
        return super().redirect_request(request, response, code, message, headers, newurl)


def verify_input(path, item):
    if Path(path).is_symlink() or path.stat().st_size != item["size"] or sha256_file(path) != item["sha256"]:
        raise ValueError(f"SHA-256/size mismatch for pinned input: {item['filename']}")


def acquire(item, cache, offline=False, fallback_cache=None):
    path = Path(cache) / item["filename"]
    if path.is_symlink():
        raise ValueError(f"Symlink in package cache: {path.name}")
    if not path.exists() and fallback_cache is not None:
        fallback = Path(fallback_cache) / item["filename"]
        if fallback.exists():
            verify_input(fallback, item)
            return fallback
    if not path.exists():
        if offline:
            raise ValueError(f"Missing pinned input in offline cache: {path.name}")
        context = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE"))
        opener = urllib.request.build_opener(OfficialRedirect(), urllib.request.HTTPSHandler(context=context))
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=cache, prefix=".download-", delete=False) as target:
                temporary = Path(target.name)
                with opener.open(item["url"], timeout=90) as response:
                    official_url(response.url, redirect=True)
                    count = 0
                    for chunk in iter(lambda: response.read(1024 * 1024), b""):
                        count += len(chunk)
                        if count > item["size"]:
                            raise ValueError(f"Pinned input exceeded its expected size: {path.name}")
                        target.write(chunk)
            verify_input(temporary, item)
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    verify_input(path, item)
    return path


def archive_members(archive):
    members = archive.infolist()
    if len(members) > MAX_FILES:
        raise ValueError("Too many archive entries")
    seen, total = set(), 0
    for info in members:
        name = safe_name(info.filename)
        key = name.casefold()
        if key in seen:
            raise ValueError(f"Duplicate archive path: {name}")
        seen.add(key)
        kind = stat.S_IFMT(info.external_attr >> 16)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or (kind == stat.S_IFDIR and not info.is_dir()):
            raise ValueError(f"Unsupported archive file type: {name}")
        if info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError(f"Unsupported archive encoding: {name}")
        total += info.file_size
        if info.file_size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
            raise ValueError("Archive exceeds extraction size limits")
        if not info.is_dir():
            yield name, info


def wheel_destination(package, name):
    parts = name.split("/")
    if parts[0].endswith(".data"):
        if len(parts) < 3:
            raise ValueError(f"Invalid wheel data path: {name}")
        if parts[1] in ("purelib", "platlib"):
            return "runtime/python/Lib/site-packages/" + "/".join(parts[2:])
        # Preserve data/notices while avoiding installation of wheel launchers.
        return f"licenses/{package}/wheel-data/{name}"
    return "runtime/python/Lib/site-packages/" + name


def validate_pe(source, label):
    head = source.read(64)
    if len(head) != 64 or head[:2] != b"MZ":
        raise ValueError(f"Missing Windows executable header: {label}")
    offset = struct.unpack_from("<I", head, 60)[0]
    if offset < 64 or offset > 1024 * 1024:
        raise ValueError(f"Invalid Windows executable header offset: {label}")
    source.seek(offset)
    header = source.read(26)
    if len(header) < 26 or header[:4] != b"PE\0\0" or struct.unpack_from("<H", header, 4)[0] != 0x8664 or struct.unpack_from("<H", header, 24)[0] != 0x20B:
        raise ValueError(f"Expected PE32+ AMD64 executable: {label}")


def app_sources(root):
    directory = root / "desktop"
    for source in sorted(directory.rglob("*")):
        relative = source.relative_to(directory)
        if any(part.startswith(".") or part in {"__pycache__", "tests", "launcher"} for part in relative.parts):
            continue
        if source.name.startswith("test_") and source.suffix.lower() == ".py":
            continue
        allowed = (source.suffix.lower() in SOURCE_SUFFIXES
                   or relative.as_posix() in {"dependencies-lock.json", "README.ko.md", "THIRD_PARTY_NOTICES.md"}
                   or relative.parts[0] == "assets" and source.suffix.lower() == ".json")
        if allowed and (source.is_file() or source.is_symlink()):
            if source.is_symlink() or any(parent.is_symlink() for parent in source.parents if parent != root.parent):
                raise ValueError(f"Symlink in desktop application sources: {relative}")
            yield source, "desktop/" + relative.as_posix()


def build_bundle(root, lock_path, cache, output, offline=False):
    root, lock_path, cache, output = map(Path, (root, lock_path, cache, output))
    lock = load_lock(lock_path)
    app_version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    if lock["version"] != app_version:
        raise ValueError("Application package and desktop lock versions differ")
    cache.mkdir(parents=True, exist_ok=True)
    fallback = root / ".cache/youtube-offline-runtime"
    archives = [(item, acquire(item, cache, offline, fallback)) for item in lock["inputs"]]
    notices = [(item, acquire(item, cache, offline)) for item in lock.get("notices", [])]
    plan, folded, total = {}, set(), 0

    def add(name, size, source):
        nonlocal total
        name = safe_name(name)
        key = name.casefold()
        ancestors = {"/".join(key.split("/")[:i]) for i in range(1, len(key.split("/")))}
        if key in folded or ancestors & folded or any(old.startswith(key + "/") for old in folded):
            raise ValueError(f"Duplicate or conflicting bundle path: {name}")
        folded.add(key)
        total += size
        if size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES or len(plan) >= MAX_FILES - 1:
            raise ValueError("Desktop bundle exceeds extraction limits")
        plan[name] = (size, source)

    source_hashes = {"scripts/build-desktop.py": sha256_file(Path(__file__)), "package.json": sha256_file(root / "package.json")}
    for source, name in app_sources(root):
        add(name, source.stat().st_size, source)
        source_hashes[name] = sha256_file(source)
    for name in ("main.py", "engine.py", "README.ko.md", "THIRD_PARTY_NOTICES.md"):
        if "desktop/" + name not in plan:
            raise ValueError(f"Missing desktop application source: {name}")
    if app_version in ("1.19.2", "1.19.3", "1.19.4") and "desktop/activity.py" not in plan:
        raise ValueError("Missing desktop activity logging source: activity.py")
    launcher = root / "desktop/launcher/MyVideoApp.exe"
    if launcher.is_symlink() or not launcher.is_file():
        raise ValueError("Build desktop/launcher/MyVideoApp.exe before packaging")
    add("My Video App.exe", launcher.stat().st_size, launcher)
    source_hashes["desktop/launcher/MyVideoApp.exe"] = sha256_file(launcher)
    # Use the script's absolute location, so spaces and Unicode paths work.
    command = b'@echo off\r\n"%~dp0runtime\\python\\pythonw.exe" -I -B "%~dp0desktop\\main.py" %*\r\n'
    add("My Video App.cmd", len(command), command)
    for name in ("README.ko.md", "THIRD_PARTY_NOTICES.md"):
        source = root / "desktop" / name
        add(name, source.stat().st_size, source)
    for item, path in notices:
        add(item["destination"], item["size"], path)
    for item in lock.get("localNotices", []):
        source = root / item["source"]
        if (source.is_symlink() or not source.is_file() or source.stat().st_size != item["size"]
                or sha256_file(source) != item["sha256"]):
            raise ValueError("Local runtime notice is missing or changed")
        add(item["destination"], item["size"], source)
        source_hashes[item["source"]] = item["sha256"]
    source_notice = canonical_json(lock)
    add("licenses/dependencies-lock.json", len(source_notice), source_notice)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    with ExitStack() as stack:
        for item, path in archives:
            archive = stack.enter_context(zipfile.ZipFile(path))
            package = item["id"]
            for name, info in archive_members(archive):
                if package == "python":
                    destination = "runtime/python/" + name[6:] if name.startswith("tools/") else f"licenses/python-package/{name}"
                elif package == "deno":
                    destination = "runtime/deno.exe" if name == f"deno-{item['version']}.data/scripts/deno.exe" else f"licenses/deno/{name}"
                elif package == "ffmpeg":
                    prefix = item["archiveRoot"] + "/"
                    if not name.startswith(prefix):
                        raise ValueError("Unexpected top-level FFmpeg archive path")
                    relative = name[len(prefix):]
                    if relative == "bin/ffplay.exe":
                        continue
                    if relative in {"bin/ffmpeg.exe", "bin/ffprobe.exe"}:
                        destination = "runtime/ffmpeg/" + relative[4:]
                    elif relative.startswith("bin/"):
                        raise ValueError("Static FFmpeg archive contains unexpected executables/libraries")
                    else:
                        destination = "licenses/ffmpeg/" + relative
                else:
                    if package == "pyside6-essentials" and (name.startswith(QT_OMIT_PREFIXES) or name in QT_OMIT_FILES):
                        continue
                    destination = wheel_destination(package, name)
                add(destination, info.file_size, (archive, info))
        required = (
            "runtime/python/python.exe", "runtime/python/pythonw.exe", "runtime/python/LICENSE.txt", "runtime/deno.exe",
            "runtime/python/python313.dll", "runtime/python/vcruntime140.dll", "runtime/python/Lib/os.py",
            "runtime/python/Lib/ssl.py", "runtime/python/DLLs/_ssl.pyd",
            "runtime/ffmpeg/ffmpeg.exe", "runtime/ffmpeg/ffprobe.exe", "licenses/ffmpeg/LICENSE.txt",
            "runtime/python/Lib/site-packages/yt_dlp/__init__.py", "runtime/python/Lib/site-packages/yt_dlp_ejs/__init__.py",
            "runtime/python/Lib/site-packages/PySide6/__init__.py", "runtime/python/Lib/site-packages/shiboken6/__init__.py",
            "runtime/python/Lib/site-packages/PySide6/QtCore.pyd", "runtime/python/Lib/site-packages/PySide6/QtGui.pyd",
            "runtime/python/Lib/site-packages/PySide6/QtWidgets.pyd", "runtime/python/Lib/site-packages/PySide6/plugins/platforms/qwindows.dll",
            "runtime/python/Lib/site-packages/PySide6/Qt6Core.dll", "runtime/python/Lib/site-packages/PySide6/Qt6Gui.dll",
            "runtime/python/Lib/site-packages/PySide6/Qt6Widgets.dll", "runtime/python/Lib/site-packages/PySide6/msvcp140.dll",
        )
        if any(name not in plan for name in required):
            raise ValueError("Pinned desktop runtime archives are incomplete")

        def open_source(source):
            if isinstance(source, Path):
                return source.open("rb")
            if isinstance(source, bytes):
                return BytesIO(source)
            archive, info = source
            return archive.open(info)

        checked = ["My Video App.exe", "runtime/python/python.exe", "runtime/python/pythonw.exe", "runtime/deno.exe", "runtime/ffmpeg/ffmpeg.exe", "runtime/ffmpeg/ffprobe.exe", "runtime/python/Lib/site-packages/PySide6/QtWidgets.pyd"]
        for name in checked:
            with open_source(plan[name][1]) as source:
                validate_pe(source, name)

        def write_member(bundle, name, source, expected_size):
            entry = zipfile.ZipInfo(PREFIX + name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry._compresslevel = 6
            digest, count = hashlib.sha256(), 0
            with bundle.open(entry, "w") as target:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    count += len(chunk)
                    if count > expected_size:
                        raise ValueError(f"Archive member grew beyond its declared size: {name}")
                    target.write(chunk)
                    digest.update(chunk)
            if count != expected_size:
                raise ValueError(f"Archive member did not match its declared size: {name}")
            return digest.hexdigest()

        try:
            with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".desktop-", delete=False) as target:
                temporary = Path(target.name)
            hashes = {}
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
                for name, (size, source) in sorted(plan.items()):
                    with open_source(source) as stream:
                        hashes[name] = write_member(bundle, name, stream, size)
                for source_name, digest in source_hashes.items():
                    destination = "My Video App.exe" if source_name == "desktop/launcher/MyVideoApp.exe" else source_name
                    if destination in hashes and hashes[destination] != digest:
                        raise ValueError(f"Application source changed while packaging: {source_name}")
                manifest = canonical_json({
                    "schema": 1, "name": "My Video App", "version": app_version, "platform": lock["platform"],
                    "inputs": lock["inputs"], "notices": lock.get("notices", []), "sourceFiles": source_hashes,
                    "omittedOptionalComponents": {"ffmpeg": ["bin/ffplay.exe"], "pyside6-essentials": list(QT_OMIT_PREFIXES) + sorted(QT_OMIT_FILES)},
                    "files": hashes, "manifestHashScope": "Every other file in this archive; APPMANIFEST.json excludes itself.",
                    "validation": {"windowsExecutionPerformed": False, "pe32PlusAmd64": checked},
                })
                if total + len(manifest) > MAX_TOTAL_BYTES:
                    raise ValueError("Desktop manifest exceeds extraction limits")
                write_member(bundle, "APPMANIFEST.json", BytesIO(manifest), len(manifest))
            os.replace(temporary, output)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return {"output": str(output), "version": app_version, "sha256": sha256_file(output), "size": output.stat().st_size, "files": len(plan) + 1, "uncompressedBytes": total + len(manifest)}


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=root / "desktop/dependencies-lock.json")
    parser.add_argument("--cache", type=Path, default=root / ".cache/desktop-runtime")
    parser.add_argument("--output", type=Path, default=root / "artifacts/my-video-app-desktop-windows-x64.zip")
    parser.add_argument("--offline", action="store_true", help="Use only cached, SHA-256 verified inputs")
    args = parser.parse_args()
    print(json.dumps(build_bundle(root, args.lock, args.cache, args.output, args.offline), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
