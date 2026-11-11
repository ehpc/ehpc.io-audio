import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { authenticateOutsider, test } from './auth-fixture';
import { seedAdditionalSilverArtifact, seedCachedSongs } from './cache-fixture';

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
