import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

export const BASE = '/huashu-design';
export const LIMITS = Object.freeze({ page: 100, read: 16000, sourceBytes: 128 * 1024, markdownBytes: 2 * 1024 * 1024, bodyBytes: 1024 * 1024, indexBytes: 8 * 1024 * 1024 });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../upstream');
const queues = new Map();
const MIME = Object.freeze({ '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.ogv': 'video/ogg', '.ppdesign': 'application/octet-stream' });
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg']);
const IMAGE_EDITABLE = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const WORKS = new Set(Object.keys(MIME).filter(ext => !['.md', '.markdown'].includes(ext)));
const SOURCES = new Set(['.html', '.htm', '.svg', '.md', '.css', '.js', '.mjs', '.json', '.txt']);
const SELF_EDITABLE = new Set(['.html', '.htm', '.svg']);
const sourceOf = item => item.sourcePath || (SELF_EDITABLE.has(path.extname(item.path).toLowerCase()) ? item.path : null);
const projectOf = item => item.projectPath || (path.extname(item.path).toLowerCase() === '.ppdesign' ? item.path : null);
const revisionOf = bytes => createHash('sha256').update(bytes).digest('hex');
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
function decodeSource(bytes) {
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('BINARY_SOURCE', 'Editable source must be valid UTF-8 text.', 415); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) fail('BINARY_SOURCE', 'Binary source cannot be edited.', 415);
  return content;
}

// Reject junctions/symlinks in every ancestor, including replacements of a once
// canonical parent. Re-check these identities after opening and before mutations.
async function sourceLocation(file, expected) {
  if (!path.isAbsolute(file) || file.includes('\0')) fail('UNSAFE_PATH', 'Source path must be absolute.', 403);
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  const parents = [];
  const parts = path.relative(root, absolute).split(path.sep);
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('SOURCE_NOT_FOUND', `Registered source is missing: ${file}`, 404); throw error; }
    if (info.isSymbolicLink()) fail('UNSAFE_PATH', 'Source and its parent directories cannot be symlinks or junctions.', 403);
    if (index < parts.length - 1) {
      if (!info.isDirectory()) fail('UNSAFE_PATH', 'Source parent is not a directory.', 403);
      parents.push({ path: current, info });
    } else if (!info.isFile()) fail('INVALID_FILE', 'Editable source must be a regular file.');
  }
  const canonical = await fs.realpath(absolute);
  if (pathKey(canonical) !== pathKey(absolute)) fail('UNSAFE_PATH', 'Source path changed its canonical location.', 403);
  if (expected && (pathKey(expected.path) !== pathKey(canonical) || parents.length !== expected.parents.length || parents.some((entry, index) => pathKey(entry.path) !== pathKey(expected.parents[index].path) || !sameFile(entry.info, expected.parents[index].info)))) fail('UNSAFE_PATH', 'Source parent directory changed during the operation.', 403);
  return { path: canonical, parents };
}
async function sourceSnapshot(file, expected) {
  const location = await sourceLocation(file, expected);
  const handle = await fs.open(location.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('INVALID_FILE', 'Editable source must be a regular file.');
    if (info.size > LIMITS.sourceBytes) fail('SOURCE_TOO_LARGE', `Source exceeds the complete-edit limit of ${LIMITS.sourceBytes} bytes; it has not been truncated.`, 413);
    const bytes = Buffer.alloc(LIMITS.sourceBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > LIMITS.sourceBytes) fail('SOURCE_TOO_LARGE', `Source exceeds ${LIMITS.sourceBytes} bytes; it has not been truncated.`, 413);
    await sourceLocation(file, location);
    const current = await fs.lstat(location.path);
    const after = await handle.stat();
    if (current.isSymbolicLink() || !sameFile(info, current) || !sameFile(info, after) || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) fail('SOURCE_CHANGED', 'Source changed while reading; reload it before editing.', 409);
    const body = bytes.subarray(0, used);
    return { location, info: after, bytes: body, content: decodeSource(body), revision: revisionOf(body) };
  } finally { await handle.close(); }
}
// Register/revise larger projects without loading them into the bounded text editor.
async function sourceReference(file) {
  const location = await sourceLocation(file);
  const info = await fs.lstat(location.path);
  if (info.size <= LIMITS.sourceBytes) return sourceSnapshot(location.path);
  await sourceLocation(file, location);
  return { location, info, revision: null };
}
// Native projects and previews are binary references, never editable text. Pin
// the opened file and every parent, then re-check them before publishing metadata.
async function fileReference(file, expected) {
  let location;
  try { location = await sourceLocation(file, expected?.location); }
  catch (error) { if (error.code === 'SOURCE_NOT_FOUND') fail('NOT_FOUND', `File does not exist: ${file}`, 404); throw error; }
  const handle = await fs.open(location.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('INVALID_FILE', 'Expected an existing regular file.');
    await sourceLocation(file, location);
    const current = await fs.lstat(location.path);
    const after = await handle.stat();
    if (current.isSymbolicLink() || !sameFile(info, current) || !sameFile(info, after) || (expected && (!sameFile(info, expected.info) || info.size !== expected.info.size || info.mtimeMs !== expected.info.mtimeMs || info.ctimeMs !== expected.info.ctimeMs)) || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) fail('FILE_CHANGED', 'File changed during the operation; reload it before linking.', 409);
    return { location, info: after };
  } finally { await handle.close(); }
}
async function projectReference(value) {
  const file = text(value, 'projectPath', 4096, true);
  if (!path.isAbsolute(file)) fail('INVALID_FILE', 'projectPath must be absolute.');
  if (path.extname(file).toLowerCase() !== '.ppdesign') fail('UNSUPPORTED_PROJECT', 'Native projects must be .ppdesign files.', 415);
  return fileReference(file);
}
async function durableExclusive(file, bytes) {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); return await handle.stat(); }
  finally { await handle.close(); }
}
async function syncDirectory(directory) {
  // Windows does not allow opening directories through Node's fs.open. File
  // handles above are flushed there; POSIX also persists the new directory entry.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { await handle.sync(); } finally { await handle.close(); }
}
export class OperationError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'OperationError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new OperationError(code, message, status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, name, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || value.includes('\0')) fail('INVALID_ARGUMENT', `${name} must be ${required ? 'a nonempty' : 'a'} string of at most ${max} characters.`);
  return value.trim();
}
function integer(value, fallback, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('INVALID_ARGUMENT', `${name} must be an integer from 0 to ${max}.`);
  return value;
}
function pagination(args, defaultLimit = 24) {
  const offset = integer(args.offset, 0, 1000000, 'offset');
  const limit = integer(args.limit, defaultLimit, LIMITS.page, 'limit');
  if (!limit) fail('INVALID_ARGUMENT', 'limit must be at least 1.');
  return { offset, limit };
}
function page(items, args, defaultLimit) {
  const { offset, limit } = pagination(args, defaultLimit);
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, nextOffset: offset + limit < items.length ? offset + limit : null };
}
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const assetUrl = value => `${BASE}/assets/${value.split('/').map(encodeURIComponent).join('/')}`;
const inRoot = (root, value) => { const rel = path.relative(root, value); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };

