import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { captureBackendFailure, memoryEvents, observeBackend, prepareBackendDiagnostics } from './backend-evidence.mjs';

for (const intentional of [false, true]) {
  test(`records a real ${intentional ? 'intentional' : 'unexpected'} child exit`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backend-exit-test-'));
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'inherit'] });
    const evidence = observeBackend(child);
    const closed = once(child, 'close');
    try {
      const before = await memoryEvents();
      await once(child.stdout, 'data');
      if (intentional) evidence.requestShutdown();
      assert.equal(child.kill(intentional ? 'SIGTERM' : 'SIGKILL'), true);
      await closed;
      const after = await memoryEvents();
      const path = join(directory, 'backend-exit.json');
      await evidence.write(path, before, after);
      const saved = JSON.parse(await readFile(path, 'utf8'));
      assert.deepEqual(saved.exit, { code: null, signal: intentional ? 'SIGTERM' : 'SIGKILL', shutdownRequested: intentional });
      for (const snapshot of [saved.memoryBefore, saved.memoryAfter]) {
        for (const counters of [snapshot.events, snapshot.local]) {
          assert.ok(counters === null || Object.values(counters).every(value => Number.isSafeInteger(value) && value >= 0));
        }
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('captures only an identity-verified backend and leaves its children alone', { skip: process.platform !== 'linux' }, async () => {
  for (const entrypoint of ['console', 'module']) {
    const directory = await mkdtemp(join(tmpdir(), 'backend-diagnostic-test-'));
    const reservation = createServer();
    const listening = once(reservation, 'listening');
    reservation.listen(0, '127.0.0.1');
    await listening;
    const port = reservation.address().port;
    await promisify(reservation.close.bind(reservation))();
    const baseURL = `http://127.0.0.1:${port}`;
    const environment = {
      ...process.env,
      DATA_DIR: join(directory, 'data'),
      TMPDIR: directory,
      PYTHONPATH: [resolve('.'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      QUEUE_CONCURRENCY: '0',
      AUTH_ORIGIN: baseURL,
      AUTH_OTP_SECRET: 'test-otp-secret-'.repeat(3),
      AUTH_INVITE_SECRET: 'test-invite-secret-'.repeat(3),
      AUTH_ADMIN_EMAIL: 'e2e-admin@example.test',
      MODAL_APP_NAME: 'audio-separator-key-analysis-no-gpu',
      MODAL_CONFIG_PATH: join(directory, 'missing-modal.toml'),
      MODAL_SERVER_URL: 'http://127.0.0.1:9',
      E2E_TEST_PENDING: join(directory, 'pending'),
    };
    for (const key of ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'MODAL_OAUTH_REFRESH_TOKEN',
      'MODAL_OAUTH_CLIENT_ID', 'MODAL_OAUTH_CLIENT_SECRET', 'MODAL_PROFILE', 'MODAL_IS_REMOTE']) delete environment[key];
    const diagnostics = await prepareBackendDiagnostics(directory, environment);
    await writeFile(join(directory, 'usercustomize.py'), String.raw`
import os
import sys
args = sys.orig_argv[1:]
console = len(args) >= 2 and os.path.basename(args[0]) == "uvicorn" and args[1] == "backend.main:app"
module = len(args) >= 3 and args[:3] == ["-m", "uvicorn", "backend.main:app"]
if console or module:
    import asyncio
    from pathlib import Path
    import backend.main
    original = backend.main.app
    gate = asyncio.Event()
    async def async_wait_marker():
        await gate.wait()
    class AwaitFixture:
        async def __call__(self, scope, receive, send):
            if scope["type"] == "http" and scope["path"] == "/health":
                headers = dict(scope.get("headers", []))
                if b"x-e2e-release" in headers:
                    gate.set()
                if b"x-e2e-wait" in headers:
                    Path(os.environ["E2E_TEST_PENDING"]).write_text("waiting")
                    await async_wait_marker()
            await original(scope, receive, send)
    backend.main.app = AwaitFixture()
    print("E2E_TEST_WRAPPER_READY", file=sys.stderr, flush=True)
`);
    // Isolated virtualenvs may disable Python's automatic usercustomize import.
    await writeFile(join(directory, 'sitecustomize.py'), '\nimport usercustomize\n', { flag: 'a' });
    const args = entrypoint === 'console'
      ? ['run', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', String(port)]
      : ['run', 'python', '-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', String(port)];
    const backend = spawn('uv', args, { cwd: resolve('.'), env: diagnostics.environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(backend, 'close');
    let stderr = '';
    backend.stdout.resume();
    backend.stderr.on('data', chunk => { stderr += chunk; });
    const sibling = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const siblingClosed = once(sibling, 'close');
    try {
      const deadline = Date.now() + 15_000;
      while (true) {
        if (backend.exitCode !== null) throw new Error('Owned backend exited before readiness');
        try {
          if ((await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(500) })).status === 200) break;
        } catch {}
        if (Date.now() >= deadline) throw new Error('Owned backend did not become ready');
        await delay(50);
      }
      assert.match(stderr, /E2E_TEST_WRAPPER_READY/);
      const receipt = await readFile(diagnostics.receipt, 'utf8');
      const parsed = JSON.parse(receipt);
      assert.ok(Number.isSafeInteger(parsed.pid) && parsed.pid > 1);

      // The real staging child inherits the hook environment but is not Uvicorn.
      const staging = spawn('uv', ['run', 'python', '-m', 'backend.stage_upload'], {
        cwd: resolve('.'), env: diagnostics.environment, stdio: 'ignore',
      });
      const [stagingExit] = await once(staging, 'exit');
      assert.notEqual(stagingExit, 0);
      assert.equal(await readFile(diagnostics.receipt, 'utf8'), receipt);

      const capture = wrapper => captureBackendFailure({ backend: wrapper, diagnostics, baseURL, cwd: resolve('.'), environment });
      await writeFile(diagnostics.receipt, JSON.stringify({ ...parsed, start: String(BigInt(parsed.start) + 1n) }));
      assert.equal((await capture(backend)).signalSent, false);
      await writeFile(diagnostics.receipt, receipt);
      assert.equal((await capture(sibling)).signalSent, false);
      assert.equal(stderr.includes('Current thread'), false);
      const pending = fetch(`${baseURL}/health`, {
        headers: { 'x-e2e-wait': '1' }, signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      const waitDeadline = Date.now() + 3000;
      while (true) {
        try { await readFile(environment.E2E_TEST_PENDING); break; } catch {}
        if (Date.now() >= waitDeadline) throw new Error('Fixture request did not start waiting');
        await delay(20);
      }


      const result = await capture(backend);
      assert.equal(result.signalSent, true);
      assert.equal(result.health.status, 200);
      assert.equal(result.router.status, 405);
      const stackDeadline = Date.now() + 3000;
      while ((!stderr.includes('Current thread') || !stderr.includes('E2E_ASYNC_SNAPSHOT ')) && Date.now() < stackDeadline) await delay(20);
      assert.match(stderr, /Current thread/);
      assert.match(stderr, /uvicorn/);
      const snapshotLine = stderr.split('\n').find(line => line.startsWith('E2E_ASYNC_SNAPSHOT '));
      assert.ok(snapshotLine);
      const snapshot = JSON.parse(snapshotLine.slice('E2E_ASYNC_SNAPSHOT '.length));
      assert.ok(snapshot.tasks.some(frames => frames.some(frame => frame.function === 'async_wait_marker')));
      assert.equal(backend.exitCode, null);
      assert.equal((await fetch(`${baseURL}/health`, { headers: { 'x-e2e-release': '1' } })).status, 200);
      assert.equal((await pending)?.status, 200);
    } finally {
      await fetch(`${baseURL}/health`, {
        headers: { 'x-e2e-release': '1' }, signal: AbortSignal.timeout(1000),
      }).catch(() => {});
      if (sibling.exitCode === null && sibling.signalCode === null) sibling.kill('SIGTERM');
      if (backend.exitCode === null && backend.signalCode === null) backend.kill('SIGTERM');
      await Promise.all([closed, siblingClosed]);
      await rm(directory, { recursive: true, force: true });
    }
  }
});
