import { createRequire } from 'node:module';
import { defineConfig, type ReporterDescription } from '@playwright/test';

const require = createRequire(import.meta.url);
const version = require('@playwright/test/package.json').version;
if (process.env.E2E_VISUAL_RUNTIME !== `playwright-${version}-noble` || process.env.E2E_CHROMIUM_EXECUTABLE) {
  throw new Error('Use npm run test:visual: baselines require the version-matched Playwright Noble Docker runtime.');
}
if (!process.env.E2E_BASE_URL) throw new Error('Visual tests require the isolated real-backend harness.');

const reporter: ReporterDescription[] = [
  ['list'],
  ['html', { open: 'never', outputFolder: 'playwright-report/visual' }],
  ['json', { outputFile: 'test-results/visual/summary.json' }],
];
if (process.env.CI) reporter.push(['github']);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/visual.spec.ts',
  outputDir: 'test-results/visual',
  snapshotPathTemplate: '{testDir}/visual-snapshots/{arg}{ext}',
  updateSnapshots: 'none',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    // Ignore ~1 RGB-level native-control raster rounding, with no pixel-count/ratio allowance.
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', threshold: 0.005, maxDiffPixels: 0 },
  },
  reporter,
  use: {
    baseURL: process.env.E2E_BASE_URL,
    browserName: 'chromium',
    headless: true,
    // Use CPU rasterization and a fixed color profile on developer/CI hosts.
    launchOptions: { args: ['--disable-gpu', '--disable-skia-runtime-opts', '--force-color-profile=srgb'] },
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
