import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AlignedWordDTO, JobDTO, ReferenceLineDTO } from '../src/api';

// UI-only HTTP fixtures, not backend alignment or Modal proof. The browser still
// decodes/plays real public-domain audio and drives the production media clock.
const longLine = 'A lighthouse watches over quiet boats while silver clouds drift above the harbor and patient travelers follow the winding shoreline past sleeping gardens and distant windows until the morning carries every tired sailor safely homeward';
const rapidWords = ['Bright', 'small', 'sparks', 'rise', 'then', 'fall', 'soft', 'rain'];
let original: Buffer;
let transformed: Buffer;
let transformedPlayback: Buffer;

test.beforeAll(() => {
  const source = resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg');
  original = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', source, '-t', '45',
    '-codec:a', 'libvorbis', '-f', 'ogg', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
  transformed = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-af', 'atempo=1.25', '-codec:a', 'libmp3lame', '-f', 'mp3', 'pipe:1'],
  { input: original, maxBuffer: 16 * 1024 * 1024 });
  transformedPlayback = execFileSync('uv', ['run', 'python', '-c', String.raw`
import sys
from pathlib import Path
from backend.playback import listening_path
root=Path(sys.argv[1])
source=root / 'karaoke-listening-source.mp3'
source.write_bytes(sys.stdin.buffer.read())
result=listening_path(source,root / 'karaoke-listening-cache')
assert result is not None
sys.stdout.buffer.write(result.read_bytes())
`, process.env.E2E_FIXTURE_DIR!], {
    cwd: process.env.E2E_REPO_ROOT!, input: transformed, maxBuffer: 16 * 1024 * 1024,
  });
});

function aligned(text: string, start: number, end: number): AlignedWordDTO {
  return { text, start_s: start * 1.25, end_s: end * 1.25, probability: null, origin: 'reference-aligned' };
}

function phrase(text: string, start: number, end: number): ReferenceLineDTO {
  return { text, start_s: start * 1.25, end_s: end * 1.25, status: 'aligned', support: 0.8,
    reason: 'Purpose-built UI timing fixture', unconfirmed_words: [], recognized_variant: null };
}

function karaokeJob(): JobDTO {
  const words = [aligned('silver', 4, 6), aligned('Next', 9.5, 10.5), aligned('chorus', 11, 12.5),
    aligned('lighthouse', 22, 27), ...rapidWords.map((text, index) => ({
      ...aligned(text, 32 + index / 10, 32 + (index + 1) / 10), origin: 'asr-extra' as const,
    }))];
  const labels = ['vocals', 'vocals-dry', 'vocals-decrowded', 'vocals-decrowded-dry', 'vocals-male',
    'vocals-male-dry', 'vocals-female', 'vocals-female-dry', 'lead', 'lead-dry', 'backing', 'backing-dry',
    'instruments', 'instruments-decrowded', 'drums', 'bass', 'other-instruments'];
  return {
    id: 9401, status: 'done', position: null, source_type: 'upload', source_value: 'karaoke-ui.ogg',
    title: 'Karaoke native-media UI fixture', original_key: 'C major', output_key: 'C# major',
    error_message: null, created_at: 1, has_original: true, has_pitch_vocals: true,
    options: { extract_vocals: true, extract_instruments: true, extract_lyrics: true, detect_pitch: true,
      extract_pitched_lyrics: false, mixes: [], decrowd: true, decrowd_vocals: true, dereverb: true,
      genders: true, lead_backing: true, drums: true, pitch_semitones: 1.25, tempo_percent: 125 },
    manifest: labels.map(label => ({ label, filename: `${label}.mp3`,
      download_name: `karaoke-ui - ${label} - pitch+1.25st - tempo125pct.mp3`, size_bytes: transformed.length, duration_s: 36 })),
    transcript: {
      status: 'recognized', language: 'en', timestamp_reference: 'original', structure_model: null,
      sections: [], segments: [], timestamped_text: '', words,
      canonical_word_positions: [
        { word_index: 0, reference_line_index: 0, reference_token_index: 1 },
        { word_index: 1, reference_line_index: 1, reference_token_index: 0 },
        { word_index: 2, reference_line_index: 1, reference_token_index: 1 },
        { word_index: 3, reference_line_index: 2, reference_token_index: 1 },
      ],
      reference: { status: 'partial', reason: 'UI fixture', provider: 'fixture', source_url: null, record_id: null,
        artist: null, title: null, album: null, duration_s: null, agreement: null, corrections: [],
        original_segments: [], original_words: [], lines: [phrase('Before silver after', 3, 9),
          phrase('Next chorus', 9.5, 12.5), phrase(longLine, 20, 30)] },
    },
    pitch: { version: 1, model: 'UI fixture, no inference', source_duration_s: 45, duration_s: 36,
      pitch_shift_semitones: 1.25, tempo_percent: 125, timestamp_reference: 'output', pitch_reference: 'output',
      word_alignment: 'UI fixture', words: words.map(word => ({ ...word, start_s: word.start_s / 1.25, end_s: word.end_s / 1.25 })),
      tracks: ['lead', 'backing'].map(label => ({ label, notes: [
        { start_s: 4, end_s: 6, midi: 61.25, frequency_hz: 280, confidence: 0.8, note: 'C#4', cents: 25, word_indices: [0] },
      ] })) },
  };
}

