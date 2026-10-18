// Assemblies: parts placed together and held by mates. An assembly opens in a tab of its own (like a drawing,
// through the same tab plumbing) but uses the 3D view: each part's mesh is drawn where each of its components
// sits (asmview.js).
//
// Assembly file (.rasm):
//   { kind: 'assembly', version, name, nextId,
//     parts:      [{ id, name, path, doc }]                       the parts used (a copy, refreshed from their file / tab)
//     components: [{ id, part, name, config, pos: [x, y, z], rot: [qx, qy, qz, qw], fixed, hidden, suppressed }]
//                 (config: which configuration of the part it uses; null = Default)
//     configs:    [{ id, name, comps: { compId: { config, hidden, suppressed } }, mates: { mateId: { suppressed, value } } }]
//     activeConfig                                                 the assembly configuration shown (null = Default)
//     mates:      [{ id, name, type, a: ref, b: ref, value, align, side, suppressed }] }
//   ref: { comp, kind: 'plane' | 'axis' | 'point', p, n | d, r, face | edge (local index), what }  — in the part's
//        own coordinates, so it moves with the component.
// Mates: Coincident, Concentric, Parallel, Perpendicular, Distance, Angle, Tangent, Lock. They are solved by Gauss-
// Newton steps of least change on the free components' positions and rotations (6 unknowns each).

import * as THREE from 'three';
import { icon } from './icons.js';
import { platform } from './platform.js';
import { materialById, DEFAULT_BODY_COLOR, docJSON, stripThumbnail, fileStem, isDefaultName } from './model.js';
import { gauss } from './sketch3dmodel.js';
import { fmt } from './expr.js';
import { ExplodeTool, explodeOffsets, drawExplodeLines, animateExplode } from './explode.js';
import { hashText, packResult, unpackResult } from './modelcache.js';
import { AssemblyView } from './asmview.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = (tag, attrs = {}, html = '') => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  if (html) e.innerHTML = html;
  return e;
};
const sameFile = (a, b) => !!a && !!b && String(a).replace(/\//g, '\\').toLowerCase() === String(b).replace(/\//g, '\\').toLowerCase();
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

export const ASM_EXT = '.rasm';
export const isAssembly = (doc) => doc?.kind === 'assembly';
export function newAssembly(name = 'Assembly1') {
  return { kind: 'assembly', version: 1, name, nextId: 1, parts: [], components: [], mates: [] };
}

export const MATE_TYPES = {
  coincident: { label: 'Coincident', icon: 'mateCoincident' },
  concentric: { label: 'Concentric', icon: 'mateConcentric' },
  parallel: { label: 'Parallel', icon: 'mateParallel' },
  perpendicular: { label: 'Perpendicular', icon: 'matePerpendicular' },
  tangent: { label: 'Tangent', icon: 'mateTangent' },
  distance: { label: 'Distance', icon: 'mateDistance', value: 'mm' },
  angle: { label: 'Angle', icon: 'mateAngle', value: '°' },
  lock: { label: 'Lock', icon: 'mateLock' },
};

// ------------------------------------------------------------------ vectors
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// A part's mesh for the model cache: the edge points in one Float32Array (the vertices' precision). As JSON
// numbers they would be most of the file, and slow to read back.
function packMesh(m) {
  let n = 0;
  for (const e of m.edges) n += e.pts.length;
  const edgePts = new Float32Array(n), edgeOff = new Uint32Array(m.edges.length + 1);
  let o = 0;
  m.edges.forEach((e, i) => { edgeOff[i] = o; edgePts.set(e.pts, o); o += e.pts.length; });
  edgeOff[m.edges.length] = o;
  return { ...m, edges: m.edges.map(({ pts, ...e }) => e), edgePts, edgeOff };
}
function unpackMesh(m) {
  const { edgePts, edgeOff, ...out } = m;
  out.edges = m.edges.map((e, i) => ({ ...e, pts: Array.from(edgePts.subarray(edgeOff[i], edgeOff[i + 1])) }));
  return out;
}
const MESH_CACHE = 'assembly part mesh 1\n'; // (changes when packMesh does)

// a pose: { p: [x, y, z], q: THREE.Quaternion }
const poseOf = (c) => ({ p: c.pos.slice(), q: new THREE.Quaternion(...c.rot) });
const applyQ = (q, v) => new THREE.Vector3(...v).applyQuaternion(q).toArray();
const toWorld = (pose, p) => add(applyQ(pose.q, p), pose.p);
const dirWorld = (pose, d) => applyQ(pose.q, d);
// a small rotation (rotation vector w) applied before q
const turned = (q, w) => { const a = len(w); if (a < 1e-15) return q.clone(); return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...mul(w, 1 / a)), a).multiply(q); };

// The equations of one mate: functions of world geometry A, B (refs placed by the trial poses).
function mateEquations(m, A, B) {
  const t = m.type, ka = m.a.kind, kb = m.b.kind, s = m.align || -1, side = m.side || 1, v = Number(m.value) || 0;
  const eqs = [];
  const vec3 = (f) => { for (const k of [0, 1, 2]) eqs.push(() => f()[k]); };
  const swap = (x, y) => [x, y];
  const pair = (k1, k2) => (ka === k1 && kb === k2 ? swap(A, B) : ka === k2 && kb === k1 ? swap(B, A) : null);
  const g = (o) => o;
  if (t === 'lock') {
    // the two components keep the turn and place they have relative to each other now (stored in m.rel)
    return eqs; // handled by solveAssembly (needs the poses)
  }
  if (t === 'coincident' || t === 'concentric') {
    let q;
    if ((q = pair('plane', 'plane'))) { const [a, b] = q; vec3(() => sub(a().n, mul(b().n, s))); eqs.push(() => dot(a().n, sub(b().p, a().p))); }
    else if ((q = pair('plane', 'point'))) { const [a, b] = q; eqs.push(() => dot(a().n, sub(b().p, a().p))); }
    else if ((q = pair('plane', 'axis'))) { const [a, b] = q; eqs.push(() => dot(a().n, b().d)); eqs.push(() => dot(a().n, sub(b().p, a().p))); }
    else if ((q = pair('axis', 'axis'))) { const [a, b] = q; vec3(() => cross(a().d, b().d)); vec3(() => cross(sub(b().p, a().p), a().d)); }
    else if ((q = pair('axis', 'point'))) { const [a, b] = q; vec3(() => cross(sub(b().p, a().p), a().d)); }
    else if ((q = pair('point', 'point'))) { const [a, b] = q; vec3(() => sub(a().p, b().p)); }
    return eqs;
  }
  if (t === 'parallel') {
    let q;
    if ((q = pair('plane', 'plane'))) { const [a, b] = q; vec3(() => sub(a().n, mul(b().n, s))); }
    else if ((q = pair('axis', 'axis'))) { const [a, b] = q; vec3(() => cross(a().d, b().d)); }
    else if ((q = pair('plane', 'axis'))) { const [a, b] = q; eqs.push(() => dot(a().n, b().d)); }
    return eqs;
  }
  if (t === 'perpendicular') {
    let q;
    if ((q = pair('plane', 'plane'))) { const [a, b] = q; eqs.push(() => dot(a().n, b().n)); }
    else if ((q = pair('axis', 'axis'))) { const [a, b] = q; eqs.push(() => dot(a().d, b().d)); }
    else if ((q = pair('plane', 'axis'))) { const [a, b] = q; vec3(() => cross(a().n, b().d)); }
    return eqs;
  }
  if (t === 'distance') {
    let q;
    if ((q = pair('plane', 'plane'))) { const [a, b] = q; vec3(() => sub(a().n, mul(b().n, s))); eqs.push(() => dot(a().n, sub(b().p, a().p)) - side * v); }
    else if ((q = pair('plane', 'point'))) { const [a, b] = q; eqs.push(() => dot(a().n, sub(b().p, a().p)) - side * v); }
    else if ((q = pair('point', 'point'))) { const [a, b] = q; eqs.push(() => len(sub(a().p, b().p)) - v); }
    else if ((q = pair('axis', 'axis'))) { const [a, b] = q; vec3(() => cross(a().d, b().d)); eqs.push(() => len(cross(sub(b().p, a().p), unit(a().d))) - v); }
    else if ((q = pair('axis', 'point'))) { const [a, b] = q; eqs.push(() => len(cross(sub(b().p, a().p), unit(a().d))) - v); }
    else if ((q = pair('plane', 'axis'))) { const [a, b] = q; eqs.push(() => dot(a().n, b().d)); eqs.push(() => dot(a().n, sub(b().p, a().p)) - side * v); }
    return eqs;
  }
  if (t === 'angle') {
    const th = (v * Math.PI) / 180;
    const dir = (o) => (o.kind === 'plane' ? o.n : o.d);
    eqs.push(() => { const x = dir(A()), y = dir(B()); return Math.atan2(len(cross(x, y)), dot(x, y)) - th; });
    void ka; void kb;
    return eqs;
  }
  if (t === 'tangent') {
    let q;
    if ((q = pair('plane', 'axis'))) { const [a, b] = q; eqs.push(() => dot(a().n, b().d)); eqs.push(() => dot(a().n, sub(b().p, a().p)) - side * (b().r || 0)); }
    else if ((q = pair('axis', 'axis'))) { const [a, b] = q; vec3(() => cross(a().d, b().d)); eqs.push(() => len(cross(sub(b().p, a().p), unit(a().d))) - ((a().r || 0) + side * (b().r || 0))); }
    else if ((q = pair('plane', 'point'))) { const [a, b] = q; eqs.push(() => dot(a().n, sub(b().p, a().p)) - side * (b().r || 0)); }
    return eqs;
  }
  void g;
  return eqs;
}

// the mate types that make sense for two refs (the first the usual choice)
export function mateChoices(A, B) {
  if (!A || !B) return [];
  const k = [A.kind, B.kind].sort().join(',');
  const cyl = (o) => o.kind === 'axis' && o.r > 0;
  switch (k) {
    case 'plane,plane': return ['coincident', 'parallel', 'perpendicular', 'distance', 'angle', 'lock'];
    case 'axis,axis': return [cyl(A) && cyl(B) && !A.circle && !B.circle ? 'concentric' : 'concentric', 'coincident', 'parallel', 'perpendicular', 'distance', 'angle', ...(cyl(A) && cyl(B) ? ['tangent'] : []), 'lock'];
    case 'axis,plane': return [...((A.kind === 'axis' ? cyl(A) : cyl(B)) ? ['tangent'] : []), 'coincident', 'parallel', 'perpendicular', 'distance', 'angle', 'lock'];
    case 'axis,point': return ['coincident', 'distance', 'lock'];
    case 'plane,point': return ['coincident', 'distance', ...((A.kind === 'point' ? A.r : B.r) ? ['tangent'] : []), 'lock'];
    case 'point,point': return ['coincident', 'distance', 'lock'];
    default: return ['lock'];
  }
}

