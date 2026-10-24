// 3D sketch data, geometry and solver (no display): shared by the 3D sketch editor (sketch3d.js) and the
// geometry kernel, which re-solves 3D sketches whose converted entities follow model edges.

import * as W from './wcs.js';

export const REL3D = {
  alongX: { label: 'Along X', glyph: 'X', refs: ['seg'] },
  alongY: { label: 'Along Y', glyph: 'Y', refs: ['seg'] },
  alongZ: { label: 'Along Z', glyph: 'Z', refs: ['seg'] },
  parallelXY: { label: 'Parallel to XY', glyph: '∥XY', refs: ['seg'] },
  parallelYZ: { label: 'Parallel to YZ', glyph: '∥YZ', refs: ['seg'] },
  parallelZX: { label: 'Parallel to ZX', glyph: '∥ZX', refs: ['seg'] },
  parallel: { label: 'Parallel', glyph: '∥', refs: ['seg', 'seg'] },
  perpendicular: { label: 'Perpendicular', glyph: '⊥', refs: ['seg', 'seg'] },
  collinear: { label: 'Collinear', glyph: '≡', refs: ['seg', 'seg'] },
  equal: { label: 'Equal Length', glyph: '=', refs: ['seg', 'seg'] },
  equalR: { label: 'Equal Radius', glyph: '=', refs: ['arc', 'arc'] },
  equalDist: { label: 'Equal Distance', glyph: '=', refs: ['pt', 'pt', 'pt', 'pt'] },
  tangent: { label: 'Tangent', glyph: 'T', refs: ['arc', 'seg'] },
  midpoint: { label: 'Midpoint', glyph: 'M', refs: ['pt', 'seg'] },
  onLine: { label: 'On Line', glyph: '◦', refs: ['pt', 'seg'] },
  onXY: { label: 'On XY (Front) plane', glyph: '⌗XY', refs: ['pt'] },
  onYZ: { label: 'On YZ (Right) plane', glyph: '⌗YZ', refs: ['pt'] },
  onZX: { label: 'On ZX (Top) plane', glyph: '⌗ZX', refs: ['pt'] },
  onPlane: { label: 'On Plane', glyph: '⌗', refs: ['pt'] },
  regular: { label: 'Regular Polygon', glyph: '⬡', refs: ['pt'] },
  fix: { label: 'Fix', glyph: '⚓', refs: ['pt'] },
  length: { label: 'Length', dim: true, refs: ['seg'] },
  distance: { label: 'Distance', dim: true, refs: ['pt', 'pt'] },
  angle: { label: 'Angle', dim: true, refs: ['seg', 'seg'] },
  radius: { label: 'Radius', dim: true, refs: ['arc'] },
  diameter: { label: 'Diameter', dim: true, refs: ['circle'] },
};

export const PLANES = {
  XY: { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], color: 0x2563eb, name: 'XY (Front)' },
  YZ: { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], color: 0xdc2626, name: 'YZ (Right)' },
  ZX: { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], color: 0x16a34a, name: 'ZX (Top)' },
};
export const AXES = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
// The names of the axes and planes above as the user sees them (wcs.js: with Z up, RazorCAD's Y is called Z and its
// Z −Y; the XY plane is called XZ, ZX is XY): the relations and planes keep RazorCAD's keys, only their names change.
export function relabelAxes3D() {
  const L = (k) => W.axisLetter(k.toLowerCase()), P = (k) => W.planeLabel(k);
  for (const k of ['X', 'Y', 'Z']) Object.assign(REL3D['along' + k], { label: `Along ${L(k)}`, glyph: L(k) });
  const std = { XY: 'Front', YZ: 'Right', ZX: 'Top' };
  for (const k of ['XY', 'YZ', 'ZX']) {
    Object.assign(REL3D['parallel' + k], { label: `Parallel to ${P(k)}`, glyph: '∥' + P(k) });
    Object.assign(REL3D['on' + k], { label: `On ${P(k)} (${std[k]}) plane`, glyph: '⌗' + P(k) });
    PLANES[k].name = `${P(k)} (${std[k]})`;
  }
}
export const COORD = { x: 0, y: 1, z: 2 };
export const TAU = 2 * Math.PI;

