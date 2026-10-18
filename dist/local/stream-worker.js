// src/local/stream-worker.ts
import createFFmpegCore from "../vendor/ffmpeg/ffmpeg-core.js";

// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/upscale/policy.ts
var MAX_INPUT_BYTES = 256 * 1024 * 1024;
var MAX_QUEUE_BYTES = 512 * 1024 * 1024;
var RETENTION_MS = 24 * 60 * 60 * 1e3;

// src/local/model.ts
var MAX_STREAM_BYTES = 128 * 1024 * 1024;
var MAX_SEGMENTS = 4096;
function mediaURL(value, base) {
  if (typeof value !== "string" || !value || value.length > 8192) throw new Error("\uBBF8\uB514\uC5B4 \uC8FC\uC18C\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("HTTP \uB610\uB294 HTTPS \uBBF8\uB514\uC5B4 \uC8FC\uC18C\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
  url.hash = "";
  return url;
}

// src/local/network.ts
function validRange(range) {
  if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || !Number.isSafeInteger(range.offset + range.length) || range.offset < 0 || range.length < 1 || range.length > 128 * 1024 * 1024) throw new Error("\uBBF8\uB514\uC5B4 \uBC14\uC774\uD2B8 \uBC94\uC704\uAC00 \uD5C8\uC6A9 \uBC94\uC704\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
}
async function fetchBytes(url, maximum, signal, range) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3e4);
  let reader;
  try {
    const options = { credentials: "include", redirect: "follow", signal: AbortSignal.any([signal, controller.signal]) };
    if (range) {
      validRange(range);
      options.headers = { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
    }
    const response = await fetch(mediaURL(url), options);
    if (!response.ok || !response.body) throw new Error(`\uBBF8\uB514\uC5B4 \uC694\uCCAD \uC2E4\uD328 (${response.status})`);
    if (response.url) mediaURL(response.url);
    const declared = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > maximum) throw new Error("\uBBF8\uB514\uC5B4 \uC6A9\uB7C9\uC774 \uCC98\uB9AC \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
    if (range && response.status === 206) {
      const contentRange = response.headers.get("Content-Range")?.match(/^bytes (\d+)-(\d+)\//i);
      if (!contentRange || Number(contentRange[1]) !== range.offset || Number(contentRange[2]) !== range.offset + range.length - 1) throw new Error("\uC11C\uBC84\uAC00 \uC798\uBABB\uB41C \uBBF8\uB514\uC5B4 \uBC94\uC704\uB97C \uBC18\uD658\uD588\uC2B5\uB2C8\uB2E4.");
    }
    reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (; ; ) {
      const result2 = await reader.read();
      if (result2.done) break;
      total += result2.value.length;
      if (total > maximum) throw new Error("\uBBF8\uB514\uC5B4 \uC6A9\uB7C9\uC774 \uCC98\uB9AC \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
      chunks.push(result2.value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    if (range) {
      if (response.status === 206) {
        if (result.length !== range.length) throw new Error("\uBBF8\uB514\uC5B4 \uC870\uAC01\uC774 \uBD88\uC644\uC804\uD569\uB2C8\uB2E4.");
        return result;
      }
      if (response.status !== 200 || result.length < range.offset + range.length) throw new Error("\uC11C\uBC84\uAC00 \uBC14\uC774\uD2B8 \uBC94\uC704\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      return result.slice(range.offset, range.offset + range.length);
    }
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {
    });
  }
}

// src/local/preferences.ts
var QUALITIES = ["highest", "2160", "1080", "720", "480"];
function downloadOptions(value) {
  if (value === void 0) return { quality: "highest", output: "original" };
  if (!record(value) || !QUALITIES.includes(value.quality) || !["original", "mp3", "m4a"].includes(String(value.output))) throw new Error("\uB2E4\uC6B4\uB85C\uB4DC \uD654\uC9C8 \uB610\uB294 \uC800\uC7A5 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  return { quality: value.quality, output: value.output };
}

// src/local/stream-worker.ts
var scope = globalThis;
var busy = false;
scope.onmessage = async (event) => {
  if (busy) return;
  busy = true;
  try {
    const data = event.data;
    if (!record(data) || !record(data.plan) || !Array.isArray(data.plan.assets) || !Array.isArray(data.plan.inputs) || !data.plan.assets.length || data.plan.assets.length > MAX_SEGMENTS || !data.plan.inputs.length || data.plan.inputs.length > 2) throw new Error("\uC798\uBABB\uB41C \uC2A4\uD2B8\uB9BC \uC791\uC5C5\uC785\uB2C8\uB2E4.");
    const plan = data.plan;
    const options = downloadOptions(data.options);
    const names = /* @__PURE__ */ new Set();
    for (const asset of plan.assets) {
      if (!/^asset-\d+\.(ts|m4s|data)$|^dash-\d+\.m4s$/.test(asset.filename) || names.has(asset.filename)) throw new Error("\uC798\uBABB\uB41C \uC870\uAC01 \uD30C\uC77C\uBA85\uC785\uB2C8\uB2E4.");
      mediaURL(asset.url);
      names.add(asset.filename);
    }
    const core = await createFFmpegCore();
    let log = "";
    core.setLogger(({ message }) => {
      log = message.slice(0, 300);
    });
    let bytes = 0;
    for (let index = 0; index < plan.assets.length; index++) {
      const asset = plan.assets[index];
      const data2 = await fetchBytes(asset.url, MAX_STREAM_BYTES - bytes, new AbortController().signal, asset.range);
      bytes += data2.length;
      if (bytes > MAX_STREAM_BYTES) throw new Error("\uC2A4\uD2B8\uB9BC\uC740 \uCD1D 128MiB \uC774\uD558\uB9CC \uCC98\uB9AC\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
      core.FS.writeFile(asset.filename, data2);
      scope.postMessage({ type: "progress", value: (index + 1) / plan.assets.length * 0.8 });
    }
    const args = ["-hide_banner", "-nostdin", "-max_alloc", "67108864"];
    for (const input of plan.inputs) {
      if (!/^input-[01]\.(mp4|m3u8)$/.test(input.filename)) throw new Error("\uC798\uBABB\uB41C \uC785\uB825 \uD30C\uC77C\uBA85\uC785\uB2C8\uB2E4.");
      if (typeof input.playlist === "string") {
        if (input.playlist.length > 2 * 1024 * 1024 || /https?:|\.\.|[\\]/i.test(input.playlist)) throw new Error("\uC7AC\uC791\uC131\uB41C \uBAA9\uB85D\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
        core.FS.writeFile(input.filename, new TextEncoder().encode(input.playlist));
        args.push("-protocol_whitelist", "file,pipe", "-allowed_extensions", "ALL", "-i", input.filename);
      } else if (Array.isArray(input.parts) && input.parts.length && input.parts.every((name) => names.has(name))) {
        const chunks = input.parts.map((name) => core.FS.readFile(name));
        if (!chunks.every((chunk) => chunk instanceof Uint8Array)) throw new Error("DASH \uC870\uAC01\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        if (total > MAX_STREAM_BYTES) throw new Error("DASH \uD2B8\uB799 \uC6A9\uB7C9 \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.length;
        }
        core.FS.writeFile(input.filename, joined);
        for (const part of input.parts) core.FS.unlink(part);
        args.push("-protocol_whitelist", "file,pipe", "-i", input.filename);
      } else throw new Error("\uC2A4\uD2B8\uB9BC \uC785\uB825\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    }
    const outputName = `output.${options.output === "original" ? "mp4" : options.output}`;
    if (options.output === "original") args.push("-map", "0:v:0?", "-map", plan.inputs.length === 2 ? "1:a:0?" : "0:a:0?", "-c", "copy", "-movflags", "+faststart");
    else {
      args.push("-map", plan.inputs.length === 2 ? "1:a:0" : "0:a:0", "-vn", "-c:a", options.output === "mp3" ? "libmp3lame" : "aac", "-b:a", "192k", "-threads", "1");
      if (options.output === "m4a") args.push("-movflags", "+faststart");
    }
    args.push("-fs", String(MAX_STREAM_BYTES), "-y", outputName);
    core.setTimeout(12e4);
    const result = core.exec(...args);
    if (result !== 0) throw new Error(`\uBBF8\uB514\uC5B4\uB97C \uC800\uC7A5 \uD615\uC2DD\uC73C\uB85C \uCC98\uB9AC\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. ${log}`);
    const output = core.FS.readFile(outputName);
    if (!(output instanceof Uint8Array) || !output.length || output.length >= MAX_STREAM_BYTES - 1024 * 1024) throw new Error("\uACB0\uACFC\uAC00 \uBE44\uC5B4 \uC788\uAC70\uB098 \uC548\uC804\uD55C \uCD9C\uB825 \uC6A9\uB7C9\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
    const buffer = new Uint8Array(output).buffer;
    scope.postMessage({ type: "done", bytes: buffer }, [buffer]);
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : "\uC2A4\uD2B8\uB9BC \uCC98\uB9AC \uC624\uB958" });
  }
};
