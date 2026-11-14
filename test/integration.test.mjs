import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperations } from '../lib/core.js';

async function context(t) {
  const root = await mkdtemp(join(tmpdir(), 'huashu-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, ops: createOperations({ dshHome: root }) };
}

test('upstream snapshot exposes all 92 actual image files and seven creation modules', async t => {
  const { ops } = await context(t);
  const catalog = await ops.operation('catalog');
  assert.equal(catalog.styles.length, 92);
  assert.ok(catalog.tasks.some(x => x.id === 'xiaohongshu'));
  assert.equal(catalog.styles.filter(x => x.category === 'xhs').length, 8);
  assert.ok(catalog.styles.filter(x => x.category === 'xhs').every(x => x.module === 'xiaohongshu'));
  for (const item of catalog.styles) assert.ok((await stat((await ops.assetFile(item.specimen)).file)).size > 1000);
  assert.equal(catalog.manifest.source.commit, 'e8d1148a80d5a281d4247cffe320add3df017928');
});

test('Xiaohongshu brief uses the Xiaohongshu guide', async t => {
  const { ops } = await context(t);
  const result = await ops.operation('draft', { task: 'xiaohongshu', brief: '五页咖啡图文' });
  assert.match(result.draft, /xiaohongshu\.md/);
  assert.match(result.draft, /五页咖啡图文/);
});

test('tool-only reuse inherits registered module and style with explicit overrides', async t => {
  const { root, ops } = await context(t);
  const file = join(root, 'deck.html'); await writeFile(file, '<html><title>Deck</title></html>');
  const catalog = await ops.operation('catalog');
  const style = catalog.styles.find(x => x.category === 'ppt').id;
  const { item } = await ops.operation('add', { path: file, title: 'My deck', module: 'deck', style });
  const draft = await ops.operation('draft', { workId: item.id });
  assert.equal(draft.task, 'deck'); assert.equal(draft.style, style);
  assert.match(draft.draft, /deck\.md/);
  const override = await ops.operation('draft', { workId: item.id, task: 'web', style: '' });
  assert.equal(override.task, 'web'); assert.equal(override.style, null);
});

test('review workflow uses critique and never requests a new webpage', async t => {
  const { ops } = await context(t);
  const result = await ops.operation('draft', { workflow: 'review-polish', task: 'web' });
  assert.equal(result.task, 'critique');
  assert.match(result.draft, /critique-guide\.md/);
  assert.doesNotMatch(result.draft, /制作 HTML 网页|三个有明显差异/);
});
