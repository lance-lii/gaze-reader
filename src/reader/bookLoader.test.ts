// @vitest-environment jsdom
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '../types';
import {
  BookLoadError,
  countWords,
  decodeText,
  detectTextFormat,
  extractMainContent,
  hashId,
  loadBookFromFile,
  loadBookFromText,
  loadBookFromUrl,
  markdownToHtml,
  matchChapterLine,
  smartenPunctuation,
  stripGutenberg,
  tameShouting,
  textOfNode,
  titleFromFileName,
} from './bookLoader';

// pdf.js itself isn't under test here: a stand-in shows whether a file was routed to the PDF parser.
vi.mock('./pdf', () => ({
  parsePdf: vi.fn(async () => {
    throw new Error('routed to the PDF parser');
  }),
}));

function fragment(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

function chapterText(book: Book, i: number): string {
  return fragment(book.chapters[i].html).textContent ?? '';
}

// ─────────────────────────────── helpers ───────────────────────────────

describe('hashId (FNV-1a 64 → base36)', () => {
  function reference(text: string): string {
    let h = 0xcbf29ce484222325n;
    for (const b of new TextEncoder().encode(text)) {
      h ^= BigInt(b);
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h.toString(36);
  }

  it('matches the published test vectors', () => {
    expect(hashId('')).toBe(BigInt('0xcbf29ce484222325').toString(36));
    expect(hashId('a')).toBe(BigInt('0xaf63dc4c8601ec8c').toString(36));
    expect(hashId('foobar')).toBe(BigInt('0x85944171f73967e8').toString(36));
  });

  it('agrees with a BigInt reference over Unicode and long input', () => {
    for (const s of ['héllo wörld', '日本語のテキスト', '😀 emoji', 'x'.repeat(10_000), '\u0000\uffff']) {
      expect(hashId(s)).toBe(reference(s));
    }
  });
});

describe('countWords', () => {
  it.each([
    ['', 0],
    ['Hello, world!', 2],
    ["don't well-known e.g. 3.14", 4],
    ['— – … !!!', 0],
    ['naïve café', 2],
    ['cafe\u0301 au lait', 3],
    ['日本語のテキスト', 8],
    ['  spaced\n\nout\ttext  ', 3],
  ])('%j → %i', (text, n) => {
    expect(countWords(text)).toBe(n);
  });
});

describe('smartenPunctuation', () => {
  it('curls quotes and apostrophes and sets dashes and ellipses', () => {
    expect(smartenPunctuation(`"Hello," she said. 'Tis the season--isn't it?...`)).toBe(
      '\u201cHello,\u201d she said. \u2019Tis the season\u2014isn\u2019t it?\u2026',
    );
    expect(smartenPunctuation("rock 'n' roll in the '90s")).toBe('rock \u2019n\u2019 roll in the \u201990s');
    expect(smartenPunctuation("'single' and (\"nested 'inner'\")")).toBe(
      '\u2018single\u2019 and (\u201cnested \u2018inner\u2019\u201d)',
    );
    expect(smartenPunctuation('a ---- rule stays')).toBe('a ---- rule stays');
  });
});

describe('matchChapterLine', () => {
  it.each([
    'CHAPTER I.',
    'Chapter 12',
    'BOOK TWO',
    'Chapter 3: The Storm',
    'CHAPTER IV THE STORM',
    'Chapter One - The Beginning',
    'Chapter 1 The Beginning',
    'Part the First',
    'Letter 4',
    'PROLOGUE',
    'Table of Contents',
    'XIV',
    '7.',
  ])('recognizes %j', (line) => {
    expect(matchChapterLine(line)).not.toBeNull();
  });

  it.each([
    'Book two was better.',
    'Chapter one of my life was dull.',
    'Part of the problem is time',
    'Chapter 5 was long, and dull',
    'Book mild',
    'Mix',
    'I think so.',
    'The chapter ended.',
    '',
  ])('rejects %j', (line) => {
    expect(matchChapterLine(line)).toBeNull();
  });

  it('labels headings by keyword and number, independent of their titles', () => {
    expect(matchChapterLine('CHAPTER IV.')?.label).toBe('chapter iv');
    expect(matchChapterLine('Chapter IV: The Storm')?.label).toBe('chapter iv');
    expect(matchChapterLine('CHAPTER IV.')?.numberOnly).toBe(true);
    expect(matchChapterLine('Chapter IV: The Storm')?.numberOnly).toBe(false);
  });
});

describe('small text utilities', () => {
  it('tames all-caps titles but leaves mixed case alone', () => {
    expect(tameShouting('PRIDE AND PREJUDICE')).toBe('Pride and Prejudice');
    expect(tameShouting('THE LIFE OF HENRY VIII')).toBe('The Life of Henry VIII');
    expect(tameShouting('MOBY-DICK; OR, THE WHALE')).toBe('Moby-Dick; or, The Whale');
    expect(tameShouting('WHAT DID THE CIVIL WAR DO?')).toBe('What Did the Civil War Do?');
    expect(tameShouting('“THE END”')).toBe('“The End”');
    expect(tameShouting('WAR AND PEACE: A NOVEL')).toBe('War and Peace: A Novel');
    expect(tameShouting('Moby-Dick; or, The Whale')).toBe('Moby-Dick; or, The Whale');
  });

  it('turns file names into titles', () => {
    expect(titleFromFileName('the_time-machine.txt')).toBe('The time machine');
    expect(titleFromFileName('C:\\books\\war-and-peace.epub')).toBe('War and peace');
    expect(titleFromFileName('.txt')).toBe('Untitled');
  });

  it('detects text formats', () => {
    expect(detectTextFormat('<!DOCTYPE html><html><body><p>x</p></body></html>')).toBe('html');
    expect(detectTextFormat('<p>Hello</p><p>World</p>')).toBe('html');
    expect(detectTextFormat('# Title\n\nSome **bold** text.')).toBe('md');
    expect(detectTextFormat('---\ntitle: X\n---\n\nText')).toBe('md');
    expect(detectTextFormat('CHAPTER I.\n\nIt was a dark and stormy night; the rain fell in torrents.')).toBe('txt');
    expect(detectTextFormat('Price: 3 * 4 = 12 and a - b')).toBe('txt');
  });

  it('decodes UTF-8, BOMs, UTF-16 and windows-1252', () => {
    expect(decodeText(new TextEncoder().encode('caf\u00e9 \u201cok\u201d'))).toBe('caf\u00e9 \u201cok\u201d');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe('hi');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe('hi');
    // Smart quotes and an e-acute from an old Windows/Gutenberg file, which is not valid UTF-8.
    expect(decodeText(new Uint8Array([0x93, 0x48, 0x69, 0x94, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x85]))).toBe(
      '\u201cHi\u201d caf\u00e9\u2026',
    );
    expect(decodeText(new Uint8Array([0xe9]), 'iso-8859-1')).toBe('\u00e9');
  });
});

// ──────────────────────────────── plain text ────────────────────────────────

const GUTENBERG = `The Project Gutenberg eBook of The Tiny Test, by Ada Byron

This eBook is for the use of anyone anywhere in the United States and
most other parts of the world at no cost and with almost no restrictions.

Title: The Tiny Test

Author: Ada Byron

Release date: January 1, 2024 [eBook #99999]

*** START OF THE PROJECT GUTENBERG EBOOK THE TINY TEST ***




Produced by A. Volunteer and the Online Distributed
Proofreading Team.




THE TINY TEST

By Ada Byron




CONTENTS

CHAPTER I. The Lantern

CHAPTER II. The Library

CHAPTER III. The Letter




CHAPTER I.

THE LANTERN


The morning fog lay thick over the valley, and the bells of the old abbey
were ringing nine when Marigold set out along the lane toward the library,
her scarf pulled high against the wind and her satchel full of borrowed books.

"Good morning," said the baker.
"Good morning," said Marigold.

She stopped at the gate and looked back at the village, where the chimneys
were beginning to smoke.
"It will rain," she said, and walked on without waiting for an answer.

The keeper of the library was a small man with a very large ring of keys--the
largest ring, people said, in the whole of the county--and a habit of humming.

* * *

He was _very_ glad to see her.




CHAPTER II.

THE LIBRARY


Inside, the shelves climbed higher than any ladder could reach, and the air
smelled of paper, dust and the faint sweetness of old glue and leather.

    Here lies a reader, calm and still,
      who read by lamp and window-sill.




CHAPTER III.

THE LETTER


At the back of the last shelf she found a letter addressed to her by name,
though no one in the village could have known that she would come today.

End of the Project Gutenberg EBook of The Tiny Test, by Ada Byron

*** END OF THE PROJECT GUTENBERG EBOOK THE TINY TEST ***

Updated editions will replace the previous one--the old editions will
be renamed. LICENSE TEXT THAT MUST NOT APPEAR.
`;

describe('plain text → Book', () => {
  it('strips the Gutenberg boilerplate and reads its metadata', () => {
    const g = stripGutenberg(GUTENBERG);
    expect(g.title).toBe('The Tiny Test');
    expect(g.author).toBe('Ada Byron');
    expect(g.body).not.toContain('Produced by');
    expect(g.body).not.toContain('LICENSE TEXT');
    expect(g.body).not.toContain('End of the Project Gutenberg');
  });

  const book = (): Book => loadBookFromText(GUTENBERG, { format: 'txt' });

  it('splits chapters on headings and keeps a title page and a contents page', () => {
    const b = book();
    expect(b.title).toBe('The Tiny Test');
    expect(b.author).toBe('Ada Byron');
    expect(b.format).toBe('txt');
    expect(b.source).toBe('paste');
    expect(b.chapters.map((c) => c.title)).toEqual([
      null,
      'CONTENTS',
      'CHAPTER I. THE LANTERN',
      'CHAPTER II. THE LIBRARY',
      'CHAPTER III. THE LETTER',
    ]);
    expect(b.chapters[0].html).toContain('<h1>THE TINY TEST</h1>');
    expect(b.chapters[0].html).toContain('<p>By Ada Byron</p>');
    // The table of contents is one block of lines, not three empty chapters.
    expect(b.chapters[1].html).toMatch(/<p>CHAPTER I\. The Lantern<br>CHAPTER II\. The Library<br>CHAPTER III\. The Letter<\/p>/);
    expect(b.chapters[2].html).toContain('<h2>CHAPTER I.<br>THE LANTERN</h2>');
    expect(JSON.stringify(b)).not.toContain('LICENSE TEXT');
  });

  it('joins hard-wrapped lines, keeps dialogue apart and sets smart punctuation', () => {
    const ch = fragment(book().chapters[2].html);
    const paras = Array.from(ch.querySelectorAll('p')).map((p) => p.textContent);
    expect(paras[0]).toMatch(/^The morning fog lay thick over the valley, .* borrowed books\.$/);
    expect(paras[0]).not.toContain('\n');
    expect(paras[1]).toBe('\u201cGood morning,\u201d said the baker.');
    expect(paras[2]).toBe('\u201cGood morning,\u201d said Marigold.');
    expect(paras[3]).toBe('She stopped at the gate and looked back at the village, where the chimneys were beginning to smoke.');
    expect(paras[4]).toBe('\u201cIt will rain,\u201d she said, and walked on without waiting for an answer.');
    expect(paras[5]).toContain('keys\u2014the largest ring');
    expect(ch.querySelector('hr')).not.toBeNull();
    expect(ch.querySelector('em')?.textContent).toBe('very');
  });

  it('keeps verse line breaks and indentation inside an indented block quote', () => {
    const ch = fragment(book().chapters[3].html);
    const quote = ch.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote?.innerHTML).toContain('Here lies a reader, calm and still,<br>');
    expect(quote?.textContent).toContain('\u00a0\u00a0who read by lamp');
  });

  it('computes word counts and a stable content id', () => {
    const a = book();
    const b = book();
    expect(a.id).toBe(b.id);
    expect(a.wordCount).toBeGreaterThan(150);
    expect(a.wordCount).toBe(a.chapters.reduce((n, c) => n + countWords(textOfNode(fragment(c.html))), 0));
    // Text after the END marker is licence boilerplate and doesn't change the book…
    expect(loadBookFromText(GUTENBERG + ' extra', { format: 'txt' }).id).toBe(a.id);
    // …but any change to the book itself does.
    expect(loadBookFromText(GUTENBERG.replace('_very_', '_truly_'), { format: 'txt' }).id).not.toBe(a.id);
  });

  it('merges a part heading into the chapter that follows it', () => {
    const b = loadBookFromText(
      'PART ONE\n\n\n\nCHAPTER 1\n\nThe first chapter has a sentence or two of text in it.\n\n\n\nCHAPTER 2\n\nThe second one too, with a few more words.',
      { format: 'txt', title: 'Parts' },
    );
    expect(b.title).toBe('Parts');
    expect(b.chapters.map((c) => c.title)).toEqual(['CHAPTER 1', 'CHAPTER 2']);
    expect(b.chapters[0].html).toContain('<h2>PART ONE</h2>');
    expect(b.chapters[0].html).toContain('<h3>CHAPTER 1</h3>');
  });

  it('treats each line as a paragraph when the text is not hard-wrapped', () => {
    const long = (n: number) => `Paragraph ${n} ` + 'goes on and on with plenty of words in it '.repeat(4) + 'and ends here.';
    const b = loadBookFromText([long(1), long(2), long(3)].join('\n'), { format: 'txt' });
    expect(fragment(b.chapters[0].html).querySelectorAll('p')).toHaveLength(3);
  });

  it('splits first-line-indented paragraphs without blank lines', () => {
    const text = [
      '  The first paragraph starts here and continues onto another line that',
      'is long enough to look like hard-wrapped prose in a plain text file.',
      '  The second paragraph also starts with an indent and it also runs on',
      'for a while so that it wraps onto a second line of the text file.',
    ].join('\n');
    const b = loadBookFromText(text, { format: 'txt', title: 'Indents' });
    expect(fragment(b.chapters[0].html).querySelectorAll('p')).toHaveLength(2);
    expect(fragment(b.chapters[0].html).querySelector('blockquote')).toBeNull();
  });

  it('uses the first title-like line as the title, and a fallback otherwise', () => {
    expect(loadBookFromText('The Clockwork Garden\n\nby Iris Vale\n\nOnce upon a time there was a garden.').title).toBe(
      'The Clockwork Garden',
    );
    expect(loadBookFromText('The Clockwork Garden\n\nby Iris Vale\n\nOnce upon a time there was a garden.').author).toBe('Iris Vale');
    expect(loadBookFromText('it was a dark and stormy night and nothing happened at all.').title).toBe('Pasted text');
  });

  it('drops illustration placeholders and refuses empty input', () => {
    const b = loadBookFromText('[Illustration: A lantern]\n\nSome real words here.', { format: 'txt', title: 'x' });
    expect(chapterText(b, 0)).not.toContain('Illustration');
    expect(() => loadBookFromText('   \n  ')).toThrow(BookLoadError);
    expect(() => loadBookFromText('[Illustration]', { format: 'txt' })).toThrow(/readable text/);
  });
});

// ──────────────────────────────── Markdown ────────────────────────────────

describe('markdownToHtml', () => {
  it('renders the supported subset', () => {
    const html = markdownToHtml(
      [
        '# Title',
        '',
        'Some *em*, **strong**, ***both***, _under_, snake_case_word and `code <b>`.',
        '',
        '- one',
        '- two',
        '  - nested',
        '',
        '3. three',
        '4. four',
        '',
        '> quoted',
        'lazy continuation',
        '',
        '---',
        '',
        '```js',
        '<script>alert(1)</script>',
        '```',
        '',
        'Setext Heading',
        '--------------',
        '',
        'line one  ',
        'line two\\',
        'line three',
      ].join('\n'),
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain(
      '<p>Some <em>em</em>, <strong>strong</strong>, <strong><em>both</em></strong>, <em>under</em>, snake_case_word and <code>code &lt;b&gt;</code>.</p>',
    );
    expect(html).toContain('<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>');
    expect(html).toContain('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(html).toContain('<blockquote><p>quoted lazy continuation</p></blockquote>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>');
    expect(html).toContain('<h2>Setext Heading</h2>');
    expect(html).toContain('<p>line one<br>line two<br>line three</p>');
  });

  it('escapes raw HTML instead of passing it through', () => {
    expect(markdownToHtml('<div onclick="x()">raw</div>')).toBe('<p>&lt;div onclick=\u201cx()\u201d&gt;raw&lt;/div&gt;</p>');
  });

  it('keeps safe links and drops dangerous ones', () => {
    expect(markdownToHtml('[site](https://example.com "The site")')).toBe(
      '<p><a href="https://example.com" title="The site">site</a></p>',
    );
    expect(markdownToHtml('[x](javascript:alert(1)) [y]( JAVASCRIPT:alert(1)) [z](data:text/html,x)')).toBe('<p>x y z</p>');
    expect(markdownToHtml('<https://example.com/a>')).toBe('<p><a href="https://example.com/a">https://example.com/a</a></p>');
    expect(markdownToHtml('![alt text](cover.png) after')).toBe('<p> after</p>');
  });

  it('handles escapes, smart quotes and loose lists', () => {
    expect(markdownToHtml('\\*not em\\* and "quoted" it\'s')).toBe('<p>*not em* and \u201cquoted\u201d it\u2019s</p>');
    expect(markdownToHtml('- a\n\n- b')).toBe('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    expect(markdownToHtml('1) first\n2) second')).toBe('<ol><li>first</li><li>second</li></ol>');
  });

  it('strips YAML front matter but not a leading rule followed by prose', () => {
    expect(markdownToHtml('---\ntitle: X\nauthor: "Y"\n---\n\nBody')).toBe('<p>Body</p>');
    expect(markdownToHtml('---\n\nJust a rule.\n\n---\n')).toBe('<hr>\n<p>Just a rule.</p>\n<hr>');
  });
});

describe('Markdown → Book', () => {
  const md = [
    '---',
    'title: "Front Matter Title"',
    'author: Jane Doe',
    '---',
    '',
    '# Big Title',
    '',
    '*by Someone Else*',
    '',
    'An introductory paragraph with some words.',
    '',
    '## Chapter One',
    '',
    'Text of chapter one.',
    '',
    '## Chapter Two',
    '',
    'Text of chapter two.',
  ].join('\n');

  it('uses front matter, splits at chapter headings and keeps the title page', () => {
    const b = loadBookFromText(md, { format: 'md' });
    expect(b.title).toBe('Front Matter Title');
    expect(b.author).toBe('Jane Doe');
    expect(b.format).toBe('md');
    expect(b.chapters.map((c) => c.title)).toEqual(['Big Title', 'Chapter One', 'Chapter Two']);
    expect(b.chapters[1].html).toBe('<h2>Chapter One</h2>\n<p>Text of chapter one.</p>\n');
  });

  it('falls back to the h1 and its byline without front matter', () => {
    const b = loadBookFromText(md.split('\n').slice(5).join('\n'));
    expect(b.format).toBe('md');
    expect(b.title).toBe('Big Title');
    expect(b.author).toBe('Someone Else');
  });
});

// ────────────────────────────────── HTML ──────────────────────────────────

const ARTICLE_PAGE = `<!doctype html><html><head><title>The Quiet Library | Example Magazine</title>
<meta name="author" content="Jo Writer"></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/subscribe">Subscribe</a></nav>
<div class="sidebar"><p>Subscribe to our newsletter for more great articles, delivered every week!</p></div>
<article>
  <h1>The Quiet Library</h1>
  <p>Libraries are quiet places, full of books, readers, and the soft rustle of turning pages.</p>
  <p>Some readers come for silence, some for company, and some, quite simply, for the smell of paper.</p>
  <div class="share-buttons"><a href="https://social.example/share">Share this</a></div>
  <h2>Opening hours</h2>
  <p>Most libraries open early and close late, which suits readers of every kind, owls and larks alike.</p>
  <p>Check the <a href="/hours">full schedule</a>, or the <a href="#faq">FAQ</a>, before visiting.</p>
  <script>trackEverything()</script>
</article>
<footer>© 2024 Example Magazine. All rights reserved.</footer>
</body></html>`;

describe('HTML → Book', () => {
  it('extracts the article from a full page', () => {
    const doc = new DOMParser().parseFromString(ARTICLE_PAGE, 'text/html');
    expect(extractMainContent(doc).localName).toBe('article');
  });

  it('keeps the article text and drops navigation, sidebars, sharing widgets and footers', () => {
    const b = loadBookFromText(ARTICLE_PAGE, { format: 'html' });
    expect(b.title).toBe('The Quiet Library');
    expect(b.author).toBe('Jo Writer');
    expect(b.format).toBe('html');
    const all = b.chapters.map((c) => c.html).join('\n');
    expect(all).toContain('soft rustle of turning pages');
    expect(all).toContain('owls and larks');
    for (const junk of ['Home', 'newsletter', 'Share this', 'All rights reserved', 'trackEverything']) {
      expect(all).not.toContain(junk);
    }
    expect(all).toContain('<a href="#gr-src-faq">FAQ</a>');
  });

  it('uses a pasted fragment as is and splits it at repeated headings', () => {
    const b = loadBookFromText('<h2>One</h2><p>First part text.</p><h2>Two</h2><p>Second part text.</p>', { format: 'html' });
    expect(b.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
  });

  it('drops the Project Gutenberg licence sections even when they outweigh the book', () => {
    const licence = '<p>' + 'This eBook is for the use of anyone anywhere, at no cost, and with almost no restrictions. '.repeat(40) + '</p>';
    const b = loadBookFromText(
      `<html><body><section class="pg-boilerplate pgheader" id="pg-header">${licence}<p>*** START OF THE PROJECT GUTENBERG EBOOK A POEM ***</p></section>` +
        '<h1>A Poem</h1><p>Short and sweet, the whole poem fits on a single line, like this one.</p>' +
        `<section class="pg-boilerplate pgheader" id="pg-footer"><p>*** END OF THE PROJECT GUTENBERG EBOOK A POEM ***</p>${licence}</section></body></html>`,
      { format: 'html' },
    );
    const all = b.chapters.map((c) => c.html).join('');
    expect(all).toContain('Short and sweet');
    expect(all).not.toContain('no restrictions');
    expect(all).not.toContain('PROJECT GUTENBERG');
  });

  it('reads Project Gutenberg style titles', () => {
    const b = loadBookFromText(
      '<html><head><title>The Project Gutenberg eBook of Tiny Tales, by Ada Byron</title></head><body><p>Once there was a tale.</p></body></html>',
      { format: 'html' },
    );
    expect(b.title).toBe('Tiny Tales');
    expect(b.author).toBe('Ada Byron');
  });
});

// ────────────────────────────────── files ──────────────────────────────────

async function tinyEpub(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    'content.opf',
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Zipped</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
  );
  zip.file('c1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>One</h1><p>Hello from an EPUB.</p></body></html>');
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('loadBookFromFile', () => {
  it('reads a windows-1252 text file and titles it from the file name', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('It was a '), 0x93, ...new TextEncoder().encode('fine'), 0x94, 0x20, 0x64, 0x61, 0x79, 0x2e]);
    const book = await loadBookFromFile(new File([bytes], 'a_fine-day.txt', { type: 'text/plain' }));
    expect(book.title).toBe('A fine day');
    expect(book.source).toBe('file');
    expect(chapterText(book, 0)).toBe('It was a \u201cfine\u201d day.');
  });

  it('reads Markdown and HTML by extension', async () => {
    const md = await loadBookFromFile(new File(['# Hello\n\nWorld of *words*.'], 'notes.md'));
    expect(md.format).toBe('md');
    expect(md.title).toBe('Hello');
    const html = await loadBookFromFile(new File(['<html><body><p>Hi there, reader.</p></body></html>'], 'page.htm'));
    expect(html.format).toBe('html');
    expect(chapterText(html, 0)).toBe('Hi there, reader.');
  });

  it('sniffs an EPUB by its bytes, whatever the extension', async () => {
    const book = await loadBookFromFile(new File([await tinyEpub()], 'download.bin'));
    expect(book.format).toBe('epub');
    expect(book.title).toBe('Zipped');
    expect(book.source).toBe('file');
  });

  it('explains unsupported and empty files', async () => {
    await expect(loadBookFromFile(new File(['x'], 'book.mobi'))).rejects.toMatchObject({ code: 'unsupported' });
    const docx = new JSZip();
    docx.file('word/document.xml', '<w:document/>');
    await expect(loadBookFromFile(new File([await docx.generateAsync({ type: 'arraybuffer' })], 'essay.docx'))).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('Word'),
    });
    await expect(loadBookFromFile(new File([new Uint8Array([0, 1, 2, 3, 0, 5])], 'blob.dat'))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(loadBookFromFile(new File([], 'empty.txt'))).rejects.toMatchObject({ code: 'empty' });
    await expect(loadBookFromFile(new File(['{\\rtf1 hello}'], 'x.txt'))).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('keeps text that merely mentions a PDF header as text, but routes real PDFs to the PDF parser', async () => {
    // Regression: any "%PDF-" in the first KB used to send the file to pdf.js ("This PDF couldn't be read").
    const md = await loadBookFromFile(new File(['# PDF notes\n\nEvery file starts with %PDF-1.7 and a comment.\n\nMore notes.'], 'notes.md'));
    expect(md.format).toBe('md');
    const txt = await loadBookFromFile(new File(['Notes\n\nThe signature %PDF-1.4 sits near the top of a PDF.'], 'notes'));
    expect(txt.format).toBe('txt');

    const routed = { message: 'routed to the PDF parser' };
    await expect(loadBookFromFile(new File(['%PDF-1.7\n%âã\n1 0 obj'], 'download.bin'))).rejects.toMatchObject(routed);
    // Junk before the signature is tolerated when the name or the bytes say "PDF".
    await expect(loadBookFromFile(new File(['junk\n%PDF-1.4\n1 0 obj'], 'paper.pdf'))).rejects.toMatchObject(routed);
    const binary = new Uint8Array([0x01, 0x02, 0x03, 0x04, ...new TextEncoder().encode('%PDF-1.4\n'), 0x05, 0x06, 0x07, 0x08]);
    await expect(loadBookFromFile(new File([binary], 'scan.bin'))).rejects.toMatchObject(routed);
  });
});

describe('scaling to huge and hostile text', () => {
  it('loads a 150 000-line text with no blank lines in linear time', () => {
    // Regression: Math.min(...lines) overflowed the call stack for one huge block, and
    // re-joining wrapped lines tested a regex against the whole growing paragraph (quadratic:
    // 200 000 lines took minutes).
    const line = 'the quiet reader turned another page and kept on going';
    const text = Array.from({ length: 150_000 }, () => line).join('\n');
    const started = performance.now();
    const book = loadBookFromText(text, { format: 'txt' });
    expect(book.wordCount).toBe(150_000 * 10);
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('caps Markdown nesting so hostile input neither overflows the stack nor goes quadratic', () => {
    const quotes = markdownToHtml(`${'> '.repeat(20_000)}deep`);
    expect(quotes.match(/<blockquote>/g)).toHaveLength(16);
    expect(quotes).toContain('deep');

    const list = Array.from({ length: 3000 }, (_, i) => `${' '.repeat(i * 2)}- item ${i}`).join('\n');
    const started = performance.now();
    const html = markdownToHtml(list);
    expect(html.match(/<ul>/g)).toHaveLength(16);
    expect(html).toContain('item 2999');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('keeps smart quotes right in a very long paragraph', () => {
    const text = Array.from({ length: 2000 }, () => '"Yes," she said, \'twas fine').join(' ');
    const out = smartenPunctuation(text);
    expect(out.startsWith('“Yes,” she said, ’twas fine “Yes,”')).toBe(true);
    expect(out).not.toMatch(/["']/);
  });
});

// ─────────────────────────────────── URLs ───────────────────────────────────

describe('loadBookFromUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function respond(body: BodyInit, contentType: string, status = 200): Response {
    return new Response(body, { status, headers: { 'content-type': contentType } });
  }

  it('fetches without credentials or referrer and extracts the article', async () => {
    const fetchMock = vi.fn(async () => respond(ARTICLE_PAGE, 'text/html; charset=utf-8'));
    vi.stubGlobal('fetch', fetchMock);
    const book = await loadBookFromUrl('https://magazine.example/articles/quiet-library');
    expect(book.source).toBe('url');
    expect(book.title).toBe('The Quiet Library');
    const all = book.chapters.map((c) => c.html).join('');
    expect(all).toContain('href="https://magazine.example/hours"'); // relative links resolved against the page
    expect(all).not.toContain('newsletter');
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
  });

  it('adds https:// to bare domains and reads plain text', async () => {
    const fetchMock = vi.fn(async () => respond('A short story.\n\nThe end came quickly.', 'text/plain'));
    vi.stubGlobal('fetch', fetchMock);
    const book = await loadBookFromUrl('stories.example/tiny-tale.txt');
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('https://stories.example/tiny-tale.txt');
    expect(book.title).toBe('Tiny tale');
    expect(book.format).toBe('txt');
  });

  it('turns network/CORS failures into a friendly error that suggests the extension', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const err = await loadBookFromUrl('https://no-cors.example/book').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BookLoadError);
    expect(err).toMatchObject({ code: 'network' });
    expect((err as Error).message).toMatch(/download/i);
    expect((err as Error).message).toMatch(/extension/i);
  });

  it('times out slow servers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    await expect(loadBookFromUrl('https://slow.example/', { timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('lets a caller-initiated abort through untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    const controller = new AbortController();
    const pending = loadBookFromUrl('https://slow.example/', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports HTTP errors and rejects non-web URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond('nope', 'text/plain', 404)));
    await expect(loadBookFromUrl('https://gone.example/x')).rejects.toMatchObject({ code: 'http', message: expect.stringContaining('404') });
    await expect(loadBookFromUrl('javascript:alert(1)')).rejects.toMatchObject({ code: 'invalid-url' });
    await expect(loadBookFromUrl('   ')).rejects.toMatchObject({ code: 'invalid-url' });
  });

  it('treats "host:port" as an address, with http for local servers', async () => {
    const fetchMock = vi.fn(async () => respond('A local story.\n\nIt loaded.', 'text/plain'));
    vi.stubGlobal('fetch', fetchMock);
    await loadBookFromUrl('localhost:8080/books/local.txt');
    await loadBookFromUrl('reader.example:8443/story.txt');
    expect(fetchMock.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'http://localhost:8080/books/local.txt',
      'https://reader.example:8443/story.txt',
    ]);
  });

  /** A body that delivers `bytes` in `pieces` chunks, `gapMs` apart, and errors when the request is aborted. */
  function trickle(bytes: Uint8Array, pieces: number, gapMs: number, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
    const size = Math.ceil(bytes.length / pieces);
    let i = 0;
    return new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        await new Promise((r) => setTimeout(r, gapMs));
        if (signal?.aborted) return ctrl.error(new DOMException('Aborted', 'AbortError'));
        if (i >= pieces) return ctrl.close();
        ctrl.enqueue(bytes.slice(i * size, (i + 1) * size));
        i++;
      },
    });
  }

  it('keeps downloading while data flows, however long the whole file takes', async () => {
    // Regression: the timeout used to cover the whole body, so big books on slow links always failed.
    const text = 'A long download.\n\nIt arrived slowly, piece by piece.\n\nBut it did arrive.';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        new Response(trickle(new TextEncoder().encode(text), 6, 20, init.signal), { headers: { 'content-type': 'text/plain' } }),
      ),
    );
    // ≈ 140 ms in total, but never more than ~20 ms without data.
    const book = await loadBookFromUrl('https://slow.example/story.txt', { timeoutMs: 90 });
    expect(book.wordCount).toBe(countWords(text));
  });

  it('times out a download that stalls halfway', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode('The first part arrived, '));
            init.signal?.addEventListener('abort', () => ctrl.error(new DOMException('Aborted', 'AbortError')));
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/plain' } });
      }),
    );
    await expect(loadBookFromUrl('https://stall.example/book.txt', { timeoutMs: 40 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('stops a download as soon as it passes the size limit, even without Content-Length', async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024); // the same 8 MiB, sent again and again
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent >= 40) return ctrl.close(); // 320 MiB if nobody stops reading
        sent++;
        ctrl.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/plain' } })));
    await expect(loadBookFromUrl('https://huge.example/book.txt')).rejects.toMatchObject({ code: 'too-large' });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(27); // 200 MiB = 25 chunks, plus what was queued ahead
  });

  it('opens an EPUB served from a URL', async () => {
    const epub = await tinyEpub();
    vi.stubGlobal('fetch', vi.fn(async () => respond(epub, 'application/epub+zip')));
    const book = await loadBookFromUrl('https://books.example/zipped.epub');
    expect(book.format).toBe('epub');
    expect(book.source).toBe('url');
  });
});

