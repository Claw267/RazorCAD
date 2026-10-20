// Auto-dimensioning of drawing views: the dimensions a part's views need, placed round them —
//   overall sizes (width and height of each view; the depth from the next view), outermost;
//   hole diameters ("4× Ø9" for holes of one size) and arc radii;
//   hole positions, from the view's left and bottom edges (one dimension per distinct position);
// each size once in the drawing (a size one view shows is not repeated in another of the same part), and none
// that a dimension in the view gives already. Only views looking along the part's axes are dimensioned.
import * as D from './drawing.js';

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const axisOf = (v3) => { const i = [0, 1, 2].find((k) => Math.abs(Math.abs(v3[k]) - 1) < 1e-6); return i === undefined ? null : 'xyz'[i]; };
const ROW = 7, FIRST = 9, MAX_LOCS = 8;

// The new dimension annotations (without ids) for the views, in order (dimensioned first, so the front view's
// sizes are on it). done: sizes dimensioned already (it is added to).
export function autoDims(dwg, views, geos, done = new Set()) {
  const out = [];
  for (const v of views) {
    if (!['model', 'projected', 'section', 'aux', 'flat'].includes(v.type)) continue;
    const cam = D.viewCamera(dwg, v), ax = axisOf(cam.x), ay = axisOf(cam.y);
    if (!ax || !ay || !axisOf(cam.dir)) continue;
    const pk = D.viewPickables(dwg, v, geos);
    if (pk.points.length < 2) continue;
    const X = D.viewXform(dwg, v);
    const ns = `${v.model}|${v.type === 'flat' ? 'flat' : 'part'}`;
    // (what the view's own dimensions give already)
    const have = new Set(dwg.anns.filter((a) => a.type === 'dim' && a.view === v.id).map((a) => `${a.kind}|${a.orient || ''}|${r4(D.dimValue(dwg, a))}`));
    const add = (a, key = null) => {
      const k = `${a.kind}|${a.orient || ''}|${r4(D.dimValue(dwg, a))}`;
      if (have.has(k)) { if (key) done.add(key); return false; } // (shown already: done)
      if (key && done.has(key)) return false;
      if (a.kind === 'linear' && D.dimValue(dwg, a) < 1e-6) return false;
      have.add(k);
      if (key) done.add(key);
      out.push(a);
      return true;
    };
    const base = { type: 'dim', sheet: v.sheet, view: v.id };
    // the view's extent (view coordinates) and the points at its edges
    let lo = pk.points[0], hi = lo, bo = lo, to = lo;
    for (const q of pk.points) {
      if (q.p[0] < lo.p[0] - 1e-9) lo = q;
      if (q.p[0] > hi.p[0] + 1e-9) hi = q;
      if (q.p[1] < bo.p[1] - 1e-9) bo = q;
      if (q.p[1] > to.p[1] + 1e-9) to = q;
    }
    const Ps = pk.points.map((q) => q.P);
    const sx0 = Math.min(...Ps.map((P) => P[0])), sx1 = Math.max(...Ps.map((P) => P[0])), sy0 = Math.min(...Ps.map((P) => P[1])), sy1 = Math.max(...Ps.map((P) => P[1]));
    let rowH = 0, rowV = 0; // dimension rows used above and to the right of the view
    const hDim = (p1, p2, key) => {
      const P1 = X.toSheet(p1), P2 = X.toSheet(p2);
      if (add({ ...base, kind: 'linear', orient: 'h', p1, p2, pos: [(P1[0] + P2[0]) / 2 - v.x, sy0 - FIRST - ROW * rowH - v.y] }, key)) rowH++;
    };
    const vDim = (p1, p2, key) => {
      const P1 = X.toSheet(p1), P2 = X.toSheet(p2);
      if (add({ ...base, kind: 'linear', orient: 'v', p1, p2, pos: [sx1 + FIRST + ROW * rowV - v.x, (P1[1] + P2[1]) / 2 - v.y] }, key)) rowV++;
    };
    // holes and arcs: one dimension per size (in the view the hole is round in)
    const full = new Map(), arcs = new Map();
    for (const c of pk.circles) {
      const m = c.full ? full : arcs, k = r4(c.r);
      if (!m.has(k)) m.set(k, []);
      const list = m.get(k);
      if (!list.some((o) => Math.hypot(o.c[0] - c.c[0], o.c[1] - c.c[1]) < 1e-6)) list.push(c);
    }
    const rKey = (kind, r) => `${ns}|${kind}|${r4(r)}|${axisOf(cam.dir)}`;
    for (const [r, list] of full) {
      // (the one furthest up and right takes the dimension, its leader out at 45°)
      // (its leader at 45° towards the middle of the view, clear of the dimensions round it; a hole in the
      // middle: down and to the right, away from the others)
      const c = list.reduce((b, x) => (x.C[0] - x.C[1] > b.C[0] - b.C[1] ? x : b), list[0]);
      const L = c.R + 8, mx = (sx0 + sx1) / 2 - c.C[0], my = (sy0 + sy1) / 2 - c.C[1];
      const dx = Math.abs(mx) > 1e-6 ? Math.sign(mx) : 1, dy = Math.abs(my) > 1e-6 ? Math.sign(my) : 1;
      add({ ...base, kind: 'diameter', c: c.c, r, pos: [c.C[0] + L * 0.7071 * dx - v.x, c.C[1] + L * 0.7071 * dy - v.y], ...(list.length > 1 ? { prefix: `${list.length}× ` } : {}) }, rKey('d', r));
    }
    for (const [r, list] of arcs) {
      const c = list[0], am = (c.a0 + c.a1) / 2 + (c.a1 < c.a0 ? Math.PI : 0);
      const dir = [Math.cos(am), Math.sin(am)], L = c.R + 6;
      add({ ...base, kind: 'radius', c: c.c, r, pos: [c.C[0] + L * dir[0] - v.x, c.C[1] - L * dir[1] - v.y], ...(list.length > 1 ? { prefix: `${list.length}× ` } : {}) }, rKey('r', r));
    }
    // hole positions: from the left and bottom edges, one per distinct position (only holes inside the outline)
    const centres = [...full.values()].flat().filter((c) => c.c[0] - c.r > lo.p[0] + 1e-6 || c.c[0] + c.r < hi.p[0] - 1e-6);
    const xs = [...new Set(centres.map((c) => r4(c.c[0])))].filter((x) => x > lo.p[0] + 1e-6 && x < hi.p[0] - 1e-6).sort((p, q) => p - q).slice(0, MAX_LOCS);
    const ys = [...new Set(centres.map((c) => r4(c.c[1])))].filter((y) => y > bo.p[1] + 1e-6 && y < to.p[1] - 1e-6).sort((p, q) => p - q).slice(0, MAX_LOCS);
    for (const x of xs) hDim(lo.p, centres.find((c) => r4(c.c[0]) === x).c, null);
    for (const y of ys) vDim(bo.p, centres.find((c) => r4(c.c[1]) === y).c, null);
    // overall sizes, outermost (not when the outline is a circle: its diameter gives them)
    const round = [...full.values()].flat().some((c) => c.c[0] - c.r <= lo.p[0] + 1e-6 && c.c[0] + c.r >= hi.p[0] - 1e-6 && c.c[1] - c.r <= bo.p[1] + 1e-6 && c.c[1] + c.r >= to.p[1] - 1e-6);
    if (!round) {
      hDim(lo.p, hi.p, `${ns}|size|${ax}`);
      vDim(bo.p, to.p, `${ns}|size|${ay}`);
    } else { done.add(`${ns}|size|${ax}`); done.add(`${ns}|size|${ay}`); }
  }
  return out;
}
