import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createOperations, OperationError } from '../lib/core.js';
import { createWorkPreview, PREVIEW_LIMITS } from '../lib/work-preview.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const code = expected => error => error instanceof OperationError && error.code === expected;
async function fixture(t, content = '<!doctype html><html><head><title>Original</title></head><body>Work</body></html>', extension = '.html') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-preview-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('huashu-preview-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'project'); await fs.mkdir(directory);
  const file = path.join(directory, `article${extension}`); await fs.writeFile(file, content);
  const operations = createOperations({ dshHome: path.join(root, 'home') });
  const { item } = await operations.operation('add', { title: 'Registered article', path: file, module: 'web' });
  const put = async (relative, bytes = png) => {
    const destination = path.join(directory, relative); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes); return destination;
  };
  const sparse = async (relative, size) => {
    const destination = await put(relative, ''); const handle = await fs.open(destination, 'r+'); try { await handle.truncate(size); } finally { await handle.close(); } return destination;
  };
  return { root, directory, file, content, item, operations, put, sparse, preview: createWorkPreview(operations) };
}
async function junction(t, target, destination, directory = true) {
  try { await fs.symlink(target, destination, directory && process.platform === 'win32' ? 'junction' : directory ? 'dir' : 'file'); return true; }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic(`Link branch unavailable: ${error.code}`); return false; } throw error; }
}
async function filePrototype(file) { const handle = await fs.open(file, 'r'); const prototype = Object.getPrototypeOf(handle); await handle.close(); return prototype; }

test('preview limits match the source editor, per-resource, aggregate and reference contracts', () => {
  assert.deepEqual(PREVIEW_LIMITS, { sourceBytes: 128 * 1024, resourceBytes: 16 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, entries: 100 });
});

test('registered HTML renders a copy with original identity and no injected CSP, RPC or index writes', async t => {
  const f = await fixture(t, '<!doctype html><html><body><h1>你好</h1><script>window.original = true;</script></body></html>');
  const library = await fs.readFile(f.operations.libraryPath, 'utf8');
  const result = await f.preview.render(f.item.id);
  assert.deepEqual(result, { kind: 'html', workId: f.item.id, title: f.item.title, html: f.content, assetMap: {}, sourcePath: f.item.sourcePath, warnings: [] });
  assert.equal(await fs.readFile(f.file, 'utf8'), f.content);
  assert.equal(await fs.readFile(f.operations.libraryPath, 'utf8'), library);
  assert.doesNotMatch(result.html, /Content-Security-Policy|postMessage|guizang-design/);
});

test('registered HTM self-source is editable inline while an external source stays preview-only', async t => {
  const f = await fixture(t, '<html>HTM</html>', '.HTM');
  assert.equal((await f.preview.render(f.item.id)).sourcePath, f.file);
  const actual = await f.put('source.txt', 'Actual source');
  await f.operations.operation('add', { title: 'HTM', path: f.file, sourcePath: actual });
  assert.equal((await f.preview.render(f.item.id)).sourcePath, null);
  assert.equal((await f.operations.operation('source', { id: f.item.id })).path, actual);
  const readOnly = createWorkPreview({ workFile: async id => { const result = await f.operations.workFile(id); return { ...result, item: { ...result.item, editable: false } }; } });
  assert.equal((await readOnly.render(f.item.id)).sourcePath, null);
});

test('an exported HTML associated with JS has no inline source bridge and keeps its source association', async t => {
  const f = await fixture(t);
  const original = 'export const title = "Original template";\n';
  const actual = await f.put('template.js', original);
  await f.operations.operation('add', { title: 'HTML export', path: f.file, sourcePath: actual });
  const library = await fs.readFile(f.operations.libraryPath, 'utf8');
  const result = await f.preview.render(f.item.id);
  assert.equal(result.sourcePath, null);
  assert.equal(result.html, f.content);
  const selected = await f.operations.operation('source', { id: f.item.id });
  assert.equal(selected.path, actual);
  assert.equal(selected.content, original);
  assert.equal((await f.operations.operation('edit', { id: f.item.id })).sourcePath, actual);
  assert.equal(await fs.readFile(actual, 'utf8'), original);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.content);
  assert.equal(await fs.readFile(f.operations.libraryPath, 'utf8'), library);
});

