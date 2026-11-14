import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import { installInlineTextEditor } from '../src/inline-text-editor.js';
import { createOperations } from '../lib/core.js';
import { createWorkPreview } from '../lib/work-preview.js';

// Reuse an already-installed standards DOM parser; no browser/install/runtime
// dependency is introduced. The rest of the fixture supplies only UI events,
// focus and Selection, which xmldom intentionally does not implement.
const require = createRequire(import.meta.url);
const checkoutRoot = process.env.HUASHU_PRINTPRESS_TEST_ROOT || process.env.HUASHU_PRINTPRESS_ROOT;
let dom;
for (const location of [process.env.HUASHU_DOM_TEST_MODULE, '@xmldom/xmldom', checkoutRoot && path.join(checkoutRoot, 'node_modules', '@xmldom', 'xmldom')].filter(Boolean)) {
  try { dom = require(location); break; } catch { /* Try only explicit known dependency locations. */ }
}
const domTest = { skip: dom ? false : 'set HUASHU_DOM_TEST_MODULE to an existing @xmldom/xmldom installation' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const KEY = 'huashu:inline:work-one';
const html = body => '<!doctype html><html><head><style>.accent{color:red}</style></head><body>' + body + '</body></html>';
function storageFixture(initial = {}) {
  const data = new Map(Object.entries(initial)), reads = [];
  return { data, reads, getItem(key) { reads.push(key); return data.get(key) ?? null; }, setItem(key, value) { data.set(key, String(value)); }, removeItem(key) { data.delete(key); }, key() { throw new Error('Do not enumerate host storage'); } };
}
function fixture(content = html('<h1>Title</h1><p>A <strong>bold</strong> sentence.</p><img src="assets/photo.jpg"/>'), options = {}) {
  const listeners = new WeakMap();
  function events(node) {
    listeners.set(node, []);
    node.addEventListener = (name, callback, capture = false) => listeners.get(node).push({ name, callback, capture });
    node.removeEventListener = (name, callback, capture = false) => listeners.set(node, listeners.get(node).filter(item => item.name !== name || item.callback !== callback || item.capture !== capture));
    return node;
  }
  function enhance(document) {
    Object.defineProperty(document, 'body', { get: () => document.getElementsByTagName('body')[0] });
    events(document);
    function element(node) {
      events(node);
      node.contains = other => { for (let current = other; current; current = current.parentNode) if (current === node) return true; return false; };
      node.focus = () => { document.activeElement = node; };
      Object.defineProperty(node, 'outerHTML', { get: () => new dom.XMLSerializer().serializeToString(node) });
      return node;
    }
    for (const node of Array.from(document.getElementsByTagName('*'))) element(node);
    const createElement = document.createElement.bind(document);
    document.createElement = name => element(createElement(name));
    document.createRange = () => {
      let container = null;
      return { get commonAncestorContainer() { return container; }, selectNodeContents(node) { container = node; }, collapse() {}, deleteContents() { container.textContent = ''; }, insertNode(node) { container.appendChild(node); }, setStartAfter() {} };
    };
    document.caretRangeFromPoint = () => document.testCaret ? { startContainer: document.testCaret } : null;
    return document;
  }
  class TestDOMParser {
    parseFromString(value, mime) { return enhance(new dom.DOMParser().parseFromString(value, mime)); }
  }
  const document = new TestDOMParser().parseFromString(options.liveContent || content, 'text/html');
  const window = events({ document }), selection = { rangeCount: 0, removeAllRanges() { this.rangeCount = 0; }, addRange(range) { this.rangeCount = 1; this.range = range; }, getRangeAt() { return this.range; } };
  window.getSelection = () => selection;
  const storage = options.storage || storageFixture(options.draft ? { [KEY]: options.draft } : {}), states = [], writes = [], reads = [];
  let file = { content, revision: 'r1' }, revision = 1;
  const sourceOptions = {
    storage, storageKey: KEY, onState: value => states.push({ ...value }),
    async readSource() { reads.push(file.revision); return options.readSource ? options.readSource({ ...file }) : { ...file }; },
    async writeSource(request) {
      writes.push({ ...request });
      if (request.revision !== file.revision) throw Object.assign(new Error('Changed on disk'), { code: 'SOURCE_CONFLICT', status: 409 });
      const result = options.writeSource ? await options.writeSource(request) : { revision: 'r' + ++revision };
      if (result?.revision && !result.error) file = { content: request.content, revision: result.revision };
      return result;
    }
  };
  const context = vm.createContext({ window, document, DOMParser: TestDOMParser, TextEncoder, options: sourceOptions });
  // Execute the serialized production function in a separate realm with no
  // module lexical scope; every behavior test also checks the injection contract.
  const controller = vm.runInContext('(' + installInlineTextEditor.toString() + ')(options)', context);
  function dispatch(type, target, extra = {}) {
    const event = { type, target, clientX: 10, clientY: 10, prevented: false, stopped: false, immediate: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediate = true; }, ...extra };
    const pending = [];
    for (const owner of [window, document, target]) {
      if (event.stopped) break;
      for (const listener of [...(listeners.get(owner) || [])].filter(value => value.name === type)) {
        if (event.immediate) break;
        const result = listener.callback(event); if (result?.then) pending.push(result);
      }
    }
    return { event, done: Promise.all(pending) };
  }
  const node = (name, index = 0) => document.getElementsByTagName(name)[index];
  const wrapper = () => Array.from(document.getElementsByTagName('span')).find(value => value.hasAttribute('data-huashu-inline-editor'));
  return {
    document, window, storage, controller, states, writes, reads, node, wrapper, dispatch, context,
    get file() { return file; }, set file(value) { file = value; },
    last: () => states.at(-1), listenerCount: () => (listeners.get(document)?.length || 0) + (listeners.get(window)?.length || 0),
    async begin(target, caret) { document.testCaret = caret || null; await dispatch('dblclick', target).done; return wrapper(); },
    input(value) { const field = wrapper(); assert.ok(field, 'a temporary text editor is active'); field.textContent = value; dispatch('input', field); },
    finish() { dispatch('keydown', wrapper() || document.body, { key: 'Enter' }); },
    parseFile() { return new TestDOMParser().parseFromString(file.content, 'text/html'); }
  };
}

