import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.hd-work');
const reportFile = path.join(ROOT, 'quality-report/hd-library-manifest.json');
const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
if (!report.published || report.count !== 144) throw new Error('The complete high-resolution library has not been published');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const renders = new Map((await fs.readFile(path.join(WORK, 'renders.jsonl'), 'utf8')).trim().split('\n').map(line => { const item = JSON.parse(line); return [item.path, item]; }));
if (renders.size !== 116) throw new Error(`Missing render evidence (${renders.size}/116)`);
const checks = [...renders.values()];
if (checks.some(item => item.checks.dpr !== 4 || !item.checks.textLength || item.checks.images.some(i => !i.loaded) || item.checks.fonts.some(f => f.status === 'error'))) throw new Error('Render evidence has a failed dependency');
const social = checks.filter(item => item.path.startsWith('style-specimens/xhs/'));
if (social.length !== 8 || social.some(item => item.checks.images.some(i => i.src.includes('/stickers/') && Math.max(i.width, i.height) !== 1070))) throw new Error('Social previews have not verified the high-resolution sticker originals');
const canvas = checks.find(item => item.path.includes('10-computational-portrait'));
if (canvas.checks.canvas[0]?.width !== 4800 || canvas.checks.canvas[0]?.height !== 3000) throw new Error('Canvas backing store was not actually redrawn at four times the resolution');
for (const item of report.assets) {
  const file = path.resolve(ROOT, 'upstream/assets', item.path);
  if (!file.startsWith(path.join(ROOT, 'upstream/assets') + path.sep) || sha(await fs.readFile(file)) !== item.sha256) throw new Error(`Published hash mismatch: ${item.path}`);
}
report.renderVerification = {
  sourceImages: 116, socialPreviewsWith1070pxOriginals: social.length,
  allFontRequestsCompleted: true, brokenImages: 0, canvasBackingSize: [4800, 3000],
  results: checks.map(item => ({ path: item.path, cssWidth: item.cssWidth, cssHeight: item.cssHeight, scale: item.scale, textLength: item.checks.textLength, loadedFontFaces: item.checks.fonts.filter(f => f.status === 'loaded').length, images: item.checks.images, canvas: item.checks.canvas })),
};
await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
const manifestPath = path.join(ROOT, 'upstream-manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
manifest.acquisition_verification ??= manifest.verification;
manifest.file_inventory_scope = 'files[] preserves original upstream acquisition hashes; current locally derived files are recorded by local_derivatives and quality-report/hd-library-manifest.json';
manifest.working_tree_bytes = (await Promise.all(manifest.files.map(async item => (await fs.stat(path.join(ROOT, 'upstream', item.path))).size))).reduce((a, b) => a + b, 0);
const scriptPath = 'scripts/build_specimens.py';
manifest.local_derivatives = {
  updated_at: new Date().toISOString(), purpose: 'High-resolution reference library; replace low-resolution working images after full verification',
  raster_count: report.count, scale: report.scale, jpeg_quality: report.jpegQuality,
  manifest: 'quality-report/hd-library-manifest.json',
  artifacts: report.assets.map(item => ({ path: `assets/${item.path}`, original_sha256: item.oldSha256, sha256: item.sha256, width: item.width, height: item.height, method: item.kind === 'sticker' ? 'restore-matching-pinned-original' : item.kind === 'sheet' ? 'recompose-from-high-resolution-images' : 'rerender-from-editable-source' })),
  source_changes: [{ path: scriptPath, sha256: sha(await fs.readFile(path.join(ROOT, 'upstream', scriptPath))), reason: 'Default DPR4 / JPEG98, reset specimen viewport after sheets, redraw Canvas backing at DPR, decode image dependencies before capture.' }],
};
manifest.verification = { scope: 'Current working tree after local high-resolution derivatives; original acquisition evidence is retained in acquisition_verification', working_tree_clean: false, byte_exact_match: false, expected_modified_upstream_files: 145, current_raster_hashes_verified: 144, current_low_resolution_originals_remaining: 0 };
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('PROVENANCE UPDATED', report.count, 'image fingerprints;', renders.size, 'source render checks; original acquisition evidence retained');
