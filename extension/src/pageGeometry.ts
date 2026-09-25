import type { Rect } from '../../src/types';
import { IGNORE_ATTR } from '../../src/core/constants';

export type Scroller = HTMLElement | Window;

const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);

export function isWindow(s: Scroller): s is Window {
  return 'document' in s && (s as Window).window === s;
}

/**
 * The element that scrolls `content`: `window`, unless the content lives in a
 * scrollable ancestor (an app-like layout whose body doesn't scroll).
 */
export function findScroller(content: Element): Scroller {
  const doc = content.ownerDocument;
  const view = doc.defaultView;
  if (!view) return window;
  // <body> only scrolls on its own when <html>'s overflow isn't visible; otherwise its overflow drives the viewport.
  const bodyScrollsItself = style(view, doc.documentElement)?.overflowY !== 'visible';
  for (let a: Element | null = content; a && a !== doc.documentElement; a = a.parentElement) {
    if (a === doc.body && !bodyScrollsItself) continue;
    const cs = style(view, a);
    if (!cs || !SCROLLABLE_OVERFLOW.has(cs.overflowY)) continue;
    const el = a as HTMLElement;
    if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) return el;
  }
  return view;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function scrollMetrics(scroller: Scroller): ScrollMetrics {
  if (isWindow(scroller)) {
    const doc = scroller.document;
    const se = doc.scrollingElement ?? doc.documentElement;
    return {
      scrollTop: finite(scroller.scrollY, se.scrollTop),
      scrollHeight: finite(se.scrollHeight, 0),
      clientHeight: finite(scroller.innerHeight, se.clientHeight),
    };
  }
  return {
    scrollTop: finite(scroller.scrollTop, 0),
    scrollHeight: finite(scroller.scrollHeight, 0),
    clientHeight: finite(scroller.clientHeight, 0),
  };
}

/**
 * The visible reading area in viewport px: the scroller's client box clipped
 * to the window, minus fixed/sticky bars along the top and bottom edges.
 * Returns null when there is no usable area (zero-size or collapsed viewport).
 */
export function readingViewport(scroller: Scroller, win: Window = window): Rect | null {
  const doc = win.document;
  const vw = finite(doc.documentElement.clientWidth, 0) || finite(win.innerWidth, 0);
  const vh = finite(win.innerHeight, 0) || finite(doc.documentElement.clientHeight, 0);
  let rect: Rect = { left: 0, top: 0, right: vw, bottom: vh };

  if (!isWindow(scroller)) {
    const r = scroller.getBoundingClientRect();
    const left = r.left + scroller.clientLeft;
    const top = r.top + scroller.clientTop;
    rect = intersect(rect, { left, top, right: left + scroller.clientWidth, bottom: top + scroller.clientHeight });
  }
  if (!(rect.right - rect.left > 1 && rect.bottom - rect.top > 1)) return null;

  const insets = edgeObstructions(doc, rect);
  const inset = { ...rect, top: insets.top, bottom: insets.bottom };
  // Never let a huge "bar" (a modal, a cookie wall) swallow the whole page.
  return inset.bottom - inset.top >= 0.35 * (rect.bottom - rect.top) ? inset : rect;
}

/**
 * Probes the top and bottom edges for fixed/sticky bars (site headers, cookie
 * banners) that cover content. Only the topmost hit at each probe counts, so
 * page content that merely sits at the edge isn't mistaken for a bar.
 */
export function edgeObstructions(doc: Document, rect: Rect): { top: number; bottom: number } {
  const out = { top: rect.top, bottom: rect.bottom };
  const view = doc.defaultView;
  if (!view || typeof doc.elementsFromPoint !== 'function') return out;
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const xs = [0.2, 0.5, 0.8].map((f) => rect.left + width * f);
  const maxBar = 0.4 * height;

  for (let pass = 0; pass < 3; pass++) {
    let next = out.top;
    for (const x of xs) {
      const bar = barAt(doc, view, x, out.top + 1, width);
      if (bar && bar.top <= out.top + 2 && bar.bottom - rect.top <= maxBar) next = Math.max(next, bar.bottom);
    }
    if (next <= out.top) break;
    out.top = next;
  }
  for (let pass = 0; pass < 3; pass++) {
    let next = out.bottom;
    for (const x of xs) {
      const bar = barAt(doc, view, x, out.bottom - 1, width);
      if (bar && bar.bottom >= out.bottom - 2 && rect.bottom - bar.top <= maxBar) next = Math.min(next, bar.top);
    }
    if (next >= out.bottom) break;
    out.bottom = next;
  }
  return out;
}

function barAt(doc: Document, view: Window, x: number, y: number, readingWidth: number): DOMRect | null {
  let stack: Element[];
  try {
    stack = doc.elementsFromPoint(x, y);
  } catch {
    return null;
  }
  for (const el of stack) {
    if (el.closest(`[${IGNORE_ATTR}]`)) continue; // our own UI
    let a: Element | null = el;
    for (let depth = 0; a && depth < 12 && a !== doc.body && a !== doc.documentElement; depth++, a = a.parentElement) {
      const pos = style(view, a)?.position;
      if (pos === 'fixed' || pos === 'sticky') {
        const r = a.getBoundingClientRect();
        return r.width >= 0.3 * readingWidth && r.height > 0 ? r : null;
      }
    }
    return null; // the topmost thing here is ordinary content
  }
  return null;
}

function intersect(a: Rect, b: Rect): Rect {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

function style(view: Window, el: Element): CSSStyleDeclaration | null {
  try {
    return view.getComputedStyle(el);
  } catch {
    return null;
  }
}

function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}
