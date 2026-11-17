# Third-party components

My Video App 1.1.0 uses an independent TypeScript application engine. The original
Video Download Helper service, activation/subscription logic, injected extractors,
QuickJS and original libav binaries are not included in the current application
or its install/source ZIPs. Historical upstream files remain in Git history at
commit `806ef92`; the initial uploaded archive's hashes are recorded separately.

The two PNG icons in `assets/bitmaps` are the new video-download artwork generated
for My Video App. Original upstream branding is no longer shipped. Historical
upstream materials retain their original rights and notices in Git history.

Local stream remuxing and upscaling use **@ffmpeg/core 0.12.10**, licensed
**GPL-2.0-or-later**, from https://github.com/ffmpegwasm/ffmpeg.wasm.
This core includes FFmpeg and codecs including x264. Their component licenses and
corresponding-source/build obligations apply. GPL v2 is provided in
`licenses/ffmpeg-GPL-2.0.txt`. Upstream build configuration and source references:
https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10 (including `build/` and
`Dockerfile`). Preserve the notices and corresponding sources required for the
exact binaries when redistributing them.

The offline compressed-engine bootstrap includes **brotli-dec-wasm 2.3.2** from
https://github.com/ustclug-dev/brotli-dec-wasm. We distribute it under its offered
**MIT** license, reproduced in `licenses/brotli-dec-wasm-MIT.txt`. Its pinned Wasm
decoder and bundled JavaScript wrapper only decompress the authenticated local
engine payload; they do not download code or media from a third-party service.
The decoder is an extension runtime component, unlike the build/test tools below.
The same license file includes the bundled Rust dependency notices, including
Dropbox BSD notices for brotli-decompressor/alloc and selected MIT notices for the
runtime support crates. Versions are bound to the npm release's source commit
`04947d5b2cbcf0487435d26d6598ea624a6b191b` and its Cargo.lock, rather than the
upstream development branch.

Build/test dependencies: TypeScript (Apache-2.0), esbuild (MIT), Playwright
(Apache-2.0), DefinitelyTyped declarations (MIT). Pinned versions and npm integrity
hashes are in `package-lock.json`. These build tools are not extension runtime code.

## HTTP/3 test tooling

The optional local HTTP/3 test server uses aioquic 1.3.0 (BSD-3-Clause), installed separately in a development Python environment. It and its Python dependencies are not bundled in the extension ZIP. OpenSSL and Chromium are system test tools. Generated test certificates and private keys are temporary and are not shipped.

## Optional local antivirus integration

The native messaging bridge uses separately installed ClamAV (GPL-2.0) or Microsoft Defender under its operating-system license. Antivirus engines and signature databases are not bundled in the extension, source or helper ZIPs. An isolated ClamAV 1.4.6 test used a private test-only signature database; that does not verify the freshness or coverage of official signatures.

Windows antivirus auto-selection uses the operating system's Windows Security Center and AMSI APIs, Microsoft Defender, or the registered AMSI providers under their respective installed licenses. No third-party antivirus engine is bundled. Their existing cloud protection and sample-submission policies remain in effect.
