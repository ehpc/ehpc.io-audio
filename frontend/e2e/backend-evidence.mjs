import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { promisify } from 'node:util';

export async function memoryEvents() {
  try {
    const cgroup = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (cgroup === undefined) return { events: null, local: null };
    const readCounters = async name => {
      try {
        const text = await readFile(resolve('/sys/fs/cgroup', `.${cgroup}`, name), 'utf8');
        return Object.fromEntries(text.trim().split('\n').map(line => line.split(/\s+/)).filter(([key, value]) => /^(low|high|max|oom|oom_kill|oom_group_kill)$/.test(key) && /^\d+$/.test(value)).map(([key, value]) => [key, Number(value)]));
      } catch { return null; }
    };
    return { events: await readCounters('memory.events'), local: await readCounters('memory.events.local') };
  } catch { return { events: null, local: null }; }
}

export function observeBackend(child) {
  let shutdownRequested = false;
  let exit = null;
  child.once('exit', (code, signal) => { exit = { code, signal, shutdownRequested }; });
  return {
    requestShutdown() { shutdownRequested = true; },
    async write(path, memoryBefore, memoryAfter) {
      await writeFile(path, JSON.stringify({ process: 'uv wrapper', exit, memoryBefore, memoryAfter }, null, 2));
    },
  };
}

// The hook runs only for the owned uvicorn entrypoint, not its Python children.
const diagnosticHook = String.raw`
import asyncio
import faulthandler
import json
import os
import signal
import sys
import time

args = sys.orig_argv[1:]
console = len(args) >= 2 and os.path.basename(args[0]) == "uvicorn" and args[1] == "backend.main:app"
module = len(args) >= 3 and args[:3] == ["-m", "uvicorn", "backend.main:app"]
if (console or module) and os.environ.get("E2E_BACKEND_DIAGNOSTIC_NONCE"):
    def snapshot_tasks():
        tasks = list(asyncio.all_tasks())
        snapshots = []
        for task in tasks[:16]:
            frames, seen = [], set()
            current = task.get_coro()
            while current is not None and id(current) not in seen and len(seen) < 12:
                seen.add(id(current))
                frame = next((getattr(current, key, None) for key in ("cr_frame", "gi_frame", "ag_frame") if getattr(current, key, None) is not None), None)
                if frame is not None:
                    frames.append({"file": frame.f_code.co_filename[-256:], "function": frame.f_code.co_name[:128], "line": frame.f_lineno})
                current = next((getattr(current, key, None) for key in ("cr_await", "gi_yieldfrom", "ag_await") if getattr(current, key, None) is not None), None)
            snapshots.append(frames)
        data = {"captured_at": time.time(), "tasks": snapshots, "truncated": len(tasks) > 16}
        os.write(2, ("E2E_ASYNC_SNAPSHOT " + json.dumps(data, separators=(",", ":")) + "\n").encode())

    def request_snapshot(signum, frame):
        try:
            asyncio.get_running_loop().call_soon_threadsafe(snapshot_tasks)
        except RuntimeError:
            pass

    signal.signal(signal.SIGUSR1, request_snapshot)
    faulthandler.register(signal.SIGUSR1, all_threads=True, chain=True)
    stat = open("/proc/self/stat").read()
    start = stat[stat.rfind(")") + 2:].split()[19]
    receipt = {"pid": os.getpid(), "start": start, "nonce": os.environ["E2E_BACKEND_DIAGNOSTIC_NONCE"]}
    fd = os.open(os.environ["E2E_BACKEND_DIAGNOSTIC_RECEIPT"], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(receipt, output)
`;

// Open the pidfd before validation so PID reuse can never redirect the signal.
const signalOwnedBackend = String.raw`
import json
import os
from pathlib import Path
import signal
import sys

pid, expected_start, wrapper = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
def info(target):
    stat = Path(f"/proc/{target}/stat").read_text()
    fields = stat[stat.rfind(")") + 2:].split()
    return int(fields[1]), fields[19]

sent = False
try:
    if pid <= 1 or wrapper <= 1 or pid == os.getpid():
        raise ValueError("invalid process identity")
    fd = os.pidfd_open(pid)
    try:
        _, start = info(pid)
        if start != expected_start:
            raise ValueError("stale process identity")
        args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        console = any(os.path.basename(args[i]) == b"uvicorn" and args[i + 1] == b"backend.main:app" for i in range(len(args) - 1))
        module = any(args[i:i + 3] == [b"-m", b"uvicorn", b"backend.main:app"] for i in range(len(args) - 2))
        if not (console or module):
            raise ValueError("unexpected process command")
        ancestor = pid
        for _ in range(64):
            if ancestor == wrapper:
                break
            ancestor, _ = info(ancestor)
            if ancestor <= 1:
                raise ValueError("wrapper is not an ancestor")
        else:
            raise ValueError("process ancestry is too deep")
        signal.pidfd_send_signal(fd, signal.SIGUSR1)
        sent = True
    finally:
        os.close(fd)
except (AttributeError, OSError, ValueError, IndexError):
    pass
print(json.dumps({"sent": sent}))
`;

export async function prepareBackendDiagnostics(directory, environment) {
  const nonce = randomBytes(32).toString('hex');
  const receipt = resolve(directory, 'backend-diagnostic-pid.json');
  await writeFile(resolve(directory, 'sitecustomize.py'), diagnosticHook, { flag: 'wx', mode: 0o600 });
  return {
    nonce,
    receipt,
    environment: {
      ...environment,
      PYTHONPATH: [directory, environment.PYTHONPATH].filter(Boolean).join(delimiter),
      E2E_BACKEND_DIAGNOSTIC_NONCE: nonce,
      E2E_BACKEND_DIAGNOSTIC_RECEIPT: receipt,
    },
  };
}

async function probe(baseURL, method) {
  const start = performance.now();
  try {
    const response = await fetch(`${baseURL}/health`, { method, signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return { status: response.status, elapsedMs: Math.round(performance.now() - start) };
  } catch (error) {
    return { error: error.name, elapsedMs: Math.round(performance.now() - start) };
  }
}

export async function captureBackendFailure({ backend, diagnostics, baseURL, cwd, environment }) {
  let signalSent = false;
  try {
    const receipt = JSON.parse(await readFile(diagnostics.receipt, 'utf8'));
    if (receipt.nonce === diagnostics.nonce && Number.isSafeInteger(receipt.pid) && receipt.pid > 1
      && /^\d+$/.test(receipt.start) && Number.isSafeInteger(backend.pid) && backend.pid > 1
      && backend.exitCode === null && backend.signalCode === null) {
      const { stdout } = await promisify(execFile)('uv', [
        'run', 'python', '-c', signalOwnedBackend, String(receipt.pid), receipt.start, String(backend.pid),
      ], { cwd, env: environment, timeout: 5000 });
      signalSent = JSON.parse(stdout).sent === true;
    }
  } catch {
    // Diagnostics are best-effort; never signal an unverified process.
  }
  const [health, router] = await Promise.all([probe(baseURL, 'GET'), probe(baseURL, 'OPTIONS')]);
  return { signalSent, health, router };
}
