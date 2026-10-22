import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { scanBytes } from '../src/security/internal-scan.ts';

const encode = (value: string) => new TextEncoder().encode(value);
function media(size = 1024) {
  const bytes = new Uint8Array(size); const view = new DataView(bytes.buffer);
  view.setUint32(0, 20); bytes.set(encode('ftypisom'), 4); bytes.set(encode('mp42'), 16);
  return bytes;
}
function pe() {
  const bytes = new Uint8Array(1024), view = new DataView(bytes.buffer);
  bytes.set([77, 90]); view.setUint32(60, 128, true); bytes.set([80, 69, 0, 0], 128);
  view.setUint16(132, 0x8664, true); view.setUint16(134, 1, true); view.setUint16(148, 240, true); view.setUint16(150, 2, true);
  view.setUint16(152, 0x20b, true); view.setUint32(208, 4096, true); view.setUint32(212, 512, true);
  view.setUint32(408, 512, true); view.setUint32(412, 512, true); return bytes;
}
function append(first: Uint8Array, second: Uint8Array) { const bytes = new Uint8Array(first.length + second.length); bytes.set(first); bytes.set(second, first.length); return bytes; }
function zip(prefix = 0) {
  // Stored, harmless text entry. No payload execution or compression is involved.
  const bytes = new Uint8Array(109 + prefix), view = new DataView(bytes.buffer), local = prefix, central = prefix + 36, end = prefix + 87;
  if (prefix) bytes.set(media(prefix));
  bytes.set([80, 75, 3, 4], local); view.setUint16(local + 4, 20, true); view.setUint32(local + 18, 1, true); view.setUint32(local + 22, 1, true); view.setUint16(local + 26, 5, true);
  bytes.set(encode('a.txt'), local + 30); bytes[local + 35] = 97;
  bytes.set([80, 75, 1, 2], central); view.setUint16(central + 4, 20, true); view.setUint16(central + 6, 20, true);
  view.setUint32(central + 20, 1, true); view.setUint32(central + 24, 1, true); view.setUint16(central + 28, 5, true); view.setUint32(central + 42, 0, true); bytes.set(encode('a.txt'), central + 46);
  bytes.set([80, 75, 5, 6], end); view.setUint16(end + 8, 1, true); view.setUint16(end + 10, 1, true); view.setUint32(end + 12, 51, true); view.setUint32(end + 16, 36, true); return bytes;
}
function marker() { return encode(['X5O!P%@AP[4', String.fromCharCode(92), 'PZX54(P^)7CC)7}$', 'EICAR', '-STANDARD-ANTIVIRUS-', 'TEST-FILE!$H+H*'].join('')); }

test('full media and explicit raw fragments have bounded no-signals reports without a clean verdict', () => {
  const bytes = media(); bytes.set(encode('MZ, PK, <script>, powershell and eval are ordinary metadata words'), 100);
  for (const value of [bytes, new Uint8Array([26,69,223,163,128]), new Uint8Array([137,80,78,71,13,10,26,10]), encode('RIFF1234WEBP')]) {
    const actual = scanBytes(value); assert.equal(actual.status, 'no-signals'); assert.equal(actual.complete, true); assert.equal(actual.scannedBytes, value.length); assert.deepEqual(actual.findings, []);
    assert(!JSON.stringify(actual).includes('clean'));
  }
  assert.equal(scanBytes(encode('opaque stream fragment'), { expectedMedia: false }).status, 'no-signals');
});

test('unknown, empty, partial and over-limit inputs remain incomplete', () => {
  for (const [bytes, options] of [[encode('ordinary text'), {}], [new Uint8Array(), {}], [media(), { complete: false }]] as const) {
    const actual = scanBytes(bytes, options); assert.equal(actual.status, 'incomplete'); assert.equal(actual.complete, false); assert(actual.findings.some(f => f.severity === 'warning'));
  }
  const large = new Uint8Array(256 * 1024 * 1024 + 1); large.set(media(20));
  const actual = scanBytes(large); assert.equal(actual.status, 'incomplete'); assert.equal(actual.complete, false); assert.equal(actual.scannedBytes, 256 * 1024 * 1024); assert(actual.findings.some(f => f.id === 'analysis-limit'));
});