async function mountFixture(page: Page) {
  const job = karaokeJob();
  await page.route('**/api/jobs**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    expect(route.request().method(), 'this UI fixture must never submit an analysis job').toBe('GET');
    if (path === '/api/jobs/current' || path === `/api/jobs/${job.id}`) return route.fulfill({ json: job });
    if (path === '/api/jobs') return route.fulfill({ json: [] });
    const isOriginal = path === `/api/jobs/${job.id}/original`;
    if (isOriginal || path.startsWith(`/api/jobs/${job.id}/results/`) || path === `/api/jobs/${job.id}/pitch-reference/vocals`) {
      const listening = !isOriginal && url.searchParams.get('playback') === '1';
      const bytes = isOriginal ? original : listening ? transformedPlayback : transformed;
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      return route.fulfill({ status: range ? 206 : 200, body: bytes.subarray(start, end + 1),
        contentType: isOriginal ? 'audio/ogg' : listening ? 'audio/mp4' : 'audio/mpeg', headers: {
          'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
        } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  const view = page.getByLabel('Vocal pitch analysis', { exact: true });
  await expect(view).toBeVisible();
  const player = view.locator('audio');
  await view.getByRole('combobox', { name: 'Pitch background audio' }).selectOption('song');
  await player.evaluate((audio: HTMLAudioElement) => { audio.preload = 'auto'; audio.load(); });
  await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.readyState >= 2 && audio.seekable.length > 0)).toBe(true);
  return { view, player, reader: view.getByRole('region', { name: 'Current karaoke line' }) };
}

async function seekNative(player: Locator, seconds: number) {
  await player.evaluate(async (audio: HTMLAudioElement, time) => {
    audio.pause();
    const sought = Promise.withResolvers<void>();
    audio.addEventListener('seeked', () => sought.resolve(), { once: true });
    audio.currentTime = time;
    await sought.promise;
    const painted = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => painted.resolve()));
    await painted.promise;
  }, seconds);
}

interface PaintSample {
  time: number;
  text: string;
  active: string | null;
  opacity: number;
  transform: string;
  gradient: string;
}

