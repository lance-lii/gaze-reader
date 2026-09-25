/**
 * Lighting robustness of the gaze model: a scoreboard.
 *
 * For each simulated world (W1–W5, faceSim.ts) and 5 calibration seeds, both model
 * configurations are trained on the same synthetic calibration, then read a 5 × 9 reading grid
 * (24 frames per point) rendered twice with identical noise: once in the calibration lighting,
 * once under a perturbation. The shift is the mean paired change of the predicted gaze.
 *
 *   OLD = Gaze Reader 1.0 (27 features, the model may use the lids)
 *   NEW = GAZE_EXCLUDED_FEATURES neutralized (5-point corner-referenced iris, eyeLook*, posture)
 *
 * Columns: LOTO = trainGazeModel's leave-one-target-out error; σy = per-frame spread of the
 * predicted y on the reading grid; shifts in px [lines of 41.8 px], mean ± SD over seeds.
 * + dy = the gaze reads lower on the page (early page turns); − dy = higher (late turns).
 *
 * Then, for a few lid and glint cases: the offset the accuracy check measures on the 5 quick
 * dots (measureOffset), and the shift left after a quick refresh under the new light
 * (refineGazeModel); and how visible each lid change is to the eyelid-appearance baseline.
 *
 * Run with `npm run bench` (≈ 15 s).
 */
import { describe, expect, it } from 'vitest';
import { computeAppearanceBaseline, measureOffset, refineGazeModel, type RidgeGazeModel } from '../../src/gaze/calibrationModel';
import type { AppearanceBaseline } from '../../src/types';
import { calibrationSession, pairedReadingFrames, PRIMARY_APERTURE_MM, QUICK_TARGETS, VIEW, WORLDS, type PairedFrame, type Perturbation, type WorldName } from './faceSim';
import { LINE_PX, NEW_CONFIG, OLD_CONFIG, configFeatures, mean, measureShift, readingAccuracy, sd, trainConfig, type ModelConfig } from './harness';

const SEEDS = [1, 2, 3, 4, 5];
const PER_POINT = 24;
const READING_SEED = 1000;

interface Case {
  key: string;
  label: string;
  light: Perturbation;
}

const CASES: Case[] = [
  { key: 'squint5', label: 'squint 5 %', light: { squint: 0.05 } },
  { key: 'squint10', label: 'squint 10 %', light: { squint: 0.1 } },
  { key: 'squint20', label: 'squint 20 %', light: { squint: 0.2 } },
  { key: 'squint10up', label: 'squint 10 %, upper lid only', light: { squint: 0.1, lowerLidShare: 0 } },
  { key: 'wider', label: 'eyes 0.25 mm wider', light: { widenMm: 0.25 } },
  ...(['up', 'down', 'sideways'] as const).flatMap((dir) =>
    [0.01, 0.02, 0.05].map(
      (m): Case => ({
        key: `glint-${dir}-${m}`,
        label: `glint ${dir} ${m}`,
        light: { irisBias: dir === 'up' ? { dx: 0, dy: -m } : dir === 'down' ? { dx: 0, dy: m } : { dx: m, dy: 0 } },
      }),
    ),
  ),
  { key: 'lidShadow', label: 'upper-lid shadow 0.02', light: { lidBias: { upper: 0.02, lower: 0 } } },
  { key: 'jitter2', label: 'jitter x2', light: { jitter: 2 } },
  { key: 'shrink10', label: 'low-light shrink 10 %', light: { shrink: 0.1 } },
  { key: 'shrink20', label: 'low-light shrink 20 %', light: { shrink: 0.2 } },
  { key: 'shiftX', label: 'global shift x 0.005', light: { globalShift: { dx: 0.005, dy: 0 } } },
  { key: 'shiftY', label: 'global shift y 0.005', light: { globalShift: { dx: 0, dy: 0.005 } } },
  { key: 'shiftY2', label: 'global shift y 0.02', light: { globalShift: { dx: 0, dy: 0.02 } } },
];
const LIGHTS: Perturbation[] = [{}, ...CASES.map((c) => c.light)];
/** Cases for the accuracy check (measureOffset on the 5 quick dots) and the quick refresh under the new light. */
const REFRESH_CASES = ['squint10', 'squint20', 'squint10up', 'wider', 'glint-up-0.02', 'lidShadow'];
const CONFIGS: readonly ModelConfig[] = [OLD_CONFIG, NEW_CONFIG];

