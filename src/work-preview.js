import { installInlineTextEditor } from './inline-text-editor.js';

export const PREVIEW_NAMESPACE = 'hshu-work-preview:v1';
export const PREVIEW_SANDBOX = 'allow-scripts allow-downloads';
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
export const PREVIEW_DRAFT_LIMIT = 128 * 1024;
const SOURCE_ENDPOINT = '/huashu-design/api/action';
const byteSize = value => new TextEncoder().encode(value).length;
const failure = (code, message) => Object.assign(new Error(message), { code });
const validWorkId = value => typeof value === 'string' && value.length > 0 && value.length <= 160;

export function htmlPreviewable(item) {
  return item?.mime?.toLowerCase().split(';')[0] === 'text/html' || /\.html?$/i.test(item?.path || '');
}
export function htmlThumbnailUrl(item) {
  return '/huashu-design/works/' + encodeURIComponent(item.id) + '/thumbnail' + (item.updatedAt ? '?updatedAt=' + encodeURIComponent(item.updatedAt) : '');
}
export const MINIATURE_CSP = PREVIEW_CSP.replace("script-src 'unsafe-inline'", "script-src 'none'");
export const previewCacheKey = item => String(item.id) + '\u0000' + String(item.updatedAt || '');

export function createWorkPreviewCache(load, limit = 6) {
  const entries = new Map();
  return {
    invalidate(item) { entries.delete(previewCacheKey(item)); },
    get(item, { reload = false } = {}) {
      const key = previewCacheKey(item);
      if (reload) entries.delete(key);
      if (entries.has(key)) { const value = entries.get(key); entries.delete(key); entries.set(key, value); return value; }
      const pending = Promise.resolve().then(() => load(item)).then(value => {
        if (value?.kind !== 'html' || value.workId !== item.id || typeof value.html !== 'string') throw failure('INVALID_PREVIEW', 'The HTML preview belongs to another work.');
        return value;
      });
      entries.set(key, pending);
      pending.catch(() => { if (entries.get(key) === pending) entries.delete(key); });
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return pending;
    }
  };
}

// Gallery miniatures have no scripts, origin access, storage proxy or host RPC.
export function miniatureDocument(preview) {
  let html = preview.html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? html;
  if (!/<(?:img|svg|picture)\b/i.test(body) && !body.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/<[^>]+>/g, '').trim()) return null;
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + MINIATURE_CSP + '"><style>html{pointer-events:none!important}#pp-inline-editor{display:none!important}[data-pp-edit]{outline:none!important}</style>' + html.replace(/^\s*<!doctype\s+html[^>]*>/i, '');
}

export function previewNonce(crypto = globalThis.crypto) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

// Only the current work's known inline-editor draft is exposed. No host storage
// enumeration occurs, and legacy migration reads one exact key for this work.
export function createPreviewDraftStore(workId, storage) {
  if (!validWorkId(workId)) throw failure('INVALID_WORK', 'Invalid preview work.');
  const rawKey = 'printpress:inline:' + workId, editorKey = 'huashu:inline:' + workId;
  const keys = [rawKey, editorKey], prefix = 'hshu-preview:' + encodeURIComponent(workId) + ':';
  const marker = prefix + '__initialized', cache = Object.create(null);
  let error = '';
  const check = (name, value) => {
    if (!keys.includes(name)) throw failure('PREVIEW_STORAGE_DENIED', 'This draft key does not belong to the current work.');
    const others = Object.entries(cache).filter(([key]) => key !== name).reduce((sum, [key, text]) => sum + byteSize(key) + byteSize(text), 0);
    if (value !== undefined && (typeof value !== 'string' || others + byteSize(name) + byteSize(value) > PREVIEW_DRAFT_LIMIT)) throw failure('PREVIEW_STORAGE_LIMIT', 'The preview drafts exceed 128 KiB.');
  };
  try {
    storage ||= globalThis.localStorage;
    if (!storage) throw new Error('Browser draft storage is unavailable.');
    let legacy = storage.getItem(prefix + rawKey);
    if (legacy === null && storage.getItem(marker) !== '1') {
      legacy = storage.getItem(rawKey);
      if (legacy !== null) { check(rawKey, legacy); storage.setItem(prefix + rawKey, legacy); }
      storage.setItem(marker, '1');
    }
    if (legacy !== null) { check(rawKey, legacy); cache[rawKey] = legacy; }
    const current = storage.getItem(prefix + editorKey);
    if (current !== null) { check(editorKey, current); cache[editorKey] = current; }
  } catch (value) { error = value.message; }
  return {
    rawKey, editorKey, keys, prefix, initialError: error,
    snapshot: () => ({ ...cache }),
    set(name, value) { check(name, value); storage.setItem(prefix + name, value); if (name === rawKey) storage.setItem(marker, '1'); cache[name] = value; },
    remove(name) { check(name); storage.removeItem(prefix + name); if (name === rawKey) storage.setItem(marker, '1'); delete cache[name]; },
    clear() { for (const name of keys) this.remove(name); }
  };
}

