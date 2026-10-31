import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { PitchAnalysisDTO } from '../src/api';

const mobile = { width: 390, height: 844 };
const desktop = { width: 1440, height: 1000 };
const pitchName = 'Pitch shift (semitones)';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-01T12:00:00Z'));
});

test.afterEach(async ({ page, browser }, info) => {
  await writeFile(info.outputPath('runtime.json'), JSON.stringify({
    runtime: process.env.E2E_VISUAL_RUNTIME,
    browser: browser.version(),
    os: await readFile('/etc/os-release', 'utf8'),
    viewport: page.viewportSize(),
  }, null, 2));
});

async function analyze(page: Page, info: TestInfo, unknown = false) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
  const response = page.waitForResponse(res => res.url().endsWith('/api/key-analysis') && res.request().method() === 'POST');
  await page.getByLabel('Audio file', { exact: true }).setInputFiles(resolve(process.env.E2E_FIXTURE_DIR!, unknown ? 'silent-fixture.wav' : 'tone-fixture.wav'));
  const result = await response;
  expect(result.ok()).toBe(true);
  const analysis = await result.json();
  expect(analysis.original_key).toBe(unknown ? null : 'C major');
  await writeFile(info.outputPath('analysis.json'), JSON.stringify(analysis, null, 2));
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

async function adjust(page: Page) {
  if (page.viewportSize()!.width <= 700) await page.getByRole('tab', { name: 'Adjust', exact: true }).click();
}

async function compare(subject: Page | Locator, info: TestInfo, name: string) {
  // Keep an actual PNG even on success, alongside the strict baseline comparison.
  await subject.screenshot({ path: info.outputPath('actual.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
  await expect(subject).toHaveScreenshot(name);
}

for (const tab of ['Outputs', 'Adjust', 'Review']) {
  test(`mobile 390 ${tab} workspace`, async ({ page }, info) => {
    await page.setViewportSize(mobile);
    await analyze(page, info);
    if (tab !== 'Outputs') {
      await page.getByRole('checkbox', { name: 'Extract vocals', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Female vocals + instruments', exact: true }).check();
      await adjust(page);
      await page.getByRole('spinbutton', { name: pitchName }).fill('2');
      await page.getByRole('spinbutton', { name: 'Tempo (% of original)' }).fill('120');
      await expect(page.locator('.pitch-key-badge')).toHaveText('Resulting key: D major');
      await page.getByRole('tab', { name: tab, exact: true }).click();
    }
    await page.getByRole('heading', { name: "ehpc's Vocal Tools", exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await compare(page, info, `mobile-390-${tab.toLowerCase()}.png`);
  });
}

for (const viewport of [desktop, { width: 2560, height: 1440 }]) {
  test(`desktop ${viewport.width} workspace`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await analyze(page, info);
    await page.getByRole('checkbox', { name: 'Extract vocals', exact: true }).check();
    await page.getByRole('spinbutton', { name: pitchName }).fill('2');
    await expect(page.locator('.pitch-key-badge')).toHaveText('Resulting key: D major');
    await page.getByRole('heading', { name: "ehpc's Vocal Tools", exact: true }).click();
    await compare(page, info, `desktop-${viewport.width}-workspace.png`);
  });
}

const states = [
  { name: 'known-zero', pitch: '0', key: 'C major' },
  { name: 'shifted-plus-two', pitch: '2', key: 'D major' },
  { name: 'unknown', pitch: '0', key: null },
  { name: 'long-fractional-cents', pitch: '2.123456789', key: 'D major (+12.3456789 cents)' },
];
for (const viewport of [mobile, desktop]) {
  for (const state of states) {
    test(`focused pitch ${viewport.width} ${state.name}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await analyze(page, info, state.key === null);
      await adjust(page);
      const input = page.getByRole('spinbutton', { name: pitchName });
      await input.fill(state.pitch);
      await input.focus();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(state.pitch);
      if (state.key) {
        await expect(input).toHaveAccessibleDescription(`Resulting key: ${state.key}`);
      } else {
        await expect(page.locator('.pitch-key-badge')).toHaveCount(0);
        await expect(page.getByText('Original key: Undetermined', { exact: true })).toBeVisible();
      }
      // Include the neighboring tempo control to catch wrapping/overlap and
      // leave room for the pitch focus outline without eight whole-page images.
      await compare(page.locator('.workspace-numbers'), info, `pitch-${viewport.width}-${state.name}.png`);
    });
  }
}

// Genuine full-song CREPE/Whisper output, filtered to output9.5–15.2s.
// Audio remains the uncut public-domain recording; these cases exercise the
// real upload/API/storage/native transform/rendering path without another GPU.
const publishTimeline = String.raw`
import json,sys
from backend import config,db
from backend.queue import _persist_results
from separator.lyrics import transcript_from_json
from separator.pitch import pitch_from_json,pitch_to_json
from separator.stems import StemResult
value=json.load(sys.stdin)
job=db.get_job(int(sys.argv[1]))
assert job is not None
source=(config.UPLOADS_DIR / str(job.id) / job.source_value).read_bytes()
manifest=_persist_results(job,dict(song=StemResult(source,0)))
db.mark_done(job.id,manifest,transcript_from_json(json.dumps(value['transcript'])),
    pitch_to_json(pitch_from_json(json.dumps(value['pitch']))))
`;

for (const viewport of [mobile, desktop]) {
  test(`detected vocal melody ${viewport.width} with linked sung words`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg'));
    const fixture = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8');
    const response = await page.request.post('/api/jobs', { multipart: {
      file: { name: 'auld-lang-syne-full.ogg', mimeType: 'audio/ogg', buffer: source },
      detect_pitch: 'true', extract_lyrics: 'true', pitch_semitones: '1.25', tempo_percent: '125',
    } });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).id as number;
    execFileSync('uv', ['run', 'python', '-c', publishTimeline, String(id)], {
      cwd: process.env.E2E_REPO_ROOT!, input: fixture,
      env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    await page.reload();
    const view = page.getByLabel('Vocal pitch analysis', { exact: true });
    await expect(view).toBeVisible();
    const player = view.locator('audio');
    // Native buffered-range paint is transport-dependent. Load the actual
    // complete file before comparison rather than masking it or allowing diffs.
    await player.evaluate(element => { element.preload = 'auto'; element.load(); });
    await expect.poll(() => player.evaluate(element => Number.isFinite(element.duration)
      && element.buffered.length === 1 && element.buffered.start(0) <= 0.01
      && element.buffered.end(0) >= element.duration - 0.01)).toBe(true);
    const payload = await (await page.request.get(`/api/jobs/${id}/pitch`)).json() as PitchAnalysisDTO;
    const acquaintanceIndex = payload.words.findIndex(word => word.text === 'acquaintance');
    const noteIndex = payload.tracks[0].notes.findIndex(note => note.word_indices.includes(acquaintanceIndex));
    const note = view.locator('.pitch-note').nth(noteIndex);
    await note.scrollIntoViewIfNeeded();
    await note.click();
    await expect(view.locator('.pitch-selection')).toContainText('acquaintance');
    await expect.poll(() => player.evaluate(element => !element.seeking && element.readyState >= 4)).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await compare(view, info, `vocal-melody-${viewport.width}-word-notes.png`);
  });
}
