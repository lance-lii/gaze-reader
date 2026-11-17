import { describe, expect, it } from 'vitest';

// Vitest blanks CSS imports (even `?raw`), and the project has no Node typings, so read the
// stylesheet through Node's built-in module loader with a minimal local type.
interface FsLike {
  readFileSync(path: URL, encoding: 'utf8'): string;
}
const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
const fs = proc?.getBuiltinModule?.('node:fs') as FsLike | undefined;
if (!fs) throw new Error('This test needs Node 22.3+ (process.getBuiltinModule).');
const appCss = fs.readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');

/** The body of every rule whose selector list contains `selector` (flat scan, media blocks included). */
function rulesFor(selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(appCss); m; m = re.exec(appCss)) {
    if (m[1]!.includes(selector)) out.push(m[2]!);
  }
  return out;
}

describe('app.css layout around Dewey and toasts', () => {
  it('stops the reading stage above Dewey on narrow screens (he would hide the last lines)', () => {
    expect(appCss).toMatch(/@media \(max-width: 899px\)\s*\{\s*:root\[data-buddy='on'\]\[data-buddy-corner\^='bottom'\] \.gr-reader-stage/);
    const bottoms = rulesFor(":root[data-buddy='on'][data-buddy-corner^='bottom'] .gr-reader-stage");
    expect(bottoms.some((r) => /bottom:\s*calc\(150px/.test(r))).toBe(true);
    expect(bottoms.some((r) => /bottom:\s*calc\(110px/.test(r))).toBe(true);
  });

  it('keeps Dewey in a top corner below the top bar instead of over its buttons', () => {
    const top = rulesFor('.gr-app > .gr-buddy--top-right');
    expect(top.some((r) => r.includes('var(--gr-topbar-h)'))).toBe(true);
    expect(rulesFor('.gr-app > .gr-buddy--top-left').length).toBeGreaterThan(0);
  });

  it('moves reader toasts off the centre of the column on wide screens', () => {
    const rules = rulesFor(".gr-app[data-screen='reader'] .gr-toasts");
    expect(rules.some((r) => /left:\s*auto/.test(r) && /transform:\s*none/.test(r))).toBe(true);
  });
});

describe('app.css contrast of controls (WCAG 1.4.11: 3:1 for what marks a control)', () => {
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    const f = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  /** The tokens of one theme block (`:root` or `:root[data-theme='…']`). */
  const tokens = (selector: string): Record<string, string> => {
    const block = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(appCss)?.[1] ?? '';
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/(--gr-[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]!] = m[2]!;
    return out;
  };

  it('the edge of text fields, selects and switches stands out from every surface, in every theme', () => {
    const light = tokens(':root');
    for (const [name, selector] of [['light', ':root'], ['sepia', ":root[data-theme='sepia']"], ['dark', ":root[data-theme='dark']"]] as const) {
      const t = { ...light, ...tokens(selector) };
      for (const surface of ['--gr-surface', '--gr-bg', '--gr-surface-2']) {
        expect(contrast(t['--gr-control']!, t[surface]!), `${name}: --gr-control on ${surface}`).toBeGreaterThanOrEqual(3);
      }
      // Body and muted text keep 4.5:1.
      expect(contrast(t['--gr-fg']!, t['--gr-surface']!), `${name}: text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--gr-muted']!, t['--gr-bg']!), `${name}: muted text (and placeholders)`).toBeGreaterThanOrEqual(4.5);
    }
    for (const rule of ['.gr-input', '.gr-select']) {
      expect(rulesFor(rule).some((r) => /border:\s*1px solid var\(--gr-control\)/.test(r)), rule).toBe(true);
    }
    expect(rulesFor('.gr-switch').some((r) => /background:\s*var\(--gr-control\)/.test(r))).toBe(true);
    expect(rulesFor('.gr-input::placeholder').some((r) => /color:\s*var\(--gr-muted\)/.test(r))).toBe(true);
  });

  it('lets buttons in the settings drawer wrap instead of widening it', () => {
    expect(rulesFor('.gr-settings__body .gr-btn').some((r) => /white-space:\s*normal/.test(r))).toBe(true);
  });
});
