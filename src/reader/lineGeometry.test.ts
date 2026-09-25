// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rect } from '../types';
import { measureLines } from './lineGeometry';

// ───────────────────────── a tiny fake layout engine ─────────────────────────

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

const ZERO = rect(0, 0, 0, 0);
const elementRects = new WeakMap<Element, DOMRect>();
/** Line boxes of a text node for the character range [start, end). */
const textLayout = new WeakMap<Text, (start: number, end: number) => DOMRect[]>();
const calls = { element: 0, rangeRects: 0, rangeBox: 0 };

type RangeWithRects = Range & { getClientRects(): DOMRectList; getBoundingClientRect(): DOMRect };

function rangeRects(range: Range): DOMRect[] {
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return [];
  return textLayout.get(node as Text)?.(range.startOffset, range.endOffset) ?? [];
}

beforeEach(() => {
  calls.element = calls.rangeRects = calls.rangeBox = 0;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    calls.element++;
    return elementRects.get(this) ?? ZERO;
  });
  const proto = Range.prototype as RangeWithRects;
  proto.getClientRects = function (this: Range) {
    calls.rangeRects++;
    return rangeRects(this) as unknown as DOMRectList;
  };
  proto.getBoundingClientRect = function (this: Range) {
    calls.rangeBox++;
    const rs = rangeRects(this);
    if (!rs.length) return ZERO;
    const left = Math.min(...rs.map((r) => r.left));
    const top = Math.min(...rs.map((r) => r.top));
    return rect(left, top, Math.max(...rs.map((r) => r.right)) - left, Math.max(...rs.map((r) => r.bottom)) - top);
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  const proto = Range.prototype as Partial<RangeWithRects>;
  delete proto.getClientRects;
  delete proto.getBoundingClientRect;
  document.body.replaceChildren();
});

const LINE_H = 20; // text content-area height
const PITCH = 30; // line-height
const COL_LEFT = 100;
const COL_W = 400;

/** A paragraph of `lines` lines whose first line box starts at `top`. */
function para(parent: Element, top: number, lines: number, text = 'word '.repeat(lines * 16).trim()): HTMLParagraphElement {
  const p = document.createElement('p');
  const node = document.createTextNode(text);
  p.appendChild(node);
  parent.appendChild(p);
  elementRects.set(p, rect(COL_LEFT, top, COL_W, lines * PITCH));
  textLayout.set(node, () =>
    Array.from({ length: lines }, (_, i) => rect(COL_LEFT, top + i * PITCH + 5, i === lines - 1 ? COL_W / 2 : COL_W, LINE_H)),
  );
  return p;
}

function root(top = 0, height = 2000): HTMLElement {
  const el = document.createElement('article');
  document.body.appendChild(el);
  elementRects.set(el, rect(COL_LEFT, top, COL_W, height));
  return el;
}

const VIEWPORT: Rect = { left: 0, top: 0, right: 800, bottom: 600 };

function measure(el: Element, extra: Partial<Parameters<typeof measureLines>[0]> = {}) {
  return measureLines({ root: el, viewport: VIEWPORT, scrollTop: 1000, scrollHeight: 10_000, clientHeight: 600, ...extra });
}

// ───────────────────────────────────── tests ─────────────────────────────────────