interface ConfigResult {
  loto: number[];
  sigmaY: number[];
  errY: number[];
  dx: Record<string, number[]>;
  dy: Record<string, number[]>;
  rejected: Record<string, number[]>;
  /** Accuracy check's measured y offset on the quick dots (px), per case. */
  checkY: Record<string, number[]>;
  /** Paired y shift left on the reading grid after a quick refresh under the new light (px), per case. */
  afterRefreshY: Record<string, number[]>;
}

interface WorldResult {
  byConfig: Record<string, ConfigResult>;
  appearance: { baseline: AppearanceBaseline | null; residualZ: Record<string, number>; squintDelta: Record<string, number> }[];
}

const fmt = (v: number, digits = 0, width = 5): string => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a').padStart(width);
const pm = (a: readonly number[], digits = 0): string => `${fmt(mean(a), digits)}±${fmt(sd(a), digits, 0).padEnd(3)}`;
const lines = (a: readonly number[]): string => `[${fmt(mean(a) / LINE_PX, 1, 5)}]`;

function runWorld(world: WorldName): WorldResult {
  const noise = WORLDS[world].noise;
  const reading = pairedReadingFrames(READING_SEED, PER_POINT, LIGHTS, noise);
  const byConfig: Record<string, ConfigResult> = {};
  for (const cfg of CONFIGS) byConfig[cfg.key] = { loto: [], sigmaY: [], errY: [], dx: {}, dy: {}, rejected: {}, checkY: {}, afterRefreshY: {} };
  const appearance: WorldResult['appearance'] = [];

  for (const seed of SEEDS) {
    const cal = calibrationSession(seed, { noise });
    for (const cfg of CONFIGS) {
      const R = byConfig[cfg.key];
      const { model, report } = trainConfig(cfg, cal);
      R.loto.push(report.meanErrorPx);
      const acc = readingAccuracy(model, cfg, reading);
      R.sigmaY.push(acc.sigmaY);
      R.errY.push(acc.errY);
      CASES.forEach((c, i) => {
        const s = measureShift(model, cfg, reading, i + 1);
        (R.dx[c.key] ??= []).push(s.dx);
        (R.dy[c.key] ??= []).push(s.dy);
        (R.rejected[c.key] ??= []).push(s.rejectedPct);
      });
      for (const key of REFRESH_CASES) {
        const li = CASES.findIndex((c) => c.key === key) + 1;
        const quick = calibrationSession(seed + 100, { noise, targets: QUICK_TARGETS, perTarget: 20, light: LIGHTS[li] }).map((q) => ({
          ...q,
          features: configFeatures(cfg, q.features),
        }));
        (R.checkY[key] ??= []).push(measureOffset(model, quick, { maxBlink: 0.85 }).offsetYPx);
        const refreshed = refineGazeModel(model, quick, { viewport: { ...VIEW }, maxBlink: 0.85 }).model;
        (R.afterRefreshY[key] ??= []).push(refreshedShift(model, refreshed, cfg, reading, li));
      }
    }
    // How visible each lid change is to the eyelid-appearance baseline (per frame).
    const baseline = computeAppearanceBaseline(cal, VIEW.height);
    const residualZ: Record<string, number> = {};
    const squintDelta: Record<string, number> = {};
    if (baseline) {
      const sdOpen = Math.max(baseline.opennessResidualSd, 1e-6);
      LIGHTS.forEach((_, li) => {
        const z: number[] = [];
        const dq: number[] = [];
        for (const fr of reading) {
          const f = fr.byLight[li];
          const a = fr.byLight[0];
          if (!f || !a) continue;
          z.push((f.openness - (baseline.opennessAt0 + baseline.opennessSlope * (fr.target.y / VIEW.height))) / sdOpen);
          dq.push((f.squint ?? 0) - (a.squint ?? 0));
        }
        const key = li === 0 ? 'baseline' : CASES[li - 1].key;
        residualZ[key] = mean(z);
        squintDelta[key] = mean(dq);
      });
    }
    appearance.push({ baseline, residualZ, squintDelta });
  }
  return { byConfig, appearance };
}

