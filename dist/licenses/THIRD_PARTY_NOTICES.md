# Third-party components

My Video App 1.1.0 uses an independent TypeScript application engine. The original
Video Download Helper service, activation/subscription logic, injected extractors,
QuickJS and original libav binaries are not included in the current application
or its install/source ZIPs. Historical upstream files remain in Git history at
commit `806ef92`; the initial uploaded archive's hashes are recorded separately.

The two PNG icons in `assets/bitmaps` came from the user-supplied upstream archive.
Their rights and branding remain with their original owners. No rights to those
images or to historical upstream materials are granted by this project.

Local stream remuxing and upscaling use **@ffmpeg/core 0.12.10**, licensed
**GPL-2.0-or-later**, from https://github.com/ffmpegwasm/ffmpeg.wasm.
This core includes FFmpeg and codecs including x264. Their component licenses and
corresponding-source/build obligations apply. GPL v2 is provided in
`licenses/ffmpeg-GPL-2.0.txt`. Upstream build configuration and source references:
https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10 (including `build/` and
`Dockerfile`). Preserve the notices and corresponding sources required for the
exact binaries when redistributing them.

Build/test dependencies: TypeScript (Apache-2.0), esbuild (MIT), Playwright
(Apache-2.0), DefinitelyTyped declarations (MIT). Pinned versions and npm integrity
hashes are in `package-lock.json`. These build tools are not extension runtime code.
