import type { GazeSample, LightingFlag, LineEstimate, LineLayout, PageEndDecision, Sensitivity } from '../../src/types';
import { restoreLayout, type DiagnosticsRecording, type PipelineInput } from '../../src/app/diagnostics';
import { FixationDetector } from '../../src/signal/fixations';
import { LineTracker, type LineTrackerResetOptions } from '../../src/reading/lineTracker';
import { PageEndDetector } from '../../src/reading/pageEndDetector';

/**
 * Replays a tracking-diagnostics recording (src/app/diagnostics.ts) through the
 * current reading layer: the recorded gaze samples and every call the app made
 * into the pipeline, in the original order, into a fresh FixationDetector →
 * LineTracker → PageEndDetector wired exactly like src/app/controller.ts.
 *
 * The replay is open-loop: the page scrolled where the recorded session turned
 * it, so the layouts are the recorded ones. What changes with the modules is
 * where the replayed page-end detector *would* have turned (compared with the
 * recorded turns), which line the tracker believes, and the drift it learns.
 * Replaying with the modules that made the recording reproduces the recorded
 * decisions exactly (src/app/diagnostics.test.ts checks that).
 */

/** What the replay needs from a line tracker (lets a benchmark swap in another one). */
export interface ReplayTracker {
  readonly estimate: LineEstimate | null;
  setLayout(layout: LineLayout, reason: Parameters<LineTracker['setLayout']>[1]): void;
  onFixation: LineTracker['onFixation'];
  onSample: LineTracker['onSample'];
  afterPageTurn(resumeLineIndex: number): void;
  appearanceChangedAt?(t: number): void;
  reset(opts?: LineTrackerResetOptions): void;
}

export interface ReplayOptions {
  /** Line tracker to replay with (default: the current LineTracker). */
  tracker?: () => ReplayTracker;
  /** Override the recorded sensitivity. */
  sensitivity?: Sensitivity;
  /** Ignore the recorded appearance changes (what the reading layer does without the camera's reports). */
  ignoreAppearanceChanges?: boolean;
  /** A replayed trigger within this long of a recorded automatic turn counts as the same turn, ms (default 1500). */
  matchWindowMs?: number;
}

export interface ReplayTrigger {
  t: number;
  reason: PageEndDecision['reason'];
  targetLineIndex: number;
  /** Line the tracker believed, and the last fully visible line, at the trigger. */
  line: number;
  lastLine: number;
}

export interface ReplayResult {
  durationMs: number;
  frames: number;
  /** Camera frames per second, and share with a face. */
  fps: number;
  faceFoundPct: number;
  gazeSamples: number;
  validPct: number;
  /** Share of samples the recorded pipeline consumed (not blocked by a scroll, dialog, calibration). */
  fedPct: number;
  fixations: number;
  /** Replayed fixation estimates with p ≥ 0.8. */
  confidentPct: number;
  /** Replayed per-fixation drift, lines. */
  drift: { medianAbs: number; p90Abs: number; maxAbs: number; overPct: number; final: number };
  /** Agreement with the recorded per-fixation estimates on the line index (NaN when none were recorded). */
  lineAgreementPct: number;
  recordedTurns: { t: number; auto: boolean; reason: string }[];
  replayedTriggers: ReplayTrigger[];
  /** Replayed triggers vs recorded automatic turns. */
  turns: { recordedAuto: number; matched: number; earlier: number; extra: number; missed: number };
  lighting: { states: number; changedTransitions: number; maxDistance: number | null; flags: Partial<Record<LightingFlag, number>> };
  appearanceChanges: Record<string, number>;
  accuracyChecks: { meanErrorPx: number; offsetYLines: number; applied: boolean }[];
  /** Lighting-stat frames, and recorded lid openness spread (robust SD) — for spotting squints. */
  lightingFrames: number;
  opennessMedian: number;
}

const quantile = (xs: readonly number[], q: number): number => {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((p, r) => p - r);
  const i = Math.min(a.length - 1, Math.max(0, (a.length - 1) * q));
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return a[lo]! + (a[hi]! - a[lo]!) * (i - lo);
};

const pct = (n: number, d: number): number => (d > 0 ? (100 * n) / d : NaN);

function lastFullyVisible(layout: LineLayout | null): number {
  if (!layout) return -1;
  for (let i = layout.lines.length - 1; i >= 0; i--) if (layout.lines[i]!.fullyVisible) return i;
  return -1;
}

