import { defineConfig, type Plugin } from 'vite';
import pkg from './package.json';

/**
 * The built web app's Content-Security-Policy, as a <meta> tag (GitHub Pages sets no headers).
 *
 * The page holds a camera permission and the reader's library, and renders books and web pages
 * from anywhere. Those are sanitized before they reach the DOM; this is the second line, for the
 * day a sanitizer or a parser bug lets a script through: nothing runs that didn't ship with the app.
 *
 *  - script-src: our own files, WebAssembly (MediaPipe), and the one inline script in index.html
 *    (the theme, applied before first paint), by its hash, which is computed here from the HTML as
 *    it is emitted. No 'unsafe-inline', no 'unsafe-eval'.
 *  - style-src needs 'unsafe-inline': the reader's stylesheet is injected by script, and elements
 *    carry style attributes.
 *  - connect-src is wide (any http/https): "Open from URL" fetches whatever address the reader
 *    types, and the face model comes from Google's storage. MediaPipe's usage logging is refused in
 *    code instead (src/gaze/mediapipeTelemetry.ts).
 *  - img/font/media/worker: what pdf.js (embedded fonts, its worker) and the camera preview need.
 *
 * Build only: the dev server injects inline scripts of its own. The extension's pages have their
 * policy in the manifest, and the Artifact build runs under its frame's.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'gaze-reader:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      async handler(html) {
        const hashes: string[] = [];
        for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m[1]));
          hashes.push(`'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
        }
        const policy = [
          "default-src 'self'",
          `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`.trim(),
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data: blob:",
          "media-src 'self' blob: mediastream:",
          "worker-src 'self' blob:",
          "connect-src 'self' https: http:",
          "object-src 'none'",
          "frame-src 'none'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join('; ');
        return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  };
}

// Relative base so the built app works from any static host or subfolder.
// The Artifact build (scripts/build-artifact.mjs) doesn't use this file.
export default defineConfig({
  base: './',
  define: {
    // See src/core/target.ts.
    __GR_TARGET__: JSON.stringify('web'),
    __GR_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [contentSecurityPolicy()],
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
