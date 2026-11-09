import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { authenticateOutsider, test } from './auth-fixture';
import type { JobDTO } from '../src/api';

const SOURCE_SHA256 = '0d277de969ce02959923ec32fd94897a6791cf183fd954198d5e02166e36fb04';

test('real full-song per-stem notes and sung words seek, zoom, persist and stay private on desktop and mobile', async ({ page, browser }, info) => {
  test.setTimeout(45 * 60 * 1000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg'));
  expect(createHash('sha256').update(source).digest('hex')).toBe(SOURCE_SHA256);
  await page.goto('/');
  await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
  const keyResponse = page.waitForResponse(response => response.url().endsWith('/api/key-analysis'));
  await page.getByLabel('Audio file', { exact: true }).setInputFiles({ name: 'auld-lang-syne-full.ogg', mimeType: 'audio/ogg', buffer: source });
  expect((await keyResponse).ok()).toBe(true);
  await page.getByRole('checkbox', { name: 'Karaoke with pitches', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Extract lyrics', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Extract vocals', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Extract instruments', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Split drums, bass & other instruments', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Split lead & backing vocals', exact: true }).check();
  await page.getByLabel('Pitch shift (semitones)', { exact: true }).fill('1.25');
  await page.getByLabel('Tempo (% of original)', { exact: true }).fill('125');
  const submitted = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Process audio', exact: true }).click();
  const id = (await (await submitted).json()).id as number;
  let job: JobDTO | undefined;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/jobs/${id}`, { headers: { Connection: 'close' } });
    expect(response.ok()).toBe(true);
    job = await response.json() as JobDTO;
    if (job.status === 'failed') throw new Error(job.error_message ?? 'Pitch job failed');
    return job.status;
  }, { timeout: 25 * 60 * 1000, intervals: [500, 2000, 5000] }).toBe('done');
  const analysis = job!.pitch!;
  expect(analysis.tracks.map(track => track.label)).toEqual(['vocals', 'lead', 'backing']);
  expect(analysis.source_duration_s).toBeGreaterThan(141);
  expect(analysis.source_duration_s).toBeLessThan(142);
  expect(analysis.duration_s).toBeCloseTo(analysis.source_duration_s / 1.25, 5);
  expect(analysis.pitch_shift_semitones).toBe(1.25);
  expect(analysis.timestamp_reference).toBe('output');
  const recognizedWords = analysis.words.map(word => word.text.toLocaleLowerCase()).join(' ');
  expect(recognizedWords).toContain('acquaintance be forgot');
  expect(recognizedWords).toContain('cup of kindness');
  expect(job!.transcript!.timestamp_reference).toBe('original');
  expect(job!.transcript!.reference).not.toBeNull();
  expect(job!.transcript!.words![0].start_s / 1.25).toBeCloseTo(analysis.words[0].start_s, 6);
  expect(job!.manifest!.map(entry => entry.label)).toEqual(['song', 'vocals', 'lead', 'backing', 'instruments', 'drums', 'bass', 'other-instruments', 'drums-vocals']);
  const view = page.getByLabel('Vocal pitch analysis', { exact: true });
  await expect(view).toBeVisible();
  await expect(view.locator('.pitch-note')).toHaveCount(analysis.tracks[0].notes.length);
  await expect(view.locator('.pitch-note text').first()).toHaveText(analysis.tracks[0].notes[0].note);
  const acquaintanceIndex = analysis.words.findIndex(word => word.text.toLocaleLowerCase() === 'acquaintance');
  const noteIndex = analysis.tracks[0].notes.findIndex(note => note.word_indices.includes(acquaintanceIndex));
  const note = analysis.tracks[0].notes[noteIndex];
  const rectangle = view.locator('.pitch-note').nth(noteIndex);
  await rectangle.scrollIntoViewIfNeeded();
  await rectangle.click();
  const player = view.locator('audio:not([hidden])');
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(note.start_s, 1);
  await player.evaluate(element => element.play());
  await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(note.start_s + 0.3);
  await expect(view.locator('.pitch-selection')).toContainText(note.note);
  const playhead = Number(await view.locator('.pitch-playhead').getAttribute('x1')) / 100;
  expect(Math.abs(playhead - await player.evaluate(element => element.currentTime))).toBeLessThan(0.6);
  // The new native player participates in the central playback guard too.
  const original = page.getByRole('link', { name: 'Download original', exact: true }).locator('..').locator('audio');
  await original.evaluate(element => element.play());
  await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
  await original.evaluate(element => element.pause());

  const wordIndex = analysis.words.findIndex((_, index) => analysis.tracks[0].notes.filter(item => item.word_indices.includes(index)).length >= 2);
  expect(wordIndex).toBeGreaterThanOrEqual(0);
  const word = view.locator('.pitch-word').nth(wordIndex);
  await word.scrollIntoViewIfNeeded();
  await word.click();
  const linkedCount = analysis.tracks[0].notes.filter(item => item.word_indices.includes(wordIndex)).length;
  await expect(view.locator('.pitch-note-selected')).toHaveCount(linkedCount);
  await expect(view.locator('.pitch-selection')).toContainText(analysis.words[wordIndex].text);
  const selectedBackgroundUrl = await player.getAttribute('src');
  await view.getByLabel('Pitch vocal stem', { exact: true }).selectOption('lead');
  await expect(view.locator('.pitch-note')).toHaveCount(analysis.tracks[1].notes.length);
  await expect(player).toHaveAttribute('src', selectedBackgroundUrl!);
  const leadBackground = view.getByRole('group', { name: 'Pitch background audio' }).getByRole('button', { name: /^lead/ });
  await leadBackground.click();
  await expect(leadBackground).toHaveAttribute('aria-pressed', 'true');
  await expect(view.locator('.pitch-note')).toHaveCount(analysis.tracks[1].notes.length);
  await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
  await player.evaluate(audio => audio.play());
  const leadStartedAt = await player.evaluate(audio => audio.currentTime);
  await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(leadStartedAt + 0.2);
  await player.evaluate(audio => audio.pause());
  await view.screenshot({ path: info.outputPath('pitch-desktop.png') });
  const downloaded = await page.request.get(`/api/jobs/${id}/pitch`);
  expect(await downloaded.json()).toEqual(analysis);
  const downloadPromise = page.waitForEvent('download');
  await view.getByRole('link', { name: 'Download pitch JSON', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('auld-lang-syne-full - pitch.json');
  const originalResponse = await page.request.get(`/api/jobs/${id}/original`);
  expect(createHash('sha256').update(await originalResponse.body()).digest('hex')).toBe(SOURCE_SHA256);
  const lyricsJson = await page.request.get(`/api/jobs/${id}/lyrics/download.json`);
  expect(await lyricsJson.json()).toEqual(job!.transcript);
  const storageState = await page.context().storageState();
  const mobile = await browser.newContext({ storageState, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(process.env.E2E_BASE_URL!);
  const mobileView = mobilePage.getByLabel('Vocal pitch analysis', { exact: true });
  await expect(mobileView).toBeVisible();
  // Compare against the configured device width, not an overflow-expanded innerWidth.
  expect(await mobilePage.evaluate(() => window.innerWidth)).toBe(mobilePage.viewportSize()!.width);
  expect(await mobilePage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobilePage.viewportSize()!.width);
  const scroll = mobileView.getByRole('region', { name: 'Scrollable vocal melody timeline', exact: true });
  expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth * 10)).toBe(true);
  await scroll.evaluate(element => { element.scrollLeft = 1000; });
  await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(500);
  const widthBefore = await mobileView.locator('.pitch-canvas').evaluate(element => element.clientWidth);
  await mobileView.getByRole('button', { name: 'Zoom in melody' }).click();
  expect(await mobileView.locator('.pitch-canvas').evaluate(element => element.clientWidth)).toBeGreaterThan(widthBefore);
  expect(await mobilePage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobilePage.viewportSize()!.width);
  await mobileView.screenshot({ path: info.outputPath('pitch-mobile.png') });
  await mobileView.getByRole('slider', { name: 'Melody zoom', exact: true }).press('End');
  await expect(mobileView.getByRole('slider', { name: 'Melody zoom', exact: true })).toHaveValue('640');
  expect(await mobilePage.evaluate(() => window.innerWidth)).toBe(mobilePage.viewportSize()!.width);
  const shortestIndex = analysis.tracks[0].notes.reduce((best, item, index, all) =>
    item.word_indices.includes(acquaintanceIndex) && item.end_s - item.start_s < all[best].end_s - all[best].start_s ? index : best, noteIndex);
  const shortNote = analysis.tracks[0].notes[shortestIndex];
  const shortRectangle = mobileView.locator('.pitch-note').nth(shortestIndex);
  await shortRectangle.scrollIntoViewIfNeeded();
  await shortRectangle.click();
  await expect(mobileView.locator('.pitch-selection')).toContainText(shortNote.note);
  const shortGeometry = await shortRectangle.evaluate(element => ({
    rectangle: element.querySelector('rect')!.getBBox().width,
    label: element.querySelector('text')!.getComputedTextLength(),
    fontSize: getComputedStyle(element.querySelector('text')!).fontSize,
  }));
  expect(shortGeometry.rectangle).toBeGreaterThanOrEqual(shortGeometry.label + 2);
  const nearestTick = Math.round(shortNote.start_s * 4) / 4;
  const rulerLabel = `${Math.floor(nearestTick / 60)}:${(nearestTick % 60).toFixed(2).padStart(5, '0')}`;
  await scroll.scrollIntoViewIfNeeded();
  await expect(mobileView.locator('.pitch-ruler').getByText(rulerLabel, { exact: true })).toBeInViewport();
  expect(await mobilePage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobilePage.viewportSize()!.width);
  await mobileView.screenshot({ path: info.outputPath('pitch-mobile-short-note-zoom.png') });
  await mobilePage.reload();
  await expect(mobilePage.getByLabel('Vocal pitch analysis', { exact: true })).toBeVisible();
  await expect(mobilePage.getByRole('button', { name: 'View vocal pitch timeline', exact: true })).toBeVisible();
  const foreign = await browser.newContext();
  await authenticateOutsider(foreign);
  const outsider = await foreign.newPage();
  await outsider.goto(process.env.E2E_BASE_URL!);
  expect((await outsider.request.get(`/api/jobs/${id}/pitch`)).status()).toBe(404);
  expect(await (await outsider.request.get('/api/jobs')).json()).toEqual([]);
  await foreign.close();
  await mobile.close();
  await writeFile(info.outputPath('pitch-proof.json'), JSON.stringify({ source_sha256: SOURCE_SHA256, job, linked_word: { text: analysis.words[wordIndex].text, notes: linkedCount }, download_filename: download.suggestedFilename(), shortest_word_note: { note: shortNote, zoom_px_per_second: 640, geometry: shortGeometry, visible_ruler_label: rulerLabel }, screenshots: ['pitch-desktop.png', 'pitch-mobile.png', 'pitch-mobile-short-note-zoom.png'] }, null, 2));
});

test('legacy API pitch-only analysis retains the hidden full-vocal prerequisite and recovers its cached private audio without reanalysis', async ({ page, browser }) => {
  test.setTimeout(25 * 60 * 1000);
  let analysisPostCount = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') {
      analysisPostCount += 1;
    }
  });
  const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-30s.flac'));
  await page.goto('/');
  // The current karaoke form includes vocals and lyrics. Preserve coverage of
  // independent API pitch-only requests and their historical stored-job path.
  const id = await page.evaluate(async bytes => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(bytes)], 'sung-excerpt.flac', { type: 'audio/flac' }));
    form.append('detect_pitch', 'true');
    const response = await fetch('/api/jobs', { method: 'POST', body: form, credentials: 'include' });
    if (!response.ok) throw new Error(`Pitch-only API submission failed: ${response.status}`);
    return (await response.json()).id as number;
  }, [...source]);
  let job: JobDTO | undefined;
  await expect.poll(async () => {
    job = await (await page.request.get(`/api/jobs/${id}`, { headers: { Connection: 'close' } })).json() as JobDTO;
    if (job.status === 'failed') throw new Error(job.error_message ?? 'Pitch job failed');
    return job.status;
  }, { timeout: 20 * 60 * 1000, intervals: [500, 2000, 5000] }).toBe('done');
  expect(job!.manifest).toEqual([]);
  expect(job!.transcript).toBeNull();
  expect(job!.pitch!.tracks.map(track => track.label)).toEqual(['vocals']);
  expect(job!.pitch!.tracks[0].notes.some(note => note.start_s < 4.5 && note.end_s > 2.5)).toBe(true);
  expect(job!.pitch!.word_alignment).toBeNull();
  await page.reload();
  const view = page.getByLabel('Vocal pitch analysis', { exact: true });
  await expect(view.getByRole('group', { name: 'Pitch background audio' }).getByRole('button', { name: 'Full song' })).toHaveAttribute('aria-pressed', 'true');
  expect((await page.request.get(`/api/jobs/${id}/results/vocals`)).status()).toBe(404);
  const original = await page.request.get(`/api/jobs/${id}/original`);
  expect(await original.body()).toEqual(source);
  expect(analysisPostCount).toBe(1);
  expect(job!.has_pitch_vocals).toBe(true);
  const modalCallId = () => JSON.parse(execFileSync('uv', [
    'run', 'python', '-c',
    'import json,sqlite3,sys; db=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro", uri=True); print(json.dumps(db.execute("SELECT modal_call_id FROM jobs WHERE id=?", (int(sys.argv[2]),)).fetchone()[0]))',
    resolve(process.env.E2E_DATA_DIR!, 'jobs.db'), String(id),
  ], { cwd: process.env.E2E_REPO_ROOT!, encoding: 'utf8' })) as string | null;
  const originalCallId = modalCallId();
  const originalPitch = await (await page.request.get(`/api/jobs/${id}/pitch`)).json();
  const privateReference = await page.request.get(`/api/jobs/${id}/pitch-reference/vocals`);
  expect(privateReference.status()).toBe(200);
  expect(privateReference.headers()['content-type']).toContain('audio/mpeg');

  await rm(resolve(
    process.env.E2E_DATA_DIR!,
    'results',
    String(id),
    '.pitch-vocals.mp3',
  ));
  expect((await page.request.get(`/api/jobs/${id}/pitch-reference/vocals`)).status()).toBe(404);
  await page.reload();
  const recoveredView = page.getByLabel('Vocal pitch analysis', { exact: true });
  await expect(recoveredView).toBeVisible();
  await expect(recoveredView.getByRole('button', { name: 'Recover cached vocals', exact: true })).toBeVisible();

  const recovery = page.waitForResponse(response =>
    response.url().endsWith(`/api/jobs/${id}/pitch-reference/vocals`)
      && response.request().method() === 'POST',
    { timeout: 120_000 },
  );
  await recoveredView.getByRole('button', { name: 'Recover cached vocals', exact: true }).click();
  expect((await recovery).status()).toBe(204);
  await expect(recoveredView.getByRole('group', { name: 'Pitch background audio' }).getByRole('button', { name: 'Just vocals' })).toHaveAttribute('aria-pressed', 'true');
  expect((await page.request.get(`/api/jobs/${id}/pitch-reference/vocals`)).status()).toBe(200);
  const recoveredPlayer = recoveredView.locator('audio:not([hidden])');
  await expect.poll(() => recoveredPlayer.evaluate(element => element.paused)).toBe(true);
  await recoveredPlayer.evaluate(element => element.play());
  await expect.poll(() => recoveredPlayer.evaluate(element =>
    element.readyState >= 1
      && element.duration > 20
      && element.seekable.length > 0
      && element.currentTime > 0.2,
  )).toBe(true);
  await recoveredPlayer.evaluate(element => element.pause());
  await expect.poll(() => recoveredPlayer.evaluate(element => element.paused)).toBe(true);
  await recoveredPlayer.evaluate(element => { element.currentTime = 1; });
  await expect.poll(() => recoveredPlayer.evaluate(element => element.currentTime)).toBeGreaterThan(0.8);

  const recoveredJob = await (await page.request.get(`/api/jobs/${id}`)).json() as JobDTO;
  expect(recoveredJob.id).toBe(id);
  expect(recoveredJob.has_pitch_vocals).toBe(true);
  expect(recoveredJob.pitch).toEqual(job!.pitch);
  expect(await (await page.request.get(`/api/jobs/${id}/pitch`)).json()).toEqual(originalPitch);
  expect((await page.request.get(`/api/jobs/${id}/results/vocals`)).status()).toBe(404);
  expect(analysisPostCount).toBe(1);
  expect(modalCallId()).toBe(originalCallId);

  const foreign = await browser.newContext();
  await authenticateOutsider(foreign);
  expect((await foreign.request.get(`/api/jobs/${id}/pitch-reference/vocals`)).status()).toBe(404);
  await foreign.close();
});