// Solve the mates: components not fixed (and not pinned) move as little as they must. Returns { ok, residual }.
export function solveAssembly(doc, { pinned = new Set(), only = null } = {}) {
  const comps = doc.components, byId = new Map(comps.map((c) => [c.id, c]));
  const mates = (only || doc.mates).filter((m) => !m.suppressed && byId.has(m.a?.comp) && byId.has(m.b?.comp));
  const free = comps.filter((c) => !c.fixed && !pinned.has(c.id) && mates.some((m) => m.a.comp === c.id || m.b.comp === c.id));
  const col = new Map(free.map((c, i) => [c.id, 6 * i]));
  const N = 6 * free.length;
  if (!mates.length) return { ok: true, residual: 0, dofs: new Map() };
  const base = new Map(comps.map((c) => [c.id, poseOf(c)]));
  let X = new Float64Array(N);
  const poseAt = (id, Xv) => {
    const b = base.get(id), i = col.get(id);
    if (i === undefined) return b;
    return { p: [b.p[0] + Xv[i], b.p[1] + Xv[i + 1], b.p[2] + Xv[i + 2]], q: turned(b.q, [Xv[i + 3], Xv[i + 4], Xv[i + 5]]) };
  };
  // the equations, each a function of X
  let cur = X;
  const world = (ref) => () => {
    const ps = poseAt(ref.comp, cur);
    const o = { kind: ref.kind, p: toWorld(ps, ref.p), r: ref.r };
    if (ref.n) o.n = dirWorld(ps, ref.n);
    if (ref.d) o.d = dirWorld(ps, ref.d);
    return o;
  };
  const eqs = [];
  for (const m of mates) {
    if (m.type === 'lock' && m.rel) {
      // B's pose seen from A stays as it was when locked
      const lockEq = (k) => () => {
        const pa = poseAt(m.a.comp, cur), pb = poseAt(m.b.comp, cur);
        const inv = pa.q.clone().invert();
        const relP = applyQ(inv, sub(pb.p, pa.p)), relQ = inv.clone().multiply(pb.q);
        const dq = new THREE.Quaternion(...m.rel.q).invert().multiply(relQ);
        const w = [dq.x, dq.y, dq.z].map((x) => x * 2 * Math.sign(dq.w || 1));
        return k < 3 ? relP[k] - m.rel.p[k] : w[k - 3];
      };
      for (let k = 0; k < 6; k++) eqs.push(lockEq(k));
      continue;
    }
    for (const f of mateEquations(m, world(m.a), world(m.b))) eqs.push(f);
  }
  const M = eqs.length;
  const F = new Float64Array(M);
  const evalF = (Xv) => { cur = Xv; let s = 0; for (let k = 0; k < M; k++) { const v = eqs[k](); F[k] = Number.isFinite(v) ? v : 1e6; s += F[k] * F[k]; } return Math.sqrt(s); };
  const scale = Math.max(1, ...comps.flatMap((c) => c.pos.map(Math.abs)));
  let res = evalF(X), J = null;
  // (nothing free to move: the mates are met as things stand, or not)
  if (!N) return { ok: res < 1e-6 * scale, residual: res, dofs: new Map() };
  const jac = () => {
    const rows = Array.from({ length: M }, () => new Float64Array(N));
    const F0 = Float64Array.from(F);
    for (let j = 0; j < N; j++) {
      const h = j % 6 < 3 ? 1e-6 * scale : 1e-7;
      const Xp = Float64Array.from(X); Xp[j] += h;
      evalF(Xp);
      for (let k = 0; k < M; k++) rows[k][j] = (F[k] - F0[k]) / h;
    }
    evalF(X);
    return rows;
  };
  for (let it = 0; it < 80 && res > 1e-9 * scale; it++) {
    J = jac();
    const A = Array.from({ length: M }, () => new Float64Array(M));
    for (let a = 0; a < M; a++) for (let b = a; b < M; b++) { let s = 0; const ra = J[a], rb = J[b]; for (let j = 0; j < N; j++) s += ra[j] * rb[j]; A[a][b] = A[b][a] = s; }
    for (let a = 0; a < M; a++) A[a][a] += 1e-12 + 1e-9 * A[a][a];
    const y = gauss(A, Array.from(F));
    if (!y) break;
    const step = new Float64Array(N);
    for (let a = 0; a < M; a++) for (let j = 0; j < N; j++) step[j] -= J[a][j] * y[a];
    let t = 1, next = res, Xn = X;
    for (let tries = 0; tries < 10; tries++) {
      Xn = X.map((x, j) => x + t * step[j]);
      next = evalF(Xn);
      if (next < res) break;
      t /= 2;
    }
    if (!(next < res)) { evalF(X); break; }
    X = Xn;
    res = next;
    // (bake the step into the base poses: small rotations stay small)
    for (const c of free) { const ps = poseAt(c.id, X); base.set(c.id, ps); }
    X = new Float64Array(N);
    res = evalF(X);
  }
  const ok = res < 1e-6 * scale;
  if (ok) for (const c of free) { const ps = base.get(c.id); c.pos = ps.p.map(r6); c.rot = [ps.q.x, ps.q.y, ps.q.z, ps.q.w].map((x) => Math.round(x * 1e9) / 1e9); }
  // degrees of freedom left: per free component 6 less the rank of its columns (others held)
  const dofs = new Map();
  if (ok) {
    const Jn = jac();
    const rank = (cols) => {
      const rows = Jn.map((r) => cols.map((j) => r[j]));
      let rk = 0; const used = new Array(rows.length).fill(false);
      for (let c = 0; c < cols.length; c++) {
        let best = -1, bv = 1e-7;
        for (let r = 0; r < rows.length; r++) if (!used[r] && Math.abs(rows[r][c]) > bv) { bv = Math.abs(rows[r][c]); best = r; }
        if (best < 0) continue;
        used[best] = true; rk++;
        for (let r = 0; r < rows.length; r++) { if (used[r] || !rows[r][c]) continue; const k = rows[r][c] / rows[best][c]; for (let j = c; j < cols.length; j++) rows[r][j] -= k * rows[best][j]; }
      }
      return rk;
    };
    for (const c of free) { const i = col.get(c.id); dofs.set(c.id, 6 - rank([0, 1, 2, 3, 4, 5].map((k) => i + k))); }
  }
  return { ok, residual: res, dofs };
}

// ------------------------------------------------------------------ the editor
export class AssemblyEditor {
  constructor(app, doc, filePath = null) {
    this.app = app;
    this.doc = doc;
    doc.parts ||= []; doc.components ||= []; doc.mates ||= []; doc.nextId ||= 1; doc.configs ||= [];
    this.filePath = filePath;
    this.dirty = false;
    this.tabIcon = 'assembly';
    this.kindLabel = 'Assembly';
    this.parts = new Map();      // part id → { key, mesh, color, box, error }
    this.live = new Map();       // part id → the open part tab it came from
    this.sel = null;             // { kind: 'comp' | 'mate', id }
    this.pm = null;              // the open Mate Property panel
    this.undoStack = [];
    this.redoStack = [];
    this.dofs = new Map();
    this.cmTab = 'assembly';
    doc.explodes ||= [];
    this.explodeTool = null;
  }

  // ---------------------------------------------------------------- exploded views (the display moves only)
  offsets() {
    if (this.explodeTool?.ex) return this.explodeTool.offsets();
    const ex = this.doc.exploded && this.doc.explodes.find((x) => x.id === this.doc.exploded);
    return ex ? explodeOffsets(ex, null, this._explodeT ?? 1) : new Map();
  }
  // (the explode tool's host)
  items() { return this.doc.components.filter((c) => !this.eff(c).suppressed).map((c) => ({ id: c.id, name: c.name })); }
  itemAt(e) { return this.compAt(e)?.comp.id || null; }
  itemCenter(id) { const c = this.comp(id); return c ? this.compCenter(c) : [0, 0, 0]; }
  itemSize(id) { const c = this.comp(id), b = c && this.geo(c)?.box; return b ? Math.max(...b.max.map((x, i) => x - b.min[i])) * 1.2 : 50; }
  faceNormalAt(e) { const ch = this.compAt(e); const fi = ch && this.display.faceInfo(ch.bi, ch.hit.face); return fi?.planar ? fi.normal.toArray() : null; }
  redisplay() { this.updateGeometry(); }
  commit(msg) { this.change(msg); }
  pmRoot() { return $('#pm'); }
  onToolClosed() { this.explodeTool = null; this.renderAll(); }
  startExplode(id = null) {
    if (this.doc.components.length < 2) { this.app.toast('Insert at least two components first'); return; }
    if (this.pm) this.cancelMate(true);
    this.begin();
    this.doc.exploded = null; this._explodeT = 1;
    this.explodeTool = new ExplodeTool(this);
    this.explodeTool.open(id);
    this.renderCommandManager();
  }
  setExploded(id, animate = false) {
    const was = this.doc.exploded;
    if (!animate) { this.doc.exploded = id || null; this._explodeT = 1; this.dirty = true; this.updateGeometry(); this.renderAll(); return; }
    const target = id || was;
    if (!target) return;
    this.doc.exploded = target;
    animateExplode((t) => { this._explodeT = t; this.buildMesh(); }, id ? 0 : 1, id ? 1 : 0, () => { this._explodeT = 1; this.doc.exploded = id || null; this.dirty = true; this.buildMesh(); this.renderAll(); });
  }
  collapseExplode() { if (this.doc.exploded) { this.doc.exploded = null; this.updateGeometry(); this.renderAll(); this.app.status('Collapsed to edit (the exploded view is kept).'); } }
  deleteExplode(id) { this.begin(); this.doc.explodes = this.doc.explodes.filter((x) => x.id !== id); if (this.doc.exploded === id) this.doc.exploded = null; this.change(); }
  get name() { return this.filePath ? fileStem(this.filePath) : this.doc.name; }
  get vp() { return this.app.viewport; }
  uid(prefix) { return prefix + this.doc.nextId++; }
  comp(id) { return this.doc.components.find((c) => c.id === id) || null; }

