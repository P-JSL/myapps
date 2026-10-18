// src/upscale/worker.ts
import createFFmpegCore from "../vendor/ffmpeg/ffmpeg-core.js";

// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/upscale/policy.ts
var MAX_INPUT_BYTES = 256 * 1024 * 1024;
var MAX_QUEUE_BYTES = 512 * 1024 * 1024;
var MAX_OUTPUT_PIXELS = 16777216;
var MAX_EDGE = 8192;
var MAX_DURATION = 600;
var MAX_RUNTIME_MS = 3e5;
var RETENTION_MS = 24 * 60 * 60 * 1e3;
function outputDimensions(info, factor) {
  if (factor !== 2 && factor !== 4) throw new Error("\uD655\uB300 \uBC30\uC728\uC740 2\uBC30 \uB610\uB294 4\uBC30\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1) throw new Error("\uC601\uC0C1 \uD06C\uAE30\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  if (info.kind === "video" && (!Number.isFinite(info.duration) || info.duration <= 0 || info.duration > MAX_DURATION)) throw new Error("\uCD5C\uB300 10\uBD84 \uAE38\uC774\uC758 \uB3D9\uC601\uC0C1\uB9CC \uCC98\uB9AC\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
  let width = info.width * factor;
  let height = info.height * factor;
  if (info.kind === "video") {
    width += width % 2;
    height += height % 2;
  }
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_OUTPUT_PIXELS) throw new Error("\uD655\uB300 \uACB0\uACFC\uB294 \uD55C \uBCC0 8,192\uD53D\uC140, \uC804\uCCB4 1,677\uB9CC \uD53D\uC140 \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  return { width, height };
}
function sniffMedia(bytes) {
  const ascii = (start, count) => String.fromCharCode(...bytes.subarray(start, start + count));
  if (bytes[0] === 137 && ascii(1, 3) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "image";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image";
  if (ascii(4, 4) === "ftyp" || ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") return "video";
  if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return "video";
  return void 0;
}
function ffmpegArguments(info, factor) {
  const { width, height } = outputDimensions(info, factor);
  const args = ["-hide_banner", "-nostdin", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-i", "input.media", "-map", "0:v:0", "-vf", `scale=${width}:${height}:flags=lanczos`, "-threads", "1"];
  if (info.kind === "image") args.push("-frames:v", "1", "-c:v", "png", "-fs", String(MAX_INPUT_BYTES), "-y", "output.png");
  else args.push("-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-fs", String(MAX_INPUT_BYTES), "-y", "output.mp4");
  return args;
}

// src/upscale/worker.ts
var scope = globalThis;
var busy = false;
scope.onmessage = async (event) => {
  if (busy) return;
  busy = true;
  try {
    const data = event.data;
    if (!record(data) || !(data.file instanceof File) || data.factor !== 2 && data.factor !== 4) throw new Error("\uC798\uBABB\uB41C \uCC98\uB9AC \uC694\uCCAD\uC785\uB2C8\uB2E4.");
    const file = data.file;
    if (!file.size || file.size > MAX_INPUT_BYTES) throw new Error("\uD30C\uC77C \uD06C\uAE30\uB294 256MiB \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
    const kind = sniffMedia(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    if (!kind) throw new Error("\uC9C0\uC6D0\uD558\uB294 \uD615\uC2DD: PNG, JPEG, WebP, MP4/MOV, WebM/MKV, AVI.");
    scope.postMessage({ type: "status", message: "\uBE0C\uB77C\uC6B0\uC800 \uB0B4\uBD80 \uCC98\uB9AC \uC5D4\uC9C4\uC744 \uC900\uBE44\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4\u2026" });
    const core = await createFFmpegCore();
    let lastLog = "";
    core.setLogger(({ message }) => {
      lastLog = message.slice(0, 500);
    });
    core.FS.writeFile("input.media", new Uint8Array(await file.arrayBuffer()));
    core.setTimeout(15e3);
    const code = core.ffprobe("-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-show_error", "-show_streams", "-show_format", "-of", "json", "-o", "probe.json", "input.media");
    if (code !== 0 && code !== -1) throw new Error("\uD30C\uC77C \uC815\uBCF4\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC190\uC0C1\uB418\uAC70\uB098 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD30C\uC77C\uC785\uB2C8\uB2E4.");
    const raw = core.FS.readFile("probe.json", { encoding: "utf8" });
    if (typeof raw !== "string" || raw.length > 256e3) throw new Error("\uD30C\uC77C \uC815\uBCF4\uAC00 \uD5C8\uC6A9 \uBC94\uC704\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
    const metadata = JSON.parse(raw);
    if (!record(metadata) || metadata.error || !Array.isArray(metadata.streams)) throw new Error("\uBBF8\uB514\uC5B4 \uC815\uBCF4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uD30C\uC77C\uC774 \uC190\uC0C1\uB418\uC5C8\uAC70\uB098 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD615\uC2DD\uC785\uB2C8\uB2E4.");
    const video = metadata.streams.find((stream) => record(stream) && stream.codec_type === "video");
    if (!record(video)) throw new Error("\uC601\uC0C1 \uB610\uB294 \uC774\uBBF8\uC9C0 \uD2B8\uB799\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
    const format = record(metadata.format) ? metadata.format : {};
    const info = { width: Number(video.width), height: Number(video.height), duration: Number(format.duration ?? video.duration ?? 0), kind };
    const dimensions = outputDimensions(info, data.factor);
    scope.postMessage({ type: "metadata", info, output: dimensions });
    core.reset();
    core.setTimeout(MAX_RUNTIME_MS);
    let lastProgress = 0;
    core.setProgress(({ progress }) => {
      const now = performance.now();
      if (now - lastProgress > 200 && Number.isFinite(progress)) {
        scope.postMessage({ type: "progress", value: Math.max(0, Math.min(0.99, progress)) });
        lastProgress = now;
      }
    });
    const result = core.exec(...ffmpegArguments(info, data.factor));
    if (result !== 0) throw new Error(`\uBBF8\uB514\uC5B4 \uBCC0\uD658\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4 (\uCF54\uB4DC ${result}). ${lastLog}`);
    const output = core.FS.readFile(kind === "image" ? "output.png" : "output.mp4");
    if (!(output instanceof Uint8Array) || !output.length || output.length >= MAX_INPUT_BYTES - 1024 * 1024) throw new Error("\uD655\uB300\uBCF8\uC774 \uBE44\uC5B4 \uC788\uAC70\uB098 \uC548\uC804\uD55C \uCD9C\uB825 \uC6A9\uB7C9 \uD55C\uB3C4\uC5D0 \uB3C4\uB2EC\uD588\uC2B5\uB2C8\uB2E4.");
    const bytes = new Uint8Array(output).buffer;
    scope.postMessage({ type: "done", info, output: dimensions, bytes }, [bytes]);
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : "\uCC98\uB9AC \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
  }
};
