import type { PdfTextItem } from './pdf';

/**
 * Reading the text off scanned pages (OCR), for PDFs that are pictures of pages.
 *
 * The engine is Tesseract compiled to WebAssembly (tesseract.js), run in web workers. Nothing
 * leaves the device: its worker script, its WebAssembly core and the English language data are
 * served with the app (scripts/copy-ocr-assets.mjs puts them in public/ocr), where the library by
 * default would fetch all three from public CDNs. They are loaded only when a scanned PDF is
 * opened (about 7 MB then, cached by the browser afterwards).
 *
 * What comes back is turned into the same positioned text items pdf.js gives for a PDF with real
 * text (one item per recognized line), so everything after that is shared: paragraphs and headings
 * for the text view, and the line boxes the pages view lays over the page for the eye tracker.
 */

/** Relative to document.baseURI: where scripts/copy-ocr-assets.mjs puts the engine and its data. */
export const OCR_ASSET_DIR = 'ocr';

/** A box in the px of the image that was recognized. */
export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One line as Tesseract reports it (the part of its output used here). */
export interface OcrLine {
  text: string;
  /** 0–100. */
  confidence: number;
  bbox: OcrBox;
  /** The line the letters sit on; tilted when the scan is. */
  baseline?: OcrBox | null;
  rowAttributes?: { rowHeight?: number; ascenders?: number; descenders?: number } | null;
  words?: OcrWord[] | null;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: OcrBox;
}

export interface OcrBlock {
  paragraphs?: { lines?: OcrLine[] | null }[] | null;
}

/** Below this, a "line" is more often a smudge, a page edge or a picture than text. */
const MIN_LINE_CONFIDENCE = 45;
/** A word below this at either end of a line is dropped from it (a shadow at the page's edge read as "|"). */
const MIN_EDGE_WORD_CONFIDENCE = 60;
/** Letters this small (in page points) are not body text anyone reads line by line. */
const MIN_SIZE_PT = 3;
/** Lines at least this share of the page's width say how crooked the page is. */
const SKEW_MIN_LINE_SHARE = 0.25;
/** A tilt beyond this (≈ 8°) isn't a crooked scan, it is a misread: leave the page as it is. */
const MAX_SKEW = 0.14;
/** Type sizes within this share of the page's commonest are taken to be that size (the estimate wobbles from line to line). */
const SIZE_SNAP = 0.14;

const hasWord = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);
const finiteBox = (b: OcrBox | null | undefined): b is OcrBox => !!b && [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite);

