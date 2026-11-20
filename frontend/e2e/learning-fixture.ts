import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

interface LearningFixtureRecord { id: number; digest: string; owner: string }
const owned = new WeakMap<Page, LearningFixtureRecord[]>();

export async function cleanupLearning(page: Page) {
  await page.goto('about:blank');
  for (const item of owned.get(page) ?? []) {
    execFileSync('uv', ['run', 'python', '-c', String.raw`
import hashlib, os, re, sys
from pathlib import Path
from backend import auth_store, config, db
assert config.QUEUE_CONCURRENCY == 0 and config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
job_id, digest, owner = int(sys.argv[1]), sys.argv[2], sys.argv[3]
assert re.fullmatch(r'[0-9a-f]{64}', digest)
principal = auth_store.authenticate(os.environ['E2E_AUTH_SESSION'])
assert principal and principal.id == owner
with db._session() as conn:
    row = conn.execute('SELECT session_id,internal,active_stage_key,modal_call_id FROM jobs WHERE id=?', (job_id,)).fetchone()
    assert row and row['session_id'] == owner and not row['internal'] and row['active_stage_key'] is None and row['modal_call_id'] is None
source = config.UPLOADS_DIR / str(job_id) / 'learning-tone.wav'
assert not source.is_symlink()
if source.exists():
    assert hashlib.sha256(source.read_bytes()).hexdigest() == digest
`, String(item.id), item.digest, item.owner], { cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! } });
    const deleted = await page.request.delete(`/api/jobs/${item.id}`, { headers: { Origin: process.env.E2E_BASE_URL! } });
    expect(deleted.status()).toBe(204);
    execFileSync('uv', ['run', 'python', '-c', String.raw`
import os, re, sys
from pathlib import Path
from backend import auth_store, cache_catalog, config, db as jobs_db
digest, owner = sys.argv[1:]
assert config.QUEUE_CONCURRENCY == 0 and config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
assert re.fullmatch(r'[0-9a-f]{64}', digest)
principal = auth_store.authenticate(os.environ['E2E_AUTH_SESSION'])
assert principal and principal.id == owner
with jobs_db._session() as db:
    db.execute('DELETE FROM learning_progress WHERE principal_id=? AND source_digest=?', (owner, digest))
with cache_catalog._connection() as db:
    associations = cache_catalog._associations(db)
    own = {path for source, path in associations if source == digest}
    assert not any(source != digest and path in own for source, path in associations), 'Shared cache artifact; refusing cleanup'
    assert all((parent in own) == (child in own) for parent, child in db.execute('SELECT parent,child FROM dependencies')), 'Shared cache dependency; refusing cleanup'
    for path in own:
        assert cache_catalog._allowed(path)
        target = config.DATA_DIR / 'artifacts' / path
        if target.exists() or target.is_symlink():
            assert cache_catalog._safe_file(target)
    for path in own:
        target = config.DATA_DIR / 'artifacts' / path
        target.unlink(missing_ok=True)
        db.execute('DELETE FROM dependencies WHERE parent=? OR child=?', (path,path))
        db.execute('DELETE FROM complete_paths WHERE path=?', (path,))
        db.execute('DELETE FROM source_fingerprints WHERE path=?', (path,))
    db.execute('DELETE FROM paths WHERE digest=?', (digest,))
    db.execute('DELETE FROM retained_songs WHERE digest=?', (digest,))
    db.execute('DELETE FROM songs WHERE digest=?', (digest,))
`, item.digest, item.owner], { cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! } });
  }
  owned.delete(page);
}

const publish = String.raw`
import os, sys
from pathlib import Path
from backend import config, db
from backend.queue import _persist_results
from separator.lyrics import transcript_from_json
from separator.stems import StemResult
assert config.QUEUE_CONCURRENCY == 0
assert config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
job = db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'queued' and job.modal_call_id is None
source = (config.UPLOADS_DIR / str(job.id) / job.source_value).read_bytes()
manifest = _persist_results(job, {'song': StemResult(source, 0)})
db.mark_done(job.id, manifest, transcript_from_json(sys.stdin.read()), None)
`;

export async function seedLearning(page: Page, options: { untimed?: boolean; missingOriginal?: boolean } = {}) {
  const source = Buffer.concat([await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav')), randomBytes(16)]);
  const owner = (await (await page.request.get('/api/auth/me')).json()).id as string;
  const response = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
    file: { name: 'learning-tone.wav', mimeType: 'audio/wav', buffer: source }, extract_lyrics: 'true',
  } });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as number;
  const items = owned.get(page) ?? [];
  items.push({ id, digest: createHash('sha256').update(source).digest('hex'), owner });
  owned.set(page, items);
  const transcript = {
    segments: [
      { start_s: 0.2, end_s: 1.1, text: 'Amber lanterns softly shine' },
      { start_s: 1.2, end_s: 2.1, text: 'Silver branches gently sway' },
      { start_s: 2.2, end_s: 3.2, text: 'Golden rivers carry dreams' },
    ],
    language: 'English', timestamp_reference: 'original',
    sections: [{ start_s: 0.2, end_s: 2.1, label: 'verse' }, { start_s: 2.2, end_s: 3.5, label: 'chorus' }],
    structure_model: null, asr_model: 'synthetic', word_alignment: null, words: [],
    untimed: options.untimed ? [{ text: 'Unplaced moonlight', reason: 'No alignment' }] : [],
  };
  execFileSync('uv', ['run', 'python', '-c', publish, String(id)], {
    cwd: process.env.E2E_REPO_ROOT!, input: JSON.stringify(transcript),
    env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
  });
  const sourcePath = resolve(process.env.E2E_DATA_DIR!, 'uploads', String(id), 'learning-tone.wav');
  if (options.missingOriginal) await unlink(sourcePath);
  await page.goto('/');
  await page.reload();
  const trigger = page.getByRole('button', { name: 'Learn lyrics', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Learn lyrics', exact: true });
  await expect(dialog.getByText('Full lyrics', { exact: true })).toBeVisible();
  return { id, dialog, trigger, sourcePath };
}
