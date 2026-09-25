// @vitest-environment jsdom
/**
 * Page mode at the session level: a page whose text can't be measured (a
 * canvas or image reader) switches to pseudo-lines after ~2 s, turns pages by
 * scrolling or by the page's own next-page keys, and switches back once real
 * text lines appear. jsdom has no layout, so line measurement is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvents, AppSettings, EventBus, EventName, LineLayout, TextLine } from '../../src/types';
import type { MeasureOptions } from '../../src/reader/lineGeometry';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { KEYS, type ExtSettings } from './extStorage';
import { PORT_TAB } from './messages';
import { HOST_TAG, PageSession, resetPageModeNotice, type PageSessionDeps } from './pageSession';
import { FakeStorage, flush, portPair } from './testing/fakes';

const { buses, text } = vi.hoisted(() => ({ buses: [] as EventBus[], text: { lines: 0, above: 0 } }));

vi.mock('../../src/core/events', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/events')>();
  return {
    ...mod,
    createEventBus: (): EventBus => {
      const bus = mod.createEventBus();
      buses.push(bus);
      return bus;
    },
  };
});

/** `text.lines` full-width lines of real text in view (0: a canvas reader). */
vi.mock('../../src/reader/lineGeometry', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/reader/lineGeometry')>();
  return {
    ...mod,
    measureLines: (opts: MeasureOptions): LineLayout => {
      const v = opts.viewport;
      const lines: TextLine[] = [];
      for (let i = 0; i < text.above + text.lines; i++) {
        // text.above lines sit just above the view (measured in its margin), then text.lines in it.
        const top = v.top + 20 + (i - text.above) * 30;
        lines.push({ index: i, top, bottom: top + 22, left: 200, right: 800, centerY: top + 11, docTop: top - v.top + opts.scrollTop, charCount: 70, fullyVisible: top >= v.top });
      }
      return {
        lines,
        viewport: v,
        column: { left: 200, right: 800, top: v.top, bottom: v.bottom },
        linePitch: 30,
        scrollTop: opts.scrollTop,
        scrollHeight: opts.scrollHeight,
        clientHeight: opts.clientHeight,
        measuredAt: 0,
      };
    },
  };
});

function record<K extends EventName>(type: K): AppEvents[K][] {
  const seen: AppEvents[K][] = [];
  buses.at(-1)!.on(type, (p) => seen.push(p));
  return seen;
}

function setup(settings: Partial<AppSettings> = {}, ext?: ExtSettings) {
  const storage = new FakeStorage();
  storage.data.set(KEYS.settings, { v: 1, settings: { ...DEFAULT_SETTINGS, gazeSource: 'mouse', ...settings }, origin: 'seed', seq: 1 });
  if (ext) storage.data.set(KEYS.extSettings, ext);
  const deps: PageSessionDeps = {
    storage,
    connectPort: () => portPair(PORT_TAB)[0],
    isContextValid: () => true,
    openSetup: () => undefined,
    onEnded: () => undefined,
  };
  return { storage, deps };
}

const PAGE_MODE_TEXT = /can't read the text on this page/;
const pointAt = (x: number, y: number) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
const altShift = (code: string) =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { code, altKey: true, shiftKey: true, bubbles: true, composed: true, cancelable: true }));

/** Records the key presses that reach the page. */
function pageKeys(): string[] {
  const seen: string[] = [];
  const onKey = (e: KeyboardEvent) => {
    if (!e.altKey) seen.push(`${e.type}:${e.key}`);
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKey);
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = '<main><canvas id="page"></canvas><p>Location 12 of 3400</p></main>';
  text.lines = 0;
  text.above = 0;
  resetPageModeNotice();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.querySelectorAll(HOST_TAG).forEach((el) => el.remove());
});

