import type { Book, BookFormat } from '../types';
import { sanitizeToElement } from './sanitize';

// ───────────────────────────────── Errors ──────────────────────────────────

export type BookLoadErrorCode =
  | 'unsupported'
  | 'empty'
  | 'too-large'
  | 'invalid-url'
  | 'network'
  | 'timeout'
  | 'http'
  | 'parse'
  | 'drm';

/** Every loader failure is a BookLoadError whose message is written for the reader, not the developer. */
export class BookLoadError extends Error {
  readonly code: BookLoadErrorCode;
  constructor(code: BookLoadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BookLoadError';
    this.code = code;
  }
}

/** Books above this size are refused before we try to parse them. */
export const MAX_BOOK_BYTES = 200 * 1024 * 1024;
const DEFAULT_URL_TIMEOUT_MS = 20_000;

/** What every format parser produces; loaders stamp `source` and `addedAt` on top. */
export type ParsedBook = Omit<Book, 'source' | 'addedAt'>;
export interface ParseOptions {
  /** Used when the content itself carries no title (usually derived from the file name). */
  fallbackTitle?: string;
}

// ────────────────────────────── Small helpers ──────────────────────────────

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Drops trailing spaces and tabs (only those: a trailing NBSP is kept). A loop, not
 * `/[ \t]+$/`, which backtracks quadratically on a long run of spaces before a non-space.
 */
function trimEndSpTab(s: string): string {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return s.slice(0, e);
}

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WORD = /[\p{L}\p{N}\p{M}]+(?:['’.\-\u2010][\p{L}\p{N}\p{M}]+)*/gu;

/**
 * Counts words the way a reader would: "don't", "well-known", "e.g." and "3.14"
 * are one word each; punctuation and dashes are none. Han/kana characters count
 * individually because those scripts don't separate words with spaces.
 */
export function countWords(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_CHAR);
  const rest = cjk ? text.replace(CJK_CHAR, ' ') : text;
  const words = rest.match(WORD);
  return (cjk ? cjk.length : 0) + (words ? words.length : 0);
}

const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_LO = 0x1b3; // prime = 2^40 + 0x1b3

/**
 * Stable id: 64-bit FNV-1a over the UTF-8 bytes, printed in base 36.
 * The 64-bit multiply is done on two 32-bit halves so hashing a whole book
 * doesn't allocate a BigInt per byte.
 */
export function hashId(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hi = FNV_OFFSET_HI;
  let lo = FNV_OFFSET_LO;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    // (hi:lo) * (2^40 + 0x1b3) mod 2^64. All intermediates stay below 2^53.
    const loProduct = lo * FNV_PRIME_LO;
    const carry = Math.floor(loProduct / 0x1_0000_0000);
    const newHi = (hi * FNV_PRIME_LO + carry + ((lo << 8) >>> 0)) % 0x1_0000_0000;
    lo = loProduct >>> 0;
    hi = newHi >>> 0;
  }
  return ((BigInt(hi) << 32n) | BigInt(lo)).toString(36);
}

const BLOCK_BOUNDARY = new Set([
  'p', 'div', 'section', 'article', 'li', 'dt', 'dd', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'tr', 'td', 'th', 'figure', 'figcaption', 'br', 'hr', 'ul', 'ol', 'dl', 'table', 'header', 'footer',
  'main', 'aside', 'nav',
]);

/** Text content with a space at block boundaries ("<p>a</p><p>b</p>" → "a b", but "<em>un</em>real" → "unreal"). */
export function textOfNode(root: Node): string {
  const parts: string[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
      parts.push((node as CharacterData).data);
      continue;
    }
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK_BOUNDARY.has((node as Element).localName.toLowerCase())) {
      parts.push(' ');
    }
    for (let c = node.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return parts.join('');
}

// ───────────────────────────── Typography ─────────────────────────────────

const OPENING_CONTEXT = /[\s([{—–"'“‘*_/-]/;

/**
 * "Smart" punctuation for plain text and Markdown: curly quotes and apostrophes,
 * em dashes for "--"/"---", and an ellipsis for "...". Deliberately conservative.
 */
export function smartenPunctuation(input: string): string {
  const s = input
    .replace(/(^|[^-])-{2,3}(?!-)/g, '$1—')
    .replace(/\.\s?\.\s?\./g, '…');
  let out = '';
  // The last character written, kept aside: indexing the growing string would flatten it on
  // every quote mark, which is quadratic for a long paragraph.
  let prev = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '"' && c !== "'") {
      out += c;
      prev = c;
      continue;
    }
    // Context is the previous *output* character: a quote we just closed is not an opening context.
    const next = i + 1 < s.length ? s[i + 1] : '';
    const nextIsWord = /[\p{L}\p{N}]/u.test(next);
    let opens: boolean;
    if (prev === '' || OPENING_CONTEXT.test(prev)) opens = next !== '' && !/\s/.test(next);
    else if (/[\p{L}\p{N}.,!?;:)\]}’”…]/u.test(prev)) opens = false;
    else opens = nextIsWord; // after a symbol such as "=" or "/"
    let q: string;
    if (c === '"') {
      q = opens ? '“' : '”';
    } else {
      const after = s.slice(i + 1, i + 8);
      if (/[\p{L}\p{N}]/u.test(prev)) q = '’'; // don't, dogs', 1990's
      else if (/^\d\d(?:s|\b)/.test(after)) q = '’'; // '90s
      else if (opens && /^(?:tis|twas|twere|em|cause|til|n)\b/i.test(after)) q = '’'; // 'tis, rock 'n' roll
      else q = opens ? '‘' : '’';
    }
    out += q;
    prev = q;
  }
  return out;
}

const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'of', 'on', 'in', 'at', 'to', 'by', 'up', 'as', 'is',
  'with', 'from', 'into', 'over', 'upon', 'de', 'la', 'le', 'von', 'van',
]);

/** "PRIDE AND PREJUDICE" → "Pride and Prejudice". Leaves anything with lowercase letters alone. */
export function tameShouting(s: string): string {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length < 4 || letters !== letters.toUpperCase()) return s;
  const words = s.toLowerCase().split(/(\s+)/);
  const lastWord = words.length - 1;
  let previous = '';
  return words
    .map((w, i) => {
      if (/^\s+$/.test(w) || !w) return w;
      const before = previous;
      previous = w;
      const bare = w.replace(/[.,:;!?]+$/, '');
      if (bare.length >= 2 && ROMAN_WORD_RE.test(bare)) return w.toUpperCase(); // "VIII", not "Viii"
      // A subtitle starts after a colon or dash, or after the old "; or," ("Moby-Dick; or, The Whale").
      const startsSubtitle = /[:.!?—–]$/.test(before) || before === 'or,';
      if (i !== 0 && i !== lastWord && !startsSubtitle && SMALL_WORDS.has(w.replace(/[^\p{L}]/gu, ''))) return w;
      // First letter, and the first letter after a hyphen or dash ("Moby-Dick").
      return w.replace(/(^|[-–—])([^\p{L}]*)(\p{L})/gu, (_m, sep: string, pre: string, ch: string) => sep + pre + ch.toUpperCase());
    })
    .join('');
}

function cleanTitle(s: string | null | undefined, maxLength = 200): string | null {
  if (!s) return null;
  const t = collapseWhitespace(s).replace(/^[\s.:;,–—-]+|[\s:;,–—-]+$/g, '');
  return t ? t.slice(0, maxLength) : null;
}

/** "the_time-machine.v2.txt" → "The time machine.v2" */
export function titleFromFileName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,8}$/i, '');
  const spaced = collapseWhitespace(base.replace(/[_]+|(?<=\p{L})-(?=\p{L})/gu, ' '));
  if (!spaced) return 'Untitled';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ───────────────────────── Chapter assembly (shared) ─────────────────────────

export interface ChapterDraft {
  title: string | null;
  html: string;
  words: number;
}

/** Serializes a (sanitized) container into a chapter draft. */
export function draftFromElement(el: Element, title: string | null): ChapterDraft {
  return { title, html: el.innerHTML, words: countWords(textOfNode(el)) };
}

/**
 * Drops empty chapters, totals the words and derives the stable id.
 * Throws a friendly "empty" error when nothing readable is left.
 */
export function finalizeBook(
  meta: { title: string | null; author: string | null; format: BookFormat; fallbackTitle?: string; id?: string },
  drafts: readonly ChapterDraft[],
): ParsedBook {
  const chapters = drafts.filter((d) => d.words > 0);
  if (chapters.length === 0) {
    throw new BookLoadError('empty', "We couldn't find any readable text in this book.");
  }
  const firstTitled = chapters.find((c) => c.title)?.title ?? null;
  const title = cleanTitle(meta.title) ?? cleanTitle(meta.fallbackTitle) ?? cleanTitle(firstTitled) ?? 'Untitled';
  const html = chapters.map((c) => c.html);
  return {
    id: meta.id ?? hashId(`${meta.format}\n${title}\n${html.join('\n')}`),
    title,
    author: cleanTitle(meta.author, 160),
    chapters: chapters.map((c) => ({ title: c.title, html: c.html })),
    wordCount: chapters.reduce((sum, c) => sum + c.words, 0),
    format: meta.format,
  };
}

