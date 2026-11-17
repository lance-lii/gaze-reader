// Copies the MediaPipe tasks-vision WASM runtime out of node_modules so it can be
// served from our own origin (web app: public/mediapipe/wasm, extension: dist-extension/mediapipe/wasm).
// Usage: node scripts/copy-mediapipe-wasm.mjs <destDir>
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dest = resolve(process.argv[2] ?? 'public/mediapipe/wasm');
const src = resolve('node_modules/@mediapipe/tasks-vision/wasm');

if (!existsSync(src)) {
  console.error(`[copy-wasm] ${src} not found — run npm install first.`);
  process.exit(1);
}
/**
 * The "_module" runtime is the one FilesetResolver picks when asked for an ES-module loader
 * (forVisionTasks(base, true)). The app never asks (src/gaze/faceTracker.ts, and its test pins the
 * call), so those 12 MB stay out of the web app and the extension package.
 */
const unused = (name) => /_wasm_module_/.test(name);

mkdirSync(dest, { recursive: true });
let copied = 0;
for (const name of readdirSync(dest)) {
  if (unused(name)) rmSync(join(dest, name)); // left by an earlier version of this script
}
for (const name of readdirSync(src)) {
  if (unused(name)) continue;
  const from = join(src, name);
  const to = join(dest, name);
  // Same bytes already there: nothing to do. (Compared by content, not only by size: after an
  // upgrade a file of the same size is still a different runtime.)
  if (existsSync(to) && statSync(to).size === statSync(from).size && readFileSync(to).equals(readFileSync(from))) continue;
  cpSync(from, to);
  copied++;
}
console.log(`[copy-wasm] ${copied} file(s) copied to ${dest}`);
