import { describe, expect, it } from 'vitest';
import type { SyntheticDocOptions } from '../../src/reading/testLayouts';
import { lastFullyVisibleIndex, makeReadingPage, withBlockGap } from '../../src/reading/testLayouts';
import {
  APP_DOC,
  APP_DOC_LONG,
  NEW,
  NEW_TRACKER_OLD_DETECTOR,
  ONE_PARAGRAPH_DOC,
  OLD,
  constant,
  fmt,
  markdownTable,
  noOffset,
  pct,
  scaled,
  stepAt,
  type Offset,
  type Pipeline,
  type Schedule,
} from './harness';
import { runSession, summarizeSessions, type SessionConfig, type SessionSummary } from './session';
import {
  READING_ORDERS,
  afterReading,
  runInterrupted,
  runPage,
  summarizePages,
  type InterruptConfig,
  type PageConfig,
  type PageSummary,
  type Segment,
} from './page';

/**
 * Scoreboard: how the reading layer copes with gaze offsets of the kind light
 * causes (a squint in bright light reads low, wide eyes in dim light read
 * high), for Gaze Reader 1.0 ("old 1.0", frozen copies in this folder) and the
 * current modules ("new"). Run with `npm run bench` (≈ 10 min); the fast
 * regression guards are in src/reading/offsets.test.ts.
 *
 * Documents (they matter: paragraph gaps and short lines are what tell "line k,
 * no drift" from "line k + 1, drift −1"):
 * - gapped (extension-like): 3–7-line paragraphs with 0.5-pitch gaps between
 *   them, like most web articles the extension reads;
 * - app: the app reader's CSS (no paragraph gaps, 1.5em first-line indent),
 *   3–9-line paragraphs; app, long ¶: 12–30-line paragraphs;
 * - one ¶: a single paragraph (nothing but the page's top and bottom).
 *
 * Sessions: 24 seeds × 7 page turns (168 turns per row), 300 wpm, 0.75-pitch
 * white noise at 30 Hz, 10 blinks/min, offsets added to the smoothed samples.
 * "Steps" happen 100 s in (on the third or fourth page); "+ event (2.3 s)" is
 * the camera's appearance-changed report (carrying the change's time) reaching
 * the tracker 2.3 s later, as the lid monitor's median; "(8 s)" as LightingWatch.
 *
 * - on line: reading fixations the tracker put on the reader's true line
 *   (pooled; worst session in brackets); after turn: the first 8 fixations
 *   after each turn.
 * - premature: the reader was more than one line above the last line when the
 *   page turned; unsafe: above the anchor line (the line being read scrolled
 *   away); missed: no turn 8 s after the reader finished the page (the reader
 *   turned by hand); skipped: lines never read because they scrolled away.
 * - latency: ms from the reader starting to linger on the last line to the
 *   turn (turns that fire during the last words don't count), median / p90.
 * - drift err: |driftY − injected offset at the reader's line| at the turns, lines.
 *
 * Interrupted reading (single fresh pages, 24 seeds; peeks also at the eager preset, 48 runs):
 * after line 8 the reader glances straight down or up and straight back, or peeks at the end of
 * the page's last line; then reads on. Any turn during a peek run is unread text scrolled away.
 *
 * Known limits (asserted at today's level, so they can only get better): in steady light at high
 * noise, on long gapless paragraphs and on one-paragraph pages, the ±5-line tracker sometimes sits a
 * line or more away from the reader with a matching spurious drift ("line k − 3, +3" explains
 * unstructured text as well as "line k, 0"). The page-end detector clamps an unpinned drift to
 * ±1.5 pitches, which halves the damage; the root cause (the drift's random walk also has to carry
 * the y-dependent drift of a gain error, so it can't be slowed down) is a follow-up: model the gain
 * separately, then lower driftRate to ≈ 0.075.
 */

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const STEP_AT_MS = 100_000;
const HARSH: Partial<SessionConfig> = { wanderLines: 0.3, blinksPerMin: 15 };
/** The lid monitor's median report latency, and LightingWatch's typical one. */
const EVENT_DELAYS = [2300, 8000] as const;

