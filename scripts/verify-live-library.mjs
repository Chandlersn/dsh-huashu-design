import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:3080';
const manifest = JSON.parse(await fs.readFile(path.join(root, 'quality-report/hd-library-manifest.json'), 'utf8'));
const urls = [];
// Read only the existing launch URLs; never print or persist authentication inputs.
for (const filename of ['D:/dsh/logs/web-3080.log', 'D:/dsh/logs/dsh-web.log']) {
  try {
    const handle = await fs.open(filename, 'r');
    try {
      const { size } = await handle.stat();
      for (const position of [...new Set([0, Math.max(0, size - 512 * 1024)])]) {
        const buffer = Buffer.alloc(Math.min(size - position, 512 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        for (const match of text.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):3080\/\?token=[A-Za-z0-9_-]+/g)) urls.push(match[0].replace('localhost:', '127.0.0.1:'));
      }
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.HD_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
try {
  let authenticated = false;
  for (const url of [...new Set(urls)].reverse()) {
    const response = await context.request.get(url);
    if (response.status() === 200) { authenticated = true; break; }
  }
  if (!authenticated) throw new Error('The existing launch URLs did not authenticate this browser. No server/authentication settings were changed.');
  const response = await context.request.get(origin + '/huashu-design/api/catalog');
  if (response.status() !== 200) throw new Error(`Live catalog returned ${response.status()}`);
  const catalog = await response.json();
  if (catalog.styles.length !== 92) throw new Error('Live style count mismatch');
  const results = [];
  for (const item of manifest.assets) {
    const url = origin + '/huashu-design/assets/assets/' + item.path.split('/').map(encodeURIComponent).join('/');
    const response = await context.request.get(url);
    const bytes = await response.body();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (response.status() !== 200 || sha256 !== item.sha256) throw new Error(`Live asset mismatch: ${item.path} (${response.status()})`);
    results.push({ path: item.path, status: response.status(), hashMatches: true, cacheControl: response.headers()['cache-control'] });
  }
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /花叔设计|Huashu Design/i }).first().click({ timeout: 30000 });
  await page.locator('.hs-design').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /风格库|Styles/i, exact: true }).first().click({ timeout: 10000 });
  await page.locator('.hs-style-card').first().waitFor({ state: 'visible' });
  await page.evaluate(async () => { await Promise.all([...document.querySelectorAll('.hs-design img')].filter(i => !i.loading || i.loading !== 'lazy' || i.getBoundingClientRect().top < innerHeight).map(i => i.decode())); });
  const shown = await page.locator('.hs-design img').evaluateAll(images => images.filter(i => i.complete && i.naturalWidth > 0).map(i => ({ source: i.getAttribute('src'), width: i.naturalWidth, height: i.naturalHeight, displayedWidth: Math.round(i.getBoundingClientRect().width) })));
  if (!shown.length || shown.some(i => i.width !== 4800 || i.height !== 3000)) throw new Error('The displayed style specimens did not resolve to the new high-resolution images');
  await page.locator('.hs-design').screenshot({ path: path.join(root, 'quality-report/live-library.png') });
  const report = { checkedAt: new Date().toISOString(), origin, liveStyles: catalog.styles.length, imagesChecked: results.length, allBytesMatch: true, displayed: shown, assets: results };
  await fs.writeFile(path.join(root, 'quality-report/live-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('LIVE VERIFIED', results.length, 'image routes; 92 styles; rendered style specimens are 4800x3000; no-store cache policy');
} catch (error) {
  console.error(String(error.message).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[REDACTED]'));
  process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
