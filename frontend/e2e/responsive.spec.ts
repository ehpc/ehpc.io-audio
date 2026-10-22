import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

const directory = process.env.E2E_FIXTURE_DIR!;
const fixtureURL = process.env.E2E_FIXTURE_URL!;

async function assertUncovered(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  expect(await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!hit && (element.contains(hit) || hit.contains(element));
  })).toBe(true);
}

async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}


for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
]) {
  test(`desktop workspace scales cleanly at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    for (const name of ['Outputs', 'Mixes', 'Cleanup', 'Splits']) {
      await expect(page.getByRole('group', { name, exact: true })).toBeVisible();
    }
    const options = page.locator('.option-groups input[type=checkbox]');
    await expect(options).toHaveCount(11);
    for (const option of await options.all()) {
      await expect(option).toBeInViewport();
      await assertUncovered(page, option);
    }
    await expect(page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' })).toBeInViewport();
    await expect(page.getByRole('region', { name: 'Output preview', exact: true })).toBeInViewport();
    await expect(page.getByRole('tablist')).toBeHidden();
    const layout = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell')!;
      const option = document.querySelector('.workspace-option')!;
      const input = document.querySelector('.audio-workspace input:not([type="checkbox"])')!;
      return {
        shell: shell.getBoundingClientRect().width,
        optionFont: Number.parseFloat(getComputedStyle(option).fontSize),
        inputFont: Number.parseFloat(getComputedStyle(input).fontSize),
        workspaceFont: Number.parseFloat(getComputedStyle(document.querySelector('.audio-workspace')!).fontSize),
      };
    });
    const historyHeadingFont = Number.parseFloat(await page.getByRole('heading', { name: 'History', exact: true }).evaluate(element => getComputedStyle(element).fontSize));
    expect(layout.shell).toBeGreaterThan(viewport.width * 0.5);
    expect(layout.optionFont).toBeGreaterThanOrEqual(viewport.width >= 1701 ? 18 : 16);
    expect(layout.inputFont).toBeGreaterThanOrEqual(16);
    expect(layout.workspaceFont).toBeGreaterThanOrEqual(viewport.width >= 1701 ? 18 : 16);
    expect(historyHeadingFont).toBeGreaterThanOrEqual(viewport.width >= 1701 ? 18 : 16);
    await assertNoOverflow(page);
    await page.screenshot({ path: info.outputPath(`desktop-${viewport.width}x${viewport.height}.png`), fullPage: true });
  });
}

for (const viewport of [{ width: 375, height: 812 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
  test(`mobile workspace persists state and releases action before results ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Outputs', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Download song', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`mobile-${viewport.width}x${viewport.height}.png`), fullPage: true });
    await assertUncovered(page, page.getByText('Advanced · cache', { exact: true }));
    await page.getByRole('button', { name: 'Download song', exact: true }).click();
    await assertUncovered(page, page.getByRole('alert'));
    await expect(page.getByRole('alert')).toContainText('Provide a URL');
    await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
    await page.getByLabel('Audio file', { exact: true }).setInputFiles(resolve(directory, 'invalid.wav'));
    await expect(page.getByRole('alert').filter({ hasText: 'Key analysis:' })).toBeVisible();
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await page.getByLabel('Track URL', { exact: true }).fill(`${fixtureURL}/tone-fixture.wav`);
    await expect(page.getByRole('status')).toContainText('Downloading audio and analyzing');
    const outputs = page.getByRole('tab', { name: 'Outputs', exact: true });
    await outputs.focus();
    await outputs.press('ArrowRight');
    const adjust = page.getByRole('tab', { name: 'Adjust', exact: true });
    await expect(adjust).toBeFocused();
    await expect(adjust).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Original key: C major', { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' }).fill('2');
    await page.getByRole('spinbutton', { name: 'Tempo (% of original)' }).fill('120');
    await expect(page.getByText('Target key: D major', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: viewport.width, height: 450 });
    await assertUncovered(page, page.getByRole('spinbutton', { name: 'Tempo (% of original)' }));
    await page.setViewportSize(viewport);
    await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
    const options = page.locator('.option-groups input[type=checkbox]');
    await expect(options).toHaveCount(11);
    for (const option of await options.all()) {
      const label = option.locator('..');
      expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await option.check();
      await expect(option).toBeChecked();
    }
    await page.getByText('Advanced · cache', { exact: true }).click();
    const cache = page.getByRole('checkbox', { name: /Reprocess from scratch/ });
    await assertUncovered(page, cache.locator('..'));
    await cache.check();
    await page.getByRole('tab', { name: 'Review', exact: true }).click();
    await expect(page.getByText('Tracks you\'ll get (21)', { exact: true })).toBeVisible();
    await expect(page.locator('.output-tags')).toContainText('pitch +2 st');
    await page.getByRole('tab', { name: 'Adjust', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' })).toHaveValue('2');
    await expect(page.getByRole('spinbutton', { name: 'Tempo (% of original)' })).toHaveValue('120');
    await expect(page.getByText('Target key: D major', { exact: true })).toBeVisible();
    expect(await page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' }).evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
    for (const option of await options.all()) { await expect(option).toBeChecked(); await option.uncheck(); }
    await expect(cache).toBeChecked();
    await page.getByRole('button', { name: 'Review →', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Review', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Tracks you\'ll get (2)', { exact: true })).toBeVisible();
    const response = page.waitForResponse(res => res.url().endsWith('/api/jobs') && res.request().method() === 'POST');
    await page.getByRole('button', { name: 'Process audio', exact: true }).click();
    const submitted = await (await response).json();
    await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible({ timeout: 120_000 });
    const job = await (await page.request.get(`/api/jobs/${submitted.id}`)).json();
    expect(job.options.pitch_semitones).toBe(2);
    expect(job.options.tempo_percent).toBe(120);
    expect(job.options.no_cache).toBe(true);
    expect(job.manifest.map((stem: { label: string }) => stem.label)).toEqual(['song']);
    const downloads = page.locator(`a[download][href^='/api/jobs/${job.id}/']`);
    expect(await downloads.count()).toBe(4);
    for (const link of await downloads.all()) {
      await assertUncovered(page, link);
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    for (const audio of await page.locator('audio').all()) {
      await assertUncovered(page, audio);
      expect(await audio.evaluate(async element => {
        const player = element as HTMLAudioElement;
        await player.play();
        player.pause();
        return player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
      })).toBe(true);
    }
    await assertNoOverflow(page);
    await page.screenshot({ path: info.outputPath(`mobile-${viewport.width}-results.png`), fullPage: true });
    await page.getByRole('tab', { name: 'Adjust', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' })).toHaveValue('0');
    await expect(page.getByRole('spinbutton', { name: 'Tempo (% of original)' })).toHaveValue('100');
  });
}
