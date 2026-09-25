import { describe, expect, it } from 'vitest';
import {
  buildArtifactHtml,
  checkArtifactHtml,
  CONTROL_CHARS,
  escapeControlChars,
  escapeInlineScript,
  formatBytes,
} from '../scripts/artifact-html.mjs';

const FULL_APP = 'https://lance-lii.github.io/gaze-reader/';

const page = (js: string, extraMarkup = '') =>
  buildArtifactHtml({ title: 'Gaze Reader', css: 'body{color:red}', js, markup: `<div id="app"></div>${extraMarkup}` });

describe('escapeInlineScript', () => {
  it('neutralises everything that could end or confuse the inline script', () => {
    const js = 'const a="</script>",b=`<!-- x -->`,c="<SCRIPT src=x>",d=/<\\/script/;const e="<!doctype html><html><head></head><body></body></html>";';
    const out = escapeInlineScript(js);
    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toMatch(/<!--/);
    expect(out).not.toMatch(/<(?:!doctype|html|head|body)\b/i);
    expect(out).toContain('"\\x3C/script>"');
    expect(out).toContain('\\x3C!-- x -->');
  });

  it('keeps the program meaning the same', () => {
    const js = 'globalThis.out=["</script>","<!--","<body class=x>",/<head\\b/.test("<head>"),/<\\/script/u.test("</script")];';
    const run = (src: string) => {
      const scope: { out?: unknown } = {};
      new Function('globalThis', src)(scope);
      return scope.out;
    };
    expect(run(escapeInlineScript(js))).toEqual(run(js));
  });

  it('leaves ordinary comparisons and markup-free code alone', () => {
    const js = 'for(let i=0;i<n;i++)if(a<b&&c<header)x();';
    expect(escapeInlineScript(js)).toBe(js);
  });
});

describe('buildArtifactHtml', () => {
  it('is content only: title first, then style, markup and one module script', () => {
    const html = page('console.log("</script>")');
    expect(html.startsWith('<title>Gaze Reader</title>\n<style>')).toBe(true);
    expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('<div id="app">'));
    expect(html.indexOf('<div id="app">')).toBeLessThan(html.indexOf('<script type="module">'));
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(checkArtifactHtml(html)).toEqual([]);
  });

  it('refuses CSS that would close the style element', () => {
    expect(() => buildArtifactHtml({ title: 't', css: 'a{}</style><b>', js: '', markup: '' })).toThrow(/<\/style/);
  });

  it('escapes the title', () => {
    expect(buildArtifactHtml({ title: 'A <b> & c', css: '', js: '', markup: '' })).toContain('<title>A &lt;b&gt; &amp; c</title>');
  });
});

describe('checkArtifactHtml', () => {
  it('rejects document-level tags', () => {
    const problems = checkArtifactHtml('<!doctype html><title>x</title>');
    expect(problems.join('\n')).toMatch(/<!doctype/i);
    expect(checkArtifactHtml('<title>x</title><body>').join('\n')).toMatch(/<body/);
    expect(checkArtifactHtml('<title>x</title><header></header>')).toEqual([]);
  });

  it('requires a title near the top', () => {
    expect(checkArtifactHtml('<div></div>').join('\n')).toMatch(/no <title>/);
    expect(checkArtifactHtml(`<style>${'a'.repeat(9000)}</style><title>x</title>`).join('\n')).toMatch(/8 KB/);
  });

  it('allows external scripts only from the CDNs', () => {
    expect(checkArtifactHtml(page('', '<script src="https://cdn.jsdelivr.net/npm/x@1/x.js"></script>'))).toEqual([]);
    const bad = checkArtifactHtml(page('', '<script src="https://evil.example/x.js"></script><script src="./local.js"></script>'));
    expect(bad).toHaveLength(2);
  });

  it('allows stylesheets only from Google Fonts', () => {
    expect(checkArtifactHtml(page('', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">'))).toEqual([]);
    expect(checkArtifactHtml(page('', '<link rel="stylesheet" href="app.css">'))).toHaveLength(1);
  });

  it('flags network URLs in fetch(), import() and new Worker(), but not relative paths or allowed links', () => {
    const ok = page(`fetch("samples/index.json");fetch('./x.md');new Worker("pdf.worker.min.mjs");fetch("${FULL_APP}")`);
    expect(checkArtifactHtml(ok, { allowedFetchUrls: [FULL_APP] })).toEqual([]);
    const bad = checkArtifactHtml(page('fetch("https://api.example.com/x");import("//cdn.example/y.js");new Worker(`https://w.example/w.js`)'));
    expect(bad).toHaveLength(3);
  });

  it('flags dynamic imports of separate chunks', () => {
    expect(checkArtifactHtml(page('import("./assets/pdf-123.js")')).join('\n')).toMatch(/separate chunk/);
  });
});

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});

describe('escapeControlChars', () => {
  const ESC = String.fromCharCode(0x1b);
  const ETX = String.fromCharCode(0x03);
  const EOT = String.fromCharCode(0x04);
  const DEL = String.fromCharCode(0x7f);
  const BS = String.fromCharCode(0x5c); // backslash
  const TICK = '`';
  // Evaluates an expression the way the browser will after escaping.
  const run = (src: string): unknown => new Function('return (' + src + ');')();

  it('keeps string and template literals meaning the same characters', () => {
    const cases = [
      '"a' + ESC + 'b"', // raw control char in a string
      TICK + 'PK' + ETX + EOT + TICK, // in a template literal, like jszip's minified zip headers
      '"' + BS + ESC + '"', // a backslash-escaped control char means the char itself
      '"' + BS + BS + ESC + '"', // an escaped backslash followed by a raw control char
      '"x' + DEL + '"',
    ];
    for (const src of cases) {
      const escaped = escapeControlChars(src);
      expect(CONTROL_CHARS.test(escaped)).toBe(false);
      expect(run(escaped)).toEqual(run(src));
    }
  });

  it('keeps regex literals matching the same text', () => {
    const src = '/' + ESC + '[^' + ESC + ']*/';
    const re = run(escapeControlChars(src)) as RegExp;
    expect(re.test(ESC + '[31m')).toBe(true);
    expect(re.test('plain')).toBe(false);
  });

  it('leaves tabs, newlines and ordinary text alone', () => {
    const src = 'const a = "x\ty";\r\nconst b = ' + TICK + 'line\nline' + TICK + ';';
    expect(escapeControlChars(src)).toBe(src);
  });

  it('is applied to the page\'s inline script', () => {
    const js = 'const h=' + TICK + 'PK' + ETX + EOT + TICK + ';';
    const html = buildArtifactHtml({ title: 'T', css: '', js, markup: '<div id="app"></div>' });
    expect(CONTROL_CHARS.test(html)).toBe(false);
    expect(html).toContain('PK' + BS + 'x03' + BS + 'x04');
  });
});