test('single click stays idle; double click edits one leaf and Enter removes only its temporary wrapper', domTest, async () => {
  const f = fixture(); await tick();
  f.dispatch('click', f.node('h1')); assert.equal(f.wrapper(), undefined);
  const field = await f.begin(f.node('h1'));
  assert.equal(field.getAttribute('contenteditable'), 'plaintext-only'); assert.equal(f.document.activeElement, field);
  f.input('Updated title'); assert.equal(f.controller.isDirty(), true);
  assert.equal(JSON.parse(f.storage.data.get(KEY)).edits[0].before, 'Title');
  assert.equal(f.writes.length, 0, 'typing saves only the isolated draft');
  f.finish(); assert.equal(f.wrapper(), undefined); assert.equal(f.node('h1').textContent, 'Updated title');
  assert.equal(f.listenerCount(), 7);
  f.controller.dispose();
});

test('nested emphasis, image paths, scripts, links and raw source styles survive save without preview markup', domTest, async () => {
  const source = html('<p id="copy">A <strong class="accent">bold</strong> sentence.</p><a href="detail.html">Details</a><img src="assets/photo.jpg"/><script>window.workOwned = 1;</script>');
  const f = fixture(source); await tick();
  f.node('img').setAttribute('src', 'data:image/png;base64,PREVIEW_ONLY');
  f.node('style').textContent = '.accent{color:blue}';
  const policy = f.document.createElement('meta'); policy.setAttribute('data-preview-policy', ''); f.document.getElementsByTagName('head')[0].appendChild(policy);
  await f.begin(f.node('strong')); f.input('important & exact');
  await f.controller.save();
  const saved = f.parseFile();
  assert.equal(saved.getElementsByTagName('strong')[0].textContent, 'important & exact');
  assert.equal(saved.getElementsByTagName('strong')[0].getAttribute('class'), 'accent');
  assert.equal(saved.getElementsByTagName('p')[0].childNodes.length, 3, 'surrounding text nodes are not flattened');
  assert.equal(saved.getElementsByTagName('img')[0].getAttribute('src'), 'assets/photo.jpg');
  assert.equal(saved.getElementsByTagName('a')[0].getAttribute('href'), 'detail.html');
  assert.equal(saved.getElementsByTagName('style')[0].textContent, '.accent{color:red}');
  assert.equal(saved.getElementsByTagName('script')[0].textContent, 'window.workOwned = 1;');
  assert.doesNotMatch(f.file.content, /PREVIEW_ONLY|data-preview-policy|data-huashu-inline-editor|contenteditable/);
  assert.equal(f.last().saved, true); assert.equal(f.controller.isDirty(), false); assert.equal(f.storage.data.has(KEY), false);
  f.controller.dispose();
});

