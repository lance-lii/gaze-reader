import { defineConfig } from 'vite';

// Relative base so the built app works from any static host or subfolder.
// The Artifact build (scripts/build-artifact.mjs) doesn't use this file.
export default defineConfig({
  base: './',
  define: {
    // See src/core/target.ts.
    __GR_TARGET__: JSON.stringify('web'),
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // The MediaPipe runtime is large by nature; don't nag about it.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
