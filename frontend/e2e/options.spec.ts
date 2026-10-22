import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { BooleanOptionKey, JobDTO, SeparationOptions } from '../src/api';
import { keyScale, transposeKey } from '../src/lib/music';
import { hash, inspectAudio, inspectMix, pcm } from './audio';

const directory = process.env.E2E_FIXTURE_DIR!;
const fixtureURL = process.env.E2E_FIXTURE_URL!;
const booleanKeys: BooleanOptionKey[] = ['extract_vocals', 'extract_instruments', 'mix_female_instruments', 'mix_male_instruments', 'mix_backing_instruments', 'decrowd', 'decrowd_vocals', 'dereverb', 'genders', 'lead_backing', 'drums', 'no_cache'];
const defaults = Object.fromEntries([...booleanKeys.map(key => [key, false]), ['pitch_semitones', 0], ['tempo_percent', 100]]) as unknown as SeparationOptions;
const allLabels = ['vocals', 'vocals-dry', 'vocals-decrowded', 'vocals-decrowded-dry', 'vocals-male', 'vocals-male-dry', 'vocals-female', 'vocals-female-dry', 'lead', 'lead-dry', 'backing', 'backing-dry', 'instruments', 'instruments-decrowded', 'drums', 'bass', 'other-instruments', 'female-instruments', 'male-instruments', 'backing-instruments'];
interface Case { name: string; selected: Partial<SeparationOptions>; labels: string[]; source?: 'url'; cache?: 'hit' | 'bypass'; }
const cases: Case[] = [
  { name: 'identity-original-only', selected: {}, labels: [] },
  { name: 'extract_vocals', selected: { extract_vocals: true }, labels: ['vocals'] },
  { name: 'extract_instruments', selected: { extract_instruments: true }, labels: ['instruments'] },
  { name: 'mix_female_instruments', selected: { mix_female_instruments: true }, labels: ['female-instruments'] },
  { name: 'mix_male_instruments', selected: { mix_male_instruments: true }, labels: ['male-instruments'] },
  { name: 'mix_backing_instruments', selected: { mix_backing_instruments: true }, labels: ['backing-instruments'] },
  { name: 'decrowd', selected: { decrowd: true }, labels: ['instruments-decrowded'] },
  { name: 'decrowd_vocals', selected: { decrowd_vocals: true }, labels: ['vocals-decrowded'] },
  { name: 'dereverb', selected: { dereverb: true }, labels: ['vocals-dry'] },
  { name: 'genders', selected: { genders: true }, labels: ['vocals-male', 'vocals-female'] },
  { name: 'lead_backing', selected: { lead_backing: true }, labels: ['lead', 'backing'] },
  { name: 'drums', selected: { drums: true }, labels: ['drums', 'bass', 'other-instruments'] },
  { name: 'no_cache-without-gpu', selected: { no_cache: true }, labels: [] },
  { name: 'gpu-cache-hit', selected: { extract_vocals: true }, labels: ['vocals'], cache: 'hit' },
  { name: 'gpu-cache-bypass', selected: { extract_vocals: true, no_cache: true }, labels: ['vocals'], cache: 'bypass' },
  { name: 'all-booleans-enabled', selected: Object.fromEntries(booleanKeys.map(key => [key, true])), labels: allLabels },
  { name: 'all-options-with-transforms', selected: { ...Object.fromEntries(booleanKeys.map(key => [key, true])), pitch_semitones: 1.25, tempo_percent: 125 }, labels: allLabels },
  { name: 'mixes-hidden-dry-prerequisites', selected: { mix_female_instruments: true, mix_male_instruments: true, mix_backing_instruments: true, dereverb: true }, labels: ['female-instruments', 'male-instruments', 'backing-instruments'] },
  { name: 'mixes-cleaned-dry-prerequisites', selected: { mix_female_instruments: true, mix_male_instruments: true, mix_backing_instruments: true, decrowd: true, decrowd_vocals: true, dereverb: true }, labels: ['vocals-decrowded', 'vocals-decrowded-dry', 'instruments-decrowded', 'female-instruments', 'male-instruments', 'backing-instruments'] },
  { name: 'instrument-only-dereverb-no-hidden-vocal', selected: { extract_instruments: true, dereverb: true }, labels: ['instruments'] },
  { name: 'positive-fractional-pitch-speedup-no-extraction', selected: { pitch_semitones: 2.5, tempo_percent: 120 }, labels: ['song'] },
  { name: 'negative-fractional-pitch-slowdown-no-extraction', selected: { pitch_semitones: -1.25, tempo_percent: 80, no_cache: true }, labels: ['song'] },
  { name: 'pitch-only', selected: { pitch_semitones: 2 }, labels: ['song'] },
  { name: 'tempo-only', selected: { tempo_percent: 80 }, labels: ['song'] },
  { name: 'separated-output-pitch-and-tempo', selected: { extract_instruments: true, pitch_semitones: -2.5, tempo_percent: 125 }, labels: ['instruments'] },
  { name: 'real-http-url-download', selected: {}, labels: [], source: 'url' },
];

