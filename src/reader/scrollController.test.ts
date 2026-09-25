// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../core/events';
import { DEFAULT_SETTINGS } from '../core/settings';
import type { AppEvents, AppSettings, EventBus, LineLayout, TextLine } from '../types';
import { ScrollController, easeInOutCubic } from './scrollController';

// ───────────────────────────── test doubles ─────────────────────────────

let clock = 0;
let frames: { id: number; cb: FrameRequestCallback }[] = [];
let nextFrameId = 1;
const reduced = { matches: false };

/** Advances the clock to `t` and runs the frames that were queued before this call. */
function frame(t: number): void {
  clock = t;
  const due = frames;
  frames = [];
  for (const f of due) f.cb(t);
}

function runAnimation(until = 5000, step = 16): void {
  let t = clock;
  while (frames.length && t < until) {
    t += step;
    frame(t);
  }
}

interface FakeScroller extends HTMLDivElement {
  setScroll(top: number): void;
}

function makeScroller(opts: { scrollHeight?: number; clientHeight?: number } = {}): FakeScroller {
  const el = document.createElement('div') as FakeScroller;
  let top = 0;
  const scrollHeight = opts.scrollHeight ?? 10_000;
  const clientHeight = opts.clientHeight ?? 600;
  Object.defineProperties(el, {
    scrollTop: {
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(scrollHeight - clientHeight, v)); // browsers clamp too
      },
    },
    scrollHeight: { get: () => scrollHeight },
    clientHeight: { get: () => clientHeight },
    clientWidth: { get: () => 785 },
    clientLeft: { get: () => 0 },
    clientTop: { get: () => 0 },
  });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  el.setScroll = (v) => {
    el.scrollTop = v;
  };
  document.body.appendChild(el);
  return el;
}

function makeLayout(scrollTop: number, opts: { lines?: number; pitch?: number; first?: number } = {}): LineLayout {
  const pitch = opts.pitch ?? 40;
  const first = opts.first ?? 10;
  const lines: TextLine[] = Array.from({ length: opts.lines ?? 20 }, (_, index) => {
    const top = first + index * pitch;
    return {
      index,
      top,
      bottom: top + 25,
      left: 100,
      right: 700,
      centerY: top + 12.5,
      docTop: top + scrollTop,
      charCount: 60,
      fullyVisible: top >= 0 && top + 25 <= 600,
    };
  });
  return {
    lines,
    viewport: { left: 0, top: 0, right: 800, bottom: 600 },
    column: { left: 100, top: first, right: 700, bottom: lines[lines.length - 1].bottom },
    linePitch: pitch,
    scrollTop,
    scrollHeight: 10_000,
    clientHeight: 600,
    measuredAt: 0,
  };
}

interface Harness {
  scroller: FakeScroller;
  bus: EventBus;
  controller: ScrollController;
  settings: AppSettings;
  events: { type: string; payload: unknown }[];
}

function setup(overrides: Partial<AppSettings> = {}, scrollerOpts?: Parameters<typeof makeScroller>[0]): Harness {
  const scroller = makeScroller(scrollerOpts);
  const bus = createEventBus();
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const events: Harness['events'] = [];
  for (const type of ['page-turn', 'page-turn-undone'] as const) {
    bus.on(type, (payload: AppEvents[typeof type]) => events.push({ type, payload }));
  }
  const controller = new ScrollController({ scroller, bus, getSettings: () => settings });
  return { scroller, bus, controller, settings, events };
}

beforeEach(() => {
  clock = 1000;
  frames = [];
  reduced.matches = false;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames = frames.filter((f) => f.id !== id);
  });
  vi.stubGlobal('matchMedia', () => reduced as unknown as MediaQueryList);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// ───────────────────────────────── tests ─────────────────────────────────

describe('easeInOutCubic', () => {
  it('is 0 → 1, symmetric and clamped', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1);
    expect(easeInOutCubic(-3)).toBe(0);
    expect(easeInOutCubic(9)).toBe(1);
  });
});

