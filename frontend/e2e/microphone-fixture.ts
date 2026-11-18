import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { test as base } from './auth-fixture';

export const wavePath = resolve(process.env.E2E_FIXTURE_DIR!, 'microphone-tones.wav');
const seed = String.raw`
import json,os,sys,subprocess
from pathlib import Path
from backend import cache_catalog,config,db
from backend.queue import _persist_results
from separator.stems import StemResult
from separator.pitch import pitch_from_json,pitch_to_json
assert config.QUEUE_CONCURRENCY == 0
assert config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
job=db.get_job(int(sys.argv[1]))
manifest=[]
if sys.argv[2] == 'backing':
 wav=subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=220:duration=30:sample_rate=24000','-f','wav','pipe:1'],stdin=subprocess.DEVNULL,capture_output=True,check=True).stdout
 source=(config.UPLOADS_DIR / str(job.id) / job.source_value).read_bytes()
 with cache_catalog.capture() as recorder:
  recorder.bind(source,job.title)
  manifest=_persist_results(job,{'instruments':StemResult(wav,0)})
db.mark_done(job.id,manifest,None,pitch_to_json(pitch_from_json(json.dumps(json.load(sys.stdin)['pitch']))))
`;

const cleanup = String.raw`
import os,sys
from pathlib import Path
from backend import config,db
from backend.routes.jobs import _remove_job_files
assert config.QUEUE_CONCURRENCY == 0
assert config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
job_id=int(sys.argv[1])
assert job_id > 0
with db._session() as c:
    row=c.execute("SELECT session_id FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row:
        assert row[0] == sys.argv[2]
        c.execute("DELETE FROM jobs WHERE id=? AND session_id=?", (job_id,sys.argv[2]))
if row:
    _remove_job_files(job_id)
`;

export async function writeMicrophoneWave() {
  const rate = 48000, seconds = 3, frequencies = [329.6275569, 329.6275569 * 2 ** (10 / 1200), 329.6275569 * 2 ** (35 / 1200), 0, 220 * 2 ** (-30 / 1200), 277.1826309];
  const count = rate * seconds * frequencies.length;
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const frequency = frequencies[Math.floor(i / (rate * seconds))];
    wav.writeInt16LE(Math.round(0.25 * 32767 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  }
  await writeFile(wavePath, wav);
}

export const test = base.extend<{ openPitchJob: (backing?: boolean) => Promise<void> }>({
  openPitchJob: async ({ page }, use) => {
    const jobIds: number[] = [];
    let owner: string | undefined;
    const root = process.env.E2E_REPO_ROOT!;
    const env = { ...process.env, UV_NO_SYNC: '1', DATA_DIR: process.env.E2E_DATA_DIR! };
    await use(async (backing = false) => {
      await page.goto('/');
      owner = (await (await page.request.get('/api/auth/me')).json()).id;
      const audio = await readFile(resolve(root, 'tests/fixtures/auld-lang-syne-full.ogg'));
      const fixture = await readFile(resolve(root, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8');
      const response = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
        file: { name: 'voice.ogg', mimeType: 'audio/ogg', buffer: audio }, detect_pitch: 'true', pitch_semitones: '1.25', tempo_percent: '125',
      } });
      expect(response.ok()).toBe(true);
      const jobId: number = (await response.json()).id;
      jobIds.push(jobId);
      execFileSync('uv', ['run', 'python', '-c', seed, String(jobId), backing ? 'backing' : 'none'], { cwd: root, input: fixture, env });
      await page.reload();
    });
    for (const jobId of jobIds) execFileSync('uv', ['run', 'python', '-c', cleanup, String(jobId), owner!], { cwd: root, env });
  },
});
