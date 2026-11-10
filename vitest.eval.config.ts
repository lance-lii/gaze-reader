import { defineConfig } from 'vitest/config';

// The end-to-end scoreboard (npm run eval): simulated hours of reading in parallel shards, merged
// and reported by bench/endtoend/evalSetup.ts once they have all finished. See bench/endtoend/eval.ts.
export default defineConfig({
  test: {
    include: ['bench/endtoend/*.eval.test.ts'],
    environment: 'node',
    globalSetup: ['bench/endtoend/evalSetup.ts'],
    maxWorkers: 6,
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
});