// ------------------------------------------------------------------ vectors and geometry
export const V = (p) => [p.x, p.y, p.z];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mulv = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (a) => { const l = len(a) || 1; return mulv(a, 1 / l); };
export const r6 = (x) => Math.round(x * 1e6) / 1e6;
// v turned about the unit axis n by ang (right hand)
export const rot = (v, n, ang) => { const c = Math.cos(ang), s = Math.sin(ang), k = dot(n, v), cr = cross(n, v); return v.map((x, i) => x * c + cr[i] * s + n[i] * k * (1 - c)); };
// a unit vector square to n
export const perp = (n) => unit(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));

export const isLine = (s) => !s.type || s.type === 'line';
export const getPt = (f, id) => f.pts.find((p) => p.id === id);
export const getSeg = (f, id) => f.segs.find((s) => s.id === id);
// 'pt' | 'seg' (a line) | 'arc' | 'circle'
export const kindOf = (f, id) => { if (getPt(f, id)) return 'pt'; const s = getSeg(f, id); return !s ? null : isLine(s) ? 'seg' : s.type; };
export const segPts = (s) => (s.type === 'circle' ? [s.c] : s.type === 'arc' ? [s.a, s.b, s.c] : s.type === 'spline' ? s.pts.slice() : [s.a, s.b]);
// the two ends of an open entity (a spline: its first and last point), null for a circle / closed spline
export const segEnds = (s) => (s.type === 'circle' || (s.type === 'spline' && s.closed) ? null : s.type === 'spline' ? [s.pts[0], s.pts[s.pts.length - 1]] : [s.a, s.b]);

// the closest points of segments AB and CD: { p (on AB), d } (null for parallel ones that don't overlap usefully)
export function closestSegSeg(A, B, C, D) {
  const u = sub(B, A), v = sub(D, C), w = sub(A, C);
  const a = dot(u, u), b = dot(u, v), c = dot(v, v), d = dot(u, w), e = dot(v, w), den = a * c - b * b;
  if (den < 1e-12 * a * c) return null;
  let s = (b * e - c * d) / den, t = (a * e - b * d) / den;
  s = Math.max(0, Math.min(1, s)); t = Math.max(0, Math.min(1, t));
  const P = addv(A, mulv(u, s)), Q = addv(C, mulv(v, t));
  return { p: P, d: len(sub(P, Q)) };
}
// where segment AB meets the circle (centre C, normal n, radius R): in its plane, or piercing it at the rim
export function lineRound(A, B, C, n, R, tol) {
  const u = sub(B, A), out = [];
  const un = dot(u, n), an = dot(sub(A, C), n);
  if (Math.abs(un) > 1e-9 * len(u)) {
    const t = -an / un;
    if (t < -1e-9 || t > 1 + 1e-9) return out;
    const q = addv(A, mulv(u, t));
    if (Math.abs(len(sub(q, C)) - R) < tol) out.push(q);
    return out;
  }
  if (Math.abs(an) > tol) return out;
  const w = sub(A, C), a = dot(u, u), b = 2 * dot(u, w), c = dot(w, w) - R * R, disc = b * b - 4 * a * c;
  if (disc < 0) return out;
  for (const t of disc < 1e-18 ? [-b / (2 * a)] : [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)]) if (t > -1e-9 && t < 1 + 1e-9) out.push(addv(A, mulv(u, t)));
  return out;
}

