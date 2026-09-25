// Builds the claude.ai Artifact version of Gaze Reader into dist-artifact/.
//
//   gaze-reader.html     the page: content only (the frame supplies <!doctype>,
//                        <head> and <body>), <title> first, all CSS in one inline
//                        <style>, the whole app in one inline module <script>
//   pdf.worker.min.mjs   pdf.js's worker, loaded by a document-relative URL
//   samples/…            the sample books, fetched relatively
//
// The app is compiled with __GR_TARGET__ = 'artifact' (see src/core/target.ts):
// no MediaPipe, no webcam, no "Open from URL", and the theme follows the host.
// The build fails if the page breaks one of the frame's rules (document tags,
// external scripts or styles, network URLs in fetch(), leftover chunks,
// MediaPipe code, size) or if the inlined script or the pdf worker doesn't parse.
//
// Usage: node scripts/build-artifact.mjs   (npm run build:artifact)
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifactHtml, checkArtifactHtml, CONTROL_CHARS, escapeControlChars, escapeInlineScript, formatBytes } from './artifact-html.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-artifact');
const PAGE = 'gaze-reader.html';
/** Must match ARTIFACT_PDF_WORKER_FILE in src/reader/pdf.ts. */
const PDF_WORKER = 'pdf.worker.min.mjs';
/** The only absolute URLs the app may name (links, never fetched). Must match src/core/target.ts. */
const ALLOWED_LINKS = ['https://lance-lii.github.io/gaze-reader/', 'https://github.com/lance-lii/gaze-reader'];
/** Strings that only exist in the MediaPipe runtime: none may reach the page. */
const MEDIAPIPE_MARKERS = ['vision_wasm_internal', 'storage.googleapis.com/mediapipe-models'];
const t0 = Date.now();

const step = (label) => console.log(`[build:artifact] ${label}`);
const fail = (problems) => {
  console.error(`[build:artifact] FAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
};

// ───────────────────────────────── bundle ────────────────────────────────────

step('bundling the app (target: artifact)');
const result = await build({
  configFile: false,
  root,
  base: './',
  publicDir: false,
  logLevel: 'warn',
  define: {
    __GR_TARGET__: JSON.stringify('artifact'),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    write: false,
    target: 'es2022',
    minify: true,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 8192,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: join(root, 'src/main.ts'),
      // One file: dynamic imports (EPUB, PDF) are inlined instead of split into chunks.
      output: { codeSplitting: false },
    },
  },
});

const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []));
const chunks = outputs.filter((o) => o.type === 'chunk');
const css = outputs
  .filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
  .map((o) => (typeof o.source === 'string' ? o.source : Buffer.from(o.source).toString('utf8')))
  .join('\n');
if (chunks.length !== 1) fail([`expected one JS chunk, got ${chunks.length}: ${chunks.map((c) => c.fileName).join(', ')}`]);
if (!css) fail(['the bundle has no CSS']);
const js = chunks[0].code;

// ──────────────────────────────── assemble ───────────────────────────────────

step('assembling the page');
const artifactCss = readFileSync(join(root, 'src/styles/artifact.css'), 'utf8');
const markup = `
<noscript>
  <p style="font: 18px/1.6 system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem">
    Gaze Reader needs JavaScript to turn the pages. Everything runs locally in your browser.
  </p>
</noscript>
<div id="app"></div>`;
const html = buildArtifactHtml({ title: 'Gaze Reader', css: `${css}\n${artifactCss}`, js, markup });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, PAGE), html);
// pdf.js's minified worker has raw control characters in its literals; the host refuses those.
const worker = escapeControlChars(readFileSync(join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), 'utf8'));
writeFileSync(join(out, PDF_WORKER), worker);
cpSync(join(root, 'public/samples'), join(out, 'samples'), { recursive: true });

// ───────────────────────────────── verify ────────────────────────────────────

step('verifying');
const problems = checkArtifactHtml(html, { allowedFetchUrls: ALLOWED_LINKS });
for (const marker of MEDIAPIPE_MARKERS) {
  if (html.includes(marker)) problems.push(`MediaPipe code reached the page ("${marker}")`);
}
// Every absolute http(s) URL in *our* page that isn't a namespace or doc link must be one of the allowed links.
for (const m of html.matchAll(/https:\/\/lance-lii\.github\.io[^"'`\s)<]*|https:\/\/github\.com\/lance-lii[^"'`\s)<]*/g)) {
  if (!ALLOWED_LINKS.includes(m[0])) problems.push(`unexpected project URL ${m[0]}`);
}
if (!['"', "'", '`'].some((q) => html.includes(`${q}${PDF_WORKER}${q}`))) problems.push(`the page doesn't reference ${PDF_WORKER}`);
if (!/["'`]samples\/["'`]/.test(html)) problems.push('the page doesn\'t fetch samples/ relatively');

// The inlined (escaped) script must still be a valid module.
const scratch = mkdtempSync(join(tmpdir(), 'gr-artifact-'));
try {
  const probe = join(scratch, 'inline.mjs');
  writeFileSync(probe, escapeInlineScript(escapeControlChars(js)));
  execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', join(out, PDF_WORKER)], { stdio: 'pipe' });
} catch (err) {
  problems.push(`the inlined script or the pdf worker doesn't parse: ${String(err.stderr ?? err.message).trim().split('\n').slice(0, 4).join(' ')}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// The host refuses text files with raw control characters.
for (const [name, text] of [[PAGE, html], [PDF_WORKER, worker]]) {
  if (CONTROL_CHARS.test(text)) problems.push(`${name} still contains a raw control character`);
}

// Every sample the index lists must be published.
const index = JSON.parse(readFileSync(join(out, 'samples/index.json'), 'utf8'));
for (const entry of Array.isArray(index) ? index : (index.books ?? [])) {
  try {
    statSync(join(out, 'samples', entry.file));
  } catch {
    problems.push(`samples/index.json lists ${entry.file}, which isn't published`);
  }
}

if (problems.length > 0) fail(problems);

// ───────────────────────────────── report ────────────────────────────────────

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ path: relative(out, p).split(sep).join('/'), size: statSync(p).size });
  }
};
walk(out);
const width = Math.max(...files.map((f) => f.path.length));
console.log(`[build:artifact] published files (dist-artifact/):`);
for (const f of files) console.log(`  ${f.path.padEnd(width)}  ${formatBytes(f.size).padStart(9)}`);
const pageBytes = Buffer.byteLength(html, 'utf8');
console.log(`[build:artifact] page ${PAGE}: ${formatBytes(pageBytes)} of 16 MB (JS ${formatBytes(js.length)}, CSS ${formatBytes(css.length + artifactCss.length)})`);
console.log(`[build:artifact] done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
