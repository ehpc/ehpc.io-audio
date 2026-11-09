import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { transform } from 'esbuild';
import { test } from './auth-fixture';

test.use({ hasTouch: true });

const seed = String.raw`
import json,os,subprocess,sys
from pathlib import Path
from backend import config,db
from backend.pitch_reference import persist_pitch_vocals
from backend.queue import _persist_results
from separator.pitch import pitch_from_json,pitch_to_json
assert config.QUEUE_CONCURRENCY == 0
assert config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
job=db.get_job(int(sys.argv[1]))
source=(config.UPLOADS_DIR / str(job.id) / job.source_value).read_bytes()
converted=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i','pipe:0','-t','20','-codec:a','libmp3lame','-f','mp3','pipe:1'],input=source,capture_output=True,check=True).stdout
persist_pitch_vocals(job,converted)
manifest=_persist_results(job,{})
db.mark_done(job.id,manifest,None,pitch_to_json(pitch_from_json(json.dumps(json.load(sys.stdin)['pitch']))))
`;

for (const width of [390, 1280]) {
  test(`piano follows playback and accepts a held pointer at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      const contexts: AudioContext[] = [];
      Object.defineProperty(window, '__pianoContexts', { value: contexts });
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor() { super(); contexts.push(this); }
      };
    });
    await page.goto('/');
    const root = process.env.E2E_REPO_ROOT!;
    const source = await readFile(resolve(root, 'tests/fixtures/auld-lang-syne-full.ogg'));
    const fixture = JSON.parse(await readFile(resolve(root, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8'));
    fixture.pitch.tracks[0].notes = [
      { ...fixture.pitch.tracks[0].notes[0], start_s: 1, end_s: 4, midi: 60, note: 'C4' },
      { ...fixture.pitch.tracks[0].notes[0], start_s: 5, end_s: 8, midi: 84, note: 'C6' },
    ];
    fixture.pitch.tracks = [fixture.pitch.tracks[0]];
    const response = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
      file: { name: 'voice.ogg', mimeType: 'audio/ogg', buffer: source }, detect_pitch: 'true', pitch_semitones: '1.25', tempo_percent: '125',
    } });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).id as number;
    execFileSync('uv', ['run', 'python', '-c', seed, String(id)], { cwd: root, input: JSON.stringify(fixture), env: { ...process.env, UV_NO_SYNC: '1', DATA_DIR: process.env.E2E_DATA_DIR! } });
    await page.reload();
    const piano = page.getByRole('region', { name: 'Piano keyboard' });
    await expect(piano).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const key = piano.getByRole('button', { name: 'Piano C4', exact: true });
    await key.scrollIntoViewIfNeeded();
    const box = (await key.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
    await page.mouse.down();
    await expect(key).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __pianoContexts: AudioContext[] }).__pianoContexts[0]?.state)).toBe('running');
    await page.mouse.up();
    await expect(key).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __pianoContexts: AudioContext[] }).__pianoContexts[0]?.state)).toBe('suspended');
    if (width === 390) {
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 8);
      await expect(key).toHaveAttribute('aria-pressed', 'false');
      const scroll = piano.locator('.piano-scroll');
      const bounds = (await scroll.boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      const point = (x: number) => ({ x, y: bounds.y + bounds.height - 15, id: 1 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(bounds.x + bounds.width - 30)] });
      for (let x = bounds.x + bounds.width - 60; x > bounds.x + 35; x -= 30)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(x)] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      await cdp.detach();
      await key.scrollIntoViewIfNeeded();
    }
    await key.focus();
    await page.keyboard.down('Space');
    await expect(key).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.up('Space');
    await expect(key).toHaveAttribute('aria-pressed', 'false');
    const audio = page.getByLabel('Vocal pitch analysis', { exact: true }).locator('audio:not([hidden])');
    await audio.evaluate(async (element: HTMLAudioElement) => { element.currentTime = 1.2; await element.play(); });
    await expect(key).toHaveAttribute('aria-pressed', 'true');
    await audio.evaluate((element: HTMLAudioElement) => element.pause());
    await expect(key).toHaveAttribute('aria-pressed', 'false');
    const high = piano.getByRole('button', { name: 'Piano C6', exact: true });
    await audio.evaluate(async (element: HTMLAudioElement) => { element.currentTime = 5.2; await element.play(); });
    await expect(high).toHaveAttribute('aria-pressed', 'true');
    const visible = await high.evaluate(element => {
      const key = element.getBoundingClientRect();
      const viewport = element.closest('.piano-scroll')!.getBoundingClientRect();
      return key.left >= viewport.left && key.right <= viewport.right;
    });
    expect(visible).toBe(true);
    if (width === 390) {
      const scroll = piano.locator('.piano-scroll');
      const before = await scroll.evaluate(element => element.scrollLeft);
      const highBox = (await high.boundingBox())!;
      await page.mouse.move(highBox.x + highBox.width / 2, highBox.y + highBox.height - 8);
      await page.mouse.down();
      await audio.evaluate((element: HTMLAudioElement) => { element.currentTime = 1.2; });
      await expect(key).toHaveAttribute('aria-pressed', 'true');
      expect(await scroll.evaluate(element => element.scrollLeft)).toBe(before);
      await page.mouse.up();
      await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeLessThan(before);
    }
    await audio.evaluate((element: HTMLAudioElement) => element.pause());
    if (width === 1280) {
      await high.focus();
      await page.keyboard.down('Space');
      await expect(high).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Start another job' }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __pianoContexts: AudioContext[] }).__pianoContexts[0]?.state)).toBe('closed');
    }
    expect(await page.evaluate(() => (window as unknown as { __pianoContexts: AudioContext[] }).__pianoContexts.length)).toBe(1);
  });
}

test('real offline Web Audio has a pitched attack, sustain and release', async ({ page }) => {
  await page.goto('/');
  const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/src/lib/pianoAudio.ts'), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'iife', globalName: 'PianoAudio' });
  await page.addScriptTag({ content: compiled.code });
  const result = await page.evaluate(async () => {
    const context = new OfflineAudioContext(1, 48000 * 2, 48000);
    const piano = (window as unknown as { PianoAudio: { createPianoVoice(context: BaseAudioContext, midi: number, destination: AudioNode, onEnd: () => void): { release(at: number): void } } }).PianoAudio;
    let disconnects = 0;
    let ended = false;
    const original = AudioNode.prototype.disconnect;
    AudioNode.prototype.disconnect = function (...args: unknown[]) {
      disconnects++;
      return Reflect.apply(original, this, args);
    } as typeof AudioNode.prototype.disconnect;
    piano.createPianoVoice(context, 69, context.destination, () => { ended = true; }).release(1.2);
    const samples = (await context.startRendering()).getChannelData(0);
    await new Promise(resolve => setTimeout(resolve, 50));
    AudioNode.prototype.disconnect = original;
    const rms = (start: number, end: number) => {
      let sum = 0;
      for (let i = start * 48000; i < end * 48000; i++) sum += samples[i] ** 2;
      return Math.sqrt(sum / ((end - start) * 48000));
    };
    let crossings = 0;
    for (let i = 24001; i < 48000; i++) if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
    return { attack: rms(0.02, 0.1), sustain: rms(0.8, 1.1), released: rms(1.5, 1.8), frequency: crossings * 2, disconnects, ended };
  });
  expect(result.attack).toBeGreaterThan(result.sustain);
  expect(result.sustain).toBeGreaterThan(0.003);
  expect(result.released).toBeLessThan(0.00001);
  expect(result.frequency).toBeGreaterThan(435);
  expect(result.frequency).toBeLessThan(445);
  expect(result.ended).toBe(true);
  expect(result.disconnects).toBe(7);
});
