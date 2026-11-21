import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Stored synthetic/captured analysis has one producer: run.mjs --visual sets
// QUEUE_CONCURRENCY=0. These cases stay required alongside the live suite.
export default defineConfig({
  ...base,
  testMatch: ['**/admin-cache.spec.ts', '**/auth.spec.ts', '**/karaoke.spec.ts', '**/karaoke-transposition.spec.ts', '**/pitch-interactions.spec.ts', '**/live-pitch-trace.spec.ts', '**/job-status-dock.spec.ts', '**/pitched-lyrics-odt.spec.ts', '**/piano.spec.ts', '**/microphone-tuner.spec.ts', '**/delete-track-ui.spec.ts', '**/history-library.spec.ts', '**/learning.spec.ts'],
  testIgnore: ['**/history-library-visual.spec.ts'],
});
