import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../core/settings';
import type { AppSettings, TextLine } from '../types';
import {
  BreakTimer,
  ProgressMeter,
  ReadingClock,
  SETTINGS_GROUPS,
  SHORTCUTS,
  TrackingStateMachine,
  calibrationFitsViewport,
  cameraErrorInfo,
  computeWpm,
  deriveTitle,
  firstFullyVisibleIndex,
  formatMinutes,
  formatPercent,
  guessTextFormat,
  keyTargetKind,
  lastFullyVisibleIndex,
  minutesLeft,
  normalizeUrl,
  previewCorner,
  relativeTime,
  resetPatch,
  resolveTheme,
  resumeLineIndex,
  sameStatus,
  shortcutFor,
  shouldIgnoreShortcut,
  statusPill,
  trackerErrorCode,
  type TrackingContext,
} from './logic';

const running = (over: Partial<TrackingContext> = {}): TrackingContext => ({
  phase: 'running',
  kind: 'webcam',
  autoScroll: true,
  ...over,
});

/** Feeds samples every `dt` ms from `from` (exclusive) to `to` (inclusive). */
function feed(m: TrackingStateMachine, from: number, to: number, valid: boolean, confidence = 0.9, dt = 33): number {
  let t = from;
  while (t + dt <= to) {
    t += dt;
    m.push({ t, valid, confidence });
  }
  return t;
}

describe('TrackingStateMachine', () => {
  it('maps non-running phases straight through, keeping the detail', () => {
    const m = new TrackingStateMachine();
    expect(m.evaluate(0, running({ phase: 'off' }))).toEqual({ state: 'off' });
    expect(m.evaluate(0, running({ phase: 'starting' })).state).toBe('starting');
    expect(m.evaluate(0, running({ phase: 'calibrating' })).state).toBe('calibrating');
    expect(m.evaluate(0, running({ phase: 'error', detail: 'blocked' }))).toEqual({ state: 'error', detail: 'blocked' });
  });

  it('reports tracking while valid samples flow', () => {
    const m = new TrackingStateMachine();
    m.reset(0);
    const t = feed(m, 0, 2000, true);
    expect(m.evaluate(t, running()).state).toBe('tracking');
  });

  it('gives a fresh source a 1 s grace period before "no-face"', () => {
    const m = new TrackingStateMachine();
    m.reset(10_000);
    expect(m.evaluate(10_900, running()).state).toBe('tracking');
    expect(m.evaluate(11_001, running()).state).toBe('no-face');
  });

  it('enters no-face only after > 1 s of invalid samples', () => {
    const m = new TrackingStateMachine();
    m.reset(0);
    let t = feed(m, 0, 1000, true);
    const lastValid = t;
    t = feed(m, t, lastValid + 990, false);
    expect(m.evaluate(lastValid + 990, running()).state).toBe('tracking');
    t = feed(m, t, lastValid + 1100, false);
    expect(m.evaluate(t, running()).state).toBe('no-face');
  });

  it('treats a stalled source (no samples at all) as no-face', () => {
    const m = new TrackingStateMachine();
    m.reset(0);
    const t = feed(m, 0, 500, true);
    expect(m.evaluate(t + 1200, running()).state).toBe('no-face');
  });

  it('needs a sustained valid run to recover from no-face (no flicker)', () => {
    const m = new TrackingStateMachine();
    m.reset(0);
    let t = feed(m, 0, 500, true);
    t = feed(m, t, t + 1500, false);
    expect(m.evaluate(t, running()).state).toBe('no-face');

    // One stray valid frame does not end no-face.
    t += 33;
    m.push({ t, valid: true, confidence: 0.9 });
    expect(m.evaluate(t, running()).state).toBe('no-face');
    t = feed(m, t, t + 100, false);
    expect(m.evaluate(t, running()).state).toBe('no-face');

    // 250 ms of continuous valid samples does.
    const runStart = t + 33;
    m.push({ t: runStart, valid: true, confidence: 0.9 });
    t = feed(m, runStart, runStart + 250, true);
    expect(m.evaluate(t, running()).state).toBe('tracking');
  });

  it('flags low confidence with hysteresis', () => {
    const m = new TrackingStateMachine();
    m.reset(0);
    let t = feed(m, 0, 3000, true, 0.2);
    expect(m.evaluate(t, running()).state).toBe('poor');
    // Slightly better but still under the exit threshold → stays poor.
    t = feed(m, t, t + 3000, true, 0.36);
    expect(m.evaluate(t, running()).state).toBe('poor');
    t = feed(m, t, t + 3000, true, 0.8);
    expect(m.evaluate(t, running()).state).toBe('tracking');
  });

  it('smooths confidence so a single bad frame does not flip the state', () => {
    const m = new TrackingStateMachine();
    m.reset(0);
    let t = feed(m, 0, 2000, true, 0.9);
    t += 33;
    m.push({ t, valid: true, confidence: 0 });
    expect(m.evaluate(t, running()).state).toBe('tracking');
    expect(m.smoothedConfidence).toBeGreaterThan(0.8);
  });

  it('prioritises no-face over paused, and paused over poor', () => {
    const m = new TrackingStateMachine();
    m.reset(0);
    let t = feed(m, 0, 3000, true, 0.1);
    expect(m.evaluate(t, running({ autoScroll: false })).state).toBe('paused');
    t = feed(m, t, t + 1500, false);
    expect(m.evaluate(t, running({ autoScroll: false })).state).toBe('no-face');
  });

  it('never reports no-face or poor for mouse and demo sources', () => {
    const m = new TrackingStateMachine();
    m.reset(0);
    const t = feed(m, 0, 3000, false);
    expect(m.evaluate(t, running({ kind: 'mouse' })).state).toBe('tracking');
    expect(m.evaluate(t, running({ kind: 'simulated' })).state).toBe('tracking');
    expect(m.evaluate(t, running({ kind: 'mouse', autoScroll: false })).state).toBe('paused');
  });

  it('ignores non-finite timestamps and confidences', () => {
    const m = new TrackingStateMachine();
    m.reset(0);
    m.push({ t: Number.NaN, valid: true, confidence: 1 });
    expect(m.smoothedConfidence).toBeNull();
    m.push({ t: 10, valid: true, confidence: Number.NaN });
    expect(m.smoothedConfidence).toBe(0);
  });

  it('sameStatus compares state and detail', () => {
    expect(sameStatus(null, { state: 'off' })).toBe(false);
    expect(sameStatus({ state: 'off' }, { state: 'off' })).toBe(true);
    expect(sameStatus({ state: 'error', detail: 'a' }, { state: 'error', detail: 'b' })).toBe(false);
  });
});

