import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The handbook is mostly fenced code, so its block chrome is a reading surface in
// its own right: readers copy single snippets out of it constantly. These checks
// pin the parts a regression would silently drop (the copy affordance, the language
// label staying attached to its block, and the styles that keep long lines readable).
const read = name => fs.readFile(path.join(ROOT, name), 'utf8')

test('handbook code blocks expose a per-block copy control with its own state', async () => {
  const source = await read('src/client.js')
  const start = source.indexOf("case 'code':")
  const end = source.indexOf("case 'html':", start)
  assert.ok(start > 0 && end > start, 'code block case is locatable')
  const block = source.slice(start, end)

  // Assert the rendered tree, not merely that a class name appears somewhere:
  // a span with the same class would satisfy a substring check but break clicking.
  assert.match(block, /h\('button',\{[^}]*className:'hs-doc-code-copy'/, 'copy control is a real button element')
  assert.match(block, /onClick:\(\)=>copyBlock\(id,text\)/, 'copy control is wired to the per-block handler')
  assert.match(block, /'data-copied':/, 'copied state is reflected on the control')
  assert.match(block, /token\.lang/, 'language label is derived from the fence info string')
  assert.match(block, /token\.text/, 'the copied payload is the raw fenced text')

  // The handler must be defined and scoped per block, not reuse the document copy.
  assert.match(source, /async function copyBlock\(id,text\)/, 'per-block copy handler exists')
  assert.match(source, /setCopiedBlock\(id\)/, 'handler records which block was copied')
  assert.match(source, /const \[copiedBlock,setCopiedBlock\]=React\.useState/, 'copied state is component state')
})

test('code block styles keep long lines scrollable and the copy control reachable', async () => {
  const source = await read('src/client.js')
  assert.match(source, /\.hs-design \.hs-doc-code-head\{[^}]*display:flex/, 'head row lays out label and action')
  assert.match(source, /\.hs-design \.hs-doc-code-copy\{[^}]*min-height:/, 'copy control keeps a usable hit target')
  assert.match(source, /\.hs-design \.hs-doc-code-copy\[data-copied=true\]/, 'copied state has a visible style')
  // Overflow rules must stay on the shared pre rule so fences do not wrap mid-token.
  assert.match(source, /\.hs-design \.hs-prose pre\{[^}]*overflow:auto/, 'code areas scroll instead of wrapping')
})

test('both locales define the copy strings used by the block chrome', async () => {
  const source = await read('src/client.js')
  for (const key of ['docCodeCopy', 'docCodeCopied']) {
    const occurrences = source.match(new RegExp(key + ":", 'g')) || []
    assert.ok(occurrences.length >= 2, key + ' is defined for both locales')
  }
})
