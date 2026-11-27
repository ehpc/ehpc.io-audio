import { expect } from '@playwright/test';
import { test, wavePath, writeMicrophoneWave } from './microphone-fixture';
import { VISUAL_BROWSER_ARGS } from './visual-settings';

// Preserve the strict visual lane's pinned CPU raster settings while enabling a fake input device.
test.use({
  permissions: ['microphone'],
  launchOptions: { args: [
    ...VISUAL_BROWSER_ARGS,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wavePath}`,
  ] },
});
test.beforeAll(writeMicrophoneWave);

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`microphone tuner ${viewport.width}`, async ({ page, openPitchJob }, info) => {
    await page.clock.setFixedTime(new Date('2026-01-01T12:00:00Z'));
    await page.setViewportSize(viewport);
    await openPitchJob();
    const tuner = page.getByRole('region', { name: 'Live microphone pitch' });
    const display = tuner.locator('.mic-tuner-display');
    await page.evaluate(async () => { await document.fonts.ready; });
    const geometry = () => display.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const tuner = element.closest('.mic-tuner')?.getBoundingClientRect();
      return {
        display: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        tuner: tuner ? { x: tuner.x, y: tuner.y, width: tuner.width, height: tuner.height } : null,
        scrollX: window.scrollX, scrollY: window.scrollY, devicePixelRatio: window.devicePixelRatio,
        fonts: document.fonts.status, animations: document.getAnimations().length,
      };
    });
    const capture = async (state: 'off' | 'sharp') => {
      await display.scrollIntoViewIfNeeded();
      const box = await display.boundingBox();
      expect(box).not.toBeNull();
      const padding = 3;
      // The extra pixel contains a fractional origin without clipping either edge.
      const clip = {
        x: Math.floor(box!.x) - padding, y: Math.floor(box!.y) - padding,
        width: Math.ceil(box!.width) + 2 * padding + 1,
        height: Math.ceil(box!.height) + 2 * padding + 1,
      };
      const viewportSize = page.viewportSize()!;
      expect(clip.x).toBeGreaterThanOrEqual(0);
      expect(clip.y).toBeGreaterThanOrEqual(0);
      expect(clip.x + clip.width).toBeLessThanOrEqual(viewportSize.width);
      expect(clip.y + clip.height).toBeLessThanOrEqual(viewportSize.height);
      expect(box!.x).toBeGreaterThanOrEqual(clip.x);
      expect(box!.y).toBeGreaterThanOrEqual(clip.y);
      expect(box!.x + box!.width).toBeLessThanOrEqual(clip.x + clip.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(clip.y + clip.height);
      const image = await page.screenshot({
        path: info.outputPath(`microphone-reading-${state}-actual.png`),
        clip, animations: 'disabled', caret: 'hide', scale: 'css',
      });
      expect.soft(image).toMatchSnapshot(`microphone-reading-${state}-${viewport.width}.png`, { threshold: 0.005, maxDiffPixels: 0 });
    };
    const offBefore = await geometry();
    await capture('off');
    const offAfter = await geometry();
    await tuner.getByRole('button', { name: 'Start microphone pitch detection' }).click();
    await expect(tuner.locator('.mic-tuner-reading')).toHaveText(/E4\s*\+35 cents/, { timeout: 15_000 });
    const sharpBefore = await geometry();
    await capture('sharp');
    await info.attach('microphone-capture-geometry', {
      body: Buffer.from(JSON.stringify({ offBefore, offAfter, sharpBefore, sharpAfter: await geometry() }, null, 2)),
      contentType: 'application/json',
    });
  });
}
