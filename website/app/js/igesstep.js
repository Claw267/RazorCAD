// IGES files (.igs, .iges) read by translating them into STEP (the geometry kernel reads STEP): the IGES entities
// RazorCAD understands become the matching STEP geometry and topology —
//   curves: 100 circular arc, 102 composite curve, 104 conic (an ellipse, as points), 106 copious data (polylines),
//     110 line, 126 rational B-spline curve (all written as B-spline curves; arcs exactly, as rational ones);
//   surfaces: 108 plane, 118 ruled surface (as a fine B-spline), 120 surface of revolution, 122 tabulated cylinder,
//     128 rational B-spline surface, 190 plane, 192 cylinder, 194 cone, 196 sphere, 198 torus;
//   faces: 144 trimmed surface and 143 bounded surface (their 142 / 141 boundaries in model space), each a face of
//     its own (sewn into a body by the kernel afterwards); 186 B-rep solid with its shells, faces, loops, edge and
//     vertex lists (514, 510, 508, 504, 502), kept as a solid;
//   124 transformation matrices, and the file's units (to millimetres).
// igesToStep(text) → { step, faces, solids, skipped: { type: count } }.

// ------------------------------------------------------------------ reading IGES
function parseIges(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length >= 73);
  const sec = (c) => lines.filter((l) => l[72] === c);
  // global section: its own delimiters first ("1H," / "1H;")
  const g = sec('G').map((l) => l.slice(0, 72)).join('');
  let pd = ',', rd = ';', gi = 0;
  if (g.startsWith('1H')) { pd = g[2]; gi = 4; } else if (g[0] === pd) gi = 1;
  if (g.slice(gi, gi + 2) === '1H') { rd = g[gi + 2]; }
  const globals = splitParams(g, pd, rd);
  // (units: field 14 the unit flag, 13 the model space scale)
  const UNITS = { 1: 25.4, 2: 1, 4: 304.8, 5: 1609344, 6: 1000, 7: 1e6, 8: 0.0254, 9: 0.001, 10: 10, 11: 0.0000254 };
  const flag = Math.round(Number(globals[13])) || 2;
  let unit = UNITS[flag] ?? 1;
  if (flag === 3) { const name = String(globals[14] || '').toUpperCase(); unit = /IN/.test(name) ? 25.4 : /^M$|METER|METRE/.test(name) ? 1000 : /CM/.test(name) ? 10 : /FT|FOOT/.test(name) ? 304.8 : 1; }
  const scale = Number(globals[12]) || 1;
  const d = sec('D');
  const de = new Map();
  for (let i = 0; i + 1 < d.length; i += 2) {
    const a = d[i], b = d[i + 1], f = (s, k) => s.slice(k * 8, k * 8 + 8).trim();
    const seq = parseInt(a.slice(73, 80), 10) || i + 1;
    de.set(seq, { seq, type: +f(a, 0), pointer: +f(a, 1), transform: +f(a, 6) || 0, status: f(a, 8), form: +f(b, 4) || 0 });
  }
  // parameter data: lines gathered by the entity they belong to
  const pdata = new Map();
  for (const l of sec('P')) {
    const k = parseInt(l.slice(64, 72), 10);
    pdata.set(k, (pdata.get(k) || '') + l.slice(0, 64));
  }
  for (const e of de.values()) {
    const p = splitParams(pdata.get(e.seq) || '', pd, rd);
    e.params = p.slice(1).map((x) => (typeof x === 'string' ? x : x));
  }
  return { de, unit: unit * scale };
}
// parameters split at the delimiter, Hollerith strings (nH…) kept whole; numbers as numbers
function splitParams(s, pd, rd) {
  const out = [];
  let i = 0, cur = '';
  while (i < s.length) {
    const c = s[i];
    if (/\d/.test(c) && cur.trim() === '' ) {
      const m = /^(\d+)H/.exec(s.slice(i));
      if (m) { const n = +m[1], start = i + m[0].length; out.push(s.slice(start, start + n)); i = start + n; while (i < s.length && s[i] !== pd && s[i] !== rd) i++; if (s[i] === rd) break; i++; cur = ''; continue; }
    }
    if (c === pd || c === rd) { out.push(num(cur)); cur = ''; i++; if (c === rd) break; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(num(cur));
  return out;
}
function num(s) {
  const t = String(s).trim();
  if (t === '') return null;
  const v = Number(t.replace(/D/i, 'E'));
  return Number.isFinite(v) ? v : t;
}

// ------------------------------------------------------------------ geometry helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };
const perp = (n) => unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
// a point of a (rational) B-spline curve { deg, knots (full), ctrl, w } at parameter t
function bsplineAt(c, t) {
  const { deg: p, knots: U, ctrl: P } = c, W = c.w || P.map(() => 1), n = P.length - 1;
  t = Math.min(Math.max(t, U[p]), U[n + 1]);
  let k = p;
  while (k < n && t >= U[k + 1]) k++;
  const d = [];
  for (let j = 0; j <= p; j++) { const i = k - p + j, w = W[i]; d.push([P[i][0] * w, P[i][1] * w, P[i][2] * w, w]); }
  for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
    const i = k - p + j, den = U[i + p - r + 1] - U[i], a = den ? (t - U[i]) / den : 0;
    for (let q = 0; q < 4; q++) d[j][q] = (1 - a) * d[j - 1][q] + a * d[j][q];
  }
  const h = d[p];
  return [h[0] / h[3], h[1] / h[3], h[2] / h[3]];
}
// an arc as a rational quadratic B-spline (pieces of up to 90°): centre c, axes x / y (unit), radius r, from
// angle a0 counter-clockwise to a1
function arcSpline(c, x, y, r, a0, a1) {
  let sweep = a1 - a0;
  while (sweep <= 1e-9) sweep += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9)), da = sweep / n, w1 = Math.cos(da / 2);
  const at = (a, rr = r) => add(c, add(mul(x, rr * Math.cos(a)), mul(y, rr * Math.sin(a))));
  const ctrl = [at(a0)], w = [1], knots = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const am = a0 + da * (i + 0.5), ae = a0 + da * (i + 1);
    ctrl.push(at(am, r / w1), at(ae)); w.push(w1, 1);
    if (i < n - 1) knots.push((i + 1) / n, (i + 1) / n);
  }
  knots.push(1, 1, 1);
  return { deg: 2, knots, ctrl, w, t0: 0, t1: 1 };
}
const polySpline = (pts) => {
  const n = pts.length, knots = [0, ...pts.map((_, i) => i / (n - 1)), 1];
  return { deg: 1, knots, ctrl: pts, w: null, t0: 0, t1: 1 };
};

