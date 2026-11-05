import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { JobDTO } from '../src/api';

const SOURCE_SHA256 = '0d277de969ce02959923ec32fd94897a6791cf183fd954198d5e02166e36fb04';

test('real full-song pitched lyrics preserve detected per-stem notes, output clock and canonical TXT in browser/history', async ({ page, browser }, info) => {
  test.setTimeout(45 * 60 * 1000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg'));
  expect(createHash('sha256').update(source).digest('hex')).toBe(SOURCE_SHA256);
  await page.goto('/');
  await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
  await page.getByLabel('Audio file', { exact: true }).setInputFiles({ name: 'auld-lang-syne-full.ogg', mimeType: 'audio/ogg', buffer: source });
  await page.getByRole('checkbox', { name: 'Lyrics with pitches', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Extract lyrics', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Detect vocal pitch', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Extract vocals', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Split lead & backing vocals', exact: true }).check();
  await page.getByLabel('Pitch shift (semitones)', { exact: true }).fill('1.25');
  await page.getByLabel('Tempo (% of original)', { exact: true }).fill('125');
  const submitted = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Process audio', exact: true }).click();
  const id = (await (await submitted).json()).id as number;
  let job: JobDTO | undefined;
  await expect.poll(async () => {
    job = await (await page.request.get(`/api/jobs/${id}`)).json() as JobDTO;
    if (job.status === 'failed') throw new Error(job.error_message ?? 'Pitched lyrics failed');
    return job.status;
  }, { timeout: 25 * 60 * 1000, intervals: [500, 2000, 5000] }).toBe('done');
  const analysis = job!.pitch!;
  expect(analysis.source_duration_s).toBeGreaterThan(141);
  expect(analysis.source_duration_s).toBeLessThan(142);
  expect(analysis.duration_s).toBeCloseTo(analysis.source_duration_s / 1.25, 5);
  expect(analysis.words.map(word => word.text.toLowerCase()).join(' ')).toContain('acquaintance be forgot');
  expect(analysis.words.map(word => word.text.toLowerCase()).join(' ')).toContain('cup of kindness');
  expect(analysis.tracks.map(track => track.label)).toEqual(['vocals', 'lead', 'backing']);
  expect(job!.pitched_lyrics!.map(track => track.label)).toEqual(['vocals', 'lead', 'backing']);
  expect(job!.manifest!.map(track => track.label)).toEqual(['song', 'vocals', 'lead', 'backing']);
  const view = page.getByRole('region', { name: 'Lyrics with pitches', exact: true }).first();
  const text = view.getByRole('region', { name: 'Aligned pitch and lyric text', exact: true });
  await expect(view).toBeVisible();
  await expect(page.getByLabel('Vocal pitch analysis', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Lyrics transcript', { exact: true })).toHaveCount(0);
  const proofs = [];
  for (const [index, track] of job!.pitched_lyrics!.entries()) {
    await view.getByRole('combobox', { name: 'Pitched lyrics vocal stem', exact: true }).selectOption(track.label);
    expect(await text.textContent()).toBe(track.text);
    const response = await page.request.get(`/api/jobs/${id}/pitched-lyrics/${track.label}/download`);
    expect(response.ok()).toBe(true);
    expect((await response.body()).equals(Buffer.from(track.text, 'utf8'))).toBe(true);
    const pending = page.waitForEvent('download');
    await view.getByRole('link', { name: 'Download lyrics with pitches TXT', exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(`auld-lang-syne-full - ${track.label} - lyrics-with-pitches - pitch+1.25st - tempo125pct.txt`);
    expect(await readFile((await download.path())!)).toEqual(Buffer.from(track.text, 'utf8'));
    const lines = track.text.split('\n');
    for (const segment of job!.transcript!.segments) {
      const seconds = Math.floor(segment.start_s / 1.25);
      const timestamp = `[${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}]`;
      const lyricIndex = lines.findIndex(line => line.startsWith(`${timestamp} `));
      expect(lyricIndex, `lyric onset ${timestamp}`).toBeGreaterThanOrEqual(1);
      const expected = segment.text.split(/\s+/);
      const actual: string[] = [];
      for (let row = lyricIndex; actual.length < expected.length && row < lines.length; row += 3) {
        actual.push(...lines[row].slice(timestamp.length + 1).trim().split(/\s+/));
      }
      expect(actual).toEqual(expected);
    }
    const melismaIndex = analysis.words.findIndex((word, wordIndex) => analysis.tracks[index].notes.filter(note => note.word_indices.includes(wordIndex)).length >= 2
      && job!.transcript!.segments.some(segment => segment.start_s <= word.start_s * 1.25 && segment.end_s >= word.end_s * 1.25 && segment.text.split(/\s+/).filter(cell => cell.toLowerCase() === word.text.toLowerCase()).length === 1));
    if (melismaIndex >= 0) {
      const notes = analysis.tracks[index].notes.filter(note => note.word_indices.includes(melismaIndex));
      const sequence = notes.map(note => note.note).join(' ');
      expect(track.text).toContain(sequence);
      proofs.push({ stem: track.label, word: analysis.words[melismaIndex].text, detected_notes: notes, sequence });
    }
  }
  expect(proofs.some(proof => proof.stem === 'vocals')).toBe(true);
  await view.getByRole('combobox', { name: 'Pitched lyrics vocal stem', exact: true }).selectOption('vocals');
  await text.evaluate(element => {
    const firstOnset = element.textContent!.split('\n').findIndex(line => /^\[\d+:\d{2}\] /.test(line)) - 1;
    element.scrollTop = firstOnset * Number.parseFloat(getComputedStyle(element).lineHeight);
    element.scrollLeft = 0;
  });
  await view.screenshot({ path: info.outputPath('pitched-lyrics-1440.png') });
  // New output does not add players; selected tracks retain exclusive playback.
  const original = page.locator('audio').first();
  const vocal = page.locator(`audio[src="/api/jobs/${id}/results/vocals"]`);
  await original.evaluate(element => element.play());
  await vocal.evaluate(element => element.play());
  await expect.poll(() => original.evaluate(element => element.paused)).toBe(true);
  await vocal.evaluate(element => element.pause());
  const song = page.locator(`audio[src="/api/jobs/${id}/results/song"]`);
  await song.evaluate(element => { element.preload = 'metadata'; element.load(); });
  await expect.poll(() => song.evaluate(element => element.duration)).toBeGreaterThan(0);
  const durationProof = {
    original_s: await original.evaluate(element => element.duration),
    transformed_s: await song.evaluate(element => element.duration),
    expected_output_s: analysis.source_duration_s / 1.25,
    first_word_source_s: job!.transcript!.words![0].start_s,
    first_word_output_s: analysis.words[0].start_s,
  };
  expect(Math.abs(durationProof.original_s - 141.5457)).toBeLessThan(0.03);
  expect(Math.abs(durationProof.transformed_s - durationProof.expected_output_s)).toBeLessThan(0.1);
  expect(durationProof.first_word_output_s).toBeCloseTo(durationProof.first_word_source_s / 1.25, 6);
  expect(durationProof.first_word_output_s).toBeLessThan(durationProof.transformed_s);
  await page.reload();
  const history = page.getByRole('heading', { name: 'History', exact: true }).locator('..');
  expect(await history.getByRole('region', { name: 'Aligned pitch and lyric text', exact: true }).textContent()).toBe(job!.pitched_lyrics![0].text);
  const mobile = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await mobile.newPage();
  await phone.goto(process.env.E2E_BASE_URL!);
  const mobileView = phone.getByRole('region', { name: 'Lyrics with pitches', exact: true }).first();
  const mobileText = mobileView.getByRole('region', { name: 'Aligned pitch and lyric text', exact: true });
  expect(await mobileText.textContent()).toBe(job!.pitched_lyrics![0].text);
  expect(await mobileText.evaluate(element => ({ font: getComputedStyle(element).fontSize, wrap: getComputedStyle(element).whiteSpace }))).toEqual({ font: '16px', wrap: 'pre' });
  expect(await mobileText.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  const firstRows = await mobileText.evaluate(element => {
    const content = element.textContent!;
    const onset = content.match(/^\[\d+:\d{2}\] /m)!;
    const pitchStart = content.lastIndexOf('\n', onset.index! - 2) + 1 + onset[0].length;
    const wordStart = onset.index! + onset[0].length;
    const at = (offset: number) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && offset >= node.textContent!.length) {
        offset -= node.textContent!.length;
        node = walker.nextNode();
      }
      const range = document.createRange();
      range.setStart(node!, offset);
      range.setEnd(node!, offset + 1);
      return range;
    };
    const pitch = at(pitchStart);
    const word = at(wordStart);
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
    element.scrollTop = content.slice(0, onset.index).split('\n').length * lineHeight - lineHeight;
    element.scrollLeft = 0;
    return { pitch_left: pitch.getBoundingClientRect().left, word_left: word.getBoundingClientRect().left,
      line_height: lineHeight, pitch_top: pitch.getBoundingClientRect().top, word_top: word.getBoundingClientRect().top,
      scroll_left: element.scrollLeft, first_word: content.slice(wordStart).split(/\s+/)[0] };
  });
  expect(firstRows.scroll_left).toBe(0);
  expect(firstRows.pitch_left).toBeCloseTo(firstRows.word_left, 4);
  expect(firstRows.word_top - firstRows.pitch_top).toBeCloseTo(firstRows.line_height, 1);
  await mobileView.screenshot({ path: info.outputPath('pitched-lyrics-390-touch.png') });
  await mobileText.evaluate(element => { element.scrollLeft = 100; });
  await expect.poll(() => mobileText.evaluate(element => element.scrollLeft)).toBeGreaterThan(50);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const foreign = await browser.newContext();
  const outsider = await foreign.newPage();
  await outsider.goto(process.env.E2E_BASE_URL!);
  expect((await outsider.request.get(`/api/jobs/${id}/pitched-lyrics/vocals/download`)).status()).toBe(404);
  expect(await (await outsider.request.get('/api/jobs')).json()).toEqual([]);
  const originalResponse = await page.request.get(`/api/jobs/${id}/original`);
  expect(createHash('sha256').update(await originalResponse.body()).digest('hex')).toBe(SOURCE_SHA256);
  await writeFile(info.outputPath('pitched-lyrics-proof.json'), JSON.stringify({ source_sha256: SOURCE_SHA256, job, proofs, native_duration: durationProof, mobile_first_rows: firstRows, screenshots: ['pitched-lyrics-1440.png', 'pitched-lyrics-390-touch.png'] }, null, 2));
  await foreign.close();
  await mobile.close();
});

test('pitched lyrics alone analyze hidden vocals without adding audio exports', async ({ page }) => {
  test.setTimeout(25 * 60 * 1000);
  const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-30s.flac'));
  await page.goto('/');
  const response = await page.request.post('/api/jobs', { multipart: { file: { name: 'public-domain-excerpt.flac', mimeType: 'audio/flac', buffer: source }, extract_pitched_lyrics: 'true' } });
  const id = (await response.json()).id as number;
  let job: JobDTO | undefined;
  await expect.poll(async () => {
    job = await (await page.request.get(`/api/jobs/${id}`)).json() as JobDTO;
    if (job.status === 'failed') throw new Error(job.error_message ?? 'Pitched lyrics failed');
    return job.status;
  }, { timeout: 20 * 60 * 1000, intervals: [1000, 5000] }).toBe('done');
  expect(job!.manifest).toEqual([]);
  expect(job!.pitched_lyrics!.map(track => track.label)).toEqual(['vocals']);
  expect(job!.pitch!.words.map(word => word.text.toLowerCase()).join(' ')).toContain('acquaintance be forgot');
  const knownWord = job!.pitch!.words.findIndex(word => word.text.toLowerCase() === 'acquaintance');
  expect(job!.pitch!.tracks[0].notes.some(note => note.word_indices.includes(knownWord))).toBe(true);
  expect((await page.request.get(`/api/jobs/${id}/results/vocals`)).status()).toBe(404);
  const download = await page.request.get(`/api/jobs/${id}/pitched-lyrics/vocals/download`);
  expect(await download.body()).toEqual(Buffer.from(job!.pitched_lyrics![0].text, 'utf8'));
});
