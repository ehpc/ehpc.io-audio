import { resolve } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './auth-fixture';
import { jobLabel, resultUrl, type JobDTO, type SongDetail, type SubmitResult } from '../src/api';

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

async function submitAndComplete(page: Page): Promise<{ submission: SubmitResult; detail: SongDetail }> {
  const response = page.waitForResponse(res => res.url().endsWith('/api/jobs') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Process audio', exact: true }).click();
  const posted = await response;
  expect(posted.status()).toBe(200);
  const submission = await posted.json() as SubmitResult;
  if (submission.work_id !== null) {
    await expect.poll(async () => {
      const response = await page.request.get(`/api/jobs/${submission.work_id}`);
      expect(response.ok()).toBe(true);
      const job = await response.json() as JobDTO;
      expect(job.status, job.error_message ?? '').not.toBe('failed');
      return job.status;
    }, { timeout: 120_000 }).toBe('done');
  }
  const responseDetail = await page.request.get(`/api/songs/${submission.song_id}`);
  expect(responseDetail.ok()).toBe(true);
  return { submission, detail: await responseDetail.json() as SongDetail };
}

async function selectOutputVersion(page: Page, detail: SongDetail, identity: string) {
  const choices = detail.variants.flatMap(variant =>
    variant.outputs.filter(output => output.identity === identity));
  if (choices.length > 1) {
    // The selected variant determines the card's accessible selector name.
    const names = [...new Set(choices.map(output => output.display_name))];
    let selector = page.getByRole('combobox', { name: `${names[0]} version`, exact: true });
    for (const name of names.slice(1)) selector = selector.or(page.getByRole('combobox', { name: `${name} version`, exact: true }));
    await expect(selector).toBeVisible();
    await selector.selectOption('2:120');
  }
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
    for (const name of ['Outputs', 'Mixes Build your own', 'Cleanup', 'Splits']) {
      await expect(page.getByRole('group', { name, exact: true })).toBeVisible();
    }
    const options = page.locator('.option-groups input[type=checkbox]');
    for (const option of await options.all()) {
      await option.scrollIntoViewIfNeeded();
      await expect(option).toBeInViewport();
      await assertUncovered(page, option);
    }
    const pitch = page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' });
    await pitch.scrollIntoViewIfNeeded();
    await expect(pitch).toBeInViewport();
    const preview = page.getByRole('region', { name: 'Output preview', exact: true });
    await preview.scrollIntoViewIfNeeded();
    await expect(preview).toBeInViewport();
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
    await page.getByRole('button', { name: 'Download song', exact: true }).click();
    await assertUncovered(page, page.getByRole('alert'));
    await expect(page.getByRole('alert')).toContainText('Provide a URL');
    await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
    await page.getByLabel('Audio file', { exact: true }).setInputFiles(resolve(directory, 'invalid.wav'));
    await expect(page.getByRole('alert').filter({ hasText: 'Key analysis:' })).toBeVisible();
    await page.getByRole('button', { name: 'From URL', exact: true }).click();
    await page.getByLabel('Track URL', { exact: true }).fill(`${fixtureURL}/tone-fixture.wav`);
    await expect(page.getByRole('region', { name: 'Audio source', exact: true }).getByRole('status')).toBeVisible();
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
    for (const option of await options.all()) {
      const label = option.locator('..');
      expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await option.check();
      await expect(option).toBeChecked();
    }
    const mixName = 'Mobile lead + instruments';
    const mixLabel = `${mixName} (pitch +2 st, tempo 120%)`;
    await page.locator('details.vocal-variants > summary').click();
    await page.getByRole('button', { name: '+ Lead vocals', exact: true }).click();
    await page.getByRole('button', { name: '+ Instruments', exact: true }).click();
    await page.getByLabel('New mix name', { exact: true }).fill(mixName);
    await page.getByRole('button', { name: 'Add mix', exact: true }).click();
    await expect(page.getByTestId('mix-item')).toHaveAttribute('data-mix-name', mixName);
    await page.getByRole('tab', { name: 'Review', exact: true }).click();
    await expect(page.locator('.output-tags').getByText('Original (unchanged)', { exact: true })).toBeVisible();
    await expect(page.locator('.output-tags').getByText('Full song (pitch +2 st, tempo 120%)', { exact: true })).toBeVisible();
    await expect(page.locator('.output-tags').getByText(mixLabel, { exact: true })).toBeVisible();
    await expect(page.locator('.output-tags').getByText('Lyrics (timestamped TXT)', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Adjust', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' })).toHaveValue('2');
    await expect(page.getByRole('spinbutton', { name: 'Tempo (% of original)' })).toHaveValue('120');
    await expect(page.getByText('Target key: D major', { exact: true })).toBeVisible();
    expect(await page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' }).evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
    // Check retained effective choices before disabling karaoke restores manual preferences.
    for (const option of await options.all()) await expect(option).toBeChecked();
    await page.getByRole('checkbox', { name: 'Karaoke with pitches', exact: true }).uncheck();
    for (const option of await options.all()) await option.uncheck();
    for (const option of await options.all()) await expect(option).not.toBeChecked();
    await expect(page.locator('.output-tags').getByText('Lyrics (timestamped TXT)', { exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Review', exact: true }).click();
    await expect(page.locator('.output-tags').getByText(mixLabel, { exact: true })).toBeVisible();
    const mixed = await submitAndComplete(page);
    const variant = mixed.detail.variants.find(item => item.pitch_semitones === 2 && item.tempo_percent === 120);
    expect(variant).toBeDefined();
    const mix = variant!.outputs.find(output => output.identity === 'mix:instruments,lead');
    expect(mix).toBeDefined();
    await selectOutputVersion(page, mixed.detail, mix!.identity);
    const mixLink = page.locator(`a[download][href="${resultUrl(mix!.work_id, mix!.label, mix!.revision)}"]`);
    const mixCard = mixLink.locator('../..');
    await expect(mixLink).toBeVisible();
    await expect(mixCard.getByText('Source key: C major', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Library/ }).click();
    const history = page.getByRole('dialog', { name: 'Library', exact: true }).getByRole('region', { name: 'History', exact: true });
    await expect(history.locator(`a[href="${resultUrl(mix!.work_id, mix!.label, mix!.revision)}"]`)).toHaveCount(0);
    const historyDateTime = await page.evaluate(createdAt => new Date(createdAt * 1000).toISOString(), mixed.detail.summary.created_at);
    const historyCard = history.getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: `Delete ${jobLabel(mixed.detail.summary)}`, exact: true }) })
      .filter({ has: page.locator(`time[datetime="${historyDateTime}"]`) });
    await historyCard.getByRole('button', { name: jobLabel(mixed.detail.summary), exact: true }).click();
    await selectOutputVersion(page, mixed.detail, mix!.identity);
    await expect(mixLink).toBeVisible();
    await expect(mixCard.getByText('Source key: C major', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
    await expect(page.getByTestId('mix-item')).toHaveAttribute('data-mix-name', mixName);
    await page.getByRole('button', { name: `Remove ${mixName}`, exact: true }).click();
    await expect(page.getByTestId('mix-item')).toHaveCount(0);
    await page.getByRole('button', { name: 'Review →', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Review', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText(/Tracks and files you'll get \(2\)/)).toBeVisible();
    const result = await submitAndComplete(page);
    expect(result.submission.song_id).toBe(mixed.submission.song_id);
    expect(result.submission.work_id).toBeNull();
    const retainedVariant = result.detail.variants.find(item => item.pitch_semitones === 2 && item.tempo_percent === 120);
    expect(retainedVariant?.outputs.find(output => output.identity === 'mix:instruments,lead')).toEqual(mix);
    const song = retainedVariant?.outputs.find(output => output.identity === 'song');
    expect(song).toBeDefined();
    expect(result.detail.summary.original_work_id).not.toBeNull();
    await selectOutputVersion(page, result.detail, song!.identity);
    const downloads = [
      page.locator(`a[download][href='/api/jobs/${result.detail.summary.original_work_id}/original']`),
      page.locator(`a[download][href="${resultUrl(song!.work_id, song!.label, song!.revision)}"]`),
    ];
    for (const link of downloads) {
      await expect(link).toBeVisible();
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
    await expect(page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' })).toHaveValue('2');
    await expect(page.getByRole('spinbutton', { name: 'Tempo (% of original)' })).toHaveValue('120');
  });
}
