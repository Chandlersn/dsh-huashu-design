import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOperations, LIMITS, splitSkill } from '../lib/core.js';

const errorCode = code => error => error.code === code;
const nativeBytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 254, 0]);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-layered-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('huashu-layered-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const upstreamRoot = path.join(root, 'upstream');
  await fs.mkdir(path.join(upstreamRoot, 'references'), { recursive: true });
  const skill = '---\nname: huashu-design\ndescription: Fixture design skill\n---\n# Original fixture skill\n';
  await fs.writeFile(path.join(upstreamRoot, 'SKILL.md'), skill);
  await fs.writeFile(path.join(upstreamRoot, 'references/design-styles.md'), '**测试风格 Fixture Style**\n- 样张:assets/style-specimens/info/01-fixture.png\n');
  const options = { upstreamRoot, dshHome: path.join(root, 'home') };
  const ops = createOperations(options);
  const put = async (name, bytes = 'fixture bytes') => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return file;
  };
  const image = await put('original.png');
  const project = await put('native/project.ppdesign', nativeBytes);
  const source = await put('source.html', '<h1>Original source</h1>');
  const designRef = { id: `design_${'a1'.repeat(12)}`, revision: 1, dataDir: path.join(root, 'native-data') };
  return { root, upstreamRoot, options, ops, put, image, project, source, designRef, skill };
}
async function link(t, target, destination, directory = false) {
  try {
    await fs.symlink(target, destination, directory && process.platform === 'win32' ? 'junction' : directory ? 'dir' : 'file');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic(`Link case unavailable: ${error.code}`); return false; }
    throw error;
  }
}
const rawIndex = ops => fs.readFile(ops.libraryPath, 'utf8');

test('explicit native association persists separately from text source and existing editable semantics', async t => {
  const { ops, options, image, project, source } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Linked work', path: image, projectPath: project, sourcePath: source, module: 'infographic', style: 'info-01-fixture', note: 'Keep text source' });
  assert.equal(item.projectPath, await fs.realpath(project));
  assert.equal(item.sourcePath, await fs.realpath(source));
  assert.equal(item.imageEditable, true);
  assert.equal(item.layeredEditable, true);
  assert.equal(item.editable, true);
  assert.equal(item.designRef, null);
  assert.equal((await ops.operation('source', { id: item.id })).content, '<h1>Original source</h1>');
  assert.deepEqual((await createOperations(options).operation('list')).items[0], item);
  assert.deepEqual(await fs.readFile(project), nativeBytes);
});

test('.ppdesign itself is a binary work, including projects larger than the text editor bound', async t => {
  const { ops, put, image } = await fixture(t);
  const bytes = Buffer.alloc(LIMITS.sourceBytes + 1, 0xff);
  const project = await put('large.PPDESIGN', bytes);
  const { item } = await ops.operation('add', { title: 'Native only', path: project });
  assert.equal(item.mime, 'application/octet-stream');
  assert.equal(item.projectPath, await fs.realpath(project));
  assert.equal(item.layeredEditable, true);
  assert.equal(item.imageEditable, false);
  assert.equal(item.editable, false);
  assert.equal(item.sourcePath, null);
  const download = await ops.workFile(item.id);
  assert.equal(download.file, item.projectPath);
  assert.equal(download.mime, 'application/octet-stream');
  assert.deepEqual(await fs.readFile(download.file), bytes);
  await assert.rejects(ops.operation('source', { id: item.id }), errorCode('NO_EDITABLE_SOURCE'));
  await assert.rejects(ops.operation('source', { id: item.id, content: 'cannot replace binary', revision: 'a'.repeat(64) }), errorCode('NO_EDITABLE_SOURCE'));
  await assert.rejects(ops.operation('add', { title: 'Wrong text association', path: image, sourcePath: project }), errorCode('UNSUPPORTED_SOURCE'));
  assert.deepEqual(await fs.readFile(project), bytes);
});

