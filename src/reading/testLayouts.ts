import type { LineLayout, Rect, TextLine } from '../types';
import { mulberry32 } from './simulatedReader';

/**
 * Synthetic `LineLayout`s with the same geometry conventions as
 * `measureLines` (src/reader/lineGeometry.ts): a line's box is the text's
 * client rect (≈ 0.62 × pitch tall for a 1.9 line-height), `docTop` is
 * `(top − viewport.top) + scrollTop`, lines are sorted by top, and the layout
 * holds the lines within viewport ± margin. Shared by the reading-layer tests
 * and handy for demos.
 */

export interface DocLine {
  /** Text rect top in scroll-content coordinates. */
  docTop: number;
  left: number;
  right: number;
  charCount: number;
  /** Index of the paragraph this line belongs to. */
  paragraph: number;
  /** Last line of its paragraph (usually short). */
  paragraphEnd: boolean;
}

export interface SyntheticDocOptions {
  /** Total number of text lines. Default 24. */
  lines?: number;
  /** Distance between consecutive line centers, px. Default 42 (22 px × 1.9). */
  pitch?: number;
  /** Column extent, viewport px. Default 160..860. */
  columnLeft?: number;
  columnRight?: number;
  /** Width of one character, px. Default: column width / 62. */
  charWidth?: number;
  /** Text rect height as a fraction of the pitch. Default 0.62. */
  textHeightRatio?: number;
  /** Extra vertical space between paragraphs, px. Default 0.5 × pitch. */
  paragraphGap?: number;
  /** First-line indent, px. Default 0. */
  indentPx?: number;
  /** Paragraph length range (lines). Default [3, 7]. Use [n, n] for a fixed length; Infinity for one paragraph. */
  paragraphLines?: readonly [number, number];
  /** Width range of paragraph-final lines as a fraction of the column. Default [0.18, 0.8]. */
  shortLineFraction?: readonly [number, number];
  /** Doc-space top of the first line's line box. Default 0.5 × pitch. */
  firstLineBoxTop?: number;
  seed?: number;
}

export interface LayoutAtOptions {
  /** Visible reading area (viewport px). Default { left: 0, top: 0, right: 1024, bottom: 900 }. */
  viewport?: Rect;
  /** Include lines this far outside the viewport. Default 0.5 × viewport height. */
  marginPx?: number;
  measuredAt?: number;
}

export interface SyntheticDocument {
  readonly lines: readonly DocLine[];
  readonly pitch: number;
  readonly textHeight: number;
  readonly scrollHeight: number;
  /** The layout `measureLines` would report at this scroll position. */
  layoutAt(scrollTop: number, opts?: LayoutAtOptions): LineLayout;
}

export const DEFAULT_TEST_VIEWPORT: Readonly<Rect> = Object.freeze({ left: 0, top: 0, right: 1024, bottom: 900 });

