import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const result = spawnSync(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-B', '-m', 'unittest', 'discover', '-s', 'native', '-p', 'test_*.py', '-v'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const summary = `${result.stdout}\n${result.stderr}`;
const count = Number(summary.match(/Ran (\d+) tests?/)?.[1]);
if (!count || !/^OK(?:\s|$)/m.test(summary)) throw new Error('Native test summary missing');
const sourceSha256 = {};
for (const name of ['antivirus_host.py', 'windows_antivirus.py', 'install.py']) sourceSha256[`native/${name}`] = createHash('sha256').update(await readFile(`native/${name}`)).digest('hex');
await writeFile('reports/native-tests.json', JSON.stringify({ status: 'passed', count, platform: process.platform, windowsRuntimeVerified: false, scope: 'native unit and subprocess tests; Windows COM/AMSI interfaces use test doubles on non-Windows', sourceSha256 }, null, 2) + '\n');
