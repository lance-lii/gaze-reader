// Zips the built extension for the Chrome Web Store (or for sharing a build).
//
//   dist-extension/  →  release/gaze-reader-extension-v<version>.zip
//
// manifest.json sits at the root of the zip, as the Web Store requires. Entries
// are sorted and carry a fixed timestamp, so the same build always gives a
// byte-identical zip. Run `npm run build:ext` first.
//
// Usage: node scripts/package-extension.mjs
import JSZip from 'jszip';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist-extension');
const releaseDir = join(root, 'release');
/** Zip timestamps are local DOS time; any fixed date keeps the output reproducible. */
const FIXED_DATE = new Date(2026, 0, 1, 0, 0, 0);

function fail(message) {
  console.error(`[package:ext] ${message}`);
  process.exit(1);
}

const manifestPath = join(dist, 'manifest.json');
if (!existsSync(manifestPath)) fail('dist-extension/manifest.json not found. Run `npm run build:ext` first.');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = manifest.version;
if (typeof version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(version)) {
  fail(`manifest.json has no valid version (got ${JSON.stringify(version)}).`);
}
if (version !== pkg.version) {
  fail(`dist-extension is version ${version} but package.json says ${pkg.version}. Run \`npm run build:ext\` again.`);
}
if (manifest.manifest_version !== 3) fail('manifest_version must be 3.');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}

// Leftovers that should never ship.
const SKIP = [/(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/i, /\.map$/, /(^|\/)\./];
const files = walk(dist)
  .map((abs) => ({ abs, rel: relative(dist, abs).split(sep).join('/') }))
  .filter((f) => !SKIP.some((re) => re.test(f.rel)))
  .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

const zip = new JSZip();
let bytes = 0;
for (const f of files) {
  const data = readFileSync(f.abs);
  bytes += data.length;
  zip.file(f.rel, data, { date: FIXED_DATE, createFolders: false });
}

const out = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
  platform: 'UNIX',
});

mkdirSync(releaseDir, { recursive: true });
const name = `gaze-reader-extension-v${version}.zip`;
const target = join(releaseDir, name);
writeFileSync(target, out);

// Read it back: the Web Store rejects a zip without manifest.json at its root.
const check = await JSZip.loadAsync(readFileSync(target));
const back = check.file('manifest.json');
if (!back) fail(`${name} has no manifest.json at its root.`);
if (JSON.parse(await back.async('string')).version !== version) fail(`${name} holds the wrong manifest.`);
const entries = Object.values(check.files).filter((e) => !e.dir).length;
if (entries !== files.length) fail(`${name} holds ${entries} files, expected ${files.length}.`);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`[package:ext] ${relative(root, target)}: ${files.length} files, ${mb(bytes)} → ${mb(statSync(target).size)} zipped`);