// ─────────────────────────────── sample books ───────────────────────────────

describe('sample books', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists valid entries only and loads one as a Book', async () => {
    const index = {
      books: [
        { id: 'dewey', title: 'Dewey and the Lantern', author: 'Gaze Reader', blurb: 'A short story.', file: 'dewey.md' },
        { id: 'evil', title: 'Offsite', file: 'https://evil.example/x.md' },
        { id: 'bad id!', title: 'Bad', file: 'x.md' },
        { title: 'No id', file: 'y.md' },
      ],
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/samples/index.json')) return new Response(JSON.stringify(index));
      if (url.endsWith('/samples/dewey.md')) return new Response('# Dewey and the Lantern\n\n## One\n\nDewey pushed up his glasses.\n\n## Two\n\nHe turned the page.');
      return new Response('missing', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const mod = await import('./bookLoader');
    const list = await mod.listSampleBooks();
    expect(list).toEqual([
      { id: 'dewey', title: 'Dewey and the Lantern', author: 'Gaze Reader', blurb: 'A short story.', file: 'dewey.md' },
    ]);
    const book = await mod.loadSampleBook('dewey');
    expect(book.id).toBe('sample-dewey');
    expect(book.format).toBe('sample');
    expect(book.source).toBe('sample');
    expect(book.author).toBe('Gaze Reader');
    expect(book.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    expect(book.chapters[0].html).toContain('<h1>Dewey and the Lantern</h1>');
    await expect(mod.loadSampleBook('nope')).rejects.toMatchObject({ code: 'empty' });
  });

  it('accepts a bare array index and retries after a failure', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new TypeError('offline');
        return new Response(JSON.stringify([{ id: 's1', title: 'S', file: 's1.md' }]));
      }),
    );
    const mod = await import('./bookLoader');
    await expect(mod.listSampleBooks()).rejects.toBeInstanceOf(mod.BookLoadError);
    expect((await mod.listSampleBooks()).map((s) => s.id)).toEqual(['s1']);
  });
});