const GAPPED = 'gapped (extension-like)';
const DOCS: Readonly<Record<string, SyntheticDocOptions | undefined>> = {
  [GAPPED]: undefined,
  app: APP_DOC,
  'app, long ¶': APP_DOC_LONG,
  'one ¶': ONE_PARAGRAPH_DOC,
};

interface SessionScenario {
  label: string;
  schedule: Schedule;
  extra?: Partial<SessionConfig>;
  /** Only meaningful for the new tracker (appearance events, reset({ keepDrift })). */
  newOnly?: boolean;
}

const sign = (dy: number): string => (dy > 0 ? `+${dy}` : String(dy));
const withEvent = (dy: number, delayMs: number): SessionScenario => ({
  label: `step ${sign(dy)} + event (${delayMs / 1000} s)`,
  schedule: stepAt(dy, STEP_AT_MS),
  extra: { appearanceEvents: [STEP_AT_MS], eventDelayMs: delayMs },
  newOnly: true,
});
const step = (dy: number): SessionScenario => ({ label: `step ${sign(dy)}`, schedule: stepAt(dy, STEP_AT_MS) });
const offset = (dy: number): SessionScenario => ({ label: `constant ${sign(dy)}`, schedule: constant(dy) });
const falseAlarms = (noiseLines: number): SessionScenario => ({
  label: `false alarms: event every 15 s (2.3 s late), no offset, noise ${noiseLines}`,
  schedule: noOffset,
  extra: { appearanceEvents: Array.from({ length: 40 }, (_, i) => 15_000 * (i + 1)), eventDelayMs: 2300, noiseLines },
  newOnly: true,
});

const GAPPED_SCENARIOS: readonly SessionScenario[] = [
  { label: 'none', schedule: noOffset },
  offset(1), offset(-1), offset(2), offset(-2), offset(3), offset(-3), offset(4), offset(-4),
  // Beyond the modelled ±5 lines (with noise, the tails reach past the grid): the limit.
  offset(6), offset(-6),
  { label: 'scale 1.15', schedule: scaled(1.15) },
  { label: 'scale 0.85', schedule: scaled(0.85) },
  ...[2, -2, 3, -3, 4, -4].flatMap((dy) => [step(dy), ...EVENT_DELAYS.map((d) => withEvent(dy, d))]),
  { label: 'noise 1.2', schedule: noOffset, extra: { noiseLines: 1.2 } },
  { label: 'x +120 px', schedule: constant(0, 120) },
  { label: 'x −120 px', schedule: constant(0, -120) },
  { label: 'x +200 px', schedule: constant(0, 200) },
  { label: 'x −200 px', schedule: constant(0, -200) },
  { label: 'harsh (wander .3, blinks 15)', schedule: noOffset, extra: HARSH },
  { label: 'harsh + constant +2', schedule: constant(2), extra: HARSH },
  { label: 'harsh + step +2', schedule: stepAt(2, STEP_AT_MS), extra: HARSH },
  {
    label: 'harsh + step +2 + event (2.3 s)',
    schedule: stepAt(2, STEP_AT_MS),
    extra: { ...HARSH, appearanceEvents: [STEP_AT_MS], eventDelayMs: 2300 },
    newOnly: true,
  },
  falseAlarms(0.75),
  { label: 'book re-opened on page 3, constant +3, fresh reset', schedule: constant(3), extra: { reopenAtPage: { page: 3, keepDrift: false } }, newOnly: true },
  { label: 'book re-opened on page 3, constant +3, reset({ keepDrift })', schedule: constant(3), extra: { reopenAtPage: { page: 3, keepDrift: true } }, newOnly: true },
];

/** The app's layouts: the rows where the missing paragraph gaps matter. */
const APP_SCENARIOS: readonly SessionScenario[] = [
  { label: 'none', schedule: noOffset },
  { label: 'noise 1.2', schedule: noOffset, extra: { noiseLines: 1.2 } },
  { label: 'noise 1.4', schedule: noOffset, extra: { noiseLines: 1.4 } },
  { label: 'harsh (wander .3, blinks 15)', schedule: noOffset, extra: HARSH },
  offset(2), offset(-2), offset(3), offset(-3),
  step(3), withEvent(3, 2300), step(-3), withEvent(-3, 2300),
  falseAlarms(0.75),
  falseAlarms(1.2),
];

