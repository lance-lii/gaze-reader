import { describe, expect, it } from 'vitest';
import { GAZE_EXCLUDED_FEATURES, trainGazeModel, type TrainOptions } from '../../src/gaze/calibrationModel';
import { FEATURE_NAMES } from '../../src/gaze/features';
import { REAL_FACE_PRIOR } from '../../src/gaze/gazePrior';
import type { GazeModel, Point } from '../../src/types';
import { eottAvailable, eottCase, loadEott, type EottCase, type EottPerson, type EottSample } from './eott';
import { emptyErrors, summarize, table, type Errors, type Row } from './protocol';
import { faceScale, SharedPersonalModel } from './shared';

/**
 * Scoreboard on real people moving their eyes: the app's calibration on the EOTT dot tests (see
 * eott.ts and docs/REAL_DATA.md). One test case per person: calibrate on the clicks of the first
 * dot test, then say where the person is looking during the final dot test. Skipped when the data
 * isn't there. Run with `npm run bench:eott`.
 */
const HEAD = ['yaw', 'pitch', 'roll', 'tx', 'ty', 'tz', 'faceScale'];

interface Predictor {
  predict(s: EottSample): Point | null;
}

interface Config {
  label: string;
  fit: (c: EottCase) => Predictor | null;
  /** Needs the trained network's answers (scripts/research/train_eye_cnn.py): left out when they aren't there. */
  cnn?: boolean;
}

const base = (p: EottPerson): TrainOptions => ({
  viewport: { width: p.screen.widthPx, height: p.screen.heightPx },
  featureNames: FEATURE_NAMES,
  camera: p.camera,
});

function train(cal: readonly EottSample[], options: TrainOptions): GazeModel | null {
  try {
    return trainGazeModel([...cal], options).model;
  } catch {
    return null;
  }
}

const app = (c: EottCase, extra: Partial<TrainOptions> = {}): Predictor | null => {
  const model = train(c.cal, { ...base(c.person), ...extra });
  return model && { predict: (s) => model.predict(s.features) };
};

/** Stands in for a network's id: the bench reads its answers from a file instead of running it. */
const NET_ID = 'eott-held-out';

/** The app's own calibration made on the network's answers, the way the app makes it (TrainOptions.eyeNet). */
function appOnNetwork(c: EottCase, extra: Partial<TrainOptions> = {}): Predictor | null {
  const tag = (s: EottSample): EottSample => (s.frame.cnn ? { ...s, features: { ...s.features, eyeNet: { id: NET_ID, x: s.frame.cnn.x, y: s.frame.cnn.y } } } : s);
  const model = train(c.cal.map(tag), { ...base(c.person), eyeNet: NET_ID, ...extra });
  return model && { predict: (s) => model.predict(tag(s).features) };
}

/** The network's answer fitted to one person with four numbers: screen = camera + (K·answer + c) ÷ face size, per axis. */
function fourNumbers(c: EottCase): Predictor | null {
  const rows = c.cal.filter((s) => s.frame.cnn && s.features.blink <= 0.5 && faceScale(s.features.vector) > 0);
  if (rows.length < 4) return null;
  const cam = c.person.camera;
  const k = [0, 0];
  const b = [0, 0];
  for (const axis of [0, 1]) {
    const x = rows.map((s) => (axis === 0 ? s.frame.cnn!.x : s.frame.cnn!.y));
    const y = rows.map((s) => (axis === 0 ? s.target.x - cam.x : s.target.y - cam.y) * faceScale(s.features.vector));
    const mx = x.reduce((a, v) => a + v, 0) / x.length;
    const my = y.reduce((a, v) => a + v, 0) / y.length;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < x.length; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
    }
    k[axis] = sxy / sxx;
    b[axis] = my - k[axis] * mx;
  }
  if (![...k, ...b].every(Number.isFinite)) return null;
  return {
    predict: (s) => {
      const scale = faceScale(s.features.vector);
      if (!s.frame.cnn || !(scale > 0)) return null;
      return { x: cam.x + (k[0] * s.frame.cnn.x + b[0]) / scale, y: cam.y + (k[1] * s.frame.cnn.y + b[1]) / scale };
    },
  };
}


