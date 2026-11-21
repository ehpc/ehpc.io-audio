import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './auth-fixture';
import { test as microphoneTest } from './microphone-fixture';

const seedPitchJob = String.raw`
import json,os,sys
from pathlib import Path
from backend import config,db
from separator.lyrics import transcript_from_json
from separator.pitch import pitch_from_json,pitch_to_json
assert config.QUEUE_CONCURRENCY == 0
assert config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
job=db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'queued' and job.modal_call_id is None
value=json.load(sys.stdin)
db.mark_done(job.id,[],transcript_from_json(json.dumps(value['transcript'])),pitch_to_json(pitch_from_json(json.dumps(value['pitch']))))
`;
async function createSeededPitchJob(page: Page, rememberJob: (id: number) => void) {
  expect(process.env.QUEUE_CONCURRENCY).toBe('0');
  const root = process.env.E2E_REPO_ROOT!;
  const source = await readFile(resolve(root, 'tests/fixtures/auld-lang-syne-full.ogg'));
  const fixture = JSON.parse(await readFile(resolve(root, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8'));
  const firstPitch = fixture.pitch.tracks[0].notes[0];
  fixture.pitch.tracks[0].notes = [
    { ...firstPitch, start_s: 10, end_s: 20 },
    ...fixture.pitch.tracks[0].notes.slice(1).filter((note: { start_s: number }) => note.start_s >= 20),
  ];
  const submitted = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
    file: { name: 'auld-lang-syne-full.ogg', mimeType: 'audio/ogg', buffer: source },
    detect_pitch: 'true', pitch_semitones: '1.25', tempo_percent: '125',
  } });
  expect(submitted.ok()).toBe(true);
  const jobId = (await submitted.json()).id as number;
  rememberJob(jobId);
  execFileSync('uv', ['run', 'python', '-c', seedPitchJob, String(jobId)], {
    cwd: root, input: JSON.stringify(fixture),
    env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
  });
  const completed = await (await page.request.get(`/api/jobs/${jobId}`)).json();
  expect(completed.options).toMatchObject({ pitch_semitones: 1.25, tempo_percent: 125 });
  const storedPitch = await (await page.request.get(`/api/jobs/${jobId}/pitch`)).json();
  expect(storedPitch.tracks[0].notes[0].note).toBe('F4');
  return { baselineNote: storedPitch.tracks[0].notes[0] };
}
async function panTimeline(page: Page, viewport: Locator, width: number, distance: number) {
  const settled = await viewport.evaluateHandle(element => {
    const state = { done: false, origin: element.scrollLeft };
    let armed = false;
    let moved = false;
    const begin = () => { armed = true; state.origin = element.scrollLeft; };
    const changed = () => { if (armed && element.scrollLeft !== state.origin) moved = true; };
    const end = () => { if (moved) { state.done = true; stop(); } };
    const stop = () => {
      element.removeEventListener('pointerdown', begin);
      element.removeEventListener('wheel', begin);
      element.removeEventListener('scroll', changed);
      element.removeEventListener('scrollend', end);
    };
    element.addEventListener('pointerdown', begin);
    element.addEventListener('wheel', begin);
    element.addEventListener('scroll', changed);
    element.addEventListener('scrollend', end);
    return { state, stop };
  });
  const before = await viewport.evaluate(element => element.scrollLeft);
  try {
    if (width <= 700) {
      await viewport.scrollIntoViewIfNeeded();
      const box = (await viewport.boundingBox())!;
      const touch = await page.context().newCDPSession(page);
      const delta = Math.sign(distance) * Math.min(Math.abs(distance), box.width - 102);
      const start = delta > 0 ? box.x + box.width - 24 : box.x + 78;
      const y = box.y + box.height / 2;
      try {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y, id: 1 }] });
        for (let step = 1; step <= 8; step++) {
          await touch.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{ x: start - delta * step / 8, y, id: 1 }],
          });
          await page.evaluate(() => {
            const { promise, resolve } = Promise.withResolvers<void>();
            requestAnimationFrame(() => resolve());
            return promise;
          });
        }
        await page.waitForTimeout(150);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await touch.detach();
      }
    } else {
      await viewport.hover();
      await page.mouse.wheel(distance, 0);
    }
    await expect.poll(() => settled.evaluate(value => value.state.done)).toBe(true);
    const after = await viewport.evaluate(element => element.scrollLeft);
    expect(Math.sign(distance) * (after - before)).toBeGreaterThan(0);
  } finally {
    await settled.evaluate(value => value.stop());
    await settled.dispose();
  }
}


