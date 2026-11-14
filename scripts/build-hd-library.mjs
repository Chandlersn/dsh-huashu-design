import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'upstream/assets');
const WORK = path.join(ROOT, '.hd-work');
const STAGE = path.join(WORK, 'images');
const REPORT = path.join(ROOT, 'quality-report');
const EDGE = process.env.HD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PYTHON = process.env.HD_PYTHON || 'D:/Python312/python.exe';
const SCALE = 4;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2] || 'sample';
const force = process.argv.includes('--force');
const selected = process.argv.slice(3).filter(value => value !== '--force');
const knownSamples = [
  'style-specimens/web/03-memphis-maximalism.jpg',
  'style-specimens/info/20-swiss-grid-report.jpg',
  'style-specimens/app/08-command-palette.jpg',
  'style-specimens/xhs/01-specimen-journal.jpg',
  'showcases/website-saas/saas-build.png',
];

function runPython(script, ...args) {
  const result = spawnSync(PYTHON, ['-c', script, ...args], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Python verification exited ${result.status}`);
}
async function exists(file) { try { return (await fs.stat(file)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function safeFile(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '..' || p === '.')) throw new Error('Unsafe relative path');
  const canonicalRoot = await fs.realpath(root);
  const absolute = path.resolve(root, relative);
  const real = await fs.realpath(absolute);
  if (!real.startsWith(canonicalRoot + path.sep) || !(await fs.stat(real)).isFile()) throw new Error(`Unsafe file ${absolute}`);
  return real;
}
async function baseline() {
  await fs.mkdir(WORK, { recursive: true });
  const file = path.join(WORK, 'baseline.json');
  if (!(await exists(file))) {
    runPython(`from pathlib import Path
from PIL import Image
import json,hashlib,sys
root=Path(sys.argv[1]);out=Path(sys.argv[2]);rows=[]
for p in sorted(root.rglob('*')):
 if p.suffix.lower() not in ['.jpg','.jpeg','.png','.webp']:continue
 with Image.open(p) as im:
  im.load();w,h=im.size
 kind='sticker' if '/stickers/' in p.as_posix() else 'sheet' if p.name.startswith('sheet-') else 'showcase' if '/showcases/' in p.as_posix() else 'specimen'
 rows.append(dict(path=p.relative_to(root).as_posix(),width=w,height=h,bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),kind=kind))
out.write_text(json.dumps(dict(schemaVersion=1,assets=rows),ensure_ascii=False,indent=2),encoding='utf-8')
print('BASELINE',len(rows),'images',sum(x['bytes'] for x in rows),'bytes')`, ASSETS, file);
  }
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
function viewportFor(item) {
  if (item.kind === 'specimen') return { width: 1200, height: 750 };
  const group = item.path.split('/')[1];
  if (group === 'cover') return { width: 1200, height: 510 };
  if (group === 'ppt') return { width: 1920, height: 1080 };
  if (group === 'infographic') return { width: 1080, height: 1920 };
  if (item.kind === 'showcase') return { width: 1440, height: 900 };
  throw new Error(`No CSS viewport for ${item.path}`);
}
async function sourceFor(item) {
  const src = item.path.replace(/\.(jpg|jpeg|png)$/i, '.html');
  return safeFile(ASSETS, src);
}
async function renderItems(items) {
  await fs.mkdir(STAGE, { recursive: true });
  await fs.mkdir(REPORT, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  const context = await browser.newContext({ deviceScaleFactor: SCALE, reducedMotion: 'reduce' });
  await context.route('**/style-specimens/xhs/_kit/stickers/*.webp', async route => {
    const filename = path.basename(decodeURIComponent(new URL(route.request().url()).pathname));
    const relative = `style-specimens/xhs/_kit/stickers/${filename}`;
    if (await exists(path.join(STAGE, relative))) await route.fulfill({ path: await safeFile(STAGE, relative), contentType: 'image/webp' });
    else await route.continue();
  });
  const results = [];
  try {
    for (const item of items) {
      const output = path.join(STAGE, item.path);
      if (!force && await exists(output)) { console.log('STAGED', item.path); continue; }
      const viewport = viewportFor(item);
      const page = await context.newPage();
      await page.setViewportSize(viewport);
      // Resize the backing store before the source draws. DPR alone cannot add
      // detail to the deterministic canvas in the computational-portrait specimen.
      await page.addInitScript(scale => {
        const original = HTMLCanvasElement.prototype.getContext;
        const prepared = new WeakSet();
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          if (type === '2d' && !prepared.has(this)) {
            const w = this.width, h = this.height;
            this.style.width = `${w}px`; this.style.height = `${h}px`;
            this.width = w * scale; this.height = h * scale;
            const ctx = original.call(this, type, ...args);
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
            prepared.add(this);
            return ctx;
          }
          return original.call(this, type, ...args);
        };
      }, SCALE);
      const errors = [], failedRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('requestfailed', req => failedRequests.push({ url: req.url(), error: req.failure()?.errorText }));
      try {
        const src = await sourceFor(item);
        await page.goto(pathToFileURL(src).href, { waitUntil: 'load', timeout: 60000 });
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(async () => {
          await Promise.all([...document.images].map(im => im.decode()));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const checks = await page.evaluate(() => ({
          dpr: devicePixelRatio,
          textLength: document.body.innerText.trim().length,
          fonts: [...document.fonts].map(f => ({ family: f.family, weight: f.weight, status: f.status })),
          images: [...document.images].map(im => ({ src: im.getAttribute('src'), loaded: im.complete && im.naturalWidth > 0, width: im.naturalWidth, height: im.naturalHeight })),
          unresolvedIcons: document.querySelectorAll('i[data-lucide]').length,
          canvas: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height, cssWidth: c.clientWidth, cssHeight: c.clientHeight })),
        }));
        if (checks.dpr !== SCALE || !checks.textLength || checks.images.some(i => !i.loaded) || checks.unresolvedIcons || checks.canvas.some(c => c.width < c.cssWidth * SCALE || c.height < c.cssHeight * SCALE) || errors.length) throw new Error(`Render content failed: ${JSON.stringify({ checks, errors, failedRequests })}`);
        if (failedRequests.length || checks.fonts.some(f => f.status === 'error')) throw new Error(`Dependencies failed: ${JSON.stringify({ failedRequests, fonts: checks.fonts.filter(f => f.status === 'error') })}`);
        if (item.path.startsWith('style-specimens/xhs/') && checks.images.some(i => i.src.includes('/stickers/') && Math.max(i.width, i.height) !== 1070)) throw new Error('XHS preview still loaded a low-resolution sticker');
        await fs.mkdir(path.dirname(output), { recursive: true });
        await page.screenshot({ path: output, type: item.path.endsWith('.png') ? 'png' : 'jpeg', ...(item.path.endsWith('.png') ? {} : { quality: 98 }), animations: 'disabled', scale: 'device' });
        const entry = { path: item.path, method: 'source-rerender', source: path.relative(ROOT, src).split(path.sep).join('/'), cssWidth: viewport.width, cssHeight: viewport.height, scale: SCALE, checks, sha256: hash(await fs.readFile(output)) };
        results.push(entry);
        await fs.appendFile(path.join(WORK, 'renders.jsonl'), JSON.stringify(entry) + '\n');
        console.log('RENDERED', item.path, `${viewport.width * SCALE}x${viewport.height * SCALE}`, 'fonts', checks.fonts.filter(f => f.status === 'loaded').length);
      } catch (error) {
        results.push({ path: item.path, error: error.message });
        console.error('FAILED', item.path, error.message);
        await fs.appendFile(path.join(WORK, 'failures.jsonl'), JSON.stringify({ path: item.path, error: error.message, time: new Date().toISOString() }) + '\n');
      } finally { await page.close(); }
    }
  } finally { await context.close(); await browser.close(); }
  if (results.some(r => r.error)) process.exitCode = 1;
}
async function renderSheets(data) {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    for (const item of data.assets.filter(i => i.kind === 'sheet')) {
      const group = path.basename(item.path, '.jpg').replace('sheet-', '');
      const members = data.assets.filter(i => i.kind === 'specimen' && i.path.split('/')[1] === group);
      const cards = [];
      for (const m of members) {
        const src = await sourceFor(m);
        const title = (await fs.readFile(src, 'utf8')).match(/<title>([\s\S]*?)<\/title>/i)?.[1] || path.basename(m.path);
        const staged = await safeFile(STAGE, m.path);
        const url = `data:image/jpeg;base64,${(await fs.readFile(staged)).toString('base64')}`;
        cards.push(`<figure><img src="${url}"><figcaption>${title.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</figcaption></figure>`);
      }
      const page = await browser.newPage({ deviceScaleFactor: SCALE, viewport: { width: 1290, height: ({ app: 724, east: 724, xhs: 600 })[group] || 1186 } });
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#d9d9d6;font:600 15px/1.35 'Microsoft YaHei',sans-serif;color:#1a1a1a}.g{display:grid;grid-template-columns:repeat(4,300px);gap:18px 14px}figure{margin:0}img{width:300px;height:187px;display:block;box-shadow:0 0 0 1px rgba(0,0,0,.15)}figcaption{margin-top:6px}</style><div class="g">${cards.join('')}</div>`);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(im => im.decode())); });
      const output = path.join(STAGE, item.path);
      await page.screenshot({ path: output, fullPage: true, type: 'jpeg', quality: 98, scale: 'device' });
      console.log('SHEET', item.path, members.length);
      await page.close();
    }
  } finally { await browser.close(); }
}

const data = await baseline();
if (mode === 'inventory') console.log(JSON.stringify(data, null, 2));
else if (mode === 'probe') {
  const response = await fetch('http://127.0.0.1:3080/huashu-design/api/catalog');
  console.log('LIVE_CATALOG', response.status);
  await renderItems(data.assets.filter(i => knownSamples.includes(i.path)));
} else if (mode === 'sample') await renderItems(data.assets.filter(i => knownSamples.includes(i.path)));
else if (mode === 'render') await renderItems(data.assets.filter(i => ['specimen', 'showcase'].includes(i.kind) && (!selected.length || selected.some(s => i.path.includes(s)))));
else if (mode === 'sheets') await renderSheets(data);
else throw new Error(`Unknown mode ${mode}`);
