import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Locator } from '@playwright/test';
import { test } from './auth-fixture';
import type { JobDTO, SubmitResult } from '../src/api';
import { inspectAudio } from './audio';

interface StemSignalFixture {
  frequencyHz: number;
  durationSeconds: number;
}

const completeStemSignals: Record<string, StemSignalFixture> = {
  vocals: { frequencyHz: 330, durationSeconds: 20 },
  instruments: { frequencyHz: 220, durationSeconds: 16 },
  drums: { frequencyHz: 110, durationSeconds: 18 },
  bass: { frequencyHz: 150, durationSeconds: 22 },
  'other-instruments': { frequencyHz: 440, durationSeconds: 24 },
};

const seedTimelineJob = String.raw`
import json,os,subprocess,sys
from functools import partial
from pathlib import Path
from backend import config,db
from backend.pitch_reference import persist_pitch_vocals
from backend.queue import _persist_results
from separator.lyrics import transcript_from_json
from separator.pitch import pitch_from_json,pitch_to_json
from separator.stems import StemResult
assert config.QUEUE_CONCURRENCY == 0
assert config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
value=json.load(sys.stdin)
job=db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'queued' and job.modal_call_id is None
input_path=config.UPLOADS_DIR / str(job.id) / job.source_value
source=input_path.read_bytes()
if value.get('complete_outputs',False):
 from separator.processing import ProcessingContext,run_processing
 sys.path.insert(0,str(Path('tests').resolve()))
 from inference_fixture import StemSignal,cpu_inference,fixture_manifest
 assert job.options.detect_pitch and job.options.extract_lyrics
 assert set(job.options.output_labels)=={'vocals','instruments','drums','bass','other-instruments','drums-vocals'}
 root=config.DATA_DIR / 'synthetic-producers' / str(job.id)
 signals={label:StemSignal(signal['frequencyHz'],signal['durationSeconds']) for label,signal in value['stem_signals'].items()}
 producer=fixture_manifest(root,signals=signals,pitch=pitch_from_json(json.dumps(value['pitch'])),transcript=transcript_from_json(json.dumps(value['transcript'])))
 context=ProcessingContext(root / 'cache',producer,partial(cpu_inference,root=root))
 processed=run_processing(input_path,job.options,root / 'cold',context)
 def unexpected_inference(request,key):
  raise AssertionError('Warm graph must reuse its actual CPU-produced inference artifacts')
 warm=run_processing(input_path,job.options,root / 'warm',ProcessingContext(context.root,producer,unexpected_inference))
 assert {label:stem.data for label,stem in warm.audio.items()}=={label:stem.data for label,stem in processed.audio.items()}
 assert warm.pitch_json==processed.pitch_json
 assert warm.transcript.words==processed.transcript.words
 backgrounds=processed.audio
 if 'song' in job.options.result_labels:
  backgrounds={'song':StemResult(source,0),**backgrounds}
 assert set(backgrounds)==set(job.options.result_labels)
 manifest=_persist_results(job,backgrounds)
 db.mark_done(job.id,manifest,processed.transcript,processed.pitch_json)
else:
 # Historical partial jobs intentionally retain stored analysis and no public
 # vocal output; loading them must not need producer provenance or credentials.
 converted=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i','pipe:0','-t','20','-codec:a','libmp3lame','-f','mp3','pipe:1'],input=source,capture_output=True,check=True).stdout
 persist_pitch_vocals(job,converted)
 backgrounds={}
 for label,frequency,duration in [('instruments',220,16),('drums',80,18)]:
  wav=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i',f'sine=frequency={frequency}:duration={duration}:sample_rate=24000','-f','wav','pipe:1'],capture_output=True,check=True).stdout
  backgrounds[label]=StemResult(wav,0)
 manifest=_persist_results(job,backgrounds)
 db.mark_done(job.id,manifest,None,pitch_to_json(pitch_from_json(json.dumps(value['pitch']))))
`;