describe('ScrollController.computeTarget', () => {
  it('puts lines[L − overlap + 1] at the top, 0.35 pitch below the edge', () => {
    const { scroller, controller } = setup();
    scroller.setScroll(2000);
    const layout = makeLayout(2000);
    const L = 13; // top = 10 + 13 × 40 = 530
    expect(controller.computeTarget(layout, L, 0)).toBe(layout.lines[14].docTop - 14);
    expect(controller.computeTarget(layout, L, 1)).toBe(layout.lines[13].docTop - 14);
    expect(controller.computeTarget(layout, L, 2)).toBe(layout.lines[12].docTop - 14);
    expect(controller.computeTarget(layout, L, 7.6)).toBe(layout.lines[11].docTop - 14); // clamped to 3 lines
  });

  it('falls back to a screenful minus the overlap when the line is unknown or not forward enough', () => {
    const { scroller, controller } = setup();
    scroller.setScroll(2000);
    const layout = makeLayout(2000);
    const fallback = (overlap: number) => 2000 + 600 - (overlap + 1) * 40;
    expect(controller.computeTarget(layout, 19, 0)).toBe(fallback(0)); // lines[20] doesn't exist
    expect(controller.computeTarget(layout, 0, 1)).toBe(fallback(1)); // lines[0] is not a pitch forward
    expect(controller.computeTarget(layout, -1, 1)).toBe(fallback(1));
    expect(controller.computeTarget(layout, Number.NaN, 1)).toBe(fallback(1));
    // No layout at all: the pitch comes from the settings (22 px × 1.9).
    expect(controller.computeTarget(null, 5, 1)).toBeCloseTo(2000 + 600 - 2 * 22 * 1.9);
  });

  it('never goes past the end of the scroll range', () => {
    const { scroller, controller } = setup({}, { scrollHeight: 2500 });
    scroller.setScroll(1800);
    expect(controller.computeTarget(makeLayout(1800), 13, 1)).toBe(1900);
  });
});

