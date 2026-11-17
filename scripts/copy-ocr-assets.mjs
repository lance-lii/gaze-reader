// Copies the OCR engine (Tesseract compiled to WebAssembly) and its English language data out of
// node_modules into public/ocr, so the web app serves them from its own origin: by default
// tesseract.js fetches its worker, its core and the language data from public CDNs.
// They are only downloaded by a browser that opens a scanned PDF (see src/reader/ocr.ts).
// Usage: node scripts/copy-ocr-assets.mjs [destDir]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dest = resolve(process.argv[2] ?? 'public/ocr');

/**
 * [source in node_modules, file name served]. The cores are the LSTM-only builds (the app asks for
 * OEM 1): the worker picks one of the three by what the browser's WebAssembly supports. The
 * language data is the "best, integer" English model, LSTM only (3 MB; the legacy+LSTM one is 11).
 */
const FILES = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
];

mkdirSync(dest, { recursive: true });
const wanted = new Set(FILES.map(([, name]) => name));
for (const name of readdirSync(dest)) {
  if (!wanted.has(name)) rmSync(join(dest, name), { recursive: true }); // from another version
}
let copied = 0;
for (const [source, name] of FILES) {
  const from = resolve('node_modules', source);
  if (!existsSync(from)) {
    console.error(`[copy-ocr] ${from} not found — run npm install first.`);
    process.exit(1);
  }
  const to = join(dest, name);
  if (existsSync(to) && statSync(to).size === statSync(from).size && readFileSync(to).equals(readFileSync(from))) continue;
  cpSync(from, to);
  copied++;
}
console.log(`[copy-ocr] ${copied} file(s) copied to ${dest}`);
