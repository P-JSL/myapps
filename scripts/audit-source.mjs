import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as project from './project.mjs';
import { files, sourceIdentity } from './lib/artifacts.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
// This one build-bundled vendor wrapper is deliberately outside the application
// TypeScript graph. Keep its package permission narrow and its lock identity
// explicit rather than accepting arbitrary bare imports in runtime sources.
const brotliVendor = Object.freeze({
  input: 'scripts/lib/browser-brotli.mjs', output: 'vendor/brotli/decoder.js',
  package: 'brotli-dec-wasm', specifier: 'brotli-dec-wasm/web', version: '2.3.2',
  resolved: 'https://registry.npmjs.org/brotli-dec-wasm/-/brotli-dec-wasm-2.3.2.tgz',
  integrity: 'sha512-5H+k8eVLIJY6B4olN2HP9QzJAxcplf0jV7mWnkpxvOSeUE9Npg3dQ2pgLn30a9MUFHNro1iSmtdu6VNdlb+TIw==',
  wasmInput: 'node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm_bg.wasm',
  wasmOutput: 'vendor/brotli/brotli_dec_wasm_bg.wasm',
});
const isDeclaration = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword);
const typeOnlyBindings = bindings => bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly);
const typeOnlyImport = node => Boolean(node.importClause && (node.importClause.isTypeOnly || (!node.importClause.name && typeOnlyBindings(node.importClause.namedBindings))));
const typeOnlyExport = node => node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause)
  && (node.exportClause.elements.length > 0 || !node.moduleSpecifier) && node.exportClause.elements.every(item => item.isTypeOnly));

function runtimeStatement(node) {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEmptyStatement(node) || isDeclaration(node)) return false;
  if (ts.isImportDeclaration(node)) return !typeOnlyImport(node);
  if (ts.isExportDeclaration(node)) return !typeOnlyExport(node);
  if (ts.isImportEqualsDeclaration(node)) return !node.isTypeOnly;
  if (ts.isModuleDeclaration(node)) return Boolean(node.body && (ts.isModuleBlock(node.body) ? node.body.statements.some(runtimeStatement) : runtimeStatement(node.body)));
  return true;
}

function relativeName(value, description) {
  assert.equal(typeof value, 'string', `${description} must be a string`);
  assert(value && !value.includes('\\') && !path.posix.isAbsolute(value) && !/^[a-z]+:/i.test(value), `${description} must be relative: ${value}`);
  const normalized = path.posix.normalize(value);
  assert(normalized !== '..' && !normalized.startsWith('../'), `${description} escapes its root: ${value}`);
  return normalized.replace(/^\.\//, '');
}

function localName(from, specifier) {
  assert(specifier.startsWith('.'), `Uncatalogued package import in ${from}: ${specifier}`);
  return relativeName(path.posix.join(path.posix.dirname(from), specifier), `Import in ${from}`);
}

function cyclesIn(graph) {
  let sequence = 0;
  const indices = new Map(), lows = new Map(), stack = [], active = new Set(), cycles = [];
  function visit(name) {
    indices.set(name, sequence); lows.set(name, sequence++); stack.push(name); active.add(name);
    for (const next of graph.get(name) ?? []) {
      if (!indices.has(next)) { visit(next); lows.set(name, Math.min(lows.get(name), lows.get(next))); }
      else if (active.has(next)) lows.set(name, Math.min(lows.get(name), indices.get(next)));
    }
    if (lows.get(name) !== indices.get(name)) return;
    const component = [];
    let next;
    do { next = stack.pop(); active.delete(next); component.push(next); } while (next !== name);
    if (component.length > 1 || graph.get(name)?.has(name)) cycles.push(component.sort());
  }
  for (const name of [...graph.keys()].sort()) if (!indices.has(name)) visit(name);
  return cycles.sort((a, b) => a[0].localeCompare(b[0]));
}

function constantInitializer(identifier) {
  // Resolve only lexical const declarations; never evaluate application code.
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text)) return undefined;
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text) {
          return statement.declarationList.flags & ts.NodeFlags.Const ? declaration.initializer : undefined;
        }
      }
    }
  }
}

