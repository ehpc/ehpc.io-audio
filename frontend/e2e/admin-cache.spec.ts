import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { authenticateOutsider, test } from './auth-fixture';
import { cleanupRegenerationFixtures, seedAdditionalSilverArtifact, seedCachedSongs, seedRegenerationCandidates, setRegenerationFixtureStatus } from './cache-fixture';

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`admin cache management ${viewport.width}`, async ({ page, browser }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const headers = { Origin: process.env.E2E_BASE_URL! };
    const reset = await page.request.post('/api/admin/cache/clear', { headers, data: { all: true } });
    expect(reset.ok()).toBe(true);
    seedCachedSongs();

    const outsider = await browser.newContext();
    await authenticateOutsider(outsider);
    const other = await outsider.newPage();
    await other.goto(process.env.E2E_BASE_URL!);
    await expect(other.getByRole('button', { name: 'People', exact: true })).toHaveCount(0);
    expect((await other.request.get('/api/admin/cache')).status()).toBe(403);
    expect((await other.request.post('/api/admin/cache/clear', { headers, data: { all: true } })).status()).toBe(403);
    await outsider.clearCookies();
    expect((await other.request.get('/api/admin/cache')).status()).toBe(401);
    await outsider.close();

    await page.goto('/');
    await page.getByRole('button', { name: 'People', exact: true }).click();
    await page.getByRole('button', { name: 'Manage cached songs' }).click();
    const cache = page.getByRole('region', { name: 'Cached songs' });
    await expect(cache.getByText('Silver harbor')).toBeVisible();
    await expect(cache.getByText('Quiet morning')).toBeVisible();
    await expect(cache.getByText('Distant lights')).toBeVisible();
    await cache.screenshot({ path: info.outputPath(`cache-${viewport.width}.png`) });
    await cache.getByRole('button', { name: 'Clear Silver harbor' }).click();
    let dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Silver harbor');
    await expect(dialog).toContainText('GPU costs');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(cache.getByText('Silver harbor')).toBeVisible();
    seedAdditionalSilverArtifact();
    await cache.getByRole('button', { name: 'Clear Silver harbor' }).click();
    dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Confirm clear' }).click();
    await expect(cache.getByText(/Cleared 2 cache files/)).toBeVisible();
    await expect(cache.getByText('Silver harbor')).toHaveCount(0);
    await expect(cache.getByText('Quiet morning')).toBeVisible();

    await cache.getByRole('checkbox', { name: /Quiet morning/ }).check();
    await cache.getByRole('checkbox', { name: /Distant lights/ }).check();
    await cache.getByRole('button', { name: 'Clear selected (2)' }).click();
    dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('2 selected songs');
    const file = await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
    const queued = await page.request.post('/api/jobs', { headers, multipart: {
      file: { name: 'cache-busy-fixture.wav', mimeType: 'audio/wav', buffer: file },
    } });
    expect(queued.ok()).toBe(true);
    const id = (await queued.json()).id as number;
    await dialog.getByRole('button', { name: 'Confirm clear' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(cache.getByRole('checkbox', { name: /Quiet morning/ })).toBeChecked();
    await expect(cache.getByRole('checkbox', { name: /Distant lights/ })).toBeChecked();
    execFileSync('uv', ['run', 'python', '-c', 'import sys; from backend import db; db.mark_failed(int(sys.argv[1]), "fixture complete")', String(id)], {
      cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    await cache.getByRole('button', { name: 'Clear selected (2)' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm clear' }).click();
    await expect(cache.getByText('No cached songs.')).toBeVisible();
    seedCachedSongs();
    await cache.getByRole('button', { name: 'Refresh cache' }).click();
    await expect(cache.getByText('Silver harbor')).toBeVisible();
    await cache.getByRole('button', { name: 'Clear all cache' }).click();
    dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('3 listed songs');
    await dialog.screenshot({ path: info.outputPath(`cache-confirm-${viewport.width}.png`) });
    await dialog.getByRole('button', { name: 'Confirm clear' }).click();
    await expect(cache.getByText('No cached songs.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('admin regeneration selects an exact source configuration and keeps failures retryable', async ({ page }) => {
  test.setTimeout(120_000);
  const headers = { Origin: process.env.E2E_BASE_URL! };
  cleanupRegenerationFixtures();
  const clearBefore = await page.request.post('/api/admin/cache/clear', { headers, data: { all: true } });
  expect(clearBefore.ok()).toBe(true);
  let unrelatedQueuedJobId: number | null = null;
  try {
    seedCachedSongs();
    const sourceJobs = seedRegenerationCandidates();
    expect(sourceJobs).toHaveLength(2);
    execFileSync('uv', ['run', 'python', '-c', String.raw`
from backend import config
from separator.artifact_cache import cached_bytes, cache_key
assert config.QUEUE_CONCURRENCY == 0
cached_bytes(config.DATA_DIR/'artifacts'/'keys', cache_key('admin-regeneration-unattributed-fixture'), lambda: b'unattributed fixture')
`], { cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! } });
    const audio = await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
    const unrelatedQueued = await page.request.post('/api/jobs', { headers, multipart: {
      file: { name: 'admin-regeneration-busy-fixture.wav', mimeType: 'audio/wav', buffer: audio },
    } });
    expect(unrelatedQueued.ok()).toBe(true);
    unrelatedQueuedJobId = (await unrelatedQueued.json() as { id: number }).id;
    const apiRequests: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/admin/cache')) apiRequests.push(`${request.method()} ${url.pathname}`);
    });
    const initialStatusLoad = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/admin/cache/regenerations');
    await page.goto('/');
    await page.getByRole('button', { name: 'People', exact: true }).click();
    await page.getByRole('button', { name: 'Manage cached songs' }).click();
    await initialStatusLoad;
    const cache = page.getByRole('region', { name: 'Cached songs' });
    await expect(cache.getByText(/Active, queued or unresolved work/)).toBeVisible();
    await expect(cache.getByText(/older cache data cannot be attributed/)).toBeVisible();
    await expect(cache.getByRole('button', { name: 'Clear selected (0)' })).toBeDisabled();
    await expect(cache.getByRole('button', { name: 'Clear all cache' })).toBeDisabled();
    const silver = cache.getByRole('checkbox', { name: /Silver harbor/ });
    await silver.check();
    await cache.getByRole('checkbox', { name: /Quiet morning/ }).check();
    await expect(cache.getByRole('button', { name: 'Clear selected (2)' })).toBeDisabled();
    await expect(cache.getByRole('button', { name: 'Regenerate selected (2)' })).toBeEnabled();
    await cache.getByRole('button', { name: 'Regenerate selected (2)' }).click();

    let dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Silver harbor');
    await expect(dialog).toContainText('Quiet morning');
    await expect(dialog).toContainText('No completed job with a verified saved original is available.');
    await expect(dialog).toContainText('original owners’ Library');
    await expect(dialog).toContainText('existing jobs and downloads stay');
    await expect(dialog).toContainText('GPU costs');
    const firstChoice = dialog.getByRole('checkbox', { name: new RegExp(`job ${sourceJobs[0]}:`) });
    const secondChoice = dialog.getByRole('checkbox', { name: new RegExp(`job ${sourceJobs[1]}:`) });
    await expect(firstChoice).not.toBeChecked();
    await expect(secondChoice).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Queue regeneration' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(apiRequests.filter(request => request === 'POST /api/admin/cache/regenerate')).toHaveLength(0);

    await cache.getByRole('button', { name: 'Regenerate selected (2)' }).click();
    dialog = page.getByRole('alertdialog');
    await dialog.getByRole('checkbox', { name: new RegExp(`job ${sourceJobs[0]}:`) }).check();
    const queue = dialog.getByRole('button', { name: 'Queue regeneration' });
    await expect(queue).toBeEnabled();
    const cacheLoad = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/admin/cache');
    const firstPost = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/admin/cache/regenerate');
    await queue.click();
    const firstResponse = await firstPost;
    await cacheLoad;
    expect(firstResponse.ok()).toBe(true);
    const firstRecord = (await firstResponse.json()).jobs[0] as { job_id: number; source_job_id: number; status: string; position: number | null };
    expect(firstRecord.source_job_id).toBe(sourceJobs[0]);
    expect(['queued', 'running', 'done']).toContain(firstRecord.status);
    await expect(dialog).toHaveCount(0);
    const activity = page.getByRole('region', { name: 'Regeneration status' });
    await expect(activity.getByText(new RegExp(`Job #${firstRecord.job_id}`))).toBeVisible();
    await expect(activity.getByText(/Queued|Running|Completed/)).toBeVisible();
    if (firstRecord.position !== null) await expect(activity.getByText(new RegExp(`position ${firstRecord.position}`))).toBeVisible();
    await expect(cache.getByRole('button', { name: 'Refresh cache' })).toBeEnabled();

    const statusReadsBeforePoll = apiRequests.filter(request => request === 'GET /api/admin/cache/regenerations').length;
    const cacheReadsBeforePoll = apiRequests.filter(request => request === 'GET /api/admin/cache').length;
    await expect.poll(
      () => apiRequests.filter(request => request === 'GET /api/admin/cache/regenerations').length,
      { timeout: 6_000 },
    ).toBeGreaterThan(statusReadsBeforePoll);
    expect(apiRequests.filter(request => request === 'GET /api/admin/cache')).toHaveLength(cacheReadsBeforePoll);

    await page.reload();
    await page.getByRole('button', { name: 'People', exact: true }).click();
    await page.getByRole('button', { name: 'Manage cached songs' }).click();
    const persisted = page.getByRole('region', { name: 'Regeneration status' });
    await expect(persisted.getByText(new RegExp(`Job #${firstRecord.job_id}`))).toBeVisible();
    await expect(persisted.getByText(/Queued|Running/)).toBeVisible();

    await page.getByRole('region', { name: 'Cached songs' })
      .getByRole('button', { name: 'Regenerate Silver harbor' }).click();
    dialog = page.getByRole('alertdialog');
    await dialog.getByRole('checkbox', { name: new RegExp(`job ${sourceJobs[0]}:`) }).check();
    const conflictPost = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/admin/cache/regenerate');
    await dialog.getByRole('button', { name: 'Queue regeneration' }).click();
    expect((await conflictPost).status()).toBe(409);
    await expect(dialog.getByRole('alert')).not.toBeEmpty();
    await expect(dialog.getByRole('checkbox', { name: new RegExp(`job ${sourceJobs[0]}:`) })).toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Queue regeneration' })).toBeEnabled();

    const cacheReadsBeforeTerminal = apiRequests.filter(request => request === 'GET /api/admin/cache').length;
    setRegenerationFixtureStatus(firstRecord.job_id, 'done');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(activity.getByText(/Completed/)).toBeVisible({ timeout: 10_000 });
    await expect.poll(
      () => apiRequests.filter(request => request === 'GET /api/admin/cache').length,
      { timeout: 10_000 },
    ).toBe(cacheReadsBeforeTerminal + 1);
    await expect(cache.getByRole('button', { name: 'Clear all cache' })).toBeDisabled();
    await page.getByRole('region', { name: 'Cached songs' })
      .getByRole('button', { name: 'Regenerate Silver harbor' }).click();
    dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('checkbox', { name: new RegExp(`job ${firstRecord.job_id}:`) })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('region', { name: 'Cached songs' })
      .getByRole('button', { name: 'Regenerate Silver harbor' }).click();
    dialog = page.getByRole('alertdialog');
    await dialog.getByRole('checkbox', { name: new RegExp(`job ${sourceJobs[1]}:`) }).check();
    const secondPost = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/admin/cache/regenerate');
    await dialog.getByRole('button', { name: 'Queue regeneration' }).click();
    const secondResponse = await secondPost;
    expect(secondResponse.ok()).toBe(true);
    const secondRecord = (await secondResponse.json()).jobs[0] as { job_id: number; source_job_id: number };
    expect(secondRecord.source_job_id).toBe(sourceJobs[1]);
    setRegenerationFixtureStatus(secondRecord.job_id, 'failed');
    const failedStatusRefresh = page.getByRole('region', { name: 'Regeneration status' })
      .getByRole('button', { name: 'Refresh regeneration status' });
    await expect(failedStatusRefresh).toBeEnabled();
    await failedStatusRefresh.click();
    await expect(page.getByRole('region', { name: 'Regeneration status' }).getByRole('alert'))
      .toContainText('Synthetic fixture failure');
    const adminCache = await page.request.get('/api/admin/cache');
    const cacheSnapshot = await adminCache.json();
    const retainedCandidates = cacheSnapshot.songs.find((song: { title: string | null }) => song.title === 'Silver harbor').candidates;
    expect(retainedCandidates.map((candidate: { job_id: number }) => candidate.job_id)).toEqual(expect.arrayContaining(sourceJobs));
  } finally {
    try {
      if (unrelatedQueuedJobId !== null) {
        execFileSync('uv', ['run', 'python', '-c', String.raw`
import shutil, sys
from backend import config, db
job = int(sys.argv[1])
db.mark_failed(job, 'fixture cleanup')
with db._session() as conn:
    conn.execute('DELETE FROM jobs WHERE id=?', (job,))
for root in (config.UPLOADS_DIR, config.RESULTS_DIR):
    shutil.rmtree(root / str(job), ignore_errors=True)
(config.DATA_DIR / 'source-metadata' / f'{job}.json').unlink(missing_ok=True)
`, String(unrelatedQueuedJobId)], { cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! } });
      }
    } finally {
      try {
        cleanupRegenerationFixtures();
      } finally {
        const clearAfter = await page.request.post('/api/admin/cache/clear', { headers, data: { all: true } });
        expect(clearAfter.ok()).toBe(true);
      }
    }
  }
});

test('late pre-enqueue regeneration status cannot hide a newly queued job', async ({ page }) => {
  test.setTimeout(60_000);
  const headers = { Origin: process.env.E2E_BASE_URL! };
  const statusRoute = '**/api/admin/cache/regenerations';
  cleanupRegenerationFixtures();
  const clearBefore = await page.request.post('/api/admin/cache/clear', { headers, data: { all: true } });
  expect(clearBefore.ok()).toBe(true);
  let releaseStatusResponse = () => {};
  let statusResponseReceived = () => {};
  const statusResponseReady = new Promise<void>(resolve => { statusResponseReceived = resolve; });
  const responseGate = new Promise<void>(resolve => { releaseStatusResponse = resolve; });
  let held = false;
  await page.route(statusRoute, async route => {
    const response = await route.fetch();
    if (!held) {
      held = true;
      statusResponseReceived();
      await responseGate;
    }
    await route.fulfill({ response });
  });
  try {
    seedCachedSongs();
    const sourceJobs = seedRegenerationCandidates();
    await page.goto('/');
    await page.getByRole('button', { name: 'People', exact: true }).click();
    await page.getByRole('button', { name: 'Manage cached songs' }).click();
    await statusResponseReady;
    const cache = page.getByRole('region', { name: 'Cached songs' });
    await cache.getByRole('button', { name: 'Regenerate Silver harbor' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('checkbox', { name: new RegExp(`job ${sourceJobs[0]}:`) }).check();
    const post = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/admin/cache/regenerate');
    await dialog.getByRole('button', { name: 'Queue regeneration' }).click();
    const response = await post;
    expect(response.ok()).toBe(true);
    const created = (await response.json()).jobs[0] as { job_id: number; source_job_id: number };
    expect(created.source_job_id).toBe(sourceJobs[0]);
    const activity = page.getByRole('region', { name: 'Regeneration status' });
    const jobLabel = new RegExp(`Job #${created.job_id}`);
    await expect(activity.getByText(jobLabel)).toBeVisible();
    releaseStatusResponse();
    await expect(activity.getByRole('button', { name: 'Refresh regeneration status' })).toBeEnabled();
    await expect(activity.getByText(jobLabel)).toBeVisible();
    await expect(activity.getByText(/Queued/)).toBeVisible();
  } finally {
    releaseStatusResponse();
    await page.unroute(statusRoute);
    try {
      cleanupRegenerationFixtures();
    } finally {
      const clearAfter = await page.request.post('/api/admin/cache/clear', { headers, data: { all: true } });
      expect(clearAfter.ok()).toBe(true);
    }
  }
});
