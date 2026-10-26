// Reviewable build catalog; tests are deliberately absent from shipped entry points.
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
export const browserEntries = freeze([
  {
    "input": "src/local/background.ts",
    "output": "local/background.js",
    "format": "esm"
  },
  {
    "input": "src/local/collect.ts",
    "output": "local/collect.js",
    "format": "iife"
  },
  {
    "input": "src/local/offscreen.ts",
    "output": "local/offscreen.js",
    "format": "esm"
  },
  {
    "input": "src/local/ui.ts",
    "output": "local/ui.js",
    "format": "esm"
  },
  {
    "input": "src/local/popup.ts",
    "output": "local/popup.js",
    "format": "esm"
  },
  {
    "input": "src/local/stream-worker.ts",
    "output": "local/stream-worker.js",
    "format": "esm",
    "external": [
      "../vendor/ffmpeg/ffmpeg-core.js"
    ]
  },
  {
    "input": "src/local/large-stream-worker.ts",
    "output": "local/large-stream-worker.js",
    "format": "esm",
    "external": ["../vendor/ffmpeg/ffmpeg-core.js"]
  },
  {
    "input": "src/upscale/worker.ts",
    "output": "hardening/upscale-worker.js",
    "format": "esm",
    "external": [
      "../vendor/ffmpeg/ffmpeg-core.js"
    ]
  },
  {
    "input": "src/ui/app.ts",
    "output": "upscale/app.js",
    "format": "esm"
  }
]);
// Vendor wrappers are bundled separately and retain only their required default export.
export const vendorEntries = freeze([
  { "input": "scripts/lib/browser-brotli.mjs", "output": "vendor/brotli/decoder.js", "format": "esm" }
]);
export const staticFiles = freeze([
  {
    "input": "src/local/index.html",
    "output": "local/index.html"
  },
  {
    "input": "src/local/offscreen.html",
    "output": "local/offscreen.html"
  },
  {
    "input": "src/local/style.css",
    "output": "local/style.css"
  },
  {
    "input": "src/local/popup.html",
    "output": "local/popup.html"
  },
  {
    "input": "src/local/popup.css",
    "output": "local/popup.css"
  },
  {
    "input": "src/ui/index.html",
    "output": "upscale/index.html"
  },
  {
    "input": "src/ui/style.css",
    "output": "upscale/style.css"
  },
  {
    "input": "src/local/manifest.json",
    "output": "manifest.json"
  },
  {
    "input": "THIRD_PARTY_NOTICES.md",
    "output": "licenses/THIRD_PARTY_NOTICES.md"
  },
  {
    "input": "licenses/ffmpeg-GPL-2.0.txt",
    "output": "licenses/ffmpeg-GPL-2.0.txt"
  },
  {
    "input": "licenses/brotli-dec-wasm-MIT.txt",
    "output": "licenses/brotli-dec-wasm-MIT.txt"
  },
  {
    "input": "reports/LOCAL_MODE.ko.md",
    "output": "LOCAL_MODE.ko.md"
  },
  {
    "input": "native/YOUTUBE.ko.md",
    "output": "YOUTUBE.ko.md"
  },
  {
    "input": "reports/FEATURES.ko.md",
    "output": "FEATURES.ko.md"
  },
  {
    "input": "reports/DOWNLOADS_HTTP3.ko.md",
    "output": "DOWNLOADS_HTTP3.ko.md"
  },
  {
    "input": "reports/SECURITY_DOWNLOADS.ko.md",
    "output": "SECURITY_DOWNLOADS.ko.md"
  },
  {
    "input": "reports/DATABASE.ko.md",
    "output": "DATABASE.ko.md"
  },
  {
    "input": "reports/LARGE_DOWNLOADS.ko.md",
    "output": "LARGE_DOWNLOADS.ko.md"
  },
  {
    "input": "reports/INTERNAL_SCAN.ko.md",
    "output": "INTERNAL_SCAN.ko.md"
  },
  {
    "input": "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js",
    "output": "vendor/ffmpeg/ffmpeg-core.js"
  },
  {
    "input": "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm",
    "output": "vendor/ffmpeg/ffmpeg-core.wasm"
  },
  {
    "input": "node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm_bg.wasm",
    "output": "vendor/brotli/brotli_dec_wasm_bg.wasm"
  }
]);
export const directoryCopies = freeze([{ input: 'assets/bitmaps', output: 'bitmaps' }]);
export const capabilities = freeze([
  "http-media-detection",
  "native-download",
  "unencrypted-hls-vod",
  "unencrypted-dash-vod",
  "local-history",
  "local-upscale",
  "stream-quality-selection",
  "audio-download",
  "local-transcode",
  "audio-extract",
  "local-track-merge",
  "browser-http3-negotiation",
  "observed-transport",
  "bounded-network-retries",
  "queued-preparation",
  "parallel-segments",
  "local-antivirus-integration",
  "browser-danger-review",
  "explicit-security-decisions",
  "windows-default-antivirus",
  "active-antivirus-discovery",
  "windows-amsi-integration",
  "effective-manifest-urls",
  "inherited-dash-templates",
  "antivirus-readiness",
  "remembered-download-options",
  "stable-keyboard-focus",
  "automatic-indexeddb-management",
  "toolbar-media-popup",
  "authenticated-rescan",
  "media-signature-validation",
  "canonical-media-filenames",
  "builtin-static-risk-screening",
  "predecode-risk-check",
  "hash-bound-risk-evidence",
  "sticky-risk-review",
  "antivirus-integration-toggle",
  "parallel-range-download",
  "disk-backed-stream-remux",
  "incremental-large-file-hash",
  "offline-brotli-engine-packaging"
]);
export const algorithmSuites = freeze([['state','tests/bench-state.mjs'],['media','tests/bench-media.mjs'],['transfer','tests/bench-transfer.mjs'],['ui','tests/bench-ui.mjs'],['security','scripts/benchmark-security.mjs']]);