function stringValues(node, seen = new Set()) {
  if (!node || seen.has(node)) return [{ text: '', complete: false }];
  const nextSeen = new Set(seen).add(node);
  if (ts.isStringLiteralLike(node)) return [{ text: node.text, complete: true }];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return stringValues(node.expression, nextSeen);
  if (ts.isIdentifier(node)) return stringValues(constantInitializer(node), nextSeen);
  if (ts.isConditionalExpression(node)) return [...stringValues(node.whenTrue, nextSeen), ...stringValues(node.whenFalse, nextSeen)];
  const append = (left, right) => left.flatMap(a => a.complete ? right.map(b => ({ text: a.text + b.text, complete: b.complete })) : [a]);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return append(stringValues(node.left, nextSeen), stringValues(node.right, nextSeen));
  if (ts.isTemplateExpression(node)) {
    let values = [{ text: node.head.text, complete: true }];
    for (const span of node.templateSpans) values = append(append(values, stringValues(span.expression, nextSeen)), [{ text: span.literal.text, complete: true }]);
    return values;
  }
  return [{ text: '', complete: false }];
}

function resourceNames(node, description) {
  return [...new Set(stringValues(node).map(value => {
    const suffix = value.text.search(/[?#]/);
    assert(value.complete || suffix >= 0, `Non-static runtime resource in ${description}`);
    return suffix < 0 ? value.text : value.text.slice(0, suffix);
  }))];
}

const isGetURL = node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
  && node.expression.name.text === 'getURL' && ts.isPropertyAccessExpression(node.expression.expression)
  && node.expression.expression.name.text === 'runtime' && ts.isIdentifier(node.expression.expression.expression)
  && ['chrome', 'browser'].includes(node.expression.expression.expression.text);

/** Parse the source graph and resource references without importing browser modules. */
export async function auditSource(root = repository, catalog = project) {
  root = path.resolve(root);
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  assert(!config.error, 'Cannot read tsconfig.json');
  const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsedConfig.options.noUnusedLocals, true, 'tsconfig noUnusedLocals must be true');
  assert.equal(parsedConfig.options.noUnusedParameters, true, 'tsconfig noUnusedParameters must be true');

  const entries = catalog.browserEntries;
  assert(Array.isArray(entries) && entries.length > 0, 'browserEntries must declare the runtime roots');
  const outputs = new Set(), copied = [];
  function output(name) {
    const normalized = relativeName(name, 'Build output');
    assert(!outputs.has(normalized), `Duplicate build output: ${normalized}`);
    outputs.add(normalized);
    return normalized;
  }
  for (const entry of entries) {
    relativeName(entry.input, 'Browser entry');
    output(entry.output);
    assert(['esm', 'iife'].includes(entry.format), `Invalid browser format: ${entry.input}`);
  }
  const vendorEntries = catalog.vendorEntries ?? [];
  assert(Array.isArray(vendorEntries), 'vendorEntries must be an array');
  const vendorRecords = [];
  for (const entry of vendorEntries) {
    const input = relativeName(entry.input, 'Vendor entry');
    const destination = output(entry.output);
    assert(input === brotliVendor.input && destination === brotliVendor.output && entry.format === 'esm',
      `Uncatalogued vendor wrapper: ${input}`);
    assert.equal(packageJson.devDependencies?.[brotliVendor.package], brotliVendor.version, 'Vendor dependency must use its exact approved version');
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    const dependency = lock.packages?.[`node_modules/${brotliVendor.package}`];
    assert(dependency?.version === brotliVendor.version && dependency?.integrity === brotliVendor.integrity
      && dependency?.resolved === brotliVendor.resolved, 'Vendor dependency lock identity does not match the approved package');
    const source = ts.createSourceFile(input, await readFile(path.join(root, input), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(source.parseDiagnostics.length, 0, `Invalid vendor wrapper syntax: ${input}`);
    const imports = [], exported = [];
    function inspectVendor(node) {
      if (ts.isImportDeclaration(node)) {
        assert(ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === brotliVendor.specifier,
          `Unapproved vendor import in ${input}`);
        imports.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        assert.fail(`Dynamic vendor imports are unsupported: ${input}`);
      }
      ts.forEachChild(node, inspectVendor);
    }
    inspectVendor(source);
    assert.deepEqual(imports, [brotliVendor.specifier], 'Vendor wrapper must statically import only its approved dependency');
    for (const statement of source.statements) {
      if (ts.isExportAssignment(statement)) {
        assert(!statement.isExportEquals, 'CommonJS vendor exports are unsupported'); exported.push('default');
      } else if (ts.isExportDeclaration(statement)) assert.fail(`Vendor re-exports are unsupported: ${input}`);
      else if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        assert(statement.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword), 'Vendor wrapper may export only default');
        exported.push('default');
      }
    }
    assert.deepEqual(exported, ['default'], 'Vendor wrapper must have exactly its required default export');
    vendorRecords.push({ input, output: destination, format: entry.format,
      dependency: { package: brotliVendor.package, specifier: brotliVendor.specifier, version: dependency.version, integrity: dependency.integrity } });
  }
  if (packageJson.devDependencies?.[brotliVendor.package] !== undefined) {
    assert.equal(vendorRecords.length, 1, 'Pinned Brotli dependency requires its one audited vendor wrapper');
  }
  for (const item of catalog.staticFiles ?? []) copied.push({ input: relativeName(item.input, 'Static input'), output: output(item.output) });
  for (const item of catalog.directoryCopies ?? []) {
    const input = relativeName(item.input, 'Directory input');
    const destination = relativeName(item.output, 'Directory output');
    for (const name of await files(path.join(root, input))) copied.push({ input: path.posix.join(input, name), output: output(path.posix.join(destination, name)) });
  }
  if (vendorRecords.length) assert(copied.some(item => item.input === brotliVendor.wasmInput && item.output === brotliVendor.wasmOutput),
    'Pinned vendor decoder Wasm must be included in the static build catalog');

  const names = (await files(path.join(root, 'src'), { skipDirectories: ['__pycache__'] }))
    .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts')).map(name => `src/${name}`);
  const sources = new Map();
  for (const name of names) {
    const source = ts.createSourceFile(name, await readFile(path.join(root, name), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.equal(source.parseDiagnostics.length, 0, `Invalid TypeScript syntax: ${name}`);
    sources.set(name, source);
  }
  const runtime = new Set([...sources].filter(([, source]) => source.statements.some(runtimeStatement)).map(([name]) => name));
  const graph = new Map([...runtime].map(name => [name, new Set()]));
  const external = new Map(), resources = new Map(), workers = new Map();
  function resolveImport(from, specifier) {
    const candidate = localName(from, specifier);
    const options = [candidate, candidate.replace(/\.[cm]?js$/, '.ts'), `${candidate}.ts`, `${candidate}/index.ts`];
    return options.find(name => sources.has(name));
  }
  for (const [name, source] of sources) {
    if (!runtime.has(name)) continue;
    const imports = [], urls = [], workerNodes = [];
    function visit(node) {
      if (ts.isImportDeclaration(node) && !typeOnlyImport(node)) imports.push(node.moduleSpecifier);
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !typeOnlyExport(node)) imports.push(node.moduleSpecifier);
      else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) imports.push(node.moduleReference.expression);
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) imports.push(node.arguments[0]);
      else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') assert.fail(`CommonJS runtime import is unsupported: ${name}`);
      if (isGetURL(node)) urls.push(node.arguments[0]);
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['Worker', 'SharedWorker'].includes(node.expression.text)) workerNodes.push(node.arguments?.[0]);
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifierNode of imports) {
      assert(specifierNode && ts.isStringLiteralLike(specifierNode), `Non-static runtime import in ${name}`);
      const specifier = specifierNode.text;
      const resolved = resolveImport(name, specifier);
      if (resolved) { if (runtime.has(resolved)) graph.get(name).add(resolved); }
      else { if (!external.has(name)) external.set(name, []); external.get(name).push(specifier); }
    }
    resources.set(name, urls); workers.set(name, workerNodes);
  }

  const owners = new Map(), reachable = new Set();
  for (const entry of entries) {
    const input = relativeName(entry.input, 'Browser entry');
    assert(runtime.has(input), `Browser entry is missing or has no runtime code: ${input}`);
    const seen = new Set();
    function walk(name) {
      if (seen.has(name)) return;
      seen.add(name); reachable.add(name);
      if (!owners.has(name)) owners.set(name, []);
      owners.get(name).push(entry);
      for (const specifier of external.get(name) ?? []) {
        assert(specifier.startsWith('.') && /(?:^|\/)vendor\/ffmpeg\/ffmpeg-core\.js$/.test(specifier)
          && entry.external?.includes(specifier), `Uncatalogued runtime import for ${entry.input} in ${name}: ${specifier}`);
        const destination = localName(entry.output, specifier);
        assert(outputs.has(destination), `External runtime resource missing from build catalog: ${destination}`);
      }
      for (const next of graph.get(name)) walk(next);
    }
    walk(input);
  }
  const orphanModules = [...runtime].filter(name => !reachable.has(name)).sort();
  const runtimeCycles = cyclesIn(graph);
  assert.equal(orphanModules.length, 0, `Orphan runtime modules: ${orphanModules.join(', ')}`);
  assert.equal(runtimeCycles.length, 0, `Runtime import cycles: ${runtimeCycles.map(cycle => cycle.join(' -> ')).join('; ')}`);

  function checkResource(name, description, { relativeTo, allowBase = false, worker = false } = {}) {
    if (!name && allowBase) return;
    const destination = relativeTo ? localName(relativeTo, name.startsWith('.') ? name : `./${name}`) : relativeName(name, description);
    assert(outputs.has(destination), `Runtime resource missing from build catalog in ${description}: ${destination}`);
    if (worker) assert(entries.some(entry => entry.output === destination), `Worker is not a browser entry in ${description}: ${destination}`);
  }
  for (const [name, nodes] of resources) for (const node of nodes) {
    for (const resource of resourceNames(node, name)) checkResource(resource, name, { allowBase: true });
  }
  for (const [name, nodes] of workers) for (const node of nodes) {
    if (node && isGetURL(node)) {
      for (const resource of resourceNames(node.arguments[0], name)) checkResource(resource, name, { worker: true });
    } else {
      let expression = node;
      if (node && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
        assert(node.arguments?.[1]?.getText() === 'import.meta.url', `Worker URL must use import.meta.url in ${name}`);
        expression = node.arguments[0];
      }
      for (const resource of resourceNames(expression, name)) for (const entry of owners.get(name)) checkResource(resource, name, { relativeTo: entry.output, worker: true });
    }
  }
  for (const item of copied) {
    if (item.output.endsWith('.html')) {
      const html = await readFile(path.join(root, item.input), 'utf8');
      for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
        checkResource((match[1] ?? match[2] ?? match[3]).split(/[?#]/)[0], item.input, { relativeTo: item.output });
      }
    }
    if (item.output === 'manifest.json') {
      const manifest = JSON.parse(await readFile(path.join(root, item.input), 'utf8'));
      const references = [manifest.background?.service_worker, ...(manifest.background?.scripts ?? []), manifest.action?.default_popup,
        manifest.browser_action?.default_popup, manifest.page_action?.default_popup, manifest.side_panel?.default_path,
        manifest.options_ui?.page, manifest.options_page, manifest.devtools_page,
        ...Object.values(manifest.chrome_url_overrides ?? {}), ...Object.values(manifest.icons ?? {})];
      for (const action of [manifest.action, manifest.browser_action, manifest.page_action]) {
        if (typeof action?.default_icon === 'string') references.push(action.default_icon);
        else references.push(...Object.values(action?.default_icon ?? {}));
      }
      for (const content of manifest.content_scripts ?? []) references.push(...(content.js ?? []), ...(content.css ?? []));
      for (const reference of references.filter(value => value !== undefined)) checkResource(reference.split(/[?#]/)[0], item.input);
      for (const group of manifest.web_accessible_resources ?? []) for (const resource of typeof group === 'string' ? [group] : group.resources) {
        const pattern = new RegExp(`^${resource.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        assert([...outputs].some(name => pattern.test(name)), `Manifest resource missing from build catalog: ${resource}`);
      }
    }
  }
  return {
    status: 'passed', release: packageJson.version, sourceSha256: await sourceIdentity(root),
    moduleCount: runtime.size, entryCount: entries.length, vendorEntryCount: vendorRecords.length, vendorEntries: vendorRecords,
    edges: [...graph].flatMap(([from, targets]) => [...targets].map(to => ({ from, to }))).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    orphanModules, runtimeCycles,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = path.join(repository, 'reports/source-audit.json');
  await rm(destination, { force: true });
  const report = await auditSource();
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Source audit passed: ${report.moduleCount} runtime modules, ${report.entryCount} browser entries.`);
}
