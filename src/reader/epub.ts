import JSZip from 'jszip';
import {
  BookLoadError,
  collapseWhitespace,
  decodeText,
  draftFromElement,
  finalizeBook,
  tameShouting,
  textOfNode,
  type ChapterDraft,
  type ParseOptions,
  type ParsedBook,
} from './bookLoader';
import { SANITIZE_ID_PREFIX, sanitizeId, sanitizeToElement } from './sanitize';

/**
 * EPUB 2/3 → Book. META-INF/container.xml → OPF package (metadata, manifest,
 * spine) → each linear spine document parsed as XHTML (HTML fallback for sloppy
 * files) → <body> → sanitizer. Cross-chapter links ("notes.xhtml#n3") are
 * rewritten to in-book fragments so footnotes keep working in the single
 * scrolling column.
 */

interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: Set<string>;
}

const CONTENT_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
  'application/xml',
  'text/xml',
  'application/x-dtbook+xml',
  'text/x-oeb1-document',
]);

/** Font obfuscation is not DRM: the text is readable, only embedded fonts are scrambled. */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// ─────────────────────────────── XML helpers ───────────────────────────────

function hasParserError(doc: Document): boolean {
  return doc.getElementsByTagName('parsererror').length > 0;
}

/**
 * XHTML self-closing tags (<title/>, <a id="x"/>) mean something else to an HTML
 * parser — "<title/>" would swallow the whole body — so expand them first.
 */
function expandSelfClosing(markup: string): string {
  // One lazy group up to "/>" (no separate \s* before it, which would backtrack quadratically on long tags).
  return markup.replace(/<([A-Za-z][\w:.-]*)(\s[^<>]*?)?\/>/g, (whole, tag: string, attrs?: string) =>
    VOID_TAGS.has(tag.toLowerCase()) ? whole : `<${tag}${attrs ?? ''}></${tag}>`,
  );
}

function parseMarkup(text: string, type: DOMParserSupportedType): Document {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, type);
  if (!hasParserError(doc)) return doc;
  // Real-world EPUBs contain HTML entities (&nbsp;) and other XML errors: parse leniently.
  return parser.parseFromString(expandSelfClosing(text), 'text/html');
}

/** Elements by local name, tolerant of prefixes ("dc:title") and of the HTML-parser fallback. */
function findAll(root: Document | Element, name: string): Element[] {
  const out: Element[] = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const local = all[i].localName.toLowerCase();
    if (local === name || local.endsWith(`:${name}`)) out.push(all[i]);
  }
  return out;
}

function attr(el: Element, name: string): string | null {
  const direct = el.getAttribute(name);
  if (direct !== null) return direct;
  for (const a of Array.from(el.attributes)) {
    const local = a.localName.toLowerCase();
    if (local === name || local.endsWith(`:${name}`)) return a.value;
  }
  return null;
}

function text(el: Element | undefined | null): string {
  return el ? collapseWhitespace(el.textContent ?? '') : '';
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i + 1) : '';
}

