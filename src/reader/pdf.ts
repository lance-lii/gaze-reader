import bundledWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { IS_ARTIFACT } from '../core/target';
import {
  BookLoadError,
  collapseWhitespace,
  draftFromElement,
  escapeHtml,
  finalizeBook,
  matchChapterLine,
  tameShouting,
  type ChapterDraft,
  type ParseOptions,
  type ParsedBook,
} from './bookLoader';
import { sanitizeToElement } from './sanitize';

// ───────────────────────────── Pure reconstruction ─────────────────────────────

/** One positioned run of text, in page coordinates with y growing downwards. */
export interface PdfTextItem {
  str: string;
  /** Left edge. */
  x: number;
  /** Baseline, measured from the top of the page. */
  y: number;
  width: number;
  /** Font size. */
  height: number;
}

export interface PdfPageText {
  width: number;
  height: number;
  items: PdfTextItem[];
}

export type PdfBlock = { kind: 'heading'; level: 2 | 3; text: string } | { kind: 'paragraph'; text: string };

interface Piece {
  x0: number;
  x1: number;
  y: number;
  size: number;
  text: string;
}

interface Line extends Piece {
  page: number;
  /** 0/1 = column, -1 = spans the whole width. */
  col: number;
}

const median = (values: number[]): number => {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Math.max/min over a mapped array without spreading it (huge pages would overflow the stack). */
function extremum<T>(items: readonly T[], value: (item: T) => number, pick: (a: number, b: number) => number, empty: number): number {
  let out = empty;
  for (const item of items) out = pick(out, value(item));
  return out;
}

const percentile = (values: number[], q: number): number => {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

function cleanItems(page: PdfPageText): PdfTextItem[] {
  const out: PdfTextItem[] = [];
  for (const it of page.items) {
    if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
    if (![it.x, it.y, it.width, it.height].every(Number.isFinite) || it.height <= 0) continue;
    out.push({ ...it, width: Math.max(0, it.width) });
  }
  return out;
}

/** Joins items on one baseline, adding a space only where the gap looks like one. */
function joinItems(items: PdfTextItem[], size: number): string {
  let text = '';
  let prevEnd = -Infinity;
  for (const it of items) {
    const gap = it.x - prevEnd;
    if (text && gap > size * 0.15 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
    text += it.str;
    prevEnd = Math.max(prevEnd, it.x + it.width);
  }
  return collapseWhitespace(text);
}

/** A large initial: one or two letters at least this many times the size of the text beside it. */
const DROP_CAP_RATIO = 1.8;

/**
 * Rows as text reads them. A row's size is that of most of its text, not of its largest run: one
 * large initial (a drop cap) made its whole line "larger type", which reads as a heading and
 * opened a chapter there. And the initial itself belongs to the first of the lines it spans, where
 * the word it starts is: "T" + "he quick brown fox", not a "T" in front of the line below.
 */
function settleRows(rows: { y: number; size: number; items: PdfTextItem[] }[]): void {
  for (const row of rows) {
    const chars = new Map<number, number>();
    for (const it of row.items) chars.set(it.height, (chars.get(it.height) ?? 0) + it.str.trim().length);
    let body = row.size;
    let most = -1;
    for (const [size, n] of chars) {
      if (n > most || (n === most && size > body)) {
        body = size;
        most = n;
      }
    }
    if (body !== row.size) {
      row.size = body;
      const baselines = row.items.filter((it) => it.height === body).map((it) => it.y);
      row.y = median(baselines);
    }
  }
  for (const row of rows) {
    for (const cap of [...row.items]) {
      const text = cap.str.trim();
      if (row.items.length < 2 || cap.height < DROP_CAP_RATIO * row.size || !/^\p{L}{1,2}$/u.test(text)) continue;
      if (row.items.some((it) => it !== cap && it.x < cap.x)) continue; // not at the start of its line
      // The lines the initial stands beside: the rows inside its height that start to its right.
      const spanned = rows
        .filter((r) => r.y <= row.y && r.y > cap.y - 0.95 * cap.height && r.items.every((it) => it === cap || it.x >= cap.x + 0.5 * cap.width))
        .sort((a, b) => a.y - b.y);
      const beside = spanned[0];
      if (!beside || beside === row) continue;
      row.items.splice(row.items.indexOf(cap), 1);
      for (const r of spanned) {
        const start = r.items.reduce((min, it) => Math.min(min, it.x), Infinity);
        // In the first line: the letter itself, flush against the word it starts, at that line's
        // size and baseline. In the others: nothing but its width, so that they start where the
        // paragraph does (set in beside the initial, they read as first lines of new paragraphs).
        r.items.push({ str: r === beside ? text : '', x: cap.x, y: r.y, width: Math.max(0, start - cap.x), height: r.size });
      }
    }
  }
}

/** Groups items into baseline rows, then splits rows at gaps wide enough to be column gutters. */
function pagePieces(page: PdfPageText): Piece[] {
  const items = cleanItems(page).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: { y: number; size: number; items: PdfTextItem[] }[] = [];
  for (const it of items) {
    let row: (typeof rows)[number] | undefined;
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 4; k--) {
      // Half the larger size, but never more than 0.8 of the smaller: a superscript sits a few
      // units off its line's baseline, while a three-line initial would otherwise gather three
      // lines of body text into its own row.
      const big = Math.max(rows[k].size, it.height);
      const small = Math.min(rows[k].size, it.height);
      if (Math.abs(rows[k].y - it.y) <= 0.5 * Math.min(big, 1.6 * small)) {
        row = rows[k];
        break;
      }
    }
    if (!row) {
      rows.push({ y: it.y, size: it.height, items: [it] });
      continue;
    }
    row.items.push(it);
    if (it.height > row.size) {
      // The biggest run (body text, not a superscript) defines the row's baseline.
      row.size = it.height;
      row.y = it.y;
    }
  }

  settleRows(rows);
  const pieces: Piece[] = [];
  for (const row of rows) {
    const sorted = row.items.sort((a, b) => a.x - b.x);
    let group: PdfTextItem[] = [];
    let end = -Infinity;
    const flush = (): void => {
      if (!group.length) return;
      const text = joinItems(group, row.size);
      if (text) {
        pieces.push({
          x0: group[0].x,
          x1: extremum(group, (g) => g.x + g.width, Math.max, -Infinity),
          y: row.y,
          size: row.size,
          text,
        });
      }
      group = [];
    };
    for (const it of sorted) {
      if (group.length && it.x - end > row.size * 1.8) flush();
      end = group.length ? Math.max(end, it.x + it.width) : it.x + it.width;
      group.push(it);
    }
    flush();
  }
  return pieces;
}

/** A vertical strip in the middle of the page that no narrow piece crosses = a column gutter. */
function findGutter(pieces: Piece[], pageWidth: number): number | null {
  if (pieces.length < 8 || !(pageWidth > 0)) return null;
  const BINS = 100;
  const narrow = pieces.filter((p) => p.x1 - p.x0 < 0.6 * pageWidth);
  const cover = new Array<number>(BINS).fill(0);
  for (const p of narrow) {
    const from = Math.max(0, Math.floor((p.x0 / pageWidth) * BINS));
    const to = Math.min(BINS - 1, Math.floor((p.x1 / pageWidth) * BINS));
    for (let b = from; b <= to; b++) cover[b]++;
  }
  const limit = Math.floor(narrow.length * 0.02);
  let best: { start: number; end: number } | null = null;
  let runStart = -1;
  for (let b = 30; b <= 71; b++) {
    const open = b <= 70 && cover[b] <= limit;
    if (open && runStart < 0) runStart = b;
    if (!open && runStart >= 0) {
      if (!best || b - 1 - runStart > best.end - best.start) best = { start: runStart, end: b - 1 };
      runStart = -1;
    }
  }
  if (!best) return null;
  const gutter = (((best.start + best.end + 1) / 2) / BINS) * pageWidth;
  const left = pieces.filter((p) => p.x1 <= gutter).length;
  const right = pieces.filter((p) => p.x0 >= gutter).length;
  if (left < 4 || right < 4 || left < pieces.length * 0.2 || right < pieces.length * 0.2) return null;
  return gutter;
}

function mergePiecesIntoLines(pieces: Piece[], page: number, col: number): Line[] {
  const sorted = [...pieces].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines: Line[] = [];
  for (const p of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - p.y) <= 0.5 * Math.max(last.size, p.size)) {
      last.text = `${last.text} ${p.text}`;
      last.x0 = Math.min(last.x0, p.x0);
      last.x1 = Math.max(last.x1, p.x1);
      continue;
    }
    lines.push({ ...p, page, col });
  }
  return lines;
}

