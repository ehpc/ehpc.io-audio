import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const source = 'https://music.youtube.com/watch?v=wf5RdLDxrUk&si=ANzOjMlDcHwwlwOL';

test('real YouTube URL yields native original key and zero-pitch badge without a job', async ({ page }, info) => {
  const posts: string[] = [];
  const proof: Record<string, unknown> = { source, baseURL: info.project.use.baseURL };
  page.on('request', request => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
  });
  try {
    await page.goto('/');
    const before = await page.request.get('/api/jobs');
    expect(before.ok()).toBe(true);
    const jobsBefore = await before.json();
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/key-analysis' && response.request().method() === 'POST', { timeout: 180_000 });
    await page.getByLabel('Track URL', { exact: true }).fill(source);
    const analyzed = await response;
    proof.status = analyzed.status();
    proof.response = await analyzed.text();
    expect(analyzed.status(), `Real external download/native analysis failed: ${proof.response}`).toBe(200);
    const result = JSON.parse(proof.response as string) as { original_key: unknown };
    expect(result.original_key).toMatch(/^(?:C|Db|D|Eb|E|F|Gb|G|Ab|A|Bb|B) (?:major|minor)$/);
    const key = result.original_key as string;
    await expect(page.getByText(`Original key: ${key}`, { exact: true })).toBeVisible();
    const pitch = page.getByRole('spinbutton', { name: 'Pitch shift (semitones)', exact: true });
    await expect(pitch).toHaveValue('0');
    const badge = page.locator('#pitch-target-key');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(`Resulting key: ${key}`);
    await expect(page.getByText(`Target key: ${key}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(posts).toEqual(['/api/key-analysis']);
    const after = await page.request.get('/api/jobs');
    expect(after.ok()).toBe(true);
    expect(await after.json()).toEqual(jobsBefore);
    proof.original_key = key;
    proof.target_key = key;
    proof.pitch_semitones = await pitch.inputValue();
    proof.pitch_badge = await badge.innerText();
    proof.jobs_unchanged = true;
  } finally {
    proof.posts = posts;
    proof.alerts = await page.getByRole('alert').allTextContents();
    await writeFile(info.outputPath('youtube-key-proof.json'), JSON.stringify(proof, null, 2));
    await info.attach('real-youtube-key-proof', { path: info.outputPath('youtube-key-proof.json'), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('youtube-key-ui.png'), fullPage: true });
    await info.attach('real-youtube-key-ui', { path: info.outputPath('youtube-key-ui.png'), contentType: 'image/png' });
  }
});