async function chooseSource(page: Page, source: 'url' | 'upload' = 'upload', filename = 'tone-fixture') {
  if (source === 'upload') {
    await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
    await page.getByLabel('Audio file', { exact: true }).setInputFiles(resolve(directory, `${filename}.wav`));
  } else {
    await page.getByLabel('Track URL', { exact: true }).fill(`${fixtureURL}/${filename}.wav`);
  }
}

async function configure(page: Page, options: SeparationOptions) {
  if (options.no_cache) await page.getByText('Advanced · cache', { exact: true }).click();
  for (const key of booleanKeys) {
    if (options[key]) await page.locator(`#option-${key}`).click();
  }
  await page.getByLabel('Pitch shift (semitones)', { exact: true }).fill(String(options.pitch_semitones));
  await page.getByLabel('Tempo (% of original)', { exact: true }).fill(String(options.tempo_percent));
}

async function submit(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
  await page.locator('form button[type=submit]').click();
  const res = await response;
  expect(res.status()).toBe(200);
  const submitted = await res.json();
  expect(submitted.status).toBe('queued');
  if (submitted.position !== null) expect(submitted.position).toBeGreaterThan(0);
  return submitted.id as number;
}

async function complete(page: Page, id: number) {
  let job: JobDTO | undefined;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/jobs/${id}`);
    expect(response.ok()).toBe(true);
    job = await response.json();
    if (job!.status === 'failed') throw new Error(`Real job ${id} failed: ${job!.error_message}`);
    return job!.status;
  }, { timeout: 24 * 60 * 1000, intervals: [250, 1000, 3000] }).toBe('done');
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
  return job!;
}

async function prove(page: Page, info: TestInfo, item: Case, job: JobDTO, originalKey: string) {
  const fixtureName = item.labels.length && item.labels[0] !== 'song' ? 'musical-fixture' : 'tone-fixture';
  const options = { ...defaults, ...item.selected };
  expect(job.options).toEqual(options);
  expect(job.manifest!.map(stem => stem.label)).toEqual(item.labels);
  expect(job.has_original).toBe(true);
  expect(job.original_key).toBe(originalKey);
  expect(job.output_key).toBe(transposeKey(originalKey, options.pitch_semitones));
  const queue = JSON.parse(execFileSync('uv', ['run', 'python', '-c',
    'import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.row_factory=sqlite3.Row; print(json.dumps(dict(db.execute("SELECT modal_call_id,started_at,finished_at FROM jobs WHERE id=?",(int(sys.argv[2]),)).fetchone())))',
    resolve(process.env.E2E_DATA_DIR!, 'jobs.db'), String(job.id),
  ], { cwd: process.env.E2E_REPO_ROOT, encoding: 'utf8' }));
  expect(queue.started_at).not.toBeNull();
  expect(queue.finished_at).toBeGreaterThanOrEqual(queue.started_at);
  if (item.labels.length && item.labels[0] !== 'song') expect(queue.modal_call_id).toMatch(/^fc-/);
  else expect(queue.modal_call_id).toBeNull();
  const links = page.locator(`a[download][href^='/api/jobs/${job.id}/']`).filter({ visible: true });
  // Results and History each expose exactly one link for every public track.
  expect(await links.count()).toBe((item.labels.length + 1) * 2);
  const files: Record<string, string> = {};
  const audio: Record<string, unknown> = {};
  const original = page.locator(`a[href='/api/jobs/${job.id}/original']`).first();
  const originalDownload = page.waitForEvent('download');
  await original.click();
  const download = await originalDownload;
  files.original = info.outputPath(download.suggestedFilename());
  await download.saveAs(files.original);
  const originalBytes = await readFile(files.original);
  if (job.source_type === 'upload') expect(hash(originalBytes)).toBe(hash(await readFile(resolve(directory, `${fixtureName}.wav`))));
  expect(download.suggestedFilename()).toBe(`${fixtureName} - original.${job.source_type === 'upload' ? 'wav' : 'mp3'}`);
  audio.original = await inspectAudio(page, files.original, 8, fixtureName === 'tone-fixture' ? 261.6256 : undefined);
  const suffix = `${options.pitch_semitones ? ` - pitch${options.pitch_semitones > 0 ? '+' : ''}${options.pitch_semitones}st` : ''}${options.tempo_percent !== 100 ? ` - tempo${options.tempo_percent}pct` : ''}`;
  for (const stem of job.manifest!) {
    expect(stem.filename).toBe(`${stem.label}${suffix}.mp3`);
    expect(stem.download_name).toBe(`${fixtureName} - ${stem.label} - source-key-${originalKey.replaceAll(' ', '-')}${suffix}.mp3`);
    const served = await page.request.get(`/api/jobs/${job.id}/results/${stem.label}`);
    expect(served.status()).toBe(200);
    expect(decodeURIComponent(served.headers()['content-disposition'])).toContain(stem.download_name);
    const stemLinks = page.locator(`a[href='/api/jobs/${job.id}/results/${stem.label}']`);
    await expect(stemLinks).toHaveCount(2);
    await expect(stemLinks.nth(1)).toContainText(`Source key: ${originalKey}`);
    const card = stemLinks.first().locator('../..');
    await expect(card.getByText(`Source key: ${originalKey}`, { exact: true })).toBeVisible();
    if (job.output_key !== originalKey) {
      await expect(card.getByText(`Source key: ${job.output_key}`, { exact: true })).toHaveCount(0);
    }
    const event = page.waitForEvent('download');
    await page.locator(`a[href='/api/jobs/${job.id}/results/${stem.label}']`).first().click();
    const output = await event;
    expect(output.suggestedFilename()).toBe(stem.download_name);
    files[stem.label] = info.outputPath(output.suggestedFilename());
    await output.saveAs(files[stem.label]);
    expect((await readFile(files[stem.label])).length).toBe(stem.size_bytes);
    audio[stem.label] = await inspectAudio(page, files[stem.label], 8 * 100 / options.tempo_percent, stem.label === 'song' ? 261.6256 * 2 ** (options.pitch_semitones / 12) : undefined);
    if (item.cache === 'hit') expect(stem.duration_s).toBe(0);
    if (item.cache === 'bypass') expect(stem.duration_s).toBeGreaterThan(0);
  }
  for (const label of [...allLabels, 'song'].filter(label => !item.labels.includes(label))) {
    expect((await page.request.get(`/api/jobs/${job.id}/results/${label}`)).status()).toBe(404);
  }
  const mixes: Record<string, unknown> = {};
  if (item.name === 'all-booleans-enabled') {
    for (const [mix, vocal] of [['female-instruments', 'vocals-female-dry'], ['male-instruments', 'vocals-male-dry'], ['backing-instruments', 'backing-dry']]) {
      mixes[mix] = inspectMix(files[mix], files[vocal], files['instruments-decrowded']);
    }
    expect(hash(await readFile(files['vocals-male']))).not.toBe(hash(await readFile(files['vocals-female'])));
    expect(hash(await readFile(files.lead))).not.toBe(hash(await readFile(files.backing)));
    for (const width of [1440, 1920, 2560, 3840, 375, 390, 430]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1100 });
      await expect(page.getByText(`Source key: ${originalKey}`, { exact: true })).toHaveCount(allLabels.length * 2);
      const geometry = await page.evaluate(id => {
        const links = [...document.querySelectorAll<HTMLAnchorElement>(`a[href^="/api/jobs/${id}/results/"]`)];
        return {
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          links: links.map(link => {
            const rect = link.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: link.clientWidth, contentWidth: link.scrollWidth };
          }),
        };
      }, job.id);
      expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
      for (const link of geometry.links) {
        expect(link.left).toBeGreaterThanOrEqual(0);
        expect(link.right).toBeLessThanOrEqual(width);
        expect(link.contentWidth).toBeLessThanOrEqual(link.width + 1);
      }
      await page.screenshot({ path: info.outputPath(`source-key-all-stems-${width}.png`), fullPage: true });
    }
  }
  if (item.name === 'pitch-only') {
    await page.setViewportSize({ width: 2560, height: 1440 });
    const card = page.locator(`a[href='/api/jobs/${job.id}/results/song']`).first().locator('../..');
    await card.screenshot({ path: info.outputPath('source-key-pitched-card-2560.png') });
  }
  const proof = { case: item.name, modal_app: process.env.E2E_MODAL_APP_NAME, fixture_seed: process.env.E2E_FIXTURE_SEED, options, expected_labels: item.labels, job, queue, audio, mixes };
  await writeFile(info.outputPath('proof.json'), JSON.stringify(proof, null, 2));
  await info.attach('per-option-proof', { path: info.outputPath('proof.json'), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('completed.png'), fullPage: true });
  console.log(`OPTION_PROOF ${JSON.stringify({ case: item.name, id: job.id, options, labels: item.labels, proof: info.outputPath('proof.json') })}`);
}

for (const item of cases) {
  test(item.name, async ({ page, browser }, info) => {
    const options = { ...defaults, ...item.selected };
    const fixtureName = item.labels.length && item.labels[0] !== 'song' ? 'musical-fixture' : 'tone-fixture';
    await page.goto('/');
    const analysisResponse = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
    await chooseSource(page, item.source === 'url' ? 'url' : 'upload', fixtureName);
    const analysis = await analysisResponse;
    expect(analysis.status()).toBe(200);
    const originalKey = (await analysis.json()).original_key as string;
    expect(originalKey).toBe('C major');
    await expect(page.getByText(`Original key: ${originalKey}`, { exact: true })).toBeVisible();
    await configure(page, options);
    await expect(page.getByText(`Target key: ${transposeKey(originalKey, options.pitch_semitones)}`, { exact: true })).toBeVisible();
    const notes = keyScale(transposeKey(originalKey, options.pitch_semitones))!;
    await expect(page.getByText(`Notes (${notes.mode}): ${notes.notes.join(' · ')}`, { exact: true }).last()).toBeVisible();
    await expect(page.getByText(`Tracks you'll get (${item.labels.length + 1})`, { exact: true })).toBeVisible();
    if (item.cache === 'hit') {
      const warmId = await submit(page);
      await complete(page, warmId);
      await chooseSource(page, 'upload', fixtureName);
      await expect(page.getByText(`Original key: ${originalKey}`, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await configure(page, options);
    }
    const id = await submit(page);
    if (item.name === 'extract_vocals' || item.name === 'all-booleans-enabled') {
      await expect(page.getByText(/Processing audio, this can take a few minutes/)).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('span.animate-spin').last()).toBeVisible();
      await page.reload();
      await expect(page.getByText(/Processing audio, this can take a few minutes/)).toBeVisible();
    }
    const job = await complete(page, id);
    await prove(page, info, item, job, originalKey);
    if (item.name === 'identity-original-only') {
      await page.reload();
      const history = page.getByRole('heading', { name: 'History', exact: true }).locator('..');
      await expect(history.locator(`a[href='/api/jobs/${id}/original']`)).toBeVisible();
    }
    if (item.name === 'identity-original-only' || item.name === 'all-booleans-enabled') {
      const stranger = await browser.newContext();
      try {
        const isolated = await stranger.newPage();
        await isolated.goto('/');
        await expect(isolated.getByText('No jobs yet.', { exact: true })).toBeVisible();
        expect((await isolated.request.get(`/api/jobs/${id}`)).status()).toBe(404);
        expect((await isolated.request.get(`/api/jobs/${id}/original`)).status()).toBe(404);
        for (const label of item.labels) expect((await isolated.request.get(`/api/jobs/${id}/results/${label}`)).status()).toBe(404);
      } finally { await stranger.close(); }
    }
  });
}

