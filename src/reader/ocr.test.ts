// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ocrLinesToItems, ocrScale, ocrWorkerCount, type OcrBlock, type OcrLine, type PdfOcrSession } from './ocr';
import { pagesToRecognize, recognizePages, reconstructBlocks, layoutPdfPages, type PdfPageText, type PdfTextItem } from './pdf';

/** A line as Tesseract reports it, in px of a page drawn at `scale`. */
function ocrLine(text: string, x0: number, baselineY: number, widthPx: number, opts: Partial<OcrLine> & { rowHeight?: number; tilt?: number } = {}): OcrLine {
  const row = opts.rowHeight ?? 32;
  const tilt = opts.tilt ?? 0;
  return {
    text: `${text}\n`,
    confidence: opts.confidence ?? 95,
    bbox: { x0, y0: baselineY - 0.75 * row, x1: x0 + widthPx, y1: baselineY + 0.25 * row + tilt },
    baseline: { x0, y0: baselineY, x1: x0 + widthPx, y1: baselineY + tilt },
    rowAttributes: { rowHeight: row, ascenders: row / 4, descenders: row / 4 },
  };
}

const block = (...lines: OcrLine[]): OcrBlock => ({ paragraphs: [{ lines }] });
const PAGE = { width: 612, height: 792 };

