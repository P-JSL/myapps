/** Real Chromium HTTP/3 laboratory test. No TLS verification or administrator policy bypass. */
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve('.');
const temporary = await mkdtemp('/tmp/my-video-app-h3-');
const python = process.env.HTTP3_PYTHON ?? 'python3';
const executablePath = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium';
const fixture = await readFile('test-results/fixtures/clip.mp4');
const identity = createHash('sha256').update(fixture).digest('hex');
const outcomes = [];
let server, context;
let serverLog = '';
function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${binary}: ${result.stderr?.slice(-1500)}`);
  return result.stdout;
}
function passed(name) { outcomes.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
const options = { executablePath, headless: true, ignoreHTTPSErrors: false, args: ['--no-sandbox'] };
try {
  command(python, ['-c', 'import aioquic; assert aioquic.__version__ == "1.3.0"']);
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', `${temporary}/ca.key`, '-out', `${temporary}/ca.pem`, '-subj', '/CN=MyVideoAppEphemeralTestCA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${temporary}/server.key`, '-out', `${temporary}/server.csr`, '-subj', '/CN=localhost']);
  await writeFile(`${temporary}/server.ext`, 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  command('openssl', ['x509', '-req', '-in', `${temporary}/server.csr`, '-CA', `${temporary}/ca.pem`, '-CAkey', `${temporary}/ca.key`, '-CAcreateserial', '-days', '1', '-extfile', `${temporary}/server.ext`, '-out', `${temporary}/server.pem`]);
  await build({ entryPoints: ['src/local/network.ts'], outfile: `${temporary}/network.js`, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120' });
  server = spawn(python, ['tests/http3-server.py', temporary, root], { stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', data => { serverLog = (serverLog + data).slice(-3000); });
  let ready;
  for (let i = 0; i < 50; i++) {
    try { ready = JSON.parse(await readFile(`${temporary}/ready.json`, 'utf8')); break; } catch { /* Server starts asynchronously. */ }
    if (server.exitCode !== null) throw new Error(`HTTP/3 fixture server failed: ${serverLog}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready && Number.isInteger(ready.port));
  const origin = `https://127.0.0.1:${ready.port}`;
  const profile = `${temporary}/profile`;
  context = await chromium.launchPersistentContext(profile, options);
  let page = await context.newPage();
  await assert.rejects(page.goto(origin, { timeout: 10_000 }), /ERR_CERT_AUTHORITY_INVALID/);
  passed('Untrusted test CA is rejected by normal Chromium TLS verification');
  page = await context.newPage();
  await page.goto('chrome://certificate-manager/localcerts/usercerts');
  await page.getByRole('heading', { name: 'Trusted Certificates', exact: true }).waitFor();
  await context.close(); context = undefined;
  // Seed ONLY this disposable profile's user trust store. Chrome 154 stores
  // CertificateMetadata { trust { trust_type: TRUSTED (3) } } as 0a020803.
  // Source: chromium/components/server_certificate_database/server_certificate_database.proto.
  // No operating-system or existing user certificate store is modified.
  command(python, ['-c', String.raw`
import sys, sqlite3, ssl, hashlib
from pathlib import Path
root=Path(sys.argv[1])
der=ssl.PEM_cert_to_DER_cert((root/'ca.pem').read_text())
db=sqlite3.connect(root/'profile/Default/ServerCertificate')
columns={row[1] for row in db.execute('pragma table_info(certificates)')}
assert {'sha256hash_hex','der_cert','trust_settings'} <= columns, 'Unsupported Chromium test-profile trust schema'
assert db.execute('select count(*) from certificates').fetchone()[0] == 0
db.execute('insert into certificates values(?,?,?)',(hashlib.sha256(der).hexdigest(),der,bytes.fromhex('0a020803')))
db.commit(); db.close()
`, temporary]);
  // Select the loopback test origin's QUIC route deterministically. This is a
  // test-only switch; the extension itself always uses browser negotiation.
  context = await chromium.launchPersistentContext(profile, { ...options, args: [...options.args, `--origin-to-force-quic-on=127.0.0.1:${ready.port}`] });
  page = await context.newPage();
  const response = await page.goto(origin);
  const security = await response.securityDetails(); assert.equal(security.protocol, 'QUIC');
  const transfers = await page.evaluate(async () => {
    const { fetchBytes } = await import('/network.js');
    const protocols = [];
    const bytes = await fetchBytes(location.origin + '/fixtures/clip.mp4', 256 * 1024 * 1024, new AbortController().signal, undefined, { protocol: p => protocols.push(p) });
    const rangeProtocols = [];
    const range = await fetchBytes(location.origin + '/fixtures/clip.mp4?range=1', 256 * 1024 * 1024, new AbortController().signal, { offset: 2, length: 6 }, { protocol: p => rangeProtocols.push(p) });
    return { protocols, rangeProtocols, range: [...range], sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('') };
  });
  assert.deepEqual(transfers.protocols, ['h3']); assert.equal(transfers.sha256, identity);
  passed('Application fetchBytes downloads the exact MP4 over real HTTP/3 with verified TLS');
  assert.deepEqual(transfers.rangeProtocols, ['h3']); assert.deepEqual(transfers.range, [...fixture.subarray(2, 8)]);
  passed('HTTP/3 byte-range request preserves exactly the requested media bytes');
  await page.evaluate(() => {
    Object.defineProperty(window, 'chrome', { value: { runtime: { id: 'http3-test-double', getURL: name => location.origin + '/' + name, onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) } }, configurable: true });
  });
  const stream = await page.evaluate(async () => {
    const module = await import('/local/offscreen.js'); const id = crypto.randomUUID();
    try {
      const result = await module.prepareLocal(id, location.origin + '/fixtures/parallel/list.m3u8', 'hls');
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle(result.filename)).getFile();
      return { protocols: result.protocols, bytes: [...new Uint8Array(await file.arrayBuffer())] };
    } finally { await module.disposeLocal(id); }
  });
  assert.deepEqual(stream.protocols, ['h3']);
  await writeFile('test-results/http3-hls.mp4', new Uint8Array(stream.bytes));
  const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', 'test-results/http3-hls.mp4']));
  const video = probe.streams.find(stream => stream.codec_type === 'video'); const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264'); assert.equal(Number(video.nb_frames), 12); assert.equal(audio.codec_name, 'aac');
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'test-results/http3-hls.mp4', '-f', 'null', '-']);
  passed('Real HTTP/3 HLS segments and local Wasm remux preserve decodable video and audio');
  const stats = JSON.parse(await readFile(`${temporary}/stats.json`, 'utf8')); assert(stats.h3 >= 6);
  const buildReport = JSON.parse(await readFile('reports/build.json', 'utf8'));
  await writeFile('reports/http3.json', JSON.stringify({ buildSha256: buildReport.buildSha256, browser: context.browser()?.version() ?? 'Chromium', transport: 'h3', tlsVerification: 'enabled; untrusted CA rejected before isolated test-profile trust was configured', mode: 'real loopback HTTP/3; deterministic QUIC origin selected only in test; Chrome runtime API doubled for offscreen processing', profileTrust: 'generated short-lived test CA in disposable Chromium profile; no OS or user profile changes', productionTransport: 'normal Chrome negotiation; no forced transport flags', server: { aioquic: '1.3.0', ...stats }, inputSha256: identity, outcomes }, null, 2) + '\n');
  console.log(`${outcomes.length} real HTTP/3 checks passed.`);
} finally {
  await context?.close();
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  await rm(temporary, { recursive: true, force: true });
}
