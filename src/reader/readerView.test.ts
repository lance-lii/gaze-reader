// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../core/events';
import { DEFAULT_SETTINGS } from '../core/settings';
import type { AppSettings, Book } from '../types';
import { READER_STYLE_ATTR } from './reader.css';
import type { PdfPageLayout } from './pdf';
import { ReaderView, type PagesSource } from './readerView';

// ─────────────────────────── fixtures ───────────────────────────

const LONG = 'The lamp was lit at dusk every evening, and the keeper climbed the stairs slowly, counting each step. ';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    title: 'The Lamp',
    author: 'Ada Byron',
    source: 'paste',
    format: 'txt',
    addedAt: 1,
    wordCount: 500,
    chapters: [
      {
        title: 'One',
        html: `<h2>Chapter One</h2><p>${LONG.repeat(3)}</p><p>Short one.</p><p id="gr-src-note">${LONG}</p><blockquote><p>${LONG}</p></blockquote>`,
      },
      {
        title: 'Two',
        html: `<h2>Chapter Two</h2><p>Hi.</p><p>${LONG.repeat(2)}</p><ul><li>${LONG}</li><li><p>nested para</p></li></ul>` +
          `<p><a href="#gr-src-note">back to the note</a> <a href="https://example.com/">web</a></p>`,
      },
      { title: null, html: `<p>${LONG.repeat(4)}</p><p>${LONG.repeat(4)}</p><p>${LONG.repeat(4)}</p>` },
    ],
    ...overrides,
  };
}

// ─────────────────────── a tiny layout model ───────────────────────

interface Layout {
  clientHeight: number;
  clientWidth: number;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

/**
 * Blocks stack vertically; a block's height is its line count × line pitch, where
 * both follow the CSS variables applySettings() writes — so typography changes
 * really reflow this fake page.
 */
function installLayout(view: ReaderView): Layout {
  const state: Layout = { clientHeight: 600, clientWidth: 800 };
  const s = view.scroller;
  let top = 0;

  const model = () => {
    const fontSize = Number.parseFloat(s.style.getPropertyValue('--gr-reader-font-size')) || 22;
    const lineHeight = Number.parseFloat(s.style.getPropertyValue('--gr-reader-line-height')) || 1.9;
    const pitch = fontSize * lineHeight;
    const charsPerLine = Math.max(10, Math.floor(state.clientWidth / 1.3 / (fontSize * 0.5)));
    const blocks = new Map<Element, { y: number; h: number }>();
    let y = 50;
    for (const el of Array.from(view.content.querySelectorAll('[id^="c"]'))) {
      if (!/^c\d+-p\d+$/.test(el.id)) continue;
      const lines = Math.max(1, Math.ceil((el.textContent ?? '').length / charsPerLine));
      blocks.set(el, { y, h: lines * pitch });
      y += lines * pitch + pitch * 0.5;
    }
    return { blocks, endY: y + 80 };
  };

  Object.defineProperties(s, {
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(model().endY + 360 - state.clientHeight, v));
        s.dispatchEvent(new Event('scroll'));
      },
    },
    scrollHeight: { configurable: true, get: () => model().endY + 360 },
    clientHeight: { configurable: true, get: () => state.clientHeight },
    clientWidth: { configurable: true, get: () => state.clientWidth },
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === s) return rect(0, 0, state.clientWidth, state.clientHeight);
    const m = model();
    if (this.classList.contains('gr-end')) return rect(100, m.endY - top, 600, 120);
    const b = m.blocks.get(this);
    if (b) return rect(100, b.y - top, 600, b.h);
    return rect(0, 0, 0, 0);
  });
  return state;
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(private readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    this.cb([], this as unknown as ResizeObserver);
  }
}

let frames: FrameRequestCallback[] = [];
function flushFrames(): void {
  const due = frames;
  frames = [];
  for (const f of due) f(0);
}

let mount: HTMLElement;
beforeEach(() => {
  FakeResizeObserver.instances = [];
  frames = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  mount = document.createElement('div');
  document.body.appendChild(mount);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.head.querySelectorAll(`style[${READER_STYLE_ATTR}]`).forEach((s) => s.remove());
});