export function replayRecording(rec: DiagnosticsRecording, opts: ReplayOptions = {}): ReplayResult {
  const fixations = new FixationDetector();
  const tracker: ReplayTracker = opts.tracker ? opts.tracker() : new LineTracker();
  const pageEnd = new PageEndDetector({
    sensitivity: opts.sensitivity ?? rec.settings.sensitivity,
    glanceDownToTurn: rec.settings.glanceDownToTurn,
  });
  let layout: LineLayout | null = null;
  let wasBlocked = false;
  const triggers: ReplayTrigger[] = [];
  const fixEstimates: LineEstimate[] = [];
  /** Line pitch of the layout each fixation estimate was made on. */
  const fixPitch: number[] = [];
  let gazeN = 0;
  let validN = 0;
  let fedN = 0;

  const run = (e: PipelineInput): void => {
    switch (e.k) {
      case 'gaze': {
        gazeN++;
        if (e.v) validN++;
        if (!e.fed) {
          wasBlocked = true;
          return;
        }
        fedN++;
        if (wasBlocked) {
          wasBlocked = false;
          fixations.reset();
        }
        const s: GazeSample = { t: e.t, x: e.x, y: e.y, rawX: e.rx, rawY: e.ry, valid: e.v === 1, confidence: e.c, source: e.src };
        const { completed } = fixations.push(s);
        if (completed) {
          fixEstimates.push(tracker.onFixation(completed));
          fixPitch.push(layout?.linePitch ?? NaN);
        }
        tracker.onSample(s);
        const d = pageEnd.update({ t: s.t, gaze: s, estimate: tracker.estimate, layout });
        if (d.trigger) {
          triggers.push({
            t: s.t,
            reason: d.reason,
            targetLineIndex: d.targetLineIndex,
            line: tracker.estimate?.lineIndex ?? -1,
            lastLine: lastFullyVisible(layout),
          });
        }
        return;
      }
      case 'pipeline-reset':
        fixations.reset();
        pageEnd.reset();
        if (e.full) tracker.reset(e.keepDrift ? { keepDrift: true } : e.calibrated === true ? { calibrated: true } : {});
        wasBlocked = false;
        return;
      case 'fixations-reset':
        fixations.reset();
        if (e.unblock) wasBlocked = false;
        return;
      case 'layout':
        layout = restoreLayout(e.layout);
        tracker.setLayout(layout, e.reason);
        return;
      case 'resume':
        tracker.afterPageTurn(e.line);
        return;
      case 'scrolled':
        pageEnd.notifyScrolled(e.t);
        return;
      case 'page-end-reset':
        pageEnd.reset();
        return;
      case 'configure':
        pageEnd.configure({ sensitivity: opts.sensitivity ?? e.sensitivity, glanceDownToTurn: e.glanceDownToTurn });
        return;
      case 'appearance':
        if (!opts.ignoreAppearanceChanges) tracker.appearanceChangedAt?.(e.at);
        return;
      case 'tracker-reset':
        tracker.reset(e.keepDrift ? { keepDrift: true } : {});
        return;
    }
  };
  for (const e of rec.inputs) run(e);

  // ── Summaries ──
  const driftLines = fixEstimates
    .map((e, i) => (e.lineIndex >= 0 && fixPitch[i]! > 0 ? e.driftY / fixPitch[i]! : NaN))
    .filter(Number.isFinite);
  const absDrift = driftLines.map(Math.abs);

  const recordedFix = rec.estimates.filter((e) => e.fx === 1);
  let agree = 0;
  let compared = 0;
  for (let i = 0, j = 0; i < fixEstimates.length && recordedFix.length > 0; i++) {
    const e = fixEstimates[i]!;
    while (j < recordedFix.length - 1 && recordedFix[j]!.t < e.t - 0.05) j++;
    const r = recordedFix[j]!;
    if (Math.abs(r.t - e.t) <= 0.2) {
      compared++;
      if (r.i === e.lineIndex) agree++;
    }
  }

  const recordedTurns: ReplayResult['recordedTurns'] = [];
  const lighting: ReplayResult['lighting'] = { states: 0, changedTransitions: 0, maxDistance: null, flags: {} };
  const appearanceChanges: Record<string, number> = {};
  const accuracyChecks: ReplayResult['accuracyChecks'] = [];
  let wasChanged = false;
  for (const ev of rec.events) {
    switch (ev.type) {
      case 'page-turn':
        recordedTurns.push({ t: ev.t, auto: ev.data.auto, reason: ev.data.reason });
        break;
      case 'lighting-state': {
        lighting.states++;
        const d = ev.data.distance;
        if (d !== null && Number.isFinite(d)) lighting.maxDistance = Math.max(lighting.maxDistance ?? 0, d);
        for (const f of ev.data.flags) lighting.flags[f] = (lighting.flags[f] ?? 0) + 1;
        if (ev.data.changedSinceCalibration && !wasChanged) lighting.changedTransitions++;
        wasChanged = ev.data.changedSinceCalibration;
        break;
      }
      case 'appearance-changed':
        appearanceChanges[ev.data.reason] = (appearanceChanges[ev.data.reason] ?? 0) + 1;
        break;
      case 'accuracy-check':
        accuracyChecks.push({ meanErrorPx: ev.data.meanErrorPx, offsetYLines: ev.data.offsetYLines, applied: ev.data.applied });
        break;
      default:
        break;
    }
  }

  // Match replayed triggers to recorded automatic turns (the turn's event follows its trigger).
  const window = opts.matchWindowMs ?? 1500;
  const auto = recordedTurns.filter((t) => t.auto);
  const used = new Set<number>();
  let matched = 0;
  let earlier = 0;
  let extra = 0;
  for (const trig of triggers) {
    const k = auto.findIndex((a, i) => !used.has(i) && Math.abs(a.t - trig.t) <= window);
    if (k >= 0) {
      used.add(k);
      matched++;
      continue;
    }
    // Fired well before a recorded turn on the same page (no recorded turn in between): early.
    const next = auto.find((a, i) => !used.has(i) && a.t > trig.t);
    if (next) earlier++;
    else extra++;
  }

  const frames = rec.frames.length;
  const span = frames > 1 ? rec.frames[frames - 1]!.t - rec.frames[0]!.t : 0;
  const openness = rec.frames.map((f) => f.o).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return {
    durationMs: rec.durationMs,
    frames,
    fps: span > 0 ? (1000 * (frames - 1)) / span : NaN,
    faceFoundPct: pct(rec.frames.filter((f) => f.f === 1).length, frames),
    gazeSamples: gazeN,
    validPct: pct(validN, gazeN),
    fedPct: pct(fedN, gazeN),
    fixations: fixEstimates.length,
    confidentPct: pct(fixEstimates.filter((e) => e.probability >= 0.8).length, fixEstimates.length),
    drift: {
      medianAbs: quantile(absDrift, 0.5),
      p90Abs: quantile(absDrift, 0.9),
      maxAbs: absDrift.length > 0 ? Math.max(...absDrift) : NaN,
      overPct: pct(absDrift.filter((d) => d >= 1.5).length, absDrift.length),
      final: driftLines.length > 0 ? driftLines[driftLines.length - 1]! : NaN,
    },
    lineAgreementPct: compared > 0 ? pct(agree, compared) : NaN,
    recordedTurns,
    replayedTriggers: triggers,
    turns: { recordedAuto: auto.length, matched, earlier, extra, missed: auto.length - matched },
    lighting,
    appearanceChanges,
    accuracyChecks,
    lightingFrames: rec.frames.filter((f) => f.l !== undefined).length,
    opennessMedian: quantile(openness, 0.5),
  };
}

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '–');
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '–');

