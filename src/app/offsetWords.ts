/**
 * The accuracy check's verdict, in one place: the calibration overlay's results
 * screen (badge, title, suggested button) and the toast and Dewey line after
 * "Done" (accuracyCheckView in ./logic) both read it, so they can't disagree.
 * Pure: no DOM, no globals.
 */
import type { CalibrationQuality } from '../types';

/** Below this vertical offset (lines) the tracking counts as on target. */
export const ON_TARGET_LINES = 0.5;
/** From this vertical offset (lines) the accuracy check recommends "Correct it". */
export const CORRECT_FROM_LINES = 0.75;
/** A horizontal offset from this fraction of the viewport width is worded and corrected. */
export const OFFSET_X_FRAC = 0.06;
/**
 * The worst single dot's vertical error (lines): from DOT_OFF_LINES the check is not on target
 * whatever the mean says, from DOT_CORRECT_LINES it is worth correcting, from DOT_BIG_LINES it
 * has drifted. The dots sit symmetrically (y = 0.15, 0.5, 0.5, 0.85, 0.85), so a scale error
 * (sitting further back than at calibration: the top reads high, the bottom low) cancels in the
 * mean — and the bottom of the page is exactly where page turns are decided.
 */
export const DOT_OFF_LINES = 1;
export const DOT_CORRECT_LINES = 1.5;
export const DOT_BIG_LINES = 2;
/** A mean offset from this many lines (or twice OFFSET_X_FRAC sideways) has "drifted". */
export const BIG_OFFSET_LINES = 2;

export interface OffsetWords {
  /**
   * Follows "Tracking reads …": "about 2 lines low", "about half a line high and a bit to the
   * left", "up to 2 lines off near the top and bottom", or "within half a line".
   */
  text: string;
  /** Within half a line vertically, every dot within DOT_OFF_LINES, and no notable horizontal offset. */
  onTarget: boolean;
  /** Large enough that correcting it is worth it (≥ CORRECT_FROM_LINES, a horizontal offset, or a dot ≥ DOT_CORRECT_LINES off). */
  worthCorrecting: boolean;
  /** Large: ≥ BIG_OFFSET_LINES, a horizontal offset ≥ 2 × OFFSET_X_FRAC, or a dot ≥ DOT_BIG_LINES off. */
  big: boolean;
  vertical: 'low' | 'high' | null;
  horizontal: 'left' | 'right' | null;
  /** The dots disagree by a line or more beyond the mean offset (a scale error or scatter). */
  spread: boolean;
}

const lineWord = (n: number): string => (n === 1 ? '1 line' : `${n} lines`);

/**
 * Plain words for a measured offset. `offsetYLines` > 0 means the gaze estimate lands below
 * where the reader looks ("reads low"); `offsetXFrac` is the horizontal offset as a fraction of
 * the viewport width (> 0 = to the right); `maxDotYLines` is the worst dot's vertical error in
 * lines (NaN when unknown: the verdict then rests on the mean alone). Non-finite `offsetYLines`
 * reads as "unknown".
 */
export function describeOffset(offsetYLines: number, offsetXFrac = 0, maxDotYLines = Number.NaN): OffsetWords {
  if (!Number.isFinite(offsetYLines)) {
    return { text: 'unknown', onTarget: false, worthCorrecting: false, big: false, vertical: null, horizontal: null, spread: false };
  }
  const fx = Number.isFinite(offsetXFrac) ? offsetXFrac : 0;
  const ay = Math.abs(offsetYLines);
  const dot = Number.isFinite(maxDotYLines) ? Math.max(0, maxDotYLines) : Number.NaN;
  const vertical = ay < ON_TARGET_LINES ? null : offsetYLines > 0 ? 'low' : 'high';
  const horizontal = Math.abs(fx) < OFFSET_X_FRAC ? null : fx > 0 ? 'right' : 'left';
  // Worth its own words when it is the whole story (the mean is within half a line), or when the
  // dots disagree by a line beyond the shared offset.
  const spread = dot >= DOT_OFF_LINES && (vertical === null || dot - ay >= DOT_OFF_LINES);
  const parts: string[] = [];
  if (vertical) {
    const amount = ay < 0.75 ? 'half a line' : ay < 1.5 ? '1 line' : `${Math.round(ay)} lines`;
    parts.push(`about ${amount} ${vertical}`);
  }
  if (horizontal) parts.push(`${Math.abs(fx) < 2 * OFFSET_X_FRAC ? 'a bit ' : ''}to the ${horizontal}`);
  let text = parts.length > 0 ? parts.join(' and ') : 'within half a line';
  if (spread) {
    const up = `up to ${lineWord(Math.max(1, Math.round(dot)))} off near the top and bottom`;
    text = parts.length > 0 ? `${text}, and ${up}` : up;
  }
  return {
    text,
    onTarget: parts.length === 0 && !(dot >= DOT_OFF_LINES),
    worthCorrecting: ay >= CORRECT_FROM_LINES || horizontal !== null || dot >= DOT_CORRECT_LINES,
    big: ay >= BIG_OFFSET_LINES || Math.abs(fx) >= 2 * OFFSET_X_FRAC || dot >= DOT_BIG_LINES,
    vertical,
    horizontal,
    spread,
  };
}

export type OffsetBadge = 'On target' | 'Close enough' | 'Slightly off' | 'Drifted';

export interface OffsetVerdict {
  words: OffsetWords;
  badge: OffsetBadge;
  /** The badge's colour, on the calibration quality scale. */
  quality: CalibrationQuality;
}

/** The accuracy check's verdict: on target, then close enough (not worth correcting), then drifted (big), else slightly off. */
export function offsetVerdict(offsetYLines: number, offsetXFrac = 0, maxDotYLines = Number.NaN): OffsetVerdict {
  const words = describeOffset(offsetYLines, offsetXFrac, maxDotYLines);
  const [badge, quality]: [OffsetBadge, CalibrationQuality] = words.onTarget
    ? ['On target', 'excellent']
    : !words.worthCorrecting
      ? ['Close enough', 'good']
      : words.big
        ? ['Drifted', 'poor']
        : ['Slightly off', 'fair'];
  return { words, badge, quality };
}

/**
 * "within half a line", "within about 1 line", "within about 2 lines", from the worst dot's
 * vertical error (lines); "within half a line" when unknown.
 */
export function withinWords(maxDotYLines: number | undefined): string {
  const m = maxDotYLines ?? Number.NaN;
  if (!Number.isFinite(m) || m < 0.75) return 'within half a line';
  return `within about ${lineWord(Math.max(1, Math.round(m)))}`;
}
