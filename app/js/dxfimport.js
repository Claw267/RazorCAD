// DXF import into a sketch: lines, circles, arcs, polylines (with bulges; old-style R12 ones too), ellipses
// (and their arcs), splines (through their fit points, else their control points) and points, in the DXF's
// units converted to millimetres. Blocks (INSERT) are expanded with their position, scale and rotation.
import * as S from './sketchmodel.js';

const UNITS = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 14: 100, 0: 1 };

// The DXF as { units (mm per drawing unit), ents: [{ type, codes: [[code, value]…] }], blocks: Map }.
export function parseDXF(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].replace(/\s+$/, '')]);
  let units = 1, section = null, block = null;
  const ents = [], blocks = new Map();
  let cur = null;
  const flush = () => { if (cur) (block ? block.ents : ents).push(cur); cur = null; };
  for (let k = 0; k < pairs.length; k++) {
    const [c, v] = pairs[k];
    if (c === 0) {
      flush();
      if (v === 'SECTION') { section = pairs[k + 1]?.[0] === 2 ? pairs[k + 1][1] : null; continue; }
      if (v === 'ENDSEC') { section = null; continue; }
      if (section === 'BLOCKS' && v === 'BLOCK') { block = { name: '', base: [0, 0], ents: [] }; cur = { type: '__BLOCK', codes: [] }; continue; }
      if (section === 'BLOCKS' && v === 'ENDBLK') { if (block) blocks.set(block.name, block); block = null; continue; }
      if (section === 'ENTITIES' || (section === 'BLOCKS' && block)) cur = { type: v, codes: [] };
      continue;
    }
    if (section === 'HEADER' && c === 9 && v === '$INSUNITS') { const u = pairs[k + 1]; if (u && u[0] === 70) units = UNITS[parseInt(u[1], 10)] ?? 1; }
    if (cur) {
      if (cur.type === '__BLOCK') {
        if (c === 2) block.name = v;
        if (c === 10) block.base[0] = +v;
        if (c === 20) block.base[1] = +v;
        continue;
      }
      cur.codes.push([c, v]);
    }
  }
  flush();
  for (const b of blocks.values()) b.ents = joinPolylines(b.ents);
  return { units, ents: joinPolylines(ents.filter((e) => e.type !== '__BLOCK')), blocks };
}
// An old-style (R12) POLYLINE is followed by its VERTEX entities up to a SEQEND: gathered into the POLYLINE
// (verts: [{ x, y, bulge }]), as an LWPOLYLINE holds them.
function joinPolylines(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.type !== 'POLYLINE') { if (e.type !== 'VERTEX' && e.type !== 'SEQEND') out.push(e); continue; }
    const verts = [];
    for (i++; i < list.length && list[i].type === 'VERTEX'; i++) {
      const C = list[i].codes, one = (c) => +(C.find((q) => q[0] === c)?.[1] ?? 0);
      // (spline frame points and the like, flag 16 / 32 / 64 / 128 without plain vertices: left out)
      if (one(70) & 16) continue;
      verts.push({ x: one(10), y: one(20), bulge: one(42) });
    }
    if (i < list.length && list[i].type !== 'SEQEND') i--; // (a file with no SEQEND: the next entity is not part of it)
    out.push({ ...e, verts });
  }
  return out;
}

