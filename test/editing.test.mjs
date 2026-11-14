import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createOperations, LIMITS } from '../lib/core.js';
import { createHttpHandler, createTool } from '../lib/host.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const errorCode = (code, status) => error => error.code === code && (status === undefined || error.status === status);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-edit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const file = path.join(project, 'work.html');
  const original = '\uFEFF  <!doctype html>\r\n<html><h1>原有标题</h1></html>\r\n  ';
  await fs.writeFile(file, original);
  const options = { dshHome: path.join(root, 'home') };
  const ops = createOperations(options);
  const { item } = await ops.operation('add', { path: file, title: '作品', module: 'web', note: '保留正文' });
  return { root, project, file, original, options, ops, item };
}
async function link(t, target, destination, directory = false) {
  try { await fs.symlink(target, destination, directory && process.platform === 'win32' ? 'junction' : directory ? 'dir' : 'file'); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic(`Link case not available: ${error.code}`); return false; }
    throw error;
  }
}
async function server(t, ops) {
  let origin;
  const instance = http.createServer(createHttpHandler(ops, { requestRejection: () => undefined }, () => origin));
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${instance.address().port}`;
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return async input => {
    const response = await fetch(`${origin}/huashu-design/api/action`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
}

test('HTML complete UTF-8 read/save preserves whitespace and produces a unique original backup', async t => {
  const { ops, file, project, original, item } = await fixture(t);
  assert.equal(item.editable, true);
  assert.equal(item.sourcePath, await fs.realpath(file));
  assert.equal(item.projectDir, await fs.realpath(project));
  const read = await ops.operation('source', { id: item.id });
  assert.equal(read.content, original);
  assert.equal(read.revision, hash(Buffer.from(original)));
  assert.equal(read.path, item.sourcePath);
  const content = '  <html><h1>新的标题</h1></html>\n\n ';
  const saved = await ops.operation('source', { id: item.id, revision: read.revision, content });
  assert.equal(await fs.readFile(file, 'utf8'), content);
  assert.equal(await fs.readFile(saved.backupPath, 'utf8'), original);
  assert.equal(path.dirname(saved.backupPath), project);
  assert.match(path.basename(saved.backupPath), /^work\.html\.[0-9]+-[\w-]+\.huashu\.bak$/);
  assert.equal(saved.revision, hash(content));
  assert.equal(saved.saved, true);
  assert.equal(saved.item.id, item.id);
  assert.equal(saved.item.createdAt, item.createdAt);
  const second = await ops.operation('source', { workId: item.id, revision: saved.revision, content: '' });
  assert.notEqual(second.backupPath, saved.backupPath);
  assert.equal(await fs.readFile(second.backupPath, 'utf8'), content);
  assert.equal(await fs.readFile(saved.backupPath, 'utf8'), original);
  assert.equal(await fs.readFile(file, 'utf8'), '');
  assert.equal((await ops.operation('list')).total, 1);
  assert.deepEqual((await fs.readdir(project)).filter(name => name.endsWith('.tmp')), []);
});

test('missing or stale revision preserves both proposed edit and current disk; no stale backup is made', async t => {
  const { ops, file, project, item } = await fixture(t);
  const read = await ops.operation('source', { id: item.id });
  const proposed = 'my unsaved edit';
  await assert.rejects(ops.operation('source', { id: item.id, content: proposed }), errorCode('REVISION_REQUIRED', 409));
  await fs.writeFile(file, 'changed externally');
  await assert.rejects(ops.operation('source', { id: item.id, revision: read.revision, content: proposed }), errorCode('REVISION_CONFLICT', 409));
  assert.equal(proposed, 'my unsaved edit');
  assert.equal(await fs.readFile(file, 'utf8'), 'changed externally');
  assert.deepEqual(await fs.readdir(project), ['work.html']);
});

test('parallel saves through different operations and export ids share a canonical source lock', async t => {
  const { ops, options, root, file, item } = await fixture(t);
  const exported = path.join(root, 'export.png'); await fs.writeFile(exported, Buffer.from([137, 80, 78, 71]));
  const second = await ops.operation('add', { path: exported, sourcePath: file, title: '导出图' });
  const other = createOperations(options);
  const { revision } = await ops.operation('source', { id: item.id });
  const results = await Promise.allSettled([
    ops.operation('source', { id: item.id, revision, content: 'first edit' }),
    other.operation('source', { id: second.item.id, revision, content: 'second edit' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT');
  assert.equal(rejected.reason.status, 409);
  assert.equal(await fs.readFile(file, 'utf8'), 'first edit');
});

test('exports require an explicit source association; same-path upsert retains it and its canonical project', async t => {
  const { ops, root, file, project } = await fixture(t);
  for (const extension of ['png', 'pdf', 'mp4']) {
    const exported = path.join(root, `output.${extension}`); await fs.writeFile(exported, 'export bytes');
    const added = await ops.operation('add', { title: extension, path: exported });
    assert.equal(added.item.editable, false);
    assert.equal(added.item.sourcePath, null);
    await assert.rejects(ops.operation('source', { id: added.item.id }), errorCode('NO_EDITABLE_SOURCE', 415));
    await assert.rejects(ops.operation('edit', { id: added.item.id }), errorCode('NO_EDITABLE_SOURCE', 415));
    const linked = await ops.operation('add', { title: extension, path: exported, sourcePath: file });
    assert.equal(linked.item.id, added.item.id);
    assert.equal(linked.item.sourcePath, await fs.realpath(file));
    assert.equal(linked.item.projectDir, await fs.realpath(project));
    const retained = await ops.operation('add', { title: 'renamed', path: exported });
    assert.equal(retained.item.sourcePath, linked.item.sourcePath);
    assert.equal((await ops.operation('source', { id: retained.item.id })).path, linked.item.sourcePath);
    assert.equal(await fs.readFile(exported, 'utf8'), 'export bytes');
  }
});

test('edit produces an unsent existing-project change draft with actual source identity and same-registration update', async t => {
  const { ops, file, project, original, item } = await fixture(t);
  const result = await ops.operation('edit', { workId: item.id, brief: '只把标题改成蓝色' });
  assert.equal(result.workId, item.id);
  assert.equal(result.task, 'web');
  assert.equal(result.style, null);
  assert.equal(result.sourcePath, await fs.realpath(file));
  assert.equal(result.projectDir, await fs.realpath(project));
  assert.ok(result.draft.includes(file));
  assert.ok(result.draft.includes(project));
  assert.ok(result.draft.includes(hash(original)), 'draft must reflect the bytes actually read');
  assert.match(result.draft, /读取上述实际源码/);
  assert.match(result.draft, /只把标题改成蓝色/);
  assert.match(result.draft, /保留未被本次需求明确要求变更的内容、视觉方向和功能/);
  assert.match(result.draft, /不另建作品/);
  assert.match(result.draft, /更新同一条登记/);
  assert.doesNotMatch(result.draft, /三个|三方向|制作 HTML 网页/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal((await ops.operation('list')).total, 1);
});

test('an explicit missing source never falls back to an editable export or another file', async t => {
  const { ops, root, file, item, original } = await fixture(t);
  const sourcePath = path.join(root, 'source.html'); await fs.writeFile(sourcePath, 'actual associated source');
  await ops.operation('add', { path: file, title: '作品', sourcePath });
  await fs.unlink(sourcePath);
  for (const action of ['source', 'edit']) await assert.rejects(ops.operation(action, { id: item.id }), error => error.code === 'SOURCE_NOT_FOUND' && error.status === 404 && error.message.includes(sourcePath));
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('source cannot redirect by path/sourcePath, conflicting ids, missing id or unknown registration', async t => {
  const { ops, root, item, file, original } = await fixture(t);
  const outside = path.join(root, 'outside.txt'); await fs.writeFile(outside, 'private');
  const read = await ops.operation('source', { id: item.id });
  await assert.rejects(ops.operation('source', { path: outside }), errorCode('INVALID_ARGUMENT'));
  await assert.rejects(ops.operation('source', { id: item.id, path: outside }), errorCode('INVALID_ARGUMENT'));
  await assert.rejects(ops.operation('source', { id: item.id, sourcePath: outside, revision: read.revision, content: 'overwritten' }), errorCode('SOURCE_MISMATCH', 403));
  await assert.rejects(ops.operation('source', { id: item.id, sourcePath: `${file}/../outside.txt` }), errorCode('SOURCE_MISMATCH', 403));
  await assert.rejects(ops.operation('source', { id: item.id, workId: 'other' }), errorCode('INVALID_ARGUMENT'));
  await assert.rejects(ops.operation('source', { id: 'missing' }), errorCode('UNKNOWN_WORK', 404));
  assert.equal(await fs.readFile(outside, 'utf8'), 'private');
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('registration and reads reject symlink sources; a replaced file never exposes its target', async t => {
  const { ops, root, item, file } = await fixture(t);
  const outside = path.join(root, 'private.txt'); await fs.writeFile(outside, 'private');
  const alias = path.join(root, 'alias.txt');
  if (await link(t, outside, alias)) await assert.rejects(ops.operation('add', { path: file, title: 'linked', sourcePath: alias }), errorCode('UNSAFE_PATH', 403));
  await fs.unlink(file);
  if (!await link(t, outside, file)) return;
  for (const action of ['source', 'edit']) await assert.rejects(ops.operation(action, { id: item.id }), errorCode('UNSAFE_PATH', 403));
  assert.equal(await fs.readFile(outside, 'utf8'), 'private');
});

test('replacing an ancestor by a junction between read and save cannot redirect writes or backups', async t => {
  const { ops, root, project, file, item } = await fixture(t);
  const read = await ops.operation('source', { id: item.id });
  const external = path.join(root, 'external'); await fs.mkdir(external);
  const target = path.join(external, path.basename(file)); await fs.writeFile(target, 'external secret');
  const originalParent = path.join(root, 'original-parent');
  await fs.rename(project, originalParent);
  if (!await link(t, external, project, true)) return;
  await assert.rejects(ops.operation('source', { id: item.id, revision: read.revision, content: 'redirected' }), errorCode('UNSAFE_PATH', 403));
  await assert.rejects(ops.operation('edit', { id: item.id }), errorCode('UNSAFE_PATH', 403));
  assert.equal(await fs.readFile(target, 'utf8'), 'external secret');
  assert.deepEqual(await fs.readdir(external), ['work.html']);
});

test('an external disk change during backup persistence is caught by the final revision comparison', async t => {
  const { ops, file, original, item, project } = await fixture(t);
  const { revision } = await ops.operation('source', { id: item.id });
  const probe = await fs.open(file, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  let injected = false;
  t.mock.method(prototype, 'sync', async function () {
    await originalSync.call(this);
    if (!injected) { injected = true; await fs.writeFile(file, 'external concurrent change'); }
  });
  await assert.rejects(ops.operation('source', { id: item.id, revision, content: 'my proposed edit' }), errorCode('REVISION_CONFLICT', 409));
  assert.equal(injected, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'external concurrent change');
  const backups = (await fs.readdir(project)).filter(name => name.endsWith('.huashu.bak'));
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(project, backups[0]), 'utf8'), original);
  assert.deepEqual((await fs.readdir(project)).filter(name => name.endsWith('.tmp')), []);
});

test('a parent junction swapped during save is rejected after backup and never redirects the source write', async t => {
  const { ops, root, project, file, original, item } = await fixture(t);
  const { revision } = await ops.operation('source', { id: item.id });
  const external = path.join(root, 'external-during-save'); await fs.mkdir(external);
  const target = path.join(external, 'work.html'); await fs.writeFile(target, 'external file');
  // Prove junction support before triggering the mid-operation replacement.
  const check = path.join(root, 'junction-capability');
  if (!await link(t, external, check, true)) return;
  await fs.unlink(check);
  const moved = path.join(root, 'moved-during-save');
  const probe = await fs.open(file, 'r'); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const originalSync = prototype.sync;
  let replaced = false;
  t.mock.method(prototype, 'sync', async function () {
    await originalSync.call(this);
    if (!replaced) {
      replaced = true;
      // Windows pins the containing directory while this backup handle is
      // open. Inject immediately after close, before the policy re-check.
      const originalClose = this.close.bind(this);
      this.close = async () => {
        await originalClose();
        await fs.rename(project, moved);
        await fs.symlink(external, project, process.platform === 'win32' ? 'junction' : 'dir');
      };
    }
  });
  await assert.rejects(ops.operation('source', { id: item.id, revision, content: 'must not escape' }), errorCode('UNSAFE_PATH', 403));
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'external file');
  assert.equal(await fs.readFile(path.join(moved, 'work.html'), 'utf8'), original);
  assert.deepEqual(await fs.readdir(external), ['work.html']);
});

test('failure to persist a backup prevents any change to the original source', async t => {
  const { ops, file, original, item } = await fixture(t);
  const { revision } = await ops.operation('source', { id: item.id });
  const probe = await fs.open(file, 'r'); const prototype = Object.getPrototypeOf(probe); await probe.close();
  t.mock.method(prototype, 'sync', async function () { const error = new Error('simulated backup persistence failure'); error.code = 'EIO'; throw error; });
  await assert.rejects(ops.operation('source', { id: item.id, revision, content: 'must not save' }), error => error.code === 'EIO');
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('library damage during a save is not overwritten and aborts before replacing source', async t => {
  const { ops, file, original, item } = await fixture(t);
  const { revision } = await ops.operation('source', { id: item.id });
  const probe = await fs.open(file, 'r'); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const originalSync = prototype.sync;
  let injected = false;
  t.mock.method(prototype, 'sync', async function () {
    await originalSync.call(this);
    if (!injected) { injected = true; await fs.writeFile(ops.libraryPath, '{damaged during backup'); }
  });
  await assert.rejects(ops.operation('source', { id: item.id, revision, content: 'not saved' }), errorCode('CORRUPT_LIBRARY', 409));
  assert.equal(await fs.readFile(ops.libraryPath, 'utf8'), '{damaged during backup');
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('invalid UTF-8, binary text, unsupported extensions and oversized complete source are rejected', async t => {
  const { ops, root, file, item } = await fixture(t);
  for (const bytes of [Buffer.from([255, 254, 255]), Buffer.from('abc\0def'), Buffer.from([1, 2, 3])]) {
    await fs.writeFile(file, bytes);
    await assert.rejects(ops.operation('source', { id: item.id }), errorCode('BINARY_SOURCE', 415));
  }
  await fs.writeFile(file, 'x'.repeat(LIMITS.sourceBytes + 1));
  await assert.rejects(ops.operation('source', { id: item.id }), errorCode('SOURCE_TOO_LARGE', 413));
  await fs.writeFile(file, 'valid');
  const { revision } = await ops.operation('source', { id: item.id });
  for (const content of ['x'.repeat(LIMITS.sourceBytes + 1), '中'.repeat(Math.floor(LIMITS.sourceBytes / 3) + 1)]) await assert.rejects(ops.operation('source', { id: item.id, revision, content }), errorCode('SOURCE_TOO_LARGE', 413));
  await assert.rejects(ops.operation('source', { id: item.id, revision, content: 'nul\0text' }), errorCode('BINARY_SOURCE', 415));
  await assert.rejects(ops.operation('source', { id: item.id, revision, content: '\ud800' }), errorCode('INVALID_ARGUMENT'));
  const unsupported = path.join(root, 'unsafe.exe'); await fs.writeFile(unsupported, 'text');
  await assert.rejects(ops.operation('add', { path: file, sourcePath: unsupported, title: 'unsupported' }), errorCode('UNSUPPORTED_SOURCE', 415));
  await assert.rejects(ops.operation('add', { path: file, sourcePath: 'relative.html', title: 'relative' }), errorCode('INVALID_FILE'));
  await assert.rejects(ops.operation('add', { path: file, sourcePath: path.join(root, 'missing.html'), title: 'missing' }), errorCode('SOURCE_NOT_FOUND', 404));
  assert.equal(await fs.readFile(file, 'utf8'), 'valid');
});

test('supported editable source formats are data and are never automatically executed', async t => {
  const { ops, root, file } = await fixture(t);
  const marker = path.join(root, 'executed');
  for (const extension of ['html', 'htm', 'svg', 'md', 'css', 'js', 'mjs', 'json', 'txt']) {
    const sourcePath = path.join(root, `source.${extension}`);
    const content = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');`;
    await fs.writeFile(sourcePath, content);
    const { item } = await ops.operation('add', { path: file, sourcePath, title: extension });
    const read = await ops.operation('source', { id: item.id });
    assert.equal(read.content, content);
    await ops.operation('source', { id: item.id, revision: read.revision, content: `${content}\n` });
    await ops.operation('edit', { id: item.id });
  }
  await assert.rejects(fs.stat(marker), error => error.code === 'ENOENT');
});