/** Lines of one page in reading order (two-column pages: header, left column, right column, footer). */
function pageLines(page: PdfPageText, pageIndex: number): Line[] {
  const pieces = pagePieces(page);
  const gutter = findGutter(pieces, page.width);
  if (gutter === null) return mergePiecesIntoLines(pieces, pageIndex, 0);

  const left = pieces.filter((p) => p.x1 <= gutter);
  const right = pieces.filter((p) => p.x0 >= gutter);
  const spanning = pieces.filter((p) => p.x0 < gutter && p.x1 > gutter);
  const columnTop = Math.min(extremum(left, (p) => p.y, Math.min, Infinity), extremum(right, (p) => p.y, Math.min, Infinity));
  return [
    ...mergePiecesIntoLines(spanning.filter((p) => p.y < columnTop), pageIndex, -1),
    ...mergePiecesIntoLines(left, pageIndex, 0),
    ...mergePiecesIntoLines(right, pageIndex, 1),
    ...mergePiecesIntoLines(spanning.filter((p) => p.y >= columnTop), pageIndex, -1),
  ];
}

// ───────────────────────────── Page layouts (the pages view) ─────────────────────────────

/** One line of text on a PDF page, in page units (the page is `width` × `height`, y grows downwards). */
export interface PdfLineBox {
  x0: number;
  x1: number;
  /** Baseline. */
  y: number;
  /** Font size: the line's box is taken to reach from y − 0.8 × size to y + 0.25 × size. */
  size: number;
  text: string;
}