// Shapes in DXF coordinates: { line: [a, b] } | { arc: { c, r, a0, a1 } (degrees, counter-clockwise) } |
// { circle: { c, r } } | { ellipse: { c, major, ratio, t0, t1 } } | { spline: { pts, closed } } | { point } |
// { text: { p, h, s, rot } } (TEXT and MTEXT; a sketch leaves them out)
export function dxfShapes(dxf) {
  const out = [];
  const one = (codes, c) => { const x = codes.find((q) => q[0] === c); return x ? +x[1] : 0; };
  const all = (codes, c) => codes.filter((q) => q[0] === c).map((q) => +q[1]);
  const add = (e, M, depth) => {
    const C = e.codes;
    const P = (x, y) => M([x, y]);
    switch (e.type) {
      case 'LINE': out.push({ line: [P(one(C, 10), one(C, 20)), P(one(C, 11), one(C, 21))] }); break;
      case 'CIRCLE': out.push({ circle: { c: P(one(C, 10), one(C, 20)), r: one(C, 40) * M.k } }); break;
      case 'ARC': out.push({ arc: { c: P(one(C, 10), one(C, 20)), r: one(C, 40) * M.k, a0: one(C, 50) + M.rot, a1: one(C, 51) + M.rot } }); break;
      case 'POINT': out.push({ point: P(one(C, 10), one(C, 20)) }); break;
      case 'TEXT':
      case 'MTEXT': {
        // (MTEXT: its text in pieces, formatting codes taken out; \P a new line, kept as a space)
        const raw = C.filter((q) => q[0] === 3 || q[0] === 1).map((q) => q[1]).join('');
        const s = e.type === 'MTEXT' ? raw.replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/[{}]/g, '').replace(/\\~/g, ' ') : raw;
        if (s.trim()) out.push({ text: { p: P(one(C, 10), one(C, 20)), h: (one(C, 40) || 2.5) * M.k, s: s.trim(), rot: one(C, 50) + M.rot } });
        break;
      }
      case 'ELLIPSE': {
        const c = P(one(C, 10), one(C, 20)), m = M.dir([one(C, 11), one(C, 21)]);
        out.push({ ellipse: { c, major: m, ratio: one(C, 40), t0: C.some((q) => q[0] === 41) ? one(C, 41) : 0, t1: C.some((q) => q[0] === 42) ? one(C, 42) : 2 * Math.PI } });
        break;
      }
      case 'POLYLINE': {
        // (2D polylines only: a polyface or polygon mesh is 3D)
        if (one(C, 70) & (16 | 64) || !e.verts?.length) break;
        poly(e.verts.map((v) => P(v.x, v.y)), e.verts.map((v) => v.bulge), (one(C, 70) & 1) === 1);
        break;
      }
      case 'LWPOLYLINE': {
        const xs = all(C, 10), ys = all(C, 20), closed = (one(C, 70) & 1) === 1;
        // bulges belong to the vertex before them
        const bul = new Array(xs.length).fill(0);
        let vi = -1;
        for (const [c, v] of C) { if (c === 10) vi++; else if (c === 42 && vi >= 0) bul[vi] = +v; }
        poly(xs.map((x, i) => P(x, ys[i])), bul, closed);
        break;
      }
      case 'SPLINE': {
        const fx = all(C, 11), fy = all(C, 21), cx = all(C, 10), cy = all(C, 20);
        const closed = (one(C, 70) & 1) === 1;
        const pts = fx.length >= 2 ? fx.map((x, i) => P(x, fy[i])) : cx.map((x, i) => P(x, cy[i]));
        if (pts.length >= 2) out.push({ spline: { pts, closed } });
        break;
      }
      case 'INSERT': {
        const b = dxf.blocks.get(C.find((q) => q[0] === 2)?.[1]);
        if (!b || depth > 6) break;
        const ip = [one(C, 10), one(C, 20)], sx = C.some((q) => q[0] === 41) ? one(C, 41) : 1, sy = C.some((q) => q[0] === 42) ? one(C, 42) : 1, rot = one(C, 50);
        const r = (rot * Math.PI) / 180, co = Math.cos(r), si = Math.sin(r);
        const inner = (q) => { const x = (q[0] - b.base[0]) * sx, y = (q[1] - b.base[1]) * sy; return M([ip[0] + x * co - y * si, ip[1] + x * si + y * co]); };
        inner.k = M.k * Math.abs(sx); inner.rot = M.rot + rot;
        inner.dir = (d) => M.dir([d[0] * sx * co - d[1] * sy * si, d[0] * sx * si + d[1] * sy * co]);
        for (const be of b.ents) add(be, inner, depth + 1);
        break;
      }
      default: break;
    }
  };
  // a polyline with bulges: straight runs and arcs
  const poly = (pts, bul, closed) => {
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n], bg = bul[i] || 0;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-12) continue;
      if (Math.abs(bg) < 1e-9) { out.push({ line: [a, b] }); continue; }
      const th = 4 * Math.atan(bg), chord = Math.hypot(b[0] - a[0], b[1] - a[1]), r = chord / (2 * Math.sin(Math.abs(th) / 2));
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, d = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
      const ux = (b[0] - a[0]) / chord, uy = (b[1] - a[1]) / chord;
      // the centre: left of the chord for a counter-clockwise bulge of less than half a turn
      const sgn = (bg > 0 ? 1 : -1) * (Math.abs(th) < Math.PI ? 1 : -1);
      const c = [mx - uy * d * sgn, my + ux * d * sgn];
      const ang = (q) => (Math.atan2(q[1] - c[1], q[0] - c[0]) * 180) / Math.PI;
      out.push(bg > 0 ? { arc: { c, r, a0: ang(a), a1: ang(b) } } : { arc: { c, r, a0: ang(b), a1: ang(a) } });
    }
  };
  const M = (q) => [q[0] * dxf.units, q[1] * dxf.units];
  M.k = dxf.units; M.rot = 0; M.dir = (d) => [d[0] * dxf.units, d[1] * dxf.units];
  for (const e of dxf.ents) add(e, M, 0);
  return out;
}

