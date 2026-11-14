import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { discoverPrintpress } from '../lib/printpress-discovery.js';
import { createPrintpressRuntime } from '../lib/printpress.js';
import manifest from '../lib/printpress-manifest.json' with { type: 'json' };

test('installed PrintPress runs MODNet on an isolated portrait fixture', { timeout: 180000 }, async t => {
  const portrait = process.env.HUASHU_PRINTPRESS_TEST_PORTRAIT;
  if (!portrait) return t.skip('set HUASHU_PRINTPRESS_TEST_PORTRAIT to a portrait fixture');
  const installed = await discoverPrintpress(manifest.version);
  if (!installed) return t.skip('a compatible installed PrintPress is required');
  const model = path.join(installed.resources, 'models', 'modnet.onnx');
  try { await fs.access(model); await fs.access(portrait); }
  catch { return t.skip('the model and portrait fixture must exist'); }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-installed-model-test-'));
  const runtime = createPrintpressRuntime({ printpressRoot: installed.root, printpressDataDir: path.join(temp, 'data'), printpressUserData: path.join(temp, 'runtime') });
  t.after(async () => {
    await runtime.dispose();
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('huashu-installed-model-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  await runtime.start();
  const capability = await runtime.request('imageCapabilities');
  assert.equal(capability.effective.source, 'local-fast');
  assert.equal(capability.fallback.ready, true);
  const call = (name, args = []) => runtime.operation('call', { name, args });
  const csv = path.join(temp, 'input.csv');
  await fs.writeFile(csv, '\ufeffid,name\n001,Example\n');
  const datasetId = (await call('dataset:inspect', [csv])).datasets[0].id;
  await call('dataset:setPhotoMatchColumn', [{ datasetId, key: 'id' }]);
  await call('photo:processingOptions', [{ datasetId, autoProcess: false }]);
  const folder = path.join(temp, 'photos');
  await fs.mkdir(folder);
  await fs.copyFile(portrait, path.join(folder, '001.jpg'));
  await call('photo:importFolder', [{ datasetId, column: 'id', folder }]);
  const assetId = (await call('photo:report', [{ datasetId, column: 'id' }])).results[0].assetId;
  const preview = await call('photo:processingPreview', [{ datasetId, assetId, recipe: { width: 384, height: 256, cutout: true, faceAlign: false }, model: 'fast' }]);
  assert.equal(preview.analysis.source, 'local-fast');
  const image = await runtime.media(preview.asset.id);
  const bytes = await fs.readFile(image.file);
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(bytes.readUInt32BE(16), 384);
  assert.equal(bytes.readUInt32BE(20), 256);
  const chunks = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(chunks));
  let transparent = 0, opaque = 0, soft = 0;
  for (let y = 0; y < 256; y++) {
    const row = y * (384 * 4 + 1);
    assert.equal(rows[row], 0, 'test output uses unfiltered RGBA rows');
    for (let x = 0; x < 384; x++) {
      const alpha = rows[row + 1 + x * 4 + 3];
      if (alpha <= 5) transparent++;
      else if (alpha >= 250) opaque++;
      else soft++;
    }
  }
  assert.ok(transparent > 20000 && opaque > 5000 && soft > 100, JSON.stringify({ transparent, opaque, soft }));
  const applied = await call('photo:processingApply', [{ datasetId, sampleAssetId: assetId, recipe: { width: 384, height: 256, cutout: true, faceAlign: false }, model: 'fast', taskId: 'installed-fast-test' }]);
  assert.equal(applied.applied, true);
  assert.equal((await call('photo:processingGet', [{ datasetId }])).model.source, 'local-fast');
});
