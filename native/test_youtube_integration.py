#!/usr/bin/env python3
"""Explicit real pinned-package/runtime test. No YouTube network calls or cookies.

Run using the isolated dependency Python with --deno /absolute/deno --report ... .
The extractor is an explicitly injected harmless InfoExtractor fixture; genuine
YoutubeDL extraction, format processing, native selection and Deno are exercised.
This is not evidence of a successful live YouTube download.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import sys
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deno", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    host_path = Path(__file__).with_name("youtube_host.py")
    spec = importlib.util.spec_from_file_location("host", host_path)
    host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)
    import yt_dlp
    import yt_dlp_ejs
    from yt_dlp.extractor.common import InfoExtractor
    assert importlib.metadata.version("yt-dlp") == host.VERSION
    assert importlib.metadata.version("yt-dlp-ejs") == host.EJS_VERSION
    deno = Path(args.deno)
    host._safe_file(deno, executable=True)
    version = host.run_process([str(deno), "--version"], timeout=5, output_limit=4096).decode().splitlines()[0]
    outcomes = [{"name": "pinned-package-and-real-runtime-readiness", "status": "passed"}]
    original = yt_dlp.YoutubeDL
    seen_options = []
    class FixtureIE(InfoExtractor):
        _VALID_URL = r"https://www\.youtube\.com/watch\?v=(?P<id>[A-Za-z0-9_-]{11})"
        def _real_extract(self, url):
            identifier = self._match_id(url)
            formats = []
            for itag, height, ext, kind, rate in [(18, 720, "mp4", "combined", 800), (137, 1080, "mp4", "video", 2000),
                                                   (313, 2160, "webm", "video", 4000), (140, None, "m4a", "audio", 128),
                                                   (251, None, "webm", "audio", 160)]:
                formats.append({"format_id": str(itag), "url": f"https://rr1---sn-example.googlevideo.com/videoplayback?itag={itag}",
                                "ext": ext, "height": height, "vcodec": "none" if kind == "audio" else "vp9" if ext == "webm" else "h264",
                                "acodec": "none" if kind == "video" else "opus" if ext == "webm" else "aac", "tbr": rate})
            return {"id": identifier, "title": "Real-package offline fixture", "duration": 14400.5,
                    "live_status": "not_live", "availability": "public", "formats": formats}
    def downloader(options):
        # YoutubeDL normalizes some options in place (for example an empty
        # remote component list becomes a set); retain the actual constructor
        # input so the assertion checks our policy rather than its container type.
        seen_options.append(copy.deepcopy(options))
        value = original(options, auto_init=False)
        value.add_info_extractor(FixtureIE())
        return value
    request = {"version": 1, "requestId": "11111111-1111-4111-8111-111111111111", "action": "resolve",
               "url": "https://www.youtube.com/watch?v=abcdefghijk", "quality": "highest", "output": "original", "userAgent": "Chrome harmless offline fixture"}
    with patch.object(host, "configuration", return_value=deno), patch.object(yt_dlp, "YoutubeDL", side_effect=downloader):
        highest = host.extract(request)
        assert [track["formatId"] for track in highest["tracks"]] == ["313", "251"]
        assert highest["duration"] == 14400.5
        outcomes.append({"name": "real-ytdlp-offline-extraction-highest-split-tracks", "status": "passed"})
        ceiling = host.extract({**request, "quality": "1080"})
        assert [track["formatId"] for track in ceiling["tracks"]] == ["137", "140"]
        outcomes.append({"name": "real-ytdlp-offline-quality-ceiling", "status": "passed"})
        audio = host.extract({**request, "output": "m4a"})
        assert len(audio["tracks"]) == 1 and audio["tracks"][0]["kind"] == "audio"
        outcomes.append({"name": "real-ytdlp-offline-audio-only", "status": "passed"})
    for options in seen_options:
        assert options["cookiefile"] is None and options["cookiesfrombrowser"] is None
        assert options["cachedir"] is False and options["remote_components"] == [] and options["skip_download"] is True
    assert yt_dlp.globals.plugin_dirs.value == []
    outcomes.append({"name": "real-package-config-isolation-and-no-browser-cookie-access", "status": "passed"})
    source = "const results={};try{Deno.readTextFileSync('/etc/passwd');results.file=false}catch(e){results.file=e instanceof Deno.errors.NotCapable}try{await fetch('https://example.invalid/');results.network=false}catch(e){results.network=e instanceof Deno.errors.NotCapable}console.log(JSON.stringify(results));"
    output = host.run_process([str(deno), "run", "--no-config", "--no-prompt", "--no-remote", "--no-npm", "--no-lock", "--no-code-cache", "--ext=js", "-"], source.encode(), timeout=10, output_limit=4096)
    assert json.loads(output) == {"file": True, "network": True}
    outcomes.append({"name": "real-deno-sandbox-denies-file-and-network-permissions", "status": "passed"})
    # Run the shipped EJS protocol on a harmless preprocessed fixture. This
    # exercises the actual solver bundles, not a hand-written solver, while
    # deliberately making no claim about parsing today's remote YouTube player.
    from yt_dlp_ejs.yt.solver import core, lib
    bundles = {"core": core(), "lib": lib()}
    challenge = {"type": "preprocessed",
                 "preprocessed_player": "_result.n=(value)=>value.split('').reverse().join('');_result.sig=(value)=>value.slice(1)+value[0];",
                 "requests": [{"type": "n", "challenges": ["abc123"]}, {"type": "sig", "challenges": ["signature"]}]}
    program = bundles["lib"] + "\nObject.assign(globalThis,lib);\n" + bundles["core"]
    program += "\nconsole.log(JSON.stringify(jsc(" + json.dumps(challenge) + ")));\n"
    output = host.run_process([str(deno), "run", "--no-config", "--no-prompt", "--no-remote", "--no-npm", "--no-lock", "--no-code-cache", "--ext=js", "-"],
                              program.encode(), timeout=10, output_limit=4096)
    assert json.loads(output) == {"type": "result", "responses": [
        {"type": "result", "data": {"abc123": "321cba"}},
        {"type": "result", "data": {"signature": "ignatures"}}]}
    outcomes.append({"name": "real-ejs-and-deno-harmless-preprocessed-challenge-protocol", "status": "passed"})
    # Exercise the actual yt-dlp provider and capture (without replacing) its
    # real subprocess execution. The provider reads the youtube-ejs option key;
    # checking only a hand-written Deno argv would miss a misspelled key.
    from yt_dlp.extractor.youtube import YoutubeIE
    from yt_dlp.extractor.youtube.jsc._builtin import deno as deno_provider
    class ProviderLogger:
        prefix = "offline integration fixture"
        def debug(self, *_args, **_kwargs): pass
        def trace(self, *_args, **_kwargs): pass
        def info(self, *_args, **_kwargs): pass
        def warning(self, *_args, **_kwargs): pass
    commands = []
    real_popen = deno_provider.Popen
    def tracked_popen(argv, **kwargs):
        commands.append(list(argv))
        return real_popen(argv, **kwargs)
    with original(copy.deepcopy(seen_options[0]), auto_init=False) as downloader:
        provider = deno_provider.DenoJCP(YoutubeIE(downloader), ProviderLogger(), {})
        assert provider.ejs_setting("jitless", ["false"]) == ["true"]
        assert provider.is_available()
        with patch.object(deno_provider, "Popen", side_effect=tracked_popen):
            assert json.loads(provider._run_js_runtime(program)) == json.loads(output)
    assert len(commands) == 1
    assert {"--v8-flags=--jitless", "--no-config", "--no-prompt", "--no-remote", "--no-npm", "--cached-only"} <= set(commands[0])
    assert not any(argument.startswith("--allow-") or argument.startswith("--unsafely-") for argument in commands[0])
    outcomes.append({"name": "real-ytdlp-deno-provider-honors-jitless-and-sandbox-policy", "status": "passed"})
    files = ["youtube_host.py", "install_youtube.py", "youtube-requirements.txt", "test_youtube_integration.py"]
    report = {"status": "passed", "ytDlpVersion": host.VERSION, "ejsVersion": yt_dlp_ejs.version, "runtime": version,
              "scope": "Real hash-installed yt-dlp/EJS packages and Deno runtime; local injected InfoExtractor and harmless preprocessed-player fixtures; no live YouTube requests, cookies, media writes or real browser/native registration. The EJS protocol check does not validate current remote player parsing.",
              "liveSiteValidation": {"status": "not-run", "reason": "This reproducible offline test intentionally makes no site network requests."},
              "runtimeExecutableSha256": hashlib.sha256(deno.read_bytes()).hexdigest(),
              "ejsBundleSha256": {name: hashlib.sha256(code.encode()).hexdigest() for name, code in bundles.items()},
              "outcomes": outcomes, "sourceSha256": {"native/" + name: hashlib.sha256(host_path.with_name(name).read_bytes()).hexdigest() for name in files}}
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"{len(outcomes)} actual pinned YouTube package/runtime offline checks passed.")


if __name__ == "__main__": main()