test('imageEditable exposes only PNG, JPG, JPEG and WebP while editable continues to mean text source', async t => {
  const { ops, put } = await fixture(t);
  for (const extension of ['png', 'JPG', 'jpeg', 'WebP', 'gif', 'avif', 'svg', 'pdf', 'mp4']) {
    const file = await put(`type-${extension}.${extension}`, extension === 'svg' ? '<svg/>' : 'fixture bytes');
    const { item } = await ops.operation('add', { title: extension, path: file });
    assert.equal(item.imageEditable, ['png', 'jpg', 'jpeg', 'webp'].includes(extension.toLowerCase()));
    assert.equal(item.editable, extension === 'svg');
    assert.equal(item.layeredEditable, false);
    assert.equal(item.projectPath, null);
  }
});

test('image same-stem sidecars are discovered safely and missing sidecars remain optional', async t => {
  const { ops, put, image } = await fixture(t);
  const plain = await ops.operation('add', { title: 'No sidecar', path: image });
  assert.equal(plain.item.projectPath, null);
  const sidecar = await put('original.ppdesign', nativeBytes);
  const linked = await ops.operation('add', { title: 'Sidecar found', path: image });
  assert.equal(linked.item.id, plain.item.id);
  assert.equal(linked.item.projectPath, await fs.realpath(sidecar));
  assert.equal(linked.item.editable, false);
  assert.equal(linked.item.layeredEditable, true);
  const jpg = await put('cover.JPG');
  const jpgSidecar = await put('cover.ppdesign', nativeBytes);
  assert.equal((await ops.operation('add', { title: 'JPG', path: jpg })).item.projectPath, await fs.realpath(jpgSidecar));
});

test('non-files and symlink sidecars are rejected rather than silently linked', async t => {
  const { ops, image, project, root } = await fixture(t);
  const sidecar = path.join(root, 'original.ppdesign');
  await fs.mkdir(sidecar);
  await assert.rejects(ops.operation('add', { title: 'Directory sidecar', path: image }), errorCode('INVALID_FILE'));
  await fs.rmdir(sidecar);
  if (await link(t, project, sidecar)) await assert.rejects(ops.operation('add', { title: 'Linked sidecar', path: image }), errorCode('UNSAFE_PATH'));
  assert.equal((await ops.operation('list')).total, 0);
});

test('an explicit valid project takes precedence over sidecar discovery', async t => {
  const { ops, root, image, project } = await fixture(t);
  await fs.mkdir(path.join(root, 'original.ppdesign'));
  const { item } = await ops.operation('add', { title: 'Explicit', path: image, projectPath: project });
  assert.equal(item.projectPath, await fs.realpath(project));
});

test('linkProject changes previews on the same work id and keeps the first origin, source and metadata', async t => {
  const { ops, image, project, source, designRef, put } = await fixture(t);
  const { item: original } = await ops.operation('add', { title: 'Keep title', path: image, sourcePath: source, module: 'infographic', style: 'info-01-fixture', note: 'Keep note' });
  const preview = await put('published/first.png');
  const first = await ops.operation('linkProject', { id: original.id, projectPath: project, designRef, previewPath: preview, imageOnly: true });
  assert.equal(first.updated, true);
  assert.equal(first.item.id, original.id);
  assert.equal(first.item.path, await fs.realpath(preview));
  assert.equal(first.item.originPath, original.path);
  assert.equal(first.item.createdAt, original.createdAt);
  assert.deepEqual(first.item.designRef, designRef);
  assert.equal(first.item.imageOnly, true);
  for (const key of ['title', 'module', 'style', 'note', 'sourcePath']) assert.equal(first.item[key], original[key]);
  const secondPreview = await put('published/second.webp');
  const second = await ops.operation('linkProject', { id: original.id, projectPath: project, previewPath: secondPreview, imageOnly: false });
  assert.equal(second.item.id, original.id);
  assert.equal(second.item.originPath, original.path);
  assert.equal(second.item.sourcePath, original.sourcePath);
  assert.deepEqual(second.item.designRef, designRef);
  assert.equal(second.item.imageOnly, false);
  const updated = await ops.operation('add', { title: 'Updated title', path: secondPreview });
  assert.equal(updated.item.id, original.id);
  assert.equal(updated.item.originPath, original.path);
  assert.equal(updated.item.projectPath, await fs.realpath(project));
  assert.deepEqual(updated.item.designRef, designRef);
  assert.equal(updated.item.imageOnly, false);
  assert.equal(updated.item.sourcePath, original.sourcePath);
  assert.equal((await ops.operation('list')).total, 1);
  assert.equal((await ops.workFile(original.id)).file, await fs.realpath(secondPreview));
});

