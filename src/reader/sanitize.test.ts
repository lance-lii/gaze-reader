// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeHtml, sanitizeNode, sanitizeToElement, sanitizeToFragment } from './sanitize';

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'i', 'strong', 'b', 'u', 's', 'sub', 'sup',
  'small', 'blockquote', 'q', 'cite', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre', 'code', 'span', 'div',
  'section', 'article', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'abbr',
  'time',
]);
const GLOBAL_ATTRS = new Set(['id', 'title', 'lang', 'dir']);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'rel', 'target']),
  time: new Set(['datetime']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
};

/** Asserts every element/attribute in `root` is on the allowlist and every link is safe. */
function assertSafe(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const tag = el.localName;
    expect(ALLOWED_TAGS.has(tag), `unexpected <${tag}>`).toBe(true);
    expect(el.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
    for (const attr of Array.from(el.attributes)) {
      const ok = GLOBAL_ATTRS.has(attr.name) || TAG_ATTRS[tag]?.has(attr.name);
      expect(ok, `unexpected ${tag}[${attr.name}="${attr.value}"]`).toBe(true);
      if (attr.name === 'id') expect(attr.value.startsWith('gr-src-')).toBe(true);
    }
    const href = el.getAttribute('href');
    if (href !== null) {
      if (href.startsWith('#')) {
        expect(href.startsWith('#gr-src-')).toBe(true);
        expect(el.hasAttribute('target')).toBe(false);
      } else {
        expect(['http:', 'https:']).toContain(new URL(href).protocol);
        expect(el.getAttribute('rel')).toBe('noopener noreferrer');
        expect(el.getAttribute('target')).toBe('_blank');
      }
    }
  }
}

function reparse(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
}

function checkString(input: string): string {
  const out = sanitizeHtml(input);
  assertSafe(reparse(out));
  // Rendering the output with innerHTML (what a naive consumer would do) must also be safe.
  const live = document.createElement('div');
  live.innerHTML = out;
  assertSafe(live);
  expect(sanitizeHtml(out), 'sanitize must be idempotent').toBe(out);
  return out;
}

