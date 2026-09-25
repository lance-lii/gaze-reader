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

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

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

function isHtmlNamespace(el: Element): boolean {
  return el.namespaceURI === XHTML_NS || el.namespaceURI === null;
}

function disposition(el: Element): Disposition {
  const tag = tagOf(el);
  if (DROPPED.has(tag)) return { kind: 'drop' };
  // Anything from a foreign namespace (epub:switch, stray MathML children, …) keeps only its text.
  if (!isHtmlNamespace(el)) return { kind: 'unwrap' };
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

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/** ASCII tab/newline are removed anywhere by the URL parser; C0 controls and spaces are trimmed. */
function compactUrl(raw: string): string {
  return raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
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

/** Copies the allowlisted, validated attributes of `src` onto `out`. */
function copyAttributes(src: Element, out: Element, tag: string, opts: ResolvedOptions): void {
  let id: string | null = null;
  let legacyName: string | null = null;

  for (const attr of Array.from(src.attributes)) {
    const ns = attr.namespaceURI;
    const name = attr.localName.toLowerCase();
    const value = attr.value;
    if (value.length > MAX_ATTR_LENGTH && name !== 'href') continue;

    if (ns === XML_NS) {
      // xml:lang from XHTML is the same thing as lang.
      if (name === 'lang' && LANG_RE.test(value.trim())) out.setAttribute('lang', value.trim());
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
        if (value.trim()) out.setAttribute('title', value.trim());
        break;
      case 'lang':
        if (LANG_RE.test(value.trim())) out.setAttribute('lang', value.trim());
        break;
      case 'dir': {
        const dir = value.trim().toLowerCase();
        if (dir === 'ltr' || dir === 'rtl' || dir === 'auto') out.setAttribute('dir', dir);
        break;
      }
      case 'href': {
        if (tag !== 'a') break;
        const safe = sanitizeHref(value, opts);
        if (!safe) break;
        out.setAttribute('href', safe.href);
        if (safe.kind === 'external') {
          out.setAttribute('rel', 'noopener noreferrer');
          out.setAttribute('target', '_blank');
        }
        break;
      }
      case 'datetime':
        if (tag === 'time' && value.trim().length <= 100) out.setAttribute('datetime', value.trim());
        break;
      case 'colspan':
      case 'rowspan': {
        if (tag !== 'td' && tag !== 'th') break;
        const n = parseIntAttr(value, name === 'colspan' ? 1 : 0, 1000);
        if (n !== null) out.setAttribute(name, n);
        break;
      }
      case 'scope': {
        const scope = value.trim().toLowerCase();
        if (tag === 'th' && /^(row|col|rowgroup|colgroup)$/.test(scope)) out.setAttribute('scope', scope);
        break;
      }
      case 'start':
        if (tag === 'ol') {
          const n = parseIntAttr(value, -1_000_000, 1_000_000);
          if (n !== null) out.setAttribute('start', n);
        }
        break;
      case 'reversed':
        if (tag === 'ol') out.setAttribute('reversed', '');
        break;
      case 'type':
        if (tag === 'ol' && /^[1aAiI]$/.test(value.trim())) out.setAttribute('type', value.trim());
        break;
      case 'value':
        if (tag === 'li') {
          const n = parseIntAttr(value, -1_000_000, 1_000_000);
          if (n !== null) out.setAttribute('value', n);
        }
        break;
      default:
        // Everything else — on*, style, class, src, srcdoc, formaction, xlink:href, data-*, … — is dropped.
        break;
    }
  }

  const safeId = prefixedId(id ?? legacyName ?? '', opts.idPrefix);
  if (safeId) out.setAttribute('id', safeId);
}

/** Would this <p> produce block-level output? Then it must be a <div> to stay valid HTML. */
function hasBlockDescendant(el: Element): boolean {
  const all = el.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const d = disposition(all[i]);
    if (d.kind === 'element' && BLOCK_OUTPUT.has(d.tag)) return true;
  }
  return false;
}

interface Frame {
  node: Node;
  parent: Node;
  depth: number;
  inLink: boolean;
}

/**
 * Rebuilds the sanitized children of `src` under `outRoot`, creating every node
 * with `outDoc`. Iterative (explicit stack) so hostile nesting can't blow the stack.
 */
function buildInto(src: Node, outDoc: Document, outRoot: Node, opts: ResolvedOptions): void {
  const stack: Frame[] = [];
  const pushChildren = (node: Node, parent: Node, depth: number, inLink: boolean): void => {
    for (let c = node.lastChild; c; c = c.previousSibling) stack.push({ node: c, parent, depth, inLink });
  };
  pushChildren(src, outRoot, 0, false);

  while (stack.length > 0) {
    const { node, parent, depth, inLink } = stack.pop() as Frame;

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

    if (tag === 'a' && inLink) tag = null; // nested links are invalid; keep the text
    if (tag === 'p' && hasBlockDescendant(el)) tag = 'div';
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
        pushChildren(el, div, depth + 1, inLink);
      } else {
        pushChildren(el, parent, depth, inLink);
      }
      continue;
    }

    if (tag === null) {
      pushChildren(el, parent, depth, inLink);
      continue;
    }

    const out = outDoc.createElement(tag);
    copyAttributes(el, out, tag, opts);
    if (tag === 'span' && tagOf(el) === 'bdi' && !out.hasAttribute('dir')) out.setAttribute('dir', 'auto');
    parent.appendChild(out);
    if (tag !== 'br' && tag !== 'hr') pushChildren(el, out, depth + 1, inLink || tag === 'a');
  }

  pruneEmpty(outRoot);
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