test('changing an HTML preview explicitly preserves its implicit source association', async t => {
  const { ops, source, image, project } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Implicit source', path: source });
  const linked = await ops.operation('linkProject', { id: item.id, projectPath: project, previewPath: image });
  assert.equal(linked.item.sourcePath, await fs.realpath(source));
  assert.equal(linked.item.editable, true);
  assert.equal((await ops.operation('source', { id: item.id })).content, '<h1>Original source</h1>');
});

test('linking without a new preview preserves the path and does not invent an origin', async t => {
  const { ops, image, project } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Same preview', path: image });
  const linked = await ops.operation('linkProject', { id: item.id, projectPath: project });
  assert.equal(linked.item.path, item.path);
  assert.equal(linked.item.originPath, undefined);
  const same = await ops.operation('linkProject', { id: item.id, projectPath: project, previewPath: image });
  assert.equal(same.item.originPath, undefined);
});

test('preview path conflicts and unknown work ids fail before changing the library', async t => {
  const { ops, image, project, put } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'First', path: image });
  const taken = await put('taken.png');
  await ops.operation('add', { title: 'Second', path: taken });
  const before = await rawIndex(ops);
  await assert.rejects(ops.operation('linkProject', { id: item.id, projectPath: project, previewPath: taken }), errorCode('WORK_PATH_CONFLICT'));
  await assert.rejects(ops.operation('linkProject', { id: 'missing', projectPath: project }), errorCode('UNKNOWN_WORK'));
  await assert.rejects(ops.operation('linkProject', { projectPath: project }), errorCode('INVALID_ARGUMENT'));
  assert.equal(await rawIndex(ops), before);
});

test('legacy indexes without new fields remain readable, including native and reference-only records', async t => {
  const { ops, image, project, designRef } = await fixture(t);
  const date = '2026-01-01T00:00:00.000Z';
  const common = { title: 'Old', module: '', style: '', note: '', createdAt: date, updatedAt: date };
  const items = [{ ...common, id: 'old-image', path: image }, { ...common, id: 'old-project', path: project }, { ...common, id: 'ref-only', path: path.join(path.dirname(image), 'absent-preview.png'), designRef }];
  await fs.mkdir(path.dirname(ops.libraryPath), { recursive: true });
  await fs.writeFile(ops.libraryPath, JSON.stringify({ version: 1, items }));
  const listing = await ops.operation('list');
  assert.equal(listing.total, 3);
  assert.equal(listing.items[0].imageEditable, true);
  assert.equal(listing.items[0].layeredEditable, false);
  assert.equal(listing.items[0].editable, false);
  assert.equal(listing.items[1].projectPath, project);
  assert.equal(listing.items[1].layeredEditable, true);
  assert.equal(listing.items[1].sourcePath, null);
  assert.equal(listing.items[2].layeredEditable, true);
  assert.equal(listing.items[2].projectPath, null);
});

test('damaged project, reference, origin and imageOnly fields are rejected without overwriting the index', async t => {
  const { ops, image, project, designRef } = await fixture(t);
  await ops.operation('add', { title: 'Valid', path: image });
  const valid = JSON.parse(await rawIndex(ops));
  const fields = [
    { projectPath: 'relative.ppdesign' }, { projectPath: image }, { projectPath: null }, { projectPath: `${project}\0` },
    { designRef: null }, { designRef: { ...designRef, id: 'other' } }, { designRef: { ...designRef, revision: 0 } }, { designRef: { ...designRef, dataDir: 'relative' } }, { designRef: { ...designRef, extra: true } },
    { originPath: 'relative.png' }, { originPath: null }, { imageOnly: 'true' }, { sourcePath: project },
  ];
  for (const bad of fields) {
    const raw = JSON.stringify({ ...valid, items: [{ ...valid.items[0], ...bad }] });
    await fs.writeFile(ops.libraryPath, raw);
    await assert.rejects(ops.operation('list'), errorCode('CORRUPT_LIBRARY'));
    await assert.rejects(ops.operation('add', { title: 'Do not overwrite', path: image }), errorCode('CORRUPT_LIBRARY'));
    await assert.rejects(ops.operation('linkProject', { id: valid.items[0].id, projectPath: project }), errorCode('CORRUPT_LIBRARY'));
    assert.equal(await rawIndex(ops), raw);
  }
});

