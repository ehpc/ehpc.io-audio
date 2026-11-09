import { expect } from '@playwright/test';
import { test } from './auth-fixture';
import type { QueryRecognition } from '../src/components/VoiceQuery';
import { songArtwork, songVersions } from './song-fixtures';

type SpeechTestWindow = Window & { recognition: QueryRecognition; aborted: number };

// Controlled API boundary responses test the browser contract, not the real
// LLM/catalog. External-provider smoke tests are deliberately outside default CI.
for (const width of [375, 390, 430, 1440, 2560]) {
  test.describe(`source input at ${width}px`, () => {
  test.use({ hasTouch: width < 700 });
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
        status: 'done', songs: songVersions,
      } });
    });
    await page.route('**/api/key-analysis', route => {
      analyzed.push(route.request().postData() ?? '');
      return route.fulfill({ json: { original_key: 'C major' } });
    });
    await page.route(songVersions[0].thumbnail_url!, route => route.fulfill({ contentType: 'image/svg+xml', body: songArtwork }));
    await page.route(songVersions[2].thumbnail_url!, route => route.abort());
    await page.goto('/');
    const finder = page.getByRole('button', { name: 'Find song', exact: true });
    if (width < 700) await finder.tap();
    else await finder.click();
    const query = page.getByLabel('Describe a song', { exact: true });
    if (width < 700) await query.tap();
    else await query.click();
    await query.pressSequentially('宇多田ヒカル First Love');
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
    if (width === 390 || width === 1440) await query.press('Enter');
    else await search.click();
    await expect(search).toBeDisabled();
    await expect(page.getByRole('status')).toBeVisible();
    await expect.poll(() => searches).toBe(1);
    if (width === 390 || width === 1440) await query.press('Enter');
    await page.screenshot({ path: info.outputPath(`song-pending-${width}.png`), fullPage: true });
    const link = page.getByRole('link', { name: 'Verify First Love on YouTube Music', exact: true });
    await expect(link).toHaveAttribute('href', songVersions[0].url);
    const choices = page.getByRole('radio');
    await expect(choices).toHaveCount(3);
    await expect(choices.nth(0)).toBeChecked();
    await expect.poll(() => analyzed.length).toBe(1);
    expect(analyzed[0]).toContain(songVersions[0].url);
    const artwork = page.locator('.song-match img');
    await expect(artwork).toHaveCount(1);
    await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await artwork.evaluate(image => {
      const box = image.getBoundingClientRect();
      return { width: box.width, height: box.height, fit: getComputedStyle(image).objectFit };
    })).toEqual({ width: 48, height: 48, fit: 'cover' });
    await expect(page.getByText('About 2.7B YouTube Music plays', { exact: true })).toBeVisible();
    await expect(page.getByText('0 YouTube Music plays', { exact: true })).toBeVisible();
    await expect(page.getByText('5:05', { exact: true })).toBeVisible();
    for (const label of await page.locator('.song-choice').all()) expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (width < 700) await page.locator('.song-choice').nth(1).tap();
    else {
      await choices.nth(0).focus();
      await page.keyboard.press('ArrowDown');
    }
    await expect(choices.nth(1)).toBeChecked();
    await expect.poll(() => analyzed.length).toBe(2);
    expect(analyzed[1]).toContain(songVersions[1].url);
    await expect(page.getByRole('link', { name: 'Verify First Love (Dance Remix) on YouTube Music', exact: true })).toHaveAttribute('href', songVersions[1].url);
    await choices.nth(2).focus();
    await page.keyboard.press('Space');
    await expect(choices.nth(2)).toBeChecked();
    await page.keyboard.press('Enter');
    await expect.poll(() => analyzed.length).toBe(3);
    expect(analyzed[2]).toContain(songVersions[2].url);
    expect(jobs).toBe(0);
    expect(searches).toBe(1);
    await info.attach('search-request-proof', {
      body: JSON.stringify({ width, hasTouch: width < 700, trigger: width === 390 || width === 1440 ? 'Enter' : 'button', searches, polls, jobs, analyzed }, null, 2),
      contentType: 'application/json',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`song-selected-${width}.png`), fullPage: true });
    await query.fill('edited song');
    await expect(link).toHaveCount(0);
    await page.getByRole('button', { name: 'Download song', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(jobs).toBe(0);
  });
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
