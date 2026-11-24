// The live accuracy test's scoring, on sessions played by the face simulator.
import { describe, expect, it } from 'vitest';
import { SIM_EYE_NET, simulatedSession } from '../bench/live/simSession';
import {
  DEFAULT_VARIANT,
  EYE_NET_VARIANT,
  POSTURES,
  REAL_FACE_VARIANT,
  TEST_TARGETS,
  VARIANTS,
  accuracyRecordingFileName,
  compareVariants,
  featuresOf,
  formatPooled,
  formatScores,
  median,
  parseRecording,
  poolComparisons,
  scoreRecording,
  signTest,
  type AccuracyRecording,
} from '../src/gaze/accuracyTest';
import { REAL_FACE_PRIOR } from '../src/gaze/gazePrior';
import { STANDARD_TARGETS } from '../src/ui/calibrationOverlay';

const clone = (rec: AccuracyRecording): AccuracyRecording => JSON.parse(JSON.stringify(rec)) as AccuracyRecording;

describe('accuracy test: the plan', () => {
  it('tests on dots the calibration never showed', () => {
    for (const t of TEST_TARGETS) {
      expect(STANDARD_TARGETS.some((c) => Math.hypot(c.x - t.x, c.y - t.y) < 0.02)).toBe(false);
    }
  });

  it('starts and ends in the calibration posture, with the moved ones between', () => {
    expect(POSTURES[0].moved).toBe(false);
    expect(POSTURES[POSTURES.length - 1].moved).toBe(false);
    expect(POSTURES.filter((p) => p.moved).length).toBe(3);
  });
});

/** The calibrations every recording is scored for: the eye-picture network's needs a recording that carries its answers. */
const PLAIN = VARIANTS.filter((v) => !v.needsEyeNet);

