// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { BuddyMood } from '../types';
import { AVATAR_HEIGHT, AVATAR_WIDTH, clampOffset, createAvatar, PUPIL_MAX_TRAVEL, pupilOffset, setPupil } from './avatar';

const MOODS: BuddyMood[] = ['idle', 'reading', 'happy', 'excited', 'thinking', 'worried', 'sleepy', 'celebrating'];

describe('createAvatar', () => {
  const { svg, eyes } = createAvatar(document, 'gr-buddy-t1');
  const count = (sel: string) => svg.querySelectorAll(sel).length;

  it('is a decorative ~120×150 SVG', () => {
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${AVATAR_WIDTH} ${AVATAR_HEIGHT}`);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
  });

  it('has every part the moods and animations toggle', () => {
    expect(count('.gr-buddy-brow--l')).toBe(1);
    expect(count('.gr-buddy-brow--r')).toBe(1);
    expect(count('.gr-buddy-lid-up')).toBe(2);
    expect(count('.gr-buddy-lid-low')).toBe(2);
    expect(count('.gr-buddy-pupil')).toBe(2);
    expect(count('.gr-buddy-eye-happy')).toBe(1);
    expect(count('.gr-buddy-glasses .gr-buddy-glint')).toBe(1);
    expect(count('.gr-buddy-cowlick')).toBe(1);
    expect(count('.gr-buddy-book .gr-buddy-flip')).toBe(1);
    expect(count('.gr-buddy-zzz .gr-buddy-z')).toBe(3);
    expect(count('.gr-buddy-sparkles .gr-buddy-star')).toBeGreaterThanOrEqual(4);
    for (const mouth of ['smile', 'soft', 'grin', 'big', 'hmm', 'wavy', 'o', 'talk']) {
      expect(count(`.gr-buddy-mouth--${mouth}`), mouth).toBe(1);
    }
    expect(count('.gr-buddy-char .gr-buddy-body')).toBe(1);
    expect(count('.gr-buddy-char .gr-buddy-head')).toBe(1);
    expect(MOODS.length).toBe(8);
  });

  it('never moves CSS-animated parts with a transform attribute (CSS would override it)', () => {
    for (const cls of ['char', 'body', 'head', 'glasses', 'cowlick', 'brow', 'lid-up', 'lid-low', 'mouth--talk', 'flip', 'z', 'star']) {
      for (const el of svg.querySelectorAll(`.gr-buddy-${cls}`)) expect(el.hasAttribute('transform'), cls).toBe(false);
    }
  });

  it('keeps ids unique and every url(#…) reference resolvable', () => {
    const ids = [...svg.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith('gr-buddy-t1-')).toBe(true);
    const refs = new Set<string>();
    for (const el of svg.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) {
        for (const m of (el.getAttribute(attr) ?? '').matchAll(/url\(#([^)]+)\)/g)) refs.add(m[1] ?? '');
      }
    }
    expect(refs.size).toBeGreaterThan(5);
    for (const ref of refs) expect(ids, ref).toContain(ref);
  });

  it('gives two avatars disjoint ids', () => {
    const other = createAvatar(document, 'gr-buddy-t2');
    const a = new Set([...svg.querySelectorAll('[id]')].map((el) => el.id));
    for (const el of other.svg.querySelectorAll('[id]')) expect(a.has(el.id)).toBe(false);
  });

  it('prefixes every class with gr-', () => {
    for (const el of svg.querySelectorAll('[class]')) {
      for (const c of (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) expect(c.startsWith('gr-')).toBe(true);
    }
  });

  it('positions pupils relative to each eye center', () => {
    const [left, right] = eyes;
    expect(left.center.x).toBeLessThan(right.center.x);
    expect(left.sclera.tagName).toBe('ellipse');
    setPupil(left, { x: 1.5, y: -2 });
    expect(left.pupil.getAttribute('transform')).toBe(`translate(${left.center.x + 1.5} ${left.center.y - 2})`);
  });
});

describe('pupilOffset', () => {
  const eye = { x: 100, y: 100 };

  it('points toward the target and never exceeds the max travel', () => {
    const far = pupilOffset(eye, { x: 5_000, y: 100 });
    expect(far.x).toBeGreaterThan(2.9);
    expect(far.x).toBeLessThan(PUPIL_MAX_TRAVEL);
    expect(Math.abs(far.y)).toBeLessThan(1e-9);
    const diag = pupilOffset(eye, { x: -900, y: -900 });
    expect(diag.x).toBeLessThan(0);
    expect(diag.y).toBeLessThan(0);
    expect(Math.hypot(diag.x, diag.y)).toBeLessThanOrEqual(PUPIL_MAX_TRAVEL);
  });

  it('saturates smoothly: nearer targets move the pupil less (eye contact up close)', () => {
    const m = (d: number) => Math.hypot(...Object.values(pupilOffset(eye, { x: eye.x + d, y: eye.y })));
    expect(m(10)).toBeLessThan(m(100));
    expect(m(100)).toBeLessThan(m(1_000));
    expect(m(10)).toBeLessThan(0.5);
    expect(Math.hypot(...Object.values(pupilOffset(eye, { x: 101, y: 100 }, 3, 0)))).toBeCloseTo(3);
  });

  it('returns center for degenerate input', () => {
    expect(pupilOffset(eye, eye)).toEqual({ x: 0, y: 0 });
    expect(pupilOffset(eye, { x: Number.NaN, y: 3 })).toEqual({ x: 0, y: 0 });
    expect(pupilOffset({ x: Number.POSITIVE_INFINITY, y: 0 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(pupilOffset(eye, { x: 200, y: 200 }, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('clampOffset', () => {
  it('clamps to a disc and zeroes NaN', () => {
    expect(clampOffset({ x: 1, y: 1 })).toEqual({ x: 1, y: 1 });
    const c = clampOffset({ x: 30, y: 40 });
    expect(Math.hypot(c.x, c.y)).toBeCloseTo(PUPIL_MAX_TRAVEL);
    expect(c.x / c.y).toBeCloseTo(0.75);
    expect(clampOffset({ x: Number.NaN, y: 1 })).toEqual({ x: 0, y: 0 });
  });
});
