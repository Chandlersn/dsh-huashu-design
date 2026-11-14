"""Audit exact cleanup targets, then remove only verified low-res artifacts and staging data."""
from pathlib import Path
import hashlib
import json
import shutil
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / 'quality-report'
WORK = ROOT / '.hd-work'
OLD_ARCHIVE = ROOT / 'artifacts/dsh-huashu-design-0.1.1.tgz'
manifest = json.loads((REPORT / 'hd-library-manifest.json').read_text(encoding='utf-8'))
if not manifest.get('published') or manifest['count'] != 144:
    raise ValueError('The complete library has not been published')
old_hashes = {r['oldSha256'] for r in manifest['assets']}
for row in manifest['assets']:
    p = (ROOT / 'upstream/assets' / row['path']).resolve(strict=True)
    if not p.is_relative_to((ROOT / 'upstream/assets').resolve()): raise ValueError('Unsafe active image path')
    if hashlib.sha256(p.read_bytes()).hexdigest() != row['sha256']:
        raise ValueError('Active high-resolution image changed: ' + str(p))
plan = []
if WORK.exists():
    absolute = WORK.resolve(strict=True)
    expected = ROOT.resolve() / '.hd-work'
    if absolute != expected or WORK.is_symlink(): raise ValueError('Unexpected staging directory')
    leftovers = [p for p in WORK.rglob('*') if p.is_file() and p.suffix.lower() in ['.jpg','.jpeg','.png','.webp']]
    if leftovers: raise ValueError('Unpublished images remain in staging: ' + str(leftovers))
    plan.append(dict(path=str(absolute), kind='staging', bytes=sum(p.stat().st_size for p in WORK.rglob('*') if p.is_file()), reason='All 144 staged raster files were validated and atomically moved into the active library; only processing metadata remains.'))
if OLD_ARCHIVE.exists():
    absolute = OLD_ARCHIVE.resolve(strict=True)
    if absolute != ROOT.resolve() / 'artifacts/dsh-huashu-design-0.1.1.tgz' or OLD_ARCHIVE.is_symlink(): raise ValueError('Unexpected archive target')
    low_resolution_members = 0
    with tarfile.open(absolute, 'r:gz') as archive:
        for member in archive:
            if member.isfile() and member.name.lower().endswith(('.jpg','.jpeg','.png','.webp')):
                with archive.extractfile(member) as handle:
                    if hashlib.sha256(handle.read()).hexdigest() in old_hashes: low_resolution_members += 1
    if low_resolution_members != 144: raise ValueError(f'Old archive does not contain the expected 144 obsolete images: {low_resolution_members}')
    plan.append(dict(path=str(absolute), kind='old-archive', bytes=absolute.stat().st_size, oldImages=low_resolution_members, reason='Obsolete 0.1.1 package embeds every original low-resolution raster image.'))
print(json.dumps(dict(mode=sys.argv[1] if len(sys.argv)>1 else 'audit', targets=plan), ensure_ascii=False, indent=2), flush=True)
if len(sys.argv)>1 and sys.argv[1] == 'clean':
    # Absolute, fixed roots and all their contents have been checked above.
    for item in plan:
        target = Path(item['path'])
        if item['kind'] == 'staging': shutil.rmtree(target)
        else: target.unlink()
    result = dict(cleaned=True, activeImages=144, oldActiveImages=0, removed=plan,
                  note='Editable source and Git source history are retained; the comparison is a cropped quality-verification board, not an old material master.')
    (REPORT / 'cleanup.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print('CLEANED', len(plan), 'verified targets; active library contains only high-resolution replacements')