async function samplePlayback(player: Locator, milliseconds: number): Promise<PaintSample[]> {
  return player.evaluate(async (audio: HTMLAudioElement, duration) => {
    const region = document.querySelector('[aria-label="Current karaoke line"]')!;
    const samples: PaintSample[] = [];
    await audio.play();
    const start = performance.now();
    const complete = Promise.withResolvers<void>();
    function frame() {
      const line = region.querySelector('p')!;
      const active = region.querySelector('[aria-current="true"]');
      const style = getComputedStyle(line);
      samples.push({ time: audio.currentTime, text: line.textContent ?? '', active: active?.textContent ?? null,
        opacity: Number(style.opacity), transform: style.transform,
        gradient: active ? getComputedStyle(active).backgroundImage : 'none' });
      if (performance.now() - start >= duration) { audio.pause(); complete.resolve(); }
      else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    await complete.promise;
    return samples;
  }, milliseconds);
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`karaoke native-media reader ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width === 390, hasTouch: viewport.width === 390, deviceScaleFactor: 1 });
    test('maps native clocks, paints timed words, and keeps wrapped/rapid cues readable', async ({ page }, info) => {
      test.setTimeout(120_000);
      const { view, player, reader } = await mountFixture(page);
      const source = view.getByRole('combobox', { name: 'Pitch background audio' });
      await reader.scrollIntoViewIfNeeded();

      // Original native clock: 5.625s / 1.25 = output4.5, a quarter through silver.
      await seekNative(player, 2.5);
      await expect(reader).toHaveText('Before silver after');
      await expect(reader.locator('[aria-current]')).toHaveCount(0);
      await seekNative(player, 5.625);
      const silver = reader.getByText('silver', { exact: true });
      await expect(silver).toHaveAttribute('aria-current', 'true');
      await expect.poll(() => reader.locator('p').evaluate(line => Number(getComputedStyle(line).opacity))).toBe(1);
      const quarterPaint = await silver.screenshot({ animations: 'disabled' });
      const originalGradient = await silver.evaluate(word => getComputedStyle(word).backgroundImage);
      expect(originalGradient).toContain('linear-gradient');
      const sung = await samplePlayback(player, 700);
      expect(sung.at(-1)!.time - sung[0].time).toBeGreaterThan(0.3);
      expect(sung.every(sample => sample.active === 'silver')).toBe(true);
      expect(new Set(sung.map(sample => sample.gradient)).size).toBeGreaterThan(3);
      expect(Math.min(...sung.map(sample => sample.opacity)), 'native-clock updates must not restart the current line fade').toBeGreaterThanOrEqual(0.99);
      await seekNative(player, 5.625);
      await source.selectOption('vocals');
      await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(4.5, 2);
      await expect(silver).toHaveAttribute('aria-current', 'true');
      await expect.poll(() => silver.evaluate(word => getComputedStyle(word).backgroundImage)).toBe(originalGradient);
      await seekNative(player, 5.5);
      const laterPaint = await silver.screenshot({ animations: 'disabled' });
      expect(laterPaint.equals(quarterPaint), 'actual rasterized word fill must advance within the same word').toBe(false);
      await info.attach('silver-quarter-fill', { body: quarterPaint, contentType: 'image/png' });
      await info.attach('silver-three-quarter-fill', { body: laterPaint, contentType: 'image/png' });

      await seekNative(player, 8.75);
      await expect(reader).toHaveText('Before silver after');
      await expect(reader.locator('[aria-current]')).toHaveCount(0);
      await seekNative(player, 9);
      await expect(reader).toHaveText('Next chorus');
      await expect(reader.locator('[aria-current]')).toHaveCount(0);
      await seekNative(player, 9.5);
      await expect(reader.locator('[aria-current]')).toHaveText('Next');
      const back = view.getByRole('button', { name: 'Back 5 seconds', exact: true });
      if (viewport.width === 390) await back.tap(); else await back.click();
      await expect(reader.locator('[aria-current]')).toHaveText('silver');
      await seekNative(player, 16);
      await expect(reader).toHaveText('Next chorus');
      await expect(reader.locator('[aria-current]')).toHaveCount(0);

      await seekNative(player, 22.5);
      await expect(reader).toHaveText(longLine);
      await reader.scrollIntoViewIfNeeded();
      const geometry = await reader.evaluate(region => {
        const line = region.querySelector('p')!;
        const rect = region.getBoundingClientRect();
        const rows = new Set([...region.querySelectorAll('span')].map(word => Math.round(word.getBoundingClientRect().top)));
        return { viewport: innerWidth, document: document.documentElement.scrollWidth,
          left: rect.left, right: rect.right, rows: rows.size, height: rect.height,
          scrollHeight: region.scrollHeight, clientHeight: region.clientHeight, font: Number.parseFloat(getComputedStyle(line).fontSize) };
      });
      expect(geometry.viewport).toBe(viewport.width);
      expect(geometry.document).toBeLessThanOrEqual(viewport.width);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(viewport.width);
      expect(geometry.rows).toBeGreaterThan(1);
      expect(geometry.font).toBeGreaterThanOrEqual(16);
      await reader.screenshot({ path: info.outputPath('long-wrapped-karaoke.png'), animations: 'disabled' });
      await reader.focus();
      await reader.press('End');
      await expect(reader).toBeFocused();
      await expect.poll(async () => {
        const [word, region] = await Promise.all([
          reader.getByText('homeward', { exact: true }).boundingBox(), reader.boundingBox(),
        ]);
        return !!word && !!region && word.y >= region.y && word.y + word.height <= region.y + region.height + 1;
      }, { message: 'Keyboard scrolling must expose the complete wrapped lyric tail' }).toBe(true);
      const longSung = await samplePlayback(player, 700);
      expect(Math.min(...longSung.map(sample => sample.opacity)), 'word updates must not repeatedly fade a long cue').toBeGreaterThanOrEqual(0.99);
      await expect(reader.getByText('homeward', { exact: true })).toBeInViewport();

      await seekNative(player, 32);
      await expect(reader).toBeFocused();
      await expect(reader.getByText('Bright', { exact: true })).toBeInViewport();
      const rapid = await samplePlayback(player, 850);
      const sungRapid = rapid.filter(sample => rapidWords.includes(sample.text));
      expect(new Set(sungRapid.map(sample => sample.text)).size).toBeGreaterThanOrEqual(5);
      expect(Math.min(...sungRapid.map(sample => sample.opacity)), '100ms word cues must never spend their whole life transparent').toBeGreaterThanOrEqual(0.65);
      expect(await reader.evaluate(region => region.getBoundingClientRect().height)).toBeCloseTo(geometry.height, 0);

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await seekNative(player, 32);
      const reduced = await samplePlayback(player, 850);
      const reducedCues = reduced.filter(sample => rapidWords.includes(sample.text));
      expect(new Set(reducedCues.map(sample => sample.text)).size).toBeGreaterThanOrEqual(5);
      expect(reducedCues.every(sample => sample.opacity === 1 && sample.transform === 'none')).toBe(true);
      await info.attach('native-karaoke-paint-proof', { body: JSON.stringify({
        scope: 'Fixture HTTP data + actual native media decoding/playback; not backend alignment inference',
        viewport, geometry, sung, longSung, rapid, reduced,
      }, null, 2), contentType: 'application/json' });
    });
  });
}
