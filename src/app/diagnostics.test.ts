import { describe, expect, it, vi } from 'vitest';
import type { FeatureFrame, GazeModel, GazeSample, LineLayout, PageEndDecision } from '../types';
import { DEFAULT_SETTINGS } from '../core/settings';
import { FixationDetector } from '../signal/fixations';
import { LineTracker } from '../reading/lineTracker';
import { PageEndDetector } from '../reading/pageEndDetector';
import { simulateReading } from '../reading/simulatedReader';
import { lastFullyVisibleIndex, makeDocument } from '../reading/testLayouts';
import { replayRecording } from '../../bench/replay/replay';
import {
  DIAGNOSTICS_FORMAT,
  DiagnosticsRecorder,
  cameraSettings,
  parseRecording,
  recordLayout,
  recordingFileName,
  restoreLayout,
  type DiagnosticsEnvironment,
  type DiagnosticsRecording,
} from './diagnostics';
import { resumeLineIndex } from './logic';

const ENV: DiagnosticsEnvironment = {
  userAgent: 'test',
  screen: null,
  devicePixelRatio: 1,
  viewport: { width: 1024, height: 900 },
  chromeTop: null,
  hardwareConcurrency: 8,
  camera: null,
  lightingBackend: 'copy',
};

function recorder(clock: { t: number }, opts: { limitMs?: number; onLimit?: () => void } = {}): DiagnosticsRecorder {
  return new DiagnosticsRecorder({ now: () => clock.t, wallClock: () => Date.UTC(2026, 8, 25, 14, 12), ...opts });
}

function start(r: DiagnosticsRecorder, model: GazeModel | null = null): void {
  r.start({ settings: DEFAULT_SETTINGS, environment: ENV, featureNames: ['a', 'b'], model, report: null });
}

const frame = (t: number): FeatureFrame => ({
  t,
  faceFound: true,
  quality: 0.87654,
  features: {
    vector: [0.1234567, -2.5],
    headPose: { yaw: 0.01, pitch: -0.2, roll: 0, tx: 1, ty: 2, tz: -50 },
    blink: 0.1,
    openness: 0.31234567,
    squint: 0.2,
    faceScale: 0.12,
    faceCenter: { x: 0.5, y: 0.45 },
  },
  lighting: {
    faceLuma: 0.5, faceLin: 0.2, faceRange: 1.23456, faceClip: 0, frameLin: 0.2, bgLin: 0.1, bgClip: 0,
    scleraR: 0.4, scleraL: 0.41, backlight: 0.2, side: 0.1, shade: -0.3, glareR: 0, glareL: 0.001,
    irisGlintR: 0, irisGlintL: 0, facePx: 12345.6,
  },
});

describe('DiagnosticsRecorder', () => {
  it('records nothing until started, and compact rounded numbers once it is', () => {
    const clock = { t: 1000 };
    const r = recorder(clock);
    r.frame(frame(1000));
    r.gaze({ t: 1000, x: 1, y: 2, rawX: 1, rawY: 2, valid: true, confidence: 1, source: 'webcam' }, true);
    expect(r.hasData).toBe(false);
    expect(r.toJSON()).toBeNull();

    start(r);
    clock.t = 1500;
    r.frame(frame(1500));
    r.gaze({ t: 1500.04, x: 100.049, y: 200.06, rawX: 99, rawY: 201, valid: true, confidence: 0.91234, source: 'webcam' }, false);
    r.input({ k: 'scrolled', t: 1600.123 });
    const rec = r.toJSON()!;
    expect(rec.format).toBe(DIAGNOSTICS_FORMAT);
    expect(rec.startedAt).toBe('2026-09-25T14:12:00.000Z');
    expect(rec.durationMs).toBe(500);
    const f = rec.frames[0]!;
    expect(f).toMatchObject({ t: 1500, f: 1, q: 0.877, b: 0.1, o: 0.31235, s: 0.2, v: [0.12346, -2.5], fs: 0.12, fc: [0.5, 0.45] });
    expect(f.l?.faceRange).toBe(1.2346);
    expect(f.l?.facePx).toBe(12346);
    expect(f.l?.frameLin).toBe(0.2); // whole-frame exposure stays
    // The face's own brightness depends on skin tone: live coaching only, never recorded.
    expect(f.l).not.toHaveProperty('faceLuma');
    expect(f.l).not.toHaveProperty('faceLin');
    expect(JSON.stringify(rec)).not.toMatch(/faceLuma|faceLin/);
    expect(rec.inputs).toEqual([
      { k: 'gaze', t: 1500, x: 100, y: 200.1, rx: 99, ry: 201, v: 1, c: 0.912, src: 'webcam', fed: 0 },
      { k: 'scrolled', t: 1600.1 },
    ]);
    // Never pixels, never anything the book says.
    expect(JSON.stringify(rec)).not.toMatch(/data:|base64|title/i);
  });

  it('stops by itself at the time limit, once', () => {
    const clock = { t: 0 };
    const onLimit = vi.fn();
    const r = recorder(clock, { limitMs: 10_000, onLimit });
    start(r);
    clock.t = 9_999;
    expect(r.tick()).toBe(false);
    r.input({ k: 'page-end-reset', t: 9_999 });
    clock.t = 10_000;
    r.input({ k: 'page-end-reset', t: 10_000 }); // the check runs on every record
    expect(r.recording).toBe(false);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(r.tick()).toBe(false);
    const rec = r.toJSON()!;
    expect(rec.stoppedBy).toBe('limit');
    expect(rec.inputs).toHaveLength(1);
    expect(rec.durationMs).toBe(10_000);
    clock.t = 20_000;
    expect(r.elapsedMs).toBe(10_000); // frozen once stopped
  });

  it('keeps the model and settings changes, and forgets everything on discard', () => {
    const clock = { t: 0 };
    const r = recorder(clock);
    const model: GazeModel = { predict: () => null, viewport: { width: 1, height: 1 }, trainedAt: 5, toJSON: () => ({ version: 1, kind: 'x' }) };
    start(r, model);
    r.model(null, null, 10);
    r.settingsChanged({ sensitivity: 'eager' }, 20);
    r.event('appearance-changed', { t: 30, reason: 'lids', detail: 'narrower' }, 31);
    const rec = r.toJSON()!;
    expect(rec.models.map((m) => m.model?.kind ?? null)).toEqual(['x', null]);
    expect(rec.settingsChanges).toEqual([{ t: 20, changed: { sensitivity: 'eager' } }]);
    expect(rec.events).toEqual([{ t: 31, type: 'appearance-changed', data: { t: 30, reason: 'lids', detail: 'narrower' } }]);
    r.discard();
    expect(r.hasData).toBe(false);
  });

  it('marks a recording truncated instead of growing without bound', () => {
    const clock = { t: 0 };
    const r = recorder(clock);
    start(r);
    for (let i = 0; i < 40_010; i++) r.frame(frame(i));
    const rec = r.toJSON()!;
    expect(rec.frames).toHaveLength(40_000);
    expect(rec.truncated).toBe(true);
  });
});

