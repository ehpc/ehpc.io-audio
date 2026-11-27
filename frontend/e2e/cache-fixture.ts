import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

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

// Fixtures are real completed jobs and saved outputs inside the isolated CPU
// backend. The runner keeps inference disabled; status transitions are seeded.
export type SongRegenerationFixture = {
  songId: string;
  sourceSongIds: number[];
  sourceJobIds: number[];
  title: string;
  sourceDigest: string;
  cachePaths: string[];
};

// Creates two real completed source jobs owned by the isolated admin and
// outsider accounts. No inference worker is started.
export function seedSongRegenerationFixture(): SongRegenerationFixture {
  if (!process.env.E2E_DATA_DIR || !process.env.E2E_REPO_ROOT) throw new Error('Isolated E2E data directory required.');
  const cacheIdentity = randomBytes(16).toString('hex');
  const output = execFileSync('uv', ['run', 'python', '-c', String.raw`
import hashlib, json, os, sys
from backend import auth_store, cache_catalog, config, db
from backend.models import ResultManifestEntry
from separator.artifact_cache import cached_bytes, cache_key
from separator.options import SeparationOptions
assert config.QUEUE_CONCURRENCY == 0
owners = [
    auth_store.authenticate(os.environ['E2E_AUTH_SESSION']),
    auth_store.authenticate(os.environ['E2E_AUTH_OUTSIDER_SESSION']),
]
assert all(owners)
audio = b'synthetic regeneration source ' + sys.argv[1].encode()
title = 'In-place fixture song'
cache_name = cache_key('song-regeneration-ui-fixture', sys.argv[1])
with cache_catalog.capture() as recorder:
    recorder.bind(audio, title, 'Fixture artist')
    cached_bytes(config.DATA_DIR/'artifacts'/'keys', cache_name, lambda: b'fixture cached stage')
source_digest = hashlib.sha256(audio).hexdigest()
with cache_catalog._connection() as conn:
    song_id = conn.execute('SELECT id FROM songs WHERE digest=?', (source_digest,)).fetchone()[0]
source_jobs = []
source_songs = []
options_list = [
    SeparationOptions(detect_pitch=True),
    SeparationOptions(extract_vocals=True, pitch_semitones=2, tempo_percent=90),
]
for index, (owner, options) in enumerate(zip(owners, options_list, strict=True)):
    filename = f'regeneration-fixture-{index}.wav'
    library_song_id, job_id = db.insert_job(owner.id, 'upload', filename, options, source_digest=source_digest)
    assert job_id is not None
    source_songs.append(library_song_id)
    upload = config.UPLOADS_DIR / str(job_id)
    upload.mkdir(parents=True)
    (upload / filename).write_bytes(audio)
    db.set_title(job_id, title)
    old_result = f'old-result-{index}'.encode()
    result_dir = config.RESULTS_DIR / str(job_id)
    result_dir.mkdir(parents=True)
    (result_dir / 'Vocals.wav').write_bytes(old_result)
    db.mark_done(job_id, [ResultManifestEntry(
        label='Vocals', filename='Vocals.wav', size_bytes=len(old_result),
        duration_s=1.0, download_name='Vocals.wav', display_name='Vocals',
    )])
    source_jobs.append(job_id)
print(json.dumps({
    'songId': song_id, 'sourceJobIds': source_jobs, 'sourceSongIds': source_songs, 'title': title,
    'sourceDigest': source_digest, 'cachePaths': [f'keys/{cache_name}.bin'],
}))
` , cacheIdentity], { cwd: process.env.E2E_REPO_ROOT, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR } });
  return JSON.parse(output.toString()) as SongRegenerationFixture;
}

