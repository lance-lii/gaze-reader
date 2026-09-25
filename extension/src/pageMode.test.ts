// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { GazeSample, LineLayout, TextLine } from '../../src/types';
import { PageEndDetector, lastFullyVisibleLine, pageEndZones } from '../../src/reading/pageEndDetector';
import {
  ENTER_PAGE_MODE_MS,
  PageModeMonitor,
  buildPseudoLayout,
  centralColumn,
  countReadableLines,
  findPageModeScroller,
  isScrollable,
  modeLineCount,
  largestVisualRect,
  pressPageKeys,
  resolvePageTurn,
} from './pageMode';

const VIEWPORT = { left: 0, top: 0, right: 1280, bottom: 800 };

function pseudo(extra: Partial<Parameters<typeof buildPseudoLayout>[0]> = {}): LineLayout {
  return buildPseudoLayout({ viewport: VIEWPORT, scrollTop: 0, scrollHeight: 800, clientHeight: 800, now: 0, ...extra });
}

function line(i: number, top: number, charCount = 60, left = 100, right = 700): TextLine {
  return { index: i, top, bottom: top + 24, left, right, centerY: top + 12, docTop: top, charCount, fullyVisible: true };
}

function layoutOf(lines: TextLine[]): LineLayout {
  return {
    lines,
    viewport: VIEWPORT,
    column: { left: 100, right: 700, top: 0, bottom: 800 },
    linePitch: 32,
    scrollTop: 0,
    scrollHeight: 800,
    clientHeight: 800,
    measuredAt: 0,
  };
}

