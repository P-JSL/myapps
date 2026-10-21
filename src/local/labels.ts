import type { FileSecurity } from './antivirus.ts';
import type { DownloadState, HistoryItem } from './model.ts';

export const HISTORY_STATE_LABELS = Object.freeze({
  preparing: '파일 준비 중', downloading: '다운로드 중', scanning: '로컬 백신 검사 중', review: '보안 검사 확인 필요',
  discarded: '파일 삭제됨', complete: '완료', cancelled: '취소됨', error: '실패',
} satisfies Record<DownloadState, string>);
export const SECURITY_STATUS_LABELS = Object.freeze({
  scanning: '로컬 백신: 검사 중', clean: '로컬 백신: 위협 미탐지', infected: '로컬 백신: 위협 탐지',
  unavailable: '로컬 백신: 연결되지 않음', error: '로컬 백신: 검사 실패', 'chrome-warning': 'Chrome 다운로드 경고',
} satisfies Record<FileSecurity['status'], string>);
export const PREPARATION_STAGE_LABELS = Object.freeze({
  queued: '준비 대기 중', fetching: '파일 받는 중', processing: '미디어 합치는 중', saving: '저장 준비 중',
} satisfies Record<NonNullable<HistoryItem['preparation']>['stage'], string>);
