#!/usr/bin/env python3
"""Explicit real-engine integration test; uses only a temporary test-only database.

Run with --clamav /absolute/clamscan --video /absolute/clean.mp4. An optional
--eicar path must refer to an ephemeral standard harmless antivirus test file
outside the repository; its contents are never printed or copied into reports.
The encrypted-content check requires the test-only `zip` command; its password
and payload are harmless fixtures created and removed in a temporary directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clamav", required=True)
    parser.add_argument("--video", required=True)
    parser.add_argument("--eicar", help="Optional temporary standard antivirus test file outside this repository")
    parser.add_argument("--report", help="Optional JSON report output; no sample contents are written")
    options = parser.parse_args()
    executable = Path(options.clamav).resolve(strict=True)
    video = Path(options.video).resolve(strict=True)
    version = subprocess.run([str(executable), "--version"], capture_output=True, text=True, check=True).stdout.strip()
    zip_executable = shutil.which("zip")
    if zip_executable is None:
        raise RuntimeError("The test-only zip command is required for the encrypted archive regression check.")
    outcomes = []
    with tempfile.TemporaryDirectory(prefix="mva-real-clamav-") as temporary:
        root = Path(temporary).resolve()
        database = root / "local-test.hdb"
        harmless = root / "harmless-detection.mp4"
        harmless.write_bytes(b"My Video App harmless local antivirus integration signature fixture.\n")
        samples = [(harmless, "MVA.Local.Harmless.Test")]
        if options.eicar:
            eicar = Path(options.eicar).resolve(strict=True)
            repository = Path(__file__).resolve().parent.parent
            if repository == eicar or repository in eicar.parents:
                raise ValueError("The standard antivirus test file must be outside the repository.")
            if eicar.stat().st_size != 68:
                raise ValueError("Expected the 68-byte standard antivirus test file.")
            samples.append((eicar, "MVA.Local.StandardAntivirus.Test"))
        database.write_text("".join(f"{hashlib.md5(path.read_bytes(), usedforsecurity=False).hexdigest()}:{path.stat().st_size}:{name}\n" for path, name in samples), encoding="ascii")
        host_directory = root / "host"
        host_directory.mkdir(mode=0o700)
        installed_host = host_directory / "antivirus_host.py"
        shutil.copyfile(Path(__file__).with_name("antivirus_host.py"), installed_host)
        # This adapter supplies only a private test database to the actual engine.
        # Production scanner discovery/arguments and verdict parsing are unchanged.
        wrapper = root / "clamscan"
        wrapper.write_text("#!" + sys.executable + "\nimport os,sys\nos.execv(" + repr(str(executable)) + ", [" + repr(str(executable)) + ", " + repr("--database=" + str(database)) + ", *sys.argv[1:]])\n", encoding="utf-8")
        wrapper.chmod(0o700)
        (host_directory / "config.json").write_text(json.dumps({"clamav": str(wrapper)}), encoding="utf-8")

        def scan(path: Path, expected: str, name: str) -> dict:
            request = json.dumps({"version": 1, "action": "scan", "requestId": "integration-" + str(len(outcomes)), "path": str(path)}).encode()
            result = subprocess.run([sys.executable, "-I", str(installed_host)], input=struct.pack("<I", len(request)) + request,
                                    capture_output=True, timeout=150, check=True)
            if len(result.stdout) < 4 or struct.unpack("<I", result.stdout[:4])[0] != len(result.stdout) - 4:
                raise AssertionError("Invalid native response framing.")
            response = json.loads(result.stdout[4:])
            if response.get("status") != expected:
                raise AssertionError(f"{name}: expected {expected}, got {response.get('status')}: {response.get('message', '')}")
            if expected in ("clean", "infected"):
                if response.get("sha256") != hashlib.sha256(path.read_bytes()).hexdigest() or response.get("size") != path.stat().st_size:
                    raise AssertionError("Incorrect scanned-byte identity.")
            outcomes.append({"name": name, "status": "passed", "verdict": expected, "engine": response.get("engine")})
            print("PASS " + name)
            return response

        payload = json.dumps({"version": 1, "action": "status", "requestId": "integration-readiness"}).encode()
        probe = subprocess.run([sys.executable, "-I", str(installed_host)], input=struct.pack("<I", len(payload)) + payload,
                               capture_output=True, timeout=30, check=True)
        if len(probe.stdout) < 4 or struct.unpack("<I", probe.stdout[:4])[0] != len(probe.stdout) - 4:
            raise AssertionError("Invalid native readiness response framing.")
        readiness = json.loads(probe.stdout[4:])
        if readiness.get("status") != "ready" or readiness.get("engine") != "ClamAV" or readiness.get("requestId") != "integration-readiness":
            raise AssertionError("Actual ClamAV readiness was not confirmed by the native host.")
        outcomes.append({"name": "Native readiness request contacts real ClamAV without scanning a user file", "status": "passed", "verdict": "ready", "engine": "ClamAV"})
        print("PASS " + outcomes[-1]["name"])
        scan(video, "clean", "Complete native messaging scan of clean MP4 with real ClamAV")
        scan(harmless, "infected", "Real ClamAV detects harmless custom local test signature; original retained")
        if not harmless.exists():
            raise AssertionError("The host removed the detection fixture.")
        encrypted = root / "encrypted-download.mp4"
        subprocess.run([zip_executable, "-q", "-P", "my-video-app-harmless-test-fixture", str(encrypted), harmless.name],
                       cwd=root, check=True, capture_output=True)
        scan(encrypted, "error", "Real ClamAV encrypted archive renamed MP4 remains explicitly unscanned")
        if options.eicar:
            scan(eicar, "infected", "Real ClamAV detects standard harmless antivirus marker using test-only local signature")
        database.write_text("intentionally-invalid-test-database\n", encoding="ascii")
        scan(video, "error", "Real ClamAV invalid-database error never becomes a clean verdict")
    report = {"version": 1, "engineVersion": version, "signatureScope": "Private test-only local hash database; official signature database freshness/coverage not tested",
              "nativeHost": "com.myvideoapp.antivirus", "fileUpload": False, "officialDatabaseVerified": False,
              "sourceSha256": hashlib.sha256(Path(__file__).with_name("antivirus_host.py").read_bytes()).hexdigest(), "outcomes": outcomes}
    if options.report:
        Path(options.report).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"{len(outcomes)} real ClamAV native messaging checks passed ({version}); test-only signatures.")


if __name__ == "__main__":
    main()
