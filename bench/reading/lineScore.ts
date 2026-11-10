/**
 * The line tracker's own errors, scored end to end: the simulated reader of bench/endtoend (webcam
 * landmarks → gaze → fixations → line tracker), every reading fixation compared with the line the
 * reader really fixated. Page-turn outcomes depend on the page-end detector too; these numbers
 * don't, so they say whether the tracker picks the right line.
 *
 * Also scored: the pill's "Unsure of your line" (LineConfidenceWatch, fed every fixation's
 * estimate and started over with the reading layer, as the app does). It should be up where the
 * tracker is lost and rarely otherwise, and the pages a reader has to turn by hand should mostly
 * be missed while it says so.
 */
import { lastFullyVisibleIndex } from '../../src/app/logic';
import { LineConfidenceWatch } from '../../src/reading/lineConfidence';
import type { LineTracker } from '../../src/reading/lineTracker';
import { runSession, summarize, type RigFixation } from '../endtoend/rig';
import type { Scenario } from '../endtoend/world';

/** "Sure" of its line: the tracker's probability on it. */
export const SURE = 0.8;
/** The balanced preset's θp: this much on the last line or below lets the line-tracker rule turn the page. */
const END_POSTERIOR = 0.55;

export interface LineScore {
  scenario: string;
  hours: number;
  /** Reading fixations scored (the tracker had a line, the reader was on a visible one). */
  fixations: number;
  onLinePct: number;
  wrongLinePct: number;
  /** Wrong while sure of itself (probability ≥ SURE), % of fixations. */
  sureWrongPct: number;
  /** Fixations an hour with ≥ θp on the last line or below while the reader is 2+ lines above it: the early-turn kind. */
  endWrongPerHour: number;
  /** Tracker line − true line, % of fixations: −4 (or less) … +4 (or more). */
  offsetPct: number[];
  /** "Unsure of your line" shown, % of the fixations scored; the tracker on the line while it was shown, and while it wasn't, %. */
  unsurePct: number;
  onLineUnsurePct: number;
  onLineSurePct: number;
  /** Times an hour it came on. */
  unsurePerHour: number;
  /** Pages missed (turned by hand) while it was shown, % of the missed pages. */
  missedUnsurePct: number;
  /** Page-turn outcomes of the same sessions, for reference. */
  pages: number;
  falsePerHour: number;
  missedPct: number;
  falseCauses: Record<string, number>;
}

export interface LineScoreOptions {
  minutes?: number;
  tracker?: () => LineTracker;
}

export function scoreLineTracker(scenario: Scenario, seeds: readonly number[], opts: LineScoreOptions = {}): LineScore {
  let n = 0;
  let on = 0;
  let sureWrong = 0;
  let endWrong = 0;
  let unsure = 0;
  let onUnsure = 0;
  let episodes = 0;
  let missed = 0;
  let missedUnsure = 0;
  const bins = new Array<number>(9).fill(0);
  let watch = new LineConfidenceWatch();
  /** When the watch's answer changed, this session: [t, unsure]. */
  let changes: [number, boolean][] = [];
  const note = (t: number): void => {
    const last = changes.at(-1)?.[1] ?? false;
    if (watch.unsure === last) return;
    changes.push([t, watch.unsure]);
    if (watch.unsure) episodes++;
  };
  const onReset = (t: number): void => {
    watch.reset();
    note(t);
  };
  const onFixation = (f: RigFixation): void => {
    watch.push(f.estimate);
    note(f.estimate.t);
    if (f.mode !== 'reading' || f.trueIndex < 0 || f.estimate.lineIndex < 0) return;
    const e = f.estimate;
    const off = e.lineIndex - f.trueIndex;
    n++;
    if (watch.unsure) {
      unsure++;
      if (off === 0) onUnsure++;
    }
    if (off === 0) on++;
    else if (e.probability >= SURE) sureWrong++;
    bins[Math.max(-4, Math.min(4, off)) + 4]!++;
    const L = lastFullyVisibleIndex(f.layout.lines);
    let pEnd = 0;
    for (let j = Math.max(0, L); j < e.posterior.length; j++) pEnd += e.posterior[j]!;
    if (pEnd >= END_POSTERIOR && f.trueIndex <= L - 2) endWrong++;
  };
  const runs = seeds.map((seed) => {
    watch = new LineConfidenceWatch();
    changes = [];
    const m = runSession(scenario, seed, {
      onFixation,
      onReset,
      ...(opts.minutes !== undefined ? { minutes: opts.minutes } : {}),
      ...(opts.tracker ? { tracker: opts.tracker } : {}),
    });
    for (const turn of m.turns) {
      if (turn.kind !== 'missed') continue;
      missed++;
      // What the pill said just before the reader gave up and turned it.
      let shown = false;
      for (const [t, u] of changes) {
        if (t > turn.t) break;
        shown = u;
      }
      if (shown) missedUnsure++;
    }
    return m;
  });
  const s = summarize(runs);
  const pct = (v: number): number => (n ? (100 * v) / n : NaN);
  const share = (a: number, b: number): number => (b ? (100 * a) / b : NaN);
  return {
    scenario: scenario.name,
    hours: s.hours,
    fixations: n,
    onLinePct: pct(on),
    wrongLinePct: pct(n - on),
    sureWrongPct: pct(sureWrong),
    endWrongPerHour: endWrong / s.hours,
    offsetPct: bins.map(pct),
    unsurePct: pct(unsure),
    onLineUnsurePct: share(onUnsure, unsure),
    onLineSurePct: share(on - onUnsure, n - unsure),
    unsurePerHour: episodes / s.hours,
    missedUnsurePct: share(missedUnsure, missed),
    pages: s.pages,
    falsePerHour: s.falsePerHour,
    missedPct: s.missedPct,
    falseCauses: s.falseCauses,
  };
}

const f1 = (v: number, d = 1): string => (Number.isFinite(v) ? v.toFixed(d) : '–');

export function lineScoreTable(rows: readonly LineScore[]): string {
  const head = [
    'scenario',
    'hours',
    'on line %',
    'wrong %',
    'sure & wrong %',
    'end-wrong /h',
    'off by 1 / 2–3 / 4+ %',
    'unsure shown %',
    'on line: shown / not %',
    'unsure /h',
    'missed while shown %',
    'unintended turns /h',
    'missed %',
  ];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const r of rows) {
    const o = r.offsetPct;
    const by1 = o[3]! + o[5]!;
    const by23 = o[1]! + o[2]! + o[6]! + o[7]!;
    const by4 = o[0]! + o[8]!;
    lines.push(
      `| ${[
        r.scenario,
        f1(r.hours),
        f1(r.onLinePct),
        f1(r.wrongLinePct),
        f1(r.sureWrongPct),
        f1(r.endWrongPerHour, 0),
        `${f1(by1)} / ${f1(by23)} / ${f1(by4)}`,
        f1(r.unsurePct),
        `${f1(r.onLineUnsurePct)} / ${f1(r.onLineSurePct)}`,
        f1(r.unsurePerHour),
        f1(r.missedUnsurePct),
        f1(r.falsePerHour, 2),
        f1(r.missedPct),
      ].join(' | ')} |`,
    );
  }
  return lines.join('\n');
}
