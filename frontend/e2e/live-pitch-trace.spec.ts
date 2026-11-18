import { expect } from '@playwright/test';
import { test } from './microphone-fixture';

// Test-only synthetic microphone: the app still uses its real MediaStream,
// analyser and Pitchy detector, while the backing audio uses the browser clock.
for (const width of [390, 1440]) {
  test(`voice trace follows real playback and survives transport changes at ${width}px`, async ({ page, openPitchJob }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 329.6275569;
      gain.gain.value = 0.3;
      oscillator.connect(gain);
      oscillator.start();
      Object.defineProperty(window, '__traceTone', { value: { context, gain, oscillator } });
      navigator.mediaDevices.getUserMedia = async () => {
        await context.resume();
        const destination = context.createMediaStreamDestination();
        gain.connect(destination);
        return destination.stream;
      };
    });
    await openPitchJob(true);
    const tuner = page.getByRole('region', { name: 'Live microphone pitch' });
    const play = page.getByRole('button', { name: 'Play', exact: true }).first();
    const viewport = page.getByRole('region', { name: 'Scrollable vocal melody timeline' });
    const path = page.locator('.pitch-voice-trace');
    const audio = page.getByRole('region', { name: 'Karaoke with pitches', exact: true }).locator('audio[controls]');
    await page.getByRole('checkbox', { name: 'Follow playback' }).uncheck();
    await tuner.getByRole('button', { name: 'Start microphone pitch detection' }).click();
    await expect(tuner.locator('.mic-tuner-reading')).toContainText('E4', { timeout: 12000 });
    await expect(path).toHaveAttribute('d', ''); // Microphone alone cannot record.
    await play.click();
    await expect.poll(async () => (await path.getAttribute('d'))?.includes('L'), { timeout: 12000 }).toBe(true);
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Pause', exact: true }).first().click();
    const first = await path.getAttribute('d');
    await page.waitForTimeout(250);
    expect(await path.getAttribute('d')).toBe(first);
    const voiceY = await path.evaluate((p: SVGPathElement) => p.getBBox().y);
    await viewport.evaluate((v: HTMLElement, y) => { v.scrollTop = Math.max(0, 32 + y - v.clientHeight / 2); }, voiceY);
    await viewport.screenshot({ path: info.outputPath(`live-pitch-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Open karaoke fullscreen' }).click();
    await page.getByRole('button', { name: 'Exit karaoke fullscreen' }).click();
    await expect(path).toHaveAttribute('d', first!);
    const instruments = page.getByRole('group', { name: 'Pitch background audio' }).getByRole('button', { name: /^Instruments/ });
    await instruments.click();
    await expect(instruments).toHaveAttribute('aria-pressed', 'true');
    await expect(path).toHaveAttribute('d', first!);

    // Seeking alone and microphone-off playback never erase a take.
    await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 5; });
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.seeking)).toBe(false);
    await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 0; });
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.seeking)).toBe(false);
    await viewport.evaluate((v: HTMLElement) => { v.scrollLeft = 0; });
    await expect(path).toHaveAttribute('d', first!);
    await tuner.getByRole('button', { name: 'Stop microphone pitch detection' }).click();
    await play.click();
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.5);
    await page.getByRole('button', { name: 'Pause', exact: true }).first().click();
    await expect(path).toHaveAttribute('d', first!);

    // Replay the beginning with silence. Its visited cells disappear, but the
    // later part of the old trace remains visible and starts a new subpath.
    await tuner.getByRole('button', { name: 'Start microphone pitch detection' }).click();
    await page.evaluate(() => {
      // The test itself installed this in-process oscillator above.
      const tone = (window as unknown as { __traceTone: { gain: GainNode } }).__traceTone;
      tone.gain.gain.value = 0;
    });
    await expect(tuner.getByText('Listening for a clear note…')).toBeVisible();
    await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 0; });
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.seeking)).toBe(false);
    await play.click();
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.35);
    await page.getByRole('button', { name: 'Pause', exact: true }).first().click();
    const erased = await path.getAttribute('d');
    expect(erased).not.toBe(first);
    expect(erased).toContain('L');
    expect(Number(erased!.match(/^M([\d.]+)/)?.[1])).toBeGreaterThan(0);
    await viewport.evaluate((v: HTMLElement) => { v.scrollLeft = 400; });
    await viewport.evaluate((v: HTMLElement) => { v.scrollLeft = 0; });
    await expect(path).toHaveAttribute('d', erased!);
    await openPitchJob();
    await expect(page.locator('.pitch-voice-trace')).toHaveAttribute('d', '');
  });
}
