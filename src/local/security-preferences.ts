export const ANTIVIRUS_ENABLED_KEY = 'my_video_app_antivirus_enabled_v1';

/** A missing setting preserves existing protection; malformed values never disable it. */
export function antivirusEnabled(value?: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new Error('백신 연동 설정이 올바르지 않습니다.');
  return value;
}
