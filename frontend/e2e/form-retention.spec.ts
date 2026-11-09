import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { authenticateOutsider, test } from './auth-fixture';
import type { JobDTO } from '../src/api';
import { transposeKey } from '../src/lib/music';
import { hash, pcm } from './audio';
const fixtureURL = process.env.E2E_FIXTURE_URL!;
const fixturePath = resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav');

async function formState(page: Page) {
  return page.locator('form').evaluate(form => ({
    inputs: [...form.querySelectorAll('input')].map(input => ({
      id: input.id, value: input.value, checked: input.checked,
      files: input.files ? [...input.files].map(file => ({ name: file.name, size: file.size, type: file.type, lastModified: file.lastModified })) : null,
    })),
    source: [...form.querySelectorAll('.source-tabs button')].map(button => ({ text: button.textContent, pressed: button.getAttribute('aria-pressed') })),
    keys: form.querySelector('.workspace-keys')!.textContent,
    preview: form.querySelector('.review-page')!.textContent,
    tab: form.getAttribute('data-active-tab'),
  }));
}

async function submit(page: Page) {
  const responsePending = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
  await page.locator('form button[type=submit]').click();
  const response = await responsePending;
  expect(response.status()).toBe(200);
  await expect(page.locator('form button[type=submit]')).toBeEnabled();
  return (await response.json()).id as number;
}

