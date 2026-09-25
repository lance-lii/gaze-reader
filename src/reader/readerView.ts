import { CSS_PREFIX, IGNORE_ATTR } from '../core/constants';
import type { AppSettings, Book, EventBus, LineLayout, ReadingPosition, Unsubscribe } from '../types';
import { measureLines } from './lineGeometry';
import { FONT_STACKS, READER_CSS, READER_STYLE_ATTR } from './reader.css';
import { sanitizeToFragment } from './sanitize';

/**
 * Renders a Book as one continuous, beautifully set column inside its own scroll
 * container, and answers the questions the reading pipeline asks: which lines are
 * on screen (measureLayout), where the reader is (getPosition / progress), and how
 * to get back there (open(book, position)).
 *
 * Positions survive typography and window-size changes: the paragraph at the top
 * of the view is re-anchored after every relayout.
 */

export interface ReaderViewOptions {
  mount: HTMLElement;
  bus: EventBus;
}

/** Block elements that can carry a reading-position anchor (leaf-most ones win). */
const ANCHOR_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, dt, dd, pre, figcaption, blockquote, div';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const DROPCAP_MIN_CHARS = 120;
const TOP_GAP_PITCH = 0.35;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function requestFrame(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => cb());
  return setTimeout(cb, 16) as unknown as number;
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
}

interface Anchor {
  el: HTMLElement;
  /** Scroll offset relative to the element's top, as a fraction of its height (may be < 0 or > 1). */
  ratio: number;
}