const XSS_VECTORS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<math href="javascript:alert(1)">CLICKME</math>',
  '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
  '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  '<svg><style><img src=x onerror=alert(1)></style></svg>',
  '<math><style><img src=x onerror=alert(1)></style></math>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<noscript><style></noscript><img src=x onerror=alert(1)></style></noscript>',
  '<template><template><img src=x onerror=alert(1)></template></template>',
  '<template><script>alert(1)</script></template><p>after</p>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="java\nscript:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="java&#10;script:alert(1)">x</a>',
  '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
  '<a href="&#x6A;avascript:alert(1)">x</a>',
  '<a href="&#0000106avascript:alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="\u0001javascript:alert(1)">x</a>',
  '<a href="\u0000javascript:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="DATA:text/html,<script>alert(1)</script>">x</a>',
  '<a href=" &#x20;data:text/html,x">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="file:///etc/passwd">x</a>',
  '<a href="//evil.example/x">protocol-relative without a base</a>',
  '<p style="background:url(javascript:alert(1))">x</p>',
  '<div style="behavior:url(x.htc)">x</div>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<form action="javascript:alert(1)"><button>go</button></form>',
  '<button formaction="javascript:alert(1)">x</button>',
  '<input autofocus onfocus=alert(1)>',
  '<details open ontoggle=alert(1)>x</details>',
  '<body onload=alert(1)><p>x</p>',
  '<base href="javascript:alert(1)//"><a href="/x">rel</a>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel=stylesheet href="javascript:alert(1)">',
  '<style>@import "javascript:alert(1)";</style>',
  '<xmp><img src=x onerror=alert(1)></xmp>',
  '<textarea><img src=x onerror=alert(1)></textarea>',
  '<title><img src=x onerror=alert(1)></title>',
  '<noembed><img src=x onerror=alert(1)></noembed>',
  '<noframes><img src=x onerror=alert(1)></noframes>',
  '<plaintext><img src=x onerror=alert(1)>',
  '<listing><img src=x onerror=alert(1)></listing>',
  '<a href="https://ok.example" onclick="alert(1)" target="_self" ping="https://track.example">ok</a>',
  '<a href="https://ok.example/?q=&quot;onmouseover=alert(1)">x</a>',
  '<a xlink:href="javascript:alert(1)">x</a>',
  '<isindex action="javascript:alert(1)" type=image>',
  '<image src=x onerror=alert(1)>',
  '<video><source onerror="alert(1)"></video>',
  '<audio src=x onerror=alert(1)>',
  '<marquee onstart=alert(1)>x</marquee>',
  '<div><!--<img src=x onerror=alert(1)>--></div>',
  '<?xml-stylesheet href="javascript:alert(1)"?><p>x</p>',
  '<![CDATA[<img src=x onerror=alert(1)>]]>',
  '<a href="#" onmouseover="alert(1)">x</a>',
  '<select><option><img src=x onerror=alert(1)></option></select>',
  '<keygen autofocus onfocus=alert(1)>',
  '<frameset onload=alert(1)>',
  '<portal src="javascript:alert(1)"></portal>',
  '<span data-bind="x" class="gr-reader" is="evil-el">x</span>',
  '<p id="location">clobber</p><img name="getElementById"><form name="cookie"></form>',
  '<a id="__proto__" name="constructor">x</a>',
  '<table><td background="javascript:alert(1)">x</td></table>',
  '<table><caption onclick=alert(1)>Cap</caption><tr><td>x</td></tr></table>',
  '<ol start="1;alert(1)" type="javascript:"><li value="x">a</li></ol>',
  '<time datetime="2020" onmouseover=alert(1)>t</time>',
  '<div dir="rtl" lang="en-GB" xml:lang="fr">x</div><div dir="evil" lang="$(x)">y</div>',
  '<custom-element onclick=alert(1)><shadow-thing>deep <b>text</b></shadow-thing></custom-element>',
  '<p>a<p>b<div>c</div>',
  '<a href="https://a.example"><a href="https://b.example">nested</a></a>',
];

describe('sanitizeHtml — XSS battery', () => {
  it.each(XSS_VECTORS.map((v) => [v]))('neutralizes %s', (vector) => {
    const out = checkString(vector);
    expect(out).not.toMatch(/<(script|style|img|svg|math|iframe|object|embed|form|input|button|textarea|noscript|template|base|meta|link)\b/i);
    expect(out).not.toMatch(/\son\w+=/i);
    expect(out).not.toMatch(/javascript:|vbscript:|data:/i);
  });

  it('drops the content of executable and raw-text elements entirely', () => {
    const out = sanitizeHtml('<p>keep</p><script>SECRET1</script><style>SECRET2</style><template>SECRET3</template>' +
      '<noscript>SECRET4</noscript><textarea>SECRET5</textarea><svg><text>SECRET6</text></svg><math><mi>SECRET7</mi></math>' +
      '<select><option>SECRET8</option></select><button>SECRET9</button><iframe>SECRET10</iframe>');
    expect(out).toBe('<p>keep</p>');
  });

  it('keeps the text of harmless unknown containers', () => {
    expect(sanitizeHtml('<custom-el>Hello <b>World</b></custom-el>')).toBe('Hello <b>World</b>');
    expect(sanitizeHtml('<font color=red>red</font> <blink>blink</blink>')).toBe('<span>red</span> blink');
  });

  it('maps semantic containers to allowlisted equivalents', () => {
    expect(sanitizeHtml('<main><header><h1>T</h1></header><aside>note</aside></main>')).toBe('<div><div><h1>T</h1></div><div>note</div></div>');
    expect(sanitizeHtml('<p><kbd>Ctrl</kbd> <del>old</del> <ins>new</ins> <mark>hi</mark></p>')).toBe(
      '<p><code>Ctrl</code> <s>old</s> <u>new</u> <span>hi</span></p>',
    );
    expect(sanitizeHtml('<acronym title="As Soon As Possible">ASAP</acronym>')).toBe('<abbr title="As Soon As Possible">ASAP</abbr>');
  });

  it('escapes text so it can never become markup', () => {
    expect(sanitizeHtml('<p>1 &lt; 2 &amp;&amp; &lt;script&gt;</p>')).toBe('<p>1 &lt; 2 &amp;&amp; &lt;script&gt;</p>');
    expect(sanitizeHtml('plain < text > & more')).toBe('plain &lt; text &gt; &amp; more');
  });

  it('returns an empty string for empty, whitespace-only or frameset documents', () => {
    expect(sanitizeHtml('')).toBe('');
    expect(sanitizeHtml('<script>x</script>  \n ')).toBe('');
    expect(sanitizeHtml('<frameset><frame src="x"></frameset>')).toBe('');
  });

  it('drops leading whitespace (it would not survive a re-parse) but keeps a leading nbsp', () => {
    expect(sanitizeHtml('<svg></svg>  <b>x</b>')).toBe('<b>x</b>');
    expect(sanitizeHtml('<svg></svg>\u00a0x')).toBe('&nbsp;x');
  });
});

