"""The geometry kernel's signature: a hash of the code that decides how parts are built and meshed (the kernel
worker, every module it imports, the geometry library) and of how stored models are packed. Stored models and
feature states are kept per signature, so they stay valid across RazorCAD builds that don't change the kernel,
and are dropped when it changes.

    python kernelsig.py [app folder]    print it (website builds write it to kernel-signature.txt)
"""
import hashlib
import os
import re
import sys

IMPORT = re.compile(r"""(?:import|from)\s*(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}/[^'"]+)['"]""")
# (the main thread's side of a stored model: how it is packed)
EXTRA = ('js/modelcache.js', 'js/partmeshes.js')


def kernel_files(app):
    """The kernel worker and the modules it imports (directly or not), relative to app, sorted."""
    seen, todo = set(), ['js/kernel.worker.js']
    while todo:
        rel = os.path.normpath(todo.pop()).replace('\\', '/')
        if rel in seen or not os.path.isfile(os.path.join(app, rel)):
            continue
        seen.add(rel)
        with open(os.path.join(app, rel), encoding='utf-8', errors='replace') as f:
            text = f.read()
        base = os.path.dirname(rel)
        for m in IMPORT.finditer(text):
            todo.append(os.path.join(base, m.group(1)))
    vendor = os.path.join(app, 'vendor', 'replicad')
    if os.path.isdir(vendor):
        for n in os.listdir(vendor):
            seen.add(f'vendor/replicad/{n}')
    for x in EXTRA:
        if os.path.isfile(os.path.join(app, x)):
            seen.add(x)
    return sorted(seen)


def kernel_signature(app):
    h = hashlib.sha256()
    for rel in kernel_files(app):
        h.update(rel.encode() + b'\0')
        with open(os.path.join(app, rel), 'rb') as f:
            h.update(f.read().replace(b'\r\n', b'\n'))
        h.update(b'\0')
    return h.hexdigest()[:20]


if __name__ == '__main__':
    app = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")
    print(kernel_signature(app))
