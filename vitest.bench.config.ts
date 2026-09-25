import { defineConfig } from 'vitest/config';

// Accuracy benchmarks: slower, simulation-heavy suites that print scoreboards
// (lighting robustness of the gaze features, reading-layer offset tolerance).
// Run with `npm run bench`; the fast regression guards live in the normal suite.
export default defineConfig({
  test: {
    include: ['bench/**/*.bench.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