describe('statusPill', () => {
  it('uses the agreed vocabulary', () => {
    expect(statusPill('tracking', 'webcam', true).label).toBe('Tracking');
    expect(statusPill('no-face', 'webcam', true).label).toBe('Looking for you');
    expect(statusPill('poor', 'webcam', true).label).toBe('Low confidence');
    expect(statusPill('paused', 'webcam', true).label).toBe('Paused');
    expect(statusPill('off', null, false).label).toBe('Camera off');
    expect(statusPill('tracking', 'simulated', false).label).toBe('Demo');
    expect(statusPill('tracking', 'mouse', false).label).toBe('Mouse');
    expect(statusPill('paused', 'mouse', false).label).toBe('Paused');
  });

  it('mentions the camera whenever it is on', () => {
    for (const s of ['tracking', 'no-face', 'poor', 'paused', 'starting', 'calibrating'] as const) {
      expect(statusPill(s, 'webcam', true).description).toMatch(/Camera on/);
    }
    expect(statusPill('paused', 'mouse', false).description).not.toMatch(/Camera on/);
  });

  it('uses tones that match severity', () => {
    expect(statusPill('tracking', 'webcam', true).tone).toBe('ok');
    expect(statusPill('no-face', 'webcam', true).tone).toBe('warn');
    expect(statusPill('error', 'webcam', false).tone).toBe('bad');
    expect(statusPill('paused', 'webcam', true).tone).toBe('idle');
  });
});

function line(i: number, docTop: number, fullyVisible = true): TextLine {
  return {
    index: i,
    top: docTop,
    bottom: docTop + 30,
    left: 100,
    right: 700,
    centerY: docTop + 15,
    docTop,
    charCount: 60,
    fullyVisible,
  };
}