describe('sanitizeHtml — links', () => {
  it('keeps http(s) links, forcing a safe rel and a new tab', () => {
    expect(sanitizeHtml('<a href="https://example.com/a?b=1#c" target="_top" rel="opener">x</a>')).toBe(
      '<a href="https://example.com/a?b=1#c" rel="noopener noreferrer" target="_blank">x</a>',
    );
  });

  it('rewrites in-document fragments to prefixed ids (without target)', () => {
    expect(sanitizeHtml('<a href="#note 1">1</a><p id="note 1">n</p>')).toBe(
      '<a href="#gr-src-note_1">1</a><p id="gr-src-note_1">n</p>',
    );
    expect(sanitizeHtml('<a href="#caf%C3%A9">x</a>')).toBe('<a href="#gr-src-café">x</a>');
    expect(sanitizeHtml('<a href="#">top</a>')).toBe('<a>top</a>');
  });

  it('drops relative links without a base and resolves them with one', () => {
    expect(sanitizeHtml('<a href="chapter2.html">next</a>')).toBe('<a>next</a>');
    expect(sanitizeHtml('<a href="chapter2.html">next</a>', { baseUrl: 'https://books.example/b/ch1.html' })).toBe(
      '<a href="https://books.example/b/chapter2.html" rel="noopener noreferrer" target="_blank">next</a>',
    );
    expect(sanitizeHtml('<a href="//cdn.example/x">x</a>', { baseUrl: 'https://books.example/' })).toContain(
      'href="https://cdn.example/x"',
    );
  });

  it('turns links back into the same page into in-book fragments', () => {
    const out = sanitizeHtml('<a href="https://books.example/b/ch1.html#fn3">3</a>', { baseUrl: 'https://books.example/b/ch1.html' });
    expect(out).toBe('<a href="#gr-src-fn3">3</a>');
  });

  it('ignores a non-http base URL', () => {
    expect(sanitizeHtml('<a href="x.html">x</a>', { baseUrl: 'javascript:alert(1)//' })).toBe('<a>x</a>');
  });

  it('validates whatever a rewriteHref hook returns', () => {
    const evil = sanitizeHtml('<a href="notes.xhtml">x</a>', { rewriteHref: () => 'javascript:alert(1)' });
    expect(evil).toBe('<a>x</a>');
    const mapped = sanitizeHtml('<a href="notes.xhtml#n2">x</a>', { rewriteHref: (h) => `#gr-src-s4-${h.split('#')[1]}` });
    expect(mapped).toBe('<a href="#gr-src-s4-n2">x</a>');
    const dropped = sanitizeHtml('<a href="img.png">x</a>', { rewriteHref: () => null });
    expect(dropped).toBe('<a>x</a>');
  });

  it('unwraps nested links, keeping their text', () => {
    const root = sanitizeToElement('<p><a href="https://a.example">outer <a href="https://b.example">inner</a></a></p>');
    expect(root.querySelectorAll('a a')).toHaveLength(0);
    expect(root.textContent).toContain('inner');
  });
});

