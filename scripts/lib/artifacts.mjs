import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
// Inventory policies stay explicit; caches are excluded only by source snapshots.
export async function files(root, { skipDirectories = [] } = {}) {
  const info = await lstat(root);
  assert(!info.isSymbolicLink() && info.isDirectory(), `Expected a real directory: ${root}`);
  const skipped = new Set(skipDirectories), names = [];
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const name = path.posix.join(prefix, entry.name);
      assert(!entry.isSymbolicLink(), `Unexpected symlink: ${path.join(root, name)}`);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
      else { assert(entry.isFile(), `Unexpected file type: ${name}`); names.push(name); }
    }
  }
  await visit(root, ''); return names.sort();
}
export async function treeIdentity(root, names) {
  names ??= await files(root);
  return hash((await Promise.all(names.map(async name => `${name}\0${hash(await readFile(path.join(root, name)))}`))).join('\n'));
}
export async function sourceIdentity(root = '.') {
  const names = ['package.json', 'package-lock.json', 'tsconfig.json'];
  for (const directory of ['src', 'native', 'scripts', 'tests']) {
    for (const name of await files(path.join(root, directory), { skipDirectories: ['__pycache__'] })) {
      const full = `${directory}/${name}`;
      if (/\.(?:ts|mjs|py)$/.test(full) || (full.startsWith('tests/baselines/') && full.endsWith('.txt'))) names.push(full);
    }
  }
  return Object.fromEntries(await Promise.all(names.sort().map(async name => [name, hash(await readFile(path.join(root, name)))])));
}