describe('resumeLineIndex', () => {
  const pitch = 40;
  // After a turn with overlap 1 the last line read (old docTop 1200) sits at the top.
  const lines = [line(0, 1120, false), line(1, 1160, false), line(2, 1200.4), line(3, 1240), line(4, 1280)];

  it('returns the first line below the target, not the target itself', () => {
    expect(resumeLineIndex(lines, 1200, pitch)).toBe(3);
  });

  it('tolerates sub-pixel re-measurement wobble', () => {
    const wobbly = [line(0, 1199.6), line(1, 1200.9), line(2, 1240.2)];
    expect(resumeLineIndex(wobbly, 1200, pitch)).toBe(2);
  });

  it('works when the target scrolled out of the measured window (overlap 0)', () => {
    const noOverlap = [line(0, 1240), line(1, 1280), line(2, 1320)];
    expect(resumeLineIndex(noOverlap, 1200, pitch)).toBe(0);
  });

  it('falls back to the first fully visible line when the target is unknown', () => {
    expect(resumeLineIndex(lines, null, pitch)).toBe(2);
    expect(resumeLineIndex(lines, Number.NaN, pitch)).toBe(2);
    expect(resumeLineIndex([line(0, 0, false)], null, pitch)).toBe(0);
  });

  it('returns the last line when nothing lies below, and -1 for an empty layout', () => {
    expect(resumeLineIndex(lines, 5000, pitch)).toBe(4);
    expect(resumeLineIndex([], 100, pitch)).toBe(-1);
  });

  it('skips lines with non-finite docTop and survives a bad pitch', () => {
    const bad = [line(0, Number.NaN), line(1, 1300)];
    expect(resumeLineIndex(bad, 1200, Number.NaN)).toBe(1);
    expect(resumeLineIndex([line(0, 1200.5), line(1, 1240)], 1200, 0)).toBe(1);
  });

  it('finds first / last fully visible lines', () => {
    expect(firstFullyVisibleIndex(lines)).toBe(2);
    expect(lastFullyVisibleIndex(lines)).toBe(4);
    expect(lastFullyVisibleIndex([line(0, 0, false)])).toBe(-1);
    expect(firstFullyVisibleIndex([])).toBe(-1);
  });
});