/** Steady light, no offset, where the wide drift range can learn a spurious drift (acceptance rows). */
const STEADY_SCENARIOS: ReadonlyArray<readonly [doc: string, scenario: SessionScenario]> = [
  ['app', { label: 'noise 1.6', schedule: noOffset, extra: { noiseLines: 1.6 } }],
  ['app, long ¶', { label: 'noise 1.4', schedule: noOffset, extra: { noiseLines: 1.4 } }],
  ['one ¶', { label: 'harsh (wander .3, blinks 15)', schedule: noOffset, extra: HARSH }],
  ['one ¶', { label: 'noise 1.2', schedule: noOffset, extra: { noiseLines: 1.2 } }],
  ['one ¶', { label: 'none', schedule: noOffset }],
];

/**
 * Known limits: how many more early + unsafe turns (of 168) than 1.0 a row may have. Everything
 * else must be at most 1.0's + 2 (steady rows) or no worse than 1.0 (app layouts at noise 1.2 / 1.4
 * and harsh). Measured when these were set (24 seeds): one ¶ harsh 1.0 1 → new 7 (0 / 7 / 2),
 * one ¶ noise 1.2 0 → 5 (0 / 5 / 6); app, long ¶ noise 1.4 1 → 2, harsh 1 → 2 (1.0 without the
 * detector's drift clamp: 5 and 2, and 11 / 5 on one ¶).
 */
const KNOWN_EXCESS: Readonly<Record<string, number>> = {
  'one ¶ · harsh (wander .3, blinks 15)': 6,
  'one ¶ · noise 1.2': 5,
  'app, long ¶ · noise 1.4': 1,
  'app, long ¶ · harsh (wander .3, blinks 15)': 1,
};

interface PageScenario {
  label: string;
  segments?: (L: number) => Segment[];
  offset: Offset;
}

const PAGE_SCENARIOS: readonly PageScenario[] = [
  { label: 'fresh page, no offset', offset: { dy: 0 } },
  { label: 'fresh page, constant +3', offset: { dy: 3 } },
  { label: 'fresh page, constant −3', offset: { dy: -3 } },
  ...READING_ORDERS.flatMap(([label, segments]): PageScenario[] => [
    { label, segments, offset: { dy: 0 } },
    { label: `${label} + offset +2`, segments, offset: { dy: 2 } },
  ]),
];

/** First pages after a start: the reading orders that expose a weak drift prior on long gapless paragraphs. */
const START_ORDERS: ReadonlyArray<readonly [label: string, segments: (L: number) => Segment[]]> = [
  ['straight from the top', (L) => [{ startLine: 0, endLine: L }]],
  ['re-read (0–10, back to 6–7, 11–L)', (L) => [{ startLine: 0, endLine: 10 }, { startLine: 6, endLine: 7 }, { startLine: 11, endLine: L }]],
  ['re-read far (0–14, back to 3–4, 15–L)', (L) => [{ startLine: 0, endLine: 14 }, { startLine: 3, endLine: 4 }, { startLine: 15, endLine: L }]],
  ['resume mid-page (line 8)', (L) => [{ startLine: 8, endLine: L }]],
];

interface StartVariant {
  label: string;
  pipeline: Pipeline;
  prepare?: (seed: number) => PageConfig['prepare'];
}

const START_VARIANTS: readonly StartVariant[] = [
  { label: 'old 1.0', pipeline: OLD },
  { label: 'new, stored calibration (reset({}))', pipeline: NEW },
  { label: 'new, just calibrated (reset({ calibrated }))', pipeline: NEW, prepare: () => (t) => t.reset?.({ calibrated: true }) },
  {
    label: 'new, re-opened after lines 0–10 (reset({ keepDrift }))',
    pipeline: NEW,
    prepare: (seed) => afterReading(seed, { keepDrift: true }, { doc: APP_DOC_LONG, endLine: 10 }),
  },
  {
    label: 'new, re-opened after a page (reset({ keepDrift }))',
    pipeline: NEW,
    prepare: (seed) => afterReading(seed, { keepDrift: true }, { doc: APP_DOC_LONG }),
  },
];

