import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test as authenticatedTest } from './auth-fixture';

// These layout cases intercept API traffic and never enqueue a real job.
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
  test(`accepted job dock remains usable at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      class ControlledEventSource {
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() { (window as unknown as { jobStream: ControlledEventSource }).jobStream = this; }
        close() {}
      }
      Object.defineProperty(window, 'EventSource', { value: ControlledEventSource, configurable: true });
    });
    let submitted = false;
    const song = {
      id: 7, title: 'A remarkably long title — An artist with an equally long name',
      source_type: 'url', source_value: 'https://example.test/song', created_at: 1700000000,
      open_count: 0, status: 'queued', has_original: false, original_key: null, original_work_id: null,
      latest_work_id: 42, active_work_id: 42, active_work_ids: [42],
      availability: { audio: true, karaoke: false, lyrics: false, pitched_lyrics: false },
    };
    let work = {
      id: 42, song_id: 7, title: song.title, source_type: 'url', source_value: song.source_value,
      status: 'queued', position: 2 as number | null, progress: { steps: ['source', 'analysis', 'export'], current: null as string | null },
      options: { extract_vocals: false, extract_instruments: false, extract_lyrics: false, detect_pitch: false,
        extract_pitched_lyrics: false, mixes: [], decrowd: false, decrowd_vocals: false, dereverb: false,
        genders: false, lead_backing: false, drums: false, pitch_semitones: 0, tempo_percent: 100 },
      original_key: null, output_key: null, result_revision: null, manifest: null, transcript: null, pitch: null,
      pitched_lyrics: null, lyric_pitch_lines: null, error_message: null, created_at: 1700000000,
      has_original: false, has_pitch_vocals: false,
    };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      let data: unknown;
      if (path === '/api/auth/activity' && method === 'POST') {
        await route.fulfill({ status: 204 });
        return;
      }
      if (path === '/api/auth/me') data = { id: 'fixture', email: 'listener@example.test', is_admin: false, invite_limit: 0, invites: [] };
      else if (path === '/api/songs/current') data = null;
      else if (path === '/api/songs') data = submitted ? [song] : [];
      else if (path === '/api/songs/7') data = { summary: song, variants: [{
        pitch_semitones: 0, tempo_percent: 100,
        outputs: [{ identity: 'vocals', label: 'vocals', display_name: 'Vocals', work_id: 41, revision: 'v1',
          manifest: { label: 'vocals', filename: 'vocals.wav', download_name: 'vocals.wav', size_bytes: 100, duration_s: 8 } }],
        karaoke_work_id: null, karaoke_revision: null, lyrics_work_id: null, lyrics_revision: null,
        pitched_lyrics_work_id: null, pitched_lyrics_revision: null,
      }] };
      else if (path === '/api/jobs/42' && method === 'GET') data = work;
      else if (path === '/api/jobs/41/results/vocals') {
        await route.fulfill({ body: await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav')), contentType: 'audio/wav' });
        return;
      }
      else if (path === '/api/jobs' && method === 'POST') {
        submitted = true;
        data = { song_id: 7, work_id: 42, status: 'queued', position: 2, progress: { steps: ['source', 'analysis', 'export'], current: null } };
      } else if (path === '/api/key-analysis') data = { original_key: null };
      else throw new Error(`Unexpected fixture request: ${method} ${path}`);
      await route.fulfill({ json: data });
    });
    await page.goto('/');
    await page.getByLabel('Track URL').fill('https://example.test/song');
    await page.getByRole('button', { name: 'Download song' }).click();
    const dock = page.locator('.job-dock');
    await expect(dock).toContainText('Queued');
    work = { ...work, status: 'running', position: null, progress: { ...work.progress, current: 'analysis' } };
    await page.evaluate(current => {
      // The fixture installs this stream in the same page before app startup.
      const fixtureWindow = window as unknown as { jobStream: { onmessage: (event: { data: string }) => void } };
      const stream = fixtureWindow.jobStream;
      stream.onmessage({ data: JSON.stringify(current) });
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    }, work);
    if (viewport.width <= 390) {
      await expect.poll(() => page.evaluate(() => {
        const dock = document.querySelector('.job-dock')!.getBoundingClientRect();
        const action = document.querySelector('.workspace-action')!.getBoundingClientRect();
        return dock.bottom <= action.top;
      })).toBe(true);
    }
    await expect(dock).toContainText('Detecting song key');
    await expect(dock.getByRole('list', { name: 'Processing steps' })).toContainText('Detecting song key: Current');
    const navigation = page.getByRole('navigation', { name: 'Song outputs' });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole('link', { name: 'Go to Audio' })).toBeVisible();
    await expect(navigation.getByRole('link', { name: /Go to (Karaoke|Lyrics|Pitched lyrics)/ })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const nav = document.querySelector('.outputs-navigation')!.getBoundingClientRect();
      const dock = document.querySelector('.job-dock')!.getBoundingClientRect();
      return nav.bottom <= dock.top;
    })).toBe(true);
    const audio = page.locator('#song-audio audio');
    await audio.evaluate((element: HTMLAudioElement) => { element.volume = 0; return element.play(); });
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
    await navigation.getByRole('link', { name: 'Go to Audio' }).click();
    await expect(page.locator('#song-audio')).toBeFocused();
    expect(await audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
    await info.attach(`outputs-navigation-${viewport.width}`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await page.evaluate(() => document.documentElement.requestFullscreen());
    await expect(navigation).toBeHidden();
    await page.evaluate(() => document.exitFullscreen());
    await expect(navigation).toBeVisible();
    const geometry = await page.evaluate(() => {
      const dock = document.querySelector('.job-dock')!.getBoundingClientRect();
      const action = document.querySelector('.workspace-action')!.getBoundingClientRect();
      return { dock: { left: dock.left, right: dock.right, top: dock.top, bottom: dock.bottom }, actionTop: action.top, width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) };
    });
    expect(geometry.dock.left).toBeGreaterThanOrEqual(0);
    expect(geometry.dock.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.dock.bottom).toBeLessThanOrEqual(geometry.height);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.padding).toBeGreaterThan(geometry.dock.bottom - geometry.dock.top);
    if (viewport.width <= 390) expect(geometry.dock.bottom).toBeLessThanOrEqual(geometry.actionTop);
    await info.attach(`job-dock-${viewport.width}`, { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await expect(dock.locator('strong')).toHaveAttribute('title', 'A remarkably long title — An artist with an equally long name');
    if (viewport.width <= 390) {
      // CSS zoom exercises the narrower layout while retaining the physical viewport.
      await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
      await page.getByRole('button', { name: '+ Drums', exact: true }).click();
      await page.getByRole('button', { name: '+ Bass', exact: true }).click();
      for (const control of [
        page.getByRole('checkbox', { name: 'Split drums, bass & other instruments' }),
        page.getByRole('button', { name: 'Add mix', exact: true }),
        page.getByRole('button', { name: 'Download song', exact: true }),
        dock.getByRole('button', { name: 'View progress' }),
      ]) {
        await control.scrollIntoViewIfNeeded();
        await control.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(control).toBeFocused();
        await expect.poll(() => control.evaluate(element => {
          const target = element.getBoundingClientRect();
          const overlaps = (other: DOMRect) => target.left < other.right && target.right > other.left && target.top < other.bottom && target.bottom > other.top;
          const dock = document.querySelector('.job-dock')!;
          const action = document.querySelector('.workspace-action')!;
          return target.top >= 0 && target.bottom <= innerHeight &&
            (dock.contains(element) || !overlaps(dock.getBoundingClientRect())) &&
            (action.contains(element) || !overlaps(action.getBoundingClientRect()));
        })).toBe(true);
      }
      await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    }
    await page.getByRole('button', { name: 'Add outputs', exact: true }).click();
    await expect(page.getByText('Adding outputs to', { exact: false })).toBeInViewport();
    await expect.poll(() => page.evaluate(() => document.activeElement?.contains(document.querySelector('[aria-label="Audio source"]')))).toBe(true);
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(dock).toBeVisible();
    await dock.getByRole('button', { name: 'View progress' }).click();
    await expect(page.locator('.processing-results')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (viewport.width <= 390) {
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      const drawer = page.getByRole('dialog');
      await drawer.getByRole('button', { name: 'View progress' }).click();
      await expect(drawer).not.toBeVisible();
      await expect(page.locator('.processing-results')).toBeFocused();
    }
    expect(errors).toEqual([]);
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
authenticatedTest(`adding a variant reuses the source and keeps each stem independently selectable at ${viewport.width}px`, async ({ page }, info) => {
  expect(process.env.QUEUE_CONCURRENCY).toBe('0');
  await page.setViewportSize(viewport);
  const source = Buffer.concat([await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav')), randomBytes(16)]);
  let songId: number | undefined;
  const finish = (id: number) => execFileSync('uv', ['run', 'python', '-c', String.raw`
import os,sys
from pathlib import Path
from backend import config,db
from backend.queue import _persist_results
from separator.stems import StemResult
assert config.QUEUE_CONCURRENCY == 0
assert config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
job=db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'queued' and job.modal_call_id is None
source=(config.UPLOADS_DIR / str(job.id) / job.source_value).read_bytes()
manifest=_persist_results(job,{label:StemResult(source,0) for label in job.options.result_labels})
db.mark_done(job.id,manifest,None)
`, String(id)], { cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! } });
  const secondAccepted = Promise.withResolvers<{ song_id: number; work_id: number }>();
  const releaseSecond = Promise.withResolvers<void>();
  await page.route('**/api/jobs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    const accepted = await response.json() as { song_id: number; work_id: number };
    songId = accepted.song_id;
    finish(accepted.work_id);
    await route.fulfill({ response });
  });
  await page.route('**/api/songs/*/work', async route => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const accepted = await response.json() as { song_id: number; work_id: number };
    secondAccepted.resolve(accepted);
    await releaseSecond.promise;
    finish(accepted.work_id);
    await route.fulfill({ response });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
    const analysis = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
    await page.getByLabel('Audio file').setInputFiles({ name: 'variant-source.wav', mimeType: 'audio/wav', buffer: source });
    expect((await analysis).ok()).toBe(true);
    await page.getByRole('checkbox', { name: 'Extract vocals', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Extract instruments', exact: true }).check();
    const firstPost = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Process audio', exact: true }).click();
    const first = await (await firstPost).json() as { song_id: number; work_id: number };
    songId = first.song_id;
    expect(first.work_id).toBeGreaterThan(0);
    expect(first.song_id).toBe(songId);
    const vocals = page.getByRole('link', { name: /Download .*vocals/i });
    await expect(vocals).toBeVisible();
    const originalVocals = await vocals.getAttribute('href');
    await page.getByRole('button', { name: 'Add outputs', exact: true }).click();
    await expect(page.getByText('Adding outputs to', { exact: false })).toBeInViewport();
    if (viewport.width <= 390) await page.getByRole('tab', { name: 'Adjust', exact: true }).click();
    await page.getByLabel('Pitch shift (semitones)').fill('2');
    await page.getByLabel('Tempo (% of original)').fill('120');
    const secondPost = page.waitForResponse(response => response.url().endsWith(`/api/songs/${songId}/work`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Process audio', exact: true }).click();
    const pending = await secondAccepted.promise;
    expect(pending.song_id).toBe(songId);
    expect(pending.work_id).not.toBe(first.work_id);
    expect(await vocals.getAttribute('href')).toBe(originalVocals);
    releaseSecond.resolve();
    const response = await secondPost;
    expect(response.ok()).toBe(true);
    const multipart = response.request().postData()!;
    expect(multipart).not.toContain('name=\"file\"');
    expect(multipart).not.toContain('name=\"url\"');
    const second = await response.json() as { song_id: number; work_id: number };
    expect(second.song_id).toBe(songId);
    expect(second.work_id).not.toBe(first.work_id);
    expect(await vocals.getAttribute('href')).toBe(originalVocals);
    const vocalVersion = page.getByRole('combobox', { name: 'vocals version' });
    const instrumentVersion = page.getByRole('combobox', { name: 'instruments version' });
    await expect(vocalVersion).toBeVisible();
    await vocalVersion.selectOption('2:120');
    await expect(vocals).toHaveAttribute('href', new RegExp(`/api/jobs/${second.work_id}/results/vocals`));
    await expect(instrumentVersion).toHaveValue('0:100');
    for (const selector of [vocalVersion, instrumentVersion]) {
      const geometry = await selector.evaluate(element => {
        const select = element.getBoundingClientRect();
        const card = element.closest('.rounded-lg')!.getBoundingClientRect();
        return { select: { left: select.left, right: select.right }, card: { left: card.left, right: card.right },
          pageWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth };
      });
      expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
      expect(geometry.select.left).toBeGreaterThanOrEqual(geometry.card.left);
      expect(geometry.select.right).toBeLessThanOrEqual(geometry.card.right);
    }
    await page.locator('#song-audio').screenshot({ path: info.outputPath(`independent-versions-${viewport.width}.png`), animations: 'disabled' });
    const library = await (await page.request.get('/api/songs?sort=added')).json() as { id: number }[];
    expect(library.filter(item => item.id === songId)).toHaveLength(1);
  } finally {
    releaseSecond.resolve();
    await page.goto('about:blank');
    if (songId !== undefined) expect((await page.request.delete(`/api/songs/${songId}`, { headers: { Origin: process.env.E2E_BASE_URL! } })).status()).toBe(204);
  }
});
}

// Run with the real authenticated backend and key analyzer, but no worker.
// Complete each accepted job in the isolated database before its real POST
// response reaches the UI, so the real SSE snapshot observes completion.
authenticatedTest('completed dock does not prevent another source analysis and submission', async ({ page }) => {
  expect(process.env.QUEUE_CONCURRENCY).toBe('0');
  const createdIds: number[] = [];
  const releaseAnalysis = Promise.withResolvers<void>();
  const analysisFetched = Promise.withResolvers<void>();
  await page.route('**/api/jobs', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch();
    if (response.ok()) {
      const created = await response.json() as { song_id: number; work_id: number };
      createdIds.push(created.song_id);
      execFileSync('uv', ['run', 'python', '-c', String.raw`
import os,sys
from backend import config,db
assert config.QUEUE_CONCURRENCY == 0
assert str(config.DATA_DIR.resolve()) == os.environ['E2E_DATA_DIR']
job=db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'queued' and job.modal_call_id is None
db.mark_done(job.id,[],None)
`, String(created.work_id)], { cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! } });
    }
    await route.fulfill({ response });
  });
  try {
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
    await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
    const input = page.getByLabel('Audio file', { exact: true });
    const analysisStatus = page.getByRole('region', { name: 'Audio source', exact: true }).getByRole('status');
    const firstAnalysis = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
    await input.setInputFiles({ name: 'first-tone.wav', mimeType: 'audio/wav', buffer: source });
    expect((await firstAnalysis).ok()).toBe(true);
    await expect(analysisStatus).toHaveCount(0);
    const firstPost = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Download song', exact: true }).click();
    expect((await firstPost).ok()).toBe(true);
    const dock = page.locator('.job-dock');
    await expect(dock).toContainText('Complete');
    await page.route('**/api/key-analysis', async route => {
      const response = await route.fetch();
      analysisFetched.resolve();
      await releaseAnalysis.promise;
      await route.fulfill({ response });
    });

    const secondAnalysis = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
    await input.setInputFiles({ name: 'second-tone.wav', mimeType: 'audio/wav', buffer: Buffer.concat([source, Buffer.from('second')]) });
    await analysisFetched.promise;
    await expect(analysisStatus).toBeVisible();
    await expect(dock).toContainText('Complete');
    releaseAnalysis.resolve();
    expect((await secondAnalysis).ok()).toBe(true);
    await expect(analysisStatus).toHaveCount(0);
    await expect(dock).toContainText('Complete');
    await page.getByRole('checkbox', { name: 'Extract vocals', exact: true }).check();
    const processButton = page.getByRole('button', { name: 'Process audio', exact: true });
    await expect(processButton).toBeEnabled();
    const secondPost = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
    await processButton.click();
    expect((await secondPost).ok()).toBe(true);
    expect(createdIds).toHaveLength(2);
    await expect(dock).toContainText('second-tone.wav');
    await expect(dock).toContainText('Complete');
  } finally {
    releaseAnalysis.resolve();
    await page.goto('about:blank');
    for (const id of createdIds) {
      const response = await page.request.delete(`/api/songs/${id}`, { headers: { Origin: process.env.E2E_BASE_URL! } });
      expect(response.status()).toBe(204);
    }
  }
});

authenticatedTest('a dropped job stream reconnects and shows completion without reload', async ({ page }, info) => {
  expect(process.env.QUEUE_CONCURRENCY).toBe('0');
  let jobId: number | undefined;
  let songId: number | undefined;
  let streams = 0;
  await page.route('**/api/jobs/*/events', async route => {
    streams++;
    if (streams === 1) await route.abort('connectionreset');
    else await route.continue();
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
    const analysis = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
    await page.getByLabel('Audio file', { exact: true }).setInputFiles(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
    expect((await analysis).ok()).toBe(true);
    await expect(page.getByRole('region', { name: 'Audio source', exact: true }).getByRole('status')).toHaveCount(0);
    const post = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
    const snapshot = page.waitForResponse(response => /\/api\/jobs\/\d+$/.test(response.url()) && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Download song', exact: true }).click();
    const accepted = await post;
    expect(accepted.ok()).toBe(true);
    ({ work_id: jobId, song_id: songId } = await accepted.json() as { work_id: number; song_id: number });
    expect((await (await snapshot).json()).status).toBe('queued');
    await expect(page.locator('.job-dock')).toContainText('Queued');
    await page.screenshot({ path: info.outputPath('disconnect-before-completion.png') });
    execFileSync('uv', ['run', 'python', '-c', String.raw`
import os,sys
from backend import config,db
assert config.QUEUE_CONCURRENCY == 0
assert str(config.DATA_DIR.resolve()) == os.environ['E2E_DATA_DIR']
job=db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'queued' and job.modal_call_id is None
db.mark_done(job.id,[],None)
`, String(jobId)], { cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! } });
    await expect(page.locator('.job-dock')).toContainText('Complete', { timeout: 12_000 });
    await expect(page.locator(`a[href="/api/jobs/${jobId}/original"]`)).toBeVisible();
    expect(streams).toBeGreaterThan(1);
    await page.screenshot({ path: info.outputPath('reconnected-completion.png') });
  } finally {
    await page.goto('about:blank');
    if (songId !== undefined) {
      const response = await page.request.delete(`/api/songs/${songId}`, { headers: { Origin: process.env.E2E_BASE_URL! } });
      expect(response.status()).toBe(204);
    }
  }
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`real worker reports live phases and terminal states at ${viewport.width}px`, async ({ browser }, info) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(resolve(tmpdir(), 'job-phases-'));
    const reservation = createServer();
    await new Promise<void>(done => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Could not reserve fixture port');
    const origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()));
    const root = process.env.E2E_REPO_ROOT!;
    const environment = {
      ...process.env, DATA_DIR: directory, TMPDIR: directory, PYTHONPATH: root, QUEUE_CONCURRENCY: '1',
      AUTH_ORIGIN: origin, AUTH_OTP_SECRET: 'fixture-otp-secret-0123456789abcdef',
      AUTH_INVITE_SECRET: 'fixture-invite-secret-0123456789abcdef', TEST_PORT: String(address.port),
    };
    const provision = "from backend import auth_store,db; db.init_db(); email='phase-test@example.invalid'; _,invite=auth_store.create_invite(None); challenge=auth_store.start(email,invite,'127.0.0.1'); print(auth_store.verify(email,challenge[1],invite)[0])";
    const token = execFileSync('uv', ['run', 'python', '-c', provision], { cwd: root, env: environment, encoding: 'utf8' }).trim();
    const server = spawn('uv', ['run', 'python', 'tests/drain_http_worker.py'], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = '';
    server.stdout.on('data', data => { serverLog += String(data); });
    server.stderr.on('data', data => { serverLog += String(data); });
    const exited = new Promise<void>(done => server.once('exit', () => done()));
    const context = await browser.newContext({ baseURL: origin, viewport, reducedMotion: 'reduce' });
    const errors: string[] = [];
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await expect.poll(async () => {
        if (server.exitCode !== null) throw new Error(`Fixture server exited: ${serverLog}`);
        try { return (await fetch(`${origin}/health`)).ok; } catch { return false; }
      }, { timeout: 30_000 }).toBe(true);
      await context.addCookies([{ name: 'auth_session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      await page.goto('/');
      const source = await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
      await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
      const input = page.getByLabel('Audio file', { exact: true });
      const analysis = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
      await input.setInputFiles({ name: 'first-tone.wav', mimeType: 'audio/wav', buffer: source });
      expect((await analysis).ok()).toBe(true);
      await expect(page.getByRole('region', { name: 'Audio source', exact: true }).getByRole('status')).toHaveCount(0);
      await page.getByRole('checkbox', { name: 'Extract vocals', exact: true }).check();
      const firstPost = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Process audio', exact: true }).click();
      const firstResponse = await firstPost;
      expect(firstResponse.ok()).toBe(true);
      const firstId = (await firstResponse.json() as { work_id: number }).work_id;
      const dock = page.locator('.job-dock');
      await expect(dock).toContainText('Separating audio', { timeout: 30_000 });
      await expect.poll(async () => access(resolve(directory, 'polling')).then(() => true, () => false), { timeout: 30_000 }).toBe(true);
      await expect(dock.getByRole('list', { name: 'Processing steps' })).toContainText('Separating audio: Current');
      await expect(dock.getByRole('list', { name: 'Processing steps' })).not.toContainText('Detecting vocal pitch');
      await info.attach(`live-phase-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' });
      await dock.getByRole('button', { name: 'View progress' }).click();
      const results = page.locator('.processing-results');
      await expect(results).toBeFocused();
      const fullSteps = results.getByRole('list', { name: 'Processing steps' });
      await expect(fullSteps).toContainText('Preparing source: Complete');
      await expect(fullSteps).toContainText('Detecting song key: Complete');
      await expect(fullSteps).toContainText('Separating audio: Current');
      await expect(fullSteps).toContainText('Preparing outputs: Pending');
      await expect(fullSteps).not.toContainText('Transcribing and aligning lyrics');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await info.attach(`live-expanded-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' });
      await page.reload();
      await expect(dock).toContainText('first-tone.wav');
      await expect(dock).toContainText('Separating audio', { timeout: 30_000 });
      await dock.getByRole('button', { name: 'View progress' }).click();
      await expect(results).toBeFocused();
      await expect(fullSteps).toContainText('Separating audio: Current');
      await writeFile(resolve(directory, 'release'), '');
      await expect(dock).toContainText('Complete', { timeout: 30_000 });
      await expect(page.locator(`a[href^="/api/jobs/${firstId}/results/vocals"]`)).toBeVisible();
      await info.attach(`live-complete-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' });

      await rm(resolve(directory, 'release'));
      await rm(resolve(directory, 'polling'), { force: true });
      await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
      const secondAnalysis = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
      await input.setInputFiles({ name: 'second-tone.wav', mimeType: 'audio/wav', buffer: Buffer.concat([source, Buffer.from('second')]) });
      expect((await secondAnalysis).ok()).toBe(true);
      await expect(page.getByRole('region', { name: 'Audio source', exact: true }).getByRole('status')).toHaveCount(0);
      await page.getByRole('checkbox', { name: 'Extract instruments', exact: true }).check();
      const secondPost = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Process audio', exact: true }).click();
      const secondResponse = await secondPost;
      expect(secondResponse.ok()).toBe(true);
      const secondId = (await secondResponse.json() as { work_id: number }).work_id;
      expect(secondId).not.toBe(firstId);
      await expect(dock).toContainText('Separating audio', { timeout: 30_000 });
      await expect.poll(async () => access(resolve(directory, 'polling')).then(() => true, () => false), { timeout: 30_000 }).toBe(true);
      if (viewport.width === 390) await page.getByRole('button', { name: 'Library', exact: true }).click();
      await page.getByRole('region', { name: 'History', exact: true }).getByRole('button', { name: 'first-tone.wav', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'first-tone.wav', exact: true })).toBeVisible();
      await writeFile(resolve(directory, 'fail'), '');
      await writeFile(resolve(directory, 'release'), '');
      await expect(dock).toContainText('Failed', { timeout: 30_000 });
      await expect(page.getByRole('heading', { name: 'first-tone.wav', exact: true })).toBeVisible();
      await dock.getByRole('button', { name: 'View error' }).click();
      await expect(page.getByRole('alert')).toContainText('Controlled inference failure');
      const retry = page.locator('.processing-results').getByRole('button', { name: 'Retry', exact: true });
      await expect(retry).toBeVisible();
      await retry.scrollIntoViewIfNeeded();
      const retryBox = (await retry.boundingBox())!;
      expect(retryBox.height).toBeGreaterThanOrEqual(44);
      expect(retryBox.x).toBeGreaterThanOrEqual(0);
      expect(retryBox.x + retryBox.width).toBeLessThanOrEqual(viewport.width);
      await retry.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(retry).toBeFocused();
      await expect(input).toHaveValue(/second-tone\.wav/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await info.attach(`live-failed-${viewport.width}`, { body: await page.screenshot(), contentType: 'image/png' });
      expect(errors).toEqual([]);
    } finally {
      await writeFile(resolve(directory, 'release'), '');
      await context.close();
      server.kill('SIGTERM');
      await Promise.race([exited, new Promise<void>(done => setTimeout(done, 10_000))]);
      if (server.exitCode === null) server.kill('SIGKILL');
      await info.attach('fixture-server-log', { body: serverLog, contentType: 'text/plain' });
      await rm(directory, { recursive: true, force: true });
    }
  });
}
