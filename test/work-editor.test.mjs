import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOperations } from '../lib/core.js';
import { createPrintpressRuntime, createPrintpressTool } from '../lib/printpress.js';
import { createWorkEditor } from '../lib/work-editor.js';
import { createHostImages } from '../lib/host-images.js';
import { createHttpHandler } from '../lib/host.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-work-editor-'));
  const operations = createOperations({ dshHome: path.join(root, 'home') });
  const runtime = createPrintpressRuntime({ printpressDataDir: path.join(root, 'data'), printpressUserData: path.join(root, 'runtime') });
  const editor = createWorkEditor(operations, runtime); runtime.attachEditor(editor);
  const runtimes = [runtime];
  t.after(async () => {
    for (const instance of runtimes) await instance.dispose();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('huashu-work-editor-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = (name, params, allowWrite = false) => runtime.operation('invoke', { name, params, allowWrite });
  return { root, operations, runtime, editor, call, trackRuntime(instance) { runtimes.push(instance); return instance; }, tool: createPrintpressTool(runtime) };
}
const doc = () => ({ name: 'Independent layers', artboard: { w: 50.8, h: 67.7333333333, background: '#f4f4f5' }, assets: {}, layers: [
  { id: 'panel', type: 'rect', x: 2, y: 2, w: 46, h: 62, fill: '#ffffff', stroke: 'transparent', strokeWidth: 0 },
  { id: 'title', type: 'text', x: 5, y: 8, w: 40, h: 15, fontFamily: 'Arial', fontSize: 12, text: 'Editable title', color: '#18181b' },
  { id: 'accent', type: 'ellipse', x: 5, y: 30, w: 12, h: 12, fill: '#2563eb', strokeWidth: 0 }
] });

async function documentWithAvailableFont(call) {
  const available = await call('font:list', {});
  const family = available.system[0]?.family || available.uploaded[0]?.family;
  assert.ok(family, 'portable editable text requires an installed or uploaded font');
  const value = doc(); value.layers[1].fontFamily = family; return value;
}

test('real layered project publishes, reopens, edits and returns to the same Huashu work', { timeout: 90000 }, async t => {
  const { root, operations, runtime, call, tool, trackRuntime } = await fixture(t);
  const guide = await tool.execute({ action: 'guide' });
  assert.equal(guide.example.layers.filter(layer => layer.type === 'text').length, 1);
  assert.equal((await runtime.status()).running, false, 'guide must not acquire an engine lock');
  const saved = await call('design:save', { design: await documentWithAvailableFont(call) }, true);
  const blocked = await tool.execute({ action: 'publish', designId: saved.id, revision: saved.revision });
  assert.equal(blocked.error.code, 'WRITE_FORBIDDEN');
  const first = await tool.execute({ action: 'publish', designId: saved.id, revision: saved.revision, title: 'Native layered card', module: 'infographic', requireLayers: true, allowWrite: true });
  assert.equal(first.ok, true, JSON.stringify(first));
  const created = first.data;
  assert.equal(created.layerCount, 3); assert.equal(created.item.layeredEditable, true); assert.equal(created.imageOnly, false);
  const firstPng = await fs.readFile(created.previewPath), firstPackage = await fs.readFile(created.projectPath);
  assert.equal(firstPng.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(firstPackage.toString('ascii', 0, 2), 'PK');
  assert.equal(firstPng.readUInt32BE(16), 300); assert.equal(firstPng.readUInt32BE(20), 400);
  const handoff = await runtime.operation('handoff', { workId: created.item.id });
  assert.equal(handoff.mode, 'layers'); assert.equal(handoff.openImageEditor, false); assert.equal(handoff.designRef.id, saved.id);
  const current = await call('design:get', handoff.designRef);
  current.layers.find(layer => layer.type === 'text').text = 'Changed in editor';
  const next = await call('design:save', { design: current }, true);
  const updated = await runtime.operation('publish', { workId: created.item.id, designId: next.id, revision: next.revision });
  assert.equal(updated.item.id, created.item.id); assert.equal(updated.item.createdAt, created.item.createdAt);
  assert.notEqual(updated.previewPath, created.previewPath); assert.notEqual(updated.projectPath, created.projectPath);
  assert.deepEqual(await fs.readFile(created.previewPath), firstPng, 'original delivered preview is preserved');
  assert.deepEqual(await fs.readFile(created.projectPath), firstPackage, 'original layered package is preserved');
  const reopened = await runtime.operation('handoff', { workId: created.item.id });
  const readback = await call('design:get', reopened.designRef);
  assert.equal(readback.layers.length, 3); assert.equal(readback.layers[1].text, 'Changed in editor');
  assert.equal((await operations.operation('list')).total, 1);
  await assert.rejects(runtime.operation('publish', { workId: created.item.id, designId: 'design_' + '0'.repeat(24), revision: 1 }), cause => cause.code === 'PROJECT_MISMATCH');
  const secondRuntime = trackRuntime(createPrintpressRuntime({ printpressDataDir: path.join(root, 'second-data'), printpressUserData: path.join(root, 'second-runtime') }));
  secondRuntime.attachEditor(createWorkEditor(operations, secondRuntime));
  const imported = await secondRuntime.operation('handoff', { workId: created.item.id });
  assert.notEqual(imported.designRef.id, saved.id, 'portable package creates a copy in another engine data root');
  const portable = await secondRuntime.operation('invoke', { name: 'design:get', params: imported.designRef });
  assert.equal(portable.layers[1].type, 'text'); assert.equal(portable.layers[1].text, 'Changed in editor');
  await secondRuntime.dispose();
});

test('raster handoff opens image tools, keeps the original and never advertises recovered text layers', { timeout: 90000 }, async t => {
  const { root, operations, runtime, call } = await fixture(t);
  const png = await fs.readFile(path.join((await runtime.status()).root, 'test/fixtures/tiny.png'));
  const original = path.join(root, 'original.png'); await fs.writeFile(original, png);
  const { item } = await operations.operation('add', { title: 'Flat picture', path: original, module: 'infographic' });
  const opened = await runtime.operation('handoff', { workId: item.id, filePath: path.join(root, 'not-registered.png') });
  assert.equal(opened.openImageEditor, true); assert.equal(opened.mode, 'image'); assert.equal(opened.imageOnly, true);
  assert.equal(opened.layerCount, 1); assert.equal(opened.item.path, original);
  const document = await call('design:get', opened.designRef);
  document.layers[0].opacity = 0.75;
  const saved = await call('design:save', { design: document }, true);
  await assert.rejects(runtime.operation('publish', { workId: item.id, designId: saved.id, revision: saved.revision, requireLayers: true }), cause => cause.code === 'NOT_LAYERED');
  const result = await runtime.operation('publish', { workId: item.id, designId: saved.id, revision: saved.revision });
  assert.equal(result.item.id, item.id); assert.equal(result.item.originPath, original); assert.equal(result.item.imageOnly, true);
  assert.deepEqual(await fs.readFile(original), png);
  assert.equal((await runtime.operation('handoff', { workId: item.id })).mode, 'image');
  await assert.rejects(runtime.operation('publish', { workId: item.id, designId: saved.id, revision: saved.revision, previewPath: original }), cause => cause.code === 'OUTPUT_EXISTS');
});

test('provider registration during startup and removal update the actual worker capability', { timeout: 30000 }, async t => {
  const { runtime } = await fixture(t);
  const images = createHostImages(); runtime.attachImages(images); t.after(() => images.dispose());
  const startup = runtime.start();
  const deadline = Date.now() + 5000;
  while (!runtime.diagnostics().pid && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(runtime.diagnostics().pid, 'Electron must actually spawn before registration');
  const unregister = images.register({ id: 'test-host', title: 'Test host', capabilities: { cutout: true, faceAlign: false }, process() { throw new Error('This test only inspects capability propagation'); } });
  await startup;
  const capabilities = await runtime.operation('capabilities');
  assert.equal(capabilities.host.cutout, true);
  assert.equal(capabilities.effective.source, 'dsh-host');
  const changed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Worker did not receive provider removal')); }, 5000);
    const unsubscribe = runtime.subscribe(message => {
      if (message.event === 'host:imageCapabilities' && !message.payload.host.cutout) { clearTimeout(timer); unsubscribe(); resolve(message.payload); }
    });
  });
  unregister();
  const removed = await changed;
  assert.equal(removed.host.cutout, false);
  assert.equal(removed.effective.source, removed.fallback.ready ? 'local-fast' : 'dsh-host');
});

test('authenticated HTTP handoff, publish and project download use the same editor service', { timeout: 90000 }, async t => {
  const { operations, runtime, call } = await fixture(t);
  let origin;
  const server = createServer(createHttpHandler(operations, { requestRejection: req => req.headers.authorization === 'test-owner' ? undefined : 401 }, () => origin, runtime));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const post = body => fetch(origin + '/huashu-design/printpress/api', { method: 'POST', headers: { authorization: 'test-owner', origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const saved = await call('design:save', { design: await documentWithAvailableFont(call) }, true);
  const response = await post({ action: 'publish', designId: saved.id, revision: saved.revision });
  assert.equal(response.status, 200); const { data } = await response.json();
  const handoff = await post({ action: 'handoff', workId: data.item.id });
  assert.equal(handoff.status, 200); assert.equal((await handoff.json()).data.layerCount, 3);
  const projectUrl = origin + '/huashu-design/printpress/project/' + data.item.id;
  assert.equal((await fetch(projectUrl)).status, 401);
  const archive = await fetch(projectUrl, { headers: { authorization: 'test-owner' } });
  assert.equal(archive.status, 200); assert.match(archive.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await archive.arrayBuffer()), await fs.readFile(data.projectPath));
  assert.equal((await fetch(origin + '/huashu-design/printpress/project/not-registered', { headers: { authorization: 'test-owner' } })).status, 404);
});
