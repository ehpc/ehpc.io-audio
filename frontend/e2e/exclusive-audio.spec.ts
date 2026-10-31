import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`only one dynamically mounted audio plays at a time (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.evaluate(async () => {
      const rate = 8000;
      const buffer = new ArrayBuffer(44 + rate * 5 * 2);
      const view = new DataView(buffer);
      const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
      text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVEfmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      text(36, 'data'); view.setUint32(40, rate * 5 * 2, true);
      for (let i = 0; i < rate * 5; i++) view.setInt16(44 + i * 2, Math.sin(i * 0.08) * 5000, true);
      const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
      const first = document.createElement('audio');
      const second = document.createElement('audio');
      first.src = url; second.src = url;
      document.body.append(first, second);
      await second.load();
      const firstPlaying = Promise.withResolvers<void>();
      first.addEventListener('playing', firstPlaying.resolve, { once: true });
      await first.play();
      await firstPlaying.promise;
      first.pause();
      first.currentTime = 1.25;
      const resumePlaying = Promise.withResolvers<void>();
      first.addEventListener('playing', resumePlaying.resolve, { once: true });
      await first.play();
      await resumePlaying.promise;
      const secondPlaying = Promise.withResolvers<void>();
      second.addEventListener('playing', secondPlaying.resolve, { once: true });
      await second.play();
      await secondPlaying.promise;
      (window as Window & { exclusiveAudioState?: { firstPaused: boolean; firstTime: number; secondPaused: boolean } }).exclusiveAudioState = {
        firstPaused: first.paused, firstTime: first.currentTime, secondPaused: second.paused,
      };
    });
    await expect.poll(() => page.evaluate(() => (window as Window & { exclusiveAudioState?: { firstPaused: boolean; firstTime: number; secondPaused: boolean } }).exclusiveAudioState)).toMatchObject({
      firstPaused: true, secondPaused: false,
    });
    expect(await page.evaluate(() => (window as Window & { exclusiveAudioState?: { firstPaused: boolean; firstTime: number; secondPaused: boolean } }).exclusiveAudioState?.firstTime)).toBeGreaterThanOrEqual(1.25);
  });
}
