import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { PREVIEW_NAMESPACE, PREVIEW_SANDBOX, PREVIEW_CSP, PREVIEW_DRAFT_LIMIT, MINIATURE_CSP, htmlPreviewable, htmlThumbnailUrl, createWorkPreviewCache, previewCacheKey, miniatureDocument, createPreviewDraftStore, createPreviewSession, createPreviewBridge, sourceArgsForPreview } from '../src/work-preview.js';

function storageFixture(initial = {}) {
  const data = new Map(Object.entries(initial)), reads = [];
  return { data, reads, getItem(key) { reads.push(key); return data.get(key) ?? null; }, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), key() { throw new Error('Do not enumerate host storage'); } };
}
const work = (extra = {}) => ({ kind: 'html', workId: 'work-1', title: 'A real HTML work', html: '<!doctype html><html><head><title>Work</title></head><body><h1>Editable text</h1><script>window.originalRan = true;</script></body></html>', sourcePath: 'D:/work/source.html', warnings: [], ...extra });
function fixture(options = {}) {
  const storage = options.storage || storageFixture({ 'host-secret': 'untouched' });
  const session = createPreviewSession(work(options.preview), { storage });
  const replies = [], states = [], calls = [], saved = [];
  const child = { postMessage: value => replies.push(value) }, frame = { contentWindow: child };
  const bridge = createPreviewBridge({ session, frame, action: options.action || (async (action, args) => { calls.push({ action, args }); return { id: args.id, revision: 'revision-1', ...(args.content === undefined ? { content: '<html>Source</html>' } : { backupPath: 'D:/work/backup.html' }) }; }), onSaved: value => saved.push(value), onState: value => states.push(value) });
  let sequence = 0;
  const message = (extra = {}) => ({ namespace: PREVIEW_NAMESPACE, nonce: session.nonce, workId: session.workId, type: 'source:request', requestId: 'source-' + ++sequence, action: 'source', args: { id: session.workId }, ...extra });
  const send = data => bridge.handleMessage({ source: child, data });
  return { storage, session, replies, states, calls, saved, child, frame, bridge, message, send };
}

test('opaque document starts with restrictive CSP and trusted bridge before any original script', () => {
  const { session } = fixture();
  assert.equal(PREVIEW_SANDBOX, 'allow-scripts allow-downloads');
  assert.doesNotMatch(PREVIEW_SANDBOX, /allow-same-origin|allow-forms|allow-top-navigation/);
  for (const directive of ["default-src 'none'", "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'", "img-src data: blob:", "font-src data:"]) assert.ok(PREVIEW_CSP.includes(directive));
  assert.ok(session.srcDoc.indexOf('Content-Security-Policy') < session.srcDoc.indexOf('hshu-preview-bootstrap'));
  assert.ok(session.srcDoc.indexOf('hshu-preview-bootstrap') < session.srcDoc.indexOf('window.originalRan'));
  assert.match(session.srcDoc, /^<!doctype html><html><head><meta charset/);
  const next = createPreviewSession(work(), { storage: storageFixture() });
  assert.notEqual(session.nonce, next.nonce);
});

test('plugin preview preserves source-owned scripts without requiring a page-owned editor', () => {
  const html = '<script>if(!/^https?:$/.test(location.protocol)){say(edits.size?\'draft\':\'local\');return;}</script>';
  const input = work({ html });
  const session = createPreviewSession(input, { storage: storageFixture() });
  assert.ok(session.srcDoc.includes(html), 'Source-owned code remains unchanged by the generic plugin editor.');
  assert.equal(input.html, html);
});

test('wrong frame, nonce, namespace, work id and disposed sessions cannot invoke source operations', async () => {
  const f = fixture();
  assert.equal(await f.bridge.handleMessage({ source: {}, data: f.message() }), false);
  for (const change of [{ nonce: 'wrong' }, { namespace: 'other-plugin' }, { workId: 'work-2' }]) assert.equal(await f.send(f.message(change)), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.replies.length, 0);
  f.bridge.dispose();
  assert.equal(await f.send(f.message()), false);
});