describe('long runs of spaces (regression: quadratic regexes froze the tab)', () => {
  const spaces = ' '.repeat(200_000);
  const fast = (run: () => unknown): void => {
    const start = performance.now();
    run();
    expect(performance.now() - start).toBeLessThan(1000);
  };

  it('loads a plain-text line with a huge run of spaces quickly', () => {
    fast(() => loadBookFromText('a' + spaces + 'b', { format: 'txt' }));
  });

  it('renders Markdown headings and paragraphs with huge runs of spaces quickly', () => {
    fast(() => markdownToHtml('# a' + spaces + 'b'));
    fast(() => markdownToHtml('a' + spaces + 'b'));
    fast(() => markdownToHtml('a' + spaces + 'b' + spaces + '\nc'));
  });

  it('loads an HTML book whose link has a huge run of spaces quickly', () => {
    fast(() => loadBookFromText(`<html><body><p>Some text with <a href="a${spaces}b">a link</a> in it.</p></body></html>`, { format: 'html' }));
  });

  it('keeps the ATX heading and hard-break rules unchanged', () => {
    expect(markdownToHtml('# foo ##')).toContain('<h1>foo</h1>');
    expect(markdownToHtml('## foo ## ')).toContain('<h2>foo</h2>');
    expect(markdownToHtml('# foo#')).toContain('<h1>foo#</h1>');
    expect(markdownToHtml('# foo#bar ##')).toContain('<h1>foo#bar</h1>');
    expect(markdownToHtml('# #')).toContain('<h1>#</h1>');
    expect(markdownToHtml('# ##')).toContain('<h1>##</h1>');
    expect(markdownToHtml('#')).toContain('<h1></h1>');
    expect(markdownToHtml('#\tfoo  ')).toContain('<h1>foo</h1>');
    expect(markdownToHtml('#5 bolts')).not.toContain('<h1>');
    expect(markdownToHtml('x  \ny')).toContain('<br>');
    expect(markdownToHtml('x\\\ny')).toContain('<br>');
    expect(markdownToHtml('x \ny')).not.toContain('<br>');
  });
});