export function makeDocument(opts: SyntheticDocOptions = {}): SyntheticDocument {
  const pitch = opts.pitch ?? 42;
  const colLeft = opts.columnLeft ?? 160;
  const colRight = opts.columnRight ?? 860;
  const colWidth = colRight - colLeft;
  const charWidth = opts.charWidth ?? colWidth / 62;
  const textHeight = Math.round((opts.textHeightRatio ?? 0.62) * pitch);
  const gap = opts.paragraphGap ?? 0.5 * pitch;
  const indent = opts.indentPx ?? 0;
  const [pMin, pMax] = opts.paragraphLines ?? [3, 7];
  const [sMin, sMax] = opts.shortLineFraction ?? [0.18, 0.8];
  const total = Math.max(0, Math.floor(opts.lines ?? 24));
  const rng = mulberry32(opts.seed ?? 7);
  const randInt = (a: number, b: number): number => a + Math.floor(rng() * (b - a + 1));

  const lines: DocLine[] = [];
  let boxTop = opts.firstLineBoxTop ?? 0.5 * pitch;
  let paragraph = 0;
  while (lines.length < total) {
    const len = Number.isFinite(pMax) ? randInt(Math.max(1, pMin), Math.max(pMin, pMax)) : total;
    for (let k = 0; k < len && lines.length < total; k++) {
      const last = k === len - 1;
      const left = colLeft + (k === 0 ? indent : 0);
      const right = last && len > 1 ? left + colWidth * (sMin + rng() * (sMax - sMin)) : colRight;
      lines.push({
        docTop: boxTop + (pitch - textHeight) / 2,
        left,
        right: Math.min(colRight, right),
        charCount: Math.max(1, Math.round((Math.min(colRight, right) - left) / charWidth)),
        paragraph,
        paragraphEnd: last,
      });
      boxTop += pitch;
    }
    boxTop += gap;
    paragraph++;
  }

  const scrollHeight = boxTop + pitch;

  function layoutAt(scrollTop: number, o: LayoutAtOptions = {}): LineLayout {
    const viewport = o.viewport ?? DEFAULT_TEST_VIEWPORT;
    const vh = viewport.bottom - viewport.top;
    const margin = o.marginPx ?? 0.5 * vh;
    const out: TextLine[] = [];
    for (const l of lines) {
      const top = l.docTop - scrollTop + viewport.top;
      const bottom = top + textHeight;
      if (bottom < viewport.top - margin || top > viewport.bottom + margin) continue;
      out.push({
        index: out.length,
        top,
        bottom,
        left: l.left,
        right: l.right,
        centerY: top + textHeight / 2,
        docTop: l.docTop,
        charCount: l.charCount,
        fullyVisible: top >= viewport.top && bottom <= viewport.bottom,
      });
    }
    return {
      lines: out,
      viewport: { ...viewport },
      column: unionRect(out),
      linePitch: medianPitch(out, pitch),
      scrollTop,
      scrollHeight,
      clientHeight: vh,
      measuredAt: o.measuredAt ?? 0,
    };
  }

  return { lines, pitch, textHeight, scrollHeight, layoutAt };
}

export interface ReadingPageOptions extends SyntheticDocOptions {
  /** Also include a line cut off by the bottom edge (not fully visible). Default true. */
  partialLastLine?: boolean;
  /** Extra space between the last fully visible line's box and the viewport bottom, px. Default 0.25 × pitch. */
  bottomSlackPx?: number;
  viewportTop?: number;
}

/**
 * One page of the standard test scene: 18–24 fully visible lines (seeded),
 * pitch 42, column 160..860, paragraph-final short lines, paragraph gaps, and
 * (by default) a half-visible line at the bottom edge.
 */
export function makeReadingPage(seed: number, opts: ReadingPageOptions = {}): LineLayout {
  const rng = mulberry32(seed * 7919 + 13);
  const fullLines = opts.lines ?? 18 + Math.floor(rng() * 7);
  const partial = opts.partialLastLine ?? true;
  const doc = makeDocument({ ...opts, lines: fullLines + (partial ? 1 : 0), seed: opts.seed ?? seed });
  const lastFull = doc.lines[fullLines - 1]!;
  const vTop = opts.viewportTop ?? 0;
  const lastBoxBottom = lastFull.docTop + doc.textHeight + (doc.pitch - doc.textHeight) / 2;
  let bottom = vTop + lastBoxBottom + (opts.bottomSlackPx ?? 0.25 * doc.pitch);
  if (partial) {
    // Cut the next line through the middle of its text so it is visible but unreadable.
    const next = doc.lines[fullLines]!;
    bottom = vTop + next.docTop + doc.textHeight / 2;
  }
  return doc.layoutAt(0, { viewport: { left: 0, top: vTop, right: 1024, bottom } });
}

/** Index of the last fully visible line, or -1. */
export function lastFullyVisibleIndex(layout: LineLayout): number {
  for (let i = layout.lines.length - 1; i >= 0; i--) if (layout.lines[i]!.fullyVisible) return i;
  return -1;
}

function unionRect(lines: readonly TextLine[]): Rect {
  if (lines.length === 0) return { left: 0, top: 0, right: 0, bottom: 0 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const l of lines) {
    left = Math.min(left, l.left);
    top = Math.min(top, l.top);
    right = Math.max(right, l.right);
    bottom = Math.max(bottom, l.bottom);
  }
  return { left, top, right, bottom };
}

function medianPitch(lines: readonly TextLine[], fallback: number): number {
  if (lines.length < 2) return fallback;
  const d: number[] = [];
  for (let i = 1; i < lines.length; i++) d.push(lines[i]!.centerY - lines[i - 1]!.centerY);
  d.sort((a, b) => a - b);
  const m = d.length >> 1;
  return d.length % 2 ? d[m]! : (d[m - 1]! + d[m]!) / 2;
}
