// src/upscale/worker.ts
import createFFmpegCore from "../vendor/ffmpeg/ffmpeg-core.js";

// src/security/validation.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/security/transfer.ts
function ownedTransferBuffer(bytes) {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return new Uint8Array(bytes).buffer;
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

// src/shared/media.ts
var MEDIA_FILE_MIME = Object.freeze({
  mp4: "video/mp4",
  m4a: "audio/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  ogg: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  aac: "audio/aac"
});
var PROCESSING_MIME = Object.freeze({
  mp4: MEDIA_FILE_MIME.mp4,
  webm: MEDIA_FILE_MIME.webm,
  mkv: MEDIA_FILE_MIME.mkv,
  mp3: MEDIA_FILE_MIME.mp3,
  m4a: MEDIA_FILE_MIME.m4a,
  wav: MEDIA_FILE_MIME.wav,
  png: "image/png"
});
var VIDEO_FORMATS = Object.freeze(["mp4", "webm", "mkv"]);
var AUDIO_FORMATS = Object.freeze(["mp3", "m4a", "wav"]);
var MERGE_FORMATS = Object.freeze(["mp4", "mkv"]);
var QUALITIES = Object.freeze(["highest", "2160", "1080", "720", "480"]);
var DOWNLOAD_OUTPUTS = Object.freeze(["original", "mp3", "m4a"]);
var ENCODER_ARGUMENTS = Object.freeze({
  h264: Object.freeze(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]),
  vp8: Object.freeze(["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "4", "-crf", "10", "-b:v", "4M"]),
  mp3: Object.freeze(["-c:a", "libmp3lame", "-b:a", "192k"]),
  aac: Object.freeze(["-c:a", "aac", "-b:a", "192k"]),
  pcm16: Object.freeze(["-c:a", "pcm_s16le"]),
  opus: Object.freeze(["-c:a", "libopus", "-b:a", "192k"])
});

// src/upscale/processing.ts
function processingOptions(value) {
  if (!record(value)) throw new Error("\uCC98\uB9AC \uC124\uC815\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  if (value.mode === "upscale" && (value.factor === 2 || value.factor === 4)) return { mode: "upscale", factor: value.factor };
  if (value.mode === "convert" && VIDEO_FORMATS.includes(String(value.format)) && QUALITIES.includes(value.quality)) return { mode: "convert", format: value.format, quality: value.quality };
  if (value.mode === "audio" && AUDIO_FORMATS.includes(String(value.format))) return { mode: "audio", format: value.format };
  if (value.mode === "merge" && MERGE_FORMATS.includes(String(value.format))) return { mode: "merge", format: value.format };
  throw new Error("\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uCC98\uB9AC \uC124\uC815\uC785\uB2C8\uB2E4.");
}
function sniffInput(bytes) {
  const visual = sniffMedia(bytes);
  if (visual) return visual;
  const ascii = (start, count) => String.fromCharCode(...bytes.subarray(start, start + count));
  if (ascii(0, 3) === "ID3" || ascii(0, 4) === "fLaC" || ascii(0, 4) === "OggS" || ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE" || bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224) return "audio";
  return void 0;
}
function validateTrack(info, options) {
  if (options.mode === "upscale") return;
  if (!Number.isFinite(info.duration) || info.duration <= 0 || info.duration > MAX_DURATION) throw new Error("\uCD5C\uB300 10\uBD84 \uAE38\uC774\uC758 \uBBF8\uB514\uC5B4\uB9CC \uCC98\uB9AC\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
  if (options.mode === "audio") {
    if (!info.audio) throw new Error("\uC800\uC7A5\uD560 \uC624\uB514\uC624 \uD2B8\uB799\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
    return;
  }
  if (!info.video || info.kind === "image") throw new Error("\uC601\uC0C1 \uD2B8\uB799\uC774 \uC788\uB294 \uB3D9\uC601\uC0C1 \uD30C\uC77C\uC744 \uC120\uD0DD\uD558\uC138\uC694.");
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 2 || info.height < 2 || info.width > MAX_EDGE || info.height > MAX_EDGE || info.width * info.height > MAX_OUTPUT_PIXELS) throw new Error("\uC601\uC0C1 \uD06C\uAE30\uAC00 \uC548\uC804\uD55C \uCC98\uB9AC \uD55C\uB3C4\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
}
function convertedDimensions(info, quality) {
  const ratio = quality === "highest" ? 1 : Math.min(1, Number(quality) / info.height);
  return { width: Math.max(2, Math.floor(info.width * ratio / 2) * 2), height: Math.max(2, Math.floor(info.height * ratio / 2) * 2) };
}
function resultFormat(options, kind) {
  return options.mode === "upscale" ? kind === "image" ? "png" : "mp4" : options.format;
}
function processingArguments(info, options) {
  if (options.mode === "upscale") return ffmpegArguments(info, options.factor);
  validateTrack(info, options);
  const args = ["-hide_banner", "-nostdin", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-i", "input.media"];
  if (options.mode === "merge") args.push("-protocol_whitelist", "file,pipe", "-i", "audio.media");
  args.push("-threads", "1", "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn");
  if (options.mode === "audio") {
    const encoder = options.format === "mp3" ? ENCODER_ARGUMENTS.mp3 : options.format === "m4a" ? ENCODER_ARGUMENTS.aac : ENCODER_ARGUMENTS.pcm16;
    args.push("-map", "0:a:0", "-vn", ...encoder);
    if (options.format !== "wav" && encoder === ENCODER_ARGUMENTS.pcm16) args.push("-b:a", "192k");
  } else if (options.mode === "merge") args.push("-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", ...ENCODER_ARGUMENTS.aac, "-shortest");
  else {
    const dimensions = convertedDimensions(info, options.quality);
    args.push("-map", "0:v:0", "-map", "0:a:0?", "-vf", `scale=${dimensions.width}:${dimensions.height}:flags=lanczos`, "-pix_fmt", "yuv420p");
    if (options.format === "webm") args.push(...ENCODER_ARGUMENTS.vp8, ...ENCODER_ARGUMENTS.opus);
    else args.push(...ENCODER_ARGUMENTS.h264, ...ENCODER_ARGUMENTS.aac);
  }
  if (options.format === "mp4" || options.format === "m4a") args.push("-movflags", "+faststart");
  args.push("-fs", String(MAX_INPUT_BYTES), "-y", `output.${options.format}`);
  return args;
}

// src/upscale/worker.ts
var scope = globalThis;
var busy = false;
async function checkFile(file) {
  if (!(file instanceof File) || !file.size || file.size > MAX_INPUT_BYTES) throw new Error("\uD30C\uC77C\uC740 0\uBC14\uC774\uD2B8\uBCF4\uB2E4 \uD06C\uACE0 256MiB \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  const kind = sniffInput(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (!kind) throw new Error("\uC9C0\uC6D0\uD558\uB294 \uD615\uC2DD: \uC601\uC0C1\xB7\uC774\uBBF8\uC9C0\xB7\uC624\uB514\uC624. HTML\xB7\uBAA9\uB85D \uD30C\uC77C\uC740 \uCC98\uB9AC\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  return kind;
}
function probe(core, filename, kind) {
  core.reset();
  core.setTimeout(15e3);
  const code = core.ffprobe("-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-show_error", "-show_streams", "-show_format", "-of", "json", "-o", "probe.json", filename);
  if (code !== 0 && code !== -1) throw new Error("\uD30C\uC77C \uC815\uBCF4\uB97C \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  const raw = core.FS.readFile("probe.json", { encoding: "utf8" });
  core.FS.unlink("probe.json");
  if (typeof raw !== "string" || raw.length > 256e3) throw new Error("\uD30C\uC77C \uC815\uBCF4\uAC00 \uD5C8\uC6A9 \uBC94\uC704\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.");
  const metadata = JSON.parse(raw);
  if (!record(metadata) || metadata.error || !Array.isArray(metadata.streams)) throw new Error("\uBBF8\uB514\uC5B4 \uC815\uBCF4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uD30C\uC77C\uC774 \uC190\uC0C1\uB418\uC5C8\uAC70\uB098 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uD615\uC2DD\uC785\uB2C8\uB2E4.");
  const video = metadata.streams.find((stream) => record(stream) && stream.codec_type === "video" && !(record(stream.disposition) && stream.disposition.attached_pic === 1));
  const audio = metadata.streams.find((stream) => record(stream) && stream.codec_type === "audio");
  const format = record(metadata.format) ? metadata.format : {};
  return {
    width: record(video) ? Number(video.width) : 0,
    height: record(video) ? Number(video.height) : 0,
    duration: Number(format.duration ?? (record(video) ? video.duration : record(audio) ? audio.duration : 0) ?? 0),
    video: !!video,
    audio: !!audio,
    kind: kind === "image" ? "image" : video ? "video" : "audio"
  };
}
scope.onmessage = async (event) => {
  if (busy) return;
  busy = true;
  try {
    const data = event.data;
    if (!record(data)) throw new Error("\uC798\uBABB\uB41C \uCC98\uB9AC \uC694\uCCAD\uC785\uB2C8\uB2E4.");
    const options = processingOptions(data.options ?? { mode: "upscale", factor: data.factor });
    const kind = await checkFile(data.file);
    const file = data.file;
    let secondary;
    if (options.mode === "merge") {
      await checkFile(data.audio);
      secondary = data.audio;
      if (file.size + secondary.size > MAX_INPUT_BYTES) throw new Error("\uBCD1\uD569\uD560 \uB450 \uD30C\uC77C\uC758 \uD569\uACC4\uB294 256MiB \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
    }
    scope.postMessage({ type: "status", message: "\uBE0C\uB77C\uC6B0\uC800 \uB0B4\uBD80 \uCC98\uB9AC \uC5D4\uC9C4\uC744 \uC900\uBE44\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4\u2026" });
    const core = await createFFmpegCore();
    let lastLog = "";
    core.setLogger(({ message }) => {
      lastLog = message.slice(0, 500);
    });
    core.FS.writeFile("input.media", new Uint8Array(await file.arrayBuffer()), { canOwn: true });
    const info = probe(core, "input.media", kind);
    if (options.mode === "upscale" && !info.video) throw new Error("\uC5C5\uC2A4\uCF00\uC77C\uB9C1\uD560 \uC601\uC0C1 \uB610\uB294 \uC774\uBBF8\uC9C0 \uD2B8\uB799\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
    validateTrack(info, options);
    if (secondary) {
      core.FS.writeFile("audio.media", new Uint8Array(await secondary.arrayBuffer()), { canOwn: true });
      const audio = probe(core, "audio.media", "audio");
      validateTrack(audio, { mode: "audio", format: "m4a" });
    }
    const dimensions = options.mode === "upscale" ? outputDimensions(info, options.factor) : options.mode === "convert" ? convertedDimensions(info, options.quality) : { width: info.width, height: info.height };
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
    const result = core.exec(...processingArguments(info, options));
    if (result !== 0) throw new Error(`\uBBF8\uB514\uC5B4 \uCC98\uB9AC\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4 (\uCF54\uB4DC ${result}). ${lastLog}`);
    const format = resultFormat(options, kind);
    const output = core.FS.readFile(`output.${format}`);
    if (!(output instanceof Uint8Array) || !output.length || output.length >= MAX_INPUT_BYTES - 1024 * 1024) throw new Error("\uACB0\uACFC\uAC00 \uBE44\uC5B4 \uC788\uAC70\uB098 \uC548\uC804\uD55C \uCD9C\uB825 \uC6A9\uB7C9 \uD55C\uB3C4\uC5D0 \uB3C4\uB2EC\uD588\uC2B5\uB2C8\uB2E4.");
    const bytes = ownedTransferBuffer(output);
    scope.postMessage({ type: "done", info, output: dimensions, format, bytes }, [bytes]);
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : "\uCC98\uB9AC \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4." });
  }
};
