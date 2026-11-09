import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { silentFixture, tonalFixture, vocalFixture } from './fixture.mjs';
import { transform } from 'esbuild';
import { startMediaRelay } from './media-relay.mjs';
import { memoryEvents, observeBackend } from './backend-evidence.mjs';
import { startAuthSmtp } from './auth-smtp.mjs';

// Use the already-provisioned environment rather than resolving dependencies
// for each backend or fixture subprocess; callers may explicitly override this.
process.env.UV_NO_SYNC ??= 'true';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(frontend, '..');
const visual = process.argv.includes('--visual');
const youtube = process.argv.includes('--youtube');
const cpu = process.argv.includes('--cpu');
const throttleMedia = process.argv.includes('--throttle-media');
if (throttleMedia && !visual) throw new Error('--throttle-media requires --visual so fixture jobs cannot run workers.');
const cpuOnly = visual || youtube || cpu;
const arguments_ = process.argv.slice(2).filter(argument => !['--visual', '--youtube', '--cpu', '--throttle-media'].includes(argument));
if (youtube) arguments_.unshift('--config=playwright.youtube.config.ts');
const app = cpuOnly ? 'audio-separator-key-analysis-no-gpu' : process.env.E2E_MODAL_APP_NAME;
// Production namespaces stay off-limits, including those retained during cutover.
// Only authorized deployments may drive them, never ad-hoc browser tests.
if (!app || app === 'audio-separator' || app === 'audio-separator-v2' || app === 'audio-inference-v3') {
  throw new Error('Set E2E_MODAL_APP_NAME to an explicitly isolated Modal test deployment, not a production app.');
}
console.log(youtube ? 'YouTube verification: real external download + full-song native key analysis, no GPU jobs' : visual ? 'Visual verification: real native key analysis, deterministic local audio, no GPU jobs' : cpu ? 'CPU verification: real native processing and key analysis, deterministic local audio, no GPU jobs' : `Real full-stack verification: Modal app=${app}; no mocked boundaries`);
// Parse every browser spec before paying for the build/backend/model startup.
for (const entry of await readdir(resolve(frontend, 'e2e'))) {
  if (!entry.endsWith('.ts')) continue;
  await transform(await readFile(resolve(frontend, 'e2e', entry), 'utf8'), { loader: 'ts', sourcefile: entry });
}
const build = spawnSync('npm', ['run', 'build'], { cwd: frontend, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const fixtureSeed = cpuOnly ? 0 : randomBytes(4).readUInt32LE();
const toneFixture = tonalFixture();
const fixture = cpuOnly ? toneFixture : await vocalFixture(fixtureSeed);
const temporary = await mkdtemp(resolve(tmpdir(), 'vocals-browser-e2e-'));
await writeFile(resolve(temporary, 'musical-fixture.wav'), fixture);
await writeFile(resolve(temporary, 'tone-fixture.wav'), toneFixture);
await writeFile(resolve(temporary, 'silent-fixture.wav'), silentFixture());
await writeFile(resolve(temporary, 'invalid.wav'), 'not audio');
// The pinned ASR reference is only needed by GPU lyrics tests, never CPU,
// visual, YouTube, or explicitly selected unrelated GPU specs.
const selectedSpecs = arguments_.filter(argument => /\.spec\.ts(?:$|:)/.test(argument));
const needsLyricsFixture = !cpuOnly && (selectedSpecs.length === 0 || selectedSpecs.some(argument => /(?:^|\/)lyrics\.spec\.ts(?:$|:)/.test(argument)));
if (needsLyricsFixture) {
  const reference = spawnSync('uv', ['run', 'python', 'tests/lyrics_fixture.py', resolve(temporary, 'jfk.flac')], { cwd: root, stdio: 'inherit' });
  if (reference.status !== 0) {
    await rm(temporary, { recursive: true, force: true });
    throw new Error('Failed to stage the checksum-verified ASR reference fixture.');
  }
}
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
const backendURL = `http://127.0.0.1:${port}`;
const mediaRelay = throttleMedia ? await startMediaRelay(backendURL) : null;
const baseURL = mediaRelay?.url ?? backendURL;
const smtp = await startAuthSmtp(temporary);
const environment = {
  ...process.env,
  DATA_DIR: resolve(temporary, 'data'),
  MODAL_APP_NAME: app,
  // Visual cases can publish captured real inference through the normal DB/API
  // without accidentally claiming their fixture jobs on a GPU worker.
  QUEUE_CONCURRENCY: visual ? '0' : '1',
  QUEUE_POLL_INTERVAL_S: '0.1',
  DOWNLOAD_MAX_ATTEMPTS: '1',
  AUTH_ORIGIN: baseURL,
  AUTH_OTP_SECRET: randomBytes(32).toString('hex'),
  AUTH_INVITE_SECRET: randomBytes(32).toString('hex'),
  AUTH_SMTP_SOCKET: smtp.socketPath,
  AUTH_ADMIN_EMAIL: 'e2e-admin@example.test',
  E2E_BASE_URL: baseURL,
  E2E_FIXTURE_URL: fixtureURL,
  E2E_FIXTURE_DIR: temporary,
  E2E_DATA_DIR: resolve(temporary, 'data'),
  E2E_REPO_ROOT: root,
  E2E_FIXTURE_SEED: String(fixtureSeed),
};
const memoryBefore = await memoryEvents();
const backend = spawn('uv', ['run', 'uvicorn', 'backend.main:app', '--no-proxy-headers', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
let backendError;
const backendEvidence = observeBackend(backend);
const backendClosed = new Promise(resolve => backend.once('close', resolve));
backend.once('error', error => { backendError = error; });
let child;
let interrupted = false;
const interrupt = () => {
  backendEvidence.requestShutdown();
  interrupted = true;
  child?.kill('SIGTERM');
  void mediaRelay?.stop();
  backend.kill('SIGTERM');
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
for (const stream of [backend.stdout, backend.stderr]) stream.on('data', chunk => { backendLog += chunk; process.stdout.write(chunk); });
const cleanup = async () => {
  backendEvidence.requestShutdown();
  await mediaRelay?.stop();
  if (backend.exitCode === null && !backendError) backend.kill('SIGTERM');
  await backendClosed;
  await smtp.stop();
  await new Promise(resolve => source.close(resolve));
  try {
    await cp(
      resolve(temporary, 'data', 'artifacts', 'inference-diagnostics'),
      resolve(frontend, 'test-results', ...(visual ? ['visual'] : youtube ? ['youtube'] : []), 'inference-diagnostics'),
      { recursive: true, force: false, errorOnExist: true },
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
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
  const adminCommand = (...args) => {
    const result = spawnSync('uv', ['run', 'python', '-m', 'backend.auth_admin', ...args], { cwd: root, env: environment, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Auth fixture command failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  for (const name of ['user_daily_work', 'global_daily_work', 'user_queue', 'global_queue']) adminCommand('budget', name, '100000');
  const post = (path, body) => fetch(`${baseURL}/api/auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseURL }, body: JSON.stringify(body),
  });
  const createSession = async email => {
    const invite = adminCommand('seed-invite').split(/\s+/)[1];
    const started = await post('start', { email, invite_code: invite });
    if (!started.ok) throw new Error(`Auth fixture start failed: ${started.status}`);
    let code;
    const deadline = Date.now() + 15_000;
    while (!code) {
      try { code = await readFile(resolve(temporary, `mail-${encodeURIComponent(email)}.txt`), 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const verified = await post('verify', { email, invite_code: invite, code });
    if (!verified.ok) throw new Error(`Auth fixture verification failed: ${verified.status}`);
    const cookie = verified.headers.get('set-cookie')?.match(/(?:^|,\s*)auth_session=([^;]+)/)?.[1];
    if (!cookie) throw new Error('Auth fixture did not receive a session cookie');
    return cookie;
  };
  environment.E2E_AUTH_SESSION = await createSession(environment.AUTH_ADMIN_EMAIL);
  environment.E2E_AUTH_OUTSIDER_SESSION = await createSession('e2e-outsider@example.test');
  console.log(`Built frontend + real HTTP backend: ${baseURL}; isolated DATA_DIR=${environment.DATA_DIR}`);
  child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...arguments_], {
    cwd: frontend, env: environment, stdio: 'inherit',
  });
  exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? (interrupted ? 130 : 1)));
  });
} finally {
  try {
    const results = resolve(frontend, 'test-results', ...(visual ? ['visual'] : youtube ? ['youtube'] : []));
    await mkdir(results, { recursive: true });
    await writeFile(resolve(results, 'backend.log'), backendLog);
    if (mediaRelay) {
      await mediaRelay.stop();
      await writeFile(resolve(results, 'listening-transport.json'), JSON.stringify({
        bytesPerSecond: mediaRelay.bytesPerSecond, chunkBytes: mediaRelay.chunkBytes, requests: mediaRelay.records,
      }, null, 2));
    }
  } finally {
    const results = resolve(frontend, 'test-results', ...(visual ? ['visual'] : youtube ? ['youtube'] : []));
    const memoryAfter = await memoryEvents();
    await cleanup();
    await backendEvidence.write(resolve(results, 'backend-exit.json'), memoryBefore, memoryAfter);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
process.exitCode = exit;