/** What the pages view needs to know about one page besides its picture. */
export interface PdfPageLayout {
  width: number;
  height: number;
  /**
   * The page is set in two columns. Its `lines` are in reading order (heading, left column, right
   * column, foot), but lines of the two columns share heights, so they can't be followed as one
   * top-to-bottom sequence: the pages view leaves such a page to the keyboard and to gestures.
   */
  columns: boolean;
  lines: PdfLineBox[];
}

/** The original file and its pages' line boxes: kept beside the extracted text so the pages can be shown as they are. */
export interface PdfSource {
  bytes: ArrayBuffer;
  pages: PdfPageLayout[];
}

/** PDFs larger than this are not kept for the pages view (browser storage is limited). */
export const MAX_PDF_SOURCE_BYTES = 64 * 1024 * 1024;
/** At most this many characters of a line are kept (a line box only needs to be found, not read from here). */
const MAX_LINE_TEXT = 400;

/** Line boxes of every page, in reading order. Pure: the same grouping the text reconstruction uses. */
export function layoutPdfPages(pages: readonly PdfPageText[]): PdfPageLayout[] {
  return pages.map((page, index) => {
    const width = Number.isFinite(page.width) && page.width > 0 ? page.width : 0;
    const height = Number.isFinite(page.height) && page.height > 0 ? page.height : 0;
    if (!width || !height) return { width: width || 1, height: height || 1, columns: false, lines: [] };
    const columns = findGutter(pagePieces(page), width) !== null;
    const lines: PdfLineBox[] = [];
    for (const l of pageLines(page, index)) {
      // Inside the page, and wide enough to be a line rather than a stray mark.
      if (!(l.x1 > l.x0) || l.y <= 0 || l.y - l.size > height || l.x1 <= 0 || l.x0 >= width) continue;
      lines.push({ x0: Math.max(0, l.x0), x1: Math.min(width, l.x1), y: l.y, size: l.size, text: l.text.slice(0, MAX_LINE_TEXT) });
    }
    return { width, height, columns, lines };
  });
}

/** Sources of PDFs parsed in this page load, until whoever opens the book collects them (by the parsed book's id). */
const pendingSources = new Map<string, PdfSource>();
const MAX_PENDING_SOURCES = 2;

/**
 * The source of a PDF that parsePdf produced a book with this id from, once: the caller stores it
 * with the book (library.savePdfSource). Null for anything else, or when the file was too large.
 */