// Check lexical containment, every directory entry, then the canonical target. No symlinks,
// including internal links, are resources. This is also used immediately before opening.
export async function safeResource(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 2048 || /[\\:\0%]/.test(relative) || path.isAbsolute(relative)) fail('UNSAFE_PATH', 'Resource path must be a relative upstream path.', 403);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH', 'Path traversal is forbidden.', 403);
  if ((await fs.lstat(root)).isSymbolicLink()) fail('UNSAFE_PATH', 'The upstream resource root cannot be a symlink.', 403);
  const canonicalRoot = await fs.realpath(root);
  let target = canonicalRoot;
  for (const part of parts) {
    target = path.join(target, part);
    let info;
    try { info = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('NOT_FOUND', 'Resource does not exist.', 404); throw error; }
    if (info.isSymbolicLink()) fail('UNSAFE_PATH', 'Symlink resources are forbidden.', 403);
  }
  const canonical = await fs.realpath(target);
  if (!inRoot(canonicalRoot, canonical)) fail('UNSAFE_PATH', 'Resource leaves upstream directory.', 403);
  if (!(await fs.stat(canonical)).isFile()) fail('INVALID_FILE', 'Resource must be a regular file.');
  return canonical;
}
async function boundedText(file, max = LIMITS.markdownBytes) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('INVALID_FILE', 'Expected a regular file.');
    if (info.size > max) fail('RESOURCE_TOO_LARGE', `File exceeds ${max} bytes.`, 413);
    const bytes = Buffer.alloc(max + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > max) fail('RESOURCE_TOO_LARGE', `File exceeds ${max} bytes.`, 413);
    return bytes.subarray(0, used).toString('utf8');
  } finally { await handle.close(); }
}
export function splitSkill(raw) {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const field = name => (match?.[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1] || '').trim().replace(/^(["'])(.*)\1$/, '$2');
  return { name: field('name') || 'huashu-design', description: field('description') || '花叔Design：HTML 原型、幻灯片、信息图、动画与专家评审。', version: match?.[1].match(/^\s+version:\s*["']?([^"'\r\n]+)/m)?.[1]?.trim() || 'unknown', body: match ? raw.slice(match[0].length) : raw };
}
export const TASKS = Object.freeze([
  { id: 'web', title: '网页与原型', titleEn: 'Web & prototypes', description: '落地页、官网、Dashboard 和桌面界面原型。', descriptionEn: 'Landing pages, websites, dashboards and desktop prototypes.', prompt: '请用 huashu-design 制作 HTML 网页或交互原型。', resource: 'references/modules/web.md' },
  { id: 'deck', title: '幻灯片', titleEn: 'Slide decks', description: '演讲、路演、课件和汇报用 HTML 幻灯片。', descriptionEn: 'HTML decks for talks, pitches, lessons and reports.', prompt: '请用 huashu-design 制作 HTML 幻灯片。', resource: 'references/modules/deck.md' },
  { id: 'infographic', title: '信息图', titleEn: 'Infographics', description: '信息图、数据可视化和独立阅读的长图。', descriptionEn: 'Infographics, data visualizations and long-form visual stories.', prompt: '请用 huashu-design 制作信息图或数据可视化。', resource: 'references/modules/infographic.md' },
  { id: 'app', title: 'App 原型', titleEn: 'App prototypes', description: '手机 App、iOS 界面和可交互移动端原型。', descriptionEn: 'Mobile app, iOS interface and interactive mobile prototypes.', prompt: '请用 huashu-design 制作手机 App HTML 原型。', resource: 'references/app-prototype.md' },
  { id: 'motion', title: '动画与视频', titleEn: 'Motion & video', description: '时间轴动画、产品演示以及 MP4 / GIF 交付。', descriptionEn: 'Timeline animations, product demos and MP4 / GIF deliverables.', prompt: '请用 huashu-design 制作动画或视频。', resource: 'references/modules/motion.md' },
  { id: 'critique', title: '设计评审', titleEn: 'Design critique', description: '依据参考和可观察标准评审已有设计。', descriptionEn: 'Review an existing design against references and observable criteria.', prompt: '请用 huashu-design 评审这份设计，给出依据与修改建议。', resource: 'references/critique-guide.md' },
  { id: 'xiaohongshu', title: '小红书图文', titleEn: 'Xiaohongshu cards', description: '封面、图文轮播与长图，附切图和版式检查。', descriptionEn: 'Social covers, carousels and long images with layout checks.', prompt: '请用 huashu-design 制作小红书封面或图文轮播。', resource: 'references/modules/xiaohongshu.md' },
]);
export const WORKFLOWS = Object.freeze([
  { id: 'three-directions', title: '三个方向', titleEn: 'Three directions', description: '从需求出发，先做三个有明显差异的方向供选择。', descriptionEn: 'Explore three distinct directions before execution.', prompt: '先提供三个有明显差异的方向初稿，等我选择后再完成设计。', resource: 'references/directions.md' },
  { id: 'steady-track', title: '稳妥轨道', titleEn: 'Steady track', description: '逐屏稿、样张和检查清单驱动的制作流程。', descriptionEn: 'Build from screen scripts, specimens and a checklist.', prompt: '采用稳妥轨道：读 steady-track，逐屏写稿、参考样张并检查交付。', resource: 'references/steady-track.md' },
  { id: 'same-style', title: '同风格下一份', titleEn: 'Continue a style', description: '基于已登记作品，做同一视觉语言的新作品。', descriptionEn: 'Create another piece using a registered work as a reference.', prompt: '沿用参考作品的视觉语言，替换为新内容；先做三个方向初稿供我选择。' },
  { id: 'review-polish', title: '评审与打磨', titleEn: 'Review & polish', description: '审视现有设计，按证据逐项改进。', descriptionEn: 'Review and refine an existing design using concrete evidence.', prompt: '先按 critique-guide 评审现有设计，再按影响程度列出修改建议。', resource: 'references/critique-guide.md' },
]);

export function parseStyles(markdown, details = false) {
  const result = [];
  const sections = markdown.split(/(?=^\*\*[^\n]+\*\*)/m);
  for (const section of sections) {
    const heading = section.match(/^\*\*(.+?)\*\*/);
    const specimen = section.match(/(?:样张|specimen)[：:]\s*(?:\[[^\]]*\]\()?`?(assets\/style-specimens\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png|webp|avif))/i)?.[1];
    if (!heading || !specimen || specimen.includes('..')) continue;
    const title = heading[1];
    const category = specimen.split('/')[2];
    const slug = path.posix.basename(specimen).replace(/\.[^.]+$/, '');
    const field = label => section.match(new RegExp(`^[\\t ]*-[\\t ]*${label}[\\t ]*[:：][\\t ]*([^\\r\\n]*)`, 'm'))?.[1]?.trim() || '';
    const useCases = field('适配');
    const description = useCases || title;
    const titleEn = title.match(/[A-Za-z][A-Za-z0-9\s&+'’/.,:–—-]*/)?.[0]?.trim() || slug.replace(/^\d+-/, '').replaceAll('-', ' ');
    const metadata = section.slice(heading[0].length).split(/\r?\n/, 1)[0];
    const tone = metadata.match(/大胆|中性|安静/)?.[0] || null;
    const percent = metadata.match(/还原[\t ]*(\d+(?:\.\d+)?)[\t ]*%/)?.[1];
    const fidelity = percent !== undefined && Number(percent) <= 100 ? Number(percent) : null;
    const entry = { id: `${category}-${slug}`, title, titleEn, description, descriptionEn: titleEn, category, module: ({ ppt: 'deck', info: 'infographic', web: 'web', app: 'app', east: 'cross', xhs: 'xiaohongshu' })[category] || category, resource: 'references/design-styles.md', specimen, specimenUrl: assetUrl(specimen), tone, fidelity };
    if (details) {
      const visualDNA = field('视觉[\\t ]*DNA');
      const seen = new Set();
      const palette = [];
      for (const [hex] of visualDNA.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_])/g)) {
        const key = (hex.length === 4 ? '#' + [...hex.slice(1)].map(char => char + char).join('') : hex).toLowerCase();
        if (!seen.has(key)) { seen.add(key); palette.push(hex); }
        if (palette.length === 8) break;
      }
      entry.notes = { reference: field('参考'), useCases, visualDNA, implementation: field('HTML[\\t ]*实现'), typography: field('字体'), palette };
    }
    result.push(entry);
  }
  return result.filter((entry, index) => result.findIndex(other => other.id === entry.id) === index);
}

function serial(key, run) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  queues.set(key, current);
  return current.finally(() => { if (queues.get(key) === current) queues.delete(key); });
}
const absolutePath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value);
function validDesignRef(value) {
  return object(value) && Object.keys(value).length === 3 && ['id', 'revision', 'dataDir'].every(key => Object.hasOwn(value, key)) && typeof value.id === 'string' && /^design_[a-f0-9]{24}$/.test(value.id) && Number.isSafeInteger(value.revision) && value.revision > 0 && absolutePath(value.dataDir);
}
function designReference(value) {
  if (!validDesignRef(value)) fail('INVALID_ARGUMENT', 'designRef must contain only id (design_<24 lowercase hex>), a positive safe-integer revision, and an absolute dataDir.');
  return { id: value.id, revision: value.revision, dataDir: value.dataDir };
}
function validRecord(item) {
  return object(item) && typeof item.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(item.id) && absolutePath(item.path) && WORKS.has(path.extname(item.path).toLowerCase()) && ['title', 'module', 'style', 'note', 'createdAt', 'updatedAt'].every(key => typeof item[key] === 'string') && item.title.length > 0 && item.title.length <= 240 && item.note.length <= 4000 && (item.sourcePath === undefined || (absolutePath(item.sourcePath) && SOURCES.has(path.extname(item.sourcePath).toLowerCase()))) && (item.projectPath === undefined || (absolutePath(item.projectPath) && path.extname(item.projectPath).toLowerCase() === '.ppdesign')) && (item.designRef === undefined || validDesignRef(item.designRef)) && (item.originPath === undefined || (absolutePath(item.originPath) && WORKS.has(path.extname(item.originPath).toLowerCase()))) && (item.imageOnly === undefined || typeof item.imageOnly === 'boolean');
}

export function createOperations(options = {}) {
  const upstreamRoot = path.resolve(options.upstreamRoot || ROOT);
  const dshHome = path.resolve(options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const libraryPath = path.join(dshHome, 'huashu-design', 'library.json');
  const publicItem = item => ({ ...item, editable: Boolean(sourceOf(item)), sourcePath: sourceOf(item), imageEditable: IMAGE_EDITABLE.has(path.extname(item.path).toLowerCase()), layeredEditable: Boolean(projectOf(item) || item.designRef), projectPath: projectOf(item), designRef: item.designRef ? { ...item.designRef } : null, projectDir: path.dirname(sourceOf(item) || projectOf(item) || item.path), mime: MIME[path.extname(item.path).toLowerCase()], url: `${BASE}/works/${encodeURIComponent(item.id)}/entry` });
  async function readIndex() {
    let raw;
    try {
      if ((await fs.lstat(path.dirname(libraryPath))).isSymbolicLink()) fail('UNSAFE_PATH', 'Library directory cannot be a symlink.', 403);
      if ((await fs.lstat(libraryPath)).isSymbolicLink()) fail('CORRUPT_LIBRARY', 'Library index cannot be a symlink.', 409);
      raw = await boundedText(libraryPath, LIMITS.indexBytes);
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, items: [] }; throw error; }
    let data;
    try { data = JSON.parse(raw); } catch { fail('CORRUPT_LIBRARY', 'Library index is damaged; it has not been overwritten.', 409); }
    if (!object(data) || data.version !== 1 || !Array.isArray(data.items) || !data.items.every(validRecord) || new Set(data.items.map(item => item.id)).size !== data.items.length || new Set(data.items.map(item => pathKey(item.path))).size !== data.items.length) fail('CORRUPT_LIBRARY', 'Library index has an invalid structure; it has not been overwritten.', 409);
    return data;
  }
  async function saveIndex(data, verifyFiles) {
    const directory = path.dirname(libraryPath);
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.lstat(directory)).isSymbolicLink()) fail('UNSAFE_PATH', 'Library directory cannot be a symlink.', 403);
    const encoded = JSON.stringify(data, null, 2) + '\n';
    if (Buffer.byteLength(encoded) > LIMITS.indexBytes) fail('LIBRARY_TOO_LARGE', 'Library metadata exceeds its size limit.', 413);
    const temporary = path.join(directory, `.library-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
      if (verifyFiles) await verifyFiles();
      await fs.rename(temporary, libraryPath);
    } finally { if (handle) await handle.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function catalog(args = {}) {
    let styles = [];
    let metadata = { version: 'unknown' };
    const warnings = [];
    try { styles = parseStyles(await boundedText(await safeResource(upstreamRoot, 'references/design-styles.md'))); }
    catch (error) { if (!['ENOENT', 'NOT_FOUND'].includes(error.code)) throw error; warnings.push('Upstream design-styles.md is unavailable.'); }
    try { metadata = splitSkill(await boundedText(await safeResource(upstreamRoot, 'SKILL.md'))); }
    catch (error) { if (!['ENOENT', 'NOT_FOUND'].includes(error.code)) throw error; warnings.push('Upstream SKILL.md is unavailable.'); }
    let snapshot = {};
    const manifestFile = path.join(path.dirname(upstreamRoot), 'upstream-manifest.json');
    try {
      if ((await fs.lstat(manifestFile)).isSymbolicLink()) fail('UNSAFE_PATH', 'Snapshot manifest cannot be a symlink.', 403);
      const data = JSON.parse(await boundedText(manifestFile));
      const select = (source, fields) => Object.fromEntries(fields.filter(key => typeof source?.[key] === 'string').map(key => [key, source[key].slice(0, 2048)]));
      snapshot = {
        source: select(data.source, ['repository', 'branch', 'commit', 'version', 'describe']),
        acquiredAt: typeof data.acquired_at === 'string' ? data.acquired_at.slice(0, 120) : null,
        fileCount: Number.isSafeInteger(data.file_count) ? data.file_count : null,
        license: { ...select(data.license, ['spdx', 'copyright', 'redistribution_requirement']), exceptions: Array.isArray(data.license?.exceptions) ? data.license.exceptions.slice(0, 8).map(entry => select(entry, ['path', 'license', 'required_notice', 'upstream_guidance'])) : [] },
      };
    } catch (error) {
      if (!['ENOENT', 'NOT_FOUND'].includes(error.code)) warnings.push('Snapshot acquisition manifest is unavailable or invalid.');
    }
    const manifest = { name: 'huashu-design', version: metadata.version, ...snapshot, upstreamRoot, resourceBase: { kind: 'directory', path: upstreamRoot }, actions: ['catalog', 'read', 'draft', 'edit', 'source', 'list', 'add', 'remove', 'delete'], limits: LIMITS, counts: { tasks: TASKS.length, workflows: WORKFLOWS.length, styles: styles.length }, warnings };
    const section = args.section;
    if (section) {
      if (!['tasks', 'styles', 'workflows', 'manifest'].includes(section)) fail('INVALID_ARGUMENT', 'section must be tasks, styles, workflows or manifest.');
      if (section === 'manifest') return { manifest };
      let entries = ({ tasks: TASKS, styles, workflows: WORKFLOWS })[section];
      if (args.module) entries = entries.filter(entry => entry.module === args.module || entry.id === args.module || entry.module === 'cross');
      return { section, ...page(entries, args), manifest };
    }
    return { tasks: TASKS.map(item => ({ ...item })), workflows: WORKFLOWS.map(item => ({ ...item })), styles, manifest };
  }
  async function resource(args) {
    if (args.style !== undefined) {
      if (args.path !== undefined) fail('INVALID_ARGUMENT', 'Use either style or path when reading, not both.');
      const id = text(args.style, 'style', 160, true);
      const resourcePath = 'references/design-styles.md';
      const markdown = await boundedText(await safeResource(upstreamRoot, resourcePath));
      const style = parseStyles(markdown, true).find(entry => entry.id === id);
      if (!style) fail('UNKNOWN_STYLE', `Unknown style: ${id}`, 404);
      return { style, path: resourcePath, notes: style.notes };
    }
    const resourcePath = text(args.path, 'path', 2048, true);
    const file = await safeResource(upstreamRoot, resourcePath);
    const extension = path.extname(file).toLowerCase();
    if (IMAGES.has(extension)) return { path: resourcePath, mime: MIME[extension], url: assetUrl(resourcePath) };
    if (!['.md', '.markdown'].includes(extension)) fail('UNSUPPORTED_RESOURCE', 'Only upstream Markdown and image resources may be read.', 415);
    const content = await boundedText(file);
    const offset = integer(args.offset, 0, content.length, 'offset');
    const limit = integer(args.limit, 8000, LIMITS.read, 'limit');
    if (!limit) fail('INVALID_ARGUMENT', 'limit must be at least 1.');
    return { path: resourcePath, content: content.slice(offset, offset + limit), total: content.length, offset, limit, truncated: offset + limit < content.length, nextOffset: offset + limit < content.length ? offset + limit : null };
  }
  async function add(args) {
    const title = text(args.title, 'title', 240, true);
    const source = text(args.path, 'path', 4096, true);
    if (!path.isAbsolute(source)) fail('INVALID_FILE', 'Work path must be absolute.');
    let canonical;
    try { canonical = await fs.realpath(source); } catch (error) { if (error.code === 'ENOENT') fail('NOT_FOUND', 'Work file does not exist.', 404); throw error; }
    if (!(await fs.stat(canonical)).isFile()) fail('INVALID_FILE', 'Work path must be an existing regular file.');
    const extension = path.extname(canonical).toLowerCase();
    if (!WORKS.has(extension)) fail('UNSUPPORTED_FILE', 'Supported works: HTML, PDF, images, video and .ppdesign projects.', 415);
    const nativeWork = extension === '.ppdesign' || path.extname(source).toLowerCase() === '.ppdesign' ? await fileReference(source) : undefined;
    const module = text(args.module ?? args.task, 'module', 80);
    const style = text(args.style, 'style', 160);
    if (module && !TASKS.some(task => task.id === module)) fail('UNKNOWN_TASK', `Unknown task: ${module}`);
    if (style && !(await catalog()).styles.some(item => item.id === style)) fail('UNKNOWN_STYLE', `Unknown style: ${style}`);
    const note = text(args.note, 'note', 4000);
    let sourcePath;
    if (args.sourcePath !== undefined) {
      sourcePath = text(args.sourcePath, 'sourcePath', 4096, true);
      if (!path.isAbsolute(sourcePath)) fail('INVALID_FILE', 'sourcePath must be an absolute existing editable source.');
      if (!SOURCES.has(path.extname(sourcePath).toLowerCase())) fail('UNSUPPORTED_SOURCE', 'Supported editable sources: HTML, HTM, SVG, MD, CSS, JS, MJS, JSON and TXT.', 415);
      sourcePath = (await sourceReference(sourcePath)).location.path;
    } else if (SELF_EDITABLE.has(extension)) {
      // Preserve registration of larger HTML deliverables; the editor reports its
      // own complete-read size limit when opened. Validate path safety here.
      await sourceLocation(canonical);
    }
    let project = args.projectPath !== undefined ? await projectReference(args.projectPath) : nativeWork;
    if (!project && args.projectPath === undefined && IMAGES.has(extension)) {
      const sidecar = canonical.slice(0, -extension.length) + '.ppdesign';
      try { project = await projectReference(sidecar); }
      catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    }
    const designRef = args.designRef === undefined ? undefined : designReference(args.designRef);
    return serial(pathKey(libraryPath), async () => {
      const data = await readIndex();
      const old = data.items.find(item => pathKey(item.path) === pathKey(canonical));
      const now = new Date().toISOString();
      const linkedSource = sourcePath || old?.sourcePath;
      const linkedProject = project?.location.path || old?.projectPath;
      const linkedDesign = designRef || old?.designRef;
      const item = { id: old?.id || randomUUID(), title, path: canonical, ...(linkedSource ? { sourcePath: linkedSource } : {}), ...(linkedProject ? { projectPath: linkedProject } : {}), ...(linkedDesign ? { designRef: linkedDesign } : {}), ...(old?.originPath ? { originPath: old.originPath } : {}), ...(old?.imageOnly !== undefined ? { imageOnly: old.imageOnly } : {}), module, style, note, createdAt: old?.createdAt || now, updatedAt: now };
      data.items = [item, ...data.items.filter(entry => entry.id !== item.id)];
      await saveIndex(data, async () => {
        if (nativeWork) await fileReference(nativeWork.location.path, nativeWork);
        if (project) await fileReference(project.location.path, project);
      });
      return { item: publicItem(item), updated: Boolean(old) };
    });
  }
  async function linkProject(args) {
    const id = text(args.id, 'id', 80, true);
    const designRef = args.designRef === undefined ? undefined : designReference(args.designRef);
    if (args.imageOnly !== undefined && typeof args.imageOnly !== 'boolean') fail('INVALID_ARGUMENT', 'imageOnly must be a boolean.');
    const previewPath = args.previewPath === undefined ? undefined : text(args.previewPath, 'previewPath', 4096, true);
    if (previewPath !== undefined && (!path.isAbsolute(previewPath) || !IMAGE_EDITABLE.has(path.extname(previewPath).toLowerCase()))) fail('INVALID_FILE', 'previewPath must be an absolute existing PNG, JPG, JPEG or WebP file.');
    return serial(pathKey(libraryPath), async () => {
      const data = await readIndex();
      const index = data.items.findIndex(item => item.id === id);
      if (index < 0) fail('UNKNOWN_WORK', 'Registered work was not found.', 404);
      const old = data.items[index];
      const project = await projectReference(args.projectPath);
      const preview = previewPath === undefined ? undefined : await fileReference(previewPath);
      const nextPath = preview?.location.path || old.path;
      if (data.items.some(item => item.id !== id && pathKey(item.path) === pathKey(nextPath))) fail('WORK_PATH_CONFLICT', 'Preview is already registered to a different work.', 409);
      const item = { ...old, path: nextPath, ...(sourceOf(old) ? { sourcePath: sourceOf(old) } : {}), projectPath: project.location.path, ...(designRef ? { designRef } : {}), ...(args.imageOnly !== undefined ? { imageOnly: args.imageOnly } : {}), ...(pathKey(nextPath) !== pathKey(old.path) && !old.originPath ? { originPath: old.path } : {}), updatedAt: new Date().toISOString() };
      data.items[index] = item;
      await saveIndex(data, async () => {
        await fileReference(project.location.path, project);
        if (preview) await fileReference(preview.location.path, preview);
      });
      return { item: publicItem(item), updated: true };
    });
  }
  async function list(args) {
    const data = await serial(pathKey(libraryPath), readIndex);
    let items = data.items;
    if (args.module) items = items.filter(item => item.module === args.module);
    if (args.style) items = items.filter(item => item.style === args.style);
    return page(items.map(publicItem), args);
  }
  async function remove(args) {
    const id = text(args.id, 'id', 80, true);
    return serial(pathKey(libraryPath), async () => {
      const data = await readIndex();
      const remaining = data.items.filter(item => item.id !== id);
      const removed = remaining.length !== data.items.length;
      if (removed) { data.items = remaining; await saveIndex(data); }
      return { id, removed };
    });
  }
  // Delete one registration together with the files it owns: the deliverable,
  // its linked editable source and its native project. Files still referenced by
  // another registration are kept and reported instead of being deleted.
  async function deleteWork(args) {
    if (args.confirm !== true) fail('CONFIRM_REQUIRED', 'Deleting a work and its files requires confirm: true.', 409);
    const id = text(args.id, 'id', 80, true);
    return serial(pathKey(libraryPath), async () => {
      const data = await readIndex();
      const item = data.items.find(entry => entry.id === id);
      if (!item) fail('UNKNOWN_WORK', 'Registered work was not found.', 404);
      const remaining = data.items.filter(entry => entry.id !== id);
      const shared = new Set();
      for (const entry of remaining) {
        for (const value of [entry.path, entry.sourcePath, entry.projectPath]) if (value) shared.add(pathKey(value));
      }
      const deleted = [], skipped = [], failed = [];
      for (const [role, value] of [['file', item.path], ['source', item.sourcePath], ['project', item.projectPath]]) {
        if (!value) continue;
        if (!path.isAbsolute(value) || value.includes('\0')) { failed.push({ role, path: value, reason: 'Not an absolute path.' }); continue; }
        if (shared.has(pathKey(value))) { skipped.push({ role, path: value, reason: 'Also referenced by another registered work.' }); continue; }
        let info;
        try { info = await fs.lstat(value); }
        catch (error) {
          if (error.code === 'ENOENT') { skipped.push({ role, path: value, reason: 'Already missing.' }); continue; }
          failed.push({ role, path: value, reason: error.code || 'stat failed' }); continue;
        }
        // Never follow a link out of the registered target.
        if (info.isSymbolicLink()) { failed.push({ role, path: value, reason: 'Symbolic links are never deleted.' }); continue; }
        if (!info.isFile()) { failed.push({ role, path: value, reason: 'Not a regular file.' }); continue; }
        try { await fs.unlink(value); deleted.push({ role, path: value, bytes: info.size }); }
        catch (error) { failed.push({ role, path: value, reason: error.code || 'unlink failed' }); }
      }
      if (failed.length) fail('DELETE_FAILED', `Some files could not be deleted: ${failed.map(entry => `${entry.path} (${entry.reason})`).join('; ')}`, 409);
      data.items = remaining;
      await saveIndex(data);
      return { id, deleted: true, files: deleted, skipped };
    });
  }
  async function draft(args) {
    const workflowId = text(args.workflow, 'workflow', 80);
    const workflow = workflowId ? WORKFLOWS.find(item => item.id === workflowId) : undefined;
    if (workflowId && !workflow) fail('UNKNOWN_WORKFLOW', `Unknown workflow: ${workflowId}`);
    const workId = text(args.workId ?? args.work, 'workId', 80);
    const work = workId ? (await serial(pathKey(libraryPath), readIndex)).items.find(item => item.id === workId) : undefined;
    if (workId && !work) fail('UNKNOWN_WORK', 'Registered reference work was not found.', 404);
    const requestedTask = text(args.task ?? args.module ?? (work?.module || 'web'), 'task', 80, true);
    if (!TASKS.some(item => item.id === requestedTask)) fail('UNKNOWN_TASK', `Unknown task: ${requestedTask}`);
    const taskId = workflowId === 'review-polish' ? 'critique' : requestedTask;
    const task = TASKS.find(item => item.id === taskId);
    const styleId = text(args.style ?? work?.style, 'style', 160);
    const style = styleId ? (await catalog()).styles.find(item => item.id === styleId) : undefined;
    if (styleId && !style) fail('UNKNOWN_STYLE', `Unknown style: ${styleId}`);
    const brief = text(args.brief, 'brief', 8000);
    const outputMode = text(args.outputMode === undefined ? 'standard' : args.outputMode, 'outputMode', 16, true);
    if (!['standard', 'layered'].includes(outputMode)) fail('INVALID_ARGUMENT', 'outputMode must be standard or layered.');
    // Layered output is now a per-creation choice for every task, not just
    // static infographics. The composer defaults to 'standard' so only an
    // explicit user selection produces a native editable .ppdesign project.
    const layered = outputMode === 'layered';
    const projectPath = work && projectOf(work);
    if (projectPath) await projectReference(projectPath);
    const lines = [task.prompt, '作品登记到本次花叔设计工作台的作品库，并在工作台内预览；用户明确指定其它作品库时按用户选择执行。'];
    if (brief) lines.push(`需求：${brief}`);
    if (style) lines.push(`参考风格：${style.title}（${style.id}）。样张：${path.join(upstreamRoot, ...style.specimen.split('/'))}`);
    if (workflow) lines.push(`工作流：${workflow.prompt}`);
    if (work) lines.push(`参考作品：${work.title}\n文件：${work.path}${projectPath ? `\n原生分层工程：${projectPath}；读取并参考真实图层，保留原作品的源码关联。` : ''}${work.note ? `\n参考备注：${work.note}` : ''}`);
    if (taskId !== 'critique') lines.push('先按 huashu-design 提供三个有明显差异的方向初稿，等我选择后再完成。');
    lines.push(`先阅读模块手册：${path.join(upstreamRoot, ...task.resource.split('/'))}。`);
    if (layered) {
      lines.push('交付 PNG 预览和可在批印坊继续编辑的原生 .ppdesign 工程包。文字、矩形、椭圆、线条和图片必须按设计保留真实独立的 text/rect/ellipse/line/image 图层；禁止把整张渲染图伪装成一个图片图层的分层项目。', '先调用 huashu_printpress，action="guide"，读取原生工程坐标、字号和图片资源契约；再用现有 action="call" 的 design:importBytes / design:save 构建真实文档。完成后调用 huashu_printpress，action="publish"，顶层参数包含 designId、revision、title、module、style、previewPath、projectPath，以及 allowWrite:true、requireLayers:true，由该操作生成 PNG + .ppdesign 并登记作品；续改既有作品时在顶层加 workId 回存同一登记。源码如有仍可用 sourcePath 保留；.ppdesign 是本任务的原生可编辑工程，不能作为文本 sourcePath。');
    } else {
      lines.push('交付时保留可编辑源码；交付后调用 huashu_design，action="add"，args 包含 title、交付文件的绝对 path、可编辑源码绝对 sourcePath、module、style、note，登记作品。HTML/HTM/SVG 本体默认可编辑；图片、PDF、视频需另行关联原始源码。');
    }
    return { draft: lines.join('\n\n'), task: taskId, style: styleId || null, workflow: workflowId || null, workId: workId || null, outputMode, ...(projectPath ? { projectPath } : {}) };
  }
  function workIdArgument(args) {
    const id = text(args.id ?? args.workId, 'id or workId', 80, true);
    if (args.id !== undefined && args.workId !== undefined && args.id !== args.workId) fail('INVALID_ARGUMENT', 'id and workId must identify the same registered work.');
    return id;
  }
  async function registeredWork(args) {
    const id = workIdArgument(args);
    const item = (await serial(pathKey(libraryPath), readIndex)).items.find(entry => entry.id === id);
    if (!item) fail('UNKNOWN_WORK', 'Registered work was not found.', 404);
    return { id, item };
  }
  async function registeredSource(args) {
    const { id, item } = await registeredWork(args);
    const file = sourceOf(item);
    if (!file) fail('NO_EDITABLE_SOURCE', 'This export has no editable source. Register its original sourcePath before editing; an exported image, PDF or video cannot be reverse-edited.', 415);
    if (args.path !== undefined) fail('INVALID_ARGUMENT', 'source/edit select files by registered id, not an arbitrary path.');
    if (args.sourcePath !== undefined && pathKey(text(args.sourcePath, 'sourcePath', 4096, true)) !== pathKey(file)) fail('SOURCE_MISMATCH', 'sourcePath does not match this work’s registered source. Register a new association with add first.', 403);
    await sourceLocation(file);
    return { id, item, file };
  }
  const sourceResult = (item, snapshot) => ({ id: item.id, workId: item.id, path: snapshot.location.path, sourcePath: snapshot.location.path, projectDir: path.dirname(snapshot.location.path), editable: true, revision: snapshot.revision, bytes: snapshot.bytes.length });
  async function layeredEdit(args, id, item, projectPath) {
    if (args.path !== undefined) fail('INVALID_ARGUMENT', 'source/edit select files by registered id, not an arbitrary path.');
    const file = sourceOf(item);
    if (args.sourcePath !== undefined && (!file || pathKey(text(args.sourcePath, 'sourcePath', 4096, true)) !== pathKey(file))) fail('SOURCE_MISMATCH', 'sourcePath does not match this work’s registered source.', 403);
    const project = await projectReference(projectPath);
    if (file) await sourceReference(file);
    const brief = text(args.brief, 'brief', 8000);
    const task = item.module || 'infographic';
    const style = text(args.style ?? item.style, 'style', 160);
    if (style && !(await catalog()).styles.some(entry => entry.id === style)) fail('UNKNOWN_STYLE', `Unknown style: ${style}`);
    const registration = { workId: id, title: item.title, module: task, style };
    const lines = [
      `请续改已有作品「${item.title}」（登记 id：${id}），在原生工程中保留未被本次需求明确要求变更的内容、视觉方向和真实独立图层。`,
      `原生分层工程：${project.location.path}\n工程目录：${path.dirname(project.location.path)}\n现有交付文件：${item.path}${item.designRef ? `\n原生文档引用：${JSON.stringify(item.designRef)}` : ''}`,
      file ? `关联的可编辑源码：${file}；保留 sourcePath 关联和源码文件，原生 .ppdesign 不覆盖这份文本源码。` : '',
      brief ? `本次修改要求：${brief}` : '请根据接下来的修改要求继续编辑这份作品。',
      `先调用 huashu_printpress，action="guide"，读取原生坐标、字号和图片资源契约，再读取上述 .ppdesign 工程，使用 action="call" 的 design:importBytes / design:save 续改真实文档。${item.imageOnly ? '当前为单图片工程，保留实际图层结构并按需求修改图片；实际增加文字或形状时，才添加相应的独立图层。' : '保留独立的 text/rect/ellipse/line/image 图层，不把整图伪装为单层项目。'}不另建作品，不进行新设计方向探索；关联文件不可用时明确报告错误。`,
      style ? (style === item.style ? `保留已选风格：${style}。` : `本次明确选择新的视觉参考：${style}。`) : '',
      item.note ? `作品备注：${item.note}` : '',
      `完成后调用 huashu_printpress，action="publish"；顶层参数包含 designId、revision、allowWrite:true${item.imageOnly ? '' : '、requireLayers:true'}，作品字段也置于顶层：${JSON.stringify(registration)}。previewPath、projectPath 使用新的 PNG 和 .ppdesign 输出路径并置于顶层；以 workId 回存并更新同一条登记，保留原 sourcePath、备注和作品来历。`,
    ];
    return { draft: lines.filter(Boolean).join('\n\n'), task, style: style || null, workId: id, sourcePath: file, projectPath: project.location.path, projectDir: path.dirname(project.location.path) };
  }
  async function edit(args) {
    const selected = await registeredWork(args);
    if (projectOf(selected.item)) return layeredEdit(args, selected.id, selected.item, projectOf(selected.item));
    const { id, item, file } = await registeredSource(args);
    const snapshot = await sourceReference(file);
    const sourceVersion = snapshot.revision ? `SHA-256：${snapshot.revision}` : `源码 ${snapshot.info.size} 字节（超出内置编辑框限制，请直接读取工程文件修改）`;
    const brief = text(args.brief, 'brief', 8000);
    const task = item.module || 'web';
    const style = text(args.style ?? item.style, 'style', 160);
    if (style && !(await catalog()).styles.some(entry => entry.id === style)) fail('UNKNOWN_STYLE', `Unknown style: ${style}`);
    const registration = { title: item.title, path: item.path, sourcePath: file, module: task, style, note: item.note };
    const lines = [
      `请续改已有作品「${item.title}」（登记 id：${id}），直接修改现有工程和文件，保留未被本次需求明确要求变更的内容、视觉方向和功能。`,
      `工程目录：${path.dirname(file)}\n实际可编辑源码：${file}\n现有交付文件：${item.path}\n当前源码版本：${sourceVersion}`,
      brief ? `本次修改要求：${brief}` : '请根据接下来的修改要求继续编辑这份作品。',
      '修改前先读取上述实际源码及它引用的必要工程文件，再在原文件中实施改动。不进行新设计方向探索，不另建作品或另起工程。若关联文件不可用，明确报告错误，不改用其他文件。',
      style ? (style === item.style ? `保留已选风格：${style}（本次要求明确变更的部分除外）。` : `本次明确选择新的视觉参考：${style}；在原工程中实施，不另建作品。`) : '',
      item.note ? `作品备注：${item.note}` : '',
      `保存修改；如作品有独立导出文件，使用现有工程流程更新原交付文件。然后调用 huashu_design，action="add"，args=${JSON.stringify(registration)}，按原交付 path 更新同一条登记（${id}），保留 sourcePath 关联。`,
    ];
    return { draft: lines.filter(Boolean).join('\n\n'), task, style: style || null, workId: id, sourcePath: file, projectDir: path.dirname(file) };
  }
  async function source(args) {
    const selected = await registeredSource(args);
    const writing = args.content !== undefined;
    let bytes;
    if (writing) {
      if (typeof args.content !== 'string') fail('INVALID_ARGUMENT', 'content must be complete UTF-8 source text.');
      bytes = Buffer.from(args.content, 'utf8');
      if (args.content.length > LIMITS.sourceBytes || bytes.length > LIMITS.sourceBytes) fail('SOURCE_TOO_LARGE', `Complete source must be at most ${LIMITS.sourceBytes} UTF-8 bytes; it has not been saved.`, 413);
      if (decodeSource(bytes) !== args.content) fail('INVALID_ARGUMENT', 'content must not contain invalid Unicode surrogate characters.');
      if (typeof args.revision !== 'string' || !/^[a-f0-9]{64}$/.test(args.revision)) fail('REVISION_REQUIRED', 'Saving requires the SHA-256 revision returned by source read.', 409);
    }
    // Module-global queues share locks across operation instances, keyed by the
    // canonical source rather than work id (several exports can share a source).
    return serial(`source:${pathKey(selected.file)}`, () => serial(pathKey(libraryPath), async () => {
      const data = await readIndex();
      const item = data.items.find(entry => entry.id === selected.id);
      if (!item || sourceOf(item) !== selected.file) fail('SOURCE_CHANGED', 'The registered source association changed; reload the work.', 409);
      const before = await sourceSnapshot(selected.file);
      if (!writing) return { ...sourceResult(item, before), content: before.content };
      const conflict = () => fail('REVISION_CONFLICT', 'Source changed on disk. Your edit has not been saved; keep it and reload the current source before merging.', 409);
      if (before.revision !== args.revision) conflict();
      const directory = path.dirname(selected.file);
      const token = `${Date.now()}-${randomUUID()}`;
      const backupPath = path.join(directory, `${path.basename(selected.file)}.${token}.huashu.bak`);
      const temporary = path.join(directory, `.huashu-edit-${token}.tmp`);
      let staged;
      try {
        await sourceLocation(selected.file, before.location);
        // Exclusive creation and fsync complete before the original is replaced.
        // Backup names and destinations are generated here, never supplied by a caller.
        await durableExclusive(backupPath, before.bytes);
        await sourceLocation(backupPath, { ...before.location, path: backupPath });
        await syncDirectory(directory);
        await sourceLocation(selected.file, before.location);
        staged = await durableExclusive(temporary, bytes);
        await sourceLocation(temporary, { ...before.location, path: temporary });
        if (!sameFile(staged, await fs.lstat(temporary))) fail('UNSAFE_PATH', 'Staged source changed before saving.', 403);
        const registered = (await readIndex()).items.find(entry => entry.id === item.id);
        if (!registered || sourceOf(registered) !== selected.file) fail('SOURCE_CHANGED', 'The source association changed before saving; reload the work.', 409);
        const current = await sourceSnapshot(selected.file, before.location);
        if (current.revision !== args.revision || !sameFile(before.info, current.info)) conflict();
        await fs.rename(temporary, selected.file);
        staged = undefined;
        await syncDirectory(directory);
        const after = await sourceSnapshot(selected.file, before.location);
        if (after.revision !== revisionOf(bytes)) fail('SOURCE_CHANGED', 'Source changed immediately after saving; the original backup is preserved.', 409);
        // Re-read before the metadata update as well: external damage to the
        // library while an edit was being saved must never be overwritten.
        const latest = await readIndex();
        const updated = latest.items.find(entry => entry.id === item.id);
        if (!updated || sourceOf(updated) !== selected.file) fail('SOURCE_CHANGED', 'Source was saved with a backup, but its library association changed; reload the library.', 409);
        updated.updatedAt = new Date().toISOString();
        await saveIndex(latest);
        return { ...sourceResult(updated, after), saved: true, backupPath, item: publicItem(updated) };
      } finally {
        if (staged) {
          // A substituted parent must never redirect even cleanup outside the
          // original directory. Leave an unreachable temporary for manual review.
          try {
            await sourceLocation(temporary, { ...before.location, path: temporary });
            if (sameFile(staged, await fs.lstat(temporary))) await fs.unlink(temporary);
          } catch (error) { if (!['ENOENT', 'SOURCE_NOT_FOUND', 'UNSAFE_PATH'].includes(error.code)) throw error; }
        }
      }
    }));
  }
  async function workFile(id) {
    const item = (await serial(pathKey(libraryPath), readIndex)).items.find(entry => entry.id === id);
    if (!item) fail('NOT_FOUND', 'Work was not found.', 404);
    const reference = await fileReference(item.path);
    return { file: reference.location.path, item: publicItem(item), mime: MIME[path.extname(reference.location.path).toLowerCase()] };
  }
  async function assetFile(relative) {
    const file = await safeResource(upstreamRoot, relative);
    const extension = path.extname(file).toLowerCase();
    if (!IMAGES.has(extension)) fail('UNSUPPORTED_RESOURCE', 'Only upstream images are available as static assets.', 415);
    return { file, mime: MIME[extension], attachment: extension === '.svg' };
  }
  async function skillDefinition() {
    const file = await safeResource(upstreamRoot, 'SKILL.md');
    const parsed = splitSkill(await boundedText(file));
    return { ...parsed, file, root: await fs.realpath(upstreamRoot), content: `${parsed.body}\n\n---\n\n## 在 DSH 花叔设计插件中使用\n\n本 skill 的资源根目录（$HD）是 \`${await fs.realpath(upstreamRoot)}\`。上文 scripts/、assets/、references/ 均相对此绝对目录。\n\n花叔工作台制作的作品由花叔作品库登记、预览和编辑；用户明确选择其它作品库时按用户选择执行。\n\n交付作品后调用 \`huashu_design\`：action 为 \`add\`，args 包含 \`title\`、交付文件绝对 \`path\`、\`module\`（web/deck/infographic/app/motion/critique/xiaohongshu）、可选目录中 style id 与 note。交付时保留可编辑源码，并以绝对 \`sourcePath\` 关联登记；HTML/HTM/SVG 本体默认作为源码。图片、PDF、视频属于导出结果，只有关联原始源码后才能编辑源码，不能把导出文件宣称为可逆编辑。登记仅保存元数据，不复制文件。\n\n续改已有作品时先调用 action=\`edit\`，args 含作品 \`id\` 和可选 \`brief\`，按照返回的草稿修改实际工程，沿用既有内容与方向，不另起作品。保存后对原交付 path 调用 add 更新同条登记。轻量源码编辑使用 action=\`source\`：以 id 读取完整 UTF-8 源码与 revision；保存需原 revision 和完整 content，最多 ${LIMITS.sourceBytes} 字节，自动保留唯一备份，冲突时保留编辑内容并重新读取再合并。工具不执行源码。\n\n任何创作类型都可由用户显式选 draft 的 outputMode=\`layered\` 交付 PNG + 原生 .ppdesign，保留独立文字、形状和图片图层（默认 \`standard\` 常规输出）。先调用 \`huashu_printpress\` 的 action=\`guide\` 按需读取坐标、字号及图片资源契约，再经现有 call 构建文档并用 action=\`publish\` 交付登记。publish 使用顶层参数 designId、revision、title、module、style、previewPath、projectPath 和 \`allowWrite:true\`；分层交付加 \`requireLayers:true\`，单图片续改保留实际图层结构；顶层传 workId 可回存既有作品。作品可通过绝对 projectPath 关联 .ppdesign，工程不作为文本 sourcePath，已有源码关联继续保留。\n` };
  }
  const handlers = { catalog, read: resource, resource, draft, edit, source, list, add, linkProject, remove, delete: deleteWork, 'library.list': list, 'library.add': add, 'library.remove': remove, 'library.delete': deleteWork };
  async function operation(action, args = {}) {
    if (typeof action !== 'string' || !Object.hasOwn(handlers, action)) fail('UNKNOWN_ACTION', 'Unknown huashu-design action.');
    if (!object(args)) fail('INVALID_ARGUMENT', 'args must be a JSON object.');
    return handlers[action](args);
  }
  return { operation, catalog, workFile, assetFile, skillDefinition, upstreamRoot, libraryPath };
}
