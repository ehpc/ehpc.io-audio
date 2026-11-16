import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { test } from './auth-fixture';
import { jobLabel, type JobDTO } from '../src/api';

const seedLibraryTrack = String.raw`
import json,sys
from backend import db
from separator.pitch import pitch_from_json,pitch_to_json
value=json.load(sys.stdin)
job=db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'queued' and job.modal_call_id is None
db.mark_done(job.id,[],None,pitch_to_json(pitch_from_json(json.dumps(value['pitch']))))
with db._session() as connection:
 connection.execute('UPDATE jobs SET title=?,created_at=?,finished_at=? WHERE id=?',(value['title'],4102444800,4102444801,job.id))
`;

const viewports = [
  { name: 'iphone', width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: 'tablet', width: 768, height: 1024, isMobile: true, hasTouch: true },
  { name: 'narrow-desktop', width: 1024, height: 900, isMobile: false, hasTouch: false },
  { name: 'medium-desktop', width: 1280, height: 900, isMobile: false, hasTouch: false },
  { name: 'desktop', width: 1440, height: 1000, isMobile: false, hasTouch: false },
  { name: 'wide-desktop', width: 1920, height: 1080, isMobile: false, hasTouch: false },
] as const;

async function createSeededTrack(page: Page, source: Buffer, fixture: { pitch: unknown }, title: string, createdIds: number[]): Promise<JobDTO> {
  const response = await page.request.post('/api/jobs', {
    headers: { Origin: process.env.E2E_BASE_URL! },
    multipart: {
      file: { name: `${title}.ogg`, mimeType: 'audio/ogg', buffer: source },
      detect_pitch: 'true', pitch_semitones: '0', tempo_percent: '100',
    },
  });
  const created = await response.json() as { id: number };
  createdIds.push(created.id);
  expect(response.status()).toBe(200);
  execFileSync('uv', ['run', 'python', '-c', seedLibraryTrack, String(created.id)], {
    cwd: process.env.E2E_REPO_ROOT!,
    input: JSON.stringify({ pitch: fixture.pitch, title }),
    env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
  });
  const completedResponse = await page.request.get(`/api/jobs/${created.id}`);
  expect(completedResponse.ok()).toBe(true);
  const completed = await completedResponse.json() as JobDTO;
  expect(completed.status).toBe('done');
  expect(completed.title).toBe(title);
  expect(completed.pitch).not.toBeNull();
  return completed;
}