export function takePdfSource(bookId: string): PdfSource | null {
  const source = pendingSources.get(bookId) ?? null;
  pendingSources.delete(bookId);
  return source;
}

function rememberSource(bookId: string, source: PdfSource): void {
  pendingSources.delete(bookId);
  pendingSources.set(bookId, source);
  // Books that were parsed and never opened (a newer request won) don't pile up.
  while (pendingSources.size > MAX_PENDING_SOURCES) pendingSources.delete(pendingSources.keys().next().value as string);
}

/**
 * A folio: "12", "Page 12 of 300", "– 12 –", or front-matter Roman numerals — only
 * well-formed ones, so a lone word such as "civil", "mild" or "vivid" at the edge of a
 * page is never mistaken for a page number.
 */
const BARE_PAGE_NUMBER =
  /^(?:page\s+)?(?:\d{1,4}|(?=[ivxl])(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))(?:\s*(?:of|\/)\s*\d{1,4})?$|^[-–—]\s*\d{1,4}\s*[-–—]$/i;

/**
 * Removes running heads/feet and page numbers. Candidates are the top/bottom two
 * lines of a page inside the outer 10 % margins. A number is a page number when
 * (number − page index) matches the offset most pages share, so "Chapter 7" at the
 * top of a chapter-opening page is not mistaken for one.
 */
function dropRunningHeads(pagesLines: Line[][], pages: readonly PdfPageText[]): Line[][] {
  type Candidate = { line: Line; norm: string; num: number | null; rest: string };
  const candidates: Candidate[] = [];
  pagesLines.forEach((lines, p) => {
    const height = pages[p].height;
    if (!(height > 0) || lines.length === 0) return;
    const byY = [...lines].sort((a, b) => a.y - b.y);
    const edge = new Set([...byY.slice(0, 2), ...byY.slice(-2)]);
    for (const line of edge) {
      const top = line.y - line.size;
      if (top > height * 0.1 && line.y < height * 0.9) continue;
      const norm = line.text.toLowerCase().replace(/\s+/g, ' ').trim();
      const m = /^(\d{1,4})\s+(.+)$/.exec(norm) ?? /^(.+?)\s+(\d{1,4})$/.exec(norm);
      let num: number | null = null;
      let rest = norm;
      if (m) {
        const leading = /^\d/.test(m[1]);
        num = Number(leading ? m[1] : m[2]);
        rest = leading ? m[2] : m[1];
      }
      candidates.push({ line, norm, num, rest });
    }
  });

  const offsets = new Map<number, number>();
  for (const c of candidates) {
    if (c.num === null) continue;
    const offset = c.num - (c.line.page + 1);
    offsets.set(offset, (offsets.get(offset) ?? 0) + 1);
  }
  const numberedPages = new Set(candidates.filter((c) => c.num !== null).map((c) => c.line.page)).size;
  const dominant = new Set([...offsets].filter(([, n]) => n >= Math.max(2, Math.ceil(numberedPages * 0.3))).map(([o]) => o));

  const keyOf = (c: Candidate): string =>
    c.num !== null && dominant.has(c.num - (c.line.page + 1)) ? `r:${c.rest}` : `n:${c.norm}`;
  const pagesPerKey = new Map<string, Set<number>>();
  for (const c of candidates) {
    const key = keyOf(c);
    const set = pagesPerKey.get(key) ?? new Set<number>();
    set.add(c.line.page);
    pagesPerKey.set(key, set);
  }
  const minRepeat = pages.length >= 5 ? 3 : pages.length >= 2 ? 2 : Infinity;

  const drop = new Set<Line>();
  for (const c of candidates) {
    if (BARE_PAGE_NUMBER.test(c.norm) || (pagesPerKey.get(keyOf(c))?.size ?? 0) >= minRepeat) drop.add(c.line);
  }
  return pagesLines.map((lines) => lines.filter((l) => !drop.has(l)));
}

