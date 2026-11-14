import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pyfRoot = process.env.HUASHU_PRINTPRESS_ROOT || 'D:/个人开发/PYF';
const esbuild = await import('esbuild');

// bridge.js imports '@printpress-domain/user-error.cjs', which is a build-time
// alias. Compile just this module (with its real dependency) into a temp ESM
// file so transport() can be exercised against a real HTTP 400 response.
const built = await esbuild.build({
  absWorkingDir: root,
  stdin: { contents: await fs.readFile(path.join(root, 'src/printpress/bridge.js'), 'utf8'), resolveDir: path.join(root, 'src/printpress'), sourcefile: 'bridge.js', loader: 'js' },
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], write: false,
  alias: { '@printpress-domain': path.join(pyfRoot, 'electron') }
});
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-bridge-test-'));
const modulePath = path.join(temp, 'bridge.mjs');
await fs.writeFile(modulePath, built.outputFiles[0].contents);

const originalFetch = globalThis.fetch;
const logs = [];
const originalConsoleError = console.error;
let endpoint;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => raw += chunk);
  req.on('end', () => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'ERROR', message: '底图版本不存在或尚未提交' } }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
endpoint = `http://127.0.0.1:${server.address().port}`;
globalThis.fetch = (url, options) => originalFetch(url.startsWith('/') ? endpoint + url : url, options);
globalThis.EventSource = class { constructor() { this.onmessage = null; this.onerror = null; } close() {} };
console.error = (...args) => logs.push(args);
const { createBridge, forTransport } = await import(pathToFileURL(modulePath).href);

test('optional undefined arguments stay absent instead of becoming null over JSON', () => {
  const body = forTransport({ action: 'call', name: 'design:get', args: ['design_x', undefined] });
  assert.deepEqual(body.args, ['design_x'], 'trailing undefined is dropped');
  const roundtrip = JSON.parse(JSON.stringify(body));
  assert.equal(roundtrip.args.length, 1, 'no null revision reaches the worker');
  assert.equal('revision' in (roundtrip.args[1] || {}), false);
  assert.deepEqual(forTransport({ a: undefined, b: 1, c: { d: undefined, e: 2 } }), { b: 1, c: { e: 2 } });
  assert.deepEqual(forTransport(['x', undefined, 'y', undefined]), ['x', undefined, 'y'], 'only trailing undefined is trimmed');
});

test.after(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  server.close();
  return fs.rm(temp, { recursive: true, force: true });
});

test('a 400 domain error surfaces the real operation, code and message', async () => {
  const { api, dispose } = createBridge({});
  try {
    await assert.rejects(api.getDesign('design_x', 99), error => {
      assert.equal(error.code, 'ERROR');
      assert.equal(error.status, 400);
      assert.equal(error.operation, 'design:get');
      assert.match(error.message, /底图版本不存在或尚未提交/);
      assert.equal(error.userFacing, true);
      return true;
    });
    const line = logs.find(args => args[0] === '[PrintPress]');
    assert.ok(line, 'the failed operation is logged for diagnosis');
    assert.equal(line[1], 'design:get');
    assert.equal(line[2], 400);
    assert.equal(line[3], 'ERROR');
    assert.match(line[4], /底图版本不存在或尚未提交/);
  } finally { dispose(); }
});

test('bridge disposal rejects later transport', async () => {
  const { api, dispose } = createBridge({});
  dispose();
  await assert.rejects(api.getDesign('design_x', 1), /已关闭/);
});