  // ---------------------------------------------------------------- configurations
  // the assembly configuration shown, and what it sets for a component / mate
  cfg() { return this.doc.activeConfig ? this.doc.configs.find((c) => c.id === this.doc.activeConfig) || null : null; }
  eff(c) {
    const o = this.cfg()?.comps?.[c.id] || {};
    return { config: 'config' in o ? o.config : (c.config ?? null), hidden: 'hidden' in o ? o.hidden : !!c.hidden, suppressed: 'suppressed' in o ? o.suppressed : !!c.suppressed };
  }
  effMate(m) { const o = this.cfg()?.mates?.[m.id]; return o ? { ...m, ...o } : m; }
  // a component / mate setting: in the configuration shown, else on the component itself
  setComp(c, key, val) {
    const cf = this.cfg();
    if (cf) { cf.comps ||= {}; (cf.comps[c.id] ||= {})[key] = val; } else c[key] = val;
  }
  setMate(m, key, val) {
    const cf = this.cfg();
    if (cf) { cf.mates ||= {}; (cf.mates[m.id] ||= {})[key] = val; } else m[key] = val;
  }
  // the assembly as the configuration shows it (suppressed components and their mates left out)
  view() {
    const comps = this.doc.components.filter((c) => !this.eff(c).suppressed), on = new Set(comps.map((c) => c.id));
    return { components: comps, mates: this.doc.mates.map((m) => this.effMate(m)).filter((m) => on.has(m.a.comp) && on.has(m.b.comp)) };
  }
  // a part's configurations: [[id | null, name]…]
  partConfigs(p) { return [[null, 'Default'], ...((p?.doc?.configs) || []).map((c) => [c.id, c.name])]; }
  configName(p, id) { return id ? (p?.doc?.configs || []).find((c) => c.id === id)?.name || '?' : 'Default'; }
  // the built geometry of a component (its part in its configuration)
  geoKey(partId, cfgId) { return partId + '|' + (cfgId || ''); }
  geo(c) { return this.parts.get(this.geoKey(c.part, this.eff(c).config)) || null; }

