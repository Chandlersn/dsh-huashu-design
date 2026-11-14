import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lexer } from 'marked';
import { parseHandbook, resolveHandbookTarget } from '../lib/handbook.js';

const upstream = fileURLToPath(new URL('../upstream/', import.meta.url));
const current = 'references/modules/web.md';

function allTokens(tokens) {
  return tokens.flatMap(token => [
    token,
    ...(token.tokens ? allTokens(token.tokens) : []),
    ...(token.items ? allTokens(token.items) : []),
    ...(token.type === 'table' ? [...token.header, ...token.rows.flat()].flatMap(cell => allTokens(cell.tokens)) : []),
  ]);
}

function withoutHeadingIds(tokens) {
  const copy = structuredClone(tokens);
  // structuredClone resets marked's null-prototype link-definition dictionary.
  Object.setPrototypeOf(copy.links, Object.getPrototypeOf(tokens.links));
  for (const token of allTokens(copy)) if (token.type === 'heading') delete token.id;
  return copy;
}

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(full));
    else if (/\.md$/i.test(entry.name)) files.push(full);
  }
  return files.sort();
}

test('all 45 upstream references plus SKILL/README retain real GFM tokens and a matching heading TOC', async () => {
  const references = await markdownFiles(path.join(upstream, 'references'));
  assert.equal(references.length, 45, 'exercise every shipped reference, including nested modules');
  const files = [...references, path.join(upstream, 'SKILL.md'), path.join(upstream, 'README.md')];
  const totals = { heading: 0, table: 0, list: 0, code: 0, blockquote: 0 };
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const parsed = parseHandbook(source);
    const label = path.relative(upstream, file);
    const flattened = allTokens(parsed.tokens);
    const headings = flattened.filter(token => token.type === 'heading');
    assert.ok(headings.length > 0, `${label} has visible headings`);
    assert.equal(parsed.toc.length, headings.length, label);
    assert.equal(new Set(parsed.toc.map(entry => entry.id)).size, headings.length, `${label} IDs are unique`);
    assert.ok(parsed.wordCount > 0, `${label} has readable content`);
    assert.ok(parsed.title.length > 0, label);
    assert.deepEqual(parsed.toc.map(({ id, depth }) => ({ id, depth })), headings.map(({ id, depth }) => ({ id, depth })), label);
    const body = source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    assert.deepEqual(withoutHeadingIds(parsed.tokens), lexer(body, { gfm: true }), `${label}: raw/inline tokens are unchanged`);
    for (const token of flattened) if (Object.hasOwn(totals, token.type)) totals[token.type]++;
  }
  for (const [type, count] of Object.entries(totals)) assert.ok(count > 0, `real corpus contains ${type}`);
  const typography = parseHandbook(await fs.readFile(path.join(upstream, 'references/typography.md'), 'utf8'));
  assert.ok(typography.tokens.filter(token => token.type === 'table').length >= 5);
  assert.ok(typography.tokens.some(token => token.type === 'code' && token.lang === 'css'));
  const skill = parseHandbook(await fs.readFile(path.join(upstream, 'SKILL.md'), 'utf8'));
  assert.equal(skill.title, '花叔Design · Huashu-Design');
  assert.doesNotMatch(skill.tokens[0].raw, /name: huashu-design|metadata:/);
});

