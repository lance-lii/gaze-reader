// Copies the MediaPipe tasks-vision WASM runtime out of node_modules so it can be
// served from our own origin (web app: public/mediapipe/wasm, extension: dist-extension/mediapipe/wasm).
// Usage: node scripts/copy-mediapipe-wasm.mjs <destDir>
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dest = resolve(process.argv[2] ?? 'public/mediapipe/wasm');
const src = resolve('node_modules/@mediapipe/tasks-vision/wasm');

if (!existsSync(src)) {
  console.error(`[copy-wasm] ${src} not found — run npm install first.`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
let copied = 0;
for (const name of readdirSync(src)) {
  const from = join(src, name);
  const to = join(dest, name);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  cpSync(from, to);
  copied++;
}
console.log(`[copy-wasm] ${copied} file(s) copied to ${dest}`);
