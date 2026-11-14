import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHandoffQueue, editorMode, outputModeFor, workPreviewUrl, publishLinkedWork, printpressAction } from '../src/printpress/handoff.js';
import { adaptDesignerView } from '../src/printpress/designer-adapter.js';
import { adaptPrintpressUI, adaptPhotoProcessingPanel, hostThemeValue } from '../src/printpress/ui-adapter.js';

const root = process.env.HUASHU_PRINTPRESS_ROOT || 'D:/个人开发/PYF';
const original = await readFile(path.join(root, 'src/views/BackgroundDesignerView.vue'), 'utf8');
const adapted = adaptDesignerView(adaptPrintpressUI(original, '/views/BackgroundDesignerView.vue'));
const compiler = createRequire(path.join(root, 'package.json'))('@vue/compiler-sfc');
const request = () => ({ item: { id: 'work-1', title: 'Poster' }, designRef: { id: 'design-1', revision: 4 }, artboard: { w: 120, h: 160 }, mode: 'layers', openImageEditor: false });
const ref = value => ({ value });
const createInScope = (code, scope) => new Function(...Object.keys(scope), code)(...Object.values(scope));

function consumerHarness({ dirty = false, getDesign } = {}) {
  const results = [], replacements = [], imageModes = [];
  const scope = {
    busy: ref(false), modalOpen: ref(false), designerNav: { request: null }, design: ref({ id: 'old-design', layers: [] }),
    error: ref(''), imageEdit: ref(null), selectedIds: ref([]),
    finishTextEdit() {}, clone: value => JSON.parse(JSON.stringify(value)),
    fail(error) { scope.error.value = error.message; },
    protectDraft(action, cancel) { if (dirty) scope.pending = { action, cancel }; else scope.loading = action(); },
    replaceDesign(value, context, saved) { scope.design.value = value; replacements.push({ value, context, saved }); },
    nextTick: async () => {},
    async openImageEdit(mode) { assert.equal(scope.busy.value, false); imageModes.push(mode); scope.imageEdit.value = {}; },
    window: { printpress: { getDesign: getDesign || (async (id, revision) => ({ id, revision, layers: [{ id: 'photo', type: 'image' }] })) } },
    refreshPortraitAvailability: async () => {}, refreshVariablePhotoSample: async () => {},
    returnToTemplate: () => { results.push({ status: 'returned-to-template' }); }
  };
  const start = adapted.indexOf('async function consumeRequest(request) {');
  const end = adapted.indexOf('watch(() => designerNav.request', start);
  const consume = createInScope(adapted.slice(start, end) + '; return consumeRequest;', scope);
  return { scope, results, replacements, imageModes, async open(extra = {}) {
    const value = { origin: 'huashu', ...request(), onHuashuResult: result => results.push(result), ...extra };
    scope.designerNav.request = value;
    await consume(value);
    await scope.loading;
    return value;
  }, consume };
}

test('handoff queue survives enqueue before mount and acknowledges only its current request', () => {
  const queue = createHandoffQueue();
  const first = queue.request(request());
  const second = queue.request({ ...request(), item: { id: 'work-2' } });
  assert.equal(queue.peek().token, first);
  let delivered;
  const unsubscribe = queue.subscribe(() => { delivered = queue.peek(); });
  assert.equal(delivered.item.id, 'work-1');
  assert.equal(queue.acknowledge(second), false);
  unsubscribe();
  assert.equal(queue.peek().token, first, 'Unmount must not discard the queued handoff.');
  queue.acknowledge(first);
  assert.equal(queue.peek().token, second);
  queue.acknowledge(second);
  assert.equal(queue.peek(), null);
});

test('image-only projects remain labeled image editing and thumbnails change only with updatedAt', () => {
  assert.equal(editorMode({ layeredEditable: true }), 'layers');
  assert.equal(editorMode({ layeredEditable: true, imageOnly: true }), 'image');
  assert.equal(editorMode({ imageEditable: true }), 'image');
  assert.equal(editorMode({ editable: true }), null);
  const item = { url: '/huashu-design/work/w-1', updatedAt: '2026-11-11 16:00' };
  assert.match(workPreviewUrl(item), /updatedAt=2026-11-11%2016%3A00$/);
  assert.notEqual(workPreviewUrl(item), workPreviewUrl({ ...item, updatedAt: 'new-version' }));
  assert.equal(workPreviewUrl({ ...item, url: '/work?preview=1' }).split('?').length, 2);
});