function joinLineText(a: string, b: string): string {
  if (/\p{L}[-\u00ad]$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b; // "recon-" + "struction"
  if (/\u00ad$/.test(a)) return a.slice(0, -1) + b;
  if (/[—–/]$/.test(a) || /^[—–]/.test(b)) return a + b;
  return `${a} ${b}`;
}

interface Metrics {
  body: number;
  gap: number;
  left: (l: Line) => number;
  right: (l: Line) => number;
}

function measure(lines: Line[]): Metrics {
  const weights = new Map<number, number>();
  for (const l of lines) {
    const size = Math.round(l.size * 2) / 2;
    weights.set(size, (weights.get(size) ?? 0) + l.text.length);
  }
  const body = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12;
  const isBody = (l: Line): boolean => Math.abs(l.size - body) <= body * 0.15;

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1];
    const b = lines[i];
    if (a.page === b.page && a.col === b.col && isBody(a) && isBody(b) && b.y - a.y > body * 0.3) gaps.push(b.y - a.y);
  }
  const gap = gaps.length ? median(gaps) : body * 1.2;

  const groups = new Map<string, Line[]>();
  const globalBody = lines.filter(isBody);
  for (const l of globalBody) {
    const key = `${l.page}:${l.col}`;
    const g = groups.get(key) ?? [];
    g.push(l);
    groups.set(key, g);
  }
  const cache = new Map<string, { left: number; right: number }>();
  const edges = (l: Line): { left: number; right: number } => {
    const key = `${l.page}:${l.col}`;
    let e = cache.get(key);
    if (!e) {
      const g = groups.get(key);
      const src = g && g.length >= 5 ? g : globalBody.length ? globalBody : lines;
      const lefts = src.map((x) => Math.round(x.x0));
      const counts = new Map<number, number>();
      for (const v of lefts) counts.set(v, (counts.get(v) ?? 0) + 1);
      const mode = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
      e = { left: Math.min(mode, percentile(lefts, 0.1)), right: percentile(src.map((x) => x.x1), 0.9) };
      cache.set(key, e);
    }
    return e;
  };
  return { body, gap, left: (l) => edges(l).left, right: (l) => edges(l).right };
}

const BULLET_START = /^(?:[•◦▪‣∙·]|[–-]\s|\(?\d{1,3}[.)]\s|\(?[a-z][.)]\s)/;

function startsNewBlock(a: Line, b: Line, m: Metrics): boolean {
  const width = Math.max(1, m.right(a) - m.left(a));
  if (Math.abs(a.size - b.size) > m.body * 0.15) return true;
  if (a.page === b.page && a.col === b.col && b.y - a.y > m.gap * 1.55) return true;
  const indent = b.x0 - m.left(b);
  if (indent > m.body * 0.8 && indent < m.body * 8) return true;
  if (BULLET_START.test(b.text)) return true;
  const shortfall = m.right(a) - a.x1;
  if (shortfall > width * 0.4) return true;
  return shortfall > Math.max(m.body * 3, width * 0.1) && /[.!?:…”"’)\]]$/.test(a.text);
}

/**
 * Rebuilds readable blocks from positioned PDF text: reading order (incl. two
 * columns), running heads and page numbers removed, lines joined into paragraphs
 * (with hyphenated line breaks repaired), larger type and "Chapter N" lines as headings.
 */
export function reconstructBlocks(pages: readonly PdfPageText[]): PdfBlock[] {
  const lines = dropRunningHeads(
    pages.map((p, i) => pageLines(p, i)),
    pages,
  ).flat();
  if (lines.length === 0) return [];
  const m = measure(lines);

  const groups: Line[][] = [];
  for (const line of lines) {
    const current = groups[groups.length - 1];
    const prev = current?.[current.length - 1];
    if (!prev || startsNewBlock(prev, line, m)) groups.push([line]);
    else current.push(line);
  }

  const blocks: PdfBlock[] = [];
  for (const group of groups) {
    const text = group.map((l) => l.text).reduce(joinLineText);
    const size = extremum(group, (l) => l.size, Math.max, 0);
    const larger = size >= m.body * 1.18 && text.length <= 200;
    const chapterLine = group.length === 1 && matchChapterLine(text) !== null;
    if (larger || chapterLine) {
      const level: 2 | 3 = size >= m.body * 1.45 || (chapterLine && !larger) ? 2 : 3;
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === 'heading' && prev.level === level && prev.text.length + text.length < 200) {
        prev.text = `${prev.text} ${text}`; // a heading set on two lines
      } else {
        blocks.push({ kind: 'heading', level, text });
      }
    } else {
      blocks.push({ kind: 'paragraph', text });
    }
  }
  return blocks;
}

