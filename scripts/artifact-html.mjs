// Pure helpers for scripts/build-artifact.mjs: turn the bundled JS and CSS into
// the content-only page a claude.ai Artifact frame expects, and check it
// against the frame's rules. Types: artifact-html.d.mts. Tests: tests/artifactHtml.test.ts.
//
// The frame wraps the published file in its own <!doctype html><head>…<body>,
// so the file must not contain those tags; it starts with <title>, then one
// inline <style>, the markup and one inline module <script>.

/** Scripts may come from these CDNs only (everything else is blocked by the frame's CSP). */
export const ALLOWED_SCRIPT_ORIGINS = ['https://cdnjs.cloudflare.com/', 'https://cdn.jsdelivr.net/', 'https://unpkg.com/'];

/** Stylesheets may come from Google Fonts only. */
export const ALLOWED_STYLE_ORIGINS = ['https://fonts.googleapis.com/', 'https://fonts.gstatic.com/'];

/** The page must stay under this size, inline data included. */
export const MAX_PAGE_BYTES = 16 * 1024 * 1024;

/** The <title> must appear within this many bytes of the start. */
export const TITLE_WITHIN_BYTES = 8 * 1024;

const DOCUMENT_TAG = /<(?:!doctype|html|head|body)\b/i;

/**
 * Makes JS safe to inline in <script>: every `<` that starts something the HTML
 * parser (or a naive document sniffer) would react to becomes `\x3C`. That is
 * the same character inside string, template and regular-expression literals,
 * and those are the only places such text can occur in a module.
 */
export function escapeInlineScript(js) {
  return js
    .replace(/<(\/?)(script|style|html|head|body)\b/gi, '\\x3C$1$2')
    .replace(/<!(--|doctype\b)/gi, '\\x3C!$1');
}

/** Throws when CSS can't be inlined as-is (it would end the <style> element early). */
export function assertInlineableCss(css) {
  if (/<\/style/i.test(css)) throw new Error('The CSS contains "</style" and cannot be inlined.');
  return css;
}

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Assembles the content-only page: <title> first, then <style>, the body
 * markup, and the module script last.
 * @param {{ title: string, css: string, js: string, markup: string }} parts
 */
export function buildArtifactHtml({ title, css, js, markup }) {
  return [
    `<title>${escapeText(title)}</title>`,
    `<style>\n${assertInlineableCss(css).trim()}\n</style>`,
    markup.trim(),
    `<script type="module">\n${escapeInlineScript(js).trim()}\n</script>`,
    '',
  ].join('\n');
}

const startsWithAny = (url, prefixes) => prefixes.some((p) => url.startsWith(p));
const isAbsolute = (url) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);

/**
 * Checks a finished page against the frame's rules and returns a list of
 * problems (empty when it's fine).
 * @param {string} html
 * @param {{ allowedFetchUrls?: readonly string[] }} [opts] absolute URLs that fetch() may name
 */
export function checkArtifactHtml(html, opts = {}) {
  const allowedFetch = opts.allowedFetchUrls ?? [];
  const problems = [];
  const bytes = Buffer.byteLength(html, 'utf8');

  if (bytes > MAX_PAGE_BYTES) problems.push(`the page is ${bytes} bytes; the limit is ${MAX_PAGE_BYTES}`);
  const doc = DOCUMENT_TAG.exec(html);
  if (doc) problems.push(`the page contains "${doc[0]}"; the frame supplies <!doctype>, <html>, <head> and <body> itself`);

  const titleAt = html.search(/<title>[^<]+<\/title>/i);
  if (titleAt < 0) problems.push('the page has no <title>');
  else if (Buffer.byteLength(html.slice(0, titleAt), 'utf8') > TITLE_WITHIN_BYTES) problems.push('the <title> is not within the first 8 KB');

  for (const m of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    const src = m[1];
    if (!isAbsolute(src) || !startsWithAny(src, ALLOWED_SCRIPT_ORIGINS)) {
      problems.push(`external script ${src} is not on an allowed CDN (${ALLOWED_SCRIPT_ORIGINS.join(', ')})`);
    }
  }
  for (const m of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']?([^"'\s>]+)/gi)) {
    const href = m[1];
    if (!isAbsolute(href) || !startsWithAny(href, ALLOWED_STYLE_ORIGINS)) {
      problems.push(`<link href="${href}"> is not allowed (inline styles, or Google Fonts only)`);
    }
  }

  // Network URLs named directly in fetch(), import() or new Worker(): only relative
  // paths (published files) and the allowed links may appear.
  for (const m of html.matchAll(/\b(fetch|import|Worker)\s*\(\s*(["'`])([^"'`]*)\2/g)) {
    const [, fn, , url] = m;
    if (isAbsolute(url) && !allowedFetch.includes(url)) problems.push(`${fn}() names a network URL the frame blocks: ${url}`);
  }
  // Dynamic chunks can't be published beside the page: everything must be inlined.
  for (const m of html.matchAll(/\bimport\s*\(\s*(["'`])(\.{1,2}\/[^"'`]*)\1/g)) {
    problems.push(`dynamic import of a separate chunk: ${m[2]}`);
  }

  return problems;
}

/** 1234567 → "1.18 MB". */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