describe('reading time, progress and WPM', () => {
  it('ReadingClock counts only active time and caps long gaps', () => {
    const c = new ReadingClock(2000);
    expect(c.tick(0, true)).toBe(0);
    expect(c.tick(1000, true)).toBe(1000);
    c.tick(2000, false);
    c.tick(3000, true);
    expect(c.minutes).toBeCloseTo(2000 / 60_000);
    // Laptop slept for an hour: only 2 s count.
    expect(c.tick(3000 + 3_600_000, true)).toBe(2000);
    expect(c.minutes).toBeCloseTo(4000 / 60_000);
    c.tick(Number.NaN, true);
    expect(c.minutes).toBeCloseTo(4000 / 60_000);
    c.reset();
    expect(c.minutes).toBe(0);
  });

  it('ProgressMeter counts forward reading and ignores jumps and regressions', () => {
    const m = new ProgressMeter(10_000);
    m.update(0.1);
    m.update(0.12); // +200 words
    m.update(0.11); // back: ignored
    m.update(0.13); // +200
    m.update(0.6); // scrollbar jump of 4700 words: ignored
    m.update(0.61); // +100
    m.update(Number.NaN);
    expect(m.wordsAdvanced).toBeCloseTo(500);
  });

  it('ProgressMeter is safe with a zero word count', () => {
    const m = new ProgressMeter(0);
    m.update(0);
    m.update(1);
    expect(m.wordsAdvanced).toBe(0);
  });

  it('computeWpm needs enough data and rejects implausible rates', () => {
    expect(computeWpm(500, 2)).toBe(250);
    expect(computeWpm(40, 2)).toBeNull();
    expect(computeWpm(500, 0.2)).toBeNull();
    expect(computeWpm(10_000, 1)).toBeNull();
    expect(computeWpm(Number.NaN, 2)).toBeNull();
    expect(computeWpm(301, 1.2)).toBe(251);
  });

  it('minutesLeft', () => {
    expect(minutesLeft(0.5, 10_000, 250)).toBe(20);
    expect(minutesLeft(1.2, 10_000, 250)).toBe(0);
    expect(minutesLeft(0.5, 10_000, 0)).toBeNull();
    expect(minutesLeft(Number.NaN, 10_000, 250)).toBeNull();
  });

  it('BreakTimer fires once per interval of active reading', () => {
    const b = new BreakTimer();
    let fired = 0;
    for (let i = 0; i < 20 * 60; i++) if (b.tick(1000, true, 20, true)) fired++;
    expect(fired).toBe(1);
    for (let i = 0; i < 19 * 60; i++) if (b.tick(1000, true, 20, true)) fired++;
    expect(fired).toBe(1);
    for (let i = 0; i < 60; i++) if (b.tick(1000, true, 20, true)) fired++;
    expect(fired).toBe(2);
  });

  it('BreakTimer treats a long idle stretch as a break, and pauses while idle', () => {
    const b = new BreakTimer(5 * 60_000);
    for (let i = 0; i < 15 * 60; i++) b.tick(1000, true, 20, true);
    for (let i = 0; i < 2 * 60; i++) b.tick(1000, false, 20, true); // short pause: keeps count
    let fired = false;
    for (let i = 0; i < 5 * 60; i++) fired ||= b.tick(1000, true, 20, true);
    expect(fired).toBe(true);

    const c = new BreakTimer(5 * 60_000);
    for (let i = 0; i < 15 * 60; i++) c.tick(1000, true, 20, true);
    for (let i = 0; i < 6 * 60; i++) c.tick(1000, false, 20, true); // real break: resets
    fired = false;
    for (let i = 0; i < 10 * 60; i++) fired ||= c.tick(1000, true, 20, true);
    expect(fired).toBe(false);
  });

  it('BreakTimer does nothing when disabled and restarts cleanly when re-enabled', () => {
    const b = new BreakTimer();
    for (let i = 0; i < 30 * 60; i++) expect(b.tick(1000, true, 20, false)).toBe(false);
    expect(b.tick(1000, true, 20, true)).toBe(false);
    expect(b.tick(Number.NaN, true, 20, true)).toBe(false);
  });
});

