import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { musicalFixture, vocalFixture } from './fixture.mjs';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(frontend, '..');
const app = process.env.E2E_MODAL_APP_NAME;
if (!app || app === 'audio-separator') {
  throw new Error('Set E2E_MODAL_APP_NAME to an explicitly isolated Modal test deployment (not audio-separator).');
}
console.log(`Real full-stack verification: Modal app=${app}; no mocked boundaries`);
const build = spawnSync('npm', ['run', 'build'], { cwd: frontend, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const fixtureSeed = randomBytes(4).readUInt32LE();
const fixture = await vocalFixture(fixtureSeed);
const toneFixture = musicalFixture(fixtureSeed);
const temporary = await mkdtemp(resolve(tmpdir(), 'vocals-browser-e2e-'));
await writeFile(resolve(temporary, 'musical-fixture.wav'), fixture);
await writeFile(resolve(temporary, 'tone-fixture.wav'), toneFixture);
await writeFile(resolve(temporary, 'invalid.wav'), 'not audio');
let serveRecovered = false;
const source = createServer((req, res) => {
  if (req.url === '/recover' && req.method === 'POST') {
    serveRecovered = true;
    res.end('ok');
  } else if (['/musical-fixture.wav', '/tone-fixture.wav'].includes(req.url) || (req.url === '/recoverable.wav' && serveRecovered)) {
    const bytes = req.url === '/tone-fixture.wav' ? toneFixture : fixture;
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length });
    res.end(bytes);
  } else {
    res.writeHead(404);
    res.end('No such fixture');
  }
});
await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
const fixtureURL = `http://127.0.0.1:${source.address().port}`;
const reservation = createNetServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const baseURL = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  DATA_DIR: resolve(temporary, 'data'),
  MODAL_APP_NAME: app,
  QUEUE_CONCURRENCY: '1',
  QUEUE_POLL_INTERVAL_S: '0.1',
  DOWNLOAD_MAX_ATTEMPTS: '1',
  COOKIE_SECRET: `isolated-e2e-${temporary}`,
  COOKIE_SECURE: 'false',
  E2E_BASE_URL: baseURL,
  E2E_FIXTURE_URL: fixtureURL,
  E2E_FIXTURE_DIR: temporary,
  E2E_DATA_DIR: resolve(temporary, 'data'),
  E2E_REPO_ROOT: root,
  E2E_FIXTURE_SEED: String(fixtureSeed),
};
const backend = spawn('uv', ['run', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
let backendError;
const backendClosed = new Promise(resolve => backend.once('close', resolve));
backend.once('error', error => { backendError = error; });
let child;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  child?.kill('SIGTERM');
  backend.kill('SIGTERM');
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
for (const stream of [backend.stdout, backend.stderr]) stream.on('data', chunk => { backendLog += chunk; process.stdout.write(chunk); });
const cleanup = async () => {
  if (backend.exitCode === null && !backendError) backend.kill('SIGTERM');
  await backendClosed;
  await new Promise(resolve => source.close(resolve));
  await rm(temporary, { recursive: true, force: true });
};
let exit = 1;
try {
  const deadline = Date.now() + 60_000;
  while (true) {
    if (backendError) throw backendError;
    if (interrupted) throw new Error('Full-stack verification interrupted');
    if (backend.exitCode !== null) throw new Error(`Backend exited ${backend.exitCode}`);
    try { if ((await fetch(`${baseURL}/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Real backend failed to become healthy');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log(`Built frontend + real HTTP backend: ${baseURL}; isolated DATA_DIR=${environment.DATA_DIR}`);
  child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
    cwd: frontend, env: environment, stdio: 'inherit',
  });
  exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? (interrupted ? 130 : 1)));
  });
} finally {
  try {
    await mkdir(resolve(frontend, 'test-results'), { recursive: true });
    await writeFile(resolve(frontend, 'test-results', 'backend.log'), backendLog);
  } finally {
    await cleanup();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
process.exitCode = exit;
