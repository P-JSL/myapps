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
function validRange(range2) {
  if (!Number.isSafeInteger(range2.offset) || !Number.isSafeInteger(range2.length) || !Number.isSafeInteger(range2.offset + range2.length) || range2.offset < 0 || range2.length < 1 || range2.length > 128 * 1024 * 1024) throw new Error("\uBBF8\uB514\uC5B4 \uBC14\uC774\uD2B8 \uBC94\uC704\uAC00 \uD5C8\uC6A9 \uBC94\uC704\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
}

// src/local/preferences.ts
var QUALITIES = ["highest", "2160", "1080", "720", "480"];
function downloadOptions(value) {
  if (value === void 0) return { quality: "highest", output: "original" };
  if (!record(value) || !QUALITIES.includes(value.quality) || !["original", "mp3", "m4a"].includes(String(value.output))) throw new Error("\uB2E4\uC6B4\uB85C\uB4DC \uD654\uC9C8 \uB610\uB294 \uC800\uC7A5 \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  return { quality: value.quality, output: value.output };
}
function chooseQuality(items, quality, height, bandwidth) {
  let highest = -Infinity, lowest = Infinity, eligible = -Infinity;
  const ceiling = Number(quality);
  for (const item of items) {
    const value = height(item);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value > highest) highest = value;
    if (value < lowest) lowest = value;
    if (value <= ceiling && value > eligible) eligible = value;
  }
  const target = highest === -Infinity ? void 0 : quality === "highest" ? highest : eligible !== -Infinity ? eligible : lowest;
  let best, bestBandwidth = -Infinity, found = false;
  for (const item of items) {
    if (target !== void 0 && height(item) !== target) continue;
    const value = bandwidth(item);
    if (!Number.isFinite(value)) return legacyQuality(items, quality, height, bandwidth);
    if (!found || value > bestBandwidth) {
      best = item;
      bestBandwidth = value;
      found = true;
    }
  }
  return best;
}
function legacyQuality(items, quality, height, bandwidth) {
  const known = items.filter((item) => Number.isFinite(height(item)) && height(item) > 0);
  const ranked = (values) => [...values].sort((a, b) => height(b) - height(a) || bandwidth(b) - bandwidth(a))[0];
  if (!known.length) return [...items].sort((a, b) => bandwidth(b) - bandwidth(a))[0];
  if (quality === "highest") return ranked(known);
  const eligible = known.filter((item) => height(item) <= Number(quality));
  if (eligible.length) return ranked(eligible);
  const minimum = Math.min(...known.map(height));
  return ranked(known.filter((item) => height(item) === minimum));
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
  const audio = chooseQuality(
    selections.filter((s) => s.type === "audio"),
    "highest",
    () => 0,
    (item) => Number(item.representation.getAttribute("bandwidth"))
  );
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
export {
  planDash
};
