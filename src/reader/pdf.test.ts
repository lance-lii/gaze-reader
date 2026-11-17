import { describe, expect, it } from 'vitest';
import { layoutPdfPages, reconstructBlocks, takePdfSource, type PdfPageText, type PdfTextItem } from './pdf';

const SIZE = 10;
const CHAR_W = 5; // a monospaced stand-in: every character 5 units wide
const PITCH = 14;
const LEFT = 72;

/** Words of one line as separate text items (pdf.js often splits runs like this). */
function lineItems(text: string, x: number, y: number, size = SIZE): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  let cx = x;
  for (const word of text.split(' ')) {
    const width = word.length * CHAR_W * (size / SIZE);
    items.push({ str: word, x: cx, y, width, height: size });
    cx += width + CHAR_W * (size / SIZE);
  }
  return items;
}

interface Para {
  lines: string[];
  indent?: boolean;
  size?: number;
  gapBefore?: number;
}

/** A 600×800 page: optional running head and folio, then paragraphs with first-line indents. */
function page(paras: Para[], opts: { head?: string; folio?: string; startY?: number } = {}): PdfPageText {
  const items: PdfTextItem[] = [];
  if (opts.head) items.push(...lineItems(opts.head, 250, 40, 8));
  let y = opts.startY ?? 100;
  for (const para of paras) {
    y += para.gapBefore ?? 0;
    para.lines.forEach((text, i) => {
      const x = i === 0 && para.indent !== false ? LEFT + 15 : LEFT;
      items.push(...lineItems(text, x, y, para.size));
      y += para.size ? para.size * 1.4 : PITCH;
    });
  }
  if (opts.folio) items.push(...lineItems(opts.folio, 296, 770, 9));
  return { width: 600, height: 800, items };
}

const FULL = (s: string): string => s.padEnd(88, ' ').slice(0, 88).replace(/ +$/, '');