/** Mean y of (refreshed model under perturbation li) − (calibrated model in the calibration light), paired frames. */
function refreshedShift(base: RidgeGazeModel, refreshed: RidgeGazeModel, cfg: ModelConfig, frames: readonly PairedFrame[], li: number): number {
  const d: number[] = [];
  for (const fr of frames) {
    const a = fr.byLight[0];
    const b = fr.byLight[li];
    if (!a || !b) continue;
    const pa = base.predictScreenFromVector(configFeatures(cfg, a).vector);
    const pb = refreshed.predictScreenFromVector(configFeatures(cfg, b).vector);
    if (pa && pb) d.push(pb.y - pa.y);
  }
  return mean(d);
}

function printWorld(world: WorldName, r: WorldResult): string[] {
  const out: string[] = [];
  const O = r.byConfig.OLD;
  const N = r.byConfig.NEW;
  out.push('');
  out.push(`=== ${world}: ${WORLDS[world].label} ===`);
  out.push(`  LOTO px      OLD ${pm(O.loto, 1)}   NEW ${pm(N.loto, 1)}`);
  out.push(`  σy px        OLD ${pm(O.sigmaY, 1)}   NEW ${pm(N.sigmaY, 1)}`);
  out.push(`  read err y   OLD ${pm(O.errY, 1)}   NEW ${pm(N.errY, 1)}`);
  out.push(`  ${'perturbation'.padEnd(28)} | ${'OLD dy px [lines]'.padEnd(19)} | ${'NEW dy px [lines]'.padEnd(19)} | ${'OLD dx px'.padEnd(10)} | ${'NEW dx px'.padEnd(10)} | rej% O/N`);
  for (const c of CASES) {
    const rej = `${fmt(mean(O.rejected[c.key]), 1, 0)}/${fmt(mean(N.rejected[c.key]), 1, 0)}`;
    out.push(
      `  ${c.label.padEnd(28)} | ${pm(O.dy[c.key])} ${lines(O.dy[c.key])} | ${pm(N.dy[c.key])} ${lines(N.dy[c.key])} | ${pm(O.dx[c.key])} | ${pm(N.dx[c.key])} | ${rej}`,
    );
  }
  return out;
}

