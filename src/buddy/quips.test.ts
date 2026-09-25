import { describe, expect, it } from 'vitest';
import { fillTemplate, hasTemplate, QUIP_KEYS, QuipPicker, QUIPS, shortTitle, type QuipKey } from './quips';

const MAX = 90;
const REQUIRED: QuipKey[] = [
  'greeting',
  'pageTurn',
  'milestone25',
  'milestone50',
  'milestone75',
  'tenPages',
  'trackingLost',
  'trackingBack',
  'calibrationStart',
  'calibrationPositioning',
  'calibrationPoint',
  'calibrationTraining',
  'calibrationValidating',
  'calibrationGood',
  'calibrationFair',
  'calibrationPoor',
  'calibrationCancelled',
  'calibrationFailed',
  'break',
  'bookFinished',
  'poke',
  'funFacts',
];
/** Keys whose lines may use templates, and the variables Dewey passes for them. */
const TEMPLATED: Partial<Record<QuipKey, readonly string[]>> = {
  greeting: ['title'],
  welcomeBack: ['title'],
  tenPages: ['pages'],
};

const len = (s: string) => Array.from(s).length;
const allLines = () => QUIP_KEYS.flatMap((k) => QUIPS[k] ?? []);

describe('QUIPS', () => {
  it('covers every situation Dewey reacts to', () => {
    for (const key of REQUIRED) expect(QUIPS[key]?.length ?? 0, key).toBeGreaterThan(0);
  });

  it('has a real repertoire: 80+ lines and 30+ fun facts', () => {
    expect(allLines().length).toBeGreaterThanOrEqual(80);
    expect(QUIPS.funFacts?.length ?? 0).toBeGreaterThanOrEqual(30);
  });

  it('fits the 90-character bubble, even with the longest template values', () => {
    const worst = { title: shortTitle('W'.repeat(200)), pages: 9_990 };
    for (const key of QUIP_KEYS) {
      for (const line of QUIPS[key] ?? []) {
        const filled = fillTemplate(line, worst);
        expect(filled, line).not.toBeNull();
        expect(len(filled ?? ''), line).toBeLessThanOrEqual(MAX);
        expect(line.trim(), key).toBe(line);
        expect(line.length, key).toBeGreaterThan(0);
      }
    }
  });

  it('never repeats a line', () => {
    const lines = allLines();
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('uses templates only where Dewey fills them', () => {
    for (const key of QUIP_KEYS) {
      const allowed = TEMPLATED[key] ?? [];
      for (const line of QUIPS[key] ?? []) {
        const vars = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        for (const v of vars) expect(allowed, `${key}: ${line}`).toContain(v);
      }
    }
    // Every ten-pages line says how many pages; greetings still work without a title.
    for (const line of QUIPS.tenPages ?? []) expect(line).toContain('{pages}');
    for (const key of ['greeting', 'welcomeBack'] as const) {
      expect((QUIPS[key] ?? []).filter((l) => !hasTemplate(l)).length, key).toBeGreaterThanOrEqual(2);
    }
  });

  it('is typeset consistently (curly apostrophes, no straight quotes)', () => {
    for (const line of allLines()) {
      expect(line, line).not.toMatch(/['"]/);
      expect(line, line).not.toMatch(/\s[,.!?]/);
    }
  });

  it('says the worried line from the spec and a correct 20-20-20 tip', () => {
    expect(QUIPS.trackingLost?.[0]).toBe('I can’t see you… are you still there?');
    for (const tip of QUIPS.break ?? []) {
      expect(tip).toMatch(/20 s(econds)?\b/);
      expect(tip).toMatch(/20 f(ee)?t/);
      expect(tip).toMatch(/6 m\b/);
    }
  });

  it('keeps fun facts to careful, checkable claims', () => {
    const facts = (QUIPS.funFacts ?? []).join('\n');
    // The numbers reading research actually supports (Rayner's reviews).
    expect(facts).toContain('200–250 milliseconds');
    expect(facts).toContain('7–9 letters');
    expect(facts).toContain('3–4 letters left');
    expect(facts).toContain('10–15%');
    expect(facts).toMatch(/Dewey.*1876/);
    // Classic myths and hype stay out.
    expect(facts).not.toMatch(/10% of (your|the) brain|photographic|1,?000 words per minute|speed.?read/i);
  });
});

describe('fillTemplate / shortTitle', () => {
  it('fills variables and reports missing ones', () => {
    expect(fillTemplate('{pages} pages!', { pages: 20 })).toBe('20 pages!');
    expect(fillTemplate('Hi {title}', {})).toBeNull();
    expect(fillTemplate('Hi {title}', { title: '   ' })).toBeNull();
    expect(fillTemplate('{pages}', { pages: Number.NaN })).toBeNull();
    expect(fillTemplate('No vars.', {})).toBe('No vars.');
  });

  it('shortens long titles on a word boundary', () => {
    expect(shortTitle('Moby Dick')).toBe('Moby Dick');
    const t = shortTitle('The Very Long Title Of A Book About Eyes');
    expect(len(t)).toBeLessThanOrEqual(28);
    expect(t).toBe('The Very Long Title Of A…');
    expect(len(shortTitle('Supercalifragilisticexpialidocious and more'))).toBeLessThanOrEqual(28);
    expect(shortTitle('  spaced \n  out  ')).toBe('spaced out');
  });
});

describe('QuipPicker', () => {
  const seeded = (seed: number) => () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  it('deals every line once before repeating, without back-to-back repeats across decks', () => {
    const picker = new QuipPicker(seeded(42));
    const n = QUIPS.poke?.length ?? 0;
    const seen: string[] = [];
    for (let i = 0; i < n * 5; i++) seen.push(picker.pick('poke') ?? '');
    for (let d = 0; d < 5; d++) expect(new Set(seen.slice(d * n, (d + 1) * n)).size).toBe(n);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it('respects the veto and returns null when every line is vetoed', () => {
    const picker = new QuipPicker(seeded(7));
    const first = QUIPS.trackingBack?.[0] ?? '';
    for (let i = 0; i < 20; i++) expect(picker.pick('trackingBack', {}, (l) => l === first)).not.toBe(first);
    expect(picker.pick('trackingBack', {}, () => true)).toBeNull();
  });

  it('skips lines whose variables are missing and fills the rest', () => {
    const picker = new QuipPicker(seeded(3));
    for (let i = 0; i < 20; i++) {
      const line = picker.pick('greeting') ?? '';
      expect(line).not.toContain('{');
    }
    const withTitle = new Set<string>();
    for (let i = 0; i < 30; i++) withTitle.add(picker.pick('greeting', { title: 'Dune' }) ?? '');
    expect([...withTitle].some((l) => l.includes('Dune'))).toBe(true);
    expect(picker.pick('tenPages')).toBeNull();
    expect(picker.pick('tenPages', { pages: 30 })).toContain('30');
  });

  it('copes with a broken random source', () => {
    const picker = new QuipPicker(() => Number.NaN);
    expect(QUIPS.poke).toContain(picker.pick('poke'));
    const one = new QuipPicker(() => 1);
    expect(QUIPS.poke).toContain(one.pick('poke'));
  });
});
