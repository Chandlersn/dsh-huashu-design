#!/usr/bin/env python3
"""把风格样张渲染成图，并为每个分区拼一张总览图。

样张是 assets/style-specimens/<分区>/<编号-名字>.html，CSS 视口 1200×750，<title> 写风格名。
默认按 4 倍像素重新绘制为 4800×3000、JPEG 质量 98；总览图也按 4 倍像素重建。
渲染结果放在同名 .jpg；每个分区再出一张 sheet-<分区>.jpg，一眼看完这一区所有风格。

用法（在 skill 根目录）：
  python3 scripts/build_specimens.py              # 全部重渲染
  python3 scripts/build_specimens.py web app      # 只渲染这几个分区
  python3 scripts/build_specimens.py --sheets     # 只重拼总览图
  python3 scripts/build_specimens.py assets/style-specimens/web/03-x.html   # 只渲染这几张，不拼总览
"""

import html
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'assets' / 'style-specimens'
W, H = 1200, 750
SCALE, QUALITY = 4, 98
COLS = 4


def groups(names):
    found = sorted(p for p in ROOT.iterdir() if p.is_dir())
    return [g for g in found if not names or g.name in names]


def render(page, src):
    # sheet() uses its own viewport; always restore the specimen's CSS layout.
    page.set_viewport_size({'width': W, 'height': H})
    page.goto(src.resolve().as_uri(), wait_until='networkidle', timeout=45000)
    page.evaluate('document.fonts.ready')
    page.evaluate('async () => { await Promise.all([...document.images].map(im => im.decode())); }')
    page.wait_for_timeout(300)
    page.screenshot(path=str(src.with_suffix('.jpg')), type='jpeg', quality=QUALITY, scale='device')


def sheet(page, group):
    items = []
    for src in sorted(group.glob('*.html')):
        jpg = src.with_suffix('.jpg')
        if not jpg.exists():
            continue
        title = src.stem
        text = src.read_text(encoding='utf-8')
        if '<title>' in text:
            title = text.split('<title>', 1)[1].split('</title>', 1)[0].strip()
        items.append((jpg, title))
    if not items:
        return None
    cells = ''.join(
        f'<figure><img src="{jpg.resolve().as_uri()}"><figcaption>{html.escape(t)}</figcaption></figure>'
        for jpg, t in items)
    doc = f'''<!doctype html><meta charset="utf-8"><style>
body{{margin:0;padding:24px;background:#d9d9d6;font:600 15px/1.35 -apple-system,"PingFang SC","Noto Sans SC",sans-serif;color:#1a1a1a}}
.g{{display:grid;grid-template-columns:repeat({COLS},300px);gap:18px 14px}}
figure{{margin:0}} img{{width:300px;height:{300 * H // W}px;display:block;box-shadow:0 0 0 1px rgba(0,0,0,.15)}}
figcaption{{margin-top:6px}}</style><div class="g">{cells}</div>'''
    tmp = group / '.sheet.html'
    tmp.write_text(doc, encoding='utf-8')
    page.set_viewport_size({'width': COLS * 314 + 34, 'height': 600})
    page.goto(tmp.resolve().as_uri(), wait_until='load')
    out = ROOT / f'sheet-{group.name}.jpg'
    page.evaluate('async () => { await document.fonts.ready; await Promise.all([...document.images].map(im => im.decode())); }')
    page.screenshot(path=str(out), full_page=True, type='jpeg', quality=QUALITY, scale='device')
    tmp.unlink()
    return out


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except (AttributeError, ValueError):
            pass
    only_sheets = '--sheets' in argv
    files = [Path(a) for a in argv if a.endswith('.html')]
    names = [a for a in argv if not a.startswith('--') and not a.endswith('.html')]
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('需要 Playwright：pip install playwright && python3 -m playwright install chromium')
        return 2
    failed = []
    with sync_playwright() as p:
        try:
            executable = os.environ.get('PLAYWRIGHT_EXECUTABLE_PATH')
            local_edge = Path('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
            if not executable and sys.platform == 'win32' and local_edge.is_file():
                executable = str(local_edge)
            browser = p.chromium.launch(**({'executable_path': executable} if executable else {}))
        except Exception as e:
            print('Chromium 启动失败：', str(e).splitlines()[0], '\n装一下：python3 -m playwright install chromium')
            return 2
        page = browser.new_page(viewport={'width': W, 'height': H}, device_scale_factor=SCALE)
        page.add_init_script(f'''(() => {{
          const original = HTMLCanvasElement.prototype.getContext;
          const prepared = new WeakSet();
          HTMLCanvasElement.prototype.getContext = function(type, ...args) {{
            if (type === '2d' && !prepared.has(this)) {{
              const w = this.width, h = this.height;
              this.style.width = w + 'px'; this.style.height = h + 'px';
              this.width = w * {SCALE}; this.height = h * {SCALE};
              const ctx = original.call(this, type, ...args);
              ctx.setTransform({SCALE}, 0, 0, {SCALE}, 0, 0);
              prepared.add(this); return ctx;
            }}
            return original.call(this, type, ...args);
          }};
        }})();''')
        for src in files:
            try:
                render(page, src)
                print('✓', src)
            except Exception as e:
                failed.append(src.name)
                print('✗', src, e)
        for g in ([] if files else groups(names)):
            if not only_sheets:
                for src in sorted(g.glob('*.html')):
                    try:
                        render(page, src)
                        print('✓', src.relative_to(ROOT))
                    except Exception as e:  # 单张失败不拖垮整批
                        failed.append(src.name)
                        print('✗', src.relative_to(ROOT), e)
            out = sheet(page, g)
            if out:
                print('总览', out.relative_to(ROOT.parent.parent))
        browser.close()
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
