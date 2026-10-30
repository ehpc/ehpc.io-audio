import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { JobDTO } from '../src/api';
import { transposeKey } from '../src/lib/music';
import { hash } from './audio';

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

for (const scenario of ['desktop-url', 'mobile-upload'] as const) {
  test(`retains ${scenario} form for a completed repeat submission`, async ({ page }, info) => {
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
    await page.getByText('Advanced · cache', { exact: true }).click();
    await page.locator('#option-no_cache').check();
    if (mobile) await page.getByRole('tab', { name: 'Adjust', exact: true }).click();
    await page.getByLabel('Pitch shift (semitones)', { exact: true }).fill('-1.25');
    await page.getByLabel('Tempo (% of original)', { exact: true }).fill('119.5');
    await expect(page.locator('form').getByText('Original key: C major', { exact: true })).toBeVisible();
    await expect(page.locator('form').getByText(`Target key: ${transposeKey('C major', -1.25)}`, { exact: true })).toBeVisible();
    if (mobile) await page.getByRole('tab', { name: 'Review', exact: true }).click();
    const beforeSubmit = await formState(page);
    expect(beforeSubmit.inputs.find(input => input.id === 'pitch-input')!.value).toBe('-1.25');
    expect(beforeSubmit.inputs.find(input => input.id === 'tempo-input')!.value).toBe('119.5');
    expect(beforeSubmit.inputs.find(input => input.id === 'option-no_cache')!.checked).toBe(true);
    if (mobile) {
      const files = beforeSubmit.inputs.find(input => input.id === 'file-input')!.files!;
      expect(files).toHaveLength(1);
      expect(files[0]).toEqual(expect.objectContaining({ name: 'tone-fixture.wav', size: fixture.length }));
    } else {
      await expect(page.getByLabel('Track URL', { exact: true })).toHaveValue(`${fixtureURL}/tone-fixture.wav`);
    }

    const proofs = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      // No refill, reselect, or settings change between these real submissions.
      const id = await submit(page);
      const afterPost = await formState(page);
      expect(afterPost).toEqual(beforeSubmit);
      const job = await complete(page, id);
      const afterDone = await formState(page);
      expect(afterDone).toEqual(beforeSubmit);
      expect(job.options.no_cache).toBe(true);
      expect(job.options.pitch_semitones).toBe(-1.25);
      expect(job.options.tempo_percent).toBe(119.5);
      for (const [key, value] of Object.entries(job.options)) {
        if (typeof value === 'boolean' && key !== 'no_cache') expect(value, key).toBe(false);
      }
      expect(job.manifest?.map(stem => stem.label)).toEqual(['song']);
      expect(job.source_type).toBe(mobile ? 'upload' : 'url');
      expect(job.source_value).toBe(mobile ? 'tone-fixture.wav' : `${fixtureURL}/tone-fixture.wav`);
      const original = await originalProof(page, id, mobile ? fixture : undefined);
      if (proofs.length) expect(original.sha256).toBe(proofs[0]!.original.sha256);
      proofs.push({ id, options: job.options, source: job.source_value, original, afterPost, afterDone });
      await page.screenshot({ path: info.outputPath(`${scenario}-${attempt + 1}-done.png`), fullPage: false });
    }
    expect(proofs[0]!.id).not.toBe(proofs[1]!.id);
    await writeFile(info.outputPath(`${scenario}-proof.json`), JSON.stringify({ scenario, beforeSubmit, submissions: proofs, repeatWithoutRefillOrReselect: true }, null, 2));
  });
}
