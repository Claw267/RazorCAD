"""Generates the RazorCAD logo: a decahedron (pentagonal bipyramid) cleanly sliced
by one diagonal cut, the upper piece lifted clear (exploded-view style) to reveal a
hatched section face.

Writes (from one set of geometry, so every format matches):
  assets/razorcad.svg      master mark (also copied to app/razorcad.svg for the UI)
  assets/razorcad.ico      multi-size Windows icon (hatching dropped below 48 px)
  assets/razorcad-512.png  raster for README / release pages
"""
import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')

TILE_TOP, TILE_BOT = (0xEF, 0x45, 0x3A), (0xA8, 0x16, 0x16)
FACET_DARK, FACET_LIGHT = (0x7c, 0x81, 0x87), (0xc2, 0xc6, 0xca)
CUT = '#26303c'
HATCH = '#7f8c9c'
OUTLINE = '#1f2731'
OUTLINE_W = 0.9      # at 256 px

APEX = 1.05           # apex height over the pentagon's circumradius (1.0)
TWIST = 8             # degrees the pentagon is turned off the line of sight
VIEW_AZ, VIEW_EL = -90, 24     # camera azimuth / elevation, degrees
LIGHT = (-0.85, 0.45, 0.45)     # (screen-right, up, toward-viewer) components

# cut plane, in camera terms: tilted SLOPE down to the right, passing OFFSET above
# the centre, so it reads as one slash across the front facets
SLOPE, OFFSET = 0.62, 0.10
LIFT = 0.36           # exploded-view lift of the upper piece, exposing the section


def sub(a, b): return tuple(p - q for p, q in zip(a, b))
def add(a, b): return tuple(p + q for p, q in zip(a, b))
def mul(a, k): return tuple(p * k for p in a)
def dot(a, b): return sum(p * q for p, q in zip(a, b))
def norm(a): return mul(a, 1 / math.sqrt(dot(a, a)))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


az, el = math.radians(VIEW_AZ), math.radians(VIEW_EL)
VIEW = (math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el))  # toward eye
RIGHT = (-math.sin(az), math.cos(az), 0.0)
UP = cross(VIEW, RIGHT)


def solid_faces():
    """Pentagonal bipyramid faces as (outward normal, ccw vertex loop), z up."""
    ring = [(math.cos(a), math.sin(a), 0.0) for a in
            (math.radians(TWIST + VIEW_AZ + 72 * i) for i in range(5))]
    top, bot = (0.0, 0.0, APEX), (0.0, 0.0, -APEX)
    faces = []
    for i in range(5):
        a, b = ring[i], ring[(i + 1) % 5]
        for loop in ([a, b, top], [b, a, bot]):
            faces.append((norm(cross(sub(loop[1], loop[0]), sub(loop[2], loop[0]))), loop))
    return faces


def clip(poly, n, d, keep_below):
    """Sutherland-Hodgman clip of a 3D polygon against n.p <= d (or >= d)."""
    side = (lambda p: d - dot(n, p)) if keep_below else (lambda p: dot(n, p) - d)
    out = []
    for i, p in enumerate(poly):
        q = poly[(i + 1) % len(poly)]
        sp, sq = side(p), side(q)
        if sp >= 0:
            out.append(p)
        if (sp >= 0) != (sq >= 0):
            t = sp / (sp - sq)
            out.append(add(p, mul(sub(q, p), t)))
    return out


def section(n, d):
    """Ordered loop of the plane/solid intersection."""
    pts = []
    for _, loop in solid_faces():
        for i, p in enumerate(loop):
            q = loop[(i + 1) % len(loop)]
            sp, sq = dot(n, p) - d, dot(n, q) - d
            if (sp > 0) != (sq > 0):
                pts.append(add(p, mul(sub(q, p), sp / (sp - sq))))
    c = mul(tuple(map(sum, zip(*pts))), 1 / len(pts))
    u = norm(sub(pts[0], c))
    v = cross(norm(n), u)
    pts.sort(key=lambda p: math.atan2(dot(sub(p, c), v), dot(sub(p, c), u)))
    uniq = []
    for p in pts:
        if not any(dot(sub(p, q), sub(p, q)) < 1e-12 for q in uniq):
            uniq.append(p)
    return uniq


def project(p):
    return (dot(p, RIGHT), -dot(p, UP))


def shade(n):
    """Facet colour from a soft key light at the viewer's upper left."""
    light = norm(add(add(mul(RIGHT, LIGHT[0]), mul(UP, LIGHT[1])), mul(VIEW, LIGHT[2])))
    t = min(1.0, max(0.0, 0.5 + 0.48 * dot(n, light)))
    return '#%02x%02x%02x' % tuple(round(a + (b - a) * t) for a, b in zip(FACET_DARK, FACET_LIGHT))


