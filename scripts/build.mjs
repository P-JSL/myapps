import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const hash = data => createHash('sha256').update(data).digest('hex');
const productName = 'My Video App';
const originals = JSON.parse(await readFile('reports/original-hashes.json', 'utf8'));
async function files(dir, prefix = '') {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = path.posix.join(prefix, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${rel}`);
    if (entry.isDirectory()) result.push(...await files(path.join(dir, entry.name), rel));
    else result.push(rel);
  }
  return result.sort();
}
assert.deepEqual(await files('vendor/original'), Object.keys(originals.files).sort(), 'Original file membership changed');
for (const [name, expected] of Object.entries(originals.files)) assert.equal(hash(await readFile(`vendor/original/${name}`)), expected, `Original changed: ${name}`);
for (const dest of ['dist', 'dist-compat']) {
  await rm(dest, { recursive: true, force: true });
  await cp('vendor/original', dest, { recursive: true });
  await rm(`${dest}/_metadata`, { recursive: true, force: true });
}
const common = { bundle: true, platform: 'browser', target: 'chrome120', logLevel: 'warning', minify: false, legalComments: 'eof' };
await build({ ...common, entryPoints: ['src/security/service.ts'], format: 'esm', outfile: 'dist/hardening/service.js' });
await build({ ...common, entryPoints: ['src/upscale/worker.ts'], format: 'esm', external: ['../vendor/ffmpeg/ffmpeg-core.js'], outfile: 'dist/hardening/upscale-worker.js' });
await build({ ...common, entryPoints: ['src/ui/app.ts'], format: 'esm', outfile: 'dist/upscale/app.js' });
await mkdir('dist/upscale', { recursive: true });
await cp('src/ui/index.html', 'dist/upscale/index.html');
await cp('src/ui/style.css', 'dist/upscale/style.css');
await mkdir('dist/vendor/ffmpeg', { recursive: true });
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) await cp(`node_modules/@ffmpeg/core/dist/esm/${name}`, `dist/vendor/ffmpeg/${name}`);

const changes = [];
function exactly(source, before, after, description) {
  assert.equal(source.split(before).length - 1, 1, `Patch not uniquely applicable: ${description}`);
  changes.push(description);
  return source.replace(before, after);
}
let service = await readFile('dist/service/main.js', 'utf8');
assert(!service.includes('__vdhAllowMessage') && !service.includes('__vdhOfferUpscale'));
service = exactly(service, 'i.channel==bt.FromInjectedToService&&e(i.msg,n)', '__vdhAllowMessage(i,n,0)&&e(i.msg,n)', 'Validate injected runtime sender, message and privileged operations');
service = exactly(service, 'i.channel==bt.FromContentToService&&await e(i.msg,n)', '__vdhAllowMessage(i,n,1)&&await e(i.msg,n)', 'Require extension-owned pages for UI messages');
service = exactly(service, 'let d=i.newContext(),c=d.evalCode(a.data.code);', 'let d=i.newContext();let __vdhDeadline=performance.now()+2000;d.runtime.setMemoryLimit(134217728);d.runtime.setMaxStackSize(2097152);d.runtime.setInterruptHandler(()=>performance.now()>__vdhDeadline);let c=d.evalCode(a.data.code);', 'Bound QuickJS execution to 2 seconds, 128MiB heap and 2MiB stack');
service = exactly(service, 'if(await(await navigator.storage.getDirectory()).removeEntry(r),wr({name:"revoke_blob_url"', 'if(await __vdhOfferUpscale({internalFilename:r,filename:u,downloadId:c,success:d.isOk(),incognito:!!i||chrome.extension.inIncognitoContext}),await(await navigator.storage.getDirectory()).removeEntry(r),wr({name:"revoke_blob_url"', 'Offer optional upscaling after a successful download, before original cleanup');
service = exactly(service, 'Promise.allSettled(n.map(r=>(console.warn(`main::purging ${r}`),i.removeEntry(r))))', 'Promise.allSettled(n.filter(r=>r!=="vdh-upscale-v1").map(r=>(console.warn(`main::purging ${r}`),i.removeEntry(r))))', 'Preserve the private upscaling queue during original startup cleanup');
service = 'import { allowMessage as __vdhAllowMessage, offerUpscale as __vdhOfferUpscale } from "../hardening/service.js";\n' + service;
await writeFile('dist/service/main.js', service);

const guards = await build({ ...common, entryPoints: ['src/security/validation.ts'], format: 'iife', globalName: '__VDHBridgeSecurity', write: false });
const guardCode = guards.outputFiles[0].text;
const receiverNames = {
  youtube: ['youtube_on_visitor_data'], vimeo: ['vimeo_on_config'], iq: ['iq_on_config'],
  bilibili: ['bilibili_tv_on_config', 'bilibili_com_on_id'], javrank: ['javrank_on_manifest'], xgplayer_crypto: ['91porna_on_config'],
};
const receiverPattern = /let (\w+)=(\w+)=>\{let (\w+)=\2\.data\.msg;\2\.data\.channel==(\w+)\.FromUntrustedInjectedToTrusted&&(\w+)\(\3\)\}/g;
for (const [name, allowed] of Object.entries(receiverNames)) {
  const filename = `dist/injected/${name}.js`;
  const source = await readFile(filename, 'utf8');
  assert(!source.includes('__VDHBridgeSecurity'));
  assert.equal([...source.matchAll(receiverPattern)].length, 1, `Receiver patch unavailable: ${name}`);
  const guarded = source.replace(receiverPattern, (_all, callback, event, message, channels, handler) => `let ${callback}=${event}=>{if(!__VDHBridgeSecurity.safeBridge(${event}.data,${JSON.stringify(allowed)}))return;let ${message}=${event}.data.msg;${event}.data.channel==${channels}.FromUntrustedInjectedToTrusted&&${handler}(${message})}`);
  await writeFile(filename, guardCode + '\n' + guarded);
  changes.push(`Validate incoming MAIN-world messages: ${name}`);
}
for (const name of ['youtube', 'vimeo', 'iq', 'bilibili', 'javrank']) await build({ ...common, entryPoints: [`src/bridges/${name}.ts`], format: 'iife', outfile: `dist/injected/${name}_untrusted.js` });
await build({ ...common, entryPoints: ['src/bridges/taiav.ts'], format: 'iife', outfile: 'dist/injected/taiav.js' });

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
manifest.name = productName;
manifest.short_name = productName;
manifest.action.default_title = productName;
manifest.side_panel.default_title = productName;
manifest.version_name = `${manifest.version} · TypeScript hardening + local upscale`;
manifest.options_ui = { page: 'upscale/index.html', open_in_tab: true };
manifest.content_security_policy.extension_pages = "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'";
// Store auto-update would overwrite this locally modified build. Keep public identity for original runtime compatibility.
delete manifest.update_url;
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
// Rename display text in the installed build while preserving the uploaded engine verbatim.
for (const name of await files('dist')) {
  if (!(name.endsWith('.html') || (name.startsWith('_locales/') && name.endsWith('/messages.json')))) continue;
  const source = await readFile(`dist/${name}`, 'utf8');
  const renamed = source.replaceAll('Video Download Helper', productName).replaceAll('VIDEO DOWNLOAD HELPER', productName.toUpperCase());
  if (source !== renamed) {
    await writeFile(`dist/${name}`, renamed);
    changes.push(`Rename visible product text: ${name}`);
  }
}
assert.equal(manifest.name, productName);
assert.equal(manifest.action.default_title, productName);
assert.equal(manifest.side_panel.default_title, productName);
await mkdir('dist/licenses', { recursive: true });
await cp('THIRD_PARTY_NOTICES.md', 'dist/licenses/THIRD_PARTY_NOTICES.md');
await cp('licenses/ffmpeg-GPL-2.0.txt', 'dist/licenses/ffmpeg-GPL-2.0.txt');
await cp('reports/ANALYSIS.ko.md', 'dist/ANALYSIS.ko.md');

const outputFiles = await files('dist');
const unchanged = [];
const changed = [];
for (const rel of outputFiles) {
  if (!(rel in originals.files)) continue;
  (hash(await readFile(`dist/${rel}`)) === originals.files[rel] ? unchanged : changed).push(rel);
}
const ffmpegWasm = await readFile('dist/vendor/ffmpeg/ffmpeg-core.wasm');
const buildSha256 = hash((await Promise.all(outputFiles.map(async name => `${name}\0${hash(await readFile(`dist/${name}`))}`))).join('\n'));
await writeFile('reports/build.json', JSON.stringify({ buildSha256, originalArchiveSha256: originals.archive_sha256, originalFiles: Object.keys(originals.files).length, unchangedOriginalFiles: unchanged, changedOriginalFiles: changed, removedStoreSignatureMetadata: Object.keys(originals.files).filter(p => p.startsWith('_metadata/')), auditedPatches: changes, ffmpeg: { package: '@ffmpeg/core', version: '0.12.10', wasmSha256: hash(ffmpegWasm), bytes: ffmpegWasm.length }, distFiles: outputFiles.length, distBytes: (await Promise.all(outputFiles.map(p => stat(`dist/${p}`).then(s => s.size)))).reduce((a, b) => a + b, 0) }, null, 2) + '\n');
console.log(`Build complete: ${outputFiles.length} files; ${unchanged.length} original files unchanged; ${changed.length} deliberately changed.`);