// ─────────────────────────────── pdf.js driver ───────────────────────────────

type PdfJs = typeof import('pdfjs-dist');

/**
 * Where pdf.js loads its worker from. The Artifact build publishes the worker
 * next to the page under this fixed name (scripts/build-artifact.mjs), and the
 * frame only lets the page load files it published, by a document-relative URL.
 */
export const ARTIFACT_PDF_WORKER_FILE = 'pdf.worker.min.mjs';

function workerUrl(): string {
  if (!IS_ARTIFACT) return bundledWorkerUrl;
  const base = typeof document !== 'undefined' ? document.baseURI : globalThis.location?.href;
  return base ? new URL(ARTIFACT_PDF_WORKER_FILE, base).href : ARTIFACT_PDF_WORKER_FILE;
}
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist')
    .then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl();
      return pdfjs;
    })
    .catch((err: unknown) => {
      pdfjsPromise = null;
      throw new BookLoadError('parse', 'The PDF reader component failed to load. Check your connection and try again.', {
        cause: err,
      });
    });
  return pdfjsPromise;
}

function pdfError(err: unknown): BookLoadError {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'PasswordException') {
    return new BookLoadError('drm', 'This PDF is password-protected. Remove the password and open it again.', { cause: err });
  }
  if (name === 'InvalidPDFException') {
    return new BookLoadError('parse', 'This PDF file is damaged, or isn’t really a PDF.', { cause: err });
  }
  return new BookLoadError('parse', 'This PDF couldn’t be read.', { cause: err });
}

function metadataString(info: unknown, key: string): string | null {
  if (!info || typeof info !== 'object') return null;
  const v = (info as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? collapseWhitespace(v) : null;
}

/** Document titles that are really just file names or tool output. */
const JUNK_TITLE = /^(?:untitled|document\d*|microsoft word\b.*|.*\.(?:docx?|pdf|odt|rtf|txt|indd|tex))$/i;

function blocksToDrafts(blocks: PdfBlock[]): ChapterDraft[] {
  const chapters: { title: string | null; html: string[] }[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading' && block.level === 2) {
      chapters.push({ title: block.text.slice(0, 160), html: [] });
    } else if (chapters.length === 0) {
      chapters.push({ title: null, html: [] });
    }
    const tag = block.kind === 'heading' ? `h${block.level}` : 'p';
    chapters[chapters.length - 1].html.push(`<${tag}>${escapeHtml(block.text)}</${tag}>`);
  }
  // A chapter that is only its heading (a part title page) joins the next chapter.
  const merged: { title: string | null; html: string[] }[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    const next = chapters[i + 1];
    if (c.html.length === 1 && c.title && next) {
      next.html.unshift(...c.html);
      next.title = next.title ?? c.title;
      continue;
    }
    merged.push(c);
  }
  return merged.map((c) => draftFromElement(sanitizeToElement(c.html.join('\n')), c.title));
}