test('caret text selects the intended mixed-content fragment without removing nested labels', domTest, async () => {
  const f = fixture(); await tick();
  const paragraph = f.node('p'), tail = paragraph.lastChild;
  await f.begin(paragraph, tail); f.input(' ending.'); await f.controller.save();
  assert.equal(f.parseFile().getElementsByTagName('p')[0].textContent, 'A bold ending.');
  assert.equal(f.parseFile().getElementsByTagName('strong')[0].textContent, 'bold');
  f.controller.dispose();
});

test('dynamic/generated or rearranged text is rejected instead of overwriting another original node', domTest, async () => {
  const f = fixture(); await tick();
  f.node('h1').firstChild.nodeValue = 'Runtime-only title';
  assert.equal(await f.begin(f.node('h1')), undefined);
  assert.match(f.last().error, /动态|原稿/); assert.equal(f.writes.length, 0);
  const generated = f.document.createElement('p'); generated.textContent = 'Generated'; f.document.body.appendChild(generated);
  assert.equal(await f.begin(generated), undefined); assert.equal(f.writes.length, 0);
  const source = html('<p>First <strong>bold</strong> Last</p>'), g = fixture(source); await tick();
  g.node('p').insertBefore(g.document.createTextNode('Inserted'), g.node('p').firstChild);
  assert.equal(await g.begin(g.node('strong')), undefined, 'same tag/text at a shifted path is not guessed');
  f.controller.dispose(); g.controller.dispose();
});

test('script/style/svg/form control text remains unavailable for inline editing', domTest, async () => {
  const f = fixture(html('<script>code()</script><style>.x{}</style><svg><text>vector</text></svg><textarea>input</textarea><select><option>pick</option></select><p>Allowed</p>')); await tick();
  for (const name of ['script', 'style', 'text', 'textarea', 'option']) assert.equal(await f.begin(f.node(name)), undefined, name);
  assert.ok(await f.begin(f.node('p'))); f.controller.dispose();
});

test('editable anchor/button first clicks cannot navigate or run page actions before double click', domTest, async () => {
  const f = fixture(html('<a href="download.bin" download="">Download</a><button onclick="sideEffect()">Action</button><input value="keep"/>')); await tick();
  let sideEffect = 0;
  f.node('a').addEventListener('click', () => sideEffect++);
  f.node('button').addEventListener('click', () => sideEffect++);
  for (const name of ['a', 'button']) {
    const click = f.dispatch('click', f.node(name));
    assert.equal(click.event.prevented, true); assert.equal(click.event.immediate, true);
    await f.begin(f.node(name)); f.input(name === 'a' ? 'New download label' : 'New action label'); f.finish();
  }
  assert.equal(sideEffect, 0);
  assert.equal(f.dispatch('click', f.node('input')).event.prevented, false);
  await f.controller.save();
  assert.equal(f.parseFile().getElementsByTagName('a')[0].getAttribute('href'), 'download.bin');
  assert.equal(f.parseFile().getElementsByTagName('button')[0].getAttribute('onclick'), 'sideEffect()');
  f.controller.dispose();
});

test('paste is plain text and cannot introduce source elements or image URLs', domTest, async () => {
  const f = fixture(); await tick(); await f.begin(f.node('h1'));
  const plain = '<img src="evil">literal & safe';
  const paste = f.dispatch('paste', f.wrapper(), { clipboardData: { getData: type => type === 'text/plain' ? plain : '<b>ignored</b>' } });
  assert.equal(paste.event.prevented, true); await f.controller.save();
  assert.equal(f.parseFile().getElementsByTagName('h1')[0].textContent, plain);
  assert.equal(f.parseFile().getElementsByTagName('img').length, 1);
  f.controller.dispose();
});

