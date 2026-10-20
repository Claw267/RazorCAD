"""Builds the browser version of RazorCAD into the website: app/ copied to website/app/ (razorcad.com/app/).

The browser version is the same program: files are opened from the PC and saved as downloads, preferences stay in
the browser, and there is no auto-save, no Windows fonts and no automatic updating (a notice at the top says so and
links to the Windows app). It is published with the rest of the website, only when the website is.

    python tools/build_web_app.py
"""
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'app')
DST = os.path.join(ROOT, 'website', 'app')
# the host serves files up to 25 MiB
MAX_FILE = 25 * 1024 * 1024


def app_version():
    try:
        return open(os.path.join(ROOT, 'version.txt'), encoding='utf-8').read().strip() or 'dev'
    except OSError:
        return 'dev'


def main():
    if not os.path.isfile(os.path.join(SRC, 'index.html')):
        sys.exit('app/index.html not found')
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    shutil.copytree(SRC, DST, ignore=shutil.ignore_patterns('__pycache__', '*.map', '*.bak', 'Thumbs.db', '.DS_Store'))
    version = app_version()
    p = os.path.join(DST, 'index.html')
    html = open(p, encoding='utf-8').read()
    main_tag = '<script type="module" src="js/main.js"></script>'
    assert html.count(main_tag) == 1, 'main.js script tag'
    html = html.replace(main_tag, f'<script>window.RAZORCAD_WEB = {{ version: {version!r} }};</script>\n{main_tag}')
    html = re.sub(r'<title>[^<]*</title>', '<title>RazorCAD in your browser</title>', html, count=1)
    if 'name="description"' not in html:
        html = html.replace('</title>', '</title>\n<meta name="description" content="RazorCAD, the free parametric 3D CAD program, running in your browser: parts, sketches, assemblies and drawings.">', 1)
    open(p, 'w', encoding='utf-8', newline='\n').write(html)
    total, big = 0, []
    for d, _, files in os.walk(DST):
        for f in files:
            n = os.path.getsize(os.path.join(d, f))
            total += n
            if n > MAX_FILE:
                big.append(f)
    if big:
        sys.exit('Too big for the website host (25 MiB a file): ' + ', '.join(big))
    print(f'website/app: RazorCAD {version}, {sum(len(f) for _, _, f in os.walk(DST))} files, {total / 1048576:.1f} MB')


if __name__ == '__main__':
    main()