describe('PageSession page mode', () => {
  it('switches to page mode after ~2 s without text, says so once, and back when text appears', async () => {
    const t = setup();
    const session = await PageSession.start(t.deps);
    const said = record('buddy-say');
    const layouts = record('layout');

    await vi.advanceTimersByTimeAsync(1_100);
    expect(session.state().pageMode).toBe(false); // too soon: a page may still be loading its text
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.state().pageMode).toBe(true);
    expect(said.filter((s) => PAGE_MODE_TEXT.test(s.text))).toHaveLength(1);
    expect(said.find((s) => PAGE_MODE_TEXT.test(s.text))).toMatchObject({ priority: 'high' });
    expect(said.at(-1)!.text).toMatch(/Glance at the bottom edge/);
    const pseudo = layouts.at(-1)!;
    expect(pseudo.lines.length).toBeGreaterThan(10); // pseudo-lines tile the view
    expect(pseudo.lines.every((l) => l.fullyVisible)).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000); // stays in page mode without repeating itself
    expect(session.state().pageMode).toBe(true);
    expect(said.filter((s) => PAGE_MODE_TEXT.test(s.text))).toHaveLength(1);

    text.lines = 12; // the reader switched to a page with real text
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.state().pageMode).toBe(false);
    expect(layouts.at(-1)!.lines).toHaveLength(12);
    expect(layouts.at(-1)!.lines[0]!.left).toBe(200); // the measured lines, not pseudo ones

    // Measured text keeps it in text mode: no polling, no switch.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.state().pageMode).toBe(false);
    session.destroy();

    // Turned off and on again on the same page: page mode again, but Dewey has already explained it.
    text.lines = 0;
    const again = await PageSession.start(t.deps);
    const saidAgain = record('buddy-say');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(again.state().pageMode).toBe(true);
    expect(saidAgain.filter((s) => PAGE_MODE_TEXT.test(s.text))).toHaveLength(0);
    again.destroy();
  });

  it('never enters page mode while there is text to read', async () => {
    text.lines = 20;
    const t = setup();
    const session = await PageSession.start(t.deps);
    const said = record('buddy-say');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.state().pageMode).toBe(false);
    expect(said.filter((s) => PAGE_MODE_TEXT.test(s.text))).toHaveLength(0);
    session.destroy();
  });

  it('the end of an ordinary article (two lines left, text just above) is not page mode', async () => {
    text.above = 10;
    text.lines = 2;
    const t = setup();
    const session = await PageSession.start(t.deps);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(session.state().pageMode).toBe(false);
    session.destroy();
  });

  it('on a page that does not scroll, a glance below the page presses the next-page keys', async () => {
    const t = setup({ sensitivity: 'balanced', glanceDownToTurn: true });
    const session = await PageSession.start(t.deps);
    const turns = record('page-turn');
    const keys = pageKeys();
    pointAt(500, 300);
    await vi.advanceTimersByTimeAsync(4_000); // page mode, and past its cooldown
    expect(session.state().pageMode).toBe(true);
    expect(keys).toEqual([]);

    pointAt(500, 790); // below the 768 px window
    await vi.advanceTimersByTimeAsync(1_000);
    expect(keys).toEqual(['keydown:ArrowRight', 'keyup:ArrowRight', 'keydown:PageDown', 'keyup:PageDown']);
    expect(turns).toEqual([expect.objectContaining({ auto: true, reason: 'glance-down', pageIndex: 1 })]);

    // Parked below the page, it doesn't keep paging: the eyes must come back up first.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(turns).toHaveLength(1);
    pointAt(500, 300);
    await vi.advanceTimersByTimeAsync(3_000);
    pointAt(500, 790);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(turns).toHaveLength(2);

    // Alt+Shift+↑ goes back the same way.
    keys.length = 0;
    altShift('ArrowUp');
    expect(keys.filter((k) => k.startsWith('keydown'))).toEqual(['keydown:ArrowLeft', 'keydown:PageUp']);
    session.destroy();
  });

  it('"Scrolling" never sends keys, and "Next-page key" sends them even on a page with text', async () => {
    const t = setup({}, { pageTurn: 'scroll' });
    const session = await PageSession.start(t.deps);
    const keys = pageKeys();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(session.state().pageMode).toBe(true);
    altShift('ArrowDown');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(keys).toEqual([]);

    // The popup changes the setting live.
    await t.storage.area.set({ [KEYS.extSettings]: { pageTurn: 'keys' } });
    await flush();
    text.lines = 15;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.state().pageMode).toBe(false);
    altShift('ArrowDown');
    expect(keys.filter((k) => k.startsWith('keydown'))).toEqual(['keydown:ArrowRight', 'keydown:PageDown']);
    session.destroy();
  });

  it('auto: in page mode on a page that scrolls, a turn scrolls about a screen and presses no keys', async () => {
    // A viewer that draws its pages on canvases inside a scrolling box (not around any main text).
    document.body.innerHTML = '<header><p>Viewer</p></header><div id="app" style="overflow-y: auto"><canvas id="page"></canvas></div>';
    const app = document.getElementById('app')!;
    document.getElementById('page')!.getBoundingClientRect = () => DOMRect.fromRect({ x: 112, y: 0, width: 800, height: 1100 });
    let top = 0;
    Object.defineProperty(app, 'scrollHeight', { configurable: true, value: 8000 });
    Object.defineProperty(app, 'clientHeight', { configurable: true, value: 768 });
    Object.defineProperty(app, 'clientWidth', { configurable: true, value: 1024 });
    Object.defineProperty(app, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
    app.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 1024, height: 768 });
    app.scrollTo = ((opts: ScrollToOptions) => {
      top = opts.top ?? top;
    }) as typeof app.scrollTo;
    vi.stubGlobal('requestAnimationFrame', () => 1); // no frames in jsdom: the turn lands via its deadline
    vi.stubGlobal('cancelAnimationFrame', () => undefined);

    const t = setup({ scrollDurationMs: 300 });
    const session = await PageSession.start(t.deps);
    const keys = pageKeys();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(session.state().pageMode).toBe(true);
    altShift('ArrowDown');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(keys).toEqual([]);
    expect(top).toBeGreaterThan(0.75 * 768);
    expect(top).toBeLessThan(768);
    session.destroy();
  });
});