export function setSongRegenerationFixtureStatus(operationId: number, status: 'running' | 'done' | 'failed') {
  if (!process.env.E2E_DATA_DIR || !process.env.E2E_REPO_ROOT) throw new Error('Isolated E2E data directory required.');
  execFileSync('uv', ['run', 'python', '-c', String.raw`
import sys
from backend import config, db
from backend.models import ResultManifestEntry
assert config.QUEUE_CONCURRENCY == 0
operation_id = int(sys.argv[1])
status = sys.argv[2]
with db._session() as conn:
    items = conn.execute(
        'SELECT original_job_id,work_job_id FROM song_regeneration_items WHERE operation_id=? ORDER BY original_job_id',
        (operation_id,),
    ).fetchall()
    assert items
    if status == 'running':
        conn.execute("UPDATE song_regeneration_operations SET status='running' WHERE id=?", (operation_id,))
        conn.execute("UPDATE song_regeneration_items SET state='running' WHERE operation_id=?", (operation_id,))
        conn.executemany("UPDATE jobs SET status='running' WHERE id=?", ((item['work_job_id'],) for item in items))
    elif status == 'failed':
        conn.execute("UPDATE song_regeneration_operations SET status='failed',error_message='Synthetic regeneration failure' WHERE id=?", (operation_id,))
        conn.execute("UPDATE song_regeneration_items SET state='failed' WHERE operation_id=?", (operation_id,))
        conn.executemany("UPDATE jobs SET status='failed',error_message='Synthetic regeneration failure' WHERE id=?", ((item['work_job_id'],) for item in items))
    else:
        conn.execute("UPDATE song_regeneration_operations SET status='running' WHERE id=?", (operation_id,))
        conn.execute("UPDATE song_regeneration_items SET state='running' WHERE operation_id=?", (operation_id,))
        conn.executemany("UPDATE jobs SET status='done' WHERE id=?", ((item['work_job_id'],) for item in items))
for index, item in enumerate(items):
    if status != 'done':
        continue
    original_id, work_id = item['original_job_id'], item['work_job_id']
    original = db.get_job(original_id)
    assert original
    generation = f'e2e-regeneration-{operation_id}-{original_id}'
    output = f'regenerated-result-{index}'.encode()
    directory = config.RESULTS_DIR / str(original_id) / 'generations' / generation
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'Vocals.wav').write_bytes(output)
    manifest = [ResultManifestEntry(
        label='Vocals', filename='Vocals.wav', size_bytes=len(output),
        duration_s=1.0, download_name='Vocals.wav', display_name='Vocals',
    )]
    db.publish_regeneration(
        work_id, original_id, generation, manifest,
        original.transcript, original.pitch_json, original.original_key,
    )
` , String(operationId), status], { cwd: process.env.E2E_REPO_ROOT, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR } });
}