test('bridge rejects other actions, work ids and paths while fixing the original source association', async () => {
  const f = fixture();
  for (const extra of [
    { action: 'remove' }, { args: { id: 'work-2' } }, { args: { id: 'work-1', path: 'D:/private/file' } },
    { args: { id: 'work-1', sourcePath: 'D:/private/file' } }, { args: { id: 'work-1', module: 'web' } }, { args: [] }
  ]) { await f.send(f.message(extra)); assert.equal(f.replies.at(-1).status, 403); }
  assert.equal(f.calls.length, 0);
  await f.send(f.message());
  assert.deepEqual(f.calls[0], { action: 'source', args: { id: 'work-1', sourcePath: 'D:/work/source.html' } });
  assert.equal(f.replies.at(-1).body.revision, 'revision-1');
  assert.equal(f.replies.at(-1).body.ok, undefined, 'The existing inline editor consumes raw action results.');
  assert.throws(() => sourceArgsForPreview({ id: 'work-1' }, work({ sourcePath: null })), { code: 'PREVIEW_NO_SOURCE' });
});

test('source read and revision save responses stay raw and errors preserve HTTP status and code', async () => {
  const f = fixture();
  await f.send(f.message());
  await f.send(f.message({ args: { id: 'work-1', revision: 'revision-1', content: '<html>Updated</html>' } }));
  assert.deepEqual(f.calls[1].args, { id: 'work-1', sourcePath: 'D:/work/source.html', revision: 'revision-1', content: '<html>Updated</html>' });
  assert.equal(f.saved.length, 1);
  assert.equal(f.replies.at(-1).body.backupPath, 'D:/work/backup.html');
  const failed = fixture({ action: async () => { throw Object.assign(new Error('Changed on disk'), { code: 'SOURCE_CONFLICT', status: 409 }); } });
  await failed.send(failed.message());
  assert.equal(failed.replies[0].status, 409);
  assert.deepEqual(failed.replies[0].body, { error: { code: 'SOURCE_CONFLICT', message: 'Changed on disk' } });
});

test('input while save is in flight remains dirty and is not silently cleared', async () => {
  let finish;
  const f = fixture({ action: () => new Promise(resolve => { finish = resolve; }) });
  await f.send(f.message({ type: 'preview:dirty' }));
  const saving = f.send(f.message({ args: { id: 'work-1', content: 'first version', revision: 'revision-1' } }));
  await f.send(f.message({ type: 'preview:dirty' }));
  finish({ revision: 'revision-2' }); await saving;
  assert.ok(!f.states.some(value => value.dirty === false));
  assert.equal(f.saved.length, 1);
  assert.equal(f.states.at(-1).busy, false);
});

test('draft migration reads exactly this work key and all changes stay under its safe prefix', () => {
  const raw = 'printpress:inline:work-1', legacy = '{"changes":[{"id":"title","value":"Draft"}]}';
  const storage = storageFixture({ [raw]: legacy, 'printpress:inline:work-2': 'another draft', 'host-secret': 'secret' });
  const drafts = createPreviewDraftStore('work-1', storage);
  assert.equal(drafts.snapshot()[raw], legacy);
  assert.ok(storage.reads.every(key => key === raw || key.startsWith('hshu-preview:work-1:')));
  assert.equal(storage.data.get('hshu-preview:work-1:' + raw), legacy);
  drafts.remove(raw);
  assert.deepEqual(createPreviewDraftStore('work-1', storage).snapshot(), {}, 'A cleared migrated draft must not reappear from the legacy key.');
  assert.equal(storage.data.get('host-secret'), 'secret');
  assert.equal(storage.data.get('printpress:inline:work-2'), 'another draft');
  assert.throws(() => drafts.set('host-secret', 'overwrite'), { code: 'PREVIEW_STORAGE_DENIED' });
  assert.throws(() => drafts.set(raw, '界'.repeat(PREVIEW_DRAFT_LIMIT / 2)), { code: 'PREVIEW_STORAGE_LIMIT' });
});

