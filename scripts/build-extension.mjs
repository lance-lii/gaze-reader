// Builds the Chrome extension into dist-extension/ and verifies the result.
//
//   pages       popup.html, offscreen.html, setup.html   (multi-page, ES modules)
//   background  background.js                            (ES module service worker, one file)
//   content     content.js                               (classic IIFE, one file: injected with chrome.scripting)
//   static      manifest.json, icons/, mediapipe/wasm/
//
// The verification step fails the build if anything the manifest, the pages or
// the code references is missing, if a page would need inline script (blocked
// by the extension CSP), or if content.js isn't a self-contained classic script free of HTML-string sinks.
//
// Usage: node scripts/build-extension.mjs
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const out = join(root, 'dist-extension');
const t0 = Date.now();

/** Files the code opens at runtime by name (not visible in the manifest). */
const RUNTIME_FILES = [
  'content.js', // chrome.scripting.executeScript
  'offscreen.html', // chrome.offscreen.createDocument
  'setup.html', // chrome.tabs.create
  'mediapipe/wasm/vision_wasm_internal.js', // FilesetResolver (SIMD)
  'mediapipe/wasm/vision_wasm_internal.wasm',
  'mediapipe/wasm/vision_wasm_nosimd_internal.js', // FilesetResolver (no SIMD)
  'mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
];

const shared = {
  configFile: false,
  root: ext,
  base: './',
  publicDir: false,
  logLevel: 'warn',
  // Library builds leave process.env.NODE_ENV alone; nothing may reach the browser unreplaced.
  // __GR_TARGET__: shared app modules (src/core/target.ts) build as the web target here.
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), __GR_TARGET__: JSON.stringify('web') },
};

const sharedBuild = {
  outDir: out,
  emptyOutDir: false,
  target: 'chrome116',
  minify: true,
  sourcemap: false,
  reportCompressedSize: false,
  chunkSizeWarningLimit: 4096,
  modulePreload: { polyfill: false },
};

function step(label) {
  console.log(`[build:ext] ${label}`);
}

// ───────────────────────────────── build ─────────────────────────────────────

rmSync(out, { recursive: true, force: true });

step('pages: popup, offscreen, setup');
await build({
  ...shared,
  build: {
    ...sharedBuild,
    rolldownOptions: {
      input: {
        popup: join(ext, 'popup.html'),
        offscreen: join(ext, 'offscreen.html'),
        setup: join(ext, 'setup.html'),
      },
    },
  },
});

