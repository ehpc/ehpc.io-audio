import { defineConfig } from '@playwright/test';

if (!process.env.E2E_BASE_URL) throw new Error('Use npm run test:e2e so the real isolated backend is launched.');

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 25 * 60 * 1000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/summary.json' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    browserName: 'chromium',
    headless: true,
    actionTimeout: 15_000,
    launchOptions: process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
