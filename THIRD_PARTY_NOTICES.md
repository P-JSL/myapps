# Third-party components

The user-supplied Video Download Helper 10.6.1.2 archive is preserved verbatim in
`vendor/original`. Its branding, entitlement logic, public keys, locales and
bundled license notices remain those of the original authors. The archive does
not supply a top-level source-code license or the original development project.
This workspace does not grant rights to those materials or claim to be an
official release. Check the original authors' terms before distributing a fork.

Original embedded notices include libav.js/FFmpeg and their LGPL notices,
m3u8-parser (Apache-2.0), and other bundled dependency notices. They remain in
their original files. The old Web Store `_metadata` signature files are preserved
in the source archive only; they do not authenticate this modified developer build.

The new local upscaler uses **@ffmpeg/core 0.12.10**, licensed
**GPL-2.0-or-later**, from https://github.com/ffmpegwasm/ffmpeg.wasm.
Its core build includes FFmpeg and codecs, including x264; upstream component
licenses and corresponding source/build instructions apply. The GPL v2 text is
provided in `licenses/ffmpeg-GPL-2.0.txt`. Upstream core source/build configuration:
https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10
and its `build/` and `Dockerfile` sources. A production redistribution must satisfy
the corresponding-source obligations for the exact binaries, including upstream
codec sources; the uploaded package alone does not establish that compliance.

Build/test-only dependencies: TypeScript (Apache-2.0), esbuild (MIT), Playwright
(Apache-2.0), DefinitelyTyped type declarations (MIT). Versions and npm integrity
hashes are pinned in `package-lock.json`. These tools are not extension runtime code.
