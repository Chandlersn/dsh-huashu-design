import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { adaptDesignerView } from '../src/printpress/designer-adapter.js';
import { adaptPrintpressUI, adaptPhotoProcessingPanel, hostThemeValue } from '../src/printpress/ui-adapter.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The PrintPress source tree is not redistributed with this plugin. Point the
// build at your own local checkout; there is no machine-specific default.
if (!process.env.HUASHU_PRINTPRESS_ROOT) {
  throw new Error(
    'HUASHU_PRINTPRESS_ROOT is not set. Export it to your local PrintPress checkout ' +
    'before building the embedded panel (e.g. HUASHU_PRINTPRESS_ROOT=/path/to/printpress).'
  );
}
const printpressRoot = path.resolve(process.env.HUASHU_PRINTPRESS_ROOT);
if (!existsSync(path.join(printpressRoot, 'package.json'))) {
  throw new Error(`HUASHU_PRINTPRESS_ROOT does not look like a PrintPress checkout: ${printpressRoot}`);
}
const requirePrintpress = createRequire(path.join(printpressRoot, 'package.json'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function inputFiles(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await inputFiles(full));
    else if (/\.(?:vue|js|css|cjs|svg|png|jpe?g|webp|gif|avif|woff2?|ttf|otf)$/i.test(item.name) && !item.name.endsWith('.generated.js')) result.push(full);
  }
  return result;
}
const files = [...await inputFiles(path.join(printpressRoot, 'src')), ...await inputFiles(path.join(root, 'src/printpress')), path.join(printpressRoot, 'electron/preload.cjs'), path.join(printpressRoot, 'electron/api.cjs'), path.join(root, 'scripts/build-printpress.mjs')].sort();
const inputHash = createHash('sha256');
for (const file of files) inputHash.update(file).update(await readFile(file));
const inputsSha256 = inputHash.digest('hex');
if (process.argv.includes('--check')) {
  const built = JSON.parse(await readFile(path.join(root, 'lib/printpress-manifest.json'), 'utf8'));
  if (built.inputsSha256 !== inputsSha256 || built.embeddedSha256 !== digest(await readFile(path.join(root, 'dist/printpress/embedded.js'))) || built.cssSha256 !== digest(await readFile(path.join(root, 'dist/printpress/style.css')))) throw new Error('Embedded PrintPress artifact is stale. Run npm run build.');
  console.log('Embedded PrintPress matches the actual domain, UI and adapter source.');
  process.exit(0);
}
const { build } = await import(pathToFileURL(path.join(path.dirname(requirePrintpress.resolve('vite/package.json')), 'dist/node/index.js')));
const { default: vue } = await import(pathToFileURL(requirePrintpress.resolve('@vitejs/plugin-vue')));
const preload = await readFile(path.join(printpressRoot, 'electron/preload.cjs'), 'utf8');
const match = preload.match(/contextBridge\.exposeInMainWorld\('printpress',\s*(\{[\s\S]*\})\s*\)\s*$/);
if (!match) throw new Error('PrintPress preload contract changed; recheck the browser adapter.');
await mkdir(path.join(root, 'src/printpress'), { recursive: true });
await writeFile(path.join(root, 'src/printpress/preload.generated.js'), '// Generated from the actual PrintPress preload whitelist.\nexport function bindPreload(invoke, ipcRenderer) { return ' + match[1] + '; }\n');
const scopeImport = `import { ppWindow as window, ppDocument as document } from ${JSON.stringify(path.join(root, 'src/printpress/scope.js').replaceAll('\\', '/'))};\n`;
const sourcePrefix = path.join(printpressRoot, 'src').replaceAll('\\', '/') + '/';
const scoping = {
  postcssPlugin: 'huashu-printpress-scope',
  Rule(rule) {
    if (/keyframes$/i.test(rule.parent?.name || '')) return;
    rule.selectors = rule.selectors.map(selector => selector.startsWith('.hs-printpress') ? selector : '.hs-printpress ' + selector);
  },
  Declaration(declaration) {
    declaration.value = hostThemeValue(declaration.prop, declaration.value, declaration.parent?.selector || '');
  }
};
await build({
  configFile: false,
  root,
  logLevel: 'warn',
  plugins: [{
    name: 'huashu-printpress-adapter', enforce: 'pre',
    transform(input, id) {
      const normalized = id.replaceAll('\\', '/');
      if (!normalized.startsWith(sourcePrefix) || normalized.includes('?')) return;
      let code = adaptPrintpressUI(input, normalized).replaceAll('pp://media/', '/huashu-design/printpress/media/').replaceAll('<Teleport to="body">', '<Teleport to="#hs-printpress-portal">');
      if (normalized.endsWith('/components/PhotoProcessingPanel.vue')) code = adaptPhotoProcessingPanel(code);
      if (normalized.endsWith('/views/DatasetView.vue')) {
        const oldDrop = /function onDrop\(e\) \{\s*dragDepth\.value = 0\s*const file = \[\.\.\.\(e\.dataTransfer\?\.files \|\| \[\]\)\]\.find\(\(f\) => f\.path\)\s*if \(!file\) return\s*importFromPath\(file\.path\)[^\n]*\n\}/;
        if (!oldDrop.test(code)) throw new Error('PrintPress dataset drop handler changed; update the browser upload adapter.');
        code = code.replace(oldDrop, `async function onDrop(e) {\n  dragDepth.value = 0\n  const file = [...(e.dataTransfer?.files || [])][0]\n  if (!file) return\n  errorMsg.value = ''\n  try { const staged = await window.printpress.stageFile(file); await importFromPath(staged.filePath) } catch (err) { errorMsg.value = extractError(err) }\n}`);
      }
      if (normalized.endsWith('/views/BackgroundDesignerView.vue')) code = adaptDesignerView(code);
      if (normalized.endsWith('.vue')) code = code.replace(/<script(\s+setup)?\s*>/, value => value + '\n' + scopeImport);
      else if (normalized.endsWith('.js') && /\b(?:window|document)\b/.test(code)) code = scopeImport + code;
      return { code, map: null };
    }
  }, vue()],
  resolve: { alias: { '@printpress': path.join(printpressRoot, 'src'), '@printpress-domain': path.join(printpressRoot, 'electron'), vue: requirePrintpress.resolve('vue/dist/vue.runtime.esm-bundler.js') }, dedupe: ['vue'] },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  css: { postcss: { plugins: [scoping] } },
  build: {
    outDir: path.join(root, 'dist/printpress'), emptyOutDir: true,
    lib: { entry: path.join(root, 'src/printpress/mount.js'), formats: ['es'], fileName: () => 'embedded.js', cssFileName: 'style' },
    commonjsOptions: { include: [/node_modules/, new RegExp(
      '[' + '\\\\' + '/]' + printpressRoot.split(/[\\/]/).pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '[' + '\\\\' + '/](?:src|electron)[' + '\\\\' + '/].*\\.cjs$', 'i')] },
    assetsInlineLimit: Infinity, minify: false, target: 'es2022'
  }
});
const vueLicense = await readFile(path.join(path.dirname(requirePrintpress.resolve('vue/package.json')), 'LICENSE'));
await writeFile(path.join(root, 'dist/printpress/Vue-LICENSE.txt'), vueLicense);
const pkg = JSON.parse(await readFile(path.join(printpressRoot, 'package.json'), 'utf8'));
const metadataRoot = await mkdtemp(path.join(os.tmpdir(), 'huashu-printpress-build-'));
try {
  // Domain modules need a data-root at import time. Metadata extraction must never
  // inherit a production data directory or an external original-asset pool.
  process.env.PRINTPRESS_DATA_DIR = metadataRoot;
  delete process.env.PRINTPRESS_ASSET_DIR;
  const api = requirePrintpress('./electron/api.cjs');
  // No sourceRoot: the manifest ships inside the package and must not leak the
  // absolute path of whatever local checkout built it.
  const manifest = { name: pkg.name, version: pkg.version, preloadSha256: digest(preload), inputsSha256, embeddedSha256: digest(await readFile(path.join(root, 'dist/printpress/embedded.js'))), cssSha256: digest(await readFile(path.join(root, 'dist/printpress/style.css'))), operations: api.describe() };
  await writeFile(path.join(root, 'lib/printpress-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Built embedded PrintPress ${pkg.version}; ${manifest.operations.length} operations from the actual API.`);
} finally {
  if (path.dirname(metadataRoot) !== path.resolve(os.tmpdir()) || !path.basename(metadataRoot).startsWith('huashu-printpress-build-')) throw new Error('Unexpected metadata temporary directory.');
  await rm(metadataRoot, { recursive: true, force: true });
}
