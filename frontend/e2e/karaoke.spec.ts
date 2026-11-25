import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './auth-fixture';
import type { AlignedWordDTO, JobDTO, ReferenceLineDTO } from '../src/api';

interface NativePlaybackState {
  time: number;
  paused: boolean;
  seeking: boolean;
  muted: boolean;
}
interface PresetTransition {
  before: NativePlaybackState[];
  after: NativePlaybackState[];
}

// UI-only HTTP fixtures, not backend alignment or Modal proof. The browser still
// decodes/plays real public-domain audio and drives the production media clock.
const longLine = 'A lighthouse watches over quiet boats while silver clouds drift above the harbor and patient travelers follow the winding shoreline past sleeping gardens and distant windows until the morning carries every tired sailor safely homeward';
const rapidWords = ['Bright', 'small', 'sparks', 'rise', 'then', 'fall', 'soft', 'rain'];
const leadPitches = ['C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4', 'G#4', 'A4', 'A#4', 'B4', 'C5',
  'C#5', 'D5', 'D#5', 'E5', 'F5', 'F#5', 'G5', 'G#5', 'A5', 'A#5', 'B5', 'C6'];
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
    title: 'Karaoke native-media UI fixture', original_key: 'C major', output_key: 'C# major', result_revision: null,
    error_message: null, created_at: 1, has_original: true, has_pitch_vocals: true,
    lyric_pitch_lines: null,
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
      presentation_lines: [
        { text: 'Before silver, after', source_kind: 'canonical', source_index: 0, canonical_line_index: 0,
          onset_s: 3.75, end_s: null, onset_source: 'provider-synced', words: [{ word_index: 0, token_index: 1 }] },
        { text: 'Next chorus', source_kind: 'canonical', source_index: 1, canonical_line_index: 1,
          onset_s: 11.25, end_s: null, onset_source: 'provider-synced', words: [{ word_index: 1, token_index: 0 }, { word_index: 2, token_index: 1 }] },
        { text: longLine, source_kind: 'canonical', source_index: 2, canonical_line_index: 2,
          onset_s: 25, end_s: null, onset_source: 'provider-synced', words: [{ word_index: 3, token_index: 1 }] },
        { text: 'The harbor rests', source_kind: 'canonical', source_index: 3, canonical_line_index: 3,
          onset_s: 42.5, end_s: null, onset_source: 'provider-synced', words: [] },
        ...rapidWords.map((text, index) => ({ text, source_kind: 'asr-word' as const, source_index: index + 4,
          canonical_line_index: null, onset_s: (32 + index / 10) * 1.25, end_s: (32 + (index + 1) / 10) * 1.25,
          onset_source: 'acoustic' as const, words: [{ word_index: index + 4, token_index: 0 }] })),
      ],
      reference: { status: 'partial', reason: 'UI fixture', provider: 'fixture', source_url: null, record_id: null,
        artist: null, title: null, album: null, duration_s: null, agreement: null, corrections: [],
        original_segments: [], original_words: [], lines: [phrase('Before silver, after', 3, 9),
          phrase('Next chorus', 9.5, 12.5), phrase(longLine, 20, 30), phrase('The harbor rests', 34, 35)] },
    },
    pitch: { version: 1, model: 'UI fixture, no inference', source_duration_s: 45, duration_s: 36,
      pitch_shift_semitones: 1.25, tempo_percent: 125, timestamp_reference: 'output', pitch_reference: 'output',
      word_alignment: 'UI fixture', words: words.map(word => ({ ...word, start_s: word.start_s / 1.25, end_s: word.end_s / 1.25 })),
      tracks: ['lead', 'backing'].map(label => ({ label, notes: label === 'lead'
        ? [...leadPitches.map((note, index) => ({ start_s: 4 + index * 0.08, end_s: 4 + (index + 1) * 0.08 - 0.000001,
          midi: 61 + index, frequency_hz: 440 * 2 ** ((61 + index - 69) / 12), confidence: 0.8, note, cents: 0, word_indices: [0] })),
          ...['F#4', 'G#4', 'A#4'].map((note, index) => ({ start_s: 9.5 + index * 0.2, end_s: 9.5 + (index + 1) * 0.2 - 0.000001,
            midi: 66 + index * 2, frequency_hz: 440, confidence: 0.8, note, cents: 0, word_indices: [1] })),
          ...['C#5', 'D#5', 'F#5'].map((note, index) => ({ start_s: 11 + index * 0.2, end_s: 11 + (index + 1) * 0.2 - 0.000001,
            midi: 73 + index * 2, frequency_hz: 554.4, confidence: 0.8, note, cents: 0, word_indices: [2] }))]
        : [{ start_s: 4, end_s: 6, midi: 64, frequency_hz: 329.6, confidence: 0.8, note: 'E4', cents: 0, word_indices: [0] }] })) },
  };
}

interface InstrumentGate {
  gate: Promise<void>;
  requested: () => void;
}