/** Pages whose short last line sits below a block gap (the sweep into it is classified as a jump). */
const GAP_PAGES: ReadonlyArray<readonly [label: string, gapPx: number, widthFraction: number]> = [
  ['short last line after a scene break (2.8 pitches down)', 75, 0.3],
  ['last line is a heading (2.6 pitches down)', 68, 0.45],
  ['short last line 3.8 pitches down', 2.8 * 42, 0.25],
];

const rulesText = (r: Record<string, number>): string =>
  Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');

function sessionRow(label: string, p: Pipeline, s: SessionSummary): string[] {
  return [
    label,
    p.name,
    `${pct(s.onLine)} (${pct(s.onLineMin, 0)})`,
    pct(s.onLineAfterTurn),
    `${s.premature} / ${s.unsafe} / ${s.missed}`,
    String(s.skippedLines),
    `${fmt(s.latencyMedian, 0)} / ${fmt(s.latencyP90, 0)}`,
    fmt(s.driftError, 2),
    rulesText(s.rules),
  ];
}

function pageRow(label: string, p: string, s: PageSummary): string[] {
  return [
    label,
    p,
    `${pct(s.onLine)} (${pct(s.onLineMin, 0)})`,
    `${s.premature} / ${s.unsafe} / ${s.missed}`,
    `${fmt(s.latencyMedian, 0)} / ${fmt(s.latencyP90, 0)}`,
    rulesText(s.rules),
  ];
}

const SESSION_HEAD = ['scenario', 'pipeline', 'on line (worst)', 'after turn', 'premature / unsafe / missed', 'skipped', 'latency ms', 'drift err', 'rules'];
const PAGE_HEAD = ['scenario', 'pipeline', 'on line (worst)', 'premature / unsafe / missed', 'latency ms (vs end of last line)', 'rules'];

const PIPELINES: readonly Pipeline[] = [OLD, NEW, NEW_TRACKER_OLD_DETECTOR];

interface InterruptScenario {
  label: string;
  look: InterruptConfig['look'];
  lookMs: number;
  offset?: Offset;
}

const INTERRUPT_SCENARIOS: readonly InterruptScenario[] = [
  { label: 'glance 3 lines down and back (350 ms)', look: { kind: 'glance', dyLines: 3 }, lookMs: 350 },
  { label: 'glance 5 lines down and back (350 ms)', look: { kind: 'glance', dyLines: 5 }, lookMs: 350 },
  { label: 'glance 3 lines up and back (350 ms)', look: { kind: 'glance', dyLines: -3 }, lookMs: 350 },
  { label: 'glance 3 lines down and back, offset +2', look: { kind: 'glance', dyLines: 3 }, lookMs: 350, offset: { dy: 2 } },
  { label: 'peek at the end of the page, 400 ms', look: { kind: 'peek' }, lookMs: 400 },
  { label: 'peek at the end of the page, 800 ms', look: { kind: 'peek' }, lookMs: 800 },
  { label: 'peek at the end of the page, 1200 ms', look: { kind: 'peek' }, lookMs: 1200 },
  { label: 'peek at the end of the page, 800 ms, offset +2', look: { kind: 'peek' }, lookMs: 800, offset: { dy: 2 } },
];

