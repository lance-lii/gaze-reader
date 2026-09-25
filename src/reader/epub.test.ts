// @vitest-environment jsdom
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseEpub, resolveZipPath } from './epub';

type Files = Record<string, string>;

async function buildEpub(files: Files, opts: { mimetype?: boolean } = {}): Promise<ArrayBuffer> {
  const zip = new JSZip();
  if (opts.mimetype !== false) zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'arraybuffer' });
}

const container = (opfPath: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const xhtml = (body: string, attrs = ''): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"${attrs}>
<head><title>t</title><link rel="stylesheet" href="../Styles/s.css"/></head>
<body>${body}</body></html>`;

function epub3(): Files {
  return {
    'META-INF/container.xml': container('OEBPS/content.opf'),
    'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:1234</dc:identifier>
    <dc:title id="sub">A Subtitle Nobody Wants</dc:title>
    <meta refines="#sub" property="title-type">subtitle</meta>
    <dc:title id="main">The Main Title</dc:title>
    <meta refines="#main" property="title-type">main</meta>
    <dc:creator id="c1">Ada Byron</dc:creator>
    <meta refines="#c1" property="role" scheme="marc:relators">aut</meta>
    <dc:creator id="c2">Ed Itor</dc:creator>
    <meta refines="#c2" property="role" scheme="marc:relators">edt</meta>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="Text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="remote" href="https://cdn.example/remote.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="Styles/s.css" media-type="text/css"/>
    <item id="img" href="Images/pic.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="nav"/>
    <itemref idref="cover"/>
    <itemref idref="ch1"/>
    <itemref idref="notes" linear="no"/>
    <itemref idref="ch2"/>
    <itemref idref="remote"/>
    <itemref idref="css"/>
  </spine>
</package>`,
    'OEBPS/Text/nav.xhtml': xhtml(
      '<nav epub:type="toc"><ol><li><a href="chapter%201.xhtml">Nav One</a></li><li><a href="ch2.xhtml">Nav Two</a></li></ol></nav>',
    ),
    'OEBPS/Text/cover.xhtml': xhtml('<div><img src="../Images/pic.png" alt="Cover"/></div>'),
    // Uses an HTML entity (&nbsp;) and a self-closing <title/>: not well-formed XML → lenient fallback.
    'OEBPS/Text/chapter 1.xhtml': `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title/><script>alert(1)</script></head>
<body>
  <h1 class="chapter">Chapter&nbsp;One</h1>
  <p class="first">It began, as these things do, with a lamp&nbsp;and a book.</p>
  <p>See <a href="ch2.xhtml#sec">the next part</a>, <a href="ch2.xhtml">the next chapter</a>,
     <a href="notes.xhtml#n1">a note</a>, <a href="../Images/pic.png">the picture</a>
     and <a href="https://example.com/more">the web</a>.<img src="../Images/pic.png"/></p>
  <script>alert(2)</script>
</body></html>`,
    'OEBPS/Text/notes.xhtml': xhtml('<aside id="n1"><p>A note that is not part of the reading order.</p></aside>'),
    'OEBPS/Text/ch2.xhtml': xhtml(
      '<section id="sec"><h2>Chapter Two</h2><p onclick="steal()">Le deuxième chapitre commence ici.</p></section>',
      ' xml:lang="fr"',
    ),
    'OEBPS/Styles/s.css': 'p { color: red }',
  };
}