describe('ScrollController.turnPage', () => {
  it('emits page-turn and animates with an ease-in-out curve to the exact target', async () => {
    const { scroller, controller, events } = setup({ scrollDurationMs: 400 });
    scroller.setScroll(2000);
    const layout = makeLayout(2000);
    const target = layout.lines[13].docTop - 14;
    const done = controller.turnPage(layout, 13, { auto: true, reason: 'line-tracker' });

    expect(events).toEqual([{ type: 'page-turn', payload: { from: 2000, to: target, auto: true, reason: 'line-tracker', pageIndex: 1 } }]);
    expect(controller.animating).toBe(true);
    expect(controller.pagesTurned).toBe(1);
    expect(controller.lastTurnAt).toBe(1000);

    frame(1100); // t = 0.25
    expect(scroller.scrollTop).toBeCloseTo(2000 + (target - 2000) * easeInOutCubic(0.25), 5);
    frame(1200); // t = 0.5
    expect(scroller.scrollTop).toBeCloseTo(2000 + (target - 2000) * 0.5, 5);
    frame(1400);
    expect(scroller.scrollTop).toBe(target);
    await done;
    expect(controller.animating).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it('is instant under prefers-reduced-motion or with a zero duration', async () => {
    reduced.matches = true;
    const a = setup();
    a.scroller.setScroll(2000);
    await a.controller.turnPage(makeLayout(2000), 13, { auto: false, reason: 'key' });
    expect(a.scroller.scrollTop).toBe(makeLayout(2000).lines[13].docTop - 14);
    expect(frames).toHaveLength(0);

    reduced.matches = false;
    const b = setup({ scrollDurationMs: 0 });
    await b.controller.turnPage(null, -1, { auto: false, reason: 'key' });
    expect(b.scroller.scrollTop).toBeCloseTo(600 - 2 * 22 * 1.9);
  });

  it('does nothing (and emits nothing) at the end of the book', async () => {
    const { scroller, controller, events } = setup({}, { scrollHeight: 2600 });
    scroller.setScroll(2000);
    expect(controller.atEnd()).toBe(true);
    await controller.turnPage(makeLayout(2000), 13, { auto: true, reason: 'line-tracker' });
    expect(events).toEqual([]);
    expect(controller.pagesTurned).toBe(0);
  });

  it('finishes a running turn before starting the next one', async () => {
    const { scroller, controller, events } = setup({ scrollDurationMs: 400 });
    const first = controller.turnPage(null, -1, { auto: false, reason: 'key' });
    frame(1100);
    const second = controller.turnPage(null, -1, { auto: false, reason: 'key' });
    await first; // resolved by the jump to its destination
    const step = 600 - 2 * 22 * 1.9;
    expect(events.map((e) => (e.payload as { from: number }).from)).toEqual([0, step]);
    runAnimation();
    await second;
    expect(scroller.scrollTop).toBeCloseTo(2 * step);
    expect(controller.pagesTurned).toBe(2);
  });
});

describe('ScrollController — the reader can interrupt', () => {
  async function startTurn(h: Harness): Promise<{ done: Promise<void>; mid: number }> {
    const done = h.controller.turnPage(null, -1, { auto: true, reason: 'bottom-dwell' });
    frame(clock + 200);
    return { done, mid: h.scroller.scrollTop };
  }

  it('stops on wheel, touch and middle-click', async () => {
    for (const make of [
      () => new WheelEvent('wheel', { deltaY: 10 }),
      () => new Event('touchstart'),
      () => new MouseEvent('pointerdown', { button: 1, clientX: 400, clientY: 300 }),
    ]) {
      const h = setup();
      const { done, mid } = await startTurn(h);
      h.scroller.dispatchEvent(make());
      await done;
      expect(h.controller.animating).toBe(false);
      runAnimation();
      expect(h.scroller.scrollTop).toBe(mid);
      document.body.replaceChildren();
    }
  });

  it('stops on a pointer press on the scrollbar, but not on the text', async () => {
    const h = setup();
    const { done } = await startTurn(h);
    h.scroller.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 400, clientY: 300 }));
    expect(h.controller.animating).toBe(true);
    h.scroller.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 792, clientY: 300 }));
    expect(h.controller.animating).toBe(false);
    await done;
  });

  it('stops on navigation keys pressed during the animation — but not on the key that started it', async () => {
    const h = setup();
    const started = clock;
    const { done } = await startTurn(h);
    const early = new KeyboardEvent('keydown', { key: 'PageDown' });
    Object.defineProperty(early, 'timeStamp', { value: started - 5 });
    window.dispatchEvent(early);
    expect(h.controller.animating).toBe(true);
    const letter = new KeyboardEvent('keydown', { key: 'a' });
    Object.defineProperty(letter, 'timeStamp', { value: clock });
    window.dispatchEvent(letter);
    expect(h.controller.animating).toBe(true);
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown' });
    Object.defineProperty(arrow, 'timeStamp', { value: clock });
    window.dispatchEvent(arrow);
    expect(h.controller.animating).toBe(false);
    await done;
  });

  it('understands epoch-based event timestamps from older engines', async () => {
    const h = setup();
    const { done } = await startTurn(h);
    const key = new KeyboardEvent('keydown', { key: 'End' });
    Object.defineProperty(key, 'timeStamp', { value: Date.now() });
    window.dispatchEvent(key);
    expect(h.controller.animating).toBe(false);
    await done;
  });

  it('gives up when something else moves the scroll position', async () => {
    const h = setup();
    const { done } = await startTurn(h);
    h.scroller.setScroll(4321); // e.g. find-in-page
    frame(clock + 16);
    await done;
    expect(h.controller.animating).toBe(false);
    expect(h.scroller.scrollTop).toBe(4321);
  });
});

