import { describe, expect, it } from 'vitest';
import { lastFullyVisibleIndex, makeDocument, makeReadingPage } from './testLayouts';

describe('synthetic layouts', () => {
  it('follows measureLines conventions (docTop, visibility, pitch, column)', () => {
    const doc = makeDocument({ lines: 40, pitch: 42, seed: 3 });
    const viewport = { left: 0, top: 50, right: 1000, bottom: 650 };
    const layout = doc.layoutAt(300, { viewport });
    expect(layout.lines.length).toBeGreaterThan(10);
    for (const [i, l] of layout.lines.entries()) {
      expect(l.index).toBe(i);
      expect(l.docTop).toBeCloseTo(l.top - viewport.top + 300, 6);
      expect(l.centerY).toBeCloseTo((l.top + l.bottom) / 2, 6);
      expect(l.fullyVisible).toBe(l.top >= viewport.top && l.bottom <= viewport.bottom);
      if (i > 0) expect(l.top).toBeGreaterThan(layout.lines[i - 1]!.top);
    }
    expect(layout.linePitch).toBe(42);
    expect(layout.column.left).toBe(160);
    expect(layout.column.right).toBe(860);
    expect(layout.scrollTop).toBe(300);
    expect(layout.clientHeight).toBe(600);
  });

  it('is stable across scroll positions (same docTop, shifted top)', () => {
    const doc = makeDocument({ lines: 60, seed: 9 });
    const a = doc.layoutAt(0);
    const b = doc.layoutAt(210);
    const line = a.lines.find((l) => l.docTop > 400)!;
    const same = b.lines.find((l) => l.docTop === line.docTop)!;
    expect(same.top).toBeCloseTo(line.top - 210, 6);
  });

  it('builds reading pages with short paragraph-final lines, gaps and a cut-off last line', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const page = makeReadingPage(seed);
      const full = page.lines.filter((l) => l.fullyVisible).length;
      expect(full).toBeGreaterThanOrEqual(18);
      expect(full).toBeLessThanOrEqual(24);
      const L = lastFullyVisibleIndex(page);
      const cut = page.lines[L + 1]!;
      expect(cut.fullyVisible).toBe(false);
      expect(cut.top).toBeLessThan(page.viewport.bottom);
      expect(page.lines.some((l) => l.right - l.left < 0.8 * 700)).toBe(true);
      const deltas = page.lines.slice(1).map((l, i) => l.centerY - page.lines[i]!.centerY);
      expect(Math.max(...deltas)).toBeGreaterThan(page.linePitch * 1.2);
    }
  });

  it('handles empty documents', () => {
    const layout = makeDocument({ lines: 0 }).layoutAt(0);
    expect(layout.lines).toEqual([]);
    expect(lastFullyVisibleIndex(layout)).toBe(-1);
  });
});
