import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BASE, LIMITS, OperationError, createOperations } from './core.js';
import { PRINTPRESS_BASE, createPrintpressRuntime, createPrintpressHttp, createPrintpressTool } from './printpress.js';
import { createWorkEditor } from './work-editor.js';
import { createHostImages } from './host-images.js';
import { createWorkPreview } from './work-preview.js';

export const name = 'huashu-design';
export const inject = ['webServer', 'connection', 'skills', 'tools'];
const CSP = "sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP };
function send(req, res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(req.method === 'HEAD' ? undefined : body);
}
function reject(code, message, status = 400) { throw new OperationError(code, message, status); }
function readBody(req) {
  const rawLength = req.headers['content-length'];
  if (rawLength && (!/^\d+$/.test(rawLength) || Number(rawLength) > LIMITS.bodyBytes)) { req.resume(); reject('BODY_TOO_LARGE', 'JSON body exceeds the size limit.', 413); }
  return new Promise((resolve, rejectPromise) => {
    const chunks = [];
    let length = 0;
    const cleanup = () => { clearTimeout(timer); req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted); };
    const fail = error => { cleanup(); req.resume(); rejectPromise(error); };
    const onData = chunk => {
      length += chunk.length;
      if (length > LIMITS.bodyBytes) return fail(new OperationError('BODY_TOO_LARGE', 'JSON body exceeds the size limit.', 413));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { rejectPromise(new OperationError('INVALID_JSON', 'Request body must be valid JSON.')); }
    };
    const onError = () => fail(new OperationError('INVALID_BODY', 'Request body could not be read.'));
    const onAborted = () => fail(new OperationError('INVALID_BODY', 'Request body was interrupted.'));
    const timer = setTimeout(() => fail(new OperationError('BODY_TIMEOUT', 'Request body timed out.', 408)), 15000);
    timer.unref?.();
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAborted);
  });
}
function sameOrigin(req, expectedOrigin) {
  if (typeof req.headers.origin !== 'string' || typeof req.headers.host !== 'string') return false;
  try {
    const expected = new URL(expectedOrigin);
    const origin = new URL(req.headers.origin);
    const requestOrigin = new URL(`${expected.protocol}//${req.headers.host}`);
    // The Connection service has already admitted Host. Use the listener's protocol,
    // never forwarded headers, and require a canonical browser Origin with no path.
    return origin.origin === req.headers.origin && origin.origin === requestOrigin.origin && expected.protocol === origin.protocol;
  } catch { return false; }
}
function disposition(file, attachment) {
  const filename = path.basename(file);
  const fallback = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
async function serveFile(req, res, lookup) {
  const item = await lookup();
  const handle = await fs.open(item.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    // Re-run the policy after opening and compare the open inode to its current path.
    const verified = await lookup();
    const current = await fs.stat(verified.file);
    if (item.file !== verified.file || !info.isFile() || info.dev !== current.dev || info.ino !== current.ino) reject('UNSAFE_PATH', 'File changed while opening.', 403);
    const attachment = item.attachment || /^(text\/html|image\/svg\+xml)/.test(item.mime);
    const headers = { ...SECURITY, 'Content-Type': item.mime, 'Content-Disposition': disposition(item.file, attachment), 'Accept-Ranges': 'bytes' };
    let start = 0, end = info.size - 1;
    let status = 200;
    if (req.headers.range) {
      const match = typeof req.headers.range === 'string' && req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2]) || !info.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }); res.end(); return;
      }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }); res.end(); return;
      }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !info.size) { res.end(); return; }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await handle.close(); }
}
export function createHttpHandler(operations, connection, getOrigin, printpress) {
  const handlePrintpress = printpress ? createPrintpressHttp(printpress, connection, getOrigin, serveFile) : null;
  const workPreview = createWorkPreview(operations);
  return async (req, res) => {
    try {
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) { send(req, res, rejection, { error: { code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message: 'Request rejected by DSH Connection.' } }); return; }
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) { send(req, res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET, HEAD or POST.' } }, { Allow: 'GET, HEAD, POST' }); return; }
      // Do not normalize the URL first: URL() removes dot-segments before policy sees them.
      let pathname;
      try { pathname = decodeURIComponent((req.url || '').split('?')[0]); }
      catch { reject('INVALID_URL', 'URL contains invalid encoding.'); }
      if (handlePrintpress && (pathname === PRINTPRESS_BASE || pathname.startsWith(PRINTPRESS_BASE + '/'))) { await handlePrintpress(req, res, pathname); return; }
      if (pathname === `${BASE}/api/action`) {
        if (req.method !== 'POST') { send(req, res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for actions.' } }, { Allow: 'POST' }); return; }
        if (!sameOrigin(req, getOrigin()) || req.headers['sec-fetch-site'] === 'cross-site') reject('CROSS_ORIGIN', 'Action requires the same browser origin.', 403);
        if (typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'])) reject('UNSUPPORTED_MEDIA_TYPE', 'Action requires application/json.', 415);
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') reject('INVALID_ARGUMENT', 'Expected {action,args}.');
        send(req, res, 200, body.action === 'preview' ? await workPreview.render(body.args?.id ?? body.args?.workId) : await operations.operation(body.action, body.args ?? {})); return;
      }
      if (req.method === 'POST') { send(req, res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'This route is read-only.' } }, { Allow: 'GET, HEAD' }); return; }
      if (pathname === `${BASE}/api/catalog`) { send(req, res, 200, await operations.operation('catalog')); return; }
      if (pathname.startsWith(`${BASE}/assets/`)) {
        const relative = pathname.slice(`${BASE}/assets/`.length);
        await serveFile(req, res, () => operations.assetFile(relative)); return;
      }
      const thumbnail = pathname.match(/^\/huashu-design\/works\/([a-zA-Z0-9-]{1,80})\/thumbnail$/);
      if (thumbnail) { await serveFile(req, res, () => workPreview.thumbnail(thumbnail[1])); return; }
      const match = pathname.match(/^\/huashu-design\/works\/([a-zA-Z0-9-]{1,80})\/entry$/);
      if (match) { await serveFile(req, res, () => operations.workFile(match[1])); return; }
      reject('NOT_FOUND', 'Route was not found.', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
      const known = error instanceof OperationError;
      send(req, res, known ? error.status : missing ? 404 : 500, { error: { code: known ? error.code : missing ? 'NOT_FOUND' : 'INTERNAL_ERROR', message: known ? error.message : missing ? 'File was not found.' : 'Huashu Design could not complete this operation.' } });
    }
  };
}

export function createSkillProvider(operations) {
  const summary = definition => ({ name: 'huashu-design', description: definition.description, path: definition.file, source: 'bundled', provider: 'huashu-design', invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'directory', path: definition.root } });
  return {
    name: 'huashu-design',
    async list() {
      try {
        const definition = await operations.skillDefinition();
        return [{ ...summary(definition), rank: 600, locator: definition.file }];
      } catch (error) { if (['ENOENT', 'NOT_FOUND'].includes(error.code)) return []; throw error; }
    },
    async get(candidate) {
      const definition = await operations.skillDefinition();
      if (candidate.name !== 'huashu-design' || candidate.locator !== definition.file) return undefined;
      return { ...summary(definition), content: definition.content };
    },
  };
}

export function createTool(operations) {
  return {
    name: 'huashu_design',
    description: 'Browse Huashu Design guides and styles; draft a design or changes to an existing work; read and save registered editable source with revision checks and backups; manage the work library. Prompts are unsent; source is never executed. "remove" unregisters a work and keeps its files; "delete" removes the registration together with its deliverable, linked source and native project, and requires confirm: true.',
    parameters: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['catalog', 'read', 'draft', 'edit', 'source', 'list', 'add', 'remove', 'delete'], description: 'catalog discovers IDs; read loads guides/images/style notes; draft prepares a new design; edit prepares changes to an existing work; source reads/saves registered source; list/add/remove/delete manage the library. delete also unlinks the files it owns and is irreversible.' },
        args: { type: 'object', additionalProperties: false, properties: {
          section: { type: 'string', enum: ['tasks', 'styles', 'workflows', 'manifest'], description: 'catalog section; default styles for bounded tool output.' },
          task: { type: 'string', description: 'draft task ID; defaults to reference work module, then web. review-polish selects critique.' },
          style: { type: 'string', description: 'Catalog ID for draft/edit/add/list; read returns this style’s notes, without path.' },
          workflow: { type: 'string', description: 'draft workflow ID from catalog.' },
          workId: { type: 'string', maxLength: 80, description: 'Registered reference work ID for draft; alias of id for edit/source.' },
          brief: { type: 'string', maxLength: 8000, description: 'draft: design requirements; edit: requested changes while retaining the existing work.' },
          path: { type: 'string', maxLength: 4096, description: 'read: upstream-relative Markdown/image path; add: absolute existing HTML/PDF/image/video file.' },
          sourcePath: { type: 'string', maxLength: 4096, description: 'add: absolute existing UTF-8 editable source (HTML/HTM/SVG/MD/CSS/JS/MJS/JSON/TXT). For source/edit, optional exact match of the registered association, never an arbitrary target. HTML/HTM/SVG default to themselves; exports need an association.' },
          projectPath: { type: 'string', maxLength: 4096, description: 'add: absolute existing .ppdesign layered project associated with this preview. Enables one-click native editing; binary project is not a text source.' },
          outputMode: { type: 'string', enum: ['standard', 'layered'], description: 'draft: static graphic output. layered requests a real editable .ppdesign project plus PNG, using huashu_printpress guide and publish.' },
          content: { type: 'string', maxLength: LIMITS.sourceBytes, description: 'source only: omit to read complete text and revision; supply complete replacement text plus revision to save. Maximum 131072 UTF-8 bytes, preserving whitespace. Oversized sources are rejected without truncation.' },
          revision: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$', description: 'source save: required SHA-256 revision from the latest source read. A disk change returns conflict without overwriting either version.' },
          title: { type: 'string', maxLength: 240, description: 'add: work title.' },
          module: { type: 'string', enum: ['web', 'deck', 'infographic', 'app', 'motion', 'critique', 'xiaohongshu'], description: 'add task or list/catalog filter.' },
          note: { type: 'string', maxLength: 4000, description: 'add: reuse note.' },
          id: { type: 'string', maxLength: 80, description: 'Required registered work ID for remove/delete/edit/source; edit/source also accept workId. source only edits this work’s associated source.' },
          confirm: { type: 'boolean', description: 'delete only: must be true. Deleting removes the registration and permanently deletes the deliverable, its linked editable source and its native project file.' },
          offset: { type: 'integer', minimum: 0, description: 'List/catalog item offset or read character offset; default 0.' },
          limit: { type: 'integer', minimum: 1, maximum: LIMITS.read, description: 'List/catalog page size 1–100 (default 24); read character limit 1–16000 (default 8000).' },
        } },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; } },
    async execute(input) {
      const args = input.args ?? {};
      return operations.operation(input.action, input.action === 'catalog' ? { ...args, section: args.section || 'styles' } : args);
    },
  };
}

export function apply(ctx, config = {}) {
  const operations = createOperations(config);
  const printpress = createPrintpressRuntime(config);
  const imageProviders = createHostImages();
  printpress.attachImages(imageProviders);
  printpress.attachEditor(createWorkEditor(operations, printpress));
  ctx.effect(() => () => imageProviders.dispose());
  ctx.effect(() => () => printpress.dispose());
  ctx.effect(() => ctx.provide('huashuImageProviders', imageProviders));
  ctx.effect(() => ctx.provide('huashuDesign', operations));
  ctx.effect(() => ctx.provide('huashuPrintpress', printpress));
  ctx.effect(() => ctx.tools.register(createTool(operations)));
  ctx.effect(() => ctx.tools.register(createPrintpressTool(printpress)));
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(operations)));
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: BASE, handler: createHttpHandler(operations, ctx.connection, () => ctx.webServer.getOrigin(), printpress) }));
}