test('layered output is a per-task user choice, defaulting to standard for every task', async () => {
  const tasks = ['web', 'deck', 'app', 'motion', 'critique', 'infographic', 'xiaohongshu'];
  for (const task of tasks) {
    assert.equal(outputModeFor(task), 'standard', task + ' defaults to standard');
    assert.equal(outputModeFor(task, 'layered'), 'layered', task + ' accepts an explicit layered choice');
    assert.equal(outputModeFor(task, 'standard'), 'standard');
  }
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function makeInstructions('), end = source.indexOf('async function prepare(', start);
  const calls = [];
  const make = createInScope(source.slice(start, end) + ';return makeInstructions;', {
    editingWork: null, task: 'web', style: '', brief: 'A real brief', outputMode: 'standard', outputModeFor,
    action: async (action, args) => { calls.push({ action, args }); return args; }
  });
  await make();
  await make({ task: 'web', outputMode: 'layered' });
  await make({ task: 'deck', outputMode: 'layered' });
  await make({ task: 'infographic' });
  await make({ task: 'xiaohongshu', outputMode: 'standard' });
  await make({ task: 'infographic', workflow: 'review-polish' });
  assert.deepEqual(calls.map(call => [call.args.task, call.args.outputMode]), [['web', 'standard'], ['web', 'layered'], ['deck', 'layered'], ['infographic', 'standard'], ['xiaohongshu', 'standard'], ['infographic', 'standard']]);
});

test('publish offers a one-click Edit now action instead of forcing the editor open', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.match(source, /workbench:published[\s\S]{0,400}layeredEditable\|\|item\.imageEditable[\s\S]{0,200}setPublishedWork\(item\)/);
  assert.match(source, /t\('editNow'\)[\s\S]{0,120}editGraphic\(item\)/, 'Edit now reuses the existing handoff');
  assert.match(source, /setPublishedWork\(null\);rootRef\.current/, 'switching tabs dismisses the offer');
  assert.doesNotMatch(source, /workbench:published[\s\S]{0,300}switchTab\('printpress'\)/, 'publish must not force a tab switch');
});

test('publish saves through component API and sends the saved revision for the same work', async () => {
  let revision = 4, saves = 0, published;
  const editor = { getCurrentId: () => 'design-1', async saveForHuashu() { saves++; return { id: 'design-1', revision: ++revision }; } };
  const result = await publishLinkedWork(request(), editor, async (action, args) => { published = { action, args }; return { item: { id: args.workId } }; });
  assert.equal(saves, 1);
  assert.deepEqual(published, { action: 'publish', args: { workId: 'work-1', designId: 'design-1', revision: 5 } });
  assert.equal(result.item.id, 'work-1');
});

test('publish refuses a different project before and after save and forwards editor failures', async () => {
  let saved = false, published = false;
  const publish = () => { published = true; };
  await assert.rejects(publishLinkedWork(request(), { getCurrentId: () => 'other', saveForHuashu: () => { saved = true; } }, publish), { code: 'HUASHU_PROJECT_CHANGED' });
  assert.equal(saved, false);
  let id = 'design-1';
  await assert.rejects(publishLinkedWork(request(), { getCurrentId: () => id, async saveForHuashu() { id = 'other'; return { id: 'design-1', revision: 5 }; } }, publish), { code: 'HUASHU_PROJECT_CHANGED' });
  await assert.rejects(publishLinkedWork(request(), { getCurrentId: () => 'design-1', async saveForHuashu() { throw new Error('Unapplied image dialog'); } }, publish), /Unapplied image dialog/);
  assert.equal(published, false);
});

test('transport sends same-origin handoff without forcing layers and retains structured errors', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true, data: request() }) }; };
    await printpressAction('handoff', { workId: 'work-1' });
    assert.equal(calls[0].url, '/huashu-design/printpress/api');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(calls[0].options.body), { workId: 'work-1', action: 'handoff' });
    globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'STALE', message: 'Changed on disk' } }) });
    await assert.rejects(printpressAction('publish', {}), { code: 'STALE', status: 409, message: 'Changed on disk' });
  } finally { globalThis.fetch = previous; }
});