function newView(): ReaderView {
  return new ReaderView({ mount, bus: createEventBus() });
}

// ───────────────────────────── tests ─────────────────────────────

describe('ReaderView rendering', () => {
  it('renders chapters with paragraph anchors, a chapter-opening heading and an end marker', () => {
    const view = newView();
    view.open(makeBook());
    const sections = view.content.querySelectorAll('section.gr-chapter');
    expect(sections).toHaveLength(3);
    expect(sections[1].getAttribute('data-gr-chapter')).toBe('1');
    expect(sections[1].getAttribute('aria-label')).toBe('Two');
    expect(view.content.getAttribute('aria-label')).toBe('The Lamp');
    expect(view.book?.id).toBe('book-1');

    const ids = Array.from(sections[0].querySelectorAll('[id^="c0-"]')).map((e) => `${e.localName}#${e.id}`);
    expect(ids).toEqual(['h2#c0-p0', 'p#c0-p1', 'p#c0-p2', 'p#c0-p3', 'p#c0-p4']); // the blockquote's paragraph, not the blockquote
    expect(sections[1].querySelector('li')?.id).toBe('c1-p3'); // a leaf list item
    expect(sections[1].querySelectorAll('li')[1].id).toBe(''); // its paragraph carries the anchor instead
    expect(sections[0].querySelector('h2')?.classList.contains('gr-chapter-start')).toBe(true);
    expect(sections[2].querySelector('.gr-chapter-start')).toBeNull();

    const end = view.content.querySelector('.gr-end');
    expect(end?.hasAttribute('data-gr-ignore')).toBe(true);
    expect(end?.textContent).toContain('End of book');
    expect(end?.textContent).toContain('The Lamp · Ada Byron');
    expect(view.content.lastElementChild).toBe(end);
  });

  it('keeps the book’s own ids (footnote targets) on a marker inside the anchored block', () => {
    const view = newView();
    view.open(makeBook());
    const note = view.content.querySelector('#gr-src-note');
    expect(note?.localName).toBe('span');
    expect(note?.parentElement?.id).toBe('c0-p3');
  });

  it('puts a subtle drop cap on the opening paragraph of a chapter only when it is long enough', () => {
    const view = newView();
    view.open(makeBook());
    const caps = Array.from(view.content.querySelectorAll('.gr-dropcap')).map((e) => e.id);
    // Chapter two opens with "Hi.": a two-line initial on a one-line paragraph would look broken,
    // and a drop cap anywhere but the opening paragraph would be wrong — so it gets none.
    // Chapter three has no heading (a split file mid-chapter): none either.
    expect(caps).toEqual(['c0-p1']);
  });

  it('sanitizes again at render time, whatever the Book contains', () => {
    const view = newView();
    view.open(
      makeBook({
        chapters: [
          {
            title: null,
            html: '<p onclick="steal()">Hi<img src=x onerror="steal()"><script>steal()</script><a href="javascript:steal()">x</a></p><style>*{}</style>',
          },
        ],
      }),
    );
    const html = view.content.querySelector('section')?.innerHTML ?? '';
    expect(html).toBe('<p id="c0-p0">Hi<a>x</a></p>');
  });

  it('injects its stylesheet once per document and into a shadow root when mounted there', () => {
    newView();
    newView();
    expect(document.head.querySelectorAll(`style[${READER_STYLE_ATTR}]`)).toHaveLength(1);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    shadow.appendChild(inner);
    new ReaderView({ mount: inner, bus: createEventBus() });
    expect(shadow.querySelectorAll(`style[${READER_STYLE_ATTR}]`)).toHaveLength(1);
  });

  it('applies typography through CSS variables without re-rendering', () => {
    const view = newView();
    view.open(makeBook());
    const firstPara = view.content.querySelector('p');
    const settings: AppSettings = { ...DEFAULT_SETTINGS, fontSizePx: 24, lineHeight: 2, columnWidthCh: 70, fontFamily: 'sans' };
    view.applySettings(settings);
    const style = view.scroller.style;
    expect(style.getPropertyValue('--gr-reader-font-size')).toBe('24px');
    expect(style.getPropertyValue('--gr-reader-line-height')).toBe('2');
    expect(style.getPropertyValue('--gr-reader-measure')).toBe('70ch');
    expect(style.getPropertyValue('--gr-reader-font')).toContain('system-ui');
    expect(view.scroller.dataset.font).toBe('sans');
    view.applySettings({ ...settings, fontFamily: 'serif' });
    expect(style.getPropertyValue('--gr-reader-font')).toMatch(/^var\(--gr-font-reading, "Iowan Old Style"/);
    expect(view.content.querySelector('p')).toBe(firstPara);
  });
});

describe('ReaderView positions', () => {
  it('reports the paragraph at the top of the view and the fraction through the text', () => {
    const view = newView();
    installLayout(view);
    view.open(makeBook());
    const target = view.content.querySelector('#c1-p2') as HTMLElement;
    const y = target.getBoundingClientRect().top + view.scroller.scrollTop;
    view.scroller.scrollTop = y + 30;
    const pos = view.getPosition();
    expect(pos).toMatchObject({ bookId: 'book-1', anchor: 'c1-p2' });
    const maxScroll = view.scroller.scrollHeight - view.scroller.clientHeight;
    expect(pos?.fraction).toBeCloseTo((y + 30) / maxScroll, 10);
    expect(view.progress()).toBe(pos?.fraction);
    view.scroller.scrollTop = 1e9; // as far as it goes (the end-of-book padding)
    expect(view.progress()).toBe(1);
    view.scroller.scrollTop = 0;
    expect(view.progress()).toBe(0);
  });

  it('never counts the end-of-book padding when the reader could scroll past the text', () => {
    const view = newView();
    const layout = installLayout(view);
    layout.clientHeight = 100; // a short window: the scroll range reaches beyond the end marker
    view.open(makeBook());
    const endTop = (view.content.querySelector('.gr-end') as HTMLElement).getBoundingClientRect().top;
    view.scroller.scrollTop = endTop;
    expect(view.progress()).toBe(1);
    view.scroller.scrollTop = endTop / 2;
    expect(view.progress()).toBeCloseTo(0.5, 10);
  });

  it('restores exactly when the layout is unchanged', () => {
    const view = newView();
    installLayout(view);
    view.open(makeBook());
    view.scroller.scrollTop = 777;
    const pos = view.getPosition();
    view.close();
    expect(view.scroller.scrollTop).toBe(0);
    view.open(makeBook(), pos);
    expect(view.scroller.scrollTop).toBeCloseTo(777, 6);
  });

  it('falls back to the paragraph anchor when the layout changed since saving', () => {
    const view = newView();
    installLayout(view);
    view.open(makeBook());
    view.open(makeBook(), { bookId: 'book-1', fraction: 0.02, anchor: 'c2-p1', updatedAt: 1 });
    const anchorY = (view.content.querySelector('#c2-p1') as HTMLElement).getBoundingClientRect().top + view.scroller.scrollTop;
    expect(view.scroller.scrollTop).toBeCloseTo(anchorY - 22 * 1.9 * 0.35, 6);
  });

  it('ignores a position that belongs to another book', () => {
    const view = newView();
    installLayout(view);
    view.open(makeBook(), { bookId: 'other', fraction: 0.5, updatedAt: 1 });
    expect(view.scroller.scrollTop).toBe(0);
  });

  it('keeps the reader’s place when the font size changes', () => {
    const view = newView();
    installLayout(view);
    view.applySettings({ ...DEFAULT_SETTINGS });
    view.open(makeBook());
    const para = view.content.querySelector('#c2-p1') as HTMLElement;
    const before = para.getBoundingClientRect();
    view.scroller.scrollTop += before.top + before.height * 0.4; // 40 % into the paragraph
    flushFrames();
    view.applySettings({ ...DEFAULT_SETTINGS, fontSizePx: 30 });
    const after = para.getBoundingClientRect();
    expect(after.height).toBeGreaterThan(before.height); // really reflowed
    expect(-after.top / after.height).toBeCloseTo(0.4, 6);
    expect(view.getPosition()?.anchor).toBe('c2-p1');
  });

  it('keeps the reader’s place when the window width changes', () => {
    const view = newView();
    const layout = installLayout(view);
    view.open(makeBook());
    const ro = FakeResizeObserver.instances[0];
    ro.fire(); // initial observation
    const para = view.content.querySelector('#c2-p0') as HTMLElement;
    view.scroller.scrollTop += para.getBoundingClientRect().top;
    flushFrames();
    layout.clientWidth = 420; // narrower → taller paragraphs
    ro.fire();
    expect(para.getBoundingClientRect().top).toBeCloseTo(0, 6);
  });

  it('defers restoring until a hidden reader gets a size', () => {
    const view = newView();
    const layout = installLayout(view);
    layout.clientHeight = 0;
    const saved = { bookId: 'book-1', fraction: 0.5, anchor: 'c2-p1', updatedAt: 1 };
    view.open(makeBook(), saved);
    expect(view.scroller.scrollTop).toBe(0);
    expect(view.getPosition()).toMatchObject({ fraction: 0.5, anchor: 'c2-p1' });
    expect(view.progress()).toBe(0.5);
    layout.clientHeight = 600;
    FakeResizeObserver.instances[0].fire();
    expect(view.scroller.scrollTop).toBeGreaterThan(0);
    expect(view.getPosition()?.anchor).toBe('c2-p1');
  });
});

describe('ReaderView behaviour', () => {
  it('follows in-book links inside the scroller and leaves external links alone', () => {
    const view = newView();
    installLayout(view);
    view.open(makeBook());
    const [internal, external] = Array.from(view.content.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    internal.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(view.getPosition()?.anchor).toBe('c0-p3');
    const outClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    external.dispatchEvent(outClick);
    expect(outClick.defaultPrevented).toBe(false);
    expect(external.getAttribute('target')).toBe('_blank');
  });

  it('forwards raw scroll events until unsubscribed', () => {
    const view = newView();
    const cb = vi.fn();
    const off = view.onScroll(cb);
    view.scroller.dispatchEvent(new Event('scroll'));
    off();
    view.scroller.dispatchEvent(new Event('scroll'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('measures its own content with the scroller as the viewport', () => {
    const view = newView();
    installLayout(view);
    view.open(makeBook());
    view.scroller.scrollTop = 120;
    const layout = view.measureLayout();
    expect(layout.viewport).toEqual({ left: 0, top: 0, right: 800, bottom: 600 });
    expect(layout.scrollTop).toBe(120);
    expect(layout.clientHeight).toBe(600);
    expect(Array.isArray(layout.lines)).toBe(true);
  });

  it('close() empties the view; destroy() removes it and every listener', () => {
    const view = newView();
    view.open(makeBook());
    view.close();
    expect(view.book).toBeNull();
    expect(view.getPosition()).toBeNull();
    expect(view.progress()).toBe(0);
    expect(view.content.childElementCount).toBe(0);

    const cb = vi.fn();
    view.onScroll(cb);
    const ro = FakeResizeObserver.instances[0];
    const scroller = view.scroller;
    view.destroy();
    scroller.dispatchEvent(new Event('scroll'));
    expect(cb).not.toHaveBeenCalled();
    expect(ro.disconnected).toBe(true);
    expect(mount.contains(scroller)).toBe(false);
    view.open(makeBook()); // no-op after destroy
    expect(view.book).toBeNull();
    view.destroy();
  });
});

// ───────────────────────────── the pages view ─────────────────────────────

describe('ReaderView pages view (a PDF’s own pages)', () => {
  const PAGES: PdfPageLayout[] = [
    {
      width: 600,
      height: 800,
      columns: false,
      lines: [
        // Out of order on purpose: the view lays them out top to bottom.
        { x0: 72, x1: 500, y: 130, size: 10, text: 'the second line of the page' },
        { x0: 87, x1: 520, y: 116, size: 10, text: 'The first line of the page' },
        { x0: 72, x1: 300, y: 400, size: 20, text: '<img src=x onerror=alert(1)> stays text' },
      ],
    },
    { width: 600, height: 800, columns: true, lines: [{ x0: 60, x1: 280, y: 100, size: 10, text: 'left column' }, { x0: 330, x1: 550, y: 100, size: 10, text: 'right column' }] },
    { width: 800, height: 600, columns: false, lines: [] }, // a scan: a picture with no text
  ];

  class FakeIntersectionObserver {
    static instances: FakeIntersectionObserver[] = [];
    readonly observed: Element[] = [];
    disconnected = false;
    constructor(
      private readonly cb: IntersectionObserverCallback,
      readonly options?: IntersectionObserverInit,
    ) {
      FakeIntersectionObserver.instances.push(this);
    }
    observe(el: Element): void {
      this.observed.push(el);
    }
    unobserve(): void {}
    disconnect(): void {
      this.disconnected = true;
    }
    /** The page comes near the view, or leaves. */
    show(el: Element, isIntersecting: boolean): void {
      this.cb([{ target: el, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
  }

  function pagesSource(): PagesSource & { rendered: [number, number, number][]; cancelled: number } {
    const rendered: [number, number, number][] = [];
    const src = {
      pages: PAGES,
      rendered,
      cancelled: 0,
      render: (index: number, canvas: HTMLCanvasElement, cssWidth: number, ratio: number): Promise<boolean> => {
        rendered.push([index, cssWidth, ratio]);
        canvas.width = Math.round(cssWidth * ratio);
        canvas.height = 10;
        return Promise.resolve(true);
      },
      cancel: (): void => {
        src.cancelled++;
      },
    };
    return src;
  }

  const pdfBook = (): Book => makeBook({ id: 'pdf-1', title: 'A Paper', format: 'pdf', source: 'file' });

  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
  });

  it('lays every page out as a picture with one element per line, where the line is', () => {
    const view = newView();
    expect(view.view).toBe('text');
    view.openPages(pdfBook(), pagesSource());
    expect(view.view).toBe('pages');
    expect(view.scroller.dataset.view).toBe('pages');
    expect(view.book?.id).toBe('pdf-1');

    const pages = [...view.content.querySelectorAll<HTMLElement>('.gr-pdf-page')];
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.id)).toEqual(['pg0', 'pg1', 'pg2']);
    expect(pages[0]!.getAttribute('aria-label')).toBe('Page 1 of 3');
    expect(pages[0]!.style.aspectRatio).toBe('600 / 800');
    expect(pages[2]!.style.aspectRatio).toBe('800 / 600');
    for (const p of pages) expect(p.querySelector('canvas')!.getAttribute('aria-hidden')).toBe('true');

    const lines = [...pages[0]!.querySelectorAll<HTMLElement>('.gr-pdf-line')];
    expect(lines.map((l) => l.textContent)).toEqual(['The first line of the page', 'the second line of the page', '<img src=x onerror=alert(1)> stays text']);
    expect(lines.map((l) => l.id)).toEqual(['pg0-l0', 'pg0-l1', 'pg0-l2']);
    expect(pages[0]!.querySelector('img')).toBeNull(); // a line's text is only ever text
    const first = lines[0]!;
    expect(Number.parseFloat(first.style.left)).toBeCloseTo((100 * 87) / 600, 3);
    expect(Number.parseFloat(first.style.width)).toBeCloseTo((100 * (520 - 87)) / 600, 3);
    // The box reaches from above the baseline (116) to a little below it.
    expect(Number.parseFloat(first.style.top)).toBeCloseTo((100 * (116 - 8)) / 800, 3);
    expect(Number.parseFloat(first.style.height)).toBeCloseTo((100 * 10.5) / 800, 3);
    expect(Number.parseFloat(first.style.getPropertyValue('--gr-pdf-size'))).toBeCloseTo(10 / 600, 4);
    expect(Number.parseFloat(lines[2]!.style.getPropertyValue('--gr-pdf-size'))).toBeCloseTo(20 / 600, 4);

    // Two columns, and a page with no text: no line elements (nothing there can be followed top to bottom), and a note saying so.
    expect(pages[1]!.querySelectorAll('.gr-pdf-line')).toHaveLength(0);
    expect(pages[1]!.dataset.grUntracked).toMatch(/Two columns/);
    expect(pages[2]!.querySelectorAll('.gr-pdf-line')).toHaveLength(0);
    expect(pages[2]!.dataset.grUntracked).toMatch(/No text/);
    expect(pages[0]!.dataset.grUntracked).toBeUndefined();

    // The end marker follows the last page, as it follows the last chapter.
    expect(view.content.lastElementChild!.classList.contains('gr-end')).toBe(true);
    expect(view.content.lastElementChild!.previousElementSibling).toBe(pages[2]);
  });

  it('draws a page’s picture when it comes near the view, lets go of it when it leaves, and redraws at a new width', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    vi.stubGlobal('devicePixelRatio', 2);
    const view = newView();
    const source = pagesSource();
    view.openPages(pdfBook(), source);
    const io = FakeIntersectionObserver.instances[0]!;
    expect(io.options?.root).toBe(view.scroller);
    const pages = [...view.content.querySelectorAll<HTMLElement>('.gr-pdf-page')];
    expect(io.observed).toEqual(pages);
    let width = 900;
    for (const p of pages) Object.defineProperty(p, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(view.scroller, 'clientWidth', { configurable: true, get: () => width + 100 });

    io.show(pages[0]!, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.rendered).toEqual([[0, 900, 2]]);
    expect(pages[0]!.querySelector('canvas')!.width).toBe(1800);
    io.show(pages[0]!, true); // already drawn at this width: nothing to do
    await vi.advanceTimersByTimeAsync(0);
    expect(source.rendered).toHaveLength(1);

    io.show(pages[0]!, false);
    expect(pages[0]!.querySelector('canvas')!.width).toBe(0); // the picture's memory is given back

    io.show(pages[1]!, true);
    await vi.advanceTimersByTimeAsync(0);
    width = 600;
    FakeResizeObserver.instances[0]!.fire(); // first size
    FakeResizeObserver.instances[0]!.fire();
    await vi.advanceTimersByTimeAsync(400);
    expect(source.rendered.at(-1)).toEqual([1, 600, 2]);

    view.close();
    expect(io.disconnected).toBe(true);
    expect(view.view).toBe('text');
    expect(view.scroller.dataset.view).toBeUndefined();
    expect(view.content.childElementCount).toBe(0);
    vi.useRealTimers();
  });

  it('a picture that can’t be drawn is reported once and never stops the others', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const bus = createEventBus();
    const errors: string[] = [];
    bus.on('error', (e) => errors.push(e.code));
    const view = new ReaderView({ mount, bus });
    const source = pagesSource();
    let fail = true;
    const render = source.render;
    source.render = (...args) => (fail ? Promise.reject(new Error('bad page')) : render(...args));
    view.openPages(pdfBook(), source);
    const io = FakeIntersectionObserver.instances[0]!;
    const pages = [...view.content.querySelectorAll<HTMLElement>('.gr-pdf-page')];
    for (const p of pages) Object.defineProperty(p, 'clientWidth', { configurable: true, value: 800 });
    io.show(pages[0]!, true);
    io.show(pages[1]!, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual(['reader-render']);
    fail = false;
    io.show(pages[2]!, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.rendered).toEqual([[2, 800, 1]]);
    view.destroy();
  });

  it('remembers the place by line, and goes back to a text book cleanly', () => {
    const view = newView();
    view.openPages(pdfBook(), pagesSource());
    const pos = view.getPosition();
    expect(pos?.bookId).toBe('pdf-1');
    expect(pos?.anchor).toMatch(/^pg\d+(-l\d+)?$/); // a page or one of its lines (nothing is laid out here to say which)
    expect(view.pagesStatus()).toEqual({ page: 0, count: 3, trackable: true });

    view.open(makeBook());
    expect(view.view).toBe('text');
    expect(view.pagesStatus()).toBeNull();
    expect(view.content.querySelector('.gr-pdf-page')).toBeNull();
    expect(view.content.querySelectorAll('section.gr-chapter')).toHaveLength(3);
  });
});
