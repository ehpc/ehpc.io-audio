import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test as authenticatedTest } from './auth-fixture';

// These layout cases intercept API traffic and never enqueue a real job.
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`accepted job dock remains usable at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      class ControlledEventSource {
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() { (window as unknown as { jobStream: ControlledEventSource }).jobStream = this; }
        close() {}
      }
      Object.defineProperty(window, 'EventSource', { value: ControlledEventSource, configurable: true });
    });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const data = path === '/api/auth/me' ? { id: 'fixture', email: 'listener@example.test', is_admin: false, invite_limit: 0, invites: [] }
        : path === '/api/jobs/current' ? null
        : path === '/api/jobs' && method === 'POST' ? { id: 42, status: 'queued', position: 2 }
        : path === '/api/jobs' ? []
        : path === '/api/key-analysis' ? { original_key: null } : {};
      await route.fulfill({ json: data });
    });
    await page.goto('/');
    await page.getByLabel('Track URL').fill('https://example.test/song');
    await page.getByRole('button', { name: 'Download song' }).click();
    const dock = page.locator('.job-dock');
    await expect(dock).toContainText('Queued');
    await page.evaluate(() => {
      // The fixture installs this stream in the same page before app startup.
      const fixtureWindow = window as unknown as { jobStream: { onmessage: (event: { data: string }) => void } };
      const stream = fixtureWindow.jobStream;
      stream.onmessage({ data: JSON.stringify({ id: 42, status: 'running', position: null, title: 'A remarkably long title — An artist with an equally long name', source_type: 'url', source_value: 'https://example.test/song', options: { mixes: [], pitch_semitones: 0, tempo_percent: 100 }, manifest: null, transcript: null, pitch: null, error_message: null, created_at: 1700000000 }) });
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    if (viewport.width === 390) {
      await expect.poll(() => page.evaluate(() => {
        const dock = document.querySelector('.job-dock')!.getBoundingClientRect();
        const action = document.querySelector('.workspace-action')!.getBoundingClientRect();
        return dock.bottom <= action.top;
      })).toBe(true);
    }
    await expect(dock).toContainText('Processing audio');
    const geometry = await page.evaluate(() => {
      const dock = document.querySelector('.job-dock')!.getBoundingClientRect();
      const action = document.querySelector('.workspace-action')!.getBoundingClientRect();
      return { dock: { left: dock.left, right: dock.right, top: dock.top, bottom: dock.bottom }, actionTop: action.top, width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) };
    });
    expect(geometry.dock.left).toBeGreaterThanOrEqual(0);
    expect(geometry.dock.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.dock.bottom).toBeLessThanOrEqual(geometry.height);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.padding).toBeGreaterThan(geometry.dock.bottom - geometry.dock.top);
    if (viewport.width === 390) expect(geometry.dock.bottom).toBeLessThanOrEqual(geometry.actionTop);
    await info.attach(`job-dock-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' });
    await expect(dock.locator('strong')).toHaveAttribute('title', 'A remarkably long title — An artist with an equally long name');
    if (viewport.width === 390) {
      // CSS zoom exercises the narrower layout while retaining the physical viewport.
      await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
      await page.getByRole('button', { name: '+ Drums', exact: true }).click();
      await page.getByRole('button', { name: '+ Bass', exact: true }).click();
      for (const control of [
        page.getByRole('checkbox', { name: 'Split drums, bass & other instruments' }),
        page.getByRole('button', { name: 'Add mix', exact: true }),
        page.getByRole('button', { name: 'Download song', exact: true }),
        dock.getByRole('button', { name: 'View progress' }),
      ]) {
        await control.scrollIntoViewIfNeeded();
        await control.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(control).toBeFocused();
        await expect.poll(() => control.evaluate(element => {
          const target = element.getBoundingClientRect();
          const overlaps = (other: DOMRect) => target.left < other.right && target.right > other.left && target.top < other.bottom && target.bottom > other.top;
          const dock = document.querySelector('.job-dock')!;
          const action = document.querySelector('.workspace-action')!;
          return target.top >= 0 && target.bottom <= innerHeight &&
            (dock.contains(element) || !overlaps(dock.getBoundingClientRect())) &&
            (action.contains(element) || !overlaps(action.getBoundingClientRect()));
        })).toBe(true);
      }
      await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    }
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(dock).toBeVisible();
    await dock.getByRole('button', { name: 'View progress' }).click();
    await expect(page.locator('.processing-results')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (viewport.width === 390) {
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      const drawer = page.getByRole('dialog');
      await drawer.getByRole('button', { name: 'View progress' }).click();
      await expect(drawer).not.toBeVisible();
      await expect(page.locator('.processing-results')).toBeFocused();
    }
    expect(errors).toEqual([]);
  });
}

