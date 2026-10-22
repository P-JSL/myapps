import test from 'node:test';
import assert from 'node:assert/strict';
import { antivirusEnabled } from '../src/local/security-preferences.ts';
import { cancelAntivirusRequests, probeAntivirus, readinessResponse, scanFile, scanResponse } from '../src/local/antivirus.ts';

test('antivirus preference defaults on and only an explicit boolean can disable it', () => {
  assert.equal(antivirusEnabled(), true);
  assert.equal(antivirusEnabled(true), true);
  assert.equal(antivirusEnabled(false), false);
  for (const value of [null, 0, 1, 'false', 'true', [], {}, { enabled: false }]) assert.throws(() => antivirusEnabled(value));
});

test('a native host cannot forge the local user-disabled policy outcome', () => {
  const value = { version: 1, requestId: 'request', status: 'disabled' };
  assert.throws(() => scanResponse(value, 'request'));
  assert.throws(() => readinessResponse(value, 'request'));
});

test('disabled and cancelled pre-connection requests never contact permissions or native messaging', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  let permissions = 0, connections = 0;
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    permissions: { async contains() { permissions++; return true; } },
    runtime: { connectNative() { connections++; throw Error('Must not connect'); } },
  } });
  try {
    assert.equal((await probeAntivirus(async () => false)).status, 'disabled');
    assert.equal((await scanFile('/test/media.mp4', async () => false)).status, 'disabled');
    let release!: (value: boolean) => void;
    const held = new Promise<boolean>(resolve => { release = resolve; });
    const readiness = probeAntivirus(() => held);
    cancelAntivirusRequests(); release(true);
    assert.equal((await readiness).status, 'disabled');
    const scan = scanFile('/test/media.mp4', async () => true);
    cancelAntivirusRequests();
    assert.equal((await scan).status, 'disabled');
    assert.equal(permissions, 0); assert.equal(connections, 0);
  } finally {
    cancelAntivirusRequests();
    if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome');
  }
});

test('cancellation during a permission lookup wins over late denied or granted replies', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  try {
    for (const granted of [false, true]) {
      let release!: (value: boolean) => void, entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const permission = new Promise<boolean>(resolve => { release = resolve; });
      Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
        permissions: { contains() { entered(); return permission; } },
        runtime: { connectNative() { assert.fail('Cancelled request opened a native connection'); } },
      } });
      const result = probeAntivirus(async () => true);
      await started; cancelAntivirusRequests(); release(granted);
      assert.equal((await result).status, 'disabled');
    }
  } finally {
    cancelAntivirusRequests();
    if (previous) Object.defineProperty(globalThis, 'chrome', previous); else Reflect.deleteProperty(globalThis, 'chrome');
  }
});
