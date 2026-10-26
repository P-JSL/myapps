#!/usr/bin/env python3
"""Offline smoke of an extracted Windows bundle using its actual native runtimes.

Run with the bundle's python.exe -I -B desktop/test_runtime.py --app-root PATH.
Only a synthetic repository fixture is served, bound to 127.0.0.1. No external
media sites, account credentials, or installed system runtimes are used.
"""
from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import uuid


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def assert_saved_media(saved: Path, destination: Path) -> None:
    # Windows TEMP often uses an 8.3 alias (RUNNER~1), whereas the engine
    # resolves the same directory to its full name. Compare filesystem identity.
    if not saved.is_file():
        raise AssertionError("The completed media file is missing: " + str(saved))
    if saved.stat().st_size < 1024:
        raise AssertionError("The completed media file is unexpectedly small.")
    if not saved.parent.samefile(destination):
        raise AssertionError("The media file was saved outside the selected directory.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-root", required=True, type=Path)
    arguments = parser.parse_args()
    root = arguments.app_root.resolve(strict=True)
    source = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "desktop-source.mp4"
    if not source.is_file():
        raise RuntimeError("The synthetic desktop fixture is missing from the repository.")
    # Load the packaged application code by a fixed path, even with -I isolation.
    specification = importlib.util.spec_from_file_location("myvideoapp_runtime_engine", root / "desktop" / "engine.py")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    ffprobe = root / "runtime" / "ffmpeg" / "ffprobe.exe"
    with tempfile.TemporaryDirectory(prefix="myvideoapp-runtime-") as temporary:
        work = Path(temporary)
        destination = work / "한글 저장 폴더"
        destination.mkdir()
        destination = destination.resolve(strict=True)
        downloader = module.Engine(root, work / "data")
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(source.parent)))
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/{source.name}"
            for output in ("original", "mp3", "m4a"):
                events = []
                identifier = uuid.uuid4().hex
                result = downloader.download(module.DownloadRequest(url, destination, output=output, job_id=identifier), events.append, threading.Event())
                saved = Path(result.filepath)
                assert_saved_media(saved, destination)
                expected_extension = ".mp4" if output == "original" else "." + output
                if saved.suffix != expected_extension or result.job_id != identifier:
                    raise AssertionError("Saved extension or GUI queue identifier does not match the request.")
                metadata = json.loads(subprocess.check_output([str(ffprobe), "-v", "error", "-show_entries",
                                                              "format=duration:stream=codec_name,codec_type", "-of", "json", str(saved)],
                                                             timeout=30, creationflags=0x08000000 if sys.platform == "win32" else 0))
                streams = metadata.get("streams", [])
                kinds = [item.get("codec_type") for item in streams]
                if kinds != (["video", "audio"] if output == "original" else ["audio"]):
                    raise AssertionError("The saved file has missing or unexpected streams.")
                expected_codec = {"original": ["h264", "aac"], "mp3": ["mp3"], "m4a": ["aac"]}[output]
                if [item.get("codec_name") for item in streams] != expected_codec or float(metadata["format"]["duration"]) < 0.9:
                    raise AssertionError("The saved file has an unexpected codec or duration.")
                if not events or events[-1].stage != "complete" or not any(item.stage == "processing" for item in events):
                    raise AssertionError("Progress events do not cover the completed lifecycle.")
                row = next(row for row in downloader.history() if row["job_id"] == identifier)
                if row["stage"] != "complete" or row["filepath"] != str(saved):
                    raise AssertionError("The local SQLite history does not match the saved file.")
                if list(destination.glob(".myvideoapp-*")):
                    raise AssertionError("Completed downloads left an owned temporary directory behind.")
                print(json.dumps({"output": output, "bytes": saved.stat().st_size, "codecs": expected_codec,
                                  "duration": metadata["format"]["duration"], "stage": row["stage"]}, sort_keys=True))
            if len(downloader.history()) != 3:
                raise AssertionError("Unexpected download history count.")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
