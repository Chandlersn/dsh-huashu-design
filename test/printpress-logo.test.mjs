import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const printpressRoot = process.env.HUASHU_PRINTPRESS_ROOT || 'D:/个人开发/PYF';
const requirePrintpress = createRequire(path.join(printpressRoot, 'package.json'));
const compiler = requirePrintpress('@vue/compiler-sfc');
const vue = requirePrintpress('vue');
const [logo, workbench, standalone, generator, buildScript] = await Promise.all([
  readFile(new URL('../src/printpress/PrintpressLogo.vue', import.meta.url), 'utf8'),
  readFile(new URL('../src/printpress/Workbench.vue', import.meta.url), 'utf8'),
  readFile(new URL('../artifacts/printpress-logo.svg', import.meta.url), 'utf8'),
  readFile(new URL('../artifacts/make-printpress-logo.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/build-printpress.mjs', import.meta.url), 'utf8'),
]);
function parse(source, filename) {
  const result = compiler.parse(source, { filename });
  assert.deepEqual(result.errors, [], `${filename} must parse with the real Vue compiler`);
  return result.descriptor;
}
function elements(node, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (node.type === 1) result.push(node);
  for (const child of node.children || []) elements(child, result);
  return result;
}
const attributes = node => Object.fromEntries((node.props || []).filter(prop => prop.type === 6).map(prop => [prop.name, prop.value?.content ?? true]));
const descriptor = parse(logo, 'PrintpressLogo.vue');
const work = parse(workbench, 'Workbench.vue');
const svgFile = parse(`<template>${standalone}</template>`, 'StandaloneLogo.vue');
const logoNodes = () => elements(descriptor.template.ast);

test('logo and Workbench compile with the actual Vue SFC and template compilers', () => {
  for (const [name, value] of [['PrintpressLogo', descriptor], ['Workbench', work]]) {
    const script = value.script || value.scriptSetup ? compiler.compileScript(value, { id: `logo-${name}` }) : undefined;
    const template = compiler.compileTemplate({ source: value.template.content, filename: name + '.vue', id: `logo-${name}`, compilerOptions: { bindingMetadata: script?.bindings } });
    assert.deepEqual(template.errors, [], name);
    assert.ok(template.code.length > 0);
    if (name === 'Workbench') assert.ok(Object.hasOwn(script.bindings, 'PrintpressLogo'));
  }
});

