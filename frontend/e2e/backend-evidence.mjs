import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
