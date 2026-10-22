import assert from 'node:assert/strict';
import test from 'node:test';
import { internalScanPresentation } from '../src/local/labels.ts';

const result = (status = 'no-signals', complete = true) => ({ version: 1, engine: 'builtin-static-v1', status, complete, scannedBytes: 1024, findings: [] as Array<{ id: string; severity: string; message: string }> });

test('internal scan labels never promote missing, partial or quiet evidence to an antivirus clean verdict', () => {
  const absent = internalScanPresentation(undefined);
  assert.equal(absent.label, '내부 위험 검사: 기록 없음');
  for (const value of [null, {}, { ...result(), engine: 'unrecognized' }, { ...result(), scannedBytes: -1 }, { ...result(), scannedBytes: Infinity }, { ...result(), status: { toString() { throw new Error('Must not coerce data'); } } }]) {
    assert.equal(internalScanPresentation(value).label, '내부 위험 검사: 결과 확인 필요');
  }
  for (const value of [result('incomplete', false)]) {
    assert.equal(internalScanPresentation(value).label, '내부 위험 검사: 검사 범위 제한');
  }
  assert.equal(internalScanPresentation(result('no-signals', false)).label, '내부 위험 검사: 결과 확인 필요');
  const contradictory = result(); contradictory.findings = [{ id: 'analysis-limit', severity: 'warning', message: '부분 검사' }];
  assert.equal(internalScanPresentation(contradictory).label, '내부 위험 검사: 결과 확인 필요');
  for (const id of ['analysis-limit', 'empty-input', 'unsupported-format', 'partial-input']) {
    const limited = result('incomplete', false); limited.findings = [{ id, severity: 'warning', message: '검사 범위 안내' }];
    const presentation = internalScanPresentation(limited);
    assert.equal(presentation.label, '내부 위험 검사: 검사 범위 제한');
    assert.equal(presentation.tone, 'warning');
    assert.deepEqual(presentation.findings, ['검사 범위 안내']);
    assert.doesNotMatch(presentation.label, /위험 신호/);
    assert.equal(internalScanPresentation({ ...limited, status: 'suspicious' }).label, '내부 위험 검사: 결과 확인 필요');
    assert.equal(internalScanPresentation({ ...limited, complete: true }).label, '내부 위험 검사: 결과 확인 필요');
    assert.equal(internalScanPresentation({ ...limited, findings: [{ id, severity: 'high', message: '모순된 위험도' }] }).label, '내부 위험 검사: 결과 확인 필요');
  }
  const quiet = internalScanPresentation(result());
  assert.equal(quiet.label, '내부 위험 검사: 신호 없음');
  assert.match(quiet.explanation, /보장하지 않습니다/);
  assert(!quiet.label.includes('안전'));
});

test('risk presentation retains warnings in partial evidence and treats finding text as bounded literal content', () => {
  const scan = result('suspicious', false);
  scan.findings = [{ id: 'test-signal', severity: 'warning', message: '<img src=x onerror=alert(1)>\u202e' }];
  const presentation = internalScanPresentation(scan);
  assert.equal(presentation.tone, 'danger');
  assert.equal(presentation.label, '내부 위험 검사: 위험 신호');
  assert.match(presentation.scope!, /일부 범위/);
  assert.deepEqual(presentation.findings, ['<img src=x onerror=alert(1)>']);
  assert.match(presentation.explanation, /확정 판정은 아닙니다/);
  const mixed = internalScanPresentation({ ...scan, findings: [...scan.findings, { id: 'analysis-limit', severity: 'warning', message: '부분 검사' }] });
  assert.equal(mixed.tone, 'danger');
  assert.deepEqual(mixed.findings, ['<img src=x onerror=alert(1)>', '부분 검사']);
  const malformedLimited = { ...scan, status: 'incomplete' };
  assert.equal(internalScanPresentation(malformedLimited).label, '내부 위험 검사: 결과 확인 필요');
  const long = result('suspicious'); long.findings = [{ id: 'long', severity: 'high', message: 'x'.repeat(500) }];
  assert.equal(internalScanPresentation(long).findings[0]!.length, 240);
});

test('malformed and oversized finding records do not become quiet scanner evidence', () => {
  const scan = result();
  scan.findings = Array.from({ length: 17 }, () => ({ id: 'signal', severity: 'warning', message: 'signal' }));
  assert.equal(internalScanPresentation(scan).tone, 'warning');
  for (const finding of [null, { id: '', severity: 'high', message: 'signal' }, { id: 'a', severity: 'unknown', message: 'signal' }, { id: 'a', severity: { toString() { throw new Error('Must not coerce data'); } }, message: 'signal' }, { id: 'a', severity: 'high', message: 'x'.repeat(501) }]) {
    assert.equal(internalScanPresentation({ ...result(), findings: [finding] }).label, '내부 위험 검사: 결과 확인 필요');
  }
});
