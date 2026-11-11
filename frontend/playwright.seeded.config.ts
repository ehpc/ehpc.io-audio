import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Stored synthetic/captured analysis has one producer: run.mjs --visual sets
// QUEUE_CONCURRENCY=0. These cases stay required alongside the live suite.
export default defineConfig({
  ...base,
  testMatch: ['**/admin-cache.spec.ts', '**/auth.spec.ts', '**/karaoke.spec.ts', '**/pitch-interactions.spec.ts', '**/pitched-lyrics-odt.spec.ts', '**/piano.spec.ts'],
  testIgnore: [],
});
