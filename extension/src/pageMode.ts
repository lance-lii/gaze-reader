/**
 * Page mode: the fallback for pages whose text can't be measured.
 *
 * Canvas- and image-based readers (Kindle Cloud Reader, Google Play Books,
 * some PDF viewers) draw their text as pixels, so `measureLines` finds no
 * lines and the line tracker has nothing to follow. When that lasts, the
 * session switches to page mode:
 *
 *  - a *pseudo layout* tiles the page's visual area (the biggest canvas or
 *    image in view, else a central column) with evenly spaced pseudo-lines.
 *    The PageEndDetector's geometric rules (glance-down, bottom-dwell) work on
 *    it unchanged; the line-tracker rule can't, since nobody is reading those
 *    lines, so the session gives the detector no line estimate in this mode;
 *  - pages turn by scrolling when the page scrolls, otherwise by sending the
 *    reader's own "next page" keys (ArrowRight + PageDown). Synthetic key
 *    events are untrusted, and many readers ignore them: best effort.
 *
 * Everything here is pure or DOM-only (no chrome.* APIs), so it can be tested
 * in jsdom.
 */
import type { LineLayout, Rect, TextLine } from '../../src/types';
import { IGNORE_ATTR } from '../../src/core/constants';
import type { PageTurnMethod } from './extStorage';
import { findScroller, scrollMetrics, type ScrollMetrics, type Scroller } from './pageGeometry';

export type ReadingMode = 'text' | 'page';

/** Fewer readable lines than this in view means "no text here". */
export const MIN_TEXT_LINES = 3;
/** How long there must be too few lines before page mode starts. */
export const ENTER_PAGE_MODE_MS = 2_000;
/** A measured line shorter than this (characters) doesn't count: page numbers, "Aa" buttons, "5 %". */
export const MIN_LINE_CHARS = 8;

// ───────────────────────────── counting real text ────────────────────────────

/**
 * Measured lines that hold more than a label's worth of text, either
 * overlapping the visible reading area (`viewport`) or anywhere measureLines
 * looked, which is up to half a screen beyond it (`nearby`).
 */
export function countReadableLines(layout: LineLayout | null, where: 'viewport' | 'nearby' = 'viewport'): number {
  if (!layout) return 0;
  const v = layout.viewport;
  let n = 0;
  for (const l of layout.lines) {
    if (l.charCount < MIN_LINE_CHARS) continue;
    if (where === 'nearby' || (l.bottom > v.top && l.top < v.bottom)) n++;
  }
  return n;
}

/**
 * The line count that decides the mode. Entering page mode needs the text to
 * be missing around the view too: at the end of an ordinary article the last
 * two lines sit above the footer, and that is not a canvas reader. Leaving it
 * needs real lines in view.
 */
export function modeLineCount(layout: LineLayout | null, mode: ReadingMode): number {
  return countReadableLines(layout, mode === 'text' ? 'nearby' : 'viewport');
}

// ──────────────────────────────── mode switching ─────────────────────────────

export interface PageModeMonitorOptions {
  minLines?: number;
  enterAfterMs?: number;
}

/**
 * Decides between text mode and page mode from successive line counts.
 * Enters page mode once the count has stayed below `minLines` for
 * `enterAfterMs`; returns to text mode as soon as real lines are back.
 */
export class PageModeMonitor {
  private readonly minLines: number;
  private readonly enterAfterMs: number;
  private current: ReadingMode = 'text';
  /** When the count first dropped below minLines (null while there is enough text). */
  private scarceSince: number | null = null;

  constructor(opts: PageModeMonitorOptions = {}) {
    this.minLines = opts.minLines ?? MIN_TEXT_LINES;
    this.enterAfterMs = opts.enterAfterMs ?? ENTER_PAGE_MODE_MS;
  }

  get mode(): ReadingMode {
    return this.current;
  }

  /**
   * True while the answer may change without the page telling us (no scroll,
   * no mutation): text is scarce and the clock decides, or page mode is on and
   * text may come back. The session then re-measures on its 1 s tick.
   */
  get needsPolling(): boolean {
    return this.current === 'page' || this.scarceSince !== null;
  }

  /** Feeds one measurement. Returns the mode to use from now on. */
  observe(readableLines: number, now: number): ReadingMode {
    if (readableLines >= this.minLines) {
      this.scarceSince = null;
      this.current = 'text';
      return this.current;
    }
    if (this.scarceSince === null || now < this.scarceSince) this.scarceSince = now;
    if (this.current === 'text' && now - this.scarceSince >= this.enterAfterMs) this.current = 'page';
    return this.current;
  }

