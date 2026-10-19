"use strict";
(() => {
  // src/upscale/policy.ts
  var MAX_INPUT_BYTES = 256 * 1024 * 1024;
  var MAX_QUEUE_BYTES = 512 * 1024 * 1024;
  var RETENTION_MS = 24 * 60 * 60 * 1e3;

  // src/local/model.ts
  var SCOPE = "my-video-app/local";
  var MAX_STREAM_BYTES = 128 * 1024 * 1024;
  function mediaURL(value, base) {
    if (typeof value !== "string" || !value || value.length > 8192) throw new Error("\uBBF8\uB514\uC5B4 \uC8FC\uC18C\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("HTTP \uB610\uB294 HTTPS \uBBF8\uB514\uC5B4 \uC8FC\uC18C\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
    url.hash = "";
    return url;
  }
  function mediaKind(url, mime = "", fromElement = false) {
    const path = mediaURL(url).pathname.toLowerCase();
    if (/\.m3u8$/.test(path) || /mpegurl/i.test(mime)) return "hls";
    if (/\.mpd$/.test(path) || /dash\+xml/i.test(mime)) return "dash";
    if (!fromElement && (/\.(ts|m4s)$/.test(path) || /video\/mp2t/i.test(mime))) return void 0;
    if (/\.(mp4|webm|mkv|mov|avi|m4v|mp3|m4a|ogg|wav|flac|aac)$/.test(path) || /^(video|audio)\//i.test(mime) || fromElement) return "file";
    return void 0;
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

  // src/local/collect.ts
  var sent = /* @__PURE__ */ new Map();
  var timings = /* @__PURE__ */ new Map();
  var candidates = "video,audio,video source,audio source,a[href]";
  var affected = `${candidates},base`;
  var timer;
  var scannedTitle = document.title;
  var scannedBase = document.baseURI;
  var saturated = false;
  function scan() {
    scannedTitle = document.title;
    scannedBase = document.baseURI;
    const found = [];
    const add = (value, mime, fromElement) => {
      try {
        const url = mediaURL(value, location.href).href;
        if (!mediaKind(url, mime, fromElement)) return;
        const protocol = timings.get(url) ?? resourceTransport(url);
        const signature = `${mime}|${document.title.slice(0, 200)}|${protocol ?? ""}`;
        if (sent.get(url) === signature) return;
        sent.set(url, signature);
        found.push({ url, title: document.title.slice(0, 200), mime: mime.slice(0, 100), fromElement, ...protocol ? { observedTransport: protocol } : {} });
      } catch {
      }
    };
    for (const element of document.querySelectorAll(candidates)) {
      if (found.length >= 100) break;
      if (element instanceof HTMLMediaElement) add(element.currentSrc || element.src, "", true);
      else if (element instanceof HTMLSourceElement) add(element.src, element.type, true);
      else if (element instanceof HTMLAnchorElement) add(element.href, "", false);
    }
    for (const url of timings.keys()) {
      if (found.length >= 100) break;
      add(url, "", false);
    }
    saturated = found.length >= 100;
    if (sent.size > 1e3) sent.clear();
    for (let index = 0; index < found.length; index += 10) void chrome.runtime.sendMessage({ scope: SCOPE, type: "capture", items: found.slice(index, index + 10) }).catch(() => {
    });
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(scan, 500);
  }
  try {
    new PerformanceObserver((list) => {
      let changed = false;
      for (const entry of list.getEntries()) {
        const protocol = transport(entry.nextHopProtocol);
        if (!protocol) continue;
        try {
          const url = mediaURL(entry.name).href;
          if (timings.get(url) !== protocol && (sent.has(url) || mediaKind(url))) changed = true;
          timings.set(url, protocol);
        } catch {
        }
      }
      while (timings.size > 1e3) timings.delete(timings.keys().next().value);
      if (saturated || changed || document.title !== scannedTitle || document.baseURI !== scannedBase) schedule();
    }).observe({ type: "resource", buffered: true });
  } catch {
  }
  new MutationObserver((records) => {
    if (saturated || document.title !== scannedTitle || document.baseURI !== scannedBase) {
      schedule();
      return;
    }
    for (const record2 of records) {
      if (record2.type === "attributes") {
        if (record2.target instanceof Element && (record2.target.matches(affected) || record2.target instanceof HTMLAnchorElement)) {
          schedule();
          return;
        }
      } else if (record2.target instanceof HTMLMediaElement) {
        schedule();
        return;
      } else for (const changed of [...record2.addedNodes, ...record2.removedNodes]) {
        if (changed instanceof Element && (changed.matches(affected) || changed.querySelector(affected))) {
          schedule();
          return;
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "href", "type"] });
  document.addEventListener("loadedmetadata", schedule, true);
  scan();
})();