test('only a registered HTML work can enter render or thumbnail', async t => {
  const f = await fixture(t);
  await assert.rejects(f.preview.render('../article.html'), code('INVALID_ARGUMENT'));
  await assert.rejects(f.preview.render('unknown-id'), code('NOT_FOUND'));
  const image = await f.put('image.png');
  const { item } = await f.operations.operation('add', { title: 'Image', path: image });
  await assert.rejects(f.preview.render(item.id), code('UNSUPPORTED_PREVIEW'));
  await assert.rejects(f.preview.thumbnail(item.id), code('UNSUPPORTED_PREVIEW'));
  const forged = createWorkPreview({ workFile: async () => ({ file: f.file, item: { ...f.item, id: 'other-id' } }) });
  await assert.rejects(forged.render(f.item.id), code('INVALID_PREVIEW_WORK'));
});

test('local img sources and width/density srcset are embedded without changing the source file', async t => {
  const html = '<img src="assets/a.png" srcset="assets/a.png 1x, assets/b.jpg 2x"><source srcset="assets/a.png 320w, assets/b.jpg 640w">';
  const f = await fixture(t, html); await f.put('assets/a.png'); await f.put('assets/b.jpg', Buffer.from([255, 216, 255, 217]));
  const result = await f.preview.render(f.item.id);
  assert.match(result.html, /src="data:image\/png;base64,/);
  assert.match(result.html, /data:image\/png;base64,[^ ]+ 1x, data:image\/jpeg;base64,[^ ]+ 2x/);
  assert.match(result.html, /320w/); assert.match(result.html, /640w/);
  assert.equal(await fs.readFile(f.file, 'utf8'), html);
});

test('data-image and original query URL keys point only to verified image bytes', async t => {
  const f = await fixture(t, '<button data-image="assets/a.png?version=1">Zoom</button><img src="assets/a.png?version=2"><style>@font-face{src:url(font.woff2)}</style><img src="https://example.test/not-read.png">');
  await f.put('assets/a.png'); await f.put('font.woff2', 'font bytes');
  const result = await f.preview.render(f.item.id);
  assert.match(result.html, /data-image="data:image\/png;base64,/);
  assert.equal(result.assetMap['assets/a.png?version=1'], `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(result.assetMap['assets/a.png?version=2'], result.assetMap['assets/a.png?version=1']);
  assert.deepEqual(Object.keys(result.assetMap).sort(), ['assets/a.png', 'assets/a.png?version=1', 'assets/a.png?version=2']);
  assert.equal(result.assetMap['font.woff2'], undefined);
  assert.equal(result.assetMap['https://example.test/not-read.png'], undefined);
});

test('existing data URLs and fragment anchors remain unchanged in img, srcset and CSS', async t => {
  const data = `data:image/png;base64,${png.toString('base64')}`;
  const f = await fixture(t, `<style>.a{background:url(#shape)}</style><img src="${data}" srcset="${data} 1x"><link rel="stylesheet" href="data:text/css,.x%7Bcolor:red%7D">`);
  const result = await f.preview.render(f.item.id);
  assert.ok(result.html.includes(`src="${data}"`)); assert.ok(result.html.includes(`srcset="${data} 1x"`));
  assert.match(result.html, /url\("#shape"\)/);
  assert.match(result.html, /href="data:text\/css,/);
  assert.deepEqual(result.warnings, []);
});

test('local stylesheets, style attributes, CSS images and sibling fonts inline relative to their stylesheet', async t => {
  const f = await fixture(t, '<link rel="stylesheet" href="styles/site.css" media="screen"><div style="background: url(assets/a.png)">Text</div>');
  await f.put('assets/a.png'); await f.put('fonts/body.woff2', Buffer.from('fixture font'));
  await f.put('styles/site.css', '@font-face{font-family:x;src:url("../fonts/body.woff2")} .x{background:url(../assets/a.png)}');
  const result = await f.preview.render(f.item.id);
  assert.match(result.html, /<style media="screen">/);
  assert.match(result.html, /data:font\/woff2;base64,/);
  assert.match(result.html, /data:image\/png;base64,/);
  assert.doesNotMatch(result.html, /href="styles\/|\.\.\/fonts/);
});

test('CSS font types and SVG fragments use explicit MIME allowlists', async t => {
  const f = await fixture(t, '<style>@font-face{src:url(fonts/a.woff),url(fonts/b.ttf),url(fonts/c.otf)}.x{mask:url(assets/a.svg#mask)}</style>');
  for (const extension of ['woff', 'ttf', 'otf']) await f.put(`fonts/${({ woff: 'a', ttf: 'b', otf: 'c' })[extension]}.${extension}`, 'font bytes');
  await f.put('assets/a.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const result = await f.preview.render(f.item.id);
  for (const type of ['font/woff', 'font/ttf', 'font/otf', 'image/svg+xml']) assert.ok(result.html.includes(`data:${type};base64,`));
  assert.match(result.html, /#mask/);
});

test('HTML entities and single URI encoding resolve local resource names once', async t => {
  const f = await fixture(t, '<img src="assets/a&amp;b.png"><img src="assets/space%20name.png">');
  await f.put('assets/a&b.png'); await f.put('assets/space name.png');
  const result = await f.preview.render(f.item.id);
  assert.equal((result.html.match(/data:image\/png;base64,/g) || []).length, 2);
});

test('external images, stylesheet links and all linked scripts are omitted with bounded warnings', async t => {
  const f = await fixture(t, '<link rel="stylesheet" href="https://example.test/a.css"><link rel="preload" href="local.json"><img src="//example.test/a.png"><script src="assets/app.js">unwanted()</script><script>keep()</script>');
  const result = await f.preview.render(f.item.id);
  assert.doesNotMatch(result.html, /example\.test|unwanted\(\)|assets\/app\.js|local\.json/);
  assert.match(result.html, /<script>keep\(\)<\/script>/);
  assert.ok(result.warnings.some(value => /External preview resources/.test(value)));
  assert.ok(result.warnings.some(value => /linked scripts/.test(value)));
});

test('base tags and HTML refresh directives are removed, including entity-encoded refresh', async t => {
  const f = await fixture(t, '<base href="file:///secret/"><meta HTTP-EQUIV="refr&#101;sh" content="0;url=https://example.test"><img src="assets/a.png">');
  await f.put('assets/a.png');
  const result = await f.preview.render(f.item.id);
  assert.doesNotMatch(result.html, /<base|<meta|file:\/|https:/i);
  assert.match(result.html, /data:image\/png/);
  assert.equal(result.warnings.length, 2);
});

test('CSS imports including escaped identifiers are omitted without reading imported files', async t => {
  const f = await fixture(t, String.raw`<style>@import url("https://example.test/a.css"); @\69mport "missing.css"; @im\70 ort "also-missing.css"; .x{color:red}</style>`);
  const result = await f.preview.render(f.item.id);
  assert.match(result.html, /\.x\{color:red\}/);
  assert.doesNotMatch(result.html, /missing\.css|example\.test|@import/);
  assert.ok(result.warnings.some(value => /CSS @import/.test(value)));
});

test('comments and inline script/raw-text bodies are not parsed as resource markup', async t => {
  const html = '<!-- <img src="../private.png"> --><script>const demo = \'<img src="../private.png">\';</script><textarea><img src="../private.png"></textarea>';
  const f = await fixture(t, html);
  assert.equal((await f.preview.render(f.item.id)).html, html);
});

test('relative traversal, drive paths, UNC, file URLs, backslashes and double encoding are rejected', async t => {
  const f = await fixture(t); await f.put('../private.png');
  const values = ['../private.png', '/private.png', 'C:/private.png', 'C:private.png', '\\\\server\\private.png', 'assets\\a.png', 'file:///private.png', '%2e%2e/private.png', '%252e%252e/private.png', 'assets/%255cprivate.png', 'assets/%00a.png', 'http&colon;//example.test/a.png/../../private.png'];
  for (const value of values) {
    await fs.writeFile(f.file, `<img src="${value}">`);
    if (value.startsWith('http&colon;')) { const result = await f.preview.render(f.item.id); assert.doesNotMatch(result.html, /src=/); }
    else await assert.rejects(f.preview.render(f.item.id), code('UNSAFE_PREVIEW_PATH'));
  }
});

test('CSS escaped url identifiers cannot bypass traversal or Windows-path rules', async t => {
  const f = await fixture(t);
  for (const css of [String.raw`.x{background:u\72l('../private.png')}`, String.raw`.x{background:url('assets\private.png')}`, '.x{background:url(file:///private.png)}']) {
    await fs.writeFile(f.file, `<style>${css}</style>`);
    await assert.rejects(f.preview.render(f.item.id), code('UNSAFE_PREVIEW_PATH'));
  }
});

test('unsupported local source extensions are rejected before being interpreted as images or CSS', async t => {
  const f = await fixture(t); const secret = await f.put('private.json', '{"private":"content"}');
  for (const markup of ['<img src="private.json">', '<link rel="stylesheet" href="private.json">', '<style>.x{background:url(private.json)}</style>']) {
    await fs.writeFile(f.file, markup);
    await assert.rejects(f.preview.render(f.item.id), code('UNSUPPORTED_PREVIEW_RESOURCE'));
  }
  assert.equal(await fs.readFile(secret, 'utf8'), '{"private":"content"}');
});

test('missing resources and directory resources fail explicitly instead of serving partial previews', async t => {
  const f = await fixture(t, '<img src="missing.png">');
  await assert.rejects(f.preview.render(f.item.id), code('PREVIEW_NOT_FOUND'));
  await fs.mkdir(path.join(f.directory, 'directory.png'));
  await fs.writeFile(f.file, '<img src="directory.png">');
  await assert.rejects(f.preview.render(f.item.id), code('INVALID_PREVIEW_FILE'));
});

test('resource symlinks and ancestor directory junctions cannot expose external data', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); const secret = path.join(outside, 'private.png'); await fs.writeFile(secret, png);
  const alias = path.join(f.directory, 'alias.png');
  if (await junction(t, secret, alias, false)) { await fs.writeFile(f.file, '<img src="alias.png">'); await assert.rejects(f.preview.render(f.item.id), code('UNSAFE_PREVIEW_PATH')); }
  if (await junction(t, outside, path.join(f.directory, 'escape'))) { await fs.writeFile(f.file, '<img src="escape/private.png">'); await assert.rejects(f.preview.render(f.item.id), code('UNSAFE_PREVIEW_PATH')); }
});

test('a source parent replaced by a junction cannot be used by render or thumbnail', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, path.basename(f.file)), 'External HTML');
  await fs.rename(f.directory, path.join(f.root, 'original'));
  if (!await junction(t, outside, f.directory)) return;
  // The registered operations themselves may reject before this module is entered.
  await assert.rejects(f.preview.render(f.item.id), error => error.status === 403);
  await assert.rejects(f.preview.thumbnail(f.item.id), error => error.status === 403);
});

test('a file changed during bounded reading is rejected by the external inode/time observation', async t => {
  const f = await fixture(t);
  const prototype = await filePrototype(f.file), originalRead = prototype.read;
  let injected = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await originalRead.apply(this, args);
    if (!injected && args[0].subarray(0, result.bytesRead).toString('utf8').startsWith('<!doctype')) { injected = true; await fs.appendFile(f.file, 'external change'); }
    return result;
  });
  await assert.rejects(f.preview.render(f.item.id), code('PREVIEW_FILE_CHANGED'));
  assert.equal(injected, true);
});

test('a junction substituted after the source read is detected before returning the preview copy', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, path.basename(f.file)), 'External HTML');
  const check = path.join(f.root, 'junction-check'); if (!await junction(t, outside, check)) return; await fs.unlink(check);
  const prototype = await filePrototype(f.file), originalRead = prototype.read;
  let replaced = false, armed = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await originalRead.apply(this, args);
    if (!armed && args[0].subarray(0, result.bytesRead).toString('utf8').startsWith('<!doctype')) {
      armed = true;
      const close = this.close.bind(this);
      this.close = async () => {
        await close(); replaced = true;
        await fs.rename(f.directory, path.join(f.root, 'moved'));
        await fs.symlink(outside, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
      };
    }
    return result;
  });
  await assert.rejects(f.preview.render(f.item.id), code('UNSAFE_PREVIEW_PATH'));
  assert.equal(replaced, true);
});