test('a matching versioned text-path draft restores without source writes or host storage enumeration', domTest, async () => {
  const draft = JSON.stringify({ version: 1, revision: 'r1', edits: [{ textPath: [0, 0], before: 'Title', value: 'Recovered draft' }] });
  const storage = storageFixture({ [KEY]: draft, 'huashu:inline:another-work': 'private' });
  const f = fixture(undefined, { storage }); await tick();
  assert.equal(f.node('h1').textContent, 'Recovered draft'); assert.equal(f.controller.isDirty(), true);
  assert.deepEqual(storage.reads, [KEY]); assert.equal(f.writes.length, 0);
  await f.controller.save(); assert.equal(f.parseFile().getElementsByTagName('h1')[0].textContent, 'Recovered draft');
  assert.equal(storage.data.get('huashu:inline:another-work'), 'private'); f.controller.dispose();
});

test('wrong revision, wrong before text and malformed drafts are retained but never applied blindly', domTest, async () => {
  for (const draft of [
    { version: 1, revision: 'old', edits: [{ textPath: [0, 0], before: 'Title', value: 'Wrong revision' }] },
    { version: 1, revision: 'r1', edits: [{ textPath: [0, 0], before: 'Another title', value: 'Wrong target' }] },
    { version: 9, revision: 'r1', edits: [] },
  ]) {
    const raw = JSON.stringify(draft), f = fixture(undefined, { draft: raw }); await tick();
    assert.equal(f.node('h1').textContent, 'Title'); assert.equal(f.controller.isDirty(), true);
    assert.match(f.last().error, /草稿.*保留|未自动/);
    await assert.rejects(f.controller.save(), { code: 'DRAFT_CONFLICT' });
    assert.equal(f.storage.data.get(KEY), raw); assert.equal(f.writes.length, 0); f.controller.dispose();
  }
});

test('source revision or write conflicts retain dirty state and the exact user draft', domTest, async () => {
  for (const mode of ['read-conflict', 'write-conflict']) {
    const f = fixture(undefined, { writeSource: mode === 'write-conflict' ? async () => { throw Object.assign(new Error('Changed'), { code: 'SOURCE_CONFLICT' }); } : undefined });
    await tick(); await f.begin(f.node('h1')); f.input('Keep my changes'); f.finish();
    const draft = f.storage.data.get(KEY);
    if (mode === 'read-conflict') f.file = { content: html('<h1>Changed externally</h1>'), revision: 'r-external' };
    await assert.rejects(f.controller.save(), { code: 'SOURCE_CONFLICT' });
    assert.equal(f.controller.isDirty(), true); assert.equal(f.last().saved, false); assert.equal(f.last().saving, false);
    assert.match(f.last().error, /原文件已变化/); assert.equal(f.storage.data.get(KEY), draft);
    f.controller.dispose();
  }
});

test('new input during asynchronous save rebases onto the saved revision and remains dirty', domTest, async () => {
  let complete;
  const f = fixture(undefined, { writeSource: () => new Promise(resolve => { complete = resolve; }) }); await tick();
  await f.begin(f.node('h1')); f.input('First save'); f.finish();
  const saving = f.controller.save(); await tick(); assert.equal(f.last().saving, true);
  await f.begin(f.node('h1')); f.input('New typing');
  complete({ revision: 'r2' }); await saving;
  assert.equal(f.parseFile().getElementsByTagName('h1')[0].textContent, 'First save');
  assert.equal(f.controller.isDirty(), true); assert.equal(f.last().saved, false); assert.equal(f.last().saving, false);
  const draft = JSON.parse(f.storage.data.get(KEY));
  assert.equal(draft.revision, 'r2'); assert.deepEqual(draft.edits[0], { textPath: [0, 0], before: 'First save', value: 'New typing' });
  f.controller.dispose();
});

test('reverting to the original while a different value is being saved is still an unsaved edit', domTest, async () => {
  let complete;
  const f = fixture(undefined, { writeSource: () => new Promise(resolve => { complete = resolve; }) }); await tick();
  await f.begin(f.node('h1')); f.input('Saved value'); f.finish();
  const saving = f.controller.save(); await tick();
  await f.begin(f.node('h1')); f.input('Title'); assert.equal(f.controller.isDirty(), false, 'it temporarily matches the old base');
  complete({ revision: 'r2' }); await saving;
  assert.equal(f.controller.isDirty(), true);
  assert.deepEqual(JSON.parse(f.storage.data.get(KEY)).edits[0], { textPath: [0, 0], before: 'Saved value', value: 'Title' });
  f.controller.dispose();
});

