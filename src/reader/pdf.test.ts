import { describe, expect, it } from 'vitest';
import { reconstructBlocks, type PdfPageText, type PdfTextItem } from './pdf';

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
