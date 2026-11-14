import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { highlight, highlightedText, highlightLanguage } from '../lib/highlight.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// The reader renders handbook fences as React elements, so highlighting must never
// change the characters: a reader copies code out of this view verbatim. Every test
// below therefore compares the concatenated segments against the original input.

test('highlighting is lossless for every supported language', () => {
  const samples = {
    js: 'const a=`x${1}`;\n// note\nfunction f(b){return b+1e3}\n/* block */\n',
    bash: '#!/bin/sh\n# note\nif [ -f "$X" ]; then echo "${Y}" --flag; fi\n',
    css: '.a::after{content:"x";--v:1}\n/* c */\n@media (min-width:2rem){}\n',
    html: '<div class="a" id=\'b\'><span>t &amp; u</span><!-- c --></div>',
    markdown: '# T\n\n**b** *i* `c` [l](x)\n- item\n> q\n',
  }
  for (const [lang, code] of Object.entries(samples)) {
    const segs = highlight(code, lang)
    assert.equal(highlightedText(segs), code, lang + ' round-trips byte for byte')
    assert.ok(segs.length > 0, lang + ' produces segments')
  }
})

test('unknown or missing languages fall back to one plain segment', () => {
  const code = 'plain <b>text</b> & stuff'
  for (const lang of ['', 'nosuchlang', undefined, null]) {
    const segs = highlight(code, lang)
    assert.deepEqual(segs, [{ text: code, kind: 'plain' }])
  }
})

test('language aliases resolve to the supported tokenizers', () => {
  assert.equal(highlightLanguage('js'), 'js')
  assert.equal(highlightLanguage('jsx'), 'js')
  assert.equal(highlightLanguage('ts'), 'js')
  assert.equal(highlightLanguage('javascript'), 'js')
  assert.equal(highlightLanguage('sh'), 'bash')
  assert.equal(highlightLanguage('scss'), 'css')
  assert.equal(highlightLanguage('HTML'), 'html')
  assert.equal(highlightLanguage('js title=x'), 'js')
  assert.equal(highlightLanguage('python'), 'python')
  assert.equal(highlightLanguage('py'), 'python')
  assert.equal(highlightLanguage(''), '')
  assert.equal(highlightLanguage('ruby'), '')
})

test('python fences in the handbook get real tokens', () => {
  // The handbook's python fences are Playwright snippets.
  const code = "page = browser.new_page(device_scale_factor=2)  # retina\nUA = 'x'\n"
  const segs = highlight(code, 'python')
  assert.equal(highlightedText(segs), code, 'python round-trips byte for byte')
  const kinds = segs.map(s => s.kind)
  assert.ok(kinds.includes('comment'), 'python comment detected')
  assert.ok(kinds.includes('string'), 'python string detected')
  assert.ok(kinds.includes('word') || kinds.includes('property'), 'identifiers tokenized')
  assert.ok(!kinds.every(k => k === 'plain'), 'python is not a passthrough')
})

test('empty input yields no segments instead of a stray token', () => {
  assert.deepEqual(highlight('', 'js'), [])
  assert.deepEqual(highlight(null, 'js'), [])
})

test('tokens classify the constructs the handbook actually uses', () => {
  const js = highlight('const x = "s" // c\n', 'js')
  const kinds = js.map(s => s.kind)
  assert.ok(kinds.includes('keyword'), 'keyword detected')
  assert.ok(kinds.includes('string'), 'string detected')
  assert.ok(kinds.includes('comment'), 'comment detected')

  const css = highlight('.a{color:red}', 'css')
  assert.ok(css.some(s => s.kind === 'selector' && s.text === '.a'), 'css selector detected')

  const html = highlight('<div class="x">t</div>', 'html')
  assert.ok(html.some(s => s.kind === 'tag'), 'html tag detected')
  assert.ok(html.some(s => s.kind === 'string' && s.text.includes('"x"')), 'attribute value detected')
})

test('every real handbook fence highlights without changing text', async () => {
  const files = []
  await (async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(p)
      else if (entry.name.endsWith('.md')) files.push(p)
    }
  })(path.join(ROOT, 'upstream'))

  assert.ok(files.length > 0, 'handbook sources are present')
  let fences = 0
  for (const file of files) {
    const md = await fs.readFile(file, 'utf8')
    const re = /^```([^\n]*)\n([\s\S]*?)^```/gm
    let match
    while ((match = re.exec(md))) {
      fences++
      const lang = match[1].trim().split(/\s+/)[0]
      const code = match[2]
      assert.equal(highlightedText(highlight(code, lang)), code, `${path.basename(file)} fence ${lang || '(plain)'}`)
    }
  }
  assert.ok(fences > 200, 'scanned a meaningful number of fences, got ' + fences)
})

test('the renderer wraps segments instead of emitting HTML', async () => {
  const source = await fs.readFile(path.join(ROOT, 'src/client.js'), 'utf8')
  assert.match(source, /function highlightSegments\(text,lang\)/, 'renderer helper exists')
  assert.match(source, /h\('span',\{key:index,className:'hs-tok-'\+segment\.kind\}/, 'segments become spans')
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/, 'no raw HTML injection path')
  // A token class must exist for every kind the tokenizers can emit. `plain` is
  // deliberately excluded: it renders as bare text with no wrapper, which is what
  // keeps unsupported languages byte-identical to the fence source.
  const kinds = new Set()
  for (const code of ['const a=1', 'x', '<a b="c">', '.a{b:c}', '# h', 'echo $X --f']) {
    for (const lang of ['js', 'html', 'css', 'markdown', 'bash']) {
      for (const seg of highlight(code, lang)) if (seg.kind !== 'plain') kinds.add(seg.kind)
    }
  }
  assert.ok(kinds.size >= 10, 'exercise a broad set of token kinds, got ' + kinds.size)
  for (const kind of kinds) {
    assert.match(source, new RegExp('\\.hs-design \\.hs-tok-' + kind + '\\{'), 'style exists for token kind ' + kind)
  }
})

test('every language declared anywhere in the handbook has a tokenizer', async () => {
  // Guard against silent coverage loss: if a future handbook adds a fence language
  // we do not support, that content renders unstyled and nobody notices.
  const files = []
  await (async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(p)
      else if (entry.name.endsWith('.md')) files.push(p)
    }
  })(path.join(ROOT, 'upstream'))

  const declared = new Set()
  for (const file of files) {
    const md = await fs.readFile(file, 'utf8')
    const re = /^```([^\n]*)$/gm
    let match
    while ((match = re.exec(md))) {
      const lang = match[1].trim().split(/\s+/)[0]
      if (lang) declared.add(lang)
    }
  }
  assert.ok(declared.size >= 5, 'found declared languages, got ' + declared.size)

  const unsupported = [...declared].filter(lang => !highlightLanguage(lang))
  assert.deepEqual(unsupported, [], 'every declared fence language must tokenize; unsupported: ' + unsupported.join(', '))
})
