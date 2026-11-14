import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { LIMITS, OperationError } from './core.js';

export const PREVIEW_LIMITS = Object.freeze({ sourceBytes: LIMITS.sourceBytes, resourceBytes: 16 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, entries: 100 });
const MIME = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' });
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const keyOf = value => process.platform === 'win32' ? value.toLowerCase() : value;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const fail = (code, message, status = 400) => { throw new OperationError(code, message, status); };
const unsafe = () => fail('UNSAFE_PREVIEW_PATH', 'Preview resources must remain inside the registered work directory without links or unsafe paths.', 403);
const changed = () => fail('PREVIEW_FILE_CHANGED', 'A preview file or its directory changed while reading; reload the work.', 409);

async function location(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) unsafe();
  const absolute = path.resolve(file), root = path.parse(absolute).root;
  const segments = path.relative(root, absolute).split(path.sep);
  const parents = [];
  let current = root, info;
  for (let index = -1; index < segments.length; index++) {
    if (index >= 0) current = path.join(current, segments[index]);
    try { info = await fs.lstat(current); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('PREVIEW_NOT_FOUND', 'A registered preview file or local resource is missing.', 404); throw error; }
    if (info.isSymbolicLink()) unsafe();
    if (index < segments.length - 1) {
      if (!info.isDirectory()) unsafe();
      parents.push({ path: current, info });
    } else if (!info.isFile()) fail('INVALID_PREVIEW_FILE', 'Preview files and resources must be ordinary files.', 415);
  }
  if (keyOf(await fs.realpath(absolute)) !== keyOf(absolute)) unsafe();
  return { path: absolute, parents, info };
}
function compareLocation(before, after) {
  if (keyOf(before.path) !== keyOf(after.path) || before.parents.length !== after.parents.length || before.parents.some((entry, i) => keyOf(entry.path) !== keyOf(after.parents[i].path) || !sameFile(entry.info, after.parents[i].info))) unsafe();
  if (!unchanged(before.info, after.info)) changed();
}
async function verify(snapshot) { compareLocation(snapshot, await location(snapshot.path)); }
async function snapshot(file, max, code, reserve) {
  const before = await location(file);
  let handle;
  try { handle = await fs.open(before.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code === 'ELOOP') unsafe(); if (error.code === 'ENOENT') changed(); throw error; }
  try {
    const info = await handle.stat();
    if (!unchanged(before.info, info)) changed();
    if (info.size > max) fail(code, `Preview file exceeds the ${max}-byte limit; it has not been truncated.`, 413);
    if (reserve) reserve(info.size);
    // One extra byte detects growth without permitting an unbounded readFile.
    const bytes = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (!unchanged(info, after) || used !== info.size) changed();
    compareLocation(before, await location(file));
    return { ...before, bytes: bytes.subarray(0, used) };
  } finally { await handle.close(); }
}
function decode(bytes) {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (value.includes('\0')) fail('BINARY_PREVIEW_SOURCE', 'HTML and CSS previews require valid UTF-8 text.', 415);
    return value;
  } catch (error) { if (error instanceof OperationError) throw error; fail('BINARY_PREVIEW_SOURCE', 'HTML and CSS previews require valid UTF-8 text.', 415); }
}
const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', colon: ':', sol: '/', bsol: '\\', period: '.', percnt: '%', Tab: '\t', NewLine: '\n', num: '#', quest: '?' };
function entities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]*);?/gi, (raw, entity) => {
    if (entity.startsWith('#')) {
      const number = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '\ufffd';
    }
    return Object.hasOwn(ENTITIES, entity) ? ENTITIES[entity] : raw;
  });
}
const escapeAttr = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// A small HTML tokenizer keeps comments and raw-text script/style bodies intact;
// only resource-bearing tags/attributes are rewritten, not JavaScript strings.
function tagAt(html, start) {
  const head = /^<(\/?)([a-z][\w:-]*)/i.exec(html.slice(start));
  if (!head) return null;
  let cursor = start + head[0].length, quote = '';
  for (; cursor < html.length; cursor++) {
    const char = html[cursor];
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '>') break;
  }
  if (cursor === html.length) fail('INVALID_PREVIEW_HTML', 'An HTML resource tag is incomplete.', 422);
  const raw = html.slice(start, cursor + 1), attrs = [];
  let index = head[0].length;
  while (index < raw.length - 1) {
    while (/\s/.test(raw[index] || '') || raw[index] === '/') index++;
    if (index >= raw.length - 1) break;
    const match = /^[^\s=/>]+/.exec(raw.slice(index));
    if (!match) { index++; continue; }
    const name = match[0]; index += name.length;
    while (/\s/.test(raw[index] || '')) index++;
    let value = null;
    if (raw[index] === '=') {
      index++; while (/\s/.test(raw[index] || '')) index++;
      const q = raw[index];
      if (q === '"' || q === "'") { const end = raw.indexOf(q, ++index); value = raw.slice(index, end); index = end + 1; }
      else { const part = /^[^\s>]+/.exec(raw.slice(index)); value = part?.[0] || ''; index += value.length; }
      value = entities(value);
    }
    if (!attrs.some(attr => attr.name.toLowerCase() === name.toLowerCase())) attrs.push({ name, value });
  }
  return { name: head[2].toLowerCase(), closing: Boolean(head[1]), attrs, raw, end: cursor + 1, selfClosing: /\/\s*>$/.test(raw) };
}
const attribute = (tag, name) => tag.attrs.find(attr => attr.name.toLowerCase() === name);
function setAttribute(tag, name, value) {
  tag.attrs = tag.attrs.filter(attr => attr.name.toLowerCase() !== name);
  if (value !== null) tag.attrs.push({ name, value });
}
function serializeTag(tag) {
  return `<${tag.name}${tag.attrs.map(attr => attr.value === null ? ` ${attr.name}` : ` ${attr.name}="${escapeAttr(attr.value)}"`).join('')}${tag.selfClosing ? ' /' : ''}>`;
}
function rawEnd(html, start, name) {
  const match = new RegExp(`</${name}\\s*>`, 'ig'); match.lastIndex = start;
  const found = match.exec(html);
  return found ? { start: found.index, end: match.lastIndex, close: found[0] } : { start: html.length, end: html.length, close: '' };
}

