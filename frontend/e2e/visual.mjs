import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(frontend, '..');
const lock = JSON.parse(await readFile(resolve(frontend, 'package-lock.json'), 'utf8'));
const version = lock.packages['node_modules/@playwright/test'].version;
const dockerfile = 'frontend/e2e/Dockerfile.visual';
const definition = await readFile(resolve(root, dockerfile), 'utf8');
if (!definition.includes(`mcr.microsoft.com/playwright:v${version}-noble`)) {
  throw new Error('Match Dockerfile.visual to the locked Playwright version before running visual tests.');
}
const image = `vocals-visual:${version}`;
const run = (args) => {
  const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(['build', '--platform=linux/amd64', '-f', dockerfile, '-t', image, '.']);
const mounts = [
  ['e2e/visual-snapshots', '/app/frontend/e2e/visual-snapshots'],
  ['test-results/visual', '/app/frontend/test-results/visual'],
  ['playwright-report/visual', '/app/frontend/playwright-report/visual'],
];
const arguments_ = ['run', '--rm', '--platform=linux/amd64', '--ipc=host', '-e', `CI=${process.env.CI ?? ''}`];
for (const [host, container] of mounts) {
  const path = resolve(frontend, host);
  await mkdir(path, { recursive: true });
  arguments_.push('--mount', `type=bind,source=${path},target=${container}`);
}
run([...arguments_, image, ...process.argv.slice(2)]);
