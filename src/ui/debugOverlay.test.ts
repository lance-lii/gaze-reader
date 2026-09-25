// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fixation, GazeSample, LineEstimate, PageEndDecision } from '../types';
import { createEventBus } from '../core/events';
import { createSettingsStore } from '../core/settings';
import { IGNORE_ATTR } from '../core/constants';
import { DebugOverlay } from './debugOverlay';
import type { TrackedLineEstimate } from '../reading/lineTracker';
import { makeReadingPage } from '../reading/testLayouts';

function manualFrames() {
  const win = document.defaultView!;
  const frames = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.spyOn(win, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.set(next, cb);
    return next++;
  });
  const caf = vi.spyOn(win, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  return {
    caf,
    pending: () => frames.size,
    flush: () => {
      const cbs = [...frames.values()];
      frames.clear();
      for (const cb of cbs) cb(0);
    },
  };
}

/** A 2D context that records the methods called on it (jsdom has no canvas). */
function recordingContext() {
  const calls: string[] = [];
  const props: Record<string, unknown> = {};
  const ctx = new Proxy(props, {
    get: (target, key: string) => (key in target ? target[key] : (..._args: unknown[]) => void calls.push(key)),
    set: (target, key: string, value: unknown) => {
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const layout = makeReadingPage(4);
const gaze = (x: number, y: number, t: number, valid = true): GazeSample => ({ t, x, y, rawX: x + 5, rawY: y - 5, valid, confidence: 1, source: 'webcam' });
const fixation = (id: number, x: number, y: number): Fixation => ({ id, start: id * 300, end: id * 300 + 220, x, y, sampleCount: 7 });

function estimate(line: number): TrackedLineEstimate {
  const posterior = layout.lines.map((_, i) => (i === line ? 0.9 : i === line - 1 ? 0.1 : 0));
  return {
    t: 1,
    lineIndex: line,
    probability: 0.9,
    posterior,
    progressX: 0.42,
    lastSaccade: 'return-sweep',
    driftY: 7.5,
    fixationsOnPage: 23,
    sigmaYPx: 18.9,
    excursions: 2,
  };
}

function setup(showDebugOverlay = true) {
  const bus = createEventBus();
  const store = createSettingsStore(bus, { persist: false, initial: { showDebugOverlay } });
  const overlay = new DebugOverlay({ bus, getSettings: store.get });
  const host = document.createElement('div');
  document.body.appendChild(host);
  return { bus, store, overlay, host };
}

describe('DebugOverlay', () => {
  let frames: ReturnType<typeof manualFrames>;
  let rec: ReturnType<typeof recordingContext>;
  beforeEach(() => {
    frames = manualFrames();
    rec = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((() => rec.ctx) as unknown) as HTMLCanvasElement['getContext']);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('mounts a full-viewport, click-through, measurement-ignored canvas with a legend panel', () => {
    const { overlay, host } = setup();
    overlay.mount(host);
    const root = host.firstElementChild as HTMLElement;
    expect(root.hasAttribute(IGNORE_ATTR)).toBe(true);
    expect(root.style.pointerEvents).toBe('none');
    expect(root.querySelector('style')!.textContent).toMatch(/pointer-events:\s*none/);
    expect(root.querySelector('canvas')).not.toBeNull();
    expect(root.querySelector('.gr-debug-panel')!.textContent).toMatch(/forward.*regression.*return-sweep.*jump/s);
    overlay.destroy();
  });

  it('sizes the canvas for the device pixel ratio and follows window resizes', () => {
    const win = document.defaultView!;
    Object.defineProperty(win, 'devicePixelRatio', { configurable: true, value: 2 });
    const { overlay, host } = setup();
    overlay.mount(host);
    const canvas = host.querySelector('canvas')!;
    expect(canvas.width).toBe(win.innerWidth * 2);
    expect(canvas.height).toBe(win.innerHeight * 2);
    Object.defineProperty(win, 'innerWidth', { configurable: true, value: 640 });
    win.dispatchEvent(new Event('resize'));
    expect(canvas.width).toBe(1280);
    overlay.destroy();
    Object.defineProperty(win, 'devicePixelRatio', { configurable: true, value: 1 });
  });

  it('draws the pipeline state at most once per frame, and only while visible', () => {
    const { bus, store, overlay, host } = setup(false);
    overlay.mount(host);
    expect((host.firstElementChild as HTMLElement).hidden).toBe(true);
    bus.emit('gaze', gaze(300, 300, 1));
    expect(frames.pending()).toBe(0);

    store.update({ showDebugOverlay: true });
    frames.flush();
    rec.calls.length = 0;
    bus.emit('layout', layout);
    for (let i = 0; i < 10; i++) bus.emit('gaze', gaze(300 + 10 * i, 300, 100 + 33 * i));
    bus.emit('fixation', fixation(1, 300, 300));
    bus.emit('fixation', fixation(2, 390, 302));
    bus.emit('line-estimate', estimate(5));
    expect(frames.pending()).toBe(1);
    frames.flush();
    expect(rec.calls).toContain('clearRect');
    expect(rec.calls).toContain('fillRect'); // line boxes, zones, raw trail
    expect(rec.calls).toContain('arc'); // fixations, gaze
    expect(rec.calls.filter((c) => c === 'strokeRect').length).toBeGreaterThanOrEqual(layout.lines.length);

    overlay.setVisible(false);
    bus.emit('gaze', gaze(310, 300, 999));
    expect(frames.pending()).toBe(0);
    overlay.destroy();
  });

  it('explains the tracker state and page-end decisions in the panel', () => {
    const { bus, overlay, host } = setup();
    overlay.mount(host);
    bus.emit('layout', layout);
    bus.emit('line-estimate', estimate(5));
    const decision: PageEndDecision = { trigger: false, reason: 'none', confidence: 0.3, targetLineIndex: 20, detail: 'cooldown 400 ms · L=20' };
    overlay.showDecision(decision);
    frames.flush();
    const panel = host.querySelector('.gr-debug-panel')!.textContent!;
    expect(panel).toMatch(/line 5/);
    expect(panel).toMatch(/p 0\.90/);
    expect(panel).toMatch(/x 0\.42/);
    expect(panel).toMatch(/driftY \+7\.5 px/);
    expect(panel).toMatch(/σy 18\.9 px/);
    expect(panel).toMatch(/fixations on page 23/);
    expect(panel).toMatch(/off-text 2/);
    expect(panel).toMatch(/page-end: cooldown 400 ms/);
    bus.emit('page-end', { trigger: true, reason: 'line-tracker', confidence: 0.9, targetLineIndex: 20, detail: 'line-tracker: on last line' });
    bus.emit('gaze', gaze(0, 0, 5, false));
    frames.flush();
    const after = host.querySelector('.gr-debug-panel')!.textContent!;
    expect(after).toMatch(/last turn: line-tracker/);
    expect(after).toMatch(/gaze: invalid/);
    overlay.destroy();
  });

  it('shows the lighting, the eyelid monitor, appearance changes, checks and the drift belief', () => {
    const { bus, overlay, host } = setup();
    overlay.mount(host);
    const pitch = layout.linePitch;
    bus.emit('layout', layout);
    const tracked: TrackedLineEstimate = { ...estimate(5), driftLowY: -0.5 * pitch, driftHighY: 1.25 * pitch, driftSdY: 0.25 * pitch };
    bus.emit('line-estimate', tracked);
    bus.emit('lighting-state', { flags: ['backlit', 'glare'], distance: 1.234, changedSinceCalibration: true, dominant: 'backlight' });
    bus.emit('gaze', gaze(300, 300, 10_000));
    bus.emit('appearance-changed', { t: 7000, reason: 'lighting', detail: 'light changed since calibration' });
    bus.emit('accuracy-check', { meanErrorPx: 61.4, offsetXPx: 3, offsetYPx: 2.1 * pitch, offsetYLines: 2.1, applied: true });
    overlay.showAppearance({ state: 'watching', residualZ: -1.26, squintZ: null, levelVsCalibration: -0.0123 });
    frames.flush();
    const panel = host.querySelector('.gr-debug-panel')!.textContent!;
    expect(panel).toMatch(/drift belief -0\.50…\+1\.25 ln {2}sd 0\.25/);
    expect(panel).toMatch(/light backlit, glare {2}D 1\.23 {2}CHANGED \(backlight\)/);
    expect(panel).toMatch(/lids watching {2}z -1\.3 {2}squint z – {2}level -0\.012/);
    expect(panel).toMatch(/appearance change 3 s ago: lighting · light changed/);
    expect(panel).toMatch(/accuracy check: 61 px, y \+2\.10 ln \(applied\)/);
    // The belief is drawn as a bracket beside the drift-corrected gaze.
    expect(rec.calls.filter((c) => c === 'lineTo').length).toBeGreaterThanOrEqual(3);
    overlay.showAppearance(null);
    frames.flush();
    expect(host.querySelector('.gr-debug-panel')!.textContent!).not.toMatch(/lids /);
    overlay.destroy();
  });

  it('explains every mark it draws in the legend', () => {
    const { overlay, host } = setup();
    overlay.mount(host);
    const keys = [...host.querySelectorAll('.gr-debug-key')].map((k) => k.textContent);
    expect(keys).toEqual(
      expect.arrayContaining(['forward', 'regression', 'return-sweep', 'jump', 'gaze', 'raw', 'drift-corrected', 'fixation', 'bottom-dwell zone', 'glance zone']),
    );
    overlay.destroy();
  });

  it('does not draw the gaze trail across a tracking gap', () => {
    const { bus, overlay, host } = setup();
    overlay.mount(host);
    frames.flush();
    for (let i = 0; i < 5; i++) bus.emit('gaze', gaze(300 + 10 * i, 300, 100 + 33 * i));
    bus.emit('gaze', gaze(0, 0, 300, false));
    for (let i = 0; i < 5; i++) bus.emit('gaze', gaze(600 + 10 * i, 500, 900 + 33 * i));
    rec.calls.length = 0;
    frames.flush();
    // 4 + 4 trail segments (not 9), plus the two strokes of the gaze cross.
    expect(rec.calls.filter((c) => c === 'lineTo')).toHaveLength(10);
    overlay.destroy();
  });

  it('says how long ago the last page turn was', () => {
    const { bus, overlay, host } = setup();
    overlay.mount(host);
    bus.emit('gaze', gaze(300, 300, 1000));
    bus.emit('page-end', { trigger: true, reason: 'glance-down', confidence: 0.9, targetLineIndex: 20, detail: 'glance-down: looked below the page for 600 ms' });
    bus.emit('gaze', gaze(300, 300, 3500));
    frames.flush();
    expect(host.querySelector('.gr-debug-panel')!.textContent).toMatch(/last turn 2\.5 s ago: glance-down/);
    overlay.destroy();
  });

  it('keeps the panel clear of Dewey', () => {
    const { store, overlay, host } = setup();
    overlay.mount(host);
    const panel = host.querySelector('.gr-debug-panel')!;
    expect(panel.classList.contains('gr-is-right')).toBe(false);
    store.update({ buddyCorner: 'bottom-left' });
    expect(panel.classList.contains('gr-is-right')).toBe(true);
    overlay.destroy();
  });

  it('works inside a shadow root and without a 2D context', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation((() => null) as unknown as HTMLCanvasElement['getContext']);
    const { bus, overlay, host } = setup();
    const shadow = host.attachShadow({ mode: 'open' });
    overlay.mount(shadow);
    bus.emit('line-estimate', estimate(3));
    expect(() => frames.flush()).not.toThrow();
    expect(shadow.querySelector('.gr-debug-panel')!.textContent).toMatch(/line 3/);
    overlay.destroy();
    expect(shadow.childNodes).toHaveLength(0);
  });

  it('removes every listener, frame and element on destroy()', () => {
    const win = document.defaultView!;
    const removed = vi.spyOn(win, 'removeEventListener');
    const { bus, overlay, host } = setup();
    overlay.mount(host);
    bus.emit('gaze', gaze(100, 100, 1));
    expect(frames.pending()).toBe(1);
    overlay.destroy();
    expect(frames.pending()).toBe(0);
    expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(host.childNodes).toHaveLength(0);
    bus.emit('gaze', gaze(100, 100, 2));
    bus.emit('line-estimate', estimate(2) as LineEstimate);
    win.dispatchEvent(new Event('resize'));
    expect(frames.pending()).toBe(0);
  });
});
