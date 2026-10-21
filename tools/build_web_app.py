"""Builds the browser version of RazorCAD into the website: app/ copied to website/app/ (razorcad.com/app/).

The browser version is the same program: files are opened from the PC and saved as downloads, preferences stay in
the browser, and there is no auto-save, no Windows fonts and no automatic updating (a notice at the top says so and
links to the Windows app). It is published with the rest of the website, only when the website is.

It is built in its own folder, "RazorCAD Web" next to this project's folder (kept apart from the desktop app's
work, and always on the single-thread geometry kernel: the multi-threaded one needs cross-origin isolation, which
the website's host may not give), and copied from there into website/app for publishing. Without that folder
(another PC, GitHub), it is built straight into website/app.

    python tools/build_web_app.py
"""
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from kernelsig import kernel_signature  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'app')
SITE_APP = os.path.join(ROOT, 'website', 'app')
WEB_HOME = os.path.join(os.path.dirname(ROOT), 'RazorCAD Web')
DST = os.path.join(WEB_HOME, 'app') if os.path.isdir(WEB_HOME) else SITE_APP
# (left out of the browser version: the multi-threaded kernel)
SKIP = ('__pycache__', '*.map', '*.bak', 'Thumbs.db', '.DS_Store', 'replicad_multi.*', '_perf_*')
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
    shutil.copytree(SRC, DST, ignore=shutil.ignore_patterns(*SKIP))
    version = app_version()
    p = os.path.join(DST, 'index.html')
    html = open(p, encoding='utf-8').read()
    main_tag = '<script type="module" src="js/main.js"></script>'
    assert html.count(main_tag) == 1, 'main.js script tag'
    # (the kernel's signature: the models the browser keeps are kept per kernel)
    html = html.replace(main_tag, f'<script>window.RAZORCAD_WEB = {{ version: {version!r}, kernel: {kernel_signature(DST)!r} }};</script>\n{main_tag}')
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
    # (from its own folder into the website, for publishing)
    if DST != SITE_APP:
        if os.path.isdir(SITE_APP):
            shutil.rmtree(SITE_APP)
        shutil.copytree(DST, SITE_APP)
    print(f'{os.path.relpath(DST, os.path.dirname(ROOT))} -> website/app: RazorCAD {version}, {sum(len(f) for _, _, f in os.walk(DST))} files, {total / 1048576:.1f} MB')


if __name__ == '__main__':
    main()
