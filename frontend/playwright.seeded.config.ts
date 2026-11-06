import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Stored synthetic/captured analysis has one producer: run.mjs --visual sets
// QUEUE_CONCURRENCY=0. These four cases stay required alongside the live suite.
export default defineConfig({
  ...base,
  testMatch: ['**/pitch-interactions.spec.ts', '**/pitched-lyrics-odt.spec.ts'],
  testIgnore: [],
});