describe('keyboard mapping', () => {
  it('maps the documented keys', () => {
    expect(shortcutFor({ key: ' ' })).toBe('page-forward');
    expect(shortcutFor({ key: ' ', shiftKey: true })).toBe('page-back');
    expect(shortcutFor({ key: 'PageDown' })).toBe('page-forward');
    expect(shortcutFor({ key: 'PageUp' })).toBe('page-back');
    expect(shortcutFor({ key: 'u' })).toBe('undo-turn');
    expect(shortcutFor({ key: 'P', shiftKey: true })).toBe('toggle-autoscroll');
    expect(shortcutFor({ key: 'c' })).toBe('recalibrate');
    expect(shortcutFor({ key: 'd' })).toBe('toggle-debug');
    expect(shortcutFor({ key: 'g' })).toBe('toggle-gaze-dot');
    expect(shortcutFor({ key: 's' })).toBe('open-settings');
    expect(shortcutFor({ key: 'l' })).toBe('open-library');
    expect(shortcutFor({ key: '?', shiftKey: true })).toBe('show-help');
    expect(shortcutFor({ key: 'Escape' })).toBe('escape');
  });

  it('leaves browser chords, auto-repeat and unknown keys alone', () => {
    expect(shortcutFor({ key: 's', ctrlKey: true })).toBeNull();
    expect(shortcutFor({ key: 'l', metaKey: true })).toBeNull();
    expect(shortcutFor({ key: 'd', altKey: true })).toBeNull();
    expect(shortcutFor({ key: ' ', repeat: true })).toBeNull();
    expect(shortcutFor({ key: 'x' })).toBeNull();
    expect(shortcutFor({ key: 'ArrowDown' })).toBeNull();
    expect(shortcutFor({ key: 'Escape', repeat: true })).toBe('escape');
  });

  it('every shortcut in the help table is reachable', () => {
    const reachable = new Set(
      [' ', 'PageDown', 'PageUp', 'u', 'p', 'c', 'd', 'g', 's', 'l', '?', 'Escape']
        .flatMap((key) => [shortcutFor({ key }), shortcutFor({ key, shiftKey: true })]),
    );
    for (const s of SHORTCUTS) expect(reachable.has(s.action)).toBe(true);
  });

  it('classifies focus targets', () => {
    expect(keyTargetKind(null)).toBe('other');
    expect(keyTargetKind({ tagName: 'INPUT', type: 'text' })).toBe('editable');
    expect(keyTargetKind({ tagName: 'input' })).toBe('editable');
    expect(keyTargetKind({ tagName: 'INPUT', type: 'url' })).toBe('editable');
    expect(keyTargetKind({ tagName: 'TEXTAREA' })).toBe('editable');
    expect(keyTargetKind({ tagName: 'SELECT' })).toBe('editable');
    expect(keyTargetKind({ tagName: 'DIV', isContentEditable: true })).toBe('editable');
    expect(keyTargetKind({ tagName: 'INPUT', type: 'checkbox' })).toBe('activatable');
    expect(keyTargetKind({ tagName: 'INPUT', type: 'range' })).toBe('activatable');
    expect(keyTargetKind({ tagName: 'BUTTON' })).toBe('activatable');
    expect(keyTargetKind({ tagName: 'DIV', getAttribute: (n) => (n === 'role' ? 'button' : null) })).toBe('activatable');
    expect(keyTargetKind({ tagName: 'DIV', getAttribute: () => null })).toBe('other');
  });

  it('ignores shortcuts while typing, but lets Escape through', () => {
    const input = { tagName: 'INPUT', type: 'text' };
    expect(shouldIgnoreShortcut({ key: 'p' }, input)).toBe(true);
    expect(shouldIgnoreShortcut({ key: ' ' }, input)).toBe(true);
    expect(shouldIgnoreShortcut({ key: 'Escape' }, input)).toBe(false);
  });

  it('lets Space press a focused button instead of turning the page', () => {
    const button = { tagName: 'BUTTON' };
    expect(shouldIgnoreShortcut({ key: ' ' }, button)).toBe(true);
    expect(shouldIgnoreShortcut({ key: 'PageDown' }, button)).toBe(false);
    expect(shouldIgnoreShortcut({ key: 'p' }, button)).toBe(false);
    expect(shouldIgnoreShortcut({ key: ' ' }, { tagName: 'DIV' })).toBe(false);
  });
});

describe('camera errors', () => {
  it('extracts tracker codes from anything thrown', () => {
    expect(trackerErrorCode(Object.assign(new Error('x'), { code: 'camera-denied' }))).toBe('camera-denied');
    expect(trackerErrorCode({ code: 'model-load-failed' })).toBe('model-load-failed');
    expect(trackerErrorCode({ code: 'EPERM' })).toBe('unknown');
    expect(trackerErrorCode(new Error('plain'))).toBe('unknown');
    expect(trackerErrorCode(null)).toBe('unknown');
    expect(trackerErrorCode('camera-denied')).toBe('unknown');
  });

  it('has friendly, short copy for every code', () => {
    for (const code of ['camera-denied', 'no-camera', 'camera-in-use', 'insecure-context', 'model-load-failed', 'unknown'] as const) {
      const info = cameraErrorInfo(code);
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.message.length).toBeGreaterThan(0);
      expect(info.buddyLine.length).toBeLessThanOrEqual(90);
    }
    expect(cameraErrorInfo('camera-denied').retryable).toBe(false);
    expect(cameraErrorInfo('camera-in-use').retryable).toBe(true);
  });
});

