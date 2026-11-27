import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { authenticateOutsider, test } from './auth-fixture';
import { jobLabel, type BooleanOptionKey, type JobDTO, type SeparationOptions, type SongDetail, type SongOutputRef, type SubmitResult } from '../src/api';
import { displayOutputLabel } from '../src/lib/expectedStems';
import { keyScale, transposeKey } from '../src/lib/music';
import { stemMixName, type StemComponent, type StemMix } from '../src/lib/stemMix';
import { hash, inspectAudio, inspectMix, inspectTransformedSource, pcm } from './audio';

const directory = process.env.E2E_FIXTURE_DIR!;
const fixtureURL = process.env.E2E_FIXTURE_URL!;
const audioBooleanKeys: BooleanOptionKey[] = ['extract_vocals', 'extract_instruments', 'decrowd', 'decrowd_vocals', 'dereverb', 'genders', 'lead_backing', 'drums'];
const booleanKeys: BooleanOptionKey[] = [...audioBooleanKeys, 'extract_lyrics', 'detect_pitch', 'extract_pitched_lyrics'];
const defaults = Object.fromEntries([...audioBooleanKeys.map(key => [key, false]), ['extract_lyrics', false], ['detect_pitch', false], ['extract_pitched_lyrics', false], ['mixes', []], ['pitch_semitones', 0], ['tempo_percent', 100]]) as unknown as SeparationOptions;
const allLabels = ['vocals', 'vocals-dry', 'vocals-decrowded', 'vocals-decrowded-dry', 'vocals-male', 'vocals-male-dry', 'vocals-female', 'vocals-female-dry', 'lead', 'lead-dry', 'backing', 'backing-dry', 'instruments', 'instruments-decrowded', 'drums', 'bass', 'other-instruments'];
const COMPONENT_LABELS: Record<StemComponent, string> = {
  drums: 'Drums', bass: 'Bass', vocals: 'Vocals', other: 'Other instruments', instruments: 'Instruments',
  female: 'Female vocals', male: 'Male vocals', lead: 'Lead vocals', backing: 'Backing vocals',
};
const VARIANT_COMPONENTS: StemComponent[] = ['female', 'male', 'lead', 'backing'];
const MIX = (id: string, components: StemComponent[], name?: string): StemMix => ({
  id, name: name ?? stemMixName(components), components,
});
/**
 * Source stems a mix is built from. Dereverb cleans the vocal ingredient the
 * same way it did for the previous fixed mixes; the decrowd mapping for
 * component instruments is a backend-owned decision and mix cases therefore
 * stay decrowd-free.
 */