// an arc: centre, ends, radius, sweep (counterclockwise round n), and points along it (t 0…1)
export function arcGeom(f, s) {
  const C = V(getPt(f, s.c)), A = V(getPt(f, s.a)), B = V(getPt(f, s.b)), n = unit(s.n);
  const u = sub(A, C), w = sub(B, C);
  let th = Math.atan2(dot(n, cross(u, w)), dot(u, w));
  if (th <= 1e-9) th += TAU;
  return { C, A, B, n, R: len(u), th, at: (t) => addv(C, rot(u, n, th * t)) };
}
// A spline through points P (closed: back to the first): cubic Bézier pieces, each point's tangent along the
// chord of its neighbours; T0 / T1 (unit vectors along the curve) fix the end tangents (else a natural end).
export function splineBeziers(P, T0 = null, T1 = null, closed = false) {
  const n = P.length;
  if (n < 2) return [];
  const at = (i) => P[((i % n) + n) % n];
  const T = P.map((_, i) => {
    if (closed) return unit(sub(at(i + 1), at(i - 1)));
    if (i > 0 && i < n - 1) return unit(sub(P[i + 1], P[i - 1]));
    return null;
  });
  if (!closed) {
    if (n === 2) { T[0] = T0 || unit(sub(P[1], P[0])); T[1] = T1 || unit(sub(P[1], P[0])); }
    else {
      // (a natural end: the tangent mirrored about the end chord)
      const nat = (A, B, Tn) => { const c = unit(sub(B, A)); return unit(sub(mulv(c, 2 * dot(c, Tn)), Tn)); };
      T[0] = T0 || nat(P[0], P[1], T[1]);
      T[n - 1] = T1 || nat(P[n - 2], P[n - 1], T[n - 2]);
    }
  }
  const out = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const A = at(i), B = at(i + 1), d = len(sub(B, A)) / 3;
    out.push([A, addv(A, mulv(T[i], d)), sub(B, mulv(T[(i + 1) % n], d)), B]);
  }
  return out;
}
// A curvature-continuous (C2) spline through P: a cubic spline in chord length (its tangents solved so the curvature
// runs on smoothly through every point), as cubic Bézier pieces. Open ends: natural (no curvature), or the given
// tangents T0 / T1 (unit) times w0 / w1 times the end chord; closed: periodic.
export function splineC2(P, T0 = null, T1 = null, closed = false, w0 = 1, w1 = 1) {
  const n = P.length;
  if (n < 2) return [];
  if (n === 2 && !closed) return splineBeziers(P, T0, T1, false);
  const m = closed ? n : n - 1, h = [];
  for (let i = 0; i < m; i++) h.push(Math.max(1e-9, len(sub(P[(i + 1) % n], P[i]))));
  // the tangents D (per unit of chord length): A D = rhs, one row per point
  const A = Array.from({ length: n }, () => new Array(n).fill(0)), rhs = Array.from({ length: n }, () => [0, 0, 0]);
  const dq = (i) => mulv(sub(P[(i + 1) % n], P[i]), 1 / h[i]); // (the chord's direction / length)
  for (let i = 0; i < n; i++) {
    if (!closed && i === 0) {
      if (T0) { A[0][0] = 1; rhs[0] = mulv(unit(T0), w0); } else { A[0][0] = 2; A[0][1] = 1; rhs[0] = mulv(dq(0), 3); }
      continue;
    }
    if (!closed && i === n - 1) {
      if (T1) { A[i][i] = 1; rhs[i] = mulv(unit(T1), w1); } else { A[i][i - 1] = 1; A[i][i] = 2; rhs[i] = mulv(dq(n - 2), 3); }
      continue;
    }
    const ip = (i - 1 + n) % n, hp = h[ip], hn = h[i % m];
    A[i][ip] += hn; A[i][i] += 2 * (hp + hn); A[i][(i + 1) % n] += hp;
    rhs[i] = mulv(addv(mulv(dq(ip), hn), mulv(dq(i % m), hp)), 3);
  }
  // (Gaussian elimination with partial pivoting; n is small)
  const M = A.map((r, i) => [...r, ...rhs[i]]), W = n + 3;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c && M[r][c]) { const k = M[r][c] / d; for (let q = c; q < W; q++) M[r][q] -= k * M[c][q]; }
  }
  const D = M.map((r, i) => [r[n] / (r[i] || 1e-12), r[n + 1] / (r[i] || 1e-12), r[n + 2] / (r[i] || 1e-12)]);
  const out = [];
  for (let i = 0; i < m; i++) {
    const a = P[i], b = P[(i + 1) % n], k = h[i] / 3;
    out.push([a, addv(a, mulv(D[i], k)), sub(b, mulv(D[(i + 1) % n], k)), b]);
  }
  return out;
}
// The curvature of a cubic Bézier piece q at t: { p (point), k (curvature, 1/mm), n (unit normal, towards the centre) }
export function bezierCurvature(q, t) {
  const u = 1 - t;
  const d1 = [0, 1, 2].map((k) => 3 * (u * u * (q[1][k] - q[0][k]) + 2 * u * t * (q[2][k] - q[1][k]) + t * t * (q[3][k] - q[2][k])));
  const d2 = [0, 1, 2].map((k) => 6 * (u * (q[2][k] - 2 * q[1][k] + q[0][k]) + t * (q[3][k] - 2 * q[2][k] + q[1][k])));
  const c = cross(d1, d2), l1 = len(d1);
  const k = l1 > 1e-12 ? len(c) / l1 ** 3 : 0;
  const nrm = l1 > 1e-12 && len(c) > 1e-15 ? unit(cross(c, d1)) : [0, 0, 0];
  return { p: bez(q, t), k, n: nrm };
}
const bez = (q, t) => { const u = 1 - t; return [0, 1, 2].map((k) => u * u * u * q[0][k] + 3 * u * u * t * q[1][k] + 3 * u * t * t * q[2][k] + t * t * t * q[3][k]); };
// a spline entity: its pieces, and points along it; end tangents from Tangent relations with lines met there
export function splineGeom(f, s) {
  const P = s.pts.map((id) => V(getPt(f, id)));
  const tan = (end) => {
    const pid = end ? s.pts[s.pts.length - 1] : s.pts[0];
    for (const r of f.rels || []) {
      if (r.type !== 'tangent' || !r.refs.includes(s.id)) continue;
      const o = getSeg(f, r.refs.find((x) => x !== s.id));
      if (!o || !isLine(o) || (o.a !== pid && o.b !== pid)) continue;
      const other = V(getPt(f, o.a === pid ? o.b : o.a)), at = V(getPt(f, pid));
      return unit(end ? sub(other, at) : sub(at, other));
    }
    return null;
  };
  // (s.smooth 'c2': curvature-continuous; w0 / w1: how strongly the end tangents pull)
  const w0 = Number(s.w0) > 0 ? Number(s.w0) : 1, w1 = Number(s.w1) > 0 ? Number(s.w1) : 1;
  let pieces;
  if (s.smooth === 'c2') {
    const t0 = s.closed ? null : tan(false), t1 = s.closed ? null : tan(true);
    pieces = splineC2(P, t0, t1, !!s.closed, w0, w1);
  } else {
    pieces = splineBeziers(P, s.closed ? null : tan(false), s.closed ? null : tan(true), !!s.closed);
    // (end weights: the first and last handles longer or shorter)
    if (!s.closed && pieces.length && (w0 !== 1 || w1 !== 1)) {
      const f0 = pieces[0], fl = pieces[pieces.length - 1];
      f0[1] = addv(f0[0], mulv(sub(f0[1], f0[0]), w0));
      fl[2] = addv(fl[3], mulv(sub(fl[2], fl[3]), w1));
    }
  }
  return { P, pieces, sample: (m = 16) => pieces.flatMap((q, i) => Array.from({ length: m + (i === pieces.length - 1 ? 1 : 0) }, (_, k) => bez(q, k / m))) };
}

