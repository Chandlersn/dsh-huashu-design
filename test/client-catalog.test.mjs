import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOperations } from '../lib/core.js';

// Exercise the exact pure catalog-selection block shipped to the browser.
// No React, DOM or browser rendering is simulated here.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
const start = source.indexOf('const categoryFor=id=>');
const end = source.indexOf('const q=search', start);
assert.ok(start >= 0 && end > start, 'Client catalog selector block must be available.');
const select = new Function('styles', 'task', source.slice(start, end) + '; return { related, heroArt, referenceStyles };');

test('every task selects three real, distinct media-specific cover images', async () => {
  const ops = createOperations();
  const { tasks, styles } = await ops.catalog();
  const fingerprints = new Set();
  const categories = { web:'web', deck:'ppt', infographic:'info', app:'app', xiaohongshu:'xhs' };
  for (const task of tasks) {
    const view = select(styles, task.id);
    assert.equal(view.heroArt.length, 3, `${task.id} needs three cover specimens`);
    assert.equal(new Set(view.heroArt.map(x => x.id)).size, 3);
    assert.ok(view.referenceStyles.length >= 3);
    if (categories[task.id]) assert.ok(view.heroArt.every(x => x.category === categories[task.id]), `${task.id} has an unrelated cover`);
    for (const image of view.heroArt) assert.ok((await ops.assetFile(image.specimen)).file);
    fingerprints.add(view.heroArt.map(x => x.id).join('|'));
  }
  assert.equal(fingerprints.size, tasks.length, 'Each of the seven types must actually change the cover images.');
  assert.notDeepEqual(select(styles, 'web').heroArt.map(x => x.id), select(styles, 'deck').heroArt.map(x => x.id));
});
