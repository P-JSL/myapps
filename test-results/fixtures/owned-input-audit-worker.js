// <stdin>
import createFFmpegCore from "/assets/52819271b9ca09a31841a3e7b08e2fdb.js";

// src/upscale/policy.ts
var MAX_INPUT_BYTES = 256 * 1024 * 1024;
var MAX_QUEUE_BYTES = 512 * 1024 * 1024;
var MAX_OUTPUT_PIXELS = 16777216;
var MAX_EDGE = 8192;
var MAX_DURATION = 600;
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

// <stdin>
var digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
function probe(core, filename, report) {
  core.reset();
  core.setTimeout(15e3);
  const result = core.ffprobe("-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe", "-show_error", "-show_streams", "-show_format", "-of", "json", "-o", report, filename);
  if (result !== 0 && result !== -1) throw Error("Fixture probe failed: " + result);
  const metadata = JSON.parse(core.FS.readFile(report, { encoding: "utf8" }));
  core.FS.unlink(report);
  if (metadata.error || !metadata.streams?.length) throw Error("Fixture streams missing");
  return metadata;
}
self.onmessage = async ({ data }) => {
  try {
    const core = await createFFmpegCore();
    const versionLog = [];
    core.setLogger(({ message }) => versionLog.push(message));
    core.reset();
    core.exec("-version");
    const engineVersion = versionLog.join(" | ");
    if (!engineVersion.includes("ffmpeg version ")) throw Error("Engine version was not reported");
    core.setLogger(() => {
    });
    const routes = data.mode === "image" ? ["image.png"] : data.mode === "merge" ? ["clip.mp4", "audio-only.m4a"] : ["clip.mp4"];
    const files = await Promise.all(routes.map(async (route) => new File([await (await fetch("/fixtures/" + route)).blob()], route)));
    const originalHashes = await Promise.all(files.map(async (file) => digest(await file.arrayBuffer())));
    const ownedAliases = [];
    const randomReads = [];
    for (let index = 0; index < files.length; index++) {
      const name2 = index ? "audio.media" : "input.media";
      const bytes = new Uint8Array(await files[index].arrayBuffer());
      core.FS.writeFile(name2, bytes, data.method === "owned" ? { canOwn: true } : void 0);
      ownedAliases.push(core.FS.lookupPath(name2).node.contents.buffer === bytes.buffer);
      for (const position of [0, Math.floor(bytes.length / 2), Math.max(0, bytes.length - 31)]) {
        const stream = core.FS.open(name2, "r");
        const chunk = new Uint8Array(Math.min(31, bytes.length - position));
        core.FS.read(stream, chunk, 0, chunk.length, position);
        core.FS.close(stream);
        randomReads.push(chunk.every((byte, offset) => byte === bytes[position + offset]));
      }
    }
    const metadata = probe(core, "input.media", "input-probe.json");
    const video = metadata.streams.find((stream) => stream.codec_type === "video");
    const info = {
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      duration: Number(metadata.format.duration ?? 0),
      video: !!video,
      audio: metadata.streams.some((stream) => stream.codec_type === "audio"),
      kind: data.mode === "image" ? "image" : "video"
    };
    const options = data.mode === "audio" ? { mode: "audio", format: "mp3" } : data.mode === "merge" ? { mode: "merge", format: "mp4" } : { mode: "upscale", factor: 2 };
    core.reset();
    core.setTimeout(12e4);
    const result = core.exec(...processingArguments(info, options));
    if (result !== 0) throw Error("Fixture processing failed: " + result);
    const name = "output." + resultFormat(options, info.kind);
    const output = core.FS.readFile(name);
    const outputMetadata = probe(core, name, "output-probe.json");
    const afterHashes = await Promise.all(files.map(async (file) => digest(await file.arrayBuffer())));
    self.postMessage({
      method: data.method,
      mode: data.mode,
      engineVersion,
      ownedAliases,
      randomReads,
      metadata,
      outputMetadata,
      sourceUnchanged: originalHashes.every((hash, index) => hash === afterHashes[index]),
      bytes: output.byteLength,
      sha256: await digest(output)
    });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
