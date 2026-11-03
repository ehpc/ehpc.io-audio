import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { hash, inspectAudio } from './audio';

test('downloaded MP3 Title matches its descriptive filename in Results and reloaded History', async ({ page }, info) => {
  const fixture = resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav');
  await page.goto('/');
  await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
  await page.getByLabel('Audio file', { exact: true }).setInputFiles(fixture);
  await expect(page.getByText('Original key: C major', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Pitch shift (semitones)', { exact: true }).fill('2.5');
  await page.getByLabel('Tempo (% of original)', { exact: true }).fill('120');
  await expect(page.getByText('Full song (pitch +2.5 st, tempo 120%)', { exact: true })).toBeVisible();

  const submitted = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
  await page.locator('form button[type=submit]').click();
  const response = await submitted;
  expect(response.status()).toBe(200);
  const { id } = await response.json();
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible({ timeout: 120_000 });
  const result = page.getByRole('heading', { name: 'Results', exact: true }).locator('../..');
  const expectedName = 'tone-fixture - song - source-key-C-major - pitch+2.5st - tempo120pct.mp3';

  const downloadTrack = async (link: Locator, prefix: string) => {
    const pending = page.waitForEvent('download');
    await link.click();
    const download = await pending;
    const path = info.outputPath(`${prefix}-${download.suggestedFilename()}`);
    await download.saveAs(path);
    return { path, filename: download.suggestedFilename(), bytes: await readFile(path) };
  };
  const probe = async (path: string, evidenceName: string) => {
    const json = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format_tags:stream=codec_name', '-of', 'json', path,
    ], { encoding: 'utf8' });
    await writeFile(info.outputPath(evidenceName), json);
    return JSON.parse(json);
  };
  const generated = await downloadTrack(result.locator(`a[href='/api/jobs/${id}/results/song']`), 'results');
  expect(generated.filename).toBe(expectedName);
  const metadata = await probe(generated.path, 'results-ffprobe.json');
  expect(metadata.streams[0].codec_name).toBe('mp3');
  expect(metadata.format.tags.title).toBe(generated.filename.slice(0, -4));
  const audio = await inspectAudio(page, generated.path, 8 / 1.2, 261.6256 * 2 ** (2.5 / 12));
  const original = await downloadTrack(result.locator(`a[href='/api/jobs/${id}/original']`), 'original');
  expect(original.filename).toBe('tone-fixture - original.wav');
  expect(original.bytes.equals(await readFile(fixture))).toBe(true);
  await page.screenshot({ path: info.outputPath('results.png'), fullPage: true });

  await page.reload();
  const history = page.getByRole('heading', { name: 'History', exact: true }).locator('..');
  const historyLink = history.locator(`a[href='/api/jobs/${id}/results/song']`);
  await expect(historyLink).toBeVisible();
  const restored = await downloadTrack(historyLink, 'history');
  expect(restored.filename).toBe(expectedName);
  const historyMetadata = await probe(restored.path, 'history-ffprobe.json');
  expect(historyMetadata.format.tags.title).toBe(restored.filename.slice(0, -4));
  expect(restored.bytes.equals(generated.bytes)).toBe(true);
  const historyOriginal = await downloadTrack(history.locator(`a[href='/api/jobs/${id}/original']`), 'history-original');
  expect(historyOriginal.bytes.equals(original.bytes)).toBe(true);
  await page.screenshot({ path: info.outputPath('history.png'), fullPage: true });
  const proof = {
    id, suggestedFilename: generated.filename, metadata, historyMetadata, audio,
    originalSha256: hash(original.bytes), fixtureSha256: hash(await readFile(fixture)),
    generatedSha256: hash(generated.bytes), historySha256: hash(restored.bytes),
  };
  const proofPath = info.outputPath('metadata-proof.json');
  await writeFile(proofPath, JSON.stringify(proof, null, 2));
  await info.attach('download-metadata-proof', { path: proofPath, contentType: 'application/json' });
});