  reset(): void {
    this.current = 'text';
    this.scarceSince = null;
  }
}

// ──────────────────────────────── pseudo layout ──────────────────────────────

export interface PseudoLayoutOptions {
  /** The visible reading area (viewport px). */
  viewport: Rect;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /**
   * Where the page's visual content is (e.g. the canvas holding the text),
   * viewport px. Clipped to the viewport; ignored when too small. Default: a
   * central column.
   */
  content?: Rect | null;
  /** Pseudo-line pitch, px. Default: derived from the area's height (24–48 px). */
  pitch?: number;
  now?: number;
}

/** A pseudo-line's box takes this share of the pitch (the rest is the gap to the next). */
const LINE_BOX = 0.75;
/** Content narrower or shorter than this share of the viewport isn't where the reading happens. */
const MIN_CONTENT_SHARE = 0.3;

/** The horizontal band a central text column would occupy in a viewport this wide. */
export function centralColumn(viewport: Rect): { left: number; right: number } {
  const vw = Math.max(0, viewport.right - viewport.left);
  const width = clamp(0.7 * vw, Math.min(vw, 300), 1_100);
  const left = viewport.left + (vw - width) / 2;
  return { left, right: left + width };
}

/**
 * A LineLayout over the visible page that looks like evenly set text: a column
 * of pseudo-lines at a typical reading pitch, the last one just above the
 * bottom of the content area. Every line is fully visible.
 */
export function buildPseudoLayout(opts: PseudoLayoutOptions): LineLayout {
  const v = opts.viewport;
  const col = centralColumn(v);
  let area: Rect = { left: col.left, right: col.right, top: v.top, bottom: v.bottom };
  const c = opts.content ? intersect(opts.content, v) : null;
  if (
    c &&
    c.right - c.left >= MIN_CONTENT_SHARE * (v.right - v.left) &&
    c.bottom - c.top >= MIN_CONTENT_SHARE * (v.bottom - v.top)
  ) {
    area = c;
  }
  const height = Math.max(1, area.bottom - area.top);
  const pitch = opts.pitch !== undefined && opts.pitch > 0 ? opts.pitch : clamp(Math.round(height / 20), 24, 48);
  const box = LINE_BOX * pitch;
  // Room for whole lines with half a pitch of margin at the top and a quarter at the bottom.
  const count = Math.max(1, Math.floor((height - 0.75 * pitch - box) / pitch) + 1);
  const lastBottom = area.bottom - 0.25 * pitch;
  const width = Math.max(1, area.right - area.left);
  const charCount = Math.max(1, Math.round(width / (pitch / 3)));

  const lines: TextLine[] = [];
  for (let i = 0; i < count; i++) {
    const bottom = lastBottom - (count - 1 - i) * pitch;
    const top = bottom - box;
    lines.push({
      index: i,
      top,
      bottom,
      left: area.left,
      right: area.right,
      centerY: (top + bottom) / 2,
      docTop: top - v.top + opts.scrollTop,
      charCount,
      fullyVisible: top >= v.top - 0.5 && bottom <= v.bottom + 0.5,
    });
  }
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  return {
    lines,
    viewport: { ...v },
    column: { left: area.left, right: area.right, top: first.top, bottom: last.bottom },
    linePitch: pitch,
    scrollTop: opts.scrollTop,
    scrollHeight: opts.scrollHeight,
    clientHeight: opts.clientHeight,
    measuredAt: opts.now ?? performance.now(),
  };
}

const VISUAL_SELECTOR = 'canvas, img, svg, video, embed, object, iframe';
/** Enough candidates for any reader; a page with thousands of images isn't worth scanning in full. */
const MAX_VISUAL_CANDIDATES = 500;

/**
 * The largest visual element (canvas, image, embed…) in view, clipped to the
 * viewport: on a canvas or image reader, that is the page being read.
 * Null when nothing covers at least 10 % of the viewport.
 */
export function largestVisualRect(doc: Document, viewport: Rect): Rect | null {
  return largestVisual(doc, viewport)?.rect ?? null;
}

