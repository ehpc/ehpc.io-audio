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
    await tuner.screenshot({ path: info.outputPath('microphone-off-actual.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
    await expect(tuner).toHaveScreenshot(`microphone-off-${viewport.width}.png`);
    await tuner.getByRole('button', { name: 'Start microphone pitch detection' }).click();
    await expect(tuner.locator('.mic-tuner-reading')).toHaveText(/E4\s*\+35 cents/, { timeout: 15_000 });
    await tuner.screenshot({ path: info.outputPath('microphone-sharp-actual.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
    await expect(tuner).toHaveScreenshot(`microphone-sharp-${viewport.width}.png`);
  });
}
