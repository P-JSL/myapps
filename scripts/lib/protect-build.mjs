import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { transform } from 'esbuild';
import assert from 'node:assert/strict';
import { files } from './artifacts.mjs';
import { encryptEngine } from './engine-cipher.mjs';

const runtimeExtension = /\.(?:js|mjs|css|html|png|wasm)$/i;
const engineLogical = 'vendor/ffmpeg/ffmpeg-core.js';
const wasmLogical = 'vendor/ffmpeg/ffmpeg-core.wasm';
const decoderLogical = 'vendor/brotli/decoder.js';
const decoderWasmLogical = 'vendor/brotli/brotli_dec_wasm_bg.wasm';

/** Resolve logical paths in their original context, retaining URL suffixes. */
export function assetReference(value, logical, physical, assetMap) {
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return value;
  const split = value.search(/[?#]/);
  const name = split < 0 ? value : value.slice(0, split);
  const suffix = split < 0 ? '' : value.slice(split);
  if (Object.hasOwn(assetMap, name)) return assetMap[name] + suffix;
  if (name.startsWith('/') && Object.hasOwn(assetMap, name.slice(1))) return '/' + assetMap[name.slice(1)] + suffix;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(logical), name));
  if (!Object.hasOwn(assetMap, target)) return value;
  let relative = path.posix.relative(path.posix.dirname(physical), assetMap[target]);
  if (!relative.startsWith('.')) relative = './' + relative;
  return relative + suffix;
}

/** Parse JavaScript so ordinary prose, regexes and unrelated substrings stay intact. */
export function rewriteJavaScript(source, logical, physical, assetMap) {
  const ast = ts.createSourceFile(logical, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(`Cannot parse build resource ${logical}`);
  const edits = [];
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const replacement = assetReference(node.text, logical, physical, assetMap);
      if (replacement !== node.text) edits.push([node.getStart(ast), node.end, JSON.stringify(replacement)]);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const replacement = assetReference(node.text, logical, physical, assetMap);
      if (replacement !== node.text) {
        const start = ts.isTemplateHead(node) ? '`' : '}';
        const end = ts.isTemplateTail(node) ? '`' : '${';
        const escaped = replacement.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
        edits.push([node.getStart(ast), node.end, start + escaped + end]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let result = source;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + replacement + result.slice(end);
  return result;
}

/** Keep application entry points private while retaining their event listeners. */
export function privateApplicationModule(source, filename = 'application.js') {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(`Cannot parse application entry ${filename}`);
  const edits = [];
  let removedExports = 0;
  for (const statement of ast.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        throw new Error(`Unexpected application re-export in ${filename}`);
      }
      removedExports += statement.exportClause.elements.length;
      edits.push([statement.getStart(ast), statement.end]);
    } else if (ts.isExportAssignment(statement)) {
      throw new Error(`Unexpected application default export in ${filename}`);
    } else {
      for (const modifier of statement.modifiers ?? []) {
        if (modifier.kind === ts.SyntaxKind.DefaultKeyword) throw new Error(`Unexpected application default export in ${filename}`);
        if (modifier.kind === ts.SyntaxKind.ExportKeyword) { removedExports++; edits.push([modifier.getStart(ast), modifier.end]); }
      }
    }
  }
  for (const [start, end] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + source.slice(end);
  return { source, removedExports };
}

function moduleExports(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(`Cannot parse generated module ${filename}`);
  const exported = [];
  for (const statement of ast.statements) {
    if (ts.isExportDeclaration(statement)) {
      assert(!statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause), `Unexpected generated re-export in ${filename}`);
      exported.push(...statement.exportClause.elements.map(element => element.name.text));
    } else if (ts.isExportAssignment(statement)) exported.push('default');
    else if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      exported.push(statement.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name?.text ?? '<declaration>');
    }
  }
  return exported.sort();
}

