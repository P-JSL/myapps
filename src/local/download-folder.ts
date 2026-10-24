/** Chrome owns the actual absolute download directory; the app stores acknowledgement only. */
export const DOWNLOAD_FOLDER_CONFIRMED_KEY = 'my_video_app_download_folder_confirmed_v1';

export function downloadFolderConfirmed(value?: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('다운로드 저장 폴더 설정을 확인할 수 없습니다. 설정을 다시 확인하세요.');
  return value;
}
