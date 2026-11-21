import { expect, type Locator } from '@playwright/test';
import { test, wavePath, writeMicrophoneWave } from './microphone-fixture';

test.beforeAll(writeMicrophoneWave);

async function expectGauge(tuner: Locator, phase: RegExp) {
  await expect(async () => {
    const sample = await tuner.evaluate(element => {
      const note = element.querySelector('.mic-tuner-reading strong')?.textContent ?? '';
      const centsText = element.querySelector('.mic-tuner-reading span')?.textContent ?? '';
      const reading = `${note} ${centsText}`;
      const fill = element.querySelector<HTMLElement>('.mic-tuner-fill');
      if (!fill) return { reading, centsText, geometry: null };
      const rect = fill.getBoundingClientRect(), track = fill.parentElement!.getBoundingClientRect();
      return { reading, centsText, geometry: { left: rect.left, width: rect.width, trackLeft: track.left, trackWidth: track.width } };
    });
    expect(sample.reading).toMatch(phase);
    expect(sample.geometry).not.toBeNull();
    const cents = Number(sample.centsText.match(/^([+-]?\d+)\s+cents$/)![1]);
    const { left, width, trackLeft, trackWidth } = sample.geometry!;
    const clamped = Math.max(-25, Math.min(25, cents));
    expect(Math.abs(left - (trackLeft + trackWidth * (0.5 + Math.min(clamped, 0) / 50)))).toBeLessThan(1);
    expect(Math.abs(width - trackWidth * Math.abs(clamped) / 50)).toBeLessThan(1);
  }).toPass({ timeout: 12_000 });
}

test.use({
  permissions: ['microphone'],
  launchOptions: { ...(process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : {}), args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wavePath}`] },
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
    await expectGauge(tuner, /E4\s*0 cents/);
    await expectGauge(tuner, /E4\s*\+(9|10|11) cents/);
    await expectGauge(tuner, /E4\s*\+3[4-6] cents/);
    await expect(tuner.getByText('Listening for a clear note…')).toBeVisible({ timeout: 12_000 });
    await expect(tuner.locator('.mic-tuner-fill')).toHaveCount(0);
    await expectGauge(tuner, /A3\s*-(29|30|31) cents/);
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

for (const width of [390, 1440]) {
  test(`microphone readout keeps karaoke geometry stable ${width}px`, async ({ page, openPitchJob }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    await openPitchJob();
    const tuner = page.getByRole('region', { name: 'Live microphone pitch' });
    const reading = tuner.locator('.mic-tuner-reading');
    const karaoke = page.getByRole('region', { name: 'Current karaoke line' });
    await tuner.getByRole('button', { name: 'Start microphone pitch detection' }).click();
    const geometry = async () => ({
      tuner: await tuner.boundingBox(),
      reading: await reading.boundingBox(),
      karaoke: await karaoke.boundingBox(),
    });
    await expect(reading).toHaveText(/E4\s*0 cents/, { timeout: 12_000 });
    const note = await geometry();
    await page.screenshot({ path: info.outputPath(`microphone-note-${width}.png`), fullPage: true, animations: 'disabled' });
    await expect(reading).toHaveText(/E4\s*\+3[4-6] cents/, { timeout: 12_000 });
    const sharp = await geometry();
    await expect(reading).toHaveText('Listening for a clear note…', { timeout: 12_000 });
    const silence = await geometry();
    await page.screenshot({ path: info.outputPath(`microphone-silence-${width}.png`), fullPage: true, animations: 'disabled' });
    await expect(reading).toHaveText(/C#4\s*0 cents/, { timeout: 12_000 });
    const longName = await geometry();
    await page.screenshot({ path: info.outputPath(`microphone-sharp-name-${width}.png`), fullPage: true, animations: 'disabled' });
    await info.attach('microphone-geometry', { body: JSON.stringify({ note, sharp, silence, longName }), contentType: 'application/json' });
    console.log(`microphone geometry ${width}:`, JSON.stringify({ note, sharp, silence, longName }));
    for (const sample of [sharp, silence, longName]) {
      expect(sample.reading!.height).toBeCloseTo(note.reading!.height, 1);
      expect(sample.tuner!.height).toBeCloseTo(note.tuner!.height, 1);
      expect(sample.karaoke!.y).toBeCloseTo(note.karaoke!.y, 1);
      expect(sample.karaoke!.height).toBeCloseTo(note.karaoke!.height, 1);
    }
  });
}

test('switches live input and stops the previous capture', async ({ page, openPitchJob }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const calls: MediaStreamConstraints[] = [], streams: MediaStream[] = [];
    Object.defineProperty(window, '__selectedMicTest', { value: { calls, streams } });
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'audioinput', deviceId: 'default', label: 'Default', groupId: '', toJSON() {} },
      { kind: 'audioinput', deviceId: 'synthetic-one', label: 'Studio input', groupId: 'one', toJSON() {} },
    ] as MediaDeviceInfo[];
    navigator.mediaDevices.getUserMedia = async constraints => {
      calls.push(constraints);
      const audio = constraints.audio as MediaTrackConstraints;
      const id = (audio.deviceId as ConstrainDOMStringParameters | undefined)?.exact;
      const context = new AudioContext();
      const oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
      oscillator.frequency.value = id === 'synthetic-one' ? 277.1826309 : 329.6275569;
      gain.gain.value = 0.25;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      await context.resume();
      streams.push(destination.stream);
      return destination.stream;
    };
  });
  await openPitchJob();
  const tuner = page.getByRole('region', { name: 'Live microphone pitch' });
  const picker = tuner.getByRole('combobox', { name: 'Microphone input' });
  expect(await page.evaluate(() => (window as unknown as { __selectedMicTest: { calls: MediaStreamConstraints[] } }).__selectedMicTest.calls.length)).toBe(0);
  await tuner.getByRole('button', { name: 'Start microphone pitch detection' }).click();
  await expect(tuner.locator('.mic-tuner-reading')).toHaveText(/E4\s*0 cents/, { timeout: 12_000 });
  const backing = page.locator('audio:not([hidden])').first();
  await backing.evaluate(audio => (audio as HTMLAudioElement).play());
  const beforeSwitch = await backing.evaluate(audio => (audio as HTMLAudioElement).currentTime);
  await picker.selectOption('synthetic-one');
  await expect(tuner.locator('.mic-tuner-reading')).toHaveText(/C#4\s*0 cents/, { timeout: 12_000 });
  await expect.poll(() => backing.evaluate(audio => (audio as HTMLAudioElement).currentTime)).toBeGreaterThan(beforeSwitch + 0.1);
  expect(await backing.evaluate(audio => (audio as HTMLAudioElement).paused)).toBe(false);
  expect(await page.evaluate(() => {
    const state = (window as unknown as { __selectedMicTest: { calls: MediaStreamConstraints[]; streams: MediaStream[] } }).__selectedMicTest;
    return { firstStopped: state.streams[0].getTracks().every(track => track.readyState === 'ended'), constraints: state.calls[1] };
  })).toMatchObject({ firstStopped: true, constraints: { audio: { deviceId: { exact: 'synthetic-one' } } } });
  await tuner.getByRole('button', { name: 'Stop microphone pitch detection' }).click();
  expect(await page.evaluate(() => (window as unknown as { __selectedMicTest: { streams: MediaStream[] } }).__selectedMicTest.streams[1].getTracks().every(track => track.readyState === 'ended'))).toBe(true);
});

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
