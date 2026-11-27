import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { authenticateOutsider, test } from './auth-fixture';
import { cleanupSongRegenerationFixture, seedSongRegenerationFixture, seedAdditionalSilverArtifact, seedCachedSongs, setSongRegenerationFixtureStatus } from './cache-fixture';

const libraryJobIds = async (request: { get(url: string): Promise<{ ok(): boolean; json(): Promise<unknown> }> }) => {
  const response = await request.get('/api/songs');
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: number }[]).map(job => job.id).sort((a, b) => a - b);
};
const resultText = async (request: { get(url: string): Promise<{ status(): number; text(): Promise<string> }> }, id: number) => {
  const response = await request.get(`/api/jobs/${id}/results/Vocals`);
  expect(response.status()).toBe(200);
  return response.text();
};

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
    await expect(other.getByRole('button', { name: 'Admin', exact: true })).toHaveCount(0);
    expect((await other.request.get('/api/admin/cache')).status()).toBe(403);
    expect((await other.request.post('/api/admin/cache/clear', { headers, data: { all: true } })).status()).toBe(403);
    await outsider.clearCookies();
    expect((await other.request.get('/api/admin/cache')).status()).toBe(401);
    await outsider.close();

    await page.goto('/');
    const accountAdmin = page.getByRole('button', { name: 'Admin', exact: true });
    const workspace = page.getByRole('button', { name: 'Workspace', exact: true });
    await expect(workspace).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(0, 0);
    const selectedBackground = await workspace.evaluate(element => getComputedStyle(element).backgroundColor);
    const unselectedBackground = await accountAdmin.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(selectedBackground).not.toBe(unselectedBackground);
    await accountAdmin.click();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    const people = page.getByRole('button', { name: 'People', exact: true });
    const cached = page.getByRole('button', { name: 'Cached songs', exact: true });
    await page.mouse.move(0, 0);
    await expect(accountAdmin).toHaveAttribute('aria-pressed', 'true');
    await expect(workspace).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => accountAdmin.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(selectedBackground);
    await expect.poll(() => workspace.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(unselectedBackground);
    await expect(people).toHaveAttribute('aria-pressed', 'true');
    await expect(cached).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => people.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(selectedBackground);
    await expect.poll(() => cached.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(unselectedBackground);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`admin-people-header-${viewport.width}.png`), animations: 'disabled' });
    await cached.click();
    const cache = page.getByRole('region', { name: 'Cached songs' });
    await expect(cache.getByText('Silver harbor')).toBeVisible();
    await expect(cache.getByText('Quiet morning')).toBeVisible();
    await expect(cache.getByText('Distant lights')).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(cached).toHaveAttribute('aria-pressed', 'true');
    await expect(people).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => cached.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(selectedBackground);
    await expect.poll(() => people.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(unselectedBackground);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`admin-cache-header-${viewport.width}.png`), animations: 'disabled' });
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
    let busySongId: number | undefined;
    let busyWorkId: number | undefined;
    try {
      const queued = await page.request.post('/api/jobs', { headers, multipart: {
        file: { name: 'cache-busy-fixture.wav', mimeType: 'audio/wav', buffer: Buffer.concat([file, Buffer.from(`cache-${viewport.width}`)]) },
      } });
      expect(queued.ok()).toBe(true);
      const created = await queued.json() as { song_id: number; work_id: number };
      busySongId = created.song_id;
      busyWorkId = created.work_id;
      await dialog.getByRole('button', { name: 'Confirm clear' }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(cache.getByRole('checkbox', { name: /Quiet morning/ })).toBeChecked();
      await expect(cache.getByRole('checkbox', { name: /Distant lights/ })).toBeChecked();
      execFileSync('uv', ['run', 'python', '-c', 'import sys; from backend import db; db.mark_failed(int(sys.argv[1]), "fixture complete")', String(busyWorkId)], {
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
    } finally {
      if (busySongId !== undefined && busyWorkId !== undefined) {
        execFileSync('uv', ['run', 'python', '-c', String.raw`
import os, sys
from backend import auth_store, config, db
from backend.routes.jobs import _remove_job_files
assert config.QUEUE_CONCURRENCY == 0
song_id, work_id = map(int, sys.argv[1:])
owner = auth_store.authenticate(os.environ["E2E_AUTH_SESSION"])
assert owner is not None and song_id > 0 and work_id > 0
with db._session() as conn:
    conn.execute("BEGIN IMMEDIATE")
    rows = conn.execute(
        "SELECT j.id,j.session_id,j.source_value,j.internal,j.active_stage_key,j.modal_call_id "
        "FROM library_song_jobs m JOIN jobs j ON j.id=m.job_id WHERE m.song_id=?", (song_id,),
    ).fetchall()
    assert len(rows) == 1
    job = rows[0]
    assert job["id"] == work_id and job["session_id"] == owner.id
    assert job["source_value"] == "cache-busy-fixture.wav" and not job["internal"]
    assert job["active_stage_key"] is None and job["modal_call_id"] is None
    _remove_job_files(work_id)
    conn.execute("DELETE FROM job_source_snapshots WHERE job_id=?", (work_id,))
    conn.execute("DELETE FROM library_song_sources WHERE song_id=?", (song_id,))
    conn.execute("DELETE FROM library_song_jobs WHERE song_id=?", (song_id,))
    conn.execute("DELETE FROM library_songs WHERE id=? AND session_id=?", (song_id, owner.id))
    conn.execute("DELETE FROM jobs WHERE id=? AND session_id=?", (work_id, owner.id))
`, String(busySongId), String(busyWorkId)], {
          cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
        });
      }
    }
  });
}

