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
/** A "line" of at most this many characters that overlaps a neighbour is folded into it… */
const STRAY_MAX_CHARS = 4;
/** …when they overlap by at least this share of the smaller height (real lines barely touch). */
const STRAY_OVERLAP = 0.2;

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

const clips = (overflow: string): boolean => overflow === 'hidden' || overflow === 'clip';

/**
 * The band that the content of `el` can show up in. Text that overflows a box with
 * `overflow: hidden | clip` is invisible — collapsed accordions (`height: 0`),
 * line-clamped teasers, truncated cards — so it must not become phantom lines on
 * top of the real text. Scroll containers (auto/scroll) are left alone: their
 * content is about to be scrolled into view, which is what the margin is for.
 * Returns null when nothing of the content can be visible.
 */
function clipBand(band: Band, rect: DOMRect, style: CSSStyleDeclaration): Band | null {
  if (style.display === 'inline' || style.display === 'contents') return band; // overflow doesn't apply
  // Browsers resolve the longhands; some engines (jsdom) only keep the shorthand ("x [y]").
  const [shortX = '', shortY = shortX] = (style.overflow || '').trim().split(/\s+/);
  const clipX = clips(style.overflowX) || clips(shortX);
  const clipY = clips(style.overflowY) || clips(shortY);
  if (!clipX && !clipY) return band;
  const out: Band = {
    top: clipY ? Math.max(band.top, rect.top) : band.top,
    bottom: clipY ? Math.min(band.bottom, rect.bottom) : band.bottom,
    left: clipX ? Math.max(band.left, rect.left) : band.left,
    right: clipX ? Math.min(band.right, rect.right) : band.right,
  };
  return out.bottom - out.top < 1 || out.right - out.left < 1 ? null : out;
}

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
    const stack: { el: Element; band: Band }[] = [{ el: root, band: this.band }];
    while (stack.length > 0) {
      const { el, band: outer } = stack.pop() as { el: Element; band: Band };
      if (isIgnored(el)) continue;

      const rect = el.getBoundingClientRect();
      const zero = isZeroSize(rect);
      if (!zero) {
        if (misses(rect, outer)) continue;
        if (rect.width <= 2 && rect.height <= 2) continue; // "visually hidden" screen-reader text
      }
      const style = getComputedStyle(el);
      if (isHiddenByStyle(style)) continue;
      const band = clipBand(outer, rect, style);
      if (!band) continue;
      const vertical = stacksVertically(style);

      const texts: Text[] = [];
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === Node.TEXT_NODE && /\S/.test((n as Text).data)) texts.push(n as Text);
      }
      // Thousands of <br>-separated text nodes (old-school web fiction) get the same band search as elements.
      const range = this.range;
      const [textFrom, textTo] =
        texts.length >= BINARY_SEARCH_MIN_CHILDREN && vertical && range && typeof range.getBoundingClientRect === 'function'
          ? this.bandRange(band, texts.length, (i) => {
              range.selectNodeContents(texts[i]);
              return range.getBoundingClientRect();
            })
          : [0, texts.length];
      for (let i = textFrom; i < textTo; i++) this.measureText(texts[i], band);

      // Only children that can hold text; <br>s between those text nodes need no layout queries at all.
      const kids: Element[] = [];
      for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.firstChild) kids.push(c);
      if (kids.length === 0) continue;
      const [from, to] =
        kids.length >= BINARY_SEARCH_MIN_CHILDREN && vertical
          ? this.bandRange(band, kids.length, (i) => kids[i].getBoundingClientRect())
          : [0, kids.length];
      for (let i = to - 1; i >= from; i--) stack.push({ el: kids[i], band });
    }
  }

  /**
   * Items [from, to) of a vertically stacked list that can intersect the band.
   * Zero-size items (display:none, empty anchors) carry no position, so probes step over them.
   */
  private bandRange(band: Band, n: number, rectAt: (i: number) => DOMRect): [number, number] {
    const probe = (i: number): { index: number; rect: DOMRect } | null => {
      for (let j = i; j < n && j < i + 16; j++) {
        const rect = rectAt(j);
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
      if (p.rect.bottom >= band.top) {
        start = Math.min(start, p.index);
        hi = mid - 1;
      } else {
        lo = p.index + 1;
      }
    }
    const from = Math.max(0, start - 1);

    // Walk forward until items start below the band (allowing a little non-monotonic slack).
    let to = from;
    let below = 0;
    while (to < n && below < 2) {
      const rect = rectAt(to);
      if (!isZeroSize(rect) && rect.top > band.bottom) below++;
      to++;
    }
    return [from, to];
  }

  private measureText(node: Text, band: Band): void {
    const range = this.range;
    const data = node.data;
    if (!range || !/\S/.test(data)) return;

    let start = 0;
    let end = data.length;
    if (data.length > LONG_TEXT && typeof range.getBoundingClientRect === 'function') {
      [start, end] = this.textWindow(node, range, band);
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
      if (r.bottom < band.top || r.top > band.bottom || r.right < band.left || r.left > band.right) continue;
      this.fragments.push({
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        chars: (chars * r.width) / totalWidth,
      });
    }
  }

  /**
   * Character offsets of a long text node that cover the band, found by binary search
   * on small ranges. When a probe finds no box on either side (a long run of collapsed
   * whitespace), the search can't tell which way to go: rather than guess — and risk
   * cutting visible lines off — the whole node is measured.
   */
  private textWindow(node: Text, range: Range, band: Band): [number, number] {
    const len = node.data.length;
    const CHUNK = 12;
    const PROBES = 8;
    const boxAt = (o: number): DOMRect | null => {
      range.setStart(node, o);
      range.setEnd(node, Math.min(len, o + CHUNK));
      const r = range.getBoundingClientRect();
      return isZeroSize(r) ? null : r;
    };
    const rectAt = (offset: number): DOMRect | null => {
      // Newlines and collapsed whitespace can have empty rects: look for a visible chunk nearby.
      for (let k = 0; k < PROBES; k++) {
        const ahead = offset + k * CHUNK;
        if (ahead < len) {
          const r = boxAt(ahead);
          if (r) return r;
        }
        const behind = offset - (k + 1) * CHUNK;
        if (behind >= 0) {
          const r = boxAt(behind);
          if (r) return r;
        }
      }
      return null;
    };
    const search = (test: (r: DOMRect) => boolean): number | null => {
      let lo = 0;
      let hi = len;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const r = rectAt(mid);
        if (r === null) return null;
        if (test(r)) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const first = search((r) => r.bottom >= band.top);
    const last = first === null ? null : search((r) => r.top > band.bottom);
    if (first === null || last === null) return [0, len];
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
  return foldStrayFragments(lines.sort((a, b) => a.coreTop - b.coreTop));
}

/**
 * A few characters that overlap an adjacent line belong to it; they are not a
 * line of their own. Chrome reports an `initial-letter` drop cap as a
 * glyph-sized box about half a line *above* its first line (too little overlap
 * to join it in mergeIntoLines), which would otherwise put a phantom
 * three-character line at the top of every chapter.
 */
function foldStrayFragments(lines: LineAcc[]): LineAcc[] {
  if (lines.length < 2) return lines;
  const share = (a: LineAcc, b: LineAcc): number => {
    const overlap = Math.min(a.coreBottom, b.coreBottom) - Math.max(a.coreTop, b.coreTop);
    const smaller = Math.min(a.coreBottom - a.coreTop, b.coreBottom - b.coreTop);
    return smaller > 0 ? overlap / smaller : 0;
  };
  const out: LineAcc[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.chars <= STRAY_MAX_CHARS) {
      const prev = out[out.length - 1];
      const next = lines[i + 1];
      const toPrev = prev ? share(line, prev) : 0;
      const toNext = next ? share(line, next) : 0;
      const host = toNext >= toPrev ? next : prev;
      if (host && Math.max(toPrev, toNext) >= STRAY_OVERLAP && host.chars > line.chars) {
        host.left = Math.min(host.left, line.left);
        host.right = Math.max(host.right, line.right);
        host.chars += line.chars;
        continue;
      }
    }
    out.push(line);
  }
  return out;
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

  const column: Rect = { left: Infinity, top: lines[0].top, right: -Infinity, bottom: -Infinity };
  for (const l of lines) {
    column.left = Math.min(column.left, l.left);
    column.right = Math.max(column.right, l.right);
    column.bottom = Math.max(column.bottom, l.bottom);
  }
  return { ...base, lines, column, linePitch };
}
