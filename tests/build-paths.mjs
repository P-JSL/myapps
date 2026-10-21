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
  assert.deepEqual(new Set(runtime), new Set([...Object.values(assetMap), ...(engineModule ? [engineModule] : [])]), 'Every shipped runtime asset must be in the production map or the declared engine module');
  const logicalPaths = Object.keys(assetMap);
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
      assert.deepEqual(exported, engine ? ['default'] : [], `Unexpected public production API in ${physical}`);
      const visit = node => {
        if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) rejectLogicalPath(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
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
