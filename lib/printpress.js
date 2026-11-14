import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createHostImages } from './host-images.js';
import { inspectPrintpress, discoverPrintpress, createPrintpressShim } from './printpress-discovery.js';

export const PRINTPRESS_BASE = '/huashu-design/printpress';
const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'printpress-manifest.json'), 'utf8'));
const blocked = new Set(['app:changeDataDir', 'app:resetDataDir', 'app:relaunch', 'app:startUpdate', 'app:installUpdate']);
const mediaTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const MAX_BYTES = 96 * 1024 * 1024;
function failure(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }

export function createPrintpressRuntime(config = {}) {
  // PrintPress is optional and may be absent entirely. Resolve the configured
  // root only when one actually exists: path.resolve(undefined) throws, which
  // would take the whole plugin's tool registration down with it instead of
  // just reporting "not installed".
  const configuredRoot = config.printpressRoot || process.env.HUASHU_PRINTPRESS_ROOT || manifest.sourceRoot;
  const sourceRoot = typeof configuredRoot === 'string' && configuredRoot.trim()
    ? path.resolve(configuredRoot)
    : path.join(os.tmpdir(), 'huashu-printpress-not-configured');
  const explicitRoot = typeof configuredRoot === 'string' && !!configuredRoot.trim();
  async function locate() { return explicitRoot ? inspectPrintpress(sourceRoot, manifest.version) : discoverPrintpress(manifest.version); }
  const events = new EventEmitter();
  events.setMaxListeners(100);
  let child, starting, ready, disposed = false, nextId = 0, errorState = null, staging, stderr = '';
  const pending = new Map(), hostRequests = new Map();
  let editor, images = createHostImages(), ownedImages = true, imageSubscription;
  function attachEditor(value) { editor = value; }
  function attachImages(value) {
    imageSubscription?.();
    if (ownedImages) images.dispose();
    images = value; ownedImages = false;
    imageSubscription = images.subscribe(capabilities => {
      const publish = () => emit({ event: 'host:capabilities', payload: capabilities });
      if (ready && child) request('hostCapabilities', { capabilities }).then(publish, cause => emit({ event: 'bridge:error', payload: { code: cause.code, message: cause.message } }));
      else publish();
    });
  }
  function cancelHostRequests() { for (const controller of hostRequests.values()) controller.abort(); hostRequests.clear(); }
  function processHostImage(instance, payload) {
    if (!payload || typeof payload.requestId !== 'string' || hostRequests.has(payload.requestId)) return;
    const controller = new AbortController(); hostRequests.set(payload.requestId, controller);
    Promise.resolve().then(() => images.process(payload, { signal: controller.signal })).then(
      result => ({ requestId: payload.requestId, result }),
      cause => ({ requestId: payload.requestId, error: { code: cause.code || 'HOST_IMAGE_ERROR', message: cause.message } })
    ).then(reply => {
      if (child === instance && !disposed && !controller.signal.aborted) return request('hostImageResult', reply, 30000).catch(() => {});
    }).finally(() => { if (hostRequests.get(payload.requestId) === controller) hostRequests.delete(payload.requestId); });
  }
  const operations = manifest.operations.filter(item => !blocked.has(item.name));
  const emit = message => events.emit('message', message);
  function rejectPending(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  async function status() {
    const installation = await locate();
    return { available: !!installation, running: !!ready, phase: ready ? 'ready' : starting ? 'starting' : errorState ? 'error' : 'idle', root: installation?.root || sourceRoot, ...(installation ? { kind: installation.kind } : {}), version: manifest.version, operationCount: operations.length, ...(ready ? { dataDir: ready.dataDir } : {}), ...(errorState ? { error: errorState } : {}) };
  }
  async function start() {
    if (disposed) throw failure('RUNTIME_CLOSED', '批印坊插件已关闭', 503);
    if (ready) return ready;
    if (starting) return starting;
    // Claim the startup promise before checking files: SSE and UI requests arrive together.
    starting = (async () => {
      const installation = await locate();
      if (disposed) throw failure('RUNTIME_CLOSED', '批印坊插件已关闭', 503);
      if (!installation) throw failure('PRINTPRESS_NOT_FOUND', '未找到兼容的批印坊，请检查安装版本或 printpressRoot 配置。', 503);
      const shim = installation.kind === 'packaged' ? await createPrintpressShim(installation, path.join(directory, 'printpress-worker.cjs')) : null;
      if (disposed) { if (shim) await fs.rm(shim.dir, { recursive: true, force: true }); throw failure('RUNTIME_CLOSED', '批印坊插件已关闭', 503); }
      return new Promise((resolve, reject) => {
      const env = { ...process.env, HUASHU_PRINTPRESS_ROOT: installation.domainRoot || installation.root, HUASHU_PRINTPRESS_IMAGE_CAPABILITIES: JSON.stringify(images.status()), HUASHU_PRINTPRESS_LOCAL_FAST_FALLBACK: config.localFastFallback === false ? '0' : '1' };
      delete env.HUASHU_PRINTPRESS_PACKAGED; delete env.HUASHU_PRINTPRESS_RESOURCES; delete env.HUASHU_PRINTPRESS_DESKTOP_USER_DATA;
      if (shim) { env.HUASHU_PRINTPRESS_PACKAGED = '1'; env.HUASHU_PRINTPRESS_RESOURCES = installation.resources; }
      delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
      if (config.printpressDataDir) { env.PRINTPRESS_DATA_DIR = path.resolve(config.printpressDataDir); delete env.PRINTPRESS_ASSET_DIR; }
      else delete env.PRINTPRESS_DATA_DIR;
      if (config.printpressAssetDir) env.PRINTPRESS_ASSET_DIR = path.resolve(config.printpressAssetDir);
      if (config.printpressUserData) env.HUASHU_PRINTPRESS_USER_DATA = path.resolve(config.printpressUserData);
      if (shim) {
        const isolatedRoot = path.join(os.homedir(), '.dsh', 'huashu-printpress');
        if (!config.printpressAssetDir) delete env.PRINTPRESS_ASSET_DIR;
        if (!config.printpressUserData) env.HUASHU_PRINTPRESS_USER_DATA = path.join(isolatedRoot, 'runtime');
      }
      const instance = spawn(shim?.executable || installation.executable, shim ? [] : [path.join(directory, 'printpress-worker.cjs')], { cwd: shim?.dir || installation.root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      if (shim) instance.once('close', () => {
        fs.rm(shim.dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 })
          .catch(() => emit({ event: 'bridge:error', payload: { code: 'RUNTIME_CLEANUP_FAILED', message: '批印坊临时运行目录清理失败。' } }));
      });
      child = instance;
      let buffer = '', settled = false;
      const timer = setTimeout(() => { const error = failure('START_TIMEOUT', '批印坊后台启动超时，请重试', 504); finish(error); instance.kill(); }, 30000);
      timer.unref?.();
      function finish(error, value) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { errorState = { code: error.code || 'START_FAILED', message: error.message }; reject(error); }
        else {
          ready = value; errorState = null;
          // A provider may register after spawn but before ready. Queue the current
          // capabilities before resolving startup so the first business call sees them.
          request('hostCapabilities', { capabilities: images.status() }).catch(cause => emit({ event: 'bridge:error', payload: { code: cause.code, message: cause.message } }));
          resolve(value);
        }
      }
      instance.stdout.setEncoding('utf8');
      instance.stdout.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_BYTES) { const error = failure('PROTOCOL_LIMIT', '批印坊返回内容超过传输限制', 502); finish(error); rejectPending(error); instance.kill(); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch {
            const error = failure('PROTOCOL_ERROR', '批印坊后台返回了无法识别的内容，请重新连接', 502);
            finish(error); rejectPending(error); instance.kill(); return;
          }
          if (message.event === 'ready') finish(null, message.payload);
          if (message.event === 'fatal') {
            const error = failure(message.error?.code || 'ENGINE_FAILED', message.error?.message || '批印坊后台不可用', 503);
            finish(error); rejectPending(error); errorState = { code: error.code, message: error.message };
          }
          if (message.event === 'host:imageRequest') processHostImage(instance, message.payload);
          else if (message.event === 'host:imageCancel') hostRequests.get(message.payload?.requestId)?.abort();
          else if (message.event) emit(message);
          if (message.id !== undefined) {
            const item = pending.get(message.id);
            if (!item) continue;
            pending.delete(message.id); clearTimeout(item.timer);
            message.ok ? item.resolve(message.data) : item.reject(failure(message.error?.code || 'PRINTPRESS_ERROR', message.error?.message || '批印坊操作未完成', 400));
          }
        }
      });
      instance.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
      instance.on('error', error => { finish(failure('START_FAILED', error.message, 503)); rejectPending(error); });
      instance.on('exit', code => {
        const error = failure('ENGINE_EXITED', errorState?.message || `批印坊后台已退出（${code ?? '中断'}）`, 503);
        finish(error); rejectPending(error); cancelHostRequests();
        if (child === instance) { child = null; ready = null; starting = null; }
        emit({ event: 'bridge:closed', payload: { code } });
      });
      instance.stdin.on('error', error => rejectPending(failure('ENGINE_CLOSED', error.message, 503)));
      });
    })();
    try { return await starting; } catch (error) { starting = null; throw error; }
  }
  async function request(method, args = {}, timeoutMs = 15 * 60 * 1000) {
    await start();
    const instance = child;
    if (!instance || instance.exitCode !== null) throw failure('ENGINE_CLOSED', '批印坊后台已停止，请重试', 503);
    const id = ++nextId;
    const payload = JSON.stringify({ id, method, ...args }) + '\n';
    if (Buffer.byteLength(payload) > MAX_BYTES) throw failure('BODY_TOO_LARGE', '请求内容超过 96 MB 限制', 413);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(failure('OPERATION_TIMEOUT', '操作尚未返回；请在工作台检查任务状态，避免重复提交', 504)); }, timeoutMs);
      timer.unref?.(); pending.set(id, { resolve, reject, timer });
      instance.stdin.write(payload, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
    });
  }
  async function upload(name, base64) {
    if (typeof name !== 'string' || name !== path.basename(name) || /[/\\\x00-\x1f]/.test(name) || !/\.(csv|xlsx?|xlsm)$/i.test(name)) throw failure('INVALID_UPLOAD', '仅接受 Excel 或 CSV 名单文件');
    if (typeof base64 !== 'string' || base64.length > 90 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw failure('INVALID_UPLOAD', '上传文件编码无效或超过 64 MB 限制');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > 64 * 1024 * 1024) throw failure('BODY_TOO_LARGE', '名单文件超过 64 MB 限制', 413);
    staging ||= fs.mkdtemp(path.join(os.tmpdir(), 'huashu-printpress-upload-'));
    const target = path.join(await staging, randomUUID() + '-' + name);
    await fs.writeFile(target, bytes, { flag: 'wx' });
    return { filePath: target };
  }
  async function media(relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('..') || /[\\\x00-\x1f]/.test(relative)) throw failure('UNSAFE_PATH', '媒体路径无效', 403);
    const item = await request('media', { url: 'pp://media/' + relative }, 30000);
    const mime = mediaTypes[path.extname(item.file || '').toLowerCase()];
    if (!mime) throw failure('UNSUPPORTED_MEDIA', '此接口只提供照片、底图和字体', 403);
    return { file: item.file, mime };
  }
  async function operation(action, args = {}) {
    if (action === 'status') return status();
    if (action === 'start') return start();
    if (action === 'capabilities') return { policy: 'host-first-fast-fallback', ...(ready ? await request('imageCapabilities') : { host: images.status(), effective: { phase: 'not-started', reason: '打开编辑器后检查快速模型；宿主提供方状态可直接读取' }, fallback: { enabled: config.localFastFallback !== false, ready: null } }), native: { pixelEdit: true, projectPackages: true, pdf: true, printing: true } };
    if (['guide', 'handoff', 'publish'].includes(action)) {
      if (!editor) throw failure('EDITOR_UNAVAILABLE', '作品编辑通道尚未加载', 503);
      return editor[action](args);
    }
    if (action === 'operations') {
      const filtered = operations.filter(item => !args.query || item.name.includes(String(args.query)));
      const offset = Math.max(0, Number.isSafeInteger(args.offset) ? args.offset : 0), limit = Math.min(50, Math.max(1, Number.isSafeInteger(args.limit) ? args.limit : 20));
      return { version: manifest.version, total: filtered.length, items: filtered.slice(offset, offset + limit), nextOffset: offset + limit < filtered.length ? offset + limit : null };
    }
    if (action === 'call') {
      if (typeof args.name !== 'string' || !Array.isArray(args.args) || !operations.some(item => item.name === args.name)) throw failure('UNKNOWN_OP', '批印坊操作名称或参数无效');
      return request('call', { name: args.name, args: args.args });
    }
    if (action === 'invoke') {
      if (typeof args.name !== 'string' || !operations.some(item => item.name === args.name)) throw failure('UNKNOWN_OP', '请先查询可用的批印坊操作');
      return request('invoke', { name: args.name, params: args.params || {}, allowWrite: args.allowWrite === true });
    }
    if (action === 'upload') return upload(args.name, args.base64);
    throw failure('UNKNOWN_ACTION', '未知批印坊动作');
  }
  async function dispose() {
    if (disposed) return;
    disposed = true;
    cancelHostRequests(); imageSubscription?.();
    if (ownedImages) images.dispose();
    const instance = child;
    if (instance && instance.exitCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { instance.kill(); }, 20000);
        const finalTimer = setTimeout(resolve, 22000);
        instance.once('close', () => { clearTimeout(timer); clearTimeout(finalTimer); resolve(); });
        instance.stdin.end();
      });
    }
    rejectPending(failure('RUNTIME_CLOSED', '批印坊插件已关闭', 503));
    events.removeAllListeners();
    if (staging) await fs.rm(await staging, { recursive: true, force: true });
  }
  return { status, start, request, media, operation, dispose, attachEditor, attachImages, projectFile(id) { if (!editor) throw failure('EDITOR_UNAVAILABLE', '作品编辑通道尚未加载', 503); return editor.projectFile(id); }, subscribe(callback) { events.on('message', callback); return () => events.off('message', callback); }, diagnostics() { return { stderr, pid: child?.pid }; } };
}