test('the harmless standard AV marker is detected at arbitrary offsets and labelled as a test', () => {
  const testBytes = marker(); assert.equal(testBytes.length, 68);
  for (const offset of [20, 65_530, 131_070]) {
    const bytes = media(offset + testBytes.length + 4); bytes.set(testBytes, offset);
    const actual = scanBytes(bytes); assert.equal(actual.status, 'suspicious'); const finding = actual.findings.find(f => f.id === 'eicar-test-marker'); assert.equal(finding?.offset, offset); assert.match(finding!.message, /무해.*시험/);
  }
  const prefix = append(media(20), testBytes.subarray(0, testBytes.length - 1)); assert.equal(scanBytes(prefix).status, 'no-signals');
  const partial = scanBytes(append(media(20), testBytes), { complete: false }); assert.equal(partial.status, 'suspicious'); assert.equal(partial.complete, false);
  testBytes.fill(0);
});

test('Windows executable signals require valid PE structures rather than incidental MZ bytes', () => {
  const actual = scanBytes(pe()); assert.equal(actual.status, 'suspicious'); assert(actual.findings.some(f => f.id === 'executable-pe'));
  const embedded = scanBytes(append(media(24), pe())); assert(embedded.findings.some(f => f.id === 'embedded-pe' && f.offset === 24));
  for (const mutate of [
    (bytes: Uint8Array) => bytes[128] = 0,
    (bytes: Uint8Array) => new DataView(bytes.buffer).setUint16(134, 97, true),
    (bytes: Uint8Array) => new DataView(bytes.buffer).setUint16(152, 0, true),
    (bytes: Uint8Array) => new DataView(bytes.buffer).setUint32(412, 999_999, true),
  ]) { const bytes = pe(); mutate(bytes); assert(!scanBytes(append(media(24), bytes)).findings.some(f => f.id === 'embedded-pe')); }
  const randomMZ = media(100_000); for (let i = 20; i < randomMZ.length - 1; i += 2) randomMZ.set([77, 90], i);
  assert.equal(scanBytes(randomMZ).status, 'no-signals');
});

test('top-level ELF, Mach-O, archives, PDF and active text are risk signals only in relevant scopes', () => {
  const elf = new Uint8Array(64), e = new DataView(elf.buffer); elf.set([127,69,76,70,2,1,1]); e.setUint16(16,2,true);e.setUint16(18,62,true);e.setUint32(20,1,true);e.setUint16(52,64,true);
  assert(scanBytes(elf).findings.some(f=>f.id==='executable-elf'));
  const mach = new Uint8Array(40), m = new DataView(mach.buffer);mach.set([207,250,237,254]);m.setUint32(4,0x1000007,true);m.setUint32(12,2,true);m.setUint32(16,1,true);m.setUint32(20,8,true);
  assert(scanBytes(mach).findings.some(f=>f.id==='executable-mach-o'));
  const fat=new Uint8Array(28+mach.length), f=new DataView(fat.buffer);fat.set([202,254,186,190]);f.setUint32(4,1);f.setUint32(8,0x1000007);f.setUint32(16,28);f.setUint32(20,mach.length);fat.set(mach,28);assert(scanBytes(fat).findings.some(value=>value.id==='executable-mach-o'));
  const java=Uint8Array.from([202,254,186,190,0,0,0,52,...new Uint8Array(80)]);assert(!scanBytes(java).findings.some(value=>value.id==='executable-mach-o'));
  for (const bytes of [zip(), encode(' \n%PDF-1.7'), encode('\ufeff <!DOCTYPE html><script>ordinary sample</script>'), encode('#!/bin/sh\n# harmless example')]) assert.equal(scanBytes(bytes).status,'suspicious');
  assert.equal(scanBytes(zip(),{expectedMedia:false}).status,'no-signals');
  assert.equal(scanBytes(encode('<script>'),{expectedMedia:false}).status,'no-signals');
  const utf16=Uint8Array.from([255,254,...Array.from('#requires -version 5').flatMap(value=>[value.charCodeAt(0),0])]);assert(scanBytes(utf16).findings.some(f=>f.id==='non-media-script'));
  assert.equal(scanBytes(Uint8Array.from([255,254,65,0])).status,'incomplete');
});