describe('small helpers', () => {
  it('calibrationFitsViewport', () => {
    expect(calibrationFitsViewport({ width: 1440, height: 900 }, { width: 1440, height: 860 })).toBe(true);
    expect(calibrationFitsViewport({ width: 1440, height: 900 }, { width: 1000, height: 900 })).toBe(false);
    expect(calibrationFitsViewport({ width: 0, height: 900 }, { width: 1440, height: 900 })).toBe(false);
    expect(calibrationFitsViewport({ width: Number.NaN, height: 900 }, { width: 1440, height: 900 })).toBe(false);
  });

  it('resolveTheme', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
    expect(resolveTheme('sepia', true)).toBe('sepia');
  });

  it('previewCorner avoids Dewey', () => {
    expect(previewCorner('bottom-left')).toBe('bottom-right');
    expect(previewCorner('bottom-right')).toBe('bottom-left');
    expect(previewCorner('top-left')).toBe('bottom-left');
  });

  it('guessTextFormat', () => {
    expect(guessTextFormat('# Title\n\nSome text with **bold**.')).toBe('md');
    expect(guessTextFormat('- one\n- two\n- three')).toBe('md');
    expect(guessTextFormat('It was a bright cold day in April.\n\nThe clocks were striking.')).toBe('txt');
    expect(guessTextFormat('Price: 5 * 3 = 15. A single - dash.')).toBe('txt');
    expect(guessTextFormat('')).toBe('txt');
  });

  it('deriveTitle', () => {
    expect(deriveTitle('\n\n# The Reading Eye\n\nText')).toBe('The Reading Eye');
    expect(deriveTitle('   ')).toBe('Pasted text');
    expect(deriveTitle('*')).toBe('Pasted text');
    const long = deriveTitle('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith('…')).toBe(true);
  });

  it('normalizeUrl', () => {
    expect(normalizeUrl('  https://example.com/book.txt ')).toBe('https://example.com/book.txt');
    expect(normalizeUrl('example.com/a.md')).toBe('https://example.com/a.md');
    expect(normalizeUrl('http://localhost:5173/x')).toBe('http://localhost:5173/x');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('data:text/plain,hi')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });

  it('formatPercent / formatMinutes / relativeTime', () => {
    expect(formatPercent(0.999)).toBe('99%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.29)).toBe('29%');
    expect(formatPercent(Number.NaN)).toBe('0%');
    expect(formatPercent(-3)).toBe('0%');
    expect(formatMinutes(0.4)).toBe('under a minute');
    expect(formatMinutes(42.4)).toBe('42 min');
    expect(formatMinutes(125)).toBe('2 h 5 min');
    expect(formatMinutes(120)).toBe('2 h');
    expect(formatMinutes(null)).toBe('');
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe('yesterday');
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3 days ago');
    expect(relativeTime(null, now)).toBe('');
  });
});

describe('settings schema', () => {
  const controls = SETTINGS_GROUPS.flatMap((g) => g.controls);

  it('binds every AppSettings field exactly once', () => {
    const keys = controls.map((c) => c.key).sort();
    expect(keys).toEqual((Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]).sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses control kinds that match the value types', () => {
    for (const c of controls) {
      const v = DEFAULT_SETTINGS[c.key];
      if (c.kind === 'toggle') expect(typeof v).toBe('boolean');
      if (c.kind === 'range') expect(typeof v).toBe('number');
      if (c.kind === 'choice') expect(c.options.map((o) => o.value)).toContain(v);
    }
  });

  it('keeps slider ranges valid, including the defaults', () => {
    for (const c of controls) {
      if (c.kind !== 'range') continue;
      expect(c.min).toBeLessThan(c.max);
      const d = DEFAULT_SETTINGS[c.key];
      expect(d).toBeGreaterThanOrEqual(c.min);
      expect(d).toBeLessThanOrEqual(c.max);
      // Every slider value must survive sanitizeSettings.
      for (const v of [c.min, c.max]) expect(sanitizeSettings({ [c.key]: v })[c.key]).toBe(v);
      expect(c.format(c.min).length).toBeGreaterThan(0);
    }
  });

  it('every choice option survives sanitizeSettings', () => {
    for (const c of controls) {
      if (c.kind !== 'choice') continue;
      for (const o of c.options) expect(sanitizeSettings({ [c.key]: o.value })[c.key]).toBe(o.value);
    }
  });

  it('reset keeps the current gaze source', () => {
    const current: AppSettings = { ...DEFAULT_SETTINGS, gazeSource: 'mouse', fontSizePx: 30 };
    const patch = resetPatch(DEFAULT_SETTINGS, current);
    expect(patch.gazeSource).toBe('mouse');
    expect(patch.fontSizePx).toBe(DEFAULT_SETTINGS.fontSizePx);
  });
});