function cssWord(css, start) {
  let index = start, value = '';
  while (index < css.length) {
    if (/[\w-]/.test(css[index])) { value += css[index++]; continue; }
    if (css[index] !== '\\') break;
    const hex = /^[\da-f]{1,6}(?:\s)?/i.exec(css.slice(index + 1));
    if (hex) { const number = parseInt(hex[0], 16); value += number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '\ufffd'; index += hex[0].length + 1; }
    else if (css[index + 1] && !/[\r\n\f]/.test(css[index + 1])) { value += css[index + 1]; index += 2; }
    else break;
  }
  return { value: value.toLowerCase(), end: index };
}
function cssStringEnd(css, start) {
  const quote = css[start];
  for (let i = start + 1; i < css.length; i++) {
    if (css[i] === '\\') { i++; continue; }
    if (css[i] === quote) return i + 1;
  }
  fail('INVALID_PREVIEW_CSS', 'A CSS resource string is incomplete.', 422);
}
function cssStatementEnd(css, start) {
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css.startsWith('/*', i)) { const end = css.indexOf('*/', i + 2); if (end < 0) return css.length; i = end + 1; }
    else if (css[i] === '"' || css[i] === "'") i = cssStringEnd(css, i) - 1;
    else if (css[i] === '(') depth++;
    else if (css[i] === ')') depth--;
    else if (css[i] === ';' && depth === 0) return i + 1;
    else if (css[i] === '}' && depth === 0) return i;
  }
  return css.length;
}
async function inlineCss(css, base, resource, warn) {
  let output = '', index = 0;
  while (index < css.length) {
    if (css.startsWith('/*', index)) { const at = css.indexOf('*/', index + 2), end = at < 0 ? css.length : at + 2; output += css.slice(index, end); index = end; continue; }
    if (css[index] === '"' || css[index] === "'") { const end = cssStringEnd(css, index); output += css.slice(index, end); index = end; continue; }
    if (css[index] === '@') {
      const word = cssWord(css, index + 1);
      if (word.value === 'import') { warn('CSS @import was omitted; use a local stylesheet link.'); index = cssStatementEnd(css, word.end); continue; }
    }
    if (/[a-z_\\-]/i.test(css[index])) {
      const word = cssWord(css, index);
      let cursor = word.end;
      while (/\s/.test(css[cursor] || '')) cursor++;
      if (word.value === 'url' && css[cursor] === '(') {
        cursor++; while (/\s/.test(css[cursor] || '')) cursor++;
        let value;
        if (css[cursor] === '"' || css[cursor] === "'") { const end = cssStringEnd(css, cursor); value = css.slice(cursor + 1, end - 1); cursor = end; while (/\s/.test(css[cursor] || '')) cursor++; }
        else { const end = css.indexOf(')', cursor); if (end < 0) fail('INVALID_PREVIEW_CSS', 'A CSS url() is incomplete.', 422); value = css.slice(cursor, end).trim(); cursor = end; }
        if (css[cursor] !== ')' || value.includes('\\')) unsafe();
        const result = await resource(value, base, 'asset');
        output += result === null || result === '' ? 'none' : `url("${result.replaceAll('"', '%22')}")`;
        index = cursor + 1; continue;
      }
      if (word.end > index) { output += css.slice(index, word.end); index = word.end; continue; }
    }
    output += css[index++];
  }
  return output;
}
async function inlineSrcset(value, base, resource) {
  const candidates = [];
  let index = 0;
  while (index < value.length) {
    while (/[\s,]/.test(value[index] || '')) index++;
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index++;
    let url = value.slice(start, index), descriptor = '';
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else { const at = value.indexOf(',', index), end = at < 0 ? value.length : at; descriptor = value.slice(index, end).trim(); index = at < 0 ? value.length : at + 1; }
    if (descriptor && !/^(?:\d+w|(?:\d*\.)?\d+x)$/.test(descriptor)) fail('INVALID_PREVIEW_SRCSET', 'Image srcset requires ordinary width or density descriptors.', 422);
    const data = await resource(url, base, 'image');
    if (data !== null && data !== '') candidates.push(`${data}${descriptor ? ` ${descriptor}` : ''}`);
  }
  return candidates.join(', ');
}