export function circleGeom(f, s) {
  const C = V(getPt(f, s.c)), n = unit(s.n), u = mulv(perp(n), s.r);
  return { C, n, R: s.r, at: (t) => addv(C, rot(u, n, TAU * t)) };
}

// An older 3D sketch (points without ids, joined in order) becomes points + lines.
export function normalize3d(f, ev = (x) => +x) {
  if (Array.isArray(f.segs) && (f.pts || []).every((p) => p.id)) { f.rels ||= []; return f; }
  const pts = (f.pts || []).map((q, i) => ({ id: 'p' + (i + 1), x: +ev(q.x ?? 0) || 0, y: +ev(q.y ?? 0) || 0, z: +ev(q.z ?? 0) || 0 }));
  const segs = [];
  for (let i = 1; i < pts.length; i++) segs.push({ id: 's' + i, a: pts[i - 1].id, b: pts[i].id });
  if (f.closed && pts.length > 2) segs.push({ id: 's' + pts.length, a: pts[pts.length - 1].id, b: pts[0].id });
  f.pts = pts;
  f.segs = segs;
  f.rels = [];
  f.nextId = pts.length + segs.length + 1;
  delete f.closed;
  return f;
}

export const newId = (f, prefix) => { f.nextId = (f.nextId || 1); return prefix + f.nextId++; };

