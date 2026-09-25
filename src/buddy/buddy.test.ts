// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../core/events';
import { createSettingsStore, DEFAULT_SETTINGS } from '../core/settings';
import type { AppEvents, AppSettings, EventBus, EventName, LineLayout, TextLine } from '../types';
import {
  Buddy,
  bubbleMaxWidth,
  chattinessAllows,
  clampDrag,
  clampSpeech,
  DEDUPE_WINDOW_MS,
  nearestCorner,
  REMARK_GAP_MS,
  SLEEP_AFTER_MS,
  speechDurationMs,
  WORRY_AFTER_MS,
} from './buddy';
import { QUIPS } from './quips';

// ─────────────────────────────── pure helpers ────────────────────────────────

describe('chattinessAllows', () => {
  it('quiet = high only; normal = + normal; chatty = everything', () => {
    expect(['low', 'normal', 'high'].map((p) => chattinessAllows('quiet', p as never))).toEqual([false, false, true]);
    expect(['low', 'normal', 'high'].map((p) => chattinessAllows('normal', p as never))).toEqual([false, true, true]);
    expect(['low', 'normal', 'high'].map((p) => chattinessAllows('chatty', p as never))).toEqual([true, true, true]);
  });
});

describe('speechDurationMs / clampSpeech', () => {
  it('is 1.2 s + 55 ms per character, kept between 2 s and 9 s', () => {
    expect(speechDurationMs('x'.repeat(60))).toBe(1_200 + 55 * 60);
    expect(speechDurationMs('Hi!')).toBe(2_000);
    expect(speechDurationMs('x'.repeat(500))).toBe(9_000);
  });

  it('caps lines at 90 characters on a word boundary', () => {
    const long = 'The quick brown fox jumps over the lazy dog while reading a very long sentence about eye movements and saccades.';
    const out = clampSpeech(long);
    expect(Array.from(out).length).toBeLessThanOrEqual(90);
    expect(out.endsWith('…')).toBe(true);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    expect(out.at(-2)).not.toBe(' ');
    expect(clampSpeech('  hello \n  there ')).toBe('hello there');
    expect(clampSpeech('')).toBe('');
  });
});

describe('nearestCorner (drag snapping)', () => {
  const vp = { width: 1000, height: 800 };
  it('snaps to the corner of the quadrant the center is in', () => {
    expect(nearestCorner({ x: 100, y: 100 }, vp)).toBe('top-left');
    expect(nearestCorner({ x: 900, y: 100 }, vp)).toBe('top-right');
    expect(nearestCorner({ x: 100, y: 700 }, vp)).toBe('bottom-left');
    expect(nearestCorner({ x: 900, y: 700 }, vp)).toBe('bottom-right');
    // Exactly on the midlines → bottom / right (ties go away from the reading start).
    expect(nearestCorner({ x: 500, y: 400 }, vp)).toBe('bottom-right');
  });

  it('falls back for NaN positions and empty viewports', () => {
    expect(nearestCorner({ x: Number.NaN, y: 10 }, vp, 'top-left')).toBe('top-left');
    expect(nearestCorner({ x: 10, y: 10 }, { width: 0, height: 0 })).toBe('bottom-right');
  });
});

describe('clampDrag', () => {
  const base = { left: 870, top: 630, right: 990, bottom: 780 };
  it('keeps Dewey fully on screen', () => {
    expect(clampDrag(base, -2_000, -2_000, { width: 1000, height: 800 }, 4)).toEqual({ x: 4 - 870, y: 4 - 630 });
    expect(clampDrag(base, 500, 500, { width: 1000, height: 800 }, 4)).toEqual({ x: 1000 - 4 - 990, y: 800 - 4 - 780 });
    expect(clampDrag(base, -10, -20, { width: 1000, height: 800 })).toEqual({ x: -10, y: -20 });
  });
  it('treats garbage as no movement', () => {
    expect(clampDrag(base, Number.NaN, Number.POSITIVE_INFINITY, { width: 1000, height: 800 })).toEqual({ x: 0, y: 0 });
  });
});

describe('bubbleMaxWidth', () => {
  const anchorRight = { left: 1064, top: 600, right: 1184, bottom: 750 };
  it('uses the preferred width when there is room', () => {
    expect(bubbleMaxWidth({ corner: 'bottom-right', anchor: anchorRight, viewportWidth: 1200, columnCenterX: 600 })).toBe(260);
  });
  it('stops short of the reading column center', () => {
    const w = bubbleMaxWidth({ corner: 'bottom-right', anchor: { ...anchorRight, left: 580, right: 700 }, viewportWidth: 716, columnCenterX: 500 });
    expect(700 - w).toBeGreaterThanOrEqual(500 + 24);
    const anchorLeft = { left: 16, top: 600, right: 136, bottom: 750 };
    const wl = bubbleMaxWidth({ corner: 'top-left', anchor: anchorLeft, viewportWidth: 400, columnCenterX: 200 });
    expect(16 + wl).toBeLessThanOrEqual(200 - 24);
  });
  it('stays in a roomy margin instead of overlapping the text', () => {
    const base = { corner: 'bottom-right', anchor: anchorRight, viewportWidth: 1200, columnCenterX: 600 } as const;
    expect(bubbleMaxWidth({ ...base, columnEdgeX: 950 })).toBe(1184 - 958);
    // A cramped margin isn't worth a skinny bubble: overlap the text edge (never the center).
    expect(bubbleMaxWidth({ ...base, columnEdgeX: 1050 })).toBe(260);
  });

  it('never shrinks below a readable minimum and survives bad input', () => {
    expect(bubbleMaxWidth({ corner: 'bottom-right', anchor: anchorRight, viewportWidth: 1200, columnCenterX: 1170 })).toBe(120);
    expect(bubbleMaxWidth({ corner: 'bottom-left', anchor: { left: Number.NaN, top: 0, right: 0, bottom: 0 }, viewportWidth: 0, columnCenterX: null })).toBe(260);
  });
});

// ─────────────────────────────────── Buddy ───────────────────────────────────

type Setup = ReturnType<typeof setup>;

function textLines(): TextLine[] {
  return Array.from({ length: 12 }, (_, i) => ({
    index: i,
    top: 100 + i * 40,
    bottom: 130 + i * 40,
    left: 300,
    right: 900,
    centerY: 115 + i * 40,
    docTop: 100 + i * 40,
    charCount: 64,
    fullyVisible: true,
  }));
}