test('song regeneration preserves both owners’ Library entries and replaces results in place', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const fixture = seedSongRegenerationFixture();
  const outsider = await browser.newContext();
  await authenticateOutsider(outsider);
  const otherOwner = await outsider.newPage();
  await otherOwner.goto(process.env.E2E_BASE_URL!);
  try {
    await page.goto('/');
    const adminIdsBefore = await libraryJobIds(page.request);
    const outsiderIdsBefore = await libraryJobIds(otherOwner.request);
    expect(adminIdsBefore).toContain(fixture.sourceSongIds[0]);
    expect(outsiderIdsBefore).toContain(fixture.sourceSongIds[1]);
    expect(await resultText(page.request, fixture.sourceJobIds[0])).toContain('old-result-0');
    expect(await resultText(otherOwner.request, fixture.sourceJobIds[1])).toContain('old-result-1');

    const submitted: unknown[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin/cache/regenerate') {
        submitted.push(request.postDataJSON());
      }
    });
    let rejectFirst = true;
    await page.route('**/api/admin/cache/regenerate', async route => {
      if (rejectFirst) {
        rejectFirst = false;
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Another regeneration is active. Retry this operation.' }),
        });
      } else {
        await route.continue();
      }
    });
    await page.getByRole('button', { name: 'Admin', exact: true }).click();
    await page.getByRole('button', { name: 'Cached songs', exact: true }).click();
    const cache = page.getByRole('region', { name: 'Cached songs' });
    await expect(cache.getByRole('button', { name: `Regenerate ${fixture.title}` })).toBeVisible();
    await expect(cache.getByText('2 saved job variants will be regenerated.')).toBeVisible();
    await cache.getByRole('button', { name: `Regenerate ${fixture.title}` }).click();
    let dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('all owners and settings');
    await expect(dialog).toContainText('same Library entry is updated without duplicates');
    await expect(dialog).toContainText('Existing results remain available until their replacement is published');
    await expect(dialog).toContainText('GPU costs');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(submitted).toHaveLength(0);
    await expect(cache.getByText(fixture.title)).toBeVisible();
    expect(await resultText(page.request, fixture.sourceJobIds[0])).toContain('old-result-0');

    await cache.getByRole('button', { name: `Regenerate ${fixture.title}` }).click();
    dialog = page.getByRole('alertdialog');
    const submit = dialog.getByRole('button', { name: 'Clear cache and regenerate' });
    const conflict = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/admin/cache/regenerate');
    await submit.click();
    expect((await conflict).status()).toBe(409);
    await expect(dialog.getByRole('alert')).toContainText('Another regeneration is active');
    await expect(submit).toBeEnabled();

    const queuedResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/admin/cache/regenerate');
    await submit.click();
    const accepted = await queuedResponse;
    expect(accepted.status()).toBe(200);
    expect(submitted).toEqual([{ ids: [fixture.songId] }, { ids: [fixture.songId] }]);
    const operation = (await accepted.json() as { operations: { operation_id: number; song_id: string; status: string; total_jobs: number }[] }).operations[0]!;
    expect(operation.song_id).toBe(fixture.songId);
    expect(operation.status).toBe('queued');
    expect(operation.total_jobs).toBe(2);
    await expect(dialog).toHaveCount(0);
    const activity = page.getByRole('region', { name: 'Regeneration status' });
    await expect(activity.getByText('Queued', { exact: true })).toBeVisible();
    expect(await libraryJobIds(page.request)).toEqual(adminIdsBefore);
    expect(await libraryJobIds(otherOwner.request)).toEqual(outsiderIdsBefore);
    expect(await resultText(page.request, fixture.sourceJobIds[0])).toContain('old-result-0');
    expect(await resultText(otherOwner.request, fixture.sourceJobIds[1])).toContain('old-result-1');

    setSongRegenerationFixtureStatus(operation.operation_id, 'running');
    await activity.getByRole('button', { name: 'Refresh regeneration status' }).click();
    await expect(activity.getByText('Regenerating', { exact: true })).toBeVisible();
    await expect(activity.getByText('0 of 2 saved job variants completed.')).toBeVisible();
    expect(await resultText(page.request, fixture.sourceJobIds[0])).toContain('old-result-0');

    setSongRegenerationFixtureStatus(operation.operation_id, 'done');
    const cacheRefresh = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/admin/cache');
    await activity.getByRole('button', { name: 'Refresh regeneration status' }).click();
    await cacheRefresh;
    await expect(activity.getByText('Completed', { exact: true })).toBeVisible();
    await expect(activity.getByText('2 of 2 saved job variants completed.')).toBeVisible();
    expect(await libraryJobIds(page.request)).toEqual(adminIdsBefore);
    expect(await libraryJobIds(otherOwner.request)).toEqual(outsiderIdsBefore);
    expect(await resultText(page.request, fixture.sourceJobIds[0])).toContain('regenerated-result-0');
    expect(await resultText(otherOwner.request, fixture.sourceJobIds[1])).toContain('regenerated-result-1');
    const updatedAdmin = (await (await page.request.get(`/api/jobs/${fixture.sourceJobIds[0]}`)).json()) as { result_revision: string | null };
    const updatedOther = (await (await otherOwner.request.get(`/api/jobs/${fixture.sourceJobIds[1]}`)).json()) as { result_revision: string | null };
    expect(updatedAdmin.result_revision).toMatch(/^e2e-regeneration-/);
    expect(updatedOther.result_revision).toMatch(/^e2e-regeneration-/);
  } finally {
    await outsider.close();
    cleanupSongRegenerationFixture(fixture);
  }
});