function headingLevel(el: Element): number {
  const m = /^h([1-6])$/.exec(el.localName.toLowerCase());
  return m ? Number(m[1]) : 0;
}

function firstElementChildSkippingBlank(el: Element): Element | null {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === Node.ELEMENT_NODE) return c as Element;
    if (c.nodeType === Node.TEXT_NODE && /\S/.test((c as Text).data)) return null;
  }
  return null;
}

/** The heading a top-level node opens with: itself, or the first child of a chapter-like wrapper. */
function leadingHeading(node: Node): Element | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  if (headingLevel(el)) return el;
  if (/^(div|section|article)$/.test(el.localName.toLowerCase())) {
    const first = firstElementChildSkippingBlank(el);
    if (first && headingLevel(first)) return first;
    // <section><div><h2>… (one more level, common in EPUB/Gutenberg markup)
    if (first && first.localName.toLowerCase() === 'div') {
      const inner = firstElementChildSkippingBlank(first);
      if (inner && headingLevel(inner)) return inner;
    }
  }
  return null;
}

function headingText(el: Element): string | null {
  return cleanTitle(textOfNode(el), 160);
}

/**
 * Splits sanitized content into chapters at its top-level headings. The split level
 * is the highest heading level that occurs at least twice (a lone <h1> is treated as
 * the book title and never forces one-chapter-per-book). Heading-only chapters
 * ("PART ONE" right before "CHAPTER I") are merged into the chapter that follows.
 */
export function splitIntoChapters(container: Element): ChapterDraft[] {
  let root: Element = container;
  for (;;) {
    const only = firstElementChildSkippingBlank(root);
    if (!only || only.nextElementSibling || !/^(div|section|article)$/.test(only.localName.toLowerCase())) break;
    if (Array.from(root.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && /\S/.test((n as Text).data))) break;
    root = only;
  }

  const nodes = Array.from(root.childNodes);
  const leads = nodes.map(leadingHeading);
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const h of leads) if (h) counts[headingLevel(h)]++;

  let splitLevel = 0;
  const minLevel = counts[1] === 1 ? 2 : 1;
  for (let level = minLevel; level <= 3; level++) {
    if (counts[level] >= 2 || (level === 2 && counts[1] === 1 && counts[2] >= 1)) {
      splitLevel = level;
      break;
    }
  }

  const doc = container.ownerDocument;
  const groups: { title: string | null; el: Element }[] = [];
  nodes.forEach((node, i) => {
    const lead = leads[i];
    const splits = splitLevel > 0 && lead !== null && headingLevel(lead) <= splitLevel;
    if (groups.length === 0 || splits) {
      groups.push({ title: splits && lead ? headingText(lead) : null, el: doc.createElement('div') });
    }
    groups[groups.length - 1].el.appendChild(node);
  });

  const firstHeading = leads.find((h) => h !== null) ?? null;
  if (splitLevel === 0 && groups.length === 1 && firstHeading) groups[0].title = headingText(firstHeading);

  const headingOnly = (el: Element): boolean => {
    let headingWords = 0;
    for (const h of Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'))) headingWords += countWords(textOfNode(h));
    return countWords(textOfNode(el)) <= headingWords;
  };

  // "PART ONE" directly before "CHAPTER I" belongs to that chapter (or to the previous one at the very end).
  const merged: typeof groups = [];
  let carry: Node[] = [];
  let carryTitle: string | null = null;
  groups.forEach((g, i) => {
    if (carry.length) {
      g.el.prepend(...carry);
      g.title = g.title ?? carryTitle;
      carry = [];
      carryTitle = null;
    }
    if (headingOnly(g.el)) {
      if (i < groups.length - 1) {
        carry = Array.from(g.el.childNodes);
        carryTitle = g.title;
        return;
      }
      const prev = merged[merged.length - 1];
      if (prev) {
        prev.el.append(...Array.from(g.el.childNodes));
        return;
      }
    }
    merged.push(g);
  });

  return merged.map((g) => draftFromElement(g.el, g.title));
}

// ──────────────────────────────── Plain text ────────────────────────────────

interface TextBlock {
  lines: string[];
  blankBefore: number;
  blankAfter: number;
}

type TextUnit =
  | { kind: 'title'; text: string }
  | { kind: 'byline'; text: string }
  | {
      kind: 'heading';
      lines: string[];
      keyword: string | null;
      /** "chapter iv" — identifies the heading independent of its title text. */
      label: string;
      numberOnly: boolean;
      level: 1 | 2;
      /** Blank lines above the heading in the source. */
      gap: number;
    }
  | { kind: 'para'; text: string }
  | { kind: 'verse'; lines: string[] }
  | { kind: 'break' }
  | { kind: 'quote'; units: TextUnit[] };

const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|' +
  'seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|' +
  'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last|final';
const HEADING_KEYWORDS =
  'chapter|chap\\.|book|part|volume|vol\\.|section|act|scene|canto|letter|stave|episode|lecture|lesson|story|tale';