describe('ocrLinesToItems', () => {
  it('turns recognized lines into text items in page units, with the type size and the baseline', () => {
    const scale = 2200 / 792;
    const { items, skew } = ocrLinesToItems([block(ocrLine('The keeper climbed the stairs each evening,', 230, 346, 1250), ocrLine('counting them as his father had.', 230, 398, 800))], scale, PAGE);
    expect(skew).toBe(0);
    expect(items).toHaveLength(2);
    expect(items[0].str).toBe('The keeper climbed the stairs each evening,');
    expect(items[0].x).toBeCloseTo(230 / scale, 6);
    expect(items[0].width).toBeCloseTo(1250 / scale, 6);
    expect(items[0].y).toBeCloseTo(346 / scale, 6);
    expect(items[0].height).toBeCloseTo(32 / scale, 6);
    expect(items[1].y).toBeCloseTo(398 / scale, 6);
  });

  it('drops what is not a line of text: specks, page edges, low confidence, boxes with no size', () => {
    const { items } = ocrLinesToItems(
      [
        block(
          { text: '|\n', confidence: 89, bbox: { x0: 0, y0: 0, x1: 1, y1: 24 }, baseline: { x0: 0, y0: 24, x1: 1, y1: 24 } }, // the page's edge
          ocrLine('~~ ·· ~', 300, 500, 200), // no letter or digit
          ocrLine('smudge that read as words', 300, 600, 400, { confidence: 21 }),
          { text: 'no box', confidence: 95, bbox: { x0: 10, y0: 10, x1: 10, y1: 10 } },
          ocrLine('tiny', 300, 650, 30, { rowHeight: 6 }), // 2 pt type
          ocrLine('The one real line.', 300, 700, 420),
          ocrLine('12', 800, 2000, 30), // a folio is text: the loader decides what a page number is
        ),
        { paragraphs: null },
        {},
      ],
      2200 / 792,
      PAGE,
    );
    expect(items.map((i) => i.str)).toEqual(['The one real line.', '12']);
    expect(ocrLinesToItems(null, 2, PAGE)).toEqual({ items: [], skew: 0 });
    expect(ocrLinesToItems([block(ocrLine('x', 1, 1, 1))], 0, PAGE)).toEqual({ items: [], skew: 0 });
  });

  /** A page of body text as a scan tilted by `deg` about its centre would be read: 3 paragraphs, indented first lines. */
  function tiltedPage(deg: number, scale: number): OcrLine[] {
    const tan = Math.tan((deg * Math.PI) / 180);
    const [cx, cy] = [(PAGE.width * scale) / 2, (PAGE.height * scale) / 2];
    const lines: OcrLine[] = [];
    let n = 0;
    for (let p = 0; p < 3; p++) {
      for (let k = 0; k < 6; k++, n++) {
        const last = k === 5;
        const x0 = k === 0 ? 300 : 230; // first-line indent
        const width = last ? 420 : 1470 - x0;
        const y = 400 + n * 51;
        // Rotate the line's ends about the page's centre (small angle).
        const at = (x: number, yy: number): [number, number] => [x - (yy - cy) * tan, yy + (x - cx) * tan];
        const [ax, ay] = at(x0, y);
        const [bx, by] = at(x0 + width, y);
        const row = 32 + (n % 3 === 1 ? -2 : n % 3 === 2 ? 1.5 : 0); // the estimate wobbles
        lines.push({
          text: `Paragraph ${p + 1} line ${k + 1} of the keeper and the light${last ? '.' : ','}\n`,
          confidence: 95,
          bbox: { x0: ax, y0: Math.min(ay, by) - 0.75 * row, x1: bx, y1: Math.max(ay, by) + 0.25 * row },
          baseline: { x0: ax, y0: ay, x1: bx, y1: by },
          rowAttributes: { rowHeight: row },
        });
      }
    }
    return lines;
  }

  it('straightens a crooked scan, so paragraphs are still paragraphs, and puts the line boxes back where the lines are', () => {
    const scale = 2200 / 792;
    for (const deg of [1.6, -1.3, 3]) {
      const tilted = tiltedPage(deg, scale);
      const read = ocrLinesToItems([block(...tilted)], scale, PAGE);
      expect(read.skew, `${deg}°`).toBeCloseTo(Math.tan((deg * Math.PI) / 180), 3);
      const page: PdfPageText = { ...PAGE, items: read.items, skew: read.skew };
      // Straightened: every body line starts at the margin or at the indent, to a point's fraction.
      const lefts = read.items.map((i) => i.x * scale);
      for (const x of lefts) expect(Math.min(Math.abs(x - 230), Math.abs(x - 300)), `${deg}°`).toBeLessThan(2);
      // One type size, although the estimates wobbled.
      expect(new Set(read.items.map((i) => i.height.toFixed(3))).size).toBe(1);
      const blocks = reconstructBlocks([page]);
      expect(blocks, `${deg}°`).toHaveLength(3);
      expect(blocks.every((b) => b.kind === 'paragraph')).toBe(true);
      // The pages view's boxes: where the lines are in the picture (their middles), not straightened.
      const layout = layoutPdfPages([page])[0];
      expect(layout.lines).toHaveLength(18);
      layout.lines.forEach((box, i) => {
        const b = tilted[i].baseline!;
        // To about a point (a twelfth of the type's height): the straightening is a small-angle one.
        expect(Math.abs((box.x0 + box.x1) / 2 - (b.x0 + b.x1) / 2 / scale), `${deg}° line ${i} x`).toBeLessThan(1.2);
        expect(Math.abs(box.y - (b.y0 + b.y1) / 2 / scale), `${deg}° line ${i} y`).toBeLessThan(1.2);
      });
    }
    // (On a real 1.6° scan read by the engine, the unstraightened lines came out as 57 paragraphs for 24.)
  });

  it('drops the junk at the ends of a line (a page edge read as "|"), with the box that goes with it', () => {
    const scale = 2;
    const word = (text: string, x0: number, x1: number, confidence = 95) => ({ text, confidence, bbox: { x0, y0: 60, x1, y1: 96 } });
    const line: OcrLine = {
      text: '| The Keeper of the Light _\n',
      confidence: 94,
      bbox: { x0: 0, y0: 0, x1: 700, y1: 96 },
      baseline: { x0: 0, y0: 88, x1: 700, y1: 88 },
      rowAttributes: { rowHeight: 30 },
      words: [word('|', 0, 2, 89), word('The', 475, 520), word('Keeper', 530, 590), word('of', 598, 615), word('the', 622, 648), word('Light', 655, 690), word('_', 696, 700, 40)],
    };
    const quoted: OcrLine = { ...line, text: '“It is only a lamp,”\n', words: [word('“It', 200, 230), word('is', 236, 250), word('only', 256, 300), word('a', 306, 314), word('lamp,”', 320, 390)], bbox: { x0: 200, y0: 160, x1: 390, y1: 196 }, baseline: { x0: 200, y0: 188, x1: 390, y1: 188 } };
    const { items } = ocrLinesToItems([block(line, quoted)], scale, PAGE);
    expect(items[0].str).toBe('The Keeper of the Light');
    expect(items[0].x).toBeCloseTo(475 / scale, 6);
    expect(items[0].width).toBeCloseTo((690 - 475) / scale, 6);
    expect(items[1].str).toBe('“It is only a lamp,”'); // quotation marks and commas are text
  });

  it('feeds the same reconstruction as a PDF with real text: paragraphs for the text view, line boxes for the pages view', () => {
    const scale = 2200 / 792;
    const lines = [
      'The lighthouse keeper climbed the stairs each evening, counting them',
      'as his father had. He lit the lamp before the last of the daylight left',
      'the water, and watched the boats come home.',
      'His daughter kept the log, writing the weather and the ships in a',
      'careful, upright hand.',
    ];
    const ocr = lines.map((text, i) => ocrLine(text, i === 0 || i === 3 ? 300 : 230, 400 + i * 51, i === 2 || i === 4 ? 700 : i === 0 || i === 3 ? 1180 : 1250));
    const page: PdfPageText = { ...PAGE, items: ocrLinesToItems([block(...ocr)], scale, PAGE).items };
    const blocks = reconstructBlocks([page]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'paragraph', text: expect.stringMatching(/^The lighthouse keeper .* boats come home\.$/) as unknown });
    expect(blocks[1]).toMatchObject({ kind: 'paragraph', text: expect.stringMatching(/^His daughter .* upright hand\.$/) as unknown });
    const layout = layoutPdfPages([page]);
    expect(layout[0].lines).toHaveLength(5);
    expect(layout[0].lines[0].text).toBe(lines[0]);
    expect(layout[0].lines[0].y).toBeCloseTo(400 / scale, 3);
  });
});