test('designRef validates exactly three keys, native identity, positive safe revision and absolute dataDir', async t => {
  const { ops, image, project, designRef } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Original', path: image });
  const before = await rawIndex(ops);
  const invalid = [null, [], {}, { ...designRef, id: `design_${'g'.repeat(24)}` }, { ...designRef, id: 'design_1234' }, { ...designRef, revision: -1 }, { ...designRef, revision: 0 }, { ...designRef, revision: 1.5 }, { ...designRef, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...designRef, revision: '1' }, { ...designRef, dataDir: 'relative' }, { ...designRef, dataDir: `${designRef.dataDir}\0` }, { ...designRef, dataDir: 'x'.repeat(4097) }, { id: designRef.id, revision: 1 }, { ...designRef, unexpected: true }];
  for (const value of invalid) {
    await assert.rejects(ops.operation('linkProject', { id: item.id, projectPath: project, designRef: value }), errorCode('INVALID_ARGUMENT'));
    assert.equal(await rawIndex(ops), before);
  }
  for (const imageOnly of [null, 1, 'false']) await assert.rejects(ops.operation('linkProject', { id: item.id, projectPath: project, imageOnly }), errorCode('INVALID_ARGUMENT'));
  const linked = await ops.operation('linkProject', { id: item.id, projectPath: project, designRef: { ...designRef, revision: Number.MAX_SAFE_INTEGER } });
  assert.equal(linked.item.designRef.revision, Number.MAX_SAFE_INTEGER);
});

test('explicit project and preview arguments reject relative, missing, unsupported and non-file paths', async t => {
  const { ops, root, image, project, put } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Original', path: image });
  const directory = path.join(root, 'directory.ppdesign'); await fs.mkdir(directory);
  const invalidProjects = [['relative.ppdesign', 'INVALID_FILE'], [image, 'UNSUPPORTED_PROJECT'], [path.join(root, 'missing.ppdesign'), 'NOT_FOUND'], [directory, 'INVALID_FILE']];
  const before = await rawIndex(ops);
  for (const [projectPath, code] of invalidProjects) {
    await assert.rejects(ops.operation('add', { title: 'Rejected association', path: image, projectPath }), errorCode(code));
    await assert.rejects(ops.operation('linkProject', { id: item.id, projectPath }), errorCode(code));
    assert.equal(await rawIndex(ops), before);
  }
  const html = await put('wrong-preview.html', '<h1>Not an image preview</h1>');
  const gif = await put('wrong-preview.gif');
  const previews = [['relative.png', 'INVALID_FILE'], [html, 'INVALID_FILE'], [gif, 'INVALID_FILE'], [path.join(root, 'missing.png'), 'NOT_FOUND']];
  for (const [previewPath, code] of previews) await assert.rejects(ops.operation('linkProject', { id: item.id, projectPath: project, previewPath }), errorCode(code));
  assert.equal(await rawIndex(ops), before);
});