// ------------------------------------------------------------------ solver
// The unknowns are the points' coordinates and the circles' radii. Each relation gives equations (arcs bring
// their own: both ends at one radius, in their plane); they are solved by Gauss-Newton steps of least change
// (dx = -Jᵀ(JJᵀ + μI)⁻¹F), so what is not held stays where it is.
export const unknowns = (f) => [...f.pts.flatMap((p) => [p.x, p.y, p.z]), ...f.segs.filter((s) => s.type === 'circle').map((s) => s.r)];
export function equations(f, ev) {
  const idx = new Map(f.pts.map((p, i) => [p.id, 3 * i]));
  const ridx = new Map(f.segs.filter((s) => s.type === 'circle').map((s, i) => [s.id, 3 * f.pts.length + i]));
  const P = (X, id) => { const i = idx.get(id); return [X[i], X[i + 1], X[i + 2]]; };
  // a round's radius, and the unknowns it uses
  const RAD = (s) => (s.type === 'circle' ? { v: [ridx.get(s.id)], r: (X) => X[ridx.get(s.id)] } : { v: [...vars(s.a, s.c)], r: (X) => len(sub(P(X, s.a), P(X, s.c))) });
  const vars = (...ids) => ids.flatMap((id) => { const i = idx.get(id); return [i, i + 1, i + 2]; });
  const eqs = [];
  const add = (v, fn) => eqs.push({ v, f: fn });
  for (const s of f.segs) {
    if (s.type !== 'arc' || ![s.a, s.b, s.c].every((x) => idx.has(x))) continue;
    const n = unit(s.n), v = vars(s.a, s.b, s.c);
    add(v, (X) => len(sub(P(X, s.a), P(X, s.c))) - len(sub(P(X, s.b), P(X, s.c))));
    add(v, (X) => dot(sub(P(X, s.a), P(X, s.c)), n));
    add(v, (X) => dot(sub(P(X, s.b), P(X, s.c)), n));
  }
  for (const r of f.rels || []) {
    const S = (k) => getSeg(f, r.refs[k]);
    const val = () => { const x = ev(r.value); return Number.isFinite(x) ? x : NaN; };
    try {
      switch (r.type) {
        case 'alongX': case 'alongY': case 'alongZ': {
          const s = S(0); if (!s) break;
          const k = { alongX: 0, alongY: 1, alongZ: 2 }[r.type];
          for (const c of [0, 1, 2]) if (c !== k) add(vars(s.a, s.b), (X) => P(X, s.b)[c] - P(X, s.a)[c]);
          break;
        }
        case 'parallelXY': case 'parallelYZ': case 'parallelZX': {
          const s = S(0); if (!s) break;
          const c = { parallelXY: 2, parallelYZ: 0, parallelZX: 1 }[r.type];
          add(vars(s.a, s.b), (X) => P(X, s.b)[c] - P(X, s.a)[c]);
          break;
        }
        case 'parallel': case 'perpendicular': case 'collinear': {
          const s1 = S(0), s2 = S(1); if (!s1 || !s2) break;
          const d = (X) => { const a = sub(P(X, s1.b), P(X, s1.a)), b = sub(P(X, s2.b), P(X, s2.a)); return [a, b, (len(a) * len(b)) || 1]; };
          const v = vars(s1.a, s1.b, s2.a, s2.b);
          if (r.type === 'perpendicular') add(v, (X) => { const [a, b, l] = d(X); return dot(a, b) / l; });
          else for (const c of [0, 1, 2]) add(v, (X) => { const [a, b, l] = d(X); return cross(a, b)[c] / l; });
          if (r.type === 'collinear') for (const c of [0, 1, 2]) add(v, (X) => { const a = sub(P(X, s1.b), P(X, s1.a)); return cross(sub(P(X, s2.a), P(X, s1.a)), a)[c] / (len(a) || 1); });
          break;
        }
        case 'equal': {
          const s1 = S(0), s2 = S(1); if (!s1 || !s2) break;
          add(vars(s1.a, s1.b, s2.a, s2.b), (X) => len(sub(P(X, s1.b), P(X, s1.a))) - len(sub(P(X, s2.b), P(X, s2.a))));
          break;
        }
        case 'equalR': {
          const s1 = S(0), s2 = S(1); if (!s1 || !s2 || isLine(s1) || isLine(s2)) break;
          const A = RAD(s1), B = RAD(s2);
          add([...A.v, ...B.v], (X) => A.r(X) - B.r(X));
          break;
        }
        case 'equalDist': {
          const [a, b, c, d] = r.refs; if (![a, b, c, d].every((x) => idx.has(x))) break;
          add(vars(a, b, c, d), (X) => len(sub(P(X, b), P(X, a))) - len(sub(P(X, d), P(X, c))));
          break;
        }
        case 'tangent': {
          // (a spline takes its end tangent from the line: no equation)
          const s1 = S(0), s2 = S(1); if (!s1 || !s2 || s1.type === 'spline' || s2.type === 'spline') break;
          if (s1.type === 'arc' && s2.type === 'arc') {
            // two arcs meeting at a point: their centres and that point in line
            const E = [s2.a, s2.b].includes(s1.a) ? s1.a : s1.b;
            for (const c of [0, 1, 2]) add(vars(s1.c, s2.c, E), (X) => { const u = sub(P(X, E), P(X, s1.c)), w = sub(P(X, E), P(X, s2.c)); return cross(u, w)[c] / ((len(u) * len(w)) || 1); });
            break;
          }
          // an arc and a line meeting at a point: there the line runs square to the radius
          const [arc, ln] = s1.type === 'arc' ? [s1, s2] : [s2, s1];
          if (arc.type !== 'arc' || !isLine(ln)) break;
          const E = [ln.a, ln.b].includes(arc.a) ? arc.a : arc.b, O = ln.a === E ? ln.b : ln.a;
          add(vars(arc.c, E, O), (X) => { const rr = sub(P(X, E), P(X, arc.c)), d = sub(P(X, O), P(X, E)); return dot(rr, d) / ((len(rr) * len(d)) || 1); });
          break;
        }
        case 'midpoint': {
          const s = S(1), p = r.refs[0]; if (!s || !idx.has(p)) break;
          if (s.type === 'arc') {
            // the middle of an arc: as far from both ends, on the arc
            for (const fn of [(X) => len(sub(P(X, p), P(X, s.a))) - len(sub(P(X, p), P(X, s.b))), (X) => len(sub(P(X, p), P(X, s.c))) - len(sub(P(X, s.a), P(X, s.c))), (X) => dot(sub(P(X, p), P(X, s.c)), unit(s.n))]) add(vars(p, s.a, s.b, s.c), fn);
          } else for (const c of [0, 1, 2]) add(vars(p, s.a, s.b), (X) => P(X, p)[c] - (P(X, s.a)[c] + P(X, s.b)[c]) / 2);
          break;
        }
        case 'onLine': {
          const s = S(1), p = r.refs[0]; if (!s || !idx.has(p)) break;
          for (const c of [0, 1, 2]) add(vars(p, s.a, s.b), (X) => { const d = sub(P(X, s.b), P(X, s.a)); return cross(sub(P(X, p), P(X, s.a)), d)[c] / (len(d) || 1); });
          break;
        }
        case 'onXY': case 'onYZ': case 'onZX': {
          const p = r.refs[0]; if (!idx.has(p)) break;
          const c = { onXY: 2, onYZ: 0, onZX: 1 }[r.type];
          add(vars(p), (X) => P(X, p)[c]);
          break;
        }
        case 'onPlane': {
          const p = r.refs[0], pl = r.value; if (!idx.has(p) || !pl?.n) break;
          add(vars(p), (X) => dot(P(X, p), pl.n) - pl.d);
          break;
        }
        case 'regular': {
          // a regular polygon: the corners at one radius from the centre, in its plane, with equal sides
          const [c, ...vs] = r.refs, n = unit(r.value?.n || [0, 0, 1]);
          if (![c, ...vs].every((x) => idx.has(x)) || vs.length < 3) break;
          const v = vars(c, ...vs), k = vs.length;
          for (let i = 0; i < k; i++) {
            add(v, (X) => dot(sub(P(X, vs[i]), P(X, c)), n));
            if (i) add(v, (X) => len(sub(P(X, vs[i]), P(X, c))) - len(sub(P(X, vs[0]), P(X, c))));
            if (i) add(v, (X) => len(sub(P(X, vs[(i + 1) % k]), P(X, vs[i]))) - len(sub(P(X, vs[1]), P(X, vs[0]))));
          }
          break;
        }
        case 'fix': {
          const p = r.refs[0]; if (!idx.has(p) || !Array.isArray(r.value)) break;
          for (const c of [0, 1, 2]) add(vars(p), (X) => P(X, p)[c] - r.value[c]);
          break;
        }
        case 'length': case 'distance': {
          const [a, b] = r.type === 'length' ? (S(0) ? [S(0).a, S(0).b] : []) : r.refs;
          if (!idx.has(a) || !idx.has(b)) break;
          // (along an axis: the signed run along it, the way it was dimensioned)
          if (r.axis) { const c = COORD[r.axis]; add(vars(a, b), (X) => (P(X, b)[c] - P(X, a)[c]) * (r.sgn || 1) - val()); }
          else add(vars(a, b), (X) => len(sub(P(X, b), P(X, a))) - val());
          break;
        }
        case 'radius': case 'diameter': {
          const s = S(0); if (!s || isLine(s)) break;
          const k = r.type === 'diameter' ? 2 : 1, A = RAD(s);
          add(A.v, (X) => k * A.r(X) - val());
          break;
        }
        case 'angle': {
          const s1 = S(0), s2 = S(1); if (!s1 || !s2) break;
          add(vars(s1.a, s1.b, s2.a, s2.b), (X) => {
            const a = sub(P(X, s1.b), P(X, s1.a)), b = sub(P(X, s2.b), P(X, s2.a));
            return Math.atan2(len(cross(a, b)), dot(a, b)) - (val() * Math.PI) / 180;
          });
          break;
        }
        default:
      }
    } catch { /* a relation on something deleted */ }
  }
  return { eqs, idx };
}

