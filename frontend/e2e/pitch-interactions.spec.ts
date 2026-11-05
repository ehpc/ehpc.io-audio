import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
test.use({ hasTouch: true });

const seedPitchOnlyJob = String.raw`
import json,subprocess,sys
from backend import config,db
from backend.pitch_reference import persist_pitch_vocals
from separator.pitch import pitch_from_json,pitch_to_json
value=json.load(sys.stdin)
job=db.get_job(int(sys.argv[1]))
assert job is not None
source=(config.UPLOADS_DIR / str(job.id) / job.source_value).read_bytes()
converted=subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i','pipe:0','-t','20','-codec:a','libmp3lame','-f','mp3','pipe:1'],input=source,capture_output=True,check=True).stdout
persist_pitch_vocals(job,converted)
db.mark_done(job.id,[],None,pitch_to_json(pitch_from_json(json.dumps(value['pitch']))))
`;

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`pitch ruler, private vocal playback, and immediate lyric tooltips (${viewport.width}px)`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg'));
    const fixture = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8');
    const submitted = await page.request.post('/api/jobs', { multipart: {
      file: { name: 'auld-lang-syne-full.ogg', mimeType: 'audio/ogg', buffer: source },
      detect_pitch: 'true', pitch_semitones: '1.25', tempo_percent: '125',
    } });
    expect(submitted.ok()).toBe(true);
    const id = (await submitted.json()).id as number;
    execFileSync('uv', ['run', 'python', '-c', seedPitchOnlyJob, String(id)], {
      cwd: process.env.E2E_REPO_ROOT!, input: fixture,
      env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    await page.reload();

    const view = page.getByLabel('Vocal pitch analysis', { exact: true });
    await expect(view).toBeVisible();
    const player = view.locator('audio');
    const sourceSelector = view.getByRole('combobox', { name: 'Pitch background audio' });
    const ruler = view.getByRole('slider', { name: 'Pitch timeline position' });
    await view.getByRole('slider', { name: 'Melody zoom' }).fill('40');
    const tapRulerAtFiveSeconds = async () => {
      await ruler.scrollIntoViewIfNeeded();
      const box = await ruler.boundingBox();
      expect(box).not.toBeNull();
      const x = box!.x + 54 + 5 * 40;
      const y = box!.y + box!.height / 2;
      if (viewport.width <= 700) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
    };
    await player.evaluate(element => { element.preload = 'auto'; element.load(); });
    await expect.poll(() => player.evaluate(element => Number.isFinite(element.duration)
      && element.duration > 10 && element.seekable.length > 0)).toBe(true);
    await page.evaluate(url => {
      const audio = document.createElement('audio');
      audio.id = 'pitch-competing-audio';
      audio.src = url;
      audio.preload = 'auto';
      document.body.append(audio);
      audio.load();
    }, `/api/jobs/${id}/original`);
    const competingAudio = page.locator('#pitch-competing-audio');
    await expect.poll(() => competingAudio.evaluate(audio => Number.isFinite(audio.duration)
      && audio.duration > 10 && audio.seekable.length > 0)).toBe(true);
    await competingAudio.evaluate(audio => audio.play());
    await expect.poll(() => competingAudio.evaluate(audio => !audio.paused)).toBe(true);
    await player.evaluate(element => element.play());
    await expect.poll(() => player.evaluate(element => !element.paused)).toBe(true);
    await expect.poll(() => competingAudio.evaluate(audio => audio.paused)).toBe(true);
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

    await sourceSelector.selectOption('vocals');
    await expect(player).toHaveAttribute('src', `/api/jobs/${id}/pitch-reference/vocals`);
    await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
    await expect.poll(() => player.evaluate(element => Number.isFinite(element.duration)
      && element.duration > 10 && element.seekable.length > 0)).toBe(true);
    await expect.poll(() => player.evaluate(element => Math.abs(element.currentTime - 5) < 0.1)).toBe(true);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1'))).toBeGreaterThan(195);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1'))).toBeLessThan(205);

    await sourceSelector.selectOption('song');
    await expect(player).toHaveAttribute('src', `/api/jobs/${id}/original`);
    await expect.poll(() => player.evaluate(element => element.paused)).toBe(true);
    await expect.poll(() => player.evaluate(element => Number.isFinite(element.duration)
      && element.duration > 10 && element.seekable.length > 0)).toBe(true);
    await expect.poll(() => player.evaluate(element => Math.abs(element.currentTime - 6.25) < 0.1)).toBe(true);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1'))).toBeGreaterThan(195);
    await expect.poll(async () => Number(await view.locator('.pitch-playhead').getAttribute('x1'))).toBeLessThan(205);

    const note = view.locator('.pitch-note').first();

    await note.scrollIntoViewIfNeeded();
    if (viewport.width <= 700) await note.tap();
    else await note.hover();
    const noteTooltip = page.getByRole('tooltip');
    await expect(noteTooltip).toBeVisible();
    await expect(noteTooltip.locator('.pitch-tooltip-note')).toHaveText('F4');
    await expect(noteTooltip.locator('.pitch-tooltip-lyrics')).toHaveText('Should');
    await expect(noteTooltip).not.toContainText(/confidence|approximate|0:10|model/i);

    const word = view.getByRole('button', { name: 'Should, approximate word timing; 3 linked notes', exact: true });
    await word.scrollIntoViewIfNeeded();
    if (viewport.width <= 700) await word.tap();
    else await word.hover();
    const wordTooltip = page.getByRole('tooltip');
    await expect(wordTooltip).toBeVisible();
    await expect(wordTooltip).toHaveText('Should');
    await expect(wordTooltip).not.toContainText(/F4|confidence|approximate|0:10|model/i);
  });
}
