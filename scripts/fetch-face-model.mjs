// Puts the MediaPipe Face Landmarker model where the app can serve it from its own origin
// (web app: public/mediapipe/models, extension: dist-extension/mediapipe/models), so that using
// the webcam needs no request to anyone else's server, and so that the model the app runs is the
// one this file names: the download is checked against a pinned SHA-256.
//
// Usage: node scripts/fetch-face-model.mjs <destDir> [--required]
//   --required  fail when the model can't be fetched (builds). Without it a failed download only
//               warns (npm run dev offline): the app then falls back to fetching the model from
//               Google at runtime, as it always did.
// A file with the wrong hash is an error either way.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
export const MODEL_FILE = 'face_landmarker.task';
/** Of the file at MODEL_URL (3 758 596 bytes). A new model version means a new URL and a new hash here. */
export const MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const args = process.argv.slice(2);
const required = args.includes('--required');
const dest = resolve(args.find((a) => !a.startsWith('--')) ?? 'public/mediapipe/models');
const target = join(dest, MODEL_FILE);

if (existsSync(target) && sha256(readFileSync(target)) === MODEL_SHA256) {
  console.log(`[face-model] up to date in ${dest}`);
  process.exit(0);
}

let bytes;
try {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  bytes = Buffer.from(await res.arrayBuffer());
} catch (err) {
  const why = err instanceof Error ? err.message : String(err);
  if (required) {
    console.error(`[face-model] couldn't download the face model (${why}). A build needs it: check the connection and try again.`);
    process.exit(1);
  }
  console.warn(`[face-model] couldn't download the face model (${why}); the app will fetch it from Google at runtime instead.`);
  process.exit(0);
}

const got = sha256(bytes);
if (got !== MODEL_SHA256) {
  console.error(`[face-model] the downloaded model is not the pinned one.\n  expected ${MODEL_SHA256}\n  got      ${got}\nNot written. If the model was updated on purpose, pin the new hash in scripts/fetch-face-model.mjs.`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
writeFileSync(target, bytes);
console.log(`[face-model] ${(bytes.length / 1e6).toFixed(1)} MB written to ${dest} (sha256 verified)`);