/** Resolves a manifest/link href against a directory inside the ZIP ("" when it points outside). */
export function resolveZipPath(baseDir: string, href: string): string {
  const clean = href.replace(/[?#].*$/, '');
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    /* keep the raw path */
  }
  if (!decoded || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) return '';
  const joined = decoded.startsWith('/') ? decoded.slice(1) : baseDir + decoded;
  const out: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

// ─────────────────────────────── ZIP access ────────────────────────────────

/**
 * MAX_BOOK_BYTES limits the ZIP; a 2 MB EPUB can still inflate to 500 MB (deflate reaches
 * ~1000:1), which would freeze and then crash the tab. These cap what is unpacked instead.
 */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/** Public JSZip API (async() is built on it) that jszip's index.d.ts leaves out. */
interface StreamableEntry {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
}

function damagedEntry(cause: unknown): BookLoadError {
  return new BookLoadError('parse', 'This file isn’t a readable EPUB (part of its ZIP container is damaged).', { cause });
}

class EpubArchive {
  private readonly lower = new Map<string, JSZip.JSZipObject>();
  /** Bytes inflated so far for this book, across entries. */
  private inflated = 0;

  constructor(private readonly zip: JSZip) {
    zip.forEach((path, file) => {
      if (!file.dir) this.lower.set(path.toLowerCase(), file);
    });
  }

  has(path: string): boolean {
    return this.entry(path) !== null;
  }

  /** Exact path first, then case-insensitively (many EPUBs disagree with themselves about case). */
  private entry(path: string): JSZip.JSZipObject | null {
    return this.zip.file(path) ?? this.lower.get(path.toLowerCase()) ?? null;
  }

  async text(path: string): Promise<string | null> {
    const file = this.entry(path);
    if (!file) return null;
    return decodeText(await this.inflate(file));
  }

  /** Inflates one entry, stopping as soon as it (or the book so far) passes the caps. */
  private inflate(file: JSZip.JSZipObject): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let settled = false;
      let stream: JSZip.JSZipStreamHelper<Uint8Array>;
      try {
        stream = (file as unknown as StreamableEntry).internalStream('uint8array');
      } catch (err) {
        reject(damagedEntry(err));
        return;
      }
      stream
        .on('data', (chunk) => {
          if (settled) return;
          size += chunk.byteLength;
          this.inflated += chunk.byteLength;
          if (size > MAX_ENTRY_BYTES || this.inflated > MAX_INFLATED_BYTES) {
            settled = true;
            stream.pause();
            reject(new BookLoadError('too-large', 'This EPUB unpacks to far more text than a book holds, so Gaze Reader can’t open it.'));
            return;
          }
          chunks.push(chunk);
        })
        .on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(damagedEntry(err));
        })
        .on('end', () => {
          if (settled) return;
          settled = true;
          const out = new Uint8Array(size);
          let offset = 0;
          for (const c of chunks) {
            out.set(c, offset);
            offset += c.byteLength;
          }
          resolve(out);
        })
        .resume();
    });
  }

  paths(): string[] {
    return [...this.lower.keys()];
  }
}

async function openArchive(data: ArrayBuffer): Promise<EpubArchive> {
  try {
    return new EpubArchive(await JSZip.loadAsync(data));
  } catch (err) {
    throw new BookLoadError('parse', 'This file isn’t a readable EPUB (its ZIP container is damaged).', { cause: err });
  }
}

async function assertNotEncrypted(archive: EpubArchive): Promise<void> {
  const drm = new BookLoadError(
    'drm',
    'This EPUB is protected by DRM, so its text is encrypted. Gaze Reader can only open DRM-free books.',
  );
  if (archive.has('META-INF/sinf.xml')) throw drm; // Apple FairPlay
  const xml = await archive.text('META-INF/encryption.xml');
  if (!xml) return;
  const doc = parseMarkup(xml, 'application/xml');
  for (const data of findAll(doc, 'encrypteddata')) {
    const method = attr(findAll(data, 'encryptionmethod')[0] ?? data, 'algorithm') ?? '';
    if (FONT_OBFUSCATION.has(method)) continue;
    const uris = findAll(data, 'cipherreference').map((c) => attr(c, 'uri') ?? '');
    if (uris.some((u) => /\.(?:x?html?|xml|opf|ncx)$/i.test(u))) throw drm;
  }
}

async function findPackagePath(archive: EpubArchive): Promise<string> {
  const container = await archive.text('META-INF/container.xml');
  if (container) {
    const doc = parseMarkup(container, 'application/xml');
    const rootfiles = findAll(doc, 'rootfile');
    const preferred =
      rootfiles.find((r) => (attr(r, 'media-type') ?? '').toLowerCase() === 'application/oebps-package+xml') ?? rootfiles[0];
    const fullPath = preferred ? attr(preferred, 'full-path') : null;
    if (fullPath) {
      const resolved = resolveZipPath('', fullPath);
      if (archive.has(resolved)) return resolved;
    }
  }
  const opf = archive.paths().find((p) => p.endsWith('.opf'));
  if (!opf) throw new BookLoadError('parse', 'This EPUB is missing its package file, so its chapters can’t be found.');
  return opf;
}

// ───────────────────────────── Package document ─────────────────────────────

interface PackageInfo {
  title: string | null;
  author: string | null;
  language: string | null;
  manifest: Map<string, ManifestItem>;
  spine: ManifestItem[];
  ncx: ManifestItem | null;
}