// Solve: pinned = coordinate indices held where they are (the point being dragged). Returns { ok, residual }.
export function solve3d(f, ev, { pinned = null } = {}) {
  const { eqs } = equations(f, ev);
  const X = unknowns(f);
  if (!eqs.length) return { ok: true, residual: 0 };
  const free = (i) => !pinned || !pinned.has(i);
  const m = eqs.length;
  const F = new Float64Array(m);
  const evalF = () => { let s = 0; for (let k = 0; k < m; k++) { F[k] = eqs[k].f(X); s += F[k] * F[k]; } return Math.sqrt(s); };
  let res = evalF();
  const scale = Math.max(1, ...X.map(Math.abs));
  for (let it = 0; it < 80 && res > 1e-9 * scale && Number.isFinite(res); it++) {
    // Jacobian rows (numeric, only the variables each equation uses)
    const J = eqs.map((e) => e.v.filter(free).map((i) => {
      const h = 1e-7 * Math.max(1, Math.abs(X[i])), x0 = X[i];
      X[i] = x0 + h; const fp = e.f(X); X[i] = x0 - h; const fm = e.f(X); X[i] = x0;
      return [i, (fp - fm) / (2 * h)];
    }).filter(([, d]) => d !== 0));
    // A = J Jᵀ + μ I
    const A = Array.from({ length: m }, () => new Float64Array(m));
    const rowMap = J.map((row) => new Map(row));
    for (let a = 0; a < m; a++) for (let b = a; b < m; b++) {
      let s = 0;
      const [ra, rb] = J[a].length < J[b].length ? [J[a], rowMap[b]] : [J[b], rowMap[a]];
      for (const [i, d] of ra) { const e = rb.get(i); if (e) s += d * e; }
      A[a][b] = A[b][a] = s;
    }
    for (let a = 0; a < m; a++) A[a][a] += 1e-12 + 1e-9 * A[a][a];
    const y = gauss(A, Array.from(F));
    if (!y) break;
    const step = new Float64Array(X.length);
    for (let a = 0; a < m; a++) for (const [i, d] of J[a]) step[i] -= d * y[a];
    // (damped when a full step makes things worse)
    let t = 1, next = res;
    const X0 = X.slice();
    for (let tries = 0; tries < 8; tries++) {
      for (let i = 0; i < X.length; i++) X[i] = X0[i] + t * step[i];
      next = evalF();
      if (next < res) break;
      t /= 2;
    }
    if (!(next < res)) { for (let i = 0; i < X.length; i++) X[i] = X0[i]; evalF(); break; }
    res = next;
  }
  const ok = res < 1e-6 * scale;
  if (ok) {
    f.pts.forEach((p, i) => { p.x = r6(X[3 * i]); p.y = r6(X[3 * i + 1]); p.z = r6(X[3 * i + 2]); });
    f.segs.filter((q) => q.type === 'circle').forEach((q, i) => { q.r = r6(Math.abs(X[3 * f.pts.length + i])); });
  }
  return { ok, residual: res };
}

