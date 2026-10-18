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

// src/local/transport.ts
function transport(value) {
  if (typeof value !== "string") return void 0;
  if (/^h3(?:-\d+)?$/.test(value)) return "h3";
  if (value === "h2") return "h2";
  if (value === "http/1.1") return "http/1.1";
  return void 0;
}
function resourceTransport(url, since = 0) {
  if (typeof performance === "undefined" || !performance.getEntriesByName) return void 0;
  const entries = performance.getEntriesByName(url, "resource");
  return transport(entries.filter((entry) => entry.startTime >= since).at(-1)?.nextHopProtocol);
}
function observeTransport(url, since) {
  let observer;
  let settle;
  let done = false;
  const result = new Promise((resolve) => {
    settle = (value) => {
      if (!done) {
        done = true;
        observer?.disconnect();
        resolve(value);
      }
    };
  });
  try {
    observer = new PerformanceObserver((list) => {
      const entry = list.getEntries().find((entry2) => entry2.name === url && entry2.startTime >= since);
      if (entry) settle(transport(entry.nextHopProtocol));
    });
    observer.observe({ type: "resource", buffered: true });
  } catch {
    settle(void 0);
  }
  return {
    async finish() {
      const known = resourceTransport(url, since);
      if (known) settle(known);
      const timer = setTimeout(() => settle(void 0), 50);
      try {
        return await result;
      } finally {
        clearTimeout(timer);
      }
    },
    cancel() {
      settle(void 0);
    }
  };
}