describe('reconstructBlocks', () => {
  it('returns nothing for empty or junk input', () => {
    expect(reconstructBlocks([])).toEqual([]);
    expect(
      reconstructBlocks([
        { width: 600, height: 800, items: [{ str: '   ', x: 1, y: 1, width: 1, height: 1 }, { str: 'x', x: NaN, y: 1, width: 1, height: 1 }] },
      ]),
    ).toEqual([]);
  });

  it('builds paragraphs, repairs hyphenation, joins across pages and drops running heads and folios', () => {
    const pages: PdfPageText[] = [
      page(
        [
          { lines: ['CHAPTER ONE'], size: 18, indent: false },
          {
            lines: [
              'The lighthouse keeper climbed the spiral stairs every evening at dusk, counting',
              'the steps out of habit and pausing at the small window halfway up to watch the',
              'boats come home. Tonight the sea was calm, and the recon-',
            ],
            gapBefore: 20,
          },
        ],
        { folio: '1' },
      ),
      page(
        [
          {
            lines: [
              'struction of the old lamp was finally finished, so he lit it with some ceremony.',
            ],
            indent: false,
          },
          {
            lines: [
              'Far below, a small boat turned toward the harbour, its single lantern swinging',
              'like a pendulum.',
            ],
          },
        ],
        { head: 'THE LIGHTHOUSE', folio: '2' },
      ),
      page(
        [{ lines: ['He watched it all the way in, and then he went back down the stairs to bed.'] }],
        { head: 'THE LIGHTHOUSE', folio: '3' },
      ),
    ];
    const blocks = reconstructBlocks(pages);
    expect(blocks[0]).toEqual({ kind: 'heading', level: 2, text: 'CHAPTER ONE' });
    const paragraphs = blocks.filter((b) => b.kind === 'paragraph').map((b) => b.text);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toBe(
      'The lighthouse keeper climbed the spiral stairs every evening at dusk, counting the steps out of habit and ' +
        'pausing at the small window halfway up to watch the boats come home. Tonight the sea was calm, and the ' +
        'reconstruction of the old lamp was finally finished, so he lit it with some ceremony.',
    );
    expect(paragraphs[1]).toBe('Far below, a small boat turned toward the harbour, its single lantern swinging like a pendulum.');
    const all = blocks.map((b) => b.text).join('\n');
    expect(all).not.toContain('THE LIGHTHOUSE');
    expect(all).not.toMatch(/(^|\n)\d+($|\n)/);
  });

  it('keeps a "Chapter 7" at the top of a page while removing numbered running heads', () => {
    const body = (n: number): Para[] => [
      { lines: [FULL(`Page ${n} begins with a line of ordinary text that runs all the way across the page`), `and ends here on page ${n}.`] },
    ];
    const pages = [1, 2, 3, 4, 5].map((n) =>
      n === 3
        ? page([{ lines: ['Chapter 7'], size: 18, indent: false }, ...body(n)], { startY: 60, folio: String(n) })
        : page(body(n), { head: `${n} THE TINY BOOK`, folio: undefined }),
    );
    const blocks = reconstructBlocks(pages);
    const text = blocks.map((b) => b.text);
    expect(text).toContain('Chapter 7');
    expect(text.join('\n')).not.toContain('THE TINY BOOK');
    expect(blocks.find((b) => b.text === 'Chapter 7')).toMatchObject({ kind: 'heading', level: 2 });
  });

  it('drops Roman-numeral folios but never a lone word made of Roman-numeral letters', () => {
    // Regression: any run of i/v/x/l/c/d/m ("civil", "mild", "vivid") at a page edge was taken for a page number.
    const first = FULL('It was a long argument, but in the end everyone around the old oak table stayed perfectly');
    const pages = [
      page([{ lines: [first, 'civil'], indent: false }], { startY: 716, folio: 'xiv' }),
      page([{ lines: [first, 'vivid'], indent: false }], { startY: 716, folio: 'xv' }),
    ];
    expect(reconstructBlocks(pages)).toEqual([
      { kind: 'paragraph', text: `${first} civil` },
      { kind: 'paragraph', text: `${first} vivid` },
    ]);
  });

  it('reads a two-column page left column first', () => {
    const items: PdfTextItem[] = [];
    for (let i = 0; i < 10; i++) {
      items.push(...lineItems(`left line number ${String(i).padStart(2, '0')} of the story here`, 50, 100 + i * PITCH));
      items.push(...lineItems(`right line number ${String(i).padStart(2, '0')} of the story here`, 320, 100 + i * PITCH));
    }
    const text = reconstructBlocks([{ width: 600, height: 800, items }])
      .map((b) => b.text)
      .join(' ');
    const lastLeft = text.indexOf('left line number 09');
    const firstRight = text.indexOf('right line number 00');
    expect(lastLeft).toBeGreaterThan(-1);
    expect(firstRight).toBeGreaterThan(lastLeft);
    expect(text.indexOf('left line number 01')).toBeLessThan(text.indexOf('left line number 02'));
  });

  it('keeps superscripts in their line', () => {
    const items = [
      ...lineItems(FULL('A sentence about reading that carries a small footnote marker at the very end of'), LEFT, 200),
      ...lineItems('reading.', LEFT, 214),
      { str: '1', x: LEFT + 8 * CHAR_W, y: 210.5, width: 3, height: 6 },
      ...lineItems('Next sentence.', LEFT + 8 * CHAR_W + 6, 214),
    ];
    const blocks = reconstructBlocks([{ width: 600, height: 800, items }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toMatch(/reading\.1 Next sentence\.$/);
  });

  it('reads a drop cap as the first letter of its paragraph, not as a heading (regression: "he quick…", then a chapter titled "T while…")', () => {
    const body = (cap: { lines: number; size: number }): PdfPageText => {
      const items: PdfTextItem[] = [];
      const capWidth = cap.size * 0.7;
      const texts = [
        'he quick brown fox jumps over the lazy dog every single afternoon',
        'while the farmer watches from the porch with a cup of strong tea,',
        'because the afternoon is long and there is nothing else to do,',
        'and then the evening comes and the fox goes home to its den to',
        'sleep until the morning light returns to the quiet valley again.',
      ];
      texts.forEach((text, i) => items.push(...lineItems(text, i < cap.lines ? LEFT + capWidth + 4 : LEFT, 100 + i * PITCH)));
      // The initial's baseline is the baseline of the last line it spans.
      items.push({ str: 'T', x: LEFT, y: 100 + (cap.lines - 1) * PITCH, width: capWidth, height: cap.size });
      // An ordinary paragraph after it, so "larger type" has something to be larger than.
      ['A second paragraph follows the first one here, set in the same', 'size, and ends on a short line.'].forEach((text, i) =>
        items.push(...lineItems(text, i === 0 ? LEFT + 15 : LEFT, 100 + 6 * PITCH + i * PITCH)),
      );
      return { width: 600, height: 800, items };
    };
    for (const cap of [{ lines: 2, size: 26 }, { lines: 3, size: 38 }]) {
      const blocks = reconstructBlocks([body(cap)]);
      expect(blocks.map((b) => b.kind), `${cap.lines}-line cap`).toEqual(['paragraph', 'paragraph']);
      expect(blocks[0]!.text, `${cap.lines}-line cap`).toBe(
        'The quick brown fox jumps over the lazy dog every single afternoon while the farmer watches from the porch with a cup of strong tea, ' +
          'because the afternoon is long and there is nothing else to do, and then the evening comes and the fox goes home to its den to sleep until the morning light returns to the quiet valley again.',
      );
    }
  });

  it('separates blocks on extra spacing, bullets and short final lines', () => {
    const pages = [
      page([
        { lines: [FULL('The first paragraph is set flush left without any indent and it runs across the'), 'whole line.'], indent: false },
        { lines: [FULL('The second paragraph follows after a blank gap instead of an indent, as many'), 'reports do.'], indent: false, gapBefore: 14 },
        { lines: ['• a bulleted point'], indent: false },
        { lines: ['• another bulleted point'], indent: false },
      ]),
    ];
    const texts = reconstructBlocks(pages).map((b) => b.text);
    expect(texts).toEqual([
      'The first paragraph is set flush left without any indent and it runs across the whole line.',
      'The second paragraph follows after a blank gap instead of an indent, as many reports do.',
      '• a bulleted point',
      '• another bulleted point',
    ]);
  });

  it('merges a heading set on two lines and levels headings by size', () => {
    const pages = [
      page([
        { lines: ['PART ONE'], size: 20, indent: false },
        { lines: ['The Beginning of Things'], size: 20, indent: false },
        { lines: ['A Smaller Section'], size: 12.5, indent: false, gapBefore: 10 },
        { lines: [FULL('Ordinary text follows the headings and fills the rest of the page with words that'), 'make a paragraph.'], gapBefore: 10 },
      ]),
    ];
    const blocks = reconstructBlocks(pages);
    expect(blocks[0]).toEqual({ kind: 'heading', level: 2, text: 'PART ONE The Beginning of Things' });
    expect(blocks[1]).toEqual({ kind: 'heading', level: 3, text: 'A Smaller Section' });
    expect(blocks[2].kind).toBe('paragraph');
  });
});

describe('layoutPdfPages (the pages view)', () => {
  it('gives one box per line of a page, where the line is, in reading order', () => {
    const [layout] = layoutPdfPages([
      page([{ lines: ['The first line of the page runs on to here', 'and the second line ends sooner'] }, { lines: ['A second paragraph'], gapBefore: 10 }]),
    ]);
    expect(layout!.width).toBe(600);
    expect(layout!.height).toBe(800);
    expect(layout!.columns).toBe(false);
    expect(layout!.lines.map((l) => l.text)).toEqual(['The first line of the page runs on to here', 'and the second line ends sooner', 'A second paragraph']);
    const [first, second, third] = layout!.lines;
    expect(first!.x0).toBe(LEFT + 15); // the paragraph indent
    expect(second!.x0).toBe(LEFT);
    expect(first!.y).toBe(100);
    expect(second!.y).toBe(100 + PITCH);
    expect(third!.y).toBe(100 + 2 * PITCH + 10);
    expect(first!.size).toBe(SIZE);
    // The box ends where the last word does.
    expect(first!.x1).toBeCloseTo(LEFT + 15 + 'The first line of the page runs on to here'.length * CHAR_W, 6);
    for (const l of layout!.lines) expect(l.x1).toBeGreaterThan(l.x0);
  });

  it('keeps running heads and folios (they are on the page), and flags a two-column page', () => {
    const single = layoutPdfPages([page([{ lines: ['Body text of the page'] }], { head: 'THE RUNNING HEAD', folio: '12' })])[0]!;
    expect(single.lines.map((l) => l.text)).toEqual(['THE RUNNING HEAD', 'Body text of the page', '12']);

    const items: PdfTextItem[] = [];
    for (let i = 0; i < 12; i++) {
      items.push(...lineItems(`left column line number ${i}`, 60, 100 + i * PITCH));
      items.push(...lineItems(`right column line number ${i}`, 330, 100 + i * PITCH));
    }
    const two = layoutPdfPages([{ width: 600, height: 800, items }])[0]!;
    expect(two.columns).toBe(true);
    // Reading order: the left column, then the right.
    expect(two.lines[0]!.text).toBe('left column line number 0');
    expect(two.lines[11]!.text).toBe('left column line number 11');
    expect(two.lines[12]!.text).toBe('right column line number 0');
  });

  it('copes with empty and broken pages', () => {
    expect(layoutPdfPages([])).toEqual([]);
    const [empty, broken] = layoutPdfPages([
      { width: 600, height: 800, items: [] },
      { width: Number.NaN, height: 0, items: lineItems('text on a page without a size', 10, 10) },
    ]);
    expect(empty).toEqual({ width: 600, height: 800, columns: false, lines: [] });
    expect(broken!.lines).toEqual([]);
    expect(broken!.width).toBeGreaterThan(0);
    expect(broken!.height).toBeGreaterThan(0);
    // Text outside the page, and absurdly long lines.
    const [odd] = layoutPdfPages([
      { width: 600, height: 800, items: [...lineItems('off the page', 700, 100), { str: 'x'.repeat(2000), x: 10, y: 200, width: 500, height: 10 }] },
    ]);
    expect(odd!.lines).toHaveLength(1);
    expect(odd!.lines[0]!.text).toHaveLength(400);
  });

  it('takePdfSource hands nothing out for books it never parsed', () => {
    expect(takePdfSource('no-such-book')).toBeNull();
  });
});