describe('ocrScale and ocrWorkerCount', () => {
  it('draws a page about 2200 px on its long side, never smaller than the page or absurdly large', () => {
    expect(ocrScale(612, 792) * 792).toBeCloseTo(2200, 6);
    expect(ocrScale(792, 612) * 792).toBeCloseTo(2200, 6);
    expect(ocrScale(5000, 7000)).toBe(1); // a poster: as it is
    expect(ocrScale(100, 150)).toBe(4); // a stamp: four times, not fifteen
    expect(ocrScale(0, 0)).toBe(1);
  });

  it('runs one worker fewer than the cores, three at most, never more than there are pages', () => {
    expect(ocrWorkerCount(300, 8)).toBe(3);
    expect(ocrWorkerCount(300, 4)).toBe(3);
    expect(ocrWorkerCount(300, 2)).toBe(1);
    expect(ocrWorkerCount(300, Number.NaN)).toBe(1); // the browser doesn't say
    expect(ocrWorkerCount(2, 8)).toBe(2);
    expect(ocrWorkerCount(0, 8)).toBe(1);
  });
});

describe('pagesToRecognize', () => {
  const text = (chars: number): PdfPageText => ({ ...PAGE, items: chars ? [{ str: 'x'.repeat(chars), x: 72, y: 100, width: chars * 5, height: 10 } satisfies PdfTextItem] : [] });
  it('reads the textless pages of a scanned book, also one scanned in part', () => {
    expect(pagesToRecognize([text(0), text(0), text(0)])).toEqual([0, 1, 2]);
    expect(pagesToRecognize([text(900), text(0), text(3), text(0)])).toEqual([1, 2, 3]); // a typed title page, then scans (one with a stray mark)
    expect(pagesToRecognize([text(0)])).toEqual([0]);
  });
  it('leaves the odd textless page of a text PDF alone (a figure, a plate, a blank)', () => {
    expect(pagesToRecognize([text(900), text(0), text(900), text(900)])).toEqual([]);
    expect(pagesToRecognize([text(900), text(900)])).toEqual([]);
    expect(pagesToRecognize([])).toEqual([]);
  });
});

// ─────────────── the loader's recognition pass, with stand-ins for pdf.js and the engine ───────────────
// (pdf.js itself needs a newer JavaScript runtime than these tests run on; the whole path, with the
// real engine, is exercised in a browser.)

const PDFJS = { AnnotationMode: { DISABLE: 0 } } as unknown as Parameters<typeof recognizePages>[0];

/** A document of scanned Letter pages: nothing to extract, something to draw. */
function scannedDoc(log: { drawn: number[]; cleaned: number }): Parameters<typeof recognizePages>[1] {
  return {
    getPage: (n: number) =>
      Promise.resolve({
        getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
        render: () => {
          log.drawn.push(n - 1);
          return { promise: Promise.resolve() };
        },
        cleanup: () => {
          log.cleaned++;
          return true;
        },
      } as unknown as Awaited<ReturnType<Parameters<typeof recognizePages>[1]['getPage']>>),
  };
}

const blank = (n: number): PdfPageText[] => Array.from({ length: n }, () => ({ ...PAGE, items: [] }));
const all = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

const SCAN_LINES = [
  'The lighthouse keeper climbed the stairs each evening, counting them',
  'as his father had. He lit the lamp before the last of the daylight left',
  'the water, and watched the boats come home.',
];