test('new and legacy editor drafts share a bounded work-local store without exposing other keys', () => {
  const store = storageFixture(), drafts = createPreviewDraftStore('work-1', store);
  drafts.set(drafts.editorKey, 'new draft');
  drafts.set(drafts.rawKey, 'legacy draft');
  assert.equal(store.data.get('hshu-preview:work-1:huashu:inline:work-1'), 'new draft');
  assert.equal(drafts.snapshot()[drafts.rawKey], 'legacy draft');
  assert.throws(() => drafts.set('huashu:inline:work-2', 'bad'), { code: 'PREVIEW_STORAGE_DENIED' });
  drafts.set(drafts.editorKey, 'x'.repeat(100000));
  assert.throws(() => drafts.set(drafts.rawKey, 'x'.repeat(40000)), { code: 'PREVIEW_STORAGE_LIMIT' });
  drafts.clear(); assert.deepEqual(drafts.snapshot(), {});
});

test('untrusted storage RPC cannot read or write other work or host keys', async () => {
  const f = fixture();
  for (const key of ['host-secret', 'printpress:inline:work-2', '../private']) {
    await f.send(f.message({ type: 'storage:request', requestId: 'storage-' + key.length, op: 'set', key, value: 'bad' }));
    assert.equal(f.calls.length, 0);
    assert.ok(f.replies.at(-1).status >= 400);
  }
  assert.equal(f.storage.data.get('host-secret'), 'untouched');
});

