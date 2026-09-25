import type { Fixation, GazeSample, LayoutChangeReason, LineEstimate, LineLayout, PageEndDecision, Sensitivity } from '../../src/types';
import { LineTracker } from '../../src/reading/lineTracker';
import { PageEndDetector, type PageEndInput } from '../../src/reading/pageEndDetector';
import type { SyntheticDocOptions } from '../../src/reading/testLayouts';
import { LegacyLineTracker } from './legacyLineTracker';
import { LegacyPageEndDetector } from './legacyPageEndDetector';

/**
 * Shared pieces of the reading-layer benchmarks: the pipelines being compared,
 * the gaze offsets injected into the smoothed samples, and small statistics
 * and table helpers. See session.ts (multi-page sessions wired like the app
 * controller) and page.ts (single pages with scripted reading orders).
 */

/** What the benchmarks need from a line tracker (the shipped and the frozen 1.0 one). */
export interface TrackerLike {
  readonly estimate: LineEstimate | null;
  setLayout(layout: LineLayout, reason: LayoutChangeReason): void;
  onFixation(f: Fixation): LineEstimate;
  onSample(s: GazeSample): LineEstimate | null;
  afterPageTurn(resumeLineIndex: number): void;
  /** Absent on the 1.0 tracker. */
  appearanceChangedAt?(t: number): void;
  /** The 1.0 tracker's takes no options. */
  reset?(opts?: { keepDrift?: boolean; calibrated?: boolean }): void;
}

export interface DetectorLike {
  update(input: PageEndInput): PageEndDecision;
  notifyScrolled(t: number): void;
}

export interface Pipeline {
  /** Short label for the scoreboard. */
  name: string;
  tracker: () => TrackerLike;
  detector: (sensitivity?: Sensitivity) => DetectorLike;
}

/** Gaze Reader 1.0 as shipped: ±1.5-line drift tracker and its page-end detector (frozen copies). */
export const OLD: Pipeline = {
  name: 'old 1.0',
  tracker: () => new LegacyLineTracker(),
  detector: (sensitivity = 'balanced') => new LegacyPageEndDetector({ sensitivity }),
};
/** The current modules. */
export const NEW: Pipeline = {
  name: 'new',
  tracker: () => new LineTracker(),
  detector: (sensitivity = 'balanced') => new PageEndDetector({ sensitivity }),
};
/** The current tracker with the 1.0 page-end detector: isolates what the detector changes buy. */
export const NEW_TRACKER_OLD_DETECTOR: Pipeline = {
  name: 'new tracker + 1.0 detector',
  tracker: () => new LineTracker(),
  detector: (sensitivity = 'balanced') => new LegacyPageEndDetector({ sensitivity }),
};

// ─────────────────────────────── layouts ───────────────────────────────

/**
 * The app reader's layout (reader.css.ts: `p { margin: 0 }`, `p + p { text-indent: 1.5em }` at
 * 22 px): no gaps between paragraphs, a 33 px first-line indent, 3–9-line paragraphs. The
 * default synthetic document has 0.5-pitch paragraph gaps, like most web articles (the
 * extension); gaps and short lines are what tell (line k, drift 0) from (line k + 1, drift −1).
 */
export const APP_DOC: Readonly<SyntheticDocOptions> = Object.freeze({ paragraphGap: 0, indentPx: 33, paragraphLines: [3, 9] as const });
/** The app layout with long paragraphs (12–30 lines): little structure to pin the drift. */
export const APP_DOC_LONG: Readonly<SyntheticDocOptions> = Object.freeze({ ...APP_DOC, paragraphLines: [12, 30] as const });
/** One paragraph per document: no structure but the page's top and bottom. */
export const ONE_PARAGRAPH_DOC: Readonly<SyntheticDocOptions> = Object.freeze({ paragraphLines: [Infinity, Infinity] as const });

/**
 * A gaze offset at one moment: `dy` lines (positive = gaze reads lower than
 * the eyes look, as a squint in bright light does), `dx` px, and a vertical
 * gain `scale` about the viewport's centre.
 */
export interface Offset {
  dy: number;
  dx?: number;
  scale?: number;
}

/** Offset as a function of time since the start (ms) and the page index (0 = first page). */
export type Schedule = (tRel: number, page: number) => Offset;

export const noOffset: Schedule = () => ({ dy: 0 });
export const constant = (dy: number, dx = 0): Schedule => () => ({ dy, dx });
export const scaled = (scale: number): Schedule => () => ({ dy: 0, scale });
/** A sudden change at `atMs` (a light switched on or off). */
export const stepAt = (dy: number, atMs: number): Schedule => (t) => ({ dy: t >= atMs ? dy : 0 });

/** Applies an offset to a (smoothed) sample. */
export function applyOffset(s: GazeSample, o: Offset, pitch: number, centerY: number): GazeSample {
  if (!s.valid) return s;
  let y = s.y;
  if (o.scale !== undefined) y = centerY + o.scale * (y - centerY);
  return { ...s, y: y + o.dy * pitch, x: s.x + (o.dx ?? 0) };
}

/** The injected vertical offset, in lines, at the height `y` (px) — what driftY should learn there. */
export function offsetLinesAt(o: Offset, y: number, pitch: number, centerY: number): number {
  const gain = o.scale !== undefined ? (o.scale - 1) * (y - centerY) : 0;
  return o.dy + gain / pitch;
}

// ─────────────────────────────── statistics ───────────────────────────────

export const mean = (a: readonly number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

export function quantile(a: readonly number[], q: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
}

export const fmt = (v: number, digits = 1): string => (Number.isFinite(v) ? v.toFixed(digits) : '–');
export const pct = (v: number, digits = 1): string => (Number.isFinite(v) ? `${(100 * v).toFixed(digits)}%` : '–');

export function markdownTable(head: readonly string[], rows: readonly (readonly string[])[]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/** Binary search: the truth entry in effect at time t (entries sorted by t). */
export function truthAt(truth: readonly { t: number; lineIndex: number }[], t: number): number {
  if (truth.length === 0) return -1;
  let lo = 0;
  let hi = truth.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (truth[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return truth[lo]!.lineIndex;
}
