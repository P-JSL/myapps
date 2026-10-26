"""Cross-compile the native Windows x64 GUI launcher with pinned Zig."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import urllib.request
import zipfile

from verify_pe import inspect_launcher

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = ROOT / ".cache" / "windows-toolchain"
LOCK = json.loads((HERE / "toolchain-lock.json").read_text(encoding="utf-8"))


def fetch_zig() -> pathlib.Path:
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        raise SystemExit("Automatic toolchain fetch supports Linux x64. Install pinned Zig and pass --zig on other systems.")
    pinned = LOCK["linux_x86_64"]
    wheel = CACHE / pinned["filename"]
    CACHE.mkdir(parents=True, exist_ok=True)
    if not wheel.exists():
        temporary = wheel.with_suffix(".part")
        try:
            with urllib.request.urlopen(pinned["url"], timeout=60) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            temporary.replace(wheel)
        finally:
            temporary.unlink(missing_ok=True)
    with wheel.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != pinned["sha256"]:
        raise SystemExit("Pinned Zig wheel checksum mismatch; refusing to execute the compiler.")
    extracted = CACHE / f"zig-{LOCK['version']}"
    with zipfile.ZipFile(wheel) as archive:
        if any(pathlib.PurePosixPath(name).is_absolute() or ".." in pathlib.PurePosixPath(name).parts for name in archive.namelist()):
            raise SystemExit("Invalid toolchain archive path")
        archive.extractall(extracted)
    zig = extracted / "ziglang" / "zig"
    zig.chmod(0o755)
    return zig


def locate_zig(explicit: str | None, fetch: bool) -> pathlib.Path:
    if explicit:
        path = pathlib.Path(explicit).resolve()
    elif os.environ.get("ZIG"):
        path = pathlib.Path(os.environ["ZIG"]).resolve()
    else:
        cached = CACHE / f"zig-{LOCK['version']}" / "ziglang" / "zig"
        on_path = shutil.which("zig")
        module = importlib.util.find_spec("ziglang")
        if cached.is_file():
            path = cached
        elif on_path:
            path = pathlib.Path(on_path)
        elif module and module.origin:
            path = pathlib.Path(module.origin).parent / ("zig.exe" if os.name == "nt" else "zig")
        elif fetch:
            path = fetch_zig()
        else:
            raise SystemExit("Zig is unavailable. Pass --fetch-toolchain once on Linux x64 or --zig /path/to/zig.")
    version = subprocess.check_output([str(path), "version"], text=True).strip()
    if version != LOCK["version"]:
        raise SystemExit(f"Expected Zig {LOCK['version']}; found {version}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=HERE / "MyVideoApp.exe")
    parser.add_argument("--zig", help="Path to the pinned Zig executable")
    parser.add_argument("--fetch-toolchain", action="store_true", help="Download and hash-check the pinned compiler if unavailable")
    args = parser.parse_args()
    zig = locate_zig(args.zig, args.fetch_toolchain)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    build = CACHE / "launcher"
    build.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    environment["ZIG_GLOBAL_CACHE_DIR"] = str(CACHE / "zig-global")
    environment["ZIG_LOCAL_CACHE_DIR"] = str(CACHE / "zig-local")
    resource = build / "launcher.res"
    subprocess.run([str(zig), "rc", "/fo", str(resource), "launcher.rc"], cwd=HERE, env=environment, check=True)
    zig_environment = subprocess.check_output([str(zig), "env"], cwd=HERE, env=environment, text=True)
    library_match = re.search(r'\.lib_dir = ("(?:\\.|[^"\\])*")', zig_environment)
    if not library_match:
        raise SystemExit("Could not determine the pinned Zig header directory")
    zig_lib = (HERE / json.loads(library_match.group(1))).resolve()
    command = [
        str(zig), "cc", "-target", "x86_64-windows-gnu", "-Os", "-g0",
        "-Wall", "-Wextra", "-Werror", "-ffreestanding", "-fno-builtin",
        "-fno-stack-protector", "-nostdlib", "-Wl,--subsystem,windows",
        "-isystem", str(zig_lib / "libc" / "include" / "any-windows-any"),
        "-Wl,--entry,launcher_entry", "-Wl,--dynamicbase", "-Wl,--high-entropy-va",
        "-Wl,--nxcompat", "-Wl,--strip-all",
        str(HERE / "launcher.c"), str(resource), "-lkernel32", "-luser32", "-o", str(output),
    ]
    subprocess.run(command, cwd=HERE, env=environment, check=True)
    report = inspect_launcher(output)
    report["compiler"] = f"Zig {LOCK['version']}"
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
