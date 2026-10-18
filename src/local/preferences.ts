import { record } from '../security/validation.ts';

export const QUALITIES = ['highest', '2160', '1080', '720', '480'] as const;
export type Quality = typeof QUALITIES[number];
export type DownloadOutput = 'original' | 'mp3' | 'm4a';
export interface DownloadOptions { quality: Quality; output: DownloadOutput; }
export function downloadOptions(value?: unknown): DownloadOptions {
  if (value === undefined) return { quality: 'highest', output: 'original' };
  if (!record(value) || !QUALITIES.includes(value.quality as Quality) || !['original', 'mp3', 'm4a'].includes(String(value.output))) throw new Error('다운로드 화질 또는 저장 형식이 올바르지 않습니다.');
  return { quality: value.quality as Quality, output: value.output as DownloadOutput };
}
/** Prefer actual resolution, then bandwidth; a ceiling never invents a missing rendition. */
export function chooseQuality<T>(items: T[], quality: Quality, height: (item: T) => number, bandwidth: (item: T) => number): T | undefined {
  const known = items.filter(item => Number.isFinite(height(item)) && height(item) > 0);
  const ranked = (values: T[]) => [...values].sort((a, b) => height(b) - height(a) || bandwidth(b) - bandwidth(a))[0];
  if (!known.length) return [...items].sort((a, b) => bandwidth(b) - bandwidth(a))[0];
  if (quality === 'highest') return ranked(known);
  const eligible = known.filter(item => height(item) <= Number(quality));
  if (eligible.length) return ranked(eligible);
  const minimum = Math.min(...known.map(height));
  return ranked(known.filter(item => height(item) === minimum));
}
