import { IGNORE_ATTR } from '../../src/core/constants';

/**
 * Finds the element that holds a web page's main reading text, so line
 * measurement sees the article and not the nav bar, sidebars or comments.
 *
 * Every paragraph-like block contributes its *own* text (text not inside a
 * nested block, so `blockquote > p` isn't counted twice). Good text — long
 * enough, low link density, outside navigation/sidebar/footer zones — is
 * credited to all its ancestors as `content`; link text and junk-zone text
 * are charged to them as `noise`. The best container maximises
 * `content − 0.5·noise`: a layout wrapper that also holds the sidebar pays for
 * the sidebar's links, while the article container gets the text almost free.
 * Ties go to the tighter (deeper) container.
 */

const BLOCK_SELECTOR = 'p, pre, blockquote, li, dd, td, figcaption, div, section, article, main';
/** Paragraph-sized blocks; the other block tags are containers that only count when they hold enough loose text. */
const PARAGRAPH_TAGS = new Set(['p', 'pre', 'blockquote', 'li', 'dd', 'td', 'figcaption']);
const MIN_PARAGRAPH_CHARS = 25;
const MIN_CONTAINER_CHARS = 60;
const MAX_LINK_DENSITY = 0.5;
const NOISE_WEIGHT = 0.5;
const DEFAULT_MIN_SCORE = 200;

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed',
  'video', 'audio', 'select', 'textarea', 'button', 'input', 'math', 'head',
]);
const JUNK_TAGS = new Set(['nav', 'aside', 'footer', 'header', 'dialog', 'menu']);
const JUNK_ROLES = new Set([
  'navigation', 'complementary', 'contentinfo', 'banner', 'search', 'dialog', 'alertdialog', 'menu', 'menubar',
]);
/** Matched against each `-`/`_`-separated part of every class token and the id. */
const JUNK_WORDS = new Set([
  'nav', 'navbar', 'navigation', 'menu', 'menus', 'sidebar', 'sidenav', 'footer', 'header', 'masthead', 'banner',
  'comment', 'comments', 'disqus', 'related', 'recommended', 'recommendations', 'share', 'sharing', 'social',
  'promo', 'promos', 'sponsor', 'sponsored', 'advert', 'advertisement', 'ad', 'ads', 'breadcrumb', 'breadcrumbs',
  'pagination', 'pager', 'subscribe', 'newsletter', 'cookie', 'cookies', 'consent', 'popup', 'modal', 'toolbar',
  'widget', 'widgets', 'outbrain', 'taboola',
]);
const POSITIVE_WORDS = new Set(['article', 'articlebody', 'post', 'entry', 'story', 'content', 'chapter', 'prose', 'text', 'body']);
/** State classes like "has-sidebar" describe a layout, not a junk zone. */
const STATE_PREFIXES = new Set(['has', 'with', 'no', 'is', 'show', 'hide', 'toggle', 'js']);
const CONTENT_LANDMARKS = 'article, main, [role="main"], [itemprop="articleBody"]';

export interface FindMainContentOptions {
  /** Below this score the page has no clear main text and `document.body` is returned. */
  minScore?: number;
}

export function findMainContent(doc: Document, opts: FindMainContentOptions = {}): HTMLElement {
  const body = doc.body;
  if (!body) return doc.documentElement as HTMLElement;
  const root = doc.documentElement;

  const blocks = Array.from(body.querySelectorAll(BLOCK_SELECTOR));
  const blockSet = new Set<Element>(blocks);
  const containsBlock = new Set<Element>();
  for (const b of blocks) {
    for (let a = b.parentElement; a && !containsBlock.has(a); a = a.parentElement) containsBlock.add(a);
  }

  const zones = new ZoneClassifier(doc.defaultView);
  const content = new Map<Element, number>();
  const noise = new Map<Element, number>();
  const credit = (map: Map<Element, number>, from: Element, amount: number) => {
    for (let a: Element | null = from; a && a !== root; a = a.parentElement) map.set(a, (map.get(a) ?? 0) + amount);
  };

  for (const block of blocks) {
    if (zones.isSkipped(block)) continue;
    const { chars, linkChars } = ownText(block, blockSet, containsBlock);
    if (chars === 0) continue;
    const min = PARAGRAPH_TAGS.has(block.localName) ? MIN_PARAGRAPH_CHARS : MIN_CONTAINER_CHARS;
    const density = linkChars / chars;
    if (chars < min) {
      if (linkChars > 0) credit(noise, block, linkChars);
      continue;
    }
    if (density > MAX_LINK_DENSITY || zones.inJunkZone(block)) {
      credit(noise, block, chars);
      continue;
    }
    credit(content, block, chars * (1 - density));
    if (linkChars > 0) credit(noise, block, linkChars);
  }

  const ranked: { el: Element; score: number }[] = [];
  for (const [el, c] of content) {
    if (zones.inJunkZone(el)) continue;
    ranked.push({ el, score: (c - NOISE_WEIGHT * (noise.get(el) ?? 0)) * boost(el) });
  }
  // Highest score first; on a tie, the descendant (tighter container) first.
  ranked.sort((a, b) => b.score - a.score || (a.el.contains(b.el) ? 1 : b.el.contains(a.el) ? -1 : 0));

  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const view = doc.defaultView;
  for (const { el, score } of ranked.slice(0, 8)) {
    if (!(score >= minScore)) break;
    if (!isHTMLElement(el, doc)) continue;
    if (view && isHiddenByStyle(el, view)) continue;
    return el;
  }
  return body;
}