test('project files and preview associations reject final symlinks and ancestor junctions', async t => {
  const { ops, root, image, project, put } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Original', path: image });
  const projectLink = path.join(root, 'project-link.ppdesign');
  if (await link(t, project, projectLink)) {
    await assert.rejects(ops.operation('linkProject', { id: item.id, projectPath: projectLink }), errorCode('UNSAFE_PATH'));
    await assert.rejects(ops.operation('add', { title: 'Binary alias', path: projectLink }), errorCode('UNSAFE_PATH'));
  }
  const previewLink = path.join(root, 'preview-link.png');
  if (await link(t, image, previewLink)) await assert.rejects(ops.operation('linkProject', { id: item.id, projectPath: project, previewPath: previewLink }), errorCode('UNSAFE_PATH'));
  const directory = path.join(root, 'directory-alias');
  if (await link(t, path.dirname(project), directory, true)) await assert.rejects(ops.operation('add', { title: 'Ancestor alias', path: image, projectPath: path.join(directory, path.basename(project)) }), errorCode('UNSAFE_PATH'));
  const preview = await put('previews/cover.png');
  const previewDirectory = path.join(root, 'preview-alias');
  if (await link(t, path.dirname(preview), previewDirectory, true)) await assert.rejects(ops.operation('linkProject', { id: item.id, projectPath: project, previewPath: path.join(previewDirectory, path.basename(preview)) }), errorCode('UNSAFE_PATH'));
  assert.equal((await ops.operation('list')).items[0].layeredEditable, false);
});

test('native project inode replacement during index persistence aborts the metadata commit', async t => {
  const { ops, image, project, put } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Original', path: image });
  const before = await rawIndex(ops);
  const replacement = await put('replacement.ppdesign', Buffer.from('a different inode'));
  const probe = await fs.open(project, 'r'); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const originalSync = prototype.sync;
  let replaced = false;
  t.mock.method(prototype, 'sync', async function () {
    await originalSync.call(this);
    if (!replaced) {
      replaced = true;
      await fs.rename(project, `${project}.original`);
      await fs.rename(replacement, project);
    }
  });
  await assert.rejects(ops.operation('linkProject', { id: item.id, projectPath: project }), errorCode('FILE_CHANGED'));
  assert.equal(replaced, true);
  assert.equal(await rawIndex(ops), before);
  assert.deepEqual(await fs.readFile(`${project}.original`), nativeBytes);
  assert.deepEqual((await fs.readdir(path.dirname(ops.libraryPath))).filter(name => name.endsWith('.tmp')), []);
});

test('a preview parent changed to a junction during index persistence cannot redirect a binding', async t => {
  const { ops, root, image, project, put } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Original', path: image });
  const preview = await put('previews/cover.png', 'original preview');
  const external = await put('outside/cover.png', 'external private bytes');
  const check = path.join(root, 'junction-check');
  if (!await link(t, path.dirname(external), check, true)) return;
  await fs.unlink(check);
  const before = await rawIndex(ops);
  const probe = await fs.open(project, 'r'); const prototype = Object.getPrototypeOf(probe); await probe.close();
  const originalSync = prototype.sync;
  let replaced = false;
  t.mock.method(prototype, 'sync', async function () {
    await originalSync.call(this);
    if (!replaced) {
      replaced = true;
      await fs.rename(path.dirname(preview), path.join(root, 'moved-previews'));
      await fs.symlink(path.dirname(external), path.dirname(preview), process.platform === 'win32' ? 'junction' : 'dir');
    }
  });
  await assert.rejects(ops.operation('linkProject', { id: item.id, projectPath: project, previewPath: preview }), errorCode('UNSAFE_PATH'));
  assert.equal(replaced, true);
  assert.equal(await rawIndex(ops), before);
  assert.equal(await fs.readFile(external, 'utf8'), 'external private bytes');
});

test('workFile refuses a native work whose registered parent was replaced by a junction', async t => {
  const { ops, root, project, put } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Native', path: project });
  const external = await put('external/project.ppdesign', 'external private bytes');
  await fs.rename(path.dirname(project), path.join(root, 'moved-native'));
  if (!await link(t, path.dirname(external), path.dirname(project), true)) return;
  await assert.rejects(ops.workFile(item.id), errorCode('UNSAFE_PATH'));
});