  setActiveConfig(id) {
    if (this.pm) this.cancelMate(true);
    this.doc.activeConfig = id || null;
    this.dirty = true;
    this.loadParts().then(() => { this.solve(); this.updateGeometry(); this.renderAll(); this.app.ui.renderConfigs?.(); });
    this.app.status(`Configuration: ${this.cfg()?.name || 'Default'}`);
  }
  addConfig(copyOf = null) {
    const base = copyOf ? this.doc.configs.find((c) => c.id === copyOf) : this.cfg();
    let k = 1;
    while (this.doc.configs.some((c) => c.id === 'acfg' + k)) k++;
    let n = this.doc.configs.length + 1, name = copyOf && base ? `Copy of ${base.name}` : 'Config' + n;
    while (this.doc.configs.some((c) => c.name === name)) name = copyOf && base ? `Copy of ${base.name} (${++n})` : 'Config' + ++n;
    this.begin();
    this.doc.configs.push({ id: 'acfg' + k, name, comps: JSON.parse(JSON.stringify(base?.comps || {})), mates: JSON.parse(JSON.stringify(base?.mates || {})) });
    this._before && this.undoStack.push(this._before); this._before = null;
    this.setActiveConfig('acfg' + k);
  }
  deleteConfig(id) {
    this.begin();
    this.doc.configs = this.doc.configs.filter((c) => c.id !== id);
    if (this.doc.activeConfig === id) this.doc.activeConfig = null;
    this.change();
    this.setActiveConfig(this.doc.activeConfig);
  }
  configSummary(cf) {
    if (!cf) return 'the assembly as built';
    const out = [];
    for (const [id, o] of Object.entries(cf.comps || {})) {
      const c = this.comp(id);
      if (!c) continue;
      if ('config' in o && o.config !== (c.config ?? null)) out.push(`${c.name}: ${this.configName(this.part(c.part), o.config)}`);
      if (o.suppressed && !c.suppressed) out.push(`${c.name} suppressed`);
      if ('suppressed' in o && !o.suppressed && c.suppressed) out.push(`${c.name} unsuppressed`);
      if (o.hidden && !c.hidden) out.push(`${c.name} hidden`);
    }
    for (const [id, o] of Object.entries(cf.mates || {})) {
      const m = this.doc.mates.find((x) => x.id === id);
      if (!m) continue;
      if ('value' in o && o.value !== m.value) out.push(`${m.name} = ${fmt(Number(o.value))}${MATE_TYPES[m.type].value === '°' ? '°' : ' mm'}`);
      if (o.suppressed && !m.suppressed) out.push(`${m.name} suppressed`);
    }
    return out.join('; ') || 'same as Default';
  }
  // the Configurations tab (drawn by the app's left panel)
  renderConfigs(root) {
    if (!root) return;
    const ui = this.app.ui;
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'cfg-head' }, `${icon('configs')}<span><b>${esc(this.doc.name)}</b> Configuration(s)</span>`));
    const bar = el('div', { class: 'cfg-bar' });
    const addB = el('button', { class: 'pm-btn', title: 'A new configuration, starting as the one shown' }, '+ Add Configuration');
    addB.onclick = () => this.addConfig();
    bar.appendChild(addB);
    root.appendChild(bar);
    const active = this.doc.activeConfig || null;
    const item = (cf) => {
      const id = cf?.id || null, on = id === active;
      const n = el('div', { class: 'tn cfg-item' + (on ? ' cfg-active' : '') + (this._cfgSel === (id || '__default') ? ' selected' : ''), title: `${cf ? cf.name : 'Default'}: ${this.configSummary(cf)}\nDouble-click to show it` });
      n.innerHTML = `<span class="tw"></span><span class="ti">${icon(on ? 'ok' : 'configs')}</span><span class="tl">${esc(cf ? cf.name : 'Default')}</span><span class="tsub">${esc(this.configSummary(cf))}</span>`;
      n.onclick = () => { this._cfgSel = id || '__default'; this.renderConfigs(root); };
      n.ondblclick = () => this.setActiveConfig(id);
      n.oncontextmenu = (e) => {
        e.preventDefault();
        const items = [{ label: 'Show Configuration', icon: 'show', action: () => this.setActiveConfig(id), disabled: on }];
        if (cf) items.push(
          { label: 'Rename', icon: 'rename', action: () => ui.promptText('Rename Configuration', 'configs', 'Name', cf.name).then((v) => { if (v?.trim()) { this.begin(); cf.name = v.trim(); this.change(); ui.renderConfigs(); } }) },
          { label: 'Copy Configuration', icon: 'configs', action: () => this.addConfig(cf.id) },
          'sep',
          { label: 'Delete', icon: 'trash', action: () => this.deleteConfig(cf.id) },
        );
        else items.push({ label: 'Add Configuration', icon: 'configs', action: () => this.addConfig() });
        ui.showContext(e.clientX, e.clientY, items);
      };
      root.appendChild(n);
    };
    item(null);
    for (const cf of this.doc.configs) item(cf);
    root.appendChild(el('div', { class: 'pm-hint', style: 'padding:8px 12px' }, 'Double-click a configuration to show it. While one is shown, these change it only: a component\'s part configuration, Hide / Show, Suppress, and a mate\'s Suppress or value (Edit Mate).'));
  }
  part(id) { return this.doc.parts.find((p) => p.id === id) || null; }
  isActive() { return this.app.drawing === this; }

  // ---------------------------------------------------------------- tab life
  attach() {
    const a = this.app, vp = this.vp;
    $('#drawing').hidden = true;
    $('#viewport').hidden = false;
    $('#status-mode').textContent = 'Editing Assembly';
    // (nothing of the part shown before)
    vp.setPlanes?.([]); vp.setRefGeometry?.([], [], []); vp.setSketches?.([]); vp.setPreview?.(null); vp.setSection?.(null);
    vp.setDimTag?.(null); vp.setMeasure?.(null); vp.setVertexMarkers?.(null); vp.setEdgeHighlights?.(null);
    vp.setBody(null, null);
    // the components are drawn by an AssemblyView (each part once, placed per component)
    this.display = vp.asmView = new AssemblyView(vp);
    a.ui.showLeft('tree');
    // (left-drag moves components; the middle button turns the view, the right one pans)
    vp.setLeftRotate(false);
    this.renderAll();
    // (the mesh is built first: loadParts only asks for it on the next frame)
    this.refreshParts().then(() => this.loadParts()).then(() => { if (!this._fitted && this.isActive()) { this._fitted = true; if (this._geoFrame) this.flushGeometry(); vp.zoomToFit(); } });
    this.updateGeometry();
  }
  detach() {
    this.pm = null;
    this.vp.setLeftRotate(true);
    this.vp.setFaceSet?.([]);
    this.vp.clearFaceHighlights();
    this.vp.setVertexMarkers?.(null);
    this.vp.setEdgeHighlights?.(null);
    if (this._geoFrame) { cancelAnimationFrame(this._geoFrame.raf); clearTimeout(this._geoFrame.tm); this._geoFrame = null; }
    this._exLines = drawExplodeLines(this.vp, this._exLines, []);
    if (this.display) { this.display.dispose(); if (this.vp.asmView === this.display) this.vp.asmView = null; this.display = null; }
    $('#status-mode').textContent = 'Editing Part';
  }
  render() { this.updateGeometry(); } // (asked by the drawing pane's resize observer: nothing of its own to draw)
  renderAll() {
    if (!this.isActive()) return;
    this.renderTree();
    this.renderPM();
    this.renderCommandManager();
    this.app.updateTitle();
  }

  // ---------------------------------------------------------------- undo / changes
  // (a part copy goes in by reference: it can hold megabytes of imported geometry, and copies are replaced, never changed)
  snapshot() { return JSON.stringify({ components: this.doc.components, mates: this.doc.mates, parts: this.doc.parts.map((p) => ({ ...p, doc: this.docRef(p.doc) })), name: this.doc.name, nextId: this.doc.nextId, configs: this.doc.configs, activeConfig: this.doc.activeConfig || null, explodes: this.doc.explodes, exploded: this.doc.exploded || null }); }
  docRef(doc) {
    this._docKeys ||= new WeakMap(); this._docs ||= new Map();
    let k = this._docKeys.get(doc);
    if (!k) { k = 'doc' + (this._docs.size + 1); this._docKeys.set(doc, k); this._docs.set(k, doc); }
    return k;
  }
  begin() { this._before = this.snapshot(); }
  change(msg = null) {
    if (this._before && this._before !== this.snapshot()) { this.undoStack.push(this._before); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }
    this._before = null;
    this.dirty = true;
    this.updateGeometry();
    this.renderAll();
    if (msg) this.app.status(msg);
  }
  restore(json) {
    const s = JSON.parse(json);
    s.parts = s.parts.map((p) => ({ ...p, doc: this._docs.get(p.doc) }));
    Object.assign(this.doc, s); this.dirty = true; this.loadParts(); this.updateGeometry(); this.renderAll(); }
  undo() { const s = this.undoStack.pop(); if (!s) return; this.redoStack.push(this.snapshot()); this.restore(s); }
  redo() { const s = this.redoStack.pop(); if (!s) return; this.undoStack.push(this.snapshot()); this.restore(s); }

  // ---------------------------------------------------------------- parts and their geometry
  // bring the part copies up to date from the open part tabs, else from their files
  async refreshParts() {
    let changed = false;
    for (const p of this.doc.parts) {
      let doc = null;
      const tab = this.live.get(p.id) || this.app.tabs.find((t) => t.kind !== 'drawing' && t.doc && p.path && sameFile(t.filePath, p.path));
      if (tab && this.app.tabs.includes(tab)) doc = this.app.tabs.indexOf(tab) === this.app.tabIndex ? this.app.doc : tab.doc;
      else if (p.path && platform.desktop) { try { const text = await platform.readText(p.path); if (text) doc = stripThumbnail(JSON.parse(text)); } catch { /* keep the copy */ } }
      if (doc && JSON.stringify(doc) !== JSON.stringify(p.doc)) { p.doc = JSON.parse(JSON.stringify(doc)); p.name = (p.path && isDefaultName(doc.name) ? fileStem(p.path) : doc.name) || p.name; changed = true; }
    }
    if (changed) { this.dirty = true; this.app.updateTitle(); }
    return changed;
  }

  // each part's mesh, in each configuration the components use (again only when it changed). A mesh built
  // before comes from the model cache on disk (modelcache.js, keyed by a hash of the part as built), all of
  // them at once; the kernel builds the others one by one, and they are stored for next time.
  async loadParts() {
    let any = false;
    const want = new Map();
    for (const c of this.doc.components) { const e = this.eff(c); if (!e.suppressed) want.set(this.geoKey(c.part, e.config), [c.part, e.config]); }
    const jobs = [];
    for (const [gk, [pid, cfgId]] of want) {
      const p = this.part(pid);
      if (!p) continue;
      // (the same part copy as last time: built already, without writing out and hashing it again)
      if (this.parts.get(gk)?.from === p.doc) continue;
      const doc = { ...p.doc, activeConfig: cfgId && (p.doc.configs || []).some((x) => x.id === cfgId) ? cfgId : null };
      const json = JSON.stringify(doc), key = json.length + ':' + hash(json);
      if (this.parts.get(gk)?.key === key) { this.parts.get(gk).from = p.doc; continue; }
      jobs.push({ gk, p, cfgId, json, key });
    }
    // (p.color: the colour a STEP assembly gave the part, until it has a material)
    const done = (j, mesh, error = null) => {
      this.parts.set(j.gk, error ? { key: j.key, from: j.p.doc, mesh: null, error } : { key: j.key, from: j.p.doc, mesh, color: materialById(j.p.doc.material)?.color ?? j.p.color ?? DEFAULT_BODY_COLOR, box: mesh ? meshBox(mesh) : null });
      any = true;
    };
    if (jobs.length && platform.desktop) {
      this.app.status(`Reading ${jobs.length === 1 ? jobs[0].p.name : `${jobs.length} parts`}…`);
      await Promise.all(jobs.map(async (j) => {
        try {
          j.cacheKey = await hashText(MESH_CACHE + j.json);
          const b64 = j.cacheKey && await platform.readModelCache(j.cacheKey);
          const r = b64 ? await unpackResult(b64) : null;
          if (r?.body?.vertices && r.body.edgePts) { done(j, unpackMesh(r.body)); j.cached = true; }
        } catch { /* build it */ }
      }));
      // (what was stored shows at once, while the kernel builds the rest)
      if (any && jobs.some((j) => !j.cached)) { this.resyncRefs(); this.solve(); this.updateGeometry(); this.renderAll(); }
    }
    for (const j of jobs) {
      if (j.cached) continue;
      this.app.status(`Building ${j.p.name}${j.cfgId ? ` (${this.configName(j.p, j.cfgId)})` : ''}…`);
      try {
        const r = await this.app.kernel.request('partMesh', { doc: j.json });
        const mesh = r.body && r.body.vertices ? r.body : null;
        done(j, mesh);
        // stored for next time, unless it had errors (its rebuild may come out differently)
        if (mesh && !r.errors && j.cacheKey) packResult({ body: packMesh(mesh) }).then((b64) => platform.writeModelCache(j.cacheKey, b64)).catch(() => {});
      } catch (err) {
        done(j, null, err.message);
        this.app.toast(`${j.p.name} could not be built: ${err.message}`, true);
      }
    }
    this.app.hideProgress?.(); // (the part builds report progress like a rebuild)
    // mates on faces / edges follow the part (the same face or edge, by its number) in the configuration used
    this.resyncRefs();
    if (any) { this.solve(); this.updateGeometry(); this.renderAll(); this.app.status('Ready'); }
  }

  resyncRefs() {
    for (const m of this.doc.mates) for (const r of [m.a, m.b]) {
      const c = this.comp(r.comp), mesh = c && this.geo(c)?.mesh;
      if (!mesh) continue;
      const fresh = r.face !== undefined ? refOfFace(mesh, r.face) : r.edge !== undefined ? refOfEdge(mesh, r.edge, r.endAt) : null;
      if (fresh && fresh.kind === r.kind) Object.assign(r, { p: fresh.p, n: fresh.n, d: fresh.d, r: fresh.r });
    }
  }

  // ---------------------------------------------------------------- the view: each part drawn at its components
  updateGeometry() {
    if (!this.isActive()) return;
    if (this._geoFrame) return;
    // (next frame; a timer too, as frames pause while the window is in the background)
    const run = () => this.flushGeometry();
    this._geoFrame = { raf: requestAnimationFrame(run), tm: setTimeout(run, 40) };
  }
  flushGeometry() {
    if (!this._geoFrame) return;
    cancelAnimationFrame(this._geoFrame.raf); clearTimeout(this._geoFrame.tm); this._geoFrame = null;
    this.buildMesh();
  }
  // (a component's placement, with its exploded-view offset, as a matrix: all a move changes on the graphics card)
  buildMesh() {
    if (!this.isActive() || !this.display) return;
    const offs = this.offsets();
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    this.display.update(this.doc.components.map((c) => {
      const e = this.eff(c), g = this.geo(c);
      if (e.suppressed || !g?.mesh) return null;
      const o = offs.get(c.id);
      p.set(...(o ? c.pos.map((x, k) => x + o[k]) : c.pos));
      return { mesh: g.mesh, color: g.color ?? DEFAULT_BODY_COLOR, hidden: !!e.hidden, matrix: new THREE.Matrix4().compose(p, q.set(...c.rot).normalize(), one) };
    }));
    this._exLines = drawExplodeLines(this.vp, this._exLines, this.showLines === false ? [] : [...offs].filter(([id, o]) => Math.hypot(...o) > 1e-9 && this.comp(id)).map(([id, o]) => { const a = this.compCenter(this.comp(id)); return [a, a.map((x, k) => x + o[k])]; }));
    this.highlight();
  }

  // ---------------------------------------------------------------- picking
  // the component under the mouse: { comp, hit: { point, face (the part's face number) }, bi (its index) }
  compAt(e) {
    const hit = this.display?.pick(e);
    if (!hit || hit.face < 0) return null;
    const c = this.doc.components[hit.comp];
    return c ? { comp: c, hit, bi: hit.comp } : null;
  }
  // a face, edge or vertex under the mouse, as a mate reference (in the part's coordinates)
  entityAt(e) {
    const view = this.display;
    if (!view) return null;
    const inv = (c) => { const ps = poseOf(c); const qi = ps.q.clone().invert(); return (w) => applyQ(qi, sub(w, ps.p)); };
    const vx = view.pickVertex(e, 7);
    const vc = vx && this.doc.components[vx.comp];
    if (vc) return { comp: vc.id, kind: 'point', p: inv(vc)(vx.point.toArray()).map(r6), what: 'Vertex', world: vx.point.toArray() };
    const ed = view.pickEdge(e, 5);
    if (ed) {
      const c = this.doc.components[ed.comp], m = c && this.geo(c)?.mesh;
      if (m) { const r = refOfEdge(m, ed.edge); if (r) return { comp: c.id, ...r, edge: ed.edge, gi: `${ed.comp}:e${ed.edge}` }; }
    }
    const ch = this.compAt(e);
    if (!ch) return null;
    const m = this.geo(ch.comp)?.mesh;
    const r = m && refOfFace(m, ch.hit.face);
    if (!r) { this.app.toast('That face is not flat, cylindrical, conical or spherical: pick another face, an edge or a vertex'); return null; }
    return { comp: ch.comp.id, ...r, face: ch.hit.face, gi: `${ch.bi}:f${ch.hit.face}` };
  }
  refLabel(r) { const c = this.comp(r.comp); return `${r.what} of ${c?.name || '?'}`; }
  // a ref placed by its component's pose now
  worldRef(r) {
    const c = this.comp(r.comp);
    if (!c) return null;
    const ps = poseOf(c);
    return { kind: r.kind, p: toWorld(ps, r.p), n: r.n && dirWorld(ps, r.n), d: r.d && dirWorld(ps, r.d), r: r.r };
  }

  // ---------------------------------------------------------------- solving
  solve(opts) {
    const r = solveAssembly(this.view(), opts);
    this.solveOk = r.ok;
    if (r.ok) this.dofs = r.dofs || new Map();
    return r;
  }

  // ---------------------------------------------------------------- viewport input (routed here by the app)
  vpEvent(kind, e) {
    const t = this.explodeTool;
    if (t) {
      if (kind === 'down') return t.down(e);
      if (kind === 'move') return t.move(e);
      if (kind === 'up') return t.up(e);
      if (kind === 'click') return t.click(e);
      if (kind === 'hover') { const ch = this.compAt(e); this.hoverComp = ch?.comp.id || null; this.highlight(); return; }
      return;
    }
    if (kind === 'down') return this.onDown(e);
    if (kind === 'move') return this.onMove(e);
    if (kind === 'up') return this.onUp(e);
    if (kind === 'click') return this.onClick(e);
    if (kind === 'hover') return this.onHover(e);
    if (kind === 'context') return this.onContext(e);
    if (kind === 'leave') { this.hoverRef = null; this.hoverComp = null; this.highlight(); }
    if (kind === 'dbl') return this.onDouble(e);
  }
  onDown(e) {
    if (e.button !== 0 || this.pm) return;
    const ch = this.compAt(e);
    if (!ch) return;
    if (this.doc.exploded) { this.collapseExplode(); return; }
    if (ch.comp.fixed) { this.dragNote = `${ch.comp.name} is fixed (right-click ▸ Float to move it).`; return; }
    const dir = new THREE.Vector3();
    this.vp.camera.getWorldDirection(dir);
    const ps = poseOf(ch.comp);
    const center = this.compCenter(ch.comp);
    this.drag = { comp: ch.comp, from: ch.hit.point.toArray(), n: dir, pose: ps, center, x: e.clientX, y: e.clientY, rotate: e.altKey, moved: false, before: this.snapshot() };
  }
  onMove(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    d.moved = true;
    const c = d.comp;
    if (d.rotate || e.altKey) {
      // turn it about its centre: across the screen about the view's up, up and down about its right
      const cam = this.vp.camera, up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion), right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const qd = new THREE.Quaternion().setFromAxisAngle(up, (e.clientX - d.x) * 0.01).multiply(new THREE.Quaternion().setFromAxisAngle(right, (e.clientY - d.y) * 0.01));
      const q = qd.clone().multiply(d.pose.q);
      const p = add(applyQ(qd, sub(d.pose.p, d.center)), d.center);
      c.pos = p; c.rot = [q.x, q.y, q.z, q.w];
    } else {
      const to = this.vp.rayPlane(e, { n: d.n, o: new THREE.Vector3(...d.from) }).toArray();
      c.pos = add(d.pose.p, sub(to, d.from));
      c.rot = [d.pose.q.x, d.pose.q.y, d.pose.q.z, d.pose.q.w];
    }
    // the mates: first with it held where the mouse put it, else it slides along what they allow
    const keep = JSON.stringify(this.doc.components);
    let r = this.solve({ pinned: new Set([c.id]) });
    if (!r.ok) {
      const back = JSON.parse(keep);
      r = this.solve();
      if (!r.ok) Object.assign(this.doc.components, back.map((x, i) => Object.assign(this.doc.components[i], x)));
    }
    this.updateGeometry();
  }
  onUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) { if (this.dragNote) { this.app.status(this.dragNote); this.dragNote = null; } return; }
    if (d.moved) { this._before = d.before; this.change(`${d.comp.name} moved.`); }
  }
  onClick(e) {
    if (this.pm) {
      const r = this.entityAt(e);
      if (!r) return;
      this.pmPick(r);
      return;
    }
    const ch = this.compAt(e);
    this.select(ch ? { kind: 'comp', id: ch.comp.id } : null);
  }
  onDouble(e) { const ch = this.compAt(e); if (ch) this.openPart(ch.comp.id); }
  onHover(e) {
    if (this.drag) return;
    if (this.pm) { this.hoverRef = this.entityAt(e); this.hoverComp = null; }
    else { const ch = this.compAt(e); this.hoverComp = ch?.comp.id || null; this.hoverRef = null; }
    this.highlight();
  }
  onContext(e) {
    const ch = this.compAt(e);
    if (ch) { this.select({ kind: 'comp', id: ch.comp.id }); this.app.ui.showContext(e.clientX, e.clientY, this.compMenu(ch.comp)); return; }
    this.app.ui.showContext(e.clientX, e.clientY, [
      { label: 'Insert Components…', icon: 'insertComponent', action: () => this.insertComponents() },
      { label: 'Mate', icon: 'mate', action: () => this.startMate() },
      'sep',
      { label: 'Zoom to Fit', icon: 'zoomfit', action: () => this.vp.zoomToFit() },
    ]);
  }

  compCenter(c) {
    const box = this.geo(c)?.box;
    const mid = box ? box.min.map((x, i) => (x + box.max[i]) / 2) : [0, 0, 0];
    return toWorld(poseOf(c), mid);
  }

  select(s) {
    this.sel = s;
    this.highlight();
    this.renderTree();
    this.renderPM();
    this.renderCommandManager();
    if (s?.kind === 'comp') { const c = this.comp(s.id); this.app.status(`${c.name} selected — drag it to move it (Alt+drag turns it), right-click for more.`); }
  }

  // ---------------------------------------------------------------- highlights
  highlight() {
    const vp = this.vp, view = this.display;
    if (!this.isActive() || !view) return;
    const bi = (id) => this.doc.components.findIndex((c) => c.id === id);
    const sel = this.sel?.kind === 'comp' ? bi(this.sel.id) : -1;
    const hov = this.hoverComp && this.hoverComp !== this.sel?.id ? bi(this.hoverComp) : -1;
    // the faces / edges / vertices of the mate being made (or of the selected mate)
    const refs = this.pm ? this.pm.picks : this.sel?.kind === 'mate' ? (([m]) => (m ? [m.a, m.b] : []))(this.doc.mates.filter((m) => m.id === this.sel.id)) : [];
    const faceInfos = [], edgesSel = [], pts = [];
    for (const r of [...refs, ...(this.hoverRef ? [this.hoverRef] : [])]) {
      const ci = bi(r.comp);
      if (ci < 0) continue;
      if (r.face !== undefined) { const fi = view.faceInfo(ci, r.face); if (fi) faceInfos.push(fi); }
      else if (r.edge !== undefined) edgesSel.push([ci, r.edge]);
      else pts.push(toWorld(poseOf(this.comp(r.comp)), r.p));
    }
    vp.setFaceSet?.(faceInfos, 'pm');
    view.setHighlights({ selected: sel, hover: hov >= 0 && !refs.length ? hov : -1, edges: edgesSel });
    vp.setVertexMarkers?.(pts.length ? { selected: pts } : null);
  }

  // ---------------------------------------------------------------- components
  async insertComponents() {
    const a = this.app;
    const parts = a.tabs.map((t, i) => ({ t, i })).filter(({ t }) => t.kind !== 'drawing' && (t.doc || false));
    const body = el('div');
    body.appendChild(el('p', {}, 'Insert a part as a component. It is placed beside what is there; then drag it or add mates.'));
    const list = el('div', { class: 'pm-list' });
    let chosen = null;
    const pick = (li, val) => { list.querySelectorAll('.li').forEach((x) => x.classList.remove('active')); li.classList.add('active'); chosen = val; };
    for (const { t, i } of parts) {
      const doc = i === a.tabIndex ? a.doc : t.doc;
      if (!doc?.features?.length) continue;
      const li = el('div', { class: 'li' }, `${icon('part')}<span>${esc(doc.name)}</span><span class="pm-hint" style="margin-left:auto">${t.filePath ? 'open' : 'open, not saved'}</span>`);
      li.onclick = () => pick(li, { doc, path: i === a.tabIndex ? a.filePath : t.filePath, tab: t });
      li.ondblclick = () => { pick(li, { doc, path: i === a.tabIndex ? a.filePath : t.filePath, tab: t }); dlg.close(); go(); };
      list.appendChild(li);
    }
    for (const p of this.doc.parts) {
      const li = el('div', { class: 'li' }, `${icon('component')}<span>${esc(p.name)}</span><span class="pm-hint" style="margin-left:auto">in this assembly</span>`);
      li.onclick = () => pick(li, { existing: p.id });
      li.ondblclick = () => { pick(li, { existing: p.id }); dlg.close(); go(); };
      list.appendChild(li);
    }
    if (!list.children.length) list.appendChild(el('div', { class: 'pm-hint', style: 'padding:6px' }, 'No parts open — browse for a part file.'));
    body.appendChild(list);
    // the configuration of the part to use (when it has some)
    const cfgRow = el('div', { class: 'asm-cfgrow', style: 'margin-top:8px;display:none' }, '<label class="pm-label">Configuration</label>');
    const cfgSel = el('select');
    cfgRow.appendChild(cfgSel);
    body.appendChild(cfgRow);
    const showCfgs = () => {
      const doc = chosen?.existing ? this.part(chosen.existing)?.doc : chosen?.doc;
      const list2 = [[null, 'Default'], ...((doc?.configs) || []).map((c) => [c.id, c.name])];
      cfgSel.innerHTML = '';
      for (const [id, name] of list2) { const o = el('option', { value: id || '' }, esc(name)); if ((doc?.activeConfig || null) === id) o.selected = true; cfgSel.appendChild(o); }
      cfgRow.style.display = list2.length > 1 ? '' : 'none';
    };
    list.addEventListener('click', () => setTimeout(showCfgs, 0));
    const go = async () => {
      if (!chosen) return;
      const cfg = cfgRow.style.display === 'none' ? undefined : cfgSel.value || null;
      if (chosen.existing) return this.addComponent(chosen.existing, cfg);
      const pid = this.addPart(chosen.doc, chosen.path, chosen.tab);
      await this.addComponent(pid, cfg);
    };
    const browse = async () => {
      const f = await platform.openText();
      if (!f?.content) return;
      try {
        const doc = JSON.parse(f.content);
        if (!Array.isArray(doc.features)) throw new Error('Not a RazorCAD part file');
        const pid = this.addPart(doc, f.path || null, null);
        const cfgs = doc.configs || [];
        let cfg;
        if (cfgs.length) {
          // (which configuration of it)
          const pick = await a.ui.choose('Part Configuration', 'configs', `<p><b>${esc(doc.name)}</b> has configurations: which one should the component use?</p>`, [[ '', 'Default', !doc.activeConfig ], ...cfgs.map((c) => [c.id, c.name, doc.activeConfig === c.id])]);
          if (pick === null) return;
          cfg = pick || null;
        }
        await this.addComponent(pid, cfg);
      } catch (err) { a.toast('Could not insert it: ' + err.message, true); }
    };
    const dlg = a.ui.modal('Insert Components', 'insertComponent', body, [
      { label: 'Browse for a Part File…', action: () => { browse(); } },
      { label: 'Insert', primary: true, action: () => { go(); } },
      { label: 'Cancel' },
    ]);
  }

  // the part (reused when it is in the assembly already)
  addPart(doc, path, tab) {
    let p = (path && this.doc.parts.find((x) => sameFile(x.path, path))) || (tab && [...this.live].find(([, t]) => t === tab) && this.doc.parts.find((x) => this.live.get(x.id) === tab));
    if (!p) {
      p = { id: this.uid('pt'), name: (path && isDefaultName(doc.name) ? fileStem(path) : doc.name) || 'Part', path: path || null, doc: stripThumbnail(JSON.parse(JSON.stringify(doc))) };
      this.doc.parts.push(p);
    } else p.doc = stripThumbnail(JSON.parse(JSON.stringify(doc)));
    if (tab) this.live.set(p.id, tab);
    return p.id;
  }

  async addComponent(partId, config = undefined) {
    const p = this.part(partId);
    if (!p) return;
    this.begin();
    const n = this.doc.components.filter((c) => c.part === partId).length + 1;
    const first = !this.doc.components.length;
    // (the part's configuration chosen, else the one it was saved showing)
    const cfgId = config !== undefined ? config : (p.doc.activeConfig ?? null);
    const c = { id: this.uid('c'), part: partId, name: `${p.name}<${n}>`, config: cfgId, pos: [0, 0, 0], rot: [0, 0, 0, 1], fixed: first, hidden: false };
    this.doc.components.push(c);
    await this.loadParts();
    // beside what is there already (to the right, a little apart)
    if (!first) {
      const box = this.geo(c)?.box, all = this.worldBox(c.id);
      if (box && all) c.pos = [all.max[0] - box.min[0] + 0.15 * Math.max(1, all.max[0] - all.min[0]), all.min[1] - box.min[1], (all.min[2] + all.max[2]) / 2 - (box.min[2] + box.max[2]) / 2].map(r6);
    }
    this.sel = { kind: 'comp', id: c.id };
    this.change(first ? `${c.name} inserted and fixed at the origin (the first component). Insert more, then mate them.` : `${c.name} inserted. Drag it into place or add mates.`);
    if (first) { this.buildMesh(); this.vp.zoomToFit(); }
  }

  // the box round every component (but one) as placed
  worldBox(except = null) {
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const c of this.doc.components) {
      if (c.id === except || this.eff(c).suppressed) continue;
      const box = this.geo(c)?.box;
      if (!box) continue;
      const ps = poseOf(c);
      for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
        const w = toWorld(ps, [x, y, z]);
        min = min.map((m, i) => Math.min(m, w[i])); max = max.map((m, i) => Math.max(m, w[i]));
      }
    }
    return Number.isFinite(min[0]) ? { min, max } : null;
  }

  setFixed(id, on) {
    const c = this.comp(id);
    if (!c) return;
    this.begin();
    c.fixed = on;
    this.solve();
    this.change(`${c.name} ${on ? 'fixed where it is' : 'floating: it moves within its mates'}.`);
  }
  setHidden(id, on) { const c = this.comp(id); if (!c) return; this.begin(); this.setComp(c, 'hidden', on); this.change(); }
  setSuppressed(id, on) {
    const c = this.comp(id);
    if (!c) return;
    this.begin();
    this.setComp(c, 'suppressed', on);
    this.solve();
    this.change(`${c.name} ${on ? 'suppressed (left out, with its mates)' : 'unsuppressed'}${this.cfg() ? ` in ${this.cfg().name}` : ''}.`);
    if (!on) this.loadParts();
  }
  async setCompConfig(id, cfgId) {
    const c = this.comp(id);
    if (!c) return;
    this.begin();
    this.setComp(c, 'config', cfgId || null);
    this.change();
    await this.loadParts();
    this.solve();
    this.updateGeometry();
    this.renderAll();
    this.app.status(`${c.name} uses ${this.configName(this.part(c.part), cfgId)}${this.cfg() ? ` in ${this.cfg().name}` : ''}.`);
  }
  deleteComponent(id) {
    const c = this.comp(id);
    if (!c) return;
    this.begin();
    this.doc.components = this.doc.components.filter((x) => x.id !== id);
    this.doc.mates = this.doc.mates.filter((m) => m.a.comp !== id && m.b.comp !== id);
    // a part no component uses any more goes from the assembly
    this.doc.parts = this.doc.parts.filter((p) => this.doc.components.some((x) => x.part === p.id));
    if (this.sel?.id === id) this.sel = null;
    this.change(`${c.name} deleted (with its mates).`);
  }
  renameComponent(id) {
    const c = this.comp(id);
    if (!c) return;
    this.app.ui.promptText('Rename Component', 'rename', 'Name', c.name).then((v) => { if (v && v.trim()) { this.begin(); c.name = v.trim(); this.change(); } });
  }
  async openPart(id) {
    const c = this.comp(id), p = c && this.part(c.part), a = this.app;
    if (!p) return;
    const tab = this.live.get(p.id) || a.tabs.find((t) => t.kind !== 'drawing' && p.path && sameFile(t.filePath, p.path));
    if (tab && a.tabs.includes(tab)) return a.activateTab(a.tabs.indexOf(tab));
    if (p.path && platform.desktop) { try { const f = await platform.openPath(p.path); if (f) return a.openFromFile(f); } catch { /* use the copy */ } }
    await a.openFromFile({ name: p.name + '.rcad', content: JSON.stringify(p.doc), path: null });
    this.live.set(p.id, a.tabs[a.tabIndex]);
  }
  compMenu(c) {
    return [
      { label: 'Open Part', icon: 'part', action: () => this.openPart(c.id) },
      { label: 'Mate…', icon: 'mate', action: () => this.startMate() },
      'sep',
      c.fixed ? { label: 'Float', icon: 'float', action: () => this.setFixed(c.id, false) } : { label: 'Fix', icon: 'fix', action: () => this.setFixed(c.id, true) },
      this.eff(c).hidden ? { label: 'Show', icon: 'show', action: () => this.setHidden(c.id, false) } : { label: 'Hide', icon: 'hide', action: () => this.setHidden(c.id, true) },
      this.eff(c).suppressed ? { label: 'Unsuppress', icon: 'suppress', action: () => this.setSuppressed(c.id, false) } : { label: 'Suppress', icon: 'suppress', action: () => this.setSuppressed(c.id, true) },
      ...(this.partConfigs(this.part(c.part)).length > 1 ? ['sep', ...this.partConfigs(this.part(c.part)).map(([id, name]) => ({ label: `${(this.eff(c).config || null) === id ? '● ' : '　'}Configuration: ${name}`, icon: '', action: () => this.setCompConfig(c.id, id) }))] : []),
      { label: 'Insert Another Instance', icon: 'insertComponent', action: () => this.addComponent(c.part) },
      'sep',
      { label: 'Rename', icon: 'rename', action: () => this.renameComponent(c.id) },
      { label: 'Delete', icon: 'trash', key: 'Del', action: () => this.deleteComponent(c.id) },
    ];
  }

  // ---------------------------------------------------------------- mates
  startMate(edit = null) {
    if (this.doc.components.length < 2) { this.app.toast('Insert at least two components first'); return; }
    this.collapseExplode();
    this.cancelMate(true);
    this.begin();
    this.pmBefore = JSON.stringify(this.doc.components);
    if (edit) {
      const m = this.doc.mates.find((x) => x.id === edit);
      this.pm = { picks: [m.a, m.b], type: m.type, value: this.effMate(m).value, align: m.align, side: m.side, edit: m.id };
    } else this.pm = { picks: [], type: null, value: null, align: null, side: 1 };
    this.sel = null;
    this.app.status('Mate: click two faces, edges or vertices on different components.');
    this.renderAll();
    this.highlight();
  }
  pmPick(r) {
    const pm = this.pm;
    if (pm.picks.length >= 2) pm.picks = [];
    if (pm.picks.length === 1 && pm.picks[0].comp === r.comp) { this.app.toast('Pick the second entity on another component'); return; }
    pm.picks.push(r);
    if (pm.picks.length === 2) {
      const [A, B] = pm.picks.map((x) => this.worldRef(x));
      const choices = mateChoices(A, B);
      if (!pm.type || !choices.includes(pm.type)) pm.type = choices[0];
      this.setDefaultValue();
      this.previewMate();
    } else this.app.status('Now click the entity on the other component.');
    this.renderPM();
    this.highlight();
  }
  setDefaultValue() {
    const pm = this.pm;
    if (pm.picks.length < 2) return;
    // (from where the components were before this mate was shown)
    const now = JSON.stringify(this.doc.components);
    if (this.pmBefore) Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    const [A, B] = pm.picks.map((x) => this.worldRef(x));
    Object.assign(this.doc.components, JSON.parse(now).map((x, i) => Object.assign(this.doc.components[i], x)));
    // aligned or not: as they face now (the least turning; Flip for the other way)
    const dA = A.n || A.d, dB = B.n || B.d;
    pm.align = dA && dB ? (dot(dA, dB) >= 0 ? 1 : -1) : -1;
    if (pm.type === 'distance') {
      const plane = A.kind === 'plane' ? A : B.kind === 'plane' ? B : null, other = plane === A ? B : A;
      if (plane) { const d = dot(plane.n, sub(other.p, plane.p)); pm.side = d >= 0 ? 1 : -1; pm.value ??= r6(Math.abs(d)); }
      else if (A.kind === 'axis') pm.value ??= r6(len(cross(sub(B.p, A.p), unit(A.d))));
      else if (B.kind === 'axis') pm.value ??= r6(len(cross(sub(A.p, B.p), unit(B.d))));
      else pm.value ??= r6(len(sub(A.p, B.p)));
    }
    if (pm.type === 'angle') { const x = A.n || A.d, y = B.n || B.d; pm.value ??= r6((Math.atan2(len(cross(x, y)), dot(x, y)) * 180) / Math.PI); }
    if (pm.type === 'tangent') {
      const plane = A.kind === 'plane' ? A : B.kind === 'plane' ? B : null, other = plane === A ? B : A;
      if (plane) pm.side = dot(plane.n, sub(other.p, plane.p)) >= 0 ? 1 : -1;
    }
  }
  // the mate as it would be made
  pmMate() {
    const pm = this.pm;
    if (!pm || pm.picks.length < 2 || !pm.type) return null;
    const m = { id: pm.edit || '__new', name: '', type: pm.type, a: pm.picks[0], b: pm.picks[1], align: pm.align, side: pm.side, value: pm.value };
    if (pm.type === 'lock') {
      const ca = this.comp(m.a.comp), cb = this.comp(m.b.comp), pa = poseOf(ca), pb = poseOf(cb), inv = pa.q.clone().invert();
      const relQ = inv.clone().multiply(pb.q);
      m.rel = { p: applyQ(inv, sub(pb.p, pa.p)), q: [relQ.x, relQ.y, relQ.z, relQ.w] };
    }
    return m;
  }
  // show the mate applied (components moved); an error when it can't be
  previewMate() {
    const m = this.pmMate();
    if (!m) return;
    Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    const v = this.view(), others = v.mates.filter((x) => x.id !== m.id);
    const r = solveAssembly(v, { only: [...others, m] });
    this.pm.error = r.ok ? null : 'This mate conflicts with the others (over-defined) or can\'t be reached: try Flip, another type or other entities.';
    if (r.ok) this.dofs = r.dofs || this.dofs;
    else Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    this.updateGeometry();
    this.renderPM();
  }
  okMate() {
    const m = this.pmMate();
    if (!m) { this.cancelMate(); return; }
    if (this.pm.error) { this.app.toast(this.pm.error, true); return; }
    if (this.pm.edit) {
      const old = this.doc.mates.find((x) => x.id === this.pm.edit);
      // (a configuration shown keeps its own value; the rest of the mate is the same in all)
      const cfgVal = this.cfg() && MATE_TYPES[m.type].value && old.type === m.type;
      const { value, ...rest } = m;
      Object.assign(old, { ...rest, id: old.id, name: old.name }, cfgVal ? {} : { value });
      if (cfgVal) this.setMate(old, 'value', value);
    } else {
      const n = this.doc.mates.filter((x) => x.type === m.type).length + 1;
      this.doc.mates.push({ ...m, id: this.uid('m'), name: `${MATE_TYPES[m.type].label}${n}` });
    }
    const editing = !!this.pm.edit;
    this.pm = null;
    this.change(`${MATE_TYPES[m.type].label} mate ${editing ? 'changed' : 'added'}.`);
    if (!editing) this.startMate(); // (ready for the next mate)
  }
  cancelMate(quiet = false) {
    if (!this.pm) return;
    if (this.pmBefore) Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    this.pm = null;
    this.pmBefore = null;
    this._before = null;
    if (!quiet) { this.updateGeometry(); this.renderAll(); this.highlight(); this.app.status('Ready'); }
  }
  deleteMate(id) {
    this.begin();
    this.doc.mates = this.doc.mates.filter((m) => m.id !== id);
    if (this.sel?.id === id) this.sel = null;
    this.solve();
    this.change('Mate deleted.');
  }
  toggleMate(id) { const m = this.doc.mates.find((x) => x.id === id); if (!m) return; this.begin(); this.setMate(m, 'suppressed', !this.effMate(m).suppressed); this.solve(); this.change(); }
  flipMate(id) {
    const m = this.doc.mates.find((x) => x.id === id);
    if (!m) return;
    this.begin();
    if (m.type === 'distance' || m.type === 'tangent') m.side = -(m.side || 1); else m.align = -(m.align || -1);
    if (!this.solve().ok) { this.restore(this._before); this.app.toast('Flipped, the mates can\'t all be met: left as it was', true); return; }
    this.change();
  }

  // ---------------------------------------------------------------- bill of materials
  showBOM() {
    // (one row per part and configuration used; suppressed components left out)
    const rows = [];
    for (const p of this.doc.parts) {
      const by = new Map();
      for (const c of this.doc.components) { const e = this.eff(c); if (c.part !== p.id || e.suppressed) continue; by.set(e.config, (by.get(e.config) || 0) + 1); }
      for (const [cfgId, n] of by) rows.push({ name: p.name + ((p.doc.configs || []).length ? ` (${this.configName(p, cfgId)})` : ''), qty: n, material: materialById(p.doc.material)?.name || '', file: p.path ? String(p.path).split(/[\\/]/).pop() : '(not saved)' });
    }
    const table = `<table class="bom"><tr><th>Item</th><th>Part</th><th>Qty</th><th>Material</th><th>File</th></tr>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.qty}</td><td>${esc(r.material)}</td><td>${esc(r.file)}</td></tr>`).join('')}</table>`;
    const csv = ['Item,Part,Qty,Material,File', ...rows.map((r, i) => [i + 1, r.name, r.qty, r.material, r.file].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','))].join('\r\n');
    this.app.ui.modal('Bill of Materials', 'bom', `${table}<p class="pm-hint">${rows.reduce((t, r) => t + r.qty, 0)} components, ${rows.length} different parts.</p>`, [
      { label: 'Copy as CSV', action: () => { navigator.clipboard?.writeText(csv); this.app.status('Bill of materials copied (CSV).'); return false; } },
      { label: 'Save CSV…', action: () => { platform.saveBinary(`${this.safeName()} BOM.csv`, new TextEncoder().encode(csv), 'csv'); } },
      { label: 'Close', primary: true },
    ]);
  }

  // ---------------------------------------------------------------- file
  safeName() { return (this.doc.name || 'Assembly').replace(/[\\/:*?"<>|]/g, '_'); }
  async save(saveAs = false) {
    if (this.pm) this.cancelMate();
    try {
      let thumb = null;
      try { thumb = this.vp.snapshot(); } catch { /* saved without a preview */ }
      const path = await platform.saveText(`${this.safeName()}${ASM_EXT}`, docJSON(this.doc, thumb, 1), saveAs ? null : this.filePath, this.filePath, 'assembly');
      if (!path) return false;
      if (platform.desktop) this.filePath = path;
      if (platform.desktop && isDefaultName(this.doc.name) && fileStem(path) !== this.doc.name) {
        this.doc.name = fileStem(path);
        await platform.saveText(`${this.safeName()}${ASM_EXT}`, docJSON(this.doc, thumb, 1), path, path, 'assembly');
      }
      this.dirty = false;
      this.app.updateTitle();
      this.app.status('Saved ' + String(path).split(/[\\/]/).pop());
      return true;
    } catch (err) {
      this.app.toast('Save failed: ' + err.message, true);
      return false;
    }
  }

  // ---------------------------------------------------------------- keys
  handleKey(e) {
    if (this.explodeTool && this.explodeTool.key(e)) return true;
    const typing = e.target.closest?.('input, select, textarea');
    if (typing) { if (e.key === 'Enter' && this.pm) { this.okMate(); return true; } return false; }
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (ctrl && k === 'z') { e.preventDefault(); this.undo(); return true; }
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); return true; }
    const views = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom', 7: 'iso' };
    if (ctrl && views[e.key]) { e.preventDefault(); this.vp.setStandardView(views[e.key]); return true; }
    if (ctrl) return false;
    if (e.key.startsWith('Arrow') && this.vp.controls.key(e)) { e.preventDefault(); return true; }
    if (e.key === 'Escape') { if (this.pm) this.cancelMate(); else this.select(null); return true; }
    if (e.key === 'Enter' && this.pm) { this.okMate(); return true; }
    if (e.key === 'Delete') {
      if (this.sel?.kind === 'comp') this.deleteComponent(this.sel.id);
      else if (this.sel?.kind === 'mate') this.deleteMate(this.sel.id);
      return true;
    }
    if (k === 'f') { this.vp.zoomToFit(); return true; }
    if (k === 'm' && !this.pm) { this.startMate(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- UI: ribbon, menus, tree, Property panel
  commandDefs() {
    const selC = this.sel?.kind === 'comp' ? this.comp(this.sel.id) : null;
    return {
      assembly: [
        { icon: 'insertComponent', label: 'Insert Components', action: () => this.insertComponents() },
        { icon: 'mate', label: 'Mate', key: 'M', action: () => this.startMate(), active: !!this.pm },
        'sep',
        { icon: 'fix', label: 'Fix', action: () => selC && this.setFixed(selC.id, true), disabled: !selC || selC.fixed },
        { icon: 'float', label: 'Float', action: () => selC && this.setFixed(selC.id, false), disabled: !selC || !selC.fixed },
        { icon: selC && this.eff(selC).hidden ? 'show' : 'hide', label: selC && this.eff(selC).hidden ? 'Show Component' : 'Hide Component', action: () => selC && this.setHidden(selC.id, !this.eff(selC).hidden), disabled: !selC },
        { icon: 'suppress', label: selC && this.eff(selC).suppressed ? 'Unsuppress' : 'Suppress', action: () => selC && this.setSuppressed(selC.id, !this.eff(selC).suppressed), disabled: !selC },
        { icon: 'part', label: 'Open Part', action: () => selC && this.openPart(selC.id), disabled: !selC },
        'sep',
        { icon: 'explode', label: 'Exploded View', action: () => this.startExplode(), active: !!this.explodeTool },
        { icon: 'explode', label: this.doc.exploded ? 'Collapse' : 'Explode', action: () => (this.doc.exploded ? this.setExploded(null, true) : this.doc.explodes.length && this.setExploded(this.doc.explodes[this.doc.explodes.length - 1].id, true)), disabled: !this.doc.explodes.length },
        'sep',
        { icon: 'bom', label: 'Bill of Materials', action: () => this.showBOM() },
        { icon: 'zoomfit', label: 'Zoom to Fit', key: 'F', action: () => this.vp.zoomToFit() },
      ],
    };
  }
  renderCommandManager() {
    if (!this.isActive()) return;
    const defs = this.commandDefs();
    const btns = $('#cm-buttons');
    btns.innerHTML = '';
    for (const d of defs[this.cmTab]) {
      if (d === 'sep') { btns.appendChild(el('div', { class: 'cm-sep' })); continue; }
      const b = el('button', { class: 'cm-btn' + (d.active ? ' active' : ''), title: d.label + (d.key ? ` (${d.key})` : ''), disabled: d.disabled }, `<span class="cm-ic">${icon(d.icon)}${d.key ? `<span class="cm-key">${esc(d.key)}</span>` : ''}</span><span>${esc(d.label)}</span>`);
      b.addEventListener('click', d.action);
      btns.appendChild(b);
    }
    const tabs = $('#cm-tabs');
    tabs.innerHTML = '';
    const t = el('button', { class: 'active' }, 'Assembly');
    tabs.appendChild(t);
  }
  menuDefs() {
    const a = this.app, selC = this.sel?.kind === 'comp' ? this.comp(this.sel.id) : null;
    return {
      File: [
        { label: 'New Part', icon: 'newdoc', key: 'Ctrl+N', action: () => a.newDocument() },
        { label: 'New Assembly', icon: 'assembly', action: () => a.newAssembly() },
        { label: 'New Drawing', icon: 'drawing', action: () => a.newDrawing() },
        { label: 'Open…', icon: 'open', key: 'Ctrl+O', action: () => a.openFile() },
        { label: 'Recent Files / Start…', icon: 'open', action: () => a.showStart() },
        'sep',
        { label: 'Save', icon: 'save', key: 'Ctrl+S', action: () => a.saveFile() },
        { label: 'Save As…', icon: 'save', key: 'Ctrl+Shift+S', action: () => a.saveFile(true) },
      ],
      Edit: [
        { label: 'Undo', icon: 'undo', key: 'Ctrl+Z', action: () => this.undo(), disabled: !this.undoStack.length },
        { label: 'Redo', icon: 'redo', key: 'Ctrl+Y', action: () => this.redo(), disabled: !this.redoStack.length },
        'sep',
        { label: 'Delete', icon: 'trash', key: 'Del', action: () => (this.sel?.kind === 'comp' ? this.deleteComponent(this.sel.id) : this.sel?.kind === 'mate' ? this.deleteMate(this.sel.id) : null), disabled: !this.sel },
      ],
      View: [
        { label: 'Zoom to Fit', icon: 'zoomfit', key: 'F', action: () => this.vp.zoomToFit() },
        { label: 'Isometric', icon: 'views', key: 'Ctrl+7', action: () => this.vp.setStandardView('iso') },
        { label: 'Front', icon: 'views', key: 'Ctrl+1', action: () => this.vp.setStandardView('front') },
        { label: 'Top', icon: 'views', key: 'Ctrl+5', action: () => this.vp.setStandardView('top') },
      ],
      Insert: [
        { label: 'Components…', icon: 'insertComponent', action: () => this.insertComponents() },
        { label: 'Exploded View…', icon: 'explode', action: () => this.startExplode() },
        { label: 'Mate…', icon: 'mate', key: 'M', action: () => this.startMate() },
      ],
      Tools: [
        { label: 'Bill of Materials…', icon: 'bom', action: () => this.showBOM() },
        ...(selC ? [{ label: `Open ${selC.name}`, icon: 'part', action: () => this.openPart(selC.id) }] : []),
      ],
    };
  }

  renderTree() {
    if (!this.isActive()) return;
    const root = $('#tree');
    root.innerHTML = '';
    const row = ({ ic, label, depth = 0, cls = '', sub = '', title = '', selected = false, onClick, onDbl, menu, vis, twisty = '', onTwisty }) => {
      const n = el('div', { class: 'tn' + (cls ? ' ' + cls : '') + (selected ? ' selected' : ''), title });
      n.style.paddingLeft = 6 + depth * 16 + 'px';
      n.innerHTML = `<span class="tw">${twisty}</span><span class="ti">${icon(ic)}</span><span class="tl">${esc(label)}</span>${sub ? `<span class="tsub">${esc(sub)}</span>` : ''}<span class="tvis"></span>`;
      if (vis) {
        const v = n.querySelector('.tvis');
        v.innerHTML = icon(vis.on ? 'visOn' : 'visOff');
        v.classList.add(vis.on ? 'on' : 'off');
        v.title = vis.on ? 'Shown — click to hide' : 'Hidden — click to show';
        v.onclick = (e) => { e.stopPropagation(); vis.toggle(); };
      }
      if (onTwisty) n.querySelector('.tw').onclick = (e) => { e.stopPropagation(); onTwisty(); };
      if (onClick) n.onclick = onClick;
      if (onDbl) n.ondblclick = onDbl;
      n.oncontextmenu = (e) => { e.preventDefault(); onClick?.(); if (menu) this.app.ui.showContext(e.clientX, e.clientY, menu()); };
      root.appendChild(n);
      return n;
    };
    const free = [...this.dofs.values()].reduce((t, x) => t + x, 0);
    row({ ic: 'assembly', label: this.doc.name + (this.cfg() ? ` (${this.cfg().name})` : ''), cls: 'tree-part', title: free ? `${free} degree${free === 1 ? '' : 's'} of freedom left among the floating components` : 'Fully placed',
      sub: !this.solveOk && this.doc.mates.length ? 'mates conflict' : '',
      onDbl: () => this.app.ui.promptText('Rename Assembly', 'rename', 'Name', this.doc.name).then((v) => { if (v?.trim()) { this.begin(); this.doc.name = v.trim(); this.change(); } }) });
    for (const c of this.doc.components) {
      const e = this.eff(c), p = this.part(c.part);
      const dof = this.dofs.get(c.id) || 0, mated = this.view().mates.some((m) => !m.suppressed && (m.a.comp === c.id || m.b.comp === c.id));
      const prefix = e.suppressed ? '' : c.fixed ? '(f) ' : dof > 0 || !mated ? '(-) ' : '';
      row({
        ic: 'component', label: prefix + c.name, depth: 1, cls: (e.hidden ? 'hidden-item' : '') + (e.suppressed ? ' suppressed' : ''),
        sub: this.partConfigs(p).length > 1 ? `(${this.configName(p, e.config)})` : '',
        title: c.fixed ? 'Fixed in place' : dof > 0 || !mated ? `Under defined: it can still move (${mated ? dof : 6} degree${(mated ? dof : 6) === 1 ? '' : 's'} of freedom) — drag it, or add mates` : 'Fully defined by its mates',
        selected: this.sel?.kind === 'comp' && this.sel.id === c.id,
        onClick: () => this.select({ kind: 'comp', id: c.id }),
        onDbl: () => this.openPart(c.id),
        menu: () => this.compMenu(c),
        vis: e.suppressed ? null : { on: !e.hidden, toggle: () => this.setHidden(c.id, !e.hidden) },
      });
    }
    const open = !this._matesClosed;
    row({ ic: 'mate', label: `Mates (${this.doc.mates.length})`, depth: 1, cls: 'tree-folder', twisty: this.doc.mates.length ? (open ? '▼' : '▶') : '', onTwisty: () => { this._matesClosed = open; this.renderTree(); } });
    if (open) for (const m0 of this.doc.mates) {
      const m = this.effMate(m0);
      const info = MATE_TYPES[m.type];
      const val = info.value ? ` ${fmt(Number(m.value))}${info.value === '°' ? '°' : ' mm'}` : '';
      row({
        ic: info.icon, label: `${m.name}${val}`, depth: 2, cls: m.suppressed ? 'suppressed' : '',
        sub: `(${this.comp(m.a.comp)?.name || '?'}, ${this.comp(m.b.comp)?.name || '?'})`,
        selected: this.sel?.kind === 'mate' && this.sel.id === m.id,
        onClick: () => this.select({ kind: 'mate', id: m.id }),
        onDbl: () => this.startMate(m.id),
        menu: () => [
          { label: 'Edit Mate', icon: 'edit', action: () => this.startMate(m.id) },
          ...(['coincident', 'parallel', 'distance', 'tangent'].includes(m.type) ? [{ label: 'Flip Alignment', icon: 'flip', action: () => this.flipMate(m.id) }] : []),
          { label: m.suppressed ? 'Unsuppress' : 'Suppress', icon: 'suppress', action: () => this.toggleMate(m.id) },
          'sep',
          { label: 'Delete', icon: 'trash', key: 'Del', action: () => this.deleteMate(m.id) },
        ],
      });
    }
    if (this.doc.explodes.length) {
      const exOpen = !this._exClosed;
      row({ ic: 'explode', label: `Exploded Views (${this.doc.explodes.length})`, depth: 1, cls: 'tree-folder', twisty: exOpen ? '▼' : '▶', onTwisty: () => { this._exClosed = exOpen; this.renderTree(); } });
      if (exOpen) for (const ex of this.doc.explodes) {
        const on = this.doc.exploded === ex.id;
        row({
          ic: 'explode', label: ex.name, depth: 2, sub: on ? 'exploded' : '', cls: on ? '' : 'hidden-item',
          title: `${ex.steps.length} step${ex.steps.length === 1 ? '' : 's'} — double-click to ${on ? 'collapse' : 'explode'}`,
          onDbl: () => this.setExploded(on ? null : ex.id, true),
          menu: () => [
            on ? { label: 'Collapse', icon: 'explode', action: () => this.setExploded(null) } : { label: 'Explode', icon: 'explode', action: () => this.setExploded(ex.id) },
            { label: on ? 'Animate Collapse' : 'Animate Explode', icon: 'explode', action: () => this.setExploded(on ? null : ex.id, true) },
            { label: 'Edit Exploded View', icon: 'edit', action: () => this.startExplode(ex.id) },
            { label: 'Rename', icon: 'rename', action: () => this.app.ui.promptText('Rename', 'explode', 'Name', ex.name).then((v) => { if (v?.trim()) { this.begin(); ex.name = v.trim(); this.change(); } }) },
            'sep',
            { label: 'Delete', icon: 'trash', action: () => this.deleteExplode(ex.id) },
          ],
        });
      }
    }
    if (!this.doc.components.length) root.appendChild(el('div', { class: 'pm-hint', style: 'padding:10px 14px' }, 'Start with <b>Insert Components</b>: the first part is fixed at the origin; insert more and <b>Mate</b> them.'));
  }

  renderPM() {
    if (!this.isActive()) return;
    if (this.explodeTool) { this.explodeTool.renderPM(); return; }
    const ui = this.app.ui, root = $('#pm');
    root.innerHTML = '';
    const pm = this.pm;
    if (!pm) { ui.showLeft('tree'); return; }
    ui.showLeft('pm');
    root.appendChild(el('div', { class: 'pm-head' }, `<span class="ti">${icon('mate')}</span><span>${pm.edit ? 'Edit Mate' : 'Mate'}</span>`));
    const act = el('div', { class: 'pm-actions' });
    act.appendChild(el('button', { title: 'OK (Enter)', onclick: () => this.okMate() }, icon('ok')));
    act.appendChild(el('button', { title: 'Close (Esc)', onclick: () => this.cancelMate() }, icon('cancel')));
    root.appendChild(act);
    if (pm.error) root.appendChild(el('div', { class: 'pm-msg err' }, esc(pm.error)));
    const g1 = ui.pmGroup(root, 'Entities to Mate', 'asm:ents');
    const list = el('div', { class: 'pm-list' });
    pm.picks.forEach((r, i) => {
      const li = el('div', { class: 'li sel' }, `<span>${i + 1}. ${esc(this.refLabel(r))}</span><span class="x" title="Remove">✕</span>`);
      li.querySelector('.x').onclick = () => { pm.picks.splice(i, 1); this.cancelPreview(); this.renderPM(); this.highlight(); };
      list.appendChild(li);
    });
    if (pm.picks.length < 2) list.appendChild(el('div', { class: 'pm-hint', style: 'padding:4px 6px' }, pm.picks.length ? 'Click the entity on the other component.' : 'Click a face, edge or vertex of one component, then one of another.'));
    g1.appendChild(list);
    if (pm.picks.length === 2) {
      const [A, B] = pm.picks.map((x) => this.worldRef(x));
      const g2 = ui.pmGroup(root, 'Mate Type', 'asm:type');
      const bar = el('div', { class: 's3-tools' });
      for (const t of mateChoices(A, B)) {
        const b = el('button', { class: 's3-tool' + (pm.type === t ? ' active' : '') }, `${icon(MATE_TYPES[t].icon)}<span>${MATE_TYPES[t].label}</span>`);
        b.onclick = () => { pm.type = t; pm.value = null; this.setDefaultValue(); this.previewMate(); };
        bar.appendChild(b);
      }
      g2.appendChild(bar);
      const info = MATE_TYPES[pm.type];
      if (info?.value) {
        g2.appendChild(el('label', { class: 'pm-label' }, pm.type === 'angle' ? 'Angle' : 'Distance'));
        g2.appendChild(ui.exprInput(pm.value ?? 0, info.value === '°' ? '°' : 'mm', (v) => { if (Number.isFinite(+v)) { pm.value = +v; this.previewMate(); } }, { min: 0 }));
      }
      const flippable = ['coincident', 'parallel', 'distance', 'tangent'].includes(pm.type) && (pm.type === 'distance' || pm.type === 'tangent' || (A.n || A.d) && (B.n || B.d));
      if (flippable) {
        const fb = el('button', { class: 'pm-btn' }, pm.type === 'distance' || pm.type === 'tangent' ? 'Flip Side' : pm.align > 0 ? 'Aligned — click for Anti-Aligned' : 'Anti-Aligned — click for Aligned');
        fb.onclick = () => { if (pm.type === 'distance' || pm.type === 'tangent') pm.side = -(pm.side || 1); else pm.align = -(pm.align || -1); this.previewMate(); };
        g2.appendChild(fb);
      }
      g2.appendChild(el('div', { class: 'pm-hint' }, 'The mate is shown applied. ✔ keeps it and starts the next one; Esc closes.'));
    }
  }
  cancelPreview() {
    if (this.pmBefore) Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    this.updateGeometry();
  }
}

// ------------------------------------------------------------------ refs from a part's mesh
function meshBox(m) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.vertices.length; i += 3) for (let k = 0; k < 3; k++) { const v = m.vertices[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max };
}
// a face (by its number in the part's mesh) as a mate ref
function refOfFace(m, gi) {
  const s = m.faceGroups[gi]?.surf;
  if (!s) return null;
  if (s.t === 'PLANE') return { kind: 'plane', p: s.p.map(r6), n: s.n.map(r6), what: 'Face' };
  if (s.t === 'CYLINDER' || s.t === 'CONE') return { kind: 'axis', p: s.p.map(r6), d: s.d.map(r6), r: r6(s.r), what: s.t === 'CYLINDER' ? 'Cylindrical face' : 'Conical face' };
  if (s.t === 'SPHERE') return { kind: 'point', p: s.p.map(r6), r: r6(s.r), what: 'Spherical face' };
  return null;
}
// an edge as a mate ref: a circle → its axis; a straight edge → its line
function refOfEdge(m, ei) {
  const e = m.edges[ei];
  if (!e) return null;
  if (e.circ) return { kind: 'axis', p: e.circ.c.map(r6), d: e.circ.n.map(r6), r: r6(e.circ.r), circle: true, what: 'Circular edge' };
  if (e.type === 'LINE' && e.pts.length >= 6) {
    const a = e.pts.slice(0, 3), b = e.pts.slice(-3);
    return { kind: 'axis', p: a.map(r6), d: unit(sub(b, a)).map(r6), what: 'Edge' };
  }
  return { kind: 'point', p: e.mid.map(r6), what: 'Edge middle' };
}
