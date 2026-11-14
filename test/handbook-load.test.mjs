import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createOperations } from '../lib/core.js';
import { loadHandbook } from '../lib/handbook-load.js';

function pages(text) {
  return async ({path,offset,limit}) => ({path,offset,limit,total:text.length,content:text.slice(offset,offset+limit),nextOffset:offset+limit<text.length?offset+limit:null});
}

test('the actual long style handbook loads completely without inserted newlines or split table/code text', async () => {
  const ops = createOperations();
  const path = 'references/design-styles.md';
  const expected = await readFile(new URL('../upstream/references/design-styles.md', import.meta.url), 'utf8');
  let pageCount = 0;
  const doc = await loadHandbook(async args=>{pageCount++;return ops.operation('read',args);},path);
  assert.ok(pageCount > 1);
  assert.equal(doc.content, expected);
  assert.equal(doc.nextOffset, null);
  assert.equal(doc.total, expected.length);
});

test('bounded loading can append across Markdown fence, table and surrogate boundaries without altering text', async () => {
  const text = '# Handbook\n'+'x'.repeat(15980)+'\n```js\nconst message = "完整文本😀";\n```\n| A | B |\n|---|---|\n| 1 | 2 |\n'+'end'.repeat(6000);
  const first = await loadHandbook(pages(text),'references/example.md',{maxPages:1});
  assert.equal(first.content, text.slice(0,16000));
  assert.equal(first.nextOffset, 16000);
  const combined = await loadHandbook(pages(text),'references/example.md',{previous:first});
  assert.equal(combined.content, text);
  assert.equal(combined.nextOffset, null);
  assert.equal(first.content.length,16000,'previous snapshot stays unchanged');
});

test('cancelled handbook reads cannot publish a late result', async () => {
  const controller = new AbortController();
  const read = async args=>{controller.abort();return pages('late result')(args);};
  await assert.rejects(loadHandbook(read,'SKILL.md',{signal:controller.signal}), error=>error.name==='AbortError');
});

test('changed documents, wrong page offsets and non-advancing pagination fail explicitly', async () => {
  const previous={path:'SKILL.md',content:'abc',nextOffset:3,total:20};
  await assert.rejects(loadHandbook(async args=>({...args,content:'def',total:21,nextOffset:6}),'SKILL.md',{previous}),/changed/);
  await assert.rejects(loadHandbook(async args=>({...args,offset:5,content:'a',total:6,nextOffset:null}),'SKILL.md'),/changed/);
  await assert.rejects(loadHandbook(async args=>({...args,content:'',total:20,nextOffset:0}),'SKILL.md'),/advance/);
});
