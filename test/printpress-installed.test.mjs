import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverPrintpress, inspectPrintpress } from '../lib/printpress-discovery.js';
import { createPrintpressRuntime } from '../lib/printpress.js';
import manifest from '../lib/printpress-manifest.json' with { type: 'json' };

test('installed PrintPress starts with isolated data and enforces the writer lock', { timeout: 120000 }, async t => {
  const installed = await discoverPrintpress(manifest.version);
  if (!installed) return t.skip('a compatible installed PrintPress is required');
  assert.equal(installed.kind, 'packaged');
  assert.equal(await inspectPrintpress(installed.root, '0.0.0-incompatible'), null);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-installed-test-'));
  const config = { printpressRoot: installed.root, printpressDataDir: path.join(temp, 'data'), printpressUserData: path.join(temp, 'runtime') };
  const first = createPrintpressRuntime(config);
  const second = createPrintpressRuntime({ ...config, printpressUserData: path.join(temp, 'runtime-2') });
  t.after(async () => {
    await second.dispose();
    await first.dispose();
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('huashu-installed-test-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const status = await first.status();
  assert.equal(status.kind, 'packaged');
  assert.equal(status.running, false);
  const ready = await first.start();
  assert.equal(ready.dataDir, path.join(temp, 'data'));
  assert.equal(ready.version, manifest.version);
  const ping = await first.operation('call', { name: 'app:ping', args: [] });
  assert.equal(ping.pong, true);
  await assert.rejects(second.start(), { code: 'DATA_DIR_BUSY' });
});