test('failed song regeneration keeps each existing result available and reports retryable status', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const fixture = seedSongRegenerationFixture();
  const outsider = await browser.newContext();
  await authenticateOutsider(outsider);
  const otherOwner = await outsider.newPage();
  await otherOwner.goto(process.env.E2E_BASE_URL!);
  try {
    await page.goto('/');
    const adminIdsBefore = await libraryJobIds(page.request);
    const outsiderIdsBefore = await libraryJobIds(otherOwner.request);
    await page.getByRole('button', { name: 'Admin', exact: true }).click();
    await page.getByRole('button', { name: 'Cached songs', exact: true }).click();
    const cache = page.getByRole('region', { name: 'Cached songs' });
    await cache.getByRole('button', { name: `Regenerate ${fixture.title}` }).click();
    const dialog = page.getByRole('alertdialog');
    const response = page.waitForResponse(item => item.request().method() === 'POST'
      && new URL(item.url()).pathname === '/api/admin/cache/regenerate');
    await dialog.getByRole('button', { name: 'Clear cache and regenerate' }).click();
    const accepted = await response;
    expect(accepted.status()).toBe(200);
    const operation = (await accepted.json() as { operations: { operation_id: number }[] }).operations[0]!;
    setSongRegenerationFixtureStatus(operation.operation_id, 'failed');
    const activity = page.getByRole('region', { name: 'Regeneration status' });
    await activity.getByRole('button', { name: 'Refresh regeneration status' }).click();
    await expect(activity.getByRole('alert')).toContainText('Synthetic regeneration failure');
    await expect(activity.getByText('Failed', { exact: true })).toBeVisible();
    expect(await resultText(page.request, fixture.sourceJobIds[0])).toContain('old-result-0');
    expect(await resultText(otherOwner.request, fixture.sourceJobIds[1])).toContain('old-result-1');
    expect(await libraryJobIds(page.request)).toEqual(adminIdsBefore);
    expect(await libraryJobIds(otherOwner.request)).toEqual(outsiderIdsBefore);
  } finally {
    await outsider.close();
    cleanupSongRegenerationFixture(fixture);
  }
});
