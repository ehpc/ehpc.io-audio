import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Locator } from '@playwright/test';
import { test } from './auth-fixture';

const insertLibraryTrack = String.raw`
import json,sys
from backend import db
from separator.pitch import pitch_from_json,pitch_to_json
session_id,title,source_value,pitch_text=sys.argv[1:]
pitch_json=pitch_to_json(pitch_from_json(pitch_text))
with db._session() as connection:
 cursor=connection.execute(
  'INSERT INTO jobs (session_id,status,source_type,source_value,title,options_json,result_manifest_json,pitch_json,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  (session_id,'done','upload',source_value,title,json.dumps({'detect_pitch':True}),None,pitch_json,1767268800,1767268801),
 )
 print(cursor.lastrowid,flush=True)
`;

const tracks = [
  { title: 'Library current visual track', source: 'current-visual.wav' },
  { title: 'Library previous visual track', source: 'previous-visual.wav' },
];
const fixedTime = new Date('2026-01-01T12:00:00Z');

async function waitForFiniteAnimations(target: Locator) {
  await target.evaluate(async element => {
    await Promise.allSettled(element.getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished));
  });
}

for (const viewport of [
  { name: 'dialog', width: 390, height: 844, isMobile: true },
  { name: 'rail', width: 1440, height: 1000, isMobile: false },
]) {
  test(`Library ${viewport.name} visual ${viewport.width}`, async ({ page }, info) => {
    await page.clock.install({ time: fixedTime });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const identity = await (await page.request.get('/api/auth/me')).json() as { id: string };
    const fixture = JSON.parse(await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8')) as { pitch: unknown };
    const ids: number[] = [];
    const pitchJson = JSON.stringify(fixture.pitch);
    try {
      for (const track of tracks) {
        let output: string;
        try {
          output = execFileSync('uv', ['run', 'python', '-c', insertLibraryTrack, identity.id, track.title, track.source, pitchJson], {
            cwd: process.env.E2E_REPO_ROOT!,
            env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
            encoding: 'utf8',
          }).trim();
        } catch (error) {
          let partialOutput = '';
          if (error && typeof error === 'object' && 'stdout' in error) {
            const stdout = error.stdout;
            if (typeof stdout === 'string' || Buffer.isBuffer(stdout)) partialOutput = stdout.toString().trim();
          }
          const partialId = Number(partialOutput);
          if (Number.isSafeInteger(partialId) && partialId > 0) ids.push(partialId);
          throw error;
        }
        const id = Number(output);
        expect(Number.isSafeInteger(id) && id > 0).toBe(true);
        ids.push(id);
      }

      await page.goto('/');
      const currentTitle = tracks[0].title;
      if (viewport.isMobile) {
        const trigger = page.getByRole('button', { name: 'Library', exact: true });
        await expect(trigger).toBeVisible();
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: 'Library', exact: true });
        const history = dialog.getByRole('region', { name: 'History', exact: true });
        await expect(history.getByRole('button', { name: currentTitle, exact: true })).toBeVisible();
        await expect(history.getByRole('button', { name: tracks[1].title, exact: true })).toBeVisible();
        await history.getByRole('button', { name: currentTitle, exact: true }).click();
        await page.mouse.move(0, 0);
        await expect(dialog).toBeHidden();
        await expect(page.getByRole('heading', { name: currentTitle, exact: true })).toBeVisible();
        await trigger.click();
        await expect(dialog.getByRole('button', { name: currentTitle, exact: true })).toHaveAttribute('aria-current', 'true');
        await expect(dialog.getByRole('button', { name: tracks[1].title, exact: true })).not.toHaveAttribute('aria-current', 'true');
        await page.mouse.move(0, 0);
        await waitForFiniteAnimations(dialog);
        await dialog.screenshot({ path: info.outputPath('library-dialog-390-actual.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
        await expect.soft(dialog).toHaveScreenshot('library-dialog-390.png');
      } else {
        const rail = page.getByRole('complementary', { name: 'Library', exact: true });
        const history = rail.getByRole('region', { name: 'History', exact: true });
        await expect(history.getByRole('button', { name: currentTitle, exact: true })).toBeVisible();
        await expect(history.getByRole('button', { name: tracks[1].title, exact: true })).toBeVisible();
        await history.getByRole('button', { name: currentTitle, exact: true }).click();
        await page.mouse.move(0, 0);
        await expect(page.getByRole('heading', { name: currentTitle, exact: true })).toBeVisible();
        await expect(history.getByRole('button', { name: currentTitle, exact: true })).toHaveAttribute('aria-current', 'true');
        await expect(history.getByRole('button', { name: tracks[1].title, exact: true })).not.toHaveAttribute('aria-current', 'true');
        await waitForFiniteAnimations(rail);
        await rail.screenshot({ path: info.outputPath('library-rail-1440-actual.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
        await expect.soft(rail).toHaveScreenshot('library-rail-1440.png');
      }
    } finally {
      const responses = await Promise.all(ids.map(id => page.request.delete(`/api/jobs/${id}`, {
        headers: { Origin: process.env.E2E_BASE_URL! },
      })));
      for (const response of responses) expect([204, 404]).toContain(response.status());
    }
  });
}
