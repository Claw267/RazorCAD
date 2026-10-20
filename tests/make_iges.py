"""Writes the IGES test files in tests/data (for the iges-import test): plain IGES 5.3, millimetres.

    box_trimmed.igs   a 20 x 30 x 40 box as six trimmed planes (144 / 142 / 108, boundaries 102 of 110 lines)
    cyl_trimmed.igs   a cylinder r 10, 30 high: the side a rational B-spline surface (128) with its natural
                      boundary, the ends planes (108) trimmed by full circles (100)
    tetra_brep.igs    a tetrahedron (corner at the origin, legs 10) as a B-rep solid (186 / 514 / 510 / 508 /
                      504 / 502, planes 108, edges 110)

    python tests/make_iges.py
"""
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data')


class Iges:
    def __init__(self):
        self.ents = []  # [type, params, form]

    def add(self, typ, params, form=0):
        self.ents.append([typ, params, form])
        return 2 * len(self.ents) - 1  # (its directory entry's line)

    def text(self, name):
        def fmt(v):
            if isinstance(v, str):
                return f'{len(v)}H{v}'
            if isinstance(v, int):
                return str(v)
            return repr(float(v))
        plines, dlines = [], []
        for i, (typ, params, form) in enumerate(self.ents):
            de = 2 * i + 1
            rec = ','.join(fmt(x) for x in [typ] + params) + ';'
            start = len(plines) + 1
            chunks = [rec[k:k + 64] for k in range(0, len(rec), 64)]
            for c in chunks:
                plines.append(f'{c:<64} {de:>7}P{len(plines) + 1:>7}')
            f8 = lambda v: f'{v:>8}'
            dlines.append(''.join(f8(x) for x in [typ, start, 0, 0, 0, 0, 0, 0, '00000000']) + f'D{len(dlines) + 1:>7}')
            dlines.append(''.join(f8(x) for x in [typ, 0, 0, len(chunks), form, '', '', '', 0]) + f'D{len(dlines) + 1:>7}')
        g = ','.join(['1H,', '1H;', fmt('TEST'), fmt(name), fmt('RazorCAD'), fmt('1.0'), '32', '38', '6', '308', '15', fmt('TEST'), '1.0', '2', fmt('MM'), '1', '1.0', fmt('20261021.000000'), '0.001', '1000.0', fmt('RazorCAD'), fmt('RazorCAD'), '11', '0']) + ';'
        glines = [f'{g[k:k + 72]:<72}G{n + 1:>7}' for n, k in enumerate(range(0, len(g), 72))]
        slines = [f'{"RazorCAD test file":<72}S{1:>7}']
        t = f'S{len(slines):>7}G{len(glines):>7}D{len(dlines):>7}P{len(plines):>7}'
        return '\n'.join(slines + glines + dlines + plines + [f'{t:<72}T{1:>7}']) + '\n'


def line(ig, a, b):
    return ig.add(110, [*map(float, a), *map(float, b)])


def box():
    ig = Iges()
    X, Y, Z = 20.0, 30.0, 40.0
    c = lambda i, j, k: (i * X, j * Y, k * Z)
    # each face: its plane (A x + B y + C z = D, normal out) and its corners in order
    faces = [((0, 0, -1, 0), [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)]), ((0, 0, 1, Z), [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)]),
             ((0, -1, 0, 0), [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)]), ((0, 1, 0, Y), [c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0)]),
             ((-1, 0, 0, 0), [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)]), ((1, 0, 0, X), [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)])]
    for (a, b, cc, d), pts in faces:
        pl = ig.add(108, [float(a), float(b), float(cc), float(d), 0, 0.0, 0.0, 0.0, 0.0])
        segs = [line(ig, pts[i], pts[(i + 1) % 4]) for i in range(4)]
        comp = ig.add(102, [4, *segs])
        cos = ig.add(142, [0, pl, 0, comp, 2])
        ig.add(144, [pl, 1, 0, cos])
    return ig


def cylinder():
    ig = Iges()
    r, h, s = 10.0, 30.0, math.sqrt(0.5)
    ring = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1), (1, 0)]
    w = [1, s, 1, s, 1, s, 1, s, 1]
    uk = [0, 0, 0, .25, .25, .5, .5, .75, .75, 1, 1, 1]
    vk = [0, 0, 1, 1]
    # 128: K1 = 8 (u: around), K2 = 1 (v: up), M1 = 2, M2 = 1, PROP1..5; knots; weights (i fastest); points; ranges
    params = [8, 1, 2, 1, 0, 0, 0, 0, 0] + [float(x) for x in uk] + [float(x) for x in vk]
    params += [float(w[i]) for j in range(2) for i in range(9)]
    for j in range(2):
        for i in range(9):
            params += [ring[i][0] * r, ring[i][1] * r, j * h]
    params += [0.0, 1.0, 0.0, 1.0]
    side = ig.add(128, params)
    ig.add(144, [side, 0, 0, 0])
    for z, n in ((0.0, -1.0), (h, 1.0)):
        pl = ig.add(108, [0.0, 0.0, n, z * n, 0, 0.0, 0.0, 0.0, 0.0])
        circ = ig.add(100, [z, 0.0, 0.0, r, 0.0, r, 0.0])
        cos = ig.add(142, [0, pl, 0, circ, 2])
        ig.add(144, [pl, 1, 0, cos])
    return ig


def tetra():
    ig = Iges()
    V = [(0, 0, 0), (10, 0, 0), (0, 10, 0), (0, 0, 10)]
    vl = ig.add(502, [4, *[float(x) for p in V for x in p]], form=1)
    E = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)]
    curves = [line(ig, V[a], V[b]) for a, b in E]
    el = ig.add(504, [6, *[x for (a, b), cv in zip(E, curves) for x in (cv, vl, a + 1, vl, b + 1)]], form=1)
    # faces: plane (normal out), loop as (edge number, follows the edge's direction)
    F = [((0, 0, -1, 0), [(2, 1), (4, 0), (1, 0)]), ((0, -1, 0, 0), [(1, 1), (5, 1), (3, 0)]),
         ((-1, 0, 0, 0), [(3, 1), (6, 0), (2, 0)]), ((1, 1, 1, 10), [(4, 1), (6, 1), (5, 0)])]
    fl = []
    for (a, b, c, d), loop in F:
        pl = ig.add(108, [float(a), float(b), float(c), float(d), 0, 0.0, 0.0, 0.0, 0.0])
        lp = ig.add(508, [3, *[x for e, of in loop for x in (0, el, e, of, 0)]], form=1)
        fl.append(ig.add(510, [pl, 1, 1, lp], form=1))
    sh = ig.add(514, [4, *[x for f in fl for x in (f, 1)]], form=1)
    ig.add(186, [sh, 1, 0])
    return ig


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, make in (('box_trimmed.igs', box), ('cyl_trimmed.igs', cylinder), ('tetra_brep.igs', tetra)):
        with open(os.path.join(OUT, name), 'w', encoding='ascii', newline='\n') as f:
            f.write(make().text(name))
        print('wrote', name)


if __name__ == '__main__':
    main()
