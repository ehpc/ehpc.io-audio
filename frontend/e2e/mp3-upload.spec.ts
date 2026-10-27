import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Request } from '@playwright/test';
import { hash } from './audio';

const providers = [
  { name: 'mpeg', mimeType: 'audio/mpeg' },
  { name: 'generic', mimeType: 'application/octet-stream' },
  { name: 'untyped', mimeType: '' },
];

for (const mobile of [false, true]) {
  for (const provider of providers) {
    test(`native MP3 upload completes with ${provider.name} MIME on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }, info) => {
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
      const fixture = info.outputPath('native-upload.MP3');
      execFileSync('ffmpeg', [
        '-nostdin', '-v', 'error', '-i', resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'),
        '-c:a', 'libmp3lame', '-q:a', '2', fixture,
      ]);
      const bytes = await readFile(fixture);
      const probe = JSON.parse(execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'stream=codec_name,channels:format=duration', '-of', 'json', fixture,
      ], { encoding: 'utf8' }));
      expect(probe.streams[0].codec_name).toBe('mp3');
      expect(probe.streams[0].channels).toBe(2);
      const posts: string[] = [];
      const errors: string[] = [];
      page.on('request', request => {
        if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
      });
      page.on('pageerror', error => errors.push(error.message));
      const proof: Record<string, unknown> = {
        provider, mobile, probe, fixtureSha256: hash(bytes), stage: 'selection',
        selectionMethod: provider.mimeType ? 'Chromium filechooser' : 'File/DataTransfer change (empty-MIME provider simulation)',
        limitation: 'Chromium filechooser.setFiles exercises selection/change and native multipart, not a physical OS/cloud-provider picker filter or Safari.',
      };
      const multipart = (request: Request) => {
        const contentType = request.headers()['content-type'];
        expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
        // Chromium's protocol omits file bodies from postDataBuffer. Verify
        // transport bytes using the server's original download instead.
        return { contentType };
      };
      try {
        await page.goto('/');
        await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
        const analysisPending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/key-analysis' && response.request().method() === 'POST');
        if (provider.mimeType) {
          const chooserPending = page.waitForEvent('filechooser');
          await page.getByLabel('Audio file', { exact: true }).click();
          const chooser = await chooserPending;
          expect(chooser.isMultiple()).toBe(false);
          await chooser.setFiles({ name: 'native-upload.MP3', mimeType: provider.mimeType, buffer: bytes });
        } else {
          // Playwright infers audio/mpeg when setFiles receives an empty MIME.
          // Use a real browser File to exercise an actually empty provider type.
          await page.getByLabel('Audio file', { exact: true }).evaluate((input: HTMLInputElement, data) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([new Uint8Array(data)], 'native-upload.MP3'));
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }, Array.from(bytes));
        }
        const selected = await page.getByLabel('Audio file', { exact: true }).evaluate((input: HTMLInputElement) => {
          const file = input.files![0];
          return { name: file.name, type: file.type, size: file.size };
        });
        expect(selected).toEqual({ name: 'native-upload.MP3', type: provider.mimeType, size: bytes.length });
        proof.selected = selected;
        await expect(page.getByText('Selected: native-upload.MP3', { exact: true })).toBeVisible();
        const analysis = await analysisPending;
        proof.analysis = { status: analysis.status(), response: await analysis.json(), multipart: multipart(analysis.request()) };
        expect(analysis.status()).toBe(200);
        if (mobile) await page.getByRole('tab', { name: 'Adjust', exact: true }).click();
        await expect(page.getByText('Original key: C major', { exact: true })).toBeVisible({ timeout: 60_000 });
        await expect(page.getByRole('alert')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath('selected-mp3.png'), fullPage: true });
        proof.stage = 'submission';
        const submitted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/jobs' && response.request().method() === 'POST');
        await page.locator('form button[type=submit]').click();
        const response = await submitted;
        const result = await response.json();
        proof.submission = { status: response.status(), response: result, multipart: multipart(response.request()) };
        expect(response.status()).toBe(200);
        const { id } = result;
        await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible({ timeout: 60_000 });
        const jobResponse = await page.request.get(`/api/jobs/${id}`);
        expect(jobResponse.ok()).toBe(true);
        const job = await jobResponse.json();
        expect(job.status).toBe('done');
        expect(job.source_type).toBe('upload');
        expect(job.source_value).toBe('native-upload.MP3');
        expect(job.original_key).toBe('C major');
        expect(job.manifest).toEqual([]);
        const downloadOriginal = async () => {
          const pending = page.waitForEvent('download');
          await page.locator(`a[href='/api/jobs/${id}/original']`).first().click();
          const download = await pending;
          const target = info.outputPath(`original-${proof.stage}.MP3`);
          await download.saveAs(target);
          expect((await readFile(target)).equals(bytes)).toBe(true);
          return { suggestedFilename: download.suggestedFilename(), sha256: hash(await readFile(target)) };
        };
        proof.job = job;
        proof.original = await downloadOriginal();
        await page.screenshot({ path: info.outputPath('mp3-results.png'), fullPage: true });
        proof.stage = 'history';
        await page.reload();
        await expect(page.locator(`a[href='/api/jobs/${id}/original']`).first()).toBeVisible();
        proof.historyOriginal = await downloadOriginal();
        await expect(page.getByRole('alert')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath('mp3-history.png'), fullPage: true });
        expect(posts).toEqual(['/api/key-analysis', '/api/jobs']);
        expect(errors).toEqual([]);
        proof.stage = 'complete';
      } catch (error) {
        proof.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        proof.posts = posts;
        proof.browserErrors = errors;
        const path = info.outputPath('mp3-upload-proof.json');
        await writeFile(path, JSON.stringify(proof, null, 2));
        await info.attach('native-mp3-upload-proof', { path, contentType: 'application/json' });
      }
    });
  }
}