async function assertKaraokeSelection(page: Page, title: string, viewport: typeof viewports[number]) {
  const heading = page.getByRole('heading', { name: title, exact: true });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveCount(1);
  const karaoke = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
  await expect(karaoke).toBeVisible();
  await expect.poll(() => karaoke.evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(180);
  if (viewport.isMobile) {
    const trigger = page.getByRole('button', { name: 'Library', exact: true });
    await expect(trigger).toBeVisible();
    const triggerBox = (await trigger.boundingBox())!;
    const karaokeTop = (await karaoke.boundingBox())!.y;
    expect(karaokeTop).toBeGreaterThan(triggerBox.y + triggerBox.height);
  }
  return karaoke;
}


test('Library rail and drawer preserve selection, focus, playback, and responsive workspace', async ({ browser, context, page }, info) => {
  test.setTimeout(180_000);
  expect(process.env.QUEUE_CONCURRENCY).toBe('0');
  const createdIds: number[] = [];
  let viewportContext: BrowserContext | undefined;
  try {
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg'));
    const fixture = JSON.parse(await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8')) as { pitch: unknown };
    const shortTitles = ['Library Alpha fixture', 'Library Beta fixture'];
    const longTitle = `Library long-title fixture ${'Harmony and melody '.repeat(7)}`;
    const jobs: JobDTO[] = [];
    for (const title of [...shortTitles, longTitle]) jobs.push(await createSeededTrack(page, source, fixture, title, createdIds));
    const titles = jobs.map(jobLabel);
    const cookies = await context.cookies();

    for (const viewport of viewports) {
      try {
        viewportContext = await browser.newContext({
          baseURL: process.env.E2E_BASE_URL,
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.isMobile,
          hasTouch: viewport.hasTouch,
          colorScheme: 'dark',
          reducedMotion: 'reduce',
        });
        await viewportContext.addCookies(cookies);
        const viewportPage = await viewportContext.newPage();
        await viewportPage.goto('/');
        const trigger = viewportPage.getByRole('button', { name: 'Library', exact: true });
        const rail = viewportPage.getByRole('complementary', { name: 'Library', exact: true });
        const history = () => viewport.isMobile
          ? viewportPage.getByRole('dialog', { name: 'Library', exact: true }).getByRole('region', { name: 'History', exact: true })
          : rail.getByRole('region', { name: 'History', exact: true });

        if (viewport.isMobile) {
          await expect(rail).toHaveCount(0);
          await expect(trigger).toBeVisible();
          await expect(viewportPage.getByRole('dialog', { name: 'Library', exact: true })).toHaveCount(0);
        } else {
          await expect(rail).toBeVisible();
          await expect(trigger).toHaveCount(0);
        }

        const openLibrary = async () => {
          if (viewport.isMobile) await trigger.click();
          const libraryHistoryRegion = history();
          await expect(libraryHistoryRegion).toBeVisible();
          for (const title of titles) {
            await expect(libraryHistoryRegion.getByRole('button', { name: title, exact: true })).toHaveCount(1);
          }
          return libraryHistoryRegion;
        };
        const assertSelectedTrack = async (selectedTitle: string, otherTitle: string) => {
          const selectedHistory = viewport.isMobile ? await openLibrary() : history();
          await expect(selectedHistory.getByRole('button', { name: selectedTitle, exact: true })).toHaveAttribute('aria-current', 'true');
          await expect(selectedHistory.getByRole('button', { name: otherTitle, exact: true })).not.toHaveAttribute('aria-current', 'true');
          if (viewport.isMobile) {
            await viewportPage.keyboard.press('Escape');
            await expect(trigger).toBeFocused();
          }
        };

        const libraryHistoryRegion = await openLibrary();
        const longTitleButton = libraryHistoryRegion.getByRole('button', { name: longTitle, exact: true });
        await expect(longTitleButton).toBeVisible();
        const pageWidth = await viewportPage.evaluate(() => document.documentElement.scrollWidth);
        expect(pageWidth).toBeLessThanOrEqual(viewport.width);
        const titleBounds = (await longTitleButton.boundingBox())!;
        const historyBounds = (await libraryHistoryRegion.boundingBox())!;
        expect(titleBounds.x).toBeGreaterThanOrEqual(historyBounds.x);
        expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(historyBounds.x + historyBounds.width);

        if (viewport.name === 'iphone') {
          const dialog = viewportPage.getByRole('dialog', { name: 'Library', exact: true });
          await dialog.screenshot({ path: info.outputPath('library-drawer-390-actual.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
        }
        if (viewport.isMobile) {
          await viewportPage.keyboard.press('Escape');
          await expect(viewportPage.getByRole('dialog', { name: 'Library', exact: true })).toBeHidden();
          await expect(trigger).toBeFocused();
        }

        if (viewport.name === 'desktop') {
          await rail.screenshot({ path: info.outputPath('library-rail-1440-actual.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
        }

        const alphaHistory = await openLibrary();
        await alphaHistory.getByRole('button', { name: titles[0], exact: true }).click();
        if (viewport.isMobile) {
          await expect(viewportPage.getByRole('dialog', { name: 'Library', exact: true })).toBeHidden();
          await expect(trigger).toBeFocused();
        }
        const alphaKaraoke = await assertKaraokeSelection(viewportPage, titles[0], viewport);
        await assertSelectedTrack(titles[0], titles[1]);
        await viewportPage.screenshot({
          path: info.outputPath(`library-selected-karaoke-${viewport.width}-actual.png`),
          animations: 'disabled', caret: 'hide', scale: 'css',
        });

        const player = viewportPage.locator('.pitch-view audio:not([hidden])');
        await expect(player).toHaveCount(1);
        await player.evaluate(audio => { (audio as HTMLAudioElement).volume = 0; });
        await alphaKaraoke.getByRole('button', { name: 'Play', exact: true }).click();
        await expect.poll(() => player.evaluate(audio => !(audio as HTMLAudioElement).paused)).toBe(true);
        const playbackTime = await player.evaluate(audio => (audio as HTMLAudioElement).currentTime);
        await openLibrary();
        await expect.poll(() => player.evaluate((audio, previous) => {
          const current = audio as HTMLAudioElement;
          return !current.paused && current.currentTime > previous;
        }, playbackTime)).toBe(true);
        if (viewport.isMobile) {
          await viewportPage.keyboard.press('Escape');
          await expect(trigger).toBeFocused();
        }

        const betaHistory = await openLibrary();
        await betaHistory.getByRole('button', { name: titles[1], exact: true }).click();
        if (viewport.isMobile) {
          await expect(viewportPage.getByRole('dialog', { name: 'Library', exact: true })).toBeHidden();
          await expect(trigger).toBeFocused();
        }
        const betaKaraoke = await assertKaraokeSelection(viewportPage, titles[1], viewport);
        await assertSelectedTrack(titles[1], titles[0]);
        await assertKaraokeSelection(viewportPage, titles[1], viewport);

        await viewportPage.evaluate(() => window.scrollTo(0, 0));
        const repeatedHistory = await openLibrary();
        await repeatedHistory.getByRole('button', { name: titles[1], exact: true }).click();
        if (viewport.isMobile) {
          await expect(viewportPage.getByRole('dialog', { name: 'Library', exact: true })).toBeHidden();
          await expect(trigger).toBeFocused();
        }
        await assertSelectedTrack(titles[1], titles[0]);
        await assertKaraokeSelection(viewportPage, titles[1], viewport);
      } finally {
        await viewportContext?.close();
        viewportContext = undefined;
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    const desktopHistory = page.getByRole('complementary', { name: 'Library', exact: true }).getByRole('region', { name: 'History', exact: true });
    await desktopHistory.getByRole('button', { name: titles[1], exact: true }).click();
    const selectedHeading = page.getByRole('heading', { name: titles[1], exact: true });
    await expect(selectedHeading).toBeVisible();
    await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
    const sourceInput = page.getByLabel('Audio file', { exact: true });
    const keyAnalysis = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
    await sourceInput.setInputFiles({ name: 'Library breakpoint source.ogg', mimeType: 'audio/ogg', buffer: source });
    expect((await keyAnalysis).status()).toBe(200);
    const pitchInput = page.getByRole('spinbutton', { name: 'Pitch shift (semitones)', exact: true });
    const tempoInput = page.getByRole('spinbutton', { name: 'Tempo (% of original)', exact: true });
    await pitchInput.fill('1.25');
    await tempoInput.fill('125');
    const selectedPlayer = page.locator('.pitch-view audio:not([hidden])');
    await selectedPlayer.evaluate(audio => { (audio as HTMLAudioElement).volume = 0; });
    await page.getByRole('region', { name: 'Karaoke with pitches', exact: true }).getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => selectedPlayer.evaluate(audio => !(audio as HTMLAudioElement).paused)).toBe(true);
    let playbackTime = await selectedPlayer.evaluate(audio => (audio as HTMLAudioElement).currentTime);

    for (const width of [768, 390, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const mobile = width <= 1000;
      const trigger = page.getByRole('button', { name: 'Library', exact: true });
      const rail = page.getByRole('complementary', { name: 'Library', exact: true });
      if (mobile) {
        await expect(rail).toHaveCount(0);
        await expect(trigger).toBeVisible();
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: 'Library', exact: true });
        await expect(dialog.getByRole('button', { name: titles[1], exact: true })).toHaveAttribute('aria-current', 'true');
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
      } else {
        await expect(rail).toBeVisible();
        await expect(rail.getByRole('button', { name: titles[1], exact: true })).toHaveAttribute('aria-current', 'true');
        const optionWidth = await page.locator('.workspace-option').first().evaluate(element => element.getBoundingClientRect().width);
        expect(optionWidth).toBeGreaterThan(200);
      }
      expect(await sourceInput.evaluate(input => (input as HTMLInputElement).files?.[0]?.name)).toBe('Library breakpoint source.ogg');
      expect(await page.locator('#pitch-input').inputValue()).toBe('1.25');
      expect(await page.locator('#tempo-input').inputValue()).toBe('125');
      const previousPlaybackTime = playbackTime;
      await expect.poll(() => selectedPlayer.evaluate((audio, previous) => {
        const current = audio as HTMLAudioElement;
        return !current.paused && current.currentTime > previous;
      }, previousPlaybackTime)).toBe(true);
      playbackTime = await selectedPlayer.evaluate(audio => (audio as HTMLAudioElement).currentTime);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  } finally {
    await viewportContext?.close();
    await page.goto('about:blank');
    for (const id of createdIds) {
      await expect.poll(async () => (await page.request.delete(`/api/jobs/${id}`, {
        headers: { Origin: process.env.E2E_BASE_URL! },
      })).status()).toBe(204);
    }
  }
});
