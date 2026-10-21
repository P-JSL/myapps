/** Container metadata is shared by validation, processing and file inspection. */
export const MEDIA_FILE_MIME = Object.freeze({
  mp4: 'video/mp4', m4a: 'audio/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', aac: 'audio/aac',
} as const);
export const PROCESSING_MIME = Object.freeze({
  mp4: MEDIA_FILE_MIME.mp4, webm: MEDIA_FILE_MIME.webm, mkv: MEDIA_FILE_MIME.mkv,
  mp3: MEDIA_FILE_MIME.mp3, m4a: MEDIA_FILE_MIME.m4a, wav: MEDIA_FILE_MIME.wav, png: 'image/png',
} as const);
export const VIDEO_FORMATS = Object.freeze(['mp4', 'webm', 'mkv'] as const);
export const AUDIO_FORMATS = Object.freeze(['mp3', 'm4a', 'wav'] as const);
export const MERGE_FORMATS = Object.freeze(['mp4', 'mkv'] as const);
export const QUALITIES = Object.freeze(['highest', '2160', '1080', '720', '480'] as const);
export const DOWNLOAD_OUTPUTS = Object.freeze(['original', 'mp3', 'm4a'] as const);
export type VideoFormat = typeof VIDEO_FORMATS[number];
export type AudioFormat = typeof AUDIO_FORMATS[number];
export type Quality = typeof QUALITIES[number];
export type DownloadOutput = typeof DOWNLOAD_OUTPUTS[number];

/** Keep profiles as ordered arguments; callers retain control over track maps. */
export const ENCODER_ARGUMENTS = Object.freeze({
  h264: Object.freeze(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'] as const),
  vp8: Object.freeze(['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '4', '-crf', '10', '-b:v', '4M'] as const),
  mp3: Object.freeze(['-c:a', 'libmp3lame', '-b:a', '192k'] as const),
  aac: Object.freeze(['-c:a', 'aac', '-b:a', '192k'] as const),
  pcm16: Object.freeze(['-c:a', 'pcm_s16le'] as const),
  opus: Object.freeze(['-c:a', 'libopus', '-b:a', '192k'] as const),
});