test('HTML, HTM and SVG bodies are discoverable as default editable sources without an explicit link', async t => {
  const { ops, root } = await fixture(t);
  for (const extension of ['html', 'htm', 'svg']) {
    const file = path.join(root, `default.${extension}`); await fs.writeFile(file, '<body>editable</body>');
    const { item } = await ops.operation('add', { path: file, title: extension });
    assert.equal(item.editable, true);
    assert.equal(item.sourcePath, await fs.realpath(file));
    assert.equal(item.projectDir, await fs.realpath(root));
    assert.equal((await ops.operation('source', { id: item.id })).content, '<body>editable</body>');
  }
});

test('old records remain readable and damaged source metadata never overwrites index or source', async t => {
  const { ops, item, original, file } = await fixture(t);
  const raw = JSON.parse(await fs.readFile(ops.libraryPath, 'utf8'));
  delete raw.items[0].sourcePath;
  await fs.writeFile(ops.libraryPath, JSON.stringify(raw));
  assert.equal((await ops.operation('source', { id: item.id })).content, original);
  assert.equal((await ops.operation('list')).items[0].editable, true);
  const { revision } = await ops.operation('source', { id: item.id });
  for (const bad of ['broken JSON', JSON.stringify({ ...raw, items: [{ ...raw.items[0], sourcePath: 'relative.txt' }] })]) {
    await fs.writeFile(ops.libraryPath, bad);
    await assert.rejects(ops.operation('source', { id: item.id, revision, content: 'not written' }), errorCode('CORRUPT_LIBRARY', 409));
    assert.equal(await fs.readFile(ops.libraryPath, 'utf8'), bad);
    assert.equal(await fs.readFile(file, 'utf8'), original);
  }
});

