// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GazeSample, LineEstimate } from '../types';
import { createEventBus } from '../core/events';
import { createSettingsStore } from '../core/settings';
import { IGNORE_ATTR } from '../core/constants';
import { DriftCorrection, GazeDot } from './gazeDot';

/** Manual animation frames: the test decides when a frame happens. */
function manualFrames() {
  const win = document.defaultView!;
  const frames = new Map<number, FrameRequestCallback>();
  let next = 1;
  const raf = vi.spyOn(win, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.set(next, cb);
    return next++;
  });
  const caf = vi.spyOn(win, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  return {
    raf,
    caf,
    pending: () => frames.size,
    flush: () => {
      const cbs = [...frames.values()];
      frames.clear();
      for (const cb of cbs) cb(0);
    },
  };
}

const gaze = (x: number, y: number, valid = true): GazeSample => ({ t: 1, x, y, rawX: x, rawY: y, valid, confidence: valid ? 1 : 0, source: 'mouse' });

function setup(showGazeDot = true) {
  const bus = createEventBus();
  const store = createSettingsStore(bus, { persist: false, initial: { showGazeDot } });
  const dot = new GazeDot({ bus, getSettings: store.get });
  const host = document.createElement('div');
  document.body.appendChild(host);
  return { bus, store, dot, host };
}

