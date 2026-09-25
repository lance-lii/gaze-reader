// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Z } from '../core/constants';
import type { BuddyMood } from '../types';
import { adoptBuddyStyles, BUDDY_CLASS, BUDDY_CSS } from './styles';

/** Returns the body of the first `@media <query> { … }` block (brace-matched). */
function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
  }
  return '';
}

/** CSS with every @keyframes block removed. */
function withoutKeyframes(css: string): string {
  let out = css;
  for (;;) {
    const start = out.indexOf('@keyframes');
    if (start < 0) return out;
    let depth = 0;
    let end = out.length;
    for (let i = out.indexOf('{', start); i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    out = out.slice(0, start) + out.slice(end);
  }
}

describe('BUDDY_CSS', () => {
  it('prefixes every class and keyframe name with gr-', () => {
    expect(BUDDY_CLASS).toBe('gr-buddy');
    const classes = [...BUDDY_CSS.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((m) => m[1] ?? '');
    expect(classes.length).toBeGreaterThan(50);
    for (const c of classes) expect(c.startsWith('gr-'), c).toBe(true);
    for (const m of BUDDY_CSS.matchAll(/@keyframes\s+([\w-]+)/g)) expect(m[1]?.startsWith('gr-buddy-')).toBe(true);
  });

  it('only animates when the reader has not asked for reduced motion', () => {
    const motion = mediaBlock(BUDDY_CSS, '(prefers-reduced-motion: no-preference)');
    expect(motion.length).toBeGreaterThan(500);
    const outside = withoutKeyframes(BUDDY_CSS.replace(motion, ''));
    expect(outside).not.toMatch(/(^|[\s;{])animation\s*:/);
    expect(outside).not.toMatch(/transition\s*:[^;]*transform/);
  });

  it('shows a mouth for every mood and stacks at the buddy z-index', () => {
    const moods: BuddyMood[] = ['idle', 'reading', 'happy', 'excited', 'thinking', 'worried', 'sleepy', 'celebrating'];
    for (const mood of moods) expect(BUDDY_CSS).toMatch(new RegExp(`\\.gr-buddy--mood-${mood} \\.gr-buddy-mouth--\\w+`));
    expect(BUDDY_CSS).toContain(`z-index: ${Z.buddy};`);
    expect(BUDDY_CSS).toContain(`z-index: ${Z.calibration + 1};`);
  });

  it('reads theme tokens with fallbacks and supports forced colors and print', () => {
    for (const token of ['--gr-surface', '--gr-fg', '--gr-border', '--gr-shadow', '--gr-accent', '--gr-font-ui']) {
      expect(BUDDY_CSS).toMatch(new RegExp(`var\\(${token},`));
    }
    expect(BUDDY_CSS).toContain('@media (forced-colors: active)');
    expect(BUDDY_CSS).toContain('@media print');
    expect(BUDDY_CSS).toContain('.gr-buddy[hidden] { display: none !important; }');
  });
});

describe('adoptBuddyStyles', () => {
  it('injects one <style> per document and removes it with the last release', () => {
    const r1 = adoptBuddyStyles(document);
    const r2 = adoptBuddyStyles(document);
    expect(document.head.querySelectorAll('style[data-gr-style="buddy"]')).toHaveLength(1);
    r1();
    r1(); // double release is harmless
    expect(document.head.querySelectorAll('style[data-gr-style="buddy"]')).toHaveLength(1);
    r2();
    expect(document.head.querySelectorAll('style[data-gr-style="buddy"]')).toHaveLength(0);
  });

  it('scopes styles to a shadow root', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const release = adoptBuddyStyles(shadow);
    expect(shadow.querySelector('style[data-gr-style="buddy"]')?.textContent).toBe(BUDDY_CSS);
    expect(document.head.querySelector('style[data-gr-style="buddy"]')).toBeNull();
    release();
    expect(shadow.querySelector('style')).toBeNull();
  });

  it('prefers constructable stylesheets when the root supports them (immune to host-page CSP)', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    let sheets: CSSStyleSheet[] = [];
    Object.defineProperty(shadow, 'adoptedStyleSheets', {
      configurable: true,
      get: () => sheets,
      set: (v: CSSStyleSheet[]) => {
        sheets = v;
      },
    });
    const replaceSync = vi.spyOn(CSSStyleSheet.prototype, 'replaceSync').mockImplementation(() => undefined);
    const release = adoptBuddyStyles(shadow);
    expect(sheets).toHaveLength(1);
    expect(replaceSync).toHaveBeenCalledWith(BUDDY_CSS);
    expect(shadow.querySelector('style')).toBeNull();
    release();
    expect(sheets).toHaveLength(0);
    replaceSync.mockRestore();
  });
});