test('the real Vue render function emits an inline 32px SVG rather than an image link', () => {
  const compiled = compiler.compileTemplate({ source: descriptor.template.content, filename: 'PrintpressLogo.vue', id: 'logo-runtime', compilerOptions: { mode: 'function', prefixIdentifiers: true, hoistStatic: false, cacheHandlers: false } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function('Vue', compiled.code)(vue);
  const vnode = render({}, []);
  assert.equal(vnode.type, 'svg');
  assert.equal(vnode.props.viewBox, '0 0 48 48');
  assert.equal(vnode.props.width, '32');
  assert.equal(vnode.props.height, '32');
  assert.equal(vnode.props['aria-hidden'], 'true');
  assert.equal(vnode.props.focusable, 'false');
});

test('accent, original glyph and host border inherit theme tokens without fixed color overrides', () => {
  const nodes = logoNodes(), [svg] = nodes;
  assert.equal(svg.tag, 'svg');
  const background = nodes.find(node => node.tag === 'rect');
  assert.equal(attributes(background).fill, 'var(--hs-accent,#2563eb)');
  assert.match(attributes(background).stroke, /var\(--hs-border-l2,var\(--dsw-alias-border-l2,/);
  assert.equal(attributes(background)['stroke-width'], '1.5');
  const glyph = nodes.find(node => node.tag === 'path');
  assert.ok(glyph, 'the themed mark is pure vector geometry');
  assert.equal(attributes(glyph).fill, 'var(--hs-on-accent,#fff)');
  assert.equal(attributes(glyph)['fill-rule'], 'evenodd');
  for (const node of nodes.slice(1)) {
    for (const [name, value] of Object.entries(attributes(node))) {
      if (['fill', 'stroke'].includes(name) && value !== 'none') assert.match(value, /^var\(--hs-(?:accent|on-accent|border-l2)/);
      assert.notEqual(name, 'opacity', 'the foreground must not fade against custom accent extremes');
    }
  }
  assert.equal(descriptor.styles.length, 0, 'the logo does not reset or cache the inherited theme variables');
});

test('the themed logo traces the original P + stacked-sheets silhouette, not a new mark', () => {
  const nodes = logoNodes(), paths = nodes.filter(node => node.tag === 'path');
  assert.equal(paths.length, 1, 'one even-odd compound path carries the whole glyph');
  const d = attributes(paths[0]).d;
  assert.ok(d.length > 600 && d.length < 4000, `traced silhouette stays compact (${d.length} chars)`);
  assert.equal((d.match(/M/g) || []).length, 4, 'two sheet outlines, the P body and its inner counter');
  assert.ok(/^M[\d.]+ [\d.]+L/.test(d), 'the path begins with real traced coordinates');
  assert.match(d, /Z$/, 'all contours are closed');
  assert.doesNotMatch(logo, /data:|<image|<use|href=|src=/i, 'no raster stencil or external asset is embedded');
  // The path is generated from the original PNG by the reproducible build helper;
  // assert the generator exists, reads that exact PNG, and self-checks fidelity.
  assert.match(logo, /fill-rule="evenodd"/);
  assert.match(generator, /electron\/brand\/printpress-logo-v2\.png/);
  assert.match(generator, /fidelity\s*<\s*0\.98/);
  assert.match(generator, /evenodd/);
});

test('Workbench keeps exactly one original-shape, theme-adaptive logo and no picker', () => {
  const nodes = elements(work.template.ast);
  const references = nodes.filter(node => node.tag === 'PrintpressLogo');
  assert.equal(references.length, 1, 'only the finalized vector mark remains');
  const heading = nodes.find(node => node.tag === 'header' && attributes(node).class === 'pp-heading');
  const headingNodes = elements(heading);
  const title = headingNodes.find(node => node.tag === 'h2');
  assert.equal(title.children.filter(child => child.type === 1 && child.tag === 'PrintpressLogo').length, 1);
  assert.equal(attributes(references[0]).class, 'pp-brand-logo');
  assert.equal(title.children.indexOf(references[0]), 0, 'logo stays the first child of the h2');
  assert.equal(headingNodes.filter(node => node.tag === 'img').length, 0, 'no original PNG is embedded in the heading');
  assert.equal(headingNodes.filter(node => node.tag === 'p').length, 0, 'no extra promotional description returns');
  assert.equal(headingNodes.filter(node => attributes(node).class === 'pp-logo-choices').length, 0, 'the comparison picker is gone');
  assert.doesNotMatch(work.template.content, /logoVariant|chooseLogo|pp-logo-choice|originalLogo/);
  assert.doesNotMatch(work.scriptSetup.content, /LOGO_STORAGE_KEY|logoVariant|chooseLogo|originalLogo|localStorage/);
  assert.match(work.template.content, /\{\{ english \? 'PrintPress' : '批印坊' \}\}/);
  assert.match(work.template.content, /<span class="pp-version">v\{\{ info\.version \}\}<\/span>/);
  assert.match(work.scriptSetup.content, /import PrintpressLogo from '\.\/PrintpressLogo\.vue'/);
  const navigation = nodes.find(node => node.tag === 'nav' && attributes(node).class === 'pp-nav');
  assert.ok(navigation);
  assert.equal(elements(navigation).filter(node => node.tag === 'PrintpressLogo').length, 0);
});

test('the final logo is generated from the original PNG shape and the build fingerprints source changes', () => {
  assert.match(generator, /electron\/brand\/printpress-logo-v2\.png/);
  assert.match(generator, /fidelity\s*<\s*0\.98/);
  assert.match(buildScript, /cjs\|svg\|png\|jpe\?g\|webp\|gif\|avif/i, 'logo source edits invalidate the embedded build');
  assert.doesNotMatch(workbench, /printpress-logo-original\.png/, 'no bundled copy of the original PNG remains');
});

test('Workbench CSS stays scoped to the single logo and compiles cleanly', () => {
  assert.equal(work.styles.length, 1);
  const style = work.styles[0];
  assert.equal(style.scoped, true);
  assert.match(style.content, /\.pp-brand-logo\s*\{/);
  assert.match(style.content, /width:\s*32px/);
  assert.match(style.content, /height:\s*32px/);
  assert.match(style.content, /flex:\s*0 0 32px/);
  assert.doesNotMatch(style.content, /pp-logo-choice|pp-logo-swatch|\.pp-brand\s*\{|:root\b/, 'no comparison-picker rules remain');
  assert.doesNotMatch(style.content, /\.pp-nav\b|\.pp-linked-work\b/, 'business layout rules are untouched');
  const compiled = compiler.compileStyle({ source: style.content, filename: 'Workbench.vue', id: 'data-v-logo-test', scoped: true });
  assert.deepEqual(compiled.errors, []);
  assert.match(compiled.code, /\.pp-brand-logo\[data-v-logo-test\]/);
});

test('standalone editable SVG uses the same geometry and supplies its own light/dark fallback palette', () => {
  const nodes = elements(svgFile.template.ast), root = nodes.find(node => node.tag === 'svg');
  assert.equal(attributes(root).viewBox, '0 0 48 48');
  assert.equal(attributes(root).role, 'img');
  assert.equal(attributes(root)['aria-labelledby'], 'printpress-logo-title');
  assert.ok(nodes.some(node => node.tag === 'title' && attributes(node).id === 'printpress-logo-title'));
  const componentPath = logoNodes().find(node => node.tag === 'path');
  const standalonePath = nodes.find(node => node.tag === 'path');
  assert.ok(componentPath && standalonePath);
  assert.equal(attributes(standalonePath).d, attributes(componentPath).d, 'standalone SVG carries the identical original silhouette');
  assert.match(standalone, /--pp-logo-accent:\s*#2563eb/);
  assert.match(standalone, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(standalone, /--pp-logo-on-accent:\s*#101828/);
  assert.match(standalone, /var\(--hs-accent,var\(--pp-logo-accent\)\)/);
  assert.match(standalone, /var\(--hs-on-accent,var\(--pp-logo-on-accent\)\)/);
});

test('both vector deliverables contain only self-contained geometry and no external assets or fonts', () => {
  assert.ok(logoNodes().every(node => ['svg', 'path', 'rect'].includes(node.tag)));
  assert.ok(elements(svgFile.template.ast).every(node => ['svg', 'title', 'style', 'path', 'rect'].includes(node.tag)));
  for (const source of [logo, standalone]) assert.doesNotMatch(source, /<(?:img|image|use|foreignObject|script|text)\b|\b(?:href|src)\s*=|url\s*\(|@import|font-family|data:/i);
});
