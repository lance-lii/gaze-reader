/**
 * The end-to-end scoreboard (`npm run eval`): simulated hours of reading, from webcam landmarks to page
 * turns, in every scenario of world.ts, for the 'balanced' and 'relaxed' presets. Sessions run in
 * parallel shards (shard-*.eval.test.ts); evalSetup.ts merges them and prints
 *  - the scoreboard per preset: unintended turns per hour and missed pages, with 95 % intervals;
 *  - with a baseline, the before → after table per scenario: each difference with its 95 % interval,
 *    and how many more pages are missed for each unintended turn prevented.
 *
 *   GR_EVAL_SEEDS (3), GR_EVAL_SEED_BASE (1)  runs per scenario and the first seed. Tune on another base
 *                                             (21 and up); the scoreboard is seeds 1–3, never tuned on.
 *   GR_EVAL_MINUTES (60)                      length of each run
 *   GR_EVAL_LONG_SEEDS (3)                    two-hour 'everyday' sessions (seeds 100 + base, …)
 *   GR_EVAL_SENS (balanced,relaxed)           presets
 *   GR_EVAL_ONLY=name,name                    a subset of scenarios, by name or its start ('dim' for
 *                                             'dim, 15 fps'; 'long' for the two-hour rows)
 *   GR_EVAL_BASELINE=deployed | file.json     also run the deployed detector on the same seeds, or
 *                                             compare with a run saved by GR_EVAL_OUT
 *   GR_EVAL_OUT=file.json                     save every session of this run
 */
import type { Sensitivity } from '../../src/types';
import { PageEndDetector } from '../../src/reading/pageEndDetector';
import { DeployedPageEndDetector } from './deployedPageEndDetector';
import { delta, deltaTable, runSession, summarize, summaryTable, toRecord, type Delta, type PageEndDetectorLike, type SessionRecord, type Summary } from './rig';
import { HARNESS_VERSION, SCENARIOS, scenario } from './world';

/** Number of shard files (shard-0 … shard-5.eval.test.ts); vitest runs them in parallel. */
export const EVAL_SHARDS = 6;
export const LONG_LABEL = 'everyday, 2 h in one go';

// The project has no Node type definitions (it's a browser app); reach Node through narrow shapes.
interface NodeFs {
  writeFileSync(path: string, data: string): void;
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
}
const nodeProcess = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
const env = (name: string): string | undefined => nodeProcess?.env[name];
async function nodeFs(): Promise<NodeFs> {
  const specifier: string = 'node:fs';
  return (await import(/* @vite-ignore */ specifier)) as NodeFs;
}

export interface EvalJob {
  scenario: string;
  label: string;
  seed: number;
  minutes: number;
  sensitivity: Sensitivity;
  detector: 'current' | 'deployed';
}

export interface EvalSettings {
  seeds: number;
  seedBase: number;
  minutes: number;
  longSeeds: number;
  sensitivities: Sensitivity[];
  only: string[] | null;
  baseline: string | null;
  out: string | null;
}

export function evalSettings(): EvalSettings {
  const num = (name: string, fallback: number): number => {
    const v = Number(env(name));
    return Number.isFinite(v) && env(name) !== undefined && env(name) !== '' ? v : fallback;
  };
  const list = (name: string): string[] | null => env(name)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const sens = (list('GR_EVAL_SENS') ?? ['balanced', 'relaxed']).filter((s): s is Sensitivity => s === 'balanced' || s === 'relaxed' || s === 'eager');
  return {
    seeds: num('GR_EVAL_SEEDS', 3),
    seedBase: num('GR_EVAL_SEED_BASE', 1),
    minutes: num('GR_EVAL_MINUTES', 60),
    longSeeds: num('GR_EVAL_LONG_SEEDS', 3),
    sensitivities: sens.length ? sens : ['balanced'],
    only: list('GR_EVAL_ONLY'),
    baseline: env('GR_EVAL_BASELINE') || null,
    out: env('GR_EVAL_OUT') || null,
  };
}

export function evalJobs(s: EvalSettings = evalSettings()): EvalJob[] {
  const detectors: EvalJob['detector'][] = s.baseline === 'deployed' ? ['deployed', 'current'] : ['current'];
  const jobs: EvalJob[] = [];
  for (const sensitivity of s.sensitivities) {
    for (const detector of detectors) {
      for (const sc of SCENARIOS) {
        if (s.only && !s.only.some((o) => sc.name === o || sc.name.startsWith(o))) continue;
        for (let i = 0; i < s.seeds; i++) jobs.push({ scenario: sc.name, label: sc.name, seed: s.seedBase + i, minutes: s.minutes, sensitivity, detector });
      }
      // Long sessions: two hours of 'everyday' in one go (drift, memory and CPU over time).
      if (!s.only || s.only.includes('long')) {
        for (let i = 0; i < s.longSeeds; i++) {
          jobs.push({ scenario: 'everyday', label: LONG_LABEL, seed: 100 + s.seedBase + i, minutes: Math.max(s.minutes, 120), sensitivity, detector });
        }
      }
    }
  }
  return jobs;
}

/** The jobs of one shard: longest first, each to the least-loaded shard (deterministic). */
export function shardJobs(jobs: readonly EvalJob[], index: number, count: number): EvalJob[] {
  const load = new Array<number>(count).fill(0);
  const mine: EvalJob[] = [];
  const order = jobs.map((j, i) => ({ j, i })).sort((a, b) => b.j.minutes - a.j.minutes || a.i - b.i);
  for (const { j } of order) {
    let k = 0;
    for (let c = 1; c < count; c++) if (load[c]! < load[k]!) k = c;
    load[k] = load[k]! + j.minutes;
    if (k === index) mine.push(j);
  }
  return mine;
}

