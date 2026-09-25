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
