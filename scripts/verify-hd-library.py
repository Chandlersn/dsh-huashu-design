"""Validate, compare and publish the exact raster inventory; never retain old masters."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageStat
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
ASSETS = (ROOT / 'upstream/assets').resolve()
WORK = (ROOT / '.hd-work').resolve()
STAGE = (WORK / 'images').resolve()
REPORT = ROOT / 'quality-report'
BASELINE = WORK / 'baseline.json'
SCALE = 4


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def safe_file(root, relative):
    root = root.resolve(strict=True)
    p = (root / relative).resolve(strict=True)
    if not p.is_relative_to(root) or not p.is_file():
        raise ValueError(f'Unexpected file target: {p}')
    return p


def baseline():
    return json.loads(BASELINE.read_text(encoding='utf-8'))['assets']


def validate(staged=True):
    rows = []
    for old in baseline():
        p = safe_file(STAGE if staged else ASSETS, old['path'])
        with Image.open(p) as im:
            im.verify()
        with Image.open(p) as im:
            im.load()
            width, height = im.size
            variance = sum(ImageStat.Stat(im.convert('RGB').resize((128, 128))).stddev)
            if variance < 3:
                raise ValueError(f'Blank output: {p}')
            if old['kind'] == 'sticker':
                if max(width, height) < max(old['width'], old['height']) * 1.5:
                    raise ValueError(f'Sticker source did not gain resolution: {p}')
                if 'A' not in im.getbands() or not im.getchannel('A').getbbox():
                    raise ValueError(f'Sticker alpha missing: {p}')
                if abs(width / height - old['width'] / old['height']) > .015:
                    raise ValueError(f'Sticker composition/aspect changed: {p}')
            elif old['kind'] == 'sheet':
                if width != old['width'] * SCALE or height < old['height'] * SCALE:
                    raise ValueError(f'Contact sheet dimensions below target: {p}: {im.size}')
            elif (width, height) != (old['width'] * SCALE, old['height'] * SCALE):
                raise ValueError(f'Wrong output dimensions: {p}: {im.size}')
        sha = digest(p)
        if sha == old['sha256']:
            raise ValueError(f'Original low-resolution bytes remain: {p}')
        if staged and digest(safe_file(ASSETS, old['path'])) != old['sha256']:
            raise ValueError(f'Original changed before publishing: {old["path"]}')
        rows.append(dict(path=old['path'], kind=old['kind'], oldWidth=old['width'], oldHeight=old['height'],
                         width=width, height=height, oldBytes=old['bytes'], bytes=p.stat().st_size,
                         oldSha256=old['sha256'], sha256=sha))
    actual = {p.relative_to(ASSETS).as_posix() for p in ASSETS.rglob('*') if p.suffix.lower() in ['.jpg', '.jpeg', '.png', '.webp']}
    expected = {r['path'] for r in rows}
    if actual != expected:
        raise ValueError(f'Inventory mismatch: extra={actual-expected}, missing={expected-actual}')
    print(f'VALIDATED {len(rows)}/{len(expected)} images; decoded, dimensions, nonblank, fingerprints, exact coverage')
    return rows


def save_manifest(rows, published=False):
    REPORT.mkdir(exist_ok=True)
    out = dict(schemaVersion=1, generatedAt=datetime.now(timezone.utc).isoformat(), published=published,
               scale=SCALE, jpegQuality=98, count=len(rows),
               counts={k:sum(r['kind']==k for r in rows) for k in ['specimen','showcase','sheet','sticker']},
               oldBytes=sum(r['oldBytes'] for r in rows), bytes=sum(r['bytes'] for r in rows),
               oldLowResolutionImagesRemaining=0 if published else None, assets=rows)
    sticker_manifest = WORK / 'sticker-sources.json'
    if sticker_manifest.exists():
        out['stickerSources'] = json.loads(sticker_manifest.read_text(encoding='utf-8'))
    (REPORT / 'hd-library-manifest.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    return out


def compare():
    REPORT.mkdir(exist_ok=True)
    samples = [
        ('style-specimens/web/03-memphis-maximalism.jpg', (462, 498, 662, 583), '孟菲斯样张：小字号与旋转边缘'),
        ('style-specimens/info/20-swiss-grid-report.jpg', (50, 618, 250, 703), '信息图样张：脚注与细线'),
        ('style-specimens/app/08-command-palette.jpg', (110, 175, 310, 260), 'App 样张：界面文字'),
    ]
    fontpath = 'C:/Windows/Fonts/msyh.ttc'
    titlefont = ImageFont.truetype(fontpath, 29)
    smallfont = ImageFont.truetype(fontpath, 24)
    canvas = Image.new('RGB', (1664, 1440), '#f3f1eb')
    draw = ImageDraw.Draw(canvas)
    draw.text((32, 24), '相同区域 · 相同显示尺寸', fill='#171717', font=titlefont)
    draw.text((32, 78), '旧版 1200×750 · 放大 4 倍', fill='#555555', font=smallfont)
    draw.text((864, 78), '新版 4800×3000 · 从源码重新绘制', fill='#171717', font=smallfont)
    for index, (rel, box, label) in enumerate(samples):
        y = 138 + index * 424
        draw.text((32, y), label, fill='#171717', font=smallfont)
        with Image.open(safe_file(ASSETS, rel)) as im:
            old = im.convert('RGB').crop(box).resize((800, 340), Image.Resampling.LANCZOS)
        with Image.open(safe_file(STAGE, rel)) as im:
            new = im.convert('RGB').crop(tuple(v * SCALE for v in box))
        canvas.paste(old, (32, y + 44))
        canvas.paste(new, (864, y + 44))
    canvas.save(REPORT / 'before-after.png')
    print('COMPARISON', REPORT / 'before-after.png')


def publish():
    rows = validate(True)  # All 144 must pass before the first original is replaced.
    save_manifest(rows)
    for item in rows:
        source = safe_file(STAGE, item['path'])
        target = safe_file(ASSETS, item['path'])
        # These exact absolute targets were validated above against the baseline.
        if digest(target) != item['oldSha256'] or digest(source) != item['sha256']:
            raise ValueError(f'File changed before atomic replacement: {target}')
        os.replace(source, target)
    final = validate(False)
    save_manifest(final, True)
    print('PUBLISHED', len(final), 'exact original paths; low-resolution originals replaced, no old-file backups')


def verify_published():
    manifest = json.loads((REPORT / 'hd-library-manifest.json').read_text(encoding='utf-8'))
    if not manifest['published']:
        raise ValueError('Not published')
    for item in manifest['assets']:
        p = safe_file(ASSETS, item['path'])
        if digest(p) != item['sha256']:
            raise ValueError(f'Published file hash mismatch: {p}')
        with Image.open(p) as im:
            im.load()
            if im.size != (item['width'], item['height']):
                raise ValueError(f'Published dimensions mismatch: {p}')
    old = {item['oldSha256'] for item in manifest['assets']}
    active = [p for p in ASSETS.rglob('*') if p.suffix.lower() in ['.jpg','.jpeg','.png','.webp']]
    if len(active) != manifest['count'] or any(digest(p) in old for p in active):
        raise ValueError('An old raster remains in active library')
    print('FINAL VERIFIED', manifest['count'], 'active high-resolution images, zero original low-resolution image hashes')


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'validate'
    if mode == 'compare': compare()
    elif mode == 'validate': save_manifest(validate(True))
    elif mode == 'publish': publish()
    elif mode == 'verify': verify_published()
    else: raise ValueError('Unknown mode ' + mode)