export function rewriteHTML(source, logical, physical, assetMap) {
  return source.replace(/\b(src|href)\s*=\s*(["'])([^"']*)\2/gi, (_, attribute, quote, value) => `${attribute}=${quote}${assetReference(value, logical, physical, assetMap)}${quote}`);
}

async function removeEmptyDirectories(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const target = path.join(directory, entry.name);
      await removeEmptyDirectories(target);
      if (!(await readdir(target)).length) await rm(target, { recursive: true });
    }
  }
}

/** Production packaging only: no eval, source maps, property mangling or CSP changes. */
export async function protectBuild(directory, { version, formats = {}, sharedModules = [] } = {}) {
  const names = await files(directory);
  const originals = new Map(await Promise.all(names.map(async name => [name, await readFile(path.join(directory, name))])));
  assert(Array.isArray(sharedModules), 'Generated shared modules must be explicitly catalogued');
  const shared = new Map();
  for (const item of sharedModules) {
    assert(item && typeof item.logicalOutput === 'string' && /^shared\/[A-Z0-9]{8}\.js$/.test(item.logicalOutput)
      && !Object.hasOwn(formats, item.logicalOutput) && !shared.has(item.logicalOutput)
      && originals.has(item.logicalOutput), 'Invalid generated shared module declaration');
    assert(Array.isArray(item.exports) && item.exports.length && item.exports.every(name => typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,2}$/.test(name))
      && new Set(item.exports).size === item.exports.length, 'Shared exports must use generated minified names');
    assert.deepEqual(moduleExports(originals.get(item.logicalOutput).toString('utf8'), item.logicalOutput), [...item.exports].sort(), 'Generated shared exports differ from their build metadata');
    shared.set(item.logicalOutput, [...item.exports]);
  }
  const salt = randomBytes(32);
  const opaque = (label, bytes, extension) => 'assets/' + createHash('sha256').update(salt).update(version ?? '').update(label).update(bytes).digest('hex').slice(0, 32) + extension;
  const assetMap = {};
  const images = new Map();
  for (const name of names.filter(name => runtimeExtension.test(name))) {
    const bytes = originals.get(name);
    // PNG bytes have no relative imports or execution context. Retain every
    // logical alias while storing an identical image only once; JS/CSS/HTML
    // and the authenticated engine keep their separate contextual paths.
    const imageKey = /\.png$/i.test(name) ? createHash('sha256').update(bytes).digest('hex') : undefined;
    const previous = imageKey === undefined ? undefined : images.get(imageKey);
    const physical = previous?.bytes.equals(bytes) ? previous.path
      : opaque(name, bytes, name.endsWith('.wasm') ? '.bin' : path.extname(name));
    assetMap[name] = physical;
    if (imageKey !== undefined && !previous) images.set(imageKey, { bytes, path: physical });
  }
  if (!originals.has(engineLogical) || !originals.has(wasmLogical)) throw new Error('Missing pinned media engine');
  const coreModulePath = opaque('engine-implementation', originals.get(engineLogical), '.js');
  const cipherPath = assetMap[wasmLogical];
  const relative = name => './' + path.posix.basename(name);
  assert.equal(originals.has(decoderLogical), originals.has(decoderWasmLogical), 'The pinned Brotli module and Wasm must be supplied together');
  const decoder = originals.has(decoderLogical) ? {
    modulePath: assetMap[decoderLogical], wasmPath: assetMap[decoderWasmLogical],
    wasmBytes: originals.get(decoderWasmLogical).length,
    wasmSha256: createHash('sha256').update(originals.get(decoderWasmLogical)).digest('hex'),
  } : undefined;
  const encrypted = encryptEngine(originals.get(wasmLogical), {
    cipherPath: relative(cipherPath), coreModulePath: relative(coreModulePath),
    ...(decoder ? { decoderModulePath: relative(decoder.modulePath), decoderWasmPath: relative(decoder.wasmPath), decoderWasmBytes: decoder.wasmBytes, decoderWasmSha256: decoder.wasmSha256 } : {}),
  });
  const outputs = new Map();
  let removedApplicationExports = 0;
  const minifyJS = async (source, logical, physical, format = 'esm') => (await transform(rewriteJavaScript(source, logical, physical, assetMap), {
    loader: 'js', format, target: 'chrome120', minify: true, charset: 'utf8', legalComments: 'eof', sourcemap: false,
  })).code;
  for (const [logical, physical] of Object.entries(assetMap)) {
    const bytes = originals.get(logical);
    if (logical === wasmLogical) outputs.set(physical, encrypted.ciphertext);
    else if (logical === engineLogical) {
      outputs.set(coreModulePath, await minifyJS(bytes.toString('utf8'), logical, coreModulePath));
      outputs.set(physical, await minifyJS(encrypted.loaderSource, logical, physical));
    } else if (/\.m?js$/.test(logical)) {
      let source = bytes.toString('utf8');
      if (logical === decoderLogical) assert.deepEqual(moduleExports(source, logical), ['default'], 'Pinned decoder must expose only its default factory');
      else if (!shared.has(logical)) {
        const application = privateApplicationModule(source, logical);
        removedApplicationExports += application.removedExports;
        source = application.source;
      }
      outputs.set(physical, await minifyJS(source, logical, physical, formats[logical] ?? 'esm'));
    }
    else if (logical.endsWith('.html')) outputs.set(physical, rewriteHTML(bytes.toString('utf8'), logical, physical, assetMap));
    else if (logical.endsWith('.css')) {
      const css = bytes.toString('utf8').replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/gi, (_, quote, value) => `url(${quote}${assetReference(value, logical, physical, assetMap)}${quote})`);
      outputs.set(physical, (await transform(css, { loader: 'css', minify: true, legalComments: 'eof', target: 'chrome120' })).code);
    } else outputs.set(physical, bytes);
  }
  const manifest = JSON.parse(originals.get('manifest.json').toString('utf8'));
  const rewriteManifest = value => typeof value === 'string' ? (assetMap[value] ?? value) : Array.isArray(value) ? value.map(rewriteManifest) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteManifest(item)])) : value;
  outputs.set('manifest.json', JSON.stringify(rewriteManifest(manifest), null, 2) + '\n');
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  for (const [name, bytes] of outputs) await writeFile(path.join(directory, name), bytes);
  for (const name of Object.keys(assetMap)) await rm(path.join(directory, name));
  await removeEmptyDirectories(directory);
  return {
    assetMap,
    protection: {
      version: 2, exportSurface: {
        application: 0, removedApplicationSymbols: removedApplicationExports, engineModules: 'default-only',
        sharedInternalModules: shared.size, sharedInternalNamedExports: [...shared.values()].reduce((sum, names) => sum + names.length, 0),
        ...(decoder ? { decoderModule: 'default-only' } : {}),
      }, minified: true, charset: 'utf8', opaqueFilenames: true, sourceMaps: false, dynamicEvaluation: false,
      engine: { ...encrypted.metadataNoKey, cipherPath, coreModulePath, ...(decoder ? { decoder } : {}) },
      limitation: 'Client decryption keys are embedded and recoverable; packaging is not a secrecy boundary. The manifest and license notices remain readable.',
    },
  };
}