describe('reading layer vs gaze offsets (scoreboard)', () => {
  const cache = new Map<string, SessionSummary>();
  const key = (doc: string, label: string, p: Pipeline): string => `${doc} · ${label} · ${p.name}`;
  const summary = (doc: string, sc: SessionScenario, p: Pipeline): SessionSummary => {
    const k = key(doc, sc.label, p);
    let s = cache.get(k);
    if (!s) {
      s = summarizeSessions(SEEDS.map((seed) => runSession({ seed, pipeline: p, schedule: sc.schedule, doc: DOCS[doc], ...sc.extra })));
      cache.set(k, s);
    }
    return s;
  };
  const table = (title: string, doc: string, scenarios: readonly SessionScenario[], pipelines: readonly Pipeline[]): void => {
    const rows: string[][] = [];
    for (const sc of scenarios) {
      for (const p of pipelines) {
        if (sc.newOnly && p === OLD) continue;
        rows.push(sessionRow(sc.label, p, summary(doc, sc, p)));
      }
    }
    console.log(`\n### ${title}\n\n` + markdownTable(SESSION_HEAD, rows));
  };
  const bad = (s: SessionSummary): number => s.premature + s.unsafe;

  it(`sessions, ${GAPPED} document: 24 seeds × 7 turns per row`, () => {
    table(`Sessions, ${GAPPED} (168 turns per row)`, GAPPED, GAPPED_SCENARIOS, PIPELINES);
    // The headline claims, so a regression shows up as a failure here too.
    const n = (label: string): SessionSummary => cache.get(key(GAPPED, label, NEW))!;
    expect(n('none').onLine).toBeGreaterThanOrEqual(0.99);
    const headline = ['constant +2', 'constant -2', ...EVENT_DELAYS.flatMap((d) => [`step +3 + event (${d / 1000} s)`, `step +4 + event (${d / 1000} s)`])];
    for (const label of headline) expect(bad(n(label)) + n(label).missed, label).toBe(0);
    expect(n('constant +2').onLine).toBeGreaterThan(0.9);
    // A report 2.3 s late works as one on time: no missed turn after a step up (before: 3–6 of 168).
    for (const dy of [-3, -4]) expect(n(`step ${dy} + event (2.3 s)`).missed, `step ${dy}`).toBe(0);
  });

  it('sessions, app layouts (no paragraph gaps): 24 seeds × 7 turns per row', () => {
    for (const doc of ['app', 'app, long ¶']) table(`Sessions, ${doc} (168 turns per row)`, doc, APP_SCENARIOS, [OLD, NEW]);
    const n = (doc: string, label: string): SessionSummary => cache.get(key(doc, label, NEW))!;
    const o = (doc: string, label: string): SessionSummary => cache.get(key(doc, label, OLD))!;
    // The lighting rows on the app layout, at today's level (1.0: every turn early or missed).
    expect(bad(n('app', 'constant +3')), 'app constant +3').toBeLessThanOrEqual(3);
    expect(n('app', 'constant +3').missed, 'app constant +3').toBe(0);
    expect(bad(n('app', 'constant -3')) + n('app', 'constant -3').missed, 'app constant -3').toBe(0);
    for (const label of ['constant +2', 'constant -2']) expect(bad(n('app', label)) + n('app', label).missed, `app ${label}`).toBe(0);
    // Steady light at high noise: no more early or unsafe turns than 1.0 (known limits excepted).
    for (const doc of ['app', 'app, long ¶']) {
      for (const label of ['noise 1.2', 'noise 1.4', 'harsh (wander .3, blinks 15)']) {
        const allowed = bad(o(doc, label)) + (KNOWN_EXCESS[`${doc} · ${label}`] ?? 0);
        expect(bad(n(doc, label)), `${doc} · ${label}`).toBeLessThanOrEqual(allowed);
      }
    }
  });

  it('sessions, steady light without an offset (acceptance: early + unsafe at most 1.0 + 2)', () => {
    const rows: string[][] = [];
    for (const [doc, sc] of STEADY_SCENARIOS) {
      for (const p of [OLD, NEW]) rows.push(sessionRow(`${doc} · ${sc.label}`, p, summary(doc, sc, p)));
    }
    console.log('\n### Sessions, steady light (168 turns per row; missed turns informational)\n\n' + markdownTable(SESSION_HEAD, rows));
    for (const [doc, sc] of STEADY_SCENARIOS) {
      const label = `${doc} · ${sc.label}`;
      const allowed = bad(summary(doc, sc, OLD)) + 2 + (KNOWN_EXCESS[label] ?? 0);
      expect(bad(summary(doc, sc, NEW)), label).toBeLessThanOrEqual(allowed);
    }
  });

  it('single fresh pages: 24 seeds per row', () => {
    const rows: string[][] = [];
    for (const sc of PAGE_SCENARIOS) {
      for (const p of PIPELINES) {
        const s = summarizePages(SEEDS.map((seed) => runPage({ seed, pipeline: p, segments: sc.segments, offset: sc.offset })));
        rows.push(pageRow(sc.label, p.name, s));
      }
    }
    console.log(`\n### Single fresh pages, ${GAPPED} (24 per row)\n\n` + markdownTable(PAGE_HEAD, rows));
  });

  it('first pages after a start on long gapless paragraphs (app, long ¶): 96 seeds per row', () => {
    const seeds = Array.from({ length: 96 }, (_, i) => i + 1);
    const rows: string[][] = [];
    const bads = new Map<string, number>();
    for (const noiseLines of [0.75, 1.2]) {
      for (const [label, segments] of START_ORDERS) {
        for (const v of START_VARIANTS) {
          const s = summarizePages(
            seeds.map((seed) => runPage({ seed, pipeline: v.pipeline, segments, doc: APP_DOC_LONG, noiseLines, prepare: v.prepare?.(seed) })),
          );
          bads.set(`${noiseLines} · ${label} · ${v.label}`, s.premature + s.unsafe);
          rows.push(pageRow(`${label}, noise ${noiseLines}`, v.label, s));
        }
      }
    }
    console.log('\n### First pages after a start, app, long ¶ (96 per row)\n\n' + markdownTable(PAGE_HEAD, rows));
    // A book opened again (keepDrift) never starts weaker than a start with a stored calibration.
    for (const noiseLines of [0.75, 1.2]) {
      for (const [label] of START_ORDERS) {
        const k = (v: StartVariant): number => bads.get(`${noiseLines} · ${label} · ${v.label}`)!;
        const stored = k(START_VARIANTS[1]!);
        for (const v of START_VARIANTS.slice(2)) expect(k(v), `${label}, noise ${noiseLines}: ${v.label}`).toBeLessThanOrEqual(stored + 1);
      }
    }
  });

  it('pages whose last line follows a block gap: 48 seeds per row', () => {
    const seeds = Array.from({ length: 48 }, (_, i) => i + 1);
    const rows: string[][] = [];
    for (const [label, gapPx, widthFraction] of GAP_PAGES) {
      for (const noiseLines of [0.75, 1.2]) {
        for (const p of PIPELINES) {
          const s = summarizePages(
            seeds.map((seed) => {
              const page = makeReadingPage(seed, APP_DOC);
              return runPage({ seed, pipeline: p, noiseLines, layout: withBlockGap(page, lastFullyVisibleIndex(page), gapPx, widthFraction) });
            }),
          );
          rows.push(pageRow(`${label}, noise ${noiseLines}`, p.name, s));
          if (p === NEW) {
            expect(s.premature + s.unsafe, label).toBe(0);
            expect(s.latencyP90, `${label}, noise ${noiseLines}`).toBeLessThanOrEqual(500);
          }
        }
      }
    }
    console.log('\n### Last line after a block gap, app (48 per row)\n\n' + markdownTable(PAGE_HEAD, rows));
  });

  it('interrupted reading: glances and peeks mid-page', () => {
    const rows: string[][] = [];
    for (const sc of INTERRUPT_SCENARIOS) {
      for (const p of PIPELINES) {
        const presets = sc.look.kind === 'peek' ? (['balanced', 'eager'] as const) : (['balanced'] as const);
        const runs = presets.flatMap((sensitivity) =>
          SEEDS.map((seed) => runInterrupted({ seed, pipeline: p, look: sc.look, lookMs: sc.lookMs, sensitivity, offset: sc.offset })),
        );
        const fix = runs.reduce((a, r) => a + r.fixations, 0);
        const onLine = runs.reduce((a, r) => a + r.onLine, 0) / Math.max(1, fix);
        const worst = Math.min(...runs.map((r) => r.onLine / Math.max(1, r.fixations)));
        const turned = runs.filter((r) => r.fired);
        rows.push([
          sc.label,
          p.name,
          sc.look.kind === 'glance' ? `${pct(onLine)} (${pct(worst, 0)})` : '–',
          `${runs.filter((r) => r.premature).length} / ${runs.filter((r) => r.unsafe).length}`,
          sc.look.kind === 'peek' ? `${turned.length} of ${runs.length}` : `${runs.length - turned.length} of ${runs.length}`,
        ]);
      }
    }
    console.log(
      '\n### Interrupted reading (24 pages per row; peeks at balanced + eager, 48)\n\n' +
        markdownTable(['scenario', 'pipeline', 'on line after the look (worst)', 'premature / unsafe', 'peek: turned mid-page · glance: missed'], rows),
    );
  });
});