test('clearing one text field saves an empty field and later edits keep correct source paths', domTest, async () => {
  const f = fixture(html('<p>Delete me<strong>Keep emphasis</strong> tail</p><h1>Next</h1>')); await tick();
  await f.begin(f.node('p'), f.node('p').firstChild); f.input(''); await f.controller.save();
  assert.equal(f.last().saved, true); assert.equal(f.controller.isDirty(), false);
  assert.equal(f.parseFile().getElementsByTagName('p')[0].firstChild.nodeName.toLowerCase(), 'strong');
  await f.begin(f.node('strong')); f.input('Updated emphasis'); await f.controller.save();
  assert.equal(f.parseFile().getElementsByTagName('strong')[0].textContent, 'Updated emphasis');
  f.controller.dispose();
});

test('save waits for source initialization and keyboard Ctrl/Cmd+S saves through the controller', domTest, async () => {
  let finishRead;
  const f = fixture(undefined, { readSource: value => value.revision === 'r1' && f.reads.length === 1 ? new Promise(resolve => { finishRead = () => resolve(value); }) : value });
  const waiting = f.controller.save(); await tick(); assert.equal(f.writes.length, 0); finishRead(); await waiting;
  await f.begin(f.node('h1')); f.input('Shortcut save');
  const key = f.dispatch('keydown', f.wrapper(), { key: 's', metaKey: true });
  assert.equal(key.event.prevented, true); await tick();
  assert.equal(f.writes.length, 1); assert.equal(f.parseFile().getElementsByTagName('h1')[0].textContent, 'Shortcut save');
  f.controller.dispose();
});

