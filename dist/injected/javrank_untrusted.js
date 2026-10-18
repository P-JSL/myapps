"use strict";
(() => {
  // src/security/validation.ts
  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function boundedData(value, maxChars = 16 * 1024 * 1024) {
    const stack = [[value, 0]];
    const visited = /* @__PURE__ */ new Set();
    let nodes = 0;
    let chars = 0;
    while (stack.length) {
      const [item, depth, exit] = stack.pop();
      if (exit) {
        visited.delete(item);
        continue;
      }
      if (++nodes > 1e5 || depth > 64) return false;
      if (typeof item === "string") chars += item.length;
      else if (typeof item === "number" && !Number.isFinite(item)) return false;
      else if (typeof item === "object" && item !== null) {
        if (visited.has(item)) return false;
        visited.add(item);
        stack.push([item, depth, true]);
        if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
        for (const key of Object.keys(item)) {
          if (key === "__proto__" || key === "constructor" || key === "prototype") return false;
          chars += key.length;
          stack.push([item[key], depth + 1]);
        }
      } else if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") return false;
      if (chars > maxChars) return false;
    }
    return true;
  }
  function envelope(value) {
    return record(value) && Number.isInteger(value.channel) && Number(value.channel) >= 0 && Number(value.channel) <= 8 && record(value.msg) && typeof value.msg.name === "string" && value.msg.name.length > 0 && value.msg.name.length <= 100 && boundedData(value.msg.data);
  }
  function url(value) {
    if (typeof value !== "string") return void 0;
    try {
      return new URL(value);
    } catch {
      return void 0;
    }
  }
  function safeBridge(value, names) {
    if (!envelope(value) || value.channel !== 4 || !names.includes(value.msg.name) || !record(value.msg.data)) return false;
    const d = value.msg.data;
    switch (value.msg.name) {
      case "youtube_on_visitor_data":
        return d.visitor_data === void 0 || typeof d.visitor_data === "string";
      case "vimeo_on_config":
      case "iq_on_config":
        return record(d.config);
      case "javrank_on_manifest":
        return typeof d.raw === "string" && d.raw.trimStart().startsWith("#EXTM3U");
      case "91porna_on_config": {
        const u = url(d.url);
        return typeof d.m3u8 === "string" && d.m3u8.trimStart().startsWith("#EXTM3U") && !!u && ["http:", "https:"].includes(u.protocol);
      }
      case "bilibili_tv_on_config":
        return ["string", "number", "undefined"].includes(typeof d.ep_id) && ["string", "number", "undefined"].includes(typeof d.ai_id);
      case "bilibili_com_on_id":
        return ["string", "number"].includes(typeof d.cid) && typeof d.bvid === "string";
      default:
        return false;
    }
  }

  // src/bridges/common.ts
  function channelHash(text, seed = 0) {
    let a = 3735928559 ^ seed;
    let b = 1103547991 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 2654435761);
      b = Math.imul(b ^ c, 1597334677);
    }
    a = Math.imul(a ^ a >>> 16, 2246822507);
    a ^= Math.imul(b ^ b >>> 13, 3266489909);
    b = Math.imul(b ^ b >>> 16, 2246822507);
    b ^= Math.imul(a ^ a >>> 13, 3266489909);
    return 4294967296 * (2097151 & b) + (a >>> 0);
  }
  function bridge(requests, responses) {
    const channel = new BroadcastChannel(`injected-${channelHash(location.href)}`);
    const abort = new AbortController();
    let pending = false;
    const send2 = (name, data) => {
      const message = { channel: 4, msg: { name, data } };
      if (!abort.signal.aborted && safeBridge(message, responses)) channel.postMessage(message);
    };
    const poll = async (read) => {
      if (pending) return;
      pending = true;
      try {
        let attempt = 1;
        while (!abort.signal.aborted) {
          try {
            if (await read()) return;
          } catch {
          }
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, Math.min(attempt++ * 1e3, 3e4));
            abort.signal.addEventListener("abort", done, { once: true });
          });
        }
      } finally {
        pending = false;
      }
    };
    let lastRequest = -Infinity;
    const listen = (handler) => channel.addEventListener("message", (event) => {
      if (!envelope(event.data) || event.data.channel !== 5 || !requests.includes(event.data.msg.name)) return;
      const now = performance.now();
      if (now - lastRequest < 100) return;
      lastRequest = now;
      handler(event.data.msg.name);
    });
    addEventListener("pagehide", (event) => {
      if (!event.persisted) {
        abort.abort();
        channel.close();
      }
    });
    return { send: send2, poll, listen };
  }

  // src/bridges/javrank.ts
  var bus = bridge(["javrank_request_manifest"], ["javrank_on_manifest"]);
  var manifest;
  function send(raw) {
    if (raw.length <= 16 * 1024 * 1024 && raw.trimStart().startsWith("#EXTM3U")) {
      manifest = raw;
      bus.send("javrank_on_manifest", { raw });
    }
  }
  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(...args) {
    this.addEventListener("load", () => {
      try {
        if (this.responseURL.includes(".m3u8") && (!this.responseType || this.responseType === "text")) send(this.responseText);
      } catch {
      }
    }, { once: true });
    return Reflect.apply(originalOpen, this, args);
  };
  bus.listen(() => {
    if (manifest) send(manifest);
  });
})();