function makeLayout(): LineLayout {
  return {
    lines: textLines(),
    viewport: { left: 0, top: 0, right: 1024, bottom: 768 },
    column: { left: 300, top: 100, right: 900, bottom: 570 },
    linePitch: 40,
    scrollTop: 0,
    scrollHeight: 6_000,
    clientHeight: 768,
    measuredAt: 0,
  };
}

function setup(initial: Partial<AppSettings> = {}, random: () => number = () => 0.5) {
  const bus = createEventBus();
  const store = createSettingsStore(bus, { persist: false, initial: { ...DEFAULT_SETTINGS, ...initial } });
  const buddy = new Buddy({ bus, getSettings: store.get, random });
  const host = document.createElement('div');
  document.body.appendChild(host);
  buddy.mount(host);
  const root = host.querySelector<HTMLElement>('.gr-buddy');
  if (!root) throw new Error('Dewey did not mount');
  const q = <T extends Element>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`missing ${sel}`);
    return el;
  };
  const emitted: Array<{ type: EventName; payload: unknown }> = [];
  const record = <K extends EventName>(type: K) => bus.on(type, (payload: AppEvents[K]) => emitted.push({ type, payload }));
  record('command');
  record('settings-patch');
  record('buddy-poke');
  return {
    bus,
    store,
    buddy,
    host,
    root,
    q,
    emitted,
    /** Text in the visible bubble, or null when Dewey is quiet. */
    said: () => (q('.gr-buddy-bubble').classList.contains('gr-buddy-bubble--show') ? q('.gr-buddy-bubble-text').textContent : null),
    live: () => q('[role="status"]').textContent,
    mood: () => root.dataset.mood,
    btn: () => q<HTMLButtonElement>('.gr-buddy-btn'),
    pop: () => q<HTMLElement>('.gr-buddy-pop'),
    items: () => Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')),
  };
}

function gaze(bus: EventBus, x: number, y: number, valid = true): void {
  bus.emit('gaze', { t: performance.now(), x, y, rawX: x, rawY: y, valid, confidence: valid ? 0.9 : 0, source: 'webcam' });
}

/** Puts the reader in the middle of line 3. */
function readMidLine(s: Setup): void {
  s.bus.emit('layout', makeLayout());
  gaze(s.bus, 600, 235);
  s.bus.emit('line-estimate', {
    t: performance.now(),
    lineIndex: 3,
    probability: 0.9,
    posterior: [],
    progressX: 0.5,
    lastSaccade: 'forward',
    driftY: 0,
    fixationsOnPage: 12,
  });
}

/** Keeps the reader reading for `ms` (gaze + estimates every 100 ms). */
function keepReading(s: Setup, ms: number): void {
  for (let t = 0; t < ms; t += 100) {
    readMidLine(s);
    vi.advanceTimersByTime(100);
  }
}

function pointer(type: string, target: EventTarget, x: number, y: number, extra: PointerEventInit = {}): void {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, isPrimary: true, button: 0, clientX: x, clientY: y, ...extra }),
  );
}

