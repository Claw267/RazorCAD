// Fast hidden-line views, for drawings of big assemblies (thousands of solids, where exact hidden-line removal
// takes far too long). The parts' display meshes, placed as the assembly places them, are drawn into a depth
// grid as seen along the view; then every B-rep edge, and the outline of every curved face, is followed over
// that grid: visible ('v') where nothing is in front of it, hidden ('h') where something is. The lines are as
// exact as the display meshes (circles and arcs come out as circles and arcs), and where they turn hidden is
// as exact as the grid (a few thousandths of the view's size).
//
// Messages in:  { type: 'parts', parts: [{ key, V, T, groups: [{ start, count, curved }], ep, eo }] }  (kept here)
//               { type: 'views', req, inst: [{ key, M }], views: [{ id, dir, up, cells }] }
// Messages out: { progress } and { req, results: [{ id, edges: [{ k, g }], cut: [], box, holes: [] }] } or { req, error }
// (M: a part's placement, row-major 3×4; views as drawing.js asks for them: dir toward the viewer, up its vertical.)
import { classifyPolyline3 } from './sketchmodel.js';

const parts = new Map();

const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A part as received, with its triangles' normals and, inside each curved face, the pairs of triangles that
// share an edge (where its outline can be).
function prepare(p) {
  const { V, T } = p, nt = T.length / 3;
  const tn = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = T[3 * t] * 3, b = T[3 * t + 1] * 3, c = T[3 * t + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    tn[3 * t] = uy * vz - uz * vy; tn[3 * t + 1] = uz * vx - ux * vz; tn[3 * t + 2] = ux * vy - uy * vx;
  }
  const adj = [];
  const K = 4194304; // (vertex pairs as one number)
  for (const g of p.groups) {
    if (!g.curved) continue;
    const open = new Map();
    for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) {
      for (let e = 0; e < 3; e++) {
        const a = T[3 * t + e], b = T[3 * t + ((e + 1) % 3)];
        const k = a < b ? a * K + b : b * K + a;
        const o = open.get(k);
        if (o === undefined) open.set(k, t); else { adj.push(o, t, a, b); open.delete(k); }
      }
    }
  }
  return { V, T, tn, ep: p.ep, eo: p.eo, adj: Uint32Array.from(adj) };
}

// view coordinate rows: u = cu · [x y z 1] for a part placed by M (and the same for v and depth)
const rowOf = (a, M) => [a[0] * M[0] + a[1] * M[4] + a[2] * M[8], a[0] * M[1] + a[1] * M[5] + a[2] * M[9], a[0] * M[2] + a[1] * M[6] + a[2] * M[10], a[0] * M[3] + a[1] * M[7] + a[2] * M[11]];

