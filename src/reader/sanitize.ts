/**
 * HTML sanitizer for untrusted book content (EPUB chapters, web pages, pasted HTML).
 *
 * Strategy: parse the untrusted markup into an *inert* document (DOMParser — no
 * scripts run, no resources load), then rebuild only allowlisted elements and
 * attributes with createElement / createTextNode into a separate document. Nothing
 * from the input is ever assigned to innerHTML of a live document, and nothing is
 * copied wholesale — every surviving node is created by us.
 *
 * Output invariants (tested):
 *  - only tags from the allowlist below;
 *  - only the per-tag attribute allowlist, with validated values;
 *  - links are http(s) (rel="noopener noreferrer", target="_blank") or in-book "#…" fragments;
 *  - ids are prefixed ("gr-src-") so they can neither clobber globals nor collide with app ids;
 *  - no raw-text / foreign-content elements, so the serialization round-trips stably.
 */

export const SANITIZE_ID_PREFIX = 'gr-src-';

export interface SanitizeOptions {
  /** Base URL used to resolve relative links. Without it, relative links lose their href. */
  baseUrl?: string;
  /** Prefix for surviving ids and for in-document fragment links. Default "gr-src-". */
  idPrefix?: string;
  /**
   * Optional hook to rewrite an href before validation — e.g. an EPUB maps
   * "chapter2.xhtml#note3" to an in-book fragment. Return null to drop the href.
   * Whatever it returns is validated exactly like source markup.
   */
  rewriteHref?: (href: string) => string | null;
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/** Elements that survive unchanged (the contract in docs/ARCHITECTURE.md). */
const ALLOWED = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'i', 'strong', 'b', 'u', 's', 'sub', 'sup',
  'small', 'blockquote', 'q', 'cite', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre', 'code', 'span', 'div',
  'section', 'article', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'abbr',
  'time',
]);

/** Common elements outside the allowlist that have a faithful allowlisted equivalent. */
const RENAMED: Readonly<Record<string, string>> = {
  main: 'div', header: 'div', footer: 'div', aside: 'div', nav: 'div', address: 'div', center: 'div',
  hgroup: 'div', details: 'div', summary: 'div', dialog: 'div', search: 'div', fieldset: 'div',
  legend: 'div', menu: 'ul', dir: 'ul', tfoot: 'tbody', tt: 'code', kbd: 'code', samp: 'code',
  strike: 's', del: 's', ins: 'u', dfn: 'em', var: 'em', acronym: 'abbr', mark: 'span', bdi: 'span',
  bdo: 'span', big: 'span', font: 'span',
};

/**
 * Removed together with everything inside them: executable, embedding, styling,
 * form, media and foreign-content elements, plus raw-text elements whose content
 * must never be reinterpreted as markup (the mutation-XSS classics).
 */
const DROPPED = new Set([
  'script', 'style', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param',
  'svg', 'math', 'noscript', 'noembed', 'noframes', 'form', 'input', 'button', 'select', 'option',
  'optgroup', 'datalist', 'textarea', 'keygen', 'output', 'img', 'image', 'picture', 'video', 'audio',
  'source', 'track', 'canvas', 'map', 'area', 'link', 'meta', 'base', 'basefont', 'bgsound', 'head',
  'title', 'xmp', 'plaintext', 'listing', 'portal', 'fencedframe', 'colgroup', 'col', 'wbr', 'slot',
]);

