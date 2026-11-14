"""Fetch pinned 1070px originals, verifying they are the same artwork as the 520px copies."""
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
import hashlib
import io
import json

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'upstream/assets'
WORK = ROOT / '.hd-work'
STAGE = WORK / 'images'
PIN = '47bb6f366641a76a482e2fb2fd26b2ac515f1a13'
BASE = f'https://raw.githubusercontent.com/alchaincyf/huashu-bird-sticker/{PIN}/'
NAMESPACE = {
 'Accipiter_nisus': 'Accipitriformes/Accipitridae',
 'Agapornis_pullarius': 'Psittaciformes/Psittaculidae',
 'Aix_galericulata': 'Anseriformes/Anatidae',
 'Alcedo_atthis': 'Coraciiformes/Alcedinidae',
 'Ara_macao': 'Psittaciformes/Psittacidae',
 'Bubo_bubo': 'Strigiformes/Strigidae',
 'Cacatua_galerita': 'Psittaciformes/Cacatuidae',
 'Calyptorhynchus_banksii': 'Psittaciformes/Cacatuidae',
 'Carpodacus_erythrinus': 'Passeriformes/Fringillidae',
 'Chrysolophus_pictus': 'Galliformes/Phasianidae',
 'Coracias_caudatus': 'Coraciiformes/Coraciidae',
 'Ensifera_ensifera': 'Apodiformes/Trochilidae',
 'Eolophus_roseicapilla': 'Psittaciformes/Cacatuidae',
 'Grus_japonensis': 'Gruiformes/Gruidae',
 'Merops_apiaster': 'Coraciiformes/Meropidae',
 'Nestor_notabilis': 'Psittaciformes/Strigopidae',
 'Platycercus_icterotis': 'Psittaciformes/Psittaculidae',
 'Psephotellus_chrysopterygius': 'Psittaciformes/Psittaculidae',
 'Psittacus_erithacus': 'Psittaciformes/Psittacidae',
 'Trichoglossus_moluccanus': 'Psittaciformes/Psittaculidae',
 'Upupa_epops': 'Bucerotiformes/Upupidae',
 'Vini_kuhlii': 'Psittaciformes/Psittaculidae',
}


def white(im):
    out = Image.new('RGBA', im.size, 'white')
    out.alpha_composite(im)
    return out.convert('RGB')


def fetch(entry):
    species, namespace = entry
    remote = f'stickers/{namespace}/{species}.webp'
    relative = f'style-specimens/xhs/_kit/stickers/{species}.webp'
    old_path = (ASSETS / relative).resolve(strict=True)
    if not old_path.is_relative_to(ASSETS.resolve()): raise ValueError('Unsafe sticker source')
    request = Request(BASE + remote, headers={'User-Agent': 'Huashu-HD-library/1.0'})
    with urlopen(request, timeout=40) as response:
        if response.status != 200: raise ValueError('Download failed: ' + species)
        body = response.read()
    with Image.open(io.BytesIO(body)) as im:
        im.load()
        original = im.convert('RGBA')
    with Image.open(old_path) as im:
        thumbnail = im.convert('RGBA')
    if max(original.size) != 1070: raise ValueError('Unexpected source resolution: ' + species)
    resized = original.resize(thumbnail.size, Image.Resampling.LANCZOS)
    alpha_equal = resized.getchannel('A').tobytes() == thumbnail.getchannel('A').tobytes()
    visible_mae = sum(ImageStat.Stat(ImageChops.difference(white(resized), white(thumbnail))).mean) / 3
    if not alpha_equal or visible_mae > 3:
        raise ValueError(f'Sticker artwork changed: {species}, alpha={alpha_equal}, visible_mae={visible_mae}')
    destination = STAGE / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(body)
    print('STICKER', species, f'{thumbnail.width}x{thumbnail.height} -> {original.width}x{original.height}', flush=True)
    return dict(path=relative, url=BASE+remote, sourceCommit=PIN, license='PolyForm-Shield-1.0.0',
                width=original.width, height=original.height, bytes=len(body), sha256=hashlib.sha256(body).hexdigest(),
                alphaMatchesThumbnail=True, visiblePixelMAE=visible_mae)


if __name__ == '__main__':
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(fetch, sorted(NAMESPACE.items())))
    WORK.mkdir(exist_ok=True)
    manifest = dict(repository='https://github.com/alchaincyf/huashu-bird-sticker', commit=PIN,
                    copyright='Copyright (c) 2026 Huashu (alchaincyf)',
                    historicLicense='PolyForm-Shield-1.0.0',
                    historicLicenseUrl=BASE+'LICENSE.md',
                    laterLicenseRegrant='https://raw.githubusercontent.com/alchaincyf/huashu-bird-sticker/fc3d95816994d3497b94e1775bbff55b93fc8f69/LICENSE.md',
                    note='Same historical artwork; distributed upstream originals, not newly generated pictures. Original notices retained.',
                    assets=results)
    (WORK / 'sticker-sources.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print('DOWNLOADED AND VERIFIED', len(results), 'matching high-resolution originals')