describe('GazeDot', () => {
  let frames: ReturnType<typeof manualFrames>;
  beforeEach(() => {
    frames = manualFrames();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('mounts a self-contained, non-interactive, measurement-ignored layer', () => {
    const { dot, host } = setup();
    dot.mount(host);
    const layer = host.firstElementChild as HTMLElement;
    expect(layer.hasAttribute(IGNORE_ATTR)).toBe(true);
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.style.pointerEvents).toBe('none');
    expect(layer.querySelector('style')!.textContent).toMatch(/\.gr-gaze-dot\s*\{/);
    expect(layer.querySelector('.gr-gaze-dot')).not.toBeNull();
    dot.destroy();
  });

  it('works inside a shadow root', () => {
    const { dot, host } = setup();
    const shadow = host.attachShadow({ mode: 'open' });
    dot.mount(shadow);
    expect(shadow.querySelector('.gr-gaze-dot')).not.toBeNull();
    expect(shadow.querySelector('style')).not.toBeNull();
    dot.destroy();
    expect(shadow.childNodes).toHaveLength(0);
  });

  it('follows the smoothed gaze with a transform, once per frame', () => {
    const { bus, dot, host } = setup();
    dot.mount(host);
    frames.flush();
    for (let i = 0; i < 5; i++) bus.emit('gaze', gaze(100 + i, 200));
    expect(frames.pending()).toBe(1);
    frames.flush();
    const el = host.querySelector<HTMLElement>('.gr-gaze-dot')!;
    expect(el.style.transform).toBe('translate3d(95.0px, 191.0px, 0)');
    expect(el.classList.contains('gr-is-on')).toBe(true);
    expect(el.classList.contains('gr-is-offscreen')).toBe(false);
    dot.destroy();
  });

  it('hides while the gaze is invalid and pins itself to the edge when the gaze is off-screen', () => {
    const { bus, dot, host } = setup();
    dot.mount(host);
    const el = host.querySelector<HTMLElement>('.gr-gaze-dot')!;
    bus.emit('gaze', gaze(300, 300));
    frames.flush();
    bus.emit('gaze', gaze(300, 300, false));
    frames.flush();
    expect(el.classList.contains('gr-is-on')).toBe(false);
    bus.emit('gaze', gaze(NaN, 300));
    frames.flush();
    expect(el.classList.contains('gr-is-on')).toBe(false);
    bus.emit('gaze', gaze(-400, window.innerHeight + 500));
    frames.flush();
    expect(el.classList.contains('gr-is-on')).toBe(true);
    expect(el.classList.contains('gr-is-offscreen')).toBe(true);
    expect(el.style.transform).toBe(`translate3d(0.0px, ${(window.innerHeight - 18).toFixed(1)}px, 0) scale(0.7)`);
    dot.destroy();
  });

  it('never queries the viewport size while following the gaze (no forced layout per frame)', () => {
    const win = document.defaultView!;
    let reads = 0;
    let size = { w: 1000, h: 700 };
    const w = Object.getOwnPropertyDescriptor(win, 'innerWidth');
    const h = Object.getOwnPropertyDescriptor(win, 'innerHeight');
    Object.defineProperty(win, 'innerWidth', { configurable: true, get: () => (reads++, size.w) });
    Object.defineProperty(win, 'innerHeight', { configurable: true, get: () => (reads++, size.h) });
    try {
      const { bus, dot, host } = setup();
      dot.mount(host);
      const el = host.querySelector<HTMLElement>('.gr-gaze-dot')!;
      const afterMount = reads;
      for (let i = 0; i < 20; i++) {
        bus.emit('gaze', gaze(100 + i, 5000));
        frames.flush();
      }
      expect(reads).toBe(afterMount);
      expect(el.style.transform).toBe('translate3d(110.0px, 682.0px, 0) scale(0.7)');
      // The window shrinks: the edge pin follows it.
      size = { w: 800, h: 500 };
      win.dispatchEvent(new Event('resize'));
      bus.emit('gaze', gaze(100, 5000));
      frames.flush();
      expect(el.style.transform).toBe('translate3d(91.0px, 482.0px, 0) scale(0.7)');
      dot.destroy();
    } finally {
      if (w) Object.defineProperty(win, 'innerWidth', w);
      if (h) Object.defineProperty(win, 'innerHeight', h);
    }
  });

  it('follows the showGazeDot setting and setVisible(), and does no work while hidden', () => {
    const { bus, store, dot, host } = setup(false);
    dot.mount(host);
    const layer = host.firstElementChild as HTMLElement;
    expect(layer.hidden).toBe(true);
    expect(dot.visible).toBe(false);
    bus.emit('gaze', gaze(100, 100));
    expect(frames.pending()).toBe(0);

    store.update({ showGazeDot: true });
    expect(layer.hidden).toBe(false);
    expect(dot.visible).toBe(true);
    frames.flush();

    dot.setVisible(false);
    expect(layer.hidden).toBe(true);
    bus.emit('gaze', gaze(120, 100));
    expect(frames.pending()).toBe(0);
    dot.setVisible(true);
    expect(layer.hidden).toBe(false);
    store.update({ showGazeDot: false });
    expect(layer.hidden).toBe(true);
    dot.destroy();
  });

  it('cleans up completely on destroy()', () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    const { bus, dot, host } = setup();
    dot.mount(host);
    bus.emit('gaze', gaze(100, 100));
    expect(frames.pending()).toBe(1);
    dot.destroy();
    expect(frames.pending()).toBe(0);
    expect(frames.caf).toHaveBeenCalled();
    expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(host.childNodes).toHaveLength(0);
    bus.emit('gaze', gaze(200, 100));
    bus.emit('settings-patch', { showGazeDot: false });
    expect(frames.pending()).toBe(0);
    dot.mount(host); // a destroyed component stays gone
    expect(host.childNodes).toHaveLength(0);
  });
  it('shows the gaze where the reading layer believes it is: minus the line tracker’s drift', () => {
    const { bus, dot, host } = setup();
    dot.mount(host);
    const el = host.querySelector<HTMLElement>('.gr-gaze-dot')!;
    const estimate = (t: number, driftY: number): LineEstimate => ({
      t, lineIndex: 3, probability: 0.9, posterior: [], progressX: 0.5, lastSaccade: 'forward', driftY, fixationsOnPage: 4,
    });
    bus.emit('line-estimate', estimate(1, 84)); // gaze reads two lines low
    bus.emit('gaze', gaze(100, 300));
    frames.flush();
    expect(el.style.transform).toBe('translate3d(91.0px, 207.0px, 0)');
    // A new calibration starts the drift over.
    bus.emit('calibration', { phase: 'start' });
    bus.emit('gaze', gaze(100, 300));
    frames.flush();
    expect(el.style.transform).toBe('translate3d(91.0px, 291.0px, 0)');
    dot.destroy();
  });

  it('can show the raw gaze instead (correctDrift: false)', () => {
    const bus = createEventBus();
    const store = createSettingsStore(bus, { persist: false, initial: { showGazeDot: true } });
    const dot = new GazeDot({ bus, getSettings: store.get, correctDrift: false });
    const host = document.createElement('div');
    document.body.appendChild(host);
    dot.mount(host);
    bus.emit('line-estimate', { t: 1, lineIndex: 0, probability: 1, posterior: [1], progressX: 0, lastSaccade: null, driftY: 84, fixationsOnPage: 1 });
    bus.emit('gaze', gaze(100, 300));
    frames.flush();
    expect(host.querySelector<HTMLElement>('.gr-gaze-dot')!.style.transform).toBe('translate3d(91.0px, 291.0px, 0)');
    dot.destroy();
  });
});

describe('DriftCorrection', () => {
  const PITCH = 42;
  const est = (t: number, driftY: number, probability = 0.9, lineIndex = 3) => ({ t, driftY, probability, lineIndex });

  it('subtracts the latest drift from y and rawY, and forgets a stale one', () => {
    const d = new DriftCorrection(30_000);
    const s: GazeSample = { t: 1000, x: 5, y: 300, rawX: 5, rawY: 310, valid: true, confidence: 1, source: 'webcam' };
    expect(d.correct(s)).toBe(s); // nothing learned yet
    d.noteEstimate(est(900, -42));
    expect(d.correct(s)).toMatchObject({ y: 342, rawY: 352, x: 5 });
    expect(d.offsetAt(30_900)).toBe(-42);
    expect(d.offsetAt(30_901)).toBe(0); // stale
    d.noteEstimate(est(950, Number.NaN)); // ignored
    expect(d.offsetAt(1000)).toBe(-42);
    d.reset();
    expect(d.offsetAt(1000)).toBe(0);
  });

  it('holds the last pinned drift while the tracker is unsure (its drift is then usually a wrong line’s)', () => {
    const d = new DriftCorrection(30_000);
    d.noteEstimate(est(1000, 0, 0.9)); // pinned: on the right line, no offset
    d.noteEstimate(est(1100, 2 * PITCH, 0.4)); // unsure, two lines off
    d.noteEstimate(est(1200, 2 * PITCH, 0.9, -1)); // no line at all
    expect(d.offsetAt(1200)).toBe(0);
    // The unsure estimates still count as reading: the held drift isn't dropped as stale.
    expect(d.offsetAt(1200 + 30_000)).toBe(0);
    d.noteEstimate(est(1300, PITCH, 0.7)); // pinned again: followed
    expect(d.offsetAt(1300)).toBe(PITCH);
    d.noteEstimate(est(40_000, -PITCH, 0.3)); // unsure, much later: the held drift is refreshed, not replaced
    expect(d.offsetAt(40_000)).toBe(PITCH);
  });

  it('follows unpinned drifts until the first pinned one, and reset() starts that over', () => {
    const d = new DriftCorrection(30_000);
    d.noteEstimate(est(1000, 3 * PITCH, 0.4)); // a constant lighting offset, not yet pinned: followed
    expect(d.offsetAt(1000)).toBe(3 * PITCH);
    d.noteEstimate(est(1100, 3 * PITCH, 0.8));
    d.noteEstimate(est(1200, 0, 0.3));
    expect(d.offsetAt(1200)).toBe(3 * PITCH);
    d.reset();
    d.noteEstimate(est(1300, -PITCH, 0.3)); // after a reset, unpinned drifts are followed again
    expect(d.offsetAt(1300)).toBe(-PITCH);
  });
});