test('separate operation instances serialize concurrent associations and imageOnly updates', async t => {
  const { ops, options, put, project, designRef } = await fixture(t);
  const other = createOperations(options);
  const works = [];
  for (let index = 0; index < 8; index++) {
    const image = await put(`parallel/${index}.png`);
    const previewPath = await put(`parallel/${index}-published.png`);
    const { item } = await ops.operation('add', { title: `Work ${index}`, path: image });
    works.push({ item, previewPath });
  }
  await Promise.all(works.map(({ item, previewPath }, index) => (index % 2 ? ops : other).operation('linkProject', { id: item.id, projectPath: project, previewPath, designRef: { ...designRef, revision: index + 1 }, imageOnly: index % 2 === 0 })));
  const listing = await ops.operation('list');
  assert.equal(listing.total, works.length);
  for (const [index, { item, previewPath }] of works.entries()) {
    const linked = listing.items.find(entry => entry.id === item.id);
    assert.equal(linked.path, await fs.realpath(previewPath));
    assert.equal(linked.originPath, item.path);
    assert.equal(linked.designRef.revision, index + 1);
    assert.equal(linked.imageOnly, index % 2 === 0);
  }
  assert.deepEqual((await fs.readdir(path.dirname(ops.libraryPath))).filter(name => name.endsWith('.tmp')), []);
});

test('layered static drafts require real independent layers, guide discovery, native document calls and publish', async t => {
  const { ops } = await fixture(t);
  for (const task of ['infographic', 'xiaohongshu']) {
    const result = await ops.operation('draft', { task, outputMode: 'layered', brief: '三个数据卡片' });
    assert.equal(result.outputMode, 'layered');
    assert.match(result.draft, /PNG.*\.ppdesign/);
    assert.match(result.draft, /真实独立.*text\/rect\/ellipse\/line\/image/);
    assert.match(result.draft, /禁止把整张渲染图伪装/);
    assert.match(result.draft, /huashu_printpress.*action="guide"/);
    assert.match(result.draft, /坐标、字号和图片资源契约/);
    assert.match(result.draft, /design:importBytes \/ design:save/);
    assert.match(result.draft, /action="publish"/);
    assert.match(result.draft, /顶层参数包含 designId、revision、title、module、style、previewPath、projectPath/);
    assert.match(result.draft, /allowWrite:true/);
    assert.match(result.draft, /requireLayers:true/);
    assert.doesNotMatch(result.draft, /params/);
    assert.match(result.draft, /workId/);
    assert.ok(result.draft.indexOf('action="guide"') < result.draft.indexOf('design:importBytes'));
    assert.ok(result.draft.indexOf('design:save') < result.draft.indexOf('action="publish"'));
  }
  assert.equal((await ops.operation('list')).total, 0);
});

test('any task can opt into a layered native project; standard remains the default', async t => {
  const { ops } = await fixture(t);
  for (const task of ['web', 'deck', 'app', 'motion', 'critique', 'infographic', 'xiaohongshu']) {
    const layered = await ops.operation('draft', { task, outputMode: 'layered', brief: '可编辑图层' });
    assert.equal(layered.outputMode, 'layered', task + ' explicit layered');
    assert.match(layered.draft, /\.ppdesign/, task + ' layered prompt names the native package');
    const standard = await ops.operation('draft', { task, brief: '常规输出' });
    assert.equal(standard.outputMode, 'standard', task + ' default standard');
    assert.doesNotMatch(standard.draft, /\.ppdesign/, task + ' standard prompt must not request a native package');
  }
});

test('standard drafts retain prior delivery behavior and do not force native output', async t => {
  const { ops } = await fixture(t);
  for (const outputMode of [undefined, 'standard']) {
    const result = await ops.operation('draft', { task: 'infographic', ...(outputMode ? { outputMode } : {}) });
    assert.equal(result.outputMode, 'standard');
    assert.match(result.draft, /action="add"/);
    assert.match(result.draft, /sourcePath/);
    assert.doesNotMatch(result.draft, /\.ppdesign|action="guide"|action="publish"/);
  }
  for (const outputMode of ['', 'invalid', null, 1]) await assert.rejects(ops.operation('draft', { task: 'infographic', outputMode }), errorCode('INVALID_ARGUMENT'));
});

