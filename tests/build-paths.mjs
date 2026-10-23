/** Resolve the production artifact map without rebuilding source modules. */
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export async function loadBuildPaths(root = '.') {
  const buildInfo = JSON.parse(await readFile(path.join(root, 'reports/build.json'), 'utf8'));
  const assetMap = buildInfo.assetMap;
  assert(assetMap && typeof assetMap === 'object' && Object.keys(assetMap).length, 'Build the protected production artifacts before running browser tests');
  const resolve = logical => {
    const name = logical.replace(/^\/+/, '');
    const split = name.search(/[?#]/);
    const pathname = split < 0 ? name : name.slice(0, split);
    const suffix = split < 0 ? '' : name.slice(split);
    return (assetMap[pathname] ?? pathname) + suffix;
  };
  return { buildInfo, assetMap, resolve, url: (origin, logical) => new URL(resolve(logical), origin + '/').href };
}

export async function assertProtectedBuild(root, buildPaths) {
  const { assetMap } = buildPaths;
  const dist = path.join(root, 'dist');
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name + '/');
      else files.push(name);
    }
  }
  await visit(dist);
  assert(files.every(name => !name.endsWith('.map')), 'Source maps must not ship');
  const runtime = files.filter(name => /\.(?:js|mjs|html|css|wasm|bin|png)$/i.test(name));
  assert(runtime.length > 0);
  const opaqueAsset = /^assets\/(?:[a-f0-9]{24}|[a-f0-9]{32})\.[a-z0-9]+$/;
  assert(runtime.every(name => opaqueAsset.test(name)), 'All runtime assets must have flattened opaque names');
  for (const [logical, physical] of Object.entries(assetMap)) {
    assert.match(physical, opaqueAsset, logical);
    assert.notEqual(logical, physical);
    assert(files.includes(physical), `Missing mapped production asset ${logical}`);
    await assert.rejects(stat(path.join(dist, logical)), { code: 'ENOENT' }, `Logical runtime path leaked into dist: ${logical}`);
  }
  const engineModule = buildPaths.buildInfo.protection?.engine?.coreModulePath;
  if (engineModule) { assert.match(engineModule, opaqueAsset); assert(engineModule.endsWith('.js')); }
  const decoderModule = buildPaths.buildInfo.protection?.engine?.decoder?.modulePath;
  if (decoderModule) { assert.match(decoderModule, opaqueAsset); assert(decoderModule.endsWith('.js')); }
  assert.deepEqual(new Set(runtime), new Set([...Object.values(assetMap), ...(engineModule ? [engineModule] : [])]), 'Every shipped runtime asset must be in the production map or the declared engine module');
  const logicalPaths = Object.keys(assetMap);
  const sharedChunks = buildPaths.buildInfo.sharedChunks ?? [];
  const shared = new Map();
  for (const chunk of sharedChunks) {
    assert(/^shared\/[A-Z0-9]{8}\.js$/.test(chunk.logicalOutput) && assetMap[chunk.logicalOutput] === chunk.output
      && !shared.has(chunk.output), 'Shared module must match its explicitly generated build record');
    assert(Array.isArray(chunk.exports) && chunk.exports.length && new Set(chunk.exports).size === chunk.exports.length
      && chunk.exports.every(name => typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,2}$/.test(name)), 'Shared module exports must use generated minified names');
    shared.set(chunk.output, chunk);
  }
  assert.deepEqual(new Set(logicalPaths.filter(name => name.startsWith('shared/'))), new Set(sharedChunks.map(chunk => chunk.logicalOutput)), 'Uncatalogued shared module');
  assert.equal(buildPaths.buildInfo.protection?.exportSurface?.sharedInternalModules ?? 0, shared.size);
  assert.equal(buildPaths.buildInfo.protection?.exportSurface?.sharedInternalNamedExports ?? 0, sharedChunks.reduce((sum, chunk) => sum + chunk.exports.length, 0));
  const applicationModules = [...(buildPaths.buildInfo.entries ?? []), ...sharedChunks];
  const generatedImports = new Map(applicationModules.map(item => [item.output, item.imports]));
  for (const item of applicationModules) assert(assetMap[item.logicalOutput] === item.output, 'Generated module must retain its logical mapping');
  for (const physical of runtime.filter(name => /\.(?:js|mjs|html|css)$/.test(name))) {
    const text = await readFile(path.join(dist, physical), 'utf8');
    const rejectLogicalPath = literal => {
      for (const logical of logicalPaths) assert(!literal.includes(logical), `Legacy runtime reference ${logical} in ${physical}`);
    };
    if (/\.(?:js|mjs)$/.test(physical)) {
      // Parse literals so escaped characters and template prefixes are checked
      // as runtime strings rather than relying on a source-text substring scan.
      const source = ts.createSourceFile(physical, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      assert.equal(source.parseDiagnostics.length, 0, `Invalid production module ${physical}`);
      const exported = [];
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement)) {
          assert(!statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause), `Unexpected production re-export in ${physical}`);
          exported.push(...statement.exportClause.elements.map(element => element.name.text));
        } else if (ts.isExportAssignment(statement)) exported.push('default');
        else if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) exported.push(statement.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name?.text ?? '<declaration>');
      }
      const engine = physical === assetMap['vendor/ffmpeg/ffmpeg-core.js'] || physical === engineModule;
      const decoder = physical === decoderModule;
      assert.deepEqual(exported.sort(), engine || decoder ? ['default'] : [...(shared.get(physical)?.exports ?? [])].sort(), `Unexpected public production API in ${physical}`);
      const actualImports = [];
      const inspectImport = reference => {
        assert(typeof reference === 'string' && /^\.{1,2}\//.test(reference) && !/[\\?#]/.test(reference), `Nonlocal production module import in ${physical}`);
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(physical), reference));
        assert(target.startsWith('assets/') && runtime.includes(target) && /\.m?js$/.test(target), `Missing or escaping production module import ${reference} in ${physical}`);
        actualImports.push(target);
      };
      const visit = node => {
        if (ts.isImportDeclaration(node)) {
          assert(ts.isStringLiteralLike(node.moduleSpecifier), `Nonliteral production module import in ${physical}`);
          inspectImport(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          assert(node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]), `Nonliteral dynamic production module import in ${physical}`);
          inspectImport(node.arguments[0].text);
        }
        if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) rejectLogicalPath(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (generatedImports.has(physical)) {
        const declared = generatedImports.get(physical);
        assert(Array.isArray(declared) && declared.every(item => item && typeof item.path === 'string' && assetMap[item.logicalPath] === item.path
          && ['import-statement', 'dynamic-import'].includes(item.kind) && typeof item.external === 'boolean'), `Invalid generated import graph for ${physical}`);
        assert.deepEqual(actualImports.sort(), declared.map(item => item.path).sort(), `Generated import graph differs from shipped imports in ${physical}`);
      }
    } else {
      const logicalFile = logicalPaths.find(logical => assetMap[logical] === physical);
      const references = physical.endsWith('.html') ? text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi) : text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi);
      for (const [, reference] of references) {
        rejectLogicalPath(reference);
        if (logicalFile && !/^(?:[a-z]+:|#|\/\/)/i.test(reference)) {
          const pathname = reference.split(/[?#]/, 1)[0];
          const resolved = pathname.startsWith('/') ? pathname.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(logicalFile), pathname));
          assert(!Object.hasOwn(assetMap, resolved), `Legacy relative runtime reference ${reference} in ${physical}`);
        }
      }
    }
  }
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  const original = JSON.parse(await readFile(path.join(root, 'src/local/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_security_policy, original.content_security_policy, 'Build protection must preserve CSP');
  assert.deepEqual(manifest.permissions, original.permissions, 'Build protection must preserve permissions');
  assert.deepEqual(manifest.optional_permissions, original.optional_permissions);
  assert.deepEqual(manifest.host_permissions, original.host_permissions);
  const sourceHTML = await readFile(path.join(root, 'src/ui/index.html'), 'utf8');
  const builtHTML = await readFile(path.join(dist, buildPaths.resolve('upscale/index.html')), 'utf8');
  const policy = text => text.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?\s*>/i)?.[1];
  assert(policy(sourceHTML));
  assert.equal(policy(builtHTML), policy(sourceHTML), 'Protected media tools must retain their HTML CSP');
  return manifest;
}
