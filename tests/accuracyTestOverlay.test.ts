// @vitest-environment jsdom
// The accuracy test's screen, driven by a simulated reader who looks at each dot and moves as asked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { posturePose } from '../bench/live/simSession';
import { BASE_POSE, DEG, NOMINAL_NOISE, STANDARD_TARGETS, VIEW, frameFeatures, gauss, headFollow, headMovementSession, makeFrame, rng, type Pose } from '../bench/lighting/faceSim';
import { MIN_FRAMES_PER_DOT, POSTURES, TEST_TARGETS, VARIANTS, formatScores, parseRecording, type AccuracyRecording, type PostureId } from '../src/gaze/accuracyTest';
import { REAL_FACE_PRIOR } from '../src/gaze/gazePrior';
import type { CalibrationSample, FeatureFrame, FeatureSource, Point, Unsubscribe } from '../src/types';
import { AccuracyTestOverlay, trialsFromSamples, type AccuracyTestOverlayOptions, type AccuracyTestResult } from '../src/ui/accuracyTestOverlay';
import type { CalibrationFrames } from '../src/ui/calibrationOverlay';

class FakeSource implements FeatureSource {
  running = true;
  private readonly listeners = new Set<(frame: FeatureFrame) => void>();
  async start(): Promise<void> {
    this.running = true;
  }
  stop(): void {
    this.running = false;
  }
  onFrame(cb: (frame: FeatureFrame) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  push(frame: FeatureFrame): void {
    for (const cb of [...this.listeners]) cb(frame);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** What the simulated eyes give for a look at `target` from `base`. */
function look(target: Point, base: Pose, r: () => number): CalibrationSample['features'] | null {
  const gaze = { h: 0.1 * DEG * gauss(r), v: 0.1 * DEG * gauss(r) };
  return frameFeatures(makeFrame(target, headFollow(target, base), gaze, {}, r, NOMINAL_NOISE));
}

/** The frames a finished calibration hands the test: its dots, then the head-movement step. */
function calibrationFrames(seed = 3): CalibrationFrames {
  const r = rng(seed);
  let t = 1000;
  const targets: CalibrationSample[] = [];
  for (const frac of STANDARD_TARGETS) {
    const target = { x: frac.x * VIEW.width, y: frac.y * VIEW.height };
    for (let i = 0; i < 30; i++) {
      const features = look(target, BASE_POSE, r);
      if (features) targets.push({ t: (t += 33), target, features });
    }
  }
  const head = headMovementSession(seed + 1).map((s) => ({ ...s, t: (t += 33) }));
  return { targets, head, viewport: { width: VIEW.width, height: VIEW.height }, maxBlink: 0.85 };
}

const PERIOD_MS = 33;
const TIMING = { glideMs: 60, settleMs: 100, dotMs: 500, maxAttempts: 2 };
const ROUND_MS = TEST_TARGETS.length * (TIMING.glideMs + TIMING.settleMs + TIMING.dotMs);

interface Rig {
  src: FakeSource;
  overlay: AccuracyTestOverlay;
  run: Promise<AccuracyTestResult | null>;
  reader: { faceFound: boolean; posture: PostureId; framesWhileLost: number };
  saved: AccuracyRecording[];
  copied: string[];
  root: () => HTMLElement | null;
  button: (label: string | RegExp) => HTMLButtonElement;
  click: (label: string | RegExp) => Promise<void>;
  title: () => string;
  stop: () => void;
}

function rig(over: Partial<AccuracyTestOverlayOptions> = {}): Rig {
  const src = new FakeSource();
  const saved: AccuracyRecording[] = [];
  const copied: string[] = [];
  const overlay = new AccuracyTestOverlay({
    features: src,
    calibration: calibrationFrames(),
    linePitchPx: 28,
    appVersion: '9.9.9',
    prior: REAL_FACE_PRIOR,
    save: (rec) => {
      saved.push(rec);
      return true;
    },
    copy: async (text) => {
      copied.push(text);
    },
    timing: TIMING,
    random: rng(5),
    ...over,
  });
  const run = overlay.run(document.body);
  const root = (): HTMLElement | null => document.querySelector<HTMLElement>('.gr-acc');
  const reader: Rig['reader'] = { faceFound: true, posture: 'still', framesWhileLost: 0 };
  const r = rng(21);
  const id = setInterval(() => {
    if (!reader.faceFound) {
      reader.framesWhileLost += 1;
      src.push({ t: performance.now(), faceFound: false, features: null, quality: 0 });
      return;
    }
    const dot = root()?.querySelector<HTMLElement>('.gr-acc-dot');
    const x = parseFloat(dot?.style.getPropertyValue('--x') ?? '');
    const y = parseFloat(dot?.style.getPropertyValue('--y') ?? '');
    const target = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : { x: VIEW.width / 2, y: VIEW.height / 2 };
    const features = look(target, posturePose(reader.posture), r);
    src.push({ t: performance.now(), faceFound: features !== null, features, quality: features ? 0.9 : 0 });
  }, PERIOD_MS);
  const button = (label: string | RegExp): HTMLButtonElement => {
    const found = [...(root()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')));
    if (!found) throw new Error(`no button ${String(label)}: ${[...(root()?.querySelectorAll('button') ?? [])].map((b) => b.textContent).join(' | ')}`);
    return found;
  };
  return {
    src,
    overlay,
    run,
    reader,
    saved,
    copied,
    root,
    button,
    click: async (label) => {
      button(label).click();
      await vi.advanceTimersByTimeAsync(1);
    },
    title: () => root()?.querySelector('.gr-acc-title')?.textContent ?? '',
    stop: () => clearInterval(id),
  };
}

/** Starts a round in the given posture and lets it run to its end. */
async function playRound(g: Rig, posture: PostureId, ms = ROUND_MS + 200): Promise<void> {
  g.reader.posture = posture;
  await g.click('Ready');
  await vi.advanceTimersByTimeAsync(ms);
}

let active: Rig | null = null;
const start = (over: Partial<AccuracyTestOverlayOptions> = {}): Rig => (active = rig(over));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  active?.stop();
  active?.overlay.destroy();
  active = null;
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('accuracy test screen', () => {
  it('runs the five rounds, scores them, and offers the recording', async () => {
    const g = start();
    expect(g.title()).toBe('Accuracy test');
    expect(g.root()?.getAttribute('role')).toBe('dialog');
    await g.click('Start');
    for (const [i, p] of POSTURES.entries()) {
      expect(g.title()).toBe(`Round ${i + 1} of ${POSTURES.length}: ${p.title}`);
      expect(g.root()?.textContent).toContain(p.instruction);
      await playRound(g, p.id);
    }
    expect(g.title()).toBe('Accuracy test: results');
    // Listening to the camera stops once the dots are over.
    expect(g.src.listenerCount).toBe(0);

    const rows = [...(g.root()?.querySelectorAll('tbody tr') ?? [])];
    expect(rows.length).toBe(VARIANTS.filter((v) => !v.needsEyeNet).length);
    expect(rows[0].textContent).toContain('Default calibration');
    expect(g.root()?.querySelector('.gr-acc-verdict')?.textContent?.length).toBeGreaterThan(20);

    await g.click('Save recording');
    expect(g.saved.length).toBe(1);
    expect(g.root()?.textContent).toContain('Recording saved');
    await g.click('Copy results');
    expect(g.copied.length).toBe(1);

    await g.click('Done');
    const result = await g.run;
    if (!result) throw new Error('no result');
    expect(g.root()).toBeNull();
    expect(g.saved[0]).toBe(result.recording);
    expect(g.copied[0]).toBe(formatScores(result.scores));

    const rec = result.recording;
    expect(rec.app).toBe('9.9.9');
    expect(rec.linePitchPx).toBe(28);
    expect(rec.viewport).toEqual({ width: VIEW.width, height: VIEW.height });
    expect(rec.blocks.map((b) => b.kind)).toEqual(['calibrate', 'head', 'test', 'test', 'test', 'test', 'test']);
    expect(rec.blocks[0].trials.length).toBe(STANDARD_TARGETS.length);
    const tests = rec.blocks.filter((b) => b.kind === 'test');
    expect(tests.map((b) => b.posture)).toEqual(POSTURES.map((p) => p.id));
    for (const b of tests) {
      // Stored in the plan's order, whatever order the dots were shown in.
      expect(b.trials.map((t) => t.target)).toEqual(TEST_TARGETS.map((f) => ({ x: f.x * VIEW.width, y: f.y * VIEW.height })));
      for (const t of b.trials) expect(t.frames.length).toBeGreaterThanOrEqual(MIN_FRAMES_PER_DOT);
    }
    // What is saved reads back as a recording, and holds numbers only.
    const parsed = parseRecording(JSON.parse(JSON.stringify(rec)));
    expect(parsed.ok).toBe(true);
    expect(result.scores.variants.every((v) => v.ok)).toBe(true);
    const def = result.scores.variants[0];
    expect(def.overall.scored).toBe(POSTURES.length * TEST_TARGETS.length);
    // A simulated reader who looks straight at the dots is followed to within a few lines.
    expect(def.postures[0].score.medianErrorPx).toBeLessThan(120);
  });

  it('keeps only frames from while a dot is held still', async () => {
    const g = start();
    await g.click('Start');
    await playRound(g, 'still');
    await g.click(/^Stop/);
    await g.click('Done');
    const result = await g.run;
    const block = result?.recording.blocks.find((b) => b.kind === 'test');
    const most = Math.ceil(TIMING.dotMs / PERIOD_MS) + 1;
    for (const t of block?.trials ?? []) expect(t.frames.length).toBeLessThanOrEqual(most);
  });

  it('"Not now" ends it with nothing recorded', async () => {
    const g = start();
    await g.click('Not now');
    expect(await g.run).toBeNull();
    expect(g.root()).toBeNull();
    expect(g.src.listenerCount).toBe(0);
    expect(g.saved.length).toBe(0);
  });

  it('Esc in the middle of a round drops that round and scores the finished ones', async () => {
    const g = start();
    await g.click('Start');
    await playRound(g, 'still');
    await playRound(g, 'turned');
    await playRound(g, 'back', ROUND_MS / 2);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(g.title()).toBe('Accuracy test: results');
    await g.click('Done');
    const result = await g.run;
    expect(result?.recording.blocks.filter((b) => b.kind === 'test').map((b) => b.posture)).toEqual(['still', 'turned']);
    expect(result?.scores.variants[0].overall.scored).toBe(2 * TEST_TARGETS.length);
  });

  it('Esc before the first round is complete ends it with nothing', async () => {
    const g = start();
    await g.click('Start');
    await playRound(g, 'still', ROUND_MS / 3);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200);
    expect(await g.run).toBeNull();
    expect(g.root()).toBeNull();
  });

  it('shows a dot again when the face was lost on it', async () => {
    const g = start();
    await g.click('Start');
    g.reader.posture = 'still';
    await g.click('Ready');
    // Lost for the whole first dot.
    g.reader.faceFound = false;
    await vi.advanceTimersByTimeAsync(TIMING.glideMs + TIMING.settleMs + TIMING.dotMs);
    g.reader.faceFound = true;
    expect(g.reader.framesWhileLost).toBeGreaterThan(10);
    // Nine dots are not enough now: the round is still going after their time.
    await vi.advanceTimersByTimeAsync(ROUND_MS - (TIMING.glideMs + TIMING.settleMs + TIMING.dotMs) + 100);
    expect(g.root()?.dataset.phase).toBe('dots');
    await vi.advanceTimersByTimeAsync(TIMING.glideMs + TIMING.settleMs + TIMING.dotMs + 100);
    expect(g.title()).toContain('Round 2');
    await g.click(/^Stop/);
    await g.click('Done');
    const result = await g.run;
    const block = result?.recording.blocks.find((b) => b.kind === 'test');
    expect(block?.trials.length).toBe(TEST_TARGETS.length);
    for (const t of block?.trials ?? []) expect(t.frames.length).toBeGreaterThanOrEqual(MIN_FRAMES_PER_DOT);
  });

  it('gives up on a recording when the window changes size', async () => {
    const g = start();
    await g.click('Start');
    await playRound(g, 'still');
    await playRound(g, 'turned', ROUND_MS / 2);
    const width = window.innerWidth;
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 });
      window.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(200);
      expect(g.title()).toBe('The window changed size');
      await g.click('Close');
      expect(await g.run).toBeNull();
      expect(g.saved.length).toBe(0);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('keeps the results up when the window changes size after the last round', async () => {
    const g = start();
    await g.click('Start');
    await playRound(g, 'still');
    await g.click(/^Stop/);
    expect(g.title()).toBe('Accuracy test: results');
    const width = window.innerWidth;
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 });
      window.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(200);
      // The recording was already complete: it is still there to read and save.
      expect(g.title()).toBe('Accuracy test: results');
      await g.click('Save recording');
      expect(g.saved.length).toBe(1);
      await g.click('Done');
      expect(await g.run).not.toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('keeps keys from the page underneath while it is up', async () => {
    const g = start();
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent): void => void seen.push(e.key);
    document.body.addEventListener('keydown', onKey);
    try {
      const key = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      document.body.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(true);
      expect(seen).toEqual([]);
      // Browser shortcuts are left alone.
      const shortcut = new KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(shortcut);
      expect(shortcut.defaultPrevented).toBe(false);
      await g.click('Not now');
      await g.run;
      const after = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      document.body.dispatchEvent(after);
      expect(after.defaultPrevented).toBe(false);
      expect(seen).toContain('ArrowDown');
    } finally {
      document.body.removeEventListener('keydown', onKey);
    }
  });

  it('cancel() from outside ends a run in progress', async () => {
    const g = start();
    await g.click('Start');
    await playRound(g, 'still', ROUND_MS / 2);
    g.overlay.cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(await g.run).toBeNull();
    expect(g.root()).toBeNull();
    expect(g.src.listenerCount).toBe(0);
  });

  it('has no Save button without a way to save', async () => {
    const g = start({ save: undefined });
    await g.click('Start');
    await playRound(g, 'still');
    await g.click(/^Stop/);
    expect(() => g.button('Save recording')).toThrow();
    expect(g.button('Copy results')).toBeTruthy();
    await g.click('Done');
    await g.run;
  });
});

describe('trialsFromSamples', () => {
  it('groups the calibration samples by dot, with times from the session start', () => {
    const cal = calibrationFrames(8);
    const trials = trialsFromSamples(cal.targets, cal.targets[0].t);
    expect(trials.length).toBe(STANDARD_TARGETS.length);
    expect(trials[0].frames[0].t).toBe(0);
    expect(trials.reduce((n, t) => n + t.frames.length, 0)).toBe(cal.targets.length);
    expect(trialsFromSamples(cal.head, cal.targets[0].t, 'all').every((t) => t.label === 'all')).toBe(true);
  });
});