// Run with the real authenticated backend and key analyzer, but no worker.
// Complete each accepted job in the isolated database before its real POST
// response reaches the UI, so the real SSE snapshot observes completion.
authenticatedTest('completed dock does not prevent another source analysis and submission', async ({ page }) => {
  expect(process.env.QUEUE_CONCURRENCY).toBe('0');
  const createdIds: number[] = [];
  const releaseAnalysis = Promise.withResolvers<void>();
  const analysisFetched = Promise.withResolvers<void>();
  await page.route('**/api/jobs', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch();
    if (response.ok()) {
      const created = await response.json() as { id: number };
      createdIds.push(created.id);
      execFileSync('uv', ['run', 'python', '-c', String.raw`
import os,sys
from backend import config,db
assert config.QUEUE_CONCURRENCY == 0
assert str(config.DATA_DIR.resolve()) == os.environ['E2E_DATA_DIR']
job=db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'queued' and job.modal_call_id is None
db.mark_done(job.id,[],None)
`, String(created.id)], { cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! } });
    }
    await route.fulfill({ response });
  });
  try {
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
    await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
    const input = page.getByLabel('Audio file', { exact: true });
    const analysisStatus = page.getByRole('region', { name: 'Audio source', exact: true }).getByRole('status');
    const firstAnalysis = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
    await input.setInputFiles({ name: 'first-tone.wav', mimeType: 'audio/wav', buffer: source });
    expect((await firstAnalysis).ok()).toBe(true);
    await expect(analysisStatus).toHaveCount(0);
    const firstPost = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Download song', exact: true }).click();
    expect((await firstPost).ok()).toBe(true);
    const dock = page.locator('.job-dock');
    await expect(dock).toContainText('Complete');
    await page.route('**/api/key-analysis', async route => {
      const response = await route.fetch();
      analysisFetched.resolve();
      await releaseAnalysis.promise;
      await route.fulfill({ response });
    });

    const secondAnalysis = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
    await input.setInputFiles({ name: 'second-tone.wav', mimeType: 'audio/wav', buffer: source });
    await analysisFetched.promise;
    await expect(analysisStatus).toBeVisible();
    await expect(dock).toContainText('Complete');
    releaseAnalysis.resolve();
    expect((await secondAnalysis).ok()).toBe(true);
    await expect(analysisStatus).toHaveCount(0);
    await expect(dock).toContainText('Complete');
    await page.getByRole('checkbox', { name: 'Extract vocals', exact: true }).check();
    const processButton = page.getByRole('button', { name: 'Process audio', exact: true });
    await expect(processButton).toBeEnabled();
    const secondPost = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
    await processButton.click();
    expect((await secondPost).ok()).toBe(true);
    expect(createdIds).toHaveLength(2);
    await expect(dock).toContainText('second-tone.wav');
    await expect(dock).toContainText('Complete');
  } finally {
    releaseAnalysis.resolve();
    await page.goto('about:blank');
    for (const id of createdIds) {
      const response = await page.request.delete(`/api/jobs/${id}`, { headers: { Origin: process.env.E2E_BASE_URL! } });
      expect(response.status()).toBe(204);
    }
  }
});