interface Log {
  read: number[];
  drawn: number[];
  cleaned: number;
  closed: number;
  inFlight: number;
  maxInFlight: number;
  canvases: { width: number; height: number }[];
}
const newLog = (): Log => ({ read: [], drawn: [], cleaned: 0, closed: 0, inFlight: 0, maxInFlight: 0, canvases: [] });

/** A session that draws each page as the real one does, then "reads" the same three lines, numbered. */
function fakeSession(log: Log, opts: { concurrency?: number; delayMs?: number; failOn?: number } = {}): (pages: number) => Promise<PdfOcrSession> {
  return () =>
    Promise.resolve({
      concurrency: opts.concurrency ?? 2,
      async read(page) {
        log.inFlight++;
        log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        try {
          const canvas = document.createElement('canvas');
          await page.draw(canvas, ocrScale(page.width, page.height));
          log.canvases.push({ width: canvas.width, height: canvas.height });
          await new Promise((r) => setTimeout(r, opts.delayMs ?? 1));
          if (opts.failOn === page.index) throw new Error('worker died');
          log.read.push(page.index);
          return { items: SCAN_LINES.map((str, i) => ({ str: i === 0 ? `Page ${page.index + 1}. ${str}` : str, x: i === 0 ? 96 : 72, y: 120 + i * 16, width: 420, height: 11 })), skew: 0 };
        } finally {
          log.inFlight--;
        }
      },
      close() {
        log.closed++;
        return Promise.resolve();
      },
    });
}

describe('recognizePages', () => {
  it('reads every page through the engine, as many at once as it has workers, and says how far it is', async () => {
    const log = newLog();
    const progress: string[] = [];
    const pages = blank(5);
    await recognizePages(PDFJS, scannedDoc(log), pages, all(5), fakeSession(log), { onProgress: (m) => progress.push(m) });
    expect([...log.read].sort()).toEqual([0, 1, 2, 3, 4]);
    expect([...log.drawn].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(log.cleaned).toBe(5);
    expect(log.maxInFlight).toBe(2);
    expect(log.closed).toBeGreaterThanOrEqual(1);
    expect(log.canvases[0]).toEqual({ width: 1700, height: 2200 }); // about 200 dpi
    pages.forEach((page, i) => expect(page.items[0].str).toBe(`Page ${i + 1}. ${SCAN_LINES[0]}`));
    expect(reconstructBlocks(pages)).toHaveLength(5);
    expect(progress[0]).toMatch(/getting the text reader ready/);
    expect(progress).toContain('This PDF is scanned pages: reading their text, page 1 of 5…');
    expect(progress[progress.length - 1]).toMatch(/page 5 of 5/);
  });

  it('reads only the pages it is asked to, and leaves the others as they were', async () => {
    const log = newLog();
    const pages = blank(4);
    pages[0] = { ...PAGE, items: [{ str: 'A typed title page', x: 72, y: 100, width: 200, height: 12 }] };
    await recognizePages(PDFJS, scannedDoc(log), pages, [1, 3], fakeSession(log), {});
    expect([...log.read].sort()).toEqual([1, 3]);
    expect(pages[0].items[0].str).toBe('A typed title page');
    expect(pages[2].items).toEqual([]);
  });

  it('stops when the reader cancels: an AbortError, the engine closed, no more pages read', async () => {
    const log = newLog();
    const abort = new AbortController();
    const reading = recognizePages(PDFJS, scannedDoc(log), blank(40), all(40), fakeSession(log, { delayMs: 15, concurrency: 1 }), {
      signal: abort.signal,
      onProgress: (m) => {
        if (/page 3 of/.test(m)) abort.abort();
      },
    });
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(log.read.length).toBeLessThan(6);
    expect(log.closed).toBeGreaterThanOrEqual(1);
    const after = log.read.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(log.read.length).toBe(after);
  });

  it('reports an engine that can’t start as a load error, and one that dies as its error, closed either way', async () => {
    const log = newLog();
    await expect(recognizePages(PDFJS, scannedDoc(log), blank(2), all(2), () => Promise.reject(new Error('404')), {})).rejects.toMatchObject({
      code: 'parse',
      message: expect.stringMatching(/text reader .* couldn’t be loaded/) as unknown,
    });
    await expect(recognizePages(PDFJS, scannedDoc(log), blank(6), all(6), fakeSession(log, { failOn: 2 }), {})).rejects.toThrow('worker died');
    expect(log.closed).toBeGreaterThanOrEqual(1);
    expect(log.read.length).toBeLessThan(6);
  });
});
