import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createOperations, parseStyles, LIMITS } from '../lib/core.js';
import { createHttpHandler, createTool } from '../lib/host.js';

const first = `**首张 First Style** \`大胆·还原98%\`
- 参考 : First Studio
- 适配：第一页媒体
- 视觉DNA : 配色 #AbC #aBc #112233 #445566 #778899 #AaBbCc #DDEEFF #000 #123 #456 #789 #C01234 #D02345 #E03456；无效 #12345 #1234567 #12345678 #123456Z #FFF_more
- HTML 实现 ： CSS Grid first
- 字体 : First Font
- 样张:assets/style-specimens/web/01-first.jpg
`;
const last = `**最后 Last Style** \`安静·还原90%\`
- 参考:Last Book
- 适配:末页故事
- 视觉DNA:竖排留白，朱红 #cc2233。
- HTML实现:writing-mode:vertical-rl
- 字体:Noto Serif SC
- 样张:assets/style-specimens/xhs/08-last.jpg
`;

async function fixture(t, markdown = first + '\n' + last) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-style-notes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const upstreamRoot = path.join(root, 'upstream');
  await fs.mkdir(path.join(upstreamRoot, 'references'), { recursive: true });
  await fs.writeFile(path.join(upstreamRoot, 'references/design-styles.md'), markdown);
  await fs.writeFile(path.join(upstreamRoot, 'references/plain.md'), 'abcdefghij');
  await fs.mkdir(path.join(upstreamRoot, 'assets'), { recursive: true });
  await fs.writeFile(path.join(upstreamRoot, 'assets/image.png'), Buffer.from([137,80,78,71]));
  return createOperations({ upstreamRoot, dshHome: path.join(root, 'home') });
}
const errorCode = (code, status) => error => error.code === code && (status === undefined || error.status === status);

