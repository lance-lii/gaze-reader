import { defineConfig } from 'vitest/config';

// Default environment is node (pure algorithm tests). DOM tests opt in with a
// `// @vitest-environment jsdom` comment at the top of the file.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'extension/**/*.test.ts'],
    environment: 'node',
  },
});