test('heading labels use inline captions, Unicode slugs are stable, and all collisions are disambiguated', () => {
  const source = '# 中文 **排版**与 `API` [指南](intro.md) ![图 *注*](图.png)\n\n'
    + '## 同名\n## 同名\n## 同名-2\n## 同名\n## !!!\n## ???\n'
    + '> ### 引文 **标题**\n\n- #### 列表标题\n\n## Café\n## Cafe\u0301\n';
  const parsed = parseHandbook(source);
  assert.equal(parsed.title, '中文 排版与 API 指南 图 注');
  assert.deepEqual(parsed.toc.map(entry => entry.id), [
    '中文-排版与-api-指南-图-注', '同名', '同名-2', '同名-2-2', '同名-3',
    'section', 'section-2', '引文-标题', '列表标题', 'café', 'café-2',
  ]);
  assert.deepEqual(parsed.toc.map(entry => entry.depth), [1, 2, 2, 2, 2, 2, 2, 3, 4, 2, 2]);
  assert.deepEqual(parseHandbook(source).toc, parsed.toc);
  assert.deepEqual(withoutHeadingIds(parsed.tokens), lexer(source, { gfm: true }));
  const entities = parseHandbook('# A &amp; B &#x4e2d; &#25991; <em>标签</em> \\*字\\*\n');
  assert.equal(entities.title, 'A & B 中 文 标签 *字*');
  assert.equal(entities.toc[0].id, 'a-b-中-文-标签-字');
  assert.equal(parseHandbook('# &constructor; &toString;\n').title, '&constructor; &toString;');
});

test('top-level frontmatter is omitted, while unclosed fences and later YAML-like content remain content', () => {
  const body = '# 阅读 **手册**\r\n\r\n正文。\r\n';
  const parsed = parseHandbook('\uFEFF---\r\ntitle: 隐藏标题\r\nmetadata:\r\n  private: true\r\n---\r\n' + body);
  assert.equal(parsed.title, '阅读 手册');
  assert.deepEqual(withoutHeadingIds(parsed.tokens), lexer(body, { gfm: true }));
  assert.equal(parsed.wordCount, parseHandbook(body).wordCount);
  assert.equal(parseHandbook('---\n---\n# Empty YAML\n').title, 'Empty YAML');
  assert.equal(parseHandbook('---\nname: hidden\n...\n# Dot terminator\n').title, 'Dot terminator');
  const unclosed = '---\nnot: closed\n# Still visible\n';
  assert.deepEqual(withoutHeadingIds(parseHandbook(unclosed).tokens), lexer(unclosed, { gfm: true }));
  const later = '# Manual\n\n---\nname: body\n---\n';
  assert.deepEqual(withoutHeadingIds(parseHandbook(later).tokens), lexer(later, { gfm: true }));
});

test('code fences never create phantom headings; tables, lists and all supported inline shapes are preserved', () => {
  const source = '# Real\n\n```md\n# Fake\n## Also fake\n| not | a table |\n```\n\n'
    + '~~~js\n# Still fake\n~~~\n\n'
    + '| **Name** | Value |\n| :--- | ---: |\n| `code` | [link](next.md) |\n\n'
    + '- [x] Done\n- Nested\n  - child\n\n> quote **bold**\n\n'
    + 'Text \\*escape\\* **strong** _em_ `inline` ~~del~~ [link](next.md) ![caption](image.png)  \nnext\n\n'
    + '<script>throw new Error("never executed")</script>\n\n---\n';
  const parsed = parseHandbook(source);
  assert.deepEqual(parsed.toc.map(entry => entry.text), ['Real']);
  const tokens = allTokens(parsed.tokens);
  for (const type of ['heading', 'paragraph', 'list', 'table', 'blockquote', 'code', 'hr', 'space', 'text', 'html',
    'escape', 'strong', 'em', 'codespan', 'del', 'link', 'image', 'br']) {
    assert.ok(tokens.some(token => token.type === type), `retains ${type}`);
  }
  const table = tokens.find(token => token.type === 'table');
  assert.deepEqual(table.align, ['left', 'right']);
  assert.equal(table.rows[0][1].tokens[0].href, 'next.md');
  assert.ok(tokens.some(token => token.type === 'list_item' && token.task && token.checked));
  assert.equal(tokens.filter(token => token.type === 'code').length, 2);
  assert.match(tokens.find(token => token.type === 'html').raw, /<script>/);
  assert.deepEqual(withoutHeadingIds(parsed.tokens), lexer(source, { gfm: true }));
});