// This function is serialized into the opaque document before its own scripts.
// It captures the platform transport/Response and exposes no host objects.
function previewBootstrap(config, installEditor) {
  'use strict';
  const host = window.parent, nativeFetch = window.fetch.bind(window), NativeResponse = window.Response;
  const sendMessage = host.postMessage.bind(host), listen = window.addEventListener.bind(window);
  const setTimer = window.setTimeout.bind(window), clearTimer = window.clearTimeout.bind(window);
  const drafts = new Map(Object.entries(config.drafts)), pending = new Map(), outbox = [];
  let sequence = 0, writable = !config.storageError, connected = false, readyTimer, editor = null;
  const send = (type, extra = {}) => {
    const message = { namespace: config.namespace, nonce: config.nonce, workId: config.workId, type, ...extra };
    if (connected || type === 'preview:ready') sendMessage(message, '*');
    else { if (outbox.length >= 32) throw new Error('The preview bridge is not connected. Keep this preview open.'); outbox.push(message); }
  };
  const denied = message => new NativeResponse(JSON.stringify({ error: { code: 'PREVIEW_DENIED', message } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  const draftKey = key => {
    key = String(key);
    if (!config.draftKeys.includes(key)) throw new DOMException('This draft key is not available in this preview.', 'SecurityError');
    return key;
  };
  const mutate = (op, key, value) => {
    key = draftKey(key);
    if (!writable) throw new DOMException('Browser draft storage is unavailable. Keep this preview open or save the work.', 'QuotaExceededError');
    const used = [...drafts].filter(([name]) => name !== key).reduce((sum, [name, text]) => sum + new TextEncoder().encode(name + text).length, 0);
    if (op === 'set' && used + new TextEncoder().encode(key + value).length > config.draftLimit) throw new DOMException('The draft total exceeds 128 KiB.', 'QuotaExceededError');
    if (op === 'set') drafts.set(key, value); else drafts.delete(key);
    send('storage:request', { requestId: 'storage-' + ++sequence, op, key, ...(op === 'set' ? { value } : {}) });
  };
  const storage = Object.freeze({
    get length() { return drafts.size; },
    key(index) { return [...drafts.keys()][Number(index)] ?? null; },
    getItem(key) { return config.draftKeys.includes(String(key)) ? drafts.get(String(key)) ?? null : null; },
    setItem(key, value) { mutate('set', key, String(value)); },
    removeItem(key) { mutate('remove', key); },
    clear() { for (const key of config.draftKeys) mutate('remove', key); }
  });
  try { Object.defineProperty(window, 'localStorage', { value: storage, configurable: false, writable: false }); }
  catch { writable = false; send('storage:error', { message: 'The isolated browser draft proxy could not be initialized.' }); }
  Object.defineProperty(window, '__HSHU_WORK_PREVIEW__', { value: true, writable: false, configurable: false });
  Object.defineProperty(window, '__HSHU_PREVIEW_ASSET__', { value: value => typeof value === 'string' && Object.hasOwn(config.assetMap, value) ? config.assetMap[value] : null, writable: false, configurable: false });
  const editorState = value => {
    const state = {};
    for (const key of ['dirty', 'saving', 'saved', 'ready']) if (typeof value?.[key] === 'boolean') state[key] = value[key];
    if (Object.hasOwn(value || {}, 'error')) state.error = value.error ? String(value.error.message || value.error).slice(0, 4096) : '';
    send('editor:state', { state });
  };
  const saveEditor = async () => { if (!editor) return; try { await editor.save(); } catch (error) { editorState({ error }); } };
  listen('message', event => {
    const message = event.data;
    if (event.source !== host || !message || message.namespace !== config.namespace || message.nonce !== config.nonce || message.workId !== config.workId) return;
    if (message.type === 'preview:init') { connected = true; clearTimer(readyTimer); for (const queued of outbox.splice(0)) sendMessage(queued, '*'); return; }
    if (message.type === 'storage:response') { if (message.status >= 400) writable = false; return; }
    if (message.type === 'editor:save') { if (config.editorEnabled) void saveEditor(); return; }
    if (message.type !== 'source:response') return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId); clearTimer(request.timer);
    request.resolve(new NativeResponse(JSON.stringify(message.body), { status: message.status, headers: { 'Content-Type': 'application/json' } }));
  });
  window.fetch = async function(input, init) {
    if (typeof input !== 'string' || input !== config.endpoint) return nativeFetch(input, init);
    let body;
    try { body = JSON.parse(init?.body); } catch { return denied('A JSON source request is required.'); }
    if (String(init?.method || 'GET').toUpperCase() !== 'POST' || body?.action !== 'source' || body?.args?.id && body.args.id !== config.workId) return denied('Only the current work source is available.');
    return new Promise((resolve, reject) => {
      const requestId = 'source-' + ++sequence;
      const timer = setTimer(() => { pending.delete(requestId); reject(new Error('The preview save bridge timed out. Your draft remains in this preview.')); }, 30000);
      pending.set(requestId, { resolve, reject, timer });
      send('source:request', { requestId, action: body.action, args: body.args });
    });
  };
  if (!config.editorEnabled) document.addEventListener('input', () => send('preview:dirty'), true);
  const source = async args => {
    const response = await window.fetch(config.endpoint, { method: 'POST', body: JSON.stringify({ action: 'source', args: { id: config.workId, ...args } }) });
    const result = await response.json();
    if (!response.ok || result.error) throw Object.assign(new Error(result.error?.message || 'The work source could not be saved.'), { code: result.error?.code, status: response.status });
    return result;
  };
  const install = () => {
    if (!config.editorEnabled || editor) return;
    try {
      document.querySelectorAll('[data-pp-edit][contenteditable]').forEach(element => element.removeAttribute('contenteditable'));
      editor = installEditor({ readSource: () => source({}), writeSource: ({ content, revision }) => source({ content, revision }), storage, storageKey: config.editorKey, onState: editorState });
      if (!editor || typeof editor.save !== 'function') throw new Error('The inline text editor could not be initialized.');
      editorState({ ready: true });
    } catch (error) { editorState({ ready: false, error }); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
  listen('pagehide', () => editor?.dispose?.());
  listen('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); send('preview:close'); } }, true);
  const ready = () => { if (connected) return; send('preview:ready', { storageReady: writable }); if (!connected) readyTimer = setTimer(ready, 250); };
  ready();
}

export function createPreviewSession(preview, options = {}) {
  if (preview?.kind !== 'html' || !validWorkId(preview.workId) || typeof preview.html !== 'string') throw failure('INVALID_PREVIEW', 'The HTML preview response is invalid.');
  const drafts = createPreviewDraftStore(preview.workId, options.storage);
  const nonce = previewNonce(options.crypto);
  const resources = preview.assets ?? preview.assetMap;
  const assetMap = Object.fromEntries(Object.entries(resources && typeof resources === 'object' && !Array.isArray(resources) ? resources : {}).filter(([, value]) => typeof value === 'string' && /^data:image\//i.test(value)));
  const installer = preview.sourcePath ? (options.installEditor === undefined ? installInlineTextEditor : options.installEditor) : null;
  const config = { namespace: PREVIEW_NAMESPACE, nonce, workId: preview.workId, endpoint: SOURCE_ENDPOINT, drafts: drafts.snapshot(), draftKeys: drafts.keys, editorKey: drafts.editorKey, editorEnabled: typeof installer === 'function', draftLimit: PREVIEW_DRAFT_LIMIT, storageError: drafts.initialError, assetMap };
  const safeJSON = JSON.stringify(config).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const editorCode = typeof installer === 'function' ? '(' + installer.toString().replace(/<\/script/gi, '<\\/script') + ')' : 'null';
  const bootstrap = '(' + previewBootstrap.toString() + ')(' + safeJSON + ',' + editorCode + ');';
  // Suppress only the known old editor runtime in the preview copy.
  let html = preview.html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attributes, body) => /(?:^|\s)id\s*=\s*(['"])pp-inline-edit-(?:js|script|runtime)\1/i.test(attributes) || /data-pp-inline-editor\s*=/i.test(preview.html) && /ppInlineReady/.test(body) && /printpress:inline:/.test(body) ? '' : tag);
  const srcDoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" data-hshu-preview-policy content="' + PREVIEW_CSP + '"><script id="hshu-preview-bootstrap">' + bootstrap + '</script><style data-hshu-preview-ui>#pp-inline-editor{display:none!important}</style>\n' + html.replace(/^\s*<!doctype\s+html[^>]*>/i, '');
  return Object.freeze({ ...preview, nonce, drafts, srcDoc });
}

export function sourceArgsForPreview(args, session) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('PREVIEW_DENIED', 'A source request is required.');
  if (Object.keys(args).some(key => !['id', 'sourcePath', 'content', 'revision'].includes(key))) throw failure('PREVIEW_DENIED', 'Arbitrary file paths and source options are not available.');
  if (args.id !== undefined && args.id !== session.workId) throw failure('PREVIEW_DENIED', 'This request belongs to another work.');
  if (typeof session.sourcePath !== 'string' || !session.sourcePath) throw failure('PREVIEW_NO_SOURCE', 'This preview has no associated editable source.');
  if (args.sourcePath !== undefined && args.sourcePath !== session.sourcePath) throw failure('PREVIEW_DENIED', 'The source association is fixed for this preview.');
  const safe = { id: session.workId, sourcePath: session.sourcePath };
  if (Object.hasOwn(args, 'content')) {
    if (typeof args.content !== 'string' || byteSize(args.content) > PREVIEW_DRAFT_LIMIT || typeof args.revision !== 'string') throw failure('PREVIEW_INVALID_SOURCE', 'Saving requires text content and its source revision, up to 128 KiB.');
    safe.content = args.content; safe.revision = args.revision;
  } else if (Object.hasOwn(args, 'revision')) throw failure('PREVIEW_INVALID_SOURCE', 'A revision requires source content.');
  return safe;
}

export function createPreviewBridge({ session, frame, action, onSaved = () => {}, onState = () => {} }) {
  let active = true, inFlight = 0, dirtyVersion = 0;
  const requests = new Set();
  const currentFrame = () => typeof frame === 'function' ? frame() : frame;
  const send = (target, type, requestId, status, body) => {
    if (active && target === currentFrame()?.contentWindow) { try { target.postMessage({ namespace: PREVIEW_NAMESPACE, nonce: session.nonce, workId: session.workId, type, requestId, status, body }, '*'); } catch { /* The opaque document may have been disposed. */ } }
  };
  const errorBody = error => ({ error: { code: typeof error.code === 'string' ? error.code.slice(0, 100) : 'PREVIEW_ERROR', message: String(error.message || 'Preview request failed.').slice(0, 4096) } });
  const state = value => { if (active) { try { onState(value); } catch { /* Rendering does not change the source operation result. */ } } };
  return {
    async handleMessage(event) {
      const message = event.data, target = event.source;
      if (!active || !target || target !== currentFrame()?.contentWindow || !message || message.namespace !== PREVIEW_NAMESPACE || message.nonce !== session.nonce || message.workId !== session.workId) return false;
      if (message.type === 'preview:dirty') { dirtyVersion++; state({ dirty: true }); return true; }
      if (message.type === 'preview:close') { state({ closeRequested: true }); return true; }
      if (message.type === 'editor:state') {
        const value = message.state;
        if (!value || typeof value !== 'object') return false;
        const patch = {};
        if (typeof value.dirty === 'boolean') { if (value.dirty) dirtyVersion++; patch.dirty = value.dirty; }
        if (typeof value.saving === 'boolean') patch.editorSaving = value.saving;
        if (typeof value.saved === 'boolean') patch.editorSaved = value.saved;
        if (typeof value.ready === 'boolean') patch.editorReady = value.ready;
        if (typeof value.error === 'string' || value.error === null) patch.editorError = value.error ? value.error.slice(0, 4096) : '';
        state(patch); return true;
      }
      if (message.type === 'preview:ready') { state({ ready: true, ...(message.storageReady === false ? { storageError: session.drafts.initialError || 'Browser draft storage is unavailable.' } : {}) }); send(target, 'preview:init', null, 200, {}); return true; }
      if (message.type === 'storage:error') { state({ storageError: 'The preview draft could not be cached. Keep the preview open or save the work.' }); return true; }
      if (!['source:request', 'storage:request'].includes(message.type) || typeof message.requestId !== 'string' || !/^[a-z]+-\d{1,10}$/.test(message.requestId)) return false;
      const responseType = message.type === 'source:request' ? 'source:response' : 'storage:response';
      if (requests.has(message.requestId) || inFlight >= 8) { send(target, responseType, message.requestId, 429, errorBody(failure('PREVIEW_BUSY', 'This preview request is already running or the bridge is busy.'))); return true; }
      requests.add(message.requestId);
      if (requests.size > 512) requests.delete(requests.values().next().value);
      if (message.type === 'storage:request') {
        try {
          if (message.op === 'set') session.drafts.set(message.key, message.value);
          else if (message.op === 'remove') session.drafts.remove(message.key);
          else throw failure('PREVIEW_STORAGE_DENIED', 'This storage operation is not available.');
          send(target, responseType, message.requestId, 200, {});
        } catch (error) { state({ storageError: error.message }); send(target, responseType, message.requestId, 403, errorBody(error)); }
        return true;
      }
      let safe;
      try { if (message.action !== 'source') throw failure('PREVIEW_DENIED', 'Only source requests are allowed.'); safe = sourceArgsForPreview(message.args, session); }
      catch (error) { send(target, responseType, message.requestId, 403, errorBody(error)); return true; }
      const version = dirtyVersion;
      inFlight++; state({ busy: true });
      try {
        const result = await action('source', safe);
        if (Object.hasOwn(safe, 'content')) {
          if (version === dirtyVersion) {
            state({ dirty: false });
            try { session.drafts.clear(); } catch (error) { state({ storageError: error.message }); }
          }
          if (active) { try { onSaved(result); } catch { /* The file save already succeeded. */ } }
        }
        send(target, responseType, message.requestId, 200, result);
      } catch (error) { send(target, responseType, message.requestId, Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500, errorBody(error)); }
      finally { inFlight--; state({ busy: inFlight > 0 }); }
      return true;
    },
    requestSave() {
      const target = currentFrame()?.contentWindow;
      if (!active || !session.sourcePath || !target) return false;
      send(target, 'editor:save', null, 200, {}); return true;
    },
    dispose() { active = false; }
  };
}