test('the source limit is exact and oversize or binary HTML is never truncated', async t => {
  const f = await fixture(t);
  const exact = 'x'.repeat(PREVIEW_LIMITS.sourceBytes);
  await fs.writeFile(f.file, exact); assert.equal((await f.preview.render(f.item.id)).html.length, exact.length);
  await fs.writeFile(f.file, exact + 'x'); await assert.rejects(f.preview.render(f.item.id), code('PREVIEW_SOURCE_TOO_LARGE'));
  assert.equal((await fs.stat(f.file)).size, PREVIEW_LIMITS.sourceBytes + 1);
  await fs.writeFile(f.file, Buffer.from([255, 254, 0])); await assert.rejects(f.preview.render(f.item.id), code('BINARY_PREVIEW_SOURCE'));
});

test('a single resource above 16 MiB fails before being allocated or truncated', async t => {
  const f = await fixture(t, '<img src="large.png">'); const large = await f.sparse('large.png', PREVIEW_LIMITS.resourceBytes + 1);
  await assert.rejects(f.preview.render(f.item.id), code('PREVIEW_RESOURCE_TOO_LARGE'));
  assert.equal((await fs.stat(large)).size, PREVIEW_LIMITS.resourceBytes + 1);
});

test('aggregate resource bytes include repeated inline references and stop above 32 MiB', async t => {
  const f = await fixture(t, '<img src="large.png"><img src="large.png"><img src="large.png">');
  await f.sparse('large.png', 11 * 1024 * 1024);
  await assert.rejects(f.preview.render(f.item.id), code('PREVIEW_RESOURCES_TOO_LARGE'));
});