// Put DXF shapes into sketch sk (scaled by k, moved by (dx, dy)); points closer than tol are joined.
// Returns { curves, skipped }.
export function addShapes(sk, shapes, { k = 1, dx = 0, dy = 0, tol = 1e-6 } = {}) {
  const map = new Map();
  const T = (q) => [q[0] * k + dx, q[1] * k + dy];
  const pt = (q0, keep = false) => {
    const q = T(q0), key = `${Math.round(q[0] / tol)},${Math.round(q[1] / tol)}`;
    let id = map.get(key);
    if (!id) { id = S.addPoint(sk, q[0], q[1]); map.set(key, id); }
    if (keep) S.getPoint(sk, id).keep = true;
    return id;
  };
  const out = [];
  let skipped = 0;
  for (const s of shapes) {
    try {
      if (s.line) { const a = pt(s.line[0]), b = pt(s.line[1]); if (a !== b) out.push(S.addLine(sk, a, b)); }
      else if (s.circle) { if (s.circle.r > 0) out.push(S.addCircle(sk, pt(s.circle.c), s.circle.r * k)); }
      else if (s.arc) {
        const { c, r, a0, a1 } = s.arc, R0 = (a0 * Math.PI) / 180, R1 = (a1 * Math.PI) / 180;
        const p1 = pt([c[0] + r * Math.cos(R0), c[1] + r * Math.sin(R0)]), p2 = pt([c[0] + r * Math.cos(R1), c[1] + r * Math.sin(R1)]);
        if (p1 === p2) out.push(S.addCircle(sk, pt(c), r * k)); else out.push(S.addArc(sk, pt(c), p1, p2));
      } else if (s.ellipse) {
        const { c, major, ratio, t0, t1 } = s.ellipse, ra = Math.hypot(major[0], major[1]);
        const id = S.addEllipse(sk, pt(c), pt([c[0] + major[0], c[1] + major[1]]), ra * ratio * k);
        let span = t1 - t0;
        while (span <= 0) span += 2 * Math.PI;
        if (span < 2 * Math.PI - 1e-6) {
          const u = [major[0] / ra, major[1] / ra], v = [-u[1], u[0]], rb = ra * ratio;
          const at = (t) => [c[0] + ra * Math.cos(t) * u[0] + rb * Math.sin(t) * v[0], c[1] + ra * Math.cos(t) * u[1] + rb * Math.sin(t) * v[1]];
          Object.assign(S.getCurve(sk, id), { type: 'earc', p1: pt(at(t0)), p2: pt(at(t1)) });
        }
        out.push(id);
      } else if (s.spline) {
        const ids = s.spline.pts.map((q) => pt(q)).filter((id, i, a) => !i || id !== a[i - 1]);
        if (s.spline.closed && ids.length > 2 && ids[0] === ids[ids.length - 1]) ids.pop();
        if (ids.length >= 2) out.push(S.addSpline(sk, ids, s.spline.closed && ids.length >= 3));
      } else if (s.point) pt(s.point, true);
    } catch { skipped++; }
  }
  return { curves: out, skipped };
}
