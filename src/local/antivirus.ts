import { boundedData, record } from '../security/validation.ts';
import type { InternalScanResult, InternalFinding } from '../security/internal-scan.ts';

export const ANTIVIRUS_HOST = 'com.myvideoapp.antivirus';
export type ScanStatus = 'clean' | 'infected' | 'unavailable' | 'error';
export interface ScanResult {
  status: ScanStatus; engine?: string; threats?: string[]; message?: string;
  sha256?: string; size?: number; checkedAt?: number; internalScan?: InternalScanResult;
}
export interface AntivirusReadiness {
  status: 'ready' | 'unavailable' | 'error'; engine?: string; message?: string;
  products?: string[]; internalAvailable?: boolean; checkedAt: number;
}
export interface FileSecurity extends Omit<ScanResult, 'status'> {
  status: ScanStatus | 'scanning' | 'chrome-warning'; token: string;
  danger?: string; decision?: 'keep' | 'delete';
}
/** Parse bounded app/native metadata; findings never contain raw file contents. */
export function internalScanResponse(value: unknown, size?: number): InternalScanResult {
  if (!record(value) || !boundedData(value, 16 * 1024) || value.version !== 1 || value.engine !== 'builtin-static-v1'
    || !['no-signals', 'suspicious', 'incomplete'].includes(String(value.status)) || typeof value.complete !== 'boolean'
    || !Number.isSafeInteger(value.scannedBytes) || Number(value.scannedBytes) < 0 || Number(value.scannedBytes) > 2 * 1024 * 1024 * 1024 - 1
    || !Array.isArray(value.findings) || value.findings.length > 16) throw new Error('내부 위험 검사 결과를 확인할 수 없습니다.');
  const findings: InternalFinding[] = value.findings.map((finding: unknown) => {
    if (!record(finding) || typeof finding.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(finding.id)
      || !['high', 'warning'].includes(String(finding.severity)) || typeof finding.message !== 'string'
      || !finding.message.trim() || finding.message.length > 500
      || (finding.offset !== undefined && (!Number.isSafeInteger(finding.offset) || Number(finding.offset) < 0 || Number(finding.offset) >= Number(value.scannedBytes)))) throw new Error('내부 위험 신호 정보가 올바르지 않습니다.');
    return { id: finding.id, severity: finding.severity as InternalFinding['severity'], message: finding.message,
      ...(finding.offset === undefined ? {} : { offset: Number(finding.offset) }) };
  });
  const hasRiskFinding = findings.some(finding => !['analysis-limit', 'empty-input', 'unsupported-format', 'partial-input'].includes(finding.id));
  if ((value.status === 'no-signals' && (!value.complete || findings.length > 0))
    || (value.status === 'incomplete' && (value.complete || hasRiskFinding)) || (value.status === 'suspicious' && !hasRiskFinding)
    || (value.status !== 'suspicious' && findings.some(finding => finding.severity === 'high'))
    || (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || Number(value.scannedBytes) > size || (value.complete && Number(value.scannedBytes) !== size)))) throw new Error('내부 검사 범위가 파일과 일치하지 않습니다.');
  return { version: 1, engine: 'builtin-static-v1', status: value.status as InternalScanResult['status'],
    scannedBytes: Number(value.scannedBytes), complete: value.complete, findings };
}
export function incompleteInternalScan(message = '브라우저가 저장된 파일 전체를 읽지 못했습니다. 로컬 백신 검사 결과도 확인하세요.'): InternalScanResult {
  return { version: 1, engine: 'builtin-static-v1', status: 'incomplete', scannedBytes: 0, complete: false,
    findings: [{ id: 'analysis-limit', severity: 'warning', message }] };
}
/** Native clean verdicts cannot erase observed app risk signals for the same file. */
export function combineInternalScans(previous: InternalScanResult | undefined, actual: InternalScanResult | undefined): InternalScanResult {
  if (!previous) return actual ?? incompleteInternalScan();
  if (!actual) return previous;
  const suspicious = [previous, actual].filter(result => result.status === 'suspicious');
  if (suspicious.length) {
    const findings = [...new Map(suspicious.flatMap(result => result.findings).map(finding => [`${finding.id}:${finding.offset ?? ''}`, finding])).values()].slice(0, 16);
    return { version: 1, engine: 'builtin-static-v1', status: 'suspicious',
      scannedBytes: Math.max(previous.scannedBytes, actual.scannedBytes), complete: previous.complete || actual.complete, findings };
  }
  return actual.complete ? actual : previous.complete ? previous : actual;
}
export function chromeWarning(danger: unknown): string | undefined {
  if (typeof danger !== 'string' || !danger) return undefined;
  return ['safe', 'accepted', 'deepScannedSafe', 'allowlistedByPolicy'].includes(danger) ? undefined : danger.slice(0, 100);
}
export function scanResponse(value: unknown, requestId: string): ScanResult {
  if (!record(value) || !boundedData(value, 64 * 1024) || value.version !== 1 || value.requestId !== requestId
    || !['clean', 'infected', 'unavailable', 'error'].includes(String(value.status))) throw new Error('백신 응답을 확인할 수 없습니다.');
  const result: ScanResult = { status: value.status as ScanStatus, checkedAt: Date.now() };
  if (typeof value.engine === 'string' && value.engine.length <= 120) result.engine = value.engine;
  if (typeof value.message === 'string') result.message = value.message.slice(0, 1000);
  if (Array.isArray(value.threats) && value.threats.length <= 16 && value.threats.every(x => typeof x === 'string' && x.length <= 240)) result.threats = value.threats as string[];
  if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) result.sha256 = value.sha256;
  if (typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0) result.size = value.size;
  if (['clean', 'infected'].includes(result.status) && (!result.engine || !result.sha256 || result.size === undefined)) throw new Error('백신이 검사한 파일 정보를 확인할 수 없습니다.');
  if (value.internalScan !== undefined) {
    if (!result.sha256 || result.size === undefined) throw new Error('내부 검사가 실제 파일과 연결되지 않았습니다.');
    result.internalScan = internalScanResponse(value.internalScan, result.size);
  }
  return result;
}
export function readinessResponse(value: unknown, requestId: string): AntivirusReadiness {
  if (!record(value) || !boundedData(value, 64 * 1024) || value.version !== 1 || value.requestId !== requestId
    || !['ready', 'unavailable', 'error'].includes(String(value.status))) throw new Error('백신 연결 상태 응답을 확인할 수 없습니다.');
  const result: AntivirusReadiness = { status: value.status as AntivirusReadiness['status'], checkedAt: Date.now() };
  if (value.engine !== undefined) {
    if (typeof value.engine !== 'string' || !value.engine.trim() || value.engine.length > 120) throw new Error('백신 엔진 응답이 올바르지 않습니다.');
    result.engine = value.engine;
  }
  if (value.message !== undefined) {
    if (typeof value.message !== 'string' || value.message.length > 1000) throw new Error('백신 상태 설명이 올바르지 않습니다.');
    result.message = value.message;
  }
  if (value.products !== undefined) {
    if (!Array.isArray(value.products) || value.products.length > 32 || !value.products.every(name => typeof name === 'string' && name.trim() && name.length <= 500)) throw new Error('백신 제품 응답이 올바르지 않습니다.');
    result.products = value.products as string[];
  }
  if (value.internalAvailable !== undefined) {
    if (typeof value.internalAvailable !== 'boolean') throw new Error('내부 검사 도우미의 준비 상태가 올바르지 않습니다.');
    result.internalAvailable = value.internalAvailable;
  }
  if (result.status === 'ready' && !result.engine) throw new Error('연결할 백신 엔진을 확인하지 못했습니다.');
  return result;
}
interface NativeProtocol<T> {
  action: 'status' | 'scan'; timeoutMs: number;
  response(value: unknown, requestId: string): T;
  failure(status: 'error' | 'unavailable', message: string): T;
  malformedMessage: string; disconnectedMessage: string; timeoutMessage: string;
}
const readinessProtocol: NativeProtocol<AntivirusReadiness> = {
  action: 'status', timeoutMs: 60_000, response: readinessResponse,
  failure: (status, message) => ({ status, checkedAt: Date.now(), message }),
  malformedMessage: '백신 도우미의 상태 응답이 올바르지 않습니다. 최신 도우미로 다시 설치하세요.',
  disconnectedMessage: '로컬 백신 도우미 연결이 종료됐습니다. 설치 상태를 확인하세요.',
  timeoutMessage: '백신 연결 상태 확인이 제한 시간을 초과했습니다.',
};
const scanProtocol: NativeProtocol<ScanResult> = {
  action: 'scan', timeoutMs: 240_000, response: scanResponse,
  failure: (status, message) => ({ status, message }),
  malformedMessage: '백신 응답이 올바르지 않아 검사 완료로 처리하지 않았습니다.',
  disconnectedMessage: '로컬 백신 도우미가 연결을 종료했습니다. 설치 상태를 확인하세요.',
  timeoutMessage: '백신 검사가 제한 시간을 초과했습니다. 검사되지 않은 파일입니다.',
};
function nativeRequest<T>(protocol: NativeProtocol<T>, payload?: { path: string }): Promise<T> {
  return new Promise<T>(resolve => {
    let port: chrome.runtime.Port | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (result: T) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      try { port?.disconnect(); } catch { /* Already disconnected. */ }
      resolve(result);
    };
    try {
      port = chrome.runtime.connectNative(ANTIVIRUS_HOST);
      const requestId = crypto.randomUUID();
      port.onMessage.addListener((value: unknown) => {
        try { finish(protocol.response(value, requestId)); }
        catch { finish(protocol.failure('error', protocol.malformedMessage)); }
      });
      port.onDisconnect.addListener(() => {
        const message = chrome.runtime.lastError?.message;
        finish(protocol.failure('unavailable', message ? `로컬 백신 연결 실패: ${message.slice(0, 300)}` : protocol.disconnectedMessage));
      });
      timer = setTimeout(() => finish(protocol.failure('error', protocol.timeoutMessage)), protocol.timeoutMs);
      port.postMessage({ version: 1, action: protocol.action, requestId, ...payload });
    } catch {
      finish(protocol.failure('unavailable', '로컬 백신 도우미에 연결할 수 없습니다. 설치와 권한을 확인하세요.'));
    }
  });
}
let readinessPending: Promise<AntivirusReadiness> | undefined;
export function probeAntivirus(): Promise<AntivirusReadiness> {
  if (readinessPending) return readinessPending;
  readinessPending = (async () => {
    if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) return { status: 'unavailable' as const, checkedAt: Date.now(), message: '로컬 백신 연결 권한이 없습니다. 백신 도우미 설치 후 ‘로컬 백신 연결’을 눌러 주세요.' };
    return nativeRequest(readinessProtocol);
  })().finally(() => { readinessPending = undefined; });
  return readinessPending;
}
export async function scanFile(path: string): Promise<ScanResult> {
  return navigator.locks.request('my-video-app-antivirus', async () => {
    if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) return { status: 'unavailable', message: '로컬 백신 연결 권한이 없습니다. 백신 도우미 설치 후 ‘로컬 백신 연결’을 눌러 주세요.' };
    return nativeRequest(scanProtocol, { path });
  });
}
