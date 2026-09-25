import { defineConfig } from 'vite';

// Relative base so the built app works from any static host or subfolder.
export default defineConfig({
  base: './',
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
