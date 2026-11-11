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