/** Text of `block` that doesn't belong to a nested block. */
function ownText(block: Element, blockSet: Set<Element>, containsBlock: Set<Element>): { chars: number; linkChars: number } {
  let chars = 0;
  let linkChars = 0;
  for (const node of Array.from(block.childNodes)) {
    if (node.nodeType === 3) {
      chars += collapsedLength(node.nodeValue ?? '');
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (blockSet.has(el) || containsBlock.has(el) || SKIP_TAGS.has(el.localName) || el.hasAttribute('hidden')) continue;
    const n = collapsedLength(el.textContent ?? '');
    chars += n;
    if (el.localName === 'a') linkChars += n;
    else for (const a of Array.from(el.querySelectorAll('a'))) linkChars += collapsedLength(a.textContent ?? '');
  }
  if (chars > 0 && block.closest('a')) linkChars = chars;
  return { chars, linkChars: Math.min(chars, linkChars) };
}

/** Length after collapsing whitespace runs, without allocating a new string. */
export function collapsedLength(s: string): number {
  let n = 0;
  let inSpace = true; // leading whitespace is dropped
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const space = c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 160;
    if (space) {
      if (!inSpace) n++;
      inSpace = true;
    } else {
      n++;
      inSpace = false;
    }
  }
  return inSpace && n > 0 ? n - 1 : n; // drop one trailing collapsed space
}

function boost(el: Element): number {
  let b = 1;
  if (el.localName === 'article' || el.getAttribute('itemprop') === 'articleBody') b *= 1.1;
  else if (el.localName === 'main' || el.getAttribute('role') === 'main') b *= 1.03;
  if (hintWords(el).some((w) => POSITIVE_WORDS.has(w))) b *= 1.05;
  return b;
}

function hintWords(el: Element): string[] {
  const words: string[] = [];
  const tokens = `${typeof el.className === 'string' ? el.className : ''} ${el.id}`.toLowerCase().split(/\s+/);
  for (const token of tokens) {
    if (!token) continue;
    const parts = token.split(/[-_]+/).filter(Boolean);
    if (parts.length === 0 || STATE_PREFIXES.has(parts[0]!)) continue;
    words.push(...parts, parts.join(''));
  }
  return words;
}

class ZoneClassifier {
  private readonly junk = new Map<Element, boolean>();
  private readonly zone = new Map<Element, boolean>();
  private readonly skipped = new Map<Element, boolean>();

  constructor(private readonly view: Window | null) {}

  /**
   * Inside markup that is never reading text: scripts, our own UI, hidden
   * subtrees. `display: none` matters: many sites render a second, hidden copy
   * of the article for another breakpoint. Each element's style is read once.
   */
  isSkipped(el: Element): boolean {
    const path: Element[] = [];
    let result = false;
    for (let a: Element | null = el; a; a = a.parentElement) {
      const cached = this.skipped.get(a);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      path.push(a);
      if (
        SKIP_TAGS.has(a.localName) ||
        a.hasAttribute(IGNORE_ATTR) ||
        a.hasAttribute('hidden') ||
        (this.view !== null && isDisplayNone(a, this.view))
      ) {
        result = true;
        break;
      }
    }
    for (const p of path) this.skipped.set(p, result);
    return result;
  }

  /** `el` or one of its ancestors is navigation, a sidebar, a footer, comments… */
  inJunkZone(el: Element): boolean {
    const path: Element[] = [];
    let result = false;
    for (let a: Element | null = el; a; a = a.parentElement) {
      const cached = this.zone.get(a);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      path.push(a);
      if (this.isJunk(a)) {
        result = true;
        break;
      }
    }
    for (const p of path) this.zone.set(p, result);
    return result;
  }

  private isJunk(el: Element): boolean {
    const cached = this.junk.get(el);
    if (cached !== undefined) return cached;
    let junk = false;
    const tag = el.localName;
    if (tag !== 'body' && tag !== 'html') {
      junk =
        JUNK_TAGS.has(tag) ||
        JUNK_ROLES.has(el.getAttribute('role') ?? '') ||
        el.getAttribute('aria-hidden') === 'true' ||
        hintWords(el).some((w) => JUNK_WORDS.has(w));
      // A "header" or "sidebar-layout" wrapper that contains the article isn't junk.
      if (junk && el.querySelector(CONTENT_LANDMARKS)) junk = false;
    }
    this.junk.set(el, junk);
    return junk;
  }
}

function isHTMLElement(el: Element, doc: Document): el is HTMLElement {
  const ctor = doc.defaultView?.HTMLElement;
  return ctor ? el instanceof ctor : 'style' in el;
}

function isHiddenByStyle(el: Element, view: Window): boolean {
  try {
    const cs = view.getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  } catch {
    return false;
  }
}

function isDisplayNone(el: Element, view: Window): boolean {
  try {
    return view.getComputedStyle(el).display === 'none';
  } catch {
    return false;
  }
}