for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 740 },
]) {
  test.describe(`reference-only transposition ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width <= 700, hasTouch: true });
    let jobId: number | undefined;
    test.afterEach(async ({ page }) => {
      if (jobId === undefined) return;
      await page.goto('about:blank');
      const response = await page.request.delete(`/api/jobs/${jobId}`, { headers: { Origin: process.env.E2E_BASE_URL! } });
      expect(response.status()).toBe(204);
      jobId = undefined;
    });

    test('shifts every reference-pitch consumer without changing native playback', async ({ page }, info) => {
      test.setTimeout(120_000);
      expect(process.env.QUEUE_CONCURRENCY).toBe('0');
      await page.goto('/');
      const { baselineNote } = await createSeededPitchJob(page, id => { jobId = id; });
      await page.reload();

      const view = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
      await expect(view).toBeVisible();
      const controls = view.getByRole('group', { name: 'Timeline playback' });
      const lower = controls.getByRole('button', { name: 'Lower reference pitch one semitone', exact: true });
      const raise = controls.getByRole('button', { name: 'Raise reference pitch one semitone', exact: true });
      const lowerOctave = controls.getByRole('button', { name: 'Lower reference pitch one octave', exact: true });
      const raiseOctave = controls.getByRole('button', { name: 'Raise reference pitch one octave', exact: true });
      const back = controls.getByRole('button', { name: 'Back 5 seconds', exact: true });
      const forward = controls.getByRole('button', { name: 'Forward 5 seconds', exact: true });
      const sequence = await controls.locator('.pitch-skip-controls > button').evaluateAll(buttons => buttons.map(button => (button as HTMLButtonElement).getAttribute('aria-label')));
      expect(sequence).toEqual(['Lower reference pitch one semitone', 'Back 5 seconds', 'Play', 'Forward 5 seconds', 'Raise reference pitch one semitone']);
      if (viewport.width > 700) {
        const boxes = await Promise.all([lower, back, controls.getByRole('button', { name: 'Play', exact: true }), forward, raise]
          .map(async button => (await button.boundingBox())!));
        for (let index = 1; index < boxes.length; index++) expect(boxes[index].x).toBeGreaterThanOrEqual(boxes[index - 1].x + boxes[index - 1].width);
      }

      const status = view.locator('.pitch-transpose-value');
      await expect(status).toHaveText('Reference pitch: 0 semitones');
      const audio = view.locator('audio:not([hidden])');
      await audio.evaluate(element => { element.preload = 'auto'; element.load(); });
      await expect.poll(() => audio.evaluate(element => Number.isFinite(element.duration) && element.duration > 20 && element.seekable.length > 0)).toBe(true);
      // Native original-song time is 1.25x the source-analysis clock. Seeking
      // into the first sung word makes the source-time contract observable.
      await audio.evaluate(element => { element.currentTime = 13.5; });
      await expect.poll(() => audio.evaluate(element => Math.abs(element.currentTime - 13.5))).toBeLessThan(0.1);
      await expect.poll(() => audio.evaluate(element => !element.seeking)).toBe(true);
      const clock = view.getByRole('slider', { name: 'Pitch timeline position' });
      await expect.poll(async () => Number(await clock.getAttribute('aria-valuenow'))).toBeCloseTo(10.8, 1);
      await audio.evaluate(element => {
        const media = element as HTMLAudioElement & { __referencePitchSeeks: number };
        media.__referencePitchSeeks = 0;
        media.addEventListener('seeking', () => { media.__referencePitchSeeks++; });
      });
      await view.getByRole('checkbox', { name: 'Follow playback' }).uncheck();
      const note = view.locator('.pitch-note').first();
      await expect(note).toHaveAttribute('data-note', baselineNote.note);
      const viewportRegion = view.getByRole('region', { name: 'Scrollable vocal melody timeline', exact: true });
      const geometry = async () => note.locator('rect').evaluate(rect => {
        const svg = rect as SVGRectElement;
        const box = svg.getBBox(), client = svg.getBoundingClientRect();
        const viewport = svg.closest('.pitch-viewport')!;
        return { x: box.x, y: box.y, clientY: client.y - viewport.getBoundingClientRect().top, width: box.width, height: box.height };
      });
      const placeNoteInView = async () => {
        const before = await geometry();
        await viewportRegion.evaluate((element, y) => { element.scrollTop += y - element.clientHeight / 2; }, before.clientY);
      };
      await placeNoteInView();
      const initialGeometry = await geometry();
      const initialScroll = await viewportRegion.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }));
      const initialStart = await note.getAttribute('data-start');
      const initialEnd = await note.getAttribute('data-end');
      const initialAudio = await audio.evaluate(element => ({ time: element.currentTime, rate: element.playbackRate, paused: element.paused, source: element.currentSrc }));
      await audio.evaluate(element => element.play());
      await expect.poll(() => audio.evaluate(element => !element.paused)).toBe(true);
      const beforeRaise = await audio.evaluate(element => ({ time: element.currentTime, wall: performance.now() }));
      await raise.click();
      await expect(status).toHaveText('Reference pitch: +1 semitones');
      await expect(note).toHaveAttribute('data-note', 'F#4');
      await expect(note).toHaveAttribute('aria-label', /F#4/);
      const raisedGeometry = await geometry();
      expect(raisedGeometry.y).toBeLessThan(initialGeometry.y);
      expect(raisedGeometry.clientY).toBeLessThan(initialGeometry.clientY);
      expect(raisedGeometry.x).toBe(initialGeometry.x);
      expect(raisedGeometry.width).toBe(initialGeometry.width);
      expect(await viewportRegion.evaluate(element => element.scrollTop)).toBe(initialScroll.top);
      expect(await viewportRegion.evaluate(element => element.scrollLeft)).toBe(initialScroll.left);
      expect(await note.getAttribute('data-start')).toBe(initialStart);
      expect(await note.getAttribute('data-end')).toBe(initialEnd);
      await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(initialAudio.time);
      const afterRaise = await audio.evaluate(element => {
        const media = element as HTMLAudioElement & { __referencePitchSeeks: number };
        const slider = document.querySelector('[aria-label="Pitch timeline position"]');
        return {
          time: media.currentTime, rate: media.playbackRate, paused: media.paused, source: media.currentSrc,
          wall: performance.now(), outputTime: Number(slider?.getAttribute('aria-valuenow')),
          seekEvents: media.__referencePitchSeeks,
        };
      });
      expect(afterRaise.paused).toBe(false);
      expect(afterRaise.time).toBeGreaterThan(beforeRaise.time);
      expect(Math.abs((afterRaise.time - beforeRaise.time) - (afterRaise.wall - beforeRaise.wall) / 1000)).toBeLessThan(0.1);
      expect(afterRaise.seekEvents).toBe(0);
      expect(afterRaise.rate).toBe(initialAudio.rate);
      expect(afterRaise.rate).toBe(1);
      expect(afterRaise.source).toBe(initialAudio.source);
      expect(Math.abs(afterRaise.outputTime - afterRaise.time / 1.25)).toBeLessThan(0.1);

      const backgrounds = view.getByRole('group', { name: 'Pitch background audio' });
      await expect(backgrounds.getByRole('button', { name: 'Full song', exact: true })).toHaveAttribute('aria-pressed', 'true');
      const karaoke = view.getByRole('region', { name: 'Current karaoke line' });
      const showPitches = view.locator('.timeline-karaoke-controls').getByRole('button', { name: 'Pitches', exact: true });
      await showPitches.click();
      const lyricPitch = karaoke.locator('.timeline-karaoke-pitches').first();
      await expect(lyricPitch).toContainText('F#4');
      await note.scrollIntoViewIfNeeded();
      if (viewport.width <= 700) await note.tap();
      else await note.click();
      const noteTooltip = page.getByRole('tooltip');
      await expect(noteTooltip.locator('.pitch-tooltip-note')).toHaveText('F#4');
      const raisedPianoKey = view.getByRole('button', { name: 'Piano F#4', exact: true });
      await expect(raisedPianoKey).toHaveAttribute('aria-pressed', 'true');
      await view.screenshot({ path: info.outputPath(`reference-transposition-${viewport.width}.png`), animations: 'disabled' });

      await lower.click();
      await expect(status).toHaveText('Reference pitch: 0 semitones');
      await expect(note).toHaveAttribute('data-note', 'F4');
      expect(await geometry()).toMatchObject({ y: initialGeometry.y });
      await expect(lyricPitch).toContainText('F4');
      const negativeBaseGeometry = await geometry();
      const negativeBaseScroll = await viewportRegion.evaluate(element => element.scrollTop);
      await lower.click();
      await expect(status).toHaveText('Reference pitch: -1 semitones');
      await expect(note).toHaveAttribute('data-note', 'E4');
      await expect(note).toHaveAttribute('aria-label', /E4/);
      const loweredGeometry = await geometry();
      expect(loweredGeometry.y).toBeGreaterThan(negativeBaseGeometry.y);
      expect(loweredGeometry.clientY).toBeGreaterThan(negativeBaseGeometry.clientY);
      expect(loweredGeometry.x).toBe(initialGeometry.x);
      expect(loweredGeometry.width).toBe(initialGeometry.width);
      expect(await viewportRegion.evaluate(element => element.scrollTop)).toBe(negativeBaseScroll);
      await expect(lyricPitch).toContainText('E4');
      await note.scrollIntoViewIfNeeded();
      if (viewport.width <= 700) await note.tap();
      else await note.click();
      await expect(noteTooltip.locator('.pitch-tooltip-note')).toHaveText('E4');
      const loweredPianoKey = view.getByRole('button', { name: 'Piano E4', exact: true });
      await expect(loweredPianoKey).toHaveAttribute('aria-pressed', 'true');
      await raise.click();
      await expect(status).toHaveText('Reference pitch: 0 semitones');
      await expect(note).toHaveAttribute('data-note', 'F4');
      const octaveBaseGeometry = await geometry();
      const octaveBaseScroll = await viewportRegion.evaluate(element => element.scrollTop);
      await raiseOctave.click();
      await expect(status).toHaveText('Reference pitch: +12 semitones');
      await expect(note).toHaveAttribute('data-note', 'F5');
      const octaveGeometry = await geometry();
      expect(octaveGeometry.y).toBeLessThan(octaveBaseGeometry.y);
      expect(octaveGeometry.clientY).toBeLessThan(octaveBaseGeometry.clientY);
      expect(octaveGeometry.x).toBe(initialGeometry.x);
      expect(octaveGeometry.width).toBe(initialGeometry.width);
      expect(await viewportRegion.evaluate(element => element.scrollTop)).toBe(octaveBaseScroll);
      await expect(lyricPitch).toContainText('F5');
      await note.scrollIntoViewIfNeeded();
      if (viewport.width <= 700) await note.tap();
      else await note.click();
      await expect(note).toHaveAttribute('aria-label', /F5/);
      const octavePianoKey = view.getByRole('button', { name: 'Piano F5', exact: true });
      await expect(octavePianoKey).toHaveAttribute('aria-pressed', 'true');
      await raise.click();
      await expect(status).toHaveText('Reference pitch: +13 semitones');
      await expect(raiseOctave).toBeDisabled();
      await lower.click();
      await expect(status).toHaveText('Reference pitch: +12 semitones');

      const lead = view.getByLabel('Pitch vocal stem', { exact: true });
      await lead.selectOption('lead');
      await expect(status).toHaveText('Reference pitch: +12 semitones');
      await controls.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect.poll(() => audio.evaluate(element => element.paused)).toBe(true);
      await audio.evaluate(element => { element.currentTime = 15.5; });
      await expect.poll(() => audio.evaluate(element => !element.seeking)).toBe(true);
      await expect(status).toHaveText('Reference pitch: +12 semitones');
      await controls.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(() => audio.evaluate(element => !element.paused)).toBe(true);
      await expect(status).toHaveText('Reference pitch: +12 semitones');

      const fullscreen = view.getByRole('button', { name: 'Open karaoke fullscreen' });
      await fullscreen.click();
      const dialog = page.getByRole('dialog', { name: 'Karaoke fullscreen', exact: true });
      await expect(dialog).toBeVisible();
      const fullscreenRaise = dialog.getByRole('button', { name: 'Raise reference pitch one semitone', exact: true });
      await fullscreenRaise.click();
      await expect(dialog.locator('.pitch-transpose-value')).toHaveText('Reference pitch: +13 semitones');
      await dialog.getByRole('button', { name: 'Exit karaoke fullscreen', exact: true }).click();
      await expect(status).toHaveText('Reference pitch: +13 semitones');
      await expect(note).toHaveAttribute('data-note', 'F#5');
      const switchedAudio = await audio.evaluate(element => ({ time: element.currentTime, rate: element.playbackRate, paused: element.paused, source: element.currentSrc }));
      expect(switchedAudio.paused).toBe(false);
      expect(switchedAudio.time).toBeGreaterThan(15.5);
      expect(switchedAudio.rate).toBe(1);
      expect(switchedAudio.source).toBe(initialAudio.source);

      await info.attach('reference-transposition-consumers', { body: Buffer.from(JSON.stringify({
        viewport, initial: { geometry: initialGeometry, note: 'F4', audio: initialAudio },
        semitone: { geometry: raisedGeometry, note: 'F#4', audio: afterRaise },
        octave: { geometry: octaveGeometry, note: 'F5' },
        consumers: ['SVG note geometry', 'word pitches', 'tooltip', 'piano keys', 'source-time clock', 'fullscreen-shared state'],
        displayedOnly: true,
      }, null, 2)), contentType: 'application/json' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    });
  });
}
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test.describe(`timeline follow restore ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width === 390, hasTouch: true });
    let jobId: number | undefined;
    test.afterEach(async ({ page }) => {
      if (jobId === undefined) return;
      await page.goto('about:blank');
      const response = await page.request.delete(`/api/jobs/${jobId}`, { headers: { Origin: process.env.E2E_BASE_URL! } });
      expect(response.status()).toBe(204);
      jobId = undefined;
    });

    test('restores the current native playhead without transport or seek changes', async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.goto('/');
      await createSeededPitchJob(page, id => { jobId = id; });
      await page.reload();

      const view = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
      const timeline = view.getByRole('region', { name: 'Scrollable vocal melody timeline', exact: true });
      const audio = view.locator('audio:not([hidden])');
      await audio.evaluate(element => { element.preload = 'auto'; element.load(); });
      await expect.poll(() => audio.evaluate(element => Number.isFinite(element.duration) && element.duration > 30 && element.seekable.length > 0)).toBe(true);
      await audio.evaluate(element => { element.currentTime = 13.5; });
      await expect.poll(() => audio.evaluate(element => Math.abs(element.currentTime - 13.5))).toBeLessThan(0.1);
      await expect.poll(() => audio.evaluate(element => !element.seeking)).toBe(true);
      const follow = view.getByRole('checkbox', { name: 'Follow playback' });
      const status = view.locator('.pitch-follow-status');
      const resume = view.getByRole('button', { name: 'Resume timeline auto-follow', exact: true });
      const inspect = () => page.evaluate(() => {
        const timeline = document.querySelector('[aria-label="Scrollable vocal melody timeline"]') as HTMLElement;
        const audio = document.querySelector('[aria-label="Karaoke with pitches"] audio:not([hidden])') as HTMLAudioElement & { __resumeFollowSeekEvents: number };
        const slider = document.querySelector('[aria-label="Pitch timeline position"]')!;
        const zoom = document.querySelector('[aria-label="Melody zoom"]') as HTMLInputElement;
        const playhead = timeline.querySelector('.pitch-playhead')!.getBoundingClientRect();
        const region = timeline.getBoundingClientRect();
        const axis = timeline.querySelector('.pitch-axis')!.getBoundingClientRect();
        const visibleHeight = Math.max(0, Math.min(region.bottom, innerHeight) - Math.max(region.top, 0));
        const visibleWidth = Math.max(0, Math.min(region.right, innerWidth) - Math.max(region.left, 0));
        const visibleViewportRatio = Math.min(
          visibleHeight / Math.max(1, Math.min(region.height, innerHeight)),
          visibleWidth / Math.max(1, Math.min(region.width, innerWidth)),
        );
        return {
          time: audio.currentTime, outputTime: Number(slider.getAttribute('aria-valuenow')),
          rate: audio.playbackRate, paused: audio.paused, source: audio.currentSrc,
          seekEvents: audio.__resumeFollowSeekEvents, zoom: Number(zoom.value),
          width: timeline.clientWidth, scrollLeft: timeline.scrollLeft,
          playheadX: playhead.x - region.left,
          contentX: playhead.x - region.left + timeline.scrollLeft,
          axisWidth: axis.width,
          visible: playhead.x >= axis.right && playhead.x < region.left + timeline.clientLeft + timeline.clientWidth,
          visibleViewportRatio,
        };
      });
      await expect.poll(async () => Math.abs((await inspect()).outputTime - 10.8)).toBeLessThan(0.1);
      await audio.evaluate(element => {
        const media = element as HTMLAudioElement & { __resumeFollowSeekEvents: number };
        media.__resumeFollowSeekEvents = 0;
        media.addEventListener('seeking', () => { media.__resumeFollowSeekEvents++; });
      });
      await audio.evaluate(element => element.play());
      await expect.poll(() => audio.evaluate(element => !element.paused)).toBe(true);

      await timeline.scrollIntoViewIfNeeded();
      await panTimeline(page, timeline, viewport.width, 800);
      await expect(status).toContainText('Auto-follow paused while browsing');
      await expect(follow).toBeChecked();
      await expect(resume).toBeVisible();
      await expect.poll(async () => !(await inspect()).visible).toBe(true);
      await resume.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`timeline-follow-paused-${viewport.width}.png`), animations: 'disabled' });
      const beforeRestore = await inspect();
      await resume.click();
      await expect(follow).toBeChecked();
      await expect(status).toBeEmpty();
      await expect(resume).toHaveCount(0);
      await expect(timeline).toBeFocused();
      await expect.poll(async () => {
        const state = await inspect();
        return !state.paused && state.visible
          && Math.abs(state.outputTime - state.time / 1.25) < 0.1
          && Math.abs(state.playheadX - state.width * 0.25) < 24
          && Math.abs(state.contentX - (state.axisWidth + state.time / 1.25 * state.zoom)) < 24
          && state.visibleViewportRatio >= 0.6;
      }).toBe(true);
      const afterRestore = await inspect();
      expect(afterRestore.visibleViewportRatio).toBeGreaterThanOrEqual(0.6);
      expect(afterRestore.paused).toBe(false);
      expect(afterRestore.time).toBeGreaterThanOrEqual(beforeRestore.time);
      expect(afterRestore.rate).toBe(beforeRestore.rate);
      expect(afterRestore.source).toBe(beforeRestore.source);
      expect(afterRestore.seekEvents).toBe(beforeRestore.seekEvents);
      await page.screenshot({
        path: info.outputPath(`timeline-follow-restored-${viewport.width}.png`),
        animations: 'disabled', caret: 'hide', scale: 'css',
      });

      await page.waitForTimeout(500);
      await expect(status).toBeEmpty();
      await expect(follow).toBeChecked();
      await audio.evaluate(element => element.pause());
      await expect.poll(() => audio.evaluate(element => element.paused)).toBe(true);
      await audio.evaluate(element => { element.currentTime = 25; });
      await expect.poll(() => audio.evaluate(element => !element.seeking)).toBe(true);
      await expect.poll(async () => Math.abs((await inspect()).outputTime - 20)).toBeLessThan(0.1);
      await follow.uncheck();
      await expect(follow).not.toBeChecked();
      await expect(resume).toBeVisible();
      await timeline.scrollIntoViewIfNeeded();
      for (let swipe = 0; swipe < 3 && (await inspect()).visible; swipe++) await panTimeline(page, timeline, viewport.width, -800);
      await expect.poll(async () => !(await inspect()).visible).toBe(true);
      const pausedBeforeRestore = await inspect();
      await resume.click();
      await expect(follow).toBeChecked();
      await expect(status).toBeEmpty();
      await expect(resume).toHaveCount(0);
      await expect(timeline).toBeFocused();
      await expect.poll(async () => {
        const state = await inspect();
        return state.paused && state.visible
          && Math.abs(state.outputTime - state.time / 1.25) < 0.1
          && Math.abs(state.playheadX - state.width * 0.25) < 6
          && Math.abs(state.contentX - (state.axisWidth + state.time / 1.25 * state.zoom)) < 6
          && state.visibleViewportRatio >= 0.6;
      }).toBe(true);
      const pausedAfterRestore = await inspect();
      expect(pausedAfterRestore.visibleViewportRatio).toBeGreaterThanOrEqual(0.6);
      expect(Math.abs(pausedAfterRestore.time - pausedBeforeRestore.time)).toBeLessThan(0.05);
      expect(pausedAfterRestore.rate).toBe(pausedBeforeRestore.rate);
      expect(pausedAfterRestore.source).toBe(pausedBeforeRestore.source);
      expect(pausedAfterRestore.seekEvents).toBe(pausedBeforeRestore.seekEvents);

      await page.waitForTimeout(500);
      await expect(status).toBeEmpty();
      await panTimeline(page, timeline, viewport.width, 800);
      await expect(status).toContainText('Auto-follow paused while browsing');
      await expect(resume).toBeVisible();
      const pausedAfterManualPan = await inspect();
      expect(pausedAfterManualPan.paused).toBe(true);
      expect(Math.abs(pausedAfterManualPan.time - pausedAfterRestore.time)).toBeLessThan(0.05);
      expect(pausedAfterManualPan.seekEvents).toBe(pausedAfterRestore.seekEvents);
    });
  });
}
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test.describe(`reference octave guides ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width === 390, hasTouch: true });
    let jobId: number | undefined;
    test.afterEach(async ({ page }) => {
      if (jobId === undefined) return;
      await page.goto('about:blank');
      const response = await page.request.delete(`/api/jobs/${jobId}`, { headers: { Origin: process.env.E2E_BASE_URL! } });
      expect(response.status()).toBe(204);
      jobId = undefined;
    });

    test('shows noninteractive octave references without duplicating primary pitch or changing playback', async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.goto('/');
      await createSeededPitchJob(page, id => { jobId = id; });
      await page.reload();

      const view = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
      const timeline = view.getByRole('region', { name: 'Scrollable vocal melody timeline', exact: true });
      const audio = view.locator('audio:not([hidden])');
      await audio.evaluate(element => { element.preload = 'auto'; element.load(); });
      await expect.poll(() => audio.evaluate(element => Number.isFinite(element.duration) && element.duration > 30 && element.seekable.length > 0)).toBe(true);
      await audio.evaluate(element => { element.currentTime = 13.5; });
      await expect.poll(() => audio.evaluate(element => Math.abs(element.currentTime - 13.5))).toBeLessThan(0.1);
      await expect.poll(() => audio.evaluate(element => !element.seeking)).toBe(true);
      await expect.poll(async () => Number(await view.getByRole('slider', { name: 'Pitch timeline position' }).getAttribute('aria-valuenow'))).toBeCloseTo(10.8, 1);
      await audio.evaluate(element => {
        const media = element as HTMLAudioElement & { __octaveGuideSeekEvents: number };
        media.__octaveGuideSeekEvents = 0;
        media.addEventListener('seeking', () => { media.__octaveGuideSeekEvents++; });
      });
      await audio.evaluate(element => element.play());
      await expect.poll(() => audio.evaluate(element => !element.paused)).toBe(true);
      const toggle = view.getByRole('button', { name: 'Octave guides', exact: true });
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      const showPitches = view.locator('.timeline-karaoke-controls').getByRole('button', { name: 'Pitches', exact: true });
      await showPitches.click();
      const lyricPitch = view.getByRole('region', { name: 'Current karaoke line' }).locator('.timeline-karaoke-pitches').first();
      await expect(lyricPitch).toContainText('F4');
      const note = timeline.locator('.pitch-note').first();
      await expect(note).toHaveAttribute('data-note', 'F4');
      const pianoF4 = view.getByRole('button', { name: 'Piano F4', exact: true });
      await expect(pianoF4).toHaveAttribute('aria-pressed', 'true');
      const pianoKeyboard = view.getByRole('region', { name: 'Piano keyboard', exact: true });
      const activePiano = () => pianoKeyboard.locator('button[aria-pressed="true"]').evaluateAll(buttons =>
        buttons.map(button => button.getAttribute('aria-label')));
      await expect.poll(activePiano).toEqual(['Piano F4']);
      const follow = view.getByRole('checkbox', { name: 'Follow playback' });
      await expect(follow).toBeChecked();
      const guideLayer = timeline.locator('.pitch-octave-guides');
      await expect(guideLayer.locator('g[data-note]')).toHaveCount(0);

      const rectGeometry = (item: Locator) => item.locator('rect').evaluate(rect => {
        const box = (rect as SVGRectElement).getBBox();
        const client = rect.getBoundingClientRect();
        const viewportTop = rect.closest('.pitch-viewport')!.getBoundingClientRect().top;
        return {
          x: box.x, y: box.y, width: box.width, height: box.height,
          svgCenterY: box.y + box.height / 2,
          centerY: client.top + client.height / 2 - viewportTop,
        };
      });
      const axisCenter = async (name: string) => {
        const row = timeline.locator('.pitch-axis > div').filter({ hasText: new RegExp(`^${name}$`) });
        await expect(row).toHaveCount(1);
        return row.evaluate(element => {
          const box = element.getBoundingClientRect();
          const viewportTop = element.closest('.pitch-viewport')!.getBoundingClientRect().top;
          return box.top + box.height / 2 - viewportTop;
        });
      };
      const readGuide = async (name: string) => {
        const guide = guideLayer.locator(`g[data-note="${name}"]`).first();
        await expect(guide.locator('text')).toHaveText(name);
        const geometry = await rectGeometry(guide);
        expect(Math.abs(geometry.centerY - await axisCenter(name))).toBeLessThan(1);
        return geometry;
      };
      const semitoneHeight = await timeline.locator('.pitch-axis > div').first().evaluate(element => element.getBoundingClientRect().height);
      const primaryBefore = await rectGeometry(note);
      const verticalScroll = await timeline.evaluate(element => element.scrollTop);

      const before = await audio.evaluate(element => ({
        time: element.currentTime, wall: performance.now(), rate: element.playbackRate,
        source: element.currentSrc, paused: element.paused,
      }));

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(follow).toBeChecked();
      await expect(guideLayer).toHaveAttribute('aria-hidden', 'true');
      await expect(guideLayer).toHaveAttribute('pointer-events', 'none');
      await expect(guideLayer.locator('[tabindex],button,[role="button"]')).toHaveCount(0);
      const lowerGuide = await readGuide('F3');
      const upperGuide = await readGuide('F5');
      const primaryAfterGuides = await rectGeometry(note);
      expect(primaryAfterGuides.svgCenterY).toBe(primaryBefore.svgCenterY);
      expect(primaryAfterGuides.centerY).toBe(primaryBefore.centerY);
      expect(await timeline.evaluate(element => element.scrollTop)).toBe(verticalScroll);
      expect(lowerGuide.x).toBe(primaryBefore.x);
      expect(upperGuide.x).toBe(primaryBefore.x);
      expect(lowerGuide.width).toBe(primaryBefore.width);
      expect(upperGuide.width).toBe(primaryBefore.width);
      expect(lowerGuide.svgCenterY).toBeGreaterThan(primaryAfterGuides.svgCenterY);
      expect(upperGuide.svgCenterY).toBeLessThan(primaryAfterGuides.svgCenterY);
      expect(Math.abs((lowerGuide.svgCenterY - primaryAfterGuides.svgCenterY) - (primaryAfterGuides.svgCenterY - upperGuide.svgCenterY))).toBeLessThan(1);
      expect(Math.abs((lowerGuide.centerY - primaryAfterGuides.centerY) - 12 * semitoneHeight)).toBeLessThan(1);
      expect(Math.abs((primaryAfterGuides.centerY - upperGuide.centerY) - 12 * semitoneHeight)).toBeLessThan(1);
      const visual = await guideLayer.evaluate(layer => {
        const ghost = layer.querySelector('g[data-note="F3"] rect')!;
        const primary = layer.closest('.pitch-viewport')!.querySelector('.pitch-note rect')!;
        const fill = getComputedStyle(ghost).fill;
        return {
          fill,
          fillOpacity: Number(getComputedStyle(ghost).fillOpacity),
          primaryFillOpacity: Number(getComputedStyle(primary).fillOpacity),
          pointerEvents: getComputedStyle(layer).pointerEvents,
          color: fill.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [],
        };
      });
      expect(visual.color).toHaveLength(3);
      expect(visual.color[0]).toBeGreaterThanOrEqual(visual.color[1]);
      expect(visual.color[1]).toBeGreaterThan(visual.color[2]);
      expect(visual.color[0]).toBeGreaterThan(200);
      expect(visual.color[1]).toBeGreaterThan(180);
      expect(visual.color[2]).toBeGreaterThan(100);
      expect(visual.fillOpacity).toBeLessThan(visual.primaryFillOpacity);
      expect(visual.pointerEvents).toBe('none');
      expect(await rectGeometry(note)).toMatchObject({ x: primaryBefore.x, y: primaryBefore.y, width: primaryBefore.width });
      expect(await timeline.evaluate(element => element.scrollTop)).toBe(verticalScroll);
      await expect(note).toHaveAttribute('data-note', 'F4');
      await expect(lyricPitch).toContainText('F4');
      await expect(pianoF4).toHaveAttribute('aria-pressed', 'true');
      expect(await activePiano()).toEqual(['Piano F4']);

      const raise = view.getByRole('button', { name: 'Raise reference pitch one semitone', exact: true });
      await raise.click();
      await expect(note).toHaveAttribute('data-note', 'F#4');
      await expect(lyricPitch).toContainText('F#4');
      await expect(view.getByRole('button', { name: 'Piano F#4', exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect(await activePiano()).toEqual(['Piano F#4']);
      const primaryAfterShift = await rectGeometry(note);
      expect(primaryAfterShift.x).toBe(primaryBefore.x);
      expect(primaryAfterShift.width).toBe(primaryBefore.width);
      expect(primaryAfterShift.y).toBeLessThan(primaryBefore.y);
      expect(primaryAfterGuides.centerY - primaryAfterShift.centerY).toBeCloseTo(semitoneHeight, 1);
      expect(primaryAfterShift.centerY).toBeLessThan(primaryAfterGuides.centerY);
      const shiftedLow = await readGuide('F#3');
      const shiftedHigh = await readGuide('F#5');
      expect(shiftedLow.x).toBe(primaryAfterShift.x);
      expect(shiftedHigh.x).toBe(primaryAfterShift.x);
      expect(shiftedLow.width).toBe(primaryAfterShift.width);
      expect(shiftedHigh.width).toBe(primaryAfterShift.width);
      expect(shiftedLow.svgCenterY).toBeGreaterThan(primaryAfterShift.svgCenterY);
      expect(shiftedHigh.svgCenterY).toBeLessThan(primaryAfterShift.svgCenterY);
      expect(Math.abs((shiftedLow.svgCenterY - primaryAfterShift.svgCenterY) - (primaryAfterShift.svgCenterY - shiftedHigh.svgCenterY))).toBeLessThan(1);
      expect(Math.abs((shiftedLow.centerY - primaryAfterShift.centerY) - 12 * semitoneHeight)).toBeLessThan(1);
      expect(Math.abs((primaryAfterShift.centerY - shiftedHigh.centerY) - 12 * semitoneHeight)).toBeLessThan(1);
      expect(await timeline.evaluate(element => element.scrollTop)).toBe(verticalScroll);
      const captureGuide = async (name: string) => {
        const guide = guideLayer.locator(`g[data-note="${name}"]`).first();
        await timeline.scrollIntoViewIfNeeded();
        const beforeCapture = await rectGeometry(guide);
        await timeline.evaluate((element, centerY) => {
          element.scrollTop = Math.max(0, element.scrollTop + centerY - element.clientHeight / 2);
        }, beforeCapture.centerY);
        await expect.poll(async () => {
          const geometry = await rectGeometry(guide);
          const height = await timeline.evaluate(element => element.clientHeight);
          return geometry.centerY > 32 && geometry.centerY < height - 4;
        }).toBe(true);
        await page.screenshot({
          path: info.outputPath(`octave-guides-${viewport.width}-${name.replace('#', 'sharp')}.png`),
          animations: 'disabled',
        });
      };
      await captureGuide('F#3');
      await captureGuide('F#5');
      await timeline.scrollIntoViewIfNeeded();
      const primaryBeforeOff = await rectGeometry(note);
      const scrollBeforeOff = await timeline.evaluate(element => element.scrollTop);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await expect(guideLayer.locator('g[data-note]')).toHaveCount(0);
      await expect(note).toHaveAttribute('data-note', 'F#4');
      await expect(lyricPitch).toContainText('F#4');
      await expect(view.getByRole('button', { name: 'Piano F#4', exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect(await activePiano()).toEqual(['Piano F#4']);
      const primaryAfterOff = await rectGeometry(note);
      expect(primaryAfterOff.svgCenterY).toBe(primaryBeforeOff.svgCenterY);
      expect(primaryAfterOff.centerY).toBe(primaryBeforeOff.centerY);
      expect(await timeline.evaluate(element => element.scrollTop)).toBe(scrollBeforeOff);
      const after = await audio.evaluate(element => {
        const media = element as HTMLAudioElement & { __octaveGuideSeekEvents: number };
        const slider = document.querySelector('[aria-label="Pitch timeline position"]')!;
        return {
          time: media.currentTime, wall: performance.now(), rate: media.playbackRate,
          source: media.currentSrc, paused: media.paused, outputTime: Number(slider.getAttribute('aria-valuenow')),
          seekEvents: media.__octaveGuideSeekEvents,
        };
      });
      expect(after.paused).toBe(false);
      expect(after.time).toBeGreaterThan(before.time);
      expect(Math.abs((after.time - before.time) - (after.wall - before.wall) / 1000)).toBeLessThan(0.1);
      expect(after.rate).toBe(before.rate);
      expect(after.source).toBe(before.source);
      expect(after.seekEvents).toBe(0);
      expect(Math.abs(after.outputTime - after.time / 1.25)).toBeLessThan(0.1);
    });
  });
}



microphoneTest('reference transposition does not alter actual microphone pitch or trace', async ({ page, openPitchJob }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 329.6275569;
    gain.gain.value = 0.3;
    oscillator.connect(gain);
    oscillator.start();
    navigator.mediaDevices.getUserMedia = async () => {
      await context.resume();
      const destination = context.createMediaStreamDestination();
      gain.connect(destination);
      return destination.stream;
    };
  });
  await openPitchJob(true);
  const tuner = page.getByRole('region', { name: 'Live microphone pitch' });
  const view = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
  const audio = view.locator('audio[controls]');
  const trace = view.locator('.pitch-voice-trace');
  await tuner.getByRole('button', { name: 'Start microphone pitch detection' }).click();
  await expect(tuner.locator('.mic-tuner-reading')).toContainText('E4', { timeout: 12_000 });
  const guides = view.getByRole('button', { name: 'Octave guides', exact: true });
  await guides.click();
  await expect(guides).toHaveAttribute('aria-pressed', 'true');
  await expect(tuner.locator('.mic-tuner-reading')).toContainText('E4');
  await view.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => trace.evaluate(path => path.getBBox().width), { timeout: 12_000 }).toBeGreaterThan(0);
  await view.getByRole('button', { name: 'Pause', exact: true }).click();
  const originalTrace = await trace.getAttribute('d');
  await view.getByRole('button', { name: 'Raise reference pitch one octave', exact: true }).click();
  await expect(tuner.locator('.mic-tuner-reading')).toContainText('E4');
  await expect(trace).toHaveAttribute('d', originalTrace!);
});