describe('sanitizeHtml — attributes and structure', () => {
  it('prefixes and cleans ids, and turns <a name> into an id', () => {
    expect(sanitizeHtml('<p id=" intro.1 ">x</p>')).toBe('<p id="gr-src-intro_1">x</p>');
    expect(sanitizeHtml('<a name="ch1"></a>')).toBe('<a id="gr-src-ch1"></a>');
    expect(sanitizeHtml('<p id="gr-src-kept">x</p>')).toBe('<p id="gr-src-kept">x</p>');
    expect(sanitizeHtml('<p id="x">y</p>', { idPrefix: 'gr-src-s2-' })).toBe('<p id="gr-src-s2-x">y</p>');
    expect(sanitizeHtml('<p id="x">y</p>', { idPrefix: '"><script>' })).toBe('<p id="gr-src-x">y</p>');
  });

  it('validates the few attributes it keeps', () => {
    expect(sanitizeHtml('<ol start="3" reversed type="i"><li value="7">a</li></ol>')).toBe(
      '<ol start="3" reversed="" type="i"><li value="7">a</li></ol>',
    );
    expect(sanitizeHtml('<ol start="3x" type="disc"><li value="x">a</li></ol>')).toBe('<ol><li>a</li></ol>');
    expect(sanitizeHtml('<table><tr><th scope="col" colspan="2">h</th><td rowspan="x" colspan="99999">d</td></tr></table>')).toBe(
      '<table><tbody><tr><th colspan="2" scope="col">h</th><td>d</td></tr></tbody></table>',
    );
    expect(sanitizeHtml('<time datetime="2024-01-02">Jan 2</time>')).toBe('<time datetime="2024-01-02">Jan 2</time>');
    expect(sanitizeHtml('<p lang="en-GB" dir="RTL" title=" t ">x</p>')).toBe('<p title="t" lang="en-GB" dir="rtl">x</p>');
    // Canonical attribute order, whatever the source order (keeps sanitizing idempotent).
    expect(sanitizeHtml('<bdi id="a">x</bdi>')).toBe(sanitizeHtml('<span dir="auto" id="a">x</span>'));
    expect(sanitizeHtml('<p xml:lang="fr" lang="en">x</p>')).toBe('<p lang="en">x</p>');
  });

  it('turns a paragraph that contains blocks into a div (so re-parsing cannot split it)', () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>a<div>b</div></p></body></html>',
      'application/xhtml+xml',
    );
    const out = sanitizeNode(doc.getElementsByTagName('body')[0]);
    expect(out).toBe('<div>a<div>b</div></div>');
    expect(sanitizeHtml(out)).toBe(out);
  });

  it('moves a table caption in front of its table and keeps table structure valid', () => {
    expect(sanitizeHtml('<table><caption>Cap</caption><tr><td>x</td></tr></table>')).toBe(
      '<div>Cap</div><table><tbody><tr><td>x</td></tr></tbody></table>',
    );
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><tr><td>loose</td></tr></body></html>',
      'application/xhtml+xml',
    );
    expect(sanitizeNode(doc.getElementsByTagName('body')[0])).toBe('<div><div>loose</div></div>');
  });

  it('prunes elements left empty, but keeps link targets and line breaks', () => {
    expect(sanitizeHtml('<p><img src=x></p><p>&nbsp;</p><span></span><p>x</p>')).toBe('<p>x</p>');
    expect(sanitizeHtml('<p id="t"></p><p><br></p>')).toBe('<p id="gr-src-t"></p><p><br></p>');
  });

  it('flattens pathological nesting without overflowing the stack', () => {
    // Built bottom-up (jsdom's own parser recurses per level; browsers cap parser depth anyway).
    let node: Element = document.createElement('span');
    node.textContent = 'deep';
    for (let i = 0; i < 20000; i++) {
      const parent = document.createElement(i % 2 ? 'span' : 'div');
      parent.appendChild(node);
      node = parent;
    }
    const holder = document.createElement('div');
    holder.appendChild(node);
    const root = sanitizeToElement(holder);
    expect(root.textContent).toBe('deep');
    let max = 0;
    for (const el of Array.from(root.querySelectorAll('*'))) {
      let d = 0;
      for (let p: Element | null = el; p && p !== root; p = p.parentElement) d++;
      max = Math.max(max, d);
    }
    expect(max).toBeLessThanOrEqual(64);
  });

  it('stays linear on hostile paragraph nesting', () => {
    // Regression: every <p> rescanned its whole subtree for block descendants, before the
    // depth cap applied, so 12 000 nested paragraphs took many seconds (quadratic).
    let node: Element = document.createElement('p');
    node.textContent = 'innermost';
    for (let i = 0; i < 12_000; i++) {
      const parent = document.createElement('p');
      parent.appendChild(document.createTextNode('x')); // (jsdom's append(a, b) is itself quadratic here)
      parent.appendChild(node);
      node = parent;
    }
    const holder = document.createElement('div');
    holder.appendChild(node);
    const started = performance.now();
    const root = sanitizeToElement(holder);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(root.textContent).toBe(`${'x'.repeat(12_000)}innermost`);
    // Paragraphs that (still) contain paragraphs became divs; only leaf paragraphs remain <p>.
    for (const p of Array.from(root.querySelectorAll('p'))) expect(p.querySelector('p, div')).toBeNull();
    expect(sanitizeHtml(root.innerHTML)).toBe(root.innerHTML);
  });

  it('keeps a paragraph a paragraph when its only block content is dropped', () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>a<script><div>b</div></script>c</p></body></html>',
      'application/xhtml+xml',
    );
    expect(sanitizeNode(doc.getElementsByTagName('body')[0])).toBe('<p>ac</p>');
  });
});