export function cleanupSongRegenerationFixture(fixture: SongRegenerationFixture) {
  if (!process.env.E2E_DATA_DIR || !process.env.E2E_REPO_ROOT) throw new Error('Isolated E2E data directory required.');
  execFileSync('uv', ['run', 'python', '-c', String.raw`
import json, os, re, shutil, sys
from backend import auth_store, cache_catalog, config, db
assert config.QUEUE_CONCURRENCY == 0
fixture = json.loads(sys.argv[1])
source_ids = fixture['sourceJobIds']
assert len(source_ids) == 2 and len(set(source_ids)) == 2
assert all(type(value) is int and value > 0 for value in source_ids)
digest = fixture['sourceDigest']
assert re.fullmatch(r'[0-9a-f]{64}', digest)
paths = fixture['cachePaths']
assert len(paths) == 1 and re.fullmatch(r'keys/[0-9a-f]{64}\.bin', paths[0])
owners = [
    auth_store.authenticate(os.environ['E2E_AUTH_SESSION']),
    auth_store.authenticate(os.environ['E2E_AUTH_OUTSIDER_SESSION']),
]
assert all(owners)
with db._session() as conn:
    conn.execute('BEGIN IMMEDIATE')
    marks = ','.join('?' for _ in source_ids)
    sources = conn.execute(
        f'SELECT id,session_id,internal,active_stage_key,modal_call_id FROM jobs WHERE id IN ({marks})',
        source_ids,
    ).fetchall()
    assert {row['id'] for row in sources} == set(source_ids)
    assert {row['session_id'] for row in sources} == {owner.id for owner in owners}
    assert all(not row['internal'] and row['active_stage_key'] is None and row['modal_call_id'] is None for row in sources)
    operations = conn.execute(
        f'SELECT DISTINCT o.id,o.song_id FROM song_regeneration_operations o '
        f'JOIN song_regeneration_items i ON i.operation_id=o.id WHERE i.original_job_id IN ({marks})',
        source_ids,
    ).fetchall()
    assert all(row['song_id'] == fixture['songId'] for row in operations)
    operation_ids = [row['id'] for row in operations]
    work_ids = []
    for operation_id in operation_ids:
        items = conn.execute(
            'SELECT i.original_job_id,j.id,j.internal,j.session_id,j.active_stage_key,j.modal_call_id '
            'FROM song_regeneration_items i JOIN jobs j ON j.id=i.work_job_id WHERE i.operation_id=?',
            (operation_id,),
        ).fetchall()
        assert items and all(row['original_job_id'] in source_ids for row in items)
        assert all(row['internal'] == 1 and row['session_id'] == 'internal:song-regeneration' and row['active_stage_key'] is None and row['modal_call_id'] is None for row in items)
        work_ids.extend(row['id'] for row in items)
    job_ids = source_ids + work_ids
    conn.executemany('DELETE FROM song_regeneration_items WHERE operation_id=?', ((value,) for value in operation_ids))
    conn.executemany('DELETE FROM song_regeneration_operations WHERE id=?', ((value,) for value in operation_ids))
    conn.executemany('DELETE FROM job_source_snapshots WHERE job_id=?', ((value,) for value in job_ids))
    song_ids = [row['song_id'] for row in conn.execute(
        f'SELECT song_id FROM library_song_jobs WHERE job_id IN ({marks})', source_ids)]
    assert len(song_ids) == len(source_ids)
    conn.executemany('DELETE FROM library_song_jobs WHERE job_id=?', ((value,) for value in job_ids))
    conn.executemany('DELETE FROM library_song_sources WHERE song_id=?', ((value,) for value in song_ids))
    conn.executemany('DELETE FROM library_songs WHERE id=?', ((value,) for value in song_ids))
    conn.executemany('DELETE FROM jobs WHERE id=?', ((value,) for value in job_ids))
with cache_catalog._connection() as conn:
    song = conn.execute('SELECT digest FROM songs WHERE id=?', (fixture['songId'],)).fetchone()
    assert song is None or song[0] == digest
    for relative in paths:
        assert not conn.execute('SELECT 1 FROM paths WHERE path=? AND digest!=?', (relative,digest)).fetchone()
        assert not conn.execute('SELECT 1 FROM dependencies WHERE parent=? OR child=?', (relative,relative)).fetchone()
        conn.execute('DELETE FROM paths WHERE digest=? AND path=?', (digest,relative))
        conn.execute('DELETE FROM complete_paths WHERE path=?', (relative,))
        conn.execute('DELETE FROM source_fingerprints WHERE path=?', (relative,))
    assert not conn.execute('SELECT 1 FROM paths WHERE digest=?', (digest,)).fetchone()
    conn.execute('DELETE FROM retained_songs WHERE digest=?', (digest,))
    conn.execute('DELETE FROM songs WHERE id=? AND digest=?', (fixture['songId'],digest))
for relative in paths:
    target = config.DATA_DIR / 'artifacts' / relative
    for path in (target, target.with_suffix('.lock')):
        if path.is_symlink():
            raise RuntimeError('Refusing to remove a symlinked fixture cache artifact')
        path.unlink(missing_ok=True)
for job_id in job_ids:
    for root in (config.UPLOADS_DIR, config.RESULTS_DIR):
        target = root / str(job_id)
        if target.is_symlink():
            raise RuntimeError('Refusing to remove a symlinked fixture directory')
        if target.exists():
            shutil.rmtree(target)
    (config.DATA_DIR / 'source-metadata' / f'{job_id}.json').unlink(missing_ok=True)
` , JSON.stringify(fixture)], { cwd: process.env.E2E_REPO_ROOT, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR } });
}