describe('measureLines', () => {
  it('measures lines with document tops, visibility, character counts and pitch', () => {
    const el = root();
    para(el, 50, 3);
    para(el, 200, 3);
    para(el, 350, 3);
    const layout = measure(el);

    expect(layout.lines).toHaveLength(9);
    expect(layout.lines.map((l) => l.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const first = layout.lines[0];
    expect(first).toMatchObject({ top: 55, bottom: 75, left: 100, right: 500, centerY: 65, docTop: 1055, fullyVisible: true });
    // "word " × 48 → 239 characters spread over 400 + 400 + 200 px of line.
    expect(first.charCount).toBe(96);
    expect(layout.lines[2].charCount).toBe(48);
    expect(layout.linePitch).toBe(30);
    expect(layout.column).toEqual({ left: 100, top: 55, right: 500, bottom: 435 });
    expect(layout).toMatchObject({ scrollTop: 1000, scrollHeight: 10_000, clientHeight: 600, viewport: VIEWPORT });
    expect(layout.measuredAt).toBeGreaterThan(0);
  });

  it('includes lines within the margin but marks only fully visible ones', () => {
    const el = root(-400, 1400);
    para(el, -380, 2); // far above: outside the default 300 px margin
    para(el, -200, 2); // above, within margin
    para(el, 580, 2); // straddles the bottom edge
    para(el, 1000, 2); // far below
    const layout = measure(el);
    expect(layout.lines.map((l) => l.top)).toEqual([-195, -165, 585, 615]);
    expect(layout.lines.map((l) => l.fullyVisible)).toEqual([false, false, false, false]);
    const tight = measure(el, { marginPx: 0 });
    expect(tight.lines.map((l) => l.top)).toEqual([585]);
  });

  it('merges inline pieces of one line, even with a big inline, a superscript or a drop cap', () => {
    const el = root();
    const p = document.createElement('p');
    const parts = ['Body text starts ', 'BIG', ' and ends', '1', ' Next line of body text here.'];
    const nodes = parts.map((t) => document.createTextNode(t));
    p.append(...nodes);
    el.appendChild(p);
    elementRects.set(p, rect(100, 100, 400, 60));
    textLayout.set(nodes[0], () => [rect(100, 105, 170, 20)]);
    textLayout.set(nodes[1], () => [rect(270, 95, 60, 40)]); // taller inline (bigger font)
    textLayout.set(nodes[2], () => [rect(330, 105, 90, 20)]);
    textLayout.set(nodes[3], () => [rect(420, 99, 8, 12)]); // superscript
    textLayout.set(nodes[4], () => [rect(100, 135, 290, 20)]);
    const dropCapP = document.createElement('p');
    const cap = document.createTextNode('Once upon a time');
    dropCapP.appendChild(cap);
    el.appendChild(dropCapP);
    elementRects.set(dropCapP, rect(100, 200, 400, 60));
    // A two-line drop cap: one tall fragment for the letter, then two ordinary lines.
    textLayout.set(cap, () => [rect(100, 203, 40, 52), rect(145, 205, 355, 20), rect(145, 235, 200, 20)]);

    const layout = measure(el);
    expect(layout.lines.map((l) => [l.top, l.bottom, l.left, l.right])).toEqual([
      [105, 125, 100, 428], // core = body text; union spans the big inline and the superscript
      [135, 155, 100, 390],
      [205, 225, 100, 500], // the drop cap joins its first line without stretching it
      [235, 255, 145, 345],
    ]);
  });

  it('folds a drop cap reported above its first line (Chrome, initial-letter) into that line', () => {
    const el = root();
    const p = document.createElement('p');
    const text = document.createTextNode('Iris Calloway had not slept properly in nineteen days, and she knew it.');
    p.appendChild(text);
    el.appendChild(p);
    elementRects.set(p, rect(100, 200, 400, 60));
    // Measured in Chrome: the letter's box is glyph-sized and sits ~half a line above line one.
    textLayout.set(text, () => [rect(100, 192, 25, 20), rect(128, 205, 372, 20), rect(128, 235, 200, 20)]);
    para(el, 300, 2);

    const layout = measure(el);
    expect(layout.lines.map((l) => [l.top, l.bottom, l.left, l.right])).toEqual([
      [205, 225, 100, 500], // no phantom line for the letter; it widens the line it belongs to
      [235, 255, 128, 328],
      [305, 325, 100, 500],
      [335, 355, 100, 300],
    ]);
    expect(layout.linePitch).toBe(30);
    // A genuinely short line (a paragraph's last word) that doesn't overlap its neighbours stays.
    const short = root();
    const q = document.createElement('p');
    const tail = document.createTextNode('A line of ordinary body text here. End.');
    q.appendChild(tail);
    short.appendChild(q);
    elementRects.set(q, rect(100, 400, 400, 60));
    textLayout.set(tail, () => [rect(100, 405, 380, 20), rect(100, 435, 30, 20)]);
    expect(measure(short).lines.map((l) => [l.top, l.charCount])).toEqual([
      [405, 36],
      [435, 3],
    ]);
  });

  it('skips ignored, hidden and non-text content', () => {
    const el = root();
    para(el, 50, 1, 'visible text');
    const cases: [string, (e: HTMLElement) => void][] = [
      ['ignored', (e) => e.setAttribute('data-gr-ignore', '')],
      ['aria-hidden', (e) => e.setAttribute('aria-hidden', 'true')],
      ['hidden attribute', (e) => e.setAttribute('hidden', '')],
      ['display none', (e) => (e.style.display = 'none')],
      ['visibility hidden', (e) => (e.style.visibility = 'hidden')],
      ['opacity 0', (e) => (e.style.opacity = '0')],
    ];
    cases.forEach(([label, hide], i) => {
      const wrapper = document.createElement('div');
      el.appendChild(wrapper);
      elementRects.set(wrapper, rect(100, 100 + i * 40, 400, 30));
      para(wrapper, 100 + i * 40, 1, label);
      hide(wrapper);
    });
    const script = document.createElement('script');
    script.textContent = 'var x = 1;';
    el.appendChild(script);
    elementRects.set(script, rect(100, 400, 400, 30));
    textLayout.set(script.firstChild as Text, () => [rect(100, 405, 100, 20)]);

    const srOnly = document.createElement('span');
    el.appendChild(srOnly);
    elementRects.set(srOnly, rect(100, 450, 1, 1));
    para(srOnly, 450, 1, 'screen reader only');

    const offscreen = document.createElement('div');
    el.appendChild(offscreen);
    elementRects.set(offscreen, rect(-10_000, 500, 400, 30));
    const offText = document.createTextNode('off to the left');
    offscreen.appendChild(offText);
    textLayout.set(offText, () => [rect(-10_000, 505, 200, 20)]);

    const layout = measure(el);
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0].top).toBe(55);
  });

  it('ignores text clipped away by overflow: hidden/clip, but not by scroll containers', () => {
    // Regression: a collapsed accordion (height: 0; overflow: hidden) or a line-clamped teaser
    // produced phantom lines on top of the real text.
    const el = root();
    para(el, 50, 1, 'real text');

    const collapsed = document.createElement('div');
    collapsed.style.overflow = 'hidden';
    el.appendChild(collapsed);
    elementRects.set(collapsed, rect(COL_LEFT, 100, COL_W, 0));
    para(collapsed, 100, 3, 'hidden answer text'); // lays out below the zero-height box

    const clamped = document.createElement('div');
    clamped.style.overflowY = 'clip';
    el.appendChild(clamped);
    elementRects.set(clamped, rect(COL_LEFT, 200, COL_W, 2 * PITCH)); // shows two of five lines
    para(clamped, 200, 5, 'teaser '.repeat(60));

    const scroller = document.createElement('div');
    scroller.style.overflow = 'auto';
    el.appendChild(scroller);
    elementRects.set(scroller, rect(COL_LEFT, 400, COL_W, PITCH));
    para(scroller, 400, 3, 'scrolls into view'); // lines below the box stay: they can be scrolled to

    const inline = document.createElement('span');
    inline.style.overflow = 'hidden'; // no effect on inline boxes
    el.appendChild(inline);
    elementRects.set(inline, rect(COL_LEFT, 500, COL_W, 1 * PITCH));
    const text = document.createTextNode('inline overflow does not apply');
    inline.appendChild(text);
    textLayout.set(text, () => [rect(COL_LEFT, 505, 300, LINE_H), rect(COL_LEFT, 535, 200, LINE_H)]);

    const tops = measure(el).lines.map((l) => l.top);
    expect(tops).toEqual([55, 205, 235, 405, 435, 465, 505, 535]);
  });

  it('measures a long text node fully when its middle is a long run of collapsed whitespace', () => {
    // Regression: a binary-search probe that found no box counted as "below the band", which cut
    // off every visible line after the whitespace run.
    const LINE = 80;
    const block = (from: number, to: number): string =>
      Array.from({ length: to - from }, (_, i) => `line ${from + i} `.padEnd(LINE - 1, 'x')).join('\n');
    const GAP = 1200;
    const text = `${block(0, 40)}\n${' '.repeat(GAP)}${block(40, 80)}`;
    const gapStart = 40 * LINE;
    const gapEnd = gapStart + GAP;
    const viewTop = 800; // line 40 (20 px pitch) sits at the top of the viewport
    const el = root(-viewTop, 80 * 20);
    const pre = document.createElement('div');
    const node = document.createTextNode(text);
    pre.appendChild(node);
    el.appendChild(pre);
    elementRects.set(pre, rect(COL_LEFT, -viewTop, 640, 80 * 20));
    const lineOf = (offset: number): number => (offset < gapStart ? Math.floor(offset / LINE) : offset < gapEnd ? -1 : 40 + Math.floor((offset - gapEnd) / LINE));
    textLayout.set(node, (start, end) => {
      const lines = new Set<number>();
      for (let o = start; o < end; o++) {
        const ch = text[o];
        const line = lineOf(o);
        if (line >= 0 && ch !== '\n' && ch !== ' ') lines.add(line);
      }
      return [...lines].sort((a, b) => a - b).map((line) => rect(COL_LEFT, line * 20 - viewTop + 2, 632, 16));
    });

    const layout = measure(el, { scrollTop: viewTop });
    // Band = −300…900 px → lines 25…79 (the book ends at line 79).
    expect(layout.lines[0].top).toBe(25 * 20 - viewTop + 2);
    expect(layout.lines.at(-1)?.top).toBe(79 * 20 - viewTop + 2);
    expect(layout.lines).toHaveLength(55);
  });

  it('descends into zero-size wrappers (display: contents, collapsed float parents)', () => {
    const el = root();
    const wrapper = document.createElement('div');
    el.appendChild(wrapper); // no rect → 0×0
    para(wrapper, 80, 2);
    expect(measure(el).lines).toHaveLength(2);
  });

  it('returns a safe empty layout for degenerate input', () => {
    const el = root();
    para(el, 50, 2);
    const flat = measure(el, { viewport: { left: 0, top: 100, right: 800, bottom: 100 } });
    expect(flat.lines).toEqual([]);
    expect(flat.column).toEqual({ left: 0, top: 100, right: 800, bottom: 100 });
    expect(Number.isFinite(flat.linePitch) && flat.linePitch > 0).toBe(true);

    const nan = measure(el, { viewport: { left: Number.NaN, top: 0, right: 800, bottom: 600 }, scrollTop: Number.NaN });
    expect(nan.scrollTop).toBe(0);
    expect(nan.lines.every((l) => Number.isFinite(l.docTop))).toBe(true);

    const detached = document.createElement('div');
    expect(measure(detached).lines).toEqual([]);

    const single = root();
    para(single, 10, 1);
    const one = measure(single);
    expect(one.lines).toHaveLength(1);
    expect(one.linePitch).toBeGreaterThan(0);
  });

  it('prunes by bounding box and binary-searches long child lists (large book)', () => {
    const SECTIONS = 200;
    const PARAS = 50;
    const PARA_H = 3 * PITCH + 10;
    const SECTION_H = PARAS * PARA_H;
    const viewTop = 57_000; // content y at the top of the viewport
    const el = root(-viewTop, SECTIONS * SECTION_H);
    for (let s = 0; s < SECTIONS; s++) {
      const section = document.createElement('section');
      el.appendChild(section);
      const sTop = s * SECTION_H - viewTop;
      elementRects.set(section, rect(COL_LEFT, sTop, COL_W, SECTION_H));
      for (let p = 0; p < PARAS; p++) {
        const para = document.createElement('p');
        const node = document.createTextNode('word '.repeat(48).trim());
        para.appendChild(node);
        section.appendChild(para);
        const pTop = sTop + p * PARA_H;
        elementRects.set(para, rect(COL_LEFT, pTop, COL_W, 3 * PITCH));
        textLayout.set(node, () => [0, 1, 2].map((i) => rect(COL_LEFT, pTop + i * PITCH + 5, COL_W, LINE_H)));
      }
    }

    const started = performance.now();
    const layout = measureLines({ root: el, viewport: VIEWPORT, scrollTop: viewTop, scrollHeight: SECTIONS * SECTION_H, clientHeight: 600 });
    const elapsed = performance.now() - started;

    // 600 px viewport ± 300 px margin = 1200 px band ≈ 12 paragraphs ≈ 36 lines.
    expect(layout.lines.length).toBeGreaterThanOrEqual(30);
    expect(layout.lines.length).toBeLessThanOrEqual(42);
    expect(layout.lines.every((l) => l.bottom >= -300 && l.top <= 900)).toBe(true);
    expect(layout.lines.every((l) => Math.abs(l.docTop - (l.top + viewTop)) < 1e-9)).toBe(true);
    expect(layout.linePitch).toBe(PITCH);
    // 10 000 paragraphs, yet only a few dozen rect queries.
    expect(calls.element).toBeLessThan(120);
    expect(calls.rangeRects).toBeLessThan(25);
    expect(elapsed).toBeLessThan(1000); // jsdom is slow; in a browser this is well under 8 ms
  });

  it('band-searches thousands of <br>-separated text nodes instead of measuring each one', () => {
    const LINES = 3000;
    const viewTop = 30_000; // line 1500 (20 px pitch) is at the top of the viewport
    const el = root(-viewTop, LINES * 20);
    const div = document.createElement('div');
    el.appendChild(div);
    elementRects.set(div, rect(COL_LEFT, -viewTop, COL_W, LINES * 20));
    for (let i = 0; i < LINES; i++) {
      const node = document.createTextNode(`Line ${i} of an old-school web page, one text node per line.`);
      div.appendChild(node);
      textLayout.set(node, () => [rect(COL_LEFT, i * 20 - viewTop + 2, 380, 16)]);
      if (i < LINES - 1) {
        const br = document.createElement('br');
        div.appendChild(br);
        elementRects.set(br, rect(COL_LEFT + 380, i * 20 - viewTop + 2, 0, 16));
      }
    }
    const layout = measure(el, { scrollTop: viewTop });
    expect(layout.lines.length).toBeGreaterThanOrEqual(58);
    expect(layout.lines.length).toBeLessThanOrEqual(62);
    expect(layout.lines[0].docTop).toBeGreaterThanOrEqual(viewTop - 300 - 20);
    expect(calls.rangeRects).toBeLessThan(70); // ≈ the lines in the band, not 3000
    expect(calls.rangeBox + calls.element).toBeLessThan(100); // a binary search + the band, never the <br>s
  });

  it('does not binary-search containers whose children do not stack (multi-column, flex, grid)', () => {
    for (const style of ['column-count: 2', 'display: flex; flex-wrap: wrap', 'display: grid']) {
      document.body.replaceChildren();
      const el = root(0, 1000);
      el.setAttribute('style', style);
      // 40 children: the first 20 fill column one, the next 20 start again at the top of column two.
      for (let i = 0; i < 40; i++) {
        const top = (i % 20) * 50;
        const p = document.createElement('p');
        const node = document.createTextNode(`item ${i}`);
        p.appendChild(node);
        el.appendChild(p);
        const left = i < 20 ? 100 : 500;
        elementRects.set(p, rect(left, top, 250, 40));
        textLayout.set(node, () => [rect(left, top + 10, 60, 20)]);
      }
      const layout = measure(el, { marginPx: 0 });
      // Both columns' visible items (tops 10…560) are found: 12 rows, each spanning both columns.
      expect(layout.lines).toHaveLength(12);
      expect(layout.lines.every((l) => l.left === 100 && l.right === 560)).toBe(true);
    }
  });

  it('windows a huge text node (a whole book in one <pre>) instead of measuring all of it', () => {
    const CHARS_PER_LINE = 80;
    const TOTAL_LINES = 800;
    const text = Array.from({ length: TOTAL_LINES }, (_, i) => `line ${String(i).padStart(4, '0')} `.padEnd(CHARS_PER_LINE - 1, 'x')).join('\n');
    const viewTop = 10_000; // line 500 (20 px pitch) is at the top of the viewport
    const el = root(-viewTop, TOTAL_LINES * 20);
    const pre = document.createElement('pre');
    const node = document.createTextNode(text);
    pre.appendChild(node);
    el.appendChild(pre);
    elementRects.set(pre, rect(COL_LEFT, -viewTop, 640, TOTAL_LINES * 20));
    textLayout.set(node, (start, end) => {
      const out: DOMRect[] = [];
      const firstLine = Math.floor(start / CHARS_PER_LINE);
      const lastLine = Math.floor((Math.max(start, end - 1)) / CHARS_PER_LINE);
      for (let line = firstLine; line <= lastLine && line < TOTAL_LINES; line++) {
        const lineStart = line * CHARS_PER_LINE;
        const from = Math.max(start, lineStart);
        const to = Math.min(end, lineStart + CHARS_PER_LINE - 1); // the newline has no box
        if (to <= from) continue;
        out.push(rect(COL_LEFT + (from - lineStart) * 8, line * 20 - viewTop + 2, (to - from) * 8, 16));
      }
      return out;
    });

    const layout = measure(el, { scrollTop: viewTop });
    // 600 px ± 300 px margin at a 20 px pitch = 60 lines.
    expect(layout.lines.length).toBeGreaterThanOrEqual(58);
    expect(layout.lines.length).toBeLessThanOrEqual(62);
    expect(layout.lines.every((l) => l.left === COL_LEFT && l.right === COL_LEFT + 79 * 8)).toBe(true);
    // ≈ 79 visible characters per line (collapsed whitespace is shared out approximately).
    expect(layout.lines.every((l) => Math.abs(l.charCount - 79) <= 1)).toBe(true);
    expect(layout.linePitch).toBe(20);
    expect(calls.rangeRects).toBe(1);
    expect(calls.rangeBox).toBeLessThan(80);
  });
});