/** Output tags that are block-level: a <p> containing one of these must become a <div>. */
const BLOCK_OUTPUT = new Set([
  'p', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'pre',
  'div', 'section', 'article', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

const TABLE_SECTION = new Set(['table', 'thead', 'tbody']);

/** Elements removed when they end up with no text and no line-break / link-target inside. */
const PRUNE_IF_EMPTY =
  'p, span, em, i, strong, b, u, s, sub, sup, small, q, cite, code, abbr, time, a, div, section, ' +
  'article, figure, figcaption, blockquote, h1, h2, h3, h4, h5, h6';

/** Nesting cap for the output; deeper markup is flattened (text is kept). */
const MAX_DEPTH = 64;
const MAX_ATTR_LENGTH = 500;

const LANG_RE = /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i;

type Disposition =
  | { kind: 'drop' }
  | { kind: 'unwrap' }
  | { kind: 'element'; tag: string };

function tagOf(el: Element): string {
  return el.localName.toLowerCase();
}

function disposition(el: Element): Disposition {
  const tag = tagOf(el);
  if (DROPPED.has(tag)) return { kind: 'drop' };
  // SVG/MathML fragments outside their roots keep only their text. Other vocabularies that
  // reuse HTML names (DTBook's <p>, <h1>, <em> in EPUB 2) map like HTML: every output element
  // is created fresh in the HTML namespace, so no namespace can be smuggled through.
  if (el.namespaceURI === SVG_NS || el.namespaceURI === MATHML_NS) return { kind: 'unwrap' };
  if (ALLOWED.has(tag)) return { kind: 'element', tag };
  const renamed = RENAMED[tag];
  if (renamed) return { kind: 'element', tag: renamed };
  return { kind: 'unwrap' };
}

/** Turns an arbitrary id/fragment into a safe token (letters, digits, "_" and "-"). */
function cleanIdToken(raw: string): string {
  return raw.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 120);
}

function prefixedId(raw: string, prefix: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Idempotent: content that went through the sanitizer once keeps its ids.
  if (trimmed.startsWith(SANITIZE_ID_PREFIX)) {
    const cleaned = cleanIdToken(trimmed);
    return cleaned.length > SANITIZE_ID_PREFIX.length ? cleaned : null;
  }
  const token = cleanIdToken(trimmed);
  return token ? prefix + token : null;
}

/**
 * The id the sanitizer gives an element whose source id is `raw` (and the fragment a
 * link to it gets), e.g. for adding link targets outside the sanitized content.
 */
export function sanitizeId(raw: string, prefix: string = SANITIZE_ID_PREFIX): string | null {
  return prefixedId(raw, resolveOptions({ idPrefix: prefix }).idPrefix);
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/** ASCII tab/newline are removed anywhere by the URL parser; C0 controls and spaces are trimmed. */
function compactUrl(raw: string): string {
  const s = raw.replace(/[\t\n\r]/g, '');
  // Loops, not an end-anchored regex: that backtracks quadratically on a long run of spaces.
  let a = 0;
  let e = s.length;
  while (a < e && s.charCodeAt(a) <= 0x20) a++;
  while (e > a && s.charCodeAt(e - 1) <= 0x20) e--;
  return s.slice(a, e);
}

function isSameDocument(url: URL, base: URL): boolean {
  return url.origin === base.origin && url.pathname === base.pathname && url.search === base.search;
}

type SafeHref = { kind: 'fragment'; href: string } | { kind: 'external'; href: string };

function sanitizeHref(raw: string, opts: ResolvedOptions): SafeHref | null {
  let href: string | null = raw;
  if (opts.rewriteHref) {
    href = opts.rewriteHref(compactUrl(raw));
    if (href === null) return null;
  }
  const compact = compactUrl(href);
  if (!compact) return null;

  const toFragment = (hash: string): SafeHref | null => {
    const id = prefixedId(decodeFragment(hash.replace(/^#/, '')), opts.idPrefix);
    return id ? { kind: 'fragment', href: `#${id}` } : null;
  };

  if (compact.startsWith('#')) return toFragment(compact);

  let url: URL;
  try {
    url = opts.base ? new URL(compact, opts.base) : new URL(compact);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (opts.base && url.hash.length > 1 && isSameDocument(url, opts.base)) return toFragment(url.hash);
  return { kind: 'external', href: url.href };
}

function parseIntAttr(value: string, min: number, max: number): string | null {
  if (!/^\s*-?\d{1,6}\s*$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return n >= min && n <= max ? String(n) : null;
}

interface ResolvedOptions {
  base: URL | null;
  idPrefix: string;
  rewriteHref: ((href: string) => string | null) | null;
}

function resolveOptions(opts: SanitizeOptions | undefined): ResolvedOptions {
  let base: URL | null = null;
  if (opts?.baseUrl) {
    try {
      const candidate = new URL(opts.baseUrl);
      if (candidate.protocol === 'http:' || candidate.protocol === 'https:') base = candidate;
    } catch {
      base = null;
    }
  }
  const idPrefix = opts?.idPrefix && /^[A-Za-z][\w-]*$/.test(opts.idPrefix) ? opts.idPrefix : SANITIZE_ID_PREFIX;
  return { base, idPrefix, rewriteHref: opts?.rewriteHref ?? null };
}

/** Output attributes are written in this order, whatever the source order, so sanitizing is idempotent. */
const ATTRIBUTE_ORDER = [
  'id', 'href', 'rel', 'target', 'title', 'lang', 'dir', 'datetime', 'colspan', 'rowspan', 'scope', 'start',
  'reversed', 'type', 'value',
] as const;
type OutputAttribute = (typeof ATTRIBUTE_ORDER)[number];

/** Copies the allowlisted, validated attributes of `src` onto `out`. */
function copyAttributes(src: Element, out: Element, tag: string, opts: ResolvedOptions): void {
  const attrs = new Map<OutputAttribute, string>();
  let id: string | null = null;
  let legacyName: string | null = null;
  let xmlLang: string | null = null;

  for (const attr of Array.from(src.attributes)) {
    const ns = attr.namespaceURI;
    const name = attr.localName.toLowerCase();
    const value = attr.value;
    const trimmed = value.trim();
    if (value.length > MAX_ATTR_LENGTH && name !== 'href') continue;

    if (ns === XML_NS) {
      if (name === 'lang' && LANG_RE.test(trimmed)) xmlLang = trimmed; // XHTML's xml:lang is lang
      continue;
    }
    if (ns !== null) continue;

    switch (name) {
      case 'id':
        id = value;
        break;
      case 'name':
        if (tag === 'a') legacyName = value; // <a name="ch1"> is an old-style link target
        break;
      case 'title':
        if (trimmed) attrs.set('title', trimmed);
        break;
      case 'lang':
        if (LANG_RE.test(trimmed)) attrs.set('lang', trimmed);
        break;
      case 'dir': {
        const dir = trimmed.toLowerCase();
        if (dir === 'ltr' || dir === 'rtl' || dir === 'auto') attrs.set('dir', dir);
        break;
      }
      case 'href': {
        if (tag !== 'a') break;
        const safe = sanitizeHref(value, opts);
        if (!safe) break;
        attrs.set('href', safe.href);
        if (safe.kind === 'external') {
          attrs.set('rel', 'noopener noreferrer');
          attrs.set('target', '_blank');
        }
        break;
      }
      case 'datetime':
        if (tag === 'time' && trimmed.length <= 100) attrs.set('datetime', trimmed);
        break;
      case 'colspan':
      case 'rowspan': {
        if (tag !== 'td' && tag !== 'th') break;
        const n = parseIntAttr(value, name === 'colspan' ? 1 : 0, 1000);
        if (n !== null) attrs.set(name, n);
        break;
      }
      case 'scope': {
        const scope = trimmed.toLowerCase();
        if (tag === 'th' && /^(row|col|rowgroup|colgroup)$/.test(scope)) attrs.set('scope', scope);
        break;
      }
      case 'start':
      case 'value': {
        if ((name === 'start' && tag !== 'ol') || (name === 'value' && tag !== 'li')) break;
        const n = parseIntAttr(value, -1_000_000, 1_000_000);
        if (n !== null) attrs.set(name, n);
        break;
      }
      case 'reversed':
        if (tag === 'ol') attrs.set('reversed', '');
        break;
      case 'type':
        if (tag === 'ol' && /^[1aAiI]$/.test(trimmed)) attrs.set('type', trimmed);
        break;
      default:
        // Everything else — on*, style, class, src, srcdoc, formaction, xlink:href, data-*, … — is dropped.
        break;
    }
  }

  const safeId = prefixedId(id ?? legacyName ?? '', opts.idPrefix);
  if (safeId) attrs.set('id', safeId);
  if (xmlLang && !attrs.has('lang')) attrs.set('lang', xmlLang);
  if (tagOf(src) === 'bdi' && !attrs.has('dir')) attrs.set('dir', 'auto');
  for (const name of ATTRIBUTE_ORDER) {
    const value = attrs.get(name);
    if (value !== undefined) out.setAttribute(name, value);
  }
}

/**
 * Answers "would this <p> produce block-level output?" (then it must become a <div>
 * to stay valid HTML). Results are memoized per source element, so hostile nesting
 * such as <p><table><tr><td><p>… repeated thousands of times costs O(n) in total
 * instead of rescanning every paragraph's subtree. Dropped subtrees produce no
 * output and are not searched. Any tag that buildInto later demotes (nested links,
 * the depth cap) only makes this an over-estimate, which is the safe direction.
 */
function createBlockProbe(): (el: Element) => boolean {
  const memo = new WeakMap<Element, boolean>();
  return (root) => {
    const known = memo.get(root);
    if (known !== undefined) return known;
    const stack: { el: Element; next: Element | null; found: boolean }[] = [
      { el: root, next: root.firstElementChild, found: false },
    ];
    let result = false;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const child = top.next;
      if (child) {
        top.next = child.nextElementSibling;
        const d = disposition(child);
        if (d.kind === 'drop') continue;
        if (d.kind === 'element' && BLOCK_OUTPUT.has(d.tag)) top.found = true;
        const cached = memo.get(child);
        if (cached !== undefined) top.found ||= cached;
        else stack.push({ el: child, next: child.firstElementChild, found: false });
        continue;
      }
      stack.pop();
      memo.set(top.el, top.found);
      const parent = stack[stack.length - 1];
      if (parent) parent.found ||= top.found;
      else result = top.found;
    }
    return result;
  };
}

interface Frame {
  node: Node;
  parent: Node;
  depth: number;
  inLink: boolean;
  inHeading: boolean;
}

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Rebuilds the sanitized children of `src` under `outRoot`, creating every node
 * with `outDoc`. Iterative (explicit stack) so hostile nesting can't blow the stack.
 */
function buildInto(src: Node, outDoc: Document, outRoot: Node, opts: ResolvedOptions): void {
  const hasBlockDescendant = createBlockProbe();
  const stack: Frame[] = [];
  const pushChildren = (node: Node, parent: Node, depth: number, inLink: boolean, inHeading: boolean): void => {
    for (let c = node.lastChild; c; c = c.previousSibling) stack.push({ node: c, parent, depth, inLink, inHeading });
  };
  pushChildren(src, outRoot, 0, false, false);

  while (stack.length > 0) {
    const { node, parent, depth, inLink, inHeading } = stack.pop() as Frame;

    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
      const data = (node as CharacterData).data;
      if (data) parent.appendChild(outDoc.createTextNode(data));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue; // comments, processing instructions, doctypes

    const el = node as Element;
    const d = disposition(el);
    if (d.kind === 'drop') continue;

    let tag = d.kind === 'element' ? d.tag : null;
    const parentTag = parent.nodeType === Node.ELEMENT_NODE ? (parent as Element).localName : '';

    // Content models an HTML parser enforces: fix them now so a later parse can't rearrange the tree.
    if (tag === 'a' && inLink) tag = null; // nested links: keep the text
    if (tag !== null && HEADINGS.has(tag) && inHeading) tag = null; // nested headings: keep the text
    if (tag === 'p' && hasBlockDescendant(el)) tag = 'div';
    // A list item outside its list would be auto-closed (and moved) by the next list item a parser sees.
    if (tag === 'li' && parentTag !== 'ul' && parentTag !== 'ol') tag = 'div';
    if ((tag === 'dt' || tag === 'dd') && parentTag !== 'dl') tag = 'div';
    // Keep table structure well-formed so a later HTML parse can't rearrange it.
    if ((tag === 'thead' || tag === 'tbody') && parentTag !== 'table') tag = null;
    if (tag === 'tr' && !TABLE_SECTION.has(parentTag)) tag = 'div';
    if ((tag === 'td' || tag === 'th') && parentTag !== 'tr') tag = 'div';
    if (depth >= MAX_DEPTH) tag = null;

    if (tagOf(el) === 'caption') {
      // A caption becomes a block right before its table instead of loose text inside it.
      if (parentTag === 'table' && parent.parentNode) {
        const div = outDoc.createElement('div');
        parent.parentNode.insertBefore(div, parent);
        pushChildren(el, div, depth + 1, inLink, inHeading);
      } else {
        pushChildren(el, parent, depth, inLink, inHeading);
      }
      continue;
    }

    if (tag === null) {
      pushChildren(el, parent, depth, inLink, inHeading);
      continue;
    }

    const out = outDoc.createElement(tag);
    copyAttributes(el, out, tag, opts);
    parent.appendChild(out);
    if (tag !== 'br' && tag !== 'hr') {
      pushChildren(el, out, depth + 1, inLink || tag === 'a', inHeading || HEADINGS.has(tag));
    }
  }

  pruneEmpty(outRoot);
  trimLeadingWhitespace(outRoot);
}

/**
 * An HTML parser drops ASCII whitespace that precedes the first content, so leading
 * whitespace would not survive a serialize → parse round trip. It never renders
 * anyway (it sits at the start of a block), so remove it for a stable output.
 */
function trimLeadingWhitespace(root: Node): void {
  let first = root.firstChild;
  while (first && first.nodeType === Node.TEXT_NODE) {
    const text = first as Text;
    const trimmed = text.data.replace(/^[\t\n\f\r ]+/, '');
    if (trimmed) {
      text.data = trimmed;
      return;
    }
    const next = first.nextSibling;
    root.removeChild(first);
    first = next;
  }
}

function pruneEmpty(root: Node): void {
  if (!('querySelectorAll' in root)) return;
  const candidates = (root as ParentNode).querySelectorAll(PRUNE_IF_EMPTY);
  // Reverse document order visits descendants before their ancestors.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const el = candidates[i];
    if (el.id || el.querySelector('br, hr, [id]')) continue;
    if (/\S/.test(el.textContent ?? '')) continue;
    el.remove();
  }
}

function inertParse(html: string): Document {
  if (typeof DOMParser === 'undefined') throw new Error('sanitizeHtml needs a DOM (DOMParser is unavailable)');
  return new DOMParser().parseFromString(html, 'text/html');
}

function createInertDocument(): Document {
  if (typeof document !== 'undefined' && document.implementation) {
    return document.implementation.createHTMLDocument('');
  }
  return inertParse('');
}

/**
 * Sanitizes `source` (an HTML string, or an already-parsed node whose *children*
 * are sanitized — e.g. an EPUB XHTML <body>) into a detached container element
 * in a fresh inert document. Read `.innerHTML` for the markup and walk it for text.
 */
export function sanitizeToElement(source: string | Node, opts?: SanitizeOptions): HTMLElement {
  const resolved = resolveOptions(opts);
  const outDoc = createInertDocument();
  const container = outDoc.createElement('div');
  if (typeof source === 'string') {
    const body = inertParse(source).body;
    if (body) buildInto(body, outDoc, container, resolved);
  } else {
    buildInto(source, outDoc, container, resolved);
  }
  return container;
}

/** Sanitizes untrusted HTML into a string that contains only the allowlist. */
export function sanitizeHtml(html: string, opts?: SanitizeOptions): string {
  if (!html) return '';
  return sanitizeToElement(html, opts).innerHTML;
}

/** Sanitizes the children of an already-parsed node (HTML or XHTML document) into an HTML string. */
export function sanitizeNode(root: Node, opts?: SanitizeOptions): string {
  return sanitizeToElement(root, opts).innerHTML;
}

/**
 * Sanitizes untrusted HTML straight into a DocumentFragment owned by `doc` (usually
 * the live document). The fragment is assembled node by node with `doc.createElement`
 * from an inert parse, so there is no serialize → reparse step for markup to mutate in.
 */
export function sanitizeToFragment(html: string, doc: Document, opts?: SanitizeOptions): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  if (!html) return fragment;
  const body = inertParse(html).body;
  if (body) buildInto(body, doc, fragment, resolveOptions(opts));
  return fragment;
}
