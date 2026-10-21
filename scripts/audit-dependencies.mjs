import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hash } from './lib/artifacts.mjs';
import { validateDependencyAudit } from './lib/dependency-policy.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const lockSha256 = hash(await readFile('package-lock.json'));
// npm run provides its JS entry point, avoiding Windows .cmd shell execution.
const npmCli = process.env.npm_execpath;
const executable = npmCli ? process.execPath : 'npm';
const arguments_ = [...(npmCli ? [npmCli] : []), 'audit', '--json', '--registry=https://registry.npmjs.org'];
const result = spawnSync(executable, arguments_, {
  encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
});
let audit;
try { audit = JSON.parse(result.stdout ?? ''); } catch { /* Failed requests are not successful zero-advisory audits. */ }
const report = {
  version: 1, status: result.status === 0 && !result.error && audit && !audit.error ? 'passed' : 'failed',
  checkedAtUtc: new Date().toISOString(), registry: 'https://registry.npmjs.org', packageLockSha256: lockSha256,
  audit: audit ?? null,
  scope: 'npm dependency advisories only; bundled native/Wasm components and browser/OS vulnerabilities require separate review',
};
// Replace old success evidence on any network/parse/registry failure as well.
if (hash(await readFile('package-lock.json')) !== lockSha256) report.status = 'failed';
await writeFile('reports/dependency-audit.json', JSON.stringify(report, null, 2) + '\n');
try {
  validateDependencyAudit(report, hash(await readFile('package-lock.json')));
  console.log('Dependency audit passed: zero npm advisories for the exact lockfile (not a native/Wasm security guarantee).');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