test('an explicit revised style is reflected in the change instructions and same-path registration', async t => {
  const { ops, item } = await fixture(t);
  const style = 'web-03-memphis-maximalism';
  const result = await ops.operation('edit', { id: item.id, style, brief: '更换视觉参考，保留内容' });
  assert.equal(result.style, style);
  assert.ok(result.draft.includes('明确选择新的视觉参考：'+style));
  assert.ok(result.draft.includes('"style":"'+style+'"'));
  assert.ok(result.draft.includes(item.path));
  await assert.rejects(ops.operation('edit', { id:item.id,style:'missing-style' }), errorCode('UNKNOWN_STYLE'));
});

test('large projects stay associated and can be revised without entering the bounded source editor', async t => {
  const { ops, root, file } = await fixture(t);
  const sourcePath = path.join(root, 'large-project.html');
  await fs.writeFile(sourcePath, '<html>' + 'x'.repeat(LIMITS.sourceBytes + 1) + '</html>');
  const { item } = await ops.operation('add', { path: file, sourcePath, title: 'Large source', module: 'web' });
  assert.equal(item.editable, true);
  await assert.rejects(ops.operation('source', { id: item.id }), errorCode('SOURCE_TOO_LARGE', 413));
  const change = await ops.operation('edit', { id: item.id, brief: '调整标题' });
  assert.equal(change.sourcePath, await fs.realpath(sourcePath));
  assert.match(change.draft, /直接读取工程文件修改/);
  assert.ok(!change.draft.includes('SHA-256：null'));
});