/** A well-formed Roman numeral (so "mild" or "mix" never count as numbers). */
const ROMAN = '(?=[ivxlcdm])m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})';
const NUMBER_TOKEN = `(?:\\d{1,4}|${ROMAN}|(?:the\\s+)?(?:${NUMBER_WORDS})(?:[-\\s](?:${NUMBER_WORDS}))*)`;
const CHAPTER_ONLY_RE = new RegExp(`^(${HEADING_KEYWORDS})\\s+(${NUMBER_TOKEN})[.:]?$`, 'i');
const CHAPTER_TITLED_RE = new RegExp(`^(${HEADING_KEYWORDS})\\s+(${NUMBER_TOKEN})\\b\\s*([.:—–-]?)\\s*(\\S.*)$`, 'i');
const STANDALONE_RE =
  /^(?:prologue|epilogue|preface|foreword|introduction|afterword|appendix(?:\s+[a-z0-9]{1,4})?|interlude|postscript|conclusion|contents|table of contents|acknowledge?ments|dedication|author[’']?s note|glossary|bibliography|finis|the end)[.:!]?$/i;
const NUMERAL_RE = new RegExp(`^(?:${ROMAN.toUpperCase()}|\\d{1,3})\\.?$`);
const ROMAN_WORD_RE = new RegExp(`^${ROMAN}$`, 'i');

export interface ChapterLineMatch {
  /** "chapter", "book", "part", …; "numeral" for a bare number; "standalone" for PROLOGUE, CONTENTS, … */
  keyword: string;
  /** Keyword plus number, lowercased ("chapter iv"): the same for "CHAPTER IV." and "Chapter IV: Storm". */
  label: string;
  /** True when the line is only the label ("CHAPTER IV.") with no title of its own. */
  numberOnly: boolean;
}

/**
 * Recognizes chapter-heading lines: "CHAPTER I.", "Chapter 12", "BOOK TWO",
 * "Chapter 3: The Storm", "PROLOGUE", "XIV". Returns null for ordinary prose such
 * as "Book two was better." (a title after the number must look like a title).
 */
export function matchChapterLine(line: string): ChapterLineMatch | null {
  const t = collapseWhitespace(line);
  if (!t || t.length > 90) return null;
  const labelOf = (m: RegExpExecArray): { keyword: string; label: string } => {
    const keyword = m[1].toLowerCase().replace(/\.$/, '');
    return { keyword, label: `${keyword} ${m[2].toLowerCase().replace(/\s+/g, ' ')}` };
  };
  let m = CHAPTER_ONLY_RE.exec(t);
  if (m) return { ...labelOf(m), numberOnly: true };
  m = CHAPTER_TITLED_RE.exec(t);
  if (m) {
    const separator = m[3];
    const rest = m[4];
    const shouty = t === t.toUpperCase() && t !== t.toLowerCase();
    const words = rest.split(/\s+/);
    const capitalized = words.filter((w) => /^[\p{Lu}"“‘'(]/u.test(w)).length;
    const titleLike = /^[\p{Lu}"“‘'(]/u.test(rest) && !/[,;]$/.test(rest) && rest.length <= 70;
    const titleCase = capitalized / words.length >= 0.5 && !/[.!?]$/.test(rest);
    if (titleLike && (separator || shouty || titleCase)) return { ...labelOf(m), numberOnly: false };
    return null;
  }
  const lower = t.toLowerCase().replace(/[.:!]$/, '');
  if (STANDALONE_RE.test(t)) return { keyword: 'standalone', label: lower, numberOnly: false };
  if (NUMERAL_RE.test(t)) return { keyword: 'numeral', label: lower, numberOnly: true };
  return null;
}

function indentOf(line: string): number {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

/**
 * Math.min without spreading: a text with one paragraph per line and no blank lines
 * is a single block of 100 000+ lines, which would overflow the call stack.
 */
function minOf(values: readonly number[]): number {
  let min = Infinity;
  for (const v of values) if (v < min) min = v;
  return min;
}

/** The smallest indentation among `lines`. */
function minIndent(lines: readonly string[]): number {
  let min = Infinity;
  for (const l of lines) min = Math.min(min, indentOf(l));
  return min;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

const GUTENBERG_START = /^[^\n]*\*{3}\s*START OF[^\n]*$/im;
const GUTENBERG_END = /^[^\n]*\*{3}\s*END OF[^\n]*$/im;
const GUTENBERG_OLD_START = /^\*END\*THE SMALL PRINT[^\n]*$/im;
const GUTENBERG_END_LINE = /^\s*End of (?:the |this )?Project Gutenberg/im;
const PRODUCED_BY = /^(?:produced by|e-?text prepared by|transcribed (?:from|by)|this e-?book was produced|updated editions will replace|\[?transcriber)/i;

interface GutenbergInfo {
  body: string;
  title: string | null;
  author: string | null;
}

/** Keeps only the text between the "*** START OF" / "*** END OF" markers, harvesting Title:/Author:. */
export function stripGutenberg(text: string): GutenbergInfo {
  const start = GUTENBERG_START.exec(text) ?? GUTENBERG_OLD_START.exec(text);
  if (!start) return { body: text, title: null, author: null };
  const header = text.slice(0, start.index);
  let body = text.slice(start.index + start[0].length);
  const endCandidates = [GUTENBERG_END.exec(body), GUTENBERG_END_LINE.exec(body)]
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m.index);
  if (endCandidates.length) body = body.slice(0, minOf(endCandidates));

  const field = (name: string): string | null => {
    const m = new RegExp(`^${name}:[ \\t]*(.+(?:\\n[ \\t]+\\S.*)*)`, 'im').exec(header);
    return m ? collapseWhitespace(m[1]) : null;
  };

  // Drop a leading "Produced by …" credit paragraph.
  const lead = /^\s*([\s\S]*?)(\n\s*\n|$)/.exec(body);
  if (lead && PRODUCED_BY.test(lead[1].trim())) body = body.slice(lead[0].length);

  return { body, title: field('Title'), author: field('Author') };
}

function normalizeText(raw: string): string {
  return raw
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n\n')
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g, '')
    .replace(/[\u2028\u2029]/g, '\n');
}

function splitBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let cur: string[] = [];
  let blank = 0;
  let blankBefore = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd(); // the same characters as /\s+$/, but linear
    if (!line.trim()) {
      if (cur.length) {
        blocks.push({ lines: cur, blankBefore, blankAfter: 0 });
        cur = [];
        blank = 0;
      }
      blank++;
      continue;
    }
    if (!cur.length) {
      blankBefore = blank;
      blank = 0;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push({ lines: cur, blankBefore, blankAfter: 0 });
  for (let i = 0; i < blocks.length - 1; i++) blocks[i].blankAfter = blocks[i + 1].blankBefore;
  if (blocks.length) blocks[blocks.length - 1].blankAfter = 99;
  return blocks;
}

const SCENE_BREAK_RE = /^[\s*·•~#=_\-–—◊⁂❦❧✻✽§o0]+$/;
const ILLUSTRATION_RE = /^\[(?:illustration|picture|image|frontispiece)[^\]]*\]$/i;
const OPENING_QUOTE_OR_DASH = /^[“"‘'(\[—–-]/;

function isSceneBreak(lines: string[]): boolean {
  if (lines.length !== 1) return false;
  const t = lines[0].trim();
  return t.length <= 40 && SCENE_BREAK_RE.test(t) && /[*·•~#=_\-–—◊⁂❦❧✻✽§]/.test(t) && !/^\d+$/.test(t);
}

function classifyHeading(block: TextBlock, wrap: number): TextUnit | null {
  const lines = block.lines.map((l) => collapseWhitespace(l));
  if (lines.length > 3 || lines.some((l) => l.length > 90)) return null;
  const first = lines[0];
  const gap = block.blankBefore;
  const chapter = matchChapterLine(first);
  if (chapter) {
    const rest = lines.slice(1);
    if (rest.some((l) => l.length > Math.min(70, wrap * 0.85))) return null;
    const numberOnly = chapter.numberOnly && rest.length === 0;
    return { kind: 'heading', lines, keyword: chapter.keyword, label: chapter.label, numberOnly, level: 2, gap };
  }
  if (lines.length !== 1) return null;
  const letters = first.replace(/[^\p{L}]/gu, '');
  const words = first.split(/\s+/).length;
  if (letters.length < 2 || words > 10 || first.length > 60 || OPENING_QUOTE_OR_DASH.test(first)) return null;
  if (/[,;]$/.test(first)) return null;
  const label = first.toLowerCase();
  const allCaps = letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  if (allCaps) return { kind: 'heading', lines, keyword: null, label, numberOnly: false, level: 2, gap };
  // A short title-like line set apart the way Gutenberg sets chapter titles (3+ blank lines above).
  if (block.blankBefore >= 3 && block.blankAfter >= 1 && /^\p{Lu}/u.test(first) && !/[.,;:]$/.test(first)) {
    return { kind: 'heading', lines, keyword: null, label, numberOnly: false, level: 2, gap };
  }
  return null;
}

function joinWrapped(lines: string[]): string {
  // Tests look at the previous *line*, never at the growing paragraph: an end-anchored
  // regex over the accumulated string rescans all of it for every line (quadratic).
  const parts: string[] = [];
  let prev = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (parts.length > 0 && !(/\p{L}-$/u.test(prev) || /[—–]$/.test(prev) || /^[—–]/.test(line))) parts.push(' ');
    parts.push(line); // glued: "well-\nknown", "word—\nword"
    prev = line;
  }
  return parts.join('');
}

interface TextStats {
  wrap: number;
  unwrapped: boolean;
  firstLineIndentStyle: boolean;
}

function textStats(blocks: TextBlock[]): TextStats {
  const lens: number[] = [];
  const multiLineLens: number[] = [];
  let indentedFirst = 0;
  let multi = 0;
  for (const b of blocks) {
    for (const l of b.lines) lens.push(l.length);
    if (b.lines.length >= 2) {
      multi++;
      for (const l of b.lines) multiLineLens.push(l.length);
      if (indentOf(b.lines[0]) >= 2 && indentOf(b.lines[1]) < 2) indentedFirst++;
    }
  }
  const longShare = lens.length ? lens.filter((n) => n > 120).length / lens.length : 0;
  const wrap = multiLineLens.length >= 8 ? Math.max(40, quantile(multiLineLens, 0.9)) : 72;
  return { wrap, unwrapped: longShare >= 0.3, firstLineIndentStyle: multi > 0 && indentedFirst / multi > 0.3 };
}

function proseUnits(block: TextBlock, stats: TextStats): TextUnit[] {
  const { lines } = block;
  const trimmed = lines.map((l) => l.trim());
  const shortAll = lines.length >= 2 && lines.every((l) => l.trim().length < stats.wrap * 0.75);

  if (shortAll) {
    if (trimmed.every((l) => OPENING_QUOTE_OR_DASH.test(l))) {
      return trimmed.map((text) => ({ kind: 'para', text }) as TextUnit); // dialogue, one line per speaker
    }
    const base = minIndent(lines);
    return [{ kind: 'verse', lines: lines.map((l) => '\u00a0'.repeat(Math.min(12, indentOf(l) - base)) + l.trim()) }];
  }
  if (stats.unwrapped) return trimmed.map((text) => ({ kind: 'para', text }) as TextUnit);

  const base = minIndent(lines);
  const hasBaseLine = lines.some((l) => indentOf(l) <= base);
  const groups: string[][] = [[lines[0]]];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    const indentBreak = hasBaseLine && indentOf(cur) >= base + 2; // first-line-indented paragraphs
    const shortPrev = prev.trim().length < stats.wrap * 0.75;
    const prevEnds = /[.!?:"'”’)\]—]$/.test(prev.trim());
    const curStarts = /^(?:[“"‘'(\[—–-]|\p{Lu})/u.test(cur.trim());
    if (indentBreak || (shortPrev && prevEnds && curStarts)) groups.push([cur]);
    else groups[groups.length - 1].push(cur);
  }
  return groups.map((g) => ({ kind: 'para', text: joinWrapped(g) }) as TextUnit);
}

function classifyBlocks(blocks: TextBlock[], stats: TextStats): TextUnit[] {
  const typicalIndent = quantile(
    blocks.filter((b) => b.lines.length >= 2).map((b) => minIndent(b.lines)),
    0.5,
  );
  const units: TextUnit[] = [];
  for (const block of blocks) {
    const joined = collapseWhitespace(block.lines.join(' '));
    if (ILLUSTRATION_RE.test(joined)) continue;
    if (isSceneBreak(block.lines)) {
      units.push({ kind: 'break' });
      continue;
    }
    const heading = classifyHeading(block, stats.wrap);
    if (heading) {
      units.push(heading);
      continue;
    }
    const blockIndent = minIndent(block.lines);
    const quoted =
      blockIndent >= 2 &&
      !(Number.isFinite(typicalIndent) && typicalIndent >= 2) &&
      (block.lines.length >= 2 || !stats.firstLineIndentStyle);
    const inner = proseUnits(block, stats);
    if (quoted) units.push({ kind: 'quote', units: inner });
    else for (const u of inner) units.push(u); // no spread: one block can hold 100 000+ paragraphs
  }
  return units;
}

type HeadingUnit = Extract<TextUnit, { kind: 'heading' }>;

/**
 * A run of ≥ 3 headings sharing a keyword is a table of contents, not a series of
 * empty chapters. The run stops at a wide gap (the real chapter that follows a TOC
 * sits under 3+ blank lines) or when an entry repeats ("Chapter I" listed, then begun).
 */
function demoteTocRuns(units: TextUnit[]): TextUnit[] {
  const out: TextUnit[] = [];
  let i = 0;
  while (i < units.length) {
    const u = units[i];
    if (u.kind !== 'heading') {
      out.push(u);
      i++;
      continue;
    }
    const run: HeadingUnit[] = [];
    const seen = new Set<string>();
    for (let j = i; j < units.length; j++) {
      const h = units[j];
      if (h.kind !== 'heading' || (run.length > 0 && (h.gap >= 3 || seen.has(h.label)))) break;
      run.push(h);
      seen.add(h.label);
    }
    const j = i + run.length;
    const keywordCounts = new Map<string, number>();
    for (const h of run) {
      if (h.keyword && h.keyword !== 'standalone') keywordCounts.set(h.keyword, (keywordCounts.get(h.keyword) ?? 0) + 1);
    }
    const isToc = run.length >= 3 && [...keywordCounts.values()].some((n) => n >= 2);
    if (!isToc) {
      for (const h of run) out.push(h);
    } else {
      let k = 0;
      if (/contents/i.test(run[0].lines.join(' '))) out.push(run[k++]);
      out.push({ kind: 'verse', lines: run.slice(k).map((h) => h.lines.join(' ')) });
    }
    i = j;
  }
  return out;
}

/** "CHAPTER I." followed by a separate "THE BEGINNING" line becomes one two-line heading. */
function mergeHeadingSubtitles(units: TextUnit[]): TextUnit[] {
  const out: TextUnit[] = [];
  for (const u of units) {
    const prev = out[out.length - 1];
    if (u.kind === 'heading' && !u.keyword && prev?.kind === 'heading' && prev.numberOnly) {
      out[out.length - 1] = { ...prev, lines: [...prev.lines, ...u.lines], numberOnly: false };
      continue;
    }
    out.push(u);
  }
  return out;
}

/** "The Time Machine" or "MOBY DICK; OR, THE WHALE" — not "It was a dark and stormy night". */
function looksLikeTitle(text: string): boolean {
  const words = text.split(/\s+/);
  if (text.length > 60 || words.length > 10) return false;
  const significant = words.filter((w) => !SMALL_WORDS.has(w.toLowerCase().replace(/[^\p{L}]/gu, '')));
  const capitalized = significant.filter((w) => /^[\p{Lu}\d"“‘'(]/u.test(w)).length;
  return /^[\p{Lu}\d"“‘]/u.test(text) && capitalized >= Math.max(1, significant.length * 0.6);
}

function headingTitle(lines: string[]): string {
  const [first, ...rest] = lines.map(collapseWhitespace);
  if (!rest.length) return first;
  return /[.:—–-]$/.test(first) ? `${first} ${rest.join(' ')}` : `${first} — ${rest.join(' ')}`;
}

function inlineText(s: string): string {
  const html = escapeHtml(smartenPunctuation(s));
  // Project Gutenberg marks italics as _like this_.
  return html.replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>');
}

function unitHtml(u: TextUnit, partsExist: boolean): string {
  switch (u.kind) {
    case 'title':
      return `<h1>${inlineText(u.text)}</h1>`;
    case 'byline':
      return `<p>${inlineText(u.text)}</p>`;
    case 'heading': {
      const tag = u.level === 1 ? 'h2' : partsExist ? 'h3' : 'h2';
      return `<${tag}>${u.lines.map((l) => inlineText(collapseWhitespace(l))).join('<br>')}</${tag}>`;
    }
    case 'para':
      return `<p>${inlineText(u.text)}</p>`;
    case 'verse':
      return `<p>${u.lines.map(inlineText).join('<br>')}</p>`;
    case 'break':
      return '<hr>';
    case 'quote':
      return `<blockquote>${u.units.map((x) => unitHtml(x, partsExist)).join('')}</blockquote>`;
  }
}

interface ParsedText {
  title: string | null;
  author: string | null;
  drafts: ChapterDraft[];
}

function parsePlainText(raw: string): ParsedText {
  const gutenberg = stripGutenberg(normalizeText(raw));
  const blocks = splitBlocks(gutenberg.body);
  const stats = textStats(blocks);
  let units = mergeHeadingSubtitles(demoteTocRuns(classifyBlocks(blocks, stats)));

  // Front matter: a short, title-like first block is the title; "by …" right after it is the author.
  let detectedTitle: string | null = null;
  let detectedAuthor: string | null = null;
  const first = units[0];
  let firstText: string | null = null;
  if (first?.kind === 'heading' && !first.keyword) firstText = headingTitle(first.lines);
  if (first?.kind === 'para' && looksLikeTitle(first.text)) firstText = first.text;
  if (firstText && firstText.length <= 90 && !/[.,;]$/.test(firstText) && !OPENING_QUOTE_OR_DASH.test(firstText)) {
    detectedTitle = firstText;
    units = [{ kind: 'title', text: firstText }, ...units.slice(1)];
    const second = units[1];
    const byText = second?.kind === 'para' ? second.text : second?.kind === 'heading' ? headingTitle(second.lines) : null;
    const by = byText ? /^by\s+(.{2,80})$/i.exec(byText) : null;
    if (by) {
      detectedAuthor = by[1];
      units[1] = { kind: 'byline', text: byText as string };
    }
  }

  const headings = units.filter((u): u is HeadingUnit => u.kind === 'heading');
  const hasChapters = headings.some((h) => h.keyword === 'chapter' || h.keyword === 'numeral');
  const partsExist = hasChapters && headings.some((h) => /^(book|part|volume|vol)$/.test(h.keyword ?? ''));
  if (partsExist) {
    for (const h of headings) if (/^(book|part|volume|vol)$/.test(h.keyword ?? '')) h.level = 1;
  }

  // Split into chapters at headings.
  const drafts: { title: string | null; units: TextUnit[]; headingOnly: boolean }[] = [];
  for (const u of units) {
    if (u.kind === 'heading' || drafts.length === 0) {
      drafts.push({ title: u.kind === 'heading' ? headingTitle(u.lines) : null, units: [], headingOnly: true });
    }
    const cur = drafts[drafts.length - 1];
    cur.units.push(u);
    if (u.kind !== 'heading') cur.headingOnly = false;
  }
  // Heading-only chapters fold into the next chapter (or the previous one at the very end).
  const merged: typeof drafts = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const next = drafts[i + 1];
    if (d.headingOnly && next) {
      next.units = [...d.units, ...next.units];
      next.title = next.title ?? d.title;
      continue;
    }
    if (d.headingOnly && merged.length) {
      merged[merged.length - 1].units.push(...d.units);
      continue;
    }
    merged.push(d);
  }

  const chapterDrafts = merged.map((d) => {
    const html = d.units.map((u) => unitHtml(u, partsExist)).join('\n');
    return draftFromElement(sanitizeToElement(html), d.title);
  });

  return {
    title: gutenberg.title ?? detectedTitle,
    author: gutenberg.author ?? detectedAuthor,
    drafts: chapterDrafts,
  };
}

// ───────────────────────────────── Markdown ─────────────────────────────────

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})[^`]*$/;
// Trailing blanks and the optional closing #s are stripped by atxText: folding them into this
// regex, as `(.*?)(?:[ \t]+#+)?[ \t]*$`, backtracks quadratically on a long run of spaces.
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;

/** An ATX heading's text: trailing blanks and an optional closing `#` sequence removed. */
function atxText(m: RegExpExecArray): string {
  let t = trimEndSpTab(m[2] ?? '');
  let e = t.length;
  while (e > 0 && t.charCodeAt(e - 1) === 35) e--;
  if (e < t.length && e > 0) {
    const p = t.charCodeAt(e - 1);
    if (p === 32 || p === 9) t = trimEndSpTab(t.slice(0, e));
  }
  return t;
}
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^( {0,3})([*+-]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

function isBlank(line: string): boolean {
  return !line.trim();
}

function startsBlock(line: string): boolean {
  return FENCE_RE.test(line) || ATX_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || isListStart(line);
}

function isListStart(line: string): boolean {
  const m = LIST_RE.exec(line);
  return !!m && (m[4] ?? '').trim().length > 0;
}

function stripColumns(line: string, n: number): string {
  let i = 0;
  let col = 0;
  while (i < line.length && col < n && (line[i] === ' ' || line[i] === '\t')) {
    col += line[i] === '\t' ? 4 : 1;
    i++;
  }
  return line.slice(i);
}

function frontMatter(text: string): { body: string; meta: Record<string, string> } {
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { body: text, meta: {} };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim() || /^\s*#/.test(line) || /^\s+-\s/.test(line) || /^\s{2,}\S/.test(line)) continue;
    const kv = /^([\w .-]+):\s*(.*)$/.exec(line);
    if (!kv) return { body: text, meta: {} }; // not YAML: a leading "---" rule followed by prose
    meta[kv[1].trim().toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { body: text.slice(m[0].length), meta };
}

type Slots = string[];

/** http(s), mailto and relative/fragment links only — so markdownToHtml is safe even before sanitizing. */
function isSafeMarkdownUrl(url: string): boolean {
  const compact = url.replace(/[\u0000-\u0020]+/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  return !scheme || /^(?:https?|mailto)$/i.test(scheme[1]);
}

function renderInlineInto(src: string, slots: Slots): string {
  const slot = (html: string): string => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src;

  s = s.replace(/(^|[^`])(`+)(?!`)([\s\S]*?[^`])\2(?!`)/g, (_m, pre: string, _ticks: string, code: string) => {
    const text = code.replace(/\n/g, ' ').replace(/^ ([\s\S]*) $/, '$1');
    return pre + slot(`<code>${escapeHtml(text)}</code>`);
  });
  s = s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_m, c: string) => slot(escapeHtml(c)));
  // The lookbehind lets a match start only at the beginning of a space run (else it's quadratic).
  s = s.replace(/(?<! ) {2,}\n|\\\n/g, () => slot('<br>'));
  s = s.replace(/<(https?:\/\/[^\s<>]+)>/gi, (_m, url: string) => slot(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, () => ''); // images: dropped, like the sanitizer does
  s = s.replace(
    /\[((?:[^[\]]|\[[^[\]]*\])*)\]\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/g,
    (_m, text: string, url: string, t1?: string, t2?: string) => {
      const inner = renderInlineInto(text, slots);
      if (!isSafeMarkdownUrl(url)) return slot(inner);
      const title = t1 ?? t2;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return slot(`<a href="${escapeHtml(url)}"${titleAttr}>${inner}</a>`);
    },
  );

  s = escapeHtml(smartenPunctuation(s));
  s = s
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, '$1<strong>$2</strong>')
    .replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
    .replace(/\n/g, ' ');
  return s;
}

function renderInline(src: string): string {
  const slots: Slots = [];
  let html = renderInlineInto(src.replace(/\u0000/g, ''), slots);
  // Slots may nest (link text containing code), so restore until stable.
  for (let guard = 0; guard < 8 && html.includes('\u0000'); guard++) {
    html = html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? '');
  }
  return html;
}

function parseList(lines: string[], start: number, depth: number): { html: string; next: number } {
  const first = LIST_RE.exec(lines[start]) as RegExpExecArray;
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  const items: string[][] = [];
  let loose = false;
  let contentIndent = 0;
  let i = start;
  let sawBlank = false;

  while (i < lines.length) {
    const line = lines[i];
    const m = LIST_RE.exec(line);
    const sameKind = m !== null && /\d/.test(m[2]) === ordered;
    if (m && sameKind && (items.length === 0 || indentOf(line) < contentIndent)) {
      if (items.length && sawBlank) loose = true;
      const spaces = (m[3] ?? ' ').replace(/\t/g, '    ').length;
      contentIndent = m[1].length + m[2].length + (spaces >= 1 && spaces <= 4 ? spaces : 1);
      items.push([m[4] ?? '']);
      sawBlank = false;
      i++;
      continue;
    }
    if (isBlank(line)) {
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j >= lines.length) break;
      const nextLine = lines[j];
      const nm = LIST_RE.exec(nextLine);
      if (indentOf(nextLine) >= contentIndent) {
        items[items.length - 1].push('');
        loose = true;
        i++;
        continue;
      }
      if (nm && /\d/.test(nm[2]) === ordered) {
        sawBlank = true;
        i = j;
        continue;
      }
      break;
    }
    if (indentOf(line) >= contentIndent) {
      items[items.length - 1].push(stripColumns(line, contentIndent));
      i++;
      continue;
    }
    if (!sawBlank && !startsBlock(line)) {
      items[items.length - 1].push(line.trim()); // lazy paragraph continuation
      i++;
      continue;
    }
    break;
  }

  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : '';
  const body = items.map((item) => `<li>${renderMdBlocks(item, !loose, depth + 1)}</li>`).join('');
  return { html: `<${tag}${startAttr}>${body}</${tag}>`, next: i };
}

/**
 * Blockquotes and lists nest at most this deep; deeper markers stay literal text. Real
 * books never come close, and a pasted "> > > …" × 20 000 must not overflow the stack
 * (or re-slice every line once per level).
 */
const MAX_MD_DEPTH = 16;

function renderMdBlocks(lines: string[], tight: boolean, depth = 0): string {
  const nests = depth < MAX_MD_DEPTH;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    let m = FENCE_RE.exec(line);
    if (m) {
      const indent = m[1].length;
      const fence = m[2];
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
        code.push(stripColumns(lines[i], indent));
        i++;
      }
      i++;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    m = ATX_RE.exec(line);
    if (m) {
      const level = m[1].length;
      out.push(`<h${level}>${renderInline(atxText(m))}</h${level}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (nests && QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (QUOTE_RE.test(l)) inner.push(l.replace(/^ {0,3}> ?/, ''));
        else if (!isBlank(l) && inner.length && !isBlank(inner[inner.length - 1]) && !startsBlock(l)) inner.push(l);
        else if (isBlank(l) && i + 1 < lines.length && QUOTE_RE.test(lines[i + 1])) inner.push('');
        else break;
        i++;
      }
      out.push(`<blockquote>${renderMdBlocks(inner, false, depth + 1)}</blockquote>`);
      continue;
    }

    if (nests && isListStart(line)) {
      const list = parseList(lines, i, depth);
      out.push(list.html);
      i = list.next;
      continue;
    }

    if (INDENTED_CODE_RE.test(line)) {
      const code: string[] = [];
      while (i < lines.length && (INDENTED_CODE_RE.test(lines[i]) || isBlank(lines[i]))) {
        code.push(stripColumns(lines[i], 4));
        i++;
      }
      while (code.length && !code[code.length - 1].trim()) code.pop();
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const para: string[] = [line.replace(/^[ \t]+/, '')]; // trailing spaces may be a hard line break
    i++;
    let setext = 0;
    while (i < lines.length && !isBlank(lines[i])) {
      const sm = SETEXT_RE.exec(lines[i]);
      if (sm) {
        setext = sm[1][0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (startsBlock(lines[i])) break;
      para.push(lines[i].replace(/^[ \t]+/, ''));
      i++;
    }
    const text = trimEndSpTab(para.join('\n'));
    if (setext) out.push(`<h${setext}>${renderInline(text)}</h${setext}>`);
    else out.push(tight ? renderInline(text) : `<p>${renderInline(text)}</p>`);
  }
  return out.join(tight ? '' : '\n');
}

/**
 * Converts a small, safe Markdown subset to HTML: ATX/setext headings, paragraphs,
 * emphasis, links, lists (nested), blockquotes, rules and code. Raw HTML in the
 * source is escaped, never passed through. Output still goes through the sanitizer.
 */
export function markdownToHtml(md: string): string {
  const { body } = frontMatter(normalizeText(md));
  return renderMdBlocks(body.split('\n'), false);
}

function parseMarkdownBook(md: string): ParsedText {
  const { body, meta } = frontMatter(normalizeText(md));
  const container = sanitizeToElement(renderMdBlocks(body.split('\n'), false));
  const h1 = container.querySelector('h1');
  let author = meta.author ?? meta.creator ?? null;
  if (!author && h1) {
    // "*by Jane Doe*" right under the title
    const next = h1.nextElementSibling;
    const by = next ? /^by\s+(.{2,80})$/i.exec(collapseWhitespace(next.textContent ?? '')) : null;
    if (by) author = by[1];
  }
  return {
    title: meta.title ?? (h1 ? headingText(h1) : null),
    author,
    drafts: splitIntoChapters(container),
  };
}

// ─────────────────────────────────── HTML ───────────────────────────────────

const NEGATIVE_HINT =
  /(?:^|[\s_-])(?:share|sharing|social|comments?|related|newsletter|subscribe|advert(?:isement)?|ads?|promo|sponsor(?:ed)?|cookie|consent|breadcrumbs?|popup|modal|sidebar|widget|masthead|pg-boilerplate|pg-header|pg-footer)(?:$|[\s_-])/i;
const POSITIVE_HINT = /(?:^|[\s_-])(?:article|body|content|entry|main|page|post|text|blog|story|chapter|prose)(?:$|[\s_-])/i;
const PARAGRAPH_SELECTOR = 'p, pre, blockquote, li, td, dd';

function hintOf(el: Element): string {
  return `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`;
}

function linkDensity(el: Element): number {
  const total = collapseWhitespace(el.textContent ?? '').length;
  if (!total) return 0;
  let links = 0;
  for (const a of Array.from(el.querySelectorAll('a'))) links += collapseWhitespace(a.textContent ?? '').length;
  return Math.min(1, links / total);
}

/**
 * Finds the element that holds the article/book text of a web page — a compact
 * cousin of Readability: paragraphs vote for their ancestors (decaying with
 * distance), votes are discounted by link density and class/id hints, and when the
 * winner's siblings also carry real text their common parent wins instead.
 */
export function extractMainContent(doc: Document): Element {
  const body = doc.body ?? doc.documentElement;
  const scores = new Map<Element, number>();
  for (const p of Array.from(body.querySelectorAll(PARAGRAPH_SELECTOR))) {
    if (p.closest('nav, aside, footer, form, [role="navigation"], [role="complementary"], [aria-hidden="true"]')) continue;
    const text = collapseWhitespace(p.textContent ?? '');
    if (text.length < 25) continue;
    const score = 1 + (text.match(/[,，、]/g)?.length ?? 0) + Math.min(3, Math.floor(text.length / 100));
    let ancestor: Element | null = p.parentElement;
    for (let depth = 1; ancestor && depth <= 5; depth++) {
      scores.set(ancestor, (scores.get(ancestor) ?? 0) + score / depth);
      if (ancestor === body) break;
      ancestor = ancestor.parentElement;
    }
  }

  let best: Element | null = null;
  let bestScore = 0;
  for (const [el, raw] of scores) {
    const hint = hintOf(el);
    let score = raw * (1 - linkDensity(el));
    if (NEGATIVE_HINT.test(hint)) score *= 0.3;
    if (POSITIVE_HINT.test(hint) || /^(article|main)$/i.test(el.localName)) score *= 1.25;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  if (!best) return body;

  const parent = best.parentElement;
  if (parent && best !== body) {
    let siblingScore = 0;
    for (const sib of Array.from(parent.children)) {
      if (sib !== best && !NEGATIVE_HINT.test(hintOf(sib))) siblingScore += scores.get(sib) ?? 0;
    }
    if (siblingScore >= bestScore * 0.3) return parent;
  }
  return best;
}

/** Removes navigation, sharing widgets, comment threads and the like from inside the chosen content. */
function stripBoilerplate(root: Element): void {
  // Project Gutenberg's licence blocks are boilerplate however long they are (in a short book, longer than the book).
  const junk = root.querySelectorAll(
    'nav, aside, form, [role="navigation"], [role="complementary"], [role="search"], [aria-hidden="true"], [hidden], ' +
      '#pg-header, #pg-footer, .pg-boilerplate',
  );
  for (const el of Array.from(junk)) el.remove();
  const rootText = collapseWhitespace(root.textContent ?? '').length;
  for (const el of Array.from(root.querySelectorAll('[class], [id]'))) {
    if (!root.contains(el)) continue; // already removed with an ancestor
    const hint = hintOf(el);
    if (!NEGATIVE_HINT.test(hint) || POSITIVE_HINT.test(hint)) continue;
    // A class name is only a hint: never throw away a large share of the text because of it.
    if (collapseWhitespace(el.textContent ?? '').length > rootText * 0.3) continue;
    el.remove();
  }
  for (const footer of Array.from(root.querySelectorAll('footer'))) {
    const text = collapseWhitespace(footer.textContent ?? '');
    if (text.length < 200 || linkDensity(footer) > 0.5) footer.remove();
  }
}

function metaContent(doc: Document, selector: string): string | null {
  const v = doc.querySelector(selector)?.getAttribute('content');
  return v ? collapseWhitespace(v) : null;
}

function htmlTitleAndAuthor(doc: Document): { title: string | null; author: string | null } {
  const og = metaContent(doc, 'meta[property="og:title"]');
  const docTitle = collapseWhitespace(doc.title ?? '');
  const h1 = doc.querySelector('h1');
  const h1Text = h1 ? collapseWhitespace(h1.textContent ?? '') : '';
  let title: string | null = og || (h1Text && docTitle.includes(h1Text) ? h1Text : null) || docTitle || h1Text || null;
  let author =
    metaContent(doc, 'meta[name="author"]') ??
    metaContent(doc, 'meta[name="dc.creator"], meta[name="DC.creator"]') ??
    metaContent(doc, 'meta[property="article:author"]');
  if (author && /^https?:/i.test(author)) author = null;
  if (!author) {
    const byline = doc.querySelector('[rel="author"], [itemprop="author"], .byline, .author');
    const text = byline ? collapseWhitespace(byline.textContent ?? '') : '';
    if (text && text.length <= 80) author = text.replace(/^by\s+/i, '');
  }
  if (title) {
    // "The Project Gutenberg eBook of Pride and Prejudice, by Jane Austen"
    const gb = /^The Project Gutenberg e-?Book of\s+(.+?)(?:,\s+by\s+(.+))?$/i.exec(title);
    if (gb) {
      title = gb[1];
      author = author ?? gb[2] ?? null;
    } else if (!og && title === docTitle) {
      // "Article title | Site name" → "Article title"
      const parts = title.split(/\s+[|·–—-]\s+/);
      if (parts.length > 1 && parts[0].length >= 8) title = parts[0];
    }
  }
  return { title, author };
}

function parseHtmlDocument(
  doc: Document,
  opts: { baseUrl?: string; mainContent: boolean },
): ParsedText {
  const { title, author } = htmlTitleAndAuthor(doc);
  const root = opts.mainContent ? extractMainContent(doc) : doc.body ?? doc.documentElement;
  stripBoilerplate(root);
  const container = sanitizeToElement(root, { baseUrl: opts.baseUrl });
  return { title, author, drafts: splitIntoChapters(container) };
}

// ───────────────────────────── Decoding & sniffing ─────────────────────────────

/** windows-1252 code points for 0x80–0x9F (some decoders return C1 controls instead). */
const CP1252_C1: Readonly<Record<number, number>> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function decodeCp1252(bytes: Uint8Array): string {
  return new TextDecoder('windows-1252')
    .decode(bytes)
    .replace(/[\u0080-\u009f]/g, (ch) => String.fromCharCode(CP1252_C1[ch.charCodeAt(0)] ?? ch.charCodeAt(0)));
}

/**
 * Decodes text bytes: BOM first, then strict UTF-8, then the declared charset,
 * then windows-1252 (what old Project Gutenberg files and Word exports use).
 */
export function decodeText(bytes: Uint8Array, charsetHint?: string | null): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* not UTF-8 */
  }
  const hint = charsetHint?.trim().toLowerCase();
  if (hint && !/^utf-?8$/.test(hint)) {
    if (/^(?:windows-1252|cp1252|iso-8859-1|latin-?1|us-ascii|ascii)$/.test(hint)) return decodeCp1252(bytes);
    try {
      return new TextDecoder(hint).decode(bytes);
    } catch {
      /* unknown label */
    }
  }
  return decodeCp1252(bytes);
}

function sniffHtmlCharset(bytes: Uint8Array): string | null {
  const head = String.fromCharCode(...bytes.subarray(0, 2048));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return m ? m[1] : null;
}

/** 'auto' = some kind of text whose format is decided from its content. */
type SourceKind = 'epub' | 'pdf' | 'html' | 'md' | 'txt' | 'auto';

const UNSUPPORTED_BY_EXT: Readonly<Record<string, string>> = {
  mobi: 'Kindle books (MOBI/AZW) aren’t supported. If the book isn’t DRM-protected, convert it to EPUB (for example with Calibre) and open that.',
  azw: 'Kindle books (MOBI/AZW) aren’t supported. If the book isn’t DRM-protected, convert it to EPUB (for example with Calibre) and open that.',
  azw3: 'Kindle books (MOBI/AZW) aren’t supported. If the book isn’t DRM-protected, convert it to EPUB (for example with Calibre) and open that.',
  kfx: 'Kindle books aren’t supported. Try an EPUB, PDF or plain-text version instead.',
  docx: 'Word documents aren’t supported yet. Save it as plain text, HTML or PDF and open that instead.',
  doc: 'Word documents aren’t supported yet. Save it as plain text, HTML or PDF and open that instead.',
  odt: 'OpenDocument files aren’t supported yet. Save it as plain text, HTML or PDF and open that instead.',
  rtf: 'RTF files aren’t supported yet. Save it as plain text, HTML or PDF and open that instead.',
  pages: 'Pages documents aren’t supported. Export it as PDF or EPUB and open that instead.',
  cbz: 'Comic archives contain images, not text — there’s nothing for Gaze Reader to read.',
  cbr: 'Comic archives contain images, not text — there’s nothing for Gaze Reader to read.',
};

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name.replace(/[?#].*$/, ''));
  return m ? m[1].toLowerCase() : '';
}

function startsWithBytes(bytes: Uint8Array, ascii: string, offset = 0): boolean {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  return true;
}

/** Bytes that never occur in text files: NUL and most C0 controls (UTF-16 files are BOM-marked). */
function looksBinary(probe: Uint8Array): boolean {
  if ((probe[0] === 0xff && probe[1] === 0xfe) || (probe[0] === 0xfe && probe[1] === 0xff)) return false;
  let controls = 0;
  for (let i = 0; i < probe.length; i++) {
    const b = probe[i];
    if (b === 0) return true;
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) controls++;
  }
  return controls > probe.length * 0.02;
}

/** Decides how to parse a file from its magic bytes, extension and MIME type (in that order of trust). */
function sniffKind(bytes: Uint8Array, name: string, mime: string): SourceKind {
  const ext = extensionOf(name);
  const type = mime.split(';')[0].trim().toLowerCase();
  const head = String.fromCharCode(...bytes.subarray(0, 1024));

  // A PDF starts with "%PDF-"; readers tolerate junk before it within the first KB. Text that
  // merely *mentions* "%PDF-1.7" (notes about the format) must stay text, so a signature that
  // isn't at the very start only counts when the name, type or binary content agree.
  const pdfAt = head.indexOf('%PDF-');
  if (pdfAt === 0 || (pdfAt > 0 && (ext === 'pdf' || type === 'application/pdf' || looksBinary(bytes.subarray(0, 4096))))) {
    return 'pdf';
  }
  if (startsWithBytes(bytes, 'PK\u0003\u0004')) {
    if (startsWithBytes(bytes, 'mimetypeapplication/epub+zip', 30) || ext === 'epub' || type === 'application/epub+zip') {
      return 'epub';
    }
    throw new BookLoadError('unsupported', UNSUPPORTED_BY_EXT[ext] ?? 'That looks like a ZIP archive, but not an EPUB book.');
  }
  if (head.startsWith('{\\rtf')) throw new BookLoadError('unsupported', UNSUPPORTED_BY_EXT.rtf);
  if (UNSUPPORTED_BY_EXT[ext]) throw new BookLoadError('unsupported', UNSUPPORTED_BY_EXT[ext]);
  if (ext === 'epub' || type === 'application/epub+zip') return 'epub'; // not a ZIP: the EPUB parser explains
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';

  // Binary content we don't understand: NUL bytes never appear in real text files (except UTF-16, BOM-marked).
  const probe = bytes.subarray(0, 4096);
  const utf16 = (probe[0] === 0xff && probe[1] === 0xfe) || (probe[0] === 0xfe && probe[1] === 0xff);
  if (!utf16 && probe.includes(0)) {
    throw new BookLoadError(
      'unsupported',
      'Gaze Reader can open EPUB, PDF, HTML, Markdown and plain-text files — this one looks like something else.',
    );
  }
  if (/^(?:html?|xhtml|xht)$/.test(ext) || type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (/^(?:md|markdown|mdown|mkd|mkdn)$/.test(ext) || type === 'text/markdown' || type === 'text/x-markdown') return 'md';
  if (ext === 'txt' || ext === 'text') return 'txt';
  return 'auto';
}

/** Best guess at what a blob of text is. */
export function detectTextFormat(text: string): 'txt' | 'md' | 'html' {
  const head = text.slice(0, 4000).replace(/^\ufeff/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html[\s>])/i.test(head)) return 'html';
  if (/^<(?:p|div|article|section|main|body|h[1-6])[\s>]/i.test(head) && /<\/(?:p|div|h[1-6]|article|section)>/i.test(head)) {
    return 'html';
  }
  let score = 0;
  if (/^#{1,6}[ \t]+\S/m.test(head)) score += 2;
  if (/^---[ \t]*\n[\w-]+:/.test(head)) score += 2;
  if (/\*\*[^*\n]+\*\*/.test(head)) score++;
  if (/^[ \t]{0,3}[-*+][ \t]+\S/m.test(head)) score++;
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(head)) score++;
  if (/^(?:```|~~~)/m.test(head)) score++;
  if (/^>[ \t]/m.test(head)) score++;
  return score >= 2 ? 'md' : 'txt';
}

interface TextParseOptions {
  format: 'txt' | 'md' | 'html';
  explicitTitle?: string | null;
  explicitAuthor?: string | null;
  fallbackTitle?: string;
  baseUrl?: string;
  /** For HTML: extract the article-like content of a full page. */
  mainContent?: boolean;
  id?: string;
  bookFormat?: BookFormat;
}

function parseTextContent(text: string, opts: TextParseOptions): ParsedBook {
  let parsed: ParsedText;
  if (opts.format === 'html') {
    if (typeof DOMParser === 'undefined') throw new BookLoadError('parse', 'Reading HTML needs a browser.');
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const fullDocument = opts.mainContent ?? /<(?:html|body)[\s>]|<!doctype/i.test(text.slice(0, 2000));
    parsed = parseHtmlDocument(doc, { baseUrl: opts.baseUrl, mainContent: fullDocument });
  } else if (opts.format === 'md') {
    parsed = parseMarkdownBook(text);
  } else {
    parsed = parsePlainText(text);
  }
  const explicitTitle = opts.explicitTitle?.trim() || null;
  const detected = parsed.title ? tameShouting(parsed.title) : null;
  return finalizeBook(
    {
      title: explicitTitle ?? detected,
      author: opts.explicitAuthor?.trim() || (parsed.author ? tameShouting(parsed.author) : null),
      format: opts.bookFormat ?? opts.format,
      fallbackTitle: opts.fallbackTitle,
      id: opts.id,
    },
    parsed.drafts,
  );
}

function stamp(parsed: ParsedBook, source: Book['source']): Book {
  return { ...parsed, source, addedAt: Date.now() };
}

async function parseBytes(
  bytes: Uint8Array,
  kind: SourceKind,
  opts: { fallbackTitle: string; charset?: string | null; baseUrl?: string },
): Promise<ParsedBook> {
  if (kind === 'epub') {
    const { parseEpub } = await import('./epub');
    return parseEpub(toArrayBuffer(bytes), { fallbackTitle: opts.fallbackTitle });
  }
  if (kind === 'pdf') {
    const { parsePdf } = await import('./pdf');
    return parsePdf(toArrayBuffer(bytes), { fallbackTitle: opts.fallbackTitle });
  }
  const charset = opts.charset ?? (kind === 'html' ? sniffHtmlCharset(bytes) : null);
  const text = decodeText(bytes, charset);
  if (!text.trim()) throw new BookLoadError('empty', 'That file is empty.');
  const format = kind === 'auto' ? detectTextFormat(text) : kind;
  return parseTextContent(text, {
    format,
    fallbackTitle: opts.fallbackTitle,
    baseUrl: opts.baseUrl,
    mainContent: format === 'html' ? true : undefined,
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // A view over a whole buffer is handed on as is: copying a 200 MB PDF here (and again in
  // parsePdf, which must copy because pdf.js detaches its input) would triple peak memory.
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsArrayBuffer(blob);
  });
}

function tooLarge(bytes: number): BookLoadError {
  const mb = Math.round(bytes / (1024 * 1024));
  return new BookLoadError(
    'too-large',
    `That file is too large (${mb} MB). Gaze Reader can open books up to ${MAX_BOOK_BYTES / (1024 * 1024)} MB.`,
  );
}

// ─────────────────────────────── Public loaders ───────────────────────────────

/** Opens a user-picked file: .txt .md .markdown .html .htm .xhtml .epub .pdf (sniffed by content, too). */
export async function loadBookFromFile(file: File): Promise<Book> {
  if (file.size > MAX_BOOK_BYTES) throw tooLarge(file.size);
  if (file.size === 0) throw new BookLoadError('empty', 'That file is empty.');
  let buffer: ArrayBuffer;
  try {
    buffer = await readBlob(file);
  } catch (err) {
    throw new BookLoadError('parse', 'Your browser couldn’t read that file.', { cause: err });
  }
  const bytes = new Uint8Array(buffer);
  const kind = sniffKind(bytes, file.name, file.type);
  return stamp(await parseBytes(bytes, kind, { fallbackTitle: titleFromFileName(file.name) }), 'file');
}

/** Builds a book from pasted or programmatic text. `opts.title` wins over any detected title. */
export function loadBookFromText(
  text: string,
  opts: { title?: string; format?: 'txt' | 'md' | 'html'; source?: Book['source'] } = {},
): Book {
  if (!text || !text.trim()) throw new BookLoadError('empty', 'There’s no text to read yet — paste some first.');
  const format = opts.format ?? detectTextFormat(text);
  const parsed = parseTextContent(text, { format, explicitTitle: opts.title, fallbackTitle: 'Pasted text' });
  return stamp(parsed, opts.source ?? 'paste');
}

function normalizeUserUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new BookLoadError('invalid-url', 'Paste the address of a book or article first.');
  // "localhost:8080/book.txt" is a host and port, not a URL with the scheme "localhost:".
  const hostWithPort = /^[\w-]+(?:\.[\w-]+)*:\d{1,5}(?:[/?#]|$)/.test(trimmed);
  const hasScheme = !hostWithPort && /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const looksLikeDomain = hostWithPort || /^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#]|$)/.test(trimmed);
  // Local development servers speak plain http; everything else gets https.
  const local = /^(?:localhost|127(?:\.\d{1,3}){3})(?:[:/?#]|$)/i.test(trimmed);
  const candidate = !hasScheme && looksLikeDomain ? `${local ? 'http' : 'https'}://${trimmed}` : trimmed;
  let url: URL;
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : undefined;
    url = base ? new URL(candidate, base) : new URL(candidate);
  } catch {
    throw new BookLoadError('invalid-url', 'That doesn’t look like a web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BookLoadError('invalid-url', 'Only http:// and https:// addresses can be opened.');
  }
  return url;
}

const CORS_HINT =
  'Many websites don’t let other apps download their pages (a browser safety rule called CORS), or you may be offline. ' +
  'Try downloading the book or page and opening the file here — or use the Gaze Reader browser extension to read it right on the site.';

function httpError(status: number): BookLoadError {
  if (status === 404 || status === 410) return new BookLoadError('http', `Nothing was found at that address (${status}).`);
  if (status === 401 || status === 403) {
    return new BookLoadError(
      'http',
      `That site refused the download (${status}). It may need you to sign in. Download the file yourself and open it here, or use the Gaze Reader browser extension on the page.`,
    );
  }
  if (status === 429) return new BookLoadError('http', 'That site is rate-limiting requests (429). Try again in a minute.');
  return new BookLoadError('http', `The site answered with an error (${status}). Try again later, or download the file and open it here.`);
}

interface FetchedBytes {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
}

/**
 * Reads a response body chunk by chunk so the size cap applies while downloading
 * (servers don't always send Content-Length) and `onProgress` can keep an idle
 * timer alive: a big book on a slow connection is fine as long as data keeps coming.
 */
async function readBody(res: Response, onProgress: () => void): Promise<Uint8Array> {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_BOOK_BYTES) throw tooLarge(buffer.byteLength);
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BOOK_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw tooLarge(total);
    }
    chunks.push(value);
    onProgress();
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function fetchBytes(url: string, timeoutMs: number, signal?: AbortSignal): Promise<FetchedBytes> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // An idle timeout: re-armed whenever data arrives, so only a stalled connection trips it.
  const armTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  armTimer();
  const forwardAbort = (): void => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });

  const mapError = (err: unknown): unknown => {
    if (signal?.aborted) return err; // the caller cancelled: let their AbortError through untouched
    if (timedOut) {
      return new BookLoadError('timeout', `That address took too long to respond (over ${Math.round(timeoutMs / 1000)} s). ${CORS_HINT}`, {
        cause: err,
      });
    }
    if (err instanceof BookLoadError) return err;
    return new BookLoadError('network', `Couldn’t download that address. ${CORS_HINT}`, { cause: err });
  };

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'follow',
      });
    } catch (err) {
      throw mapError(err);
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw httpError(res.status);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BOOK_BYTES) {
      void res.body?.cancel().catch(() => undefined);
      throw tooLarge(declared);
    }
    armTimer();
    let bytes: Uint8Array;
    try {
      bytes = await readBody(res, armTimer);
    } catch (err) {
      throw mapError(err);
    }
    return { bytes, contentType: res.headers.get('content-type') ?? '', finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function titleFromUrl(url: URL): string {
  const segment = url.pathname.split('/').filter(Boolean).pop();
  let decoded = segment ?? '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep raw */
  }
  const fromPath = decoded ? titleFromFileName(decoded) : '';
  return fromPath && fromPath !== 'Untitled' && !/^index$/i.test(fromPath) ? fromPath : url.hostname.replace(/^www\./, '');
}

/**
 * Downloads a book or article (HTML, text, Markdown, EPUB or PDF). Web pages are
 * reduced to their main article-like content. Network/CORS failures and timeouts
 * become friendly BookLoadErrors that suggest downloading the file or using the extension.
 */
export async function loadBookFromUrl(
  url: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Book> {
  const target = normalizeUserUrl(url);
  const fetched = await fetchBytes(target.href, opts.timeoutMs ?? DEFAULT_URL_TIMEOUT_MS, opts.signal);
  if (fetched.bytes.length === 0) throw new BookLoadError('empty', 'That address returned an empty page.');
  let finalUrl: URL;
  try {
    finalUrl = new URL(fetched.finalUrl);
  } catch {
    finalUrl = target;
  }
  const kind = sniffKind(fetched.bytes, finalUrl.pathname, fetched.contentType);
  const charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(fetched.contentType)?.[1] ?? null;
  const parsed = await parseBytes(fetched.bytes, kind, {
    fallbackTitle: titleFromUrl(finalUrl),
    charset,
    baseUrl: finalUrl.href,
  });
  return stamp(parsed, 'url');
}

// ──────────────────────────────── Sample books ────────────────────────────────

export interface SampleBookInfo {
  id: string;
  title: string;
  author: string;
  blurb: string;
  file: string;
}

function samplesBase(): URL {
  const base =
    (typeof document !== 'undefined' && document.baseURI) ||
    (typeof location !== 'undefined' ? location.href : 'http://localhost/');
  return new URL('samples/', base);
}

let sampleIndex: Promise<SampleBookInfo[]> | null = null;

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function fetchSampleIndex(): Promise<SampleBookInfo[]> {
  const base = samplesBase();
  const { bytes } = await fetchBytes(new URL('index.json', base).href, 15_000);
  let data: unknown;
  try {
    data = JSON.parse(decodeText(bytes));
  } catch (err) {
    throw new BookLoadError('parse', 'The sample book list is damaged.', { cause: err });
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { books?: unknown }).books)
      ? ((data as { books: unknown[] }).books)
      : [];
  const out: SampleBookInfo[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = asString(e.id);
    const title = asString(e.title);
    const file = asString(e.file);
    if (!id || !title || !file || !/^[\w.-]+$/.test(id)) continue;
    // Samples are our own assets: never follow an index entry off-origin.
    if (new URL(file, base).origin !== base.origin) continue;
    out.push({ id, title, author: asString(e.author) ?? '', blurb: asString(e.blurb) ?? '', file });
  }
  return out;
}

/** Lists the bundled sample books (samples/index.json). */
export async function listSampleBooks(): Promise<SampleBookInfo[]> {
  if (!sampleIndex) {
    sampleIndex = fetchSampleIndex().catch((err: unknown) => {
      sampleIndex = null; // allow a retry after a failure
      throw err;
    });
  }
  return (await sampleIndex).map((s) => ({ ...s }));
}

/** Loads a bundled sample (Markdown by default) as a Book with the id "sample-<id>". */
export async function loadSampleBook(id: string): Promise<Book> {
  const info = (await listSampleBooks()).find((s) => s.id === id);
  if (!info) throw new BookLoadError('empty', 'That sample book isn’t available.');
  const { bytes } = await fetchBytes(new URL(info.file, samplesBase()).href, 15_000);
  const text = decodeText(bytes);
  const ext = extensionOf(info.file);
  const format: 'txt' | 'md' | 'html' = /^html?$/.test(ext) ? 'html' : ext === 'txt' ? 'txt' : 'md';
  const parsed = parseTextContent(text, {
    format,
    explicitTitle: info.title,
    explicitAuthor: info.author || null,
    id: `sample-${info.id}`,
    bookFormat: 'sample',
  });
  return stamp(parsed, 'sample');
}
