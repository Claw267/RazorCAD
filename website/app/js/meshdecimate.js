// Triangle mesh simplification (quadric error metrics, Garland & Heckbert): edges are collapsed one at a
// time, cheapest first, the cost being how far the merged point moves off the planes of the triangles
// around it. Open (boundary) edges are held by extra planes so the outline keeps its shape; a collapse that
// would turn a triangle over or join the mesh into a non-manifold one is skipped.
// P: [[x, y, z]…] (welded points), T: [[a, b, c]…]. Returns { P, T } with at most `target` triangles.

export function decimate(P, T, target) {
  const n = P.length, m = T.length;
  if (m <= target) return { P, T };
  const X = new Float64Array(3 * n);
  P.forEach((q, i) => { X[3 * i] = q[0]; X[3 * i + 1] = q[1]; X[3 * i + 2] = q[2]; });
  const F = new Int32Array(3 * m);
  T.forEach((t, i) => { F[3 * i] = t[0]; F[3 * i + 1] = t[1]; F[3 * i + 2] = t[2]; });
  const alive = new Uint8Array(m).fill(1);
  const dead = new Uint8Array(n);
  const ver = new Uint32Array(n);
  const vf = Array.from({ length: n }, () => []);
  for (let f = 0; f < m; f++) for (let k = 0; k < 3; k++) vf[F[3 * f + k]].push(f);

  // quadrics: [a², ab, ac, ad, b², bc, bd, c², cd, d²] per point
  const Q = new Float64Array(10 * n);
  const addPlane = (i, a, b, c, d, w) => {
    const o = 10 * i;
    Q[o] += w * a * a; Q[o + 1] += w * a * b; Q[o + 2] += w * a * c; Q[o + 3] += w * a * d;
    Q[o + 4] += w * b * b; Q[o + 5] += w * b * c; Q[o + 6] += w * b * d;
    Q[o + 7] += w * c * c; Q[o + 8] += w * c * d; Q[o + 9] += w * d * d;
  };
  const normal = (f, out) => {
    const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
    const ux = X[3 * b] - X[3 * a], uy = X[3 * b + 1] - X[3 * a + 1], uz = X[3 * b + 2] - X[3 * a + 2];
    const vx = X[3 * c] - X[3 * a], vy = X[3 * c + 1] - X[3 * a + 1], vz = X[3 * c + 2] - X[3 * a + 2];
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
    return Math.hypot(out[0], out[1], out[2]);
  };
  const nv = [0, 0, 0];
  // edges used by one triangle (the outline): held in place by planes standing on them
  const edgeUse = new Map();
  const ekey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  for (let f = 0; f < m; f++) {
    const l = normal(f, nv);
    if (l > 0) {
      const a = nv[0] / l, b = nv[1] / l, c = nv[2] / l, i0 = F[3 * f], d = -(a * X[3 * i0] + b * X[3 * i0 + 1] + c * X[3 * i0 + 2]);
      for (let k = 0; k < 3; k++) addPlane(F[3 * f + k], a, b, c, d, l / 2);
    }
    for (let k = 0; k < 3; k++) { const key = ekey(F[3 * f + k], F[3 * f + (k + 1) % 3]); edgeUse.set(key, (edgeUse.get(key) || 0) + 1); }
  }
  for (let f = 0; f < m; f++) {
    const l = normal(f, nv);
    if (!(l > 0)) continue;
    for (let k = 0; k < 3; k++) {
      const i = F[3 * f + k], j = F[3 * f + (k + 1) % 3];
      if (edgeUse.get(ekey(i, j)) !== 1) continue;
      const ex = X[3 * j] - X[3 * i], ey = X[3 * j + 1] - X[3 * i + 1], ez = X[3 * j + 2] - X[3 * i + 2];
      // the plane through the edge, square to the triangle
      let a = ey * nv[2] - ez * nv[1], b = ez * nv[0] - ex * nv[2], c = ex * nv[1] - ey * nv[0];
      const ll = Math.hypot(a, b, c);
      if (!(ll > 0)) continue;
      a /= ll; b /= ll; c /= ll;
      const d = -(a * X[3 * i] + b * X[3 * i + 1] + c * X[3 * i + 2]), w = 1000 * Math.hypot(ex, ey, ez) ** 2;
      addPlane(i, a, b, c, d, w); addPlane(j, a, b, c, d, w);
    }
  }

  const err = (q, x, y, z) => q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
  const qs = new Float64Array(10);
  // the cost of joining i and j, and where the joined point goes
  const plan = (i, j) => {
    for (let k = 0; k < 10; k++) qs[k] = Q[10 * i + k] + Q[10 * j + k];
    const [a2, ab, ac, ad, b2, bc, bd, c2, cd] = qs;
    const det = a2 * (b2 * c2 - bc * bc) - ab * (ab * c2 - bc * ac) + ac * (ab * bc - b2 * ac);
    let best = null;
    const scale = Math.abs(a2) + Math.abs(b2) + Math.abs(c2);
    if (Math.abs(det) > 1e-12 * scale * scale * scale) {
      // the point where the quadric is least
      const rx = -ad, ry = -bd, rz = -cd;
      const x = (rx * (b2 * c2 - bc * bc) - ab * (ry * c2 - bc * rz) + ac * (ry * bc - b2 * rz)) / det;
      const y = (a2 * (ry * c2 - bc * rz) - rx * (ab * c2 - bc * ac) + ac * (ab * rz - ry * ac)) / det;
      const z = (a2 * (b2 * rz - ry * bc) - ab * (ab * rz - ry * ac) + rx * (ab * bc - b2 * ac)) / det;
      // (kept near the edge: a far-off minimum is a thin-feature artefact)
      const L = Math.hypot(X[3 * i] - X[3 * j], X[3 * i + 1] - X[3 * j + 1], X[3 * i + 2] - X[3 * j + 2]);
      const mx = (X[3 * i] + X[3 * j]) / 2, my = (X[3 * i + 1] + X[3 * j + 1]) / 2, mz = (X[3 * i + 2] + X[3 * j + 2]) / 2;
      if (Math.hypot(x - mx, y - my, z - mz) < 2 * L) best = [x, y, z, err(qs, x, y, z)];
    }
    for (const [x, y, z] of [[X[3 * i], X[3 * i + 1], X[3 * i + 2]], [X[3 * j], X[3 * j + 1], X[3 * j + 2]], [(X[3 * i] + X[3 * j]) / 2, (X[3 * i + 1] + X[3 * j + 1]) / 2, (X[3 * i + 2] + X[3 * j + 2]) / 2]]) {
      const e = err(qs, x, y, z);
      if (!best || e < best[3]) best = [x, y, z, e];
    }
    return best;
  };

  // a binary heap of candidate collapses (stale ones are skipped when popped)
  const heap = [];
  const push = (it) => { heap.push(it); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p].c <= it.c) break; heap[k] = heap[p]; k = p; } heap[k] = it; };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      let k = 0;
      for (;;) { const l = 2 * k + 1, r = l + 1; let s = k; const sv = () => (s === k ? last : heap[s]); if (l < heap.length && heap[l].c < sv().c) s = l; if (r < heap.length && heap[r].c < sv().c) s = r; if (s === k) break; heap[k] = heap[s]; k = s; }
      heap[k] = last;
    }
    return top;
  };
  const queue = (i, j) => { const p = plan(i, j); push({ c: Math.max(0, p[3]), i, j, vi: ver[i], vj: ver[j], x: p[0], y: p[1], z: p[2] }); };
  for (const key of edgeUse.keys()) { const i = Math.floor(key / 4294967296), j = key - i * 4294967296; queue(i, j); }

  const neighbours = (i) => { const s = new Set(); for (const f of vf[i]) if (alive[f]) for (let k = 0; k < 3; k++) { const v = F[3 * f + k]; if (v !== i) s.add(v); } return s; };
  const n0 = [0, 0, 0], n1 = [0, 0, 0];
  // moving point i to (x, y, z) (with j merged into it) turns no triangle over
  const keepsOrientation = (i, j, x, y, z) => {
    for (const v of [i, j]) for (const f of vf[v]) {
      if (!alive[f]) continue;
      const has = [F[3 * f], F[3 * f + 1], F[3 * f + 2]];
      if (has.includes(i) && has.includes(j)) continue; // (goes away)
      const l0 = normal(f, n0);
      const k = has.indexOf(v), ox = X[3 * v], oy = X[3 * v + 1], oz = X[3 * v + 2];
      X[3 * v] = x; X[3 * v + 1] = y; X[3 * v + 2] = z;
      const l1 = normal(f, n1);
      X[3 * v] = ox; X[3 * v + 1] = oy; X[3 * v + 2] = oz;
      void k;
      if (!(l1 > 1e-12 * (l0 + 1e-30))) return false;
      if ((n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) < 0.25) return false;
    }
    return true;
  };

  let faces = m;
  while (faces > target && heap.length) {
    const it = pop();
    const { i, j } = it;
    if (dead[i] || dead[j] || it.vi !== ver[i] || it.vj !== ver[j]) continue;
    // link condition: the points next to both must be just those of the triangles on the edge
    const Ni = neighbours(i), Nj = neighbours(j);
    if (!Ni.has(j)) continue;
    let common = 0;
    for (const v of Ni) if (Nj.has(v)) common++;
    let shared = 0;
    for (const f of vf[i]) if (alive[f] && (F[3 * f] === j || F[3 * f + 1] === j || F[3 * f + 2] === j)) shared++;
    if (common !== shared) continue;
    if (!keepsOrientation(i, j, it.x, it.y, it.z)) continue;
    // collapse j into i
    X[3 * i] = it.x; X[3 * i + 1] = it.y; X[3 * i + 2] = it.z;
    for (let k = 0; k < 10; k++) Q[10 * i + k] += Q[10 * j + k];
    for (const f of vf[j]) {
      if (!alive[f]) continue;
      const o = 3 * f;
      if (F[o] === i || F[o + 1] === i || F[o + 2] === i) { alive[f] = 0; faces--; continue; }
      for (let k = 0; k < 3; k++) if (F[o + k] === j) F[o + k] = i;
      vf[i].push(f);
    }
    dead[j] = 1;
    vf[j] = [];
    vf[i] = vf[i].filter((f) => alive[f]);
    ver[i]++;
    for (const v of neighbours(i)) queue(i, v);
  }
  // the points still used, numbered again
  const map = new Int32Array(n).fill(-1), P2 = [], T2 = [];
  for (let f = 0; f < m; f++) {
    if (!alive[f]) continue;
    const t = [];
    for (let k = 0; k < 3; k++) {
      const v = F[3 * f + k];
      if (map[v] < 0) { map[v] = P2.length; P2.push([X[3 * v], X[3 * v + 1], X[3 * v + 2]]); }
      t.push(map[v]);
    }
    if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) T2.push(t);
  }
  return { P: P2, T: T2 };
}
