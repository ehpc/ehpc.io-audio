import { expect, test } from '@playwright/test';
import type { QueryRecognition } from '../src/components/VoiceQuery';

type SpeechTestWindow = Window & { recognition: QueryRecognition; aborted: number };

// Controlled API boundary responses test the browser contract, not the real
// LLM/catalog. External-provider smoke tests are deliberately outside default CI.
for (const width of [375, 390, 430, 1440, 2560]) {
  test(`discovery selection and stale source protection ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width < 700 ? 844 : 1000 });
    let searches = 0;
    let polls = 0;
    let jobs = 0;
    const analyzed: string[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/jobs') && request.method() === 'POST') jobs++; });
    await page.route('**/api/song-search', route => {
      searches++;
      expect(route.request().postDataJSON()).toEqual({ query: '宇多田ヒカル First Love' });
      return route.fulfill({ status: 202, json: { status: 'pending', search_id: 'controlled-song' } });
    });
    await page.route('**/api/song-search/controlled-song', route => {
      polls++;
      return route.fulfill({ json: polls === 1 ? { status: 'pending' } : {
        status: 'done', song: { title: 'First Love', artists: ['宇多田ヒカル'], duration_seconds: 258,
          url: 'https://music.youtube.com/watch?v=o1sUaVJUeB0' },
      } });
    });
    await page.route('**/api/key-analysis', route => {
      analyzed.push(route.request().postData() ?? '');
      return route.fulfill({ json: { original_key: 'C major' } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Find song', exact: true }).click();
    const query = page.getByLabel('Describe a song', { exact: true });
    await query.fill('宇多田ヒカル First Love');
    await query.press('Enter');
    expect(searches).toBe(0);
    expect(jobs).toBe(0);
    expect(await query.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    const search = page.getByRole('button', { name: 'Search', exact: true });
    expect((await search.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const mic = page.getByRole('button', { name: 'Start voice input' });
    if (await mic.count()) {
      const size = (await mic.boundingBox())!;
      expect(size.width).toBeGreaterThanOrEqual(44);
      expect(size.height).toBeGreaterThanOrEqual(44);
    }
    await search.click();
    await expect(search).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('Finding on YouTube Music');
    await page.screenshot({ path: info.outputPath(`song-pending-${width}.png`), fullPage: true });
    const link = page.getByRole('link', { name: 'Verify on YouTube Music' });
    await expect(link).toHaveAttribute('href', 'https://music.youtube.com/watch?v=o1sUaVJUeB0');
    await expect(page.getByLabel('Selected song')).toContainText('宇多田ヒカル');
    await expect.poll(() => analyzed.length).toBe(1);
    expect(analyzed[0]).toContain('https://music.youtube.com/watch?v=o1sUaVJUeB0');
    expect(jobs).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`song-selected-${width}.png`), fullPage: true });
    await query.fill('edited song');
    await expect(link).toHaveCount(0);
    await page.getByRole('button', { name: 'Download song', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Find and select a song');
    expect(jobs).toBe(0);
  });
}

test('prefixed voice dictation restores the input and never submits a search', async ({ page }) => {
  // Browser API simulation only: no claim of real microphone or Safari coverage.
  await page.addInitScript(() => {
    const host = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown; recognition?: {
      onresult?: (event: unknown) => void; onerror?: (event: unknown) => void; onend?: () => void;
    }; aborted: number };
    host.SpeechRecognition = undefined;
    host.aborted = 0;
    host.webkitSpeechRecognition = class {
      constructor() { host.recognition = this; }
      onresult?: (event: unknown) => void;
      onerror?: (event: unknown) => void;
      onend?: () => void;
      start() {}
      stop() { this.onend?.(); }
      abort() { host.aborted++; }
    };
  });
  let searches = 0;
  page.on('request', request => { if (request.url().endsWith('/api/song-search')) searches++; });
  await page.goto('/');
  await page.getByRole('button', { name: 'Find song', exact: true }).click();
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await expect(page.getByRole('status')).toContainText('Listening');
  await page.evaluate(() => (window as SpeechTestWindow).recognition.onresult?.({ results: [[{ transcript: 'First Love 宇多田ヒカル' }]] }));
  await expect(page.getByLabel('Describe a song')).toHaveValue('First Love 宇多田ヒカル');
  expect(searches).toBe(0);
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await page.evaluate(() => (window as SpeechTestWindow).recognition.onerror?.({ error: 'not-allowed' }));
  await expect(page.getByRole('alert')).toContainText('Microphone permission was denied');
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
  expect(await page.evaluate(() => (window as SpeechTestWindow).aborted)).toBe(3);
});