const sample = (t: number, x: number, y: number, valid = true): GazeSample => ({
  t,
  x,
  y,
  rawX: x,
  rawY: y,
  valid,
  confidence: valid ? 0.9 : 0,
  source: 'mouse',
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('buildPseudoLayout', () => {
  it('tiles a central column with evenly spaced, fully visible lines ending just above the bottom', () => {
    const layout = pseudo();
    const { lines, linePitch } = layout;
    expect(linePitch).toBe(40); // 800 px tall → 20 lines' worth
    expect(lines.length).toBeGreaterThanOrEqual(15);
    const col = centralColumn(VIEWPORT);
    expect(col.right - col.left).toBeCloseTo(0.7 * 1280);
    lines.forEach((l, i) => {
      expect(l.index).toBe(i);
      expect(l.left).toBe(col.left);
      expect(l.right).toBe(col.right);
      expect(l.fullyVisible).toBe(true);
      expect(l.centerY).toBeCloseTo((l.top + l.bottom) / 2);
      if (i > 0) expect(l.top - lines[i - 1]!.top).toBeCloseTo(linePitch);
    });
    expect(lines[0]!.top).toBeGreaterThanOrEqual(VIEWPORT.top + 0.5 * linePitch - 1e-9);
    const last = lines.at(-1)!;
    expect(last.bottom).toBeLessThanOrEqual(VIEWPORT.bottom);
    expect(VIEWPORT.bottom - last.bottom).toBeLessThan(linePitch);
    expect(layout.column).toEqual({ left: col.left, right: col.right, top: lines[0]!.top, bottom: last.bottom });
  });

  it('puts docTop in scroll coordinates and keeps the scroll metrics', () => {
    const top = pseudo({ scrollTop: 0 });
    const scrolled = pseudo({ scrollTop: 1500, scrollHeight: 9000 });
    expect(scrolled.lines[3]!.docTop - top.lines[3]!.docTop).toBe(1500);
    expect(scrolled).toMatchObject({ scrollTop: 1500, scrollHeight: 9000, clientHeight: 800 });
  });

  it('follows the page picture when there is one, and ignores slivers', () => {
    const page = { left: 340, top: 60, right: 940, bottom: 760 };
    const onPage = pseudo({ content: page });
    expect(onPage.lines[0]!.left).toBe(340);
    expect(onPage.lines[0]!.right).toBe(940);
    expect(onPage.lines[0]!.top).toBeGreaterThanOrEqual(60);
    expect(onPage.lines.at(-1)!.bottom).toBeLessThanOrEqual(760);

    const sliver = pseudo({ content: { left: 0, top: 0, right: 1280, bottom: 90 } }); // a banner
    expect(sliver.lines[0]!.left).toBe(centralColumn(VIEWPORT).left);
  });

  it('respects an explicit pitch and never returns an empty layout', () => {
    expect(pseudo({ pitch: 30 }).linePitch).toBe(30);
    const tiny = buildPseudoLayout({ viewport: { left: 0, top: 0, right: 200, bottom: 20 }, scrollTop: 0, scrollHeight: 20, clientHeight: 20 });
    expect(tiny.lines.length).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(tiny.linePitch)).toBe(true);
  });

  it("works with the page-end detector's geometric rules: glance-down fires, the line rule stays out", () => {
    const layout = pseudo();
    const zones = pageEndZones(layout)!;
    expect(zones.lastIndex).toBe(lastFullyVisibleLine(layout));
    expect(zones.glanceTop).toBeGreaterThan(zones.lastLine.bottom - 1);

    const detector = new PageEndDetector({ sensitivity: 'balanced', glanceDownToTurn: true });
    let t = 0;
    for (; t < 3000; t += 33) detector.update({ t, gaze: sample(t, 640, 300), estimate: null, layout });
    let fired = null;
    for (; t < 5000 && !fired; t += 33) {
      const d = detector.update({ t, gaze: sample(t, 640, 830), estimate: null, layout }); // looking below the page
      if (d.trigger) fired = d;
    }
    expect(fired).toMatchObject({ trigger: true, reason: 'glance-down' });
  });

  it('bottom-dwell turns the page for a gaze resting at the bottom right of the pseudo column', () => {
    const layout = pseudo();
    const last = layout.lines.at(-1)!;
    const detector = new PageEndDetector({ sensitivity: 'balanced', glanceDownToTurn: false });
    let t = 0;
    for (; t < 1000; t += 33) detector.update({ t, gaze: sample(t, 640, 300), estimate: null, layout });
    let fired = null;
    for (; t < 8000 && !fired; t += 33) {
      const d = detector.update({ t, gaze: sample(t, last.right - 60, last.centerY), estimate: null, layout });
      if (d.trigger) fired = d;
    }
    expect(fired).toMatchObject({ trigger: true, reason: 'bottom-dwell' });
  });
});

describe('countReadableLines', () => {
  it('counts lines in view with more than a label of text', () => {
    const lines = [
      line(0, -300), // above the viewport (measured in the margin)
      line(1, 40, 4), // "12 %"
      line(2, 100),
      line(3, 140),
      line(4, 900), // below
    ];
    expect(countReadableLines(layoutOf(lines))).toBe(2);
    expect(countReadableLines(layoutOf(lines), 'nearby')).toBe(4); // everything measured, labels aside
    expect(countReadableLines(null)).toBe(0);
  });

  it('enters page mode only without text around the view, and leaves it once text is in view', () => {
    const articleEnd = layoutOf([line(0, -200), line(1, -160), line(2, -120), line(3, 20), line(4, 60)]);
    expect(modeLineCount(articleEnd, 'text')).toBe(5);
    expect(modeLineCount(articleEnd, 'page')).toBe(2);
    expect(modeLineCount(layoutOf([line(0, -200), line(1, -160)]), 'text')).toBe(2);
  });
});

describe('PageModeMonitor', () => {
  it('enters page mode only after the text has been scarce for ~2 s', () => {
    const m = new PageModeMonitor();
    expect(m.observe(0, 0)).toBe('text');
    expect(m.needsPolling).toBe(true);
    expect(m.observe(1, ENTER_PAGE_MODE_MS - 1)).toBe('text');
    expect(m.observe(2, ENTER_PAGE_MODE_MS)).toBe('page');
    expect(m.mode).toBe('page');
    expect(m.needsPolling).toBe(true);
  });

  it('a brief dip in the text never switches, and the clock restarts after text comes back', () => {
    const m = new PageModeMonitor();
    m.observe(0, 0);
    expect(m.observe(12, 1_500)).toBe('text');
    expect(m.needsPolling).toBe(false);
    expect(m.observe(0, 1_600)).toBe('text');
    expect(m.observe(0, 3_000)).toBe('text'); // only 1.4 s since the text went
    expect(m.observe(0, 3_600)).toBe('page');
  });

  it('switches back to text as soon as real lines appear, and can enter again later', () => {
    const m = new PageModeMonitor({ minLines: 3, enterAfterMs: 1_000 });
    m.observe(0, 0);
    m.observe(0, 1_000);
    expect(m.mode).toBe('page');
    expect(m.observe(3, 1_100)).toBe('text');
    expect(m.observe(0, 1_200)).toBe('text');
    expect(m.observe(0, 2_200)).toBe('page');
    m.reset();
    expect(m.mode).toBe('text');
    expect(m.needsPolling).toBe(false);
  });
});

describe('resolvePageTurn', () => {
  const scrolls = { scrollTop: 0, scrollHeight: 5000, clientHeight: 800 };
  const fixed = { scrollTop: 0, scrollHeight: 810, clientHeight: 800 };

  it('auto: text mode always scrolls; page mode scrolls pages that scroll and sends keys otherwise', () => {
    expect(resolvePageTurn('auto', 'text', fixed)).toBe('scroll');
    expect(resolvePageTurn('auto', 'page', scrolls)).toBe('scroll');
    expect(resolvePageTurn('auto', 'page', fixed)).toBe('keys');
    expect(resolvePageTurn('auto', 'page', null)).toBe('keys');
  });

  it('an explicit choice wins in both modes', () => {
    for (const mode of ['text', 'page'] as const) {
      expect(resolvePageTurn('scroll', mode, fixed)).toBe('scroll');
      expect(resolvePageTurn('keys', mode, scrolls)).toBe('keys');
    }
  });

  it('a few pixels of overflow is not a scrolling page', () => {
    expect(isScrollable(fixed)).toBe(false);
    expect(isScrollable({ scrollTop: 0, scrollHeight: 1200, clientHeight: 800 })).toBe(true);
    expect(isScrollable({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(false);
  });
});

describe('pressPageKeys', () => {
  function recordKeys(target: EventTarget) {
    const seen: string[] = [];
    for (const type of ['keydown', 'keyup']) {
      target.addEventListener(type, (e) => {
        const k = e as KeyboardEvent;
        seen.push(`${k.type}:${k.key}:${k.keyCode}:${String(k.bubbles)}`);
      });
    }
    return seen;
  }

  it('presses ArrowRight then PageDown on the focused element, bubbling to the document', () => {
    document.body.innerHTML = '<div id="reader" tabindex="0"></div>';
    const reader = document.getElementById('reader')!;
    reader.focus();
    const atReader = recordKeys(reader);
    const atDocument = recordKeys(document);
    expect(pressPageKeys(document, 'forward')).toBe(reader);
    const expected = ['keydown:ArrowRight:39:true', 'keyup:ArrowRight:39:true', 'keydown:PageDown:34:true', 'keyup:PageDown:34:true'];
    expect(atReader).toEqual(expected);
    expect(atDocument).toEqual(expected);
  });

  it('goes back with ArrowLeft + PageUp, on the body when nothing (or only our own UI) has focus', () => {
    document.body.innerHTML = '<gaze-reader-root data-gr-ignore><button id="ours"></button></gaze-reader-root>';
    document.getElementById('ours')!.focus();
    const atBody = recordKeys(document.body);
    expect(pressPageKeys(document, 'back')).toBe(document.body);
    expect(atBody.filter((k) => k.startsWith('keydown'))).toEqual(['keydown:ArrowLeft:37:true', 'keydown:PageUp:33:true']);
  });
});

describe('largestVisualRect', () => {
  function place(el: Element, r: { left: number; top: number; width: number; height: number }) {
    el.getBoundingClientRect = () => DOMRect.fromRect({ x: r.left, y: r.top, width: r.width, height: r.height });
  }

  it('picks the biggest canvas or image in view, clipped to the viewport, skipping our own UI', () => {
    document.body.innerHTML = `
      <img id="logo"><canvas id="page"></canvas><img id="offscreen">
      <div data-gr-ignore><canvas id="ours"></canvas></div>`;
    place(document.getElementById('logo')!, { left: 0, top: 0, width: 120, height: 40 });
    place(document.getElementById('page')!, { left: 300, top: 50, width: 700, height: 900 });
    place(document.getElementById('offscreen')!, { left: 0, top: 2000, width: 1280, height: 800 });
    place(document.getElementById('ours')!, { left: 0, top: 0, width: 1280, height: 800 });
    expect(largestVisualRect(document, VIEWPORT)).toEqual({ left: 300, top: 50, right: 1000, bottom: 800 });
  });

  it('returns null when nothing visual covers a meaningful part of the view', () => {
    document.body.innerHTML = '<img id="icon">';
    place(document.getElementById('icon')!, { left: 10, top: 10, width: 32, height: 32 });
    expect(largestVisualRect(document, VIEWPORT)).toBeNull();
  });
});

describe('findPageModeScroller', () => {
  it("scrolls the box around the page's picture when the main content's scroller can't scroll", () => {
    document.body.innerHTML = '<p id="bar">Viewer</p><div id="pages" style="overflow-y: auto"><canvas id="page"></canvas></div>';
    const pages = document.getElementById('pages')!;
    Object.defineProperty(pages, 'scrollHeight', { configurable: true, value: 9000 });
    Object.defineProperty(pages, 'clientHeight', { configurable: true, value: 760 });
    document.getElementById('page')!.getBoundingClientRect = () => DOMRect.fromRect({ x: 200, y: 0, width: 800, height: 1000 });
    expect(findPageModeScroller(document, document.body, VIEWPORT)).toBe(pages);
  });

  it('falls back to the main content scroller (the window) when nothing scrolls', () => {
    document.body.innerHTML = '<canvas id="page"></canvas>';
    document.getElementById('page')!.getBoundingClientRect = () => DOMRect.fromRect({ x: 200, y: 0, width: 800, height: 700 });
    expect(findPageModeScroller(document, document.body, VIEWPORT)).toBe(window);
  });
});