/** A plain-text report of a replay. */
export function formatReplay(r: ReplayResult, title = 'Replay'): string {
  const lines: string[] = [];
  lines.push(`## ${title}`);
  lines.push(`duration ${(r.durationMs / 1000).toFixed(0)} s · ${r.frames} frames (${f1(r.fps)} fps, face ${f1(r.faceFoundPct)} %) · ${r.lightingFrames} lighting measurements`);
  lines.push(`gaze ${r.gazeSamples} samples (valid ${f1(r.validPct)} %, fed to the pipeline ${f1(r.fedPct)} %) · ${r.fixations} fixations (p ≥ 0.8: ${f1(r.confidentPct)} %)`);
  lines.push(
    `drift |lines|: median ${f2(r.drift.medianAbs)}, p90 ${f2(r.drift.p90Abs)}, max ${f2(r.drift.maxAbs)}; ≥ 1.5 lines ${f1(r.drift.overPct)} % of fixations; final ${f2(r.drift.final)}`,
  );
  lines.push(`line agreement with the recorded tracker: ${f1(r.lineAgreementPct)} %`);
  const t = r.turns;
  lines.push(`turns: recorded ${r.recordedTurns.length} (${t.recordedAuto} automatic) · replayed triggers ${r.replayedTriggers.length}: matched ${t.matched}, earlier ${t.earlier}, extra ${t.extra}, recorded-but-not-replayed ${t.missed}`);
  for (const trig of r.replayedTriggers) {
    lines.push(`  trigger t=${(trig.t / 1000).toFixed(1)} s  ${trig.reason}  line ${trig.line} of L=${trig.lastLine}  target ${trig.targetLineIndex}`);
  }
  const flags = Object.entries(r.lighting.flags).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  lines.push(`lighting: ${r.lighting.states} states, max distance ${r.lighting.maxDistance === null ? '–' : f2(r.lighting.maxDistance)}, changed ${r.lighting.changedTransitions}×, flags: ${flags}`);
  const changes = Object.entries(r.appearanceChanges).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  lines.push(`appearance changes: ${changes} · median openness ${f2(r.opennessMedian)}`);
  for (const c of r.accuracyChecks) lines.push(`  accuracy check: ${f1(c.meanErrorPx)} px, y ${f2(c.offsetYLines)} lines${c.applied ? ' (applied)' : ''}`);
  return lines.join('\n');
}
