import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { transform } from 'esbuild';
import { files } from './artifacts.mjs';
import { encryptEngine } from './engine-cipher.mjs';

const runtimeExtension = /\.(?:js|mjs|css|html|png|wasm)$/i;
const engineLogical = 'vendor/ffmpeg/ffmpeg-core.js';
const wasmLogical = 'vendor/ffmpeg/ffmpeg-core.wasm';

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
export async function protectBuild(directory, { version, formats = {} } = {}) {
  const names = await files(directory);
  const originals = new Map(await Promise.all(names.map(async name => [name, await readFile(path.join(directory, name))])));
  const salt = randomBytes(32);
  const opaque = (label, bytes, extension) => 'assets/' + createHash('sha256').update(salt).update(version ?? '').update(label).update(bytes).digest('hex').slice(0, 32) + extension;
  const assetMap = Object.fromEntries(names.filter(name => runtimeExtension.test(name)).map(name => [name, opaque(name, originals.get(name), name.endsWith('.wasm') ? '.bin' : path.extname(name))]));
  if (!originals.has(engineLogical) || !originals.has(wasmLogical)) throw new Error('Missing pinned media engine');
  const coreModulePath = opaque('engine-implementation', originals.get(engineLogical), '.js');
  const cipherPath = assetMap[wasmLogical];
  const relative = name => './' + path.posix.basename(name);
  const encrypted = encryptEngine(originals.get(wasmLogical), { cipherPath: relative(cipherPath), coreModulePath: relative(coreModulePath) });
  const outputs = new Map();
  let removedApplicationExports = 0;
  const minifyJS = async (source, logical, physical, format = 'esm') => (await transform(rewriteJavaScript(source, logical, physical, assetMap), {
    loader: 'js', format, target: 'chrome120', minify: true, legalComments: 'eof', sourcemap: false,
  })).code;
  for (const [logical, physical] of Object.entries(assetMap)) {
    const bytes = originals.get(logical);
    if (logical === wasmLogical) outputs.set(physical, encrypted.ciphertext);
    else if (logical === engineLogical) {
      outputs.set(coreModulePath, await minifyJS(bytes.toString('utf8'), logical, coreModulePath));
      outputs.set(physical, await minifyJS(encrypted.loaderSource, logical, physical));
    } else if (/\.m?js$/.test(logical)) {
      const application = privateApplicationModule(bytes.toString('utf8'), logical);
      removedApplicationExports += application.removedExports;
      outputs.set(physical, await minifyJS(application.source, logical, physical, formats[logical] ?? 'esm'));
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
      version: 2, exportSurface: { application: 0, removedApplicationSymbols: removedApplicationExports, engineModules: 'default-only' }, minified: true, opaqueFilenames: true, sourceMaps: false, dynamicEvaluation: false,
      engine: { ...encrypted.metadataNoKey, cipherPath, coreModulePath },
      limitation: 'Client decryption keys are embedded and recoverable; packaging is not a secrecy boundary. The manifest and license notices remain readable.',
    },
  };
}
