import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { memoryEvents, observeBackend } from './backend-evidence.mjs';

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