test('actual PYF adapter and workbench compile with Vue macros and template bindings', async () => {
  const workbench = await readFile(new URL('../src/printpress/Workbench.vue', import.meta.url), 'utf8');
  for (const [name, source] of [['BackgroundDesignerView', adapted], ['Workbench', workbench]]) {
    const { descriptor, errors } = compiler.parse(source, { filename: name + '.vue' });
    assert.deepEqual(errors, []);
    const script = compiler.compileScript(descriptor, { id: 'test-' + name });
    assert.ok(script.content);
    const template = compiler.compileTemplate({ source: descriptor.template.content, filename: name + '.vue', id: 'test-' + name });
    assert.deepEqual(template.errors, []);
  }
  assert.throws(() => adaptDesignerView(original.replace('async function consumeRequest(request)', 'async function consumeChanged(request)')), /consumer changed/);
});

test('accepted handoff uses null template context and opens crop after the busy load finishes', async () => {
  const harness = consumerHarness();
  await harness.open({ openImageEditor: true });
  assert.equal(harness.replacements.length, 1);
  assert.equal(harness.replacements[0].context, null);
  assert.equal(harness.replacements[0].saved, true);
  assert.deepEqual(harness.scope.selectedIds.value, ['photo']);
  assert.deepEqual(harness.imageModes, ['crop']);
  assert.deepEqual(harness.results, [{ status: 'opened', designRef: { id: 'design-1', revision: 4 } }]);
});

test('canceling the original draft confirmation leaves the previous draft and binding untouched', async () => {
  const harness = consumerHarness({ dirty: true });
  await harness.open();
  assert.equal(harness.replacements.length, 0);
  assert.equal(harness.results.length, 0, 'Do not bind while draft protection awaits a decision.');
  harness.scope.pending.cancel();
  assert.equal(harness.scope.design.value.id, 'old-design');
  assert.deepEqual(harness.results, [{ status: 'canceled' }]);
});

test('unapplied modal defers handoff and failed loading reports failure without replacing the draft', async () => {
  const waiting = consumerHarness();
  waiting.scope.modalOpen.value = true;
  const pending = await waiting.open();
  assert.equal(waiting.scope.designerNav.request, pending);
  assert.equal(waiting.replacements.length, 0);
  waiting.scope.modalOpen.value = false;
  await waiting.consume(pending); await waiting.scope.loading;
  assert.equal(waiting.results[0].status, 'opened');
  const failed = consumerHarness({ getDesign: async () => { throw new Error('Missing revision'); } });
  await failed.open();
  assert.equal(failed.replacements.length, 0);
  assert.equal(failed.scope.design.value.id, 'old-design');
  assert.deepEqual(failed.results, [{ status: 'failed', message: 'Missing revision' }]);
  assert.equal(failed.scope.busy.value, false);
});

test('a deleted pinned revision falls back to the latest saved design instead of alarming', async () => {
  const calls = [];
  const getDesign = async (id, revision) => {
    calls.push({ id, revision });
    if (revision === 4) throw new Error('底图版本不存在或尚未提交');
    return { id, revision: 7, layers: [{ id: 'photo', type: 'image' }] };
  };
  const fresh = consumerHarness({ getDesign });
  await fresh.open();
  assert.deepEqual(calls, [{ id: 'design-1', revision: 4 }, { id: 'design-1', revision: undefined }], 'retry without a pinned revision');
  assert.equal(fresh.scope.design.value.revision, 7, 'the editor opens the latest saved version');
  assert.deepEqual(fresh.results, [{ status: 'opened', designRef: { id: 'design-1', revision: 7 } }]);
  assert.equal(fresh.scope.error.value, '', 'no spurious warning reaches the status bar');
});

test('a non-Huashu consumer still requires its exact saved revision', async () => {
  const bothFail = consumerHarness({ getDesign: async () => { throw new Error('底图版本不存在或尚未提交'); } });
  await bothFail.open({ origin: 'print' });
  assert.equal(bothFail.replacements.length, 0);
  assert.deepEqual(bothFail.results, [], 'template/print navigation must not silently reopen a different version');
});