test('reading estimate counts visible CJK/words without counting Markdown metadata or link destinations', () => {
  assert.equal(parseHandbook('').wordCount, 0);
  assert.equal(parseHandbook('你好 world 123').wordCount, 4);
  assert.equal(parseHandbook('**你好** [world](a-very-long-invisible-destination.md) 123').wordCount, 4);
  assert.equal(parseHandbook('![中文图注](many-invisible-path-words.png)').wordCount, 4);
  assert.equal(parseHandbook('```js\nhello world\n```').wordCount, 2);
  assert.equal(parseHandbook('<script>invisible words</script>\n').wordCount, 0);
  assert.equal(parseHandbook('## First section\n').title, 'First section');
  assert.equal(parseHandbook('plain body').title, '设计手册');
  assert.throws(() => parseHandbook(null), TypeError);
});

test('relative Markdown follows the current document directory and stays within the upstream root', () => {
  const examples = [
    ['next.md', 'references/modules/next.md'],
    ['./next.MARKDOWN', 'references/modules/next.MARKDOWN'],
    ['../typography.md', 'references/typography.md'],
    ['../../README.md', 'README.md'],
    ['./folder/../next.md', 'references/modules/next.md'],
    ['../中文%20排版.md', 'references/中文 排版.md'],
    ['../%E4%B8%AD%E6%96%87.md?view=read', 'references/中文.md'],
  ];
  for (const [href, expected] of examples) {
    assert.deepEqual(resolveHandbookTarget(href, current), { kind: 'document', path: expected }, href);
  }
  assert.deepEqual(resolveHandbookTarget('references/typography.md', 'SKILL.md'), { kind: 'document', path: 'references/typography.md' });
  assert.deepEqual(resolveHandbookTarget('?mode=reader', current), { kind: 'document', path: current });
  for (const href of ['next.md/', 'next.md/.']) {
    assert.deepEqual(resolveHandbookTarget(href, current), { kind: 'unsupported', path: 'references/modules/next.md' });
  }
  assert.deepEqual(resolveHandbookTarget('../typography.md#%E4%B8%AD%E6%96%87-%E6%8E%92%E7%89%88', current), {
    kind: 'document', path: 'references/typography.md', fragment: '中文-排版',
  });
});

test('fragments decode once and preserve their original case, spacing, punctuation and Unicode', () => {
  for (const [href, fragment] of [
    ['#中文-标题', '中文-标题'], ['#Hello%20World%2BAPI', 'Hello World+API'],
    ['#%E4%B8%AD%E6%96%87', '中文'], ['#Already%2520encoded', 'Already%20encoded'], ['#', ''],
  ]) assert.deepEqual(resolveHandbookTarget(href, current), { kind: 'anchor', fragment }, href);
  assert.deepEqual(resolveHandbookTarget('next.md#', current), { kind: 'document', path: 'references/modules/next.md', fragment: '' });
  assert.deepEqual(resolveHandbookTarget('#%E0%A4%A', current), { kind: 'blocked' });
});

test('images only map to the fixed upstream asset route; unsupported source resources stay inert', () => {
  for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'PNG']) {
    const href = `../../assets/中文 图.${extension}`;
    const resource = `assets/中文 图.${extension}`;
    const url = `/huashu-design/assets/assets/${encodeURIComponent(`中文 图.${extension}`)}`;
    const image = { kind: 'image', path: resource, url };
    assert.deepEqual(resolveHandbookTarget(href, current), image);
    assert.deepEqual(resolveHandbookTarget(url, current), image, 'generated image URLs round trip safely');
  }
  assert.deepEqual(resolveHandbookTarget('../sample.svg#view', current), {
    kind: 'image', path: 'references/sample.svg', url: '/huashu-design/assets/references/sample.svg',
  });
  for (const extension of ['html', 'htm', 'js', 'mjs', 'css', 'py', 'txt', 'pdf', 'mp4']) {
    assert.deepEqual(resolveHandbookTarget(`../../demos/example.${extension}`, current), { kind: 'unsupported', path: `demos/example.${extension}` });
  }
});