function bootFrame(preview = {}, delayed = false, installEditor = null) {
  const storage = storageFixture(), session = createPreviewSession(work(preview), { storage, installEditor });
  const listeners = new Map(), documentListeners = new Map(), nativeCalls = [], calls = [], clock = new Map(), states = [];
  let bridge, timerId = 0, connected = !delayed;
  const parent = { postMessage: message => { if (connected) void bridge.handleMessage({ source: context, data: message }); } };
  const context = {
    parent, Response, DOMException, TextEncoder, console,
    fetch: async (...args) => { nativeCalls.push(args); throw new TypeError('CSP blocks network'); },
    addEventListener: (name, callback) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
    document: { readyState: 'complete', querySelectorAll: () => [], addEventListener: (name, callback) => documentListeners.set(name, callback) },
    setTimeout: (fn, ms) => { clock.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => clock.delete(id),
    postMessage: message => { for (const callback of listeners.get('message') || []) callback({ source: parent, data: message }); }
  };
  context.window = context;
  bridge = createPreviewBridge({ session, frame: { contentWindow: context }, onState: value => states.push(value), action: async (action, args) => { calls.push({ action, args }); return args.content === undefined ? { revision: 'read-revision', content: '<html>Actual source</html>' } : { revision: 'saved-revision', backupPath: 'D:/work/backup.html' }; } });
  vm.createContext(context);
  const script = session.srcDoc.match(/<script id="hshu-preview-bootstrap">([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context);
  const connect = () => { connected = true; const timer = [...clock].find(([, value]) => value.ms === 250); if (timer) { clock.delete(timer[0]); timer[1].fn(); } };
  return { context, session, calls, nativeCalls, documentListeners, storage, clock, connect, states, bridge, keydown: event => { for (const callback of listeners.get('keydown') || []) callback(event); } };
}

test('source requests wait for parent handshake when iframe scripts run before the parent listener', async () => {
  const f = bootFrame({}, true);
  const response = f.context.fetch('/huashu-design/api/action', { method: 'POST', body: JSON.stringify({ action: 'source', args: { id: 'work-1' } }) });
  assert.equal(f.calls.length, 0);
  f.connect();
  assert.equal((await (await response).json()).revision, 'read-revision');
  assert.equal(f.calls.length, 1);
  assert.equal(f.clock.size, 0);
});

test('serialized draft data cannot terminate the trusted bootstrap script', () => {
  const raw = 'printpress:inline:work-1';
  const f = fixture({ storage: storageFixture({ [raw]: '</script><script>globalThis.injection = true</script>' }) });
  assert.doesNotMatch(f.session.srcDoc, /<script>globalThis.injection/);
  assert.match(f.session.srcDoc, /\\u003c\/script>/);
});

test('Escape inside the editing iframe requests close through the validated bridge', () => {
  const f = bootFrame();
  let prevented = false;
  f.keydown({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.states.at(-1).closeRequested, true);
});

function testInlineInstaller({ readSource, writeSource, storage, storageKey, onState }) {
  let dirty = false;
  const state = patch => onState({ dirty, saving: false, saved: false, error: null, ...patch });
  window.injectedEditor = {
    storageKey, saves: 0,
    async modify() { await readSource(); dirty = true; storage.setItem(storageKey, '{"version":1,"edits":[1]}'); state({}); }
  };
  return {
    save() {
      window.injectedEditor.saves++;
      state({ saving: true });
      window.injectedEditor.pending = (async () => {
        const source = await readSource();
        await writeSource({ revision: source.revision, content: '<html>Changed text</html>' });
        dirty = false; storage.removeItem(storageKey); state({ saved: true });
      })();
      return window.injectedEditor.pending;
    },
    dispose() {}, isDirty() { return dirty; }
  };
}

test('trusted bootstrap installs a standalone editor and parent save uses the fixed source revision bridge', async () => {
  const f = bootFrame({}, false, testInlineInstaller);
  assert.equal(f.context.injectedEditor.storageKey, 'huashu:inline:work-1');
  assert.ok(f.states.some(state => state.editorReady === true));
  await f.context.injectedEditor.modify();
  assert.ok(f.states.some(state => state.dirty === true));
  assert.equal(f.storage.data.get('hshu-preview:work-1:huashu:inline:work-1'), '{"version":1,"edits":[1]}');
  f.context.postMessage({ namespace: PREVIEW_NAMESPACE, nonce: 'wrong', workId: 'work-1', type: 'editor:save' });
  assert.equal(f.context.injectedEditor.saves, 0);
  assert.equal(f.bridge.requestSave(), true);
  await f.context.injectedEditor.pending;
  const write = f.calls.find(call => call.args.content !== undefined);
  assert.deepEqual(write.args, { id: 'work-1', sourcePath: 'D:/work/source.html', revision: 'read-revision', content: '<html>Changed text</html>' });
  assert.ok(f.states.some(state => state.editorSaved === true && state.dirty === false));
  assert.equal(f.storage.data.has('hshu-preview:work-1:huashu:inline:work-1'), false);
});

test('read-only works never install a text editor or accept parent save', () => {
  const f = bootFrame({ sourcePath: null }, false, testInlineInstaller);
  assert.equal(f.context.injectedEditor, undefined);
  assert.equal(f.bridge.requestSave(), false);
  assert.equal(f.calls.length, 0);
});

test('only the known legacy inline runtime is suppressed and business scripts stay unchanged', () => {
  const business = '<script>window.keepBusinessInteraction = true;</script>';
  const old = '<script id="pp-inline-edit-script">window.oldEditorStarted = true;</script>';
  const session = createPreviewSession(work({ html: '<html><body><h1>Text</h1>' + old + business + '</body></html>' }), { storage: storageFixture(), installEditor: testInlineInstaller });
  assert.doesNotMatch(session.srcDoc, /window.oldEditorStarted/);
  assert.ok(session.srcDoc.includes(business));
});

test('actual injected fetch shim completes read/save through the parent with native Response shape', async () => {
  const f = bootFrame();
  const read = await f.context.fetch('/huashu-design/api/action', { method: 'POST', body: JSON.stringify({ action: 'source', args: { id: 'work-1' } }) });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { revision: 'read-revision', content: '<html>Actual source</html>' });
  const save = await f.context.fetch('/huashu-design/api/action', { method: 'POST', body: JSON.stringify({ action: 'source', args: { id: 'work-1', revision: 'read-revision', content: '<html>New text</html>' } }) });
  assert.deepEqual(await save.json(), { revision: 'saved-revision', backupPath: 'D:/work/backup.html' });
  assert.equal(f.calls[1].args.sourcePath, 'D:/work/source.html');
  const denied = await f.context.fetch('/huashu-design/api/action', { method: 'POST', body: JSON.stringify({ action: 'remove', args: { id: 'work-1' } }) });
  assert.equal(denied.status, 403);
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.context.fetch('https://example.invalid/private'), /CSP blocks network/);
  assert.equal(f.nativeCalls.length, 1);
  assert.equal(f.clock.size, 0, 'Completed source requests and handshake do not leave timers pending.');
});

test('preview asset access is limited to verified inline images without rewriting work export code', () => {
  const data = 'data:image/png;base64,AQID';
  const html = '<script>window.customExport = () => "work-owned export";</script>';
  for (const field of ['assetMap', 'assets']) {
    const f = bootFrame({ html, [field]: { 'assets/photo.png?version=2': data, 'evil.png': 'https://example.invalid/track' } });
    assert.equal(f.context.__HSHU_PREVIEW_ASSET__('assets/photo.png?version=2'), data);
    assert.equal(f.context.__HSHU_PREVIEW_ASSET__('evil.png'), null);
    assert.equal(f.context.__HSHU_PREVIEW_ASSET__('unknown.png'), null);
    assert.ok(f.session.srcDoc.includes(html));
    assert.equal(f.nativeCalls.length, 0);
    assert.equal(work({ html }).html, html);
  }
});

test('actual injected localStorage is synchronous, bounded and isolated', () => {
  const f = bootFrame(), key = 'printpress:inline:work-1';
  f.context.localStorage.setItem(key, '{"changes":[1]}');
  assert.equal(f.context.localStorage.getItem(key), '{"changes":[1]}');
  assert.equal(f.context.localStorage.getItem('host-secret'), null);
  assert.throws(() => f.context.localStorage.setItem('printpress:inline:other', 'x'), /not available/);
  assert.throws(() => f.context.localStorage.setItem(key, 'x'.repeat(PREVIEW_DRAFT_LIMIT)), /exceeds 128 KiB/);
  assert.equal(f.storage.data.get('hshu-preview:work-1:' + key), '{"changes":[1]}');
  f.context.localStorage.removeItem(key);
  assert.equal(f.context.localStorage.getItem(key), null);
});

test('HTML cards show a miniature with real thumbnail fallback and only cover click opens fullscreen', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('function workCard('), end = source.indexOf('function worksPage(', start);
  const failed = {}, opened = [];
  const h = (type, props, ...children) => ({ type, props: props || {}, children: [...children.flat().filter(value => value && typeof value === 'object'), ...(type === 'miniature' ? [props.fallback] : [])] });
  const noop = () => {};
  const scope = {
    h, Icon: 'icon', HtmlWorkMiniature: 'miniature', htmlPreviewable, htmlThumbnailUrl, editorMode: () => null, thumbnailFailures: failed,
    setThumbnailFailures: update => Object.assign(failed, update(failed)), openHtmlPreview: item => opened.push(item.id),
    workPreviewUrl: item => item.url, title: item => item.title, tasks: [], t: key => key,
    button: (label, onClick, props) => h('button', { label, onClick, ...props }), textButton: (label, onClick, props) => h('button', { label, onClick, ...props }), link: (label, href) => h('a', { label, href }),
    htmlPreview: null, handoffBusy: '', busy: false, sending: false, workspaceBusy: false, sourceBusy: false, deleting: null,
    beginRevision: noop, loadSource: noop, editingWork: null, exitRevision: noop, setBrief: noop, prepare: noop, setDeleting: noop, deleteWork: noop
  };
  const render = new Function(...Object.keys(scope), source.slice(start, end) + ';return workCard;')(...Object.values(scope));
  const find = (node, predicate) => { if (predicate(node)) return node; for (const child of node.children || []) { const value = find(child, predicate); if (value) return value; } };
  const item = { id: 'work-1', title: 'A real work', path: 'D:/work/index.html', mime: 'text/html', editable: true, updatedAt: 'new-version', module: 'web', note: 'Full notes' };
  const tree = render(item), image = find(tree, node => node.type === 'img');
  assert.equal(image.props.src, '/huashu-design/works/work-1/thumbnail?updatedAt=new-version');
  find(tree, node => node.props.className?.includes('hs-work-preview-cover')).props.onClick();
  assert.equal(find(tree, node => node.props.label === 'previewWork'), undefined);
  assert.equal(find(tree, node => node.props.label === 'editSource'), undefined);
  assert.ok(find(tree, node => node.type === 'miniature'));
  assert.deepEqual(opened, ['work-1']);
  image.props.onError();
  assert.ok(find(render(item), node => node.type === 'icon' && node.props.kind === 'web'));
  assert.equal(find(tree, node => node.props.className === 'hs-work-note').props.title, 'Full notes');
  assert.equal(find(tree, node => node.props.className === 'hs-path hs-work-path').props.title, item.path);
  assert.equal(find(render({ ...item, path: 'D:/work/image.png', mime: 'image/png', url: '/native.png' }), node => node.type === 'img').props.src, '/native.png');
});

test('miniature and fullscreen share versioned preview requests and reload invalidates them', async () => {
  const calls = [];
  const cache = createWorkPreviewCache(async item => { calls.push(item); return work({ workId: item.id }); });
  const item = { id: 'work-1', updatedAt: 'v1' };
  const first = cache.get(item), second = cache.get({ ...item });
  assert.equal(first, second);
  await first; assert.equal(calls.length, 1);
  await cache.get({ ...item, updatedAt: 'v2' });
  assert.equal(calls.length, 2);
  await cache.get({ ...item, updatedAt: 'v2' }, { reload: true });
  assert.equal(calls.length, 3);
});

test('gallery HTML disables all scripts and bridge capabilities while preserving static content', () => {
  const html = miniatureDocument(work());
  assert.match(html, /Editable text/);
  assert.ok(html.includes(MINIATURE_CSP));
  assert.match(html, /script-src 'none'/);
  assert.doesNotMatch(html, /<script|hshu-preview-bootstrap|__HSHU_WORK_PREVIEW__/i);
  assert.equal(miniatureDocument(work({ html: '<html><head><title>Dynamic</title></head><body><div id="app"></div><script>render()</script></body></html>' })), null);
});

test('visible gallery miniature loads actual HTML into an opaque, noninteractive iframe', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('function HtmlWorkMiniature('), end = source.indexOf('function WorkPreviewFrame(', start);
  const previousIntersection = globalThis.IntersectionObserver, previousResize = globalThis.ResizeObserver;
  const hooks = [];
  let index = 0, observer, effectKey, layout = false, calls = 0;
  const React = {
    useRef() { const key = index++; return hooks[key] ||= { current: { clientWidth: 480 } }; },
    useState(initial) { const key = index++; if (!(key in hooks)) hooks[key] = initial; return [hooks[key], value => { hooks[key] = value; }]; },
    useLayoutEffect(fn) { if (!layout) { layout = true; fn(); } },
    useEffect(fn, deps) { if (deps[0] !== effectKey) { effectKey = deps[0]; fn(); } }
  };
  try {
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    globalThis.IntersectionObserver = class { constructor(callback) { this.callback = callback; observer = this; } observe() {} disconnect() {} };
    const h = (type, props, ...children) => ({ type, props: props || {}, children });
    const component = new Function('React', 'h', 'previewCacheKey', 'miniatureDocument', 'htmlPreviewCache', source.slice(start, end) + ';return HtmlWorkMiniature;')(React, h, previewCacheKey, miniatureDocument, { get: async () => { calls++; return work(); } });
    const render = () => { index = 0; return component({ item: { id: 'work-1', updatedAt: 'v1', title: 'A work' }, fallback: 'thumbnail' }); };
    render(); assert.equal(calls, 0);
    observer.callback([{ isIntersecting: true }]); await Promise.resolve(); await Promise.resolve();
    const iframe = render().children.find(child => child?.type === 'iframe');
    assert.ok(iframe);
    assert.equal(iframe.props.sandbox, '');
    assert.equal(iframe.props.tabIndex, -1);
    assert.match(iframe.props.srcDoc, /Editable text/);
    assert.equal(iframe.props.style.transform, 'scale(0.375)');
    assert.match(source, /\.hs-work-miniature-frame\{[^}]*pointer-events:none/);
    assert.equal(calls, 1);
  } finally { globalThis.IntersectionObserver = previousIntersection; globalThis.ResizeObserver = previousResize; }
});