export function runJob(job: EvalJob): SessionRecord {
  const detector = (sensitivity: Sensitivity): PageEndDetectorLike =>
    job.detector === 'deployed' ? new DeployedPageEndDetector({ sensitivity }) : new PageEndDetector({ sensitivity });
  const m = runSession(scenario(job.scenario), job.seed, { minutes: job.minutes, sensitivity: job.sensitivity, detector });
  return toRecord(m, { label: job.label, detector: job.detector });
}

export async function runShard(index: number, count: number): Promise<number> {
  const dir = env('GR_EVAL_DIR');
  if (!dir) throw new Error('GR_EVAL_DIR is not set: run the eval with `npm run eval` (vitest.eval.config.ts)');
  const records = shardJobs(evalJobs(), index, count).map(runJob);
  const fs = await nodeFs();
  fs.writeFileSync(`${dir}/shard-${index}.json`, JSON.stringify(records));
  return records.length;
}

interface SavedRun {
  version: string;
  settings: EvalSettings;
  records: SessionRecord[];
}

const key = (r: { label?: string; scenario: string; seed: number; sensitivity: string; minutes: number }): string =>
  `${r.label ?? r.scenario}|${r.seed}|${r.sensitivity}|${Math.round(r.minutes)}`;

/** Merges the shards, prints the scoreboard (and the comparison), saves the run. */
export async function mergeAndReport(dir: string, log: (s: string) => void = (s) => console.log(s)): Promise<void> {
  const fs = await nodeFs();
  const settings = evalSettings();
  const expected = evalJobs(settings);
  let records: SessionRecord[] = [];
  for (let i = 0; i < EVAL_SHARDS; i++) {
    const f = `${dir}/shard-${i}.json`;
    if (fs.existsSync(f)) records = records.concat(JSON.parse(fs.readFileSync(f, 'utf8')) as SessionRecord[]);
    else if (shardJobs(expected, i, EVAL_SHARDS).length > 0) log(`[eval] shard ${i} wrote no results (it failed?)`);
  }
  if (records.length === 0) return;

  // A saved baseline: its sessions of the same rows and seeds, under the 'baseline' label.
  if (settings.baseline && settings.baseline !== 'deployed') {
    const saved = JSON.parse(fs.readFileSync(settings.baseline, 'utf8')) as SavedRun;
    if (saved.version !== HARNESS_VERSION) {
      log(`[eval] ${settings.baseline} was made with harness ${saved.version}, this is ${HARNESS_VERSION}: no comparison`);
    } else {
      const want = new Set(records.map((r) => key(r)));
      const base = saved.records.filter((r) => r.detector === 'current' && want.has(key(r))).map((r) => ({ ...r, detector: 'baseline' }));
      if (base.length < records.length) log(`[eval] the baseline has ${base.length} of this run's ${records.length} sessions; rows without both are left out of the comparison`);
      records = records.concat(base);
    }
  }

  const order = [...SCENARIOS.map((s) => s.name), LONG_LABEL];
  const detectors = [...new Set(records.map((r) => r.detector))].sort((a, b) => (a === 'current' ? 1 : b === 'current' ? -1 : a.localeCompare(b)));
  const rowsFor = (detector: string, sensitivity: Sensitivity): Summary[] =>
    order
      .map((label) => records.filter((r) => r.detector === detector && r.sensitivity === sensitivity && r.scenario === label))
      .filter((rs) => rs.length > 0)
      .map((rs) => summarize(rs));

  for (const sensitivity of settings.sensitivities) {
    for (const detector of detectors) {
      const rows = rowsFor(detector, sensitivity);
      if (rows.length === 0) continue;
      log(`\n### ${detector === 'current' ? 'this tree' : detector} detector, ${sensitivity} (seeds from ${settings.seedBase}, harness ${HARNESS_VERSION})\n`);
      log(summaryTable([...rows, { ...summarize(records.filter((r) => r.detector === detector && r.sensitivity === sensitivity)), scenario: 'all' }]));
      for (const r of rows) {
        const causes = Object.entries(r.falseCauses).sort((a, b) => b[1] - a[1]);
        if (causes.length) log(`${r.scenario}: false turns: ${causes.map(([k, n]) => `${n}× ${k}`).join(', ')}`);
      }
    }
    const before = detectors.find((d) => d !== 'current');
    if (before && detectors.includes('current')) {
      const deltas: Delta[] = [];
      for (const label of order) {
        const b = records.filter((r) => r.detector === before && r.sensitivity === sensitivity && r.scenario === label);
        const a = records.filter((r) => r.detector === 'current' && r.sensitivity === sensitivity && r.scenario === label);
        if (b.length && a.length) deltas.push(delta(summarize(b), summarize(a)));
      }
      const all = (d: string): SessionRecord[] => records.filter((r) => r.detector === d && r.sensitivity === sensitivity);
      deltas.push({ ...delta(summarize(all(before)), summarize(all('current'))), scenario: 'all' });
      log(`\n### ${before} → this tree, ${sensitivity}: differences with 95 % intervals\n`);
      log(deltaTable(deltas));
    }
  }

  if (settings.out) {
    const saved: SavedRun = { version: HARNESS_VERSION, settings, records: records.filter((r) => r.detector !== 'baseline') };
    fs.writeFileSync(settings.out, `${JSON.stringify(saved)}\n`);
    log(`\n[eval] saved ${saved.records.length} sessions to ${settings.out}`);
  }
}