const componentStems = (component: StemComponent, options: SeparationOptions): string[] => {
  const dry = options.dereverb ? '-dry' : '';
  switch (component) {
    case 'drums': return ['drums'];
    case 'bass': return ['bass'];
    case 'vocals': return [`vocals${dry}`];
    case 'other': return ['other-instruments'];
    case 'instruments': return ['instruments'];
    case 'female': return [`vocals-female${dry}`];
    case 'male': return [`vocals-male${dry}`];
    case 'lead': return [`lead${dry}`];
    case 'backing': return [`backing${dry}`];
  }
};
interface Case { name: string; selected: Partial<SeparationOptions>; labels: string[]; source?: 'url'; fixture?: 'tone-fixture'; }
const cases: Case[] = [
  { name: 'identity-original-only', selected: {}, labels: [] },
  { name: 'extract_vocals', selected: { extract_vocals: true }, labels: ['vocals'] },
  { name: 'extract_instruments', selected: { extract_instruments: true }, labels: ['instruments'] },
  { name: 'mix-drums-bass', selected: { mixes: [MIX('mix-1', ['drums', 'bass'])] }, labels: ['mix-1'] },
  { name: 'mix-drums-vocals', selected: { mixes: [MIX('mix-1', ['drums', 'vocals'])] }, labels: ['mix-1'] },
  { name: 'mix-bass-vocals', selected: { mixes: [MIX('mix-1', ['bass', 'vocals'])] }, labels: ['mix-1'] },
  { name: 'mix-drums-other', selected: { mixes: [MIX('mix-1', ['drums', 'other'])] }, labels: ['mix-1'] },
  { name: 'mix-three-parts', selected: { mixes: [MIX('mix-1', ['drums', 'bass', 'vocals'])] }, labels: ['mix-1'] },
  { name: 'mix-vocal-variant-instruments', selected: { mixes: [MIX('mix-1', ['female', 'instruments'])] }, labels: ['mix-1'] },
  { name: 'mix-custom-name', selected: { mixes: [MIX('mix-1', ['bass', 'vocals'], 'Karaoke night')] }, labels: ['mix-1'] },
  { name: 'mixes-multiple-queued', selected: { mixes: [MIX('mix-1', ['drums', 'bass']), MIX('mix-2', ['drums', 'vocals']), MIX('mix-3', ['bass', 'vocals'])] }, labels: ['mix-1', 'mix-2', 'mix-3'] },
  { name: 'decrowd', selected: { decrowd: true }, labels: ['instruments-decrowded'] },
  { name: 'decrowd_vocals', selected: { decrowd_vocals: true }, labels: ['vocals-decrowded'] },
  { name: 'dereverb', selected: { dereverb: true }, labels: ['vocals-dry'] },
  { name: 'genders', selected: { genders: true }, labels: ['vocals-male', 'vocals-female'] },
  { name: 'lead_backing', selected: { lead_backing: true }, labels: ['lead', 'backing'] },
  { name: 'drums', selected: { drums: true }, labels: ['drums', 'bass', 'other-instruments'] },
  { name: 'all-booleans-enabled', selected: Object.fromEntries(audioBooleanKeys.map(key => [key, true])), labels: allLabels },
  { name: 'all-options-with-transforms', selected: { ...Object.fromEntries(audioBooleanKeys.map(key => [key, true])), pitch_semitones: 1.25, tempo_percent: 125 }, labels: ['song', ...allLabels] },
  { name: 'mixes-hidden-dry-prerequisites', selected: { mixes: [MIX('mix-1', ['vocals', 'bass']), MIX('mix-2', ['drums', 'vocals'])], dereverb: true }, labels: ['mix-1', 'mix-2'] },
  { name: 'instrument-only-dereverb-no-hidden-vocal', selected: { extract_instruments: true, dereverb: true }, labels: ['instruments'] },
  { name: 'positive-fractional-pitch-speedup-no-extraction', selected: { pitch_semitones: 2.5, tempo_percent: 120 }, labels: ['song'] },
  { name: 'pitch-only', selected: { pitch_semitones: 2 }, labels: ['song'] },
  { name: 'tempo-only', selected: { tempo_percent: 80 }, labels: ['song'] },
  { name: 'separated-output-pitch-and-tempo', selected: { extract_instruments: true, pitch_semitones: -2.5, tempo_percent: 125 }, labels: ['song', 'instruments'] },
  { name: 'pitched-full-source-with-selected-stem', selected: { extract_instruments: true, pitch_semitones: -1.25, tempo_percent: 119.5 }, labels: ['song', 'instruments'], fixture: 'tone-fixture' },
  { name: 'tempo-only-selected-stem-without-extra-song', selected: { extract_instruments: true, tempo_percent: 125 }, labels: ['instruments'] },
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

/** Queues mixes through the MixBuilder exactly as a user would. */
async function configureMixes(page: Page, mixes: StemMix[]) {
  for (const mix of mixes) {
    if (mix.components.some(component => VARIANT_COMPONENTS.includes(component))) {
      const details = page.locator('details.vocal-variants');
      if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
    }
    for (const component of mix.components) {
      await page.getByRole('button', { name: `+ ${COMPONENT_LABELS[component]}`, exact: true }).click();
    }
    if (mix.name !== stemMixName(mix.components)) {
      await page.getByLabel('New mix name', { exact: true }).fill(mix.name);
    }
    await page.getByRole('button', { name: 'Add mix', exact: true }).click();
  }
}

async function configure(page: Page, options: SeparationOptions) {
  for (const key of booleanKeys) {
    const checkbox = page.locator(`#option-${key}`);
    if (await checkbox.isChecked() === options[key]) continue;
    await checkbox.setChecked(Boolean(options[key]));
  }
  await configureMixes(page, options.mixes);
  await page.getByLabel('Pitch shift (semitones)', { exact: true }).fill(String(options.pitch_semitones));
  await page.getByLabel('Tempo (% of original)', { exact: true }).fill(String(options.tempo_percent));
}

async function submit(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
  await page.locator('form button[type=submit]').click();
  const res = await response;
  expect(res.status()).toBe(200);
  const submitted = await res.json() as SubmitResult;
  if (submitted.position !== null) expect(submitted.position).toBeGreaterThan(0);
  if (submitted.work_id !== null) return submitted.work_id;
  expect(submitted.status).toBe('done');
  const song = await (await page.request.get(`/api/songs/${submitted.song_id}`)).json() as SongDetail;
  return song.summary.latest_work_id;
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
  await expect(page.getByRole('heading', { name: jobLabel(job!), exact: true })).toBeVisible();
  return job!;
}

function requestedOutput(detail: SongDetail, options: SeparationOptions, label: string): SongOutputRef {
  const variant = detail.variants.find(item => item.pitch_semitones === options.pitch_semitones && item.tempo_percent === options.tempo_percent);
  expect(variant, `missing requested pitch/tempo variant for ${label}`).toBeDefined();
  const mix = options.mixes.find(item => item.id === label);
  const semantic = (stem: string) => {
    if (options.decrowd && ['drums', 'bass', 'other-instruments'].includes(stem)) return `${stem}:decrowded`;
    if (options.decrowd_vocals && ['vocals-male', 'vocals-female', 'lead', 'backing'].includes(stem.replace(/-dry$/, ''))) return `${stem}:decrowded`;
    return stem;
  };
  const identity = mix
    ? `mix:${mix.components.flatMap(component => componentStems(component, options)).map(semantic).sort().join(',')}`
    : semantic(label);
  const output = variant!.outputs.find(item => item.identity === identity);
  expect(output, `missing requested semantic output ${identity}`).toBeDefined();
  return output!;
}

async function referenceMixInputs(page: Page, info: TestInfo, options: SeparationOptions, labels: string[]) {
  // Reference stems may already belong to earlier work on the same song.
  const components = [...new Set(options.mixes.flatMap(mix => mix.components))];
  const needsSplit = (variants: StemComponent[], flag: BooleanOptionKey) =>
    components.some(component => variants.includes(component)) && { [flag]: true };
  const referenceOptions = {
    ...defaults,
    extract_instruments: components.includes('instruments'),
    extract_vocals: components.some(component => component === 'vocals'),
    ...needsSplit(['female', 'male'], 'genders'),
    ...needsSplit(['lead', 'backing'], 'lead_backing'),
    drums: components.some(component => ['drums', 'bass', 'other'].includes(component)),
    dereverb: options.dereverb,
  };
  const referencePage = await page.context().newPage();
  try {
    await referencePage.goto('/');
    await chooseSource(referencePage, 'upload', 'musical-fixture');
    await expect(referencePage.getByText('Original key: C major', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await configure(referencePage, referenceOptions);
    const id = await submit(referencePage);
    const job = await complete(referencePage, id);
    const detail = await (await referencePage.request.get(`/api/songs/${job.song_id}`)).json() as SongDetail;
    const files: Record<string, string> = {};
    for (const label of labels) {
      const output = requestedOutput(detail, referenceOptions, label);
      const response = await referencePage.request.get(`/api/jobs/${output.work_id}/results/${output.label}`);
      expect(response.status()).toBe(200);
      files[label] = info.outputPath(`reference-${output.work_id}-${label}.mp3`);
      await writeFile(files[label], await response.body());
      await inspectAudio(referencePage, files[label], 8);
    }
    return { job, files };
  } finally {
    await referencePage.close();
  }
}

async function prove(page: Page, info: TestInfo, item: Case, job: JobDTO, originalKey: string) {
  const fixtureName = item.fixture ?? (item.labels.some(label => label !== 'song') ? 'musical-fixture' : 'tone-fixture');
  const options = { ...defaults, ...item.selected };
  const detail = await (await page.request.get(`/api/songs/${job.song_id}`)).json() as SongDetail;
  const outputs = item.labels.map(label => ({ label, output: requestedOutput(detail, options, label) }));
  expect(detail.summary.original_work_id).not.toBeNull();
  for (const { output } of outputs) {
    const names = new Set(detail.variants.flatMap(variant =>
      variant.outputs.filter(candidate => candidate.identity === output.identity).map(candidate => candidate.display_name)));
    for (const name of names) {
      const selector = page.getByRole('combobox', { name: `${name} version`, exact: true });
      if (await selector.count()) {
        await selector.selectOption(`${options.pitch_semitones}:${options.tempo_percent}`);
        break;
      }
    }
  }
  const files: Record<string, string> = {};
  const audio: Record<string, unknown> = {};
  const originalWork = await (await page.request.get(`/api/jobs/${detail.summary.original_work_id}`)).json() as JobDTO;
  const original = page.locator(`a[href^='/api/jobs/${detail.summary.original_work_id}/original']`).first();
  const originalDownload = page.waitForEvent('download');
  await original.click();
  const download = await originalDownload;
  files.original = info.outputPath(download.suggestedFilename());
  await download.saveAs(files.original);
  const originalBytes = await readFile(files.original);
  if (originalWork.source_type === 'upload') expect(hash(originalBytes)).toBe(hash(await readFile(resolve(directory, `${fixtureName}.wav`))));
  expect(download.suggestedFilename()).toBe(`${fixtureName} - original.${originalWork.source_type === 'upload' ? 'wav' : 'mp3'}`);
  audio.original = await inspectAudio(page, files.original, 8, fixtureName === 'tone-fixture' ? 261.6256 : undefined);
  const suffix = `${options.pitch_semitones ? ` - pitch${options.pitch_semitones > 0 ? '+' : ''}${options.pitch_semitones}st` : ''}${options.tempo_percent !== 100 ? ` - tempo${options.tempo_percent}pct` : ''}`;
  for (const { label, output: ref } of outputs) {
    const stem = ref.manifest;
    const mix = options.mixes.find(candidate => candidate.id === label);
    expect(stem.filename).toBe(`${stem.label}${suffix}.mp3`);
    if (mix) {
      // Mix downloads carry the custom name plus the stable mix id qualifier;
      // identity is never derived from the user-chosen name.
      expect(stem.download_name).toContain(`${fixtureName} - ${stem.display_name}`);
      expect(stem.download_name).toContain(`[${stem.label}]`);
      expect(stem.download_name).toContain(`source-key-${originalKey.replaceAll(' ', '-')}`);
      if (suffix) expect(stem.download_name).toContain(suffix.trimStart());
    } else {
      expect(stem.download_name).toBe(`${fixtureName} - ${stem.label} - source-key-${originalKey.replaceAll(' ', '-')}${suffix}.mp3`);
    }
    const served = await page.request.get(`/api/jobs/${ref.work_id}/results/${ref.label}`);
    expect(served.status()).toBe(200);
    expect(decodeURIComponent(served.headers()['content-disposition'])).toContain(stem.download_name);
    const stemLinks = page.locator(`a[href='/api/jobs/${ref.work_id}/results/${ref.label}'], a[href^='/api/jobs/${ref.work_id}/results/${ref.label}?']`);
    await expect(stemLinks).toHaveCount(1);
    const card = stemLinks.first().locator('../..');
    if (mix) await expect(card.getByText(ref.display_name, { exact: true })).toBeVisible();
    await expect(card.getByText(`Source key: ${originalKey}`, { exact: true })).toBeVisible();
    if (transposeKey(originalKey, options.pitch_semitones) !== originalKey) {
      await expect(card.getByText(`Source key: ${transposeKey(originalKey, options.pitch_semitones)}`, { exact: true })).toHaveCount(0);
    }
    if (label === 'song') {
      await expect(card.getByText(displayOutputLabel('song', options), { exact: true })).toBeVisible();
      const playback = await card.locator('audio').evaluate(async element => {
        const player = element as HTMLAudioElement;
        player.load();
        await player.play();
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Full-song player did not advance')), 10_000);
          const advanced = () => {
            if (player.currentTime > 0) { clearTimeout(timeout); player.removeEventListener('timeupdate', advanced); resolve(); }
          };
          player.addEventListener('timeupdate', advanced);
          advanced();
        });
        player.pause();
        return { currentTime: player.currentTime, duration: player.duration, error: player.error?.message ?? null };
      });
      expect(playback.currentTime).toBeGreaterThan(0);
      expect(playback.error).toBeNull();
      expect(playback.duration).toBeCloseTo(8 * 100 / options.tempo_percent, 0);
      audio.songPlayback = playback;
    }
    const event = page.waitForEvent('download');
    await stemLinks.first().click();
    const output = await event;
    expect(output.suggestedFilename()).toBe(stem.download_name);
    files[label] = info.outputPath(output.suggestedFilename());
    await output.saveAs(files[label]);
    expect((await readFile(files[label])).length).toBe(stem.size_bytes);
    const metadata = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format_tags=title:stream=codec_name', '-of', 'json', files[label],
    ], { encoding: 'utf8' }));
    expect(metadata.streams[0].codec_name).toBe('mp3');
    expect(metadata.format.tags.title).toBe(stem.download_name.slice(0, -4));
    audio[label] = {
      ...await inspectAudio(page, files[label], 8 * 100 / options.tempo_percent, label === 'song' && fixtureName === 'tone-fixture' ? 261.6256 * 2 ** (options.pitch_semitones / 12) : undefined),
      metadata,
    };
    if (label === 'song') {
      audio.songSourceFidelity = inspectTransformedSource(
        files.song, files.original, options.pitch_semitones, options.tempo_percent,
        info.outputPath('full-source-reference.mp3'),
      );
    }
  }
  const mixes: Record<string, unknown> = {};
  const selectedMixes = options.mixes;
  const requiredInputs = [...new Set(selectedMixes.flatMap(mix => mix.components.flatMap(component => componentStems(component, options))))];
  const reference = selectedMixes.length && requiredInputs.some(label => !files[label])
    ? await referenceMixInputs(page, info, options, requiredInputs)
    : undefined;
  const sourceFiles = reference?.files ?? files;
  for (const mix of selectedMixes) {
    mixes[mix.id] = inspectMix(files[mix.id], mix.components.flatMap(component => componentStems(component, options)).map(label => sourceFiles[label]));
  }
  if (item.name === 'all-booleans-enabled') {
    expect(hash(await readFile(files['vocals-male']))).not.toBe(hash(await readFile(files['vocals-female'])));
    expect(hash(await readFile(files.lead))).not.toBe(hash(await readFile(files.backing)));
    for (const width of [1440, 1920, 2560, 3840, 375, 390, 430]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1100 });
      const geometry = await page.evaluate(() => {
        const links = [...document.querySelectorAll<HTMLAnchorElement>('a[download][href*="/results/"]')];
        return {
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          links: links.map(link => {
            const rect = link.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: link.clientWidth, contentWidth: link.scrollWidth };
          }),
        };
      });
      expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
      expect(geometry.links.length).toBeGreaterThanOrEqual(item.labels.length);
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
    const song = requestedOutput(detail, options, 'song');
    const card = page.locator(`a[href^='/api/jobs/${song.work_id}/results/${song.label}']`).first().locator('../..');
    await card.screenshot({ path: info.outputPath('source-key-pitched-card-2560.png') });
  }
  const proof = { case: item.name, modal_app: process.env.E2E_MODAL_APP_NAME, fixture_seed: process.env.E2E_FIXTURE_SEED, options, expected_labels: item.labels, job, audio, mixes, reference };
  await writeFile(info.outputPath('proof.json'), JSON.stringify(proof, null, 2));
  await info.attach('per-option-proof', { path: info.outputPath('proof.json'), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('completed.png'), fullPage: true });
  console.log(`OPTION_PROOF ${JSON.stringify({ case: item.name, id: job.id, options, labels: item.labels, proof: info.outputPath('proof.json') })}`);
}

