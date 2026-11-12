import { devices, expect, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { test } from './auth-fixture';

const seedCompletedTrack = String.raw`
import json, sys, wave
from backend import config, db
session_id, title = sys.argv[1:3]
manifest = [
    {"label": f"stem-{i}", "filename": f"stem-{i}.mp3", "download_name": f"Track stem-{i}.mp3", "display_name": f"stem-{i}", "size_bytes": 1, "duration_s": 1}
    for i in range(1, 7)
]
transcript = {
    "segments": [{"start_s": 1, "end_s": 2, "text": "Visible fixture lyric"}],
    "language": "en", "timestamp_reference": "original", "sections": [], "structure_model": None,
    "words": [], "reference": None, "asr_model": None, "word_alignment": None,
    "recognition_chunks": [{
        "input_start_s": 0, "input_end_s": 3, "ownership_start_s": 0, "ownership_end_s": 3,
        "text": "Raw recognition diagnostic", "language": "English",
    }],
    "untimed": [], "asr_extras": [], "canonical_word_positions": [],
}
with db._session() as connection:
    cursor = connection.execute(
        "INSERT INTO jobs (session_id,status,source_type,source_value,title,options_json,result_manifest_json,transcript_json,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (session_id, "done", "upload", "fixture.wav", title, json.dumps({"extract_lyrics": True}), json.dumps(manifest), json.dumps(transcript), 1767268800, 1767268801),
    )
    job_id = cursor.lastrowid
print(job_id, flush=True)
upload_dir = config.UPLOADS_DIR / str(job_id)
upload_dir.mkdir(parents=True)
with wave.open(str(upload_dir / "fixture.wav"), "wb") as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(8000)
    audio.writeframes(bytes(1600))
result_dir = config.RESULTS_DIR / str(job_id)
result_dir.mkdir(parents=True)
for entry in manifest:
    (result_dir / entry["filename"]).write_bytes(b"isolated-output-fixture")
`;

for (const viewport of [
  { name: 'desktop', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
  { name: 'iphone', ...devices['iPhone 13'] },
]) {
  test(`workspace gap and delete confirmation (${viewport.name})`, async ({ browser, context, page }, info) => {
    const createdJobIds: number[] = [];
    let browserContext: BrowserContext | undefined;
    const runTest = async () => {
      const identity = await (await page.request.get('/api/auth/me')).json() as { id: string };
      const cancelledTitle = `Cancelled UI fixture ${viewport.name}`;
      const confirmedTitle = `Confirmed UI fixture ${viewport.name}`;
      const seedJob = (title: string): number => {
        let output: string;
        try {
          output = execFileSync('uv', ['run', 'python', '-c', seedCompletedTrack, identity.id, title], {
            cwd: process.env.E2E_REPO_ROOT!,
            env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
            encoding: 'utf8',
          });
        } catch (error) {
          let partialOutput = '';
          if (error && typeof error === 'object' && 'stdout' in error) {
            const stdout = error.stdout;
            if (typeof stdout === 'string' || Buffer.isBuffer(stdout)) partialOutput = stdout.toString().trim();
          }
          const partialId = Number(partialOutput);
          if (Number.isSafeInteger(partialId) && partialId > 0) createdJobIds.push(partialId);
          throw error;
        }
        const jobId = Number(output.trim());
        expect(Number.isSafeInteger(jobId) && jobId > 0).toBe(true);
        createdJobIds.push(jobId);
        return jobId;
      };
      const cancelledId = seedJob(cancelledTitle);
      const confirmedId = seedJob(confirmedTitle);

    const testContext = await browser.newContext({
      ...viewport,
      baseURL: process.env.E2E_BASE_URL,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    browserContext = testContext;
    await testContext.addCookies(await context.cookies());
    const mobilePage = await testContext.newPage();
    await mobilePage.goto('/');
    await expect(mobilePage.getByText(cancelledTitle, { exact: true }).last()).toBeVisible();
    await expect(mobilePage.getByText(confirmedTitle, { exact: true }).last()).toBeVisible();
    await expect(mobilePage.getByText('6 audio outputs').first()).toBeVisible();
    const historyRegion = mobilePage.locator('section').filter({ has: mobilePage.getByRole('heading', { name: 'History', exact: true }) });
    await expect(historyRegion.getByRole('link', { name: /Download/ })).toHaveCount(0);
    await expect(mobilePage.locator('.processing-results a[href*="/results/"][download]')).toHaveCount(6);
    await expect(mobilePage.locator('.processing-results').getByRole('link', { name: 'Download original' })).toBeVisible();
    await expect(mobilePage.locator('.processing-results').getByRole('link', { name: 'Download timestamped TXT' })).toBeVisible();

    const form = mobilePage.locator('.audio-workspace');
    const processing = mobilePage.locator('.processing-results');
    await expect(processing).toBeVisible();
    const gap = await mobilePage.evaluate(() => {
      const formBox = document.querySelector('.audio-workspace')!.getBoundingClientRect();
      const processingBox = document.querySelector('.processing-results')!.getBoundingClientRect();
      return processingBox.top - formBox.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(viewport.name === 'desktop' ? 32 : 24);
    expect(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await form.screenshot({ path: info.outputPath(`workspace-${viewport.name}.png`), animations: 'disabled' });
    await processing.screenshot({ path: info.outputPath(`processing-${viewport.name}.png`), animations: 'disabled' });

    expect((await mobilePage.request.get(`/api/jobs/${cancelledId}/original`)).status()).toBe(200);
    expect((await mobilePage.request.get(`/api/jobs/${cancelledId}/results/stem-1`)).status()).toBe(200);
    await mobilePage.getByRole('button', { name: `Delete ${cancelledTitle}` }).click();
    const dialog = mobilePage.getByRole('alertdialog');
    await expect(dialog).toContainText("permanently deletes this track's history, original audio, saved outputs");
    await expect(dialog).toContainText('Shared reusable processing cache is not deleted.');
    await dialog.screenshot({ path: info.outputPath(`delete-confirmation-${viewport.name}.png`), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(mobilePage.getByText(cancelledTitle, { exact: true }).last()).toBeVisible();
    expect((await mobilePage.request.get(`/api/jobs/${cancelledId}/original`)).status()).toBe(200);
    expect((await mobilePage.request.get(`/api/jobs/${cancelledId}/results/stem-1`)).status()).toBe(200);

    await mobilePage.getByRole('button', { name: 'View results' }).first().click();
    await expect(mobilePage.getByLabel('Timestamped lyrics')).toContainText('Visible fixture lyric');
    const summary = mobilePage.getByText('Online alignment and raw recognition details');
    await summary.focus();
    await mobilePage.keyboard.press('Space');
    const rawRecognition = mobilePage.getByText('Raw independent recognition (input windows, not lyric timestamps)');
    await expect(rawRecognition).toBeVisible();
    await rawRecognition.click();
    await expect(mobilePage.getByText('Raw recognition diagnostic')).toBeVisible();
    await mobilePage.getByRole('button', { name: `Delete ${confirmedTitle}` }).click();
    const deleteResponsePromise = mobilePage.waitForResponse(response =>
      response.request().method() === 'DELETE' && response.url().endsWith(`/api/jobs/${confirmedId}`));
    await mobilePage.getByRole('alertdialog').getByRole('button', { name: 'Delete track' }).click();
    const deleteStatus = (await deleteResponsePromise).status();
    expect(deleteStatus).toBe(204);
    await expect(mobilePage.getByText(confirmedTitle)).toHaveCount(0);
    await expect(mobilePage.getByRole('heading', { name: 'Results' })).toHaveCount(0);
    expect((await mobilePage.request.get(`/api/jobs/${confirmedId}/original`)).status()).toBe(404);
    for (let output = 1; output <= 6; output++) {
      expect((await mobilePage.request.get(`/api/jobs/${confirmedId}/results/stem-${output}`)).status()).toBe(404);
    }
    await expect.poll(async () => (await (await mobilePage.request.get('/api/jobs')).json() as { title: string }[])
      .some(job => job.title === confirmedTitle)).toBe(false);
    await expect.poll(async () => (await (await mobilePage.request.get('/api/jobs')).json() as { title: string }[])
      .some(job => job.title === cancelledTitle)).toBe(true);
    await writeFile(info.outputPath(`smoke-${viewport.name}.json`), JSON.stringify({
      viewport: viewport.name,
      processing_gap_px: gap,
      compact_history_download_links: 0,
      full_result_output_downloads: 6,
      full_result_original_download: true,
      full_result_timestamped_lyrics_download: true,
      cancelled_job_original_status: 200,
      cancelled_job_result_status: 200,
      delete_status: deleteStatus,
      deleted_job_original_status: 404,
      deleted_job_result_statuses: [404, 404, 404, 404, 404, 404],
      raw_recognition_opened_by_keyboard_space: true,
      selected_results_cleared_after_delete: true,
    }, null, 2));
    };
    try {
      await runTest();
    } finally {
      try {
        await browserContext?.close();
      } finally {
        const cleanupResponses = await Promise.all(createdJobIds.map(id => page.request.delete(`/api/jobs/${id}`, {
          headers: { Origin: process.env.E2E_BASE_URL! },
        })));
        for (const response of cleanupResponses) expect([204, 404]).toContain(response.status());
      }
    }
  });
}