// Degrees of freedom left (3 per point, 1 per circle's radius, less the independent equations).
export function freedom3d(f, ev) {
  const { eqs } = equations(f, ev);
  const X = unknowns(f);
  const n = X.length;
  const rows = eqs.map((e) => {
    const row = new Float64Array(n);
    for (const i of e.v) {
      const h = 1e-6 * Math.max(1, Math.abs(X[i])), x0 = X[i];
      X[i] = x0 + h; const fp = e.f(X); X[i] = x0 - h; const fm = e.f(X); X[i] = x0;
      row[i] += (fp - fm) / (2 * h);
    }
    return row;
  });
  // rank by elimination
  let rank = 0;
  const used = new Array(rows.length).fill(false);
  for (let c = 0; c < n && rank < rows.length; c++) {
    let best = -1, bv = 1e-7;
    for (let r = 0; r < rows.length; r++) if (!used[r] && Math.abs(rows[r][c]) > bv) { bv = Math.abs(rows[r][c]); best = r; }
    if (best < 0) continue;
    used[best] = true;
    rank++;
    for (let r = 0; r < rows.length; r++) {
      if (used[r] || !rows[r][c]) continue;
      const k = rows[r][c] / rows[best][c];
      for (let j = c; j < n; j++) rows[r][j] -= k * rows[best][j];
    }
  }
  return n - rank;
}