function viewOf(inst, v) {
  const dir = unit(v.dir), x = unit(cross(v.up || [0, 1, 0], dir)), y = cross(dir, x);
  // every placed part's vertices in view coordinates (u, v, depth: larger is nearer the viewer)
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity, d0 = Infinity, d1 = -Infinity;
  const placed = [];
  for (const it of inst) {
    const p = parts.get(it.key);
    if (!p) continue;
    const cu = rowOf(x, it.M), cv = rowOf(y, it.M), cd = rowOf(dir, it.M);
    const { V } = p, n = V.length / 3, P = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const px = V[3 * i], py = V[3 * i + 1], pz = V[3 * i + 2];
      const uu = cu[0] * px + cu[1] * py + cu[2] * pz + cu[3], vv = cv[0] * px + cv[1] * py + cv[2] * pz + cv[3], dd = cd[0] * px + cd[1] * py + cd[2] * pz + cd[3];
      P[3 * i] = uu; P[3 * i + 1] = vv; P[3 * i + 2] = dd;
      if (uu < u0) u0 = uu; if (uu > u1) u1 = uu; if (vv < v0) v0 = vv; if (vv > v1) v1 = vv; if (dd < d0) d0 = dd; if (dd > d1) d1 = dd;
    }
    placed.push({ p, P, cu, cv, cd });
  }
  if (!placed.length || !isFinite(u0)) return { id: v.id, edges: [], cut: [], box: { min: [0, 0], max: [0, 0] }, holes: [] };
  // the depth grid
  const cells = Math.max(256, Math.min(6144, v.cells || 4096));
  const cell = Math.max(u1 - u0, v1 - v0, 1e-6) / (cells - 2);
  const W = Math.ceil((u1 - u0) / cell) + 3, H = Math.ceil((v1 - v0) / cell) + 3;
  const Z = new Float32Array(W * H).fill(-Infinity);
  const gx = (uu) => (uu - u0) / cell + 1, gy = (vv) => (vv - v0) / cell + 1;
  for (const { p, P } of placed) {
    const T = p.T;
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
      const x0 = gx(P[a]), y0 = gy(P[a + 1]), z0 = P[a + 2], x1 = gx(P[b]), y1 = gy(P[b + 1]), z1 = P[b + 2], x2 = gx(P[c]), y2 = gy(P[c + 1]), z2 = P[c + 2];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      const ix0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), ix1 = Math.min(W - 1, Math.floor(Math.max(x0, x1, x2)));
      const iy0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), iy1 = Math.min(H - 1, Math.floor(Math.max(y0, y1, y2)));
      let hit = false;
      if (Math.abs(area) > 1e-12) {
        const ia = 1 / area;
        for (let py = iy0; py <= iy1; py++) {
          const cy = py + 0.5;
          for (let px = ix0; px <= ix1; px++) {
            const cx = px + 0.5;
            const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * ia, w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * ia, w2 = 1 - w0 - w1;
            if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7) continue;
            const d = w0 * z0 + w1 * z1 + w2 * z2, k = py * W + px;
            if (d > Z[k]) Z[k] = d;
            hit = true;
          }
        }
      }
      // (a triangle smaller than a cell, or seen edge on, still hides what is behind it)
      if (!hit) {
        const k = Math.floor((y0 + y1 + y2) / 3) * W + Math.floor((x0 + x1 + x2) / 3), d = Math.max(z0, z1, z2);
        if (k >= 0 && k < Z.length && d > Z[k]) Z[k] = d;
      }
    }
  }
  // a point at (u, v, depth) is seen when nothing in its cell is in front of it (by more than the surface it is on
  // can rise across a cell)
  const tol = cell * 3 + (d1 - d0) * 1e-6;
  // (straight within a hundredth of a cell, or the float precision of the model's size)
  const lineTol = Math.max(cell * 0.01, Math.max(Math.abs(u0), Math.abs(u1), Math.abs(v0), Math.abs(v1)) * 2e-7);
  const seen = (uu, vv, dd) => {
    const k = Math.floor(gy(vv)) * W + Math.floor(gx(uu));
    return !(Z[k] > dd + tol);
  };
  const edges = [];
  // follow a polyline (view coordinates: flat u, v, d triples) and add its visible and hidden runs
  const follow = (Q) => {
    const n = Q.length / 3;
    if (n < 2) return;
    // samples about a cell apart; the polyline's own points kept
    const S = [];
    for (let i = 0; i < n - 1; i++) {
      const au = Q[3 * i], av = Q[3 * i + 1], ad = Q[3 * i + 2], bu = Q[3 * i + 3], bv = Q[3 * i + 4], bd = Q[3 * i + 5];
      const m = Math.max(1, Math.ceil(Math.hypot(bu - au, bv - av) / cell));
      for (let s = i ? 1 : 0; s <= m; s++) {
        const t = s / m;
        S.push([au + (bu - au) * t, av + (bv - av) * t, ad + (bd - ad) * t, s === 0 || s === m]);
      }
    }
    const vis = S.map((s) => seen(s[0], s[1], s[2]));
    // (a lone sample that differs from both its neighbours is noise in the grid)
    for (let i = 1; i < vis.length - 1; i++) if (vis[i - 1] === vis[i + 1] && vis[i] !== vis[i - 1]) vis[i] = vis[i - 1];
    let run = [[S[0][0], S[0][1]]], k = vis[0];
    const flush = () => {
      if (run.length < 2) return;
      // (an edge seen end on, or a sliver shorter than a quarter of a cell: nothing to draw, as in exact views)
      let L = 0;
      for (let j = 1; j < run.length && L < cell * 0.25; j++) L += Math.hypot(run[j][0] - run[j - 1][0], run[j][1] - run[j - 1][1]);
      if (L < cell * 0.25) return;
      const g = classify(run, lineTol);
      if (g) edges.push({ k: k ? 'v' : 'h', g });
    };
    for (let i = 1; i < S.length; i++) {
      if (vis[i] !== k) {
        const m = [(S[i - 1][0] + S[i][0]) / 2, (S[i - 1][1] + S[i][1]) / 2];
        run.push(m); flush();
        run = [m]; k = vis[i];
      }
      if (S[i][3] || i === S.length - 1) run.push([S[i][0], S[i][1]]);
    }
    flush();
  };
  for (const { p, cu, cv, cd, P } of placed) {
    // the B-rep edges
    const { ep, eo } = p;
    for (let e = 0; e + 1 < eo.length; e++) {
      const a = eo[e], b = eo[e + 1], Q = new Float64Array(b - a);
      for (let k = a; k < b; k += 3) {
        const px = ep[k], py = ep[k + 1], pz = ep[k + 2];
        Q[k - a] = cu[0] * px + cu[1] * py + cu[2] * pz + cu[3]; Q[k - a + 1] = cv[0] * px + cv[1] * py + cv[2] * pz + cv[3]; Q[k - a + 2] = cd[0] * px + cd[1] * py + cd[2] * pz + cd[3];
      }
      follow(Q);
    }
    // the outlines of curved faces: where a face turns from facing the viewer to facing away
    const { adj, tn } = p, lx = cd[0], ly = cd[1], lz = cd[2];
    const segs = new Map(); // vertex → [other vertex…]
    for (let i = 0; i < adj.length; i += 4) {
      const ta = adj[i], tb = adj[i + 1];
      const fa = tn[3 * ta] * lx + tn[3 * ta + 1] * ly + tn[3 * ta + 2] * lz, fb = tn[3 * tb] * lx + tn[3 * tb + 1] * ly + tn[3 * tb + 2] * lz;
      if ((fa > 0) === (fb > 0)) continue;
      const va = adj[i + 2], vb = adj[i + 3];
      (segs.get(va) || segs.set(va, []).get(va)).push(vb);
      (segs.get(vb) || segs.set(vb, []).get(vb)).push(va);
    }
    // chained into polylines
    const used = new Set(), key = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
    const chain = (start) => {
      const out = [start];
      let cur = start;
      for (;;) {
        const nx = (segs.get(cur) || []).find((w) => !used.has(key(cur, w)));
        if (nx === undefined) break;
        used.add(key(cur, nx)); out.push(nx); cur = nx;
      }
      return out;
    };
    const ends = [...segs.keys()].filter((vv) => segs.get(vv).length !== 2);
    for (const s of [...ends, ...segs.keys()]) {
      while ((segs.get(s) || []).some((w) => !used.has(key(s, w)))) {
        const ids = chain(s);
        if (ids.length < 2) break;
        const Q = new Float64Array(ids.length * 3);
        ids.forEach((id, j) => { Q[3 * j] = P[3 * id]; Q[3 * j + 1] = P[3 * id + 1]; Q[3 * j + 2] = P[3 * id + 2]; });
        follow(Q);
      }
    }
  }
  // the view's extent
  const b2 = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  const grow = (q) => { if (q[0] < b2.min[0]) b2.min[0] = q[0]; if (q[1] < b2.min[1]) b2.min[1] = q[1]; if (q[0] > b2.max[0]) b2.max[0] = q[0]; if (q[1] > b2.max[1]) b2.max[1] = q[1]; };
  for (const { g } of edges) {
    if (g.t === 'l') { grow(g.a); grow(g.b); } else if (g.t === 'p') g.pts.forEach(grow);
    else if (g.t === 'c') { grow([g.c[0] - g.r, g.c[1] - g.r]); grow([g.c[0] + g.r, g.c[1] + g.r]); }
    else {
      // an arc: its ends and the quadrant points it passes
      const span = ((g.a1 - g.a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const at = (t) => [g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)];
      grow(at(g.a0)); grow(at(g.a0 + span));
      for (let q = Math.ceil(g.a0 / (Math.PI / 2)) * (Math.PI / 2); q < g.a0 + span; q += Math.PI / 2) grow(at(q));
    }
  }
  return { id: v.id, edges, cut: [], box: isFinite(b2.min[0]) ? b2 : { min: [0, 0], max: [0, 0] }, holes: [], fast: { cell: +cell.toPrecision(3) } };
}

