import { expect, type Locator } from '@playwright/test';
import { unlink, writeFile } from 'node:fs/promises';
import { test } from './auth-fixture';
import { cleanupLearning, seedLearning } from './learning-fixture';
import type { LearningDocument } from '../src/api';

test.afterEach(async ({ page }) => { await cleanupLearning(page); });

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`learning at ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
    test('practice stages, reviews, persistence and real section playback', async ({ page }, info) => {
      const { id, dialog, trigger } = await seedLearning(page);
      const activate = (control: Locator) => viewport.width < 500 ? control.tap() : control.click();
      const audio = dialog.locator('audio');
      await expect(audio).toHaveCount(1);
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(1);
      expect(await audio.evaluate((element: HTMLAudioElement) => element.duration)).toBeGreaterThan(3.5);
      const original = await page.request.get(`/api/jobs/${id}/original`);
      expect(original.ok()).toBe(true);
      expect(original.headers()['content-type']).toContain('audio');

      const section = dialog.getByLabel('Practice section');
      const options = section.locator('option');
      await expect(options).toHaveCount(3);
      const firstSection = await options.nth(1).getAttribute('value');
      await section.selectOption(firstSection!);
      await activate(dialog.getByRole('button', { name: 'Silver branches gently sway' }));
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(1.2, 1);
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
      const selected = await audio.evaluate((element: HTMLAudioElement) => ({ currentTime: element.currentTime, paused: element.paused }));
      // Native playback advances inside the selected line and stops at its own end.
      await audio.click({ position: { x: 20, y: 20 } });
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(1.3);
      const advancing = await audio.evaluate((element: HTMLAudioElement) => ({ currentTime: element.currentTime, paused: element.paused }));
      expect(advancing.paused).toBe(false);
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
      const stopped = await audio.evaluate((element: HTMLAudioElement) => ({ currentTime: element.currentTime, paused: element.paused }));
      expect(stopped.currentTime).toBeCloseTo(2.1, 1);
      await writeFile(info.outputPath(`line-playback-${viewport.width}.json`), JSON.stringify({ selected, advancing, stopped }, null, 2));
      const repeat = dialog.getByRole('button', { name: 'Repeat line' });
      await activate(repeat);
      const wrapped = audio.evaluate((element: HTMLAudioElement) => new Promise<boolean>(resolve => {
        let previous = 1.2;
        const timeout = window.setTimeout(() => { element.removeEventListener('timeupdate', observe); resolve(false); }, 5000);
        function observe() {
          if (element.currentTime < previous - 0.3) {
            clearTimeout(timeout); element.removeEventListener('timeupdate', observe); resolve(true);
          }
          previous = element.currentTime;
        }
        element.addEventListener('timeupdate', observe);
      }));
      await audio.click({ position: { x: 20, y: 20 } });
      expect(await wrapped).toBe(true);
      await activate(repeat);
      await activate(dialog.getByRole('button', { name: 'Amber lanterns softly shine' }));
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeLessThan(0.5);
      await audio.evaluate((element: HTMLAudioElement) => element.pause());

      await activate(dialog.getByRole('button', { name: 'Practice', exact: true }));
      await expect(dialog.getByText('Partial words', { exact: true })).toBeVisible();
      const line = dialog.getByRole('region', { name: 'Practice line' });
      await expect(line.getByRole('button', { name: 'Reveal word 1' })).toBeVisible();
      await activate(line.getByRole('button', { name: 'Reveal word 1' }));
      await expect(line.getByRole('button', { name: 'Word 1: Amber' })).toBeVisible();
      await activate(line.getByRole('button', { name: 'Reveal line' }));
      await expect(line).toContainText('Amber lanterns softly shine');
      await activate(dialog.getByRole('button', { name: 'Fewer hints' }));
      await expect(dialog.getByText('First letters', { exact: true })).toBeVisible();
      await expect(line.getByRole('button', { name: 'Reveal word 1' })).toBeVisible();
      await activate(dialog.getByRole('button', { name: 'Fewer hints' }));
      await expect(dialog.getByText('No text', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Fewer hints' })).toBeDisabled();
      await activate(dialog.getByRole('button', { name: 'More hints' }));
      await expect(dialog.getByText('First letters', { exact: true })).toBeVisible();

      const beforeReview = await (await page.request.get(`/api/jobs/${id}/learning-progress`)).json() as LearningDocument;
      for (const rating of ['Remembered', 'Hesitated', 'Forgot']) {
        const review = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${id}/learning-progress/reviews`) && response.request().method() === 'POST');
        await activate(line.getByRole('button', { name: rating, exact: true }));
        const response = await review;
        expect(response.ok()).toBe(true);
        if (rating === 'Remembered') {
          const afterReview = await response.json() as LearningDocument;
          expect(afterReview.progress.line_id).not.toBe(beforeReview.progress.line_id);
          const next = afterReview.lines.find(item => item.id === afterReview.progress.line_id)!;
          expect(next.onset_s).not.toBeNull();
          await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(next.onset_s!, 1);
          await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
        }
        expect(response.request().postDataJSON().rating).toBe(rating.toLowerCase());
      }
      const response = await page.request.get(`/api/jobs/${id}/learning-progress`);
      expect(response.ok()).toBe(true);
      const saved = await response.json() as LearningDocument;
      expect(saved.saving_available).toBe(true);
      expect(saved.progress.hint_level).toBe('first');
      expect(saved.progress.section_id).toBe(firstSection);
      expect(Object.keys(saved.progress.difficulties).length).toBeGreaterThan(0);
      await dialog.screenshot({ path: info.outputPath(`learning-practice-${viewport.width}.png`) });
      await activate(dialog.getByRole('button', { name: 'Close learning' }));
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await activate(trigger);
      await expect(dialog.getByText('First letters', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('Practice section')).toHaveValue(firstSection!);
      await expect(dialog.getByRole('button', { name: 'Repeat line' })).toHaveAttribute('aria-pressed', 'false');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await page.reload();
      await activate(page.getByRole('button', { name: 'Learn lyrics', exact: true }));
      await expect(dialog.getByText('First letters', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('Practice section')).toHaveValue(firstSection!);
    });
  });
}

