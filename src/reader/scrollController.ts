import type { AppSettings, EventBus, LineLayout } from '../types';

/**
 * Turns pages by scrolling: computes where the next page starts, animates there
 * with an ease-in-out curve (instantly under prefers-reduced-motion), lets the
 * reader interrupt with wheel/touch/keys/scrollbar, and keeps an undo stack.
 * Works for a scrolling element (the reader app) or the window (the extension).
 */

export interface ScrollControllerOptions {
  scroller: HTMLElement | Window;
  bus: EventBus;
  getSettings: () => AppSettings;
}

interface ScrollPort {
  getTop(): number;
  setTop(top: number): void;
  getMax(): number;
  getClientHeight(): number;
  /** Receives wheel / touchstart / pointerdown. */
  inputTarget: EventTarget;
  /** Receives keydown. */
  keyTarget: EventTarget;
  isOnScrollbar(e: PointerEvent): boolean;
}

interface Animation {
  from: number;
  to: number;
  start: number;
  duration: number;
  lastSet: number | null;
  frame: number | null;
  resolve: () => void;
}

interface TurnRecord {
  from: number;
  to: number;
}

const UNDO_LIMIT = 20;
/** How far the landed line sits below the top edge, in line pitches. */
const TOP_GAP_PITCH = 0.35;
/** If the scroll position moves this far from where we put it, someone else is scrolling. */
const INTERFERENCE_PX = 3;
const NAVIGATION_KEYS = new Set([' ', 'Spacebar', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const now = (): number => performance.now();

export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function isWindow(target: HTMLElement | Window): target is Window {
  return (target as Window).window === target;
}

function windowPort(win: Window): ScrollPort {
  const root = (): Element => win.document.scrollingElement ?? win.document.documentElement;
  return {
    getTop: () => win.scrollY ?? win.pageYOffset ?? 0,
    setTop: (top) => {
      try {
        win.scrollTo({ top, left: win.scrollX, behavior: 'instant' });
      } catch {
        win.scrollTo(win.scrollX, top);
      }
    },
    getMax: () => Math.max(0, root().scrollHeight - (root().clientHeight || win.innerHeight)),
    getClientHeight: () => root().clientHeight || win.innerHeight,
    inputTarget: win,
    keyTarget: win,
    isOnScrollbar: (e) => e.clientX >= root().clientWidth || e.clientY >= root().clientHeight,
  };
}

function elementPort(el: HTMLElement): ScrollPort {
  return {
    getTop: () => el.scrollTop,
    setTop: (top) => {
      // `behavior: 'instant'` overrides any CSS scroll-behavior: smooth that would fight our animation.
      if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'instant' });
      else el.scrollTop = top;
    },
    getMax: () => Math.max(0, el.scrollHeight - el.clientHeight),
    getClientHeight: () => el.clientHeight,
    inputTarget: el,
    keyTarget: el.ownerDocument?.defaultView ?? globalThis,
    isOnScrollbar: (e) => {
      if (typeof el.getBoundingClientRect !== 'function') return false;
      const r = el.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) return false;
      const clientLeft = r.left + (el.clientLeft || 0);
      const clientTop = r.top + (el.clientTop || 0);
      // Inside the border box but outside the client (padding) box = on a scrollbar.
      return (
        e.clientX < clientLeft ||
        e.clientX >= clientLeft + el.clientWidth ||
        e.clientY < clientTop ||
        e.clientY >= clientTop + el.clientHeight
      );
    },
  };
}

type FrameRequest = (cb: (t: number) => void) => number;

function requestFrame(cb: () => void): number {
  const raf = (globalThis as { requestAnimationFrame?: FrameRequest }).requestAnimationFrame;
  if (typeof raf === 'function') return raf.call(globalThis, () => cb());
  return setTimeout(cb, 16) as unknown as number;
}