function largestVisual(doc: Document, viewport: Rect): { element: Element; rect: Rect } | null {
  const vArea = (viewport.right - viewport.left) * (viewport.bottom - viewport.top);
  if (!(vArea > 0)) return null;
  let best: { element: Element; rect: Rect } | null = null;
  let bestArea = 0.1 * vArea;
  const candidates = doc.querySelectorAll(VISUAL_SELECTOR);
  const n = Math.min(candidates.length, MAX_VISUAL_CANDIDATES);
  for (let i = 0; i < n; i++) {
    const el = candidates[i]!;
    if (el.closest(`[${IGNORE_ATTR}]`)) continue; // our own UI
    // An <svg> inside a bigger <svg> is part of the same picture.
    if (el.localName === 'svg' && el.parentElement?.closest('svg')) continue;
    const r = el.getBoundingClientRect();
    const clipped = intersect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, viewport);
    if (!clipped) continue;
    const area = (clipped.right - clipped.left) * (clipped.bottom - clipped.top);
    if (area > bestArea) {
      bestArea = area;
      best = { element: el, rect: clipped };
    }
  }
  return best;
}

/**
 * The scroller page turns should move in page mode. The main-text heuristic
 * has little to go on there (the text is pixels), so the box around the
 * picture of the page and whatever sits at the center of the view are
 * candidates too. The first that really scrolls wins; failing that, the
 * main content's scroller (usually the window).
 */
export function findPageModeScroller(doc: Document, main: Element, viewport: Rect): Scroller {
  const candidates: Element[] = [main];
  const visual = largestVisual(doc, viewport);
  if (visual) candidates.push(visual.element);
  if (typeof doc.elementFromPoint === 'function') {
    const center = doc.elementFromPoint((viewport.left + viewport.right) / 2, (viewport.top + viewport.bottom) / 2);
    if (center && !center.closest(`[${IGNORE_ATTR}]`)) candidates.push(center);
  }
  for (const el of candidates) {
    const s = findScroller(el);
    if (isScrollable(scrollMetrics(s))) return s;
  }
  return findScroller(main);
}

// ──────────────────────────────── turning pages ──────────────────────────────

export type PageTurnVia = 'scroll' | 'keys';

/** A page scrolls for real (not a few pixels of overflow) when it can move at least half a screen. */
const SCROLLABLE_SHARE = 0.5;

export function isScrollable(metrics: ScrollMetrics | null): boolean {
  if (!metrics || !(metrics.clientHeight > 0)) return false;
  return metrics.scrollHeight - metrics.clientHeight >= SCROLLABLE_SHARE * metrics.clientHeight;
}

/**
 * How the next page turn moves the page. In text mode, "auto" always scrolls
 * (the measured lines say where to); in page mode it scrolls when the page
 * scrolls and sends the next-page key when it doesn't.
 */
export function resolvePageTurn(method: PageTurnMethod, mode: ReadingMode, metrics: ScrollMetrics | null): PageTurnVia {
  if (method !== 'auto') return method === 'keys' ? 'keys' : 'scroll';
  if (mode === 'text') return 'scroll';
  return isScrollable(metrics) ? 'scroll' : 'keys';
}

interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
}

const FORWARD_KEYS: readonly KeySpec[] = [
  { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  { key: 'PageDown', code: 'PageDown', keyCode: 34 },
];
const BACK_KEYS: readonly KeySpec[] = [
  { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  { key: 'PageUp', code: 'PageUp', keyCode: 33 },
];

/**
 * Presses the reader's page keys: keydown + keyup for ArrowRight then
 * PageDown (ArrowLeft then PageUp going back), on the focused element, or on
 * the body when nothing has focus, so they bubble to document and window
 * like real presses.
 *
 * Best effort: the events are untrusted (`isTrusted` is false). Readers that
 * check it, or that listen inside a cross-origin iframe, ignore them, and the
 * browser itself never scrolls for a synthetic PageDown.
 * Returns the element the keys were sent to.
 */
export function pressPageKeys(doc: Document, direction: 'forward' | 'back'): EventTarget {
  const active = doc.activeElement;
  // Our own UI (Dewey's menu) may hold focus; the page's reader wouldn't hear keys sent there.
  const focused = active && !active.closest(`[${IGNORE_ATTR}]`) ? active : null;
  const target: EventTarget = focused ?? doc.body ?? doc;
  const Keyboard = doc.defaultView?.KeyboardEvent ?? KeyboardEvent;
  for (const k of direction === 'forward' ? FORWARD_KEYS : BACK_KEYS) {
    for (const type of ['keydown', 'keyup'] as const) {
      // keyCode/which too: many readers still look at the legacy fields.
      const init: KeyboardEventInit = {
        key: k.key,
        code: k.code,
        keyCode: k.keyCode,
        which: k.keyCode,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      target.dispatchEvent(new Keyboard(type, init));
    }
  }
  return target;
}

// ──────────────────────────────── helpers ────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function intersect(a: Rect, b: Rect): Rect | null {
  const r = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return r.right - r.left > 1 && r.bottom - r.top > 1 ? r : null;
}