/** Extracts the text of a PDF into paragraphs. pdf.js is loaded on first use only. */
export async function parsePdf(data: ArrayBuffer, opts: ParseOptions = {}): Promise<ParsedBook> {
  const pdfjs = await loadPdfJs();
  // pdf.js transfers (detaches) the buffer it is given: hand it a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), verbosity: 0, stopAtErrors: false });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    void task.destroy();
    throw pdfError(err);
  }

  try {
    const pages: PdfPageText[] = [];
    let chars = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items) {
        if (!('str' in raw) || !raw.str) continue;
        const t = pdfjs.Util.transform(viewport.transform, raw.transform).map(Number);
        const size = Math.hypot(t[2], t[3]);
        if (!(size > 0) || Math.abs(t[1]) > size * 0.1 || Math.abs(t[2]) > size * 0.1) continue; // rotated text
        items.push({ str: raw.str, x: t[4], y: t[5], width: raw.width * viewport.scale, height: size });
        chars += raw.str.trim().length;
      }
      pages.push({ width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }

    const blocks = reconstructBlocks(pages);
    if (chars < 40 || blocks.length === 0) {
      throw new BookLoadError(
        'empty',
        chars === 0
          ? 'This PDF has no selectable text — it’s probably scanned page images. Try a text-based version, or run it through OCR first.'
          : 'This PDF has almost no selectable text (a few words at most), so there is nothing to read as a book. If its pages are scanned images, run it through OCR first.',
      );
    }

    const meta = await doc.getMetadata().catch(() => null);
    const infoTitle = metadataString(meta?.info, 'Title');
    const firstHeading = blocks.find((b) => b.kind === 'heading')?.text ?? null;
    const book = finalizeBook(
      {
        title: infoTitle && !JUNK_TITLE.test(infoTitle) ? infoTitle : firstHeading ? tameShouting(firstHeading) : null,
        author: metadataString(meta?.info, 'Author'),
        format: 'pdf',
        fallbackTitle: opts.fallbackTitle,
      },
      blocksToDrafts(blocks),
    );
    // pdf.js was handed a copy, so `data` is still whole: keep it for the pages view. (Not in the
    // Artifact frame, whose content policy doesn't let pdf.js load a document's embedded fonts.)
    if (!IS_ARTIFACT && data.byteLength > 0 && data.byteLength <= MAX_PDF_SOURCE_BYTES) {
      rememberSource(book.id, { bytes: data, pages: layoutPdfPages(pages) });
    }
    return book;
  } catch (err) {
    throw err instanceof BookLoadError ? err : pdfError(err);
  } finally {
    void task.destroy();
  }
}

// ─────────────────────────────── Page pictures ───────────────────────────────

/** An open PDF that draws its pages (the pages view). */
export interface PdfDocumentHandle {
  readonly pageCount: number;
  /**
   * Draws page `index` (0-based) into `canvas`, `cssWidth` CSS px wide at `pixelRatio` device px
   * per CSS px (the canvas is resized to fit). Resolves true when the page was drawn, false when
   * the drawing was cancelled (by `cancel`, a newer render into the same canvas, or `destroy`).
   */
  render(index: number, canvas: HTMLCanvasElement, cssWidth: number, pixelRatio: number): Promise<boolean>;
  /** Stops the drawing into `canvas`, if one is running. */
  cancel(canvas: HTMLCanvasElement): void;
  destroy(): void;
}

/** A page is never drawn larger than this many device px (a canvas that size is ≈ 64 MB). */
const MAX_PAGE_PIXELS = 16_000_000;

/** Opens a PDF for drawing. Rejects with a BookLoadError when it can't be read. */
export async function openPdfDocument(bytes: ArrayBuffer): Promise<PdfDocumentHandle> {
  const pdfjs = await loadPdfJs();
  // pdf.js detaches the buffer it is given: hand it a copy, the caller keeps theirs.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), verbosity: 0, stopAtErrors: false });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    void task.destroy();
    throw pdfError(err);
  }
  let destroyed = false;
  const running = new Map<HTMLCanvasElement, { cancel(): void }>();
  return {
    pageCount: doc.numPages,
    async render(index, canvas, cssWidth, pixelRatio) {
      if (destroyed || !(cssWidth > 0) || index < 0 || index >= doc.numPages) return false;
      running.get(canvas)?.cancel();
      const page = await doc.getPage(index + 1);
      if (destroyed) return false;
      const base = page.getViewport({ scale: 1 });
      let scale = (cssWidth / base.width) * (pixelRatio > 0 ? pixelRatio : 1);
      const pixels = base.width * base.height * scale * scale;
      if (pixels > MAX_PAGE_PIXELS) scale *= Math.sqrt(MAX_PAGE_PIXELS / pixels);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      // Pictures only: no link or form annotations are drawn, and nothing in the file is run.
      const task = page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE });
      const entry = { cancel: () => task.cancel() };
      running.set(canvas, entry);
      try {
        await task.promise;
        return !destroyed;
      } catch (err) {
        const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
        if (name === 'RenderingCancelledException') return false;
        throw err;
      } finally {
        if (running.get(canvas) === entry) running.delete(canvas);
        page.cleanup();
      }
    },
    cancel(canvas) {
      running.get(canvas)?.cancel();
      running.delete(canvas);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const r of running.values()) r.cancel();
      running.clear();
      void task.destroy();
    },
  };
}
