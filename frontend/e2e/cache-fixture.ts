import { execFileSync } from 'node:child_process';

// Writes real indexed cache artifacts only inside the isolated E2E data directory.
export function seedCachedSongs() {
  if (!process.env.E2E_DATA_DIR || !process.env.E2E_REPO_ROOT) throw new Error('Isolated E2E data directory required.');
  execFileSync('uv', ['run', 'python', '-c', String.raw`
from backend import cache_catalog, config
from separator.artifact_cache import cached_bytes, cache_key
assert config.QUEUE_CONCURRENCY == 0
for index, title, artist in [(1,'Silver harbor','Example singer'),(2,'Quiet morning','Fixture artist'),(3,'Distant lights','Fixture band')]:
    with cache_catalog.capture() as recorder:
        recorder.bind(('synthetic audio '+str(index)).encode(),title,artist)
        cached_bytes(config.DATA_DIR/'artifacts'/'keys',cache_key('ui-fixture-'+str(index)),lambda: ('fixture cache '+str(index)).encode())
`], { cwd: process.env.E2E_REPO_ROOT, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR } });
}

export function seedAdditionalSilverArtifact() {
  if (!process.env.E2E_DATA_DIR || !process.env.E2E_REPO_ROOT) throw new Error('Isolated E2E data directory required.');
  execFileSync('uv', ['run', 'python', '-c', String.raw`
from backend import cache_catalog, config
from separator.artifact_cache import cached_bytes, cache_key
assert config.QUEUE_CONCURRENCY == 0
with cache_catalog.capture() as recorder:
    recorder.bind(b'synthetic audio 1','Silver harbor','Example singer')
    cached_bytes(config.DATA_DIR/'artifacts'/'keys',cache_key('ui-fixture-extra'),lambda: b'another cached stage')
`], { cwd: process.env.E2E_REPO_ROOT, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR } });
}

// These jobs belong exclusively to the isolated UI fixture, not a real account.
// Processing remains disabled; status transitions below simulate presentation
// states only. The separate CPU HTTP smoke exercises the real queue.
export function seedRegenerationCandidates(reservedIds?: [number, number]): number[] {
  if (!process.env.E2E_DATA_DIR || !process.env.E2E_REPO_ROOT) throw new Error('Isolated E2E data directory required.');
  const output = execFileSync('uv', ['run', 'python', '-c', String.raw`
import json, sys, time
from dataclasses import asdict
from backend import config, db
from separator.options import SeparationOptions
assert config.QUEUE_CONCURRENCY == 0
ids = []
reserved = json.loads(sys.argv[1])
assert reserved is None or (len(reserved) == 2 and len(set(reserved)) == 2 and all(type(i) is int and i > 0 for i in reserved))
for index, options in enumerate([SeparationOptions(detect_pitch=True), SeparationOptions(extract_vocals=True, pitch_semitones=2, tempo_percent=90)]):
    if reserved is None:
        job = db.insert_job('e2e:cache-regeneration', 'upload', 'fixture.wav', options)
    else:
        job = reserved[index]
        with db._session() as conn:
            conn.execute("INSERT INTO jobs (id,session_id,status,source_type,source_value,title,options_json,created_at) VALUES (?,'e2e:cache-regeneration','queued','upload','fixture.wav','fixture.wav',?,?)", (job,json.dumps(asdict(options)),int(time.time())))
    directory = config.UPLOADS_DIR / str(job)
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'fixture.wav').write_bytes(b'synthetic audio 1')
    db.mark_done(job, [])
    ids.append(job)
print(json.dumps(ids))
`, JSON.stringify(reservedIds ?? null)], { cwd: process.env.E2E_REPO_ROOT, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR } });
  return JSON.parse(output.toString()) as number[];
}

export function setRegenerationFixtureStatus(jobId: number, status: 'done' | 'failed') {
  if (!process.env.E2E_DATA_DIR || !process.env.E2E_REPO_ROOT) throw new Error('Isolated E2E data directory required.');
  execFileSync('uv', ['run', 'python', '-c', String.raw`
import sys
from backend import config, db
assert config.QUEUE_CONCURRENCY == 0
job = db.get_job(int(sys.argv[1]))
assert job and job.session_id == 'e2e:cache-regeneration' and db.regeneration_snapshot(job.id)
if sys.argv[2] == 'done':
    db.mark_done(job.id, [])
else:
    db.mark_failed(job.id, 'Synthetic fixture failure')
`, String(jobId), status], { cwd: process.env.E2E_REPO_ROOT, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR } });
}

export function cleanupRegenerationFixtures() {
  if (!process.env.E2E_DATA_DIR || !process.env.E2E_REPO_ROOT) throw new Error('Isolated E2E data directory required.');
  execFileSync('uv', ['run', 'python', '-c', String.raw`
import shutil
from backend import config, db
assert config.QUEUE_CONCURRENCY == 0
with db._session() as conn:
    ids = [row[0] for row in conn.execute("SELECT id FROM jobs WHERE session_id='e2e:cache-regeneration'")]
    for job in ids:
        conn.execute('DELETE FROM regenerations WHERE job_id=?', (job,))
        conn.execute('DELETE FROM jobs WHERE id=?', (job,))
        for root in (config.UPLOADS_DIR, config.RESULTS_DIR):
            shutil.rmtree(root / str(job), ignore_errors=True)
        (config.DATA_DIR / 'source-metadata' / f'{job}.json').unlink(missing_ok=True)
`], { cwd: process.env.E2E_REPO_ROOT, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR } });
}