// src/local/network.ts
function validRange(range) {
  if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || !Number.isSafeInteger(range.offset + range.length) || range.offset < 0 || range.length < 1 || range.length > 128 * 1024 * 1024) throw new Error("\uBBF8\uB514\uC5B4 \uBC14\uC774\uD2B8 \uBC94\uC704\uAC00 \uD5C8\uC6A9 \uBC94\uC704\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
}
var ByteBudget = class {
  used = 0;
  limit;
  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("\uC798\uBABB\uB41C \uC6A9\uB7C9 \uD55C\uB3C4\uC785\uB2C8\uB2E4.");
    this.limit = limit;
  }
  take(bytes) {
    if (this.used + bytes > this.limit) throw new Error("\uBBF8\uB514\uC5B4 \uC6A9\uB7C9\uC774 \uCC98\uB9AC \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
    this.used += bytes;
  }
  release(bytes) {
    this.used -= bytes;
  }
  get remaining() {
    return this.limit - this.used;
  }
};
var Retryable = class extends Error {
  delay;
  constructor(message, delay) {
    super(message);
    this.delay = delay;
  }
};
var RETRY_STATUS = /* @__PURE__ */ new Set([408, 425, 429, 500, 502, 503, 504]);
function retryDelay(header, now = Date.now()) {
  if (header === null) return void 0;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1e3;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : void 0;
}
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(signal.reason ?? new DOMException("\uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}
async function fetchBytes(url, maximum, signal, range, monitor = {}) {
  const address = mediaURL(url).href;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256 * 1024 * 1024) throw new Error("\uBBF8\uB514\uC5B4 \uC6A9\uB7C9\uC774 \uCC98\uB9AC \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
  if (range) validRange(range);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 3e4);
    let response;
    let reader;
    let reserved = 0;
    let success = false;
    let failure;
    let observation;
    try {
      const started = performance.now();
      observation = observeTransport(address, started);
      const options = { credentials: "include", redirect: "follow", signal: AbortSignal.any([signal, controller.signal]) };
      if (range) options.headers = { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
      response = await fetch(address, options);
      if (!response.ok) {
        const delay = retryDelay(response.headers.get("Retry-After"));
        const message = `\uBBF8\uB514\uC5B4 \uC694\uCCAD \uC2E4\uD328 (${response.status})${delay !== void 0 && delay > 5e3 ? " \xB7 \uC11C\uBC84\uAC00 \uB354 \uAE34 \uB300\uAE30\uB97C \uC694\uCCAD\uD588\uC2B5\uB2C8\uB2E4. \uB098\uC911\uC5D0 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694." : ""}`;
        if (RETRY_STATUS.has(response.status) && (delay === void 0 || delay <= 5e3)) throw new Retryable(message, delay);
        throw new Error(message);
      }
      if (!response.body) throw new Error("\uBBF8\uB514\uC5B4 \uC751\uB2F5\uC5D0 \uD30C\uC77C \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
      if (response.url) mediaURL(response.url);
      if (!range && response.status === 206) throw new Error("\uC804\uCCB4 \uD30C\uC77C \uC694\uCCAD\uC5D0 \uC77C\uBD80 \uBBF8\uB514\uC5B4\uB9CC \uBC18\uD658\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      const length = response.headers.get("Content-Length");
      const declared = length !== null && /^\d+$/.test(length) ? Number(length) : void 0;
      if (declared !== void 0 && declared > maximum) throw new Error("\uBBF8\uB514\uC5B4 \uC6A9\uB7C9\uC774 \uCC98\uB9AC \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
      const encoding = response.headers.get("Content-Encoding");
      if (range && encoding && encoding.toLowerCase() !== "identity") throw new Error("\uC555\uCD95\uB41C \uBBF8\uB514\uC5B4 \uBC14\uC774\uD2B8 \uBC94\uC704\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      if (range && response.status === 206) {
        const contentRange = response.headers.get("Content-Range")?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
        if (!contentRange || Number(contentRange[1]) !== range.offset || Number(contentRange[2]) !== range.offset + range.length - 1 || contentRange[3] !== "*" && Number(contentRange[3]) <= Number(contentRange[2])) throw new Error("\uC11C\uBC84\uAC00 \uC798\uBABB\uB41C \uBBF8\uB514\uC5B4 \uBC94\uC704\uB97C \uBC18\uD658\uD588\uC2B5\uB2C8\uB2E4.");
      }
      reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (; ; ) {
        const result2 = await reader.read();
        if (result2.done) break;
        total += result2.value.length;
        if (total > maximum) throw new Error("\uBBF8\uB514\uC5B4 \uC6A9\uB7C9\uC774 \uCC98\uB9AC \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
        monitor.budget?.take(result2.value.length);
        reserved += result2.value.length;
        chunks.push(result2.value);
        monitor.progress?.(total, encoding && encoding !== "identity" ? void 0 : declared);
      }
      if (!total) throw new Error("\uBBF8\uB514\uC5B4 \uD30C\uC77C\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.");
      if ((!encoding || encoding === "identity") && declared !== void 0 && total !== declared) throw new Retryable("\uBBF8\uB514\uC5B4 \uD30C\uC77C\uC774 \uBD88\uC644\uC804\uD569\uB2C8\uB2E4.");
      let result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      if (range) {
        if (response.status === 206) {
          if (result.length !== range.length) throw new Retryable("\uBBF8\uB514\uC5B4 \uC870\uAC01\uC774 \uBD88\uC644\uC804\uD569\uB2C8\uB2E4.");
        } else {
          if (response.status !== 200 || result.length < range.offset + range.length) throw new Error("\uC11C\uBC84\uAC00 \uBC14\uC774\uD2B8 \uBC94\uC704\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
          result = result.slice(range.offset, range.offset + range.length);
          monitor.budget?.release(reserved - result.length);
          reserved = result.length;
        }
      }
      const protocol = await observation.finish();
      signal.throwIfAborted();
      if (protocol) monitor.protocol?.(protocol);
      success = true;
      return result;
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      observation?.cancel();
      if (reader) await reader.cancel().catch(() => {
      });
      else await response?.body?.cancel().catch(() => {
      });
      if (!success) monitor.budget?.release(reserved);
    }
    signal.throwIfAborted();
    if (attempt >= 2 || !(failure instanceof Retryable) && !(failure instanceof TypeError) && !timedOut) throw failure;
    await wait(failure instanceof Retryable && failure.delay !== void 0 ? failure.delay : 300 * 2 ** attempt, signal);
  }
}

// src/local/assets.ts
async function downloadAssets(assets, consume, signal, progress = () => {
}, protocol = () => {
}) {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const budget = new ByteBudget(MAX_STREAM_BYTES);
  let next = 0, completed = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(3, assets.length) }, async () => {
    try {
      while (next < assets.length) {
        combined.throwIfAborted();
        const asset = assets[next++];
        const bytes = await fetchBytes(asset.url, MAX_STREAM_BYTES, combined, asset.range, { budget, protocol });
        combined.throwIfAborted();
        consume(asset.filename, bytes);
        progress(++completed);
      }
    } catch (error) {
      failure ??= error;
      controller.abort();
    }
  }));
  if (failure !== void 0) throw failure;
  signal.throwIfAborted();
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
    const protocols = /* @__PURE__ */ new Set();
    await downloadAssets(
      plan.assets,
      (name, bytes) => core.FS.writeFile(name, bytes),
      new AbortController().signal,
      (completed) => scope.postMessage({ type: "progress", value: completed / plan.assets.length * 0.8, stage: "fetching" }),
      (value) => protocols.add(value)
    );
    scope.postMessage({ type: "progress", value: 0.8, stage: "processing" });
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
    scope.postMessage({ type: "done", bytes: buffer, protocols: [...protocols] }, [buffer]);
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : "\uC2A4\uD2B8\uB9BC \uCC98\uB9AC \uC624\uB958" });
  }
};
