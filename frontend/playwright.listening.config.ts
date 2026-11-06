import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: '**/listening-clock.spec.ts',
  testIgnore: [],
  use: {
    ...base.use,
    browserName: 'firefox',
    launchOptions: {},
  },
});