const corruptPrivateReference = String.raw`
import os,sys
from pathlib import Path
from backend import config,db
assert config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
job=db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'done'
(config.RESULTS_DIR / str(job.id) / '.pitch-vocals.mp3').write_bytes(b'corrupt listening reference')
`;

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test.describe(`native timeline ${viewport.width}px`, () => {
  test.use({ viewport, isMobile: viewport.width <= 700, hasTouch: true });
  test('ruler, footer transport, manual browsing, and immediate tooltips', async ({ page, browser }, info) => {
    test.setTimeout(120_000);
    expect(process.env.QUEUE_CONCURRENCY).toBe('0');
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg'));
    const fixture = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8');
    const submitted = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
      file: { name: 'auld-lang-syne-full.ogg', mimeType: 'audio/ogg', buffer: source },
      detect_pitch: 'true', pitch_semitones: '1.25', tempo_percent: '125',
    } });
    expect(submitted.ok()).toBe(true);
    const id = (await submitted.json()).id as number;
    execFileSync('uv', ['run', 'python', '-c', seedTimelineJob, String(id)], {
      cwd: process.env.E2E_REPO_ROOT!, input: fixture,
      env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    await page.reload();

    const view = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
    await expect(view).toBeVisible();
    const player = view.locator('audio:not([hidden])');
    const scroll = view.getByRole('region', { name: 'Scrollable vocal melody timeline', exact: true });
    const backgrounds = view.getByRole('group', { name: 'Pitch background audio' });
    const back = view.getByRole('button', { name: 'Back 5 seconds', exact: true });
    const forward = view.getByRole('button', { name: 'Forward 5 seconds', exact: true });
    const playButton = view.getByRole('button', { name: 'Play', exact: true });
    const pauseButton = view.getByRole('button', { name: 'Pause', exact: true });
    const activate = async (button: Locator) => viewport.width <= 700 ? button.tap() : button.click();
    const switchBackground = async (name: string | RegExp) => {
      const button = backgrounds.getByRole('button', { name });
      await activate(button);
      await expect(button).toHaveAttribute('aria-pressed', 'true');
    };
    const graphBounds = (await view.locator('.pitch-viewport').boundingBox())!;
    const playerBounds = (await player.boundingBox())!;
    expect(playerBounds.y).toBeGreaterThanOrEqual(graphBounds.y + graphBounds.height);
    const selectionBounds = (await view.locator('.pitch-selection').boundingBox())!;
    const karaokeBounds = (await view.getByRole('region', { name: 'Current karaoke line' }).boundingBox())!;
    const transportBounds = (await view.getByRole('group', { name: 'Timeline playback' }).boundingBox())!;
    const backBounds = (await back.boundingBox())!;
    const playBounds = (await playButton.boundingBox())!;
    const forwardBounds = (await forward.boundingBox())!;
    expect(transportBounds.y).toBeGreaterThanOrEqual(selectionBounds.y + selectionBounds.height);
    expect(transportBounds.y + transportBounds.height).toBeLessThanOrEqual(karaokeBounds.y);
    expect(playBounds.x).toBeGreaterThanOrEqual(backBounds.x + backBounds.width);
    expect(playBounds.x + playBounds.width).toBeLessThanOrEqual(forwardBounds.x);
    await player.evaluate(element => { element.volume = 0.4; });
    const ruler = view.getByRole('slider', { name: 'Pitch timeline position' });
    await view.getByRole('slider', { name: 'Melody zoom' }).fill('40');
    const tapRulerAtFiveSeconds = async () => {
      // Forward playback can put five seconds underneath the sticky note axis.
      // Reveal it with the real ruler keyboard action before testing a pointer seek.
      await ruler.press('Home');
      await ruler.scrollIntoViewIfNeeded();
      const target = () => ruler.evaluate(element => {
        const box = element.getBoundingClientRect();
        const axis = element.querySelector('.pitch-axis-corner')!.getBoundingClientRect();
        const viewport = element.closest('.pitch-viewport')!.getBoundingClientRect();
        const x = box.x + 54 + 5 * 40;
        const y = box.y + box.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x, y, axisRight: axis.right, viewportRight: viewport.right,
          visible: x > axis.right && x < viewport.right && y > viewport.top && y < viewport.bottom,
          hitsRuler: hit !== null && element.contains(hit) && !hit.closest('.pitch-axis-corner'),
        };
      });
      await expect.poll(async () => {
        const point = await target();
        return point.visible && point.hitsRuler;
      }).toBe(true);
      const point = await target();
      expect(point.visible && point.hitsRuler).toBe(true);
      await info.attach('playing-ruler-target', { body: Buffer.from(JSON.stringify(point)), contentType: 'application/json' });
      if (viewport.width <= 700) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
    };
    await player.evaluate(element => { element.preload = 'auto'; element.load(); });
    await expect.poll(() => player.evaluate(element => Number.isFinite(element.duration)
      && element.duration > 10 && element.seekable.length > 0)).toBe(true);
    // Native controls have closed shadow DOM; currentTime triggers their real
    // seeking/seeked events without claiming an automated slider gesture.
    const follow = view.getByRole('checkbox', { name: 'Follow playback' });
    await follow.uncheck();
    await player.evaluate(element => { element.currentTime = 37.5; });
    await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await expect.poll(async () => Number(await ruler.getAttribute('aria-valuenow'))).toBeCloseTo(30, 1);
    expect(await follow.isChecked()).toBe(false);
    await player.evaluate(element => { element.currentTime = 0; });
    await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBe(0);
    await follow.check();
    const competingAudio = page.getByRole('link', { name: 'Download original', exact: true }).locator('..').locator('audio');
    await competingAudio.evaluate(audio => { audio.preload = 'auto'; audio.load(); });
    await expect.poll(() => competingAudio.evaluate(audio => Number.isFinite(audio.duration)
      && audio.duration > 10 && audio.seekable.length > 0)).toBe(true);
    await competingAudio.evaluate(audio => audio.play());
    await expect.poll(() => competingAudio.evaluate(audio => !audio.paused)).toBe(true);
    for (const target of [scroll, ruler]) {
      await scroll.scrollIntoViewIfNeeded();
      await target.focus();
      const before = await scroll.evaluate(element => ({ page: scrollY, top: element.scrollTop, left: element.scrollLeft }));
      const start = await player.evaluate(element => element.currentTime);
      await page.keyboard.down('Space');
      await expect.poll(() => player.evaluate(element => !element.paused)).toBe(true);
      await expect.poll(() => competingAudio.evaluate(element => element.paused)).toBe(true);
      await page.keyboard.down('Space'); // Browser-generated repeat=true.
      await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(start + 0.3);
      await page.keyboard.up('Space');
      await target.press('Space');
      await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
      expect(await scroll.evaluate(element => ({ page: scrollY, top: element.scrollTop, left: element.scrollLeft }))).toEqual(before);
    }
    await competingAudio.evaluate(audio => audio.play());
    const buttonStart = await player.evaluate(element => element.currentTime);
    await activate(playButton);
    await expect(pauseButton).toBeVisible();
    await expect.poll(() => competingAudio.evaluate(element => element.paused)).toBe(true);
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(buttonStart + 0.3);
    // An external/native stop must update the app-owned action, too.
    await competingAudio.evaluate(audio => audio.play());
    await expect(playButton).toBeVisible();
    await activate(playButton);
    await activate(pauseButton);
    await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
    await playButton.focus();
    await playButton.press('Space');
    await expect.poll(() => player.evaluate(element => !element.paused)).toBe(true);
    await expect.poll(() => competingAudio.evaluate(audio => audio.paused)).toBe(true);
    await activate(forward);
    expect(await player.evaluate(element => !element.paused)).toBe(true);
    expect(await competingAudio.evaluate(element => element.paused)).toBe(true);
    await tapRulerAtFiveSeconds();
    const songSeek = await player.evaluate(element => {
      const state = { time: element.currentTime, playing: !element.paused };
      element.pause();
      return state;
    });
    expect(songSeek.playing).toBe(true);
    expect(songSeek.time).toBeCloseTo(6.25, 1);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1'))).toBeGreaterThan(195);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1'))).toBeLessThan(205);
    // Hold the real private-reference request while the original keeps playing.
    const releaseReference = Promise.withResolvers<void>();
    const referenceRequested = Promise.withResolvers<void>();
    const privateRoute = `**/api/jobs/${id}/pitch-reference/vocals?playback=1`;
    await page.route(privateRoute, async route => {
      referenceRequested.resolve();
      await releaseReference.promise;
      await route.continue();
    });
    await activate(playButton);
    const beforeLoad = await player.evaluate(element => element.currentTime);
    await activate(backgrounds.getByRole('button', { name: 'Just vocals' }));
    await referenceRequested.promise;
    await expect(backgrounds.getByRole('button', { name: 'Full song' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(beforeLoad + 0.3);
    expect(await player.evaluate(element => !element.paused)).toBe(true);
    const originalAtHandoff = await player.evaluate(element => element.currentTime);
    releaseReference.resolve();
    await expect(backgrounds.getByRole('button', { name: 'Just vocals' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => player.evaluate(element => !element.paused)).toBe(true);
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(originalAtHandoff / 1.25 - 0.15);
    await activate(pauseButton);
    await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
    await page.unroute(privateRoute);
    // Restore the existing paused-clock checks with a real native seek.
    await player.evaluate(element => { element.currentTime = 5; });

    await switchBackground('Just vocals');
    await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
    await expect(playButton).toBeVisible();
    await expect.poll(() => player.evaluate(element => Number.isFinite(element.duration)
      && element.duration > 10 && element.seekable.length > 0)).toBe(true);
    await expect.poll(() => player.evaluate(element => Math.abs(element.currentTime - 5) < 0.1)).toBe(true);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1'))).toBeGreaterThan(195);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1'))).toBeLessThan(205);
    await activate(forward);
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(10, 1);
    await activate(back);
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(5, 1);
    expect(await player.evaluate(element => element.paused)).toBe(true);

    await switchBackground('Full song');
    await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
    await expect.poll(() => player.evaluate(element => Number.isFinite(element.duration)
      && element.duration > 10 && element.seekable.length > 0)).toBe(true);
    await expect.poll(() => player.evaluate(element => Math.abs(element.currentTime - 6.25) < 0.1)).toBe(true);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1'))).toBeGreaterThan(195);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1'))).toBeLessThan(205);
    await activate(back);
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(1.25, 1);
    await activate(back);
    expect(await player.evaluate(element => element.currentTime)).toBe(0);
    await activate(forward);
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(5, 1);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1')) / 40).toBeCloseTo(4, 1);
    expect(await player.evaluate(element => element.paused && element.volume === 0.4)).toBe(true);
    // A second choice supersedes a still-loading first choice without stopping
    // the current audio or allowing a late request to change the selection.
    const releaseDrums = Promise.withResolvers<void>();
    const drumsRequested = Promise.withResolvers<void>();
    const drumsRoute = `**/api/jobs/${id}/results/drums?playback=1`;
    await page.route(drumsRoute, async route => {
      drumsRequested.resolve();
      await releaseDrums.promise;
      await route.abort().catch(() => {}); // Superseded requests may already be cancelled.
    });
    await activate(playButton);
    await activate(backgrounds.getByRole('button', { name: /^Drums only/ }));
    await drumsRequested.promise;
    await switchBackground(/^Instruments/);
    await expect.poll(() => player.evaluate(element => !element.paused)).toBe(true);
    releaseDrums.resolve();
    await page.unroute(drumsRoute);
    await expect(backgrounds.getByRole('button', { name: /^Instruments/ })).toHaveAttribute('aria-pressed', 'true');
    await activate(pauseButton);
    await switchBackground('Full song');
    // Another app player cancels an in-flight handoff; its later stop must not
    // cause the original to resume or a stale candidate to take over.
    const releaseExternal = Promise.withResolvers<void>();
    const externalRequested = Promise.withResolvers<void>();
    await page.route(drumsRoute, async route => {
      externalRequested.resolve();
      await releaseExternal.promise;
      await route.abort().catch(() => {}); // Cancellation can close the request first.
    });
    await activate(playButton);
    await activate(backgrounds.getByRole('button', { name: /^Drums only/ }));
    await externalRequested.promise;
    await competingAudio.evaluate(element => element.play());
    await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
    releaseExternal.resolve();
    await expect(backgrounds.getByRole('button', { name: 'Full song' })).toHaveAttribute('aria-pressed', 'true');
    expect(await player.evaluate(element => element.paused)).toBe(true);
    expect(await competingAudio.evaluate(element => !element.paused)).toBe(true);
    await page.unroute(drumsRoute);
    await competingAudio.evaluate(element => element.pause());
    expect(await player.evaluate(element => element.paused)).toBe(true);

    let outputTime = await player.evaluate(element => element.currentTime / 1.25);
    const backgroundProof = [];
    for (const [label, expectedDuration] of [['instruments', 12.8], ['drums', 14.4]] as const) {
      await switchBackground(label === 'instruments' ? /^Instruments/ : /^Drums only/);
      await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
      await expect(playButton).toBeVisible();
      await expect.poll(() => player.evaluate(element => element.duration)).toBeCloseTo(expectedDuration, 1);
      await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(outputTime, 1);
      await competingAudio.evaluate(element => element.play());
      const beforePlay = await player.evaluate(element => element.currentTime);
      await activate(playButton);
      await expect.poll(() => competingAudio.evaluate(element => element.paused)).toBe(true);
      await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(beforePlay + 0.3);
      await activate(pauseButton);
      await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
      outputTime = await player.evaluate(element => element.currentTime);
      expect(await player.evaluate(element => element.volume)).toBe(0.4);
      expect(await view.getByLabel('Pitch vocal stem', { exact: true }).inputValue()).toBe('vocals');
      backgroundProof.push({ label, duration: await player.evaluate(element => element.duration), beforePlay, pausedAt: outputTime });
    }
    await switchBackground('Full song');
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(outputTime * 1.25, 1);
    expect(await player.evaluate(element => element.paused)).toBe(true);
    await info.attach('native-accompaniment-backgrounds', { body: Buffer.from(JSON.stringify(backgroundProof)), contentType: 'application/json' });

    const note = view.locator('.pitch-note').first();

    await note.scrollIntoViewIfNeeded();
    if (viewport.width <= 700) await note.tap();
    else await note.hover();
    const noteTooltip = page.getByRole('tooltip');
    await expect(noteTooltip).toBeVisible();
    await expect(noteTooltip.locator('.pitch-tooltip-note')).toHaveText('F4');
    await expect(noteTooltip.locator('.pitch-tooltip-lyrics')).toHaveText('Should');
    await expect(noteTooltip).not.toContainText(/confidence|approximate|0:10|model/i);

    const wordIndex = JSON.parse(fixture).pitch.tracks[0].notes[0].word_indices[0] as number;
    const word = view.locator('.pitch-word').nth(wordIndex);
    await expect(word).toHaveText('Should');
    await word.scrollIntoViewIfNeeded();
    if (viewport.width <= 700) await word.tap();
    else await word.hover();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const wordTooltip = page.getByRole('tooltip');
    await expect(wordTooltip).toBeVisible();
    await expect(wordTooltip).toHaveText('Should');
    await expect(wordTooltip).not.toContainText(/F4|confidence|approximate|0:10|model/i);
    await note.focus();
    await note.press('Space');
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeCloseTo(Number(await note.getAttribute('data-start')) * 1.25, 1);
    expect(await player.evaluate(element => element.paused)).toBe(true);
    await word.focus();
    await word.press('Space');
    await expect(view.locator('.pitch-selection')).toContainText('Should');
    await expect(view.locator('.pitch-note-selected')).toHaveCount(3);
    expect(await player.evaluate(element => element.paused)).toBe(true);

    // Real playback must not immediately undo a user's horizontal browsing.
    await view.getByRole('slider', { name: 'Melody zoom', exact: true }).fill('640');
    const touch = viewport.width <= 700 ? await page.context().newCDPSession(page) : null;
    const afterPanSettles = async (input: () => Promise<void>) => {
      const settled = await scroll.evaluateHandle(element => {
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
      try {
        await input();
        await expect.poll(() => settled.evaluate(value => value.state.done)).toBe(true);
      } finally {
        await settled.evaluate(value => value.stop());
        await settled.dispose();
      }
    };
    const playheadGeometry = () => scroll.evaluate(element => {
      const viewport = element.getBoundingClientRect();
      const axis = element.querySelector('.pitch-axis')!.getBoundingClientRect();
      const x = element.querySelector('.pitch-playhead')!.getBoundingClientRect().x;
      const right = viewport.left + element.clientLeft + element.clientWidth;
      return { x, axisRight: axis.right, right, visible: x >= axis.right && x < right };
    });
    const pan = async (distance: number, stopAtPlayhead = false) => {
      await scroll.scrollIntoViewIfNeeded();
      if (touch) {
        const box = (await scroll.boundingBox())!;
        const target = await scroll.evaluate((element, delta) => element.scrollLeft + delta, distance);
        for (;;) {
          // Returning is complete after the first settled swipe that reveals
          // the cursor; another swipe would be a new manual opt-out.
          if (stopAtPlayhead && (await playheadGeometry()).visible) break;
          const remaining = target - await scroll.evaluate(element => element.scrollLeft);
          if (Math.abs(remaining) < 40) break;
          const stroke = Math.sign(remaining) * Math.min(Math.abs(remaining), box.width - 102);
          const start = stroke > 0 ? box.x + box.width - 24 : box.x + 78;
          const y = box.y + box.height / 2;
          await afterPanSettles(async () => {
            await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y, id: 1 }] });
            const origin = await scroll.evaluate(element => element.scrollLeft);
            for (let step = 1; step <= 8; step++) {
              await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start - stroke * step / 8, y, id: 1 }] });
              await page.evaluate(() => {
                const { promise, resolve } = Promise.withResolvers<void>();
                requestAnimationFrame(() => resolve());
                return promise;
              });
            }
            // A deliberate stationary finger before release avoids flinging.
            await page.waitForTimeout(150);
            const current = await scroll.evaluate(element => element.scrollLeft);
            await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            expect(Math.sign(stroke) * (current - origin)).toBeGreaterThan(0);
          });
        }
      } else {
        await scroll.hover();
        await afterPanSettles(() => page.mouse.wheel(distance, 0));
      }
    };
    // Observe the real playhead crossing three quarters of the visible note
    // region, rather than waiting until it reaches the viewport's far edge.
    await player.evaluate(async element => { element.currentTime = 0; await element.play(); });
    await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBe(0);
    await player.evaluate(element => element.pause());
    const nativeCrossing = await scroll.evaluate(element =>
      (element.clientWidth - element.querySelector('.pitch-axis')!.getBoundingClientRect().width) * 0.75 / 640 * 1.25);
    await player.evaluate((element, seconds) => { element.currentTime = Math.max(0, seconds - 0.25); }, nativeCrossing);
    await expect.poll(() => player.evaluate(element => element.seeking)).toBe(false);
    const crossingTrace = await scroll.evaluateHandle(element => {
      const origin = element.scrollLeft;
      const width = element.clientWidth - element.querySelector('.pitch-axis')!.getBoundingClientRect().width;
      const line = element.querySelector('.pitch-playhead')!;
      const state = { done: false, samples: [] as { fraction: number; left: number }[] };
      const sample = () => {
        state.samples.push({ fraction: (Number(line.getAttribute('x1')) - origin) / width, left: element.scrollLeft });
        if (element.scrollLeft > origin) state.done = true;
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      return state;
    });
    await activate(playButton);
    await expect.poll(() => crossingTrace.evaluate(state => state.done)).toBe(true);
    await activate(pauseButton);
    const crossingSamples = await crossingTrace.evaluate(state => state.samples);
    await crossingTrace.dispose();
    const lastBefore = crossingSamples.at(-2)!;
    const firstAfter = crossingSamples.at(-1)!;
    expect(lastBefore.fraction).toBeGreaterThan(0.5);
    expect(lastBefore.fraction).toBeLessThanOrEqual(0.75);
    expect(firstAfter.fraction).toBeGreaterThan(0.75);
    expect(firstAfter.fraction).toBeLessThan(1);
    expect(firstAfter.left).toBeGreaterThan(lastBefore.left);
    await info.attach('native-three-quarter-follow', {
      body: Buffer.from(JSON.stringify({ viewport, nativeCrossing, lastBefore, firstAfter })),
      contentType: 'application/json',
    });

    await player.evaluate(async element => { element.currentTime = 6.25; await element.play(); });
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(6.3);
    await scroll.scrollIntoViewIfNeeded();
    const beforePan = await scroll.evaluate(element => element.scrollLeft);
    await pan(1200);
    await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(beforePan + 800);
    // Establish the cursor strictly before a browsed window, even if it outran
    // several narrow-screen swipes while playing.
    await player.evaluate(element => element.pause());
    const nativeBefore = await player.evaluate(element => element.currentTime);
    const ahead = nativeBefore / 1.25 * 640 + 640;
    await pan(ahead - await scroll.evaluate(element => element.scrollLeft));
    const manuallyChosen = await scroll.evaluate(element => element.scrollLeft);
    const axisWidth = await view.locator('.pitch-axis').evaluate(element => element.getBoundingClientRect().width);
    const enterNative = manuallyChosen / 640 * 1.25;
    const leaveNative = (manuallyChosen + await scroll.evaluate(element => element.clientWidth) - axisWidth) / 640 * 1.25;
    expect(nativeBefore).toBeLessThan(enterNative);
    await player.evaluate(element => element.play());
    let nativeEntered = 0;
    await expect.poll(async () => {
      const current = await player.evaluate(element => element.currentTime);
      if (current >= enterNative && current < leaveNative) nativeEntered = current;
      return nativeEntered;
    }, { intervals: [25] }).toBeGreaterThan(0);
    expect(Math.abs(await scroll.evaluate(element => element.scrollLeft) - manuallyChosen)).toBeLessThan(2);
    await expect.poll(() => player.evaluate(element => element.currentTime), { timeout: 10_000 }).toBeGreaterThan(leaveNative + 0.3);
    await player.evaluate(element => element.pause());
    const afterPlayback = await scroll.evaluate(element => element.scrollLeft);
    await info.attach('native-browsing-passage', { body: Buffer.from(JSON.stringify({
      viewport, nativeBefore, enterNative, nativeEntered, leaveNative,
      nativePassed: await player.evaluate(element => element.currentTime), manuallyChosen, afterPlayback,
    })), contentType: 'application/json' });
    expect(Math.abs(afterPlayback - manuallyChosen)).toBeLessThan(2);
    // Paused panning and subsequent playback/skip actions cannot opt back in.
    await pan(-600);
    await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeLessThan(manuallyChosen - 500);
    const pausedChoice = await scroll.evaluate(element => element.scrollLeft);
    await activate(playButton);
    await expect.poll(() => player.evaluate(element => !element.paused)).toBe(true);
    await activate(forward);
    expect(await player.evaluate(element => !element.paused && element.volume === 0.4)).toBe(true);
    expect(await competingAudio.evaluate(element => element.paused)).toBe(true);
    expect(await scroll.evaluate(element => element.scrollLeft)).toBe(pausedChoice);
    await scroll.focus();
    await scroll.press('Space');
    await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
    const currentOutput = await player.evaluate(element => element.currentTime / 1.25);
    const returnTo = currentOutput * 640 - (await scroll.evaluate(element => element.clientWidth) - 54) / 2;
    const beforeReturn = await playheadGeometry();
    expect(beforeReturn.visible).toBe(false);
    await pan(returnTo - pausedChoice, true);
    const afterReturn = await playheadGeometry();
    expect(afterReturn.visible).toBe(true);
    const returned = await scroll.evaluate(element => element.scrollLeft);
    const returnNative = await player.evaluate(element => element.currentTime);
    await player.evaluate(element => element.play());
    await expect.poll(() => player.evaluate(element => element.currentTime)).toBeGreaterThan(returnNative + 0.3);
    await expect.poll(() => scroll.evaluate(element => element.scrollLeft), { timeout: 10_000 }).toBeGreaterThan(returned + 50);
    await info.attach('native-manual-return', { body: Buffer.from(JSON.stringify({
      viewport, beforeReturn, afterReturn, returned, returnNative,
      resumedNative: await player.evaluate(element => element.currentTime),
      resumedLeft: await scroll.evaluate(element => element.scrollLeft),
    })), contentType: 'application/json' });
    await view.getByRole('checkbox', { name: 'Follow playback' }).uncheck();
    const optedOut = await scroll.evaluate(element => element.scrollLeft);
    await activate(forward);
    expect(await scroll.evaluate(element => element.scrollLeft)).toBe(optedOut);
    await player.evaluate(element => element.pause());
    // Skipping clamps at the actual active media duration, not the analysis end.
    await ruler.press('End');
    await activate(forward);
    await expect.poll(() => player.evaluate(element => Math.abs(element.currentTime - element.duration))).toBeLessThan(0.05);
    expect(await player.evaluate(element => element.paused)).toBe(true);
    await expect(backgrounds.getByRole('button', { name: 'Full song' })).toHaveAttribute('aria-pressed', 'true');
    expect(await view.getByLabel('Pitch vocal stem', { exact: true }).inputValue()).toBe('vocals');
    for (const button of [back, playButton, forward]) {
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => innerWidth)).toBe(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await view.locator('.pitch-footer').screenshot({ path: info.outputPath('timeline-footer.png') });
    // A failed replacement must leave the original playing and selected. A
    // fresh owner context avoids a cached, previously decoded private reference.
    execFileSync('uv', ['run', 'python', '-c', corruptPrivateReference, String(id)], {
      cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    const errorContext = await browser.newContext({
      storageState: await page.context().storageState(), baseURL: process.env.E2E_BASE_URL,
      viewport, isMobile: viewport.width <= 700, hasTouch: true,
    });
    try {
      const errorPage = await errorContext.newPage();
      await errorPage.goto('/');
      const errorView = errorPage.getByRole('region', { name: 'Karaoke with pitches', exact: true });
      const failedPlayer = errorView.locator('audio:not([hidden])');
      await activate(errorView.getByRole('button', { name: 'Play', exact: true }));
      await expect.poll(() => failedPlayer.evaluate(audio => audio.currentTime)).toBeGreaterThan(0.3);
      const beforeFailure = await failedPlayer.evaluate(audio => audio.currentTime);
      const failedResponse = errorPage.waitForResponse(response =>
        response.url().includes(`/api/jobs/${id}/pitch-reference/vocals`) && response.request().method() === 'GET');
      await activate(errorView.getByRole('group', { name: 'Pitch background audio' }).getByRole('button', { name: 'Just vocals' }));
      expect((await failedResponse).status()).toBe(503);
      await expect(errorView.getByRole('alert')).toBeVisible();
      await expect(errorView.getByRole('group', { name: 'Pitch background audio' }).getByRole('button', { name: 'Full song' })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => failedPlayer.evaluate(audio => audio.currentTime)).toBeGreaterThan(beforeFailure + 0.3);
      expect(await failedPlayer.evaluate(audio => !audio.paused)).toBe(true);
      await errorView.getByRole('button', { name: 'Pause', exact: true }).press('Enter');
      await expect.poll(() => failedPlayer.evaluate(audio => audio.paused)).toBe(true);
    } finally { await errorContext.close(); }
    await touch?.detach();
  });
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`complete karaoke backgrounds ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width <= 700, hasTouch: true });
    test('one karaoke selection publishes playable backgrounds and downloadable public stems', async ({ page }, info) => {
      test.setTimeout(120_000);
      expect(process.env.QUEUE_CONCURRENCY).toBe('0');
      const sourcePath = resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg');
      const source = await readFile(sourcePath);
      const fixture = JSON.parse(await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8'));
      const activate = async (control: Locator) => viewport.width <= 700 ? control.tap() : control.click();
      await page.goto('/');
      await activate(page.getByRole('button', { name: 'Upload audio', exact: true }));
      const analyzed = page.waitForResponse(response => response.url().endsWith('/api/key-analysis') && response.request().method() === 'POST');
      await page.getByLabel('Audio file', { exact: true }).setInputFiles(sourcePath);
      expect((await analyzed).status()).toBe(200);
      if (viewport.width <= 700) await activate(page.getByRole('tab', { name: 'Adjust', exact: true }));
      await page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' }).fill('1.25');
      await page.getByRole('spinbutton', { name: 'Tempo (% of original)' }).fill('125');
      if (viewport.width <= 700) await activate(page.getByRole('tab', { name: 'Outputs', exact: true }));
      await page.getByRole('checkbox', { name: 'Karaoke with pitches', exact: true }).check();
      for (const name of ['Extract vocals', 'Extract lyrics', 'Lyrics with pitches', 'Extract instruments', 'Split drums, bass & other instruments']) {
        const dependency = page.getByRole('checkbox', { name, exact: true });
        await expect(dependency).toBeChecked();
        await expect(dependency).toBeDisabled();
      }
      const submitted = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
      await activate(page.getByRole('button', { name: 'Process audio', exact: true }));
      const response = await submitted;
      expect(response.status()).toBe(200);
      const created = await response.json() as SubmitResult;
      const queuedResponse = await page.request.get(`/api/jobs/${created.id}`);
      expect(queuedResponse.ok()).toBe(true);
      const queued = await queuedResponse.json() as JobDTO;
      expect(queued.options).toMatchObject({
        detect_pitch: true, extract_vocals: true, extract_lyrics: true, extract_pitched_lyrics: true,
        extract_instruments: true, drums: true, mixes: [],
        pitch_semitones: 1.25, tempo_percent: 125,
      });
      const tempoRate = queued.options.tempo_percent / 100;
      const pitchScale = 2 ** (queued.options.pitch_semitones / 12);
      // Only the neural producer boundary is seeded. Real submitted options,
      // DSP, persistence, owner HTTP routes, downloads and native media run below.
      execFileSync('uv', ['run', 'python', '-c', seedTimelineJob, String(queued.id)], {
        cwd: process.env.E2E_REPO_ROOT!,
        input: JSON.stringify({ ...fixture, complete_outputs: true, stem_signals: completeStemSignals }),
        env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
      });
      const completedResponse = await page.request.get(`/api/jobs/${queued.id}`);
      expect(completedResponse.ok()).toBe(true);
      const completed = await completedResponse.json() as JobDTO;
      const labels = ['song', 'vocals', 'instruments', 'drums', 'bass', 'other-instruments', 'drums-vocals'];
      expect(completed.status).toBe('done');
      expect(completed.manifest?.map(stem => stem.label).sort()).toEqual([...labels].sort());
      await page.reload();
      const history = page.getByRole('heading', { name: 'History', exact: true }).locator('..');
      const historyCard = history.locator('.rounded-lg').filter({ has: page.locator(`a[href="/api/jobs/${queued.id}/pitch"]`) });
      await activate(page.getByRole('button', { name: 'Start another job', exact: true }));
      await expect(history.getByRole('region', { name: 'Lyrics with pitches', exact: true })).toHaveCount(0);
      await expect(historyCard.locator('a[href*="/results/"]')).toHaveCount(0);
      await expect(historyCard.locator('a[href$="/original"]')).toHaveCount(0);
      await expect(history.getByRole('region', { name: 'Lyrics transcript', exact: true })).toHaveCount(0);
      expect(completed.transcript?.timestamped_text?.length).toBeGreaterThan(0);
      await expect(history).not.toContainText(completed.transcript!.timestamped_text!);
      await history.screenshot({ path: info.outputPath('compact-history.png') });
      await activate(historyCard.getByRole('button', { name: 'View Karaoke with pitches', exact: true }));

      const view = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
      await expect(view).toBeVisible();
      const results = page.getByRole('heading', { name: 'Results', exact: true }).locator('../..');
      const pitchedLyrics = results.getByRole('region', { name: 'Lyrics with pitches', exact: true });
      const transcript = results.getByRole('region', { name: 'Lyrics transcript', exact: true });
      await expect(pitchedLyrics).toBeVisible();
      await expect(transcript).toBeVisible();
      const track = completed.pitched_lyrics![0];
      const linkedNote = completed.pitch!.tracks[0].notes.find(note => note.word_indices.length > 0)!;
      const linkedWord = completed.pitch!.words[linkedNote.word_indices[0]].text;
      const lines = track.text.split('\n');
      const wordLine = lines.findIndex(line => line.includes(linkedWord));
      expect(wordLine).toBeGreaterThan(0);
      expect(lines[wordLine - 1]).toContain(linkedNote.note);
      expect(track.text).toContain('auld-lang-syne-full');
      const txtPending = page.waitForEvent('download');
      await activate(pitchedLyrics.getByRole('link', { name: 'Download lyrics with pitches TXT', exact: true }));
      const txt = await txtPending;
      expect(await readFile((await txt.path())!)).toEqual(Buffer.from(track.text, 'utf8'));
      const odtPending = page.waitForEvent('download');
      await activate(pitchedLyrics.getByRole('link', { name: 'Download lyrics with pitches ODT', exact: true }));
      const odt = await odtPending;
      const inspectOdt = String.raw`
import json,sys,zipfile
from xml.etree import ElementTree as ET
from separator.pitched_lyrics_odt import MIME_TYPE,NS
from tests.pitched_lyrics_odt_fixture import odf_text
with zipfile.ZipFile(sys.argv[1]) as archive:
 assert archive.infolist()[0].filename=='mimetype'
 assert archive.infolist()[0].compress_type==zipfile.ZIP_STORED
 assert archive.read('mimetype').decode()==MIME_TYPE
 body=ET.fromstring(archive.read('content.xml'))
 paragraphs=body.findall('office:body/office:text/text:p',NS)
 print(json.dumps(''.join(odf_text(p)+('\n\n' if p.find('text:line-break',NS) is not None else '\n') for p in paragraphs)))
`;
      const odtText = JSON.parse(execFileSync('uv', ['run', 'python', '-c', inspectOdt, (await odt.path())!], {
        cwd: process.env.E2E_REPO_ROOT!, encoding: 'utf8',
      }));
      expect(odtText).toBe(track.text);
      const karaokeBox = (await view.boundingBox())!;
      const pitchedBox = (await pitchedLyrics.boundingBox())!;
      const transcriptBox = (await transcript.boundingBox())!;
      expect(karaokeBox.y + karaokeBox.height).toBeLessThanOrEqual(pitchedBox.y);
      expect(pitchedBox.y + pitchedBox.height).toBeLessThanOrEqual(transcriptBox.y);
      await results.screenshot({ path: info.outputPath('ordered-result-sections.png') });
      const player = view.locator('audio:not([hidden])');
      const backgrounds = view.getByRole('group', { name: 'Pitch background audio', exact: true });
      const play = view.getByRole('button', { name: 'Play', exact: true });
      const pause = view.getByRole('button', { name: 'Pause', exact: true });
      await view.getByRole('slider', { name: 'Melody zoom', exact: true }).fill('40');
      await player.evaluate(audio => { audio.preload = 'auto'; audio.load(); audio.volume = 0.4; });
      await expect(backgrounds.getByRole('button', { name: 'Full song' })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => player.evaluate(audio => audio.duration)).toBeCloseTo(fixture.pitch.duration_s, 1);
      const initialSource = await player.evaluate(audio => audio.currentSrc);
      expect(new URL(initialSource).pathname).toBe(`/api/jobs/${queued.id}/results/song`);
      const initialResponse = await page.request.get(initialSource, { headers: { Range: 'bytes=0-255' } });
      expect(initialResponse.status()).toBe(206);
      expect(initialResponse.headers()['content-type']).toContain('audio/mp4');
      const listening = await page.request.get(initialSource);
      expect(listening.status()).toBe(200);
      const listeningPath = info.outputPath('full-song-listening.mp4');
      await writeFile(listeningPath, await listening.body());
      const listeningMetadata = JSON.parse(execFileSync('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,profile',
        '-of', 'json', listeningPath,
      ], { encoding: 'utf8', timeout: 10_000 }));
      expect(listeningMetadata.streams[0]).toMatchObject({ codec_name: 'aac', profile: 'LC' });
      await activate(view.getByRole('button', { name: 'Forward 5 seconds', exact: true }));
      let outputTime = 5;
      const playbackProof = [];
      for (const label of ['song', 'vocals', 'instruments', 'drums', 'drums-vocals']) {
        const duration = label === 'song' ? fixture.pitch.duration_s : completeStemSignals[label === 'drums-vocals' ? 'vocals' : label].durationSeconds / tempoRate;
        const button = backgrounds.getByRole('button', { name: label === 'song' ? 'Full song' : label === 'vocals' ? 'Just vocals' : label === 'instruments' ? /^Instruments/ : label === 'drums' ? /^Drums only/ : /^Drums \+ Vocals/ });
        await expect(button).toBeEnabled();
        await activate(button);
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => player.evaluate(audio => audio.duration)).toBeCloseTo(duration, 1);
        await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeCloseTo(outputTime, 1);
        expect(await player.evaluate(audio => audio.paused && audio.volume === 0.4)).toBe(true);
        if (label === 'vocals') {
          await view.getByRole('slider', { name: 'Melody zoom', exact: true }).fill('80');
          await expect(button).toHaveAttribute('aria-pressed', 'true');
          await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeCloseTo(outputTime, 1);
          await view.getByRole('slider', { name: 'Melody zoom', exact: true }).fill('40');
        }
        await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1')) / 40).toBeCloseTo(outputTime, 1);
        const beforePlay = await player.evaluate(audio => audio.currentTime);
        await activate(play);
        await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(beforePlay + 0.3);
        await activate(pause);
        await expect.poll(() => player.evaluate(audio => audio.paused)).toBe(true);
        outputTime = await player.evaluate(audio => audio.currentTime);
        playbackProof.push({ label, duration: await player.evaluate(audio => audio.duration), beforePlay, pausedAt: outputTime });
      }
      await view.locator('.pitch-footer').screenshot({ path: info.outputPath('complete-karaoke-transport.png') });

      const downloads = [];
      for (const label of labels) {
        const pending = page.waitForEvent('download');
        await activate(results.locator(`a[href="/api/jobs/${queued.id}/results/${label}"]`));
        const download = await pending;
        const path = info.outputPath(`public-${label}.mp3`);
        await download.saveAs(path);
        const bytes = await readFile(path);
        const metadata = JSON.parse(execFileSync('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration:format_tags=title:stream=codec_name', '-of', 'json', path,
        ], { encoding: 'utf8', timeout: 10_000 }));
        expect(metadata.streams[0].codec_name).toBe('mp3');
        expect(metadata.format.tags.title).toBe(download.suggestedFilename().slice(0, -4));
        const range = await page.request.get(`/api/jobs/${queued.id}/results/${label}`, { headers: { Range: 'bytes=0-255' } });
        expect(range.status()).toBe(206);
        expect(range.headers()['content-type']).toContain('audio/mpeg');
        expect((await range.body()).equals(bytes.subarray(0, 256))).toBe(true);
        const profile = completeStemSignals[label];
        const expectedDuration = label === 'drums-vocals'
          ? Math.max(completeStemSignals.vocals.durationSeconds, completeStemSignals.drums.durationSeconds) / tempoRate
          : profile ? profile.durationSeconds / tempoRate : fixture.pitch.duration_s;
        const signal = profile
          ? await inspectAudio(page, path, expectedDuration, profile.frequencyHz * pitchScale)
          : label === 'drums-vocals' ? await inspectAudio(page, path, expectedDuration)
            : { duration: Number(metadata.format.duration) };
        expect(signal.duration).toBeCloseTo(expectedDuration, 0);
        downloads.push({ label, filename: download.suggestedFilename(), bytes: bytes.length, metadata, signal });
      }
      const pendingOriginal = page.waitForEvent('download');
      await activate(results.locator(`a[href="/api/jobs/${queued.id}/original"]`));
      const original = await pendingOriginal;
      const originalPath = info.outputPath('original.ogg');
      await original.saveAs(originalPath);
      expect((await readFile(originalPath)).equals(source)).toBe(true);
      const closingAudio = await player.elementHandle();
      await activate(play);
      const beforeClose = await player.evaluate(audio => audio.currentTime);
      await expect.poll(() => player.evaluate(audio => audio.currentTime)).toBeGreaterThan(beforeClose + 0.2);
      await activate(page.getByRole('button', { name: 'Start another job', exact: true }));
      expect(await closingAudio!.evaluate(audio => audio.paused)).toBe(true);
      await expect(history.getByRole('region', { name: 'Lyrics transcript', exact: true })).toHaveCount(0);
      await closingAudio!.dispose();
      await info.attach('complete-karaoke-backgrounds', {
        body: Buffer.from(JSON.stringify({
          viewport, options: queued.options, publicLabels: completed.manifest?.map(stem => stem.label),
          playback: playbackProof, listeningMetadata, downloads, originalFilename: original.suggestedFilename(),
          boundary: 'Known synthetic stems replace neural inference only; real form/HTTP/DSP/native-media/download consumers.',
        })), contentType: 'application/json',
      });
    });
  });
}
