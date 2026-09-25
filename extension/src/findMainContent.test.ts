// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { collapsedLength, findMainContent } from './findMainContent';
import { edgeObstructions, findScroller, readingViewport } from './pageGeometry';

const para = (n: number, seed = 'Reading') =>
  `<p>${seed} is a sequence of fixations and saccades; the eyes rest for about a quarter of a second, then jump seven or eight letters ahead. Paragraph ${n} goes on a little longer so it looks like real prose.</p>`;
const paras = (count: number, seed?: string) => Array.from({ length: count }, (_, i) => para(i, seed)).join('\n');
const links = (count: number, label = 'Link') =>
  `<ul>${Array.from({ length: count }, (_, i) => `<li><a href="/x${i}">${label} number ${i} somewhere</a></li>`).join('')}</ul>`;

function page(html: string): Document {
  document.documentElement.innerHTML = `<head><title>t</title></head><body>${html}</body>`;
  return document;
}

afterEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('findMainContent', () => {
  it('picks the article over navigation, sidebars, comments and footer', () => {
    const doc = page(`
      <header class="site-header"><nav>${links(12, 'Section')}</nav></header>
      <div class="layout has-sidebar">
        <aside class="sidebar">
          <h3>Popular</h3>${links(15, 'Popular story')}
          <p>Subscribe to our newsletter for a weekly digest of the most popular stories on this site.</p>
        </aside>
        <article id="story">
          <h1>How eyes read</h1>
          <div class="byline">By A. Writer</div>
          ${paras(8)}
        </article>
        <section id="comments">${paras(4, 'A commenter says reading')}</section>
      </div>
      <footer>${links(10, 'Footer')}<p>Copyright notice and a long list of legal words that nobody reads at all.</p></footer>
    `);
    expect(findMainContent(doc).id).toBe('story');
  });

  it('prefers the article body wrapper over a generic layout wrapper even without semantic tags', () => {
    const doc = page(`
      <div id="page">
        <div id="menu" class="menu">${links(20)}</div>
        <div id="main-col"><div id="post" class="post-content">${paras(6)}</div></div>
        <div id="rail" class="right-rail">${links(10, 'Related')}<p>${'Ad copy that is quite long. '.repeat(4)}</p></div>
      </div>
    `);
    const found = findMainContent(doc);
    expect(['post', 'main-col']).toContain(found.id);
    expect(found.contains(doc.getElementById('rail'))).toBe(false);
    expect(found.contains(doc.getElementById('menu'))).toBe(false);
  });

  it('collects content split across sibling sections into their common wrapper', () => {
    const doc = page(`
      <nav>${links(8)}</nav>
      <div id="wrapper">
        <section class="part">${paras(3)}</section>
        <div class="ad-slot"><a href="/ad">Buy things</a></div>
        <section class="part">${paras(3)}</section>
        <section class="part">${paras(3)}</section>
      </div>
    `);
    expect(findMainContent(doc).id).toBe('wrapper');
  });

  it('handles text written as <br>-separated lines in a div', () => {
    const line = 'An old-style page puts its prose straight into a div, separated by line breaks.';
    const doc = page(`
      <div class="nav">${links(6)}</div>
      <div id="text">${Array.from({ length: 12 }, () => line).join('<br><br>')}</div>
    `);
    expect(findMainContent(doc).id).toBe('text');
  });

  it('does not count nested blocks twice (blockquote > p)', () => {
    // The nav makes <body> pay for its links, so the choice is between #a (3
    // paragraphs) and #b (2 paragraphs, or "4" if the blockquote were counted too).
    const doc = page(`
      <nav>${links(40)}</nav>
      <div id="a">${paras(3)}</div>
      <div id="b"><blockquote>${paras(2)}</blockquote></div>
    `);
    expect(findMainContent(doc).id).toBe('a');
  });

  it('ignores hidden subtrees, scripts and our own UI', () => {
    const doc = page(`
      <div id="real">${paras(3)}</div>
      <div hidden>${paras(10)}</div>
      <div data-gr-ignore>${paras(10)}</div>
      <script>${'var x = "lots of script text";'.repeat(200)}</script>
    `);
    expect(findMainContent(doc).id).toBe('real');
  });

  it('returns <body> when a page has no real reading text', () => {
    const doc = page(`<nav>${links(30)}</nav><div><button>Click</button> <span>Short</span></div>`);
    expect(findMainContent(doc)).toBe(doc.body);
    const empty = page('');
    expect(findMainContent(empty)).toBe(empty.body);
  });

  it('skips a candidate hidden by CSS', () => {
    const doc = page(`
      <div id="hidden-copy" style="display:none"><div>${paras(10)}</div></div>
      <div id="visible">${paras(4)}</div>
    `);
    const found = findMainContent(doc);
    expect(found.closest('#hidden-copy')).toBeNull();
    expect(found.id).toBe('visible');
  });
});

