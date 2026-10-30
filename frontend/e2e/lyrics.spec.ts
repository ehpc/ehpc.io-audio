import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { JobDTO } from '../src/api';

const directory = process.env.E2E_FIXTURE_DIR!;
const JFK_SHA256 = '63a4b1e4c1dc655ac70961ffbf518acd249df237e5a0152faae9a4a836949715';

async function submitJfk(page: Page, options: { vocals?: boolean; pitch?: number; tempo?: number } = {}) {
  await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
  const path = resolve(directory, 'jfk.flac');
  const input = await readFile(path);
  expect(createHash('sha256').update(input).digest('hex')).toBe(JFK_SHA256);
  const analysisPromise = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
  await page.getByLabel('Audio file', { exact: true }).setInputFiles({ name: 'jfk.flac', mimeType: 'audio/flac', buffer: input });
  expect((await analysisPromise).ok()).toBe(true);
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Extract lyrics', exact: true }).check();
  if (options.vocals) await page.getByRole('checkbox', { name: 'Extract vocals', exact: true }).check();
  if (options.pitch !== undefined) await page.getByLabel('Pitch shift (semitones)', { exact: true }).fill(String(options.pitch));
  if (options.tempo !== undefined) await page.getByLabel('Tempo (% of original)', { exact: true }).fill(String(options.tempo));
  await expect(page.getByRole('button', { name: 'Process audio', exact: true })).toBeVisible();
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
  await page.locator('form button[type=submit]').click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  return (await response.json()).id as number;
}

