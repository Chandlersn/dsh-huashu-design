import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PDFDocument } from 'pdf-lib';
import { createPrintpressRuntime, createPrintpressTool, PRINTPRESS_BASE } from '../lib/printpress.js';
import { createHttpHandler } from '../lib/host.js';
import { createOperations } from '../lib/core.js';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-printpress-e2e-'));
  const runtime = createPrintpressRuntime({ printpressDataDir: path.join(temp, 'data'), printpressUserData: path.join(temp, 'runtime') });
  t.after(async () => {
    await runtime.dispose();
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('huashu-printpress-e2e-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  return { temp, runtime, tool: createPrintpressTool(runtime) };
}

test('embedded engine shares one writer and runs real CSV, layout, PDF and PNG operations', { timeout: 90000 }, async t => {
  const { temp, runtime, tool } = await fixture(t);
  assert.equal((await runtime.status()).running, false);
  const discovery = await tool.execute({ action: 'operations', query: 'print:' });
  assert.ok(discovery.items.some(item => item.name === 'print:generate'));
  assert.equal((await runtime.status()).running, false, 'metadata discovery must not acquire the production data lock');
  const starts = await Promise.all([runtime.start(), runtime.start(), runtime.start()]);
  assert.ok(starts.every(item => item.dataDir === path.join(temp, 'data')));
  const pid = runtime.diagnostics().pid;
  assert.ok(Number.isInteger(pid));
  assert.equal((await runtime.operation('call', { name: 'app:ping', args: [] })).pong, true);
  assert.equal(runtime.diagnostics().pid, pid);
  const csv = '\ufeff编号,姓名\n001,张三\n002,李四\n';
  const staged = await runtime.operation('upload', { name: '集成验收.csv', base64: Buffer.from(csv).toString('base64') });
  const denied = await tool.execute({ action: 'call', operation: 'dataset:importFile', params: { filePath: staged.filePath } });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'WRITE_FORBIDDEN');
  assert.deepEqual(await runtime.operation('call', { name: 'dataset:list', args: [] }), []);
  const imported = await runtime.operation('call', { name: 'dataset:inspect', args: [staged.filePath] });
  const dataset = imported.datasets[0];
  const detail = await runtime.operation('call', { name: 'dataset:get', args: [dataset.id] });
  assert.equal(detail.rows.length, 2); assert.equal(detail.rows[1]['姓名'], '李四');
  await runtime.operation('call', { name: 'dataset:updateCell', args: [{ datasetId: dataset.id, rowIndex: 0, key: '姓名', value: '张三丰' }] });
  assert.equal((await runtime.operation('call', { name: 'dataset:get', args: [dataset.id] })).rows[0]['姓名'], '张三丰');
  for (const key of ['编号', '姓名']) await runtime.operation('call', { name: 'dataset:setColumnPrint', args: [{ datasetId: dataset.id, key, printOn: true }] });
  const png = await fs.readFile(path.join(starts[0].root, 'test/fixtures/tiny.png'));
  const background = await runtime.operation('call', { name: 'template:uploadBackgroundBytes', args: [{ dataBase64: png.toString('base64'), fileName: '测试底图.png' }] });
  assert.ok(background.background);
  const media = await runtime.media(background.background);
  assert.equal(media.mime, 'image/png'); assert.deepEqual(await fs.readFile(media.file), png);
  await assert.rejects(runtime.media('datasets.json'), /照片、底图和字体/);
  await assert.rejects(runtime.media('%2e%2e/package.json'), /媒体路径/);
  await assert.rejects(runtime.operation('call', { name: 'app:installUpdate', args: [] }), /名称或参数/);
  const saved = await tool.execute({ action: 'call', operation: 'template:save', allowWrite: true, params: { template: {
    name: '花叔集成验收', datasetId: dataset.id, pageSize: { id: 'a6-landscape', w: 148, h: 105 }, background: background.background,
    fields: [{ column: '姓名', label: '姓名', x: 50, y: 40, fontSize: 24, align: 'center', color: '#000000' }]
  } } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const payload = { datasetId: dataset.id, templateId: saved.data.id };
  const preview = await runtime.operation('call', { name: 'print:generate', args: [payload] });
  assert.match(preview.html, /张三丰/); assert.match(preview.html, /李四/); assert.match(preview.html, /<img|background-image/);
  const messages = [];
  const unsubscribe = runtime.subscribe(message => messages.push(message));
  const pdfPath = path.join(temp, '两人证书.pdf');
  const output = await tool.execute({ action: 'call', operation: 'print:exportPdf', allowWrite: true, params: { ...payload, savePath: pdfPath, batchRows: 1 } });
  assert.equal(output.ok, true, JSON.stringify(output));
  const pdf = await PDFDocument.load(await fs.readFile(pdfPath)); assert.equal(pdf.getPageCount(), 2);
  assert.ok(messages.some(message => message.event === 'print:progress'), 'real progress is emitted while PDF rendering runs');
  const images = await runtime.operation('invoke', { name: 'print:exportImages', allowWrite: true, params: { ...payload, outputDir: path.join(temp, 'images'), field1: '编号', field2: '姓名', outputDpi: 150 } });
  assert.equal(images.count, 2);
  const bytes = await fs.readFile(images.files[0]);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), Math.ceil(148 / 25.4 * 150));
  assert.equal(bytes.readUInt32BE(20), Math.ceil(105 / 25.4 * 150));
  const jobs = await runtime.operation('call', { name: 'job:list', args: [] });
  assert.equal(jobs.length, 2); assert.ok(jobs.every(job => job.status === 'ok'));
  const photos = path.join(temp, 'photos'); await fs.mkdir(photos);
  await fs.writeFile(path.join(photos, '001.png'), png); await fs.writeFile(path.join(photos, '002.png'), png);
  await runtime.operation('invoke', { name: 'photo:processingOptions', allowWrite: true, params: { datasetId: dataset.id, autoProcess: false } });
  await runtime.operation('call', { name: 'dataset:setPhotoMatchColumn', args: [{ datasetId: dataset.id, key: '编号' }] });
  await runtime.operation('invoke', { name: 'photo:importFolder', allowWrite: true, params: { datasetId: dataset.id, column: '编号', folder: photos } });
  const photoReport = await runtime.operation('call', { name: 'photo:report', args: [{ datasetId: dataset.id, column: '编号' }] });
  assert.equal(photoReport.results.filter(item => item.status === 'matched').length, 2);
  const processed = await runtime.operation('call', { name: 'photo:processingPreview', args: [{ datasetId: dataset.id, assetId: photoReport.results[0].assetId, recipe: { width: 64, height: 96, cutout: false } }] });
  const processedBytes = await fs.readFile((await runtime.media(processed.asset.id)).file);
  assert.equal(processedBytes.readUInt32BE(16), 64); assert.equal(processedBytes.readUInt32BE(20), 96);
  unsubscribe();
  const contender = createPrintpressRuntime({ printpressDataDir: path.join(temp, 'data'), printpressUserData: path.join(temp, 'contender-runtime') });
  try { await assert.rejects(contender.start(), error => error.code === 'DATA_DIR_BUSY'); }
  finally { await contender.dispose(); }
  assert.equal((await runtime.operation('call', { name: 'app:ping', args: [] })).pong, true, 'refusing a contender must not release the active writer lock');
  await runtime.dispose();
  await assert.rejects(fs.stat(path.join(temp, 'data/data-dir.lock.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(staged.filePath), { code: 'ENOENT' });
});

test('HTTP bridge applies authentication and same-origin rules to calls, uploads, events and media', { timeout: 30000 }, async t => {
  const { temp, runtime } = await fixture(t);
  const connection = { requestRejection: req => req.headers['x-test-auth'] === 'yes' ? undefined : 401 };
  let origin;
  const handler = createHttpHandler(createOperations({ dshHome: temp }), connection, () => origin, runtime);
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  for (const suffix of ['/status', '/events', '/media/a.png']) {
    const response = await fetch(origin + PRINTPRESS_BASE + suffix);
    assert.equal(response.status, 401);
  }
  const endpoint = origin + PRINTPRESS_BASE + '/api';
  const headers = { 'x-test-auth': 'yes', 'Content-Type': 'application/json', Origin: origin };
  const denied = await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://other.invalid' }, body: JSON.stringify({ action: 'start' }) });
  assert.equal(denied.status, 403); assert.equal((await runtime.status()).running, false);
  const upload = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ action: 'upload', name: 'HTTP.csv', base64: Buffer.from('姓名\n花叔\n').toString('base64') }) });
  const staged = await upload.json(); assert.equal(staged.ok, true);
  const result = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ action: 'call', name: 'dataset:inspect', args: [staged.data.filePath] }) });
  const imported = await result.json(); assert.equal(imported.ok, true); assert.equal(imported.data.datasets.length, 1);
  const rejected = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ action: 'invoke', name: 'dataset:delete', allowWrite: true, params: {} }) });
  assert.equal(rejected.status, 400, 'browser input cannot switch to the agent invocation or lifecycle channel');
  const frame = await fetch(origin + PRINTPRESS_BASE + '/events', { headers: { 'x-test-auth': 'yes' }, signal: AbortSignal.timeout(4000) });
  assert.match(frame.headers.get('content-type'), /text\/event-stream/);
  const reader = frame.body.getReader(); const chunk = await reader.read(); assert.ok(chunk.value.length); await reader.cancel();
  const readOnly = await fetch(origin + PRINTPRESS_BASE + '/media/datasets.json', { headers: { 'x-test-auth': 'yes' } });
  assert.equal(readOnly.status, 403);
});
