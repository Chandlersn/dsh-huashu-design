import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { THEME_STORAGE_KEY, THEME_PRESETS, DEFAULT_THEME, normalizeColor, normalizeTheme, readThemePreference, saveThemePreference, themeVariables, readableForeground, contrastRatio } from '../src/themes.js';
import { hostThemeValue } from '../src/printpress/ui-adapter.js';

function memoryStorage() {
  const values = new Map([['unrelated-user-setting', 'keep']]);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('new users get a colorful default and six distinct preset accents', () => {
  assert.equal(THEME_PRESETS.length, 6);
  assert.equal(new Set(THEME_PRESETS.map(item => item.color)).size, 6);
  assert.deepEqual(readThemePreference(memoryStorage()), DEFAULT_THEME);
  const variables = themeVariables(DEFAULT_THEME);
  assert.equal(variables['--hs-accent'], THEME_PRESETS[0].color);
  assert.notEqual(variables['--hs-accent'], '#000000');
});

test('theme and custom accent persist under one safe key without changing other settings', () => {
  const storage = memoryStorage();
  for (const themeId of [...THEME_PRESETS.map(item => item.id), 'host', 'custom']) {
    assert.equal(saveThemePreference({ themeId, customColor: '#ffff00' }, storage), true);
    assert.deepEqual(readThemePreference(storage), { themeId, customColor: '#ffff00' });
  }
  assert.equal(storage.values.get('unrelated-user-setting'), 'keep');
  assert.deepEqual([...storage.values.keys()].sort(), [THEME_STORAGE_KEY, 'unrelated-user-setting'].sort());
  storage.values.set(THEME_STORAGE_KEY, '{broken JSON');
  assert.deepEqual(readThemePreference(storage), DEFAULT_THEME);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readThemePreference(blocked), DEFAULT_THEME);
  assert.equal(saveThemePreference({ themeId: 'rose' }, blocked), false);
  assert.deepEqual(normalizeTheme({ themeId: '__proto__', customColor: 'red; background: url(evil)' }), DEFAULT_THEME);
});

test('black or white primary text meets WCAG AA for all presets, extremes and sampled custom colors', () => {
  const colors = [...THEME_PRESETS.map(item => item.color), '#ffff00', '#ffffff', '#000000', '#00ffff', '#ff00ff'];
  const samples = [0, 32, 64, 96, 128, 160, 192, 224, 255];
  for (const r of samples) for (const g of samples) for (const b of samples) colors.push('#' + [r, g, b].map(value => value.toString(16).padStart(2, '0')).join(''));
  for (const color of colors) {
    const foreground = readableForeground(color);
    assert.ok(['#000000', '#ffffff'].includes(foreground));
    assert.ok(contrastRatio(color, foreground) >= 4.5, color);
    assert.equal(themeVariables({ themeId: 'custom', customColor: color })['--hs-on-accent'], foreground);
  }
  assert.equal(readableForeground('#ffff00'), '#000000');
  assert.equal(readableForeground('#000000'), '#ffffff');
});