async function complete(page: Page, id: number) {
  let job: JobDTO | undefined;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/jobs/${id}`);
    expect(response.ok()).toBe(true);
    job = await response.json() as JobDTO;
    if (job.status === 'failed') throw new Error(`Job ${id} failed: ${job.error_message}`);
    return job.status;
  }, { timeout: 60_000, intervals: [100, 500, 1000] }).toBe('done');
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
  return job!;
}

async function originalProof(page: Page, id: number, uploaded?: Buffer) {
  const response = await page.request.get(`/api/jobs/${id}/original`);
  expect(response.ok()).toBe(true);
  const actual = await response.body();
  // URL downloads intentionally become MP3; compare consecutive HTTP originals.
  // Uploads must retain the input bytes verbatim.
  if (uploaded) expect(hash(actual)).toBe(hash(uploaded));
  return { sha256: hash(actual) };
}

interface OutputProof {
  rawSha256: string;
  audioEssenceSha256: string;
  byteLength: number;
  title: string;
}

async function outputProof(page: Page, id: number, label: string, filePath: string): Promise<OutputProof> {
  const response = await page.request.get(`/api/jobs/${id}/results/${label}`);
  expect(response.status()).toBe(200);
  const audio = await response.body();
  expect(audio.byteLength).toBeGreaterThan(0);
  await writeFile(filePath, audio);
  const decoded = pcm(filePath);
  const audioEssenceSha256 = hash(new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength));
  const title = execFileSync('uv', [
    'run', 'python', '-c',
    "from io import BytesIO; import sys; from mutagen.id3 import ID3; print(ID3(BytesIO(sys.stdin.buffer.read()))['TIT2'].text[0])",
  ], { cwd: process.env.E2E_REPO_ROOT!, input: audio, encoding: 'utf8' }).trim();
  return { rawSha256: hash(audio), audioEssenceSha256, byteLength: audio.byteLength, title };
}

for (const scenario of ['desktop-url', 'mobile-upload'] as const) {
  test(`retains ${scenario} form across same-source renamed-mix submissions`, async ({ page, browser }, info) => {
    const mobile = scenario === 'mobile-upload';
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const fixture = await readFile(fixturePath);
    await page.goto('/');
    const keyResponse = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
    if (mobile) {
      await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
      await page.getByLabel('Audio file', { exact: true }).setInputFiles({ name: 'tone-fixture.wav', mimeType: 'audio/wav', buffer: fixture });
    } else {
      await page.getByLabel('Track URL', { exact: true }).fill(`${fixtureURL}/tone-fixture.wav`);
    }
    const analysis = await keyResponse;
    expect(analysis.status()).toBe(200);
    expect((await analysis.json()).original_key).toBe('C major');

    await page.getByRole('button', { name: '+ Drums', exact: true }).click();
    await page.getByRole('button', { name: '+ Vocals', exact: true }).click();
    await page.getByLabel('New mix name', { exact: true }).fill('Karaoke A');
    await page.getByRole('button', { name: 'Add mix', exact: true }).click();
    await expect(page.getByTestId('mix-item')).toHaveAttribute('data-mix-name', 'Karaoke A');
    if (mobile) await page.getByRole('tab', { name: 'Adjust', exact: true }).click();
    await page.getByLabel('Pitch shift (semitones)', { exact: true }).fill('-1.25');
    await page.getByLabel('Tempo (% of original)', { exact: true }).fill('119.5');
    await expect(page.locator('form').getByText('Original key: C major', { exact: true })).toBeVisible();
    await expect(page.locator('form').getByText(`Target key: ${transposeKey('C major', -1.25)}`, { exact: true })).toBeVisible();
    if (mobile) await page.getByRole('tab', { name: 'Review', exact: true }).click();
    const initialForm = await formState(page);
    expect(initialForm.inputs.find(input => input.id === 'pitch-input')!.value).toBe('-1.25');
    expect(initialForm.inputs.find(input => input.id === 'tempo-input')!.value).toBe('119.5');
    if (mobile) {
      const files = initialForm.inputs.find(input => input.id === 'file-input')!.files!;
      expect(files).toHaveLength(1);
      expect(files[0]).toEqual(expect.objectContaining({ name: 'tone-fixture.wav', size: fixture.length }));
    } else {
      await expect(page.getByLabel('Track URL', { exact: true })).toHaveValue(`${fixtureURL}/tone-fixture.wav`);
    }

    const proofs: Array<{
      id: number;
      mixName: string;
      options: JobDTO["options"];
      source: string;
      original: { sha256: string };
      outputs: { song: OutputProof; mix: OutputProof };
      songDownloadName: string;
      mixDownloadName: string;
      beforeSubmit: typeof initialForm;
      afterPost: typeof initialForm;
      afterDone: typeof initialForm;
    }> = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const mixName = attempt === 0 ? 'Karaoke A' : 'Karaoke B';
      if (attempt === 1) {
        if (mobile) await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
        await page.getByRole('button', { name: 'Edit Karaoke A', exact: true }).click();
        await page.getByLabel('Mix name for Karaoke A', { exact: true }).fill(mixName);
        await page.getByRole('button', { name: 'Save mix', exact: true }).click();
        if (mobile) await page.getByRole('tab', { name: 'Review', exact: true }).click();
      }
      const beforeSubmit = await formState(page);
      const id = await submit(page);
      const afterPost = await formState(page);
      expect(afterPost).toEqual(beforeSubmit);
      const job = await complete(page, id);
      const resultSong = page.locator(`a[href='/api/jobs/${id}/results/song']`).first().locator('../..');
      const resultMix = page.locator(`a[href='/api/jobs/${id}/results/mix-1']`).first().locator('../..');
      await expect(resultSong.getByText('Full song (pitch -1.25 st, tempo 119.5%)', { exact: true })).toBeVisible();
      await expect(resultMix.getByText(`${mixName} (pitch -1.25 st, tempo 119.5%)`, { exact: true })).toBeVisible();
      const history = page.getByRole('heading', { name: 'History', exact: true }).locator('..');
      const songHistoryName = new RegExp('^' + 'Full song (pitch -1.25 st, tempo 119.5%)'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*Source key: C major$');
      const mixHistoryName = new RegExp('^' + `${mixName} (pitch -1.25 st, tempo 119.5%)`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*Source key: C major$');
      await expect(history.locator(`a[href='/api/jobs/${id}/results/song']`)).toHaveAccessibleName(songHistoryName);
      await expect(history.locator(`a[href='/api/jobs/${id}/results/mix-1']`)).toHaveAccessibleName(mixHistoryName);
      await expect(history.locator(`a[href='/api/jobs/${id}/results/song']`)).toBeVisible();
      await expect(history.locator(`a[href='/api/jobs/${id}/results/mix-1']`)).toBeVisible();
      const afterDone = await formState(page);
      expect(afterDone).toEqual(beforeSubmit);
      expect(job.options.pitch_semitones).toBe(-1.25);
      expect(job.options.tempo_percent).toBe(119.5);
      expect(job.options.mixes).toEqual([{ id: 'mix-1', name: mixName, components: ['drums', 'vocals'] }]);
      expect(job.manifest?.map(stem => stem.label)).toEqual(['song', 'mix-1']);
      const song = job.manifest?.find(stem => stem.label === 'song');
      expect(song?.display_name).toBe('song');
      const mix = job.manifest?.find(stem => stem.label === 'mix-1');
      expect(mix?.display_name).toBe(mixName);
      expect(mix?.download_name).toContain(`${mixName} [mix-1]`);
      expect(job.source_type).toBe(mobile ? 'upload' : 'url');
      expect(job.source_value).toBe(mobile ? 'tone-fixture.wav' : `${fixtureURL}/tone-fixture.wav`);
      const original = await originalProof(page, id, mobile ? fixture : undefined);
      const songDownloadName = song!.download_name;
      const mixDownloadName = mix!.download_name;
      const outputs = {
        song: await outputProof(page, id, 'song', info.outputPath(`${scenario}-${id}-song.mp3`)),
        mix: await outputProof(page, id, 'mix-1', info.outputPath(`${scenario}-${id}-mix.mp3`)),
      };
      expect(outputs.song.title).toBe(songDownloadName.replace(/\.mp3$/, ''));
      expect(outputs.mix.title).toBe(mixDownloadName.replace(/\.mp3$/, ''));
      if (proofs.length) {
        expect(outputs.song.rawSha256).toBe(proofs[0]!.outputs.song.rawSha256);
        expect(outputs.mix.audioEssenceSha256).toBe(proofs[0]!.outputs.mix.audioEssenceSha256);
        expect(outputs.mix.rawSha256).not.toBe(proofs[0]!.outputs.mix.rawSha256);
        expect(outputs.mix.title).not.toBe(proofs[0]!.outputs.mix.title);
        expect(original.sha256).toBe(proofs[0]!.original.sha256);
      }
      proofs.push({ id, mixName, options: job.options, source: job.source_value, original, outputs, songDownloadName, mixDownloadName, beforeSubmit, afterPost, afterDone });
      await page.screenshot({ path: info.outputPath(`${scenario}-${attempt + 1}-done.png`), fullPage: false });
    }
    expect(proofs[0]!.id).not.toBe(proofs[1]!.id);
    const firstJobResponse = await page.request.get(`/api/jobs/${proofs[0]!.id}`);
    const secondJobResponse = await page.request.get(`/api/jobs/${proofs[1]!.id}`);
    expect(firstJobResponse.ok()).toBe(true);
    expect(secondJobResponse.ok()).toBe(true);
    const firstJob = await firstJobResponse.json() as JobDTO;
    const secondJob = await secondJobResponse.json() as JobDTO;
    const firstMix = firstJob.manifest?.find(stem => stem.label === 'mix-1');
    const secondMix = secondJob.manifest?.find(stem => stem.label === 'mix-1');
    expect(firstMix?.display_name).toBe(proofs[0]!.mixName);
    expect(firstMix?.download_name).toBe(proofs[0]!.mixDownloadName);
    expect(secondMix?.display_name).toBe(proofs[1]!.mixName);
    expect(secondMix?.download_name).toBe(proofs[1]!.mixDownloadName);
    const retainedFirstAudio = await outputProof(page, proofs[0]!.id, 'mix-1', info.outputPath(`${scenario}-retained-A.mp3`));
    expect(retainedFirstAudio.title).toBe(proofs[0]!.mixDownloadName.replace(/\.mp3$/, ''));
    expect(retainedFirstAudio.title).not.toBe(proofs[1]!.outputs.mix.title);
    expect(retainedFirstAudio.rawSha256).toBe(proofs[0]!.outputs.mix.rawSha256);
    expect(retainedFirstAudio.audioEssenceSha256).toBe(proofs[0]!.outputs.mix.audioEssenceSha256);
    const foreign = await browser.newContext();
    await authenticateOutsider(foreign);
    try {
      const outsider = await foreign.newPage();
      await outsider.goto('/');
      expect((await outsider.request.get(`/api/jobs/${proofs[0]!.id}`)).status()).toBe(404);
      expect((await outsider.request.get(`/api/jobs/${proofs[0]!.id}/results/mix-1`)).status()).toBe(404);
    } finally {
      await foreign.close();
    }
    await writeFile(info.outputPath(`${scenario}-proof.json`), JSON.stringify({ scenario, submissions: proofs, sameSourceSameComponents: true, distinctSessionCannotAccess: true }, null, 2));
  });
}