async function complete(page: Page, id: number): Promise<JobDTO> {
  let job: JobDTO | undefined;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/jobs/${id}`);
    expect(response.ok()).toBe(true);
    const current = await response.json() as JobDTO;
    job = current;
    if (current.status === 'failed') throw new Error(`Lyrics job ${id} failed: ${current.error_message}`);
    return current.status;
  }, { timeout: 24 * 60 * 1000, intervals: [250, 1000, 3000] }).toBe('done');
  return job!;
}

async function assertTranscriptAndDownload(page: Page, job: JobDTO) {
  expect(job.transcript).not.toBeNull();
  expect(job.transcript!.status).toBe('recognized');
  expect(job.transcript!.timestamp_reference).toBe('original');
  const text = job.transcript!.timestamped_text;
  const lower = text.toLowerCase();
  expect(lower).toContain('my fellow americans');
  expect(lower).toContain('your country');
  expect(lower).toContain('do for you');
  expect(text).toMatch(/^\[\d{2}:\d{2}\] /m);
  expect(job.transcript!.sections.length).toBeGreaterThan(0);
  expect(text).toMatch(/^\[(Intro|Verse|Pre-chorus|Chorus|Bridge|Instrumental|Outro|Silence)\]$/m);
  const maxEndS = Math.max(...job.transcript!.segments.map(segment => segment.end_s));
  expect(maxEndS).toBeLessThanOrEqual(11.0);
  if (job.options.tempo_percent === 120) expect(maxEndS).toBeGreaterThan(11 / 1.2);
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  const transcriptResponse = await page.request.get(`/api/jobs/${job.id}/lyrics`);
  expect(transcriptResponse.ok()).toBe(true);
  expect(await transcriptResponse.json()).toEqual(job.transcript);
  await expect(page.getByText('Original audio timestamps', { exact: false }).first()).toBeVisible();
  const url = `/api/jobs/${job.id}/lyrics/download`;
  const response = await page.request.get(url);
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('text/plain; charset=utf-8');
  const body = await response.body();
  expect(body.toString('utf8')).toBe(text);
  const downloadPromise = page.waitForEvent('download');
  await page.locator(`a[href="${url}"]`).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('jfk - lyrics.txt');
  return { filename: download.suggestedFilename(), sha256: createHash('sha256').update(body).digest('hex') };
}
async function assertOriginalBytes(page: Page, id: number, source: Buffer) {
  const response = await page.request.get(`/api/jobs/${id}/original`);
  expect(response.ok()).toBe(true);
  const body = await response.body();
  expect(body).toEqual(source);
  return createHash('sha256').update(body).digest('hex');
}

test('real speech lyrics render and download in Results and History on the original clock', async ({ page }, info: TestInfo) => {
  test.setTimeout(60 * 60 * 1000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const source = await readFile(resolve(directory, 'jfk.flac'));
  const sourceSha256 = createHash('sha256').update(source).digest('hex');

  const lyricsOnlyId = await submitJfk(page);
  const lyricsOnly = await complete(page, lyricsOnlyId);
  const lyricsOnlyOriginalSha256 = await assertOriginalBytes(page, lyricsOnlyId, source);
  expect(lyricsOnly.manifest).toEqual([]);
  expect(lyricsOnly.has_original).toBe(true);
  const lyricsOnlyTxt = await assertTranscriptAndDownload(page, lyricsOnly);
  const transcriptText = lyricsOnly.transcript!.timestamped_text;
  const desktopScreenshot = info.outputPath('lyrics-results-desktop.png');
  await page.screenshot({ path: desktopScreenshot, fullPage: true });
  await info.attach('lyrics-results-desktop', { path: desktopScreenshot, contentType: 'image/png' });
  const transcriptScreenshot = info.outputPath('lyrics-transcript-desktop.png');
  await page.getByLabel('Lyrics transcript').first().screenshot({ path: transcriptScreenshot });

  const transformedId = await submitJfk(page, { vocals: true, pitch: 2, tempo: 120 });
  const transformed = await complete(page, transformedId);
  const transformedOriginalSha256 = await assertOriginalBytes(page, transformedId, source);
  expect(transformed.manifest?.map(stem => stem.label)).toEqual(['song', 'vocals']);
  expect(transformed.transcript?.timestamp_reference).toBe('original');
  const transformedTxt = await assertTranscriptAndDownload(page, transformed);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileScreenshot = info.outputPath('lyrics-results-mobile.png');
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  await info.attach('lyrics-results-mobile', { path: mobileScreenshot, contentType: 'image/png' });
  const resultTranscript = page.getByLabel('Lyrics transcript').first();
  const resultDownload = resultTranscript.getByRole('link', { name: 'Download timestamped TXT' });
  expect((await resultDownload.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await resultTranscript.locator('pre').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.reload();
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'History', exact: true }) });
  const historyTranscripts = history.getByLabel('Lyrics transcript');
  await expect(historyTranscripts).toHaveCount(2);
  await expect(history.getByText(/my fellow americans/i)).toHaveCount(2);
  const lyricsOnlyHistoryTranscript = historyTranscripts.nth(1);
  await lyricsOnlyHistoryTranscript.getByText('View lyrics', { exact: true }).click();
  await expect(lyricsOnlyHistoryTranscript.getByText(/my fellow americans/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /^Download jfk - vocals/ })).toBeVisible();
  const lyricsOnlyHistoryLink = history.locator(`a[href="/api/jobs/${lyricsOnlyId}/lyrics/download"]`);
  await expect(lyricsOnlyHistoryLink).toHaveCount(1);
  const historyDownloadPromise = page.waitForEvent('download');
  await lyricsOnlyHistoryLink.click();
  const historyDownload = await historyDownloadPromise;
  expect(historyDownload.suggestedFilename()).toBe('jfk - lyrics.txt');
  const historyDownloadPath = await historyDownload.path();
  expect(historyDownloadPath).not.toBeNull();
  const historyDownloadBytes = await readFile(historyDownloadPath!);
  expect(historyDownloadBytes.toString('utf8')).toBe(transcriptText);
  const proofPath = info.outputPath('lyrics-proof.json');
  await writeFile(proofPath, JSON.stringify({
    fixture: { filename: 'jfk.flac', sha256: JFK_SHA256 },
    source_sha256: sourceSha256,
    jobs: [
      {
        purpose: 'lyrics-only',
        id: lyricsOnly.id,
        audio_manifest: lyricsOnly.manifest?.map(stem => stem.label),
        original_download_sha256: lyricsOnlyOriginalSha256,
        txt_download: lyricsOnlyTxt,
        transcript: lyricsOnly.transcript,
      },
      {
        purpose: 'lyrics-with-vocals-and-audio-transform',
        id: transformed.id,
        options: { pitch_semitones: transformed.options.pitch_semitones, tempo_percent: transformed.options.tempo_percent },
        audio_manifest: transformed.manifest?.map(stem => stem.label),
        original_download_sha256: transformedOriginalSha256,
        txt_download: transformedTxt,
        transcript: transformed.transcript,
      },
    ],
    history_txt_download: {
      filename: historyDownload.suggestedFilename(),
      sha256: createHash('sha256').update(historyDownloadBytes).digest('hex'),
    },
  }, null, 2), 'utf8');
  await info.attach('lyrics-proof', { path: proofPath, contentType: 'application/json' });
  await expect(page.getByRole('link', { name: /^Download jfk - vocals/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
});