// The watch(modalOpen) is a Huashu-only injection; the standalone desktop app
// has none. It must replay ONLY a handoff that the modal itself deferred, never
// re-consume a stale designerNav.request when the user closes the import check.
function modalWatchHarness({ request = null } = {}) {
  const watchers = [];
  let consumeCalls = 0;
  const adaptedSource = adapted;
  const start = adaptedSource.indexOf('let deferredHuashuRequest = null');
  const end = adaptedSource.indexOf('defineExpose(', start);
  assert.ok(start >= 0 && end > start, 'the deferred-handoff watch must be present in the adapter');
  const scope = {
    initialized: true, modalOpen: ref(false), designerNav: { request },
    watch: (_source, callback) => watchers.push(callback),
    consumeRequest: () => { consumeCalls++; }
  };
  createInScope(adaptedSource.slice(start, end), scope);
  assert.equal(watchers.length, 2, 'one modal watch and one incoming-request watch');
  const [onModal, onRequest] = watchers;
  return {
    scope,
    openModal() { scope.modalOpen.value = true; onModal(true); },
    closeModal() { scope.modalOpen.value = false; onModal(false); },
    arrive(next) { scope.designerNav.request = next; onRequest(next); },
    get consumeCalls() { return consumeCalls; }
  };
}

test('closing an unrelated import dialog never replays a stale work handoff', () => {
  const stale = { origin: 'huashu', designRef: { id: 'design-1', revision: 4 }, item: { id: 'work-1' } };
  const h = modalWatchHarness({ request: stale });
  // The import check page opens and closes. The stale request predates it and
  // no NEW handoff arrives while the dialog is open, so nothing is replayed.
  h.openModal();
  h.closeModal();
  assert.equal(h.consumeCalls, 0, 'no getDesign on a stale revision after closing the import check');
});

test('a handoff arriving during a modal is replayed exactly once when that modal closes', () => {
  const next = { origin: 'huashu', designRef: { id: 'design-2', revision: 9 }, item: { id: 'work-2' } };
  const h = modalWatchHarness();
  h.openModal();
  h.arrive(next);         // a real handoff is deferred by this modal
  h.closeModal();         // closing replays exactly that request
  assert.equal(h.consumeCalls, 1);
  h.openModal(); h.closeModal();
  assert.equal(h.consumeCalls, 1, 'the deferred request is not replayed twice');
});

function exposedHarness() {
  const start = adapted.indexOf('defineExpose(') + 'defineExpose('.length;
  const end = adapted.indexOf('\n})', start) + 2;
  const scope = { busy: ref(false), imageEdit: ref(null), modalOpen: ref(false), error: ref(''), dirty: ref(false), design: ref({ id: 'design-1', revision: 4 }), finishTextEdit: () => { scope.finished = true; }, async save() { scope.design.value.revision++; } };
  return { scope, api: createInScope('return (' + adapted.slice(start, end) + ');', scope) };
}

test('exposed save rejects busy/dialog state and finishes text before the original save lifecycle', async () => {
  const { scope, api } = exposedHarness();
  scope.busy.value = true;
  await assert.rejects(api.saveForHuashu(), /正在处理/);
  scope.busy.value = false; scope.imageEdit.value = {};
  await assert.rejects(api.saveForHuashu(), /应用或取消/);
  scope.imageEdit.value = null;
  assert.deepEqual(await api.saveForHuashu(), { id: 'design-1', revision: 5 });
  assert.equal(scope.finished, true);
  scope.dirty.value = true;
  await assert.rejects(api.saveForHuashu(), /再次保存/);
  scope.dirty.value = false; scope.error.value = 'Write failed';
  await assert.rejects(api.saveForHuashu(), /Write failed/);
});

