import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@wfb/engine': fileURLToPath(new URL('../packages/engine/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests talk to a real Hasura and involve real LLM/HTTP calls.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Integration suites share seeded organizations and mutate quota, so they
    // must not interleave.
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
