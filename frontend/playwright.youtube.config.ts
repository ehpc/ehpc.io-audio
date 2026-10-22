import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig(base, {
  testMatch: '**/youtube-key.spec.ts',
  testIgnore: [],
  timeout: 210_000,
  outputDir: 'test-results/youtube',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report/youtube' }],
    ['json', { outputFile: 'test-results/youtube/summary.json' }],
    ...(process.env.CI ? [['github'] as const] : []),
  ],
  use: { viewport: { width: 1440, height: 1100 } },
});
