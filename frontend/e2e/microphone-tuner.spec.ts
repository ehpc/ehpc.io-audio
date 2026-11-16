import { expect, type Locator } from '@playwright/test';
import { test, wavePath, writeMicrophoneWave } from './microphone-fixture';

test.beforeAll(writeMicrophoneWave);

async function expectGauge(tuner: Locator, cents: number) {
  const { left, width, trackLeft, trackWidth } = await tuner.locator('.mic-tuner-fill').evaluate(element => {
    const fill = element.getBoundingClientRect(), track = element.parentElement!.getBoundingClientRect();
    return { left: fill.left, width: fill.width, trackLeft: track.left, trackWidth: track.width };
  });
  const clamped = Math.max(-25, Math.min(25, cents));
  expect(Math.abs(left - (trackLeft + trackWidth * (0.5 + Math.min(clamped, 0) / 50)))).toBeLessThan(1);
  expect(Math.abs(width - trackWidth * Math.abs(clamped) / 50)).toBeLessThan(1);
}

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wavePath}`] },
});

for (const width of [390, 1440]) {
  test(`real local microphone tuner ${width}px`, async ({ page, openPitchJob }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const state = { requests: 0, streams: [] as MediaStream[], delay: false, release: undefined as (() => void) | undefined };
      Object.defineProperty(window, '__micTest', { value: state });
      navigator.mediaDevices.getUserMedia = async constraints => {
        state.requests++;
        const stream = await original(constraints);
        state.streams.push(stream);
        if (state.delay) await new Promise<void>(resolve => { state.release = resolve; });
        return stream;
      };
    });
    await openPitchJob();
    const tuner = page.getByRole('region', { name: 'Live microphone pitch' });
    const button = tuner.getByRole('button', { name: 'Start microphone pitch detection' });
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => (window as unknown as { __micTest: { requests: number } }).__micTest.requests)).toBe(0);
    await button.click();
    await expect(tuner.getByRole('button', { name: 'Stop microphone pitch detection' })).toHaveAttribute('aria-pressed', 'true');
    await expect(tuner.locator('.mic-tuner-reading')).toHaveText(/E4\s*0 cents/, { timeout: 12_000 });
    await expectGauge(tuner, 0);
    await expect(tuner.locator('.mic-tuner-reading')).toHaveText(/E4\s*\+(9|10|11) cents/, { timeout: 12_000 });
    const cents = Number((await tuner.locator('.mic-tuner-reading').innerText()).match(/\+(\d+) cents/)![1]);
    await expectGauge(tuner, cents);
    await expect(tuner.locator('.mic-tuner-reading')).toHaveText(/E4\s*\+3[4-6] cents/, { timeout: 12_000 });
    await expectGauge(tuner, 35);
    await expect(tuner.getByText('Listening for a clear note…')).toBeVisible({ timeout: 12_000 });
    await expect(tuner.locator('.mic-tuner-fill')).toHaveCount(0);
    await expect(tuner.locator('.mic-tuner-reading')).toHaveText(/A3\s*-(29|30|31) cents/, { timeout: 12_000 });
    await expectGauge(tuner, -30);
    await tuner.getByRole('button', { name: 'Stop microphone pitch detection' }).click();
    await expect(tuner.getByText('Microphone off')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __micTest: { streams: MediaStream[] } }).__micTest.streams[0].getTracks().every(track => track.readyState === 'ended'))).toBe(true);
    // Delay delivery of a real stream to exercise cancellation while permission is pending.
    await page.evaluate(() => { (window as unknown as { __micTest: { delay: boolean } }).__micTest.delay = true; });
    await tuner.getByRole('button', { name: 'Start microphone pitch detection' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __micTest: { streams: MediaStream[] } }).__micTest.streams.length)).toBe(2);
    await tuner.getByRole('button', { name: 'Stop microphone pitch detection' }).click();
    await page.evaluate(() => {
      const state = (window as unknown as { __micTest: { delay: boolean; release?: () => void } }).__micTest;
      state.delay = false;
      state.release?.();
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __micTest: { streams: MediaStream[] } }).__micTest.streams[1].getTracks().every(track => track.readyState === 'ended'))).toBe(true);
    await tuner.getByRole('button', { name: 'Start microphone pitch detection' }).click();
    await expect(tuner.getByText('Listening for a clear note…')).toBeVisible();
    await page.getByRole('button', { name: 'Start another job' }).click();
    await expect.poll(() => page.evaluate(() => {
      const state = (window as unknown as { __micTest: { streams: MediaStream[] } }).__micTest;
      return state.streams.at(-1)!.getTracks().every(track => track.readyState === 'ended');
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('reports browser microphone policy denial without recording', async ({ page, openPitchJob }) => {
  test.setTimeout(120_000);
  await openPitchJob();
  // A same-origin embedded app is explicitly denied microphone access by the browser.
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.allow = "microphone 'none'";
    frame.src = '/';
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:9999';
    document.body.append(frame);
  });
  const tuner = page.frameLocator('iframe').getByRole('region', { name: 'Live microphone pitch' });
  await tuner.getByRole('button', { name: 'Start microphone pitch detection' }).click();
  await expect(tuner.getByRole('alert')).toContainText('permission was denied');
  await expect(tuner.getByRole('button', { name: 'Start microphone pitch detection' })).toHaveAttribute('aria-pressed', 'false');
});