function ensureStyles(mount: HTMLElement): void {
  const root = mount.getRootNode();
  const doc = mount.ownerDocument;
  const host: ParentNode | null =
    typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root : doc.head ?? doc.documentElement;
  if (!host || host.querySelector(`style[${READER_STYLE_ATTR}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(READER_STYLE_ATTR, '');
  style.textContent = READER_CSS;
  host.appendChild(style);
}

function endOrnament(doc: Document): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 120 14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const line = doc.createElementNS(ns, 'path');
  line.setAttribute('d', 'M4 7h42M74 7h42');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('fill', 'none');
  const diamond = doc.createElementNS(ns, 'path');
  diamond.setAttribute('d', 'M60 1.5l5.5 5.5-5.5 5.5-5.5-5.5zM50 7a1.6 1.6 0 1 0 0 .01zM70 7a1.6 1.6 0 1 0 0 .01z');
  diamond.setAttribute('fill', 'currentColor');
  svg.append(line, diamond);
  return svg;
}

export class ReaderView {
  readonly scroller: HTMLElement;
  readonly content: HTMLElement;

  private readonly bus: EventBus;
  private currentBook: Book | null = null;
  private settings: AppSettings | null = null;
  private anchors: HTMLElement[] = [];
  private readonly anchorById = new Map<string, HTMLElement>();
  private endMarker: HTMLElement | null = null;
  private lastAnchor: Anchor | null = null;
  private pendingRestore: ReadingPosition | null = null;
  private openToken = 0;
  private trackFrame: number | null = null;
  private lastWidth = -1;
  private resizeObserver: ResizeObserver | null = null;
  private readonly scrollListeners = new Set<() => void>();
  private destroyed = false;

  constructor(opts: ReaderViewOptions) {
    this.bus = opts.bus;
    const doc = opts.mount.ownerDocument;
    ensureStyles(opts.mount);

    this.scroller = doc.createElement('div');
    this.scroller.className = `${CSS_PREFIX}reader`;
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'region');
    this.scroller.setAttribute('aria-label', 'Book text');
    this.scroller.dataset.font = 'serif';

    this.content = doc.createElement('article');
    this.content.className = `${CSS_PREFIX}reader-content`;
    this.scroller.appendChild(this.content);
    opts.mount.appendChild(this.scroller);

    this.scroller.addEventListener('scroll', this.handleScroll, { passive: true });
    this.content.addEventListener('click', this.handleClick);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.scroller);
    }
  }

  get book(): Book | null {
    return this.currentBook;
  }

  /** Renders every chapter (sanitized again at this sink) and restores `position` when it belongs to `book`. */
  open(book: Book, position?: ReadingPosition | null): void {
    if (this.destroyed) return;
    this.close();
    this.currentBook = book;
    const token = ++this.openToken;
    const doc = this.content.ownerDocument;
    this.content.setAttribute('aria-label', book.title);

    const fragment = doc.createDocumentFragment();
    book.chapters.forEach((chapter, index) => {
      const section = doc.createElement('section');
      section.className = `${CSS_PREFIX}chapter`;
      section.id = `${CSS_PREFIX}ch-${index}`;
      section.dataset.grChapter = String(index);
      if (chapter.title) section.setAttribute('aria-label', chapter.title);
      try {
        section.appendChild(sanitizeToFragment(chapter.html, doc));
      } catch (err) {
        const notice = doc.createElement('p');
        notice.textContent = 'This chapter couldn\u2019t be displayed.';
        section.appendChild(notice);
        this.bus.emit('error', {
          code: 'reader-render',
          message: `Chapter ${index + 1} could not be rendered: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      this.decorateChapter(section, index);
      fragment.appendChild(section);
    });
    this.endMarker = this.buildEndMarker(book);
    fragment.appendChild(this.endMarker);
    this.content.appendChild(fragment);

    if (position && position.bookId === book.id) this.restore(position);
    else this.scroller.scrollTop = 0;
    this.lastAnchor = this.captureAnchor();

    // Late font loads change line breaks: keep the reader's place when they land.
    const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready
      .then(() => {
        if (token === this.openToken && !this.pendingRestore && this.lastAnchor) this.applyAnchor(this.lastAnchor);
      })
      .catch(() => undefined);
  }

  close(): void {
    this.openToken++;
    this.currentBook = null;
    this.anchors = [];
    this.anchorById.clear();
    this.endMarker = null;
    this.lastAnchor = null;
    this.pendingRestore = null;
    this.content.replaceChildren();
    this.content.removeAttribute('aria-label');
    this.scroller.scrollTop = 0;
  }

  /** Font size/family, line height and column width — CSS variables only, and the reader keeps their place. */
  applySettings(s: AppSettings): void {
    const prev = this.settings;
    this.settings = s;
    const typographyChanged =
      !prev ||
      prev.fontSizePx !== s.fontSizePx ||
      prev.lineHeight !== s.lineHeight ||
      prev.fontFamily !== s.fontFamily ||
      prev.columnWidthCh !== s.columnWidthCh;
    if (!typographyChanged) return;

    const keep = this.currentBook && !this.pendingRestore ? this.captureAnchor() : null;
    const style = this.scroller.style;
    if (Number.isFinite(s.fontSizePx) && s.fontSizePx > 0) style.setProperty('--gr-reader-font-size', `${s.fontSizePx}px`);
    if (Number.isFinite(s.lineHeight) && s.lineHeight > 0) style.setProperty('--gr-reader-line-height', String(s.lineHeight));
    if (Number.isFinite(s.columnWidthCh) && s.columnWidthCh > 0) style.setProperty('--gr-reader-measure', `${s.columnWidthCh}ch`);
    const family = FONT_STACKS[s.fontFamily] ? s.fontFamily : 'serif';
    style.setProperty('--gr-reader-font', family === 'serif' ? `var(--gr-font-reading, ${FONT_STACKS.serif})` : FONT_STACKS[family]);
    this.scroller.dataset.font = family;
    if (keep) {
      this.applyAnchor(keep);
      this.lastAnchor = this.captureAnchor();
    }
  }

  /** Text lines near the viewport, measured over the book content (viewport = the scroller's client box). */
  measureLayout(): LineLayout {
    const s = this.scroller;
    const r = s.getBoundingClientRect();
    const view = s.ownerDocument.defaultView;
    const left = r.left + s.clientLeft;
    const top = r.top + s.clientTop;
    const viewport = {
      left: Math.max(left, 0),
      top: Math.max(top, 0),
      right: Math.min(left + s.clientWidth, view?.innerWidth || Infinity),
      bottom: Math.min(top + s.clientHeight, view?.innerHeight || Infinity),
    };
    return measureLines({
      root: this.content,
      viewport,
      scrollTop: s.scrollTop,
      scrollHeight: s.scrollHeight,
      clientHeight: s.clientHeight,
    });
  }

  /** Scroll fraction through the book plus the paragraph at the top of the view. */
  getPosition(): ReadingPosition | null {
    const book = this.currentBook;
    if (!book) return null;
    if (this.pendingRestore) return { ...this.pendingRestore, updatedAt: Date.now() };
    const anchor = this.anchorAtTop();
    const pos: ReadingPosition = { bookId: book.id, fraction: this.progress(), updatedAt: Date.now() };
    if (anchor?.id) pos.anchor = anchor.id;
    return pos;
  }

  /** 0..1 scroll fraction through the book (1 = scrolled as far as the text goes). */
  progress(): number {
    if (!this.currentBook) return 0;
    if (this.pendingRestore) return clamp(Number.isFinite(this.pendingRestore.fraction) ? this.pendingRestore.fraction : 0, 0, 1);
    const span = this.fractionSpan();
    if (!(span > 0)) return 0;
    return clamp(this.scroller.scrollTop / span, 0, 1);
  }

  onScroll(cb: () => void): Unsubscribe {
    const listener = (): void => cb();
    this.scrollListeners.add(listener);
    this.scroller.addEventListener('scroll', listener, { passive: true });
    return () => {
      this.scrollListeners.delete(listener);
      this.scroller.removeEventListener('scroll', listener);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.close();
    this.destroyed = true;
    if (this.trackFrame !== null) cancelFrame(this.trackFrame);
    this.trackFrame = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.scroller.removeEventListener('scroll', this.handleScroll);
    this.content.removeEventListener('click', this.handleClick);
    for (const l of this.scrollListeners) this.scroller.removeEventListener('scroll', l);
    this.scrollListeners.clear();
    this.scroller.remove();
  }

  // ───────────────────────────── rendering ─────────────────────────────

  /** Paragraph anchors ("c3-p17"), the chapter-opening heading and a subtle drop cap. */
  private decorateChapter(section: HTMLElement, chapter: number): void {
    let n = 0;
    const doc = section.ownerDocument;
    const chapterAnchors: HTMLElement[] = [];
    for (const el of Array.from(section.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR))) {
      if (el.querySelector(ANCHOR_SELECTOR)) continue; // only leaf blocks: their order is their position
      if (!/\S/.test(el.textContent ?? '')) continue;
      const id = `c${chapter}-p${n++}`;
      if (el.id) {
        // Keep the book's own id (a footnote target) on an empty marker inside the block.
        const marker = doc.createElement('span');
        marker.id = el.id;
        el.prepend(marker);
      }
      el.id = id;
      this.anchors.push(el);
      this.anchorById.set(id, el);
      chapterAnchors.push(el);
    }

    const headingIndex = chapterAnchors.findIndex((el) => el.matches(HEADING_SELECTOR));
    if (headingIndex < 0 || headingIndex > 1) return;
    chapterAnchors[headingIndex].classList.add(`${CSS_PREFIX}chapter-start`);
    for (const el of chapterAnchors.slice(headingIndex + 1, headingIndex + 4)) {
      if (el.localName !== 'p' || el.closest('blockquote, li, figure, table')) continue;
      const text = (el.textContent ?? '').trim();
      if (text.length >= DROPCAP_MIN_CHARS && /^[“"‘'(]?\p{L}/u.test(text)) el.classList.add(`${CSS_PREFIX}dropcap`);
      break;
    }
  }

  private buildEndMarker(book: Book): HTMLElement {
    const doc = this.content.ownerDocument;
    const end = doc.createElement('footer');
    end.className = `${CSS_PREFIX}end`;
    end.setAttribute(IGNORE_ATTR, '');
    end.setAttribute('role', 'note');
    const label = doc.createElement('div');
    label.className = `${CSS_PREFIX}end-label`;
    label.textContent = 'End of book';
    const title = doc.createElement('div');
    title.className = `${CSS_PREFIX}end-title`;
    title.textContent = book.author ? `${book.title} \u00b7 ${book.author}` : book.title;
    end.append(endOrnament(doc), label, title);
    return end;
  }

  // ───────────────────────────── positions ─────────────────────────────

  private yInScroller(el: Element): number {
    const s = this.scroller;
    return el.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientTop + s.scrollTop;
  }

  /**
   * The scroll distance that maps to fraction 1: the whole scroll range, but never
   * past the end of the text (the bottom padding and end marker don't count).
   */
  private fractionSpan(): number {
    const maxScroll = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
    const textEnd = this.endMarker ? this.yInScroller(this.endMarker) : maxScroll;
    return Math.min(maxScroll, Math.max(0, textEnd));
  }

  private topGap(): number {
    const s = this.settings;
    const pitch = s ? s.fontSizePx * s.lineHeight : 22 * 1.9;
    return Number.isFinite(pitch) ? pitch * TOP_GAP_PITCH : 0;
  }

  private setScrollTop(top: number): void {
    const max = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
    this.scroller.scrollTop = clamp(Number.isFinite(top) ? top : 0, 0, max);
  }

  /** The leaf block containing the top edge of the view (binary search: blocks are in document order). */
  private anchorAtTop(): HTMLElement | null {
    const list = this.anchors;
    if (list.length === 0) return null;
    const s = this.scroller;
    const viewTop = s.getBoundingClientRect().top + s.clientTop;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].getBoundingClientRect().top <= viewTop + 2) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return list[0];
    const el = list[found];
    // Between blocks (a heading's margin, a scene break): the next block is the nearer one.
    if (el.getBoundingClientRect().bottom < viewTop && found + 1 < list.length) return list[found + 1];
    return el;
  }

  private captureAnchor(): Anchor | null {
    if (!this.currentBook || this.scroller.clientHeight <= 0) return null;
    const el = this.anchorAtTop();
    if (!el) return null;
    const height = el.getBoundingClientRect().height;
    const offset = this.scroller.scrollTop - this.yInScroller(el);
    return { el, ratio: height > 0 ? clamp(offset / height, -2, 2) : 0 };
  }

  private applyAnchor(anchor: Anchor): void {
    if (!anchor.el.isConnected) return;
    const height = anchor.el.getBoundingClientRect().height;
    this.setScrollTop(this.yInScroller(anchor.el) + anchor.ratio * height);
  }

  /**
   * Restores a saved position. The fraction is exact when the layout is unchanged;
   * when it no longer falls inside the saved paragraph (different font size or
   * window width), the paragraph anchor wins.
   */
  private restore(pos: ReadingPosition): void {
    if (this.scroller.clientHeight <= 0) {
      this.pendingRestore = pos; // not laid out yet (hidden screen): restore on first resize
      return;
    }
    this.pendingRestore = null;
    const fraction = Number.isFinite(pos.fraction) ? clamp(pos.fraction, 0, 1) : 0;
    const fromFraction = fraction * this.fractionSpan();
    const el = pos.anchor ? this.anchorById.get(pos.anchor) : undefined;
    let target = fromFraction;
    if (el) {
      const top = this.yInScroller(el);
      const bottom = top + el.getBoundingClientRect().height;
      if (!(fromFraction >= top - this.topGap() - 2 && fromFraction <= bottom)) target = top - this.topGap();
    }
    this.setScrollTop(target);
  }

  // ───────────────────────────── events ─────────────────────────────

  private readonly handleScroll = (): void => {
    if (this.trackFrame !== null || this.pendingRestore) return;
    this.trackFrame = requestFrame(() => {
      this.trackFrame = null;
      this.lastAnchor = this.captureAnchor();
    });
  };

  private handleResize(): void {
    if (this.destroyed) return;
    const width = this.scroller.clientWidth;
    if (this.pendingRestore && this.scroller.clientHeight > 0) {
      this.restore(this.pendingRestore);
      this.lastAnchor = this.captureAnchor();
    } else if (width !== this.lastWidth && this.lastWidth >= 0 && this.lastAnchor) {
      this.applyAnchor(this.lastAnchor); // text reflowed: keep the same paragraph at the top
    }
    this.lastWidth = width;
  }

  /** In-book links ("#gr-src-…") scroll the reader instead of touching the page URL. */
  private readonly handleClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target.closest('a[href^="#"]') : null;
    if (!target || !this.content.contains(target)) return;
    let id = (target.getAttribute('href') ?? '').slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep raw */
    }
    if (!id || /["\\]/.test(id)) return;
    const destination = this.content.querySelector(`[id="${id}"]`);
    if (!destination) return;
    e.preventDefault();
    // An empty marker can have no box of its own (display: none): use the block it sits in.
    const box = destination.getBoundingClientRect();
    const positioned = box.width === 0 && box.height === 0 ? (destination.parentElement ?? destination) : destination;
    this.setScrollTop(this.yInScroller(positioned) - this.topGap());
  };
}