step('background service worker (ES module)');
await build({
  ...shared,
  build: {
    ...sharedBuild,
    lib: { entry: join(ext, 'src/background.ts'), formats: ['es'], fileName: () => 'background.js' },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});

step('content script (single-file IIFE)');
await build({
  ...shared,
  build: {
    ...sharedBuild,
    lib: { entry: join(ext, 'src/content.ts'), formats: ['iife'], name: 'GazeReaderContent', fileName: () => 'content.js' },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});

step('manifest, icons, MediaPipe runtime');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
manifest.version = pkg.version; // one source of truth for the version
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync(join(ext, 'icons'), join(out, 'icons'), { recursive: true });
execFileSync(process.execPath, [join(root, 'scripts/copy-mediapipe-wasm.mjs'), join(out, 'mediapipe/wasm')], {
  cwd: root,
  stdio: 'inherit',
});

// ──────────────────────────────── verify ─────────────────────────────────────

step('verifying the package');
const problems = [];
const toOut = (p) => join(out, ...p.split('/'));
const exists = (p) => existsSync(toOut(p)) && statSync(toOut(p)).isFile();
const need = (p, why) => {
  const clean = posix.normalize(p.replace(/^\.\//, '').replace(/^\//, '').split('?')[0].split('#')[0]);
  if (clean.startsWith('..')) problems.push(`${why} points outside the package: ${p}`);
  else if (!exists(clean)) problems.push(`missing ${clean} (${why})`);
};

// 1. Everything manifest.json references.
const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
if (m.manifest_version !== 3) problems.push('manifest_version must be 3');
if (m.background?.service_worker) need(m.background.service_worker, 'background.service_worker');
if (m.action?.default_popup) need(m.action.default_popup, 'action.default_popup');
for (const [k, v] of Object.entries(m.action?.default_icon ?? {})) need(v, `action.default_icon[${k}]`);
for (const [k, v] of Object.entries(m.icons ?? {})) need(v, `icons[${k}]`);
for (const cs of m.content_scripts ?? []) for (const f of [...(cs.js ?? []), ...(cs.css ?? [])]) need(f, 'content_scripts');
for (const war of m.web_accessible_resources ?? []) {
  for (const r of war.resources ?? []) if (!r.includes('*')) need(r, 'web_accessible_resources');
}
for (const key of ['options_page', 'devtools_page']) if (m[key]) need(m[key], key);
if (m.options_ui?.page) need(m.options_ui.page, 'options_ui.page');
if (m.side_panel?.default_path) need(m.side_panel.default_path, 'side_panel.default_path');

// 2. Files the code opens by name.
for (const f of RUNTIME_FILES) need(f, 'opened at runtime');

// 3. Every built page: its scripts/styles exist, and nothing needs inline script.
const allFiles = walk(out).map((f) => relative(out, f).split(sep).join('/'));
for (const page of allFiles.filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(toOut(page), 'utf8');
  for (const [, tag] of html.matchAll(/<script\b([^>]*)>/gi)) {
    if (!/\bsrc\s*=/.test(tag)) problems.push(`${page}: inline <script> would be blocked by the extension CSP`);
  }
  if (/\son[a-z]+\s*=\s*["']/i.test(html)) problems.push(`${page}: inline event handler attributes are blocked by the CSP`);
  for (const [, url] of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) continue; // absolute, data:, fragment
    need(posix.join(posix.dirname(page), url), `${page}`);
  }
}

// 4. Every emitted JS file: relative imports resolve inside the package.
for (const file of allFiles.filter((f) => f.endsWith('.js') && !f.startsWith('mediapipe/'))) {
  const code = readFileSync(toOut(file), 'utf8');
  for (const [, spec] of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    need(posix.join(posix.dirname(file), spec), `import in ${file}`);
  }
}

// 5. content.js must be a classic script: injected files can't use import/export.
if (exists('content.js')) {
  const code = readFileSync(toOut('content.js'), 'utf8');
  if (/^\s*(?:import|export)\b/m.test(code) || /\bimport\s*\(\s*["'`]/.test(code) || /\bimport\.meta\b/.test(code)) {
    problems.push('content.js is not a self-contained classic script (found import/export/import.meta)');
  }
  if (/@mediapipe|FilesetResolver/.test(code)) problems.push('content.js pulled in MediaPipe (it must only run in the offscreen document)');
  // Sites that enforce Trusted Types (much of Google) throw on these, and Gaze Reader would fail to start there.
  if (/\.(?:innerHTML|outerHTML)\s*=[^=]|\binsertAdjacentHTML\s*\(|\bdocument\.write(?:ln)?\s*\(/.test(code)) {
    problems.push('content.js writes HTML strings into the page; build its DOM with createElement/createElementNS');
  }
}
if (exists('background.js')) {
  const code = readFileSync(toOut('background.js'), 'utf8');
  if (/\bdocument\.|\bwindow\./.test(code)) problems.push('background.js touches document/window, which a service worker does not have');
}

if (problems.length > 0) {
  console.error(`\n[build:ext] FAILED: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

const kb = (f) => `${(statSync(toOut(f)).size / 1024).toFixed(1)} kB`;
const total = allFiles.reduce((s, f) => s + statSync(toOut(f)).size, 0);
console.log(`[build:ext] ok in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${relative(root, out)}/`);
for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'offscreen.html', 'setup.html']) {
  console.log(`  ✓ ${f.padEnd(16)} ${kb(f)}`);
}
console.log(`  ✓ ${allFiles.length} files, ${(total / 1024 / 1024).toFixed(1)} MB total (MediaPipe WASM is most of it)`);
console.log('  Load it via chrome://extensions → Developer mode → Load unpacked → dist-extension/');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
  );
}