const CONFIGS: Config[] = [
  { label: 'no tracker: always the middle of the screen', fit: (c) => ({ predict: () => ({ x: c.person.screen.widthPx / 2, y: c.person.screen.heightPx / 2 }) }) },
  { label: 'the app now', fit: (c) => app(c) },
  { label: 'no distance correction', fit: (c) => app(c, { depthCompensation: false }) },
  { label: '1.1: head pose as gaze features', fit: (c) => app(c, { excludedFeatures: [...GAZE_EXCLUDED_FEATURES].filter((n) => !HEAD.includes(n)) }) },
  { label: '1.0: every feature', fit: (c) => app(c, { excludedFeatures: [] }) },
  { label: 'real-face setting (as shipped)', fit: (c) => app(c, { prior: REAL_FACE_PRIOR }) },
  {
    label: 'real-face model + 4 personal numbers',
    fit: (c) => {
      const m = SharedPersonalModel.fit(REAL_FACE_PRIOR, c.cal as never, { width: c.person.screen.widthPx, height: c.person.screen.heightPx }, c.person.camera);
      return m && { predict: (s) => m.predict(s.features) };
    },
  },
  { label: 'eye-picture network + 4 personal numbers', cnn: true, fit: fourNumbers },
  { label: 'eye-picture network, as the app calibrates on it', cnn: true, fit: (c) => appOnNetwork(c) },
  { label: 'the reference eye tracker (not a webcam)', fit: () => ({ predict: (s) => s.frame.reference }) },
];

function score(model: Predictor, test: readonly EottSample[], p: EottPerson, into: Errors): void {
  for (const s of test) {
    const g = model.predict(s);
    if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y)) {
      into.failed++;
      continue;
    }
    const dx = (g.x - s.target.x) * p.mmPerPx;
    const dy = (g.y - s.target.y) * p.mmPerPx;
    const mm = Math.hypot(dx, dy);
    into.mm.push(mm);
    into.deg.push((Math.atan2(mm, p.distanceMm) * 180) / Math.PI);
    into.dyMm.push(Math.abs(dy));
    into.dx.push(dx);
    into.dy.push(dy);
  }
}

function board(cases: readonly EottCase[], truth: 'dot' | 'reference'): Row[] {
  const haveCnn = cases.some((c) => c.test.some((s) => s.frame.cnn));
  const rows: Row[] = [];
  for (const cfg of CONFIGS) {
    if (cfg.cnn && !haveCnn) continue;
    if (truth === 'reference' && cfg.label.startsWith('the reference')) continue;
    const per: Errors[] = [];
    for (const c of cases) {
      const e = emptyErrors();
      const model = cfg.fit(c);
      if (model) score(model, truth === 'dot' ? c.test : c.testReference, c.person, e);
      per.push(e);
    }
    rows.push(summarize(cfg.label, per));
  }
  return rows;
}

const pct = (x: number): string => `${x >= 0 ? '+' : ''}${(100 * (Math.exp(x) - 1)).toFixed(0)} %`;

describe.skipIf(!eottAvailable())('real people moving their eyes: EOTT dot tests (scoreboard)', () => {
  it('what the test cases are', () => {
    const people = loadEott();
    const lines = people.map((p) => {
      const c = eottCase(p);
      const s = p.sessions.map((x) => `${x.name} ${x.frames - x.noFace}/${x.frames} frames, ${x.clicks.length} clicks, ${x.dots.length} dots, lag ${x.lagMs ?? '?'} ms (r ${x.lagCorrelation ?? '?'}), face ${x.light ? x.light.face.toFixed(0) : '?'}`).join('; ');
      const verdict = c ? `${c.cal.length} calibration + ${c.test.length} test frames, light ${c.light!.same ? 'same' : 'CHANGED'} (brightness ${pct(c.light!.brightness)}, balance ${pct(c.light!.balance)}), ${c.droppedForLight} frames dropped for flicker` : 'NO TEST CASE';
      return `${p.id} ${p.setting}, ${p.distanceMm.toFixed(0)} mm: ${verdict}\n    ${s}`;
    });
    console.log(`\n${lines.join('\n')}\n`);
    expect(people.length).toBeGreaterThan(0);
  });

  it('calibrated on the clicks, tested on the final dot test', () => {
    const people = loadEott();
    const gated = people.map((p) => eottCase(p)).filter((c): c is EottCase => !!c);
    const same = gated.filter((c) => c.light!.same);
    const changed = gated.filter((c) => !c.light!.same);
    const all = people.map((p) => eottCase(p, false)).filter((c): c is EottCase => !!c);
    console.log(table(`SAME LIGHT (${same.length} people): against the dots`, board(same, 'dot')));
    console.log(table(`SAME LIGHT (${same.length} people): against the reference eye tracker`, board(same, 'reference')));
    if (changed.length) console.log(table(`LIGHT CHANGED between calibration and test (${changed.length} people: ${changed.map((c) => c.person.id).join(', ')}): against the dots`, board(changed, 'dot')));
    console.log(table(`EVERYONE, no lighting gate (${all.length} people): against the dots`, board(all, 'dot')));
    for (const setting of [...new Set(same.map((c) => c.person.setting))]) {
      const group = same.filter((c) => c.person.setting === setting);
      console.log(table(`SAME LIGHT, ${setting} only (${group.length} people): against the dots`, board(group, 'dot')));
    }
    expect(same.length).toBeGreaterThan(0);
  });
});
