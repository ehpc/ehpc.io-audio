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
    const trackIds = new Map<string, number>();
    const pitchJson = JSON.stringify(fixture.pitch);
    try {
      // The visual starts with the current track selected; switching is covered by history-library.spec.ts.
      for (const track of [...tracks].reverse()) {
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
        trackIds.set(track.title, id);
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
        const selectedResponse = page.waitForResponse(response =>
          response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/jobs/${trackIds.get(currentTitle)}`);
        await history.getByRole('button', { name: currentTitle, exact: true }).click();
        expect((await selectedResponse).ok()).toBe(true);
        await page.mouse.move(0, 0);
        await expect(dialog).toBeHidden();
        await expect(page.getByRole('heading', { name: currentTitle, exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Karaoke with pitches' })).toBeInViewport();
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
        const selectedResponse = page.waitForResponse(response =>
          response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/jobs/${trackIds.get(currentTitle)}`);
        await history.getByRole('button', { name: currentTitle, exact: true }).click();
        expect((await selectedResponse).ok()).toBe(true);
        await page.mouse.move(0, 0);
        await expect(page.getByRole('heading', { name: currentTitle, exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Karaoke with pitches' })).toBeInViewport();
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

const longSidebarTitle = 'A Deliberately Long Song Title That Must Stay Inside Its Sidebar Item Box';
for (const viewport of [
  { name: 'narrow', width: 320, height: 844, isMobile: true },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
  { name: 'desktop', width: 1440, height: 1000, isMobile: false },
]) {
  test(`history item fits at ${viewport.width} with selection and delete intact`, async ({ page }, info) => {
    await page.clock.install({ time: fixedTime });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const identity = await (await page.request.get('/api/auth/me')).json() as { id: string };
    const fixture = JSON.parse(await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8')) as { pitch: unknown };
    let jobId: number | null = null;
    try {
      const output = execFileSync('uv', ['run', 'python', '-c', insertLibraryTrack, identity.id, longSidebarTitle,
        `long-sidebar-${viewport.width}.wav`, JSON.stringify(fixture.pitch)], {
        cwd: process.env.E2E_REPO_ROOT!,
        env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
        encoding: 'utf8',
      }).trim();
      jobId = Number(output);
      expect(Number.isSafeInteger(jobId) && jobId > 0).toBe(true);

      await page.goto('/');
      const trigger = page.getByRole('button', { name: 'Library', exact: true });
      const openHistory = async () => {
        if (viewport.isMobile) await trigger.click();
        const parent = viewport.isMobile
          ? page.getByRole('dialog', { name: 'Library', exact: true })
          : page.getByRole('complementary', { name: 'Library', exact: true });
        return parent.getByRole('region', { name: 'History', exact: true });
      };
      let history = await openHistory();
      let titleButton = history.getByRole('button', { name: longSidebarTitle, exact: true });
      let row = history.getByRole('listitem').filter({ has: page.getByRole('button', { name: longSidebarTitle, exact: true }) });
      await expect(row).toHaveCount(1);
      let deleteButton = row.getByRole('button', { name: `Delete ${longSidebarTitle}` });
      const date = row.locator('time');
      await expect(titleButton).toBeVisible();
      await expect(date).toBeVisible();
      await expect(deleteButton).toBeVisible();
      await expect(row.getByRole('button')).toHaveCount(2);
      await expect(date).toHaveText(/\S/);
      await expect(date).toHaveAttribute('datetime', new Date(1767268800 * 1000).toISOString());

      const geometry = await row.evaluate(element => {
        const rowRect = element.getBoundingClientRect();
        return {
          left: rowRect.left,
          right: rowRect.right,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          parts: [...element.querySelectorAll('button,time')].map(part => {
            const rect = part.getBoundingClientRect();
            return {
              kind: part.tagName === 'TIME' ? 'date' : part.getAttribute('aria-label')?.startsWith('Delete ') ? 'delete' : 'title',
              left: rect.left,
              right: rect.right,
              height: rect.height,
              clientWidth: part.clientWidth,
              scrollWidth: part.scrollWidth,
            };
          }),
        };
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
      expect(geometry.parts).toHaveLength(3);
      const dateGeometry = geometry.parts.find(part => part.kind === 'date')!;
      expect(dateGeometry.scrollWidth).toBeLessThanOrEqual(dateGeometry.clientWidth);
      for (const part of geometry.parts) {
        expect(part.left).toBeGreaterThanOrEqual(geometry.left);
        expect(part.right).toBeLessThanOrEqual(geometry.right);
      }
      expect(geometry.parts.find(part => part.kind === 'title')!.height).toBeGreaterThanOrEqual(44);
      expect(geometry.parts.find(part => part.kind === 'delete')!.height).toBeGreaterThanOrEqual(44);
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(documentWidth).toBeLessThanOrEqual(viewport.width);

      await page.mouse.move(0, 0);
      await row.screenshot({ path: info.outputPath(`history-item-${viewport.width}-actual.png`), animations: 'disabled', caret: 'hide', scale: 'css' });
      await expect.soft(row).toHaveScreenshot(`history-item-${viewport.width}.png`);

      const selectedResponse = page.waitForResponse(response =>
        response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/jobs/${jobId}`);
      await titleButton.press('Enter');
      expect((await selectedResponse).ok()).toBe(true);
      if (viewport.isMobile) {
        await expect(page.getByRole('dialog', { name: 'Library', exact: true })).toBeHidden();
        await expect(trigger).toBeFocused();
        history = await openHistory();
        titleButton = history.getByRole('button', { name: longSidebarTitle, exact: true });
        row = history.getByRole('listitem').filter({ has: page.getByRole('button', { name: longSidebarTitle, exact: true }) });
        await expect(row).toHaveCount(1);
        deleteButton = row.getByRole('button', { name: `Delete ${longSidebarTitle}` });
      }
      await expect(titleButton).toHaveAttribute('aria-current', 'true');
      await deleteButton.click();
      let confirmation = page.getByRole('alertdialog');
      await expect(confirmation).toContainText(`Delete ${longSidebarTitle}?`);
      await confirmation.getByRole('button', { name: 'Cancel' }).click();
      await expect(row).toBeVisible();
      await deleteButton.click();
      confirmation = page.getByRole('alertdialog');
      const deletion = page.waitForResponse(response =>
        response.request().method() === 'DELETE' && new URL(response.url()).pathname === `/api/jobs/${jobId}`);
      await confirmation.getByRole('button', { name: 'Delete track' }).click();
      expect((await deletion).status()).toBe(204);
      await expect(row).toHaveCount(0);
    } finally {
      if (jobId !== null && Number.isSafeInteger(jobId) && jobId > 0) {
        const response = await page.request.delete(`/api/jobs/${jobId}`, {
          headers: { Origin: process.env.E2E_BASE_URL! },
        });
        expect([204, 404]).toContain(response.status());
      }
    }
  });
}

const wrappingTitles = [
  'An Exceptionally Long Song Title Featuring Many Words For A Narrow Library Sidebar',
  'UnbrokenSupercalifragilisticExpialidociousExtendedRecordingIdentifier0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  '非常に長い曲名と国際的な文字列🎶音楽の物語を繰り返す非常に長い曲名と国際的な文字列',
];
for (const viewport of [
  { width: 320, height: 844, isMobile: true },
  { width: 390, height: 844, isMobile: true },
  { width: 1440, height: 1000, isMobile: false },
  { width: 2560, height: 1000, isMobile: false },
]) {
  test(`full history titles remain readable at ${viewport.width}`, async ({ page }) => {
    await page.clock.install({ time: fixedTime });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const identity = await (await page.request.get('/api/auth/me')).json() as { id: string };
    const fixture = JSON.parse(await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8')) as { pitch: unknown };
    const ids: number[] = [];
    try {
      for (const title of wrappingTitles) {
        const output = execFileSync('uv', ['run', 'python', '-c', insertLibraryTrack, identity.id, title,
          `wrap-history-${viewport.width}-${ids.length}.wav`, JSON.stringify(fixture.pitch)], {
          cwd: process.env.E2E_REPO_ROOT!,
          env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
          encoding: 'utf8',
        }).trim();
        const id = Number(output);
        expect(Number.isSafeInteger(id) && id > 0).toBe(true);
        ids.push(id);
      }
      await page.goto('/');
      const library = page.getByRole('button', { name: 'Library', exact: true });
      if (viewport.isMobile) await library.click();
      const history = page.getByRole('region', { name: 'History', exact: true });
      for (const title of wrappingTitles) {
        const titleButton = history.getByRole('button', { name: title, exact: true });
        const row = history.getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) });
        await expect(row).toHaveCount(1);
        await expect(titleButton).toBeVisible();
        await expect(row.locator('time')).toBeVisible();
        await expect(row.getByRole('button', { name: `Delete ${title}`, exact: true })).toBeVisible();
        const geometry = await row.evaluate(element => {
          const button = element.querySelector('button')!;
          const span = button.querySelector('span')!;
          const date = element.querySelector('time')!;
          const deletion = element.querySelector('button[aria-label^="Delete "]')!;
          const rect = (target: Element) => {
            const box = target.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height };
          };
          const range = document.createRange();
          range.selectNodeContents(span);
          return {
            row: rect(element), button: rect(button), date: rect(date), deletion: rect(deletion),
            lines: [...range.getClientRects()].map(box => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom })),
            titleClientWidth: span.clientWidth, titleScrollWidth: span.scrollWidth,
            dateClientWidth: date.clientWidth, dateScrollWidth: date.scrollWidth,
            documentWidth: document.documentElement.scrollWidth,
          };
        });
        expect(new Set(geometry.lines.map(line => Math.round(line.top))).size).toBeGreaterThan(1);
        expect(geometry.titleScrollWidth).toBeLessThanOrEqual(geometry.titleClientWidth);
        expect(geometry.dateScrollWidth).toBeLessThanOrEqual(geometry.dateClientWidth);
        expect(geometry.row.left).toBeGreaterThanOrEqual(0);
        expect(geometry.row.right).toBeLessThanOrEqual(viewport.width);
        expect(geometry.documentWidth).toBeLessThanOrEqual(viewport.width);
        expect(geometry.button.height).toBeGreaterThanOrEqual(44);
        expect(geometry.deletion.height).toBeGreaterThanOrEqual(44);
        for (const line of geometry.lines) {
          expect(Math.round(line.left)).toBeGreaterThanOrEqual(Math.round(geometry.button.left));
          expect(Math.round(line.right)).toBeLessThanOrEqual(Math.round(geometry.button.right));
          expect(Math.round(line.top)).toBeGreaterThanOrEqual(Math.round(geometry.button.top));
          expect(Math.round(line.bottom)).toBeLessThanOrEqual(Math.round(geometry.button.bottom));
          expect(Math.round(line.bottom)).toBeLessThanOrEqual(Math.round(geometry.date.top));
          expect(Math.round(line.right)).toBeLessThanOrEqual(Math.round(geometry.deletion.left));
        }
        for (const part of [geometry.button, geometry.date, geometry.deletion]) {
          expect(part.left).toBeGreaterThanOrEqual(geometry.row.left);
          expect(part.right).toBeLessThanOrEqual(geometry.row.right);
          expect(part.top).toBeGreaterThanOrEqual(geometry.row.top);
          expect(part.bottom).toBeLessThanOrEqual(geometry.row.bottom);
        }
      }
      const firstTitle = wrappingTitles[0];
      const selected = page.waitForResponse(response =>
        response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/jobs/${ids[0]}`);
      await history.getByRole('button', { name: firstTitle, exact: true }).press('Enter');
      expect((await selected).ok()).toBe(true);
      if (viewport.isMobile) await library.click();
      await expect(history.getByRole('button', { name: firstTitle, exact: true })).toHaveAttribute('aria-current', 'true');
      const deleteButton = history.getByRole('button', { name: `Delete ${firstTitle}`, exact: true });
      await deleteButton.focus();
      await page.keyboard.press('Enter');
      const confirmation = page.getByRole('alertdialog');
      await expect(confirmation).toContainText(`Delete ${firstTitle}?`);
      await confirmation.getByRole('button', { name: 'Cancel' }).click();
      await expect(deleteButton).toBeVisible();
    } finally {
      for (const id of ids) {
        const response = await page.request.delete(`/api/jobs/${id}`, { headers: { Origin: process.env.E2E_BASE_URL! } });
        expect([204, 404]).toContain(response.status());
      }
    }
  });
}