describe('ScrollController — undo, back and teardown', () => {
  it('undoes the last turn and reports it', async () => {
    const { scroller, controller, events } = setup({ scrollDurationMs: 0 });
    scroller.setScroll(1000);
    await controller.turnPage(null, -1, { auto: true, reason: 'glance-down' });
    const after = scroller.scrollTop;
    expect(await controller.undo()).toBe(true);
    expect(scroller.scrollTop).toBe(1000);
    expect(events[1]).toEqual({ type: 'page-turn-undone', payload: { from: after, to: 1000 } });
    expect(controller.pagesTurned).toBe(0);
    expect(await controller.undo()).toBe(false);
  });

  it('forgets undo records after a reflow but keeps the session statistics', async () => {
    const { scroller, controller } = setup({ scrollDurationMs: 0 });
    scroller.setScroll(1000);
    await controller.turnPage(null, -1, { auto: true, reason: 'glance-down' });
    const after = scroller.scrollTop;
    controller.clearHistory();
    expect(controller.pagesTurned).toBe(1);
    expect(await controller.undo()).toBe(false);
    expect(scroller.scrollTop).toBe(after);
    expect(controller.pagesTurned).toBe(1);
  });

  it('keeps at most 20 turns to undo', async () => {
    const { controller } = setup({ scrollDurationMs: 0 }, { scrollHeight: 1_000_000 });
    for (let i = 0; i < 25; i++) await controller.turnPage(null, -1, { auto: true, reason: 'x' });
    let undone = 0;
    while (await controller.undo()) undone++;
    expect(undone).toBe(20);
  });

  it('pages back by a screen minus the overlap and stops at the top', async () => {
    const { scroller, controller, events } = setup({ scrollDurationMs: 0, overlapLines: 1 });
    scroller.setScroll(2000);
    await controller.pageBack(makeLayout(2000));
    expect(scroller.scrollTop).toBe(2000 - (600 - 2 * 40));
    scroller.setScroll(100);
    await controller.pageBack(makeLayout(100));
    expect(scroller.scrollTop).toBe(0);
    await controller.pageBack(null);
    expect(scroller.scrollTop).toBe(0);
    expect(events).toEqual([]);
  });

  it('scrollTo clamps, animates and resolves when interrupted by another scrollTo', async () => {
    const { scroller, controller } = setup({ scrollDurationMs: 300 });
    const first = controller.scrollTo(50_000);
    frame(clock + 16);
    const second = controller.scrollTo(-10, 0);
    await first;
    await second;
    expect(scroller.scrollTop).toBe(0);
    await controller.scrollTo(Number.NaN);
    expect(scroller.scrollTop).toBe(0);
  });

  it('destroy() stops the animation, removes every listener and makes later calls no-ops', async () => {
    const h = setup();
    const removed: string[] = [];
    const winRemove = vi.spyOn(window, 'removeEventListener').mockImplementation(function (this: Window, type: string) {
      removed.push(`window:${type}`);
    });
    const elRemove = vi.spyOn(h.scroller, 'removeEventListener').mockImplementation((type: string) => {
      removed.push(`scroller:${type}`);
    });
    const done = h.controller.turnPage(null, -1, { auto: true, reason: 'x' });
    h.controller.destroy();
    await done;
    expect(frames).toHaveLength(0);
    expect(removed.sort()).toEqual(['scroller:pointerdown', 'scroller:touchstart', 'scroller:wheel', 'window:keydown']);
    winRemove.mockRestore();
    elRemove.mockRestore();
    await h.controller.turnPage(null, -1, { auto: true, reason: 'x' });
    expect(await h.controller.undo()).toBe(false);
    expect(h.events).toHaveLength(1);
    h.controller.destroy(); // idempotent
  });
});

describe('ScrollController on the window', () => {
  it('scrolls the page with behavior "instant" and reads window.scrollY', async () => {
    let y = 0;
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
    const root = document.scrollingElement ?? document.documentElement;
    Object.defineProperty(root, 'scrollHeight', { configurable: true, get: () => 5000 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => 700 });
    const scrollTo = vi.fn((opts: ScrollToOptions) => {
      y = opts.top ?? y;
    });
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    const bus = createEventBus();
    const controller = new ScrollController({ scroller: window, bus, getSettings: () => ({ ...DEFAULT_SETTINGS, scrollDurationMs: 0 }) });
    await controller.turnPage(null, -1, { auto: false, reason: 'key' });
    expect(y).toBeCloseTo(700 - 2 * 22 * 1.9);
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'instant' }));
    expect(controller.atEnd()).toBe(false);
    await controller.scrollTo(99_999);
    expect(y).toBe(4300);
    expect(controller.atEnd()).toBe(true);
    controller.destroy();
  });
});