test('the verified image map counts toward the 32 MiB response budget', async t => {
  const f = await fixture(t, '<img src="large.png">');
  await f.sparse('large.png', 12 * 1024 * 1024);
  await assert.rejects(f.preview.render(f.item.id), error => code('PREVIEW_RESOURCES_TOO_LARGE')(error) && /image map/.test(error.message));
});

test('JSON escaping is included in the response budget rather than counting source strings alone', async t => {
  const f = await fixture(t, `<script>${'"'.repeat(24000)}</script><img src="large.png">`);
  await f.sparse('large.png', 12 * 1024 * 1024 - 16384);
  await assert.rejects(f.preview.render(f.item.id), error => code('PREVIEW_RESOURCES_TOO_LARGE')(error) && /serialized preview/.test(error.message));
});

test('100 repeated resource references fit while 101 fail even with a shared read cache', async t => {
  const f = await fixture(t); await f.put('tiny.png');
  await fs.writeFile(f.file, '<img src="tiny.png">'.repeat(100));
  assert.equal(((await f.preview.render(f.item.id)).html.match(/data:image\/png/g) || []).length, 100);
  await fs.writeFile(f.file, '<img src="tiny.png">'.repeat(101));
  await assert.rejects(f.preview.render(f.item.id), code('PREVIEW_TOO_MANY_RESOURCES'));
});