describe('parseEpub — EPUB 3', () => {
  it('reads metadata, follows the linear spine and skips nav, cover-only and non-linear documents', async () => {
    const book = await parseEpub(await buildEpub(epub3()));
    expect(book.title).toBe('The Main Title');
    expect(book.author).toBe('Ada Byron');
    expect(book.format).toBe('epub');
    expect(book.chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
    expect(book.wordCount).toBeGreaterThan(20);
    const all = book.chapters.map((c) => c.html).join('\n');
    expect(all).not.toContain('not part of the reading order');
    expect(all).not.toContain('Nav One');
  });

  it('sanitizes chapters and keeps the text of a not-well-formed XHTML file', async () => {
    const [ch1] = (await parseEpub(await buildEpub(epub3()))).chapters;
    expect(ch1.html).not.toMatch(/script|alert|<img|onclick|class=/);
    expect(ch1.html).toContain('with a lamp&nbsp;and a book.');
    expect(ch1.html).toContain('<div lang="en">');
  });

  it('rewrites cross-chapter links into in-book fragments and drops links to resources', async () => {
    const [ch1, ch2] = (await parseEpub(await buildEpub(epub3()))).chapters;
    const holder = document.createElement('div');
    holder.innerHTML = ch1.html;
    const hrefs = Array.from(holder.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    // Spine positions after filtering: cover = 0, chapter 1 = 1, chapter 2 = 2.
    expect(holder.querySelector('a')?.id).toBe('gr-src-s1-top'); // this chapter's own start anchor
    expect(hrefs).toEqual([null, '#gr-src-s2-sec', '#gr-src-s2-top', null, null, 'https://example.com/more']);
    expect(ch2.html).toContain('<a id="gr-src-s2-top"></a>');
    expect(ch2.html).toContain('<section id="gr-src-s2-sec">');
    expect(ch2.html).toContain('<div lang="fr">');
    expect(ch2.html).not.toContain('onclick');
  });

  it('keeps links to ids on <body> and <html> working', async () => {
    // Regression: the sanitizer keeps only the body's children, so "ch2.xhtml#chapter-two" pointed nowhere.
    const files = epub3();
    files['OEBPS/Text/chapter 1.xhtml'] = xhtml('<h1>One</h1><p>Go to <a href="ch2.xhtml#chapter-two">chapter two</a> or <a href="ch2.xhtml#doc">its document</a>.</p>');
    files['OEBPS/Text/ch2.xhtml'] = xhtml('<h2>Two</h2><p>Arrived.</p>', ' id="doc"').replace('<body>', '<body id="chapter-two">');
    const [ch1, ch2] = (await parseEpub(await buildEpub(files))).chapters;
    const holder = document.createElement('div');
    holder.innerHTML = ch1.html + ch2.html;
    const targets = Array.from(holder.querySelectorAll('a[href^="#"]')).map((a) => a.getAttribute('href')?.slice(1) ?? '');
    expect(targets).toEqual(['gr-src-s2-chapter-two', 'gr-src-s2-doc']);
    for (const id of targets) expect(holder.querySelector(`[id="${id}"]`)).not.toBeNull();
  });

  it('produces a stable id', async () => {
    const data = await buildEpub(epub3());
    expect((await parseEpub(data)).id).toBe((await parseEpub(data)).id);
  });
});

describe('parseEpub — EPUB 2', () => {
  function epub2(): Files {
    return {
      'META-INF/container.xml': container('content.opf'),
      'content.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>OLD STYLE BOOK</dc:title>
    <dc:creator opf:role="aut">Mary Shelley</dc:creator>
    <dc:creator opf:role="ill">An Illustrator</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="a" href="a.html" media-type="application/xhtml+xml"/>
    <item id="b" href="Text/CH-B.XHTML" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="a"/><itemref idref="b"/></spine>
</package>`,
      'toc.ncx': `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="p1" playOrder="1"><navLabel><text>First Light</text></navLabel><content src="a.html"/></navPoint>
  <navPoint id="p2" playOrder="2"><navLabel><text>Second Wind</text></navLabel><content src="Text/CH-B.XHTML#start"/></navPoint>
</navMap></ncx>`,
      'a.html': xhtml('<p class="chapter-title">First Light</p><p>Some opening words of the story.</p>'),
      // Stored with different case than the manifest says.
      'text/ch-b.xhtml': xhtml('<p>And some closing words of the story.</p>'),
    };
  }

  it('uses NCX labels when chapters have no headings, and matches paths case-insensitively', async () => {
    const book = await parseEpub(await buildEpub(epub2()));
    expect(book.title).toBe('Old Style Book');
    expect(book.author).toBe('Mary Shelley');
    expect(book.chapters.map((c) => c.title)).toEqual(['First Light', 'Second Wind']);
  });

  it('finds the package without META-INF/container.xml', async () => {
    const files = epub2();
    delete files['META-INF/container.xml'];
    expect((await parseEpub(await buildEpub(files, { mimetype: false }))).chapters).toHaveLength(2);
  });

  it('falls back to the manifest order when the spine is empty, and to the file name for a title', async () => {
    const files = epub2();
    files['content.opf'] = files['content.opf'].replace(/<spine[\s\S]*<\/spine>/, '<spine/>').replace(/<dc:title>.*<\/dc:title>/, '');
    const book = await parseEpub(await buildEpub(files), { fallbackTitle: 'From the file name' });
    expect(book.chapters).toHaveLength(2);
    expect(book.title).toBe('From the file name');
  });
});

describe('parseEpub — failures', () => {
  it('refuses DRM-protected books but accepts font obfuscation', async () => {
    const encryption = (algorithm: string, uri: string): string =>
      `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
        <enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/>
        <enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;
    const drm = { ...epub3(), 'META-INF/encryption.xml': encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'OEBPS/Text/ch2.xhtml') };
    await expect(parseEpub(await buildEpub(drm))).rejects.toMatchObject({ code: 'drm' });
    const fonts = { ...epub3(), 'META-INF/encryption.xml': encryption('http://www.idpf.org/2008/embedding', 'OEBPS/Fonts/f.otf') };
    await expect(parseEpub(await buildEpub(fonts))).resolves.toMatchObject({ title: 'The Main Title' });
    const fairplay = { ...epub3(), 'META-INF/sinf.xml': '<sinf/>' };
    await expect(parseEpub(await buildEpub(fairplay))).rejects.toMatchObject({ code: 'drm' });
  });

  it('explains damaged and empty books', async () => {
    await expect(parseEpub(new TextEncoder().encode('not a zip at all').buffer)).rejects.toMatchObject({ code: 'parse' });
    await expect(parseEpub(await buildEpub({ 'readme.txt': 'hi' }))).rejects.toMatchObject({ code: 'parse' });
    const images = epub3();
    images['OEBPS/Text/chapter 1.xhtml'] = xhtml('<img src="a.png"/>');
    images['OEBPS/Text/ch2.xhtml'] = xhtml('<p>   </p>');
    await expect(parseEpub(await buildEpub(images))).rejects.toMatchObject({ code: 'empty' });
  });
});

describe('resolveZipPath', () => {
  it.each([
    ['OEBPS/Styles/', '../Text/a%20b.xhtml#frag', 'OEBPS/Text/a b.xhtml'],
    ['OEBPS/', 'Text/./c.xhtml?x=1', 'OEBPS/Text/c.xhtml'],
    ['OEBPS/', '/abs/x.xhtml', 'abs/x.xhtml'],
    ['', '../../escape.xhtml', 'escape.xhtml'],
    ['OEBPS/', 'bad%zz.xhtml', 'OEBPS/bad%zz.xhtml'],
    ['OEBPS/', 'https://cdn.example/x.xhtml', ''],
    ['OEBPS/', '#only-fragment', ''],
  ])('%s + %s → %s', (base, href, expected) => {
    expect(resolveZipPath(base, href)).toBe(expected);
  });
});