test('appended ZIP finding requires a complete consistent directory and matching local records', () => {
  const bytes=zip(24);const actual=scanBytes(bytes);assert(actual.findings.some(f=>f.id==='appended-zip'&&f.offset===24));
  assert(!scanBytes(bytes,{complete:false}).findings.some(f=>f.id==='appended-zip'));
  for (const mutate of [
    (value:Uint8Array)=>value[24]=0,
    (value:Uint8Array)=>value[24+30]=98,
    (value:Uint8Array)=>new DataView(value.buffer).setUint32(24+36+20,99999,true),
    (value:Uint8Array)=>new DataView(value.buffer).setUint32(value.length-6,99999,true),
  ]) {const changed=Uint8Array.from(bytes);mutate(changed);assert(!scanBytes(changed).findings.some(f=>f.id==='appended-zip'));}
  const commented=append(bytes,new Uint8Array(64));new DataView(commented.buffer).setUint16(bytes.length-2,64,true);commented.set([80,75,5,6],bytes.length+2);assert(scanBytes(commented).findings.some(f=>f.id==='appended-zip'));
  const incidental=media();incidental.set([80,75,3,4],300);incidental.set([80,75,5,6],500);assert.equal(scanBytes(incidental).status,'no-signals');
});

test('unsupported ZIP directory scopes remain incomplete instead of claiming no signals', () => {
  const generated = spawnSync(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-c',
    'import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n for i in range(1025): z.writestr(str(i),b"x")\nsys.stdout.buffer.write(b.getvalue())'], { maxBuffer: 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const actual = scanBytes(append(media(24), generated.stdout));
  assert.equal(actual.status, 'incomplete'); assert.equal(actual.complete, false);
  assert(actual.findings.some(finding => finding.id === 'analysis-limit'));
  for (const mutate of [
    (bytes: Uint8Array) => new DataView(bytes.buffer).setUint16(bytes.length - 12, 65535, true),
    (bytes: Uint8Array) => new DataView(bytes.buffer).setUint32(bytes.length - 10, 0xffffffff, true),
    (bytes: Uint8Array) => new DataView(bytes.buffer).setUint32(bytes.length - 6, 0xffffffff, true),
    (bytes: Uint8Array) => new DataView(bytes.buffer).setUint16(bytes.length - 18, 1, true),
  ]) { const bytes = zip(24); mutate(bytes); const result = scanBytes(bytes); assert.equal(result.status, 'incomplete'); assert.equal(result.complete, false); }
});

test('structural work and reported findings are bounded without hiding incomplete coverage', () => {
  const executable=pe(), bytes=media(20+executable.length*514);for(let i=0;i<514;i++)bytes.set(executable,20+i*executable.length);
  const result=scanBytes(bytes);assert.equal(result.status,'suspicious');assert.equal(result.complete,false);assert.equal(result.findings.length,16);assert.equal(result.scannedBytes,bytes.length);
  const eocds=media(1024);const view=new DataView(eocds.buffer);for(let offset=400;offset<900;offset+=24){eocds.set([80,75,5,6],offset);view.setUint16(offset+20,eocds.length-offset-22,true);}
  const capped=scanBytes(eocds);assert.equal(capped.status,'incomplete');assert(capped.findings.some(f=>f.id==='analysis-limit'));
});

test('actual generated media fixtures have no builtin signals when present', async () => {
  for(const name of ['clip.mp4','clip.webm','sample.png']) {
    let bytes:Uint8Array;try{bytes=await readFile(new URL(`../test-results/fixtures/${name}`,import.meta.url));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    const actual=scanBytes(bytes);assert.equal(actual.status,'no-signals',`${name}: ${JSON.stringify(actual.findings)}`);
  }
});