async function mountFixture(page: Page, job = karaokeJob(), instruments?: InstrumentGate, tones?: { instruments: Buffer; vocals: Buffer }, vocals?: InstrumentGate) {
  // Use the same read-time projection as real API jobs, including modified fixtures.
  job.lyric_pitch_lines = JSON.parse(execFileSync('uv', ['run', 'python', '-c', String.raw`
import json,sys
from dataclasses import asdict
from separator.lyric_pitch import lyric_pitch_lines
from separator.lyrics import transcript_from_json
from separator.pitch import pitch_from_json
value=json.load(sys.stdin)
print(json.dumps([asdict(line) for line in lyric_pitch_lines(
    transcript_from_json(json.dumps(value['transcript'])),
    pitch_from_json(json.dumps(value['pitch'])))]))
`,], { cwd: process.env.E2E_REPO_ROOT!, input: JSON.stringify({ transcript: job.transcript, pitch: job.pitch }), encoding: 'utf8' }));
  await page.route('**/api/jobs**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    expect(route.request().method(), 'this UI fixture must never submit an analysis job').toBe('GET');
    if (path === '/api/jobs/current' || path === `/api/jobs/${job.id}`) return route.fulfill({ json: job });
    if (path === '/api/jobs') return route.fulfill({ json: [] });
    const isOriginal = path === `/api/jobs/${job.id}/original`;
    if (instruments && path === `/api/jobs/${job.id}/results/instruments`) {
      instruments.requested();
      await instruments.gate;
    }
    if (vocals && (path === `/api/jobs/${job.id}/results/vocals` || path === `/api/jobs/${job.id}/pitch-reference/vocals`)) {
      vocals.requested();
      await vocals.gate;
    }
    if (isOriginal || path.startsWith(`/api/jobs/${job.id}/results/`) || path === `/api/jobs/${job.id}/pitch-reference/vocals`) {
      const listening = !isOriginal && url.searchParams.get('playback') === '1';
      const tone = path.endsWith('/results/instruments') ? tones?.instruments
        : path.endsWith('/results/vocals') || path.endsWith('/pitch-reference/vocals') ? tones?.vocals : undefined;
      const bytes = isOriginal ? original : listening ? tone ?? transformedPlayback : transformed;
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
  const view = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
  await expect(view).toBeVisible();
  const player = page.locator('.pitch-view audio:not([hidden])');
  const song = view.getByRole('group', { name: 'Pitch background audio' }).getByRole('button', { name: 'Full song' });
  await song.click();
  await expect(song).toHaveAttribute('aria-pressed', 'true');
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

async function lyricText(line: Locator) {
  return line.evaluate(element => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.timeline-karaoke-pitches').forEach(pitch => pitch.remove());
    return copy.textContent ?? '';
  });
}

async function samplePlayback(player: Locator, milliseconds: number): Promise<PaintSample[]> {
  return player.evaluate(async (audio: HTMLAudioElement, duration) => {
    const region = document.querySelector('[aria-label="Current karaoke line"]')!;
    const samples: PaintSample[] = [];
    await audio.play();
    const start = performance.now();
    const complete = Promise.withResolvers<void>();
    function frame() {
      const line = region.querySelector('[aria-label="Current lyrics"]')!;
      const copy = line.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.timeline-karaoke-pitches').forEach(pitch => pitch.remove());
      const active = line.querySelector('[aria-current="true"]');
      const style = getComputedStyle(line);
      samples.push({ time: audio.currentTime, text: copy.textContent ?? '', active: active?.textContent ?? null,
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

async function fittedRows(reader: Locator) {
  return reader.evaluate(element => {
    const frame = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>('.timeline-karaoke-line')].map(row => {
      const range = document.createRange();
      range.selectNodeContents(row);
      const content = range.getBoundingClientRect();
      const words = [...row.querySelectorAll<HTMLElement>('.timeline-karaoke-word')].map(word => word.getBoundingClientRect());
      const pitches = [...row.querySelectorAll<HTMLElement>('.timeline-karaoke-pitches')].map(pitch => {
        const text = document.createRange();
        text.selectNodeContents(pitch);
        return text.getClientRects().length;
      });
      const pitchCenters = [...row.querySelectorAll<HTMLElement>('.timeline-karaoke-pitches')].map(pitch => {
        const cell = pitch.parentElement!.getBoundingClientRect();
        const lyric = pitch.parentElement!.querySelector<HTMLElement>('.timeline-karaoke-lyric')!.getBoundingClientRect();
        return Math.abs((cell.left + cell.right - lyric.left - lyric.right) / 2);
      });
      const box = row.getBoundingClientRect();
      return { left: content.left, right: content.right, top: content.top, bottom: content.bottom,
        boxTop: box.top, boxBottom: box.bottom,
        center: (content.left + content.right) / 2, centerTarget: (frame.left + frame.right) / 2,
        singleWordRow: words.every(word => Math.abs(word.bottom - (words[0]?.bottom ?? word.bottom)) < 2),
        pitches, pitchCenters };
    });
    return { frame: frame.toJSON(), font: parseFloat(getComputedStyle(element).fontSize),
      documentWidth: document.documentElement.scrollWidth, viewport: innerWidth, rows };
  });
}

async function largerThanFitOverflows(reader: Locator) {
  return reader.evaluate(element => {
    const initial = element.style.fontSize;
    element.style.fontSize = `${parseFloat(initial) * 1.05}px`;
    const rows = [...element.querySelectorAll<HTMLElement>('.timeline-karaoke-line')];
    const padding = getComputedStyle(element);
    const available = element.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
    const overflows = rows.some(row => {
      const text = document.createRange();
      text.selectNodeContents(row);
      return text.getBoundingClientRect().width > row.clientWidth;
    }) || rows.reduce((total, row) => total + row.getBoundingClientRect().height, 0) > available;
    element.style.fontSize = initial;
    return overflows;
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`karaoke native-media reader ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width === 390, hasTouch: viewport.width === 390, deviceScaleFactor: 1 });
    test('keeps keyboard playback available when the intro becomes the first cue', async ({ page }) => {
      const { view, player, reader } = await mountFixture(page);
      const hint = reader.getByText('Lyrics begin shortly');
      await hint.click();
      await expect(reader).toBeFocused();
      await page.keyboard.press('Space');
      await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
      await player.evaluate(async (audio: HTMLAudioElement) => {
        const sought = Promise.withResolvers<void>();
        audio.addEventListener('seeked', () => sought.resolve(), { once: true });
        audio.currentTime = 4;
        await sought.promise;
      });
      await expect(reader.getByLabel('Current lyrics')).toBeVisible();
      await expect(reader).toBeFocused();
      await page.keyboard.press('Space');
      await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);

      await seekNative(player, 1);
      const larger = view.getByRole('button', { name: 'Larger lyrics' });
      for (let i = 0; i < 8; i++) await larger.click();
      await reader.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(reader).toBeFocused();
      const bounds = await reader.boundingBox();
      if (viewport.width === 390) {
        await page.keyboard.press('End');
        await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      }
      await expect(reader.getByText('Lyrics begin shortly')).toBeVisible();
      expect(await reader.boundingBox()).toEqual(bounds);
      await page.keyboard.press('Space');
      await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
    });
    test('keeps the lyric reader frame fixed through changing cues and pitch labels', async ({ page }, info) => {
      const { view, player, reader } = await mountFixture(page);
      const frames = [];
      for (const seconds of [0, 5.625, 28.125, 42.5]) {
        await seekNative(player, seconds);
        frames.push(await reader.evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height }; }));
      }
      await view.getByRole('button', { name: 'Pitches', exact: true }).click();
      frames.push(await reader.evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height }; }));
      await seekNative(player, 11.875);
      const following = reader.getByRole('group', { name: 'Next lyrics' });
      await expect.poll(() => lyricText(following)).toBe(longLine);
      await following.focus();
      await following.press('End');
      await expect.poll(() => following.evaluate(row => row.scrollTop)).toBeGreaterThan(0);
      await seekNative(player, 28.125);
      await expect.poll(() => lyricText(reader.getByRole('group', { name: 'Current lyrics' }))).toBe(longLine);
      await expect.poll(() => reader.getByRole('group', { name: 'Current lyrics' }).evaluate(row => row.scrollTop)).toBe(0);
      await expect(reader.getByRole('group', { name: 'Current lyrics' })).toBeFocused();
      for (const seconds of [5.625, 28.125, 42.5]) {
        await seekNative(player, seconds);
        frames.push(await reader.evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height }; }));
      }
      await seekNative(player, 28.125);
      await expect.poll(() => lyricText(reader.getByRole('group', { name: 'Current lyrics' }))).toBe(longLine);
      const currentLine = reader.getByRole('group', { name: 'Current lyrics' });
      await currentLine.focus();
      await currentLine.press('End');
      await expect.poll(() => reader.getByText('homeward', { exact: true }).evaluate(element => {
        const box = element.getBoundingClientRect(), parent = element.closest('.timeline-karaoke-line')!.getBoundingClientRect();
        return box.bottom <= parent.bottom && box.top >= parent.top;
      })).toBe(true);
      await player.evaluate(audio => audio.play());
      await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(28.35);
      await player.evaluate(audio => audio.pause());
      expect(await currentLine.evaluate(row => row.scrollTop)).toBeGreaterThan(0);
      await reader.screenshot({ path: info.outputPath(`stable-reader-${viewport.width}.png`), animations: 'disabled' });
      await info.attach('reader-frame-transitions', { body: JSON.stringify(frames), contentType: 'application/json' });
      for (const group of [frames.slice(0, 4), frames.slice(4)]) for (const frame of group.slice(1)) {
        expect(frame.y).toBeCloseTo(group[0].y, 0);
        expect(frame.x).toBeCloseTo(group[0].x, 0);
        expect(frame.width).toBeCloseTo(group[0].width, 0);
        expect(frame.height).toBeCloseTo(group[0].height, 0);
      }
      for (const [trigger, name] of [['Open karaoke fullscreen', 'Karaoke fullscreen'], ['Lyrics learning mode', 'Lyrics learning mode'], ['Learn timings', 'Learn timings']] as const) {
        await view.getByRole('button', { name: trigger, exact: true }).click();
        const dialog = page.getByRole('dialog', { name, exact: true });
        await expect(dialog.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
        const fullscreenReader = dialog.getByRole('region', { name: 'Current karaoke line' });
        const before = await fullscreenReader.boundingBox();
        for (const seconds of [0, 5.625, 28.125]) {
          await seekNative(player, seconds);
          const after = await fullscreenReader.boundingBox();
          expect(after!.y).toBeCloseTo(before!.y, 0);
          expect(after!.height).toBeCloseTo(before!.height, 0);
          expect(after!.width).toBeCloseTo(before!.width, 0);
        }
        await dialog.getByRole('button', { name: 'Exit karaoke fullscreen' }).click();
      }
    });
    test('shows an estimated leading highlight before the independently timed word', async ({ page }, info) => {
      const { view, player, reader } = await mountFixture(page);
      await seekNative(player, 4.3);
      const current = reader.getByRole('group', { name: 'Current lyrics' });
      await expect.poll(() => lyricText(current)).toBe('Before silver, after');
      await expect(view.getByText('Synced line cues')).toBeVisible();
      await expect(current.locator('[aria-current="true"]')).toHaveText('Before');
      await expect(current.locator('[aria-current="true"]')).toHaveAttribute('data-timing', 'estimated');
      await view.locator('.pitch-footer').screenshot({ path: info.outputPath(`provider-line-${viewport.width}.png`), animations: 'disabled' });
      await player.evaluate((audio: HTMLAudioElement) => audio.play());
      await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(5.05);
      await expect(current.locator('[aria-current="true"]')).toHaveText('silver');
      await player.evaluate((audio: HTMLAudioElement) => audio.pause());
    });

    test('maps native clocks, paints timed words, and keeps wrapped/rapid cues readable', async ({ page }, info) => {
      test.setTimeout(120_000);
      const { view, player, reader } = await mountFixture(page);
      const source = view.getByRole('group', { name: 'Pitch background audio' });
      const current = reader.getByRole('group', { name: 'Current lyrics' });
      const next = reader.getByRole('group', { name: 'Next lyrics' });
      await reader.scrollIntoViewIfNeeded();

      // Original native clock: 5.625s / 1.25 = output4.5, a quarter through silver.
      await seekNative(player, 2.5);
      await expect.poll(() => lyricText(current)).toBe('Before silver, after');
      await expect.poll(() => lyricText(next)).toBe('Next chorus');
      await expect(reader.locator('[aria-current]')).toHaveCount(0);
      const pitchToggle = view.getByRole('button', { name: 'Pitches', exact: true });
      await pitchToggle.click();
      await seekNative(player, 5.625);
      const silver = reader.getByText('silver', { exact: true });
      const cell = silver.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " timeline-karaoke-cell ")]');
      const pitch = cell.getByRole('group', { name: /^Pitches for silver:/ });
      await expect(pitch).toHaveText(leadPitches.join(' '));
      const nextPitch = next.getByRole('group', { name: 'Pitches for Next: F#4 G#4 A#4' });
      await expect(nextPitch).toBeVisible();
      const chorusPitch = next.getByRole('group', { name: 'Pitches for chorus: C#5 D#5 F#5' });
      await expect(chorusPitch).toBeVisible();
      const nextCells = await Promise.all([nextPitch, chorusPitch].map(pitchGroup => pitchGroup.evaluate(group => {
        const cell = group.parentElement!;
        return {
          pitch: group.getBoundingClientRect().toJSON(),
          word: cell.querySelector<HTMLElement>('.timeline-karaoke-word')!.getBoundingClientRect().toJSON(),
          lyric: cell.querySelector<HTMLElement>('.timeline-karaoke-lyric')!.getBoundingClientRect().toJSON(),
          cell: cell.getBoundingClientRect().toJSON(),
        };
      })));
      for (const { pitch, word, lyric, cell } of nextCells) {
        expect(pitch.bottom).toBeLessThanOrEqual(word.top + 1);
        expect(pitch.left).toBeGreaterThanOrEqual(cell.left - 1);
        expect(pitch.right).toBeLessThanOrEqual(cell.right + 1);
        expect(Math.abs((lyric.left + lyric.right) / 2 - (cell.left + cell.right) / 2)).toBeLessThanOrEqual(1);
      }
      const [firstCell, secondCell] = nextCells.map(({ cell }) => cell);
      expect(
        secondCell.top >= firstCell.bottom - 1
        || (Math.abs(secondCell.bottom - firstCell.bottom) <= 1
          && secondCell.left >= firstCell.right - 1),
        'next-word cells must follow without overlapping, whether inline or wrapped',
      ).toBe(true);
      const layout = await current.evaluate(line => {
        const cells = [...line.querySelectorAll<HTMLElement>('.timeline-karaoke-cell')];
        const pitch = line.querySelector<HTMLElement>('.timeline-karaoke-pitches')!;
        const word = pitch.parentElement!.querySelector<HTMLElement>('.timeline-karaoke-word')!;
        const node = [...pitch.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())!;
        const labels = node.textContent!.split(' ');
        let offset = 0;
        const notes = labels.map(label => {
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + label.length);
          offset += label.length + 1;
          return range.getBoundingClientRect().toJSON();
        });
        const punctuation = document.createRange();
        punctuation.selectNodeContents(word.parentElement!);
        punctuation.setStartAfter(word);
        return { notes, pitch: pitch.getBoundingClientRect().toJSON(), word: word.getBoundingClientRect().toJSON(),
          lyric: word.parentElement!.getBoundingClientRect().toJSON(), cell: pitch.parentElement!.getBoundingClientRect().toJSON(),
          punctuation: punctuation.getBoundingClientRect().toJSON(), cells: cells.map(cell => cell.getBoundingClientRect().toJSON()),
          viewport: innerWidth, document: document.documentElement.scrollWidth };
      });
      expect(layout.notes).toHaveLength(leadPitches.length);
      expect(layout.document).toBeLessThanOrEqual(layout.viewport);
      expect(Math.abs(layout.punctuation.left - layout.word.right)).toBeLessThanOrEqual(1);
      expect(Math.abs((layout.lyric.left + layout.lyric.right) / 2 - (layout.cell.left + layout.cell.right) / 2)).toBeLessThanOrEqual(1);
      for (const note of layout.notes) {
        expect(note.left).toBeGreaterThanOrEqual(layout.pitch.left - 1);
        expect(note.right).toBeLessThanOrEqual(layout.pitch.right + 1);
        expect(note.bottom).toBeLessThanOrEqual(layout.word.top + 1);
      }
      for (let index = 1; index < layout.notes.length; index++) {
        const previous = layout.notes[index - 1], note = layout.notes[index];
        expect(note.top >= previous.bottom - 1 || note.left >= previous.right - 1).toBe(true);
      }
      for (let index = 1; index < layout.cells.length; index++) {
        const previous = layout.cells[index - 1], cell = layout.cells[index];
        expect(cell.top >= previous.bottom - 1 || cell.left >= previous.right - 1).toBe(true);
      }
      await reader.screenshot({ path: info.outputPath('crowded-pitches-after.png'), animations: 'disabled' });
      await info.attach('crowded-pitch-geometry', { body: JSON.stringify(layout), contentType: 'application/json' });
      expect(await player.evaluate(audio => audio.paused)).toBe(true);
      const [pitchBox, wordBox, currentBox, nextBox] = await Promise.all([
        pitch.boundingBox(), silver.boundingBox(), current.boundingBox(), next.boundingBox(),
      ]);
      expect(pitchBox!.y + pitchBox!.height).toBeLessThanOrEqual(wordBox!.y + 1);
      expect(nextBox!.y).toBeGreaterThanOrEqual(currentBox!.y);
      if (viewport.width === 390) {
        const assertActiveVisible = async () => {
          await silver.scrollIntoViewIfNeeded();
          const visibility = await silver.evaluate(word => {
            const reader = word.closest<HTMLElement>('.timeline-karaoke')!;
            const next = reader.querySelector<HTMLElement>('.timeline-karaoke-next')!;
            const wordBox = word.getBoundingClientRect(), readerBox = reader.getBoundingClientRect();
            const hit = document.elementFromPoint((wordBox.left + wordBox.right) / 2, (wordBox.top + wordBox.bottom) / 2);
            return { word: wordBox.toJSON(), reader: readerBox.toJSON(), next: next.getBoundingClientRect().toJSON(),
              hitWord: hit === word || word.contains(hit) };
          });
          expect(visibility.word.top).toBeGreaterThanOrEqual(visibility.reader.top);
          expect(visibility.word.bottom).toBeLessThanOrEqual(visibility.reader.bottom);
          expect(visibility.word.bottom).toBeLessThanOrEqual(visibility.next.top + 1);
          expect(visibility.hitWord).toBe(true);
        };
        // Simulate wider host font metrics at the default size, then exercise the largest user-selected size.
        const wideMetrics = await page.addStyleTag({ content: '.timeline-karaoke-pitches { letter-spacing: .12em; }' });
        await assertActiveVisible();
        await reader.screenshot({ path: info.outputPath('crowded-default-wide-font.png'), animations: 'disabled' });
        await wideMetrics.evaluate(style => style.remove());
        for (let i = 0; i < 8; i++) await view.getByRole('button', { name: 'Larger lyrics' }).click();
        await assertActiveVisible();
        await reader.screenshot({ path: info.outputPath('crowded-large-lyrics.png'), animations: 'disabled' });
        for (let i = 0; i < 8; i++) await view.getByRole('button', { name: 'Smaller lyrics' }).click();
      }

      if (viewport.width === 390) await pitchToggle.tap(); else await pitchToggle.click();
      await expect(pitchToggle).toHaveAttribute('aria-pressed', 'false');
      await expect(cell.locator('.timeline-karaoke-pitches')).toHaveCount(0);
      if (viewport.width === 390) await pitchToggle.tap(); else await pitchToggle.click();
      await expect(pitch).toHaveText(leadPitches.join(' '));
      await view.getByLabel('Pitch vocal stem').selectOption('backing');
      await expect(pitch).toHaveText('E4');
      await view.getByLabel('Pitch vocal stem').selectOption('lead');
      await expect(pitch).toHaveText(leadPitches.join(' '));
      // Clicking lyrics focuses their stable reader; selecting its text must
      // not prevent Space from controlling the same native player.
      if (viewport.width === 390) await silver.tap(); else await silver.click();
      await expect(current).toBeFocused();
      await page.evaluate(() => {
        const text = document.querySelector('[aria-label="Current karaoke line"]')!;
        const range = document.createRange();
        range.selectNodeContents(text);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      expect(await page.evaluate(() => !window.getSelection()!.isCollapsed)).toBe(true);
      await page.keyboard.press('Space');
      await expect.poll(() => player.evaluate(audio => !audio.paused)).toBe(true);
      const afterSpace = await player.evaluate(audio => audio.currentTime);
      await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(afterSpace + 0.2);
      await page.keyboard.press('Space');
      await expect.poll(() => player.evaluate(audio => audio.paused)).toBe(true);
      await page.evaluate(() => window.getSelection()!.removeAllRanges());
      await seekNative(player, 5.625);
      await expect(silver).toHaveAttribute('aria-current', 'true');
      await expect.poll(() => current.evaluate(line => Number(getComputedStyle(line).opacity))).toBe(1);
      const quarterPaint = await silver.screenshot({ animations: 'disabled' });
      const originalGradient = await silver.evaluate(word => getComputedStyle(word).backgroundImage);
      expect(originalGradient).toContain('linear-gradient');
      const sung = await samplePlayback(player, 700);
      expect(sung.at(-1)!.time - sung[0].time).toBeGreaterThan(0.3);
      expect(sung.every(sample => sample.active === 'silver')).toBe(true);
      expect(new Set(sung.map(sample => sample.gradient)).size).toBeGreaterThan(3);
      expect(Math.min(...sung.map(sample => sample.opacity)), 'native-clock updates must not restart the current line fade').toBeGreaterThanOrEqual(0.99);
      await seekNative(player, 5.625);
      const vocals = source.getByRole('button', { name: 'Just vocals' });
      await vocals.click();
      await expect(vocals).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(4.5, 2);
      await expect(silver).toHaveAttribute('aria-current', 'true');
      await expect.poll(() => silver.evaluate(word => getComputedStyle(word).backgroundImage)).toBe(originalGradient);
      await seekNative(player, 5.5);
      const laterPaint = await silver.screenshot({ animations: 'disabled' });
      expect(laterPaint.equals(quarterPaint), 'actual rasterized word fill must advance within the same word').toBe(false);
      await info.attach('silver-quarter-fill', { body: quarterPaint, contentType: 'image/png' });
      await info.attach('silver-three-quarter-fill', { body: laterPaint, contentType: 'image/png' });

      await seekNative(player, 8.75);
      await expect.poll(() => lyricText(current)).toBe('Before silver, after');
      await expect(reader.locator('[aria-current]')).toHaveText('after');
      await expect(reader.locator('[aria-current]')).toHaveAttribute('data-timing', 'estimated');
      const transition = await samplePlayback(player, 550);
      expect(transition.some(sample => sample.time >= 9 && sample.transform !== 'none')).toBe(true);
      await info.attach('karaoke-slide-proof', { body: JSON.stringify(transition), contentType: 'application/json' });
      await seekNative(player, 9);
      await expect.poll(() => lyricText(current)).toBe('Next chorus');
      await expect(reader.locator('[aria-current]')).toHaveCount(0);
      await seekNative(player, 9.5);
      await expect(reader.locator('[aria-current]')).toHaveText('Next');
      const back = view.getByRole('button', { name: 'Back 5 seconds', exact: true });
      if (viewport.width === 390) await back.tap(); else await back.click();
      await expect(reader.locator('[aria-current]')).toHaveText('silver');
      await seekNative(player, 16);
      await expect.poll(() => lyricText(current)).toBe('Next chorus');
      await expect(reader.locator('[aria-current]')).toHaveCount(0);

      await seekNative(player, 22.5);
      await expect.poll(() => lyricText(current)).toBe(longLine);
      await reader.scrollIntoViewIfNeeded();
      const geometry = await reader.evaluate(region => {
        const line = region.querySelector('[aria-label="Current lyrics"]')!;
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
      await current.focus();
      await current.press('End');
      await expect(current).toBeFocused();
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
      await expect(reader.getByText('Bright', { exact: true })).toBeInViewport();
      const rapid = await samplePlayback(player, 850);
      const sungRapid = rapid.filter(sample => rapidWords.includes(sample.text));
      expect(new Set(sungRapid.map(sample => sample.text)).size).toBeGreaterThanOrEqual(5);
      expect(Math.min(...sungRapid.map(sample => sample.opacity)), '100ms word cues must never spend their whole life transparent').toBeGreaterThanOrEqual(0.65);

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

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`karaoke fullscreen ${viewport.width}px`, () => {
      const tone = (frequency: number) => {
        const mp3 = execFileSync('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`,
          '-t', '36', '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1',
        ], { maxBuffer: 16 * 1024 * 1024 });
        return execFileSync('uv', ['run', 'python', '-c', String.raw`
import sys
from pathlib import Path
from backend.playback import listening_path
root=Path(sys.argv[1])
source=root / ('timing-tone-' + sys.argv[2] + '.mp3')
source.write_bytes(sys.stdin.buffer.read())
result=listening_path(source,root / 'timing-tone-cache')
assert result is not None
sys.stdout.buffer.write(result.read_bytes())
`, process.env.E2E_FIXTURE_DIR!, String(frequency)], {
          cwd: process.env.E2E_REPO_ROOT!, input: mp3, maxBuffer: 16 * 1024 * 1024,
        });
      };
    test('learn timings keeps native voices synchronized and gates sparse hints', async ({ page }, info) => {
      test.setTimeout(120_000);
      // A deterministic shuffle makes this audio fixture reproducible.
      await page.addInitScript(() => { Math.random = () => 0.5; });
      const job = karaokeJob();
      if (viewport.width === 390) job.manifest = job.manifest!.filter(item => item.label !== 'vocals');
      const { view, player } = await mountFixture(page, job, undefined, {
        instruments: tone(220), vocals: tone(880),
      });
      await seekNative(player, 4);
      await view.getByRole('button', { name: 'Learn timings', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Learn timings', exact: true });
      await expect(dialog).toBeVisible();
      await expect.poll(() => player.evaluate(audio => new URL(audio.currentSrc).pathname)).toContain('/results/instruments');
      const play = dialog.getByRole('button', { name: 'Play', exact: true });
      await expect(play).toBeEnabled();
      await play.click();
      const vocal = page.locator('body > audio[hidden]:not(#timing-test-external-player)');
      await expect(vocal).toHaveCount(1);
      // Model only the visibility input: both players and their clocks remain native.
      const setHidden = (hidden: boolean) => page.evaluate(value => {
        if (value) Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        else Reflect.deleteProperty(document, 'hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
      const masterAdvances = async () => {
        const before = await player.evaluate(audio => audio.currentTime);
        await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(before);
      };
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused && !audio.muted)).toBe(true);
      await setHidden(true);
      await masterAdvances();
      expect(await vocal.evaluate((audio: HTMLAudioElement) => !audio.paused && !audio.muted)).toBe(true);
      await setHidden(false);
      const less = dialog.getByRole('button', { name: 'Less hints', exact: true });
      await less.click();
      await expect(dialog.getByText('80% vocals', { exact: true })).toBeVisible();
      await dialog.screenshot({ path: info.outputPath(`timing-80-${viewport.width}.png`), animations: 'disabled' });
      await seekNative(player, 6.25);
      await dialog.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused && audio.muted)).toBe(true);
      await setHidden(true);
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => audio.paused && audio.muted)).toBe(true);
      await masterAdvances();
      await setHidden(false);
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused)).toBe(true);
      await seekNative(player, 3.25);
      await dialog.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused && !audio.muted)).toBe(true);
      for (const label of ['60% vocals', '40% vocals', '20% vocals', 'Vocals off']) {
        await less.click();
        await expect(dialog.getByText(label, { exact: true })).toBeVisible();
        await expect(dialog.getByRole('group', { name: 'Current lyrics' })).toBeVisible();
      }
      await expect(dialog.getByText('Vocals off', { exact: true })).toBeVisible();
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => audio.muted)).toBe(true);
      await setHidden(true);
      await masterAdvances();
      expect(await vocal.evaluate((audio: HTMLAudioElement) => !audio.paused && audio.muted)).toBe(true);
      await setHidden(false);
      expect(await player.evaluate(audio => !audio.paused && audio.currentSrc.includes('/results/instruments'))).toBe(true);
      const position = await player.evaluate(audio => audio.currentTime);
      await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(position);
      const more = dialog.getByRole('button', { name: 'More hints', exact: true });
      await more.click();
      await expect(dialog.getByText('20% vocals', { exact: true })).toBeVisible();
      await seekNative(player, 4.25);
      await dialog.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(4.3);
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => audio.muted)).toBe(true);
      await more.click();
      await expect(dialog.getByText('40% vocals', { exact: true })).toBeVisible();
      await seekNative(player, 3.25);
      await dialog.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused && !audio.muted)).toBe(true);
      await setHidden(true);
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => audio.paused && audio.muted)).toBe(true);
      await masterAdvances();
      await setHidden(false);
      await expect(dialog.getByText('40% vocals', { exact: true })).toBeVisible();
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused)).toBe(true);
      // Model the WebKit waiting/readyState=2 event; media playback and clocks stay native.
      const waiting = await player.evaluate((audio: HTMLAudioElement) => {
        Object.defineProperty(audio, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
        audio.dispatchEvent(new Event('waiting'));
        const companion = document.querySelector<HTMLAudioElement>('body > audio[hidden]');
        if (!companion) throw new Error('Missing timing audio');
        return { masterPaused: audio.paused, companionPaused: companion.paused, muted: companion.muted };
      });
      try {
        expect(waiting).toEqual({ masterPaused: false, companionPaused: true, muted: true });
        await masterAdvances();
        await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused)).toBe(true);
      } finally {
        await player.evaluate((audio: HTMLAudioElement) => { Reflect.deleteProperty(audio, 'readyState'); });
      }
      await expect.poll(async () => Math.abs(await player.evaluate(audio => audio.currentTime) - await vocal.evaluate((audio: HTMLAudioElement) => audio.currentTime))).toBeLessThan(0.08);
      const samples = await page.evaluate(async () => {
        const master = document.querySelector<HTMLAudioElement>('audio[controls]');
        const companion = document.querySelector<HTMLAudioElement>('body > audio[hidden]');
        if (!master || !companion) throw new Error('Missing timing audio');
        const rows: { master: number; vocal: number; paused: boolean; seeking: boolean }[] = [];
        for (let i = 0; i < 60; i++) {
          rows.push({ master: master.currentTime, vocal: companion.currentTime, paused: companion.paused, seeking: companion.seeking });
          await new Promise(resolve => setTimeout(resolve, 35));
        }
        return rows;
      });
      await info.attach('timing-native-clock', { body: JSON.stringify(samples), contentType: 'application/json' });
      expect(samples.at(-1)!.master - samples[0].master).toBeGreaterThan(1.5);
      expect(Math.max(...samples.map(row => Math.abs(row.master - row.vocal)))).toBeLessThan(0.08);
      expect(samples.every(row => !row.paused && !row.seeking)).toBe(true);
      await seekNative(player, 3.25);
      await dialog.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused && !audio.muted)).toBe(true);
      await seekNative(player, 4.25);
      await dialog.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused && audio.muted)).toBe(true);
      await dialog.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect.poll(() => player.evaluate(audio => audio.paused)).toBe(true);
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
      await more.click();
      await more.click();
      await more.click();
      await expect(dialog.getByText('Full vocals', { exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(() => player.evaluate(audio => !audio.paused)).toBe(true);
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused)).toBe(true);
      // A queued play from an outsider already paused in the same turn must
      // not cancel the active two-element timing session.
      const cancelled = await page.evaluate(async () => {
        const external = document.createElement('audio');
        const master = document.querySelector<HTMLAudioElement>('audio[controls]');
        if (!master) throw new Error('Missing instrument player');
        external.src = master.currentSrc;
        document.body.append(external);
        const notification = new Promise<boolean>(resolve => external.addEventListener('play', () => resolve(external.paused), { once: true }));
        const result = external.play().catch(error => { if (error.name !== 'AbortError') throw error; });
        external.pause();
        await result;
        const pausedAtNotification = await notification;
        external.remove();
        return pausedAtNotification;
      });
      expect(cancelled).toBe(true);
      expect(await player.evaluate(audio => !audio.paused)).toBe(true);
      expect(await vocal.evaluate((audio: HTMLAudioElement) => !audio.paused)).toBe(true);
      await expect(dialog.getByText('Full vocals', { exact: true })).toBeVisible();
      await page.evaluate(async () => {
        const external = document.createElement('audio');
        const master = document.querySelector<HTMLAudioElement>('audio[controls]');
        if (!master) throw new Error('Missing instrument player');
        external.src = master.currentSrc;
        external.hidden = true;
        external.id = 'timing-test-external-player';
        document.body.append(external);
        await external.play();
      });
      await expect.poll(() => player.evaluate(audio => audio.paused)).toBe(true);
      await expect(vocal).toHaveCount(0);
      await page.locator('#timing-test-external-player').evaluate((audio: HTMLAudioElement) => { audio.pause(); audio.remove(); });
      await dialog.getByRole('button', { name: 'Exit karaoke fullscreen' }).click();
      await expect(dialog).toBeHidden();
    });
    test('timing vocals volume presets change native companion output without changing transport', async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.addInitScript(() => { Math.random = () => 0.5; });
      // Real decoded companion output is sampled after its gain, never replacing native transport.
      await page.addInitScript(() => {
        const original = AudioContext.prototype.createGain;
        AudioContext.prototype.createGain = function () {
          const gain = original.call(this);
          const analyser = this.createAnalyser();
          analyser.fftSize = 2048;
          const silent = original.call(this);
          silent.gain.value = 0;
          gain.connect(analyser).connect(silent).connect(this.destination);
          (window as unknown as { timingAnalyser: AnalyserNode }).timingAnalyser = analyser;
          return gain;
        };
      });
      const job = karaokeJob();
      if (viewport.width === 390) job.manifest = job.manifest!.filter(item => item.label !== 'vocals');
      const { view, player } = await mountFixture(page, job, undefined, { instruments: tone(220), vocals: tone(880) });
      await seekNative(player, 4);
      await view.getByRole('button', { name: 'Learn timings', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Learn timings', exact: true });
      const play = dialog.getByRole('button', { name: 'Play', exact: true });
      await expect(play).toBeEnabled();
      await play.click();
      const vocal = page.locator('body > audio[hidden]');
      await expect(vocal).toHaveCount(1);
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.paused && !audio.muted)).toBe(true);
      const volume = dialog.getByRole('group', { name: 'Vocals volume' });
      await expect(volume.getByRole('button', { name: '75%' })).toHaveAttribute('aria-pressed', 'true');
      const boxes = await Promise.all([25, 50, 75, 100].map(percent => volume.getByRole('button', { name: `${percent}%` }).boundingBox()));
      for (const box of boxes) {
        expect(box).not.toBeNull();
        expect(box!.y).toBeCloseTo(boxes[0]!.y, 0);
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      await dialog.screenshot({ path: info.outputPath(`timing-volume-${viewport.width}.png`), animations: 'disabled' });
      const rms = () => page.evaluate(async () => {
        const analyser = (window as unknown as { timingAnalyser: AnalyserNode }).timingAnalyser;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 150);
        await promise;
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      });
      const defaultRms = await rms();
      expect(defaultRms).toBeGreaterThan(0.001);
      const levels: Record<string, number> = { default75: defaultRms };
      await player.evaluate((audio: HTMLAudioElement) => {
        audio.dataset.presetTransportEvents = '0';
        for (const event of ['play', 'pause', 'seeking']) audio.addEventListener(event, () => {
          audio.dataset.presetTransportEvents = String(Number(audio.dataset.presetTransportEvents) + 1);
        });
      });
      // Sample both clocks in the activation task; later companion seeks can be drift correction.
      await volume.evaluate(group => {
        const state = () => [
          document.querySelector<HTMLAudioElement>('.pitch-view audio:not([hidden])')!,
          document.querySelector<HTMLAudioElement>('body > audio[hidden]')!,
        ].map(audio => ({ time: audio.currentTime, paused: audio.paused, seeking: audio.seeking, muted: audio.muted }));
        let before: NativePlaybackState[];
        group.addEventListener('click', event => {
          before = state();
          group.dataset.trustedPresetClick = String(event.isTrusted);
        }, true);
        document.addEventListener('click', event => {
          if (event.target instanceof Node && group.contains(event.target)) {
            group.dataset.presetTransition = JSON.stringify({ before, after: state() });
          }
        });
      });
      const masterVolume = await player.evaluate(audio => audio.volume);
      for (const percent of [25, 50, 100]) {
        const before = await player.evaluate(audio => audio.currentTime);
        await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => !audio.seeking)).toBe(true);
        await volume.getByRole('button', { name: `${percent}%` }).click();
        const transition = await volume.evaluate(group => {
          if (group.dataset.trustedPresetClick !== 'true' || !group.dataset.presetTransition) throw new Error('Missing trusted preset activation');
          return JSON.parse(group.dataset.presetTransition) as PresetTransition;
        });
        for (let index = 0; index < transition.before.length; index++) {
          expect(transition.before[index].paused || transition.before[index].seeking).toBe(false);
          expect(transition.after[index].paused || transition.after[index].seeking).toBe(false);
          expect(transition.after[index].muted).toBe(transition.before[index].muted);
          expect(transition.after[index].time).toBeGreaterThanOrEqual(transition.before[index].time);
        }
        await expect(volume.getByRole('button', { name: `${percent}%` })).toHaveAttribute('aria-pressed', 'true');
        const level = await rms();
        levels[String(percent)] = level;
        expect(level / defaultRms).toBeCloseTo(percent / 75, 1);
        expect(await player.evaluate(audio => audio.volume)).toBe(masterVolume);
        const state = await player.evaluate(audio => ({ time: audio.currentTime, paused: audio.paused, seeking: audio.seeking }));
        expect(state.time).toBeGreaterThan(before);
        expect(state.paused || state.seeking).toBe(false);
        await expect.poll(() => page.evaluate(() => {
          const master = document.querySelector<HTMLAudioElement>('.pitch-view audio:not([hidden])')!;
          const companion = document.querySelector<HTMLAudioElement>('body > audio[hidden]')!;
          return Math.abs(master.currentTime - companion.currentTime);
        })).toBeLessThan(0.08);
      }
      expect(await player.evaluate((audio: HTMLAudioElement) => audio.dataset.presetTransportEvents)).toBe('0');
      await player.evaluate(audio => { audio.volume = 0.5; });
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => audio.volume)).toBe(0.5);
      levels.masterHalf = await rms();
      expect(levels.masterHalf / defaultRms).toBeCloseTo(0.5 / 0.75, 1);
      expect(await player.evaluate(audio => audio.volume)).toBe(0.5);
      await player.evaluate(audio => { audio.volume = 1; });
      const less = dialog.getByRole('button', { name: 'Less hints', exact: true });
      for (let index = 0; index < 5; index++) await less.click();
      await expect(dialog.getByText('Vocals off', { exact: true })).toBeVisible();
      await expect.poll(() => vocal.evaluate((audio: HTMLAudioElement) => audio.muted)).toBe(true);
      for (const percent of [25, 100]) {
        await volume.getByRole('button', { name: `${percent}%` }).click();
        levels[`off${percent}`] = await rms();
        expect(levels[`off${percent}`]).toBeLessThan(0.0001);
      }
      await info.attach('timing-volume-rms', { body: JSON.stringify(levels), contentType: 'application/json' });
      await dialog.getByRole('button', { name: 'Exit karaoke fullscreen' }).click();
      for (const [trigger, name] of [['Open karaoke fullscreen', 'Karaoke fullscreen'], ['Lyrics learning mode', 'Lyrics learning mode']] as const) {
        await view.getByRole('button', { name: trigger, exact: true }).click();
        const other = page.getByRole('dialog', { name, exact: true });
        await expect(other.getByRole('group', { name: 'Vocals volume' })).toHaveCount(0);
        await other.getByRole('button', { name: 'Exit karaoke fullscreen' }).click();
      }
      await view.getByRole('button', { name: 'Learn timings', exact: true }).click();
      await expect(dialog.getByRole('group', { name: 'Vocals volume' }).getByRole('button', { name: '75%' })).toHaveAttribute('aria-pressed', 'true');
      await dialog.getByRole('button', { name: 'Exit karaoke fullscreen' }).click();
    });
    test.use({ viewport, isMobile: viewport.width === 390, hasTouch: viewport.width === 390, deviceScaleFactor: 1 });
    test('outside playback cancels timing preparation before vocals load', async ({ page }) => {
      const gate = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      const { view, player } = await mountFixture(page, karaokeJob(), undefined, undefined, {
        gate: gate.promise, requested: requested.resolve,
      });
      try {
        await player.evaluate((audio: HTMLAudioElement) => audio.play());
        await expect.poll(() => player.evaluate(audio => !audio.paused)).toBe(true);
        await view.getByRole('button', { name: 'Learn timings', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Learn timings', exact: true });
        await requested.promise;
        await expect(dialog.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
        await page.evaluate(async () => {
          const master = document.querySelector<HTMLAudioElement>('audio[controls]');
          if (!master) throw new Error('Missing instrument player');
          const external = document.createElement('audio');
          external.id = 'timing-test-external-player';
          external.src = master.currentSrc;
          document.body.append(external);
          await external.play();
        });
        const external = page.locator('#timing-test-external-player');
        await expect.poll(() => external.evaluate((audio: HTMLAudioElement) => !audio.paused)).toBe(true);
        await expect.poll(() => player.evaluate(audio => audio.paused)).toBe(true);
        await expect(page.locator('body > audio[hidden]')).toHaveCount(0);
        gate.resolve();
        const position = await external.evaluate((audio: HTMLAudioElement) => audio.currentTime);
        await expect.poll(() => external.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(position);
        expect(await player.evaluate(audio => audio.paused)).toBe(true);
        await expect(page.locator('body > audio[hidden]')).toHaveCount(0);
        await external.evaluate((audio: HTMLAudioElement) => { audio.pause(); audio.remove(); });
      } finally {
        gate.resolve();
      }
    });
    test('singing practice switches safely to instruments and masks both lyric lines', async ({ page }, info) => {
      const gate = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      const { view, player } = await mountFixture(page, karaokeJob(), { gate: gate.promise, requested: requested.resolve });
      await seekNative(player, 5.625);
      await view.getByRole('button', { name: 'Pitches', exact: true }).click();
      const source = await player.elementHandle();
      const playing = viewport.width === 1440;
      if (playing) await player.evaluate(audio => audio.play());
      const before = await player.evaluate(audio => audio.currentTime / 1.25);
      const open = view.getByRole('button', { name: 'Lyrics learning mode', exact: true });
      await open.click();
      const dialog = page.getByRole('dialog', { name: 'Lyrics learning mode', exact: true });
      await expect(dialog).toBeVisible();
      await requested.promise;
      expect(await source!.evaluate(audio => audio.paused)).toBe(true);
      await expect(dialog.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('slider', { name: 'Karaoke playback position' })).toBeDisabled();
      await dialog.getByRole('region', { name: 'Current karaoke line' }).focus();
      await page.keyboard.press('Space');
      expect(await source!.evaluate(audio => audio.paused)).toBe(true);
      gate.resolve();
      await expect.poll(() => player.evaluate(audio => new URL(audio.currentSrc).pathname)).toContain('/results/instruments');
      await expect.poll(() => player.evaluate(audio => audio.paused)).toBe(!playing);
      const started = await player.evaluate(audio => audio.currentTime);
      expect(Math.abs(started - before)).toBeLessThan(0.5);
      await expect(dialog.getByRole('group', { name: 'Pitch background audio' })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Pitches', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('group', { name: 'Reference pitch controls' })).toHaveCount(0);
      const reader = dialog.getByRole('region', { name: 'Current karaoke line' });
      const more = dialog.getByRole('button', { name: 'More hints' });
      const less = dialog.getByRole('button', { name: 'Less hints' });
      await expect(more).toBeDisabled();
      await less.click();
      await less.click();
      await less.click();
      await expect(less).toBeDisabled();
      for (const name of ['Current lyrics', 'Next lyrics']) {
        const line = reader.getByRole('group', { name });
        await expect.poll(() => line.textContent()).toMatch(/^[•\s]+$/u);
        expect(await line.evaluate(element => [...element.querySelectorAll('[title], [aria-label]')].every(item =>
          !/Before|silver|after|Next|chorus/i.test(`${item.getAttribute('title')} ${item.getAttribute('aria-label')}`)))).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`singing-mode-${viewport.width}.png`), animations: 'disabled' });
      await more.click();
      await expect(less).toBeEnabled();
      await dialog.getByRole('button', { name: 'Exit karaoke fullscreen' }).click();
      await expect(open).toBeFocused();
      await expect(view.getByRole('button', { name: 'Pitches', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(view.getByRole('button', { name: /^Instruments/ })).toHaveAttribute('aria-pressed', 'true');
    });
    test('keeps native playback, source, seeking and lyric sizing across fullscreen', async ({ page }, info) => {
      const { view, player, reader: inlineReader } = await mountFixture(page);
      expect(await inlineReader.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(viewport.width === 390 ? 32 : 40);
      await seekNative(player, 5.625);
      const inlinePitches = view.getByRole('button', { name: 'Pitches', exact: true });
      await expect(inlinePitches).toHaveAttribute('aria-pressed', 'false');
      const inlineGeometry = await fittedRows(inlineReader);
      expect(inlineGeometry.rows).toHaveLength(2);
      for (const row of inlineGeometry.rows) expect(Math.abs(row.center - row.centerTarget)).toBeLessThanOrEqual(2);
      await inlinePitches.click();
      const original = await player.elementHandle();
      await player.evaluate(audio => audio.play());
      const before = await player.evaluate(audio => audio.currentTime);
      const open = view.getByRole('button', { name: 'Open karaoke fullscreen' });
      await open.click();
      const dialog = page.getByRole('dialog', { name: 'Karaoke fullscreen' });
      const exit = dialog.getByRole('button', { name: 'Exit karaoke fullscreen' });
      await expect(exit).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.locator(':focus')).toBeVisible();
      await expect(exit).not.toBeFocused();
      await page.keyboard.press('Tab');
      await expect(exit).toBeFocused();
      await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(before + 0.15);
      expect(await player.evaluate((audio, prior) => audio === prior, original)).toBe(true);
      const lyrics = dialog.getByRole('region', { name: 'Current karaoke line' });
      await expect(lyrics.getByText('silver', { exact: true })).toHaveAttribute('aria-current', 'true');
      const slider = dialog.getByRole('slider', { name: 'Karaoke playback position' });
      expect(Number(await slider.getAttribute('max'))).toBeCloseTo(await player.evaluate(audio => audio.duration), 1);
      expect(Number(await slider.inputValue())).toBeGreaterThanOrEqual(5.625);
      await expect(slider.locator('..')).toContainText('0:45');
      await dialog.getByRole('button', { name: 'Pause', exact: true }).click();
      await seekNative(player, 5.625);
      await expect.poll(() => lyrics.evaluate(element => element.style.fontSize)).not.toBe('');
      const initialSize = (await fittedRows(lyrics)).font;
      const larger = dialog.getByRole('button', { name: 'Larger lyrics' });
      const smaller = dialog.getByRole('button', { name: 'Smaller lyrics' });
      await expect(larger).toBeDisabled();
      await smaller.click();
      await expect.poll(async () => (await fittedRows(lyrics)).font).toBeLessThan(initialSize);
      await larger.click();
      await expect.poll(async () => (await fittedRows(lyrics)).font).toBeCloseTo(initialSize, 1);
      if (viewport.width === 390) {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath('fullscreen-390-largest.png'), animations: 'disabled' });
      }
      while (await smaller.isEnabled()) await smaller.click();
      await expect(smaller).toBeDisabled();
      while (await larger.isEnabled()) await larger.click();
      await expect.poll(async () => (await fittedRows(lyrics)).font).toBeCloseTo(initialSize, 1);
      const geometry = await fittedRows(lyrics);
      expect(geometry.rows).toHaveLength(2);
      expect(Math.abs((geometry.rows[0].boxTop + geometry.rows[1].boxBottom) / 2
        - (geometry.frame.top + geometry.frame.bottom) / 2)).toBeLessThanOrEqual(2);
      expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport);
      for (const row of geometry.rows) {
        expect(Math.abs(row.center - row.centerTarget)).toBeLessThanOrEqual(2);
        expect(row.left).toBeGreaterThanOrEqual(geometry.frame.left);
        expect(row.right).toBeLessThanOrEqual(geometry.frame.right);
        expect(row.top).toBeGreaterThanOrEqual(geometry.frame.top);
        expect(row.bottom).toBeLessThanOrEqual(geometry.frame.bottom);
        expect(row.singleWordRow).toBe(true);
        expect(row.pitches).toEqual([]);
      }
      expect(await largerThanFitOverflows(lyrics)).toBe(true);
      await dialog.getByRole('button', { name: 'Play', exact: true }).click();
      const playbackFonts = await lyrics.evaluate(element => new Promise<string[]>(resolve => {
        const values: string[] = [];
        const sample = () => {
          values.push(getComputedStyle(element).fontSize);
          if (values.length === 12) resolve(values); else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }));
      expect(new Set(playbackFonts).size).toBe(1);
      await dialog.getByRole('button', { name: 'Pause', exact: true }).click();
      await seekNative(player, 5.625);
      await expect.poll(async () => (await fittedRows(lyrics)).font).toBeCloseTo(initialSize, 1);
      await info.attach('fullscreen-fit-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
      await expect(dialog.getByRole('button', { name: 'Pitches', exact: true })).toHaveCount(0);
      await expect(lyrics.locator('.timeline-karaoke-pitches, .timeline-karaoke-line-pitches')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`fullscreen-no-pitches-${viewport.width}.png`), animations: 'disabled' });
      await expect(dialog.locator('audio, canvas, svg.pitch-chart, .piano-keyboard')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`fullscreen-${viewport.width}.png`), animations: 'disabled' });
      if (viewport.width === 390) {
        await page.setViewportSize({ width: 844, height: 390 });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect.poll(async () => (await fittedRows(lyrics)).frame.width).toBeGreaterThan(geometry.frame.width);
        const landscape = await fittedRows(lyrics);
        expect(Math.abs((landscape.rows[0].boxTop + landscape.rows[1].boxBottom) / 2
          - (landscape.frame.top + landscape.frame.bottom) / 2)).toBeLessThanOrEqual(2);
        for (const row of landscape.rows) {
          expect(Math.abs(row.center - row.centerTarget)).toBeLessThanOrEqual(2);
          expect(row.left).toBeGreaterThanOrEqual(landscape.frame.left);
          expect(row.right).toBeLessThanOrEqual(landscape.frame.right);
          expect(row.singleWordRow).toBe(true);
          expect(row.pitches).toEqual([]);
        }
        expect(await largerThanFitOverflows(lyrics)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await expect(lyrics.getByText('silver', { exact: true })).toBeInViewport();
        await expect(dialog.getByRole('slider', { name: 'Karaoke playback position' })).toBeInViewport();
        await expect(dialog.getByRole('button', { name: 'Back 5 seconds' })).toBeInViewport();
        expect(await lyrics.getByText('silver', { exact: true }).evaluate(element => {
          const box = element.getBoundingClientRect();
          return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
        })).toBe(true);
        await page.screenshot({ path: info.outputPath('fullscreen-landscape.png'), animations: 'disabled' });
        await page.setViewportSize(viewport);
        await expect.poll(async () => (await fittedRows(lyrics)).font).toBeCloseTo(initialSize, 1);
      }
      await dialog.getByRole('button', { name: 'Play', exact: true }).click();
      await dialog.getByRole('button', { name: 'Pause', exact: true }).click();
      await slider.fill('10');
      await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeCloseTo(10, 1);
      await expect.poll(() => lyricText(lyrics.getByRole('group', { name: 'Current lyrics' }))).toBe('Before silver, after');
      await dialog.getByRole('button', { name: 'Back 5 seconds' }).click();
      await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeCloseTo(5, 1);
      await expect(lyrics.locator('[aria-current]')).toHaveText('silver');
      await dialog.getByRole('button', { name: 'Play', exact: true }).click();
      await dialog.getByRole('button', { name: 'Just vocals' }).click();
      await expect(dialog.getByRole('button', { name: 'Just vocals' })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => player.evaluate(audio => !audio.paused)).toBe(true);
      await expect.poll(async () => Math.abs(Number(await slider.getAttribute('max')) - await player.evaluate(audio => audio.duration))).toBeLessThan(0.1);
      await expect.poll(async () => Math.abs(Number(await slider.inputValue()) - await player.evaluate(audio => audio.currentTime))).toBeLessThan(0.2);
      await dialog.getByRole('button', { name: 'Pause', exact: true }).focus();
      await page.keyboard.press('Space');
      await expect.poll(() => player.evaluate(audio => audio.paused)).toBe(true);
      await page.keyboard.press('Space');
      await expect.poll(() => player.evaluate(audio => !audio.paused)).toBe(true);
      await lyrics.focus();
      await lyrics.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      expect(await page.evaluate(() => !window.getSelection()!.isCollapsed)).toBe(true);
      await page.keyboard.press('Space');
      await expect.poll(() => player.evaluate(audio => audio.paused)).toBe(true);
      await slider.fill('22.5');
      await expect.poll(() => lyricText(lyrics.getByRole('group', { name: 'Current lyrics' }))).toBe(longLine);
      await expect.poll(async () => {
        const value = await fittedRows(lyrics);
        return value.rows.every(row => row.left >= value.frame.left && row.right <= value.frame.right);
      }).toBe(true);
      const longGeometry = await fittedRows(lyrics);
      for (const row of longGeometry.rows) {
        expect(Math.abs(row.center - row.centerTarget)).toBeLessThanOrEqual(2);
        expect(row.left).toBeGreaterThanOrEqual(longGeometry.frame.left);
        expect(row.right).toBeLessThanOrEqual(longGeometry.frame.right);
        expect(row.top).toBeGreaterThanOrEqual(longGeometry.frame.top);
        expect(row.bottom).toBeLessThanOrEqual(longGeometry.frame.bottom);
        expect(row.singleWordRow).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`fullscreen-long-${viewport.width}.png`), animations: 'disabled' });
      await lyrics.focus();
      await page.keyboard.press('Space');
      await expect.poll(() => player.evaluate(audio => !audio.paused)).toBe(true);
      const atExit = await player.evaluate(audio => audio.currentTime);
      const active = await player.elementHandle();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(open).toBeFocused();
      expect(await player.evaluate((audio, prior) => audio === prior, active)).toBe(true);
      await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(atExit + 0.15);
      await expect(view.getByRole('button', { name: 'Just vocals' })).toHaveAttribute('aria-pressed', 'true');
      if (viewport.width === 390) {
        await view.getByRole('button', { name: /^backing \(pitch/ }).click();
        await expect(view.getByRole('button', { name: /^backing \(pitch/ })).toHaveAttribute('aria-pressed', 'true');
        await open.click();
        const activeButton = dialog.getByRole('button', { name: /^backing \(pitch/ });
        await expect(activeButton).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => activeButton.evaluate(button => {
          const item = button.getBoundingClientRect(), row = button.parentElement!.getBoundingClientRect();
          return item.left >= row.left - 1 && item.right <= row.right + 1;
        })).toBe(true);
        await dialog.getByRole('button', { name: 'Exit karaoke fullscreen' }).click();
      }
    });

    test('centers a typical lyric and its next line in the fullscreen stage', async ({ page }, info) => {
      const fixture = karaokeJob();
      fixture.transcript!.reference!.lines![0] = phrase('The silver moon is shining over quiet water', 3, 9);
      fixture.transcript!.presentation_lines[0].text = 'The silver moon is shining over quiet water';
      fixture.pitch!.tracks[0].notes = fixture.pitch!.tracks[0].notes.filter((note, index) =>
        !note.word_indices.includes(0) || index < 3);
      const { view, player } = await mountFixture(page, fixture);
      await seekNative(player, 5.625);
      await view.getByRole('button', { name: 'Open karaoke fullscreen' }).click();
      const dialog = page.getByRole('dialog', { name: 'Karaoke fullscreen' });
      const reader = dialog.getByRole('region', { name: 'Current karaoke line' });
      await expect(dialog.getByRole('button', { name: 'Pitches', exact: true })).toHaveCount(0);
      await expect(reader.locator('.timeline-karaoke-pitches')).toHaveCount(0);
      await expect.poll(() => reader.evaluate(element => element.style.fontSize)).not.toBe('');
      await expect.poll(() => lyricText(reader.getByRole('group', { name: 'Current lyrics' })))
        .toBe('The silver moon is shining over quiet water');
      const geometry = await fittedRows(reader);
      expect(geometry.rows).toHaveLength(2);
      expect(Math.abs((geometry.rows[0].boxTop + geometry.rows[1].boxBottom) / 2
        - (geometry.frame.top + geometry.frame.bottom) / 2)).toBeLessThanOrEqual(2);
      for (const row of geometry.rows) {
        expect(Math.abs(row.center - row.centerTarget)).toBeLessThanOrEqual(2);
        expect(row.left).toBeGreaterThanOrEqual(geometry.frame.left);
        expect(row.right).toBeLessThanOrEqual(geometry.frame.right);
        expect(row.singleWordRow).toBe(true);
        expect(row.pitches).toEqual([]);
      }
      await expect(reader.getByText('silver', { exact: true })).toHaveAttribute('aria-current', 'true');
      await info.attach('typical-lyric-geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
      await page.screenshot({ path: info.outputPath(`fullscreen-typical-${viewport.width}.png`), animations: 'disabled' });
      await dialog.getByRole('button', { name: 'Exit karaoke fullscreen' }).click();
      await view.getByRole('button', { name: 'Pitches', exact: true }).click();
      await expect(view.getByRole('button', { name: 'Pitches', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(view.getByRole('region', { name: 'Current karaoke line' }).getByRole('group', { name: /^Pitches for silver:/ })).toBeVisible();
    });
  });
}