// ------------------------------------------------------------------ IGES → curves and surfaces (model space, mm)
export function igesToStep(text) {
  const { de, unit: U } = parseIges(text);
  const skipped = {};
  const skip = (t) => { skipped[t] = (skipped[t] || 0) + 1; return null; };
  const get = (p) => de.get(Math.abs(Math.round(p)));
  // the transformation matrix of an entity (its 124, through the chain), applied to points / directions
  const mats = new Map();
  const matOf = (seq) => {
    if (!seq) return null;
    if (mats.has(seq)) return mats.get(seq);
    const e = de.get(seq);
    if (!e || e.type !== 124) return null;
    const v = e.params.map(Number);
    let m = { r: [[v[0], v[1], v[2]], [v[4], v[5], v[6]], [v[8], v[9], v[10]]], t: [v[3], v[7], v[11]] };
    const up = matOf(e.transform);
    if (up) m = { r: up.r.map((row) => [0, 1, 2].map((j) => dot(row, [m.r[0][j], m.r[1][j], m.r[2][j]]))), t: add(up.r.map((row) => dot(row, m.t)), up.t) };
    mats.set(seq, m);
    return m;
  };
  const xf = (e) => {
    const m = matOf(e.transform);
    return {
      p: (q) => mul(m ? add(m.r.map((row) => dot(row, q)), m.t) : q, U),
      d: (q) => (m ? unit(m.r.map((row) => dot(row, q))) : unit(q)),
    };
  };
  // curves: a list of pieces { deg, knots, ctrl, w, t0, t1 } (composites: their members, in order)
  const curveCache = new Map();
  const curve = (seq) => {
    const e = get(seq);
    if (!e) return [];
    if (curveCache.has(e.seq)) return curveCache.get(e.seq);
    const P = e.params, X = xf(e);
    let out = [];
    if (e.type === 110) out = [polySpline([X.p([P[0], P[1], P[2]]), X.p([P[3], P[4], P[5]])])];
    else if (e.type === 100) {
      const zt = P[0], c = [P[1], P[2], zt], s = [P[3], P[4], zt], f = [P[5], P[6], zt], r = Math.hypot(s[0] - c[0], s[1] - c[1]);
      const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
      let a1 = Math.atan2(f[1] - c[1], f[0] - c[0]);
      if (Math.hypot(f[0] - s[0], f[1] - s[1]) < 1e-9 * Math.max(1, r)) a1 = a0 + 2 * Math.PI;
      const arc = arcSpline(c, [1, 0, 0], [0, 1, 0], r, a0, a1);
      arc.ctrl = arc.ctrl.map(X.p);
      out = [arc];
    } else if (e.type === 102) out = P.slice(1, 1 + P[0]).flatMap((q) => curve(q));
    else if (e.type === 106) {
      const ip = P[0], n = P[1], pts = [];
      if (ip === 1) for (let i = 0; i < n; i++) pts.push([P[3 + 2 * i], P[4 + 2 * i], P[2]]);
      else { const st = ip === 3 ? 6 : 3; for (let i = 0; i < n; i++) pts.push([P[2 + st * i], P[3 + st * i], P[4 + st * i]]); }
      out = pts.length > 1 ? [polySpline(pts.map(X.p))] : [];
    } else if (e.type === 104) {
      // (a conic as points: an ellipse in standard position A x² + C y² + F = 0, else its chord)
      const [A, , C, , , F, zt, x1, y1, x2, y2] = P;
      if (A * C > 0 && F * A < 0) {
        const a = Math.sqrt(-F / A), b = Math.sqrt(-F / C), t0 = Math.atan2(y1 / b, x1 / a);
        let t1 = Math.atan2(y2 / b, x2 / a);
        while (t1 <= t0 + 1e-9) t1 += 2 * Math.PI;
        const pts = Array.from({ length: 49 }, (_, i) => { const t = t0 + ((t1 - t0) * i) / 48; return [a * Math.cos(t), b * Math.sin(t), zt]; });
        out = [polySpline(pts.map(X.p))];
      } else out = [polySpline([[x1, y1, zt], [x2, y2, zt]].map(X.p))];
    } else if (e.type === 126) {
      const K = P[0], M = P[1], nk = K + M + 2, at = 6;
      const knots = P.slice(at, at + nk), w = P.slice(at + nk, at + nk + K + 1), ctrl = [];
      for (let i = 0; i <= K; i++) { const o = at + nk + K + 1 + 3 * i; ctrl.push(X.p([P[o], P[o + 1], P[o + 2]])); }
      const o = at + nk + 4 * (K + 1);
      const rational = P[4] === 0 && w.some((x) => Math.abs(x - w[0]) > 1e-12);
      out = [{ deg: M, knots, ctrl, w: rational ? w : null, t0: P[o] ?? knots[M], t1: P[o + 1] ?? knots[K + 1] }];
    } else if (e.type === 142) {
      out = P[3] ? curve(P[3]) : (skip('142 without a model space curve'), []);
    } else skip(e.type);
    curveCache.set(e.seq, out);
    return out;
  };
  // surfaces: STEP text of the surface entity (written later), or null
  const surf = (seq) => {
    const e = get(seq);
    if (!e) return null;
    const P = e.params, X = xf(e);
    if (e.type === 128) {
      const K1 = P[0], K2 = P[1], M1 = P[2], M2 = P[3], n1 = K1 + M1 + 2, n2 = K2 + M2 + 2;
      let o = 9;
      const uk = P.slice(o, o + n1); o += n1;
      const vk = P.slice(o, o + n2); o += n2;
      const N = (K1 + 1) * (K2 + 1), W = P.slice(o, o + N); o += N;
      const grid = [], wg = [];
      for (let i = 0; i <= K1; i++) { grid.push([]); wg.push([]); }
      for (let j = 0; j <= K2; j++) for (let i = 0; i <= K1; i++) { const q = o + 3 * (j * (K1 + 1) + i); grid[i][j] = X.p([P[q], P[q + 1], P[q + 2]]); wg[i][j] = W[j * (K1 + 1) + i]; }
      const rational = P[6] === 0 && W.some((x) => Math.abs(x - W[0]) > 1e-12);
      return { kind: 'bspline', du: M1, dv: M2, uk, vk, grid, w: rational ? wg : null };
    }
    if (e.type === 108) {
      const n = unit([P[0], P[1], P[2]]), p0 = mul(n, P[3] / len([P[0], P[1], P[2]]));
      return { kind: 'plane', o: X.p(p0), n: X.d(n), x: X.d(perp(n)), bound: e.form === 1 ? P[4] : 0 };
    }
    if (e.type === 190 || e.type === 192 || e.type === 194 || e.type === 196 || e.type === 198) {
      const pt = (q) => { const x = get(q); return x ? X.p(x.params.slice(0, 3).map(Number)) : [0, 0, 0]; };
      const dir = (q, dflt) => { const x = get(q); return x ? X.d(x.params.slice(0, 3).map(Number)) : dflt; };
      if (e.type === 190) { const n = dir(P[1], [0, 0, 1]); return { kind: 'plane', o: pt(P[0]), n, x: P[2] ? dir(P[2]) : perp(n) }; }
      if (e.type === 192) { const n = dir(P[1], [0, 0, 1]); return { kind: 'cylinder', o: pt(P[0]), n, x: P[3] ? dir(P[3]) : perp(n), r: P[2] * U }; }
      if (e.type === 194) { const n = dir(P[1], [0, 0, 1]); return { kind: 'cone', o: pt(P[0]), n, x: P[4] ? dir(P[4]) : perp(n), r: P[2] * U, a: (P[3] * Math.PI) / 180 }; }
      if (e.type === 196) { const n = dir(P[2], [0, 0, 1]); return { kind: 'sphere', o: pt(P[0]), n, x: P[3] ? dir(P[3]) : perp(n), r: P[1] * U }; }
      const n = dir(P[1], [0, 0, 1]);
      return { kind: 'torus', o: pt(P[0]), n, x: P[4] ? dir(P[4]) : perp(n), R: P[2] * U, r: P[3] * U };
    }
    if (e.type === 120) {
      const L = curve(P[0])[0], C = curve(P[1]);
      if (!L || !C.length) return skip('120 parts');
      const a = L.ctrl[0], b = L.ctrl[L.ctrl.length - 1];
      return { kind: 'revolution', curve: C[0], o: a, d: unit(sub(b, a)) };
    }
    if (e.type === 122) {
      const C = curve(P[0]);
      if (!C.length) return skip('122 parts');
      const start = bsplineAt(C[0], C[0].t0), end = X.p([P[1], P[2], P[3]]);
      // (the generatrix: from the directrix's start to the given point; the directrix itself is already in model space)
      const v = sub(end, start);
      return { kind: 'extrusion', curve: C[0], d: unit(v), l: len(v) };
    }
    if (e.type === 118) {
      // (two curves joined by straight lines: as a B-spline of 33 × 2 points)
      const c1 = curve(P[0])[0], c2 = curve(P[1])[0];
      if (!c1 || !c2) return skip('118 parts');
      const n = 33, at = (c, i) => bsplineAt(c, c.t0 + ((c.t1 - c.t0) * i) / (n - 1));
      const rev = P[2] === 1;
      const grid = Array.from({ length: n }, (_, i) => [at(c1, i), at(c2, rev ? n - 1 - i : i)]);
      return { kind: 'bspline', du: 1, dv: 1, uk: [0, ...grid.map((_, i) => i / (n - 1)), 1], vk: [0, 0, 1, 1], grid, w: null };
    }
    return skip(e.type);
  };

  // ------------------------------------------------------------------ writing STEP
  const ents = [];
  const id = (s) => { ents.push(s); return '#' + ents.length; };
  const f = (x) => { const v = +(+x).toPrecision(15); return Number.isInteger(v) ? v.toFixed(1) : String(v).replace(/e/, 'E'); };
  const pt = (p) => id(`CARTESIAN_POINT('',(${p.map(f).join(',')}))`);
  const dirE = (d) => id(`DIRECTION('',(${d.map(f).join(',')}))`);
  const ax2 = (o, z, x) => id(`AXIS2_PLACEMENT_3D('',${pt(o)},${dirE(z)},${dirE(x)})`);
  const knotList = (full) => { const k = [], m = []; for (const x of full) { if (k.length && Math.abs(x - k[k.length - 1]) < 1e-12) m[m.length - 1]++; else { k.push(x); m.push(1); } } return { k, m }; };
  const stepCurve = (c) => {
    const { k, m } = knotList(c.knots), cp = `(${c.ctrl.map(pt).join(',')})`;
    if (!c.w) return id(`B_SPLINE_CURVE_WITH_KNOTS('',${c.deg},${cp},.UNSPECIFIED.,.F.,.F.,(${m.join(',')}),(${k.map(f).join(',')}),.UNSPECIFIED.)`);
    return id(`(BOUNDED_CURVE()B_SPLINE_CURVE(${c.deg},${cp},.UNSPECIFIED.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS((${m.join(',')}),(${k.map(f).join(',')}),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE((${c.w.map(f).join(',')}))REPRESENTATION_ITEM(''))`);
  };
  const stepSurf = (s) => {
    if (s.kind === 'plane') return id(`PLANE('',${ax2(s.o, s.n, s.x)})`);
    if (s.kind === 'cylinder') return id(`CYLINDRICAL_SURFACE('',${ax2(s.o, s.n, s.x)},${f(s.r)})`);
    if (s.kind === 'cone') return id(`CONICAL_SURFACE('',${ax2(s.o, s.n, s.x)},${f(s.r)},${f(s.a)})`);
    if (s.kind === 'sphere') return id(`SPHERICAL_SURFACE('',${ax2(s.o, s.n, s.x)},${f(s.r)})`);
    if (s.kind === 'torus') return id(`TOROIDAL_SURFACE('',${ax2(s.o, s.n, s.x)},${f(s.R)},${f(s.r)})`);
    if (s.kind === 'revolution') return id(`SURFACE_OF_REVOLUTION('',${stepCurve(s.curve)},${id(`AXIS1_PLACEMENT('',${pt(s.o)},${dirE(s.d)})`)})`);
    if (s.kind === 'extrusion') return id(`SURFACE_OF_LINEAR_EXTRUSION('',${stepCurve(s.curve)},${id(`VECTOR('',${dirE(s.d)},${f(s.l)})`)})`);
    const u = knotList(s.uk), v = knotList(s.vk), cp = `(${s.grid.map((row) => `(${row.map(pt).join(',')})`).join(',')})`;
    if (!s.w) return id(`B_SPLINE_SURFACE_WITH_KNOTS('',${s.du},${s.dv},${cp},.UNSPECIFIED.,.F.,.F.,.F.,(${u.m.join(',')}),(${v.m.join(',')}),(${u.k.map(f).join(',')}),(${v.k.map(f).join(',')}),.UNSPECIFIED.)`);
    return id(`(BOUNDED_SURFACE()B_SPLINE_SURFACE(${s.du},${s.dv},${cp},.UNSPECIFIED.,.F.,.F.,.F.)B_SPLINE_SURFACE_WITH_KNOTS((${u.m.join(',')}),(${v.m.join(',')}),(${u.k.map(f).join(',')}),(${v.k.map(f).join(',')}),.UNSPECIFIED.)GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE((${s.w.map((row) => `(${row.map(f).join(',')})`).join(',')}))REPRESENTATION_ITEM('')SURFACE())`);
  };
  // a loop of curve pieces (one after another) as a STEP edge loop; vertices shared between neighbours
  const loopOf = (pieces) => {
    if (!pieces.length) return null;
    const ends = pieces.map((c) => [bsplineAt(c, c.t0), bsplineAt(c, c.t1)]);
    const vs = ends.map((e) => id(`VERTEX_POINT('',${pt(e[0])})`));
    const edges = pieces.map((c, i) => {
      const vEnd = len(sub(ends[i][1], ends[(i + 1) % pieces.length][0])) < 1e-6 * Math.max(1, len(ends[i][1])) ? vs[(i + 1) % pieces.length] : id(`VERTEX_POINT('',${pt(ends[i][1])})`);
      return id(`ORIENTED_EDGE('',*,*,${id(`EDGE_CURVE('',${vs[i]},${vEnd},${stepCurve(c)},.T.)`)},.T.)`);
    });
    return id(`EDGE_LOOP('',(${edges.join(',')}))`);
  };
  // the natural boundary of a B-spline surface: its four edge rows of control points
  const naturalLoop = (s) => {
    if (s.kind !== 'bspline') return null;
    const row = (pts, ws, deg, knots) => ({ deg, knots, ctrl: pts, w: ws, t0: knots[deg], t1: knots[knots.length - deg - 1] });
    const g = s.grid, W = s.w, nI = g.length - 1, nJ = g[0].length - 1;
    const colU = (j) => g.map((r) => r[j]), colW = (j) => (W ? W.map((r) => r[j]) : null);
    const rev = (c) => ({ ...c, ctrl: [...c.ctrl].reverse(), w: c.w ? [...c.w].reverse() : null, knots: c.knots.map((k) => -k).reverse(), t0: -c.t1, t1: -c.t0 });
    return loopOf([row(colU(0), colW(0), s.du, s.uk), row(g[nI], W ? W[nI] : null, s.dv, s.vk), rev(row(colU(nJ), colW(nJ), s.du, s.uk)), rev(row(g[0], W ? W[0] : null, s.dv, s.vk))]);
  };

  const faces = [];
  // trimmed (144) and bounded (143) surfaces: a face each
  for (const e of de.values()) {
    if (e.type !== 144 && e.type !== 143) continue;
    const P = e.params;
    const s = surf(e.type === 144 ? P[0] : P[1]);
    if (!s) continue;
    const bounds = [];
    if (e.type === 144) {
      if (P[1] === 0 || !P[3]) { const l = naturalLoop(s); if (l) bounds.push(id(`FACE_OUTER_BOUND('',${l},.T.)`)); }
      else { const l = loopOf(curve(P[3])); if (l) bounds.push(id(`FACE_OUTER_BOUND('',${l},.T.)`)); }
      for (let i = 0; i < (P[2] || 0); i++) { const l = loopOf(curve(P[4 + i])); if (l) bounds.push(id(`FACE_BOUND('',${l},.T.)`)); }
    } else {
      for (let i = 0; i < (P[2] || 0); i++) {
        const b = get(P[3 + i]);
        if (!b || b.type !== 141) continue;
        const Q = b.params, n = Q[3], pieces = [];
        let o = 4;
        for (let k = 0; k < n; k++) { const crv = curve(Q[o]), sense = Q[o + 1], kk = Q[o + 2]; pieces.push(...(sense === 2 ? crv.map((c) => ({ ...c, ctrl: [...c.ctrl].reverse(), w: c.w ? [...c.w].reverse() : null, knots: c.knots.map((x) => -x).reverse(), t0: -c.t1, t1: -c.t0 })).reverse() : crv)); o += 3 + kk; }
        const l = loopOf(pieces);
        if (l) bounds.push(id(`${bounds.length ? 'FACE_BOUND' : 'FACE_OUTER_BOUND'}('',${l},.T.)`));
      }
    }
    if (!bounds.length) { skip(`${e.type} without a boundary`); continue; }
    faces.push(id(`ADVANCED_FACE('',(${bounds.join(',')}),${stepSurf(s)},.T.)`));
  }
  // B-rep solids (186): shells of faces with shared edges and vertices
  const solids = [];
  const vlists = new Map(), elists = new Map();
  const vertexOf = (seq, i) => {
    if (!vlists.has(seq)) { const e = get(seq); const X = xf(e), P = e.params, n = P[0]; vlists.set(seq, Array.from({ length: n }, (_, k) => id(`VERTEX_POINT('',${pt(X.p([P[1 + 3 * k], P[2 + 3 * k], P[3 + 3 * k]]))})`))); }
    return vlists.get(seq)[i - 1];
  };
  const edgeOf = (seq, i) => {
    if (!elists.has(seq)) elists.set(seq, new Map());
    const m = elists.get(seq);
    if (!m.has(i)) {
      const e = get(seq), P = e.params, o = 1 + 5 * (i - 1);
      const pieces = curve(P[o]);
      const c = pieces.length === 1 ? pieces[0] : { ...pieces[0] }; // (a composite edge: its first piece)
      m.set(i, id(`EDGE_CURVE('',${vertexOf(P[o + 1], P[o + 2])},${vertexOf(P[o + 3], P[o + 4])},${stepCurve(c)},.T.)`));
    }
    return m.get(i);
  };
  const shellOf = (seq, closed) => {
    const e = get(seq), P = e.params, n = P[0], fs = [];
    for (let k = 0; k < n; k++) {
      const fe = get(P[1 + 2 * k]), ofl = P[2 + 2 * k];
      if (!fe || fe.type !== 510) continue;
      const F = fe.params, s = surf(F[0]);
      if (!s) continue;
      const nl = F[1], outer = F[2], bounds = [];
      for (let l = 0; l < nl; l++) {
        const le = get(F[3 + l]);
        if (!le || le.type !== 508) continue;
        const L = le.params, ne = L[0], oes = [];
        let o = 1;
        for (let q = 0; q < ne; q++) {
          const typ = L[o], edge = L[o + 1], ndx = L[o + 2], of = L[o + 3], kk = L[o + 4];
          if (typ === 0) oes.push(id(`ORIENTED_EDGE('',*,*,${edgeOf(edge, ndx)},${of ? '.T.' : '.F.'})`));
          o += 5 + 2 * kk;
        }
        if (oes.length) bounds.push(id(`${l === 0 && outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${id(`EDGE_LOOP('',(${oes.join(',')}))`)},.T.)`));
      }
      if (bounds.length) fs.push(id(`ADVANCED_FACE('',(${bounds.join(',')}),${stepSurf(s)},${ofl === 0 ? '.F.' : '.T.'})`));
    }
    return fs.length ? id(`${closed ? 'CLOSED_SHELL' : 'OPEN_SHELL'}('',(${fs.join(',')}))`) : null;
  };
  for (const e of de.values()) {
    if (e.type !== 186) continue;
    const sh = shellOf(e.params[0], true);
    if (sh) solids.push(id(`MANIFOLD_SOLID_BREP('',${sh})`));
  }

  // ------------------------------------------------------------------ the STEP file
  const items = [...solids];
  if (faces.length) items.push(id(`SHELL_BASED_SURFACE_MODEL('',(${id(`OPEN_SHELL('',(${faces.join(',')}))`)}))`));
  const c1 = id(`APPLICATION_CONTEXT('automotive design')`);
  id(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${c1})`);
  const pc = id(`PRODUCT_CONTEXT('',${c1},'mechanical')`);
  const prod = id(`PRODUCT('IGES','IGES','',(${pc}))`);
  const pdf = id(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
  const pdc = id(`PRODUCT_DEFINITION_CONTEXT('part definition',${c1},'design')`);
  const pd = id(`PRODUCT_DEFINITION('design','',${pdf},${pdc})`);
  const pds = id(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  const lu = id(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const au = id(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const su = id(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = id(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),${lu},'distance_accuracy_value','confusion accuracy')`);
  const gctx = id(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${lu},${au},${su}))REPRESENTATION_CONTEXT('',''))`);
  const origin = ax2([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const kind = solids.length && !faces.length ? 'ADVANCED_BREP_SHAPE_REPRESENTATION' : faces.length && !solids.length ? 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION' : 'SHAPE_REPRESENTATION';
  const rep = id(`${kind}('',(${[origin, ...items].join(',')}),${gctx})`);
  id(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
  const step = ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('IGES translated by RazorCAD'),'2;1');", `FILE_NAME('iges.stp','${new Date().toISOString().slice(0, 19)}',(''),(''),'RazorCAD','RazorCAD','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;', ...ents.map((s, i) => `#${i + 1}=${s};`), 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
  return { step, faces: faces.length, solids: solids.length, skipped };
}