describe('Buddy', () => {
  let active: Setup[] = [];
  const make = (...args: Parameters<typeof setup>): Setup => {
    const s = setup(...args);
    active.push(s);
    return s;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  afterEach(() => {
    for (const s of active) s.buddy.destroy();
    active = [];
    vi.useRealTimers();
  });

  describe('mounting', () => {
    it('renders an ignorable, accessible root with its own stylesheet', () => {
      const s = make();
      expect(s.root.hasAttribute('data-gr-ignore')).toBe(true);
      expect(s.root.classList.contains('gr-buddy--bottom-right')).toBe(true);
      expect(s.root.hidden).toBe(false);
      expect(s.btn().getAttribute('aria-haspopup')).toBe('menu');
      expect(s.btn().getAttribute('aria-label')).toMatch(/Dewey/);
      expect(s.q('[role="status"]').getAttribute('aria-live')).toBe('polite');
      expect(s.q('svg').getAttribute('aria-hidden')).toBe('true');
      expect(document.head.querySelectorAll('style[data-gr-style="buddy"]')).toHaveLength(1);
    });

    it('shares one stylesheet between buddies and removes it with the last one', () => {
      const a = make();
      const b = make();
      expect(document.head.querySelectorAll('style[data-gr-style="buddy"]')).toHaveLength(1);
      a.buddy.destroy();
      expect(document.head.querySelectorAll('style[data-gr-style="buddy"]')).toHaveLength(1);
      b.buddy.destroy();
      expect(document.head.querySelectorAll('style[data-gr-style="buddy"]')).toHaveLength(0);
    });

    it('mounts inside a shadow root with the styles scoped there', () => {
      const bus = createEventBus();
      const buddy = new Buddy({ bus, getSettings: () => DEFAULT_SETTINGS });
      const host = document.createElement('div');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      buddy.mount(shadow);
      expect(shadow.querySelector('.gr-buddy')).not.toBeNull();
      expect(shadow.querySelector('style[data-gr-style="buddy"]')).not.toBeNull();
      expect(document.head.querySelector('style[data-gr-style="buddy"]')).toBeNull();
      buddy.destroy();
      expect(shadow.childNodes).toHaveLength(0);
    });

    it('respects buddyCorner on mount and follows settings-changed', () => {
      const s = make({ buddyCorner: 'top-left' });
      expect(s.root.classList.contains('gr-buddy--top-left')).toBe(true);
      s.store.update({ buddyCorner: 'bottom-left' });
      expect(s.root.classList.contains('gr-buddy--bottom-left')).toBe(true);
      expect(s.root.classList.contains('gr-buddy--top-left')).toBe(false);
    });
  });

  describe('speech', () => {
    it('shows a line in the bubble and the live region, then auto-dismisses', () => {
      const s = make();
      const text = 'Reading is just very organized staring.';
      s.buddy.say(text);
      expect(s.said()).toBe(text);
      expect(s.live()).toBe(text);
      vi.advanceTimersByTime(speechDurationMs(text) - 10);
      expect(s.said()).toBe(text);
      vi.advanceTimersByTime(20);
      expect(s.said()).toBeNull();
      expect(s.live()).toBe('');
    });

    it('trims anything longer than 90 characters', () => {
      const s = make();
      s.buddy.say('word '.repeat(40));
      expect(Array.from(s.said() ?? '').length).toBeLessThanOrEqual(90);
    });

    it('quiet: only high priority gets through', () => {
      const s = make({ buddyChattiness: 'quiet' });
      s.buddy.say('low line', { priority: 'low' });
      s.buddy.say('normal line');
      vi.advanceTimersByTime(1_000);
      expect(s.said()).toBeNull();
      s.buddy.say('important line', { priority: 'high' });
      expect(s.said()).toBe('important line');
    });

    it('normal: drops low priority (fun facts), speaks normal', () => {
      const s = make({ buddyChattiness: 'normal' });
      s.buddy.say('a fun fact', { priority: 'low' });
      vi.advanceTimersByTime(1_000);
      expect(s.said()).toBeNull();
      s.buddy.say('a normal remark');
      expect(s.said()).toBe('a normal remark');
    });

    it('chatty: low priority is spoken too', () => {
      const s = make({ buddyChattiness: 'chatty' });
      s.buddy.say('a fun fact', { priority: 'low' });
      expect(s.said()).toBe('a fun fact');
    });

    it('drops queued lines that the new chattiness no longer allows', () => {
      const s = make({ buddyChattiness: 'chatty' });
      s.buddy.say('first', { priority: 'normal' });
      s.buddy.say('queued fact', { priority: 'low' });
      s.store.update({ buddyChattiness: 'normal' });
      vi.advanceTimersByTime(20_000);
      expect(s.said()).toBeNull();
    });

    it('does not repeat an identical line within two minutes', () => {
      const s = make();
      s.buddy.say('Same old line.');
      vi.advanceTimersByTime(10_000);
      s.buddy.say('Same old line.');
      expect(s.said()).toBeNull();
      vi.advanceTimersByTime(DEDUPE_WINDOW_MS);
      s.buddy.say('Same old line.');
      expect(s.said()).toBe('Same old line.');
    });

    it('lets the app repeat a high-priority line (status messages matter)', () => {
      const s = make();
      s.buddy.say('Auto-scroll paused.', { priority: 'high' });
      vi.advanceTimersByTime(10_000);
      s.buddy.say('Auto-scroll paused.', { priority: 'high' });
      expect(s.said()).toBe('Auto-scroll paused.');
    });

    it('high priority preempts lower priority at once; equal priority waits its turn', () => {
      const s = make({ buddyChattiness: 'chatty' });
      s.buddy.say('a leisurely fun fact', { priority: 'low' });
      expect(s.said()).toBe('a leisurely fun fact');
      s.buddy.say('URGENT', { priority: 'high' });
      expect(s.said()).toBe('URGENT');
      s.buddy.say('also urgent', { priority: 'high' });
      expect(s.said()).toBe('URGENT');
      vi.advanceTimersByTime(speechDurationMs('URGENT') + 400);
      expect(s.said()).toBe('also urgent');
      // The preempted low-priority line is not replayed later.
      vi.advanceTimersByTime(speechDurationMs('also urgent') + 400);
      expect(s.said()).toBeNull();
    });

    it('queues by priority: pending high lines go before pending normal ones', () => {
      const s = make();
      s.buddy.say('now showing');
      s.buddy.say('normal waiting');
      s.buddy.say('high waiting', { priority: 'high' });
      expect(s.said()).toBe('high waiting'); // high preempts the showing normal line
      vi.advanceTimersByTime(speechDurationMs('high waiting') + 400);
      expect(s.said()).toBe('normal waiting');
    });

    it('holds non-urgent lines while the reader is mid-line and releases them at the page turn', () => {
      const s = make();
      keepReading(s, 1_500);
      s.buddy.say('psst, a thought');
      expect(s.said()).toBeNull();
      keepReading(s, 3_000);
      expect(s.said()).toBeNull();
      s.bus.emit('page-turn', { from: 0, to: 700, auto: true, reason: 'line-tracker', pageIndex: 1 });
      vi.advanceTimersByTime(300);
      expect(s.said()).toBeNull(); // lets the scroll get going first
      vi.advanceTimersByTime(300);
      expect(s.said()).toBe('psst, a thought');
    });

    it('releases held lines at a pause (the reader looks away)', () => {
      const s = make();
      keepReading(s, 1_500);
      s.buddy.say('waiting for a pause');
      keepReading(s, 1_000);
      expect(s.said()).toBeNull();
      gaze(s.bus, 1010, 700); // glancing at Dewey, off the text column
      vi.advanceTimersByTime(900);
      expect(s.said()).toBe('waiting for a pause');
    });

    it('drops a held app line once it is stale instead of saying it much later (regression)', () => {
      const s = make();
      keepReading(s, 1_500);
      s.buddy.say('Paused. I’ll wait right here.');
      keepReading(s, 25_000);
      gaze(s.bus, 1010, 700); // a pause, long after the fact
      vi.advanceTimersByTime(2_000);
      expect(s.said()).toBeNull();
      // Dewey’s own remarks may still wait for a page turn.
      s.bus.emit('book-progress', { fraction: 0.1, wordsRead: 0, wpm: null, pagesTurned: 0, minutesReading: 1 });
      keepReading(s, 1_500);
      s.bus.emit('book-progress', { fraction: 0.3, wordsRead: 0, wpm: null, pagesTurned: 0, minutesReading: 2 });
      keepReading(s, 25_000);
      expect(s.said()).toBeNull();
      s.bus.emit('page-turn', { from: 0, to: 700, auto: true, reason: 'line-tracker', pageIndex: 1 });
      vi.advanceTimersByTime(600);
      expect(QUIPS.milestone25).toContain(s.said());
    });

    it('speaks high priority even mid-line', () => {
      const s = make();
      keepReading(s, 1_500);
      s.buddy.say('look up!', { priority: 'high' });
      expect(s.said()).toBe('look up!');
    });

    it('allows at most one unprompted remark per 45 s', () => {
      const s = make();
      s.bus.emit('book-progress', { fraction: 0.1, wordsRead: 0, wpm: null, pagesTurned: 0, minutesReading: 1 });
      s.bus.emit('book-progress', { fraction: 0.3, wordsRead: 0, wpm: null, pagesTurned: 1, minutesReading: 2 });
      const first = s.said();
      expect(QUIPS.milestone25).toContain(first);
      vi.advanceTimersByTime(10_000);
      expect(s.said()).toBeNull();
      s.bus.emit('book-progress', { fraction: 0.55, wordsRead: 0, wpm: null, pagesTurned: 2, minutesReading: 3 });
      vi.advanceTimersByTime(REMARK_GAP_MS - 10_000 - 1_000);
      expect(s.said()).toBeNull();
      vi.advanceTimersByTime(2_000);
      expect(QUIPS.milestone50).toContain(s.said());
    });

    it('does not announce milestones already passed when a book is resumed', () => {
      const s = make();
      s.bus.emit('book-opened', { id: 'b', title: 'A Book', author: null, wordCount: 1000, resumed: true });
      vi.advanceTimersByTime(10_000);
      s.bus.emit('book-progress', { fraction: 0.6, wordsRead: 0, wpm: null, pagesTurned: 0, minutesReading: 0 });
      s.bus.emit('book-progress', { fraction: 0.62, wordsRead: 0, wpm: null, pagesTurned: 1, minutesReading: 1 });
      vi.advanceTimersByTime(1_000);
      expect(s.said()).toBeNull();
    });

    it('saves the milestone applause once the book is finished (regression)', () => {
      const s = make();
      s.bus.emit('book-progress', { fraction: 0.6, wordsRead: 0, wpm: null, pagesTurned: 8, minutesReading: 30 });
      s.bus.emit('book-finished', { title: 'Done', minutesReading: 31, pagesTurned: 12 });
      expect(QUIPS.bookFinished).toContain(s.said());
      vi.advanceTimersByTime(10_000);
      // The last progress report trails in after the finale (it crosses 75 % and 10 pages).
      s.bus.emit('book-progress', { fraction: 1, wordsRead: 0, wpm: null, pagesTurned: 12, minutesReading: 31 });
      for (let t = 0; t < 60_000; t += 250) {
        expect(s.said()).toBeNull();
        vi.advanceTimersByTime(250);
      }
      // A new book starts the milestones over.
      s.bus.emit('book-opened', { id: 'n', title: 'Next', author: null, wordCount: 10, resumed: false });
      vi.advanceTimersByTime(10_000);
      s.bus.emit('book-progress', { fraction: 0, wordsRead: 0, wpm: null, pagesTurned: 0, minutesReading: 0 });
      s.bus.emit('book-progress', { fraction: 0.3, wordsRead: 0, wpm: null, pagesTurned: 1, minutesReading: 1 });
      expect(QUIPS.milestone25).toContain(s.said());
    });

    it('celebrates every ten pages', () => {
      const s = make();
      s.bus.emit('book-progress', { fraction: 0.01, wordsRead: 0, wpm: null, pagesTurned: 3, minutesReading: 1 });
      s.bus.emit('book-progress', { fraction: 0.02, wordsRead: 0, wpm: null, pagesTurned: 10, minutesReading: 2 });
      const line = s.said() ?? '';
      expect(line).toContain('10');
      expect(QUIPS.tenPages.map((l) => l.replace('{pages}', '10'))).toContain(line);
    });

    it('greets a newly opened book, using its title when a line calls for it', () => {
      const s = make();
      s.bus.emit('book-opened', { id: 'x', title: 'The Very Long Title Of A Book About Eyes', author: null, wordCount: 5, resumed: false });
      const line = s.said() ?? '';
      const templates = QUIPS.greeting.map((l) => l.replace('{title}', 'The Very Long Title Of A…'));
      expect(templates).toContain(line);
      expect(s.mood()).toBe('happy');
    });

    it('gives the 20-20-20 tip on break-due unless reminders are off', () => {
      const s = make({ buddyChattiness: 'quiet' });
      s.bus.emit('break-due', { minutesReading: 20 });
      const tip = s.said() ?? '';
      expect(QUIPS.break).toContain(tip);
      expect(tip).toMatch(/20/);
      expect(tip).toMatch(/6 m|20 f(ee)?t/);

      const off = make({ breakReminders: false });
      off.bus.emit('break-due', { minutesReading: 20 });
      expect(off.said()).toBeNull();
    });

    it('answers buddy-say from the bus', () => {
      const s = make();
      s.bus.emit('buddy-say', { text: 'Hello from the app', priority: 'high', mood: 'excited' });
      expect(s.said()).toBe('Hello from the app');
      expect(s.mood()).toBe('excited');
    });

    it('keeps a line up while it is hovered', () => {
      const s = make();
      s.buddy.say('hover me');
      const bubble = s.q('.gr-buddy-bubble');
      bubble.dispatchEvent(new PointerEvent('pointerenter'));
      vi.advanceTimersByTime(30_000);
      expect(s.said()).toBe('hover me');
      bubble.dispatchEvent(new PointerEvent('pointerleave'));
      vi.advanceTimersByTime(3_000);
      expect(s.said()).toBeNull();
    });

    it('queues speech said before mount and speaks it once mounted', () => {
      const bus = createEventBus();
      const buddy = new Buddy({ bus, getSettings: () => DEFAULT_SETTINGS });
      buddy.say('early bird');
      const host = document.createElement('div');
      document.body.appendChild(host);
      buddy.mount(host);
      expect(host.querySelector('.gr-buddy-bubble-text')?.textContent).toBe('early bird');
      buddy.destroy();
    });
  });

  describe('moods', () => {
    it('reads along while gaze is valid, idles when it goes away', () => {
      const s = make();
      expect(s.mood()).toBe('idle');
      gaze(s.bus, 500, 300);
      expect(s.mood()).toBe('reading');
      vi.advanceTimersByTime(1_600);
      expect(s.mood()).toBe('idle');
    });

    it('no-face for 3 s → worried, says "I can’t see you…" once per episode, relieved when back', () => {
      const s = make();
      s.bus.emit('tracking-state', { state: 'tracking' });
      s.bus.emit('tracking-state', { state: 'no-face' });
      vi.advanceTimersByTime(WORRY_AFTER_MS - 50);
      expect(s.mood()).not.toBe('worried');
      vi.advanceTimersByTime(100);
      expect(s.mood()).toBe('worried');
      const lost = s.said();
      expect(QUIPS.trackingLost).toContain(lost);

      // A flicker (face found for a moment, lost again) is the same episode: no repeat.
      vi.advanceTimersByTime(8_000);
      s.bus.emit('tracking-state', { state: 'tracking' });
      vi.advanceTimersByTime(300);
      s.bus.emit('tracking-state', { state: 'no-face' });
      vi.advanceTimersByTime(10_000);
      expect(s.said()).toBeNull();
      expect(s.mood()).toBe('worried');

      s.bus.emit('tracking-state', { state: 'tracking' });
      vi.advanceTimersByTime(1_300);
      expect(s.mood()).toBe('happy');
      expect(QUIPS.trackingBack).toContain(s.said());

      // A new episode may worry out loud again.
      vi.advanceTimersByTime(5_000);
      s.bus.emit('tracking-state', { state: 'no-face' });
      vi.advanceTimersByTime(WORRY_AFTER_MS + 10);
      expect(QUIPS.trackingLost).toContain(s.said());
    });

    it('does not fuss when tracking is paused on purpose', () => {
      const s = make();
      s.bus.emit('tracking-state', { state: 'no-face' });
      vi.advanceTimersByTime(1_000);
      s.bus.emit('tracking-state', { state: 'paused' });
      vi.advanceTimersByTime(10_000);
      expect(s.mood()).not.toBe('worried');
      expect(s.said()).toBeNull();
    });

    it('gets sleepy after 60 s without valid gaze, and wakes when the reader is back', () => {
      const s = make();
      gaze(s.bus, 500, 300);
      vi.advanceTimersByTime(SLEEP_AFTER_MS - 1_000);
      gaze(s.bus, 500, 300, false);
      expect(s.mood()).not.toBe('sleepy');
      vi.advanceTimersByTime(1_100);
      expect(s.mood()).toBe('sleepy');
      gaze(s.bus, 500, 300);
      expect(QUIPS.wakeUp).toContain(s.said());
      expect(s.mood()).toBe('excited'); // startled awake…
      vi.advanceTimersByTime(10_000);
      gaze(s.bus, 500, 300);
      expect(s.mood()).toBe('reading'); // …then back to reading along
    });

    it('wakes up to speak instead of talking in his sleep (regression)', () => {
      const s = make();
      vi.advanceTimersByTime(SLEEP_AFTER_MS + 1_000);
      expect(s.mood()).toBe('sleepy');
      s.bus.emit('buddy-say', { text: 'Your window changed size.', priority: 'high' });
      expect(s.said()).toBe('Your window changed size.');
      expect(s.mood()).not.toBe('sleepy');
      // He dozes off again only after another quiet minute.
      vi.advanceTimersByTime(SLEEP_AFTER_MS - 5_000);
      expect(s.mood()).not.toBe('sleepy');
      vi.advanceTimersByTime(6_000);
      expect(s.mood()).toBe('sleepy');
    });

    it('celebrates when the book is finished (with confetti) and settles down after', () => {
      const s = make();
      s.bus.emit('book-finished', { title: 'Done', minutesReading: 90, pagesTurned: 120 });
      expect(s.mood()).toBe('celebrating');
      expect(s.root.querySelectorAll('.gr-buddy-confetti').length).toBeGreaterThan(0);
      expect(QUIPS.bookFinished).toContain(s.said());
      vi.advanceTimersByTime(10_000);
      expect(s.mood()).not.toBe('celebrating');
      expect(s.root.querySelectorAll('.gr-buddy-confetti')).toHaveLength(0);
    });

    it('setMood holds a mood for a while, then returns to the situation', () => {
      const s = make();
      s.buddy.setMood('thinking', 2_000);
      expect(s.mood()).toBe('thinking');
      vi.advanceTimersByTime(2_100);
      expect(s.mood()).toBe('idle');
      s.buddy.setMood('excited', Number.POSITIVE_INFINITY);
      vi.advanceTimersByTime(600_000);
      expect(s.mood()).toBe('excited');
      // Nobody has been around for ten minutes, so "the situation" is a nap.
      s.buddy.setMood('idle', 0);
      expect(s.mood()).toBe('sleepy');
    });

    it('a held mood survives a spoken line with another mood and comes back after it (regression)', () => {
      const s = make();
      s.buddy.setMood('thinking', Number.POSITIVE_INFINITY);
      s.buddy.say('Eureka!', { priority: 'high', mood: 'excited' });
      expect(s.mood()).toBe('excited'); // the reaction plays over the hold…
      vi.advanceTimersByTime(speechDurationMs('Eureka!') + 100);
      expect(s.said()).toBeNull();
      expect(s.mood()).toBe('thinking'); // …and the hold returns (it used to be lost)
      s.bus.emit('book-opened', { id: 'b', title: 'T', author: null, wordCount: 10, resumed: false });
      vi.advanceTimersByTime(30_000);
      expect(s.mood()).toBe('thinking');
      s.buddy.setMood('idle', 0);
      expect(s.mood()).not.toBe('thinking');
    });

    it('setMood shows at once even while a spoken line has a mood of its own', () => {
      const s = make();
      s.buddy.say('Hello there, reader!', { priority: 'high', mood: 'happy' });
      expect(s.mood()).toBe('happy');
      s.buddy.setMood('worried', 2_000);
      expect(s.mood()).toBe('worried');
      vi.advanceTimersByTime(2_100);
      expect(s.mood()).not.toBe('worried');
    });

    it('coaches through calibration and steps behind the overlay while targets show', () => {
      const s = make();
      s.bus.emit('calibration', { phase: 'start' });
      expect(s.root.classList.contains('gr-buddy--above')).toBe(true);
      expect(QUIPS.calibrationStart).toContain(s.said());
      s.bus.emit('calibration', { phase: 'point', index: 0, total: 13 });
      expect(s.root.classList.contains('gr-buddy--above')).toBe(false);
      expect(QUIPS.calibrationPoint).toContain(s.said()); // stale coaching was replaced
      s.bus.emit('calibration', {
        phase: 'done',
        report: { meanErrorPx: 40, meanErrorXPx: 30, meanErrorYPx: 30, perPoint: [], lambda: 1, sampleCount: 300, quality: 'good' },
      });
      expect(QUIPS.calibrationGood).toContain(s.said());
      expect(s.mood()).toBe('excited');
    });

    it('does not hold calibration coaching as if the reader were mid-line (regression)', () => {
      const s = make();
      // A recalibration: the old model still yields valid gaze on the text column.
      keepReading(s, 1_500);
      s.bus.emit('calibration', { phase: 'start' });
      expect(QUIPS.calibrationStart).toContain(s.said());
      vi.advanceTimersByTime(9_000);
      keepReading(s, 1_500);
      s.bus.emit('calibration', { phase: 'positioning' });
      expect(QUIPS.calibrationPositioning).toContain(s.said());
    });

    it('gives the dot tip once, not again when the first dot is retried, paused or resumed (regression)', () => {
      const s = make();
      s.bus.emit('calibration', { phase: 'point', index: 0, total: 13 });
      const tip = s.said();
      expect(QUIPS.calibrationPoint).toContain(tip);
      vi.advanceTimersByTime(10_000);
      expect(s.said()).toBeNull();
      for (const message of ['face-lost', 'resumed', 'retry']) {
        s.bus.emit('calibration', { phase: 'point', index: 0, total: 13, message });
        expect(s.said(), message).toBeNull();
      }
    });

    it('steps back down if calibration ends without its closing event (regression)', () => {
      const s = make();
      s.bus.emit('tracking-state', { state: 'calibrating' });
      s.bus.emit('calibration', { phase: 'start' });
      s.bus.emit('calibration', { phase: 'positioning' });
      expect(s.root.classList.contains('gr-buddy--above')).toBe(true);
      s.bus.emit('tracking-state', { state: 'tracking' });
      expect(s.root.classList.contains('gr-buddy--above')).toBe(false);
      expect(s.mood()).not.toBe('happy');
    });

    it('stays quiet about "there you are" when the worried line could not be said (regression)', () => {
      const s = make();
      /** One lost-face episode; it ends either quietly (tracking paused) or with the face found again. */
      const episode = (end: 'paused' | 'tracking'): { lost: string | null; back: string | null } => {
        s.bus.emit('tracking-state', { state: 'no-face' });
        vi.advanceTimersByTime(WORRY_AFTER_MS + 10);
        const lost = s.said();
        vi.advanceTimersByTime(5_000);
        s.bus.emit('tracking-state', { state: end });
        vi.advanceTimersByTime(1_300);
        const back = s.said();
        s.bus.emit('tracking-state', { state: 'tracking' });
        vi.advanceTimersByTime(3_000);
        return { lost, back };
      };
      const n = QUIPS.trackingLost?.length ?? 0;
      for (let i = 0; i < n; i++) {
        const { lost, back } = episode('paused');
        expect(QUIPS.trackingLost).toContain(lost);
        expect(back).toBeNull(); // paused on purpose: no fuss
      }
      // Every worried line was said in the last two minutes, so this episode is silent…
      const { lost, back } = episode('tracking');
      expect(lost).toBeNull();
      // …and a cheery "found you!" answering nothing would make no sense.
      expect(back).toBeNull();
    });
  });

  describe('book & eyes', () => {
    it('flips the tiny book on page-turn and sometimes reacts', () => {
      const s = make({}, () => 0);
      s.bus.emit('page-turn', { from: 0, to: 700, auto: true, reason: 'line-tracker', pageIndex: 1 });
      expect(s.root.classList.contains('gr-buddy--flip')).toBe(true);
      vi.advanceTimersByTime(500);
      expect(QUIPS.pageTurn).toContain(s.said());
      vi.advanceTimersByTime(200);
      expect(s.root.classList.contains('gr-buddy--flip')).toBe(false);
      s.bus.emit('page-turn-undone', { from: 700, to: 0 });
      expect(s.root.classList.contains('gr-buddy--flip-back')).toBe(true);
    });

    it('pupils follow the gaze, never travel more than ~3 px, and drift home when it goes away', () => {
      const s = make();
      const pupil = s.q('.gr-buddy-pupil');
      const pos = () => (pupil.getAttribute('transform') ?? '').match(/translate\(([-\d.]+) ([-\d.]+)\)/)?.slice(1).map(Number) ?? [];
      const [x0, y0] = pos();
      gaze(s.bus, 5_000, 0); // jsdom has no layout: eye centers sit at (0, 0)
      vi.advanceTimersByTime(500);
      const [x1 = 0, y1 = 0] = pos();
      expect(x1 - (x0 ?? 0)).toBeGreaterThan(2);
      expect(Math.hypot(x1 - (x0 ?? 0), y1 - (y0 ?? 0))).toBeLessThanOrEqual(3.001);
      gaze(s.bus, 5_000, 0, false);
      vi.advanceTimersByTime(600);
      gaze(s.bus, 5_000, 0, false);
      vi.advanceTimersByTime(500);
      const [x2 = 0] = pos();
      expect(Math.abs(x2 - (x0 ?? 0))).toBeLessThan(0.5);
    });

    it('drifts home within ~0.5 s when the gaze stream simply stops', () => {
      const s = make();
      const pupil = s.q('.gr-buddy-pupil');
      const x = () => Number((pupil.getAttribute('transform') ?? '').match(/translate\(([-\d.]+)/)?.[1]);
      const home = x();
      for (let i = 0; i < 10; i++) {
        gaze(s.bus, 5_000, 0);
        vi.advanceTimersByTime(30);
      }
      expect(x()).toBeGreaterThan(home + 2);
      vi.advanceTimersByTime(900); // no more samples at all
      expect(Math.abs(x() - home)).toBeLessThan(0.3);
    });

    it('lookAt overrides gaze following until cleared', () => {
      const s = make();
      const pupil = s.q('.gr-buddy-pupil');
      const x = () => Number((pupil.getAttribute('transform') ?? '').match(/translate\(([-\d.]+)/)?.[1]);
      const home = x();
      s.buddy.lookAt({ x: -4_000, y: 0 });
      vi.advanceTimersByTime(400);
      expect(x()).toBeLessThan(home - 2);
      s.buddy.lookAt(null);
      vi.advanceTimersByTime(600);
      expect(Math.abs(x() - home)).toBeLessThan(0.5);
    });
  });

  describe('visibility', () => {
    it('hides on settings-changed buddyEnabled=false, stays silent, and comes back with a hello', () => {
      const s = make();
      s.store.update({ buddyEnabled: false });
      expect(s.root.hidden).toBe(true);
      s.buddy.say('anyone there?', { priority: 'high' });
      expect(s.said()).toBeNull();
      s.store.update({ buddyEnabled: true });
      expect(s.root.hidden).toBe(false);
      expect(QUIPS.unhide).toContain(s.said());
    });

    it('starts hidden when buddyEnabled is false', () => {
      const s = make({ buddyEnabled: false });
      expect(s.root.hidden).toBe(true);
    });
  });

  describe('menu', () => {
    it('opens on click as an accessible menu, focuses the first item and pokes', () => {
      const s = make();
      s.btn().click();
      expect(s.pop().hidden).toBe(false);
      expect(s.q('[role="menu"]')).toBeTruthy();
      expect(s.btn().getAttribute('aria-expanded')).toBe('true');
      const items = s.items();
      expect(items.map((b) => b.textContent)).toEqual([
        'Pause auto-scroll',
        'Recalibrate',
        'Tell me a fun fact',
        'Settings',
        'Hide Dewey',
      ]);
      expect(document.activeElement).toBe(items[0]);
      expect(s.emitted.some((e) => e.type === 'buddy-poke')).toBe(true);
      expect(s.q('.gr-buddy-pop-say').textContent?.length).toBeGreaterThan(0);
    });

    it('moves with arrow keys (wrapping), Home/End, and closes on Escape', () => {
      const s = make();
      s.btn().click();
      const items = s.items();
      const key = (k: string) => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      key('ArrowDown');
      expect(document.activeElement).toBe(items[1]);
      key('ArrowUp');
      key('ArrowUp');
      expect(document.activeElement).toBe(items[items.length - 1]);
      key('Home');
      expect(document.activeElement).toBe(items[0]);
      key('End');
      expect(document.activeElement).toBe(items[items.length - 1]);
      key('t'); // type-ahead
      expect(document.activeElement).toBe(items[2]);
      key('Escape');
      expect(s.pop().hidden).toBe(true);
      expect(document.activeElement).toBe(s.btn());
      expect(s.btn().getAttribute('aria-expanded')).toBe('false');
    });

    it('opens from the keyboard with ArrowUp focusing the last item', () => {
      const s = make();
      s.btn().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      expect(s.pop().hidden).toBe(false);
      expect(document.activeElement).toBe(s.items().at(-1));
    });

    it('keeps menu keystrokes away from the app’s global shortcuts', () => {
      const s = make();
      const seen: string[] = [];
      document.addEventListener('keydown', (e) => seen.push(e.key));
      s.btn().click();
      for (const k of ['ArrowDown', 'p', ' ', 'Escape']) {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      }
      expect(seen).toEqual([]);
    });

    it('labels the auto-scroll item from settings and emits commands', () => {
      const s = make();
      s.btn().click();
      s.items()[0]?.click();
      expect(s.emitted).toContainEqual({ type: 'command', payload: { name: 'toggle-autoscroll' } });
      expect(s.pop().hidden).toBe(true);

      s.store.update({ autoScroll: false });
      s.btn().click();
      expect(s.items()[0]?.textContent).toBe('Resume auto-scroll');
      s.items()[1]?.click();
      expect(s.emitted).toContainEqual({ type: 'command', payload: { name: 'recalibrate' } });
      s.btn().click();
      s.items()[3]?.click();
      expect(s.emitted).toContainEqual({ type: 'command', payload: { name: 'open-settings' } });
    });

    it('tells a fun fact on request, even when quiet', () => {
      const s = make({ buddyChattiness: 'quiet' });
      s.btn().click();
      s.items()[2]?.click();
      expect(QUIPS.funFacts).toContain(s.said());
    });

    it('Hide Dewey emits settings-patch buddyEnabled=false and hides', () => {
      const s = make();
      s.btn().click();
      s.items()[4]?.click();
      expect(s.emitted).toContainEqual({ type: 'settings-patch', payload: { buddyEnabled: false } });
      expect(s.store.get().buddyEnabled).toBe(false);
      expect(s.root.hidden).toBe(true);
    });

    it('closes when the reader presses outside', () => {
      const s = make();
      s.btn().click();
      pointer('pointerdown', s.q('.gr-buddy-pop'), 900, 600);
      expect(s.pop().hidden).toBe(false);
      pointer('pointerdown', document.body, 10, 10);
      expect(s.pop().hidden).toBe(true);
    });

    it('Tab closes the menu and lets focus move on from Dewey (menu-button pattern)', () => {
      const s = make();
      s.btn().click();
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(tab);
      expect(s.pop().hidden).toBe(true);
      expect(document.activeElement).toBe(s.btn());
      expect(tab.defaultPrevented).toBe(false);
    });

    it('holds speech while open and resumes after', () => {
      const s = make();
      s.btn().click();
      s.buddy.say('after the menu');
      expect(s.said()).toBeNull();
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      vi.advanceTimersByTime(400);
      expect(s.said()).toBe('after the menu');
    });
  });

  describe('dragging', () => {
    const rect = (left: number, top: number) =>
      ({ left, top, right: left + 120, bottom: top + 150, width: 120, height: 150, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

    it('a press that moves < 5 px is a click; farther is a drag that snaps to the nearest corner', () => {
      const s = make();
      vi.spyOn(s.root, 'getBoundingClientRect').mockReturnValue(rect(1024 - 16 - 120, 768 - 16 - 150));
      const char = s.q('.gr-buddy-char');
      pointer('pointerdown', char, 950, 680);
      pointer('pointermove', char, 953, 683);
      expect(s.root.classList.contains('gr-buddy--dragging')).toBe(false);
      pointer('pointermove', char, 120, 90);
      expect(s.root.classList.contains('gr-buddy--dragging')).toBe(true);
      expect(s.root.style.transform).toMatch(/translate3d/);
      pointer('pointerup', char, 120, 90);
      s.btn().click(); // the click that trails a drag must not open the menu
      expect(s.pop().hidden).toBe(true);
      expect(s.root.classList.contains('gr-buddy--dragging')).toBe(false);
      expect(s.emitted).toContainEqual({ type: 'settings-patch', payload: { buddyCorner: 'top-left' } });
      expect(s.store.get().buddyCorner).toBe('top-left');
      expect(s.root.classList.contains('gr-buddy--top-left')).toBe(true);
      expect(s.root.style.transform).toBe('');
    });

    it('a small wobble still counts as a click', () => {
      const s = make();
      vi.spyOn(s.root, 'getBoundingClientRect').mockReturnValue(rect(888, 602));
      const char = s.q('.gr-buddy-char');
      pointer('pointerdown', char, 950, 680);
      pointer('pointermove', char, 952, 679);
      pointer('pointerup', char, 952, 679);
      s.btn().click();
      expect(s.pop().hidden).toBe(false);
      expect(s.emitted.some((e) => e.type === 'settings-patch')).toBe(false);
    });

    it('still sees the release when the host page stops its propagation (regression)', () => {
      const s = make();
      vi.spyOn(s.root, 'getBoundingClientRect').mockReturnValue(rect(888, 602));
      const swallow = (e: Event) => e.stopPropagation();
      document.addEventListener('pointerup', swallow);
      try {
        const char = s.q('.gr-buddy-char');
        pointer('pointerdown', char, 950, 680);
        pointer('pointermove', char, 120, 90);
        pointer('pointerup', char, 120, 90);
        expect(s.root.classList.contains('gr-buddy--dragging')).toBe(false);
        expect(s.store.get().buddyCorner).toBe('top-left');
      } finally {
        document.removeEventListener('pointerup', swallow);
      }
    });

    it('a mouse release it never saw ends the drag instead of gluing Dewey to the cursor (regression)', () => {
      const s = make();
      vi.spyOn(s.root, 'getBoundingClientRect').mockReturnValue(rect(888, 602));
      const mouse = (buttons: number): PointerEventInit => ({ pointerType: 'mouse', buttons });
      const char = s.q('.gr-buddy-char');
      pointer('pointerdown', char, 950, 680, mouse(1));
      pointer('pointermove', document.body, 120, 90, mouse(1));
      expect(s.root.classList.contains('gr-buddy--dragging')).toBe(true);
      // The button came up outside the window; the next move has no button pressed.
      pointer('pointermove', document.body, 300, 500, mouse(0));
      expect(s.root.classList.contains('gr-buddy--dragging')).toBe(false);
      expect(s.store.get().buddyCorner).toBe('top-left');
      pointer('pointermove', document.body, 900, 700, mouse(0));
      expect(s.root.style.transform).toBe('');
      expect(s.root.classList.contains('gr-buddy--top-left')).toBe(true);
    });

    it('a new press settles a drag whose release was lost, then drags normally (regression)', () => {
      const s = make();
      vi.spyOn(s.root, 'getBoundingClientRect').mockReturnValue(rect(888, 602));
      const char = s.q('.gr-buddy-char');
      pointer('pointerdown', char, 950, 680);
      pointer('pointermove', char, 120, 90);
      expect(s.root.classList.contains('gr-buddy--dragging')).toBe(true);
      // No pointerup ever arrives. Before the fix, Dewey ignored every later press.
      pointer('pointerdown', char, 950, 680);
      expect(s.root.classList.contains('gr-buddy--dragging')).toBe(false);
      expect(s.root.style.transform).toBe('');
      expect(s.emitted.some((e) => e.type === 'settings-patch')).toBe(false);
      pointer('pointermove', char, 100, 700);
      pointer('pointerup', char, 100, 700);
      expect(s.store.get().buddyCorner).toBe('bottom-left');
    });

    it('hidden mid-drag, he comes back in his corner rather than where the drag left him (regression)', () => {
      const s = make();
      vi.spyOn(s.root, 'getBoundingClientRect').mockReturnValue(rect(888, 602));
      const char = s.q('.gr-buddy-char');
      pointer('pointerdown', char, 950, 680);
      pointer('pointermove', char, 500, 300);
      expect(s.root.style.transform).toMatch(/translate3d/);
      s.store.update({ buddyEnabled: false });
      s.store.update({ buddyEnabled: true });
      expect(s.root.hidden).toBe(false);
      expect(s.root.style.transform).toBe('');
      expect(s.root.classList.contains('gr-buddy--dragging')).toBe(false);
      expect(s.store.get().buddyCorner).toBe('bottom-right');
    });

    it('dropping in the same corner does not patch settings', () => {
      const s = make();
      vi.spyOn(s.root, 'getBoundingClientRect').mockReturnValue(rect(888, 602));
      const char = s.q('.gr-buddy-char');
      pointer('pointerdown', char, 950, 680);
      pointer('pointermove', char, 900, 640);
      pointer('pointerup', char, 900, 640);
      expect(s.emitted.some((e) => e.type === 'settings-patch')).toBe(false);
      expect(s.root.classList.contains('gr-buddy--bottom-right')).toBe(true);
    });
  });

  describe('destroy', () => {
    it('removes DOM, styles, every listener and every timer', () => {
      const add = vi.spyOn(window, 'addEventListener');
      const remove = vi.spyOn(window, 'removeEventListener');
      // jsdom's focus() leaves a timer of its own behind; keep the count about Dewey's.
      const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => undefined);
      const s = setup();
      // Exercise the paths that attach window listeners and timers.
      s.btn().click();
      pointer('pointerdown', s.q('.gr-buddy-char'), 950, 680);
      s.buddy.say('bye soon', { priority: 'high' });
      gaze(s.bus, 400, 300);
      s.bus.emit('tracking-state', { state: 'no-face' });
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      s.buddy.destroy();
      expect(document.querySelector('.gr-buddy')).toBeNull();
      expect(document.querySelectorAll('style[data-gr-style="buddy"]')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      // A listener only goes away when it is removed with the same capture flag it was added with.
      const capture = (o: boolean | AddEventListenerOptions | EventListenerOptions | undefined) =>
        o === true || (typeof o === 'object' && o.capture === true);
      const key = ([type, fn, o]: readonly [string, unknown, (boolean | AddEventListenerOptions)?]) =>
        `${type}:${String(fn)}:${capture(o)}`;
      const added = add.mock.calls.map(key);
      const removed = new Set(remove.mock.calls.map(key));
      expect(added.some((a) => a.startsWith('pointerup:') && a.endsWith(':true'))).toBe(true);
      for (const a of added) expect(removed.has(a), a).toBe(true);

      // The bus no longer reaches Dewey.
      s.bus.emit('buddy-say', { text: 'hello?', priority: 'high' });
      s.bus.emit('gaze', { t: 0, x: 1, y: 1, rawX: 1, rawY: 1, valid: true, confidence: 1, source: 'mouse' });
      s.bus.emit('book-finished', { title: 't', minutesReading: 1, pagesTurned: 1 });
      s.bus.emit('settings-changed', { settings: { ...DEFAULT_SETTINGS }, changed: ['buddyCorner'] });
      expect(vi.getTimerCount()).toBe(0);
      expect(document.querySelector('.gr-buddy')).toBeNull();
      expect(() => s.buddy.destroy()).not.toThrow();
      add.mockRestore();
      remove.mockRestore();
      focus.mockRestore();
    });

    it('is safe to call without mounting, and methods are no-ops afterwards', () => {
      const bus = createEventBus();
      const buddy = new Buddy({ bus, getSettings: () => DEFAULT_SETTINGS });
      buddy.destroy();
      expect(() => {
        buddy.say('x');
        buddy.setMood('happy');
        buddy.lookAt({ x: 1, y: 2 });
        buddy.mount(document.body);
      }).not.toThrow();
      expect(document.querySelector('.gr-buddy')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('robustness', () => {
    it('shrugs off malformed payloads', () => {
      const s = make();
      const bus = s.bus as unknown as { emit: (t: string, p: unknown) => void };
      expect(() => {
        bus.emit('gaze', { valid: true, x: Number.NaN, y: 3 });
        bus.emit('book-progress', { fraction: Number.NaN, pagesTurned: Number.POSITIVE_INFINITY });
        bus.emit('layout', { lines: [], viewport: null, column: { left: Number.NaN } });
        bus.emit('buddy-say', { text: 42 });
        bus.emit('calibration', {});
        bus.emit('tracking-state', {});
        s.buddy.say('   ');
        s.buddy.lookAt({ x: Number.NaN, y: 0 });
        s.buddy.setMood('grumpy' as never);
        vi.advanceTimersByTime(5_000);
      }).not.toThrow();
      expect(s.said()).toBeNull();
    });

    it('survives rapid mount / remount / destroy', () => {
      const s = make();
      const other = document.createElement('section');
      document.body.appendChild(other);
      s.buddy.mount(other);
      s.buddy.mount(s.host);
      s.buddy.mount(other);
      expect(document.querySelectorAll('.gr-buddy')).toHaveLength(1);
      expect(document.querySelectorAll('style[data-gr-style="buddy"]')).toHaveLength(1);
      s.buddy.destroy();
      expect(document.querySelectorAll('style[data-gr-style="buddy"]')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