test('only valid HTTP, HTTPS and mailto are external, with their original href retained', () => {
  for (const href of ['https://example.com/docs?a=1#中文', 'http://example.com:8080/image.png',
    'HTTPS://Example.com/Path', 'mailto:author@example.com?subject=Hello%20world']) {
    assert.deepEqual(resolveHandbookTarget(href, current), { kind: 'external', href });
  }
  assert.equal(resolveHandbookTarget('mailto:author@example.com', current).kind, 'external');
  assert.notEqual(resolveHandbookTarget('mailto:author@example.com', current).kind, 'image');
});

test('unsafe schemes, Host-root navigation, backslashes, drive letters and encoded traversal are blocked', () => {
  const unsafe = [
    '', '   ', '../../../secret.md', '../../dir/../../secret.md',
    '../.. /secret.md', '../..%20/secret.md', '../../assets./secret.png', '../../assets%20/secret.png',
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:image/svg+xml,<svg/>', 'vbscript:msgbox(1)',
    'file:///C:/secret.md', 'ftp://example.com/file.md', 'blob:https://example.com/id', 'about:blank',
    'javascript%3Aalert(1)', '%6aavascript:alert(1)', '%256aavascript%253aalert(1)',
    '//example.com/a.md', '//localhost:3080/', '%2f%2fexample.com/a.md', '%252f%252fexample.com/a.md',
    'C:/secret.md', 'C:\\secret.md', '../C:/secret.md', 'c%3A/secret.md',
    '..\\secret.md', '..%5csecret.md', '..%255csecret.md', '..%25255csecret.md',
    '../%2e%2e/secret.md', '%2e%2e/%2e%2e/%2e%2e/secret.md',
    '..%2f..%2fsecret.md', '%252e%252e/secret.md', '%25252e%25252e/secret.md',
    '%25%32%65%25%32%65/secret.md', '%c0%ae%c0%ae/secret.md',
    '/README.md', '/references/typography.md', '/api/action', '/huashu-design/',
    '/huashu-design/assets/../secret.png', '/huashu-design/assets/assets/../secret.png',
    '/huashu-design/assets/%2e%2e/secret.png', '/huashu-design/assets/assets/%252e%252e/secret.png',
    '/huashu-design/assets/demos/example.html', '/huashu-design/assets/assets/中文.png',
    'next.md\u0000', '\nhttps://example.com', 'java\tscript:alert(1)',
    'next%00.md', 'next%2500.md', '#%0aheading', '#%255cheading',
    'https://example.com/%0a', 'https://example.com/%255c', 'next\u202e.md',
    'next%ZZ.md', 'https:', 'https:example.com', 'http:/example.com',
  ];
  for (const href of unsafe) assert.deepEqual(resolveHandbookTarget(href, current), { kind: 'blocked' }, JSON.stringify(href));
});

test('an invalid current resource path blocks every target category', () => {
  const badCurrentPaths = [undefined, null, '', '/', '/references/web.md', '../web.md',
    'references/../web.md', './web.md', 'references//web.md', 'C:/web.md',
    'references\\web.md', 'references/%2e%2e/web.md', 'references/web.md\u0000', 'references/\u200bweb.md'];
  for (const currentPath of badCurrentPaths) {
    for (const href of ['next.md', '#heading', '../image.png', 'https://example.com', 'mailto:a@example.com']) {
      assert.deepEqual(resolveHandbookTarget(href, currentPath), { kind: 'blocked' }, `${String(currentPath)} => ${href}`);
    }
  }
  for (const href of [null, undefined, {}, 3]) assert.deepEqual(resolveHandbookTarget(href, current), { kind: 'blocked' });
});
