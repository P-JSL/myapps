import { internalScanResponse, type FileSecurity } from './antivirus.ts';
import type { DownloadState, HistoryItem } from './model.ts';

export const HISTORY_STATE_LABELS = Object.freeze({
  preparing: '파일 준비 중', downloading: '다운로드 중', scanning: '로컬 백신 검사 중', review: '보안 검사 확인 필요',
  discarded: '파일 삭제됨', complete: '완료', cancelled: '취소됨', error: '실패',
} satisfies Record<DownloadState, string>);
export const SECURITY_STATUS_LABELS = Object.freeze({
  scanning: '로컬 백신: 검사 중', clean: '로컬 백신: 위협 미탐지', infected: '로컬 백신: 위협 탐지',
  unavailable: '로컬 백신: 연결되지 않음', error: '로컬 백신: 검사 실패', 'chrome-warning': 'Chrome 다운로드 경고',
  disabled: '로컬 백신: 연동 OFF · 검사하지 않음',
} satisfies Record<FileSecurity['status'], string>);
export const PREPARATION_STAGE_LABELS = Object.freeze({
  queued: '준비 대기 중', fetching: '파일 받는 중', processing: '미디어 합치는 중', saving: '저장 준비 중',
} satisfies Record<NonNullable<HistoryItem['preparation']>['stage'], string>);

export interface InternalScanPresentation {
  label: string;
  explanation: string;
  scope?: string;
  tone: 'neutral' | 'warning' | 'danger';
  findings: string[];
}

/** Present persisted evidence conservatively; a quiet static scan is never an AV verdict. */
export function internalScanPresentation(value: unknown): InternalScanPresentation {
  const missing: InternalScanPresentation = {
    label: '내부 위험 검사: 기록 없음', explanation: '이 기록에는 앱 내부 검사 결과가 없습니다.', tone: 'neutral', findings: [],
  };
  if (value === undefined) return missing;
  const invalid: InternalScanPresentation = {
    label: '내부 위험 검사: 결과 확인 필요', explanation: '내부 검사 결과를 확인할 수 없습니다. 로컬 백신과 Chrome 경고를 함께 확인하세요.', tone: 'warning', findings: [],
  };
  let result: ReturnType<typeof internalScanResponse>;
  try { result = internalScanResponse(value); } catch { return invalid; }
  // The shared parser distinguishes limited coverage from actual risk and
  // rejects contradictory status/finding combinations before presentation.
  const findings = result.findings.map(item => item.message
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 240));
  const scope = `확인한 데이터 ${(result.scannedBytes as number).toLocaleString('ko-KR')}바이트 · ${result.complete ? '전체 범위' : '일부 범위'}`;
  if (result.status === 'suspicious') return {
    label: '내부 위험 검사: 위험 신호', tone: 'danger', scope, findings,
    explanation: '파일 위장이나 의심스러운 내용의 신호입니다. 악성코드 확정 판정은 아닙니다. 파일을 열기 전에 삭제하거나 로컬 백신으로 다시 확인하세요.',
  };
  if (result.status === 'incomplete' || !result.complete) return {
    label: '내부 위험 검사: 검사 범위 제한', tone: 'warning', scope, findings,
    explanation: '파일 전체를 확인하지 못했습니다. 로컬 백신 검사와 Chrome 경고를 함께 확인하세요.',
  };
  return {
    label: '내부 위험 검사: 신호 없음', tone: 'neutral', scope, findings,
    explanation: '검사한 범위에서 등록된 위험 신호를 찾지 못했습니다. 파일의 안전이나 악성코드 부재를 보장하지 않습니다.',
  };
}