describe('lighting robustness scoreboard', () => {
  it('prints OLD vs NEW for worlds W1–W5', () => {
    const t0 = Date.now();
    const results = {} as Record<WorldName, WorldResult>;
    const out: string[] = [
      'Lighting robustness of the gaze model (bench/lighting/features.bench.test.ts)',
      `${SEEDS.length} calibration seeds per world, ${PER_POINT} paired frames × 45 reading points; 1 line = ${LINE_PX.toFixed(1)} px; primary lid aperture ${PRIMARY_APERTURE_MM.toFixed(1)} mm`,
      `OLD = ${OLD_CONFIG.label}; NEW = ${NEW_CONFIG.label}`,
    ];
    for (const w of Object.keys(WORLDS) as WorldName[]) {
      results[w] = runWorld(w);
      out.push(...printWorld(w, results[w]));
    }

    // Summary: vertical shift in lines, every world side by side.
    out.push('');
    out.push('=== Vertical shift in lines, OLD → NEW (mean over seeds) ===');
    const worlds = Object.keys(WORLDS) as WorldName[];
    out.push(`  ${'perturbation'.padEnd(28)} | ${worlds.map((w) => w.padEnd(13)).join(' | ')}`);
    out.push(`  ${'LOTO px'.padEnd(28)} | ${worlds.map((w) => `${fmt(mean(results[w].byConfig.OLD.loto), 1, 5)}→${fmt(mean(results[w].byConfig.NEW.loto), 1, 5)}`.padEnd(13)).join(' | ')}`);
    out.push(`  ${'σy px'.padEnd(28)} | ${worlds.map((w) => `${fmt(mean(results[w].byConfig.OLD.sigmaY), 1, 5)}→${fmt(mean(results[w].byConfig.NEW.sigmaY), 1, 5)}`.padEnd(13)).join(' | ')}`);
    for (const c of CASES) {
      const cells = worlds.map((w) => `${fmt(mean(results[w].byConfig.OLD.dy[c.key]) / LINE_PX, 2, 5)}→${fmt(mean(results[w].byConfig.NEW.dy[c.key]) / LINE_PX, 2, 5)}`.padEnd(13));
      out.push(`  ${c.label.padEnd(28)} | ${cells.join(' | ')}`);
    }

    // Accuracy check and quick refresh under the new light.
    out.push('');
    out.push('=== Accuracy check (measureOffset, 5 quick dots) and quick refresh under the new light, lines (mean over seeds) ===');
    out.push('  shift = true paired shift on the reading grid; check = offset the accuracy check measures; after = shift left after refineGazeModel');
    out.push(`  ${'world / perturbation'.padEnd(34)} | ${'OLD shift  check  after'.padEnd(24)} | NEW shift  check  after`);
    for (const w of worlds) {
      for (const key of REFRESH_CASES) {
        const label = CASES.find((c) => c.key === key)?.label ?? key;
        const cell = (cfg: string): string => {
          const R = results[w].byConfig[cfg];
          return `${fmt(mean(R.dy[key]) / LINE_PX, 2, 6)} ${fmt(mean(R.checkY[key]) / LINE_PX, 2, 6)} ${fmt(mean(R.afterRefreshY[key]) / LINE_PX, 2, 6)}`;
        };
        out.push(`  ${`${w} ${label}`.padEnd(34)} | ${cell('OLD').padEnd(24)} | ${cell('NEW')}`);
      }
    }

    // Eyelid-appearance baseline: how far each lid change moves the per-frame openness residual.
    out.push('');
    out.push('=== Eyelid-appearance baseline (computeAppearanceBaseline on the calibration), W1 ===');
    const app = results.W1.appearance;
    const b = app.map((a) => a.baseline).filter((x): x is AppearanceBaseline => x !== null);
    out.push(
      `  openness ≈ ${mean(b.map((x) => x.opennessAt0)).toFixed(3)} + ${mean(b.map((x) => x.opennessSlope)).toFixed(3)} × y/H; per-frame residual SD ${mean(b.map((x) => x.opennessResidualSd)).toFixed(4)}; squint ${mean(b.map((x) => x.squintMedian)).toFixed(3)} ± ${mean(b.map((x) => x.squintSd)).toFixed(3)}`,
    );
    for (const key of ['baseline', 'squint5', 'squint10', 'squint20', 'squint10up', 'wider', 'lidShadow', 'jitter2', 'shrink10']) {
      const label = key === 'baseline' ? 'calibration lighting' : (CASES.find((c) => c.key === key)?.label ?? key);
      out.push(`  ${label.padEnd(28)} openness residual ${fmt(mean(app.map((a) => a.residualZ[key])), 2, 6)} SD/frame, squint score ${fmt(mean(app.map((a) => a.squintDelta[key])), 3, 7)}`);
    }
    out.push(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    console.log(out.join('\n'));

    // Loose sanity: the scoreboard is informative, the tight guards live in tests/lightingRobustness.test.ts.
    for (const w of worlds) {
      expect(Math.abs(mean(results[w].byConfig.NEW.dy.squint10)) / LINE_PX).toBeLessThan(1.25);
      expect(mean(results[w].byConfig.NEW.loto)).toBeLessThan(mean(results[w].byConfig.OLD.loto) * 1.05);
    }
  });
});