function readPackage(opf: Document, opfPath: string): PackageInfo {
  const baseDir = dirOf(opfPath);
  const refines = findAll(opf, 'meta')
    .map((m) => ({ target: (attr(m, 'refines') ?? '').replace(/^#/, ''), property: attr(m, 'property') ?? '', value: text(m) }))
    .filter((r) => r.target);
  const refined = (id: string | null, property: string): string | null =>
    (id && refines.find((r) => r.target === id && r.property === property)?.value) || null;

  const titles = findAll(opf, 'title').filter((t) => text(t));
  const mainTitle =
    titles.find((t) => refined(t.getAttribute('id'), 'title-type') === 'main') ??
    titles.find((t) => !/^(?:subtitle|short|collection|edition|expanded)$/.test(refined(t.getAttribute('id'), 'title-type') ?? '')) ??
    titles[0];

  const authors: string[] = [];
  for (const creator of findAll(opf, 'creator')) {
    const role = (attr(creator, 'role') ?? refined(creator.getAttribute('id'), 'role') ?? 'aut').toLowerCase();
    const name = text(creator);
    if (name && role === 'aut' && !authors.includes(name)) authors.push(name);
  }
  const author = authors.length === 0 ? null : authors.length <= 3 ? authors.join(', ') : `${authors.slice(0, 3).join(', ')} et al.`;

  const manifest = new Map<string, ManifestItem>();
  for (const item of findAll(opf, 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (!id || !href) continue;
    const path = resolveZipPath(baseDir, href);
    if (!path) continue;
    manifest.set(id, {
      id,
      path,
      mediaType: (attr(item, 'media-type') ?? '').toLowerCase(),
      properties: new Set((attr(item, 'properties') ?? '').split(/\s+/).filter(Boolean)),
    });
  }

  const isContent = (m: ManifestItem): boolean =>
    !m.properties.has('nav') &&
    (CONTENT_TYPES.has(m.mediaType) || (!m.mediaType && /\.(?:x?html?|xml)$/i.test(m.path)));

  const spineEl = findAll(opf, 'spine')[0];
  const spine: ManifestItem[] = [];
  if (spineEl) {
    for (const ref of findAll(spineEl, 'itemref')) {
      if ((attr(ref, 'linear') ?? '').toLowerCase() === 'no') continue;
      const item = manifest.get(attr(ref, 'idref') ?? '');
      if (item && isContent(item) && !spine.includes(item)) spine.push(item);
    }
  }
  if (spine.length === 0) {
    // No usable spine: fall back to the manifest order of the content documents.
    for (const item of manifest.values()) if (isContent(item)) spine.push(item);
  }

  const tocId = spineEl ? attr(spineEl, 'toc') : null;
  const ncx =
    (tocId ? manifest.get(tocId) : undefined) ??
    [...manifest.values()].find((m) => m.mediaType === 'application/x-dtbncx+xml') ??
    null;

  return {
    title: text(mainTitle) || null,
    author,
    language: text(findAll(opf, 'language')[0]) || null,
    manifest,
    spine,
    ncx,
  };
}

/** Chapter labels from the EPUB3 nav document or the EPUB2 NCX, keyed by content-document path. */
async function readTocLabels(archive: EpubArchive, pkg: PackageInfo): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const add = (baseDir: string, href: string | null, label: string): void => {
    if (!href || !label) return;
    const path = resolveZipPath(baseDir, href);
    if (path && !labels.has(path)) labels.set(path, label.slice(0, 160));
  };
  try {
    const nav = [...pkg.manifest.values()].find((m) => m.properties.has('nav'));
    const navText = nav ? await archive.text(nav.path) : null;
    if (nav && navText) {
      const doc = parseMarkup(navText, 'application/xhtml+xml');
      const navs = findAll(doc, 'nav');
      const toc = navs.find((n) => /\btoc\b/.test(attr(n, 'type') ?? '')) ?? navs[0];
      if (toc) for (const a of findAll(toc, 'a')) add(dirOf(nav.path), attr(a, 'href'), text(a));
    }
    const ncxText = pkg.ncx ? await archive.text(pkg.ncx.path) : null;
    if (pkg.ncx && ncxText) {
      const doc = parseMarkup(ncxText, 'application/xml');
      for (const point of findAll(doc, 'navpoint')) {
        const label = text(findAll(point, 'text')[0]);
        const content = findAll(point, 'content')[0];
        add(dirOf(pkg.ncx.path), content ? attr(content, 'src') : null, label);
      }
    }
  } catch {
    // Labels are a nicety; a broken TOC must never break the book.
  }
  return labels;
}

// ──────────────────────────────── Chapters ─────────────────────────────────

const LANG_RE = /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i;

function chapterTitle(container: Element): string | null {
  const heading = container.querySelector('h1, h2, h3, h4, h5, h6');
  if (!heading) return null;
  const title = collapseWhitespace(textOfNode(heading));
  if (!title) return null;
  // Only a heading near the top names the chapter; a subsection deep inside does not.
  const before = collapseWhitespace(textOfNode(container)).indexOf(title);
  return before >= 0 && before <= 200 ? title.slice(0, 160) : null;
}

function idPrefixFor(spineIndex: number): string {
  return `${SANITIZE_ID_PREFIX}s${spineIndex}-`;
}

/** Parses an EPUB (2 or 3) into a Book: DRM-free, text only, sanitized. */
export async function parseEpub(data: ArrayBuffer, opts: ParseOptions = {}): Promise<ParsedBook> {
  if (typeof DOMParser === 'undefined') throw new BookLoadError('parse', 'Reading EPUB files needs a browser.');
  const archive = await openArchive(data);
  await assertNotEncrypted(archive);

  const opfPath = await findPackagePath(archive);
  const opfText = await archive.text(opfPath);
  if (!opfText) throw new BookLoadError('parse', 'This EPUB’s package file is unreadable.');
  const pkg = readPackage(parseMarkup(opfText, 'application/xml'), opfPath);
  if (pkg.spine.length === 0) throw new BookLoadError('empty', 'This EPUB doesn’t list any chapters.');

  const labels = await readTocLabels(archive, pkg);
  const spineIndex = new Map(pkg.spine.map((item, i) => [item.path, i]));
  const drafts: ChapterDraft[] = [];

  for (let i = 0; i < pkg.spine.length; i++) {
    const item = pkg.spine[i];
    const markup = await archive.text(item.path);
    if (markup === null) continue;
    const doc = parseMarkup(markup, item.mediaType === 'text/html' ? 'text/html' : 'application/xhtml+xml');
    const body = findAll(doc, 'body')[0] ?? doc.documentElement;
    if (!body) continue;

    const dir = dirOf(item.path);
    const rewriteHref = (href: string): string | null => {
      if (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href; // same chapter, or absolute (validated later)
      const target = spineIndex.get(resolveZipPath(dir, href));
      if (target === undefined) return null; // an image, stylesheet or non-linear document
      const hash = href.indexOf('#');
      const fragment = hash >= 0 ? href.slice(hash + 1) : '';
      return `#${idPrefixFor(target)}${fragment || 'top'}`;
    };

    const container = sanitizeToElement(body, { idPrefix: idPrefixFor(i), rewriteHref });
    if (!/\S/.test(container.textContent ?? '')) continue; // cover images, blank pages

    // Link targets for the start of this document: "chapter.xhtml" (→ …top) and ids that sit on
    // <html> or <body> ("chapter.xhtml#ch2"), which the sanitizer never sees since it keeps children only.
    const targets = new Set([`${idPrefixFor(i)}top`]);
    for (const el of [doc.documentElement, body]) {
      const raw = el ? attr(el, 'id') : null;
      const id = raw ? sanitizeId(raw, idPrefixFor(i)) : null;
      if (id) targets.add(id);
    }
    container.prepend(
      ...[...targets].map((id) => {
        const a = container.ownerDocument.createElement('a');
        a.id = id;
        return a;
      }),
    );

    const docLang = attr(doc.documentElement, 'lang') ?? attr(body, 'lang') ?? pkg.language;
    if (docLang && LANG_RE.test(docLang.trim())) {
      const wrapper = container.ownerDocument.createElement('div');
      wrapper.setAttribute('lang', docLang.trim());
      // Moved one by one: a single-file book can have 100 000+ top-level nodes, too many to spread.
      while (container.firstChild) wrapper.appendChild(container.firstChild);
      container.append(wrapper);
    }

    drafts.push(draftFromElement(container, chapterTitle(container) ?? labels.get(item.path) ?? null));
  }

  return finalizeBook(
    {
      title: pkg.title ? tameShouting(pkg.title) : null,
      author: pkg.author ? tameShouting(pkg.author) : null,
      format: 'epub',
      fallbackTitle: opts.fallbackTitle,
    },
    drafts,
  );
}
