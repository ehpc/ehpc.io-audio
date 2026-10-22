import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

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