describe('recording format', () => {
  it('layouts survive the round trip (at 0.1 px)', () => {
    const layout = makeDocument({ lines: 30, seed: 3 }).layoutAt(120);
    const back = restoreLayout(recordLayout(layout));
    expect(back.lines).toHaveLength(layout.lines.length);
    back.lines.forEach((l, i) => {
      const o = layout.lines[i]!;
      expect(l.index).toBe(i);
      expect(l.fullyVisible).toBe(o.fullyVisible);
      for (const k of ['top', 'bottom', 'left', 'right', 'centerY', 'docTop'] as const) expect(Math.abs(l[k] - o[k])).toBeLessThanOrEqual(0.05);
    });
    expect(back.linePitch).toBeCloseTo(layout.linePitch, 3);
  });

  it('parseRecording accepts a recording and rejects anything else', () => {
    const clock = { t: 0 };
    const r = recorder(clock);
    start(r);
    const json = JSON.parse(JSON.stringify(r.toJSON())) as unknown;
    expect(parseRecording(json)).not.toBeNull();
    for (const bad of [null, 1, 'x', {}, { ...(json as object), format: 'other' }, { ...(json as object), version: 2 }, { ...(json as object), inputs: [{}] }]) {
      expect(parseRecording(bad)).toBeNull();
    }
  });

  it('keeps camera settings, never device ids', () => {
    const track = {
      label: 'Integrated Webcam (0bda:5634)',
      getSettings: () => ({ width: 640, height: 480, frameRate: 30, deviceId: 'secret', groupId: 'secret2', exposureMode: 'continuous', whiteBalanceMode: 'continuous', resizeMode: 'none', brightness: Number.NaN }),
    } as unknown as MediaStreamTrack;
    const s = cameraSettings(track)!;
    expect(s).toEqual({ width: 640, height: 480, frameRate: 30, exposureMode: 'continuous', whiteBalanceMode: 'continuous', resizeMode: 'none', label: 'Integrated Webcam (0bda:5634)' });
    expect(cameraSettings(null)).toBeNull();
  });

  it('names files by local time', () => {
    expect(recordingFileName(new Date(2026, 8, 5, 7, 3))).toBe('gaze-reader-diagnostics-2026-09-05-0703.json');
  });
});

// ─────────────────────── Replay: a recording reproduces the session ───────────────────────

const r1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * A three-page session wired like the controller (src/app/controller.ts): gaze → fixations →
 * line tracker → page-end detector; a trigger scrolls the anchor line to the top, the tracker is
 * told the resume line, samples during the 400-ms scroll are not fed, and the camera reports an
 * appearance change on page 2. Every input goes through the recorder. Inputs are at the
 * recorder's precision (0.1), so the replay must match the session exactly.
 */
