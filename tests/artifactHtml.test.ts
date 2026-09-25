import { describe, expect, it } from 'vitest';
import { buildArtifactHtml, checkArtifactHtml, escapeInlineScript, formatBytes } from '../scripts/artifact-html.mjs';

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