test('starting another real player pauses learning audio and closing stops it', async ({ page }) => {
  const { dialog, trigger } = await seedLearning(page);
  const audio = dialog.locator('audio');
  const other = page.locator('audio:not(.learn-audio)').first();
  await expect(other).toHaveCount(1);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  await audio.click({ position: { x: 20, y: 20 } });
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  // The modal makes the results player inert; real playback still exercises the global media guard.
  await other.evaluate((element: HTMLAudioElement) => element.play());
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await expect.poll(() => other.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  await audio.click({ position: { x: 20, y: 20 } });
  await expect.poll(() => other.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  const handle = await audio.elementHandle();
  await dialog.getByRole('button', { name: 'Close learning' }).click();
  expect(await handle!.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await expect(trigger).toBeFocused();
});

test('unplaced lyrics remain manually revealable when saving is unavailable', async ({ page }) => {
  const { dialog } = await seedLearning(page, { untimed: true, missingOriginal: true });
  await expect(dialog.getByText(/Saving unavailable/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Practice', exact: true }).click();
  await dialog.getByRole('button', { name: 'Line 4 (unplaced)' }).click();
  const line = dialog.getByRole('region', { name: 'Practice line' });
  await expect(line.getByText(/No supported line timing/)).toBeVisible();
  await expect(line.getByRole('button', { name: 'Forgot' })).toBeDisabled();
  await line.getByRole('button', { name: 'Reveal line' }).click();
  await expect(line).toContainText('Unplaced moonlight');
});

test('a failed save is visible when the source disappears', async ({ page }) => {
  const { dialog, sourcePath } = await seedLearning(page);
  await unlink(sourcePath);
  await dialog.getByRole('button', { name: 'Practice', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Changes were not saved');
  await expect(dialog.getByText('Full lyrics', { exact: true })).toBeVisible();
});

test('an old mutation response cannot overwrite a reopened view', async ({ page }) => {
  const { id, dialog, trigger } = await seedLearning(page);
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let delayed = false;
  await page.route(`**/api/jobs/${id}/learning-progress`, async route => {
    if (route.request().method() !== 'PATCH' || delayed) return route.continue();
    delayed = true;
    const response = await route.fetch();
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
    delivered.resolve();
  });
  await dialog.getByRole('button', { name: 'Practice', exact: true }).click();
  await received.promise;
  await dialog.getByRole('button', { name: 'Close learning' }).click();
  await trigger.click();
  await expect(dialog.getByText('Partial words', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'More hints' }).click();
  await expect(dialog.getByText('Full lyrics', { exact: true })).toBeVisible();
  release.resolve();
  await delivered.promise;
  await expect(dialog.getByText('Full lyrics', { exact: true })).toBeVisible();
});
