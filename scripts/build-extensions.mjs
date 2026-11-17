import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
for (const variant of ['standard', 'missav']) {
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
    stdio: 'inherit', env: { ...process.env, MY_VIDEO_APP_EXTENSION_VARIANT: variant },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