async function startServer(t, operations) {
  let origin;
  const server = http.createServer(createHttpHandler(operations, { requestRejection: () => undefined }, () => origin));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return async args => {
    const response = await fetch(`${origin}/huashu-design/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ action: 'read', args }) });
    return { status: response.status, value: await response.json() };
  };
}

test('parseStyles keeps catalog metadata compact and adds nullable tone and fidelity', () => {
  const entries = parseStyles(first + '\n' + last);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].tone, '大胆'); assert.equal(entries[0].fidelity, 98);
  assert.equal(entries[1].tone, '安静'); assert.equal(entries[1].fidelity, 90);
  assert.ok(entries.every(entry => !Object.hasOwn(entry, 'notes')));
  assert.equal(entries[0].specimen, 'assets/style-specimens/web/01-first.jpg');
  const [unknown] = parseStyles('**安静藏在名字里 Quiet**\n- 样张:assets/style-specimens/web/03-unknown.jpg\n');
  assert.equal(unknown.tone, null); assert.equal(unknown.fidelity, null);
  const [invalid] = parseStyles('**Invalid** `中性·还原101%`\n- 样张:assets/style-specimens/web/04-invalid.jpg\n');
  assert.equal(invalid.tone, '中性'); assert.equal(invalid.fidelity, null);
});

test('style detail fields accept colon spacing and stay within one style; palette uses actual hex only', () => {
  const entries = parseStyles((first + '\n' + last).replaceAll('\n', '\r\n'), true);
  const notes = entries[0].notes;
  assert.deepEqual(Object.keys(notes), ['reference', 'useCases', 'visualDNA', 'implementation', 'typography', 'palette']);
  assert.equal(notes.reference, 'First Studio'); assert.equal(notes.useCases, '第一页媒体');
  assert.equal(notes.implementation, 'CSS Grid first'); assert.equal(notes.typography, 'First Font');
  assert.deepEqual(notes.palette, ['#AbC', '#112233', '#445566', '#778899', '#DDEEFF', '#000', '#C01234', '#D02345']);
  assert.doesNotMatch(JSON.stringify(notes), /Last Book|末页故事|Noto Serif SC/);
  assert.deepEqual(entries[1].notes.palette, ['#cc2233']);
  assert.match(entries[1].notes.implementation, /vertical-rl/);
  const [empty] = parseStyles('**Empty**\n- 视觉DNA:无彩色示例\n- 样张:assets/style-specimens/web/05-empty.jpg\n', true);
  assert.deepEqual(empty.notes.palette, []); assert.equal(empty.notes.reference, '');
  const [invalidHex] = parseStyles('**Invalid hex**\n- 视觉DNA:#12345 #1234567 #12345678 #123456Z #FFF_more；只有 #F00 是有效值\n- 样张:assets/style-specimens/web/06-invalid-hex.jpg\n', true);
  assert.deepEqual(invalidHex.notes.palette, ['#F00']);
});

test('all 92 real catalog entries have own complete design notes; late xhs entry never returns first web notes', async () => {
  const operations = createOperations();
  const catalog = await operations.catalog();
  assert.equal(catalog.styles.length, 92);
  assert.ok(catalog.styles.every(entry => !Object.hasOwn(entry, 'notes')));
  for (const entry of catalog.styles) {
    const result = await operations.operation('read', { style: entry.id });
    assert.equal(result.style.id, entry.id);
    assert.equal(result.path, 'references/design-styles.md');
    assert.deepEqual(result.notes, result.style.notes);
    for (const key of ['useCases', 'visualDNA', 'implementation', 'typography']) assert.ok(result.notes[key].length > 0, `${entry.id} has no ${key}`);
    assert.ok(result.notes.palette.length <= 8);
    assert.ok(result.notes.palette.every(hex => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) && result.notes.visualDNA.includes(hex)));
    assert.ok(result.style.tone === null || ['大胆', '中性', '安静'].includes(result.style.tone));
    assert.ok(result.style.fidelity === null || (result.style.fidelity >= 0 && result.style.fidelity <= 100));
  }
  const late = await operations.operation('read', { style: 'xhs-08-area-infographic', limit: 1, offset: 999999 });
  assert.match(late.notes.useCases, /硬数字/);
  assert.match(late.notes.implementation, /squarify/);
  assert.match(late.notes.typography, /Figtree/);
  assert.doesNotMatch(JSON.stringify(late.notes), /Bloomberg Businessweek|Editorial Brutalism/);
  assert.equal(late.style.tone, '中性'); assert.equal(late.style.fidelity, 95);
});

test('style read rejects unknown IDs and mixed path; ordinary Markdown/image reads remain unchanged', async t => {
  const operations = await fixture(t);
  await assert.rejects(operations.operation('read', { style: 'not-a-style' }), errorCode('UNKNOWN_STYLE', 404));
  await assert.rejects(operations.operation('read', { style: 'web-01-first', path: 'references/plain.md' }), errorCode('INVALID_ARGUMENT', 400));
  await assert.rejects(operations.operation('read', { style: '' }), errorCode('INVALID_ARGUMENT', 400));
  assert.deepEqual(await operations.operation('read', { path: 'references/plain.md', offset: 2, limit: 3 }), { path: 'references/plain.md', content: 'cde', total: 10, offset: 2, limit: 3, truncated: true, nextOffset: 5 });
  assert.deepEqual(await operations.operation('read', { path: 'assets/image.png' }), { path: 'assets/image.png', mime: 'image/png', url: '/huashu-design/assets/assets/image.png' });
});

test('style read retains the resource size guard and safe-path lookup', async t => {
  const operations = await fixture(t, first + 'x'.repeat(LIMITS.markdownBytes));
  await assert.rejects(operations.operation('read', { style: 'web-01-first' }), errorCode('RESOURCE_TOO_LARGE', 413));
  const normal = await fixture(t);
  await fs.rm(path.join(normal.upstreamRoot, 'references/design-styles.md'));
  await assert.rejects(normal.operation('read', { style: 'web-01-first' }), errorCode('NOT_FOUND', 404));
});

test('style tool and HTTP read return the same complete entry and errors', async t => {
  const operations = createOperations();
  const post = await startServer(t, operations);
  const tool = createTool(operations);
  const args = { style: 'xhs-08-area-infographic' };
  const toolResult = await tool.execute({ action: 'read', args });
  const httpResult = await post(args);
  assert.equal(httpResult.status, 200); assert.deepEqual(httpResult.value, toolResult);
  assert.equal(toolResult.notes.useCases, toolResult.style.description);
  const unknown = await post({ style: 'unknown' });
  assert.equal(unknown.status, 404); assert.equal(unknown.value.error.code, 'UNKNOWN_STYLE');
  const mixed = await post({ ...args, path: 'references/design-styles.md' });
  assert.equal(mixed.status, 400); assert.equal(mixed.value.error.code, 'INVALID_ARGUMENT');
  assert.match(tool.parameters.properties.args.properties.style.description, /read/);
  assert.match(tool.parameters.properties.action.description, /style/);
});