test('native project edit and same-style reuse include the real project and preserve source identity', async t => {
  const { ops, image, project, source } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Editable layers', path: image, projectPath: project, sourcePath: source, module: 'infographic', style: 'info-01-fixture', note: 'Retain content' });
  const before = await rawIndex(ops);
  const edit = await ops.operation('edit', { id: item.id, brief: '只调整文字的位置' });
  assert.equal(edit.workId, item.id);
  assert.equal(edit.sourcePath, await fs.realpath(source));
  assert.equal(edit.projectPath, await fs.realpath(project));
  assert.ok(edit.draft.includes(project));
  assert.ok(edit.draft.includes(source));
  assert.ok(edit.draft.includes(`"workId":"${item.id}"`));
  assert.match(edit.draft, /保留 sourcePath 关联和源码文件/);
  assert.match(edit.draft, /action="guide"/);
  assert.match(edit.draft, /action="publish"/);
  assert.match(edit.draft, /顶层参数包含 designId、revision、allowWrite:true、requireLayers:true/);
  assert.match(edit.draft, /作品字段也置于顶层/);
  assert.doesNotMatch(edit.draft, /params/);
  assert.doesNotMatch(edit.draft, /三个有明显差异/);
  const reuse = await ops.operation('draft', { workId: item.id, workflow: 'same-style' });
  assert.equal(reuse.projectPath, await fs.realpath(project));
  assert.ok(reuse.draft.includes(project));
  assert.equal(await rawIndex(ops), before);
  assert.equal(await fs.readFile(source, 'utf8'), '<h1>Original source</h1>');
});

test('a native-only work can produce an edit draft but cannot route into text source editing', async t => {
  const { ops, project } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Native project', path: project, module: 'xiaohongshu' });
  const result = await ops.operation('edit', { id: item.id, brief: '改图层' });
  assert.equal(result.sourcePath, null);
  assert.equal(result.projectPath, project);
  assert.match(result.draft, /改图层/);
  assert.match(result.draft, /design:importBytes/);
  await ops.operation('linkProject', { id: item.id, projectPath: project, imageOnly: true });
  const imageEdit = await ops.operation('edit', { id: item.id, brief: '只裁切图片' });
  assert.match(imageEdit.draft, /顶层参数包含 designId、revision、allowWrite:true/);
  assert.match(imageEdit.draft, /当前为单图片工程，保留实际图层结构/);
  assert.doesNotMatch(imageEdit.draft, /params|requireLayers/);
  await assert.rejects(ops.operation('source', { id: item.id }), errorCode('NO_EDITABLE_SOURCE'));
  await assert.rejects(ops.operation('edit', { id: item.id, sourcePath: project }), errorCode('SOURCE_MISMATCH'));
  await assert.rejects(ops.operation('edit', { id: item.id, path: project }), errorCode('INVALID_ARGUMENT'));
});

test('missing native associations fail edit and reuse instead of switching to another source', async t => {
  const { ops, image, project, source } = await fixture(t);
  const { item } = await ops.operation('add', { title: 'Native project', path: image, projectPath: project, sourcePath: source });
  await fs.unlink(project);
  await assert.rejects(ops.operation('edit', { id: item.id }), errorCode('NOT_FOUND'));
  await assert.rejects(ops.operation('draft', { workId: item.id }), errorCode('NOT_FOUND'));
  assert.equal(await fs.readFile(source, 'utf8'), '<h1>Original source</h1>');
});

test('skill adapter preserves the upstream body and discovers layered contracts through guide', async t => {
  const { ops, skill } = await fixture(t);
  const definition = await ops.skillDefinition();
  assert.ok(definition.content.startsWith(splitSkill(skill).body));
  const note = definition.content.slice(definition.content.indexOf('任何创作类型都可由用户显式选'));
  assert.ok(note.length > 0 && note.length < 600);
  assert.match(note, /outputMode=`layered`/);
  assert.match(note, /PNG \+ 原生 \.ppdesign/);
  assert.match(note, /action=`guide`/);
  assert.match(note, /action=`publish`/);
  assert.match(note, /publish 使用顶层参数/);
  assert.match(note, /`allowWrite:true`/);
  assert.match(note, /分层交付加 `requireLayers:true`/);
  assert.match(note, /单图片续改保留实际图层结构/);
  assert.doesNotMatch(note, /params/);
  assert.match(note, /workId/);
  assert.match(note, /工程不作为文本 sourcePath/);
});