for (const item of cases) {
  test(item.name, async ({ page, browser }, info) => {
    const options = { ...defaults, ...item.selected };
    const fixtureName = item.fixture ?? (item.labels.some(label => label !== 'song') ? 'musical-fixture' : 'tone-fixture');
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
    const id = await submit(page);
    const job = await complete(page, id);
    await prove(page, info, item, job, originalKey);
    if (item.name === 'identity-original-only') {
      await page.reload();
      const history = page.getByRole('region', { name: 'History', exact: true });
      const detail = await (await page.request.get(`/api/songs/${job.song_id}`)).json() as SongDetail;
      const historyDateTime = await page.evaluate(createdAt => new Date(createdAt * 1000).toISOString(), detail.summary.created_at);
      const historyCard = history.getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: `Delete ${jobLabel(detail.summary)}`, exact: true }) })
        .filter({ has: page.locator(`time[datetime="${historyDateTime}"]`) });
      await historyCard.getByRole('button', { name: jobLabel(detail.summary), exact: true }).click();
      await expect(page.locator(`a[href^='/api/jobs/${detail.summary.original_work_id}/original']`)).toBeVisible();
    }
    if (item.name === 'identity-original-only' || item.name === 'all-booleans-enabled') {
      const stranger = await browser.newContext();
      await authenticateOutsider(stranger);
      try {
        const isolated = await stranger.newPage();
        await isolated.goto('/');
        await expect(isolated.getByText('No jobs yet.', { exact: true })).toBeVisible();
        expect((await isolated.request.get(`/api/jobs/${id}`)).status()).toBe(404);
        expect((await isolated.request.get(`/api/jobs/${id}/original`)).status()).toBe(404);
        const detail = await (await page.request.get(`/api/songs/${job.song_id}`)).json() as SongDetail;
        expect((await isolated.request.get(`/api/songs/${job.song_id}`)).status()).toBe(404);
        for (const label of item.labels) {
          const output = requestedOutput(detail, options, label);
          expect((await isolated.request.get(`/api/jobs/${output.work_id}/results/${output.label}`)).status()).toBe(404);
        }
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
  const failure = page.locator('.processing-results').getByRole('alert');
  await expect(failure.getByRole('button', { name: 'Retry', exact: true })).toBeVisible({ timeout: 60_000 });
  const failed = await (await page.request.get(`/api/jobs/${failedId}`)).json() as JobDTO;
  expect(failed.status).toBe('failed');
  await page.getByLabel('Track URL', { exact: true }).fill(`${fixtureURL}/tone-fixture.wav`);
  await page.getByLabel('Pitch shift (semitones)', { exact: true }).fill('2.5');
  expect(failed.source_value).not.toBe(`${fixtureURL}/tone-fixture.wav`);
  expect(failed.options.pitch_semitones).not.toBe(2.5);
  await page.getByRole('region', { name: 'History', exact: true }).getByRole('button', { name: jobLabel(failed), exact: true }).click();
  await expect(failure.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  expect((await page.request.post(`${fixtureURL}/recover`)).ok()).toBe(true);
  const response = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${failedId}/retry`));
  await failure.getByRole('button', { name: 'Retry', exact: true }).click();
  const retried = await (await response).json();
  expect(retried.work_id).not.toBe(failedId);
  const job = await complete(page, retried.work_id);
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
  const detail = await (await page.request.get(`/api/songs/${job.song_id}`)).json() as SongDetail;
  const song = requestedOutput(detail, { ...defaults, pitch_semitones: 2 }, 'song');
  expect(song.manifest.filename).toBe('song - pitch+2st.mp3');
  expect(song.manifest.download_name).toBe('silent-fixture - song - pitch+2st.mp3');
  const served = await page.request.get(`/api/jobs/${song.work_id}/results/${song.label}`);
  expect(served.status()).toBe(200);
  expect(decodeURIComponent(served.headers()['content-disposition'])).toContain('silent-fixture - song - pitch+2st.mp3');
  expect(served.headers()['content-disposition']).not.toContain('source-key');
  const resultCard = page.locator(`a[href^='/api/jobs/${song.work_id}/results/${song.label}']`).first().locator('../..');
  await expect(resultCard.getByText(/Source key:/)).toHaveCount(0);
  const event = page.waitForEvent('download');
  await page.locator(`a[href^='/api/jobs/${song.work_id}/results/${song.label}']`).first().click();
  const download = await event;
  expect(download.suggestedFilename()).toBe('silent-fixture - song - pitch+2st.mp3');
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const decoded = pcm(path);
  expect(decoded.length / 96000).toBeCloseTo(8, 1);
  expect(decoded.every(sample => sample === 0)).toBe(true);
  const original = await page.request.get(`/api/jobs/${detail.summary.original_work_id}/original`);
  expect(hash(await original.body())).toBe(hash(await readFile(resolve(directory, 'silent-fixture.wav'))));
  expect(original.headers()['content-disposition']).toContain('silent-fixture%20-%20original.wav');
  await page.reload();
  const history = page.getByRole('region', { name: 'History', exact: true });
  const historyDateTime = await page.evaluate(createdAt => new Date(createdAt * 1000).toISOString(), detail.summary.created_at);
  const historyCard = history.getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: `Delete ${jobLabel(detail.summary)}`, exact: true }) })
    .filter({ has: page.locator(`time[datetime="${historyDateTime}"]`) });
  await historyCard.getByRole('button', { name: jobLabel(detail.summary), exact: true }).click();
  const historyStem = page.locator(`a[href^='/api/jobs/${song.work_id}/results/${song.label}']`);
  await expect(historyStem).toHaveCount(1);
  await expect(historyStem.locator('../..')).not.toContainText('Source key:');
  await expect(historyStem).toHaveAttribute('download', 'silent-fixture - song - pitch+2st.mp3');
  await page.screenshot({ path: info.outputPath('undetermined-source-key.png'), fullPage: true });
});
