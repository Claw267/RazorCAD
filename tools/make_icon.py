"""Generates the RazorCAD logo: a decahedron (pentagonal bipyramid) cleanly sliced
by one diagonal cut, the upper piece lifted clear (exploded-view style) to reveal a
hatched section face.

Writes (from one set of geometry, so every format matches):
  assets/razorcad.svg      master mark (also copied to app/razorcad.svg for the UI)
  assets/razorcad.ico      multi-size Windows icon (hatching dropped below 48 px)
  assets/razorcad-512.png  raster for README / release pages
  assets/razorcad-animated.svg  loops: a sword slash, the halves fly apart, spin, stop and
                                rejoin (self-contained, no script, works in an <img>)
  assets/razorcad-intro.svg     plays once: the slash, then the lift, resting on the static mark
                                (both animated files are also copied to website/img/)
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


def scene():
    """The logo's pieces in 2D: 'lower' and 'upper' (lifted) as painted in the static
    mark, 'whole' (the uncut solid, for the animation) and 'seam' (the front of the cut
    on the lower piece, as a left-to-right polyline)."""
    n = norm(add((0.0, 0.0, 1.0), mul(RIGHT, SLOPE)))
    d = OFFSET
    lower, upper, whole = [], [], []
    for fn, loop in solid_faces():
        if dot(fn, VIEW) <= 1e-9:
            continue
        whole.append((shade(fn), loop))
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
    # front edge of the section: the chain between its leftmost and rightmost points
    # that runs lower on screen
    loop = [project(p) for p in lower[-1][1]]
    i0 = min(range(len(loop)), key=lambda i: loop[i][0])
    i1 = max(range(len(loop)), key=lambda i: loop[i][0])
    walk = lambda step: [loop[(i0 + step * j) % len(loop)] for j in range((step * (i1 - i0)) % len(loop) + 1)]
    run = max(walk(1), walk(-1), key=lambda ch: sum(y for _, y in ch) / len(ch))
    return {'lower': to2d(lower), 'upper': to2d(upper), 'whole': to2d(whole), 'seam': run,
            'lift': LIFT * dot((0.0, 0.0, 1.0), UP)}


def visible_polys():
    """Returns [(fill or 'cut', 2D points)] in back-to-front paint order."""
    sc = scene()
    return sc['lower'] + sc['upper']


def fit(size, margin):
    """Scale k and the map that centres the static mark in a size x size box."""
    polys = visible_polys()
    xs = [x for _, pts in polys for x, _ in pts]
    ys = [y for _, pts in polys for _, y in pts]
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    k = (size - 2 * margin) / max(w, h)
    ox = size / 2 - k * (min(xs) + max(xs)) / 2
    oy = size / 2 - k * (min(ys) + max(ys)) / 2
    return k, lambda pts: [(ox + k * x, oy + k * y) for x, y in pts]


def layout(size, margin):
    _, m = fit(size, margin)
    return [(kind, m(pts)) for kind, pts in visible_polys()]


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


def _rgb(c): return '#%02x%02x%02x' % c
def _pts(pts): return ' '.join(f'{x:.1f},{y:.1f}' for x, y in pts)


def _poly(fill, pts):
    return f'<polygon points="{_pts(pts)}" fill="{fill}"/>'


def _sword(pid, path, size):
    """A sword-slash streak along path (left to right): a tapered crescent of light,
    thick toward the leading end, with a soft glow.  A wide stroke in a mask is drawn
    along the same path to sweep it in."""
    L = sum(math.dist(p, q) for p, q in zip(path, path[1:]))
    # resample every few px, keeping the corners where the cut crosses facet edges
    samples, s = [], 0.0
    for p, q in zip(path, path[1:]):
        seg = math.dist(p, q)
        steps = max(1, math.ceil(seg / 4))
        for j in range(steps):
            t = j / steps
            samples.append(((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t), (s + seg * t) / L))
        s += seg
    samples.append((path[-1], 1.0))

    def normal(i):
        a = samples[max(i - 1, 0)][0]
        b = samples[min(i + 1, len(samples) - 1)][0]
        dx, dy = b[0] - a[0], b[1] - a[1]
        h = math.hypot(dx, dy)
        return (-dy / h, dx / h)

    def lens(w_top, w_bot):
        top, bot = [], []
        for i, ((x, y), t) in enumerate(samples):
            nx, ny = normal(i)
            ramp = math.sin(math.pi * t) * (0.25 + 0.75 * t)
            top.append((x - nx * w_top * ramp ** 0.7, y - ny * w_top * ramp ** 0.7))
            bot.append((x + nx * w_bot * ramp, y + ny * w_bot * ramp))
        return _pts(top + bot[::-1])
    return (f'<mask id="{pid}-sm" maskUnits="userSpaceOnUse" x="0" y="0" width="{size}" height="{size}">'
            f'<polyline class="{pid}-sweep" points="{_pts(path)}" fill="none" stroke="#ffffff" stroke-width="44"'
            f' stroke-linejoin="round" pathLength="1" stroke-dasharray="1 1"/></mask>'
            f'<g clip-path="url(#{pid}-tclip)"><g class="{pid}-slash" mask="url(#{pid}-sm)">'
            f'<polygon points="{lens(15, 6)}" fill="#ffffff" opacity=".28"/>'
            f'<polygon points="{lens(6.5, 1.6)}" fill="#ffffff"/>'
            f'</g></g>')


def _slash_keys(pid, p0, p1, p2, timing):
    """Streak sweeps in between p0 and p1 (percent), then fades by p2."""
    return (f'.{pid}-sweep {{ stroke-dashoffset: 1; animation: {pid}-sweep {timing} }}\n'
            f'  .{pid}-slash {{ opacity: 0; animation: {pid}-slash {timing} }}\n'
            f'  @keyframes {pid}-sweep {{ 0%, {p0:.2f}% {{ stroke-dashoffset: 1;'
            f' animation-timing-function: cubic-bezier(.2,.8,.3,1) }} {p1:.2f}%, 100% {{ stroke-dashoffset: 0 }} }}\n'
            f'  @keyframes {pid}-slash {{ 0%, {p1:.2f}% {{ opacity: 1; animation-timing-function: ease-in }}'
            f' {p2:.2f}%, 100% {{ opacity: 0 }} }}')


def _slash_path(m, sc, size):
    """The slash follows the front edge of the cut exactly across the solid; off the
    solid it runs on one straight line (through the cut's two ends) to the tile's
    edges, as the blade's path does."""
    seam = m(sc['seam'])

    def past(a, b):
        L = math.dist(a, b)
        return (b[0] + (b[0] - a[0]) * size / L, b[1] + (b[1] - a[1]) * size / L)
    return [past(seam[-1], seam[0])] + seam + [past(seam[0], seam[-1])]


def _shell(pid, size, style, body, defs=''):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
  <title>RazorCAD</title>
  <style>
{style}
  </style>
  <defs>
    <linearGradient id="{pid}-tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{_rgb(TILE_TOP)}"/><stop offset="1" stop-color="{_rgb(TILE_BOT)}"/>
    </linearGradient>
    <clipPath id="{pid}-tclip"><rect x="8" y="8" width="{size - 16}" height="{size - 16}" rx="52"/></clipPath>{defs}
  </defs>
  <rect x="8" y="8" width="{size - 16}" height="{size - 16}" rx="52" fill="url(#{pid}-tile)"/>
{body}
</svg>
'''


def svg_intro(size=256):
    """Plays once: the whole decahedron, a sword slash along the cut, then the upper
    piece lifts and the animation rests on the static mark (which is also what shows
    with no animation or with reduced motion)."""
    k, m = fit(size, 46)
    sc = scene()
    pid = 'rci'
    hatch = ''.join(f'M{a[0]:.1f} {a[1]:.1f}L{b[0]:.1f} {b[1]:.1f}' for a, b in hatch_lines(size, 9))
    lower, cut = [], None
    for kind, pts in sc['lower']:
        pts = m(pts)
        if kind == 'cut':
            cut = pts
            lower += [_poly(CUT, pts), f'<path clip-path="url(#{pid}-cut)" stroke="{HATCH}" stroke-width="2.4" d="{hatch}"/>',
                      _poly('none', pts)]
        else:
            lower.append(_poly(kind, pts))
    upper = ''.join(_poly(kind, m(pts)) for kind, pts in sc['upper'])
    whole = ''.join(_poly(kind, m(pts)) for kind, pts in sc['whole'])
    drop = sc['lift'] * k                   # how far down the upper piece sits when joined
    path = _slash_path(m, sc, size)
    T = 1.7
    pc = lambda t: 100 * t / T
    style = f'''  .{pid}-whole {{ opacity: 0; animation: {pid}-whole {T}s linear .3s 1 both }}
  .{pid}-upper {{ animation: {pid}-lift {T}s linear .3s 1 both }}
  @keyframes {pid}-whole {{ 0%, {pc(.3) - .1:.2f}% {{ opacity: 1 }} {pc(.3):.2f}%, 100% {{ opacity: 0 }} }}
  @keyframes {pid}-lift {{
    0%, {pc(.4):.2f}% {{ transform: translateY({drop:.2f}px); animation-timing-function: cubic-bezier(.2,.9,.25,1) }}
    100% {{ transform: translateY(0) }} }}
  {_slash_keys(pid, pc(.1), pc(.32), pc(.75), f'{T}s linear .3s 1 both')}
  @media (prefers-reduced-motion: reduce) {{
    .{pid}-whole, .{pid}-upper, .{pid}-slash, .{pid}-sweep {{ animation: none }} }}'''
    body = f'''  <g stroke="{OUTLINE}" stroke-width="{OUTLINE_W}" stroke-linejoin="round">
  <g>{''.join(lower)}</g>
  <g class="{pid}-upper">{upper}</g>
  <g class="{pid}-whole">{whole}</g>
  </g>
  {_sword(pid, path, size)}'''
    return _shell(pid, size, style, body, f'\n    <clipPath id="{pid}-cut"><polygon points="{_pts(cut)}"/></clipPath>')


# ---- looping animation: slash, the halves fly apart, spin, stop and rejoin

SPIN_TURNS = 2         # whole turns each half makes (the two spin opposite ways)
FPS = 60               # spin frames per second
SPIN_MIN = 0.2         # skip a frame that turns less than this (degrees)
SPLIT = 0.55           # gap opened between the halves, along the cut normal


def _rotate(p, axis, c, deg):
    """Rodrigues rotation of point p about the line through c along unit axis."""
    t = math.radians(deg)
    v = sub(p, c)
    r = add(add(mul(v, math.cos(t)), mul(cross(axis, v), math.sin(t))), mul(axis, dot(axis, v) * (1 - math.cos(t))))
    return add(r, c)


def _pieces():
    """Closed lower and upper pieces as [(outward normal, loop)], plus the cut plane
    and hatch segments (3D) on the lower piece's section face."""
    n = norm(add((0.0, 0.0, 1.0), mul(RIGHT, SLOPE)))
    d = OFFSET
    lower, upper = [], []
    for fn, loop in solid_faces():
        lo, hi = clip(loop, n, d, True), clip(loop, n, d, False)
        if len(lo) >= 3:
            lower.append((fn, lo))
        if len(hi) >= 3:
            upper.append((fn, hi))
    sec = section(n, d)
    lower.append((n, sec))
    upper.append((mul(n, -1), sec))
    c = mul(tuple(map(sum, zip(*sec))), 1 / len(sec))
    return n, c, lower, upper, sec


def _hatch3d(n, c, sec, spacing):
    """45-degree hatch segments lying in the cut face, so they turn with it."""
    e1 = norm(cross(n, (0.0, 0.0, 1.0)))
    e2 = cross(n, e1)
    u = norm(add(e1, e2))               # line direction
    w = cross(n, u)                     # across the lines
    offs = [dot(sub(p, c), w) for p in sec]
    segs = []
    o = math.floor(min(offs) / spacing) * spacing + spacing / 2
    while o < max(offs):
        hits = []
        for i, p in enumerate(sec):
            q = sec[(i + 1) % len(sec)]
            sp, sq = offs[i] - o, offs[(i + 1) % len(sec)] - o
            if (sp > 0) != (sq > 0):
                hits.append(add(p, mul(sub(q, p), sp / (sp - sq))))
        if len(hits) == 2:
            segs.append(tuple(hits))
        o += spacing
    return segs


def _frame(faces, axis, c, deg, hatch=()):
    """One drawn frame of a piece turned deg about the axis: [(fill, 2D pts)], hatch."""
    out = []
    for fn, loop in faces:
        rn = _rotate(fn, axis, (0, 0, 0), deg)
        if dot(rn, VIEW) <= 1e-9:
            continue
        pts = [project(_rotate(p, axis, c, deg)) for p in loop]
        out.append(('cut' if dot(fn, axis) > 0.999 else shade(rn), pts))
    segs = [tuple(project(_rotate(p, axis, c, deg)) for p in s) for s in hatch]
    return out, segs


def svg_loop(size=256):
    """Loops: whole decahedron, a sword slash through it, the halves fly apart along
    the cut and spin opposite ways, slow to a stop, snap back together, repeat.
    Each half's spin is pre-drawn as a strip of frames that a stepped animation
    slides past a window, so the file needs no script and works in an <img>."""
    pid = 'rca'
    n, c, lower_f, upper_f, sec = _pieces()
    # timeline, seconds
    T = 5.8
    t_slash, t_hit = 0.55, 0.72          # streak starts / has crossed the solid
    t_open = 1.15                        # halves fully apart
    t_spin0, t_spin1 = 0.9, 3.75         # spin starts fast, eases out to a stop
    t_close0, t_close1 = 4.0, 4.32       # halves snap back together
    pc = lambda t: 100 * t / T

    # spin frames sampled evenly in time (FPS), so the slow end of the ease-out stays
    # smooth; frames that would barely move (under SPIN_MIN degrees) are skipped
    total = SPIN_TURNS * 360
    spin = [(t_spin0, 0.0)]
    for j in range(1, round((t_spin1 - t_spin0) * FPS)):
        t = t_spin0 + j / FPS
        deg = total * (1 - (1 - (t - t_spin0) / (t_spin1 - t_spin0)) ** 3)     # ease-out cubic
        if deg - spin[-1][1] >= SPIN_MIN and total - deg >= SPIN_MIN:
            spin.append((t, deg))
    angles = [deg for _, deg in spin]
    nvec = project(n)                                     # screen direction of the split
    off = lambda pts, s: [(x + s * nvec[0] * SPLIT / 2, y + s * nvec[1] * SPLIT / 2) for x, y in pts]

    # fit everything the animation shows (both halves split apart, every angle)
    allpts = [p for _, loop in scene()['whole'] for p in loop]
    for deg in angles:
        allpts += [p for _, pts in _frame(lower_f, n, c, -deg)[0] for p in off(pts, -1)]
        allpts += [p for _, pts in _frame(upper_f, n, c, deg)[0] for p in off(pts, 1)]
    xs, ys = [p[0] for p in allpts], [p[1] for p in allpts]
    k = (size - 2 * 34) / max(max(xs) - min(xs), max(ys) - min(ys))
    ox = size / 2 - k * (min(xs) + max(xs)) / 2
    oy = size / 2 - k * (min(ys) + max(ys)) / 2
    m = lambda pts: [(ox + k * x, oy + k * y) for x, y in pts]
    hatch = _hatch3d(n, c, sec, 9 / k)

    def strip(faces, sign, with_hatch):
        cells = []
        for i, deg in enumerate(angles):
            polys, segs = _frame(faces, n, c, sign * deg, hatch if with_hatch else ())
            parts = []
            for kind, pts in polys:
                parts.append(_poly(CUT if kind == 'cut' else kind, m(pts)))
                if kind == 'cut' and segs:
                    d = ''.join(f'M{a[0]:.1f} {a[1]:.1f}L{b[0]:.1f} {b[1]:.1f}' for a, b in (m(s) for s in segs))
                    parts.append(f'<path d="{d}" stroke="{HATCH}" stroke-width="2.4"/>' + _poly('none', m(pts)))
            cells.append(f'<g transform="translate({i * size} 0)">{"".join(parts)}</g>')
        return ''.join(cells)

    whole = ''.join(_poly(kind, m(pts)) for kind, pts in scene()['whole'])
    sx, sy = nvec[0] * SPLIT / 2 * k, nvec[1] * SPLIT / 2 * k     # each half's travel, px
    sc = scene()
    path = _slash_path(m, sc, size)

    # stepped frame keys: frame i shows from its sample time until the next
    keys = [f'0%, {pc(t_spin0):.3f}% {{ transform: translateX(0) }}']
    for i, (t, _) in enumerate(spin[1:], 1):
        keys.append(f'{pc(t):.3f}% {{ transform: translateX({-i * size}px) }}')
    keys.append(f'{pc(t_spin1):.3f}%, 100% {{ transform: translateX(0) }}')
    frames = ' '.join(keys)

    def split(sign):
        tx, ty = sign * sx, sign * sy
        return (f'0%, {pc(t_hit):.3f}% {{ transform: translate(0, 0); animation-timing-function: cubic-bezier(.15,.9,.3,1.25) }}'
                f' {pc(t_open):.3f}%, {pc(t_close0):.3f}% {{ transform: translate({tx:.2f}px, {ty:.2f}px);'
                f' animation-timing-function: cubic-bezier(.7,0,.95,.5) }}'
                f' {pc(t_close1):.3f}%, 100% {{ transform: translate(0, 0) }}')

    style = f'''  .{pid}-whole {{ opacity: 0; animation: {pid}-whole {T}s linear infinite }}
  .{pid}-lo {{ transform: translate({-sx:.2f}px, {-sy:.2f}px); animation: {pid}-lo {T}s linear infinite }}
  .{pid}-up {{ transform: translate({sx:.2f}px, {sy:.2f}px); animation: {pid}-up {T}s linear infinite }}
  .{pid}-fl, .{pid}-fu {{ animation: {pid}-frames {T}s step-end infinite }}
  @keyframes {pid}-whole {{ 0%, {pc(t_hit) - .05:.3f}% {{ opacity: 1 }} {pc(t_hit):.3f}%, {pc(t_close1):.3f}% {{ opacity: 0 }}
    {pc(t_close1) + .05:.3f}%, 100% {{ opacity: 1 }} }}
  @keyframes {pid}-lo {{ {split(-1)} }}
  @keyframes {pid}-up {{ {split(1)} }}
  @keyframes {pid}-frames {{ {frames} }}
  {_slash_keys(pid, pc(t_slash), pc(t_hit + .05), pc(t_hit + .45), f'{T}s linear infinite')}
  @media (prefers-reduced-motion: reduce) {{
    .{pid}-whole, .{pid}-lo, .{pid}-up, .{pid}-fl, .{pid}-fu, .{pid}-slash, .{pid}-sweep {{ animation: none }} }}'''
    body = f'''  <g stroke="{OUTLINE}" stroke-width="{OUTLINE_W}" stroke-linejoin="round" clip-path="url(#{pid}-win)">
  <g class="{pid}-lo"><g class="{pid}-fl">{strip(lower_f, -1, True)}</g></g>
  <g class="{pid}-up"><g class="{pid}-fu">{strip(upper_f, 1, False)}</g></g>
  <g class="{pid}-whole">{whole}</g>
  </g>
  {_sword(pid, path, size)}'''
    return _shell(pid, size, style, body, f'\n    <clipPath id="{pid}-win"><rect width="{size}" height="{size}"/></clipPath>')


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
    for name, make in (('razorcad-animated.svg', svg_loop), ('razorcad-intro.svg', svg_intro)):
        text = make()
        for folder in (ASSETS, os.path.join(ROOT, 'website', 'img')):
            with open(os.path.join(folder, name), 'w', encoding='utf-8', newline='\n') as fh:
                fh.write(text)
    raster(512).save(os.path.join(ASSETS, 'razorcad-512.png'))
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [raster(s, detail=s >= 48) for s in sizes]
    frames[-1].save(os.path.join(ASSETS, 'razorcad.ico'), sizes=[(s, s) for s in sizes],
                    append_images=frames[:-1])
    print('wrote', ASSETS)


if __name__ == '__main__':
    main()