export function gauss(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-18) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const k = A[r][c] / A[c][c];
      if (!k) continue;
      for (let j = c; j < n; j++) A[r][j] -= k * A[c][j];
      b[r] -= k * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j];
    x[r] = s / A[r][r];
  }
  return x;
}

// The relations that can be added to a selection (ids): [type, refs in order].
export function applicableRelations(f, ids) {
  const of = (k) => ids.filter((id) => kindOf(f, id) === k);
  const pts = of('pt'), segs = of('seg'), arcs = of('arc'), circles = of('circle');
  const out = [];
  const splines = ids.filter((id) => kindOf(f, id) === 'spline');
  if (splines.length) {
    if (splines.length === 1 && segs.length === 1 && !pts.length && !arcs.length && !circles.length) {
      const sp = getSeg(f, splines[0]), l = getSeg(f, segs[0]), e = segEnds(sp) || [];
      if (e.some((x) => x === l.a || x === l.b)) out.push(['tangent', [splines[0], segs[0]]]);
    }
    return out;
  }
  if (arcs.length || circles.length) {
    if (arcs.length === 2 && !segs.length && !pts.length && !circles.length) {
      const [a1, a2] = arcs.map((x) => getSeg(f, x));
      if ([a2.a, a2.b].includes(a1.a) || [a2.a, a2.b].includes(a1.b)) out.push(['tangent', arcs]);
    }
    if (arcs.length + circles.length === 2 && !segs.length && !pts.length) out.push(['equalR', [...arcs, ...circles]]);
    if (arcs.length === 1 && segs.length === 1 && !pts.length && !circles.length) {
      const a = getSeg(f, arcs[0]), l = getSeg(f, segs[0]);
      if (!a || !l) return out;
      if ([l.a, l.b].includes(a.a) || [l.a, l.b].includes(a.b)) out.push(['tangent', [arcs[0], segs[0]]]);
    }
    if (arcs.length === 1 && pts.length === 1 && !segs.length && !circles.length) out.push(['midpoint', [pts[0], arcs[0]]]);
    return out;
  }
  if (segs.length === 1 && !pts.length) out.push(['alongX', segs], ['alongY', segs], ['alongZ', segs], ['parallelXY', segs], ['parallelYZ', segs], ['parallelZX', segs]);
  if (segs.length === 2 && !pts.length) out.push(['parallel', segs], ['perpendicular', segs], ['collinear', segs], ['equal', segs]);
  if (pts.length === 1 && segs.length === 1) out.push(['midpoint', [pts[0], segs[0]]], ['onLine', [pts[0], segs[0]]]);
  if (pts.length >= 1 && !segs.length) out.push(['fix', pts], ['onXY', pts], ['onYZ', pts], ['onZX', pts]);
  if (pts.length === 2 && !segs.length) out.push(['merge', pts]);
  return out;
}