describe('collapsedLength', () => {
  it('counts characters as rendered after whitespace collapsing', () => {
    expect(collapsedLength('')).toBe(0);
    expect(collapsedLength('   ')).toBe(0);
    expect(collapsedLength('a')).toBe(1);
    expect(collapsedLength('  a \n\t b  ')).toBe(3);
    expect(collapsedLength('word word')).toBe(9);
  });
});

function fakeScrollBox(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

describe('findScroller', () => {
  it('is the window for a normal document', () => {
    const doc = page(`<main id="m">${paras(3)}</main>`);
    expect(findScroller(doc.getElementById('m')!)).toBe(window);
  });

  it('finds a scrollable ancestor in an app-like layout', () => {
    const doc = page(`<div id="app" style="overflow-y: auto; height: 100vh"><article id="a">${paras(3)}</article></div>`);
    const app = doc.getElementById('app')!;
    fakeScrollBox(app, 5000, 800);
    expect(findScroller(doc.getElementById('a')!)).toBe(app);
  });

  it('ignores overflow containers that do not actually overflow', () => {
    const doc = page(`<div id="box" style="overflow: auto"><article id="a">${paras(1)}</article></div>`);
    fakeScrollBox(doc.getElementById('box')!, 300, 300);
    expect(findScroller(doc.getElementById('a')!)).toBe(window);
  });

  it('does not treat <body> as the scroller while its overflow propagates to the viewport', () => {
    const doc = page(`<article id="a">${paras(3)}</article>`);
    doc.body.style.overflowY = 'auto';
    fakeScrollBox(doc.body, 5000, 800);
    expect(findScroller(doc.getElementById('a')!)).toBe(window);
    doc.documentElement.style.overflowY = 'hidden';
    expect(findScroller(doc.getElementById('a')!)).toBe(doc.body);
    doc.documentElement.style.overflowY = '';
  });
});

describe('reading viewport', () => {
  it('is the window area when nothing covers it', () => {
    const vp = readingViewport(window)!;
    expect(vp.top).toBe(0);
    expect(vp.bottom).toBe(window.innerHeight);
    expect(vp.right).toBeGreaterThan(0);
  });

  it('clips to a scroll container and returns null for a collapsed one', () => {
    const doc = page(`<div id="box"></div>`);
    const box = doc.getElementById('box')!;
    box.getBoundingClientRect = () => new DOMRect(100, 50, 600, 400);
    Object.defineProperty(box, 'clientWidth', { configurable: true, value: 585 });
    fakeScrollBox(box, 2000, 400);
    expect(readingViewport(box)).toEqual({ left: 100, top: 50, right: 685, bottom: 450 });
    fakeScrollBox(box, 2000, 0);
    expect(readingViewport(box)).toBeNull();
  });

  it('moves the top edge below a sticky site header but ignores ordinary content at the edge', () => {
    const doc = page(`<header id="bar" style="position: fixed; top: 0; left: 0; right: 0">Site</header><p id="text">x</p>`);
    const bar = doc.getElementById('bar')!;
    const text = doc.getElementById('text')!;
    bar.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 64);
    const rect = { left: 0, top: 0, right: 1000, bottom: 800 };
    doc.elementsFromPoint = (_x: number, y: number) => (y < 64 ? [bar, doc.body] : [text, doc.body]);
    expect(edgeObstructions(doc, rect)).toEqual({ top: 64, bottom: 800 });

    bar.style.position = 'static';
    expect(edgeObstructions(doc, rect)).toEqual({ top: 0, bottom: 800 });
  });

  it('ignores narrow floating widgets and oversized overlays', () => {
    const doc = page(`<div id="chat" style="position: fixed"></div><div id="wall" style="position: fixed"></div>`);
    const chat = doc.getElementById('chat')!;
    const wall = doc.getElementById('wall')!;
    const rect = { left: 0, top: 0, right: 1000, bottom: 800 };
    chat.getBoundingClientRect = () => new DOMRect(900, 700, 80, 100);
    doc.elementsFromPoint = (x: number, y: number) => (x > 850 && y > 700 ? [chat] : [doc.body]);
    expect(edgeObstructions(doc, rect)).toEqual({ top: 0, bottom: 800 });

    wall.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800); // cookie wall covering everything
    doc.elementsFromPoint = () => [wall];
    expect(edgeObstructions(doc, rect)).toEqual({ top: 0, bottom: 800 });
  });
});