test('malformed resource CSS and invalid srcset descriptors produce explicit errors', async t => {
  const f = await fixture(t, '<style>.x{background:url("unfinished.png"}</style>');
  await assert.rejects(f.preview.render(f.item.id), error => error instanceof OperationError && [403, 422].includes(error.status));
  await fs.writeFile(f.file, '<img srcset="tiny.png invalid">');
  await assert.rejects(f.preview.render(f.item.id), code('INVALID_PREVIEW_SRCSET'));
});

test('thumbnail prefers an existing desktop sidecar, otherwise the same-stem PNG', async t => {
  const f = await fixture(t);
  const fallback = await f.put('article.png'), desktop = await f.put('article-desktop.png');
  assert.deepEqual(await f.preview.thumbnail(f.item.id), { file: desktop, mime: 'image/png' });
  await fs.unlink(desktop);
  assert.deepEqual(await f.preview.thumbnail(f.item.id), { file: fallback, mime: 'image/png' });
  assert.equal(await fs.readFile(f.file, 'utf8'), f.content);
});

test('missing thumbnails return 404 without creating files, launching a renderer or changing registration', async t => {
  const f = await fixture(t), library = await fs.readFile(f.operations.libraryPath, 'utf8');
  await assert.rejects(f.preview.thumbnail(f.item.id), code('PREVIEW_NOT_FOUND'));
  assert.deepEqual(await fs.readdir(f.directory), ['article.html']);
  assert.equal(await fs.readFile(f.operations.libraryPath, 'utf8'), library);
});

test('thumbnail rejects a non-PNG, oversized primary, directory or junction instead of taking a fallback', async t => {
  const f = await fixture(t); await f.put('article.png');
  const desktop = await f.put('article-desktop.png', 'not PNG');
  await assert.rejects(f.preview.thumbnail(f.item.id), code('INVALID_PREVIEW_IMAGE'));
  await f.sparse('article-desktop.png', PREVIEW_LIMITS.resourceBytes + 1);
  await assert.rejects(f.preview.thumbnail(f.item.id), code('PREVIEW_RESOURCE_TOO_LARGE'));
  await fs.unlink(desktop); await fs.mkdir(desktop);
  await assert.rejects(f.preview.thumbnail(f.item.id), code('INVALID_PREVIEW_FILE'));
  await fs.rmdir(desktop);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  if (await junction(t, outside, desktop)) await assert.rejects(f.preview.thumbnail(f.item.id), code('UNSAFE_PREVIEW_PATH'));
});