function medianOf(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A line's text and sideways extent without the junk at its ends; null when nothing is left. */
function trimmedLine(line: OcrLine): { text: string; x0: number; x1: number } | null {
  const whole = (line.text ?? '').replace(/\s+/g, ' ').trim();
  const words = (line.words ?? []).filter((w) => w && typeof w.text === 'string' && w.text.trim() && finiteBox(w.bbox));
  if (words.length === 0) return whole ? { text: whole, x0: line.bbox.x0, x1: line.bbox.x1 } : null;
  // From each end: marks with no letter or digit in them that the engine itself wasn't sure of,
  // and any lone stroke ("|", "_", "~": a page edge, a rule, a shadow), sure or not.
  const junk = (w: OcrWord): boolean => !hasWord(w.text) && (w.confidence < MIN_EDGE_WORD_CONFIDENCE || /^[|_~¦\\/‘’'`.,·-]+$/.test(w.text.trim()));
  let from = 0;
  let to = words.length;
  while (from < to && junk(words[from])) from++;
  while (to > from && junk(words[to - 1])) to--;
  // Closing punctuation belongs to the line: only strip a trailing mark the engine doubted.
  if (to < words.length && from < to) {
    let keep = to;
    while (keep < words.length && words[keep].confidence >= MIN_EDGE_WORD_CONFIDENCE && !/^[|_~¦\\/]+$/.test(words[keep].text.trim())) keep++;
    to = keep;
  }
  const kept = words.slice(from, to);
  if (kept.length === 0) return null;
  if (kept.length === words.length) return { text: whole, x0: line.bbox.x0, x1: line.bbox.x1 };
  return { text: kept.map((w) => w.text.trim()).join(' '), x0: Math.min(...kept.map((w) => w.bbox.x0)), x1: Math.max(...kept.map((w) => w.bbox.x1)) };
}

/** What a page's picture was read as. */
export interface OcrPageText {
  /** One item per recognized line, straightened when the scan was crooked (see `skew`). */
  items: PdfTextItem[];
  /** The tangent of the angle the page's lines run at (clockwise positive); 0 for a straight scan. */
  skew: number;
}

/**
 * The lines Tesseract found on a page image, as text items in page coordinates.
 * `scale` is image px per page unit (the scale the page was drawn at for recognition).
 *
 * A scan is rarely straight. At a degree and a half the left margin wanders 40 px down the page,
 * which reads as every line near the top being indented (a new paragraph each), and a short last
 * line sits half a line higher or lower than its neighbours. So the page's tilt is measured from
 * the lines' own baselines and the items are given as they would be on the straightened page;
 * `skew` says by how much, for whoever needs the lines where they are in the picture.
 */
export function ocrLinesToItems(blocks: readonly OcrBlock[] | null | undefined, scale: number, page: { width: number; height: number }): OcrPageText {
  if (!blocks || !(scale > 0)) return { items: [], skew: 0 };
  interface Found {
    text: string;
    x0: number;
    x1: number;
    /** Baseline at the line's middle. */
    y: number;
    size: number;
    slope: number;
  }
  const found: Found[] = [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        if (!finiteBox(line.bbox) || !(line.confidence >= MIN_LINE_CONFIDENCE)) continue;
        const trimmed = trimmedLine(line);
        if (!trimmed || !hasWord(trimmed.text)) continue;
        const { y0, y1 } = line.bbox;
        const { x0, x1 } = trimmed;
        if (!(x1 > x0) || !(y1 > y0)) continue;
        const b = finiteBox(line.baseline) && line.baseline.x1 > line.baseline.x0 ? line.baseline : null;
        const slope = b ? (b.y1 - b.y0) / (b.x1 - b.x0) : 0;
        // A tilted line's box is taller than its type: the tilt's share is taken off.
        const boxHeight = Math.max(1, y1 - y0 - Math.abs(slope) * (line.bbox.x1 - line.bbox.x0));
        // The row height is Tesseract's estimate of the type size; the box is the fallback (it is
        // shorter than the type on a line with no ascenders).
        const row = line.rowAttributes?.rowHeight;
        const size = typeof row === 'number' && row > 0 ? Math.min(row, boxHeight * 1.5) : boxHeight;
        const mid = (x0 + x1) / 2;
        const baseline = b ? b.y0 + slope * (mid - b.x0) : y1 - 0.22 * (y1 - y0);
        found.push({ text: trimmed.text, x0: x0 / scale, x1: x1 / scale, y: baseline / scale, size: size / scale, slope });
      }
    }
  }
  if (found.length === 0) return { items: [], skew: 0 };

  // The page's tilt: the middle slope of its long lines.
  const long = found.filter((l) => l.x1 - l.x0 >= SKEW_MIN_LINE_SHARE * page.width);
  const measured = long.length >= 3 ? medianOf(long.map((l) => l.slope)) : 0;
  const skew = Number.isFinite(measured) && Math.abs(measured) >= 0.002 && Math.abs(measured) <= MAX_SKEW ? measured : 0;
  // The page's commonest type size, for the lines whose estimate is merely off by a little.
  const body = medianOf(found.map((l) => l.size));

  const items: PdfTextItem[] = [];
  const cx = page.width / 2;
  const cy = page.height / 2;
  for (const l of found) {
    const size = Math.abs(l.size - body) <= SIZE_SNAP * body ? body : l.size;
    if (!(size >= MIN_SIZE_PT)) continue;
    // Straightened about the page's centre (small angles: a shear each way).
    const mid = (l.x0 + l.x1) / 2;
    const y = l.y - (mid - cx) * skew;
    const dx = (l.y - cy) * skew;
    const x = Math.max(0, l.x0 + dx);
    const width = Math.min(page.width, l.x1 + dx) - x;
    if (!(width > 0)) continue;
    items.push({ str: l.text, x, y: Math.min(page.height, Math.max(0, y)), width, height: size });
  }
  return { items, skew };
}

/** A page that has no text of its own, as the PDF loader hands it over to be read. */
export interface OcrPageRequest {
  /** 0-based. */
  index: number;
  /** In page units (PDF points). */
  width: number;
  height: number;
  /** Draws the page into `canvas` at `scale` px per page unit (sizes the canvas itself). */
  draw(canvas: HTMLCanvasElement, scale: number): Promise<void>;
}

/** Reads pages for one PDF, then is closed. */
export interface PdfOcrSession {
  /** How many `read` calls may run at once. */
  readonly concurrency: number;
  read(page: OcrPageRequest): Promise<OcrPageText>;
  close(): Promise<void>;
}

/**
 * The longer side of the picture a page is recognized from, in px: about 200 dpi for a Letter or
 * A4 page, where 10-point type has capitals some 18 px tall. Tesseract reads that well, and a
 * 300 dpi picture takes over twice as long for little gain on clean print.
 */
export const OCR_LONG_SIDE_PX = 2200;
const OCR_MAX_SCALE = 4;

/** The scale (px per page unit) a page of this size is drawn at for recognition. */
export function ocrScale(width: number, height: number): number {
  const long = Math.max(width, height);
  if (!(long > 0)) return 1;
  return Math.min(OCR_MAX_SCALE, Math.max(1, OCR_LONG_SIDE_PX / long));
}

/** The browser's session: Tesseract workers, and a canvas per page being read. */
export async function openOcrSession(pages: number): Promise<PdfOcrSession> {
  const engine = await createOcrEngine(ocrWorkerCount(pages));
  return {
    concurrency: engine.workers,
    async read(page) {
      const canvas = document.createElement('canvas');
      try {
        const scale = ocrScale(page.width, page.height);
        await page.draw(canvas, scale);
        return ocrLinesToItems(await engine.recognize(canvas), scale, page);
      } finally {
        // Give the picture's memory back now, not when the collector gets round to the canvas.
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    close: () => engine.destroy(),
  };
}

/** What recognition is asked to work on: a drawn page. */
export type OcrImage = HTMLCanvasElement;

/** A started engine. `recognize` calls may overlap up to `workers` at a time. */
export interface OcrEngine {
  readonly workers: number;
  recognize(image: OcrImage): Promise<OcrBlock[]>;
  /** Stops the workers. Recognitions in flight reject. */
  destroy(): Promise<void>;
}

/**
 * How many workers to run: each holds the engine and a page image (roughly 100–200 MB), and the
 * page still has to stay responsive. One fewer than the cores, three at most.
 */
export function ocrWorkerCount(pages: number, cores: number | undefined = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency): number {
  const usable = Number.isFinite(cores) && (cores as number) > 1 ? Math.floor(cores as number) - 1 : 1;
  return Math.max(1, Math.min(3, usable, Math.max(1, Math.floor(pages))));
}

function assetUrl(file: string): string {
  const base = typeof document !== 'undefined' ? document.baseURI : globalThis.location?.href;
  return new URL(`${OCR_ASSET_DIR}/${file}`, base).href;
}

/** Starts the engine (English). Rejects when its files can't be loaded. */
export async function createOcrEngine(workers: number): Promise<OcrEngine> {
  const tesseract = await import('tesseract.js');
  const options = {
    // All three from the app's own origin: no CDN, and nothing the content policy would refuse.
    workerPath: assetUrl('worker.min.js'),
    corePath: assetUrl('').replace(/\/$/, ''),
    langPath: assetUrl('').replace(/\/$/, ''),
    // The worker is a real file of ours, not a blob wrapper that imports it.
    workerBlobURL: false,
    // The browser's HTTP cache keeps the language data; no extra database of the library's own.
    cacheMethod: 'none',
    gzip: true,
  };
  const count = Math.max(1, Math.floor(workers));
  const pool: import('tesseract.js').Worker[] = [];
  try {
    // LSTM only (OEM 1): the smaller core and data, and the more accurate engine for print.
    for (let i = 0; i < count; i++) pool.push(await tesseract.createWorker('eng', 1, options));
  } catch (err) {
    await Promise.allSettled(pool.map((w) => w.terminate()));
    throw err;
  }
  const idle = [...pool];
  const waiting: ((w: import('tesseract.js').Worker) => void)[] = [];
  let destroyed = false;
  const take = (): Promise<import('tesseract.js').Worker> => {
    const w = idle.pop();
    return w ? Promise.resolve(w) : new Promise((resolve) => waiting.push(resolve));
  };
  const give = (w: import('tesseract.js').Worker): void => {
    const next = waiting.shift();
    if (next) next(w);
    else idle.push(w);
  };
  return {
    workers: count,
    async recognize(image) {
      if (destroyed) throw new Error('The text recognition engine was stopped.');
      const worker = await take();
      try {
        const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
        return (data.blocks ?? []) as OcrBlock[];
      } finally {
        give(worker);
      }
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await Promise.allSettled(pool.map((w) => w.terminate()));
    },
  };
}