test('template page moves only 新建模板 to the workbench header beside 打开数据目录', async () => {
  const input = await readFile(path.join(root, 'src/views/TemplateView.vue'), 'utf8');
  const view = adaptPrintpressUI(input, '/views/TemplateView.vue');
  assert.doesNotMatch(view, /<PageHeader/, 'the empty header row is gone so the template list starts at the top');
  assert.doesNotMatch(view, /新建模板/, 'the button no longer lives in the page');
  assert.match(view, /defineExpose\(\{ newTemplate \}\)/, 'the header drives the real action');
  assert.match(view, /function newTemplate\(\)/, 'the original flow is untouched');
  const { descriptor, errors } = compiler.parse(view, { filename: 'TemplateView.vue' });
  assert.deepEqual(errors, []);
  const script = compiler.compileScript(descriptor, { id: 'tpl-new' });
  assert.ok(Object.hasOwn(script.bindings, 'newTemplate'));
  const workbench = await readFile(new URL('../src/printpress/Workbench.vue', import.meta.url), 'utf8');
  assert.match(workbench, /data-testid="pp-new-template"[\s\S]{0,140}新建模板/);
  // A header button only gets the accent background through .btn-primary; the bare
  // button rule paints it with the card colour instead.
  assert.match(workbench, /class="btn-primary"[^>]*data-testid="pp-new-template"/, '新建模板 keeps its primary styling');
  assert.match(workbench, /class="btn-primary"[^>]*data-testid="pp-import-table"/, '导入表格 keeps its primary styling');
  assert.match(workbench, /template\?\.newTemplate\(\)/);
  assert.match(workbench, /<TemplateView v-else-if="tab === 'template'" ref="template" \/>/);
  // It must sit in the same header row as 打开数据目录, before it.
  const heading = workbench.slice(workbench.indexOf('<header class="pp-heading">'), workbench.indexOf('</header>'));
  assert.ok(heading.indexOf('pp-new-template') < heading.indexOf('pp-data-directory'), '新建模板 comes before 打开数据目录 in the same row');
  // 底图制作 keeps its own buttons and its panel lift.
  const designer = await readFile(path.join(root, 'src/views/BackgroundDesignerView.vue'), 'utf8');
  const designerView = adaptPrintpressUI(designer, '/views/BackgroundDesignerView.vue');
  assert.match(designerView, /<PageHeader/, 'designer keeps its own header buttons');
  assert.match(designerView, /data-testid="design-new"/);
  const css = await readFile(new URL('../src/printpress/theme.css', import.meta.url), 'utf8');
  assert.match(css, /\.designer-workspace > \.designer-panel\.tools-panel \{ margin-top: calc\(-1 \* var\(--pp-header-lift\)\)/);
});

test('photo library drops the redundant 前往底图制作 shortcut and its header row', async () => {
  const input = await readFile(path.join(root, 'src/views/PhotoLibraryView.vue'), 'utf8');
  assert.match(input, /前往底图制作/, 'the source still has the button (PYF is untouched)');
  const view = adaptPrintpressUI(input, '/views/PhotoLibraryView.vue');
  assert.doesNotMatch(view, /前往底图制作/, 'the shortcut is gone');
  assert.doesNotMatch(view, /<PageHeader/, 'the whole empty row is removed, not just the button');
  assert.match(view, /emit\('navigate', 'dataset'\)/, 'other navigation controls survive');
  const { descriptor, errors } = compiler.parse(view, { filename: 'PhotoLibraryView.vue' });
  assert.deepEqual(errors, []);
  const script = compiler.compileScript(descriptor, { id: 'photo-lib' });
  const template = compiler.compileTemplate({ source: descriptor.template.content, filename: 'PhotoLibraryView.vue', id: 'photo-lib', compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  // Removing the row must also collapse the container padding left behind, otherwise
  // the band is merely emptied instead of letting the content move up.
  const css = await readFile(new URL('../src/printpress/theme.css', import.meta.url), 'utf8');
  assert.match(css, /\.pp-view > \.photo-library-view \{ padding-top: 0; \}/, 'photo page content moves up');
  assert.match(css, /\.pp-view > \.page \{ padding-top: 0; \}/, 'headerless page containers start at the top');
});

test('five-page header adapter removes repeated heading and description while keeping action slots', async () => {
  const source = await readFile(path.join(root, 'src/components/PageHeader.vue'), 'utf8');
  const result = adaptPrintpressUI(source, '/components/PageHeader.vue');
  const { descriptor } = compiler.parse(result);
  assert.doesNotMatch(descriptor.template.content, /page-header__text|<h2|page-header__desc/);
  assert.match(descriptor.template.content, /<slot name="actions"/);
  assert.match(descriptor.template.content, /<header v-if="\$slots.actions"/);
  for (const name of ['DatasetView', 'PhotoLibraryView', 'BackgroundDesignerView', 'TemplateView', 'PrintCenterView']) {
    const filename = '/views/' + name + '.vue';
    const input = await readFile(path.join(root, 'src', filename), 'utf8');
    const view = adaptPrintpressUI(input, filename);
    assert.doesNotMatch(view, /模板工坊/);
  }
});

test('dataset page moves its import action into the workbench header row', async () => {
  const input = await readFile(path.join(root, 'src/views/DatasetView.vue'), 'utf8');
  const view = adaptPrintpressUI(input, '/views/DatasetView.vue');
  assert.doesNotMatch(view, /<PageHeader title="数据">/, 'the dataset page no longer spends a row on its own header');
  assert.doesNotMatch(view, /导入数据文件/, 'the old button label is gone');
  assert.match(view, /defineExpose\(\{ startImport, importing, errorMsg \}\)/, 'the header button drives the real import action and state');
  assert.match(view, /async function startImport\(\)/, 'the original import flow is untouched');
  const { descriptor } = compiler.parse(view);
  const compiled = compiler.compileScript(descriptor, { id: 'dataset-import-header' });
  assert.ok(Object.hasOwn(compiled.bindings, 'startImport') && Object.hasOwn(compiled.bindings, 'importing'));
  const workbench = await readFile(new URL('../src/printpress/Workbench.vue', import.meta.url), 'utf8');
  assert.match(workbench, /data-testid="pp-import-table"[\s\S]{0,160}导入表格/);
  assert.match(workbench, /dataset\?\.startImport\(\)/);
  assert.match(workbench, /dataset\?\.errorMsg/, 'import errors stay visible without the old row');
  assert.match(workbench, /<DatasetView v-if="tab === 'dataset'" ref="dataset" \/>/);
  const heading = workbench.slice(workbench.indexOf('<header class="pp-heading">'), workbench.indexOf('</header>'));
  assert.equal((heading.match(/pp-data-directory/) || []).length, 1, 'import and data folder share the single existing header row');
  assert.match(heading, /pp-heading-actions/, 'both buttons live in one flex row');
  // The header reads dataset.importing / dataset.errorMsg through a template
  // ref. Vue wraps an exposed proxy in proxyRefs, so those reads must yield the
  // unwrapped values; without that the disabled state would never change.
  const { proxyRefs, ref: vueRef } = createRequire(path.join(root, 'package.json'))('vue');
  const importing = vueRef(false), errorMsg = vueRef('');
  const exposed = proxyRefs({ importing, errorMsg, startImport() { importing.value = true; } });
  assert.equal(exposed.importing, false); assert.equal(exposed.errorMsg, '');
  exposed.startImport();
  assert.equal(exposed.importing, true, 'the header button and its state follow the live refs');
});

test('capability UI compiles and reflects host or local-fast status without unsupported model choices', async () => {
  const input = await readFile(path.join(root, 'src/components/PhotoProcessingPanel.vue'), 'utf8');
  const result = adaptPhotoProcessingPanel(input);
  const { descriptor, errors } = compiler.parse(result, { filename: 'PhotoProcessingPanel.vue' });
  assert.deepEqual(errors, []);
  assert.ok(compiler.compileScript(descriptor, { id: 'host-photo' }).content);
  assert.deepEqual(compiler.compileTemplate({ source: descriptor.template.content, filename: 'PhotoProcessingPanel.vue', id: 'host-photo' }).errors, []);
  assert.doesNotMatch(descriptor.template.content, /完整安装包|本地抠图组件缺失|模型缺失|快速 ·|10～16|1～4|v-model="previewModel"|v-model="batchModel"/);
  assert.match(descriptor.template.content, /hostModel.reason/);
  assert.match(descriptor.template.content, /hostModel.source === 'local-fast' \? '快速本地模型' : 'DSH宿主'/);
  assert.match(descriptor.scriptSetup.content, /photoProcessingRevision.value\], refresh/);
  assert.match(descriptor.template.content, /photo-processing-host-capability/);
  assert.match(descriptor.template.content, /:disabled="!modelReady && !qualityReady && !recipe.cutout"/);
  assert.match(descriptor.template.content, /:disabled="!faceReady && !recipe.faceAlign"/);
});

test('missing host providers reject AI preview but permit ordinary image processing', async () => {
  const input = await readFile(path.join(root, 'src/components/PhotoProcessingPanel.vue'), 'utf8');
  const source = adaptPhotoProcessingPanel(input);
  const recipe = ref({ cutout: true, faceAlign: false }), modelReady = ref(false), qualityReady = ref(false), faceReady = ref(false);
  const blockStart = source.indexOf('const hostProcessingBlocked = computed('), blockEnd = source.indexOf('\n', blockStart);
  const hostProcessingBlocked = createInScope(source.slice(blockStart, blockEnd) + ';return hostProcessingBlocked;', { recipe, modelReady, qualityReady, faceReady, computed: fn => ({ get value() { return fn(); } }) });
  let requests = 0;
  const scope = {
    alive: true, opened: ref(true), selected: ref({ assetId: 'photo' }), applying: ref(false), previewing: ref(false),
    queued: false, revision: 0, sampleId: ref('photo'), recipe, normalizeRecipe: value => value,
    props: { datasetId: 'dataset', rowId: '' }, regenerateSingle: ref(false), singleSaved: ref(null),
    hostProcessingBlocked, hostModel: ref({ reason: 'No host provider registered' }), error: ref(''),
    previewModel: ref('fast'), previewAsset: ref(null), restoreAsset: ref(null), analysis: ref(null),
    photoProcessingSample: ref(null), photoColumn: ref('photo-column'), emit: () => {}, toUserMessage: value => value.message,
    clearTimeout: () => {}, setTimeout: () => { throw new Error('Unexpected retry'); }, previewTimer: undefined,
    window: { printpress: { async previewPhotoProcessing() { requests++; return { asset: { id: 'resized-photo' } }; } } }
  };
  const start = source.indexOf('async function preview() {'), end = source.indexOf('async function applyAll()', start);
  const preview = createInScope(source.slice(start, end) + ';return preview;', scope);
  await preview();
  assert.equal(requests, 0);
  assert.equal(scope.error.value, 'No host provider registered');
  modelReady.value = true;
  await preview();
  assert.equal(requests, 1, 'A ready local-fast fallback permits cutout even without face analysis.');
  recipe.value.faceAlign = true;
  await preview();
  assert.equal(requests, 1, 'Face alignment still requires its own host capability.');
  recipe.value.faceAlign = false; recipe.value.cutout = false; modelReady.value = false;
  await preview();
  assert.equal(requests, 2);
  assert.equal(scope.previewAsset.value.id, 'resized-photo');
  assert.equal(scope.error.value, '');
});

test('host color mapping adapts controls and backdrops without recoloring artwork or picker spectra', async () => {
  assert.match(hostThemeValue('background', '#fff', '.canvas-drop-btn'), /dsw-alias-bg-layer/);
  assert.match(hostThemeValue('background', '#b03a2e12', '.design-image-menu button:hover'), /dsw-alias-brand-primary/);
  assert.match(hostThemeValue('background', '#17130f88', '.image-editor-mask'), /dsw-alias-bg-base/);
  assert.match(hostThemeValue('color', '#b03a2e', '.edit-error'), /dsw-alias-state-error-primary/);
  for (const selector of ['.canvas', '.design-stage[data-v-demo]', '.preview-frame', '.canvas-navigator', '.field-text', '.color-square', '.hue::-webkit-slider-thumb']) {
    assert.equal(hostThemeValue('background', '#fff', selector), '#fff', selector);
  }
  const { descriptor } = compiler.parse(adapted);
  assert.match(descriptor.scriptSetup.content, /background: '#ffffff'/);
  const names = ['views/DatasetView', 'views/PhotoLibraryView', 'views/BackgroundDesignerView', 'views/TemplateView', 'views/PrintCenterView', 'components/PhotoProcessingPanel', 'components/DesignImageEditor', 'components/PageHeader'];
  for (const name of names) {
    const source = await readFile(path.join(root, 'src', name + '.vue'), 'utf8');
    const { descriptor: view } = compiler.parse(source);
    for (const style of view.styles) {
      const result = compiler.compileStyle({ source: style.content, id: 'theme-' + name, scoped: true, postcssPlugins: [{ postcssPlugin: 'host-test', Declaration(decl) { decl.value = hostThemeValue(decl.prop, decl.value, decl.parent?.selector || ''); } }] });
      assert.deepEqual(result.errors, [], name);
    }
  }
});