function recordedSession(seed: number): { rec: DiagnosticsRecording; triggers: { t: number; decision: PageEndDecision }[]; lines: number[] } {
  const clock = { t: 0 };
  const rec = recorder(clock);
  start(rec);
  const doc = makeDocument({ lines: 90, seed });
  const fixations = new FixationDetector();
  const tracker = new LineTracker();
  const pageEnd = new PageEndDetector({ sensitivity: 'balanced', glanceDownToTurn: true });
  const triggers: { t: number; decision: PageEndDecision }[] = [];
  const lines: number[] = [];
  let scrollTop = 0;
  let t = 0;
  let resume = -1;
  let blockedUntil = -Infinity;
  let wasBlocked = false;
  const measure = (reason: 'initial' | 'page-turn'): LineLayout => {
    const layout = restoreLayout(recordLayout(doc.layoutAt(scrollTop, { measuredAt: t })));
    tracker.setLayout(layout, reason);
    rec.layout(layout, reason, t);
    return layout;
  };
  let layout = measure('initial');
  rec.input({ k: 'pipeline-reset', t, full: true, keepDrift: false });
  for (let page = 0; page < 3; page++) {
    const last = lastFullyVisibleIndex(layout);
    const sim = simulateReading(layout, {
      seed: seed * 10 + page,
      t0: t,
      wpm: 320,
      noisePx: 28,
      driftPx: 50,
      driftOnset: 'immediate',
      blinksPerMin: 10,
      startLine: resume >= 0 ? resume : undefined,
      lingerMs: 4000,
    });
    let turned = false;
    for (const raw of sim.samples) {
      const s: GazeSample = { ...raw, t: r1(raw.t), x: r1(raw.x), y: r1(raw.y), rawX: r1(raw.rawX), rawY: r1(raw.rawY), confidence: Math.round(raw.confidence * 1000) / 1000, source: 'webcam' };
      clock.t = s.t;
      t = s.t;
      if (page === 1 && s.t > sim.samples[0]!.t + 8000 && !lines.includes(-99)) {
        lines.push(-99); // marker: the appearance change happened
        tracker.appearanceChangedAt(s.t - 500);
        rec.input({ k: 'appearance', t: s.t, at: s.t - 500 });
      }
      if (s.t < blockedUntil) {
        wasBlocked = true;
        rec.gaze(s, false);
        continue;
      }
      rec.gaze(s, true);
      if (wasBlocked) {
        wasBlocked = false;
        fixations.reset();
      }
      const { completed } = fixations.push(s);
      if (completed) {
        const e = tracker.onFixation(completed);
        rec.estimate(e, true);
        lines.push(e.lineIndex);
      }
      tracker.onSample(s);
      const d = pageEnd.update({ t: s.t, gaze: s, estimate: tracker.estimate, layout });
      if (d.trigger && !turned) {
        triggers.push({ t: s.t, decision: d });
        turned = true;
        const target = d.targetLineIndex >= 0 ? d.targetLineIndex : last;
        const oldDocTop = layout.lines[target]?.docTop ?? null;
        scrollTop = Math.max(0, (layout.lines[target]?.docTop ?? scrollTop) - 0.35 * doc.pitch);
        blockedUntil = s.t + 400;
        layout = measure('page-turn');
        resume = resumeLineIndex(layout.lines, oldDocTop, layout.linePitch);
        if (resume >= 0) {
          tracker.afterPageTurn(resume);
          rec.input({ k: 'resume', t: s.t, line: resume });
        }
        pageEnd.notifyScrolled(s.t);
        rec.input({ k: 'scrolled', t: s.t });
        fixations.reset();
        rec.input({ k: 'fixations-reset', t: s.t, unblock: false });
      }
    }
    if (!turned) break;
  }
  rec.stop();
  return { rec: rec.toJSON()!, triggers, lines: lines.filter((l) => l !== -99) };
}

describe('replay (bench/replay)', () => {
  it('reproduces the recorded session exactly with the same modules', () => {
    const { rec, triggers, lines } = recordedSession(4);
    expect(triggers.length).toBeGreaterThanOrEqual(2);
    // Through JSON, as a downloaded file would be.
    const parsed = parseRecording(JSON.parse(JSON.stringify(rec)) as unknown)!;
    const out = replayRecording(parsed);
    expect(out.replayedTriggers.map((x) => x.t)).toEqual(triggers.map((x) => x.t));
    expect(out.replayedTriggers.map((x) => x.reason)).toEqual(triggers.map((x) => x.decision.reason));
    expect(out.fixations).toBe(lines.length);
    expect(out.lineAgreementPct).toBe(100);
    expect(out.fedPct).toBeLessThan(100);
    expect(out.drift.medianAbs).toBeGreaterThan(0.5); // the 50-px bias was learned (≈ 1.2 lines)
  });

  it('shows what the reading layer does without the camera’s appearance report', () => {
    const { rec } = recordedSession(4);
    const out = replayRecording(rec, { ignoreAppearanceChanges: true });
    expect(out.fixations).toBeGreaterThan(50);
    expect(Number.isFinite(out.lineAgreementPct)).toBe(true);
  });
});