def visible_polys():
    """Returns [(fill or 'cut', 2D points)] in back-to-front paint order."""
    n = norm(add((0.0, 0.0, 1.0), mul(RIGHT, SLOPE)))
    d = OFFSET
    lower, upper = [], []
    for fn, loop in solid_faces():
        if dot(fn, VIEW) <= 1e-9:
            continue
        lo = clip(loop, n, d, True)
        hi = clip(loop, n, d, False)
        if len(lo) >= 3:
            lower.append((shade(fn), lo))
        if len(hi) >= 3:
            upper.append((shade(fn), hi))
    lower.append(('cut', section(n, d)))
    move = (0.0, 0.0, LIFT)
    upper = [(k, [add(p, move) for p in loop]) for k, loop in upper]
    to2d = lambda polys: [(k, [project(p) for p in loop]) for k, loop in polys]
    return to2d(lower) + to2d(upper)


def layout(size, margin):
    polys = visible_polys()
    xs = [x for _, pts in polys for x, _ in pts]
    ys = [y for _, pts in polys for _, y in pts]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    k = (size - 2 * margin) / max(w, h)
    ox = size / 2 - k * (min(xs) + max(xs)) / 2
    oy = size / 2 - k * (min(ys) + max(ys)) / 2
    return [(kind, [(ox + k * x, oy + k * y) for x, y in pts]) for kind, pts in polys]


# ---------------------------------------------------------------- SVG

def hatch_lines(size, step):
    """45-degree hatch segments covering the whole canvas."""
    lines, c = [], -size
    while c < 2 * size:
        lines.append(((c, size), (c + size, 0)))
        c += step
    return lines


def svg(size=256):
    polys = layout(size, 46)
    f = lambda pts: ' '.join(f'{x:.2f},{y:.2f}' for x, y in pts)
    cut = next(pts for k, pts in polys if k == 'cut')
    hatch = ''.join(f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}"/>'
                    for a, b in hatch_lines(size, 9))
    shapes = []
    for kind, pts in polys:
        shapes.append(f'<polygon points="{f(pts)}" fill="{CUT if kind == 'cut' else kind}"/>')
        if kind == 'cut':
            shapes.append(f'<g clip-path="url(#rc-cut)" stroke="{HATCH}" stroke-width="2.4">{hatch}</g>')
        shapes.append(f'<polygon points="{f(pts)}" fill="none" stroke="{OUTLINE}" '
                      f'stroke-width="{OUTLINE_W}" stroke-linejoin="round"/>')
    rgb = lambda c: '#%02x%02x%02x' % c
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
  <title>RazorCAD</title>
  <defs>
    <linearGradient id="rc-tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{rgb(TILE_TOP)}"/><stop offset="1" stop-color="{rgb(TILE_BOT)}"/>
    </linearGradient>
    <clipPath id="rc-cut"><polygon points="{f(cut)}"/></clipPath>
  </defs>
  <rect x="8" y="8" width="{size - 16}" height="{size - 16}" rx="52" fill="url(#rc-tile)"/>
  {''.join(shapes)}
</svg>
'''


# ---------------------------------------------------------------- raster

def hexrgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) + (255,)


def raster(size, detail=True):
    S = 4 * max(size, 64)                      # supersample, then downscale
    k = S / 256
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for i in range(2 * S):                     # 135-degree gradient
        t = i / (2 * S)
        col = tuple(int(a + (b - a) * t) for a, b in zip(TILE_TOP, TILE_BOT)) + (255,)
        gd.line([(i, 0), (0, i)], fill=col, width=2)
    mask = Image.new('L', (S, S), 0)
    inset = 8 * k if size >= 32 else 2 * k     # small icons fill the square
    ImageDraw.Draw(mask).rounded_rectangle([inset, inset, S - inset, S - inset],
                                           radius=52 * k, fill=255)
    img.paste(grad, (0, 0), mask)
    margin = 46 if size >= 32 else 30
    polys = layout(256, margin)
    sc = lambda pts: [(x * k, y * k) for x, y in pts]
    d = ImageDraw.Draw(img)
    for kind, pts in polys:
        d.polygon(sc(pts), fill=hexrgb(CUT if kind == 'cut' else kind))
        if kind == 'cut' and detail:
            layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
            ld = ImageDraw.Draw(layer)
            for a, b in hatch_lines(256, 9):
                ld.line(sc([a, b]), fill=hexrgb(HATCH), width=max(1, round(2.4 * k)))
            m = Image.new('L', (S, S), 0)
            ImageDraw.Draw(m).polygon(sc(pts), fill=255)
            img.paste(layer, (0, 0), Image.composite(layer, Image.new('RGBA', (S, S)), m).split()[3])
            d = ImageDraw.Draw(img)
        # at small sizes keep the outline about 0.25 px so the silhouette still reads
        w = OUTLINE_W if size >= 48 else 0.25 * 256 / size
        d.line(sc(pts + pts[:1]), fill=hexrgb(OUTLINE), width=round(w * k), joint='curve')
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(ASSETS, exist_ok=True)
    text = svg()
    for path in (os.path.join(ASSETS, 'razorcad.svg'), os.path.join(ROOT, 'app', 'razorcad.svg')):
        with open(path, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text)
    raster(512).save(os.path.join(ASSETS, 'razorcad-512.png'))
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [raster(s, detail=s >= 48) for s in sizes]
    frames[-1].save(os.path.join(ASSETS, 'razorcad.ico'), sizes=[(s, s) for s in sizes],
                    append_images=frames[:-1])
    print('wrote', ASSETS)


if __name__ == '__main__':
    main()
