// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/upscale/policy.ts
var MAX_INPUT_BYTES = 256 * 1024 * 1024;
var MAX_QUEUE_BYTES = 512 * 1024 * 1024;
var RETENTION_MS = 24 * 60 * 60 * 1e3;

// src/local/model.ts
var SCOPE = "my-video-app/local";
var OFFSCREEN_SCOPE = "my-video-app/offscreen";
var MAX_STREAM_BYTES = 128 * 1024 * 1024;
var MAX_SEGMENTS = 4096;
var PREPARE_TIMEOUT_MS = 3e5;
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
function validRange(range2) {
  if (!Number.isSafeInteger(range2.offset) || !Number.isSafeInteger(range2.length) || !Number.isSafeInteger(range2.offset + range2.length) || range2.offset < 0 || range2.length < 1 || range2.length > 128 * 1024 * 1024) throw new Error("\uBBF8\uB514\uC5B4 \uBC14\uC774\uD2B8 \uBC94\uC704\uAC00 \uD5C8\uC6A9 \uBC94\uC704\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
}
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
async function fetchBytes(url, maximum, signal, range2, monitor = {}) {
  const address = mediaURL(url).href;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256 * 1024 * 1024) throw new Error("\uBBF8\uB514\uC5B4 \uC6A9\uB7C9\uC774 \uCC98\uB9AC \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
  if (range2) validRange(range2);
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
      if (range2) options.headers = { Range: `bytes=${range2.offset}-${range2.offset + range2.length - 1}` };
      response = await fetch(address, options);
      if (!response.ok) {
        const delay = retryDelay(response.headers.get("Retry-After"));
        const message = `\uBBF8\uB514\uC5B4 \uC694\uCCAD \uC2E4\uD328 (${response.status})${delay !== void 0 && delay > 5e3 ? " \xB7 \uC11C\uBC84\uAC00 \uB354 \uAE34 \uB300\uAE30\uB97C \uC694\uCCAD\uD588\uC2B5\uB2C8\uB2E4. \uB098\uC911\uC5D0 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694." : ""}`;
        if (RETRY_STATUS.has(response.status) && (delay === void 0 || delay <= 5e3)) throw new Retryable(message, delay);
        throw new Error(message);
      }
      if (!response.body) throw new Error("\uBBF8\uB514\uC5B4 \uC751\uB2F5\uC5D0 \uD30C\uC77C \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const finalURL = response.url ? mediaURL(response.url).href : address;
      if (!range2 && response.status === 206) throw new Error("\uC804\uCCB4 \uD30C\uC77C \uC694\uCCAD\uC5D0 \uC77C\uBD80 \uBBF8\uB514\uC5B4\uB9CC \uBC18\uD658\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      const length = response.headers.get("Content-Length");
      const declared = length !== null && /^\d+$/.test(length) ? Number(length) : void 0;
      if (declared !== void 0 && declared > maximum) throw new Error("\uBBF8\uB514\uC5B4 \uC6A9\uB7C9\uC774 \uCC98\uB9AC \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
      const encoding = response.headers.get("Content-Encoding");
      if (range2 && encoding && encoding.toLowerCase() !== "identity") throw new Error("\uC555\uCD95\uB41C \uBBF8\uB514\uC5B4 \uBC14\uC774\uD2B8 \uBC94\uC704\uB294 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      if (range2 && response.status === 206) {
        const contentRange = response.headers.get("Content-Range")?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
        if (!contentRange || Number(contentRange[1]) !== range2.offset || Number(contentRange[2]) !== range2.offset + range2.length - 1 || contentRange[3] !== "*" && Number(contentRange[3]) <= Number(contentRange[2])) throw new Error("\uC11C\uBC84\uAC00 \uC798\uBABB\uB41C \uBBF8\uB514\uC5B4 \uBC94\uC704\uB97C \uBC18\uD658\uD588\uC2B5\uB2C8\uB2E4.");
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
      if (range2) {
        if (response.status === 206) {
          if (result.length !== range2.length) throw new Retryable("\uBBF8\uB514\uC5B4 \uC870\uAC01\uC774 \uBD88\uC644\uC804\uD569\uB2C8\uB2E4.");
        } else {
          if (response.status !== 200 || result.length < range2.offset + range2.length) throw new Error("\uC11C\uBC84\uAC00 \uBC14\uC774\uD2B8 \uBC94\uC704\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
          result = result.slice(range2.offset, range2.offset + range2.length);
          monitor.budget?.release(reserved - result.length);
          reserved = result.length;
        }
      }
      const protocol = await observation.finish();
      signal.throwIfAborted();
      if (protocol) monitor.protocol?.(protocol);
      monitor.finalURL?.(finalURL);
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
async function fetchManifestResource(url, signal) {
  let address = mediaURL(url).href;
  const bytes = await fetchBytes(address, 2 * 1024 * 1024, signal, void 0, { finalURL: (value) => {
    address = value;
  } });
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), url: address };
}

// src/local/preferences.ts
var QUALITIES = ["highest", "2160", "1080", "720", "480"];
function downloadOptions(value) {
  if (value === void 0) return { quality: "highest", output: "original" };
  if (!record(value) || !QUALITIES.includes(value.quality) || !["original", "mp3", "m4a"].includes(String(value.output))) throw new Error("\uB2E4\uC6B4\uB85C\uB4DC \uD654\uC9C8 \uB610\uB294 \uC800\uC7A5 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  return { quality: value.quality, output: value.output };
}
function chooseQuality(items, quality, height, bandwidth) {
  const known = items.filter((item) => Number.isFinite(height(item)) && height(item) > 0);
  const ranked = (values) => [...values].sort((a, b) => height(b) - height(a) || bandwidth(b) - bandwidth(a))[0];
  if (!known.length) return [...items].sort((a, b) => bandwidth(b) - bandwidth(a))[0];
  if (quality === "highest") return ranked(known);
  const eligible = known.filter((item) => height(item) <= Number(quality));
  if (eligible.length) return ranked(eligible);
  const minimum = Math.min(...known.map(height));
  return ranked(known.filter((item) => height(item) === minimum));
}

// src/local/hls.ts
function attributes(value) {
  const result = /* @__PURE__ */ Object.create(null);
  const pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/g;
  for (const match of value.matchAll(pattern)) result[match[1]] = match[2] ?? match[3] ?? "";
  return result;
}
function check(text) {
  if (text.length > 2 * 1024 * 1024 || !text.trimStart().startsWith("#EXTM3U")) throw new Error("\uC62C\uBC14\uB978 HLS \uBAA9\uB85D\uC774 \uC544\uB2D9\uB2C8\uB2E4.");
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^#EXT-X-(?:SESSION-)?KEY:/.test(line) && attributes(line.slice(line.indexOf(":") + 1)).METHOD !== "NONE") throw new Error("\uC554\uD638\uD654\xB7DRM \uC2A4\uD2B8\uB9BC\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  }
  return lines;
}
function parseByteRange(value, offset = 0) {
  const match = value.match(/^(\d+)(?:@(\d+))?$/);
  if (!match) throw new Error("\uC798\uBABB\uB41C HLS \uBC14\uC774\uD2B8 \uBC94\uC704\uC785\uB2C8\uB2E4.");
  const range2 = { length: Number(match[1]), offset: match[2] === void 0 ? offset : Number(match[2]) };
  validRange(range2);
  return range2;
}
async function planHls(url, load, options = downloadOptions()) {
  const assets = [];
  const inputs = [];
  async function playlist(address, depth, ancestors, includeAudio) {
    if (depth > 3 || ancestors.has(address)) throw new Error("HLS \uBAA9\uB85D\uC774 \uC21C\uD658\uD558\uAC70\uB098 \uB108\uBB34 \uAE4A\uC2B5\uB2C8\uB2E4.");
    const requested = address;
    const resource = await load(address);
    address = mediaURL(typeof resource === "string" ? address : resource.url).href;
    if (ancestors.has(address)) throw new Error("HLS \uBAA9\uB85D\uC774 \uC21C\uD658\uD558\uAC70\uB098 \uB108\uBB34 \uAE4A\uC2B5\uB2C8\uB2E4.");
    const next = new Set(ancestors).add(requested).add(address);
    const lines = check(typeof resource === "string" ? resource : resource.text);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const attr = attributes(line.slice(line.indexOf(":") + 1));
      const child2 = lines[i + 1];
      if (!child2 || child2.startsWith("#")) throw new Error("HLS \uBCC0\uD615 \uBAA9\uB85D\uC774 \uBD88\uC644\uC804\uD569\uB2C8\uB2E4.");
      const variant = { url: mediaURL(child2, address).href, bandwidth: Number(attr.BANDWIDTH) || 0, height: Number(attr.RESOLUTION?.match(/^\d+x(\d+)$/)?.[1]) || 0 };
      if (attr.AUDIO) variant.audio = attr.AUDIO;
      variants.push(variant);
    }
    if (variants.length) {
      const chosen = chooseQuality(variants, options.quality, (item) => item.height, (item) => item.bandwidth);
      let audio;
      if (includeAudio && chosen.audio) {
        audio = lines.filter((line) => line.startsWith("#EXT-X-MEDIA:")).map((line) => attributes(line.slice(line.indexOf(":") + 1))).filter((a) => a.TYPE === "AUDIO" && a["GROUP-ID"] === chosen.audio && a.URI).sort((a, b) => Number(b.DEFAULT === "YES") - Number(a.DEFAULT === "YES"))[0];
      }
      if (options.output !== "original" && audio?.URI) {
        await playlist(mediaURL(audio.URI, address).href, depth + 1, next, false);
        return;
      }
      await playlist(chosen.url, depth + 1, next, false);
      if (audio?.URI) await playlist(mediaURL(audio.URI, address).href, depth + 1, next, false);
      return;
    }
    if (!lines.includes("#EXT-X-ENDLIST")) throw new Error("\uD604\uC7AC \uB85C\uCEEC \uBC84\uC804\uC740 \uC644\uB8CC\uB41C VOD \uBAA9\uB85D\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
    const rewritten = [];
    let range2;
    let previousEnd = 0;
    let previousURL = "";
    let pendingRange = "";
    let segments = 0;
    function asset(remote, bytes) {
      if (assets.length >= MAX_SEGMENTS) throw new Error("\uBBF8\uB514\uC5B4 \uC870\uAC01 \uAC1C\uC218 \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
      const item = { url: mediaURL(remote, address).href, filename: `asset-${assets.length.toString().padStart(5, "0")}.${/\.(mp4|m4s)(?:[?#]|$)/i.test(remote) ? "m4s" : "ts"}` };
      if (bytes) item.range = bytes;
      assets.push(item);
      return item.filename;
    }
    for (const line of lines) {
      if (line.startsWith("#EXT-X-BYTERANGE:")) {
        pendingRange = line.slice(17);
        continue;
      }
      if (line.startsWith("#EXT-X-MAP:")) {
        const attr = attributes(line.slice(11));
        if (!attr.URI) throw new Error("HLS \uCD08\uAE30\uD654 \uC870\uAC01\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
        const initRange = attr.BYTERANGE ? parseByteRange(attr.BYTERANGE) : void 0;
        rewritten.push(`#EXT-X-MAP:URI="${asset(attr.URI, initRange)}"`);
        continue;
      }
      if (line.startsWith("#")) {
        if (/^#(?:EXTM3U$|EXTINF:|EXT-X-(?:VERSION:|TARGETDURATION:|MEDIA-SEQUENCE:|PLAYLIST-TYPE:|DISCONTINUITY|INDEPENDENT-SEGMENTS|ENDLIST|GAP))/.test(line)) rewritten.push(line);
        continue;
      }
      const remote = mediaURL(line, address).href;
      if (pendingRange) {
        if (!pendingRange.includes("@") && previousURL !== remote) throw new Error("HLS \uC5F0\uC18D \uBC14\uC774\uD2B8 \uBC94\uC704\uC758 \uAE30\uC900\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
        range2 = parseByteRange(pendingRange, previousEnd);
        previousEnd = range2.offset + range2.length;
      } else {
        range2 = void 0;
        previousEnd = 0;
      }
      rewritten.push(asset(remote, range2));
      previousURL = remote;
      pendingRange = "";
      segments++;
    }
    if (!segments) throw new Error("HLS \uBAA9\uB85D\uC5D0 \uBBF8\uB514\uC5B4 \uC870\uAC01\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
    inputs.push({ filename: `input-${inputs.length}.m3u8`, playlist: rewritten.join("\n") + "\n" });
  }
  await playlist(mediaURL(url).href, 0, /* @__PURE__ */ new Set(), true);
  if (!inputs.length || inputs.length > 2) throw new Error("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 HLS \uD2B8\uB799 \uAD6C\uC131\uC785\uB2C8\uB2E4.");
  return { assets, inputs };
}

// src/local/dash.ts
function child(node, name) {
  return Array.from(node.children).find((e) => e.localName === name);
}
function children(node, name) {
  return Array.from(node.children).filter((e) => e.localName === name);
}
function duration(text) {
  const m = text?.match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0) : 0;
}
function range(text) {
  if (!text) return void 0;
  const match = text.match(/^(\d+)-(\d+)$/);
  if (!match) throw new Error("DASH \uBC14\uC774\uD2B8 \uBC94\uC704\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  const result = { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 };
  validRange(result);
  return result;
}
function planDash(text, address, options = downloadOptions()) {
  if (text.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 DASH \uBB38\uC11C\uC785\uB2C8\uB2E4.");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const root = doc.documentElement;
  if (root.localName !== "MPD" || doc.getElementsByTagName("parsererror").length) throw new Error("\uC62C\uBC14\uB978 DASH \uBAA9\uB85D\uC774 \uC544\uB2D9\uB2C8\uB2E4.");
  if (root.getAttribute("type") === "dynamic") throw new Error("\uD604\uC7AC \uB85C\uCEEC \uBC84\uC804\uC740 \uC644\uB8CC\uB41C VOD \uBAA9\uB85D\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
  if (doc.getElementsByTagNameNS("*", "ContentProtection").length) throw new Error("\uC554\uD638\uD654\xB7DRM \uC2A4\uD2B8\uB9BC\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  const periods = children(root, "Period");
  if (periods.length !== 1) throw new Error("\uD604\uC7AC\uB294 \uB2E8\uC77C Period DASH \uBAA9\uB85D\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
  const period = periods[0];
  const seconds = duration(period.getAttribute("duration")) || duration(root.getAttribute("mediaPresentationDuration"));
  const selections = [];
  for (const adaptation of children(period, "AdaptationSet")) {
    for (const representation of children(adaptation, "Representation")) {
      const type = representation.getAttribute("mimeType") ?? adaptation.getAttribute("mimeType") ?? adaptation.getAttribute("contentType") ?? "";
      if (/^(video|audio)/.test(type)) selections.push({ adaptation, representation, type: type.startsWith("video") ? "video" : "audio" });
    }
  }
  const audio = selections.filter((s) => s.type === "audio").sort((a, b) => Number(b.representation.getAttribute("bandwidth")) - Number(a.representation.getAttribute("bandwidth")))[0];
  const video = chooseQuality(
    selections.filter((s) => s.type === "video"),
    options.quality,
    (item) => Number(item.representation.getAttribute("height") ?? item.adaptation.getAttribute("height")),
    (item) => Number(item.representation.getAttribute("bandwidth"))
  );
  const picked = (options.output !== "original" && audio ? [audio] : [video, audio]).filter((s) => s !== void 0);
  if (!picked.length) throw new Error("DASH \uBBF8\uB514\uC5B4 \uD2B8\uB799\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
  const plan = { assets: [], inputs: [] };
  for (const item of picked) {
    let add2 = function(url, bytes) {
      if (plan.assets.length >= MAX_SEGMENTS) throw new Error("\uBBF8\uB514\uC5B4 \uC870\uAC01 \uAC1C\uC218 \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
      const asset = { url: mediaURL(url, base).href, filename: `dash-${plan.assets.length}.m4s` };
      if (bytes) asset.range = bytes;
      plan.assets.push(asset);
      parts.push(asset.filename);
    };
    var add = add2;
    const chain = [root, period, item.adaptation, item.representation];
    let base = mediaURL(address).href;
    for (const node of chain) {
      const value = child(node, "BaseURL")?.textContent?.trim();
      if (value) base = mediaURL(value, base).href;
    }
    const parts = [];
    const lists = [...chain].reverse().map((node) => child(node, "SegmentList")).filter((node) => node !== void 0);
    const list = lists[0];
    const templates = [...chain].reverse().map((node) => child(node, "SegmentTemplate")).filter((node) => node !== void 0);
    const template = templates[0];
    const templateAttribute = (name) => templates.find((node) => node.hasAttribute(name))?.getAttribute(name) ?? null;
    if (list) {
      const init = lists.map((node) => child(node, "Initialization")).find((node) => node !== void 0);
      if (init) add2(init.getAttribute("sourceURL") ?? base, range(init.getAttribute("range")));
      const segments = lists.map((node) => children(node, "SegmentURL")).find((nodes) => nodes.length) ?? [];
      for (const segment of segments) add2(segment.getAttribute("media") ?? base, range(segment.getAttribute("mediaRange")));
    } else if (template) {
      const timescale = Number(templateAttribute("timescale") ?? "1");
      const presentationTimeOffset = Number(templateAttribute("presentationTimeOffset") ?? "0");
      let number = Number(templateAttribute("startNumber") ?? "1");
      if (!Number.isSafeInteger(timescale) || timescale <= 0 || !Number.isSafeInteger(presentationTimeOffset) || presentationTimeOffset < 0 || !Number.isSafeInteger(number) || number < 0) throw new Error("DASH \uD0C0\uC784\uB77C\uC778\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      const expand = (format2, time) => format2.replace(/\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (match, key, width) => {
        if (match === "$$") return "$";
        const value = key === "RepresentationID" ? item.representation.getAttribute("id") ?? "" : key === "Bandwidth" ? item.representation.getAttribute("bandwidth") ?? "" : String(key === "Time" ? time : number);
        const pad = Number(width ?? 0);
        if (pad > 20) throw new Error("DASH \uBC88\uD638 \uD615\uC2DD\uC774 \uB108\uBB34 \uAE41\uB2C8\uB2E4.");
        return value.padStart(pad, "0");
      });
      const init = templateAttribute("initialization");
      if (init) add2(expand(init, 0));
      const format = templateAttribute("media");
      if (!format) throw new Error("DASH \uBBF8\uB514\uC5B4 \uD15C\uD50C\uB9BF\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
      const timeline = templates.map((node) => child(node, "SegmentTimeline")).find((node) => node !== void 0);
      if (timeline) {
        const entries = children(timeline, "S");
        let time = 0;
        for (let index = 0; index < entries.length; index++) {
          const s = entries[index];
          if (s.hasAttribute("t")) time = Number(s.getAttribute("t"));
          const d = Number(s.getAttribute("d"));
          let repeat = Number(s.getAttribute("r") ?? "0");
          if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(d) || d <= 0 || !Number.isSafeInteger(repeat) || repeat < -1) throw new Error("DASH \uD0C0\uC784\uB77C\uC778\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
          if (repeat === -1) {
            const next = entries[index + 1];
            const end = next ? Number(next.getAttribute("t")) : seconds * timescale + presentationTimeOffset;
            if (next && (!next.hasAttribute("t") || !Number.isSafeInteger(end)) || !next && seconds <= 0 || !Number.isFinite(end) || end > Number.MAX_SAFE_INTEGER || end <= time) throw new Error("\uB05D\uC774 \uC5C6\uB294 DASH \uD0C0\uC784\uB77C\uC778\uC740 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
            repeat = Math.ceil((end - time) / d) - 1;
          }
          if (repeat >= MAX_SEGMENTS) throw new Error("DASH \uC870\uAC01 \uAC1C\uC218 \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
          if (!Number.isSafeInteger(time + (repeat + 1) * d) || !Number.isSafeInteger(number + repeat)) throw new Error("DASH \uD0C0\uC784\uB77C\uC778\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
          for (let i = 0; i <= repeat; i++) {
            add2(expand(format, time));
            time += d;
            number++;
          }
        }
      } else {
        const step = Number(templateAttribute("duration"));
        const count = Math.ceil(seconds * timescale / step);
        if (!Number.isFinite(count) || count < 1 || count > MAX_SEGMENTS) throw new Error("DASH \uAE38\uC774 \uB610\uB294 \uC870\uAC01 \uAC1C\uC218\uAC00 \uD5C8\uC6A9 \uBC94\uC704\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
        for (let i = 0; i < count; i++) {
          add2(expand(format, i * step));
          number++;
        }
      }
    } else {
      if (base === mediaURL(address).href) throw new Error("DASH \uC870\uAC01 \uC815\uBCF4\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      add2(base);
    }
    if (!parts.length) throw new Error("DASH \uD2B8\uB799\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.");
    plan.inputs.push({ filename: `input-${plan.inputs.length}.mp4`, parts });
  }
  return plan;
}

// src/local/queue.ts
var PreparationQueue = class {
  pending = [];
  running;
  maximum;
  constructor(maximum = 8) {
    this.maximum = maximum;
  }
  run(id, work) {
    if (this.running?.id === id || this.pending.some((task) => task.id === id)) return Promise.reject(new Error("\uAC19\uC740 \uD30C\uC77C\uC744 \uC774\uBBF8 \uC900\uBE44\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4."));
    if (this.pending.length + Number(!!this.running) >= this.maximum) return Promise.reject(new Error("\uB2E4\uC6B4\uB85C\uB4DC \uC900\uBE44 \uB300\uAE30\uC5F4\uC740 \uCD5C\uB300 8\uAC1C\uC785\uB2C8\uB2E4."));
    return new Promise((resolve, reject) => {
      this.pending.push({ id, controller: new AbortController(), work, resolve: (value) => resolve(value), reject });
      this.advance();
    });
  }
  cancel(id) {
    if (this.running?.id === id) {
      this.running.controller.abort();
      return;
    }
    const index = this.pending.findIndex((task2) => task2.id === id);
    if (index < 0) return;
    const task = this.pending.splice(index, 1)[0];
    task.controller.abort();
    task.reject(new DOMException("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.", "AbortError"));
  }
  advance() {
    if (this.running) return;
    const task = this.pending.shift();
    if (!task) return;
    this.running = task;
    void (async () => {
      try {
        task.resolve(await task.work(task.controller.signal));
      } catch (error) {
        task.reject(error);
      } finally {
        this.running = void 0;
        this.advance();
      }
    })();
  }
};

// src/local/offscreen.ts
var prepared = /* @__PURE__ */ new Map();
var queue = new PreparationQueue();
async function disposeLocal(id) {
  const item = prepared.get(id);
  if (item) {
    URL.revokeObjectURL(item.url);
    prepared.delete(id);
  }
  await (await navigator.storage.getDirectory()).removeEntry(`local-${id}.media`).catch((error) => {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  });
}
function cancelLocal(id) {
  queue.cancel(id);
}
async function prepareLocal(id, url, kind, settings) {
  if (!/^[0-9a-f-]{36}$/.test(id) || prepared.has(id) || !["file", "hls", "dash"].includes(kind)) throw new Error("\uC798\uBABB\uB41C \uD30C\uC77C \uC900\uBE44 \uC694\uCCAD\uC785\uB2C8\uB2E4.");
  const options = downloadOptions(settings);
  const address = mediaURL(url).href;
  let latest = { stage: "queued" };
  let lastSent = 0;
  function report(value, force = false) {
    latest = value;
    if (!force && Date.now() - lastSent < 500) return;
    lastSent = Date.now();
    void chrome.runtime.sendMessage({ scope: SCOPE, type: "preparing-progress", id, ...latest }).catch(() => {
    });
  }
  report(latest, true);
  const heartbeat = setInterval(() => report(latest, true), 15e3);
  try {
    return await queue.run(id, (signal) => prepareOne(id, address, kind, options, signal, report));
  } finally {
    clearInterval(heartbeat);
  }
}
async function prepareOne(id, url, kind, options, signal, report) {
  const task = { id, controller: new AbortController() };
  const abort = () => {
    task.controller.abort();
    task.worker?.terminate();
    task.reject?.(new DOMException("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.", "AbortError"));
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => cancelLocal(id), PREPARE_TIMEOUT_MS);
  const protocols = /* @__PURE__ */ new Set();
  try {
    signal.throwIfAborted();
    report({ stage: "fetching", progress: 0 }, true);
    let data;
    if (kind === "file" && options.output === "original") data = await fetchBytes(url, MAX_INPUT_BYTES, task.controller.signal, void 0, {
      progress: (loaded, total) => report({ stage: "fetching", loaded, ...total ? { total, progress: loaded / total } : {} }),
      protocol: (value) => protocols.add(value)
    });
    else {
      let plan;
      if (kind === "file") plan = { assets: [{ url, filename: "asset-00000.data" }], inputs: [{ filename: "input-0.mp4", parts: ["asset-00000.data"] }] };
      else if (kind === "hls") plan = await planHls(url, (address) => fetchManifestResource(address, task.controller.signal), options);
      else {
        const resource = await fetchManifestResource(url, task.controller.signal);
        plan = planDash(resource.text, resource.url, options);
      }
      task.controller.signal.throwIfAborted();
      data = await new Promise((resolve, reject) => {
        task.reject = reject;
        const worker = new Worker(chrome.runtime.getURL("local/stream-worker.js"), { type: "module" });
        task.worker = worker;
        worker.addEventListener("error", () => reject(new Error("\uC2A4\uD2B8\uB9BC \uCC98\uB9AC \uC5D4\uC9C4\uC744 \uC2E4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.")));
        worker.addEventListener("message", (event) => {
          if (!record(event.data)) return;
          if (event.data.type === "progress" && typeof event.data.value === "number") report({ stage: event.data.stage === "processing" ? "processing" : "fetching", progress: event.data.value }, event.data.stage === "processing");
          else if (event.data.type === "done" && event.data.bytes instanceof ArrayBuffer) {
            if (Array.isArray(event.data.protocols)) for (const value of event.data.protocols) {
              const actual = transport(value);
              if (actual) protocols.add(actual);
            }
            resolve(new Uint8Array(event.data.bytes));
          } else if (event.data.type === "error") reject(new Error(typeof event.data.message === "string" ? event.data.message : "\uC2A4\uD2B8\uB9BC \uCC98\uB9AC \uC624\uB958"));
        });
        worker.postMessage({ plan, options });
      });
    }
    if (task.controller.signal.aborted) throw new Error("\uC791\uC5C5\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.");
    report({ stage: "saving", progress: 1 }, true);
    const root = await navigator.storage.getDirectory();
    const filename = `local-${id}.media`;
    const handle = await root.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(data);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {
      });
      throw error;
    }
    signal.throwIfAborted();
    const file = await handle.getFile();
    const blob = URL.createObjectURL(file);
    prepared.set(id, { url: blob, filename });
    return { ok: true, url: blob, filename, protocols: [...protocols] };
  } catch (error) {
    await disposeLocal(id).catch(() => {
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    task.worker?.terminate();
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!record(message) || message.scope !== OFFSCREEN_SCOPE || sender.id !== chrome.runtime.id || sender.tab || sender.url && !sender.url.startsWith(chrome.runtime.getURL("")) || typeof message.id !== "string" || !/^[0-9a-f-]{36}$/.test(message.id)) return false;
  const id = message.id;
  if (message.type === "cancel") {
    cancelLocal(id);
    reply({ ok: true });
    return false;
  }
  if (message.type === "dispose") {
    void disposeLocal(id).then(() => reply({ ok: true })).catch(() => reply({ ok: false }));
    return true;
  }
  if (message.type !== "prepare" || !["file", "hls", "dash"].includes(String(message.kind))) return false;
  let url;
  try {
    url = mediaURL(message.url).href;
  } catch {
    reply({ ok: false, error: "\uBBF8\uB514\uC5B4 \uC8FC\uC18C\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
    return false;
  }
  void prepareLocal(id, url, String(message.kind), message.options).then(reply).catch((error) => {
    reply({ ok: false, error: error instanceof Error ? error.message : "\uD30C\uC77C \uC900\uBE44 \uC624\uB958" });
  });
  return true;
});
export {
  cancelLocal,
  disposeLocal,
  prepareLocal
};
