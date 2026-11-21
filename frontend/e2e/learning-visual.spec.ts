import { expect } from '@playwright/test';
import { test } from './auth-fixture';
import { cleanupLearning, seedLearning } from './learning-fixture';

test.afterEach(async ({ page }) => { await cleanupLearning(page); });

for (const viewport of [
  { width: 320, height: 800 }, { width: 390, height: 844 },
  { width: 1440, height: 1000 }, { width: 2560, height: 1440 },
]) {
  test(`learning dialog full and practice layouts ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const { dialog } = await seedLearning(page);
    await page.evaluate(() => document.fonts.ready);
    const audio = dialog.locator('audio');
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) =>
      Number.isFinite(element.duration) && element.duration > 0)).toBe(true);
    await expect(dialog.getByRole('button', { name: 'Repeat line' })).toBeEnabled();
    await page.mouse.move(0, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    await dialog.screenshot({ path: info.outputPath(`learning-full-${viewport.width}.png`), animations: 'disabled', caret: 'hide', scale: 'css' });
    await expect.soft(dialog).toHaveScreenshot(`learning-full-${viewport.width}.png`, { animations: 'disabled', caret: 'hide', scale: 'css', mask: [audio] });
    await dialog.getByRole('button', { name: 'Practice', exact: true }).click();
    await expect(dialog.getByText('Partial words', { exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await dialog.screenshot({ path: info.outputPath(`learning-practice-${viewport.width}.png`), animations: 'disabled', caret: 'hide', scale: 'css' });
    await expect.soft(dialog).toHaveScreenshot(`learning-practice-${viewport.width}.png`, { animations: 'disabled', caret: 'hide', scale: 'css', mask: [audio] });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const line = dialog.getByRole('region', { name: 'Practice line' });
    expect(await line.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    if (viewport.width <= 390) {
      for (const name of ['More hints', 'Fewer hints', 'Reveal line', 'Remembered', 'Hesitated', 'Forgot']) {
        const button = dialog.getByRole('button', { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        const box = (await button.boundingBox())!;
        expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
        expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
    }
    await page.screenshot({ path: info.outputPath(`learning-context-${viewport.width}.png`), animations: 'disabled' });
  });
}