test('key-preview-source-change-errors-and-real-retry', async ({ page }, info) => {
  await page.goto('/');
  await chooseSource(page);
  await expect(page.getByRole('status')).toContainText('Analyzing original key');
  await expect(page.getByText('Original key: C major', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Audio file', { exact: true }).setInputFiles(resolve(directory, 'invalid.wav'));
  await expect(page.getByText('Original key: C major', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Key analysis:');
  await page.getByRole('button', { name: 'From URL', exact: true }).click();
  await page.getByLabel('Track URL', { exact: true }).fill(`${fixtureURL}/recoverable.wav`);
  await expect(page.getByRole('status')).toContainText('Downloading audio and analyzing');
  await expect(page.getByRole('alert')).toContainText('Key analysis:');
  expect(await page.getByText('Original key: C major', { exact: true }).count()).toBe(0);
  const failedId = await submit(page);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible({ timeout: 60_000 });
  const failed = await (await page.request.get(`/api/jobs/${failedId}`)).json();
  expect(failed.status).toBe('failed');
  expect((await page.request.post(`${fixtureURL}/recover`)).ok()).toBe(true);
  const response = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${failedId}/retry`));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  const retried = await (await response).json();
  const job = await complete(page, retried.id);
  expect(job.options).toEqual(failed.options);
  expect(job.source_value).toBe(failed.source_value);
  await writeFile(info.outputPath('proof.json'), JSON.stringify({ case: 'key-preview-source-change-errors-and-real-retry', failed, recovered: job }, null, 2));
});

test('undetermined-source-key-omits-stem-label-and-download-token', async ({ page }, info) => {
  await page.goto('/');
  const analysisResponse = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
  await chooseSource(page, 'upload', 'silent-fixture');
  expect((await (await analysisResponse).json()).original_key).toBeNull();
  await configure(page, { ...defaults, pitch_semitones: 2 });
  const id = await submit(page);
  const job = await complete(page, id);
  expect(job.original_key).toBeNull();
  expect(job.output_key).toBeNull();
  expect(job.manifest!.map(stem => stem.label)).toEqual(['song']);
  expect(job.manifest![0].filename).toBe('song - pitch+2st.mp3');
  expect(job.manifest![0].download_name).toBe('silent-fixture - song - pitch+2st.mp3');
  const served = await page.request.get(`/api/jobs/${id}/results/song`);
  expect(served.status()).toBe(200);
  expect(decodeURIComponent(served.headers()['content-disposition'])).toContain('silent-fixture - song - pitch+2st.mp3');
  expect(served.headers()['content-disposition']).not.toContain('source-key');
  await expect(page.getByText(/Source key:/)).toHaveCount(0);
  const event = page.waitForEvent('download');
  await page.locator(`a[href='/api/jobs/${id}/results/song']`).first().click();
  const download = await event;
  expect(download.suggestedFilename()).toBe('silent-fixture - song - pitch+2st.mp3');
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const decoded = pcm(path);
  expect(decoded.length / 96000).toBeCloseTo(8, 1);
  expect(decoded.every(sample => sample === 0)).toBe(true);
  const original = await page.request.get(`/api/jobs/${id}/original`);
  expect(hash(await original.body())).toBe(hash(await readFile(resolve(directory, 'silent-fixture.wav'))));
  expect(original.headers()['content-disposition']).toContain('silent-fixture%20-%20original.wav');
  await page.reload();
  const history = page.getByRole('heading', { name: 'History', exact: true }).locator('..');
  const historyStem = history.locator(`a[href='/api/jobs/${id}/results/song']`);
  await expect(historyStem).toHaveCount(1);
  await expect(historyStem).not.toContainText('Source key:');
  await expect(historyStem).toHaveAttribute('download', 'silent-fixture - song - pitch+2st.mp3');
  await page.screenshot({ path: info.outputPath('undetermined-source-key.png'), fullPage: true });
});
