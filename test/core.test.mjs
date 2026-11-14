import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createOperations, safeResource, LIMITS, splitSkill } from '../lib/core.js';
import { createHttpHandler, createSkillProvider, createTool, apply, inject } from '../lib/host.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-host-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const upstreamRoot = path.join(root, 'upstream');
  await fs.mkdir(path.join(upstreamRoot, 'references'), { recursive: true });
  await fs.mkdir(path.join(upstreamRoot, 'assets/style-specimens/web'), { recursive: true });
  const skill = '---\r\nname: huashu-design\r\ndescription: "设计资源"\r\nmetadata:\r\n  version: "3.3.0"\r\n---\r\n# Original skill\r\nDo not alter this body.\r\n';
  await fs.writeFile(path.join(upstreamRoot, 'SKILL.md'), skill);
  await fs.writeFile(path.join(upstreamRoot, 'references/design-styles.md'), '**编辑粗野 Editorial Brutalism** `大胆·还原98%`\n- 适配:媒体与品牌\n- 样张:assets/style-specimens/web/01-editorial.jpg\n\n**安静留白 Quiet White**\n- 适配:阅读\n- 样张:assets/style-specimens/web/02-quiet.jpg\n');
  await fs.writeFile(path.join(upstreamRoot, 'references/guide.md'), 'abcdefghij'.repeat(2500));
  await fs.writeFile(path.join(upstreamRoot, 'assets/style-specimens/web/01-editorial.jpg'), Buffer.from([255,216,255,217]));
  await fs.writeFile(path.join(upstreamRoot, 'assets/style-specimens/web/02-quiet.jpg'), Buffer.from([255,216,255,217]));
  await fs.writeFile(path.join(upstreamRoot, 'assets/unsafe.html'), '<script>fetch("/api")</script>');
  await fs.writeFile(path.join(upstreamRoot, 'assets/unsafe.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const work = path.join(root, '交付.html');
  await fs.writeFile(work, '<script>fetch("/api")</script>');
  const options = { upstreamRoot, dshHome: path.join(root, 'home') };
  return { root, upstreamRoot, work, skill, options, ops: createOperations(options) };
}
const code = expected => error => error.code === expected;
async function link(t, target, destination, type = 'file') {
  try { await fs.symlink(target, destination, process.platform === 'win32' && type === 'dir' ? 'junction' : type); return true; }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic(`Symlink creation unavailable (${error.code}); this link case was not exercised.`); return false; } throw error; }
}
async function server(t, ops, rejectRequest = () => undefined) {
  let origin;
  const service = { requestRejection: rejectRequest };
  const instance = http.createServer(createHttpHandler(ops, service, () => origin));
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${instance.address().port}`;
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  const request = (target, options = {}) => new Promise((resolve, reject) => {
    const headers = Object.fromEntries(Object.entries({ ...(options.body === undefined ? {} : { 'content-type': 'application/json', origin }), ...options.headers }).filter(([, value]) => value !== undefined));
    const req = http.request(origin, { path: target, method: options.method || 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(body); } catch {} resolve({ status: res.statusCode, headers: res.headers, body, json }); });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
  return { origin, request };
}

test('catalog extracts upstream styles, bilingual tasks and workflows; tool pages discovery', async t => {
  const { ops } = await fixture(t);
  const catalog = await ops.operation('catalog');
  assert.deepEqual(catalog.tasks.map(item => item.id), ['web', 'deck', 'infographic', 'app', 'motion', 'critique', 'xiaohongshu']);
  assert.ok(catalog.tasks.every(item => item.title && item.titleEn && item.description && item.descriptionEn && item.prompt));
  assert.ok(catalog.workflows.every(item => item.titleEn && item.descriptionEn));
  assert.equal(catalog.manifest.version, '3.3.0');
  assert.equal(catalog.styles.length, 2);
  assert.equal(catalog.styles[0].id, 'web-01-editorial');
  assert.equal(catalog.styles[0].specimenUrl, '/huashu-design/assets/assets/style-specimens/web/01-editorial.jpg');
  const result = await createTool(ops).execute({ action: 'catalog', args: { limit: 1 } });
  assert.equal(result.items.length, 1); assert.equal(result.nextOffset, 1); assert.equal(result.total, 2);
  assert.equal((await ops.operation('catalog', { section: 'tasks', offset: 5 })).items[0].id, 'critique');
});

test('resources reject lexical traversal, absolute paths, backslashes and unsupported file types', async t => {
  const { ops, upstreamRoot, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'secret.md'), 'secret');
  for (const value of ['../secret.md', 'references/../../secret.md', '/secret.md', 'C:/secret.md', 'references\\guide.md', 'references/./guide.md', '%2e%2e/secret.md', 'references//guide.md']) {
    await assert.rejects(ops.operation('read', { path: value }), code('UNSAFE_PATH'));
  }
  await assert.rejects(safeResource(upstreamRoot, 'references'), code('INVALID_FILE'));
  await assert.rejects(ops.operation('read', { path: 'assets/unsafe.html' }), code('UNSUPPORTED_RESOURCE'));
  await assert.rejects(ops.assetFile('SKILL.md'), code('UNSUPPORTED_RESOURCE'));
  assert.equal((await ops.operation('read', { path: 'references/guide.md', offset: 3, limit: 5 })).content, 'defgh');
  const bounded = await ops.operation('read', { path: 'references/guide.md' });
  assert.equal(bounded.content.length, 8000); assert.equal(bounded.nextOffset, 8000); assert.equal(bounded.truncated, true);
  await assert.rejects(ops.operation('read', { path: 'references/guide.md', limit: LIMITS.read + 1 }), code('INVALID_ARGUMENT'));
});

test('resources block internal symlinks, external file links and external directory junctions', async t => {
  const { ops, upstreamRoot, root } = await fixture(t);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
  if (await link(t, outside, path.join(upstreamRoot, 'escape'), 'dir')) await assert.rejects(ops.operation('read', { path: 'escape/secret.md' }), code('UNSAFE_PATH'));
  if (await link(t, path.join(outside, 'secret.md'), path.join(upstreamRoot, 'external.md'))) await assert.rejects(ops.operation('read', { path: 'external.md' }), code('UNSAFE_PATH'));
  if (await link(t, path.join(upstreamRoot, 'SKILL.md'), path.join(upstreamRoot, 'internal.md'))) await assert.rejects(ops.operation('read', { path: 'internal.md' }), code('UNSAFE_PATH'));
  if (await link(t, path.join(upstreamRoot, 'references'), path.join(upstreamRoot, 'internal-dir'), 'dir')) await assert.rejects(ops.operation('read', { path: 'internal-dir/guide.md' }), code('UNSAFE_PATH'));
});

test('library validates absolute existing regular deliverables and unknown task/style', async t => {
  const { ops, work, root } = await fixture(t);
  await assert.rejects(ops.operation('add', { title: 'Relative', path: 'relative.html' }), code('INVALID_FILE'));
  await assert.rejects(ops.operation('add', { title: 'Directory', path: root }), code('INVALID_FILE'));
  await assert.rejects(ops.operation('add', { title: 'Missing', path: path.join(root, 'missing.html') }), code('NOT_FOUND'));
  const executable = path.join(root, 'source.js'); await fs.writeFile(executable, 'source');
  await assert.rejects(ops.operation('add', { title: 'Source', path: executable }), code('UNSUPPORTED_FILE'));
  await assert.rejects(ops.operation('add', { title: 'Bad module', path: work, module: 'invalid' }), code('UNKNOWN_TASK'));
  await assert.rejects(ops.operation('add', { title: 'Bad style', path: work, style: 'invalid' }), code('UNKNOWN_STYLE'));
});

test('same canonical path upserts and concurrent operations from separate service instances do not lose writes', async t => {
  const { ops, options, root, work } = await fixture(t);
  const first = await ops.operation('add', { title: 'First', path: work, module: 'web', style: 'web-01-editorial', note: 'first note' });
  const second = await ops.operation('add', { title: 'Updated', path: work, module: 'deck', note: 'second note' });
  assert.equal(first.item.id, second.item.id); assert.equal(second.updated, true);
  assert.equal(first.item.createdAt, second.item.createdAt);
  assert.equal((await ops.operation('list')).total, 1);
  const other = createOperations(options);
  await Promise.all(Array.from({ length: 24 }, async (_, index) => {
    const file = path.join(root, `${index}.pdf`); await fs.writeFile(file, '%PDF');
    return (index % 2 ? ops : other).operation('add', { title: `Work ${index}`, path: file });
  }));
  const listing = await ops.operation('list', { limit: 100 });
  assert.equal(listing.total, 25); assert.equal(new Set(listing.items.map(item => item.id)).size, 25);
  assert.equal((await ops.operation('list', { offset: 24, limit: 1 })).nextOffset, null);
  const data = JSON.parse(await fs.readFile(ops.libraryPath, 'utf8'));
  assert.equal(data.items.length, 25);
  assert.deepEqual((await fs.readdir(path.dirname(ops.libraryPath))).filter(name => name.endsWith('.tmp')), []);
});

test('canonical symlink aliases upsert the same file; removing registration preserves source', async t => {
  const { ops, root, work } = await fixture(t);
  const original = await ops.operation('add', { title: 'Original', path: work });
  const actualDir = path.join(root, 'actual-dir'); await fs.mkdir(actualDir);
  const nested = path.join(actualDir, 'work.pdf'); await fs.writeFile(nested, '%PDF');
  const nestedEntry = await ops.operation('add', { title: 'Nested', path: nested });
  const aliasDir = path.join(root, 'alias-dir');
  if (await link(t, actualDir, aliasDir, 'dir')) {
    const viaJunction = await ops.operation('add', { title: 'Via junction', path: path.join(aliasDir, 'work.pdf') });
    assert.equal(viaJunction.item.id, nestedEntry.item.id); assert.equal(viaJunction.item.path, await fs.realpath(nested));
  }
  const alias = path.join(root, 'alias.html');
  if (await link(t, work, alias)) {
    const updated = await ops.operation('add', { title: 'Alias', path: alias });
    assert.equal(updated.item.id, original.item.id); assert.equal(updated.item.path, await fs.realpath(work));
  }
  assert.deepEqual(await ops.operation('remove', { id: original.item.id }), { id: original.item.id, removed: true });
  assert.ok((await fs.stat(work)).isFile());
  assert.equal((await ops.operation('remove', { id: original.item.id })).removed, false);
});

test('damaged JSON and invalid index structures block writes without overwriting bytes', async t => {
  const { ops, work } = await fixture(t);
  await fs.mkdir(path.dirname(ops.libraryPath), { recursive: true });
  for (const damaged of ['{broken', '{"version":2,"items":[]}', '{"version":1,"items":[{"id":"x"}]}']) {
    await fs.writeFile(ops.libraryPath, damaged);
    await assert.rejects(ops.operation('add', { title: 'Never overwrite', path: work }), code('CORRUPT_LIBRARY'));
    await assert.rejects(ops.operation('remove', { id: 'x' }), code('CORRUPT_LIBRARY'));
    assert.equal(await fs.readFile(ops.libraryPath, 'utf8'), damaged);
  }
  await fs.writeFile(ops.libraryPath, '{"version":1,"items":[]}');
  assert.equal((await ops.operation('add', { title: 'Recovered externally', path: work })).item.title, 'Recovered externally');
});

test('library metadata rejects directory junction redirection without touching external index', async t => {
  const { ops, work, root } = await fixture(t);
  const outside = path.join(root, 'external-index'); await fs.mkdir(outside);
  const external = path.join(outside, 'library.json'); const raw = '{"version":1,"items":[]}';
  await fs.writeFile(external, raw);
  await fs.mkdir(path.dirname(path.dirname(ops.libraryPath)), { recursive: true });
  if (!await link(t, outside, path.dirname(ops.libraryPath), 'dir')) return;
  await assert.rejects(ops.operation('list'), code('UNSAFE_PATH'));
  await assert.rejects(ops.operation('add', { title: 'Blocked', path: work }), code('UNSAFE_PATH'));
  assert.equal(await fs.readFile(external, 'utf8'), raw);
});

test('registered download blocks a replaced parent directory junction', async t => {
  const { ops, root } = await fixture(t);
  const current = path.join(root, 'current'); const external = path.join(root, 'external');
  await fs.mkdir(current); await fs.mkdir(external);
  const work = path.join(current, 'work.html'); await fs.writeFile(work, 'registered');
  await fs.writeFile(path.join(external, 'work.html'), 'external secret');
  const registered = await ops.operation('add', { title: 'Work', path: work });
  await fs.rename(current, path.join(root, 'original'));
  if (!await link(t, external, current, 'dir')) return;
  await assert.rejects(ops.workFile(registered.item.id), code('UNSAFE_PATH'));
  const { request } = await server(t, ops);
  const result = await request(registered.item.url);
  assert.equal(result.status, 403); assert.ok(!result.body.includes('external secret'));
});

test('delete removes registration, deliverable, linked source and project; keeps shared files', async t => {
  const { ops, root } = await fixture(t);
  const projectDir = path.join(root, 'project'); await fs.mkdir(projectDir);
  const file = path.join(projectDir, 'work.png'); await fs.writeFile(file, 'png');
  const source = path.join(projectDir, 'source.html'); await fs.writeFile(source, '<html></html>');
  const project = path.join(projectDir, 'work.ppdesign'); await fs.writeFile(project, 'layers');
  const { item } = await ops.operation('add', { title: 'Deletable', path: file, sourcePath: source, module: 'infographic' });
  await ops.operation('linkProject', { id: item.id, projectPath: project });
  await assert.rejects(ops.operation('delete', { id: item.id }), code('CONFIRM_REQUIRED'));
  assert.ok((await fs.stat(file)).isFile());
  const result = await ops.operation('delete', { id: item.id, confirm: true });
  assert.equal(result.deleted, true);
  assert.deepEqual(result.files.map(entry => entry.role).sort(), ['file', 'project', 'source']);
  for (const target of [file, source, project]) await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.equal((await ops.operation('list')).total, 0);
  await assert.rejects(ops.operation('delete', { id: item.id, confirm: true }), code('UNKNOWN_WORK'));
});

test('delete keeps a file that another registration still references', async t => {
  const { ops, root } = await fixture(t);
  const shared = path.join(root, 'shared.html'); await fs.writeFile(shared, '<html>shared</html>');
  const own = path.join(root, 'own.png'); await fs.writeFile(own, 'png');
  const first = await ops.operation('add', { title: 'First', path: own, sourcePath: shared });
  const second = path.join(root, 'second.html'); await fs.writeFile(second, '<html>second</html>');
  const other = await ops.operation('add', { title: 'Other', path: second, sourcePath: shared });
  const result = await ops.operation('delete', { id: first.item.id, confirm: true });
  assert.deepEqual(result.files.map(entry => entry.role), ['file']);
  assert.deepEqual(result.skipped.map(entry => entry.role), ['source']);
  assert.ok((await fs.stat(shared)).isFile(), 'a shared source must survive deleting one work');
  assert.ok((await fs.stat(second)).isFile());
  assert.equal((await ops.operation('list')).items[0].id, other.item.id);
  await assert.rejects(fs.stat(own), { code: 'ENOENT' });
});

test('delete never unlinks through a symlinked target', async t => {
  const { ops, root, work } = await fixture(t);
  const outside = path.join(root, 'outside.html'); await fs.writeFile(outside, 'target');
  const linkPath = path.join(root, 'link.png');
  if (!(await link(t, outside, linkPath))) return;
  const { item } = await ops.operation('add', { title: 'Linked', path: work });
  const data = JSON.parse(await fs.readFile(ops.libraryPath, 'utf8'));
  data.items[0].path = linkPath; await fs.writeFile(ops.libraryPath, JSON.stringify(data));
  await assert.rejects(ops.operation('delete', { id: item.id, confirm: true }), code('DELETE_FAILED'));
  assert.ok((await fs.stat(outside)).isFile(), 'the symlink target must never be deleted');
  assert.equal((await ops.operation('list')).total, 1);
});

test('delete reports an already missing file as skipped and still unregisters', async t => {
  const { ops, root } = await fixture(t);
  const file = path.join(root, 'gone.png'); await fs.writeFile(file, 'png');
  const { item } = await ops.operation('add', { title: 'Gone', path: file });
  await fs.unlink(file);
  const result = await ops.operation('delete', { id: item.id, confirm: true });
  assert.deepEqual(result.skipped.map(entry => entry.reason), ['Already missing.']);
  assert.equal((await ops.operation('list')).total, 0);
});

test('catalog manifest advertises the delete action', async t => {
  const { ops } = await fixture(t);
  assert.ok((await ops.operation('catalog', { section: 'manifest' })).manifest.actions.includes('delete'));
  const tool = createTool(ops);
  assert.ok(tool.parameters.properties.action.enum.includes('delete'));
  assert.equal(tool.parameters.properties.args.properties.confirm.type, 'boolean');
  await assert.rejects(tool.execute({ action: 'delete', args: { id: 'x' } }), code('CONFIRM_REQUIRED'));
});

test('catalog returns a compact snapshot manifest without file hash inventory', async t => {
  const { ops, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'upstream-manifest.json'), JSON.stringify({ source: { repository: 'https://github.com/example/design', commit: 'abc123', version: '3.3.0' }, file_count: 445, license: { spdx: 'MIT', exceptions: [{ path: 'stickers', license: 'PolyForm-Shield-1.0.0' }] }, files: ['large hash inventory'] }));
  const { manifest } = await ops.operation('catalog', { section: 'manifest' });
  assert.equal(manifest.source.commit, 'abc123'); assert.equal(manifest.license.spdx, 'MIT'); assert.equal(manifest.fileCount, 445);
  assert.equal(manifest.license.exceptions[0].license, 'PolyForm-Shield-1.0.0');
  assert.equal(manifest.files, undefined);
});

test('draft validates all IDs and returns text without invoking chat or changing library', async t => {
  const { ops, work } = await fixture(t);
  for (const [args, error] of [[{ task: 'no' }, 'UNKNOWN_TASK'], [{ style: 'no' }, 'UNKNOWN_STYLE'], [{ workflow: 'no' }, 'UNKNOWN_WORKFLOW'], [{ workId: 'no' }, 'UNKNOWN_WORK']]) await assert.rejects(ops.operation('draft', args), code(error));
  const added = await ops.operation('add', { title: 'Reference', path: work, note: 'large type' });
  const result = await ops.operation('draft', { task: 'web', style: 'web-01-editorial', workflow: 'same-style', workId: added.item.id, brief: '鸟类观察工具' });
  assert.match(result.draft, /鸟类观察工具/); assert.match(result.draft, /三个/); assert.ok(result.draft.includes(work));
  assert.equal((await ops.operation('list')).total, 1);
  await assert.rejects(ops.operation('constructor'), code('UNKNOWN_ACTION'));
  await assert.rejects(ops.operation('list', []), code('INVALID_ARGUMENT'));
});

test('skill provider keeps the upstream body and resource root, with lower priority than filesystem', async t => {
  const { ops, skill, upstreamRoot } = await fixture(t);
  const provider = createSkillProvider(ops);
  const [candidate] = await provider.list();
  assert.equal(candidate.name, 'huashu-design'); assert.equal(candidate.rank, 600);
  assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: await fs.realpath(upstreamRoot) });
  const definition = await provider.get(candidate);
  assert.ok(definition.content.startsWith(splitSkill(skill).body)); assert.ok(definition.content.includes('huashu_design'));
  assert.equal(await provider.get({ ...candidate, locator: 'wrong' }), undefined);
  assert.equal(await fs.readFile(path.join(upstreamRoot, 'SKILL.md'), 'utf8'), skill);
});

test('HTTP authenticates every route and method before reading metadata or assets', async t => {
  const { ops } = await fixture(t);
  const seen = [];
  const { request } = await server(t, ops, req => { seen.push(req.url); return req.headers.authorization === 'ok' ? undefined : req.headers.authorization === 'forbidden' ? 403 : 401; });
  for (const target of ['/huashu-design/api/catalog', '/huashu-design/assets/assets/style-specimens/web/01-editorial.jpg', '/huashu-design/works/a/entry', '/huashu-design/unknown']) assert.equal((await request(target)).status, 401);
  assert.equal((await request('/huashu-design/api/action', { method: 'POST', body: { action: 'list' } })).status, 401);
  assert.equal((await request('/huashu-design/api/catalog', { method: 'HEAD' })).status, 401);
  assert.equal((await request('/huashu-design/api/catalog', { headers: { authorization: 'forbidden' } })).status, 403);
  assert.equal((await request('/huashu-design/api/catalog', { headers: { authorization: 'ok' } })).status, 200);
  assert.equal(seen.length, 8);
});

test('HTTP POST enforces same origin, JSON and size limits; correct errors do not mutate', async t => {
  const { ops, work } = await fixture(t);
  const { request, origin } = await server(t, ops);
  const payload = { action: 'add', args: { title: 'HTTP Work', path: work } };
  for (const badOrigin of ['https://evil.example', `${origin}/fake`, 'null', undefined]) {
    const response = await request('/huashu-design/api/action', { method: 'POST', body: payload, headers: { origin: badOrigin } });
    assert.equal(response.status, 403);
  }
  assert.equal((await request('/huashu-design/api/action', { method: 'POST', body: payload, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/huashu-design/api/action', { method: 'POST', body: payload, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request('/huashu-design/api/action', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await request('/huashu-design/api/action', { method: 'POST', body: [] })).status, 400);
  assert.equal((await request('/huashu-design/api/action', { method: 'POST', body: ' '.repeat(LIMITS.bodyBytes + 1) })).status, 413);
  assert.equal((await request('/huashu-design/api/action', { method: 'POST', body: ' '.repeat(LIMITS.bodyBytes + 1), headers: { 'content-length': String(LIMITS.bodyBytes + 1) } })).status, 413);
  assert.equal((await ops.operation('list')).total, 0);
  const added = await request('/huashu-design/api/action', { method: 'POST', body: payload });
  assert.equal(added.status, 200); assert.equal(added.json.item.title, 'HTTP Work');
  assert.equal(added.headers['access-control-allow-origin'], undefined);
  assert.equal((await request('/huashu-design/api/action', { method: 'POST', body: { action: 'draft', args: { task: 'invalid' } } })).json.error.code, 'UNKNOWN_TASK');
});

test('HTTP static resources block traversal and scripts; registered HTML/SVG are safe attachments', async t => {
  const { ops, work, root } = await fixture(t);
  const { request } = await server(t, ops);
  const added = await ops.operation('add', { title: 'Unsafe HTML', path: work });
  const html = await request(added.item.url);
  assert.equal(html.status, 200); assert.match(html.headers['content-disposition'], /^attachment;/);
  assert.match(html.headers['content-security-policy'], /sandbox/); assert.match(html.headers['content-security-policy'], /script-src 'none'/);
  assert.equal(html.headers['x-content-type-options'], 'nosniff'); assert.equal(html.headers['referrer-policy'], 'no-referrer');
  const head = await request(added.item.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body, '');
  const range = await request(added.item.url, { headers: { range: 'bytes=0-6' } }); assert.equal(range.status, 206); assert.equal(range.body, '<script');
  assert.equal((await request(added.item.url, { headers: { range: 'bytes=999999-' } })).status, 416);
  const svg = await request('/huashu-design/assets/assets/unsafe.svg'); assert.equal(svg.status, 200); assert.match(svg.headers['content-disposition'], /^attachment;/);
  const image = await request('/huashu-design/assets/assets/style-specimens/web/01-editorial.jpg'); assert.equal(image.status, 200); assert.match(image.headers['content-type'], /^image\/jpeg/);
  for (const target of ['/huashu-design/assets/../secret.md', '/huashu-design/assets/%2e%2e/secret.md', '/huashu-design/assets/%252e%252e/secret.md', '/huashu-design/assets/references%5cguide.md']) assert.equal((await request(target)).status, 403);
  assert.equal((await request('/huashu-design/assets/assets/unsafe.html')).status, 415);
  assert.equal((await request(`${added.item.url}/../secret`)).status, 404);
  assert.equal((await request('/huashu-design/works/missing/entry')).status, 404);
  assert.equal((await request('/huashu-design/api/catalog', { method: 'HEAD' })).body, '');
  assert.equal((await request('/huashu-design/api/catalog', { method: 'PUT' })).status, 405);
  const outside = path.join(root, 'outside.html'); await fs.writeFile(outside, 'secret outside');
  await fs.unlink(work);
  if (await link(t, outside, work)) assert.equal((await request(added.item.url)).status, 403);
});

test('UI action and tool share operation results; plugin owns registrations and exposes same service', async t => {
  const { ops } = await fixture(t);
  const { request } = await server(t, ops);
  const tool = createTool(ops);
  const input = { action: 'draft', args: { task: 'infographic', brief: '三个月营收对比' } };
  const ui = await request('/huashu-design/api/action', { method: 'POST', body: input });
  assert.deepEqual(ui.json, await tool.execute(input));
  const effects = [], disposers = [], records = { services: {}, tools: {}, disposedServices: [], disposedTools: [] };
  const ctx = {
    effect(callback) { effects.push(callback); const dispose = callback(); disposers.push(dispose); },
    provide(key, value) { records.services[key] = value; return () => { records.disposedServices.push(key); }; },
    tools: { register(value) { records.tools[value.name] = value; return () => { records.disposedTools.push(value.name); }; } },
    skills: { registerProvider(factory) { records.provider = factory({ signal: new AbortController().signal, invalidate() {} }); return () => { records.skillDisposed = true; }; } },
    webServer: { register(value) { records.route = value; return () => { records.routeDisposed = true; }; }, getOrigin: () => 'http://127.0.0.1:3080' },
    connection: { requestRejection: () => undefined },
  };
  apply(ctx, { upstreamRoot: ops.upstreamRoot, dshHome: path.dirname(path.dirname(ops.libraryPath)) });
  assert.deepEqual(inject, ['webServer', 'connection', 'skills', 'tools']);
  assert.ok(disposers.every(dispose => typeof dispose === 'function'), 'all plugin resources must have an owning effect');
  assert.deepEqual(Object.keys(records.services).sort(), ['huashuDesign', 'huashuImageProviders', 'huashuPrintpress']);
  assert.deepEqual(Object.keys(records.tools).sort(), ['huashu_design', 'huashu_printpress']);
  assert.equal((await records.tools.huashu_printpress.execute({ action: 'status' })).running, false);
  assert.equal(records.route.path, '/huashu-design');
  const requestPath = '/huashu-design/api/catalog';
  assert.ok(requestPath === records.route.path || requestPath.startsWith(`${records.route.path}/`), 'registered prefix must match the real WebServer path-boundary contract');
  assert.equal(records.route.kind, 'prefix');
  assert.deepEqual(await records.tools.huashu_design.execute(input), await records.services.huashuDesign.operation(input.action, input.args));
  for (const disposer of disposers.reverse()) await disposer();
  assert.deepEqual(records.disposedTools.sort(), ['huashu_design', 'huashu_printpress']);
  assert.deepEqual(records.disposedServices.sort(), ['huashuDesign', 'huashuImageProviders', 'huashuPrintpress']);
  assert.equal(records.skillDisposed, true); assert.equal(records.routeDisposed, true);
  await assert.rejects(records.services.huashuPrintpress.start(), error => error.code === 'RUNTIME_CLOSED');
});