// A 2D polyline as a drawing primitive: a line, circle or arc where it is one, else a polyline (as exact views
// do). tol: how far off straight still counts as a line (the display meshes are single precision, so at the size
// of a site layout a straight edge's points are a little off it).
function classify(pts2, tol) {
  const n = pts2.length, a = pts2[0], b = pts2[n - 1];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L > 1e-9) {
    let off = 0;
    for (const q of pts2) off = Math.max(off, Math.abs((q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0])) / L);
    if (off <= tol) return { t: 'l', a: [a[0], a[1]], b: [b[0], b[1]] };
  }
  const pts = pts2.map((q) => [q[0], q[1], 0]);
  const g = classifyPolyline3(pts);
  if (!g) return null;
  const p2 = (q) => [q[0], q[1]];
  if (g.type === 'line') return Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) < 1e-9 ? null : { t: 'l', a: p2(g.a), b: p2(g.b) };
  // (a circle or arc far bigger than the run itself is a nearly straight run: kept as the polyline)
  let ext = 0;
  for (const q of pts2) ext = Math.max(ext, Math.hypot(q[0] - a[0], q[1] - a[1]));
  if ((g.type === 'circle' || g.type === 'arc') && !(g.r < Math.max(ext, tol) * 50)) return { t: 'p', pts: pts2 };
  if (g.type === 'circle') return { t: 'c', c: p2(g.c), r: g.r };
  if (g.type === 'arc') {
    const ang = (q) => Math.atan2(q[1] - g.c[1], q[0] - g.c[0]);
    let a0 = ang(g.a), a1 = ang(g.b);
    const am = ang(g.m), TAU = 2 * Math.PI, nrm = (t) => ((t % TAU) + TAU) % TAU;
    if (nrm(am - a0) > nrm(a1 - a0)) [a0, a1] = [a1, a0];
    return { t: 'a', c: p2(g.c), r: g.r, a0, a1 };
  }
  return { t: 'p', pts: pts2 };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'parts') { for (const p of m.parts) if (!parts.has(p.key)) parts.set(p.key, prepare(p)); return; }
  if (m.type === 'drop') { for (const k of m.keys || []) parts.delete(k); return; }
  if (m.type === 'views') {
    try {
      const results = [];
      for (const v of m.views) {
        self.postMessage({ progress: `Drawing ${v.id}…` });
        results.push(viewOf(m.inst, v));
      }
      self.postMessage({ req: m.req, results });
    } catch (err) { self.postMessage({ req: m.req, error: err.message || String(err) }); }
  }
};
