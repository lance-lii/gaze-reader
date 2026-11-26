import { describe, expect, it } from 'vitest';
import { joinParagraph } from './pdf';

describe('joinParagraph', () => {
  it('repairs hyphenation, keeps dashes tight and spaces the rest', () => {
    expect(joinParagraph(['the recon-', 'struction of', 'a text—', 'and/', 'or more'])).toBe('the reconstruction of a text—and/or more');
    expect(joinParagraph(['Jean-', 'Paul went'])).toBe('Jean- Paul went');
  });

  it('sees breaks that reach across very short lines and surrogate pairs', () => {
    expect(joinParagraph(['a', 'b-', 'c-', 'd'])).toBe('a bcd');
    expect(joinParagraph(['x 𝑎-', 'b'])).toBe('x 𝑎b');
    expect(joinParagraph(['one', '-', 'two'])).toBe('one - two');
    expect(joinParagraph(['alone'])).toBe('alone');
  });

  it('joins a very long run of lines', () => {
    const lines = Array.from({ length: 30_000 }, () => 'the quick brown fox jumps over the lazy dog and runs on');
    expect(joinParagraph(lines)).toBe(lines.join(' '));
  });
});