test('closing fullscreen restores the exact card position without changing its editing session', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('function closeHtmlPreview()'), end = source.indexOf('async function editGraphic(', start);
  let visible = true, pending = true, scroll, focused = false;
  const previewVisibleRef = { current: true }, session = fixture().session;
  const close = new Function('previewVisibleRef', 'setPreviewVisible', 'setPreviewPending', 'previewReturnRef', 'requestAnimationFrame', 'rootRef', source.slice(start, end) + ';return closeHtmlPreview;')(
    previewVisibleRef, value => { visible = value; }, value => { pending = value; },
    { current: { top: 735, left: 11, focus: { isConnected: true, focus: options => { focused = options.preventScroll; } } } },
    callback => callback(), { current: { scrollTo: value => { scroll = value; } } }
  );
  close();
  assert.equal(visible, false); assert.equal(pending, null); assert.equal(focused, true);
  assert.deepEqual(scroll, { top: 735, left: 11, behavior: 'instant' });
  assert.ok(session.srcDoc, 'The close operation has no session replacement or destruction path.');
});

test('fullscreen uses a dirty-only save button and has no source-edit mode control', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('function htmlWorkPreviewPanel()'), end = source.indexOf('function workCard(', start);
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter(value => value !== null && value !== undefined && value !== false) });
  const value = { item: { title: 'Current work' }, loading: false, session: { nonce: 'n', sourcePath: 'D:/work/source.html', warnings: [] }, state: { dirty: true, editorReady: true, ready: true } };
  let token = 0;
  const noop = () => {};
  const scope = { h, React: { Fragment: 'fragment' }, htmlPreview: value, previewVisible: true, workPreviewRef: { current: null }, t: key => key,
    button: (label, onClick, props) => h('button', { label, onClick, ...props }), setPreviewSaveRequest: update => { token = update(token); },
    openHtmlPreview: noop, closeHtmlPreview: noop, previewPending: null, WorkPreviewFrame: 'editor-frame', previewSaveRequest: 0, previewSourceSaved: noop, previewStateChanged: noop };
  const render = new Function(...Object.keys(scope), source.slice(start, end) + ';return htmlWorkPreviewPanel;')(...Object.values(scope));
  const find = (node, predicate) => { if (!node || typeof node !== 'object') return; if (predicate(node)) return node; for (const child of node.children || []) { const found = find(child, predicate); if (found) return found; } };
  const save = find(render(), node => node.props.label === 'inlineSave');
  assert.ok(save); assert.equal(Boolean(save.props.disabled), false);
  save.props.onClick(); assert.equal(token, 1);
  assert.ok(find(render(), node => node.children.includes('inlineEditHint')));
  value.state.dirty = false;
  assert.equal(find(render(), node => node.props.label === 'inlineSave'), undefined);
  value.session.sourcePath = null; value.state.dirty = true;
  assert.equal(find(render(), node => node.props.label === 'inlineSave'), undefined);
  assert.equal(find(render(), node => node.children.includes('inlineEditHint')), undefined);
});