export function createWorkPreview(operations) {
  if (typeof operations?.workFile !== 'function') throw new TypeError('createWorkPreview requires registered workFile operations.');
  async function registered(id) {
    if (typeof id !== 'string' || !/^[a-z\d-]{1,80}$/i.test(id)) fail('INVALID_ARGUMENT', 'Preview requires a registered work id.');
    const work = await operations.workFile(id);
    if (!work?.item || work.item.id !== id || typeof work.file !== 'string' || !path.isAbsolute(work.file) || keyOf(work.file) !== keyOf(work.item.path)) fail('INVALID_PREVIEW_WORK', 'Preview must use the actual registered work file.', 403);
    if (!['.html', '.htm'].includes(path.extname(work.file).toLowerCase())) fail('UNSUPPORTED_PREVIEW', 'Only registered HTML and HTM works support HTML previews.', 415);
    return work;
  }
  async function render(id) {
    const { file, item } = await registered(id);
    const source = await snapshot(file, PREVIEW_LIMITS.sourceBytes, 'PREVIEW_SOURCE_TOO_LARGE');
    const root = path.dirname(source.path), cache = new Map(), warnings = new Set(), assetMap = {};
    let total = 0, entries = 0;
    const warn = message => warnings.add(message);
    function reserve(size) {
      if (++entries > PREVIEW_LIMITS.entries) fail('PREVIEW_TOO_MANY_RESOURCES', `Preview exceeds ${PREVIEW_LIMITS.entries} resource references.`, 413);
      if (total + size > PREVIEW_LIMITS.totalBytes) fail('PREVIEW_RESOURCES_TOO_LARGE', `Preview resources exceed ${PREVIEW_LIMITS.totalBytes} bytes.`, 413);
      total += size;
    }
    async function resource(raw, base = '', kind = 'asset') {
      let value = raw.trim();
      if (!value || /^(?:data:|#)/i.test(value)) return value;
      if (value.length > 2048) unsafe();
      try { value = decodeURIComponent(value); } catch { unsafe(); }
      if (/[\x00-\x1f\x7f%\\]/.test(value)) unsafe();
      if (/^(?:https?:|\/\/)/i.test(value)) { warn('External preview resources were omitted.'); return null; }
      if (/^[a-z][\w+.-]*:/i.test(value) || value.startsWith('/')) unsafe();
      const fragmentAt = value.indexOf('#'), fragment = fragmentAt >= 0 ? value.slice(fragmentAt) : '';
      const relative = value.split(/[?#]/, 1)[0];
      if (!relative || /[:\\]/.test(relative)) unsafe();
      const normalized = path.posix.normalize(path.posix.join(base, relative));
      if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) unsafe();
      const extension = path.posix.extname(normalized).toLowerCase();
      if (kind === 'css' ? extension !== '.css' : !Object.hasOwn(MIME, extension) || (kind === 'image' && !MIME[extension].startsWith('image/'))) fail('UNSUPPORTED_PREVIEW_RESOURCE', 'Preview resources support local images, stylesheets and fonts only.', 415);
      const absolute = path.join(root, ...normalized.split('/'));
      let loaded = cache.get(keyOf(absolute));
      if (loaded) reserve(loaded.bytes.length);
      else { loaded = await snapshot(absolute, PREVIEW_LIMITS.resourceBytes, 'PREVIEW_RESOURCE_TOO_LARGE', reserve); cache.set(keyOf(absolute), loaded); }
      if (kind === 'css') return inlineCss(decode(loaded.bytes), path.posix.dirname(normalized) === '.' ? '' : path.posix.dirname(normalized), resource, warn);
      const data = `data:${MIME[extension]};base64,${loaded.bytes.toString('base64')}`;
      if (MIME[extension].startsWith('image/')) {
        Object.defineProperty(assetMap, normalized, { value: data, enumerable: true, configurable: true });
        if (!base) Object.defineProperty(assetMap, raw.trim(), { value: data + fragment, enumerable: true, configurable: true });
      }
      return data + fragment;
    }
    const html = decode(source.bytes);
    let output = '', index = 0;
    while (index < html.length) {
      if (html.startsWith('<!--', index)) { const at = html.indexOf('-->', index + 4), end = at < 0 ? html.length : at + 3; output += html.slice(index, end); index = end; continue; }
      if (html[index] !== '<') { const at = html.indexOf('<', index), end = at < 0 ? html.length : at; output += html.slice(index, end); index = end; continue; }
      const tag = tagAt(html, index);
      if (!tag) { output += html[index++]; continue; }
      index = tag.end;
      if (tag.closing) { output += tag.raw; continue; }
      if (tag.name === 'base') { warn('HTML base elements were removed from the preview.'); continue; }
      if (tag.name === 'meta' && attribute(tag, 'http-equiv')?.value?.trim().toLowerCase() === 'refresh') { warn('HTML refresh directives were removed from the preview.'); continue; }
      if (tag.name === 'script') {
        const end = rawEnd(html, index, 'script');
        if (attribute(tag, 'src')) warn('External and linked scripts were omitted; inline scripts remain sandboxed by the preview client.');
        else output += tag.raw + html.slice(index, end.start) + end.close;
        index = end.end; continue;
      }
      if (tag.name === 'link') {
        const rel = attribute(tag, 'rel')?.value?.toLowerCase().split(/\s+/) || [];
        const href = attribute(tag, 'href')?.value;
        if (rel.includes('stylesheet') && href) {
          if (/^(?:data:|#)/i.test(href.trim())) { output += tag.raw; continue; }
          const css = await resource(href, '', 'css');
          if (css !== null) { const media = attribute(tag, 'media')?.value; output += `<style${media ? ` media="${escapeAttr(media)}"` : ''}>${css.replace(/<\/style/gi, '<\\/style')}</style>`; }
        } else warn('Non-stylesheet links were omitted from the preview.');
        continue;
      }
      if (tag.name === 'style') {
        const end = rawEnd(html, index, 'style');
        output += tag.raw + await inlineCss(html.slice(index, end.start), '', resource, warn) + end.close;
        index = end.end; continue;
      }
      if (['textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'].includes(tag.name)) {
        const end = tag.name === 'plaintext' ? { start: html.length, end: html.length, close: '' } : rawEnd(html, index, tag.name);
        output += tag.raw + html.slice(index, end.start) + end.close; index = end.end; continue;
      }
      let modified = false;
      if (['img', 'source'].includes(tag.name)) {
        const src = attribute(tag, 'src'), srcset = attribute(tag, 'srcset');
        if (src?.value !== null && src !== undefined) { setAttribute(tag, 'src', await resource(src.value, '', 'image')); modified = true; }
        if (srcset?.value !== null && srcset !== undefined) { setAttribute(tag, 'srcset', await inlineSrcset(srcset.value, '', resource)); modified = true; }
      }
      const image = attribute(tag, 'data-image');
      if (image?.value) { setAttribute(tag, 'data-image', await resource(image.value, '', 'image')); modified = true; }
      const style = attribute(tag, 'style');
      if (style?.value) { setAttribute(tag, 'style', await inlineCss(style.value, '', resource, warn)); modified = true; }
      output += modified ? serializeTag(tag) : tag.raw;
    }
    const responseBytes = Buffer.byteLength(output) + Object.entries(assetMap).reduce((sum, [url, data]) => sum + Buffer.byteLength(url) + Buffer.byteLength(data), 0);
    if (responseBytes > PREVIEW_LIMITS.totalBytes) fail('PREVIEW_RESOURCES_TOO_LARGE', 'Preview HTML and its verified image map exceed the 32 MiB response budget.', 413);
    // The legacy inline editor serializes an HTML DOM. A linked JS/template
    // source remains editable through the source tool, never through this bridge.
    const associatedSource = item.sourcePath || item.path;
    const sourcePath = item.editable !== false && typeof associatedSource === 'string' && keyOf(associatedSource) === keyOf(source.path) ? source.path : null;
    const result = { kind: 'html', workId: item.id, title: item.title, html: output, assetMap, sourcePath, warnings: [...warnings] };
    if (Buffer.byteLength(JSON.stringify(result)) > PREVIEW_LIMITS.totalBytes) fail('PREVIEW_RESOURCES_TOO_LARGE', 'The serialized preview and verified image map exceed the 32 MiB response budget.', 413);
    await verify(source);
    for (const loaded of cache.values()) await verify(loaded);
    return result;
  }
  async function thumbnail(id) {
    const { file } = await registered(id);
    const work = await location(file);
    const stem = file.slice(0, -path.extname(file).length);
    for (const suffix of ['-desktop.png', '.png']) {
      let image;
      try { image = await snapshot(stem + suffix, PREVIEW_LIMITS.resourceBytes, 'PREVIEW_RESOURCE_TOO_LARGE'); }
      catch (error) { if (error.code === 'PREVIEW_NOT_FOUND') continue; throw error; }
      if (!image.bytes.subarray(0, PNG.length).equals(PNG)) fail('INVALID_PREVIEW_IMAGE', 'The preview thumbnail must be a PNG file.', 415);
      await verify(work); await verify(image);
      return { file: image.path, mime: 'image/png' };
    }
    fail('PREVIEW_NOT_FOUND', 'This registered HTML work has no existing PNG thumbnail.', 404);
  }
  return { render, thumbnail };
}