describe('sanitizeNode — XHTML (EPUB) documents', () => {
  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<?xml-stylesheet href="style.css"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="fr">
<head><title>T</title><style>p{}</style></head>
<body onload="alert(1)">
  <!-- a comment -->
  <h1 id="c1" epub:type="title">Chapitre</h1>
  <p xml:lang="en">A <![CDATA[<b>cdata</b>]]> tail<a epub:type="noteref" href="#n1">1</a></p>
  <epub:switch><epub:case required-namespace="http://www.w3.org/1998/Math/MathML"><m:math xmlns:m="http://www.w3.org/1998/Math/MathML"><m:mi>x</m:mi></m:math></epub:case><epub:default>x squared</epub:default></epub:switch>
  <svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>
</body></html>`;

  it('keeps the text, drops everything unsafe, and maps xml:lang', () => {
    const doc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
    const out = sanitizeNode(doc.getElementsByTagName('body')[0]);
    const root = reparse(out);
    assertSafe(root);
    expect(root.querySelector('h1')?.id).toBe('gr-src-c1');
    expect(root.querySelector('p')?.getAttribute('lang')).toBe('en');
    expect(root.textContent).toContain('<b>cdata</b>'); // CDATA stays text
    expect(root.textContent).toContain('x squared');
    expect(root.textContent).not.toContain('alert');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('#gr-src-n1');
    expect(out).not.toContain('a comment');
  });
});

describe('sanitizeNode — other XML vocabularies', () => {
  it('maps DTBook (EPUB 2) paragraphs and headings, but never SVG/MathML-namespaced look-alikes', () => {
    const doc = new DOMParser().parseFromString(
      `<dtbook xmlns="http://www.daisy.org/z3986/2005/dtbook/"><book><bodymatter><level1>
        <h1>Title</h1><p>One <em>two</em></p><p>Three</p>
        <s:a xmlns:s="http://www.w3.org/2000/svg" href="javascript:alert(1)">svg link</s:a>
        <m:p xmlns:m="http://www.w3.org/1998/Math/MathML">math p</m:p>
        <x:script xmlns:x="urn:x">alert(1)</x:script>
      </level1></bodymatter></book></dtbook>`,
      'application/xml',
    );
    const out = sanitizeNode(doc.getElementsByTagName('book')[0]);
    const root = reparse(out);
    assertSafe(root);
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(Array.from(root.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['One two', 'Three']);
    expect(root.querySelector('em')?.textContent).toBe('two');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('svg link');
    expect(root.textContent).toContain('math p');
    expect(root.textContent).not.toContain('alert');
  });
});

describe('sanitizeToFragment', () => {
  it('builds nodes owned by the target document, with the same guarantees', () => {
    const frag = sanitizeToFragment('<p onclick="x()">Hi <img src=x onerror=alert(1)><a href="javascript:x">l</a></p>', document);
    const holder = document.createElement('div');
    holder.appendChild(frag);
    expect(holder.innerHTML).toBe('<p>Hi <a>l</a></p>');
    expect(holder.firstElementChild?.ownerDocument).toBe(document);
    assertSafe(holder);
  });

  it('matches sanitizeHtml output', () => {
    for (const vector of XSS_VECTORS) {
      const holder = document.createElement('div');
      holder.appendChild(sanitizeToFragment(vector, document));
      expect(holder.innerHTML).toBe(sanitizeHtml(vector));
    }
  });
});

describe('sanitizeHtml — seeded fuzz', () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Includes the parser's "special" elements (marquee, details, center, …): they are what can
  // make a parser nest li/h*/p in ways a second parse would undo.
  const TAGS = [
    'p', 'div', 'span', 'a', 'b', 'em', 'i', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup',
    'ul', 'li', 'ol', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'script', 'style', 'svg', 'math', 'noscript',
    'template', 'img', 'iframe', 'form', 'select', 'option', 'textarea', 'xmp', 'title', 'mtext', 'mglyph', 'foreignObject',
    'desc', 'custom-x', 'details', 'summary', 'font', 'object', 'marquee', 'center', 'nobr', 'button', 'applet', 'menu',
    'hr', 'br', 'main', 'nav', 'ruby', 'rt', 'bdi', 'bdo', 'figure', 'figcaption', 'address', 'fieldset', 'legend',
    'listing', 'plaintext', 'image', 'isindex', 'keygen', 'wbr', 'ins', 'del',
  ];
  const ATTRS = [
    'onclick="alert(1)"', 'onerror=alert(1)', 'href="javascript:alert(1)"', 'href="https://ok.example"', 'href="#frag"',
    'href="  JAVA&#x0A;SCRIPT:alert(1)"', 'src="x"', 'style="x:expression(alert(1))"', 'id="a b"', 'title="</p><img src=x onerror=alert(1)>"',
    'xlink:href="javascript:alert(1)"', 'name="x"', 'colspan="2"', 'lang="en"', 'data-x="1"', 'srcdoc="<script>alert(1)</script>"',
  ];
  const TEXT = ['hello', '<', '>', '&amp;', '&lt;script&gt;', '"', "'", '</', '-->', '<!--', ']]>', 'alert(1)', ' '];

  it('keeps every invariant over 800 random documents', { timeout: 120_000 }, () => {
    const rand = mulberry32(1234);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const gen = (depth: number): string => {
      let s = '';
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        if (depth > 4 || rand() < 0.3) {
          s += pick(TEXT);
          continue;
        }
        const tag = pick(TAGS);
        const attrs = rand() < 0.6 ? ` ${pick(ATTRS)}` : '';
        s += `<${tag}${attrs}>${gen(depth + 1)}${rand() < 0.85 ? `</${tag}>` : ''}`;
      }
      return s;
    };
    for (let i = 0; i < 800; i++) checkString(gen(0));
  });
});

describe('href compaction', () => {
  it('handles a huge run of spaces in an href quickly (regression: quadratic trim)', () => {
    const start = performance.now();
    sanitizeHtml(`<a href="a${' '.repeat(200_000)}b">x</a>`);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('still trims control characters and spaces around a URL', () => {
    const ctl = String.fromCharCode(1);
    expect(sanitizeHtml(`<a href="${ctl}  https://example.com/a  ${ctl}">x</a>`)).toContain('href="https://example.com/a"');
  });
});
