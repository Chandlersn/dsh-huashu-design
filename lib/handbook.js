import { lexer } from 'marked';

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;
const DOCUMENT_EXTENSION = /\.(?:md|markdown)$/i;
const ASSET_PREFIX = '/huashu-design/assets/';
const UNSAFE_CHARACTERS = /[\\\p{Cc}\p{Cf}]/u;
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•',
});

// Text only: never parse an HTML document or execute a token's raw content.
export function handbookText(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (name[0] !== '#') return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : entity;
    const number = name[1].toLowerCase() === 'x'
      ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number) : '\ufffd';
  });
}

function tokenText(token) {
  if (token.type === 'html') return '';
  if (token.type === 'space' || token.type === 'hr' || token.type === 'br') return '\n';
  if (token.type === 'code' || token.type === 'codespan') return token.text || '';
  if (token.type === 'table') {
    return [...token.header, ...token.rows.flat()].map(tokenText).join(' ');
  }
  if (token.type === 'list') return token.items.map(tokenText).join('\n');
  if (token.tokens) {
    const separator = token.type === 'blockquote' || token.type === 'list_item' ? '\n' : '';
    return token.tokens.map(tokenText).join(separator);
  }
  return handbookText(token.text || '');
}

function visitTokens(tokens, visit) {
  for (const token of tokens) {
    visit(token);
    if (token.tokens) visitTokens(token.tokens, visit);
    if (token.items) visitTokens(token.items, visit);
    if (token.type === 'table') {
      for (const cell of [...token.header, ...token.rows.flat()]) visitTokens(cell.tokens, visit);
    }
  }
}

function withoutFrontmatter(markdown) {
  const opening = markdown.match(/^\uFEFF?---[ \t]*\r?\n/);
  if (!opening) return markdown.replace(/^\uFEFF/, '');
  const rest = markdown.slice(opening[0].length);
  const closing = rest.match(/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m);
  return closing ? rest.slice(closing.index + closing[0].length) : markdown.replace(/^\uFEFF/, '');
}

function headingSlug(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .trim().replace(/[\s-]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
}

/**
 * Return marked GFM tokens for a text-only React renderer. Only heading.id is added;
 * raw/text/inline tokens (including inert HTML) remain exactly as marked produced them.
 * wordCount estimates reading effort: CJK characters plus other word/number groups,
 * including visible code and image captions, excluding frontmatter and HTML tokens.
 */
export function parseHandbook(markdown = '') {
  if (typeof markdown !== 'string') throw new TypeError('Handbook markdown must be a string.');
  const tokens = lexer(withoutFrontmatter(markdown), { gfm: true });
  const toc = [];
  const ids = new Set();
  const nextSuffix = new Map();
  visitTokens(tokens, token => {
    if (token.type !== 'heading') return;
    const text = tokenText(token).replace(/\s+/gu, ' ').trim();
    const base = headingSlug(text);
    let id = base;
    let suffix = nextSuffix.get(base) || 2;
    while (ids.has(id)) id = `${base}-${suffix++}`;
    nextSuffix.set(base, suffix);
    ids.add(id);
    token.id = id;
    toc.push({ id, depth: token.depth, text });
  });
  const visibleText = tokens.map(tokenText).join('\n');
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const cjkCount = visibleText.match(cjk)?.length || 0;
  const otherWords = visibleText.replace(cjk, ' ').match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length || 0;
  const title = toc.find(entry => entry.depth === 1 && entry.text)?.text
    || toc.find(entry => entry.text)?.text || '设计手册';
  return { title, tokens, toc, wordCount: cjkCount + otherWords };
}

function validRootPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
    && !value.startsWith('/') && !UNSAFE_CHARACTERS.test(value) && !/[:%]/.test(value)
    // Win32 trims trailing spaces/dots; reject those aliases before routing them.
    && value.split('/').every(part => part && part !== '.' && part !== '..'
      && part.trimEnd() === part && !part.endsWith('.'));
}

// Inspect successive decodings as well as the literal input: %255c / %2500 must
// never hide a backslash/control from the first validation pass.
function forbiddenCharacters(value) {
  for (let pass = 0; pass < 8; pass++) {
    if (UNSAFE_CHARACTERS.test(value)) return true;
    if (!/%[\da-f]{2}/i.test(value)) return false;
    try { value = decodeURIComponent(value); } catch { return true; }
  }
  return true;
}

function decodedPath(value) {
  // Encoded separators and encoded dot segments are ambiguous across URL/router/
  // filesystem decoders. Literal ../ is handled below with a strict root boundary.
  if (/%(?:2f|5c)/i.test(value)) return null;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (UNSAFE_CHARACTERS.test(decoded) || /[:%]/.test(decoded)) return null;
  if (/%2e/i.test(value) && decoded.split('/').some(part => part === '.' || part === '..')) return null;
  return decoded;
}

function assetTarget(path) {
  return { kind: 'image', path, url: ASSET_PREFIX + path.split('/').map(encodeURIComponent).join('/') };
}

/**
 * Classify a handbook link; never return a navigable Host path for documents or
 * unsupported sources. currentPath is a decoded, canonical upstream-root-relative
 * resource identifier, e.g. references/modules/web.md (no leading slash).
 * Relative queries do not affect resource lookup. Fragments are decoded once and
 * otherwise preserved for the renderer's heading matching. No filesystem/DOM I/O.
 */
export function resolveHandbookTarget(href, currentPath) {
  const blocked = { kind: 'blocked' };
  if (!validRootPath(currentPath) || typeof href !== 'string' || !href || href.length > 8192) return blocked;
  if (forbiddenCharacters(href)) return blocked;
  href = href.trim();
  if (!href || href.startsWith('//')) return blocked;

  if (SCHEME.test(href)) {
    let url;
    try { url = new URL(href); } catch { return blocked; }
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return blocked;
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !/^https?:\/\//i.test(href)) return blocked;
    return { kind: 'external', href };
  }

  const hash = href.indexOf('#');
  const beforeFragment = hash < 0 ? href : href.slice(0, hash);
  let fragment;
  if (hash >= 0) {
    try { fragment = decodeURIComponent(href.slice(hash + 1)); } catch { return blocked; }
  }
  const query = beforeFragment.indexOf('?');
  const pathname = query < 0 ? beforeFragment : beforeFragment.slice(0, query);
  if (!pathname && hash >= 0) return { kind: 'anchor', fragment };

  if (pathname.startsWith('/')) {
    if (!pathname.startsWith(ASSET_PREFIX)) return blocked;
    const path = decodedPath(pathname.slice(ASSET_PREFIX.length));
    if (!validRootPath(path) || !IMAGE_EXTENSION.test(path)) return blocked;
    const target = assetTarget(path);
    return target.url === pathname ? target : blocked;
  }

  const relative = decodedPath(pathname);
  if (relative === null || relative.startsWith('/')) return blocked;
  const parts = currentPath.split('/');
  if (pathname) parts.pop();
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return blocked;
      parts.pop();
    } else parts.push(part);
  }
  const path = parts.join('/');
  if (!validRootPath(path)) return blocked;
  // A URL ending in /, /. or /.. names a directory, even if its name ends .md.
  if (pathname && ['', '.', '..'].includes(relative.split('/').at(-1))) return { kind: 'unsupported', path };
  if (DOCUMENT_EXTENSION.test(path)) {
    return { kind: 'document', path, ...(fragment === undefined ? {} : { fragment }) };
  }
  if (IMAGE_EXTENSION.test(path)) return assetTarget(path);
  return { kind: 'unsupported', path };
}
