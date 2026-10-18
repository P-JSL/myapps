#!/usr/bin/env python3
"""Install/uninstall this host for the current user; never needs administrator access."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import tempfile
import sys

NAME = "com.myvideoapp.antivirus"


def locations(browser: str) -> tuple[Path, list[Path]]:
    home = Path.home()
    browsers = ["chrome", "chromium"] if browser == "both" else [browser]
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local")) / "MyVideoApp" / "Antivirus"
        return base, [base / f"{name}-{NAME}.json" for name in browsers]
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support" / "My Video App" / "antivirus"
        manifests = [home / "Library" / "Application Support" / ("Google/Chrome" if name == "chrome" else "Chromium") / "NativeMessagingHosts" / f"{NAME}.json" for name in browsers]
        return base, manifests
    base = home / ".local" / "share" / "my-video-app-antivirus"
    config = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    if not config.is_absolute():
        raise ValueError("XDG_CONFIG_HOME must be absolute.")
    manifests = [config / ("google-chrome" if name == "chrome" else "chromium") / "NativeMessagingHosts" / f"{NAME}.json" for name in browsers]
    return base, manifests


def write_private(path: Path, content: str, mode: int = 0o600) -> None:
    # Do not follow a previously planted link when updating an installation.
    if path.is_symlink():
        raise ValueError(f"Refusing to overwrite symbolic link: {path}")
    descriptor, temporary = tempfile.mkstemp(prefix=".mva-", dir=path.parent)
    try:
        os.chmod(temporary, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            output.write(content)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


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


def main() -> int:
    parser = argparse.ArgumentParser(description="Install My Video App local antivirus native host for this OS account.")
    parser.add_argument("--extension-id", action="append", default=[], help="32-character ID shown at chrome://extensions; repeat to allow multiple IDs")
    parser.add_argument("--browser", choices=("chrome", "chromium", "both"), default="chrome")
    parser.add_argument("--scanner", choices=("auto", "defender", "clamav"), default="auto", help="auto: use Windows active antivirus, otherwise installed ClamAV")
    parser.add_argument("--clamav", help="Optional absolute path to an installed clamscan executable; no commands or arguments")
    parser.add_argument("--uninstall", action="store_true", help="Remove this host registration and its own installed files")
    arguments = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error("Python 3.11 or later is required.")
    if not arguments.uninstall and (not arguments.extension_id or any(not re.fullmatch(r"[a-p]{32}", item) for item in arguments.extension_id)):
        parser.error("Supply at least one valid --extension-id from chrome://extensions.")
    base, manifests = locations(arguments.browser)
    browsers = ["chrome", "chromium"] if arguments.browser == "both" else [arguments.browser]
    if arguments.uninstall:
        for browser, manifest in zip(browsers, manifests):
            if sys.platform == "win32":
                registry_update(browser, None)
            if manifest.is_symlink():
                raise ValueError(f"Refusing to remove symbolic link: {manifest}")
            manifest.unlink(missing_ok=True)
        _, all_manifests = locations("both")
        if any(path.exists() for path in all_manifests):
            print("Selected registration removed; companion files retained for another registered browser.")
            return 0
        # Only remove fixed filenames we install; never recursively remove user data.
        for name in ("antivirus_host.py", "windows_antivirus.py", "config.json", "launch.sh", "launch.cmd"):
            target = base / name
            if target.is_symlink():
                raise ValueError(f"Refusing to remove symbolic link: {target}")
            target.unlink(missing_ok=True)
        try:
            base.rmdir()
        except OSError:
            pass
        print("My Video App antivirus host registration removed for the selected browser(s).")
        return 0
    if arguments.scanner == "defender" and arguments.clamav:
        parser.error("--clamav cannot be combined with --scanner defender.")
    config = {"scanner": arguments.scanner}
    if arguments.clamav:
        executable = Path(arguments.clamav)
        if not executable.is_absolute() or not executable.is_file():
            parser.error("--clamav must be an existing absolute executable path.")
        executable = executable.resolve(strict=True)
        if executable.name.lower() not in {"clamscan", "clamscan.exe"}:
            parser.error("Only an installed clamscan executable is supported.")
        config["clamav"] = str(executable)
    if base.is_symlink():
        raise ValueError(f"Refusing a symbolic link install directory: {base}")
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(base, 0o700)
    source = Path(__file__).with_name("antivirus_host.py")
    write_private(base / "antivirus_host.py", source.read_text(encoding="utf-8"))
    write_private(base / "windows_antivirus.py", source.with_name("windows_antivirus.py").read_text(encoding="utf-8"))
    write_private(base / "config.json", json.dumps(config, ensure_ascii=True, indent=2) + "\n")
    python = str(Path(sys.executable).absolute())
    host = str(base / "antivirus_host.py")
    if sys.platform == "win32":
        if any(character in python + host for character in '\r\n"'):
            raise ValueError("Unsupported characters in the Python or installation path.")
        launcher = base / "launch.cmd"
        # Fixed quoted commands; do not forward browser-provided arguments into cmd.
        content = '@echo off\nsetlocal DisableDelayedExpansion\n"{}" -I "{}"\n'.format(python.replace("%", "%%"), host.replace("%", "%%"))
    else:
        launcher = base / "launch.sh"
        content = f"#!/bin/sh\nexec {shlex.quote(python)} -I {shlex.quote(host)}\n"
    write_private(launcher, content, 0o700)
    manifest_data = {"name": NAME, "description": "My Video App system antivirus bridge", "path": str(launcher),
                     "type": "stdio", "allowed_origins": [f"chrome-extension://{item}/" for item in sorted(set(arguments.extension_id))]}
    for browser, manifest in zip(browsers, manifests):
        manifest.parent.mkdir(parents=True, exist_ok=True)
        write_private(manifest, json.dumps(manifest_data, indent=2) + "\n")
        if sys.platform == "win32":
            registry_update(browser, manifest)
    print("Installed My Video App antivirus host for this OS account.")
    print("Allowed extension IDs: " + ", ".join(sorted(set(arguments.extension_id))))
    print("No antivirus/Chrome protection preferences were changed. Restart the extension before scanning.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"Installation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