export function createPrintpressTool(runtime) {
  return {
    name: 'huashu_printpress',
    description: 'Create editable layered graphics, open registered Huashu images/projects in the editor, and publish PNG plus .ppdesign back to the same work. Read guide for the native document contract, capabilities for real host AI availability, and operations for lists/photos/batch output. Mutating calls require explicit allowWrite.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['status', 'capabilities', 'guide', 'handoff', 'publish', 'operations', 'call'], description: 'guide: native layers and delivery contract; capabilities: actual host image providers; handoff: open/import a registered work; publish: export PNG+.ppdesign and register/update it; operations/call: domain API.' },
      workId: { type: 'string', maxLength: 80, description: 'handoff: required registered work ID; publish: optional existing work to update without replacing its original file.' },
      mode: { type: 'string', enum: ['image', 'layers'], description: 'handoff: optional editor hint; actual project layers are preserved.' },
      designId: { type: 'string', description: 'publish: saved native design ID returned by design:save.' },
      revision: { type: 'integer', minimum: 1, description: 'publish: fixed saved revision to export.' },
      title: { type: 'string', maxLength: 240 },
      module: { type: 'string', enum: ['web', 'deck', 'infographic', 'app', 'motion', 'critique', 'xiaohongshu'] },
      style: { type: 'string', description: 'publish: optional catalog style ID.' },
      previewPath: { type: 'string', description: 'publish: optional absolute unused PNG output path.' },
      projectPath: { type: 'string', description: 'publish: optional absolute unused .ppdesign output path.' },
      dpi: { type: 'integer', enum: [150, 300, 600], description: 'publish: resolution; default 150. Match this to the document px/mm conversion.' },
      requireLayers: { type: 'boolean', description: 'publish: true rejects single-layer flattened output when a layered deliverable was requested.' },
      query: { type: 'string', description: 'operations: filter exact operation names by substring, such as photo: or print:.' },
      offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
      operation: { type: 'string', description: 'call: exact name returned by operations.' },
      params: { type: 'object', additionalProperties: true, description: 'call: named parameters from the operation’s discovered contract.' },
      allowWrite: { type: 'boolean', description: 'Default false. Set true only for user-authorized handoff, publish or mutating domain calls.' }
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; } },
    async execute(input) {
      if (['handoff', 'publish'].includes(input.action)) {
        if (input.allowWrite !== true) return { ok: false, error: { code: 'WRITE_FORBIDDEN', message: '编辑或发布工程需用户授权后显式设置 allowWrite=true' } };
        try { return { ok: true, data: await runtime.operation(input.action, input) }; }
        catch (error) { return { ok: false, error: { code: error.code || 'EDITOR_ERROR', message: error.message } }; }
      }
      if (input.action === 'call') {
        try { return { ok: true, data: await runtime.operation('invoke', { name: input.operation, params: input.params, allowWrite: input.allowWrite === true }) }; }
        catch (error) { return { ok: false, error: { code: error.code || 'PRINTPRESS_ERROR', message: error.message } }; }
      }
      return runtime.operation(input.action, input);
    }
  };
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
}
async function readBody(req) {
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) { req.resume(); throw failure('BODY_TOO_LARGE', '请求内容超过 96 MB 限制', 413); }
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BYTES) throw failure('BODY_TOO_LARGE', '请求内容超过 96 MB 限制', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('INVALID_JSON', '请求内容必须为 JSON'); }
}
export function createPrintpressHttp(runtime, connection, getOrigin, serveFile) {
  return async (req, res, pathname) => {
    try {
      const denied = connection.requestRejection(req);
      if (denied !== undefined) throw failure('UNAUTHORIZED', '需要登录当前工作台', denied);
      if (pathname === PRINTPRESS_BASE + '/api') {
        if (req.method !== 'POST') throw failure('METHOD_NOT_ALLOWED', '请使用 POST', 405);
        const expected = new URL(getOrigin());
        const hostOrigin = new URL(expected.protocol + '//' + req.headers.host).origin;
        if (req.headers.origin !== hostOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw failure('CROSS_ORIGIN', '操作必须来自当前工作台', 403);
        if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) throw failure('UNSUPPORTED_MEDIA_TYPE', '请使用 JSON 请求', 415);
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || !['start', 'call', 'upload', 'handoff', 'publish', 'capabilities', 'guide'].includes(body.action)) throw failure('INVALID_ACTION', '工作台动作无效');
        send(res, 200, { ok: true, data: await runtime.operation(body.action, body) }); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw failure('METHOD_NOT_ALLOWED', '此入口只接受读取', 405);
      if (pathname === PRINTPRESS_BASE + '/status') { send(res, 200, { ok: true, data: await runtime.status() }); return; }
      if (pathname === PRINTPRESS_BASE + '/events') {
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(); return; }
        // Subscribe before starting so progress from the first operation is visible.
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const write = message => { if (!res.destroyed) res.write('data: ' + JSON.stringify(message) + '\n\n'); };
        res.write(': connected\n\n');
        const unsubscribe = runtime.subscribe(write);
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000); heartbeat.unref?.();
        res.once('close', () => { clearInterval(heartbeat); unsubscribe(); });
        runtime.start().then(info => write({ event: 'ready', payload: info }), error => write({ event: 'bridge:error', payload: { code: error.code, message: error.message } }));
        return;
      }
      const projectMatch = pathname.match(/^\/huashu-design\/printpress\/project\/([a-zA-Z0-9-]{1,80})$/);
      if (projectMatch) { await serveFile(req, res, () => runtime.projectFile(projectMatch[1])); return; }
      if (pathname.startsWith(PRINTPRESS_BASE + '/media/')) {
        const relative = (req.url || '').split('?')[0].slice((PRINTPRESS_BASE + '/media/').length);
        await serveFile(req, res, () => runtime.media(relative)); return;
      }
      throw failure('NOT_FOUND', '未找到批印坊接口', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      send(res, error.status || 500, { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : '批印坊未能完成操作' } });
    }
  };
}