function cancelFrame(id: number): void {
  const caf = (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame;
  if (typeof caf === 'function') caf.call(globalThis, id);
  else clearTimeout(id);
}

export class ScrollController {
  private readonly port: ScrollPort;
  private readonly bus: EventBus;
  private readonly getSettings: () => AppSettings;
  private readonly reducedMotion: MediaQueryList | null;
  private anim: Animation | null = null;
  private readonly undoStack: TurnRecord[] = [];
  private destroyed = false;
  private turns = 0;
  private lastTurn = 0;
  private readonly cleanups: (() => void)[] = [];

  constructor(opts: ScrollControllerOptions) {
    this.port = isWindow(opts.scroller) ? windowPort(opts.scroller) : elementPort(opts.scroller);
    this.bus = opts.bus;
    this.getSettings = opts.getSettings;
    this.reducedMotion =
      typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(prefers-reduced-motion: reduce)') : null;

    const cancelOnInput = (): void => this.stop();
    const onPointerDown = (e: Event): void => {
      const pe = e as PointerEvent;
      if (pe.button === 1 || this.port.isOnScrollbar(pe)) this.stop();
    };
    const onKeyDown = (e: Event): void => {
      const ke = e as KeyboardEvent;
      // Only keys pressed after the animation began: the key that *started* a page turn must not cancel it.
      if (this.anim && NAVIGATION_KEYS.has(ke.key) && ke.timeStamp < this.anim.start) return;
      if (NAVIGATION_KEYS.has(ke.key)) this.stop();
    };
    this.listen(this.port.inputTarget, 'wheel', cancelOnInput);
    this.listen(this.port.inputTarget, 'touchstart', cancelOnInput);
    this.listen(this.port.inputTarget, 'pointerdown', onPointerDown);
    this.listen(this.port.keyTarget, 'keydown', onKeyDown);
  }

  get animating(): boolean {
    return this.anim !== null;
  }

  /** Forward page turns this session (undone turns are subtracted). */
  get pagesTurned(): number {
    return this.turns;
  }

  /** performance.now() of the last page turn (0 = none yet). */
  get lastTurnAt(): number {
    return this.lastTurn;
  }

  /**
   * Where the next page starts. The line placed at the top is lines[L − overlap + 1];
   * it lands TOP_GAP_PITCH × pitch below the top edge. Falls back to "one screen
   * minus the overlap" when that line is unknown or wouldn't move us forward.
   */
  computeTarget(layout: LineLayout | null, targetLineIndex: number, overlapLines: number): number {
    const current = this.currentTop(layout);
    const max = this.port.getMax();
    const pitch = this.pitch(layout);
    const clientHeight = layout && layout.clientHeight > 0 ? layout.clientHeight : this.port.getClientHeight();
    const overlap = clamp(Math.round(Number.isFinite(overlapLines) ? overlapLines : 1), 0, 3);

    if (layout && Number.isInteger(targetLineIndex) && targetLineIndex >= 0 && targetLineIndex < layout.lines.length) {
      const line = layout.lines[targetLineIndex - overlap + 1];
      if (line && Number.isFinite(line.docTop)) {
        const top = clamp(line.docTop - TOP_GAP_PITCH * pitch, 0, max);
        if (top >= current + pitch) return top;
      }
    }
    const step = Math.max(clientHeight - (overlap + 1) * pitch, pitch);
    return clamp(current + step, 0, max);
  }

  /** Turns forward one page. Emits `page-turn` when (and only when) the view actually moves. */
  async turnPage(layout: LineLayout | null, targetLineIndex: number, opts: { auto: boolean; reason: string }): Promise<void> {
    if (this.destroyed) return;
    this.finishNow();
    const from = this.port.getTop();
    const to = this.computeTarget(layout, targetLineIndex, this.getSettings().overlapLines);
    if (!(to > from + 0.5)) return;

    this.undoStack.push({ from, to });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.turns++;
    this.lastTurn = now();
    this.bus.emit('page-turn', { from, to, auto: opts.auto, reason: opts.reason, pageIndex: this.turns });
    await this.scrollTo(to);
  }

  /** Goes back about one page, keeping `overlapLines` of context at the bottom. */
  async pageBack(layout: LineLayout | null): Promise<void> {
    if (this.destroyed) return;
    this.stop();
    const from = this.port.getTop();
    const pitch = this.pitch(layout);
    const clientHeight = layout && layout.clientHeight > 0 ? layout.clientHeight : this.port.getClientHeight();
    const overlap = clamp(Math.round(this.getSettings().overlapLines), 0, 3);
    const to = clamp(from - Math.max(clientHeight - (overlap + 1) * pitch, pitch), 0, this.port.getMax());
    if (from - to < 0.5) return;
    await this.scrollTo(to);
  }

  /** Returns to where the last page turn started. Resolves false when there is nothing to undo. */
  async undo(): Promise<boolean> {
    if (this.destroyed) return false;
    const last = this.undoStack.pop();
    if (!last) return false;
    this.stop();
    this.turns = Math.max(0, this.turns - 1);
    this.bus.emit('page-turn-undone', { from: this.port.getTop(), to: last.from });
    await this.scrollTo(last.from);
    return true;
  }

  /**
   * Animated scroll to `top` (clamped). Resolves when the animation ends or is
   * interrupted — never rejects. Duration defaults to settings.scrollDurationMs.
   */
  scrollTo(top: number, durationMs?: number): Promise<void> {
    if (this.destroyed || !Number.isFinite(top)) return Promise.resolve();
    this.stop();
    const target = clamp(top, 0, this.port.getMax());
    const from = this.port.getTop();
    const requested = durationMs ?? this.getSettings().scrollDurationMs;
    const duration = this.prefersInstant() || !Number.isFinite(requested) ? 0 : Math.max(0, requested);
    if (duration === 0 || Math.abs(target - from) < 1) {
      this.port.setTop(target);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.anim = { from, to: target, start: now(), duration, lastSet: null, frame: null, resolve };
      this.anim.frame = requestFrame(this.step);
    });
  }

  atEnd(): boolean {
    const max = this.port.getMax();
    return max <= 0 || this.port.getTop() >= max - 2;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.undoStack.length = 0;
    for (const off of this.cleanups.splice(0)) off();
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private readonly step = (): void => {
    const a = this.anim;
    if (!a) return;
    a.frame = null;
    if (a.lastSet !== null && Math.abs(this.port.getTop() - a.lastSet) > INTERFERENCE_PX) {
      this.stop(); // the reader (or find-in-page, or an anchor jump) took over
      return;
    }
    const t = clamp((now() - a.start) / a.duration, 0, 1);
    const pos = clamp(a.from + (a.to - a.from) * easeInOutCubic(t), 0, this.port.getMax());
    this.port.setTop(pos);
    a.lastSet = pos;
    if (t >= 1) {
      this.anim = null;
      a.resolve();
      return;
    }
    a.frame = requestFrame(this.step);
  };

  /** Cancels any running animation where it stands and resolves its promise. */
  private stop(): void {
    const a = this.anim;
    if (!a) return;
    this.anim = null;
    if (a.frame !== null) cancelFrame(a.frame);
    a.resolve();
  }

  /** Completes any running animation immediately at its destination. */
  private finishNow(): void {
    const a = this.anim;
    if (!a) return;
    this.stop();
    this.port.setTop(clamp(a.to, 0, this.port.getMax()));
  }

  private currentTop(layout: LineLayout | null): number {
    const live = this.port.getTop();
    if (Number.isFinite(live)) return live;
    return layout && Number.isFinite(layout.scrollTop) ? layout.scrollTop : 0;
  }

  private pitch(layout: LineLayout | null): number {
    if (layout && Number.isFinite(layout.linePitch) && layout.linePitch > 0) return layout.linePitch;
    const s = this.getSettings();
    const fromSettings = s.fontSizePx * s.lineHeight;
    return Number.isFinite(fromSettings) && fromSettings > 0 ? fromSettings : 40;
  }

  private prefersInstant(): boolean {
    if (this.reducedMotion?.matches) return true;
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  private listen(target: EventTarget, type: string, handler: (e: Event) => void): void {
    target.addEventListener(type, handler, { passive: true });
    this.cleanups.push(() => target.removeEventListener(type, handler));
  }
}