test('maximum-sized escaped source can be saved through the actual HTTP envelope', async t => {
  const { ops, item, file } = await fixture(t);
  const request = await server(t, ops);
  const read = await ops.operation('source', { id: item.id });
  const content = '"'.repeat(LIMITS.sourceBytes);
  const result = await request({ action: 'source', args: { id: item.id, revision: read.revision, content } });
  assert.equal(result.status, 200);
  assert.equal(await fs.readFile(file, 'utf8'), content);
});

test('tool and HTTP share source/edit contract, including save above old 64KiB body bound', async t => {
  const { ops, item, file } = await fixture(t);
  const request = await server(t, ops);
  const tool = createTool(ops);
  const input = { action: 'source', args: { id: item.id } };
  const read = await tool.execute(input);
  const httpRead = await request(input);
  assert.equal(httpRead.status, 200);
  assert.deepEqual(httpRead.body, read);
  const editInput = { action: 'edit', args: { id: item.id, brief: '改标题' } };
  assert.deepEqual((await request(editInput)).body, await tool.execute(editInput));
  const content = 'x'.repeat(80 * 1024);
  const saved = await request({ action: 'source', args: { id: item.id, revision: read.revision, content } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, hash(content));
  assert.equal(await fs.readFile(file, 'utf8'), content);
  assert.ok(saved.body.backupPath);
  const conflict = await request({ action: 'source', args: { id: item.id, revision: read.revision, content: 'stale' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'REVISION_CONFLICT');
  const schema = tool.parameters.properties.args.properties;
  assert.equal(schema.content.maxLength, LIMITS.sourceBytes);
  assert.equal(schema.revision.maxLength, 64);
  assert.ok(tool.parameters.properties.action.enum.includes('edit'));
  assert.ok(tool.parameters.properties.action.enum.includes('source'));
  assert.ok((await ops.operation('catalog', { section: 'manifest' })).manifest.actions.includes('source'));
  const skill = await ops.skillDefinition();
  assert.match(skill.content, /sourcePath/);
  assert.match(skill.content, /action=`edit`/);
});