test('HTML download uses only inlined preview HTML and refuses unsaved text without an implicit write', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function downloadHtmlWork('), end = source.indexOf('async function openHtmlPreview(', start);
  const raw = '<html><img src="data:image/png;base64,AQID"><script>business()</script></html>', ref = { current: null };
  let blob, clicked = 0, loads = 0, error = '';
  const anchor = { click() { clicked++; } };
  const download = new Function('htmlPreviewRef', 'htmlPreviewCache', 'URL', 'Blob', 'document', 'setTimeout', 'setError', 't', source.slice(start, end) + ';return downloadHtmlWork;')(
    ref, { get: async () => { loads++; return { html: raw }; } }, { createObjectURL: value => { blob = value; return 'blob:portable'; }, revokeObjectURL() {} }, Blob,
    { createElement: () => anchor }, callback => callback(), value => { error = value; }, key => key
  );
  await download({ id: 'work-1', title: 'Current work' });
  assert.equal(await blob.text(), raw); assert.equal(clicked, 1); assert.equal(anchor.download, 'Current work.html');
  ref.current = { item: { id: 'work-1' }, state: { dirty: true } };
  await download({ id: 'work-1', title: 'Current work' });
  assert.equal(loads, 1); assert.equal(clicked, 1); assert.equal(error, 'saveBeforeDownload');
});

test('composer keeps type cards and registration metadata while workspace selection stays compact', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const composer = source.slice(source.indexOf('function composer()'), source.indexOf('function sourceEditor()'));
  assert.doesNotMatch(composer, /formatSelect\(\)/);
  assert.match(source, /formatSelect\(true\)/);
  assert.match(source, /hs-format-grid/);
  assert.match(source, /hs-workspace-row>label\{flex:0 1 320px;width:min\(100%,320px\)/);
  assert.match(source, /@container\(max-width:550px\)\{.hs-design .hs-workspace-row>label\{flex:initial;width:100%\}/);
  const start = source.indexOf('function workspacePicker()'), end = source.indexOf('function outputFormat()', start);
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const selected = { workspaceId: 'w1', title: 'Design', path: 'D:/Very long/path/to/design/project' };
  const scope = { h, selectedWorkspace: selected, sending: false, workspaceBusy: false, workspaceState: { phase: 'ready', items: [selected] }, workspaceForm: false, t: key => key, textButton: () => null };
  const render = new Function(...Object.keys(scope), source.slice(start, end) + ';return workspacePicker;')(...Object.values(scope));
  const find = (node, predicate) => { if (!node || typeof node !== 'object') return; if (predicate(node)) return node; for (const child of node.children || []) { const found = find(child, predicate); if (found) return found; } };
  assert.equal(find(render(), node => node.type === 'select').props.title, selected.path);
  const option = find(render(), node => node.type === 'option' && node.props.value === 'w1');
  assert.equal(option.children[0], 'Design'); assert.equal(option.props.title, selected.path);
});

test('preview shell and embedded control CSS compile without emitting artifacts', async () => {
  const { transform } = await import('esbuild');
  const [source, embedded] = await Promise.all([readFile(new URL('../src/client.js', import.meta.url), 'utf8'), readFile(new URL('../src/printpress/theme.css', import.meta.url), 'utf8')]);
  const start = source.indexOf('const CSS = `'), end = source.indexOf('function Icon(', start);
  const shell = new Function(source.slice(start, end) + ';return CSS;')();
  for (const css of [shell, embedded]) {
    const result = await transform(css, { loader: 'css', logLevel: 'silent' });
    assert.deepEqual(result.warnings, []);
    assert.ok(result.code.length > 0);
  }
});

test('preview lifecycle keeps mounted content on close/save and compact controls preserve touch targets', async () => {
  const [source, css] = await Promise.all([readFile(new URL('../src/client.js', import.meta.url), 'utf8'), readFile(new URL('../src/printpress/theme.css', import.meta.url), 'utf8')]);
  assert.match(source, /function closeHtmlPreview\(\)\{previewVisibleRef.current=false;setPreviewVisible\(false\);setPreviewPending\(null\)/);
  assert.match(source, /previous\?\.top\|\|0,left:previous\?\.left\|\|0,behavior:'instant'/);
  assert.match(source, /previous.focus.focus\(\{preventScroll:true\}\)/);
  assert.match(source, /function previewSourceSaved\(\)\{if\(htmlPreviewRef.current\)htmlPreviewCache.invalidate\(htmlPreviewRef.current.item\);setStatus\(t\('previewSaved'\)\);refresh\(\);\}/);
  assert.match(source, /hidden:!previewVisible,role:'dialog'/);
  assert.match(source, /\.hs-work-preview\{position:absolute;inset:0;z-index:3000/);
  assert.match(source, /\.hs-work-preview \.hs-work-preview-frame\{height:0;min-height:0;flex:1 1 auto\}/);
  assert.match(source, /srcDoc:session.srcDoc,sandbox:PREVIEW_SANDBOX/);
  assert.match(source, /\},\[session.nonce\]\)/);
  assert.match(source, /current\?\.state.dirty&&!confirmed/);
  assert.match(source, /h\(PrintpressPanel,\{locale:locale.active,onEvent:onWorkbenchEvent\}\)/);
  assert.match(source, /style:paletteVars,'data-palette':themeId/);
  assert.match(source, /-webkit-line-clamp:3/);
  assert.match(source, /@media\(pointer:fine\) and \(min-width:721px\)/);
  assert.match(source, /@media\(pointer:coarse\),\(max-width:720px\)/);
  assert.match(source, /min-height:34px/);
  assert.match(source, /min-height:44px/);
  assert.match(css, /\.pp-nav button,.pp-data-directory,.pp-linked-actions button/);
  assert.match(css, /@media \(pointer: coarse\), \(max-width: 720px\)/);
});