test('Chinese IME candidate Enter and Ctrl+S do not commit or blur until composition ends', domTest, async () => {
  const f = fixture(); await tick(); const field = await f.begin(f.node('h1'));
  f.dispatch('compositionstart', field); f.input('中文候选');
  for (const extra of [{ key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Enter' }, { key: 's', ctrlKey: true }]) {
    const key = f.dispatch('keydown', field, extra);
    assert.equal(key.event.prevented, false, 'IME receives its candidate key normally');
    assert.equal(f.wrapper(), field); assert.equal(f.document.activeElement, field);
  }
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.controller.save(), { code: 'EDITOR_COMPOSING' });
  assert.equal(f.wrapper(), field); assert.equal(f.document.activeElement, field);
  f.dispatch('compositionend', field); f.finish();
  assert.equal(f.wrapper(), undefined);
  await f.controller.save(); assert.equal(f.parseFile().getElementsByTagName('h1')[0].textContent, '中文候选');
  assert.equal(f.last().saved, true); f.controller.dispose();
});

test('storage failures are visible without losing the in-memory edit or forcing automatic source writes', domTest, async () => {
  const storage = storageFixture(); storage.setItem = () => { throw new Error('quota'); };
  const f = fixture(undefined, { storage }); await tick(); await f.begin(f.node('h1')); f.input('Still here');
  assert.equal(f.controller.isDirty(), true); assert.match(f.last().error, /草稿未能保存/); assert.equal(f.writes.length, 0);
  await f.controller.save(); assert.equal(f.parseFile().getElementsByTagName('h1')[0].textContent, 'Still here');
  f.controller.dispose();
});

test('disposing during the pre-save source read cancels the not-yet-started write and retains the draft', domTest, async () => {
  let finishRead;
  const f = fixture(undefined, { readSource: value => f.reads.length === 2 ? new Promise(resolve => { finishRead = () => resolve(value); }) : value });
  await tick(); await f.begin(f.node('h1')); f.input('Pending save'); f.finish();
  const saving = f.controller.save(); await tick();
  f.controller.dispose(); const states = f.states.length;
  finishRead(); await assert.rejects(saving, { code: 'EDITOR_DISPOSED' });
  assert.equal(f.writes.length, 0); assert.equal(f.states.length, states, 'disposed iframe receives no new view state callbacks');
  assert.equal(JSON.parse(f.storage.data.get(KEY)).edits[0].value, 'Pending save');
});

test('dispose preserves the isolated draft, removes listeners, and prevents later source writes', domTest, async () => {
  const f = fixture(); await tick(); await f.begin(f.node('h1')); f.input('Close safely');
  f.controller.dispose(); assert.equal(f.listenerCount(), 0); assert.equal(f.wrapper(), undefined);
  assert.equal(JSON.parse(f.storage.data.get(KEY)).edits[0].value, 'Close safely');
  await f.dispatch('dblclick', f.node('p')).done; assert.equal(f.wrapper(), undefined);
  f.dispatch('keydown', f.node('h1'), { key: 's', ctrlKey: true }); await tick(); assert.equal(f.writes.length, 0);
  await assert.rejects(f.controller.save(), { code: 'EDITOR_DISPOSED' });
});

// Real-article acceptance: render the three registered WeChat drafts through
// the actual preview backend, then edit the h1 through the production engine.
// The inlined data: images/head policy must never leak into the saved source.
test('real registered articles edit through the inlined preview without flattening their original assets', domTest, async (t) => {
  // The sample articles are a local fixture set, not part of this package, so
  // skip honestly instead of failing on a missing directory.
  const articleDir = process.env.HUASHU_WECHAT_ARTICLE_DIR || '';
  const names = ['dir-1.html', 'dir-2.html', 'dir-3.html'];
  if (!articleDir || !names.every(name => fs.existsSync(path.join(articleDir, name)))) {
    t.skip('set HUASHU_WECHAT_ARTICLE_DIR to a folder containing dir-1..3.html');
    return;
  }
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const before = await Promise.all(names.map(async name => sha(await fs.readFile(path.join(articleDir, name)))));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-real-inline-'));
  try {
    const operations = createOperations({ dshHome: home });
    const preview = createWorkPreview(operations);
    for (let index = 0; index < names.length; index++) {
      const file = path.join(articleDir, names[index]);
      const raw = await fs.readFile(file, 'utf8');
      const { item } = await operations.operation('add', { title: 'Real ' + index, path: file, sourcePath: file, module: 'web' });
      const rendered = await preview.render(item.id);
      assert.equal(rendered.workId, item.id);
      assert.ok(rendered.sourcePath, 'the registered HTML is its own editable source');
      assert.deepEqual(rendered.warnings, []);
      assert.equal(Object.keys(rendered.assetMap).length, 4);
      assert.match(rendered.html, /data:image\//, 'preview really inlines the local images');
      const f = fixture(raw, { liveContent: rendered.html });
      await tick();
      const h1 = f.node('h1');
      const findText = node => { for (const child of Array.from(node.childNodes || [])) { if (child.nodeType === 3 && child.nodeValue.trim()) return child; if (child.nodeType === 1) { const hit = findText(child); if (hit) return hit; } } return null; };
      const text = findText(h1);
      assert.ok(text, names[index] + ' has editable headline text');
      const beforeText = text.nodeValue;
      const field = await f.begin(h1, text);
      assert.ok(field, names[index] + ' opens the inline editor on the real preview');
      f.input('测试修改');
      await f.controller.save();
      assert.equal(f.writes.length, 1);
      const saved = f.parseFile();
      assert.equal(saved.getElementsByTagName('h1')[0].textContent.includes('测试修改'), true);
      assert.doesNotMatch(f.file.content, /data:image\//, 'saved source keeps relative asset paths');
      assert.match(f.file.content, /assets\/(?:logo\.png|ui\.jpg|certificate\.png|dataset\.jpg)/);
      assert.notEqual(f.file.content, raw);
      // Compare at the DOM level, not by serialized prefix: the test DOM parser
      // normalizes doctype/self-closing tags. What must hold is that exactly one
      // text node changed and every other text node is byte-identical.
      const texts = doc => {
        const out = [], walk = node => { if (node.nodeType === 3) out.push(node.nodeValue); for (const child of Array.from(node.childNodes || [])) walk(child); };
        walk(doc); return out;
      };
      const rawTexts = texts(new dom.DOMParser().parseFromString(raw, 'text/html'));
      const savedTexts = texts(saved);
      assert.equal(savedTexts.length, rawTexts.length, names[index] + ' keeps every text node');
      const changed = rawTexts.filter((value, i) => value !== savedTexts[i]);
      assert.equal(changed.length, 1, names[index] + ' changes exactly one text field');
      assert.equal(changed[0], beforeText);
      assert.equal(savedTexts[rawTexts.indexOf(beforeText)], '测试修改');
      f.controller.dispose();
    }
    const after = await Promise.all(names.map(async name => sha(await fs.readFile(path.join(articleDir, name)))));
    assert.deepEqual(after, before, 'in-memory editor acceptance must not write the real articles');
  } finally {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('huashu-real-inline-'));
    await fs.rm(home, { recursive: true, force: true });
  }
});
