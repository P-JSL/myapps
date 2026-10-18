import { boundedData, record } from '../security/validation.ts';

export const ANTIVIRUS_HOST = 'com.myvideoapp.antivirus';
export type ScanStatus = 'clean' | 'infected' | 'unavailable' | 'error';
export interface ScanResult {
  status: ScanStatus; engine?: string; threats?: string[]; message?: string;
  sha256?: string; size?: number; checkedAt?: number;
}
export interface AntivirusReadiness {
  status: 'ready' | 'unavailable' | 'error'; engine?: string; message?: string;
  products?: string[]; checkedAt: number;
}
export interface FileSecurity extends Omit<ScanResult, 'status'> {
  status: ScanStatus | 'scanning' | 'chrome-warning'; token: string;
  danger?: string; decision?: 'keep' | 'delete';
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
  if (result.status === 'ready' && !result.engine) throw new Error('연결할 백신 엔진을 확인하지 못했습니다.');
  return result;
}
let readinessPending: Promise<AntivirusReadiness> | undefined;
export function probeAntivirus(): Promise<AntivirusReadiness> {
  if (readinessPending) return readinessPending;
  readinessPending = (async () => {
    if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) return { status: 'unavailable' as const, checkedAt: Date.now(), message: '로컬 백신 연결 권한이 없습니다. 백신 도우미 설치 후 ‘로컬 백신 연결’을 눌러 주세요.' };
    return new Promise<AntivirusReadiness>(resolve => {
      let port: chrome.runtime.Port | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (result: AntivirusReadiness) => {
        if (settled) return; settled = true;
        if (timer) clearTimeout(timer);
        try { port?.disconnect(); } catch { /* Already disconnected. */ }
        resolve(result);
      };
      try {
        port = chrome.runtime.connectNative(ANTIVIRUS_HOST);
        const requestId = crypto.randomUUID();
        port.onMessage.addListener((value: unknown) => {
          try { finish(readinessResponse(value, requestId)); }
          catch { finish({ status: 'error', checkedAt: Date.now(), message: '백신 도우미의 상태 응답이 올바르지 않습니다. 최신 도우미로 다시 설치하세요.' }); }
        });
        port.onDisconnect.addListener(() => {
          const message = chrome.runtime.lastError?.message;
          finish({ status: 'unavailable', checkedAt: Date.now(), message: message ? `로컬 백신 연결 실패: ${message.slice(0, 300)}` : '로컬 백신 도우미 연결이 종료됐습니다. 설치 상태를 확인하세요.' });
        });
        timer = setTimeout(() => finish({ status: 'error', checkedAt: Date.now(), message: '백신 연결 상태 확인이 제한 시간을 초과했습니다.' }), 60_000);
        port.postMessage({ version: 1, action: 'status', requestId });
      } catch {
        finish({ status: 'unavailable', checkedAt: Date.now(), message: '로컬 백신 도우미에 연결할 수 없습니다. 설치와 권한을 확인하세요.' });
      }
    });
  })().finally(() => { readinessPending = undefined; });
  return readinessPending;
}
export async function scanFile(path: string): Promise<ScanResult> {
  return navigator.locks.request('my-video-app-antivirus', async () => {
    if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) return { status: 'unavailable', message: '로컬 백신 연결 권한이 없습니다. 백신 도우미 설치 후 ‘로컬 백신 연결’을 눌러 주세요.' };
    return new Promise<ScanResult>(resolve => {
      let port: chrome.runtime.Port | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (result: ScanResult) => {
        if (settled) return; settled = true;
        if (timer) clearTimeout(timer);
        try { port?.disconnect(); } catch { /* Already disconnected. */ }
        resolve(result);
      };
      try {
        port = chrome.runtime.connectNative(ANTIVIRUS_HOST);
        const requestId = crypto.randomUUID();
        port.onMessage.addListener((value: unknown) => {
          try { finish(scanResponse(value, requestId)); }
          catch { finish({ status: 'error', message: '백신 응답이 올바르지 않아 검사 완료로 처리하지 않았습니다.' }); }
        });
        port.onDisconnect.addListener(() => {
          const message = chrome.runtime.lastError?.message;
          finish({ status: 'unavailable', message: message ? `로컬 백신 연결 실패: ${message.slice(0, 300)}` : '로컬 백신 도우미가 연결을 종료했습니다. 설치 상태를 확인하세요.' });
        });
        timer = setTimeout(() => finish({ status: 'error', message: '백신 검사가 제한 시간을 초과했습니다. 검사되지 않은 파일입니다.' }), 240_000);
        port.postMessage({ version: 1, action: 'scan', requestId, path });
      } catch {
        finish({ status: 'unavailable', message: '로컬 백신 도우미에 연결할 수 없습니다. 설치와 권한을 확인하세요.' });
      }
    });
  });
}
