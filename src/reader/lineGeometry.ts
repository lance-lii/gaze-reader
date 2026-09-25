import { IGNORE_ATTR } from '../core/constants';
import type { LineLayout, Rect, TextLine } from '../types';

/**
 * Measures the text lines of a DOM subtree in viewport coordinates. Generic on
 * purpose: the browser extension runs it over arbitrary web pages.
 *
 * Cost is kept proportional to what is near the viewport, not to the size of the
 * document: element subtrees are pruned by their bounding box, long runs of
 * children are binary-searched instead of scanned, and very long text nodes (a
 * whole book inside one <pre>) are windowed by character offset.
 */

export interface MeasureOptions {
  /** Subtree to measure. */
  root: Element;
  /** Visible reading area (viewport px). */
  viewport: Rect;
  /** scroller.scrollTop (or window.scrollY). */
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Include lines this far outside the viewport (default 0.5 × viewport height). */
  marginPx?: number;
}

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'title', 'svg', 'math', 'canvas', 'video', 'audio',
  'iframe', 'object', 'embed', 'img', 'picture', 'input', 'textarea', 'select', 'button', 'option', 'datalist',
  'meter', 'progress',
]);

/** Children lists at least this long are binary-searched for the viewport band. */
const BINARY_SEARCH_MIN_CHILDREN = 24;
/** Text nodes longer than this are measured through a character window around the band. */
const LONG_TEXT = 4000;
/** Characters of slack on each side of the window so partial edge lines fall outside the band. */
const WINDOW_SLACK = 600;
/** A fragment joins a line when they overlap by at least this share of the smaller height. */
const LINE_OVERLAP = 0.5;

interface Fragment {
  top: number;
  bottom: number;
  left: number;
  right: number;
  chars: number;
}

interface Band {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

function normalizeRect(r: Rect): Rect {
  const left = finite(r.left);
  const top = finite(r.top);
  return { left, top, right: Math.max(left, finite(r.right, left)), bottom: Math.max(top, finite(r.bottom, top)) };
}

function isIgnored(el: Element): boolean {
  if (SKIP_TAGS.has(el.localName.toLowerCase())) return true;
  if (el.hasAttribute(IGNORE_ATTR)) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  return el.hasAttribute('hidden');
}

function isHiddenByStyle(style: CSSStyleDeclaration): boolean {
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.opacity === '0' ||
    style.contentVisibility === 'hidden'
  );
}

/** Whether children of this container are laid out top-to-bottom in document order. */
function stacksVertically(style: CSSStyleDeclaration): boolean {
  if (/flex|grid|table|contents|ruby|inline/.test(style.display)) return false;
  const columns = (v: string): boolean => v === '' || v === 'auto';
  if (!columns(style.columnCount) || !columns(style.columnWidth)) return false;
  return style.writingMode === '' || style.writingMode === 'horizontal-tb';
}

function misses(r: DOMRect, band: Band): boolean {
  return r.bottom < band.top || r.top > band.bottom || r.right < band.left || r.left > band.right;
}

const isZeroSize = (r: DOMRect): boolean => r.width === 0 && r.height === 0;

class Measurer {
  readonly fragments: Fragment[] = [];
  private readonly range: Range | null;

  constructor(
    doc: Document,
    private readonly band: Band,
  ) {
    const range = doc.createRange();
    this.range = typeof range.getClientRects === 'function' ? range : null;
  }

  walk(root: Element): void {
    const stack: Element[] = [root];
    while (stack.length > 0) {
      const el = stack.pop() as Element;
      if (isIgnored(el)) continue;

      const rect = el.getBoundingClientRect();
      const zero = isZeroSize(rect);
      if (!zero) {
        if (misses(rect, this.band)) continue;
        if (rect.width <= 2 && rect.height <= 2) continue; // "visually hidden" screen-reader text
      }
      const style = getComputedStyle(el);
      if (isHiddenByStyle(style)) continue;

      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === Node.TEXT_NODE) this.measureText(n as Text);
      }