describe('accuracy test: scoring a session', () => {
  const rec = simulatedSession(11);
  const scores = scoreRecording(rec, { prior: REAL_FACE_PRIOR });
  const of = (id: string) => {
    const v = scores.variants.find((x) => x.id === id);
    if (!v) throw new Error(`no variant ${id}`);
    return v;
  };

  it('scores every variant on every test dot', () => {
    expect(scores.variants.map((v) => v.id)).toEqual(PLAIN.map((v) => v.id));
    for (const v of scores.variants) {
      expect(v.ok, `${v.id}: ${v.problem ?? ''}`).toBe(true);
      expect(v.dots.length).toBe(POSTURES.length * TEST_TARGETS.length);
      expect(v.overall.scored).toBe(v.dots.length);
      expect(v.postures.map((p) => p.posture)).toEqual(POSTURES.map((p) => p.id));
      expect(Number.isFinite(v.overall.medianErrorPx)).toBe(true);
      expect(v.moved.dots).toBe(3 * TEST_TARGETS.length);
    }
  });

  it('finds the default accurate while the reader sits still', () => {
    const still = of(DEFAULT_VARIANT).postures[0].score;
    expect(still.medianErrorPx).toBeLessThan(80);
    expect(still.medianVerticalLines).toBeCloseTo(still.medianVerticalPx / rec.linePitchPx, 9);
    // The simulated reader misses each dot by about half a line, so only some dots land on the line.
    expect(still.onLine).toBeGreaterThan(0.2);
    expect(still.onLine).toBeLessThanOrEqual(1);
  });

  it('fits the head-movement step where the app does, and only there', () => {
    expect(of(DEFAULT_VARIANT).headStep).toBe('learned');
    expect(of('no-head-step').headStep).toBe('not used');
    expect(of('v1.0').headStep).toBe('not used');
    // The step changes the answer once the head has turned.
    const turned = (id: string): number => of(id).postures[1].score.medianErrorPx;
    expect(turned(DEFAULT_VARIANT)).not.toBeCloseTo(turned('no-head-step'), 3);
  });

  it('compares each other variant with the default, dot by dot', () => {
    expect(scores.comparisons.map((c) => c.b)).toEqual(PLAIN.slice(1).map((v) => v.id));
    for (const c of scores.comparisons) {
      expect(c.a).toBe(DEFAULT_VARIANT);
      expect(c.dots).toBe(45);
      expect(c.aCloser + c.bCloser).toBeLessThanOrEqual(c.dots);
      expect(c.p).toBeGreaterThan(0);
      expect(c.p).toBeLessThanOrEqual(1);
    }
    const self = compareVariants(of(DEFAULT_VARIANT), of(DEFAULT_VARIANT));
    expect([self.aCloser, self.bCloser, self.medianGainPx, self.p]).toEqual([0, 0, 0, 1]);
  });

  it('gives the same scores for the recording read back from its file', () => {
    const parsed = parseRecording(JSON.parse(JSON.stringify(rec)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(scoreRecording(parsed.recording, { prior: REAL_FACE_PRIOR })).toEqual(scores);
  });

  it('leaves the real-face model out without its weights', () => {
    const plain = scoreRecording(rec);
    expect(plain.variants.some((v) => v.id === REAL_FACE_VARIANT)).toBe(false);
    expect(plain.verdict).toContain('The real-face model was not scored');
    expect(scoreRecording(rec, { only: [DEFAULT_VARIANT] }).variants.length).toBe(1);
  });

  it('prints a table with every variant and the verdict', () => {
    const text = formatScores(scores);
    for (const v of PLAIN) expect(text).toContain(v.label);
    for (const p of POSTURES) expect(text).toContain(p.short);
    expect(text).toContain('Against the default, dot by dot');
    expect(text.endsWith(scores.verdict)).toBe(true);
    expect(scores.verdict).toMatch(/clearly better|clearly worse|no clear difference/);
    expect(scores.warnings).toEqual([]);
  });
});

describe('accuracy test: sessions that went wrong', () => {
  it('says which postures a session that stopped early is missing', () => {
    const scores = scoreRecording(simulatedSession(5, { skip: ['low', 'again'] }));
    expect(scores.variants[0].dots.length).toBe(3 * TEST_TARGETS.length);
    expect(scores.warnings.join(' ')).toContain('stopped early: no dots for sitting lower, back to start');
  });

  it('does not score a dot the face was lost on, and says so', () => {
    const rec = clone(simulatedSession(5));
    const block = rec.blocks.find((b) => b.kind === 'test');
    if (!block) throw new Error('no test block');
    block.trials[0].frames.length = 3;
    for (const f of block.trials[1].frames) f.e[0] = 1; // eyes closed throughout
    const scores = scoreRecording(rec);
    expect(scores.variants[0].overall.scored).toBe(scores.variants[0].overall.dots - 2);
    expect(scores.variants[0].dots[0].prediction).toBeNull();
    expect(scores.warnings.join(' ')).toContain('2 of 45 test dots have too few frames');
  });

  it('warns when the window moved or the head step taught nothing', () => {
    const rec = clone(simulatedSession(5));
    rec.windowOrigin.end = { x: 40, y: 0 };
    rec.blocks = rec.blocks.filter((b) => b.kind !== 'head');
    const scores = scoreRecording(rec);
    expect(scores.warnings.join(' ')).toContain('The window moved during the session');
    expect(scores.warnings.join(' ')).toContain('Head-movement step: not recorded');
    expect(scores.variants[0].ok).toBe(true);
  });

  it('reports a calibration that cannot be fitted instead of throwing', () => {
    const rec = clone(simulatedSession(5));
    for (const b of rec.blocks) if (b.kind === 'calibrate') b.trials.length = 1;
    const scores = scoreRecording(rec);
    expect(scores.variants.every((v) => !v.ok && typeof v.problem === 'string')).toBe(true);
    expect(scores.verdict).toContain('could not be scored');
    expect(() => formatScores(scores)).not.toThrow();
  });
});

describe('accuracy test: reading a recording file', () => {
  const good = (): Record<string, unknown> => clone(simulatedSession(3, { perDot: 10 })) as unknown as Record<string, unknown>;

  it('accepts its own recordings', () => {
    expect(parseRecording(good()).ok).toBe(true);
  });

  it.each([
    ['another file', () => ({ hello: 'world' }), 'not a Gaze Reader accuracy test'],
    ['not an object', () => 'text', 'not a Gaze Reader accuracy test'],
    ['a later format', () => ({ ...good(), version: 2 }), 'format 2'],
    ['other eye features', () => ({ ...good(), featureNames: ['a', 'b'] }), 'different set of eye features'],
    ['no window size', () => ({ ...good(), viewport: { width: 0, height: 800 } }), 'no usable window size'],
    ['no camera', () => ({ ...good(), camera: null }), 'where the window and camera were'],
    ['no header', () => ({ ...good(), linePitchPx: 'x' }), 'missing its header'],
    ['an unknown block', () => ({ ...good(), blocks: [{ kind: 'dance', trials: [] }] }), 'unknown kind (dance)'],
    ['an unknown posture', () => ({ ...good(), blocks: [{ kind: 'test', posture: 'upside-down', trials: [] }] }), 'unknown posture (upside-down)'],
    ['a short feature vector', () => ({ ...good(), blocks: [{ kind: 'calibrate', trials: [{ target: { x: 1, y: 1 }, frames: [{ t: 0, q: 1, v: [1], h: [0, 0, 0, 0, 0, 0], e: [0, 0, 0, 0, 0] }] }] }] }), 'a frame is damaged'],
    ['a dot without a place', () => ({ ...good(), blocks: [{ kind: 'calibrate', trials: [{ frames: [] }] }] }), 'missing its place'],
  ])('refuses %s', (_name, make, problem) => {
    const parsed = parseRecording(make());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toContain(problem);
  });
});

describe('accuracy test: several sessions together', () => {
  const sessions = [scoreRecording(simulatedSession(11), { prior: REAL_FACE_PRIOR }), scoreRecording(simulatedSession(12, { skip: ['again'] }), { prior: REAL_FACE_PRIOR })];

  it('compares over every dot of every session', () => {
    const pooled = poolComparisons(sessions);
    expect(pooled.map((c) => c.b)).toEqual(PLAIN.filter((v) => v.id !== DEFAULT_VARIANT).map((v) => v.id));
    for (const c of pooled) {
      const each = sessions.map((s) => s.comparisons.find((x) => x.b === c.b));
      expect(c.dots).toBe(each.reduce((n, x) => n + (x?.dots ?? 0), 0));
      expect(c.aCloser).toBe(each.reduce((n, x) => n + (x?.aCloser ?? 0), 0));
      expect(c.bCloser).toBe(each.reduce((n, x) => n + (x?.bCloser ?? 0), 0));
      expect(c.p).toBeCloseTo(signTest(c.aCloser, c.bCloser), 12);
    }
    expect(pooled[0].dots).toBe((POSTURES.length + POSTURES.length - 1) * TEST_TARGETS.length);
  });

  it('one session pooled is that session', () => {
    expect(poolComparisons([sessions[0]])).toEqual(sessions[0].comparisons);
  });

  it('leaves out a variant that was not scored', () => {
    const without = scoreRecording(simulatedSession(11));
    expect(poolComparisons([without]).some((c) => c.b === REAL_FACE_VARIANT)).toBe(false);
    expect(poolComparisons([])).toEqual([]);
  });

  it('prints one column per session and one line per comparison', () => {
    const text = formatPooled(sessions);
    expect(text).toContain('2 sessions together');
    for (const v of PLAIN) expect(text).toContain(v.label);
    expect(text).toMatch(/Real-face model\s+closer on \d+ of 81 dots/);
  });
});

describe('accuracy test: the file name', () => {
  it('carries the local date and time of the session', () => {
    expect(accuracyRecordingFileName(new Date(2026, 10, 23, 14, 5).toISOString())).toBe('gaze-reader-accuracy-2026-11-23-1405.json');
    expect(accuracyRecordingFileName('nonsense')).toMatch(/^gaze-reader-accuracy-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  });
});

describe('accuracy test: the arithmetic', () => {
  it('takes medians, ignoring what is not a number', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([NaN, 5])).toBe(5);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('runs the sign test', () => {
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(5, 5)).toBe(1);
    expect(signTest(10, 0)).toBeCloseTo(2 / 1024, 12);
    expect(signTest(0, 10)).toBeCloseTo(2 / 1024, 12);
    // 2 * (C(12,0) + C(12,1) + C(12,2)) / 2^12
    expect(signTest(10, 2)).toBeCloseTo((2 * (1 + 12 + 66)) / 4096, 12);
  });
});

describe('accuracy test: a session recorded with an eye-picture network running', () => {
  const rec = simulatedSession(21, { eyeNet: true });
  const scores = scoreRecording(rec, { prior: REAL_FACE_PRIOR });

  it('keeps the network’s answer with every frame and says whose they are', () => {
    expect(rec.eyeNet).toBe(SIM_EYE_NET);
    const frames = rec.blocks.flatMap((b) => b.trials.flatMap((t) => t.frames));
    expect(frames.every((f) => f.n?.length === 2)).toBe(true);
    const back = parseRecording(JSON.parse(JSON.stringify(rec)));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.recording.eyeNet).toBe(SIM_EYE_NET);
    expect(featuresOf(frames[0], rec.eyeNet).eyeNet).toEqual({ id: SIM_EYE_NET, x: frames[0].n![0], y: frames[0].n![1] });
    expect(featuresOf(frames[0]).eyeNet).toBeUndefined();
  });

  it('scores the calibration made on the network next to the others, on the same frames', () => {
    expect(scores.variants.map((v) => v.id)).toEqual(VARIANTS.map((v) => v.id));
    const net = scores.variants.find((v) => v.id === EYE_NET_VARIANT)!;
    expect(net.ok, net.problem ?? '').toBe(true);
    expect(net.overall.scored).toBe(scores.variants[0].overall.scored);
    // The stand-in reads the dot to about 30 px; a calibration that really used it lands near that.
    expect(net.overall.medianErrorPx).toBeLessThan(60);
    expect(scores.comparisons.map((c) => c.b)).toContain(EYE_NET_VARIANT);
    expect(formatScores(scores)).toContain('Eye-picture network');
  });

  it('leaves the other calibrations as they are without the answers', () => {
    const stripped: AccuracyRecording = JSON.parse(JSON.stringify(rec));
    delete stripped.eyeNet;
    for (const b of stripped.blocks) for (const t of b.trials) for (const f of t.frames) delete f.n;
    const plain = scoreRecording(stripped, { prior: REAL_FACE_PRIOR });
    expect(plain.variants.map((v) => v.id)).toEqual(PLAIN.map((v) => v.id));
    for (const v of plain.variants) expect(scores.variants.find((x) => x.id === v.id)!.overall.medianErrorPx).toBeCloseTo(v.overall.medianErrorPx, 6);
  });

  it('refuses a recording whose network answers are damaged', () => {
    const bad = JSON.parse(JSON.stringify(rec));
    bad.blocks[0].trials[0].frames[0].n = [0.1];
    expect(parseRecording(bad).ok).toBe(false);
    const unnamed = JSON.parse(JSON.stringify(rec));
    unnamed.eyeNet = '';
    expect(parseRecording(unnamed).ok).toBe(false);
  });
});