test('host accent resolves actual computed colors and every emitted variable stays inside Huashu', () => {
  assert.equal(normalizeColor('rgb(25, 160, 90)'), '#19a05a');
  assert.equal(normalizeColor('color(srgb 1 0.5 0)'), '#ff8000');
  assert.equal(normalizeColor('#abc'), '#aabbcc');
  assert.equal(themeVariables({ themeId: 'host' }, 'rgb(255, 255, 0)')['--hs-on-accent'], '#000000');
  for (const themeId of [...THEME_PRESETS.map(item => item.id), 'host', 'custom']) {
    const variables = themeVariables({ themeId, customColor: '#ffc800' }, '#0d9488');
    assert.ok(Object.keys(variables).every(key => key.startsWith('--hs-')));
    assert.ok(!Object.keys(variables).some(key => key.startsWith('--dsw-')));
    for (const key of ['--hs-bg-base', '--hs-bg-layer-1', '--hs-bg-layer-2', '--hs-border-l1', '--hs-border-l2']) {
      assert.match(variables[key], /var\(--dsw-alias-/);
      assert.match(variables[key], /var\(--hs-accent\)/);
    }
  }
  assert.match(hostThemeValue('background', 'var(--cinnabar)', '.btn-primary[data-v-ui]'), /--hs-accent,/);
  assert.equal(hostThemeValue('background', 'var(--cinnabar, #b03a2e)', 'button.primary[data-v-ui]'), 'var(--hs-accent,var(--dsw-alias-brand-primary))');
  assert.match(hostThemeValue('color', '#fff', '.btn-primary[data-v-ui]'), /--hs-on-accent/);
  assert.equal(hostThemeValue('opacity', '.9', '.btn-primary:hover:not(:disabled)[data-v-ui]'), '1');
  assert.equal(hostThemeValue('opacity', '.5', '.btn-primary:disabled[data-v-ui]'), '.5');
  assert.equal(hostThemeValue('filter', 'brightness(1.07)', 'button.primary:hover:not(:disabled)[data-v-ui]'), 'none');
  assert.equal(hostThemeValue('background', '#fff', '.design-stage[data-v-ui]'), '#fff');
});

test('palette changes keep the mounted editor instance and current callbacks', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('function PrintpressPanel('), end = source.indexOf('function Panel()', start);
  const hooks = [], pending = [];
  let cursor = 0, mounts = 0, disposals = 0, lastEvent, locale;
  const React = {
    useRef(value) { const index = cursor++; return hooks[index] ||= { current: value }; },
    useState(value) { const index = cursor++; if (!(index in hooks)) hooks[index] = value; return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }]; },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = hooks[index];
      if (!previous || dependencies.some((value, offset) => !Object.is(value, previous.dependencies[offset]))) pending.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
    }
  };
  const mountPrintpress = async (_element, options) => {
    mounts++; lastEvent = options.onEvent;
    const cleanup = () => { disposals++; };
    cleanup.setLocale = value => { locale = value; };
    return cleanup;
  };
  const Panel = new Function('React', 'mountPrintpress', 'h', 'printpressCSS', 't', source.slice(start, end) + ';return PrintpressPanel;')(React, mountPrintpress, (...args) => args, '', key => key);
  const render = async props => { cursor = 0; Panel(props); while (pending.length) pending.shift()(); await Promise.resolve(); await Promise.resolve(); };
  let received = '';
  await render({ locale: 'zh', onEvent: () => { received = 'first'; } });
  for (const themeId of THEME_PRESETS.map(item => item.id)) {
    themeVariables({ themeId });
    await render({ locale: 'zh', onEvent: () => { received = themeId; } });
  }
  await render({ locale: 'en', onEvent: () => { received = 'latest'; } });
  lastEvent({ event: 'workbench:published', payload: {} });
  assert.equal(mounts, 1);
  assert.equal(disposals, 0);
  assert.equal(locale, 'en');
  assert.equal(received, 'latest');
  assert.match(source, /style:paletteVars,'data-palette':themeId/);
  assert.match(source, /h\(PrintpressPanel,\{locale:locale.active,onEvent:onWorkbenchEvent\}\)/);
  assert.doesNotMatch(source, /document\.(?:documentElement|body)\.style\.(?:setProperty|cssText)/);
});

test('client build fingerprints every bundled source input including the imported theme module', async () => {
  const [client, script] = await Promise.all([
    readFile(new URL('../src/client.js', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8')
  ]);
  assert.match(client, /from '\.\/themes\.js'/);
  assert.match(script, /Object.keys\(result.metafile.inputs\)/);
  assert.match(script, /inputHash.update\(input\).update\(await readFile\(path.resolve\(root, input\)\)\)/);
  assert.match(script, /Source inputs SHA-256/);
});

test('the upstream attribution footer is removed so the page keeps its space', async () => {
  const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /className:'hs-footer'/, 'no standalone upstream footer element');
  assert.doesNotMatch(client, /\.hs-design \.hs-footer(?![\w-])/, 'no upstream footer CSS rules');
  assert.doesNotMatch(client, /license:'MIT|鸟类演示贴纸另有许可|bird demo stickers/, 'no orphaned license copy');
  assert.doesNotMatch(client, /t\('license'\)|catalog\?\.manifest\?\.version\|\|'3\.3\.0'/, 'no footer version/lookup');
  assert.match(client, /hs-reader-footer/, 'the handbook pagination footer is a different control and stays');
});