      const kids = el.children;
      if (kids.length === 0) continue;
      const [from, to] =
        kids.length >= BINARY_SEARCH_MIN_CHILDREN && stacksVertically(style) ? this.bandRange(kids) : [0, kids.length];
      for (let i = to - 1; i >= from; i--) stack.push(kids[i]);
    }
  }

  /**
   * Children [from, to) that can intersect the band, assuming they stack vertically.
   * Zero-size children (display:none, empty anchors) carry no position, so probes step over them.
   */
  private bandRange(kids: HTMLCollection): [number, number] {
    const n = kids.length;
    const probe = (i: number): { index: number; rect: DOMRect } | null => {
      for (let j = i; j < n && j < i + 16; j++) {
        const rect = kids[j].getBoundingClientRect();
        if (!isZeroSize(rect)) return { index: j, rect };
      }
      return null;
    };

    let lo = 0;
    let hi = n - 1;
    let start = n;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = probe(mid);
      if (!p) return [0, n]; // no positional information here: scan everything
      if (p.rect.bottom >= this.band.top) {
        start = Math.min(start, p.index);
        hi = mid - 1;
      } else {
        lo = p.index + 1;
      }
    }
    const from = Math.max(0, start - 1);

    // Walk forward until children start below the band (allowing a little non-monotonic slack).
    let to = from;
    let below = 0;
    while (to < n && below < 2) {
      const rect = kids[to].getBoundingClientRect();
      if (!isZeroSize(rect) && rect.top > this.band.bottom) below++;
      to++;
    }
    return [from, to];
  }

  private measureText(node: Text): void {
    const range = this.range;
    const data = node.data;
    if (!range || !/\S/.test(data)) return;

    let start = 0;
    let end = data.length;
    if (data.length > LONG_TEXT && typeof range.getBoundingClientRect === 'function') {
      [start, end] = this.textWindow(node, range);
      if (start >= end) return;
    }
    range.setStart(node, start);
    range.setEnd(node, end);
    const rects = range.getClientRects();
    if (rects.length === 0) return;

    const chars = data.slice(start, end).replace(/\s+/g, ' ').trim().length;
    let totalWidth = 0;
    for (let i = 0; i < rects.length; i++) totalWidth += Math.max(0, rects[i].width);
    if (!(totalWidth > 0)) return;

    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.bottom < this.band.top || r.top > this.band.bottom || r.right < this.band.left || r.left > this.band.right) continue;
      this.fragments.push({
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        chars: (chars * r.width) / totalWidth,
      });
    }
  }

  /** Character offsets of a long text node that cover the band, found by binary search on small ranges. */
  private textWindow(node: Text, range: Range): [number, number] {
    const len = node.data.length;
    const CHUNK = 12;
    const rectAt = (offset: number): DOMRect | null => {
      // Newlines and collapsed whitespace can have empty rects: step forward to find a visible chunk.
      for (let o = offset; o < len && o < offset + CHUNK * 8; o += CHUNK) {
        range.setStart(node, o);
        range.setEnd(node, Math.min(len, o + CHUNK));
        const r = range.getBoundingClientRect();
        if (!isZeroSize(r)) return r;
      }
      return null;
    };
    const search = (test: (r: DOMRect) => boolean): number => {
      let lo = 0;
      let hi = len;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const r = rectAt(mid);
        if (r === null || test(r)) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const first = search((r) => r.bottom >= this.band.top);
    const last = search((r) => r.top > this.band.bottom);
    return [Math.max(0, first - WINDOW_SLACK), Math.min(len, last + WINDOW_SLACK)];
  }
}

interface LineAcc {
  coreTop: number;
  coreBottom: number;
  coreChars: number;
  left: number;
  right: number;
  chars: number;
}

function overlapShare(f: Fragment, line: LineAcc): number {
  const overlap = Math.min(f.bottom, line.coreBottom) - Math.max(f.top, line.coreTop);
  const smaller = Math.min(f.bottom - f.top, line.coreBottom - line.coreTop);
  return smaller > 0 ? overlap / smaller : 0;
}

/**
 * Groups rect fragments into lines. A line's vertical extent is that of its
 * dominant fragment (most characters), so a tall inline element, a drop cap or a
 * superscript neither chains two lines together nor shifts the line's center.
 */
function mergeIntoLines(fragments: Fragment[]): LineAcc[] {
  const sorted = [...fragments].sort((a, b) => a.top + a.bottom - (b.top + b.bottom) || a.left - b.left);
  const lines: LineAcc[] = [];
  for (const f of sorted) {
    let target: LineAcc | null = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 2; k--) {
      if (overlapShare(f, lines[k]) >= LINE_OVERLAP) {
        target = lines[k];
        break;
      }
    }
    if (!target) {
      lines.push({ coreTop: f.top, coreBottom: f.bottom, coreChars: f.chars, left: f.left, right: f.right, chars: f.chars });
      continue;
    }
    target.left = Math.min(target.left, f.left);
    target.right = Math.max(target.right, f.right);
    target.chars += f.chars;
    if (f.chars > target.coreChars) {
      target.coreTop = f.top;
      target.coreBottom = f.bottom;
      target.coreChars = f.chars;
    }
  }
  return lines.sort((a, b) => a.coreTop - b.coreTop);
}

function fallbackPitch(root: Element, lines: LineAcc[]): number {
  try {
    const style = getComputedStyle(root);
    const lh = Number.parseFloat(style.lineHeight);
    if (Number.isFinite(lh) && lh > 0) return lh;
    const fs = Number.parseFloat(style.fontSize);
    if (Number.isFinite(fs) && fs > 0) return fs * 1.2;
  } catch {
    /* detached or foreign element */
  }
  if (lines.length === 1) return (lines[0].coreBottom - lines[0].coreTop) * 1.5;
  return 24;
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Measures the text lines of `root` that intersect the viewport (± margin). */
export function measureLines(opts: MeasureOptions): LineLayout {
  const viewport = normalizeRect(opts.viewport);
  const height = viewport.bottom - viewport.top;
  const width = viewport.right - viewport.left;
  const scrollTop = finite(opts.scrollTop);
  const base = {
    viewport,
    scrollTop,
    scrollHeight: Math.max(0, finite(opts.scrollHeight)),
    clientHeight: Math.max(0, finite(opts.clientHeight)),
    measuredAt: now(),
  };
  const empty = (): LineLayout => ({
    ...base,
    lines: [],
    column: { ...viewport },
    linePitch: fallbackPitch(opts.root, []),
  });
  if (!(height > 0) || !(width > 0) || !opts.root?.isConnected) return empty();

  const margin = opts.marginPx !== undefined && Number.isFinite(opts.marginPx) ? Math.max(0, opts.marginPx) : height * 0.5;
  const band: Band = {
    top: viewport.top - margin,
    bottom: viewport.bottom + margin,
    left: viewport.left - 1,
    right: viewport.right + 1,
  };

  const measurer = new Measurer(opts.root.ownerDocument, band);
  measurer.walk(opts.root);
  const acc = mergeIntoLines(measurer.fragments);
  if (acc.length === 0) return empty();

  const lines: TextLine[] = acc.map((l, index) => ({
    index,
    top: l.coreTop,
    bottom: l.coreBottom,
    left: l.left,
    right: l.right,
    centerY: (l.coreTop + l.coreBottom) / 2,
    docTop: l.coreTop - viewport.top + scrollTop,
    charCount: Math.max(1, Math.round(l.chars)),
    fullyVisible: l.coreTop >= viewport.top - 0.5 && l.coreBottom <= viewport.bottom + 0.5,
  }));

  const deltas: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].centerY - lines[i - 1].centerY;
    if (d > 0) deltas.push(d);
  }
  const linePitch = deltas.length ? medianOf(deltas) : fallbackPitch(opts.root, acc);

  return {
    ...base,
    lines,
    column: {
      left: Math.min(...lines.map((l) => l.left)),
      top: lines[0].top,
      right: Math.max(...lines.map((l) => l.right)),
      bottom: Math.max(...lines.map((l) => l.bottom)),
    },
    linePitch,
  };
}
