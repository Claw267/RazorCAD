// Geometry kernel worker: replays the feature history with OpenCascade (via
// replicad) and returns render meshes, exact edge data and solved sketches.
import Module from '../vendor/replicad/replicad_single.js';
import * as R from '../vendor/replicad/replicad.js';
import { evaluate, evalEquations } from './expr.js';
import * as S from './sketchmodel.js';
import { solveSketch } from './solver.js';
import { inferPlaneType, planeRefs } from './refgeom.js';
import { threadList, minorDiameter, nearestThread } from './threads.js';
import * as SM from './sheetmetal.js';
import { holeSpec, holeProfile } from './holes.js';
import { profileDims, profileSection, piercePoint } from './profiles.js';
import { normalize3d, solve3d, splineGeom } from './sketch3dmodel.js';
import { decimate } from './meshdecimate.js';
import { installRealDelete, freeStats } from './ocfree.js';

// sheet metal features (they keep a body's flat pattern up to date)
// sheet metal features that make new bodies (from sketches)
const SHEET_NEW = new Set(['smBase', 'smExtrude', 'smLoft', 'smTransition']);
const SHEET_TYPES = new Set(['smBase', 'smFlange', 'smCornerRelief', 'smClosedCorner', 'smUnfold', 'smFold', 'smConvert', 'smLoft', 'smTransition', 'smHem', 'smExtrude', 'smSketchBend', 'smJog', 'smCrossBreak', 'smTabSlot', 'smForm', 'smGusset', 'smProfileFlange']);

// Crash reports: keep enough of the call stack to see where a deep kernel recursion started.
Error.stackTraceLimit = 80;

// Kernel stack. When an OpenCascade error (a C++ exception) escapes a kernel call into JavaScript,
// the kernel's stack pointer is not put back: every failed fillet, boolean or shell attempt
// leaves it 32 bytes lower, and given enough failures it would run into the kernel's own data.
// No kernel code is running between requests, so the stack pointer is reset to its starting
// value around each request.
// If the kernel breaks anyway (it aborted, e.g. after a stack overflow deep inside OpenCascade),
// requests answer with `fatal` and the client replaces the worker; a broken kernel otherwise
// makes every feature fail and the bodies vanish until the program is restarted.
let stack = null;      // { get, set, top }
let stackLost = 0;     // bytes of kernel stack recovered so far (for crash reports)
let kernelDead = null; // why the kernel stopped (abort); the worker must then be replaced

// emscripten_stack_get_current / _emscripten_stack_restore: plain names in unminified builds,
// 'Ra' / 'Pa' in the bundled replicad_single.wasm. Checked before use.
function findStackFns(x) {
  const pairs = [['emscripten_stack_get_current', '_emscripten_stack_restore'], ['Ra', 'Pa']];
  for (const [g, s] of pairs) {
    const get = x[g], set = x[s];
    if (typeof get !== 'function' || typeof set !== 'function' || get.length !== 0 || set.length !== 1) continue;
    try {
      const sp = get();
      if (!Number.isInteger(sp) || sp <= 1024 || sp % 16 || get() !== sp) continue;
      set(sp - 16);
      const moved = get() === sp - 16;
      set(sp);
      if (moved && get() === sp) return { get, set, top: sp };
    } catch { /* not these */ }
  }
  console.warn('RazorCAD: kernel stack functions not found; the stack is not reset between requests');
  return null;
}

function resetStack() {
  if (!stack) return;
  const sp = stack.get();
  if (sp !== stack.top) { stackLost += stack.top - sp; stack.set(stack.top); }
}

// Errors after which the kernel can't be trusted any more (the worker is replaced).
function isFatal(e) {
  if (kernelDead) return true;
  if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) return true;
  const msg = String(e?.message || '');
  return /Maximum call stack|Aborted\(|memory access out of bounds|unreachable|table index is out of bounds|Out of memory/i.test(msg);
}

const wasmUrl = new URL('../vendor/replicad/replicad_single.wasm', import.meta.url);
const ready = (async () => {
  let exportsOf = null;
  const oc = await new Promise((resolve, reject) => {
    Module({
      instantiateWasm(imports, done) {
        WebAssembly.instantiateStreaming(fetch(wasmUrl), imports)
          .catch(() => fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => WebAssembly.instantiate(b, imports)))
          .then((r) => { exportsOf = r.instance.exports; done(r.instance, r.module); }, reject);
        return {};
      },
      onAbort(what) { kernelDead = `the geometry kernel aborted${what ? ` (${what})` : ''}`; },
    }).then(resolve, reject);
  });
  stack = findStackFns(exportsOf);
  // (type information and vtables are static data, below the stack)
  installRealDelete(oc, exportsOf, stack?.top ?? 12 * 1048576);
  R.setOC(oc);
})();

// Progress for long operations (value 0..1, or null when it can't be measured).
let quietProgress = 0; // > 0 while a helper rebuild runs (e.g. for a shell), which reports no progress
let progressFeature = null; // the feature being built (so a long one can be stopped and suppressed)
const progress = (value, label) => { if (!quietProgress) self.postMessage({ type: 'progress', value, label, feature: progressFeature }); };

// For highlighting a feature's faces: the solid before/after every feature of the last rebuild,
// one sample point per face of the final model, and the model size.
let lastFeatureDiffs = new Map();
let rebuildCache = null; // { eqKey, entries: [{ json, snap }] }: the state after each feature of the last rebuild
let lastSketchBodies = new Map();
let lastFacePts = [];
let lastDiag = 1;
let lastMeshTol = 0.01;

let lastBody = null;
let lastSolids = [];
let lastSurfaces = [];
let lastName = 'Part';
const importCache = new Map();

// ------------------------------------------------------------ vector helpers
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Sketch-plane frame for a plane through point p with normal n. The in-plane "up" axis
// follows world Y where possible, and the origin is the part origin projected onto the plane.
function frameOnPlane(p, n) {
  n = unit(n);
  const v = Math.abs(n[1]) > 0.999 ? [0, 0, -1] : unit([-n[0] * n[1], 1 - n[1] * n[1], -n[2] * n[1]]);
  const u = unit(cross(v, n));
  const o = mul(n, n[0] * p[0] + n[1] * p[1] + n[2] * p[2]);
  return { o, u, v, n };
}

// Line where two planes {p, n} meet.
function planeIntersection(A, B) {
  const d = cross(A.n, B.n);
  const h1 = A.n[0] * A.p[0] + A.n[1] * A.p[1] + A.n[2] * A.p[2];
  const h2 = B.n[0] * B.p[0] + B.n[1] * B.p[1] + B.n[2] * B.p[2];
  const n11 = 1, n22 = 1, n12 = A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2];
  const det = n11 * n22 - n12 * n12;
  const c1 = (h1 * n22 - h2 * n12) / det, c2 = (h2 * n11 - h1 * n12) / det;
  return { o: [c1 * A.n[0] + c2 * B.n[0], c1 * A.n[1] + c2 * B.n[1], c1 * A.n[2] + c2 * B.n[2]], d: unit(d) };
}
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const vec = (v) => (Array.isArray(v) ? v : v.toTuple());

const STD = {
  front: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  top: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
  right: { o: [0, 0, 0], u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] },
};
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

const rPlane = (fr, origin = fr.o) => new R.Plane(origin, fr.u, fr.n);

// ------------------------------------------------------------ profiles
function loopDrawing(loop) {
  const segs = loop.segs;
  if (segs.length === 1 && segs[0].type === 'circle') return R.drawSingleCircle(segs[0].r).translate(segs[0].c[0], segs[0].c[1]);
  // arcs that together make a whole circle (e.g. after trimming and re-joining) are one circle too
  if (segs.length > 1 && segs.every((x) => x.type === 'arc')) {
    const c = arcCenter(segs[0]);
    if (c && segs.every((x) => { const k = arcCenter(x); return k && Math.hypot(k.c[0] - c.c[0], k.c[1] - c.c[1]) < 1e-7 * (1 + c.r) && Math.abs(k.r - c.r) < 1e-7 * (1 + c.r); }))
      return R.drawSingleCircle(c.r).translate(c.c[0], c.c[1]);
  }
  const pen = R.draw(segs[0].a);
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s.type === 'line') { if (!last) pen.lineTo(s.b); }
    else if (s.type === 'arc') pen.threePointsArcTo(s.b, s.m);
    else if (s.type === 'bezier') pen.cubicBezierCurveTo(s.b, s.c1, s.c2);
  });
  return pen.close();
}

// center and radius of an arc segment { a, m, b } (start, middle, end)
function arcCenter({ a, m, b }) {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, m2 = m[0] ** 2 + m[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2;
  const c = [(a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d, (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d];
  return { c, r: Math.hypot(a[0] - c[0], a[1] - c[1]) };
}

// Merge faces that lie on the same surface (e.g. the halves of a cylinder) into one face.
function unify(shape) {
  try { return shape.simplify(); } catch { return shape; }
}

// Seam edges: where a closed surface (cylinder, cone, torus, sphere) meets itself. Such an
// edge appears twice in its own face's boundary. They are not drawn or picked.
function seamEdges(shape) {
  const oc = R.getOC();
  const T = oc.TopAbs_ShapeEnum;
  const seams = [];
  for (const face of shape.faces) {
    if (face.geomType === 'PLANE') continue;
    const seen = [];
    const ex = new oc.TopExp_Explorer(face.wrapped, T.TopAbs_EDGE, T.TopAbs_SHAPE);
    while (ex.More()) {
      const e = ex.Current();
      const i = seen.findIndex((x) => x.IsSame(e));
      if (i >= 0) seams.push(seen[i]); else seen.push(e);
      ex.Next();
    }
    ex.delete();
  }
  return seams;
}

function regionsDrawing(regions) {
  let all = null;
  for (const r of regions) {
    let d = loopDrawing(r.outer);
    for (const h of r.holes) d = d.cut(loopDrawing(h));
    all = all ? all.fuse(d) : d;
  }
  return all;
}

// ------------------------------------------------------------ body queries
// Shapes never change once made, so their bounding boxes (and the edge/face lists below) are cached.
const bboxCache = new WeakMap();
function bbox(shape) {
  let r = bboxCache.get(shape);
  if (!r && shape._parts) { r = bboxOfAll(shape._parts); bboxCache.set(shape, r); }
  if (!r) {
    const b = shape.boundingBox.bounds;
    r = { min: b[0], max: b[1], center: mul(add(b[0], b[1]), 0.5), diag: len(sub(b[1], b[0])) };
    bboxCache.set(shape, r);
  }
  return r;
}

// Smallest possible distance from point p to anything inside box (0 when p is inside).
function boxDist(box, p) {
  let s = 0;
  for (let i = 0; i < 3; i++) { const d = Math.max(box.min[i] - p[i], 0, p[i] - box.max[i]); s += d * d; }
  return Math.sqrt(s);
}

// Union of the boxes of several shapes.
function bboxOfAll(shapes) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const s of shapes) { const b = bbox(s); for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); } }
  return { min, max, center: mul(add(min, max), 0.5), diag: len(sub(max, min)) };
}

// ------------------------------------------------------------ solid bodies
// A part can hold several solid bodies. Each body keeps a stable id across rebuilds: the id
// of the feature that created it ("f3"; "f3.2" for a second body made by the same feature;
// "f3~2" for the smaller piece when a cut splits body f3). Body names and materials are
// stored in the document under these ids.
function solidsOf(shape) {
  if (!shape) return [];
  const list = shape.solids;
  if (list.length) return list;
  // no solid inside: an open (shell) STL import is kept as one body; an empty result is nothing
  return R.iterTopo(shape.wrapped, 'shell').next().done ? [] : [shape];
}

// All bodies as one shape. (replicad's makeCompound deletes its inputs; the bodies must stay alive.)
function compoundOf(list) {
  if (!list.length) return null;
  if (list.length === 1) return list[0].shape;
  const oc = R.getOC();
  const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
  builder.MakeCompound(comp);
  for (const b of list) builder.Add(comp, b.shape.wrapped);
  builder.delete();
  const c = R.cast(comp);
  c._parts = list.map((b) => b.shape); // per-body caches (edges, faces, meshes) stay valid
  return c;
}

function boxesTouch(a, b, tol) {
  for (let k = 0; k < 3; k++) if (a.min[k] > b.max[k] + tol || b.min[k] > a.max[k] + tol) return false;
  return true;
}

function volumeOf(rec) {
  if (rec.vol == null) { try { rec.vol = R.measureVolume(rec.shape); } catch { rec.vol = NaN; } }
  return rec.vol;
}

// ------------------------------------------------------------ persistent edge references
// An edge reference is { p: point on edge, t: curve type, d: line direction, box: body
// bounding box when last found }. Edges are re-found after the model changes by
// matching type/direction near the stored point, or near the point remapped into the
// new bounding box, and only accepted when the match is unambiguous.
const edgeInfoCache = new WeakMap();
// Edges of one body (kept per body, so an unchanged body is never enumerated again).
function edgeInfosOne(shape) {
  let info = edgeInfoCache.get(shape);
  if (!info) {
    // seams of closed surfaces are not real edges: never match (or fillet) them
    const seams = seamEdges(shape);
    info = shape.edges.filter((e) => !seams.some((x) => x.IsSame(e.wrapped))).map((e) => {
      const t = e.geomType;
      let d = null;
      if (t === 'LINE') { const v = vec(e.tangentAt(0.5)); const l = len(v) || 1; d = mul(v, 1 / l); }
      return { e, t, d, box: bbox(e), part: shape, circ: t === 'CIRCLE' ? circleOf(e) : null };
    });
    edgeInfoCache.set(shape, info);
  }
  return info;
}
function edgeInfos(body) {
  if (!body._parts) return edgeInfosOne(body);
  let info = edgeInfoCache.get(body);
  if (!info) { info = body._parts.flatMap(edgeInfosOne); edgeInfoCache.set(body, info); }
  return info;
}

function mapIntoBox(p, from, to) {
  return [0, 1, 2].map((i) => {
    const s0 = from.max[i] - from.min[i], s1 = to.max[i] - to.min[i];
    return s0 > 1e-9 ? to.min[i] + ((p[i] - from.min[i]) / s0) * s1 : p[i] + (to.min[i] - from.min[i]);
  });
}

// The nearest and second-nearest of `cands` (with .box and shapeOf(c)) to p. Candidates are
// tried nearest box first and the search stops once no box can beat the second best.
function nearestTwo(cands, p, shapeOf) {
  const list = cands.map((c) => [boxDist(c.box, p), c]).sort((a, b) => a[0] - b[0]);
  let q = null, best = null, bd = Infinity, second = Infinity;
  for (const [lb, c] of list) {
    if (lb > second) break;
    q ||= new R.DistanceQuery(R.makeVertex(p));
    const dd = q.distanceTo(shapeOf(c));
    if (dd < bd) { second = bd; bd = dd; best = c; } else if (dd < second) second = dd;
  }
  return { best, bd, second };
}

const findEdge = (body, ref) => findEdgeInfo(body, ref)?.e ?? null;

// The edge a reference points at, with the body it belongs to (info.part).
function findEdgeInfo(body, ref) {
  if (!body) return null;
  const b = bbox(body);
  const candidates = edgeInfos(body).filter((c) => (!ref.t || c.t === ref.t) && (!ref.d || !c.d || Math.abs(dot(c.d, ref.d)) > 0.98));
  const search = (p) => nearestTwo(candidates, p, (c) => c.e);
  const tol = Math.max(0.05, b.diag * 0.15);
  const ok = (r) => r.best && r.bd < tol && (r.bd < 1e-3 || r.second > r.bd * 1.6);
  const raw = search(ref.p);
  if (raw.best && raw.bd < Math.max(1e-3, b.diag * 1e-4)) return raw.best;
  const mapped = ref.box ? search(mapIntoBox(ref.p, ref.box, b)) : null;
  const choices = [raw, mapped].filter((r) => r && ok(r)).sort((x, y) => x.bd - y.bd);
  if (choices.length) return choices[0].best;
  // a circular edge that moved further (e.g. a hole whose position changed): the one circle of the
  // same radius lying in the same plane as before
  if (ref.t === 'CIRCLE' && ref.r && ref.c && ref.n) {
    const tolR = Math.max(1e-6, ref.r * 1e-6), tolP = Math.max(1e-4, b.diag * 1e-6);
    const same = candidates.filter((c) => c.circ && Math.abs(c.circ.r - ref.r) < tolR && Math.abs(Math.abs(dot(c.circ.n, ref.n)) - 1) < 1e-6
      && Math.abs(dot(sub(c.circ.c, ref.c), ref.n)) < tolP);
    if (same.length === 1) return same[0];
  }
  return null;
}

// Radius, centre and normal of a circular edge.
function circleOf(e) {
  const oc = R.getOC();
  const ad = new oc.BRepAdaptor_Curve(e.wrapped);
  try {
    const c = ad.Circle(), L = c.Location(), D = c.Axis().Direction();
    return { r: c.Radius(), c: [L.X(), L.Y(), L.Z()], n: unit([D.X(), D.Y(), D.Z()]) };
  } catch { return null; } finally { ad.delete(); }
}

// Refresh a reference from the edge it was matched to.
function updateEdgeRef(ref, e, body) {
  const b = bbox(body);
  ref.p = vec(e.pointAt(0.5));
  ref.t = e.geomType;
  if (ref.t === 'LINE') { const v = vec(e.tangentAt(0.5)); const l = len(v) || 1; ref.d = mul(v, 1 / l); } else delete ref.d;
  // circles also remember radius, centre and plane, so they can be found again after a bigger move
  const circ = ref.t === 'CIRCLE' ? circleOf(e) : null;
  if (circ) Object.assign(ref, { r: circ.r, c: circ.c, n: circ.n }); else { delete ref.r; delete ref.c; delete ref.n; }
  ref.box = { min: b.min, max: b.max };
}

// ------------------------------------------------------------ persistent face references
// A planar face reference is { p: point on the face, n: normal, box }. Faces are re-found
// like edges: same orientation, nearest to the stored (or bounding-box-remapped) point.
const faceInfoCache = new WeakMap();
function faceInfosOne(shape) {
  let info = faceInfoCache.get(shape);
  if (!info) {
    info = [];
    for (const face of shape.faces) {
      if (face.geomType !== 'PLANE') continue;
      const n = vec(face.normalAt());
      info.push({ face, n: mul(n, 1 / (len(n) || 1)), box: bbox(face) });
    }
    faceInfoCache.set(shape, info);
  }
  return info;
}
function faceInfos(body) {
  if (!body._parts) return faceInfosOne(body);
  let info = faceInfoCache.get(body);
  if (!info) { info = body._parts.flatMap(faceInfosOne); faceInfoCache.set(body, info); }
  return info;
}

// All faces of a body with their boxes (cached per body).
const faceListCache = new WeakMap();
function facesWithBox(shape) {
  let l = faceListCache.get(shape);
  if (!l) {
    l = shape._parts ? shape._parts.flatMap(facesWithBox) : shape.faces.map((face) => ({ face, box: bbox(face) }));
    faceListCache.set(shape, l);
  }
  return l;
}

function findFace(body, ref) {
  if (!body) return null;
  const b = bbox(body);
  const cands = faceInfos(body).filter((c) => Math.abs(dot(c.n, ref.n)) > 0.999);
  const search = (p) => nearestTwo(cands, p, (c) => c.face);
  const tol = Math.max(0.05, b.diag * 0.15);
  const ok = (r) => r.best && r.bd < tol && (r.bd < 1e-3 || r.second > r.bd * 1.6);
  let hit = null;
  const raw = search(ref.p);
  if (raw.best && raw.bd < 1e-3) hit = raw.best;
  else {
    const mapped = ref.box ? search(mapIntoBox(ref.p, ref.box, b)) : null;
    const choices = [raw, mapped].filter((r) => r && ok(r)).sort((x, y) => x.bd - y.bd);
    if (choices.length) hit = choices[0].best;
  }
  if (!hit) return null;
  // a point on the found face's plane: project the reference point onto it
  const c = vec(hit.face.center);
  const p = add(ref.p, mul(hit.n, dot(sub(c, ref.p), hit.n)));
  ref.p = p;
  ref.n = hit.n;
  ref.box = { min: b.min, max: b.max };
  return { p, n: hit.n };
}

// ------------------------------------------------------------ meshes of bodies (cached per body)
const KERNEL_SESSION = Math.random().toString(36).slice(2, 10); // mesh keys from an earlier kernel never match
const shapeIds = new WeakMap();
let shapeSeq = 0;
const shapeId = (s) => { let id = shapeIds.get(s); if (!id) { id = ++shapeSeq; shapeIds.set(s, id); } return id; };
const meshCache = new WeakMap();

// Mesh, edge polylines and face sample points of one body. A body with thousands of faces (a
// triangulated STL) is "dense": its faces/edges are not enumerated (the view draws mesh edges).
// How many faces a shape has (quick: no wrappers, no check for repeats).
function faceCount(shape) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum, ex = new oc.TopExp_Explorer(shape.wrapped, T.TopAbs_FACE, T.TopAbs_SHAPE);
  let n = 0;
  try { for (; ex.More(); ex.Next()) n++; } finally { ex.delete(); }
  return n;
}
// The display mesh of a body made of triangle faces (an imported mesh): each face's three corners, read
// straight off it. (Meshing tens of thousands of faces through the kernel runs it out of memory.) null when
// a face is not a triangle.
function triangleFacesMesh(shape) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum;
  const fx = new oc.TopExp_Explorer(shape.wrapped, T.TopAbs_FACE, T.TopAbs_SHAPE);
  const V = [], N = [], I = [], groups = [];
  try {
    for (let fi = 0; fx.More(); fx.Next(), fi++) {
      const face = fx.Current();
      const vx = new oc.TopExp_Explorer(face, T.TopAbs_VERTEX, T.TopAbs_SHAPE);
      const pts = [];
      try {
        for (; vx.More(); vx.Next()) {
          const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vx.Current()));
          const q = [p.X(), p.Y(), p.Z()];
          p.delete();
          if (!pts.some((r) => r[0] === q[0] && r[1] === q[1] && r[2] === q[2])) pts.push(q);
          if (pts.length > 3) break;
        }
      } finally { vx.delete(); }
      if (pts.length !== 3) return null;
      // (its corners in the face's own turn: reversed faces turned round)
      if (face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) pts.reverse();
      const [a, b, c] = pts, n = unit(cross(sub(b, a), sub(c, a)));
      const base = V.length / 3;
      for (const q of pts) { V.push(q[0], q[1], q[2]); N.push(n[0], n[1], n[2]); }
      I.push(base, base + 1, base + 2);
      groups.push({ start: fi, count: 1, faceId: fi });
    }
  } finally { fx.delete(); }
  return { vertices: new Float32Array(V), normals: new Float32Array(N), triangles: new Uint32Array(I), faceGroups: groups };
}

// What a face is, for mates: { t: 'PLANE', p, n } (n the face's outward normal), { t: 'CYLINDER' | 'CONE', p, d, r }
// (a point on the axis, its direction), { t: 'SPHERE', p, r } or { t: 'OTHER' }.
function surfOf(face) {
  const oc = R.getOC();
  let ad = null;
  try {
    const t = face.geomType;
    if (t === 'PLANE') return { t, p: vec(face.center), n: unit(vec(face.normalAt())) };
    ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
    const ax = (a) => { const L = a.Location(), D = a.Direction(); return { p: [L.X(), L.Y(), L.Z()], d: unit([D.X(), D.Y(), D.Z()]) }; };
    if (t === 'CYLINDER' || t === 'CYLINDRE') { const c = ad.Cylinder(); return { t: 'CYLINDER', ...ax(c.Axis()), r: c.Radius() }; }
    if (t === 'CONE') { const c = ad.Cone(); return { t, ...ax(c.Axis()), r: c.RefRadius() }; }
    if (t === 'SPHERE') { const c = ad.Sphere(), L = c.Location(); return { t, p: [L.X(), L.Y(), L.Z()], r: c.Radius() }; }
    return { t: 'OTHER' };
  } catch { return { t: 'OTHER' }; } finally { ad?.delete(); }
}

function meshPart(s, tol, diagQ, onWork) {
  const c = meshCache.get(s.shape);
  if (c && c.tol === tol && c.diagQ === diagQ && c.kind === s.kind && c.look === (s.look || null)) return c;
  onWork?.();
  const m = (faceCount(s.shape) > 2500 && triangleFacesMesh(s.shape)) || s.shape.mesh({ tolerance: tol, angularTolerance: 0.2 });
  const dense = m.faceGroups.length > 2500;
  const gs = m.faceGroups.reduce((n, g) => n + g.count, 0) === m.triangles.length ? 1 : 3;
  // a few points spread over each face (triangle centroids), for finding which feature made it
  const facePts = m.faceGroups.map((g) => {
    if (dense || s.kind !== 'solid') return null;
    const V = m.vertices, T = m.triangles, nTri = Math.max(1, Math.floor((g.count * gs) / 3));
    const pts = [];
    const take = Math.min(7, nTri);
    for (let q = 0; q < take; q++) {
      const t = g.start * gs + Math.floor(((q + 0.5) * nTri) / take) * 3;
      pts.push([0, 1, 2].map((j) => (V[T[t] * 3 + j] + V[T[t + 1] * 3 + j] + V[T[t + 2] * 3 + j]) / 3));
    }
    return pts;
  });
  const edges = [];
  if (!dense) {
    const seams = seamEdges(s.shape);
    for (const e of s.shape.edges) {
      if (seams.some((x) => x.IsSame(e.wrapped))) continue;
      const circ = e.geomType === 'CIRCLE' ? circleOf(e) : null;
      edges.push({ pts: sampleEdge(e, diagQ).flat(), mid: vec(e.pointAt(0.5)), type: e.geomType, ...(circ ? { circ } : {}) });
    }
  }
  // (faces as the mesh numbers them: their surfaces, for assembly mates)
  let surfs = null;
  if (!dense) {
    const faces = s.shape.faces;
    // (a face group knows its face by hash code; the mesh lists them in the same order as the faces)
    const byHash = new Map();
    for (const f of faces) { try { byHash.set(f.hashCode, f); } catch { /* no hash */ } }
    surfs = m.faceGroups.map((g, gi) => { const f = byHash.get(g.faceId) || faces[gi]; return f ? surfOf(f) : { t: 'OTHER' }; });
  }
  // the looks an import gave single faces, each face found by its vertex box
  let faceLooks = null;
  if (s.look?.faces?.length) {
    const faces = s.shape.faces, byHash = new Map();
    for (const f of faces) { try { byHash.set(f.hashCode, f); } catch { /* no hash */ } }
    faceLooks = m.faceGroups.map((g, gi) => {
      const f = byHash.get(g.faceId) || faces[gi];
      const b = f && vertexBox(f.wrapped);
      const e = b && s.look.faces.find((x) => boxNear(b, x.b, lookTol(x.b)));
      return e ? { c: e.c ?? null, t: e.t || 0 } : null;
    });
  }
  const out = { tol, diagQ, kind: s.kind, look: s.look || null, m, gs, dense, facePts, edges, surfs, faceLooks };
  meshCache.set(s.shape, out);
  return out;
}

// ------------------------------------------------------------ previews
function meshData(shapes, diag) {
  const parts = [];
  for (const s of shapes) {
    if (!s) continue;
    try { parts.push(s.mesh({ tolerance: Math.max(0.01, diag * 0.001), angularTolerance: 0.3 })); } catch { /* skip */ }
  }
  if (!parts.length) return null;
  let nv = 0, nt = 0;
  for (const m of parts) { nv += m.vertices.length; nt += m.triangles.length; }
  if (!nt) return null;
  const vertices = new Float32Array(nv), normals = new Float32Array(nv), triangles = new Uint32Array(nt);
  let ov = 0, ot = 0;
  for (const m of parts) {
    vertices.set(m.vertices, ov); normals.set(m.normals, ov);
    for (let i = 0; i < m.triangles.length; i++) triangles[ot + i] = m.triangles[i] + ov / 3;
    ov += m.vertices.length; ot += m.triangles.length;
  }
  return { vertices, normals, triangles };
}

// Preview geometry for the feature being edited: material it adds (yellow) and removes (red).
function makePreview(f, before, after, applied, pair = null) {
  const ref = after || before;
  const diag = ref ? bbox(ref).diag : 100;
  const tryOp = (fn) => { try { return fn(); } catch (e) { if (isFatal(e)) throw e; return null; } };
  if (pair) { before = pair.before; after = pair.after; } // only the body that changed
  if (['fillet', 'chamfer', 'shell', 'combine'].includes(f.type)) {
    if (!before || !after || before === after) return null;
    return {
      add: meshData([tryOp(() => after.cut(before))], diag),
      remove: meshData([tryOp(() => before.cut(after))], diag),
    };
  }
  const shown = (a) => (a.view && tryOp(a.view)) || a.tool; // `view`: how the tool should look (e.g. a thread trimmed flat)
  const adds = applied.filter((a) => a.op === 'add').map(shown);
  const cuts = applied.filter((a) => a.op === 'cut'), cutTools = cuts.map(shown);
  if (!adds.length && !cutTools.length) return null;
  // material a cut removes (solid red), plus the cut volume itself (faint red) so the cut is
  // visible even where it misses the solid. Very long tools (Through All) are clipped to the model.
  // (`inside`: the tool is known to lie in the material, e.g. a thread, so it is shown as it is.)
  const removed = meshData(cuts.map((a, i) => (a.inside ? cutTools[i] : before ? tryOp(() => before.intersect(a.tool)) : null)), diag);
  let clip = null;
  if (before) {
    const b = bbox(before), m = b.diag * 0.05;
    clip = R.makeBox(sub(b.min, [m, m, m]), add(b.max, [m, m, m]));
  }
  const ghost = cutTools.map((t) => (clip && bbox(t).diag > 1.5 * diag ? tryOp(() => t.intersect(clip)) : t));
  return {
    add: meshData(adds, diag),
    remove: removed,
    tool: meshData(ghost, diag),
    missed: cutTools.length > 0 && !removed, // the cut removes nothing
  };
}

// Fillet/chamfer several groups of edges in a single kernel operation on `base`.
// items: [{ refs: [edge refs], value }]. Returns the new shape or null.
function combinedBlend(base, items, type) {
  const sel = [];
  for (const it of items) {
    for (const ref of it.refs) {
      const e = findEdge(base, ref);
      if (!e) return null; // never silently drop an edge
      sel.push({ e, value: it.value });
    }
  }
  if (!sel.length) return null;
  const radius = (edge) => {
    const m = sel.find((s) => s.e.isSame(edge));
    return m ? m.value : null;
  };
  try {
    return type === 'fillet' ? base.fillet(radius) : base.chamfer(radius);
  } catch (e) {
    if (isFatal(e)) throw e;
    return null;
  }
}

// Recompute a failing blend together with ALL earlier blends of the same type: start from
// the body before the first of them, apply every blend in one kernel call, then replay the
// features that came in between (their boolean tools, or other-type blends via edge refs).
function reorderedBlend(steps, type, item) {
  const first = steps.findIndex((s) => s.blend?.type === type);
  if (first < 0 || !steps[first].before) return null;
  const base = steps[first].before;
  const later = steps.slice(first);
  const items = [...later.filter((s) => s.blend?.type === type).map((s) => s.blend.item), item];
  let body = combinedBlend(base, items, type);
  if (!body) return null;
  try {
    for (const s of later) {
      if (s.opaque) return null;
      if (s.blend?.type === type) continue;
      if (s.blend) {
        const edges = s.blend.item.refs.map((r) => findEdge(body, r));
        if (edges.some((e) => !e)) return null;
        const radius = (edge) => (edges.some((e) => e.isSame(edge)) ? s.blend.item.value : null);
        body = s.blend.type === 'fillet' ? body.fillet(radius) : body.chamfer(radius);
        continue;
      }
      for (const a of s.applied) body = a.op === 'add' ? body.fuse(a.tool) : body.cut(a.tool);
    }
  } catch (e) {
    if (isFatal(e)) throw e;
    return null;
  }
  return { body, base, items };
}

function findVertex(body, ref) {

  if (!body) return null;
  const b = bbox(body);
  const pts = [];
  const seen = new Set();
  for (const { e } of edgeInfos(body)) {
    const s = vec(e.startPoint), t = vec(e.endPoint);
    if (len(sub(s, t)) < 1e-6) continue; // seam of a closed edge
    for (const q of [s, t]) {
      const k = q.map((x) => Math.round(x * 1e5)).join(',');
      if (!seen.has(k)) { seen.add(k); pts.push(q); }
    }
  }
  const search = (p) => {
    let best = null, bd = Infinity, second = Infinity;
    for (const q of pts) {
      const dd = len(sub(q, p));
      if (dd < bd) { second = bd; bd = dd; best = q; } else if (dd < second) second = dd;
    }
    return { best, bd, second };
  };
  const tol = Math.max(0.05, b.diag * 0.15);
  const ok = (r) => r.best && r.bd < tol && (r.bd < 1e-3 || r.second > r.bd * 1.6);
  const raw = search(ref.p);
  if (raw.best && raw.bd < 1e-3) return raw.best;
  const mapped = ref.box ? search(mapIntoBox(ref.p, ref.box, b)) : null;
  const choices = [raw, mapped].filter((r) => r && ok(r)).sort((x, y) => x.bd - y.bd);
  return choices.length ? choices[0].best : null;
}

function sampleEdge(e, diag) {
  const type = e.geomType;
  if (type === 'LINE') return [vec(e.startPoint), vec(e.endPoint)];
  const L = e.length;
  // (free-form curves, e.g. a closed corner's lens, get more points: drawn with few they look kinked up close)
  const nMin = type === 'BSPLINE_CURVE' || type === 'BEZIER_CURVE' || type === 'OTHER_CURVE' ? 160 : 24;
  const n = Math.max(nMin, Math.min(128, Math.ceil(L / Math.max(diag * 0.004, 0.05))));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(vec(e.pointAt(i / n)));
  return pts;
}

function edgeGeom(e, diag) {
  return S.classifyPolyline3(sampleEdge(e, diag));
}

// ------------------------------------------------------------ STL import
function parseSTL(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tris = [];
  const isBinary = bytes.length >= 84 && 84 + dv.getUint32(80, true) * 50 === bytes.length;
  if (isBinary) {
    const n = dv.getUint32(80, true);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      tris.push([0, 1, 2].map((k) => [dv.getFloat32(o + k * 12, true), dv.getFloat32(o + k * 12 + 4, true), dv.getFloat32(o + k * 12 + 8, true)]));
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m, cur = [];
    while ((m = re.exec(text))) {
      cur.push([+m[1], +m[2], +m[3]]);
      if (cur.length === 3) { tris.push(cur); cur = []; }
    }
  }
  return tris;
}

// Build a shape directly from triangles with shared vertices/edges (much faster than sewing loose
// faces): a solid when every edge joins exactly two triangles, otherwise an open shell.
// P: [[x, y, z]]; T: [[a, b, c]] point indices (degenerate and repeated triangles are skipped).
// Returns { shape, open (edges with one triangle), closed }.
function meshShape(P, T) {
  const oc = R.getOC();
  const verts = new Array(P.length).fill(null);
  const vtx = (i) => {
    if (!verts[i]) {
      const g = new oc.gp_Pnt(P[i][0], P[i][1], P[i][2]);
      const mv = new oc.BRepBuilderAPI_MakeVertex(g);
      verts[i] = mv.Vertex();
      mv.delete(); g.delete();
    }
    return verts[i];
  };
  const emap = new Map();
  const oedge = (a, b) => {
    const k = a < b ? a + '|' + b : b + '|' + a;
    let rec = emap.get(k);
    if (!rec) {
      const mk = new oc.BRepBuilderAPI_MakeEdge(vtx(a), vtx(b));
      const e = mk.Edge();
      mk.delete();
      rec = { e, from: a, rev: oc.TopoDS.Edge(e.Reversed()), uses: 0 };
      emap.set(k, rec);
    }
    rec.uses++;
    return rec.from === a ? rec.e : rec.rev;
  };
  const shell = new oc.TopoDS_Shell();
  const builder = new oc.TopoDS_Builder();
  builder.MakeShell(shell);
  let faces = 0;
  const seen = new Set();
  for (const [a, b, c] of T) {
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue; // (the same triangle twice)
    seen.add(key);
    const w = new oc.BRepBuilderAPI_MakeWire(oedge(a, b), oedge(b, c), oedge(c, a));
    const f = new oc.BRepBuilderAPI_MakeFace(w.Wire(), true);
    if (f.IsDone()) { builder.Add(shell, f.Face()); faces++; }
    w.delete(); f.delete();
  }
  if (!faces) throw new Error('The mesh contains only degenerate triangles');
  // closed only when every edge joins exactly two triangles (the kernel would orient an open shell too)
  const uses = [...emap.values()].map((r) => r.uses);
  const open = uses.filter((u) => u === 1).length;
  const watertight = uses.every((u) => u === 2);
  const ms = new oc.BRepBuilderAPI_MakeSolid(shell);
  const solid = ms.Solid();
  ms.delete();
  const closed = watertight && oc.BRepLib.OrientClosedSolid(solid);
  let shape = R.cast(closed ? solid : shell); // open mesh: keep it as a shell
  // merge coplanar triangles back into single planar faces: a big win for CAD-made STLs (flat faces of many
  // triangles), but slow and of no use on organic meshes (e.g. a scanned or sculpted model): done only when
  // a good share of neighbouring triangles lie in one plane
  if (faces <= 20000 || coplanarShare(P, T) > 0.3) { try { shape = shape.simplify(); } catch { /* as built */ } }
  return { shape, open, closed };
}
// The share of a mesh's inner edges whose two triangles lie in one plane.
function coplanarShare(P, T) {
  const nrm = T.map(([a, b, c]) => { const n = cross(sub(P[b], P[a]), sub(P[c], P[a])), l = len(n); return l > 0 ? mul(n, 1 / l) : null; });
  const first = new Map();
  let inner = 0, flat = 0;
  T.forEach((t, ti) => {
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3], key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const o = first.get(key);
      if (o === undefined) { first.set(key, ti); continue; }
      inner++;
      if (nrm[o] && nrm[ti] && Math.abs(dot(nrm[o], nrm[ti])) > 0.99999) flat++;
    }
  });
  return inner ? flat / inner : 0;
}
function stlToShape(bytes, maxTris) {
  return trisToShape(parseSTL(bytes), 'STL', maxTris);
}
// Triangles ([[x, y, z] × 3]) of a mesh file → a shape (solid when it closes, else a shell).
// Meshes with more than maxTris triangles are simplified first (the kernel runs out of memory with a few
// hundred thousand faces); 0: never.
const MESH_MAX_TRIS = 80000;
function trisToShape(tris, what = 'mesh', maxTris = MESH_MAX_TRIS) {
  if (!tris.length) throw new Error(`The ${what} file contains no triangles`);
  if (tris.length > 5000000) throw new Error(`The ${what} has ${tris.length.toLocaleString()} triangles; the limit is 5,000,000`);
  const vmap = new Map(), P = [];
  const vid = (p) => {
    const k = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
    let id = vmap.get(k);
    if (id === undefined) { id = P.length; vmap.set(k, id); P.push(p); }
    return id;
  };
  let T = tris.map((t) => t.map(vid)), mesh = { P, T };
  const limit = maxTris > 0 ? Math.max(1000, maxTris) : 0;
  if (limit && T.length > limit) {
    progress(null, `Simplifying the mesh (${T.length.toLocaleString()} triangles)…`);
    mesh = decimate(P, T, limit);
  } else if (!limit && T.length > 300000) throw new Error(`The ${what} has ${T.length.toLocaleString()} triangles: too many to convert without simplifying (set a triangle limit in the import)`);
  const out = meshShape(mesh.P, mesh.T);
  out.reduced = mesh.T.length < T.length ? { from: T.length, to: mesh.T.length } : null;
  return out;
}

// Triangles of flat-faced shapes (e.g. an STL import), points closer than tol welded into one.
function meshTris(shapes, tol) {
  const P = [], T = [], grid = new Map(), cell = Math.max(tol, 1e-9);
  const weld = (p) => {
    const c = p.map((v) => Math.floor(v / cell));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const l = grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`);
      if (l) for (const i of l) if (Math.hypot(P[i][0] - p[0], P[i][1] - p[1], P[i][2] - p[2]) <= tol) return i;
    }
    const i = P.length, k = `${c[0]},${c[1]},${c[2]}`;
    P.push(p);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
    return i;
  };
  for (const s of shapes) {
    const m = (faceCount(s) > 2500 && triangleFacesMesh(s)) || s.mesh({ tolerance: Math.max(tol, 1e-3), angularTolerance: 0.2 });
    const v = m.vertices, t = m.triangles, ids = [];
    for (let i = 0; i < v.length / 3; i++) ids.push(weld([v[3 * i], v[3 * i + 1], v[3 * i + 2]]));
    for (let k = 0; k < t.length; k += 3) T.push([ids[t[k]], ids[t[k + 1]], ids[t[k + 2]]]);
  }
  return { P, T };
}
// A shape made only of flat faces (a mesh): repaired triangle by triangle. (Asking a face its type is
// slow: a big body is judged by a sample of its faces.)
const isMeshLike = (shapes) => shapes.every((s) => {
  const fs = s.faces;
  const pick = fs.length <= 300 ? fs : Array.from({ length: 60 }, (_, i) => fs[Math.floor((i * fs.length) / 60)]);
  return pick.every((f) => f.geomType === 'PLANE');
});

// Repair a triangle mesh: degenerate and repeated triangles dropped, the triangles turned to run the
// same way round (neighbours cross their shared edge in opposite directions), and (with fill) every
// hole (loop of edges with a triangle on one side only) up to maxHole across closed with triangles.
// May add a centre point to P; returns the new triangles with what was done.
function repairTris(P, T0, { maxHole = 0, fill = true } = {}) {
  const T = [], seen = new Set();
  for (const t of T0) {
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
    const k = [...t].sort((a, b) => a - b).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    T.push([...t]);
  }
  const ek = (a, b) => (a < b ? a + ',' + b : b + ',' + a);
  const edges = new Map();
  T.forEach((t, i) => { for (let k = 0; k < 3; k++) { const key = ek(t[k], t[(k + 1) % 3]); if (!edges.has(key)) edges.set(key, []); edges.get(key).push(i); } });
  const runs = (t, a, b) => (t[0] === a && t[1] === b) || (t[1] === a && t[2] === b) || (t[2] === a && t[0] === b);
  // the same way round, spreading from each triangle across edges shared by exactly two
  const done = new Uint8Array(T.length);
  let flipped = 0;
  for (let s = 0; s < T.length; s++) {
    if (done[s]) continue;
    done[s] = 1;
    const stack = [s];
    while (stack.length) {
      const i = stack.pop(), t = T[i];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3], l = edges.get(ek(a, b));
        if (l.length !== 2) continue;
        const j = l[0] === i ? l[1] : l[0];
        if (done[j]) continue;
        if (runs(T[j], a, b)) { T[j] = [T[j][0], T[j][2], T[j][1]]; flipped++; }
        done[j] = 1;
        stack.push(j);
      }
    }
  }
  const nonManifold = [...edges.values()].filter((l) => l.length > 2).length;
  // the holes: each open edge taken the way a patch runs along it (against its triangle)
  const next = new Map();
  let openEdges = 0;
  for (const [key, l] of edges) {
    if (l.length !== 1) continue;
    openEdges++;
    const [u, v] = key.split(',').map(Number), t = T[l[0]];
    const [a, b] = runs(t, u, v) ? [u, v] : [v, u];
    if (!next.has(b)) next.set(b, []);
    next.get(b).push(a);
  }
  const loops = [];
  let chains = 0;
  for (const start of [...next.keys()]) {
    while (next.get(start)?.length) {
      const loop = [start];
      let cur = next.get(start).pop(), ok = false;
      for (let guard = 0; guard <= openEdges; guard++) {
        if (cur === start) { ok = true; break; }
        loop.push(cur);
        const l = next.get(cur);
        if (!l?.length) break;
        cur = l.pop();
      }
      if (ok && loop.length >= 3) loops.push(loop); else chains++;
    }
  }
  let filled = 0, tooBig = 0, failed = 0;
  if (fill) {
    for (const loop of loops) {
      const pts = loop.map((i) => P[i]);
      const lo = [0, 1, 2].map((j) => Math.min(...pts.map((p) => p[j]))), hi = [0, 1, 2].map((j) => Math.max(...pts.map((p) => p[j])));
      if (maxHole > 0 && len(sub(hi, lo)) > maxHole) { tooBig++; continue; }
      const tri = triangulateIdx(pts);
      if (!tri) { failed++; continue; }
      let centre = null;
      for (const t of tri) {
        T.push(t.map((k) => {
          if (k < loop.length) return loop[k];
          if (centre == null) { P.push(tri.centre); centre = P.length - 1; }
          return centre;
        }));
      }
      filled++;
    }
  }
  return { T, filled, tooBig, failed, holes: loops.length, chains, openEdges, nonManifold, flipped };
}
// Triangles closing a polygon (3D points in order), as index triples running the polygon's way round:
// ear clipping in its best-fit plane, or a fan from the centre (index n, the point in .centre).
function triangulateIdx(pts) {
  const n = pts.length;
  let N = [0, 0, 0];
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; N = add(N, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]); }
  if (len(N) < 1e-12) return null;
  N = unit(N);
  const U = unit(cross(N, Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), V = cross(N, U);
  const q = pts.map((p) => [dot(p, U), dot(p, V)]);
  const area2 = (a, b, c) => (q[b][0] - q[a][0]) * (q[c][1] - q[a][1]) - (q[b][1] - q[a][1]) * (q[c][0] - q[a][0]);
  const inside = (p, a, b, c) => area2(a, b, p) >= 0 && area2(b, c, p) >= 0 && area2(c, a, p) >= 0;
  if (n <= 2000) {
    const idx = Array.from({ length: n }, (_, i) => i), tris = [];
    while (idx.length > 3) {
      let cut = false;
      for (let k = 0; k < idx.length; k++) {
        const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
        if (area2(a, b, c) <= 1e-12) continue;
        if (idx.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
        tris.push([a, b, c]);
        idx.splice(k, 1);
        cut = true;
        break;
      }
      if (!cut) break;
    }
    if (idx.length === 3) { tris.push([...idx]); return tris; }
  }
  const out = pts.map((_, i) => [i, (i + 1) % n, n]);
  out.centre = mul(pts.reduce((acc, p) => add(acc, p), [0, 0, 0]), 1 / n);
  return out;
}

// ------------------------------------------------------------ closing surfaces into solids
// Sew faces / shells together, joining edges closer than tol.
function sewShapes(shapes, tol) {
  const oc = R.getOC();
  const sw = new oc.BRepBuilderAPI_Sewing(Math.max(1e-7, tol), true, true, true, false);
  try {
    for (const s of shapes) sw.Add(s.wrapped);
    sw.Perform(new oc.Message_ProgressRange());
    return R.cast(sw.SewedShape());
  } finally { sw.delete(); }
}
// The edges of a (sewn) shape used by only one face: the edges of its holes, chained into loops.
// Each loop: { edges (in order), pts (polyline round it), size (its box diagonal) }; chains that do not
// close (e.g. a dangling edge) come back in `open`.
function holeLoops(shape) {
  const P = (v) => vec(v);
  const key = (p) => p.map((x) => Math.round(x * 1e5)).join(',');
  const items = new Map();
  for (const face of shape.faces) {
    // (every use of an edge: a seam, e.g. down a cylinder's side, is used twice by its one face)
    const T = R.getOC().TopAbs_ShapeEnum, ex = new (R.getOC().TopExp_Explorer)(face.wrapped, T.TopAbs_EDGE, T.TopAbs_SHAPE);
    const uses = [];
    for (; ex.More(); ex.Next()) uses.push(ex.Current());
    ex.delete();
    for (const raw of uses) {
      const e = R.cast(raw);
      const a = P(e.startPoint), b = P(e.endPoint), m = P(e.pointAt(0.5));
      const k = [key(a), key(b)].sort().join('|') + '|' + key(m);
      const it = items.get(k);
      if (it) it.n++; else items.set(k, { e, a, b, n: 1 });
    }
  }
  const free = [...items.values()].filter((it) => it.n === 1);
  const at = new Map();
  free.forEach((it, i) => { for (const p of [it.a, it.b]) { const k = key(p); if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
  const used = new Set(), loops = [], open = [];
  for (let s = 0; s < free.length; s++) {
    if (used.has(s)) continue;
    used.add(s);
    const startK = key(free[s].a);
    const chain = [{ it: free[s], rev: false }];
    let endP = free[s].b, closed = key(endP) === startK;
    while (!closed) {
      const nx = (at.get(key(endP)) || []).find((j) => !used.has(j));
      if (nx == null) break;
      used.add(nx);
      const it = free[nx], rev = key(it.b) === key(endP);
      chain.push({ it, rev });
      endP = rev ? it.a : it.b;
      closed = key(endP) === startK;
    }
    // the points round it (curved edges sampled)
    const pts = [];
    for (const { it, rev } of chain) {
      const m = it.e.geomType === 'LINE' ? 1 : 16;
      const q = Array.from({ length: m + 1 }, (_, i) => P(it.e.pointAt(i / m)));
      if (rev) q.reverse();
      pts.push(...q.slice(pts.length ? 1 : 0));
    }
    if (closed && pts.length > 1) pts.pop();
    const lo = [0, 1, 2].map((j) => Math.min(...pts.map((p) => p[j]))), hi = [0, 1, 2].map((j) => Math.max(...pts.map((p) => p[j])));
    const rec = { edges: chain.map((c) => c.it.e), pts, size: len(sub(hi, lo)), curved: chain.some((c) => c.it.e.geomType !== 'LINE') };
    (closed && pts.length >= 3 ? loops : open).push(rec);
  }
  return { loops, open, freeEdges: free.length };
}
// Triangles closing a polygon (3D points in order): ear clipping in its best-fit plane; a fan from the
// centre when that fails (a hole that is far from flat).
function triangulateLoop(pts) {
  const n = pts.length;
  let N = [0, 0, 0];
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; N = add(N, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]); }
  if (len(N) < 1e-12) return null;
  N = unit(N);
  const U = unit(cross(N, Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), V = cross(N, U);
  const q = pts.map((p) => [dot(p, U), dot(p, V)]);
  const idx = Array.from({ length: n }, (_, i) => i);
  const area2 = (a, b, c) => (q[b][0] - q[a][0]) * (q[c][1] - q[a][1]) - (q[b][1] - q[a][1]) * (q[c][0] - q[a][0]);
  const inside = (p, a, b, c) => area2(a, b, p) >= 0 && area2(b, c, p) >= 0 && area2(c, a, p) >= 0;
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (area2(a, b, c) <= 1e-12) continue;
      if (idx.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      tris.push([pts[a], pts[b], pts[c]]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) { tris.push(idx.map((i) => pts[i])); return tris; }
  // (fallback) a fan from the centre
  const c = mul(pts.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / n);
  return pts.map((p, i) => [p, pts[(i + 1) % n], c]);
}
// Faces closing one hole: the exact flat face when it lies in a plane, a filling surface for a curved
// hole, triangles for a hole in a mesh.
function holePatch(loop, tol) {
  const wire = () => R.assembleWire(loop.edges.map((e) => e.clone()));
  if (loop.curved) {
    try { return [R.makeFace(wire())]; } catch { /* not flat */ }
    try { return [R.makeNonPlanarFace(wire())]; } catch { /* triangles below */ }
  } else {
    // flat (within the gap tolerance): one face
    const n = loop.pts.length;
    if (n > 3) {
      try {
        const f = R.makeFace(wire());
        if (f && f.faces?.length !== 0) return [f];
      } catch { /* not flat */ }
    }
  }
  const tris = triangulateLoop(loop.pts);
  if (!tris) return null;
  return tris.filter((t) => len(cross(sub(t[1], t[0]), sub(t[2], t[0]))) > tol * tol * 1e-3).map((t) => R.makePolygon(t));
}
// A closed sewn shape as one solid (or null when it is not closed or not one shell).
// A point in the middle of a flat face (for a dome's top): its centre of area when that lies on the face,
// else the point of a grid on the face farthest from its outline.
function domeCentre(face, wire, fallback, n) {
  const onFace = (p) => new R.DistanceQuery(R.makeVertex(p)).distanceTo(face) < 1e-6;
  let c = null;
  try { const q = R.measureShapeSurfaceProperties(face); c = q.centerOfMass; q.delete?.(); } catch { c = null; }
  if (c && onFace(c)) return c;
  // a grid over the face, in its own plane
  const u = unit(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(n, u), bb = bbox(face);
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [m & 1 ? bb.max[0] : bb.min[0], m & 2 ? bb.max[1] : bb.min[1], m & 4 ? bb.max[2] : bb.min[2]]);
  const ru = corners.map((q) => dot(sub(q, fallback), u)), rv = corners.map((q) => dot(sub(q, fallback), v));
  const u0 = Math.min(...ru), u1 = Math.max(...ru), v0 = Math.min(...rv), v1 = Math.max(...rv);
  const wq = (p) => new R.DistanceQuery(R.makeVertex(p)).distanceTo(wire);
  let best = fallback, bd = -1;
  for (let i = 1; i < 16; i++) for (let j = 1; j < 16; j++) {
    const p = add(fallback, add(mul(u, u0 + ((u1 - u0) * i) / 16), mul(v, v0 + ((v1 - v0) * j) / 16)));
    if (!onFace(p)) continue;
    const d = wq(p);
    if (d > bd) { bd = d; best = p; }
  }
  return best;
}

function solidFromSewn(sewn) {
  const oc = R.getOC();
  const shells = [...R.iterTopo(sewn.wrapped, 'shell')];
  if (shells.length !== 1) return null;
  const ms = new oc.BRepBuilderAPI_MakeSolid(shells[0]);
  const solid = R.cast(ms.Solid());
  ms.delete();
  if (!oc.BRepLib.OrientClosedSolid(solid.wrapped)) return null;
  const v = R.measureVolume(solid);
  if (!(Math.abs(v) > 0)) return null;
  return v < 0 ? R.cast(solid.wrapped.Reversed()) : solid;
}

// Wavefront OBJ: vertices and faces (polygons fanned into triangles; v, v/vt, v/vt/vn, negative indices).
function parseOBJ(text) {
  const V = [], tris = [];
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim();
    if (ln.startsWith('v ')) { const q = ln.slice(2).trim().split(/\s+/).map(Number); V.push([q[0] || 0, q[1] || 0, q[2] || 0]); }
    else if (ln.startsWith('f ')) {
      const idx = ln.slice(2).trim().split(/\s+/).map((t) => { const i = parseInt(t.split('/')[0], 10); return i < 0 ? V.length + i : i - 1; });
      for (let k = 1; k + 1 < idx.length; k++) { const a = V[idx[0]], b = V[idx[k]], c = V[idx[k + 1]]; if (a && b && c) tris.push([a, b, c]); }
    }
  }
  return tris;
}
// A zip archive's files (stored or deflated) → Map(name → bytes).
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = new Map();
  // the central directory, from the end record
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('The 3MF file is not a valid zip archive');
  let at = dv.getUint32(eocd + 16, true);
  const n = dv.getUint16(eocd + 10, true);
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(at, true) !== 0x02014b50) break;
    const method = dv.getUint16(at + 10, true), csize = dv.getUint32(at + 20, true);
    const nl = dv.getUint16(at + 28, true), xl = dv.getUint16(at + 30, true), cl = dv.getUint16(at + 32, true), lo = dv.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nl));
    at += 46 + nl + xl + cl;
    const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const data = bytes.subarray(ds, ds + csize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
  }
  return out;
}
// 3MF: the meshes of the model's objects, placed by the build items (units to millimetres).
async function parse3MF(bytes) {
  const files = await unzip(bytes);
  const key = [...files.keys()].find((k) => /3dmodel\.model$/i.test(k));
  if (!key) throw new Error('The 3MF file has no 3D model');
  const xml = new TextDecoder().decode(files.get(key));
  const unit = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[(/<model[^>]*\sunit="([a-z]+)"/i.exec(xml) || [])[1] || 'millimeter'] || 1;
  const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };
  const objects = new Map();
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attr(m[1], 'id'), body = m[2];
    const V = [...body.matchAll(/<vertex\b([^>]*)\/?>/g)].map((v) => ['x', 'y', 'z'].map((a) => +attr(v[1], a) * unit));
    const T = [...body.matchAll(/<triangle\b([^>]*)\/?>/g)].map((t) => ['v1', 'v2', 'v3'].map((a) => +attr(t[1], a)));
    const comps = [...body.matchAll(/<component\b([^>]*)\/?>/g)].map((c) => ({ id: attr(c[1], 'objectid'), tf: attr(c[1], 'transform') }));
    objects.set(id, { V, T, comps });
  }
  const mat = (tf) => (tf ? tf.trim().split(/\s+/).map(Number) : null);
  const apply = (M, q) => (M ? [M[0] * q[0] + M[3] * q[1] + M[6] * q[2] + M[9] * unit, M[1] * q[0] + M[4] * q[1] + M[7] * q[2] + M[10] * unit, M[2] * q[0] + M[5] * q[1] + M[8] * q[2] + M[11] * unit] : q);
  const tris = [];
  const emit = (id, M, depth = 0) => {
    const o = objects.get(id);
    if (!o || depth > 8) return;
    for (const t of o.T) { const pts = t.map((i) => o.V[i]); if (pts.every(Boolean)) tris.push(pts.map((q) => apply(M, q))); }
    for (const c of o.comps) emit(c.id, c.tf ? mat(c.tf) : M, depth + 1);
  };
  const items = [...xml.matchAll(/<item\b([^>]*)\/?>/g)].map((m) => ({ id: attr(m[1], 'objectid'), tf: attr(m[1], 'transform') }));
  if (items.length) for (const it of items) emit(it.id, mat(it.tf));
  else for (const id of objects.keys()) emit(id, null);
  return tris;
}

// Mesh export: OBJ text, or a 3MF package (zip, stored).
function meshArrays(shape) {
  const b = bbox(shape), m = shape.mesh({ tolerance: Math.max(0.002, b.diag * 0.0002), angularTolerance: 0.1 });
  return { V: m.vertices, T: m.triangles };
}
function objText(parts) {
  const L = ['# RazorCAD OBJ export (millimetres)'];
  let base = 1;
  for (const { name, V, T } of parts) {
    L.push(`o ${String(name || 'Body').replace(/\s+/g, '_')}`);
    for (let i = 0; i < V.length; i += 3) L.push(`v ${+V[i].toFixed(6)} ${+V[i + 1].toFixed(6)} ${+V[i + 2].toFixed(6)}`);
    for (let i = 0; i < T.length; i += 3) L.push(`f ${T[i] + base} ${T[i + 1] + base} ${T[i + 2] + base}`);
    base += V.length / 3;
  }
  return L.join('\n') + '\n';
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipStore(files) {
  const enc = new TextEncoder(), chunks = [], central = [];
  let off = 0;
  for (const [name, data0] of files) {
    const data = typeof data0 === 'string' ? enc.encode(data0) : data0, nb = enc.encode(name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
    chunks.push(new Uint8Array(h.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nb);
    off += 30 + nb.length + data.length;
  }
  const csize = central.reduce((s2, x) => s2 + x.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  const all = [...chunks, ...central, new Uint8Array(e.buffer)], out = new Uint8Array(all.reduce((s2, x) => s2 + x.length, 0));
  let at = 0;
  for (const x of all) { out.set(x, at); at += x.length; }
  return out;
}
function threeMF(parts) {
  const objs = parts.map((pt, i) => {
    const vs = [], ts = [];
    for (let k = 0; k < pt.V.length; k += 3) vs.push(`<vertex x="${+pt.V[k].toFixed(6)}" y="${+pt.V[k + 1].toFixed(6)}" z="${+pt.V[k + 2].toFixed(6)}"/>`);
    for (let k = 0; k < pt.T.length; k += 3) ts.push(`<triangle v1="${pt.T[k]}" v2="${pt.T[k + 1]}" v3="${pt.T[k + 2]}"/>`);
    return `<object id="${i + 1}" name="${String(pt.name || 'Body').replace(/[<>&"]/g, '_')}" type="model"><mesh><vertices>${vs.join('')}</vertices><triangles>${ts.join('')}</triangles></mesh></object>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">RazorCAD</metadata><resources>${objs.join('')}</resources><build>${parts.map((_, i) => `<item objectid="${i + 1}"/>`).join('')}</build></model>`;
  return zipStore([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'],
    ['3D/3dmodel.model', model],
  ]);
}

// Interference: where solid bodies overlap (volume and a mesh of each overlap).
function interference() {
  const list = lastSolids.filter((r) => r.shape);
  const out = [], shapes = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j], ba = bbox(a.shape), bb = bbox(b.shape);
    if (!boxesTouch(ba, bb, 1e-6)) continue;
    let common = null;
    try { common = a.shape.intersect(b.shape); } catch (e) { if (isFatal(e)) throw e; continue; }
    const v = solidsOf(common).reduce((acc, x) => acc + R.measureVolume(x), 0);
    if (v > Math.max(1e-9, Math.min(volumeOf(a), volumeOf(b)) * 1e-9)) { out.push({ a: a.id, b: b.id, volume: v }); shapes.push(common); }
  }
  const diag = list.length ? bboxOfAll(list.map((r) => r.shape)).diag : 1;
  return { pairs: out, mesh: shapes.length ? meshData(shapes, diag) : null };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The bodies in an imported STEP file: every solid on its own (a solid made of several separate
// closed shells is split into one body per shell), plus loose shells/faces as surface bodies.
function splitImported(shape) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum;
  const solids = [];
  for (const sol of shape.solids) {
    const shells = [...R.iterTopo(sol.wrapped, 'shell')];
    if (shells.length < 2) { solids.push(sol); continue; }
    const parts = shells.map((sh) => {
      const ms = new oc.BRepBuilderAPI_MakeSolid(sh);
      const s = R.cast(ms.Solid());
      ms.delete();
      oc.BRepLib.OrientClosedSolid(s.wrapped);
      return s;
    });
    // a shell inside another one is a cavity: keep that solid whole
    const boxes = parts.map((x) => bbox(x));
    const inside = (a, b) => [0, 1, 2].every((k) => a.min[k] >= b.min[k] - 1e-6 && a.max[k] <= b.max[k] + 1e-6);
    const nested = boxes.some((a, i) => boxes.some((b, j) => i !== j && inside(a, b)));
    if (nested) solids.push(sol); else solids.push(...parts);
  }
  const free = (kind, avoid) => {
    const out = [];
    const ex = new oc.TopExp_Explorer(shape.wrapped, T[kind], T[avoid]);
    while (ex.More()) { out.push(R.cast(ex.Current())); ex.Next(); }
    ex.delete();
    return out;
  };
  const surfaces = free('TopAbs_SHELL', 'TopAbs_SOLID');
  const faces = free('TopAbs_FACE', 'TopAbs_SHELL');
  if (faces.length) surfaces.push(asShape(faces));
  return { solids, surfaces };
}

// The box round a shape's vertices: [x0, y0, z0, x1, y1, z1], or null when it has none (as stepasm.js
// measures a STEP solid or face, so the two can be matched).
function vertexBox(shape) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const ex = new oc.TopExp_Explorer(shape, T.TopAbs_VERTEX, T.TopAbs_SHAPE);
  try {
    for (; ex.More(); ex.Next()) {
      const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(ex.Current()));
      const q = [p.X(), p.Y(), p.Z()];
      p.delete();
      for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
    }
  } finally { ex.delete(); }
  return isFinite(lo[0]) ? [...lo, ...hi] : null;
}
const boxNear = (a, b, tol) => !!a && !!b && a.every((v, k) => Math.abs(v - b[k]) <= tol);
const boxWithin = (a, b, tol) => !!a && !!b && [0, 1, 2].every((k) => a[k] >= b[k] - tol && a[k + 3] <= b[k + 3] + tol);
const lookTol = (box) => Math.max(1e-4, (box ? Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) : 0) * 1e-6);

// The look of each imported body (f.appearance from stepasm.js): { c, t, faces } or null, by shape.
// Solids are found by their vertex box (those without vertices, e.g. spheres, in file order); face looks go
// with the bodies they lie in, and meshPart finds each face by its own vertex box.
function importedLooks(app, shapes) {
  if (!app.solids) return shapes.map(() => (app.c != null || app.t ? { c: app.c ?? null, t: app.t || 0 } : null));
  const boxes = shapes.map((s) => vertexBox(s.wrapped));
  const out = shapes.map(() => null);
  const used = new Set();
  app.solids.forEach((e, ei) => {
    if (!e.b) return;
    const tol = lookTol(e.b);
    const i = boxes.findIndex((b, k) => !out[k] && boxNear(b, e.b, tol));
    if (i >= 0) { out[i] = { c: e.c ?? null, t: e.t || 0 }; used.add(ei); }
  });
  const restE = app.solids.filter((e, ei) => !used.has(ei)), restS = out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
  if (restE.length && restE.length === restS.length) restS.forEach((i, k) => { out[i] = { c: restE[k].c ?? null, t: restE[k].t || 0 }; });
  for (const e of app.faces || []) {
    if (!e.b) continue;
    const tol = lookTol(e.b);
    boxes.forEach((b, i) => { if (boxWithin(e.b, b, tol)) { out[i] ||= { c: null, t: 0 }; (out[i].faces ||= []).push(e); } });
  }
  return out;
}

async function importShape(f) {
  const key = `${f.format}:${f.data.length}:${f.data.slice(0, 64)}:${f.data.slice(-64)}:${f.maxTris ?? ''}`;
  const hit = importCache.get(f.id);
  if (hit && hit.key === key) return hit.rec;
  let shape, dense = false;
  progress(null, `Reading ${f.fileName || 'the imported file'}…`);
  if (f.format === 'step') shape = await R.importSTEP(new Blob([f.data]));
  else {
    var open = 0, reduced = null;
    const lim = f.maxTris == null || f.maxTris === '' ? MESH_MAX_TRIS : +f.maxTris;
    if (f.format === 'obj') ({ shape, open, reduced } = trisToShape(parseOBJ(new TextDecoder().decode(b64ToBytes(f.data))), 'OBJ', lim));
    else if (f.format === '3mf') ({ shape, open, reduced } = trisToShape(await parse3MF(b64ToBytes(f.data)), '3MF', lim));
    else ({ shape, open, reduced } = stlToShape(b64ToBytes(f.data), lim));
    dense = faceCount(shape) > 2500;
  }
  const rec = { shape, dense, open: open || 0, reduced: reduced || null };
  importCache.set(f.id, { key, rec });
  return rec;
}

// ------------------------------------------------------------ rebuild
// previewId: the feature open in the Property panel. The model is rolled back to just
// before it and its effect is returned separately as preview meshes.
// opts.partial: only replay the features and return { solids, surfaces } (used by Shell to get
// the body without its small fillets); no meshing, no change to the exported state.
async function rebuild(doc, previewId = null, opts = {}) {
  const t0 = performance.now();
  // the active configuration: its variable values and the features it suppresses (or un-suppresses)
  const cfg = doc.activeConfig ? (doc.configs || []).find((c) => c.id === doc.activeConfig) : null;
  if (cfg) {
    const vals = cfg.vals || {}, sup = new Set(cfg.suppressed || []), unsup = new Set(cfg.unsuppressed || []);
    doc = {
      ...doc,
      equations: (doc.equations || []).map((e) => (e.name in vals && String(vals[e.name]).trim() !== '' ? { ...e, expr: String(vals[e.name]) } : e)),
      features: doc.features.map((f) => (sup.has(f.id) && !f.suppressed ? { ...f, suppressed: true } : unsup.has(f.id) && f.suppressed ? { ...f, suppressed: false } : f)),
    };
  }
  const { vars, errors: eqErrors } = evalEquations(doc.equations || []);
  const ev = (x) => evaluate(x, vars);
  const res = { errors: [], sketches: {}, planes: {}, axes: {}, points: {}, curves: {}, notes: {}, detected: {}, features: {}, eqErrors: [...eqErrors], preview: null };
  const curves = new Map(); // curve features (helices): id -> { wire, axis, r, pitch, height }
  const planes = new Map();
  const sketches = new Map();
  const axes = new Map();
  const points = new Map();
  const tools = new Map();
  let applied = []; // tools applied by the current feature (for previews)
  let blendPair = null; // a fillet/chamfer on one body: that body before and after (for its preview)
  let body = null;    // all bodies together (one solid, or a compound of several)
  let solids = [];    // the bodies: [{ id, shape, box, last, feats }], `last` = feature that last changed it, `feats` = all that did
  let surfaces = [];  // surface bodies, same records (they don't take part in solid booleans)
  let cur = null;     // feature being rebuilt
  const usedIds = new Set();
  const newId = (base) => { let id = base, k = 2; while (usedIds.has(id)) id = `${base}.${k++}`; usedIds.add(id); return id; };
  // `from`: the records this body comes from (default: the body with this id, or the one it was split off)
  const bodyRec = (id, shape, last, from = null) => {
    usedIds.add(id);
    const base = String(id).split('~')[0], find = (x) => solids.find((b) => b.id === x) || surfaces.find((b) => b.id === x);
    const feats = new Set();
    const prev = from || [find(id) || find(base)];
    for (const r of prev) for (const k of r?.feats || []) feats.add(k);
    feats.add(last);
    // sheet metal: the flat pattern goes along; when another kind of feature changes the body, the
    // pattern no longer matches it (it is kept, marked with that feature)
    let sheet = prev[0]?.sheet || null;
    if (sheet && last === cur?.id && !SHEET_TYPES.has(cur.type) && !sheet.stale) sheet = { ...sheet, stale: cur.name };
    const member = prev[0]?.member || null;
    // (the appearance an imported body came with: { c, t, faces } — kept through later features)
    const look = prev[0]?.look || null;
    return { id, shape, box: bbox(shape), last, feats: [...feats], sheet, ...(member ? { member } : {}), ...(look ? { look } : {}) };
  };
  let dense = false; // body contains a triangulated (STL) import with thousands of faces
  const needEdges = (what) => { if (dense) throw new Error(`${what} is not available on bodies made from dense STL meshes`); };

  const resolveFrame = (ref, plane) => {
    if (STD[ref]) return STD[ref];
    if (ref === 'face') return plane.frame;
    const fr = planes.get(ref);
    if (!fr) throw new Error('The reference plane is missing or failed');
    return fr;
  };
  // Add or cut a tool. Added material fuses with the bodies it touches (merge) or becomes
  // new bodies; a cut acts on every body it reaches and may split one into several.
  // scope: for a cut, the ids of the only bodies it may cut (null: every body it reaches)
  const inScope = (s, scope) => !scope || scope.some((b) => s.id === b || s.id.startsWith(b + '~'));
  const apply = (op, tool, merge = true, scope = null) => {
    applied.push({ op, tool });
    const fid = cur.id;
    if (op === 'add') {
      for (const t of solidsOf(tool)) {
        let merged = t, mbox = bbox(t);
        const tol = Math.max(1e-6, mbox.diag * 1e-7);
        const touched = [];
        if (merge) {
          for (const s of solids) {
            if (s.sheet || !boxesTouch(s.box, mbox, tol)) continue;
            const r = merged.fuse(s.shape);
            if (solidsOf(r).length === 1) { merged = r; mbox = bbox(r); touched.push(s); }
          }
        }
        if (touched.length) {
          const at = solids.indexOf(touched[0]);
          const next = solids.filter((s) => !touched.includes(s));
          next.splice(Math.min(at, next.length), 0, bodyRec(touched[0].id, merged, fid, touched));
          solids = next;
        } else solids.push(bodyRec(newId(fid), t, fid));
      }
    } else {
      if (!solids.length) throw new Error('There is no body to cut');
      const tb = bbox(tool), tol = Math.max(1e-6, tb.diag * 1e-7);
      const next = [];
      for (const s of solids) {
        if (!inScope(s, scope) || !boxesTouch(s.box, tb, tol)) { next.push(s); continue; }
        if (s.sheet && !s.sheet.stale) {
          // sheet metal: the cut becomes a hole in the flat pattern, and the part is folded again
          try {
            const r = SM.cutSheet(s.sheet, tool);
            if (!r.hit) { next.push(s); continue; }
            const rec = bodyRec(s.id, SM.toSolid(r.sheet), fid);
            rec.sheet = r.sheet;
            next.push(rec);
            continue;
          } catch (e) {
            if (isFatal(e)) throw e;
            // fall back to an ordinary cut; the flat pattern no longer matches (see below)
          }
        }
        const pieces = solidsOf(s.shape.cut(tool)).map((shape) => ({ shape, vol: null }));
        if (pieces.length > 1) pieces.sort((x, y) => volumeOf(y) - volumeOf(x));
        pieces.forEach((pc, k) => {
          let last = fid;
          if (pieces.length === 1) {
            const v0 = volumeOf(s), v1 = volumeOf(pc);
            if (Math.abs(v1 - v0) <= Math.abs(v0) * 1e-9) last = s.last; // the cut missed this body
          }
          next.push(bodyRec(k ? newId(`${s.id}~${k + 1}`) : s.id, pc.shape, last));
        });
      }
      solids = next;
    }
    body = compoundOf(solids);
  };
  // After an operation on all bodies together (fillet, chamfer), find each body again.
  const remapSolids = (shape, changedPts) => {
    const parts = solidsOf(shape);
    const near = (box, p) => boxesTouch(box, { min: p, max: p }, box.diag * 1e-3 + 1e-6);
    if (parts.length === solids.length) {
      const pool = parts.map((shape) => ({ shape, box: bbox(shape) }));
      solids = solids.map((s) => {
        let bi = 0, bd = Infinity;
        pool.forEach((q, i) => { if (!q) return; const d = len(sub(q.box.center, s.box.center)) + Math.abs(q.box.diag - s.box.diag); if (d < bd) { bd = d; bi = i; } });
        const q = pool[bi]; pool[bi] = null;
        return bodyRec(s.id, q.shape, changedPts.some((p) => near(s.box, p)) ? cur.id : s.last);
      });
    } else solids = parts.map((shape, i) => bodyRec(solids[i]?.id ?? newId(cur.id), shape, cur.id));
    body = compoundOf(solids);
  };
  // thin: { t, dir } makes walls along the sketch curves instead of filling closed profiles
  // drawing: the 2D profile (closed regions, with any text) to extrude / revolve / project
  const getSketch = (id, thin = null) => {
    if (!id) throw new Error('Select a sketch');
    const s = sketches.get(id);
    if (!s) throw new Error('The sketch is missing, suppressed or has errors');
    if (thin) { const regions = S.thinRegions(s.sk, thin.t, thin.dir); return { ...s, regions, drawing: regionsDrawing(regions) }; }
    const regions = S.profileRegions(s.sk);
    const text = textDrawing(s.sk);
    const gears = [...gearDrawings(s.sk), ...airfoilDrawings(s.sk)]; // (generated outlines, each made on its own)
    if (!regions.length && !text && !gears.length) throw new Error(s.sk.curves.some((c) => !c.construction) ? 'The sketch has no closed profile — tick Thin Feature to use open curves' : 'The sketch has no closed profile');
    return { ...s, regions, drawing: regions.length ? regionsDrawing(regions) : null, text, gears };
  };
  // The solid a feature makes from a sketch profile: make(drawing) for the outlines and for the text,
  // combined so text inside an outline is cut out of it (and text outside it is added).
  const profileSolid = (sk, make) => {
    const a = sk.drawing ? make(sk.drawing) : null;
    let t = sk.text ? make(sk.text) : null;
    // gears: each made on its own (one 2D boolean over hundreds of tooth edges would be slow), bores cut in 3D
    if (sk.gears?.length) {
      const gs = sk.gears.map((g) => { let sol = make(g.outline); if (g.bore) sol = sol.cut(make(g.bore)); return sol; });
      const all = asShape(gs);
      t = t ? t.fuse(all) : all;
    }
    if (!a || !t) return a || t;
    let out = a.cut(t);
    try { const outside = t.cut(a); if (solidsOf(outside).length) out = out.fuse(outside); } catch (e) { if (isFatal(e)) throw e; }
    return out;
  };

  // world-space point from a reference: reference point feature or model vertex ref
  const resolvePoint = (featureId, vertexRef) => {
    if (featureId) {
      const p = points.get(featureId);
      if (!p) throw new Error('The reference point is missing or failed');
      return p;
    }
    if (!vertexRef) throw new Error('Select a vertex or reference point');
    needEdges('Picking a model vertex');
    const v = findVertex(body, vertexRef);
    if (!v) throw new Error('The selected vertex could not be found in the model');
    vertexRef.p = v;
    const b = bbox(body);
    vertexRef.box = { min: b.min, max: b.max };
    return v;
  };
  // plane { p, n } from a plane reference or a planar model face ref
  const resolveSurface = (planeId, faceRef) => {
    if (planeId) { const fr = resolveFrame(planeId); return { p: fr.o, n: fr.n }; }
    if (!faceRef) throw new Error('Select a surface (plane or flat model face)');
    needEdges('Picking a model face');

    const hit = findFace(body, faceRef);
    if (!hit) throw new Error('The selected face could not be found in the model');
    return hit;
  };
  // geometry of a plane reference: { kind: 'plane', p, n, frame? } | { kind: 'line', d, start, end, mid } | { kind: 'point', p }
  const resolveRefGeom = (r) => {
    if (r.kind === 'plane') { const fr = resolveFrame(r.id); return { kind: 'plane', p: fr.o, n: fr.n, frame: fr }; }
    if (r.kind === 'face') return { kind: 'plane', ...resolveSurface(null, r) };
    if (r.kind === 'axis') {
      const a = axes.get(r.id);
      if (!a) throw new Error('The reference axis is missing or failed');
      return { kind: 'line', d: a.d, start: a.o, end: add(a.o, a.d), mid: a.o };
    }
    if (r.kind === 'edge') {
      needEdges('Picking a model edge');
      const e = findEdge(body, r);
      if (!e) throw new Error('A selected edge could not be found in the model');
      updateEdgeRef(r, e, body);
      const g = edgeGeom(e, bbox(body).diag);
      if (g?.type === 'line') return { kind: 'line', d: unit(sub(g.b, g.a)), start: g.a, end: g.b, mid: mul(add(g.a, g.b), 0.5) };
      if (g?.type === 'circle' || g?.type === 'arc') return { kind: 'line', d: g.normal, start: g.c, end: add(g.c, g.normal), mid: g.c };
      throw new Error('Select a straight or circular edge');
    }
    if (r.kind === 'point') return { kind: 'point', p: resolvePoint(r.id) };
    if (r.kind === 'vertex') return { kind: 'point', p: resolvePoint(null, r) };
    throw new Error('Unknown reference');
  };
  // axis { o, d } from X/Y/Z or a reference axis feature
  const resolveAxis = (key) => {
    if (AXES[key]) return { o: [0, 0, 0], d: AXES[key] };
    const a = axes.get(key);
    if (!a) throw new Error('The reference axis is missing or failed');
    return a;
  };

  // axis of a revolve: an axis feature, a straight model edge or cylindrical face picked on the
  // model ('edge' / 'face'), or a line of the sketch ('v' / 'u' = the sketch axes)
  const revolveAxisOf = (f, sk) => {
    if (axes.has(f.axis)) return axes.get(f.axis);
    if (f.axis === 'edge') {
      if (!f.axisEdge) throw new Error('Click a straight edge on the model for the axis');
      needEdges('Picking a model edge');
      const e = findEdge(body, f.axisEdge);
      if (!e) throw new Error('The axis edge could not be found in the model');
      updateEdgeRef(f.axisEdge, e, body);
      res.features[f.id] = { ...(res.features[f.id] || {}), axisEdge: f.axisEdge };
      const g = edgeGeom(e, bbox(body).diag);
      if (g?.type === 'line') return { o: g.a, d: unit(sub(g.b, g.a)) };
      if (g?.type === 'circle' || g?.type === 'arc') return { o: g.c, d: g.normal };
      throw new Error('Select a straight or circular edge for the axis');
    }
    if (f.axis === 'face') {
      if (!f.axisFace) throw new Error('Click a cylindrical face on the model for the axis');
      const hit = findFaceAny([...solids, ...surfaces], f.axisFace);
      const ax = hit && faceAxis(hit.face);
      if (!ax) throw new Error('The axis face could not be found (use a cylindrical or conical face)');
      return ax;
    }
    const fr = sk.frame, ax = S.revolveAxis(f, sk.sk);
    return { o: S.fromFrame2D(fr, ax.a[0], ax.a[1]), d: add(mul(fr.u, ax.d[0]), mul(fr.v, ax.d[1])) };
  };

  // consecutive fillets (or chamfers) applied since the last other solid feature
  let blendChain = null;
  // every solid-changing feature so far, so blends can be recomputed in a different order
  const steps = [];
  let blendStep = null;

  // replace a solid body by the pieces of `shape` (largest keeps the id)
  const replaceSolid = (rec, shape, fid) => {
    const pieces = solidsOf(shape).map((sh) => ({ shape: sh, vol: null }));
    if (pieces.length > 1) pieces.sort((x, y) => volumeOf(y) - volumeOf(x));
    const at = solids.indexOf(rec);
    const recs = pieces.map((pc, k) => bodyRec(k ? newId(`${rec.id}~${k + 1}`) : rec.id, pc.shape, fid));
    solids = [...solids.slice(0, at), ...recs, ...solids.slice(at + 1)];
    body = compoundOf(solids);
    return recs;
  };
  const anyBody = (id) => solids.find((b) => b.id === id) || surfaces.find((b) => b.id === id) || null;
  // ---- sheet metal
  const sheetRecs = () => solids.filter((r) => r.sheet);
  const sheetOf = (bodyId) => {
    const recs = sheetRecs();
    if (!recs.length) throw new Error('There is no sheet metal body — start with a Base Flange or Convert to Sheet Metal');
    if (bodyId) {
      const r = recs.find((x) => x.id === bodyId);
      if (!r) throw new Error('The selected sheet metal body no longer exists');
      return r;
    }
    if (recs.length === 1) return recs[0];
    throw new Error('Select the sheet metal body');
  };
  const sheetChecked = (rec) => {
    if (rec.sheet.stale) throw new Error(`${rec.sheet.stale} changed this sheet metal body in a way its flat pattern can't follow, so sheet metal features can't be added after it`);
    return rec.sheet;
  };
  // replace a sheet metal body by the one folded from a new pattern
  const setSheet = (rec, sheet) => {
    const shape = SM.toSolid(sheet);
    const before = rec.shape;
    const recs = replaceSolid(rec, shape, cur.id);
    for (const r of recs) r.sheet = sheet;
    applied.push({ op: 'add', tool: shape, view: () => shape.cut(before) });
    return recs[0];
  };
  // straight model edges picked on one sheet metal body: { rec, edges: [{ a, b }] }
  const sheetEdges = (refs) => {
    let rec = null;
    const edges = [];
    const recs = sheetRecs();
    const all = compoundOf(recs);
    for (const ref of refs) {
      const hit = all && findEdgeInfo(all, ref);
      const owner = hit && (recs.length === 1 ? recs[0] : recs.find((s) => s.shape === hit.part));
      if (!hit || !owner) throw new Error('A selected edge is not on a sheet metal body');
      if (rec && owner !== rec) throw new Error('All the edges must be on the same sheet metal body');
      rec = owner;
      updateEdgeRef(ref, hit.e, all);
      const g = edgeGeom(hit.e, bbox(owner.shape).diag);
      if (g?.type !== 'line') throw new Error('Edge flanges need straight edges');
      edges.push({ a: g.a, b: g.b });
    }
    return { rec, edges };
  };
  // the profile of a sketch as flat faces in the sketch's own coordinates (z = 0)
  const sketchRegion = (sk) => {
    const prism = profileSolid(sk, (dr) => dr.sketchOnPlane('XY').extrude(1));
    const bottom = prism.faces.filter((fc) => fc.geomType === 'PLANE' && Math.abs(vec(fc.center)[2]) < 1e-7);
    if (!bottom.length) throw new Error('The sketch has no closed profile');
    return SM.upFaces(asShape(bottom));
  };
  const needBody = (id, what = 'body') => { const b = anyBody(id); if (!b) throw new Error(`A selected ${what} no longer exists`); return b; };
  // geometry + owning body of a mate entity
  const mateEntity = (ref) => {
    if (!ref) throw new Error('Pick both entities of every mate');
    if (ref.kind === 'plane') { const fr = resolveFrame(ref.id); return { geo: { kind: 'plane', p: fr.o, n: fr.n }, body: null }; }
    if (ref.kind === 'axis') { const a = axes.get(ref.id); if (!a) throw new Error('A reference axis is missing'); return { geo: { kind: 'line', p: a.o, d: a.d }, body: null }; }
    if (ref.kind === 'point') { const q = points.get(ref.id); if (!q) throw new Error('A reference point is missing'); return { geo: { kind: 'point', p: q }, body: null }; }
    const all = [...solids, ...surfaces];
    if (ref.kind === 'vertex') return { geo: { kind: 'point', p: ref.p }, body: bodyAt(all, ref.p) };
    if (ref.kind === 'edge') {
      const q = new R.DistanceQuery(R.makeVertex(ref.p));
      let best = null, bd = Infinity;
      for (const b of all) { if (b.dense) continue; for (const e of b.shape.edges) { const d = q.distanceTo(e); if (d < bd) { bd = d; best = { b, e }; } } }
      if (!best || bd > Math.max(1e-3, bbox(best.b.shape).diag * 2e-3)) throw new Error('A mate edge could not be found in the model');
      const g = edgeGeom(best.e, bbox(best.b.shape).diag);
      if (g?.type === 'line') return { geo: { kind: 'line', p: g.a, d: unit(sub(g.b, g.a)) }, body: best.b };
      if (g?.type === 'circle' || g?.type === 'arc') return { geo: { kind: 'line', p: g.c, d: unit(g.normal) }, body: best.b };
      throw new Error('Use straight or circular edges for mates');
    }
    const hit = findFaceAny(all, ref);
    if (!hit) throw new Error('A mate face could not be found in the model');
    const t = hit.face.geomType;
    if (t === 'PLANE') {
      const n = ref.n ? unit(ref.n) : unit(vec(hit.face.normalAt()));
      return { geo: { kind: 'plane', p: ref.p, n }, body: hit.body };
    }
    const oc = R.getOC();
    const ad = new oc.BRepAdaptor_Surface(hit.face.wrapped, false);
    try {
      if (t === 'CYLINDRE' || t === 'CONE') {
        const ax = (t === 'CYLINDRE' ? ad.Cylinder() : ad.Cone()).Axis(), L = ax.Location(), D = ax.Direction();
        return { geo: { kind: 'line', p: [L.X(), L.Y(), L.Z()], d: unit([D.X(), D.Y(), D.Z()]) }, body: hit.body };
      }
      if (t === 'SPHERE') { const L = ad.Sphere().Location(); return { geo: { kind: 'point', p: [L.X(), L.Y(), L.Z()] }, body: hit.body }; }
    } finally { ad.delete(); }
    throw new Error('Use flat, cylindrical, conical or spherical faces for mates');
  };

  const timing = { features: [] }; // where the time went (for tuning)
  const featureDiffs = new Map();
  const sketchBodies = new Map(); // sketch id -> { body before it, its frame }
  const nFeat = doc.features.length || 1;

  // Incremental rebuild: the state after every feature is kept. The next rebuild starts after
  // the last feature that is unchanged since then (same feature data, same equations), so a
  // preview or an edit only recomputes the feature being changed and what comes after it.
  const copyMap = (to, from) => { to.clear(); for (const [a, b] of from) to.set(a, b); };
  const takeSnap = () => ({
    body, solids: [...solids], surfaces: [...surfaces], dense, blendChain, steps: [...steps],
    planes: new Map(planes), sketches: new Map(sketches), axes: new Map(axes), points: new Map(points), tools: new Map(tools), curves: new Map(curves),
    usedIds: new Set(usedIds), featureDiffs: new Map(featureDiffs), sketchBodies: new Map(sketchBodies),
    res: { errors: [...res.errors], sketches: { ...res.sketches }, planes: { ...res.planes }, axes: { ...res.axes }, points: { ...res.points }, curves: { ...res.curves }, notes: { ...res.notes }, detected: { ...res.detected }, features: { ...res.features } },
    timing: [...timing.features],
  });
  const restoreSnap = (s) => {
    ({ body, dense, blendChain } = s);
    solids = [...s.solids]; surfaces = [...s.surfaces];
    steps.length = 0; steps.push(...s.steps);
    copyMap(planes, s.planes); copyMap(sketches, s.sketches); copyMap(axes, s.axes); copyMap(points, s.points); copyMap(tools, s.tools); copyMap(curves, s.curves);
    copyMap(featureDiffs, s.featureDiffs); copyMap(sketchBodies, s.sketchBodies);
    usedIds.clear(); for (const id of s.usedIds) usedIds.add(id);
    res.errors = [...s.res.errors];
    for (const key of ['sketches', 'planes', 'axes', 'points', 'curves', 'notes', 'detected', 'features']) res[key] = { ...s.res[key] };
    timing.features = [...s.timing];
  };
  // ---- patterns: instance transforms { pt, dir, shape } and running them
  const xMove = (t) => ({ pt: (p) => add(p, t), dir: (n) => n, shape: (sh) => sh.translate(t) });
  const rotV = (p, deg, o, d) => {
    const a = (deg * Math.PI) / 180, k = unit(d), v = sub(p, o), c = Math.cos(a), sn = Math.sin(a);
    return add(o, add(add(mul(v, c), mul(cross(k, v), sn)), mul(k, dot(k, v) * (1 - c))));
  };
  const xTurn = (deg, o, d) => ({ pt: (p) => rotV(p, deg, o, d), dir: (n) => rotV(n, deg, [0, 0, 0], d), shape: (sh) => sh.rotate(deg, o, d) });
  const xMirror = (o, n0) => { const n = unit(n0); return { pt: (p) => sub(p, mul(n, 2 * dot(sub(p, o), n))), dir: (d) => sub(d, mul(n, 2 * dot(d, n))), shape: (sh) => sh.mirror(n, o) }; };
  // a transform as a 3×4 matrix (columns: where the axes go; last: where the origin goes)
  const xMatrix = (X) => {
    const o = X.pt([0, 0, 0]), [a, b, c] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((d) => X.dir(d));
    return [a[0], b[0], c[0], o[0], a[1], b[1], c[1], o[1], a[2], b[2], c[2], o[2]];
  };
  const xChain = (A, B) => ({ pt: (p) => B.pt(A.pt(p)), dir: (n) => B.dir(A.dir(n)), shape: (sh) => B.shape(A.shape(sh)) });
  // a copy of a feature with its picked points (edges, faces, vertices) moved
  const moveRefs = (o, X) => {
    if (Array.isArray(o)) { o.forEach((x) => moveRefs(x, X)); return; }
    if (!o || typeof o !== 'object') return;
    const v3 = (x) => Array.isArray(x) && x.length === 3 && x.every((q) => typeof q === 'number');
    if (v3(o.p)) {
      o.p = X.pt(o.p);
      if (v3(o.n)) o.n = X.dir(o.n);
      if (v3(o.d)) o.d = X.dir(o.d);
      if (v3(o.c)) o.c = X.pt(o.c);
      delete o.box;
    }
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') moveRefs(o[k], X);
  };
  // where a feature is: its tool's centre, or the middle of the points it was picked at
  const sourceCentre = (id) => {
    const t = tools.get(id);
    if (t) { const b = bbox(t.shape); return mul(add(b.min, b.max), 0.5); }
    const src = doc.features.find((x) => x.id === id), ps = [];
    const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (Array.isArray(o.p) && o.p.length === 3) ps.push(o.p); Object.values(o).forEach(walk); } };
    walk(src);
    if (!ps.length) throw new Error('That feature has no position to pattern from');
    return mul(ps.reduce((acc, q) => add(acc, q), [0, 0, 0]), 1 / ps.length);
  };
  // The segments of a weldment path: lines { type: 'line', a, b } and arcs { type: 'arc', a, b, t0, t1, wire,
  // length } (3D), from a sketch's curves (construction left out) or a 3D sketch's edges.
  const memberPath = (id) => {
    const out = [];
    const addEdge = (e) => {
      const a = vec(e.startPoint), b = vec(e.endPoint);
      if (e.geomType === 'LINE') { if (len(sub(b, a)) > 1e-9) out.push({ type: 'line', a, b }); }
      else out.push({ type: 'arc', a, b, t0: unit(vec(e.tangentAt(0))), t1: unit(vec(e.tangentAt(1))), wire: R.assembleWire([e.clone()]), length: R.measureLength(e) });
    };
    if (curves.has(id)) { const c = curves.get(id); for (const w of c.wires || [c.wire]) for (const e of w.edges) addEdge(e); return out; }
    const sk = sketches.get(id);
    if (!sk) return out;
    for (const w of sketchWires(sk.sk, sk.frame)) for (const e of w.edges) addEdge(e);
    return out;
  };
  // a path as a 3D polyline (sketch chains, 3D sketches, helices)
  const pathPolyline = (id) => {
    if (!id) return null;
    const c = curves.get(id);
    if (c?.wire) {
      const out = [];
      for (const e of c.wire.edges) for (let i = 0; i <= 24; i++) { const q = vec(e.pointAt(i / 24)); if (!out.length || len(sub(q, out[out.length - 1])) > 1e-9) out.push(q); }
      return out.length > 1 ? out : null;
    }
    const s2 = sketches.get(id);
    if (!s2) return null;
    const ch = S.curveChains(s2.sk).filter((x) => !x.items.every((it) => it.c.construction))[0];
    if (!ch) return null;
    const out = [];
    for (const g of S.chainSegs(s2.sk, ch)) {
      let pts;
      if (g.type === 'line') pts = [g.a, g.b];
      else if (g.type === 'bezier') pts = Array.from({ length: 17 }, (_, i) => S.bezierAt(g, i / 16));
      else if (g.type === 'circle') pts = Array.from({ length: 97 }, (_, i) => [g.c[0] + g.r * Math.cos((i / 96) * 2 * Math.PI), g.c[1] + g.r * Math.sin((i / 96) * 2 * Math.PI)]);
      else {
        const C = S.circleThrough(g.a, g.b, g.m);
        if (!C) pts = [g.a, g.b];
        else {
          const a0 = Math.atan2(g.a[1] - C.cy, g.a[0] - C.cx), am = Math.atan2(g.m[1] - C.cy, g.m[0] - C.cx), a1 = Math.atan2(g.b[1] - C.cy, g.b[0] - C.cx);
          const nm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          let sp = nm(a1 - a0);
          if (nm(am - a0) > sp) sp -= 2 * Math.PI;
          pts = Array.from({ length: 33 }, (_, i) => [C.cx + C.r * Math.cos(a0 + (sp * i) / 32), C.cy + C.r * Math.sin(a0 + (sp * i) / 32)]);
        }
      }
      for (const q of pts) { const Q = S.fromFrame2D(s2.frame, q[0], q[1]); if (!out.length || len(sub(Q, out[out.length - 1])) > 1e-9) out.push(Q); }
    }
    return out.length > 1 ? out : null;
  };
  // arc-length lookups on a polyline
  const polyAt = (P) => {
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + len(sub(P[i], P[i - 1])));
    const total = cum[cum.length - 1];
    const seg = (s) => { let i = 1; while (i < P.length - 1 && cum[i] < s) i++; return i; };
    return {
      length: total,
      point: (s) => { const i = seg(s), t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1); return add(P[i - 1], mul(sub(P[i], P[i - 1]), t)); },
      tangent: (s) => { const i = seg(s); return unit(sub(P[i], P[i - 1])); },
      nearest: (q) => {
        let best = 0, bd = Infinity;
        for (let i = 1; i < P.length; i++) {
          const d = sub(P[i], P[i - 1]), L2 = dot(d, d) || 1, t = Math.max(0, Math.min(1, dot(sub(q, P[i - 1]), d) / L2));
          const x = add(P[i - 1], mul(d, t)), dd = len(sub(q, x));
          if (dd < bd) { bd = dd; best = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
        }
        return best;
      },
    };
  };
  const useCache = !opts.partial;
  const eqKey = JSON.stringify(doc.equations || []);
  const fjson = useCache ? doc.features.map((x) => JSON.stringify(x)) : null;
  const prev = useCache && rebuildCache?.eqKey === eqKey ? rebuildCache.entries : [];
  let start = 0;
  if (useCache) {
    while (start < prev.length && start < fjson.length && prev[start].json === fjson[start] && doc.features[start].id !== previewId
      && !(doc.rollbackAt && doc.features[start].id === doc.rollbackAt)) start++;
  }
  if (start > 0) restoreSnap(prev[start - 1].snap);
  const entries = useCache ? prev.slice(0, start) : null;
  timing.reused = start;
  for (let fi = start; fi < doc.features.length; fi++) {
    const f = doc.features[fi];
    if (doc.rollbackAt && f.id === doc.rollbackAt) break; // the rollback bar: nothing below it is built
    if (!opts.partial) progressFeature = f.id;
    progress((0.8 * fi) / nFeat, `Rebuilding ${f.name}…`);
    if (f.suppressed) { if (entries) entries[fi] = { json: fjson[fi], snap: takeSnap() }; continue; }
    const bodyIn = body, solidsIn = solids, surfacesIn = surfaces;
    const tf = performance.now();
    cur = f;
    applied = [];
    blendStep = null;
    blendPair = null;
    try {
      // (a function, so that patterns can run a copy of another feature)
      const runFeature = async (f) => {
      // copies of feature `srcId`, one per transform: its tool shape moved (features that add or cut a
      // shape), or the feature itself run again with its picked edges / faces moved (fillets, chamfers,
      // drafts, domes, forms…)
      const instances = async (pf, srcId, xs) => {
        const src = doc.features.find((x) => x.id === srcId);
        if (!src) throw new Error('Select the feature to pattern');
        if (src.suppressed) throw new Error('The feature to pattern is suppressed');
        const t = tools.get(srcId);
        // a feature that makes sheet metal bodies from a sketch has no tool to move (and running it again
        // would only make its body again in the same place): its bodies are copied as they are here (with
        // the flanges, cuts… done to them since), each with its flat pattern carried along
        const made = !t && SHEET_NEW.has(src.type) ? [...solids, ...surfaces].filter((r) => r.feats[0] === srcId) : null;
        if (made && !made.length) throw new Error('The bodies that feature made are no longer there');
        let flatLost = 0;
        // copies of a cut: all cut out in one boolean (much faster than one after another, as the body
        // gets more faces with every cut); sheet metal bodies keep the one-by-one way (their flat patterns)
        if (t && t.op === 'cut' && xs.length > 1 && !solids.some((s) => s.sheet && inScope(s, t.scope))) {
          const n0 = applied.length, before = solids;
          try {
            const copies = xs.map((X) => ({ shape: X.shape(t.shape.clone()) }));
            const comp = compoundOf(copies);
            apply('cut', comp, t.merge, t.scope);
            applied.splice(n0, applied.length - n0, ...copies.map((c) => ({ op: 'cut', tool: c.shape })));
            return;
          } catch (e) {
            if (isFatal(e)) throw e;
            applied.length = n0; solids = before; body = compoundOf(solids); // (then one by one)
          }
        }
        for (const [k, X] of xs.entries()) {
          if (t) { apply(t.op, X.shape(t.shape.clone()), t.merge, t.scope); continue; }
          if (made) {
            const M = xMatrix(X);
            for (const rec of made) {
              const shape = X.shape(rec.shape.clone());
              const nr = bodyRec(newId(pf.id), shape, pf.id, []);
              if (rec.sheet) { nr.sheet = SM.transformSheet(rec.sheet, M); if (!nr.sheet) flatLost++; }
              if (surfaces.includes(rec)) surfaces.push(nr); else solids.push(nr);
              applied.push({ op: 'add', tool: shape });
            }
            body = compoundOf(solids);
            continue;
          }
          const c = JSON.parse(JSON.stringify(src));
          c.id = `${src.id}@${pf.id}.${k + 1}`;
          moveRefs(c, X);
          try { await runFeature(c); } catch (e) { if (isFatal(e)) throw e; throw new Error(`Copy ${k + 1}: ${e.message || e}`); }
        }
        if (flatLost) res.notes[pf.id] = `${flatLost} mirrored lofted bend${flatLost > 1 ? 's are' : ' is a'} plain solid${flatLost > 1 ? 's' : ''} (no flat pattern)`;
      };
      switch (f.type) {
        case 'sketch': {
          const frame = orientFrame(resolveFrame(f.plane.ref, f.plane), f.plane.rot);
          sketchBodies.set(f.id, { body, frame, surfaces: surfaces.map((x) => x.shape) });
          if (f.entities) S.migrateSketch(f, vars);
          const lost = updateProjections(f, frame, dense ? null : body, sketches, surfaces.map((x) => x.shape));
          const sol = solveSketch(f, ev);
          sketches.set(f.id, { frame, sk: f });
          res.sketches[f.id] = { frame, rev: f.rev, data: { points: f.points, curves: f.curves, constraints: f.constraints, nextSid: f.nextSid } };
          if (f.texts?.length) res.sketches[f.id].textPolys = textOutlines(f.texts);
          for (const tr of f.gearTrains || []) {
            for (const mm of S.trainMeshes(f, tr)) {
              if (Math.abs(mm.need - mm.have) > 1e-3) res.notes[f.id] = `Gear train: a mesh is ${(mm.have - mm.need).toFixed(3)} mm off its centre distance (${mm.need.toFixed(3)} mm) — tick "Set the line lengths" in the gear train`;
            }
          }
          if (sol.bad.length) throw new Error(sol.bad[0]);
          if (!sol.ok) throw new Error('The sketch cannot be solved (conflicting relations or dimensions)');
          if (lost) throw new Error(`${lost} projected reference${lost > 1 ? 's' : ''} could not be found in the model`);
          break;
        }
        case 'plane': {
          const refs = planeRefs(f);
          const type = inferPlaneType(refs);
          if (!type) throw new Error('These references do not define a plane — pick a face/plane, an edge/axis or points');
          const geo = refs.map(resolveRefGeom);
          if (f.refs?.length) res.features[f.id] = { refs: f.refs };
          const planesOf = geo.filter((g) => g.kind === 'plane');
          const lineOf = geo.find((g) => g.kind === 'line');
          const pointsOf = geo.filter((g) => g.kind === 'point');
          let fr;
          if (type === 'offset') {
            const g = planesOf[0];
            const d = ev(f.offset) * (f.flip ? -1 : 1);
            fr = g.frame
              ? { o: add(g.frame.o, mul(g.frame.n, d)), u: g.frame.u, v: g.frame.v, n: g.frame.n }
              : frameOnPlane(add(g.p, mul(g.n, d)), g.n);
          } else if (type === 'midPlane') {
            const [A, B] = planesOf;
            const c = dot(A.n, B.n);
            if (Math.abs(c) > 0.99999) {
              // parallel: halfway between them
              const n = A.n;
              const h = (dot(n, A.p) + dot(n, B.p)) / 2;
              fr = A.frame ? { o: add(A.frame.o, mul(n, h - dot(n, A.frame.o))), u: A.frame.u, v: A.frame.v, n } : frameOnPlane(mul(n, h), n);
            } else {
              // intersecting: bisector plane through their line of intersection
              const s = c > 0 ? -1 : 1;
              let n = unit(add(A.n, mul(B.n, s)));
              if (f.bisector) n = unit(add(A.n, mul(B.n, -s)));
              const line = planeIntersection(A, B);
              fr = frameOnPlane(line.o, n);
            }
          } else if (type === 'atAngle') {
            const P = planesOf[0], L = lineOf;
            let n0 = sub(P.n, mul(L.d, dot(P.n, L.d)));
            if (len(n0) < 1e-6) throw new Error('The edge is perpendicular to the plane — use "Normal to an edge" instead');
            n0 = unit(n0);
            const a = (ev(f.angle) * (f.flipAngle ? -1 : 1) * Math.PI) / 180;
            const n = unit(add(mul(n0, Math.cos(a)), mul(cross(L.d, n0), Math.sin(a))));
            fr = frameOnPlane(L.mid, n);
          } else if (type === 'normalToEdge') {
            const L = lineOf;
            const at = pointsOf[0]?.p || (f.position === 'start' ? L.start : f.position === 'end' ? L.end : L.mid);
            fr = frameOnPlane(at, L.d);
          } else if (type === 'parallelThrough') {
            const P = planesOf[0];
            const p = pointsOf[0].p;
            fr = P.frame ? { o: add(P.frame.o, mul(P.frame.n, dot(sub(p, P.frame.o), P.frame.n))), u: P.frame.u, v: P.frame.v, n: P.frame.n } : frameOnPlane(p, P.n);
          } else if (type === 'threePoints') {
            const [a, b, c] = pointsOf.map((g) => g.p);
            const n = cross(sub(b, a), sub(c, a));
            if (len(n) < 1e-9) throw new Error('The three points are in a line');
            fr = frameOnPlane(a, unit(n));
          }
          planes.set(f.id, fr);
          res.planes[f.id] = fr;
          break;
        }
        case 'extrude': {
          const sk = getSketch(f.sketch, f.thin ? { t: ev(f.thinT), dir: f.thinDir || 'one' } : null);
          let z0 = 0, z1 = 0;
          if (f.end === 'blind' || f.end === 'midplane') {
            const d = ev(f.depth);
            if (d <= 0) throw new Error('Depth must be greater than zero');
            if (f.end === 'blind') z1 = d; else { z0 = -d / 2; z1 = d / 2; }
          } else if (f.end === 'through' || f.end === 'through2') {
            if (f.op === 'add' && !body) throw new Error('Through All needs an existing body');
            const b = body ? bbox(body) : { center: [0, 0, 0], diag: 1000 };
            const L = len(sub(b.center, sk.frame.o)) + b.diag + 5;
            if (f.end === 'through') z1 = L; else { z0 = -L; z1 = L; }
          }
          if (f.reverse && (f.end === 'blind' || f.end === 'through')) [z0, z1] = [-z1, -z0];
          const fr = sk.frame;
          let tool = null;
          if (f.end === 'upToVertex') {
            const P = resolvePoint(f.toPoint, f.toVertex);
            if (f.toVertex) res.features[f.id] = { ...(res.features[f.id] || {}), toVertex: f.toVertex };
            const d = dot(sub(P, fr.o), fr.n);
            if (Math.abs(d) < 1e-6) throw new Error('The vertex lies in the sketch plane');
            z0 = Math.min(0, d); z1 = Math.max(0, d);
          } else if (f.end === 'upToSurface' || f.end === 'offsetSurface') {
            const tgt = resolveSurface(f.toPlane, f.toFace);
            if (f.toFace) res.features[f.id] = { ...(res.features[f.id] || {}), toFace: f.toFace };
            const off = f.end === 'offsetSurface' ? ev(f.toOffset) * (f.toFlip ? -1 : 1) : 0;
            const cosA = dot(tgt.n, fr.n);
            if (Math.abs(cosA) < 1e-6) throw new Error('The surface is parallel to the extrusion direction');
            // signed distance along the sketch normal from the sketch origin to the surface
            const t = dot(sub(tgt.p, fr.o), tgt.n) / cosA;
            if (Math.abs(cosA) > 0.99999) {
              // parallel: a plain blind extrusion, offset back toward the sketch
              const d = t - Math.sign(t) * off;
              if (Math.abs(d) < 1e-6) throw new Error('The surface lies in the sketch plane');
              z0 = Math.min(0, d); z1 = Math.max(0, d);
            } else {
              // angled surface: extrude past it, then keep the part on the sketch's side
              const dir = Math.sign(t) || 1;
              let rProf = 0;
              for (const r of sk.regions) for (const q of r.outer.poly) rProf = Math.max(rProf, Math.hypot(q[0], q[1]));
              const tan = Math.sqrt(1 - cosA * cosA) / Math.abs(cosA);
              const L = Math.abs(t) + rProf * tan + 10;
              const long = profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(fr)).extrude(dir * L));
              const side = Math.sign(dot(sub(fr.o, tgt.p), tgt.n)) || 1;
              const nIn = mul(tgt.n, side); // points toward the sketch
              const pOff = add(tgt.p, mul(nIn, off));
              const big = L + rProf * (1 + tan) + 100;
              const tmp = Math.abs(nIn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
              const uT = (() => { const c = [nIn[1] * tmp[2] - nIn[2] * tmp[1], nIn[2] * tmp[0] - nIn[0] * tmp[2], nIn[0] * tmp[1] - nIn[1] * tmp[0]]; const l = len(c); return mul(c, 1 / l); })();
              const block = R.drawRectangle(2 * big, 2 * big).sketchOnPlane(new R.Plane(pOff, uT, nIn)).extrude(2 * big);
              tool = long.intersect(block);
            }
          }
          if (!tool) {
            if (z1 - z0 <= 1e-9) throw new Error('Depth must be greater than zero');
            tool = profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(fr, add(fr.o, mul(fr.n, z0)))).extrude(z1 - z0));
          }
          tool = unify(tool);
          const scope = f.op === 'cut' && f.scopeAll === false ? f.scope || [] : null;
          tools.set(f.id, { shape: tool, op: f.op, merge: f.merge !== false, scope });
          apply(f.op, tool, f.merge !== false, scope);
          break;
        }
        case 'revolve': {
          const sk = getSketch(f.sketch);
          const a = ev(f.angle);
          if (a <= 0) throw new Error('Angle must be greater than zero');
          const angle = Math.min(a, 360);
          const fr = sk.frame;
          const { o: origin, d: dir } = revolveAxisOf(f, sk);
          let tool = profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(fr)).revolve(dir, { origin, angle }));
          let start = 0;
          if (f.end === 'midplane') start = -angle / 2;
          else if (f.reverse) start = -angle;
          if (start) tool = tool.rotate(start, origin, dir);
          tool = unify(tool);
          const scope = f.op === 'cut' && f.scopeAll === false ? f.scope || [] : null;
          tools.set(f.id, { shape: tool, op: f.op, merge: f.merge !== false, scope });
          apply(f.op, tool, f.merge !== false, scope);
          break;
        }
        case 'lpattern': {
          const d1 = mul(resolveAxis(f.dir1).d, (f.rev1 ? -1 : 1) * ev(f.dist1));
          const c1 = Math.max(1, Math.round(ev(f.count1)));
          const two = f.dir2 && f.dir2 !== 'none';
          const d2 = two ? mul(resolveAxis(f.dir2).d, (f.rev2 ? -1 : 1) * ev(f.dist2)) : [0, 0, 0];
          const c2 = two ? Math.max(1, Math.round(ev(f.count2))) : 1;
          if (c1 * c2 > 400) throw new Error('Too many instances (max 400)');
          const xs = [];
          for (let i = 0; i < c1; i++) for (let j = 0; j < c2; j++) if (i || j) xs.push(xMove(add(mul(d1, i), mul(d2, j))));
          await instances(f, f.feature, xs);
          break;
        }
        case 'cpattern': {
          const n = Math.max(1, Math.round(ev(f.count)));
          if (n > 400) throw new Error('Too many instances (max 400)');
          const total = ev(f.angle);
          const step = f.equal ? (Math.abs(total) >= 360 ? total / n : total / Math.max(1, n - 1)) : total;
          const ax = resolveAxis(f.axis);
          const xs = [];
          for (let i = 1; i < n; i++) xs.push(xTurn(step * i, ax.o, ax.d));
          await instances(f, f.feature, xs);
          break;
        }
        case 'mirror': {
          const fr = resolveFrame(f.plane);
          await instances(f, f.feature, [xMirror(fr.o, fr.n)]);
          break;
        }
        case 'spattern': {
          // Sketch-driven pattern: a copy at each point of a sketch (the point nearest the feature is the
          // feature itself)
          const s2 = sketches.get(f.sketch);
          if (!s2) throw new Error('Select a sketch with points (or circles) where the copies go');
          const used = new Set(s2.sk.curves.filter((c) => c.type !== 'circle').flatMap((c) => [c.p1, c.p2, c.a, ...(c.pts || [])]).filter(Boolean));
          const centres = new Set(s2.sk.curves.filter((c) => c.type === 'circle' || c.type === 'arc').map((c) => c.c));
          const pts = s2.sk.points.filter((q) => q.id !== 'O' && (centres.has(q.id) || !used.has(q.id))).map((q) => S.fromFrame2D(s2.frame, q.x, q.y));
          if (pts.length < 2) throw new Error('The sketch needs at least two points (one at the feature, one for each copy)');
          const c0 = sourceCentre(f.feature);
          const base = pts.reduce((b, q) => (len(sub(q, c0)) - dot(sub(q, c0), s2.frame.n) * 0 < len(sub(b, c0)) ? q : b), pts[0]);
          await instances(f, f.feature, pts.filter((q) => q !== base).map((q) => xMove(sub(q, base))));
          res.notes[f.id] = `${pts.length - 1} cop${pts.length === 2 ? 'y' : 'ies'} at the sketch points`;
          break;
        }
        case 'curvePattern': {
          // Curve-driven pattern: copies spaced along a sketch / 3D sketch / helix, moved or turned with it
          const path = pathPolyline(f.path);
          if (!path) throw new Error('Select the curve to pattern along (a sketch, 3D sketch or helix)');
          const n = Math.max(2, Math.round(ev(f.count)));
          if (n > 400) throw new Error('Too many instances (max 400)');
          const c0 = sourceCentre(f.feature);
          const at = polyAt(path), s0 = at.nearest(c0);
          const total = at.length, closed = len(sub(path[0], path[path.length - 1])) < 1e-6 * (total || 1);
          const step = f.spacing === 'equal' ? (closed ? total / n : (total - s0) / (n - 1)) : ev(f.distance) * (f.reverse ? -1 : 1);
          if (!(Math.abs(step) > 1e-9)) throw new Error('The spacing must not be zero');
          const P0 = at.point(s0), T0 = at.tangent(s0), xs = [];
          for (let k = 1; k < n; k++) {
            let sk = s0 + step * k;
            if (closed) sk = ((sk % total) + total) % total;
            else if (sk > total + 1e-9 || sk < -1e-9) break;
            const P = at.point(sk), T = at.tangent(sk);
            if (f.align === 'tangent') {
              const ax = cross(T0, T), sn = len(ax), cs = dot(T0, T), ang = (Math.atan2(sn, cs) * 180) / Math.PI;
              xs.push(sn > 1e-9 ? xChain(xTurn(ang, P0, unit(ax)), xMove(sub(P, P0))) : xMove(sub(P, P0)));
            } else xs.push(xMove(sub(P, P0)));
          }
          if (!xs.length) throw new Error('No copies fit on the curve with that spacing');
          await instances(f, f.feature, xs);
          res.notes[f.id] = `${xs.length} cop${xs.length === 1 ? 'y' : 'ies'} along the curve`;
          break;
        }
        case 'fillPattern': {
          // Fill pattern: copies on a square or staggered grid over a flat face, kept a margin from its edges
          if (!f.face?.n) throw new Error('Click the flat face to fill');
          const hit = findFaceAny(solids, f.face);
          if (!hit) throw new Error('The face to fill could not be found');
          const sp = ev(f.spacing), margin = ev(f.margin || 0);
          if (!(sp > 0)) throw new Error('The spacing must be greater than zero');
          const n = unit(f.face.n), c0 = sourceCentre(f.feature);
          const o = sub(c0, mul(n, dot(sub(c0, f.face.p), n)));
          const fr0 = frameOnPlane(f.face.p, n), a = ((ev(f.angle || 0)) * Math.PI) / 180;
          const u = add(mul(fr0.u, Math.cos(a)), mul(fr0.v, Math.sin(a))), v = cross(n, u);
          const bb = bbox(hit.face), corners = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [m & 1 ? bb.max[0] : bb.min[0], m & 2 ? bb.max[1] : bb.min[1], m & 4 ? bb.max[2] : bb.min[2]]);
          const us = corners.map((q) => dot(sub(q, o), u)), vs = corners.map((q) => dot(sub(q, o), v));
          const stag = f.layout === 'staggered', dv = stag ? (sp * Math.sqrt(3)) / 2 : sp;
          const edges = R.makeCompound(hit.face.edges);
          const xs = [];
          for (let j = Math.floor(Math.min(...vs) / dv) - 1; j <= Math.ceil(Math.max(...vs) / dv) + 1; j++) {
            const off = stag && j % 2 ? sp / 2 : 0;
            for (let i = Math.floor((Math.min(...us) - off) / sp) - 1; i <= Math.ceil((Math.max(...us) - off) / sp) + 1; i++) {
              const q = add(o, add(mul(u, i * sp + off), mul(v, j * dv)));
              if (len(sub(q, o)) < sp * 1e-6) continue;
              const dq = new R.DistanceQuery(R.makeVertex(q));
              if (dq.distanceTo(hit.face) > 1e-6) continue;
              if (margin > 0 && dq.distanceTo(edges) < margin) continue;
              xs.push(xMove(sub(q, o)));
              if (xs.length > 400) throw new Error('Too many instances (max 400): use a larger spacing');
            }
          }
          if (!xs.length) throw new Error('No copies fit on the face with that spacing and margin');
          await instances(f, f.feature, xs);
          res.notes[f.id] = `${xs.length} cop${xs.length === 1 ? 'y' : 'ies'} over the face`;
          break;
        }
        case 'fillet':
        case 'chamfer': {
          if (!body) throw new Error('There is no body');
          needEdges(f.type === 'fillet' ? 'Fillet' : 'Chamfer');
          if (f.type === 'fillet' && (f.filletType === 'variable' || f.filletType === 'face')) {
            // variable radius (start → end along each edge) or a fillet between two picked faces
            const r1 = ev(f.radius), r2 = f.filletType === 'variable' ? ev(f.radius2) : r1;
            if (!(r1 > 0) || !(r2 > 0)) throw new Error('The radii must be greater than zero');
            const picked = [];
            let rec = null;
            if (f.filletType === 'face') {
              if ((f.faces || []).length < 2) throw new Error('Click the faces to blend: two (or more) faces that meet at edges');
              const hits = f.faces.map((r) => findFaceAny(solids, r));
              if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
              rec = hits[0].body;
              if (hits.some((h) => h.body !== rec)) throw new Error('The faces must be on the same body');
              // the edges where two of the faces meet
              for (let i = 0; i < hits.length; i++) for (const e of hits[i].face.edges) {
                if (picked.some((x) => x.isSame(e))) continue;
                if (hits.some((h, j) => j !== i && h.face.edges.some((x) => x.isSame(e)))) picked.push(e);
              }
              if (!picked.length) throw new Error('The selected faces do not meet at an edge (a face fillet here blends faces that share edges)');
            } else {
              if (!f.edges?.length) throw new Error('Select edges on the model');
              for (const e of f.edges) {
                const hit = findEdgeInfo(body, e);
                if (!hit) continue;
                updateEdgeRef(e, hit.e, body);
                picked.push(hit.e);
                rec = solids.find((s) => s.shape === hit.part) || rec;
              }
              if (!picked.length) throw new Error('The selected edges no longer exist');
            }
            res.features[f.id] = { edges: f.edges || [] };
            const input = rec ? rec.shape : body;
            const rad = f.filletType === 'variable' ? (f.flipRadii ? [r2, r1] : [r1, r2]) : r1;
            let out = null;
            for (const shrink of [0, 2e-5, 2e-4]) {
              try {
                const k = 1 - shrink;
                out = input.fillet((e) => (picked.some((x) => x.isSame(e)) ? (Array.isArray(rad) ? [rad[0] * k, rad[1] * k] : rad * k) : null));
                if (out && solidsOf(out).length) break;
                out = null;
              } catch (e) { if (isFatal(e)) throw e; out = null; }
            }
            if (!out) throw new Error('The fillet could not be computed (radius too large for the edges?)');
            if (rec) replaceSolid(rec, unify(out), f.id);
            else remapSolids(unify(out), picked.map((e) => e.pointAt(0.5)));
            blendChain = null;
            res.notes[f.id] = f.filletType === 'variable' ? `${picked.length} edge${picked.length === 1 ? '' : 's'}: R${+rad[0].toFixed(3)} → R${+rad[1].toFixed(3)}` : `${picked.length} edge${picked.length === 1 ? '' : 's'} where the faces meet, R${+r1.toFixed(3)}`;
            break;
          }
          if (!f.edges?.length) throw new Error('Select edges on the model');
          const v = ev(f.type === 'fillet' ? f.radius : f.distance);
          if (v <= 0) throw new Error('Value must be greater than zero');
          const pts = [];
          const found = [];
          const edgeShapes = [];
          const owners = new Set();
          let missing = 0;
          for (const e of f.edges) {
            const hit = findEdgeInfo(body, e);
            if (!hit) { missing++; continue; }
            updateEdgeRef(e, hit.e, body);
            pts.push(e.p);
            found.push({ ...e });
            edgeShapes.push(hit.e);
            owners.add(hit.part);
          }
          res.features[f.id] = { edges: f.edges };
          if (!pts.length) throw new Error('The selected edges no longer exist — an earlier fillet may already have rounded them (fillets continue along smoothly connected edges)');
          const filter = (fd) => fd.either(pts.map((p) => (x) => x.near(p, 1e-4)));
          // blend only the body that has the edges: much faster than blending every body together
          const rec = owners.size === 1 ? solids.find((s) => s.shape === [...owners][0]) || null : null;
          const input = rec ? rec.shape : body;
          const applyBlend = (shape, whole = false) => {
            if (rec && !whole) { const recs = replaceSolid(rec, shape, f.id); blendPair = { before: rec.shape, after: compoundOf(recs) }; }
            else remapSolids(shape, pts);
          };
          if (f.type === 'chamfer' && (f.chamferType === 'angleDist' || f.chamferType === 'twoDist')) {
            // distance + angle, or two distances: measured from one of the two faces at each edge
            const x = ev(f.chamferType === 'twoDist' ? f.distance2 : f.angle);
            if (f.chamferType === 'twoDist' && x <= 0) throw new Error('Both distances must be greater than zero');
            if (f.chamferType === 'angleDist' && (x <= 0 || x >= 90)) throw new Error('The angle must be between 0° and 90°');
            let out;
            try { out = chamferAsym(input, edgeShapes, f.chamferType, v, x, !!f.flip); } catch (e) { if (isFatal(e)) throw e; out = null; }
            if (!out || !solidsOf(out).length) throw new Error('The chamfer could not be computed (values too large for the selected edges?)');
            applyBlend(unify(out));
            blendChain = null;
            if (missing) throw new Error(`${missing} selected edge${missing > 1 ? 's' : ''} could not be found and ${missing > 1 ? 'were' : 'was'} skipped`);
            break;
          }
          const item = { refs: found, value: v };
          let result = null;
          try {
            result = f.type === 'fillet' ? input.fillet(v, filter) : input.chamfer(v, filter);
          } catch (e) { if (isFatal(e)) throw e; /* try a combined blend below */ }
          // Blends that exactly meet (e.g. R2 on both edges of a 4 mm wall: a full round) would leave
          // a face of zero width, which the kernel rejects; a hair smaller value gives the same shape.
          for (const shrink of [2e-5, 2e-4, 2e-3]) {
            if (result) break;
            try { result = f.type === 'fillet' ? input.fillet(v * (1 - shrink), filter) : input.chamfer(v * (1 - shrink), filter); } catch (e) { if (isFatal(e)) throw e; }
          }
          // Edges that end on earlier fillets (e.g. a corner where three blends meet) can't be
          // filleted afterwards. Fallbacks, each computing the corner blend in one kernel call:
          let chain = blendChain?.type === f.type && blendChain.partId === (rec?.id ?? null) ? { base: blendChain.base, items: [...blendChain.items, item] } : null;
          let whole = false;
          if (!result && chain) {
            // 1. combine with the run of blends directly before this one
            result = combinedBlend(chain.base, chain.items, f.type);
          }
          if (!result) {
            // 2. combine with every earlier blend of this type, then replay the features in between
            const r = reorderedBlend(steps, f.type, item);
            if (r) { result = r.body; chain = { base: r.base, items: r.items }; whole = true; }
          }
          if (!result) throw new Error(`The ${f.type} could not be computed (value too large for the selected edges?)`);
          result = unify(result);
          applyBlend(result, whole);
          blendChain = chain || { type: f.type, base: input, items: [item] };
          blendChain.type = f.type;
          blendChain.partId = whole ? null : rec?.id ?? null;
          blendStep = { type: f.type, item };
          if (missing) throw new Error(`${missing} selected edge${missing > 1 ? 's' : ''} could not be found and ${missing > 1 ? 'were' : 'was'} skipped`);
          break;
        }
        case 'import': {
          const rec = await importShape(f);
          const shape = rec.shape.clone();
          if (rec.dense) dense = true;
          // imported bodies stay separate unless "Merge touching bodies" is ticked
          const mergeBodies = f.mergeBodies === true;
          tools.set(f.id, { shape, op: 'add', merge: mergeBodies });
          if (f.format === 'step') {
            progress(null, 'Separating the imported bodies…');
            const parts = splitImported(shape);
            if (!parts.solids.length && !parts.surfaces.length) throw new Error('The file contains no solids or surfaces');
            const n0 = solids.length;
            for (const s of parts.solids) apply('add', s, mergeBodies);
            const s0 = surfaces.length;
            for (const s of parts.surfaces) { surfaces.push(bodyRec(newId(f.id), s, f.id)); applied.push({ op: 'add', tool: s }); }
            // the appearances the file gave its solids and faces (f.appearance, from stepasm.js)
            if (f.appearance) {
              const recs = [...(mergeBodies ? [] : solids.slice(n0)), ...surfaces.slice(s0)];
              const looks = importedLooks(f.appearance, recs.map((r) => r.shape));
              recs.forEach((r, i) => { if (looks[i]) r.look = looks[i]; });
              if (mergeBodies && f.appearance.c != null) for (const r of solids.slice(n0)) r.look = { c: f.appearance.c, t: f.appearance.t || 0 };
            }
          } else if (shape.solids.length) apply('add', shape, mergeBodies);
          else {
            // a mesh that is not closed: a surface body (Repair Mesh / Convert to Solid can close it)
            const mrec = bodyRec(newId(f.id), shape, f.id);
            mrec.mesh = true;
            surfaces.push(mrec);
            applied.push({ op: 'add', tool: shape });
            const freeEdges = rec.open;
            res.notes[f.id] = `The mesh is not closed (${freeEdges} open edge${freeEdges === 1 ? '' : 's'}): it came in as a surface body. Use Repair Mesh to close it, or Convert to Solid.`;
          }
          if (rec.reduced) res.notes[f.id] = `Simplified from ${rec.reduced.from.toLocaleString()} to ${rec.reduced.to.toLocaleString()} triangles (the shape kept within a hair; set the limit in the import's properties).` + (res.notes[f.id] ? ' ' + res.notes[f.id] : '');
          break;
        }
        case 'shell': {
          needEdges('Shell');
          if (!f.faces?.length) throw new Error('Select the faces to remove on the model');
          const t = ev(f.thickness);
          if (t <= 0) throw new Error('Thickness must be greater than zero');
          const hits = f.faces.map((r) => findFaceAny(solids, r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          const rec = hits[0].body;
          if (hits.some((h) => h.body !== rec)) throw new Error('All removed faces must be on the same body');
          const thick = (shape, faces) => {
            const oc = R.getOC(), L = ocList(faces);
            const mk = new oc.BRepOffsetAPI_MakeThickSolid();
            try {
              mk.MakeThickSolidByJoin(shape.wrapped, L, f.outward ? t : -t, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
              const out = R.cast(mk.Shape());
              return solidsOf(out).length ? out : null;
            } catch { return null; } finally { mk.delete(); L.delete(); }
          };
          let out = thick(rec.shape, hits.map((h) => h.face));
          if (!out) {
            // A fillet (or chamfer) smaller than the wall collapses when it is offset, and the kernel
            // gives up. Shell the body as it would be without those small blends instead, and cut that
            // cavity out of the real body: the outside keeps its fillets, the inside has sharp corners.
            const at = doc.features.indexOf(f);
            const size = (x) => { try { return ev(x.type === 'fillet' ? x.radius : x.distance); } catch { return Infinity; } };
            const before = doc.features.slice(0, at);
            const small = (types) => before.filter((x) => types.includes(x.type) && !x.suppressed && size(x) < t + 1e-9);
            for (const types of [['fillet'], ['fillet', 'chamfer']]) {
              const skip = new Set(small(types).map((x) => x.id));
              if (!skip.size) continue;
              const sub = JSON.parse(JSON.stringify({ ...doc, features: before.map((x) => (skip.has(x.id) ? { ...x, suppressed: true } : x)) }));
              let part;
              quietProgress++;
              try { part = await rebuild(sub, null, { partial: true }); } catch (e) { if (isFatal(e)) throw e; part = null; } finally { quietProgress--; }
              const plain = part?.solids.find((x) => x.id === rec.id);
              if (!plain) continue;
              const plainFaces = f.faces.map((r) => findFaceAny([plain], r)?.face);
              if (plainFaces.some((x) => !x)) continue;
              const shelled = thick(plain.shape, plainFaces);
              if (!shelled) continue;
              try {
                const cavity = plain.shape.cut(shelled);
                const res2 = rec.shape.cut(cavity);
                if (solidsOf(res2).length) { out = res2; break; }
              } catch (e) { if (isFatal(e)) throw e; /* try the next option */ }
            }
          }
          if (!out) throw new Error('The shell could not be built — try a smaller thickness or remove different faces');
          replaceSolid(rec, unify(out), f.id);
          break;
        }
        case 'surfExtrude':
        case 'surfRevolve':
        case 'surfPlanar': {
          if (!f.sketch) throw new Error('Select a sketch');
          const sk = sketches.get(f.sketch);
          if (!sk) throw new Error('The sketch is missing, suppressed or has errors');
          const fr = sk.frame, oc = R.getOC();
          let parts = [];
          if (f.type === 'surfPlanar') {
            const regions = S.profileRegions(sk.sk);
            if (!regions.length) throw new Error('The sketch has no closed profile');
            for (const r of regions) {
              // (outline and holes as wires: a drawing with holes cut out does not make one face)
              let face = R.makeFace(loopWire(fr, r.outer.segs));
              if (r.holes.length) face = R.addHolesInFace(face, r.holes.map((h) => loopWire(fr, h.segs)));
              parts.push(face);
            }
          } else if (f.type === 'surfExtrude') {
            const dpt = ev(f.depth);
            if (dpt <= 0) throw new Error('Depth must be greater than zero');
            const dir = f.reverse ? -1 : 1, z0 = f.end === 'midplane' ? -dpt / 2 : 0;
            for (let w of sketchWires(sk.sk, fr)) {
              if (z0) w = w.translate(mul(fr.n, z0));
              const v = new R.Vector(mul(fr.n, f.end === 'midplane' ? dpt : dir * dpt));
              const mk = new oc.BRepPrimAPI_MakePrism(w.wrapped, v.wrapped, false, true);
              parts.push(R.cast(mk.Shape()));
              mk.delete(); v.delete();
            }
          } else {
            const a = ev(f.angle);
            if (a <= 0) throw new Error('Angle must be greater than zero');
            const { o: origin, d: dir } = revolveAxisOf(f, sk);
            const sk2 = { ...sk.sk, curves: sk.sk.curves.filter((c) => c.id !== f.axis) }; // never revolve the axis line itself
            for (const w of sketchWires(sk2, fr)) {
              const ax1 = R.makeAx1(origin, dir);
              const mk = new oc.BRepPrimAPI_MakeRevol(w.wrapped, ax1, (Math.min(a, 360) * Math.PI) / 180, false);
              parts.push(R.cast(mk.Shape()));
              mk.delete(); ax1.delete();
            }
          }
          const shape = asShape(parts);
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'surfLoft': {
          // a surface through two or more profiles (open or closed chains of sketches / 3D sketches)
          const ids = (f.profiles || []).filter(Boolean);
          if (ids.length < 2) throw new Error('Select at least two profiles (in order)');
          const wires = ids.map((id) => {
            if (curves.has(id)) return curves.get(id).wire;
            const sk = sketches.get(id);
            if (!sk) throw new Error('A profile is missing, suppressed or has errors');
            const ws = sketchWires(sk.sk, sk.frame);
            if (ws.length !== 1) throw new Error(`${sk.sk.name} must be one connected chain of curves (it has ${ws.length})`);
            return ws[0];
          });
          const closed = wires.map((w) => len(sub(vec(w.startPoint), vec(w.endPoint))) < 1e-6);
          if (closed.some((c) => c !== closed[0])) throw new Error('The profiles must all be open, or all closed');
          let list = wires;
          if (closed[0]) {
            // closed profiles: matched like a solid loft (same start points, same way round)
            const secs = ids.map((id, i) => {
              if (curves.has(id)) return null;
              const sk = sketches.get(id), ch = S.curveChains(sk.sk).find((c) => c.closed);
              return loftSection(sk.frame, S.chainSegs(sk.sk, ch));
            });
            if (secs.every(Boolean)) list = matchLoftSections(secs, ids.map((id) => sketches.get(id).sk.name)).map(sectionWire);
          } else {
            // open profiles: each one runs the same way as the one before it
            list = [wires[0]];
            for (let i = 1; i < wires.length; i++) {
              const prev = list[i - 1], w = wires[i];
              const a = vec(prev.startPoint), b = vec(prev.endPoint);
              const same = len(sub(vec(w.startPoint), a)) + len(sub(vec(w.endPoint), b)), flipped = len(sub(vec(w.endPoint), a)) + len(sub(vec(w.startPoint), b));
              list.push(flipped < same ? R.cast(w.wrapped.Reversed()) : w);
            }
          }
          let shape;
          try { shape = R.loft(list, { ruled: !!f.ruled }, true); } catch (e) { if (isFatal(e)) throw e; throw new Error('The surface could not be lofted through these profiles'); }
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'surfSweep': {
          // a surface swept along a path: an open or closed sketch chain, or a circle
          let spine, helical = false;
          if (curves.has(f.path)) { spine = curves.get(f.path).wire; helical = !curves.get(f.path).route; }
          else {
            const ps = f.path && sketches.get(f.path);
            if (!ps) throw new Error('Select the path: a sketch (one chain of curves), a 3D sketch or a helix');
            const ws = sketchWires(ps.sk, ps.frame);
            if (ws.length !== 1) throw new Error('The path sketch must be one connected chain of curves');
            spine = ws[0];
          }
          let profile;
          if (f.profileType === 'circle') {
            const dia = ev(f.diameter);
            if (!(dia > 0)) throw new Error('The diameter must be greater than zero');
            profile = R.assembleWire([R.makeCircle(dia / 2, vec(spine.startPoint), unit(vec(spine.tangentAt(0))))]);
          } else {
            if (!f.profile || f.profile === f.path) throw new Error('Select a profile sketch (different from the path)');
            const ps = sketches.get(f.profile);
            if (!ps) throw new Error('The profile sketch is missing, suppressed or has errors');
            const ws = sketchWires(ps.sk, ps.frame);
            if (ws.length !== 1) throw new Error('The profile sketch must be one connected chain of curves');
            profile = ws[0];
          }
          let shape = null;
          for (const transitionMode of ['right', 'round', 'transformed']) {
            try { shape = R.genericSweep(profile, spine, { frenet: helical, transitionMode }, true)[0]; break; } catch (e) { if (isFatal(e)) throw e; }
          }
          if (!shape) throw new Error('The profile could not be swept along the path (place it at the start of the path, across it)');
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'surfFill': {
          // a patch over a hole bounded by edges (contact, or tangent to the faces round it)
          if (!(f.edges || []).length) throw new Error('Click the edges round the hole to fill');
          const all = [...solids, ...surfaces], whole = compoundOf(all);
          const found = f.edges.map((e) => findEdgeInfo(whole, e));
          if (found.some((x) => !x)) throw new Error('A boundary edge could not be found in the model');
          const edges = found.map((x) => x.e);
          const owner = (e) => all.find((r) => r.shape.edges.some((x) => x.isSame(e)));
          const recs = [...new Set(edges.map(owner))];
          const oc = R.getOC();
          const build = (tangent) => {
            const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
            try {
              for (const e of edges) {
                const sup = tangent ? owner(e)?.shape.faces.find((fc) => fc.edges.some((x) => x.isSame(e))) : null;
                if (sup) mk.Add(e.wrapped, sup.wrapped, oc.GeomAbs_Shape.GeomAbs_G1, true);
                else mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
              }
              mk.Build();
              return R.cast(mk.Shape());
            } finally { mk.delete(); }
          };
          let patch = null, note = '';
          try { patch = build(!!f.tangent); } catch (e) { if (isFatal(e)) throw e; if (f.tangent) { patch = build(false); note = ' (made with contact only: the tangent fill failed)'; } }
          if (!patch) throw new Error('The edges do not bound a hole that can be filled (they must form one closed loop)');
          // knit into the surface the edges belong to (and close a solid when that seals it)
          const surfRec = recs.length === 1 && surfaces.includes(recs[0]) ? recs[0] : null;
          if (f.merge !== false && surfRec) {
            const sewn = sewShapes([surfRec.shape, patch], 1e-4);
            const sol = f.solid && holeLoops(sewn).freeEdges === 0 ? solidFromSewn(sewn) : null;
            surfaces = surfaces.filter((r) => r !== surfRec);
            if (sol) apply('add', unify(sol), true);
            else {
              surfaces.push(bodyRec(surfRec.id, sewn, f.id));
              if (f.solid) note += ' (the surface is not closed, so no solid was made)';
            }
          } else surfaces.push(bodyRec(newId(f.id), patch, f.id));
          applied.push({ op: 'add', tool: patch });
          res.notes[f.id] = `Filled ${edges.length} edge${edges.length === 1 ? '' : 's'}${note}`;
          break;
        }
        case 'surfTrim': {
          // surfaces cut by a plane, a surface body or a sketch; the clicked pieces are kept (or removed)
          let tool = null, toolRec = null;
          if (f.tool && (STD[f.tool] || planes.has(f.tool))) { const fr = resolveFrame(f.tool); tool = planeFace(fr.o, fr.n); }
          else if (f.tool && sketches.get(f.tool)) {
            const sk = sketches.get(f.tool), L = 2 * ([...solids, ...surfaces].length ? bboxOfAll([...solids, ...surfaces].map((r) => r.shape)).diag : 100) + 10;
            const ws = sketchWires(sk.sk, sk.frame);
            if (!ws.length) throw new Error('The trim sketch has no curves');
            const oc = R.getOC();
            tool = asShape(ws.map((w) => { const v = new R.Vector(mul(sk.frame.n, 2 * L)), mk = new oc.BRepPrimAPI_MakePrism(w.clone().translate(mul(sk.frame.n, -L)).wrapped, v.wrapped, false, true); const sh = R.cast(mk.Shape()); mk.delete(); v.delete(); return sh; }));
          } else if (f.tool) { toolRec = surfaces.find((r) => r.id === f.tool); if (!toolRec) throw new Error('The trim tool surface no longer exists'); tool = toolRec.shape; }
          else throw new Error('Choose the trim tool: a plane, a surface body or a sketch');
          if (!(f.faces || []).length) throw new Error('Click the pieces to keep (or to remove)');
          // the surfaces clicked on (and the tool surface too, for a mutual trim)
          const targets = [...new Set(f.faces.map((r) => findFaceAny(surfaces, r)?.body).filter(Boolean))];
          if (f.mutual && toolRec && !targets.includes(toolRec)) targets.push(toolRec);
          if (!targets.length) throw new Error('Click on the surface bodies to trim');
          let cut = false;
          for (const rec of targets) {
            const other = rec === toolRec ? asShape(targets.filter((x) => x !== rec).map((x) => x.shape)) : tool;
            const oc = R.getOC(), sp = new oc.BRepAlgoAPI_Splitter(), A = ocList([rec.shape]), T = ocList([other]);
            sp.SetArguments(A); sp.SetTools(T); sp.Build(new oc.Message_ProgressRange());
            const bad = sp.HasErrors(), split = bad ? null : R.cast(sp.Shape());
            sp.delete(); A.delete(); T.delete();
            if (!split) throw new Error('The surface could not be trimmed with that tool');
            // pieces: faces joined except across edges lying on the tool
            const faces = [...R.iterTopo(split.wrapped, 'face')].map((x) => R.cast(x));
            const onTool = (e) => new R.DistanceQuery(R.makeVertex(vec(e.pointAt(0.5)))).distanceTo(other) < 1e-5;
            const parent = faces.map((_, i) => i), find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
            for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
              const sh = faces[i].edges.filter((e) => faces[j].edges.some((x) => x.isSame(e)));
              if (sh.some((e) => !onTool(e))) parent[find(i)] = find(j);
            }
            const groups = new Map();
            faces.forEach((fc, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(fc); });
            if (groups.size < 2) continue;
            cut = true;
            const picked = (fs) => f.faces.some((r) => fs.some((fc) => new R.DistanceQuery(R.makeVertex(r.p)).distanceTo(fc) < Math.max(1e-3, bbox(rec.shape).diag * 1e-4)));
            const keep = [...groups.values()].filter((fs) => (f.mode === 'remove' ? !picked(fs) : picked(fs)));
            // (a mutual trim: on the tool surface with nothing clicked, the side facing the others' kept pieces is not guessed: all of it stays)
            const kept = keep.length ? keep : rec === toolRec ? [...groups.values()] : [];
            surfaces = surfaces.filter((r) => r !== rec);
            if (kept.length) surfaces.push(bodyRec(rec.id, sewShapes(kept.flat(), 1e-6), f.id));
          }
          if (!cut) throw new Error('The tool does not cut the surfaces into pieces');
          break;
        }
        case 'surfExtend': {
          // surface edges extended straight on (tangent to the surface) by a distance
          if (!(f.edges || []).length) throw new Error('Click the edges of a surface to extend');
          const d = ev(f.distance);
          if (!(d > 0)) throw new Error('The distance must be greater than zero');
          const whole = compoundOf(surfaces);
          if (!surfaces.length) throw new Error('There is no surface body to extend');
          const byRec = new Map();
          for (const ref of f.edges) {
            const hit = findEdgeInfo(whole, ref);
            if (!hit) throw new Error('A selected edge could not be found on a surface body');
            const rec = surfaces.find((r) => r.shape.edges.some((x) => x.isSame(hit.e)));
            const face = rec?.shape.faces.find((fc) => fc.edges.some((x) => x.isSame(hit.e)));
            if (!face) throw new Error('A selected edge is not on a surface body');
            if (rec.shape.faces.filter((fc) => fc.edges.some((x) => x.isSame(hit.e))).length > 1) throw new Error('Extend the open edges of a surface (an edge between two faces cannot be extended)');
            const e = hit.e, n = 9, P = [], Q = [];
            for (let i = 0; i <= n; i++) {
              const t = i / n, p0 = vec(e.pointAt(t)), tg = unit(vec(e.tangentAt(t))), nm = unit(vec(face.normalAt(p0)));
              let o = unit(cross(tg, nm));
              // outward: away from the face
              const probe = add(p0, mul(o, -Math.max(1e-3, d * 1e-3)));
              if (new R.DistanceQuery(R.makeVertex(probe)).distanceTo(face) > Math.max(1e-4, d * 1e-4)) o = mul(o, -1);
              P.push(p0); Q.push(add(p0, mul(o, d)));
            }
            const straight = e.geomType === 'LINE' && len(sub(sub(Q[0], P[0]), sub(Q[n], P[n]))) < 1e-9 * (1 + d);
            const far = straight ? R.makeLine(Q[0], Q[n]) : R.makeBSplineApproximation(Q.map((q) => new R.Vector(q)));
            const ext = R.loft([R.assembleWire([e.clone()]), R.assembleWire([far])], { ruled: true }, true);
            if (!byRec.has(rec)) byRec.set(rec, []);
            byRec.get(rec).push(ext);
          }
          for (const [rec, exts] of byRec) {
            surfaces = surfaces.map((r) => (r === rec ? bodyRec(rec.id, sewShapes([rec.shape, ...exts], 1e-5), f.id) : r));
            for (const x of exts) applied.push({ op: 'add', tool: x });
          }
          break;
        }
        case 'deleteFace': {
          // faces taken out of a solid or surface: left open (a surface body), or each hole patched over
          if (!(f.faces || []).length) throw new Error('Click the faces to delete');
          const hits = f.faces.map((r) => findFaceAny([...solids, ...surfaces], r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          const rec = hits[0].body;
          if (hits.some((h) => h.body !== rec)) throw new Error('The faces must be on the same body');
          const keep = rec.shape.faces.filter((fc) => !hits.some((h) => h.face.isSame(fc)));
          if (!keep.length) throw new Error('That would delete every face of the body (use Delete Body instead)');
          let sewn = sewShapes(keep, 1e-6);
          let note = `${hits.length} face${hits.length === 1 ? '' : 's'} deleted`;
          if (f.mode === 'patch') {
            const { loops } = holeLoops(sewn), oc = R.getOC(), patches = [];
            for (const loop of loops) {
              const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
              try {
                for (const e of loop.edges) {
                  const sup = f.tangent ? keep.find((fc) => fc.edges.some((x) => x.isSame(e))) : null;
                  if (sup) mk.Add(e.wrapped, sup.wrapped, oc.GeomAbs_Shape.GeomAbs_G1, true); else mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
                }
                mk.Build();
                patches.push(R.cast(mk.Shape()));
              } catch (e) { if (isFatal(e)) throw e; const hp = holePatch(loop, 1e-6); if (!hp) throw new Error('A hole left by the deleted faces could not be patched'); patches.push(...hp); } finally { mk.delete(); }
            }
            sewn = sewShapes([sewn, ...patches], 1e-4);
            note += `, ${patches.length} hole${patches.length === 1 ? '' : 's'} patched`;
          }
          // (a solid only when nothing is left open)
          const sol = holeLoops(sewn).freeEdges === 0 ? solidFromSewn(sewn) : null;
          solids = solids.filter((r) => r !== rec);
          surfaces = surfaces.filter((r) => r !== rec);
          if (sol) solids.push(bodyRec(rec.id, unify(sol), f.id));
          else { surfaces.push(bodyRec(rec.id, sewn, f.id)); if (solidsOf(rec.shape).length) note += ' (the body is now a surface body)'; }
          body = compoundOf(solids);
          res.notes[f.id] = note;
          break;
        }
        case 'replaceFace': {
          // a flat face of a solid moved onto a surface body: the body is carried through the face and cut back
          // to the surface (the surface must reach past the face's outline)
          if (!(f.faces || []).length) throw new Error('Click the flat faces to replace');
          const tool = surfaces.find((r) => r.id === f.tool);
          if (!tool) throw new Error('Choose the replacement surface body');
          const hits = f.faces.map((r) => findFaceAny(solids, r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found on a solid body');
          const rec = hits[0].body;
          if (hits.some((h) => h.body !== rec)) throw new Error('The faces must be on the same body');
          if (f.faces.some((r) => !r.n)) throw new Error('Replace Face works on flat faces');
          const L = bboxOfAll([rec.shape, tool.shape]).diag * 2 + 10;
          let grown = rec.shape;
          for (const [i, h] of hits.entries()) grown = grown.fuse(R.basicFaceExtrusion(h.face, new R.Vector(mul(unit(f.faces[i].n), L))));
          const pieces = splitBy(unify(grown), tool.shape);
          if (pieces.length < 2) throw new Error('The surface does not cut across the face (it must reach past the face all round)');
          // the piece holding the inside of the body, well away from the faces
          const inside = (sh, q) => new R.DistanceQuery(R.makeVertex(q)).distanceTo(sh) < 1e-9 && R.measureVolume(sh.intersect(R.makeBox(sub(q, [1e-3, 1e-3, 1e-3]), add(q, [1e-3, 1e-3, 1e-3])))) > 1e-10;
          const n0 = unit(f.faces[0].n), bb = bbox(rec.shape);
          const depth = Math.max(...[0, 1, 2, 3, 4, 5, 6, 7].map((m) => dot(sub([m & 1 ? bb.max[0] : bb.min[0], m & 2 ? bb.max[1] : bb.min[1], m & 4 ? bb.max[2] : bb.min[2]], f.faces[0].p), mul(n0, -1))));
          let probe = null;
          for (const k of [0.75, 0.5, 0.9, 0.25]) { const q = add(f.faces[0].p, mul(n0, -depth * k)); if (inside(rec.shape, q)) { probe = q; break; } }
          if (!probe) throw new Error('Could not tell which side of the surface the body is on');
          const kept = pieces.filter((pc) => inside(pc, probe));
          if (!kept.length) throw new Error('The replacement surface cuts through the inside of the body');
          replaceSolid(rec, unify(asShape(kept)), f.id);
          applied.push({ op: 'add', tool: tool.shape });
          if (f.hideTool !== false) res.notes[f.id] = `${hits.length} face${hits.length === 1 ? '' : 's'} replaced by ${tool.id}`;
          break;
        }
        case 'ruledSurface': {
          // surfaces standing on edges: square to the face along the edge, or along a direction (optionally tilted)
          if (!(f.edges || []).length) throw new Error('Click the edges to rule from');
          const d = ev(f.distance);
          if (!(d > 0)) throw new Error('The distance must be greater than zero');
          const all = [...solids, ...surfaces], whole = compoundOf(all);
          const parts = [];
          const fixed = f.ruleType === 'direction' ? unit(resolveAxis(f.direction || 'y').d) : null;
          const tilt = ((f.angle ? ev(f.angle) : 0) * Math.PI) / 180;
          for (const ref of f.edges) {
            const hit = findEdgeInfo(whole, ref);
            if (!hit) throw new Error('A selected edge could not be found');
            const e = hit.e, owner = all.find((r) => r.shape.edges.some((x) => x.isSame(e)));
            const face = owner?.shape.faces.find((fc) => fc.edges.some((x) => x.isSame(e)));
            const n = 12, sides = f.both ? [1, -1] : [f.flip ? -1 : 1];
            for (const sd of sides) {
              const Q = [];
              let straight = e.geomType === 'LINE';
              for (let i = 0; i <= n; i++) {
                const t = i / n, p0 = vec(e.pointAt(t));
                let dir;
                if (fixed) {
                  dir = fixed;
                  if (tilt && face) {
                    // tilted away from the face, about the edge
                    const tg = unit(vec(e.tangentAt(t))), side = unit(cross(tg, dir));
                    const o = dot(side, unit(vec(face.normalAt(p0)))) >= 0 ? side : mul(side, -1);
                    dir = unit(add(mul(dir, Math.cos(tilt)), mul(o, Math.sin(tilt))));
                  }
                } else {
                  if (!face) throw new Error('A normal ruled surface needs edges of faces');
                  dir = unit(vec(face.normalAt(p0)));
                  if (face.geomType !== 'PLANE') straight = false;
                }
                Q.push(add(p0, mul(dir, sd * d)));
              }
              const far = straight ? R.makeLine(Q[0], Q[n]) : R.makeBSplineApproximation(Q.map((q) => new R.Vector(q)));
              parts.push(R.loft([R.assembleWire([e.clone()]), R.assembleWire([far])], { ruled: true }, true));
            }
          }
          const shape = parts.length > 1 ? sewShapes(parts, 1e-5) : parts[0];
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'untrim': {
          // faces of a surface body given back their holes (inner loops), or their whole natural extent
          const rec = surfaces.find((r) => r.id === f.body) || ((f.faces || []).length ? findFaceAny(surfaces, f.faces[0])?.body : null);
          if (!rec) throw new Error('Choose the surface body to untrim (or click its faces)');
          const picked = (f.faces || []).map((r) => findFaceAny([rec], r)?.face).filter(Boolean);
          const targets = picked.length ? picked : rec.shape.faces;
          const oc = R.getOC();
          let n = 0;
          const out = rec.shape.faces.map((fc) => {
            if (!targets.some((t) => t.isSame(fc))) return fc;
            if (f.mode === 'all') {
              const b = fc.UVBounds, srf = oc.BRep_Tool.Surface(fc.wrapped);
              const mk = new oc.BRepBuilderAPI_MakeFace(srf, b.uMin, b.uMax, b.vMin, b.vMax, 1e-6);
              try { const nf = R.cast(mk.Face()); n++; return nf; } finally { mk.delete(); }
            }
            const inner = fc.clone().innerWires();
            if (!inner.length) return fc;
            n++;
            return R.makeNewFaceWithinFace(fc, fc.clone().outerWire());
          });
          if (!n) throw new Error(f.mode === 'all' ? 'Nothing to untrim' : 'The faces have no holes to fill (choose Natural extent to untrim the outline)');
          surfaces = surfaces.map((r) => (r === rec ? bodyRec(rec.id, out.length > 1 ? sewShapes(out, 1e-5) : out[0], f.id) : r));
          res.notes[f.id] = `${n} face${n === 1 ? '' : 's'} untrimmed`;
          break;
        }
        case 'projCurve':
        case 'splitLine': {
          // a sketch projected along its normal onto faces: as a 3D curve, or splitting the faces along it
          // (Split Line can also split with a plane or a surface body)
          const all = [...solids, ...surfaces];
          const hits = (f.faces || []).map((r) => findFaceAny(all, r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          if (f.type === 'splitLine' && !hits.length) throw new Error('Click the faces to split');
          const L = (all.length ? bboxOfAll(all.map((r) => r.shape)).diag : 100) * 2 + 10;
          let tool;
          const sk = sketches.get(f.type === 'projCurve' ? f.sketch : f.tool);
          if (sk) {
            const ws = sketchWires(sk.sk, sk.frame);
            if (!ws.length) throw new Error('The sketch has no curves to project');
            const oc = R.getOC();
            tool = asShape(ws.map((w) => { const v = new R.Vector(mul(sk.frame.n, 2 * L)), mk = new oc.BRepPrimAPI_MakePrism(w.clone().translate(mul(sk.frame.n, -L)).wrapped, v.wrapped, false, true); const sh = R.cast(mk.Shape()); mk.delete(); v.delete(); return sh; }));
          } else if (f.type === 'splitLine' && f.tool && (STD[f.tool] || planes.has(f.tool))) { const fr = resolveFrame(f.tool); tool = planeFace(fr.o, fr.n); }
          else if (f.type === 'splitLine' && f.tool) { const tr = surfaces.find((r) => r.id === f.tool); if (!tr) throw new Error('The split tool no longer exists'); tool = tr.shape; }
          else throw new Error(f.type === 'projCurve' ? 'Select the sketch to project' : 'Choose what to split with: a sketch, a plane or a surface body');
          const targets = hits.length ? hits.map((h) => h.face) : all.flatMap((r) => r.shape.faces);
          const oc = R.getOC(), edges = [];
          for (const face of targets) {
            const op = new oc.BRepAlgoAPI_Section(face.wrapped, tool.wrapped, false);
            try { op.Build(new oc.Message_ProgressRange()); if (!op.HasErrors()) edges.push(...R.cast(op.Shape()).edges); } catch (e) { if (isFatal(e)) throw e; } finally { op.delete(); }
          }
          if (!edges.length) throw new Error(f.type === 'projCurve' ? 'The sketch does not project onto the faces' : 'The tool does not cross the faces');
          if (f.type === 'projCurve') {
            const chains = chainEdges(edges);
            const wire = chains.length === 1 ? chains[0].wire : null;
            if (wire) curves.set(f.id, { wire, route: true });
            res.curves[f.id] = chains.map((c) => c.pts);
            res.notes[f.id] = `${edges.length} edge${edges.length === 1 ? '' : 's'}${chains.length > 1 ? ` in ${chains.length} separate curves (one connected curve can be a sweep path)` : ''}`;
          } else {
            // split the faces along the edges (the body stays one body, with more faces)
            const byRec = new Map();
            for (const h of hits) { if (!byRec.has(h.body)) byRec.set(h.body, []); }
            for (const rec of byRec.keys()) {
              const sp = new oc.BRepAlgoAPI_Splitter(), A = ocList([rec.shape]), T = ocList(edges);
              sp.SetArguments(A); sp.SetTools(T); sp.Build(new oc.Message_ProgressRange());
              const bad = sp.HasErrors(), out = bad ? null : R.cast(sp.Shape());
              sp.delete(); A.delete(); T.delete();
              if (!out) throw new Error('The faces could not be split');
              if (solids.includes(rec)) {
                const sol = solidsOf(out);
                if (sol.length !== 1) throw new Error('Splitting the faces broke the body');
                solids = solids.map((r) => (r === rec ? bodyRec(rec.id, sol[0], f.id) : r));
              } else surfaces = surfaces.map((r) => (r === rec ? bodyRec(rec.id, out, f.id) : r));
            }
            body = compoundOf(solids);
            res.notes[f.id] = `${hits.length} face${hits.length === 1 ? '' : 's'} split`;
          }
          break;
        }
        case 'compCurve': {
          // edges of the model joined into one curve (e.g. a sweep path along a part's edges)
          if (!(f.edges || []).length) throw new Error('Click the edges to join, end to end');
          const whole = compoundOf([...solids, ...surfaces]);
          const edges = f.edges.map((r) => findEdgeInfo(whole, r)?.e);
          if (edges.some((e) => !e)) throw new Error('A selected edge could not be found');
          const chains = chainEdges(edges);
          if (chains.length !== 1) throw new Error(`The edges do not join end to end (they make ${chains.length} separate pieces)`);
          curves.set(f.id, { wire: chains[0].wire, route: true });
          res.curves[f.id] = [chains[0].pts];
          res.notes[f.id] = `${edges.length} edges, ${+R.measureLength(chains[0].wire).toFixed(3)} long`;
          break;
        }
        case 'boundarySurf': {
          // a surface through curves in two directions: the first and last of each direction bound it, the
          // ones between shape it
          const wireOf = (id) => {
            if (curves.has(id)) return curves.get(id).wire;
            const sk = sketches.get(id);
            if (!sk) throw new Error('A curve is missing, suppressed or has errors');
            const ws = sketchWires(sk.sk, sk.frame);
            if (ws.length !== 1) throw new Error(`${sk.sk.name} must be one connected chain of curves`);
            return ws[0];
          };
          const d1 = (f.dir1 || []).filter(Boolean).map(wireOf), d2 = (f.dir2 || []).filter(Boolean).map(wireOf);
          if (d1.length < 2) throw new Error('Select at least two curves in direction 1');
          if (d2.length < 2) throw new Error('Select at least two curves in direction 2 (with curves in one direction only, use Lofted Surface)');
          const bound = [d1[0], d1[d1.length - 1], d2[0], d2[d2.length - 1]];
          // the four bounding curves must meet at their ends
          const ends = bound.flatMap((w) => [vec(w.startPoint), vec(w.endPoint)]);
          const tol = Math.max(1e-3, bboxOfAll(bound).diag * 1e-5);
          for (const q of ends) if (ends.filter((x) => len(sub(x, q)) < tol).length < 2) throw new Error('The first and last curves of the two directions must meet at their ends (they bound the surface)');
          const oc = R.getOC(), mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
          let shape;
          try {
            for (const w of bound) for (const e of w.edges) mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
            for (const w of [...d1.slice(1, -1), ...d2.slice(1, -1)]) for (const e of w.edges) mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, false);
            mk.Build();
            shape = R.cast(mk.Shape());
          } catch (e) { if (isFatal(e)) throw e; throw new Error('The boundary surface could not be made through these curves'); } finally { mk.delete(); }
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'flattenSurf': {
          // faces unrolled flat: exact for surfaces that unroll (cylinders, cones, bent sheets); a doubly curved
          // surface is spread out keeping its edge lengths as well as it can (the stretch is reported)
          if (!(f.faces || []).length) throw new Error('Click the faces to flatten');
          const all = [...solids, ...surfaces];
          const hits = f.faces.map((r) => findFaceAny(all, r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          const faces = [];
          for (const h of hits) if (!faces.some((x) => x.isSame(h.face))) faces.push(h.face);
          const fl = flattenFaces(faces, Math.max(1, Math.min(5000, Math.round(ev(f.iterations ?? 1000)))));
          // laid flat beside the model, on a plane parallel to Top
          const bb = bboxOfAll(all.map((r) => r.shape)), o = [bb.max[0] + 20, bb.min[1], bb.min[2]];
          const to3 = (q) => [o[0] + q[0] - fl.min[0], o[1], o[2] - (q[1] - fl.min[1])];
          let face = R.makePolygon(fl.outer.map(to3));
          if (fl.holes.length) face = R.addHolesInFace(face, fl.holes.map((h) => R.makePolygon(h.map(to3)).outerWire()));
          surfaces.push(bodyRec(newId(f.id), face, f.id));
          applied.push({ op: 'add', tool: face });
          res.notes[f.id] = `Flat ${+(fl.max[0] - fl.min[0]).toFixed(2)} × ${+(fl.max[1] - fl.min[1]).toFixed(2)} mm, area ${+fl.area2.toFixed(2)} (surface ${+fl.area3.toFixed(2)}, ${fl.area2 >= fl.area3 ? '+' : ''}${(((fl.area2 - fl.area3) / fl.area3) * 100).toFixed(2)}%), edge lengths changed ${(fl.rmsStrain * 100).toFixed(2)}% on average (at most ${(fl.maxStrain * 100).toFixed(1)}%)`;
          break;
        }
        case 'weldBead': {
          // weld beads (round, the weld size across) along the lines where bodies meet; each joint its own body
          const sz = ev(f.size);
          if (!(sz > 0)) throw new Error('The weld size must be greater than zero');
          const pool = (f.bodies || []).length ? f.bodies.map((id) => solids.find((r) => r.id === id)).filter(Boolean) : solids.filter((r) => r.member && r.member.type !== 'weld');
          if (pool.length < 2) throw new Error('Select two or more bodies that touch (none: every weldment member)');
          const oc = R.getOC();
          let n0 = 0, total = 0;
          for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
            const A = pool[i], B = pool[j];
            if (!boxesTouch(A.box, B.box, 1e-4)) continue;
            let sec = null;
            const op = new oc.BRepAlgoAPI_Section(A.shape.wrapped, B.shape.wrapped, false);
            try { op.Build(new oc.Message_ProgressRange()); if (!op.HasErrors()) sec = R.cast(op.Shape()); } catch (e) { if (isFatal(e)) throw e; } finally { op.delete(); }
            const edges = sec ? sec.edges.filter((e) => R.measureLength(e) > 1e-6) : [];
            if (!edges.length) continue;
            const beads = [];
            for (const ch of chainEdges(edges)) {
              const w = ch.wire, st = vec(w.startPoint), t0 = unit(vec(w.tangentAt(0)));
              const prof = R.assembleWire([R.makeCircle(sz / 2, st, t0)]);
              for (const tm of ['round', 'right', 'transformed']) { try { beads.push(R.genericSweep(prof, w, { frenet: false, transitionMode: tm })); break; } catch (e) { if (isFatal(e)) throw e; } }
              total += R.measureLength(w);
            }
            if (!beads.length) continue;
            let shape = beads[0];
            for (const b of beads.slice(1)) { try { shape = shape.fuse(b); } catch (e) { if (isFatal(e)) throw e; shape = asShape([shape, b]); } }
            const rec = bodyRec(newId(f.id), shape, f.id);
            const L = beads.length ? edges.reduce((acc, e) => acc + R.measureLength(e), 0) : 0;
            rec.member = { label: `Weld ${+sz.toFixed(1)}`, type: 'weld', length: +L.toFixed(1), angles: [null, null], feature: f.id, between: [A.member?.label || A.id, B.member?.label || B.id] };
            solids.push(rec);
            applied.push({ op: 'add', tool: shape });
            n0++;
          }
          if (!n0) throw new Error('None of the bodies touch each other');
          body = compoundOf(solids);
          res.notes[f.id] = `${n0} weld${n0 === 1 ? '' : 's'}, ${+total.toFixed(1)} mm of weld in all`;
          break;
        }
        case 'weldTrim': {
          // members trimmed (or extended) to a boundary: a plane, a flat face or another body
          const recs = (f.bodies || []).map((id) => solids.find((r) => r.id === id)).filter(Boolean);
          if (!recs.length) throw new Error('Select the members to trim / extend');
          let plane = null, boundary = null;
          if (f.tool && (STD[f.tool] || planes.has(f.tool))) { const fr = resolveFrame(f.tool); plane = { p: fr.o, n: fr.n }; }
          else if (f.face?.n) plane = { p: f.face.p, n: unit(f.face.n) };
          else if (f.tool) { boundary = solids.find((r) => r.id === f.tool) || surfaces.find((r) => r.id === f.tool); if (!boundary) throw new Error('The boundary body no longer exists'); }
          else throw new Error('Choose the boundary: a plane, a flat face (click it) or a body');
          const diag = bboxOfAll([...recs.map((r) => r.shape), ...(boundary ? [boundary.shape] : [])]).diag;
          const big = (p0, n) => {
            const nn = unit(n), u = unit(cross(nn, Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), w = cross(nn, u), S2 = diag * 4 + 100;
            const sq = [add(add(p0, mul(u, -S2)), mul(w, -S2)), add(add(p0, mul(u, S2)), mul(w, -S2)), add(add(p0, mul(u, S2)), mul(w, S2)), add(add(p0, mul(u, -S2)), mul(w, S2))];
            return R.basicFaceExtrusion(R.makePolygon(sq), new R.Vector(mul(nn, S2)));
          };
          let n0 = 0;
          for (const rec of recs) {
            const ax = rec.member?.axis;
            if (!ax) throw new Error(`${rec.member?.label || rec.id} is not a straight structural member`);
            const d = unit(sub(ax.b, ax.a)), mid = mul(add(ax.a, ax.b), 0.5);
            // the end toward the boundary
            const target = plane ? plane.p : bbox(boundary.shape).center;
            const toward = dot(sub(target, mid), d) >= 0 ? d : mul(d, -1);
            let sh = rec.shape;
            // extend: the end face carried on well past the boundary
            if (f.extend !== false) {
              const ts = [];
              for (const e of sh.edges) for (const t of [0, 0.5, 1]) ts.push(dot(sub(vec(e.pointAt(t)), mid), toward));
              const endAt = Math.max(...ts);
              const endFace = sh.faces.find((fc) => fc.geomType === 'PLANE' && dot(unit(vec(fc.normalAt())), toward) > 0.9999 && Math.abs(dot(sub(vec(fc.center), mid), toward) - endAt) < 1e-4);
              if (endFace) sh = unify(sh.fuse(R.basicFaceExtrusion(endFace, new R.Vector(mul(toward, diag * 2 + 10)))));
            }
            if (plane) {
              // square cut at the plane (or along it), keeping the member's side
              const side = Math.sign(dot(sub(mid, plane.p), plane.n)) || 1;
              sh = sh.cut(big(plane.p, mul(plane.n, -side)));
            } else if (f.trimType === 'cope' || ['chs', 'round'].includes(rec.member.type)) {
              const pieces = solidsOf(sh.cut(boundary.shape));
              const q = new R.DistanceQuery(R.makeVertex(mid));
              sh = pieces.sort((x, y) => q.distanceTo(x) - q.distanceTo(y))[0] || sh;
            } else {
              // square on the boundary body's near face
              const pts = [];
              for (const e of boundary.shape.edges) for (const t of [0, 0.25, 0.5, 0.75, 1]) pts.push(vec(e.pointAt(t)));
              const reach = Math.min(...pts.map((q) => dot(sub(q, mid), toward)).filter((x) => x > 0));
              if (!Number.isFinite(reach)) throw new Error(`The boundary is not ahead of ${rec.member.label}`);
              sh = sh.cut(big(add(mid, mul(toward, reach)), toward));
            }
            const one = solidsOf(sh);
            if (!one.length) throw new Error('Trimming removed a whole member');
            const q = new R.DistanceQuery(R.makeVertex(mid));
            const keep = unify(one.sort((x, y) => q.distanceTo(x) - q.distanceTo(y))[0]);
            const ts = [];
            for (const e of keep.edges) for (const t of [0, 0.5, 1]) ts.push(dot(sub(vec(e.pointAt(t)), ax.a), d));
            const recs2 = replaceSolid(rec, keep, f.id);
            for (const r2 of recs2) r2.member = { ...rec.member, length: +(Math.max(...ts) - Math.min(...ts)).toFixed(3) };
            n0++;
          }
          res.notes[f.id] = `${n0} member${n0 === 1 ? '' : 's'} trimmed / extended`;
          break;
        }
        case 'endCap': {
          // a plate on the open end of a hollow member: outside (on the end) or inside (in the end, flush)
          if (!(f.faces || []).length) throw new Error('Click the end faces of hollow members');
          const t = ev(f.thickness);
          if (!(t > 0)) throw new Error('The thickness must be greater than zero');
          let n0 = 0;
          for (const r of f.faces) {
            const hit = findFaceAny(solids, r);
            if (!hit || !r.n) throw new Error('A cap goes on a flat end face');
            const n = unit(r.n), inner = hit.face.clone().innerWires();
            let plate;
            if (f.capType === 'inside') {
              if (!inner.length) throw new Error('An inside cap needs a hollow member (its end face a ring)');
              plate = R.basicFaceExtrusion(R.makeFace(inner[0]), new R.Vector(mul(n, -t)));
            } else {
              plate = R.basicFaceExtrusion(R.makeFace(hit.face.clone().outerWire()), new R.Vector(mul(n, t)));
            }
            const rec = bodyRec(newId(f.id), plate, f.id);
            const bb = bbox(plate);
            const dims = [0, 1, 2].map((k) => bb.max[k] - bb.min[k]).sort((x, y) => y - x);
            rec.member = { label: `End cap ${+dims[0].toFixed(1)}x${+dims[1].toFixed(1)}x${+t.toFixed(1)}`, type: 'plate', length: null, angles: [null, null], feature: f.id };
            solids.push(rec);
            applied.push({ op: 'add', tool: plate });
            n0++;
          }
          body = compoundOf(solids);
          res.notes[f.id] = `${n0} end cap${n0 === 1 ? '' : 's'}`;
          break;
        }
        case 'weldGusset': {
          // a triangular plate in the corner between two flat faces (of two members)
          if ((f.faces || []).length !== 2) throw new Error('Click two flat faces that meet at a corner (one on each member)');
          const [A, B] = f.faces;
          if (!A.n || !B.n) throw new Error('A gusset needs two flat faces');
          const na = unit(A.n), nb = unit(B.n), L = cross(na, nb);
          if (len(L) < 1e-6) throw new Error('The two faces are parallel: they do not make a corner');
          const ld = unit(L);
          // a point on the line where the two planes meet, across from the picked points
          const pa = A.p, pb = B.p, da = dot(na, pa), db = dot(nb, pb), nn = dot(na, nb);
          const c1 = (da - db * nn) / (1 - nn * nn), c2 = (db - da * nn) / (1 - nn * nn);
          const base = add(mul(na, c1), mul(nb, c2));
          const q0 = add(base, mul(ld, dot(sub(mul(add(pa, pb), 0.5), base), ld)));
          const along = ev(f.offset || 0);
          const Q = add(q0, mul(ld, along));
          // each leg runs along its face, away from the corner toward the picked point
          let ua = unit(cross(ld, na)), ub = unit(cross(ld, nb));
          if (dot(sub(pa, Q), ua) < 0) ua = mul(ua, -1);
          if (dot(sub(pb, Q), ub) < 0) ub = mul(ub, -1);
          const d1 = ev(f.d1), d2 = ev(f.d2 ?? f.d1), t = ev(f.thickness), ch = ev(f.chamfer || 0);
          if (!(d1 > 0 && d2 > 0 && t > 0)) throw new Error('The leg lengths and thickness must be greater than zero');
          const pts = ch > 0 ? [add(Q, mul(ua, ch)), add(Q, mul(ua, d1)), add(Q, mul(ub, d2)), add(Q, mul(ub, ch))] : [Q, add(Q, mul(ua, d1)), add(Q, mul(ub, d2))];
          const start = (f.position === 'start' ? 0 : f.position === 'end' ? -t : -t / 2);
          const plate = R.basicFaceExtrusion(R.makePolygon(pts.map((q) => add(q, mul(ld, start)))), new R.Vector(mul(ld, t)));
          const rec = bodyRec(newId(f.id), plate, f.id);
          rec.member = { label: `Gusset ${+d1.toFixed(1)}x${+d2.toFixed(1)}x${+t.toFixed(1)}`, type: 'plate', length: null, angles: [null, null], feature: f.id };
          solids.push(rec);
          body = compoundOf(solids);
          applied.push({ op: 'add', tool: plate });
          break;
        }
        case 'structMember': {
          // Weldment structural members: a standard (or custom) profile along every segment of a sketch / 3D
          // sketch, each segment its own body; corners mitred or butted, ends on another member coped to it
          const prof = profileDims(f, ev), sec = profileSection(prof);
          const pp = piercePoint(sec.box, f.pierce || 'mc'), rot = ((f.rotate ? ev(f.rotate) : 0) * Math.PI) / 180;
          const segs = [...new Set([f.path, ...(f.paths || [])].filter(Boolean))].flatMap((id) => memberPath(id).map((g) => ({ ...g, src: id })));
          if (!segs.length) throw new Error('Select a sketch or 3D sketch with the lines (and arcs) for the members');
          const size = Math.hypot(sec.box.x1 - sec.box.x0, sec.box.y1 - sec.box.y0), ext = size * 1.5 + 1;
          const tol = Math.max(1e-4, size * 1e-5);
          const shiftSegs = (list) => list.map((g) => (g.type === 'circle' ? { ...g, c: [g.c[0] - pp[0], g.c[1] - pp[1]] } : { ...g, a: [g.a[0] - pp[0], g.a[1] - pp[1]], b: [g.b[0] - pp[0], g.b[1] - pp[1]], ...(g.m ? { m: [g.m[0] - pp[0], g.m[1] - pp[1]] } : {}) }));
          const outerSegs = shiftSegs(sec.outer), innerSegs = sec.inner ? shiftSegs(sec.inner) : null;
          // the profile's frame where a member leaves point A in direction d (its height kept upright)
          const frameAt = (A, d) => {
            let v = rej([0, 1, 0], d);
            if (len(v) < 1e-6) v = rej(f.vertRef === 'x' ? [1, 0, 0] : [0, 0, -1], d);
            v = unit(v);
            let u = cross(v, d);
            if (rot) { const c = Math.cos(rot), sn = Math.sin(rot), u2 = add(mul(u, c), mul(v, sn)), v2 = add(mul(v, c), mul(u, -sn)); u = u2; v = v2; }
            if (f.mirror) u = mul(u, -1);
            return { o: A, u, v, n: d };
          };
          const faceAt = (fr, withHole) => {
            let face = R.makeFace(loopWire(fr, outerSegs));
            if (withHole && innerSegs) face = R.addHolesInFace(face, [loopWire(fr, innerSegs)]);
            return face;
          };
          // the members' ends and how they meet
          const ms = segs.map((g, i) => ({ i, g, line: g.type === 'line', ends: [g.a, g.b], out: g.type === 'line' ? [unit(sub(g.a, g.b)), unit(sub(g.b, g.a))] : [mul(g.t0, -1), g.t1], trim: [null, null], cut: [0, 0] }));
          const near = (x, y) => len(sub(x, y)) < tol;
          const groups = [];
          for (const m of ms) for (const k of [0, 1]) {
            const q = m.ends[k];
            let gr = groups.find((x) => near(x.p, q));
            if (!gr) groups.push((gr = { p: q, ends: [] }));
            gr.ends.push({ m, k });
          }
          const corner = f.corner || 'mitre';
          // a corner between two ends: mitred or butted
          const cornerPair = (E1, E2, gr) => {
            const straight = dot(E1.m.out[E1.k], E2.m.out[E2.k]) < -0.9999;
            if (straight || !E1.m.line || !E2.m.line) return;
            if (corner === 'mitre') {
              const n = unit(sub(mul(E1.m.out[E1.k], -1), mul(E2.m.out[E2.k], -1)));
              E1.m.trim[E1.k] = { kind: 'plane', p: gr.p, n }; E2.m.trim[E2.k] = { kind: 'plane', p: gr.p, n: mul(n, -1) };
            } else {
              const [T, C] = corner === 'butt1' ? [E1, E2] : [E2, E1];
              T.m.trim[T.k] = { kind: 'cope', hosts: [C.m], p: gr.p };
              C.m.trim[C.k] = { kind: 'cover', other: T.m, p: gr.p };
            }
          };
          for (const gr of groups) {
            if (gr.ends.length >= 3 && corner !== 'none') {
              // e.g. a table's corner: the two rails of one sketch make the corner, the leg is trimmed to both
              const bySrc = new Map();
              for (const E of gr.ends) { if (!bySrc.has(E.m.g.src)) bySrc.set(E.m.g.src, []); bySrc.get(E.m.g.src).push(E); }
              const pair = [...bySrc.values()].find((l) => l.length === 2);
              if (pair) {
                cornerPair(pair[0], pair[1], gr);
                for (const E of gr.ends) if (!pair.includes(E) && E.m.line) E.m.trim[E.k] = { kind: 'cope', hosts: pair.map((x) => x.m), p: gr.p };
              }
              continue;
            }
            if (gr.ends.length === 2 && corner !== 'none') {
              cornerPair(gr.ends[0], gr.ends[1], gr);
              continue;
            }
            if (gr.ends.length === 1) {
              // an end on the middle of another member: coped to it
              const E = gr.ends[0];
              const host = ms.find((o) => o !== E.m && o.line && (() => { const ab = sub(o.g.b, o.g.a), L2 = dot(ab, ab), t = dot(sub(gr.p, o.g.a), ab) / L2; return t > 1e-6 && t < 1 - 1e-6 && len(sub(gr.p, add(o.g.a, mul(ab, t)))) < tol; })());
              if (host && E.m.line) E.m.trim[E.k] = { kind: 'cope', hosts: [host], p: gr.p };
            }
          }
          // solids: extended at the ends to be trimmed (and the envelope of each, the profile filled, for coping)
          const halfSpace = (p0, n) => {
            const nn = unit(n), u = unit(cross(nn, Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), w = cross(nn, u), S2 = size * 4 + len(sub(segs[0].a, segs[0].b)) * 2 + 100;
            const sq = [add(add(p0, mul(u, -S2)), mul(w, -S2)), add(add(p0, mul(u, S2)), mul(w, -S2)), add(add(p0, mul(u, S2)), mul(w, S2)), add(add(p0, mul(u, -S2)), mul(w, S2))];
            return R.basicFaceExtrusion(R.makePolygon(sq), new R.Vector(mul(nn, S2)));
          };
          for (const m of ms) {
            if (m.line) {
              const d = unit(sub(m.g.b, m.g.a)), L = len(sub(m.g.b, m.g.a));
              const e0 = m.trim[0] ? ext : 0, e1 = m.trim[1] ? ext : 0;
              const fr = frameAt(sub(m.g.a, mul(d, e0)), d);
              m.d = d; m.L = L; m.fr = frameAt(m.g.a, d);
              m.solid = R.basicFaceExtrusion(faceAt(fr, true), new R.Vector(mul(d, L + e0 + e1)));
              m.env = R.basicFaceExtrusion(faceAt(fr, false), new R.Vector(mul(d, L + e0 + e1)));
              m.env0 = R.basicFaceExtrusion(faceAt(m.fr, false), new R.Vector(mul(d, L))); // (to the sketch ends)
            } else {
              // an arc: swept (no end trimming)
              const fr = frameAt(m.g.a, m.g.t0), spine = m.g.wire;
              const sw = (w) => { for (const tm of ['right', 'round', 'transformed']) { try { return R.genericSweep(w, spine, { frenet: false, transitionMode: tm }); } catch (e) { if (isFatal(e)) throw e; } } throw new Error('A curved member could not be swept'); };
              m.env = sw(loopWire(fr, outerSegs));
              m.solid = innerSegs ? m.env.cut(sw(loopWire(fr, innerSegs))) : m.env;
              m.env0 = m.env; m.L = m.g.length;
            }
          }
          for (const m of ms) for (const k of [0, 1]) {
            const tr = m.trim[k];
            if (!tr) continue;
            if (tr.kind === 'plane') {
              m.solid = m.solid.cut(halfSpace(tr.p, mul(tr.n, -1)));
              m.cut[k] = +((Math.acos(Math.min(1, Math.abs(dot(tr.n, m.d)))) * 180) / Math.PI).toFixed(2); // (0: square)
            } else if (tr.kind === 'cover') {
              // runs on over the trimmed member: to the far side of its section
              const o = m.out[k], ends = [];
              for (const e of tr.other.env0.edges) for (const t of [0, 0.5, 1]) ends.push(vec(e.pointAt(t)));
              const reach = Math.max(0, ...ends.map((q) => dot(sub(q, tr.p), o)));
              m.solid = m.solid.cut(halfSpace(add(tr.p, mul(o, reach)), o));
            } else if (tr.kind === 'cope' && f.trim !== 'cope' && prof.type !== 'chs' && prof.type !== 'round') {
              // a square cut on the face of the member it meets (as cut in the shop)
              const o = m.out[k], toward = mul(o, -1), pts = [];
              for (const h of tr.hosts) for (const e of h.env0.edges) for (const t of [0, 0.25, 0.5, 0.75, 1]) pts.push(vec(e.pointAt(t)));
              const reach = Math.max(...pts.map((q) => dot(sub(q, tr.p), toward)));
              m.solid = m.solid.cut(halfSpace(sub(tr.p, mul(o, reach)), o));
              m.cut[k] = 0;
            } else if (tr.kind === 'cope') {
              // coped: cut to the outside of the member it meets (e.g. a fish-mouth on a pipe)
              const mid = add(m.g.a, mul(sub(m.g.b, m.g.a), 0.5));
              let cutBy = tr.hosts[0].env;
              for (const h of tr.hosts.slice(1)) cutBy = cutBy.fuse(h.env);
              const pieces = solidsOf(m.solid.cut(cutBy));
              const keep = pieces.sort((x, y) => new R.DistanceQuery(R.makeVertex(mid)).distanceTo(x) - new R.DistanceQuery(R.makeVertex(mid)).distanceTo(y))[0];
              if (keep) m.solid = keep;
              m.cut[k] = null; // (a coped end)
            }
          }
          // one body per member
          for (const m of ms) {
            const sh = unify(m.solid);
            let length = m.L;
            if (m.line) {
              const ts = [];
              for (const e of sh.edges) for (const t of [0, 0.5, 1]) ts.push(dot(sub(vec(e.pointAt(t)), m.g.a), m.d));
              length = Math.max(...ts) - Math.min(...ts);
            }
            const rec = bodyRec(newId(f.id), sh, f.id);
            rec.member = { label: prof.label, type: prof.type, length: +length.toFixed(3), angles: m.cut.map((x) => (x === null ? null : +x)), feature: f.id, ...(m.line ? { axis: { a: m.g.a, b: m.g.b } } : {}), size };
            solids.push(rec);
            applied.push({ op: 'add', tool: sh });
          }
          body = compoundOf(solids);
          res.notes[f.id] = `${ms.length} member${ms.length === 1 ? '' : 's'}: ${prof.label}`;
          break;
        }
        case 'surfOffset': {
          if (!f.faces?.length) throw new Error('Select faces on the model to offset');
          const dd = ev(f.distance) * (f.flip ? -1 : 1);
          const hits = f.faces.map((r) => findFaceAny([...solids, ...surfaces], r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          const parts = hits.map((h) => (Math.abs(dd) < 1e-12 ? h.face.clone() : offsetFace(h.face, dd)));
          const shape = asShape(parts);
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'surfCopy': {
          // copies of picked faces (of solids or surfaces) as new surface bodies; the bodies are left as they are
          if (!f.faces?.length) throw new Error('Select faces on the model to copy');
          const hits = f.faces.map((r) => findFaceAny([...solids, ...surfaces], r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          const oc = R.getOC();
          // (shapes are never changed in place, so the copies can share the faces' geometry; a face picked twice once)
          const picked = [];
          for (const h of hits) if (!picked.some((x) => x.isSame(h.face))) picked.push(h.face);
          const copies = picked.map((fc) => fc.clone());
          const out = [];
          if (f.knit !== false && copies.length > 1) {
            // faces that touch along an edge become one surface body (separate patches stay separate)
            const sw = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
            for (const c of copies) sw.Add(c.wrapped);
            sw.Perform(new oc.Message_ProgressRange());
            const sewn = R.cast(sw.SewedShape());
            sw.delete();
            const shells = [...R.iterTopo(sewn.wrapped, 'shell')].map((s) => R.cast(s));
            const loose = [...R.iterTopo(sewn.wrapped, 'face')].map((x) => R.cast(x)).filter((fc) => !shells.some((s) => s.faces.some((g) => g.isSame(fc))));
            out.push(...shells, ...loose);
          } else out.push(...copies);
          for (const s of out) {
            surfaces.push(bodyRec(newId(f.id), s, f.id));
            applied.push({ op: 'add', tool: s });
          }
          res.notes[f.id] = `${picked.length} face${picked.length === 1 ? '' : 's'} copied · ${out.length} surface bod${out.length === 1 ? 'y' : 'ies'}`;
          break;
        }
        case 'knit': {
          if ((f.bodies || []).length < 1) throw new Error('Select the surface bodies to knit');
          const recs = f.bodies.map((id) => needBody(id, 'surface body'));
          if (recs.some((r) => !surfaces.includes(r))) throw new Error('Only surface bodies can be knit');
          const oc = R.getOC();
          const sw = new oc.BRepBuilderAPI_Sewing(Math.max(1e-6, ev(f.tolerance ?? 0.01)), true, true, true, false);
          for (const r of recs) sw.Add(r.shape.wrapped);
          sw.Perform(new oc.Message_ProgressRange());
          const sewn = R.cast(sw.SewedShape());
          const free = sw.NbFreeEdges();
          sw.delete();
          surfaces = surfaces.filter((r) => !recs.includes(r));
          if (f.solid && free === 0) {
            const shells = [...R.iterTopo(sewn.wrapped, 'shell')];
            if (shells.length !== 1) throw new Error('The knit surfaces do not form a single closed volume');
            const ms = new oc.BRepBuilderAPI_MakeSolid(shells[0]);
            const solid = R.cast(ms.Solid());
            ms.delete();
            oc.BRepLib.OrientClosedSolid(solid.wrapped);
            apply('add', unify(solid), f.merge !== false);
          } else {
            surfaces.push(bodyRec(recs[0].id, sewn, f.id));
            applied.push({ op: 'add', tool: sewn });
            if (f.solid) throw new Error(`The surfaces are not closed (${free} open edge${free === 1 ? '' : 's'}), so no solid was made`);
          }
          break;
        }
        case 'surfSolid': {
          // surfaces that enclose a volume (and meshes such as STL imports) made into one solid
          if (!(f.bodies || []).length) throw new Error('Select the surface bodies that enclose the volume');
          const recs = f.bodies.map((id) => needBody(id, 'surface body'));
          if (recs.some((r) => !surfaces.includes(r))) throw new Error('Only surface bodies can be converted (a solid already is one)');
          const tol = ev(f.tolerance ?? 0.01);
          if (!(tol > 0)) throw new Error('The gap tolerance must be greater than zero');
          if (recs.every((r) => r.mesh) || isMeshLike(recs.map((r) => r.shape))) {
            // a mesh (flat faces only, e.g. an STL): points within the tolerance welded, triangles turned
            // the same way round, and closed only when every edge joins two triangles
            progress(null, 'Joining the triangles…');
            const { P, T } = meshTris(recs.map((r) => r.shape), tol);
            const rp = repairTris(P, T, { fill: false });
            if (rp.openEdges) throw new Error(`The mesh does not close: ${rp.openEdges} open edge${rp.openEdges === 1 ? '' : 's'} round ${rp.holes + rp.chains} hole${rp.holes + rp.chains === 1 ? '' : 's'}. Raise the gap tolerance, or close the holes with Repair Mesh.`);
            if (rp.nonManifold) throw new Error(`The mesh has ${rp.nonManifold} edge${rp.nonManifold === 1 ? '' : 's'} shared by more than two triangles, so it is not one closed volume`);
            const built = meshShape(P, rp.T);
            if (!built.closed) throw new Error('The mesh closes, but not as one volume');
            surfaces = surfaces.filter((r) => !recs.includes(r));
            apply('add', built.shape, f.merge === true);
            res.notes[f.id] = `Solid of ${+R.measureVolume(built.shape).toFixed(3)} mm³ from ${rp.T.length} triangle${rp.T.length === 1 ? '' : 's'}` + (rp.flipped ? ` · ${rp.flipped} turned the right way round` : '');
            break;
          }
          progress(null, 'Sewing the surfaces…');
          const sewn = sewShapes(recs.map((r) => r.shape), tol);
          const { loops, open, freeEdges } = holeLoops(sewn);
          if (freeEdges) {
            const big = Math.max(0, ...loops.map((l) => l.size));
            throw new Error(`The surfaces do not close: ${freeEdges} open edge${freeEdges === 1 ? '' : 's'} round ${loops.length + open.length} gap${loops.length + open.length === 1 ? '' : 's'}${loops.length ? ` (the largest ${+big.toFixed(2)} mm across)` : ''}. Raise the gap tolerance, or close the holes with Repair Mesh.`);
          }
          const solid = solidFromSewn(sewn);
          if (!solid) throw new Error('The surfaces close, but not as one volume (several shells, or they cross themselves)');
          surfaces = surfaces.filter((r) => !recs.includes(r));
          apply('add', unify(solid), f.merge === true);
          res.notes[f.id] = `Solid of ${+R.measureVolume(solid).toFixed(3)} mm³ from ${solid.faces.length} face${solid.faces.length === 1 ? '' : 's'}`;
          break;
        }
        case 'meshRepair': {
          // close the holes of a surface body (e.g. an STL with small missing pieces), then make it a solid
          if (!(f.bodies || []).length) throw new Error('Select the surface body (mesh) to repair');
          const recs = f.bodies.map((id) => needBody(id, 'surface body'));
          if (recs.some((r) => !surfaces.includes(r))) throw new Error('Select surface bodies (a solid is already closed)');
          const tol = ev(f.tolerance ?? 0.01), maxHole = ev(f.maxHole ?? 0);
          if (!(tol > 0)) throw new Error('The gap tolerance must be greater than zero');
          if (!(maxHole >= 0)) throw new Error('The largest hole can\'t be negative');
          const pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
          if (recs.every((r) => r.mesh) || isMeshLike(recs.map((r) => r.shape))) {
            progress(null, 'Repairing the mesh…');
            const { P, T } = meshTris(recs.map((r) => r.shape), tol);
            const rp = repairTris(P, T, { maxHole });
            const built = meshShape(P, rp.T);
            surfaces = surfaces.filter((r) => !recs.includes(r));
            const solid = f.solid !== false && built.closed ? built.shape : null;
            if (solid) apply('add', solid, f.merge === true);
            else { const rec = bodyRec(recs[0].id, built.shape, f.id); rec.mesh = true; surfaces.push(rec); applied.push({ op: 'add', tool: built.shape }); }
            const parts = [rp.holes ? `${pl(rp.filled, 'hole')} closed` : 'No holes found'];
            if (rp.tooBig) parts.push(`${rp.tooBig} larger than ${+maxHole.toFixed(3)} mm left open`);
            if (rp.failed) parts.push(`${rp.failed} could not be closed`);
            if (rp.chains) parts.push(`${pl(rp.chains, 'open edge chain')} not round a hole`);
            if (rp.flipped) parts.push(`${pl(rp.flipped, 'triangle')} turned the right way round`);
            if (rp.nonManifold) parts.push(`${pl(rp.nonManifold, 'edge')} shared by more than two triangles`);
            parts.push(solid ? `solid of ${+R.measureVolume(solid).toFixed(3)} mm³` : built.open ? `still ${pl(built.open, 'open edge')}: kept as a surface body` : f.solid === false ? 'closed (kept as a surface body)' : 'closed, but not as one volume: kept as a surface body');
            res.notes[f.id] = parts.join(' · ');
            break;
          }
          progress(null, 'Sewing the surfaces…');
          let sewn = sewShapes(recs.map((r) => r.shape), tol);
          const { loops, open } = holeLoops(sewn);
          const patches = [];
          let filled = 0, tooBig = 0, failed = 0;
          progress(null, `Closing ${loops.length} hole${loops.length === 1 ? '' : 's'}…`);
          for (const loop of loops) {
            if (maxHole > 0 && loop.size > maxHole) { tooBig++; continue; }
            let faces = null;
            try { faces = holePatch(loop, tol); } catch (e) { if (isFatal(e)) throw e; faces = null; }
            if (!faces?.length) { failed++; continue; }
            patches.push(...faces);
            filled++;
          }
          if (patches.length) sewn = sewShapes([sewn, ...patches], tol);
          const left = holeLoops(sewn);
          surfaces = surfaces.filter((r) => !recs.includes(r));
          let solid = null;
          if (f.solid !== false && !left.freeEdges) solid = solidFromSewn(sewn);
          if (solid) apply('add', unify(solid), f.merge === true);
          else { surfaces.push(bodyRec(recs[0].id, sewn, f.id)); applied.push({ op: 'add', tool: sewn }); }
          const parts = [`${pl(filled, 'hole')} closed`];
          if (tooBig) parts.push(`${tooBig} larger than ${+maxHole.toFixed(3)} mm left open`);
          if (failed) parts.push(`${failed} could not be closed`);
          if (open.length) parts.push(`${pl(open.length, 'dangling edge chain')} (not round a hole)`);
          parts.push(solid ? `solid of ${+R.measureVolume(solid).toFixed(3)} mm³` : left.freeEdges ? `still ${pl(left.freeEdges, 'open edge')}: kept as a surface body` : f.solid === false ? 'closed (kept as a surface body)' : 'closed, but not as one volume: kept as a surface body');
          res.notes[f.id] = parts.join(' · ');
          if (!loops.length && !open.length) res.notes[f.id] = solid ? `No holes found · solid of ${+R.measureVolume(solid).toFixed(3)} mm³` : 'No holes found';
          break;
        }
        case 'thicken': {
          if (!f.body) throw new Error('Click the surface body to thicken');
          const rec = needBody(f.body, 'surface body');
          if (!surfaces.includes(rec)) throw new Error('Select a surface body to thicken');
          const t = ev(f.thickness);
          if (t <= 0) throw new Error('Thickness must be greater than zero');
          const oc = R.getOC();
          let src = rec.shape;
          if (f.side === 'both') src = offsetFace(src, f.flip ? t / 2 : -t / 2);
          const mk = new oc.BRepOffsetAPI_MakeThickSolid();
          mk.MakeThickSolidBySimple(src.wrapped, f.side === 'both' ? (f.flip ? -t : t) : f.flip ? -t : t);
          const solid = R.cast(mk.Shape());
          mk.delete();
          if (!solidsOf(solid).length) throw new Error('The surface could not be thickened');
          surfaces = surfaces.filter((r) => r !== rec);
          // each solid facing out: thickened one way the solid can come out inside-out (negative volume),
          // and then Combine / cuts with it give the material round it instead (OrientClosedSolid can't
          // turn it round through the binding, so it is reversed here)
          for (const sol of solidsOf(solid)) {
            oc.BRepLib.OrientClosedSolid(sol.wrapped);
            apply('add', R.measureVolume(sol) < 0 ? R.cast(sol.wrapped.Reversed()) : sol, f.merge !== false);
          }
          break;
        }
        case 'helix': {
          // the sketch's circle gives the axis (its normal), the centre and the diameter
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('Select a sketch with a circle (it sets the helix axis and diameter)');
          const circ = s.sk.curves.find((c) => (c.type === 'circle' || c.type === 'arc') && !c.construction) || s.sk.curves.find((c) => c.type === 'circle' || c.type === 'arc');
          if (!circ) throw new Error('The sketch needs a circle: its centre and diameter set the helix axis and size');
          const fr = s.frame, C = S.getPoint(s.sk, circ.c), r = S.radiusOf(s.sk, circ);
          const c0 = S.fromFrame2D(fr, C.x, C.y), d = f.reverse ? mul(fr.n, -1) : fr.n;
          let pitch = ev(f.pitch), revs = ev(f.revolutions), height = ev(f.height);
          if (f.definedBy === 'pitchHeight') revs = height / pitch;
          else if (f.definedBy === 'heightRev') pitch = height / revs;
          else height = pitch * revs;
          if (!(pitch > 0) || !(revs > 0) || !(height > 0)) throw new Error('Pitch, revolutions and height must be greater than zero');
          if (revs > 1000) throw new Error('Too many revolutions (max 1000)');
          let w = R.makeHelix(pitch, height, r, c0, d, !!f.clockwise);
          // start angle measured from the sketch's horizontal direction, about the axis
          const sp = vec(w.startPoint), e = unit(rej(sub(sp, c0), d));
          const a = ((ev(f.startAngle) || 0) * Math.PI) / 180;
          const t = add(mul(fr.u, Math.cos(a)), mul(cross(d, fr.u), Math.sin(a)));
          const turn = (Math.atan2(dot(cross(e, t), d), dot(e, t)) * 180) / Math.PI;
          if (Math.abs(turn) > 1e-9) w = w.rotate(turn, c0, d);
          curves.set(f.id, { wire: w, axis: { o: c0, d }, r, pitch, height });
          const n = Math.min(6000, Math.ceil(revs * 64) + 1), edge = w.edges[0];
          res.curves[f.id] = Array.from({ length: n + 1 }, (_, i) => vec(edge.pointAt(i / n)));
          res.notes[f.id] = `Pitch ${+pitch.toFixed(4)} mm · ${+revs.toFixed(3)} revolutions · height ${+height.toFixed(3)} mm · Ø${+(2 * r).toFixed(3)} mm`;
          break;
        }
        case 'sketch3d': {
          // a 3D sketch: points anywhere in space and lines between them. Each connected run of lines is one
          // curve: straight runs (rounded at the corners by the bend radius, e.g. a pipe or duct route) or a
          // smooth spline through its points. (Older 3D sketches: a list of points joined in order.)
          const coords = (q, i) => {
            const v = [ev(q.x ?? 0), ev(q.y ?? 0), ev(q.z ?? 0)];
            if (!v.every(Number.isFinite)) throw new Error(`Point ${i + 1} has an invalid coordinate`);
            return v;
          };
          // converted entities follow the model's edges: their fixed points (and circle radii) are taken from the
          // edges found again now, and the sketch is solved so what is attached to them follows too
          let fresh = null;
          if (Array.isArray(f.segs) && f.segs.some((g) => g.link)) {
            normalize3d(f, ev);
            const fixOf = (g, pid) => f.rels.find((r) => r.type === 'fix' && r.link === g.id && r.refs[0] === pid);
            const setFix = (g, pid, q) => { const r = fixOf(g, pid); if (r) r.value = q.map((x) => Math.round(x * 1e6) / 1e6); };
            const was = (g, pid) => fixOf(g, pid)?.value || null;
            const lost = [];
            for (const g of f.segs) {
              if (!g.link) continue;
              const e = body ? findEdge(body, g.link) : null;
              if (!e) { lost.push(g.id); continue; }
              updateEdgeRef(g.link, e, body);
              const A = vec(e.startPoint), B = vec(e.endPoint);
              const flipOf = (pid) => { const o = was(g, pid); return o ? len(sub(B, o)) < len(sub(A, o)) : false; };
              if (g.type === 'circle') {
                const ci = circleOf(e);
                if (ci) { setFix(g, g.c, ci.c); g.r = ci.r; g.n = dot(ci.n, g.n) < 0 ? mul(ci.n, -1) : ci.n; const rr = f.rels.find((r) => r.type === 'radius' && r.link === g.id); if (rr) rr.value = ci.r; }
              } else if (g.type === 'arc') {
                const flip = flipOf(g.a);
                setFix(g, g.a, flip ? B : A); setFix(g, g.b, flip ? A : B);
                const ci = circleOf(e);
                if (ci) { setFix(g, g.c, ci.c); g.n = dot(ci.n, g.n) < 0 ? mul(ci.n, -1) : ci.n; }
              } else if (g.type === 'spline') {
                const k = g.pts.length, flip = flipOf(g.pts[0]), end = g.closed ? k : k - 1;
                g.pts.forEach((pid, i) => setFix(g, pid, vec(e.pointAt(flip ? 1 - i / end : i / end))));
              } else {
                const flip = flipOf(g.a);
                setFix(g, g.a, flip ? B : A); setFix(g, g.b, flip ? A : B);
              }
            }
            for (const r of f.rels) if (r.type === 'fix' && r.link) { const q = f.pts.find((x) => x.id === r.refs[0]); if (q) [q.x, q.y, q.z] = r.value; }
            const solvedOk = solve3d(f, ev).ok;
            fresh = {
              pts: f.pts.map((q) => ({ id: q.id, x: q.x, y: q.y, z: q.z })),
              radii: Object.fromEntries(f.segs.filter((g) => g.type === 'circle').map((g) => [g.id, g.r])),
              normals: Object.fromEntries(f.segs.filter((g) => g.n).map((g) => [g.id, g.n])),
              values: Object.fromEntries(f.rels.filter((r) => r.link).map((r) => [r.id, r.value])),
              links: Object.fromEntries(f.segs.filter((g) => g.link).map((g) => [g.id, g.link])),
            };
            if (!solvedOk) fresh.warn = 'the converted edges moved where the sketch\'s relations can\'t follow';
            if (lost.length) fresh.warn = `${lost.length} converted edge${lost.length === 1 ? ' is' : 's are'} no longer in the model (kept where ${lost.length === 1 ? 'it was' : 'they were'})`;
          }
          const P = (f.pts || []).map(coords);
          res.detected[f.id] = { pts: P, ...(fresh ? { s3: fresh } : {}) };
          let chains = [];
          const closedSplines = [];
          const circles3d = [];
          // an arc's middle point (counterclockwise round its normal from a to b)
          const arcMid = (g, at) => {
            const Cc = at.get(g.c), A = at.get(g.a), B = at.get(g.b), n = unit(g.n);
            const u = sub(A, Cc), w = sub(B, Cc);
            let th = Math.atan2(dot(n, cross(u, w)), dot(u, w));
            if (th <= 1e-9) th += 2 * Math.PI;
            const h = th / 2, c = Math.cos(h), s = Math.sin(h), k = dot(n, u), nu = cross(n, u);
            return u.map((x, i) => Cc[i] + x * c + nu[i] * s + n[i] * k * (1 - c));
          };
          if (!Array.isArray(f.segs)) chains = [{ Q: P, closed: !!f.closed }];
          else {
            const at = new Map((f.pts || []).map((q, i) => [q.id, P[i]]));
            // (construction geometry shapes the sketch but makes no curve; circles are curves of their own)
            for (const g of f.segs) if (!g.construction && g.type === 'spline' && g.closed && g.pts.every((x) => at.has(x)) && g.pts.length > 2) closedSplines.push(g);
            const segs = f.segs
              .filter((g) => !g.construction && g.type !== 'circle' && !(g.type === 'spline' && g.closed))
              .map((g) => (g.type === 'spline' ? { ...g, a: g.pts[0], b: g.pts[g.pts.length - 1] } : g))
              .filter((g) => at.has(g.a) && at.has(g.b) && g.a !== g.b && (g.type !== 'arc' || at.has(g.c)) && (g.type !== 'spline' || g.pts.every((x) => at.has(x))));
            for (const g of f.segs) if (!g.construction && g.type === 'circle' && at.has(g.c) && g.r > 0) circles3d.push({ C: at.get(g.c), r: g.r, n: unit(g.n) });
            const ends = new Map();
            segs.forEach((g, k) => { for (const id of [g.a, g.b]) { if (!ends.has(id)) ends.set(id, []); ends.get(id).push(k); } });
            const used = new Set();
            // walk from a point along unused lines while the way on is clear (a point with two lines)
            const walk = (start, k0) => {
              const ids = [start], ks = [];
              let cur = start, k = k0;
              for (;;) {
                used.add(k);
                ks.push(k);
                const g = segs[k], next = g.a === cur ? g.b : g.a;
                if (next === start) return { ids, ks, closed: true };
                ids.push(next);
                cur = next;
                const on = ends.get(cur);
                if (on.length !== 2) break;
                k = on.find((x) => !used.has(x));
                if (k === undefined) break;
              }
              return { ids, ks, closed: false };
            };
            for (const [id, ks] of ends) if (ks.length !== 2) for (const k of ks) if (!used.has(k)) chains.push(walk(id, k));
            for (let k = 0; k < segs.length; k++) if (!used.has(k)) chains.push(walk(segs[k].a, k));
            chains = chains.map((c) => ({ Q: c.ids.map((id) => at.get(id)), closed: c.closed, segs: c.ks.map((k) => segs[k]), ids: c.ids }));
            chains.at = at;
          }
          const buildRoute = (P0, closed0) => {
            // (repeated points dropped)
            const Q = P0.filter((q, i) => !i || len(sub(q, P0[i - 1])) > 1e-9);
            const closed = !!closed0 && Q.length > 2;
            if (closed && len(sub(Q[0], Q[Q.length - 1])) < 1e-9) Q.pop();
            if (Q.length < 2) throw new Error('A 3D sketch needs at least two different points');
            let wire, edgesOut = [];
            if (f.kind === 'spline') {
              if (Q.length < 3) {
                wire = R.assembleWire([R.makeLine(Q[0], Q[1])]);
              } else if (!closed) {
                wire = R.assembleWire([R.makeBSplineApproximation(Q, { tolerance: 1e-4, degMin: 3, degMax: 5, smoothing: null })]);
              } else {
                // closed: cubic pieces through the points, each point's tangent along the chord of its
                // neighbours, so it runs smoothly all the way round (no kink where it closes)
                const m = Q.length, at = (i) => Q[((i % m) + m) % m];
                const tg = (i) => unit(sub(at(i + 1), at(i - 1)));
                wire = R.assembleWire(Q.map((q, i) => {
                  const b = at(i + 1), d = len(sub(b, q)) / 3;
                  return R.makeBezierCurve([q, add(q, mul(tg(i), d)), sub(b, mul(tg(i + 1), d)), b]);
                }));
              }
            } else {
              const Rb = ev(f.radius ?? 0);
              if (!(Rb >= 0)) throw new Error('The bend radius can\'t be negative');
              const V = closed ? [...Q, Q[0]] : Q, n = V.length;
              // the corner at point k (k = 0: where a closed loop meets itself): how far its bend takes from
              // the runs on either side (R tan(θ/2)) and the bend itself
              const corner = (k) => {
                if (!(Rb > 0)) return null;
                if (k === 0 && !closed) return null;
                if (k === n - 1) return null;
                const prev = k === 0 ? V[n - 2] : V[k - 1], at = V[k], next = V[k + 1];
                const d1 = unit(sub(at, prev)), d2 = unit(sub(next, at));
                const th = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
                if (th < 1e-6) return null;
                if (th > Math.PI - 1e-6) throw new Error(`The route turns right back on itself at point ${k + 1}`);
                const s = Rb * Math.tan(th / 2);
                const T1 = sub(at, mul(d1, s)), T2 = add(at, mul(d2, s));
                const ctr = add(at, mul(unit(sub(d2, d1)), Rb / Math.cos(th / 2)));
                return { s, arc: () => R.makeThreePointArc(T1, add(ctr, mul(unit(sub(at, ctr)), Rb)), T2) };
              };
              const C = V.map((_, k) => corner(k));
              for (let i = 0; i < n - 1; i++) {
                const a = V[i], b = V[i + 1], L = len(sub(b, a)), d = unit(sub(b, a));
                const cs = C[i], ce = i + 1 === n - 1 ? (closed ? C[0] : null) : C[i + 1];
                const s0 = cs?.s || 0, s1 = ce?.s || 0;
                if (s0 + s1 > L + 1e-9) throw new Error(`The bend radius is too big for the run from point ${i + 1} to point ${i + 2 > Q.length ? 1 : i + 2} (${+L.toFixed(3)} mm long)`);
                const pa = add(a, mul(d, s0)), pb = sub(b, mul(d, s1));
                if (len(sub(pb, pa)) > 1e-9) edgesOut.push(R.makeLine(pa, pb));
                if (ce) edgesOut.push(ce.arc());
              }
              wire = R.assembleWire(edgesOut);
            }
            return { wire, edgesOut, Q };
          };
          if (!chains.length && !circles3d.length && !closedSplines.length) {
            res.notes[f.id] = (f.pts || []).length ? `${f.pts.length} point${f.pts.length === 1 ? '' : 's'}, no lines` : 'Empty 3D sketch';
            break;
          }
          // runs with arcs: each line and arc as it is (the bend radius rounds runs of lines only)
          const routes = chains.map((c) => {
            if (!c.segs?.some((g) => g.type === 'arc' || g.type === 'spline')) return buildRoute(c.Q, c.closed);
            const at = chains.at, edgesOut = [];
            c.segs.forEach((g, i) => {
              const A = at.get(c.ids[i]), B = at.get(c.ids[(i + 1) % c.ids.length]);
              if (g.type === 'arc') edgesOut.push(R.makeThreePointArc(A, arcMid(g, at), B));
              else if (g.type === 'spline') {
                // (walked from its last point: the pieces the other way round)
                const fwd = c.ids[i] === g.pts[0];
                const pieces = splineGeom(f, g).pieces;
                for (const q of fwd ? pieces : pieces.slice().reverse()) edgesOut.push(R.makeBezierCurve(fwd ? q : q.slice().reverse()));
              } else if (len(sub(B, A)) > 1e-9) edgesOut.push(R.makeLine(A, B));
            });
            return { wire: R.assembleWire(edgesOut), edgesOut, Q: c.Q };
          });
          for (const ci of circles3d) routes.push({ wire: R.assembleWire([R.makeCircle(ci.r, ci.C, ci.n)]), edgesOut: [], Q: [] });
          for (const g of closedSplines) routes.push({ wire: R.assembleWire(splineGeom(f, g).pieces.map((q) => R.makeBezierCurve(q))), edgesOut: [], Q: [] });
          curves.set(f.id, { wire: routes[0].wire, wires: routes.map((r) => r.wire), route: true });
          // drawn as polylines (curves finely)
          const shownAll = routes.map(({ wire }) => {
            const shown = [];
            for (const e of wire.edges) {
              const m = e.geomType === 'LINE' ? 1 : 24;
              for (let i = shown.length ? 1 : 0; i <= m; i++) shown.push(vec(e.pointAt(i / m)));
            }
            return shown;
          });
          res.curves[f.id] = shownAll.length === 1 ? shownAll[0] : shownAll;
          const L = routes.reduce((t, r) => t + R.measureLength(r.wire), 0);
          const bends = routes.reduce((t, r) => t + r.edgesOut.filter((e) => e.geomType !== 'LINE').length, 0);
          res.notes[f.id] = `${P.length} points · ${routes.length > 1 ? routes.length + ' curves · ' : ''}length ${+L.toFixed(3)} mm` + (f.kind === 'spline' ? ' (spline)' : bends ? ` · ${bends} bend${bends === 1 ? '' : 's'}` : '') + (fresh?.warn ? ' — ' + fresh.warn : '');
          break;
        }
        case 'sweep': {
          // the path: a helix or a 3D sketch, or one connected chain of curves in a sketch
          let spine, helical = false;
          if (curves.has(f.path)) { spine = curves.get(f.path).wire; helical = !curves.get(f.path).route; }
          else {
            const ps = f.path && sketches.get(f.path);
            if (!ps) throw new Error('Select the path: a sketch (one chain of curves) or a helix');
            const ws = sketchWires(ps.sk, ps.frame);
            if (ws.length !== 1) throw new Error('The path sketch must be one connected chain of curves');
            spine = ws[0];
          }
          const start = vec(spine.startPoint), tan0 = unit(vec(spine.tangentAt(0)));
          let profiles;
          if (f.profileType === 'circle') {
            const dia = ev(f.diameter);
            if (!(dia > 0)) throw new Error('The diameter must be greater than zero');
            profiles = [{ outer: R.assembleWire([R.makeCircle(dia / 2, start, tan0)]), holes: [] }];
          } else {
            if (f.profile === f.path) throw new Error('The profile and the path must be different sketches');
            const sk = getSketch(f.profile, f.thin ? { t: ev(f.thinT), dir: f.thinDir || 'one' } : null);
            profiles = sk.regions.map((rg) => ({ outer: loopWire(sk.frame, rg.outer.segs), holes: rg.holes.map((h) => loopWire(sk.frame, h.segs)) }));
          }
          const sweepOne = (w) => {
            for (const transitionMode of ['right', 'round', 'transformed']) {
              try { return R.genericSweep(w, spine, { frenet: helical, transitionMode }); } catch (e) { if (isFatal(e)) throw e; }
            }
            throw new Error('The profile could not be swept along the path (place the profile at the start of the path, across it)');
          };
          let tool = null;
          for (const pr of profiles) {
            let s = sweepOne(pr.outer);
            for (const h of pr.holes) s = s.cut(sweepOne(h));
            tool = tool ? tool.fuse(s) : s;
          }
          tool = unify(tool);
          const scope = f.op === 'cut' && f.scopeAll === false ? f.scope || [] : null;
          tools.set(f.id, { shape: tool, op: f.op, merge: f.merge !== false, scope });
          apply(f.op, tool, f.merge !== false, scope);
          break;
        }
        case 'loft': {
          const ids = (f.profiles || []).filter(Boolean);
          if (ids.length < 2) throw new Error('Select at least two profile sketches (in order)');
          const thin = f.thin ? { t: ev(f.thinT), dir: f.thinDir || 'one' } : null;
          // each profile: one region (outline + holes), as 3D sections
          const profs = ids.map((id) => {
            const s = sketches.get(id);
            if (!s) throw new Error('A profile sketch is missing, suppressed or has errors');
            const regions = thin ? S.thinRegions(s.sk, thin.t, thin.dir) : S.profileRegions(s.sk);
            if (regions.length !== 1) throw new Error(`${s.sk.name} must have exactly one closed profile (it has ${regions.length})`);
            return { name: s.sk.name, outer: loftSection(s.frame, regions[0].outer.segs), holes: regions[0].holes.map((h) => loftSection(s.frame, h.segs)) };
          });
          const loftOf = (secs) => R.loft(matchLoftSections(secs, profs.map((p) => p.name)).map(sectionWire), { ruled: !!f.ruled });
          let tool = loftOf(profs.map((p) => p.outer));
          const nh = profs[0].holes.length;
          if (profs.some((p) => p.holes.length !== nh)) throw new Error('Every profile needs the same number of holes (inner loops)');
          for (let i = 0; i < nh; i++) tool = tool.cut(loftOf(profs.map((p) => p.holes[i])));
          tool = unify(tool);
          const scope = f.op === 'cut' && f.scopeAll === false ? f.scope || [] : null;
          tools.set(f.id, { shape: tool, op: f.op, merge: f.merge !== false, scope });
          apply(f.op, tool, f.merge !== false, scope);
          break;
        }
        case 'thread': {
          if (!f.face) throw new Error('Click the cylindrical face to thread (a bore or a shaft)');
          needEdges('Thread');
          const hit = findFaceAny(solids, f.face);
          if (!hit) throw new Error('The selected face could not be found in the model');
          const ax = faceAxis(hit.face);
          if (!ax || hit.face.geomType !== 'CYLINDRE') throw new Error('Select a cylindrical face (a bore or a shaft)');
          const rF = radiusOfFace(hit.face);
          const p = f.face.p, axisPt = (q) => add(ax.o, mul(ax.d, dot(sub(q, ax.o), ax.d)));
          const radial = unit(sub(p, axisPt(p)));
          const internal = dot(unit(vec(hit.face.normalAt(p))), radial) < 0; // the face looks at the axis: a bore
          // the face's extent along the axis
          const ts = [];
          for (const e of hit.face.edges) for (const u of [0, 0.25, 0.5, 0.75, 1]) ts.push(dot(sub(vec(e.pointAt(u)), ax.o), ax.d));
          const tMin = Math.min(...ts), tMax = Math.max(...ts), tp = dot(sub(p, ax.o), ax.d);
          // the standard (or custom size)
          let std;
          if (f.size === 'custom') {
            const D = ev(f.diameter), Pc = ev(f.pitch);
            if (!(D > 0) || !(Pc > 0)) throw new Error('Enter the custom diameter and pitch');
            std = { label: `Custom Ø${+D.toFixed(3)}×${+Pc.toFixed(3)}`, D, P: Pc };
          } else if (f.size && f.size !== 'auto') {
            std = threadList(f.system).find((t) => t.id === f.size);
            if (!std) throw new Error('Choose a thread size');
          } else std = nearestThread(f.system || 'metric', 2 * rF, internal);
          const pitchOverride = f.size !== 'custom' && f.pitch !== '' && f.pitch != null ? ev(f.pitch) : null;
          const Pt = pitchOverride > 0 ? pitchOverride : std.P, D = std.D, D1 = minorDiameter(D, Pt);
          if (D1 <= 0) throw new Error('The pitch is too large for this diameter');
          // where the face must be (bore at the minor diameter for a cut, at the major for a ridge; shafts the other way)
          const rBase = f.op === 'cut' ? (internal ? D1 / 2 : D / 2) : (internal ? D / 2 : D1 / 2);
          const rTip = f.op === 'cut' ? (internal ? D / 2 : D1 / 2) : (internal ? D1 / 2 : D / 2);
          // start at the end nearest to the picked point (Reverse: the other end)
          const fromMax = (Math.abs(tp - tMax) < Math.abs(tp - tMin)) !== !!f.reverse;
          const t0 = fromMax ? tMax : tMin, sgn = fromMax ? -1 : 1, full = tMax - tMin;
          let L = full;
          if (f.end === 'blind') L = ev(f.depth);
          else if (f.end === 'upTo') {
            const sf = resolveSurface(f.toPlane, f.toFace);
            if (f.toFace) res.features[f.id] = { ...(res.features[f.id] || {}), toFace: f.toFace };
            const den = dot(ax.d, sf.n);
            if (Math.abs(den) < 1e-9) throw new Error('The end reference is parallel to the thread axis');
            L = (dot(sub(sf.p, ax.o), sf.n) / den - t0) * sgn;
          }
          if (!(L > 1e-6)) throw new Error('The thread length must be greater than zero (check the end condition and the direction)');
          L = Math.min(L, full); // never past the end of the face
          const notes = [`${std.label}${pitchOverride ? ` (pitch ${pitchOverride})` : ''}`, internal ? 'internal (bore)' : 'external (shaft)'];
          let shape = hit.body.shape;
          const lo = Math.min(t0, t0 + sgn * L), hi = Math.max(t0, t0 + sgn * L);
          const cylAt = (r, a, b) => R.makeCylinder(r, b - a, add(ax.o, mul(ax.d, a)), ax.d);
          // 1) bring the bore / shaft to the thread size (within the body)
          if (f.autoSize !== false && Math.abs(rF - rBase) > 1e-4) {
            const big = Math.max(rF, rBase), small = Math.min(rF, rBase);
            const ring = cylAt(big, lo, hi).cut(cylAt(small, lo - 1, hi + 1));
            const removing = internal ? rBase > rF : rBase < rF;
            if (removing) {
              if (internal) {
                const inside = R.measureVolume(shape.intersect(ring)), whole = R.measureVolume(ring);
                if (inside < whole * 0.999) throw new Error(`${std.label}: the bore would have to grow from Ø${+(2 * rF).toFixed(3)} to Ø${+(2 * rBase).toFixed(3)}, which breaks out of the body`);
              }
              shape = shape.cut(ring);
            } else shape = shape.fuse(ring);
            notes.push(`${internal ? 'bore' : 'shaft'} Ø${+(2 * rF).toFixed(3)} → Ø${+(2 * rBase).toFixed(3)}`);
          } else if (Math.abs(rF - rBase) > 1e-4) notes.push(`face Ø${+(2 * rF).toFixed(3)} (thread expects Ø${+(2 * rBase).toFixed(3)})`);
          // 2) the thread: an ISO 60° trapezoid swept along a helix
          // narrow at the major diameter for a cut in a bore or a ridge on a shaft, the other way round otherwise
          const narrowAtMajor = (f.op === 'cut') === internal;
          const half = (r) => { const atMinor = narrowAtMajor ? 0.375 * Pt : 0.125 * Pt, atMajor = narrowAtMajor ? 0.0625 * Pt : 0.4375 * Pt; return atMinor + ((r - D1 / 2) / (D / 2 - D1 / 2)) * (atMajor - atMinor); };
          const ov = 0.15 * Pt, rOv = rBase + Math.sign(rBase - rTip) * ov; // overlaps the face for a clean boolean
          const corners = [[rOv, -half(rOv)], [rTip, -half(rTip)], [rTip, half(rTip)], [rOv, half(rOv)]];
          // The ends: the thread runs all the way to each end, with nothing sticking out past it. A groove
          // opening into air runs out past the end (it opens cleanly, e.g. at a nut's mouth); otherwise the
          // coil runs past the end and is cut off flush with it before it is applied. Should that fail, a
          // ridge into material runs out instead and the rest stop just short of the end.
          const maxHalf = Math.max(...corners.map((c) => Math.abs(c[1])));
          const u1 = radial, u2 = cross(ax.d, radial), rTest = rTip + 0.15 * (rBase - rTip), box = 0.08 * Pt;
          const solidAt = (t) => {
            let n = 0;
            for (let k = 0; k < 4; k++) {
              const a = (k * Math.PI) / 2, q = add(add(ax.o, mul(ax.d, t)), mul(add(mul(u1, Math.cos(a)), mul(u2, Math.sin(a))), rTest));
              const cube = R.makeBox(sub(q, [box, box, box]), add(q, [box, box, box]));
              if (R.measureVolume(hit.body.shape.intersect(cube)) > 4 * box ** 3) n++; // more than half the cube
            }
            return n >= 2;
          };
          const tEnd = t0 + sgn * L;
          const beyond = [solidAt(t0 - sgn * 0.25 * Pt), solidAt(tEnd + sgn * 0.25 * Pt)]; // material just past each end
          const harmless = (solid) => solid === (f.op !== 'cut');
          // A run-out goes far enough that the coil's flat end lies wholly past the end (a tooth is up to ~0.44
          // pitch wide: less leaves a hard step where the groove or ridge stops). Stopping short leaves the
          // widest corner a hair inside the end (a corner exactly on an end face upsets the boolean).
          const run = maxHalf + 0.1 * Pt;
          const kinds = (flush) => beyond.map((solid) => (harmless(solid) && (f.op === 'cut' || !flush) ? 'over' : flush ? 'flush' : harmless(solid) ? 'over' : 'short'));
          const insets = (flush) => kinds(flush).map((k) => (k === 'short' ? maxHalf + 0.02 * Pt : -run));
          // OCCT occasionally mis-classifies a coil against the body without any error: it adds or removes
          // nothing, or leaves the whole coil as a loose solid / a sealed cavity. Check for that and retry
          // with the coil turned a little.
          const rFace = f.autoSize !== false ? rBase : rF;
          const profileVol = (keep) => {
            // ∫ r dA over the profile part where keep(r) (Pappus: proportional to the volume)
            const pts = [corners[0], corners[1], corners[2], corners[3]], out = [];
            for (let k = 0; k < 4; k++) {
              const a = pts[k], b = pts[(k + 1) % 4], ia = keep(a[0]), ib = keep(b[0]);
              if (ia) out.push(a);
              if (ia !== ib) { const u = (rFace - a[0]) / (b[0] - a[0]); out.push([rFace, a[1] + u * (b[1] - a[1])]); }
            }
            let m = 0;
            for (let k = 0; k < out.length; k++) { const [r1, z1] = out[k], [r2, z2] = out[(k + 1) % out.length]; m += (r1 * z2 - r2 * z1) * (r1 + r2); }
            return Math.abs(m) / 6;
          };
          const inMaterial = (r) => (internal ? r > rFace : r < rFace);
          const share = profileVol(f.op === 'cut' ? inMaterial : (r) => !inMaterial(r)) / profileVol(() => true);
          const before = shape, vBefore = R.measureVolume(before);
          const topo = (sh) => `${solidsOf(sh).length}/${[...R.iterTopo(sh.wrapped, 'shell')].length}`, topoBefore = topo(before);
          const rCap = Math.max(rOv, rTip) + 4 * Pt;
          const attempt = (flush) => {
            const [inStart, inEnd] = insets(flush), kd = kinds(flush), len = L - inStart - inEnd;
            if (!(len > 0.25 * Pt)) throw new Error(`The thread is too short for a ${+Pt.toFixed(3)} pitch (it must be longer than about one pitch)`);
            // flush ends: the coil is cut off flat at the end before it is fused
            const flushEnds = [[kd[0], t0, -sgn], [kd[1], tEnd, sgn]].filter(([k]) => k === 'flush');
            for (const turn of [41, 67, 23, 97]) { // never 0°: the coil's ends would line up with the faces' seams
              let c = threadCoil(add(ax.o, mul(ax.d, t0 + sgn * inStart)), mul(ax.d, sgn), Pt, len, corners, !!f.leftHand);
              if (turn) c = c.rotate(turn, ax.o, ax.d);
              // (0.02 mm off the end: just past it for a groove, just inside for a ridge, as an end face's edges
              // exactly on the cut-off plane upset the boolean)
              for (const [, tE0, o] of flushEnds) {
                const tE = tE0 + o * (f.op === 'cut' ? 0.02 : -0.02);
                c = c.cut(cylAt(rCap, Math.min(tE, tE + o * 2 * run), Math.max(tE, tE + o * 2 * run)));
              }
              const vc = R.measureVolume(c);
              const result = f.op === 'cut' ? before.cut(c) : before.fuse(c);
              const change = Math.abs(R.measureVolume(result) - vBefore);
              if (change < 0.25 * share * vc || topo(result) !== topoBefore) continue;
              return { coil: c, result };
            }
            return null;
          };
          const out = attempt(true) || (kinds(true).includes('flush') ? attempt(false) : null);
          if (!out) throw new Error('The geometry kernel could not apply this thread to the face (try another size, pitch or length)');
          const coil = out.coil;
          shape = out.result;
          // the preview shows the thread trimmed flat at its ends (display only)
          const view = () => coil.cut(cylAt(rCap, hi, hi + 2 * Pt)).cut(cylAt(rCap, lo - 2 * Pt, lo));
          applied.push({ op: f.op, tool: coil, view, inside: true }); // the coil lies in the material it removes
          replaceSolid(hit.body, shape, f.id);
          res.notes[f.id] = notes.join(' · ');
          break;
        }
        case 'wrap': {
          // project the sketch (outlines and text) along its normal onto a face, raised or sunk by the depth
          const sk = getSketch(f.sketch);
          if (!f.face) throw new Error('Click the face to emboss or deboss onto');
          const hit = findFaceAny(solids, f.face);
          if (!hit) throw new Error('The selected face could not be found in the model');
          const dpt = ev(f.depth);
          if (!(dpt > 0)) throw new Error('The depth must be greater than zero');
          const deboss = f.method === 'deboss';
          const oc = R.getOC(), mk = new oc.BRepOffsetAPI_MakeThickSolid();
          let slab;
          try {
            mk.MakeThickSolidBySimple(hit.face.wrapped, (deboss ? -dpt : dpt) * (f.flip ? -1 : 1));
            slab = R.cast(mk.Shape());
          } finally { mk.delete(); }
          if (!slab || !solidsOf(slab).length) throw new Error('The face could not be offset by that depth (try a smaller depth)');
          // an outward offset of a curved face can come out inside out (negative volume): turn it round
          if (R.measureVolume(slab) < 0) slab = R.cast(slab.wrapped.Reversed());
          // project from the sketch plane toward the picked face only (not through to the far side of the part)
          const fr = sk.frame, side = Math.sign(dot(sub(f.face.p, fr.o), fr.n)) || 1;
          const bb = bbox(hit.body.shape), L = bb.diag + len(sub(bb.center, fr.o)) + 10;
          const prism = profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(fr)).extrude(side * L));
          let tool = prism.intersect(slab);
          // drop pieces behind the face (e.g. the back of a cylinder seen through it)
          const fb = bbox(hit.face), reach = Math.abs(dot(sub(f.face.p, fr.o), fr.n)) + Math.abs(dot(sub(fb.max, fb.min), fr.n)) / 2 + dpt;
          const near = solidsOf(tool).filter((sol) => Math.abs(dot(sub(bbox(sol).center, fr.o), fr.n)) <= reach);
          if (!near.length) throw new Error('The sketch does not project onto the selected face');
          tool = near.length === solidsOf(tool).length ? tool : asShape(near);
          applied.push({ op: deboss ? 'cut' : 'add', tool });
          replaceSolid(hit.body, unify(deboss ? hit.body.shape.cut(tool) : hit.body.shape.fuse(tool)), f.id);
          break;
        }
        case 'deleteBody':
        case 'deleteSurface': {
          const recs = (f.bodies || []).map((id) => needBody(id));
          if (!recs.length) throw new Error(f.type === 'deleteSurface' ? 'Select the surface bodies to delete' : 'Select the bodies to delete');
          if (f.type === 'deleteSurface' && recs.some((r) => !surfaces.includes(r))) throw new Error('Only surface bodies can be deleted with Delete Surface');
          for (const r of recs) applied.push({ op: 'cut', tool: r.shape });
          solids = solids.filter((x) => !recs.includes(x));
          surfaces = surfaces.filter((x) => !recs.includes(x));
          body = compoundOf(solids);
          break;
        }
        case 'combine': {
          if (!f.main) throw new Error('Click the main body on the model (or choose it in the list)');
          const main = needBody(f.main, 'main body');
          if (!solids.includes(main)) throw new Error('The main body must be a solid body');
          const tools = (f.bodies || []).filter((id) => id !== f.main).map((id) => needBody(id));
          if (!tools.length) throw new Error('Select the bodies to combine with the main body');
          if (tools.some((t) => !solids.includes(t))) throw new Error('Only solid bodies can be combined');
          let shape = main.shape;
          for (const t of tools) shape = f.op === 'subtract' ? shape.cut(t.shape) : f.op === 'common' ? shape.intersect(t.shape) : shape.fuse(t.shape);
          applied.push(...tools.map((t) => ({ op: f.op === 'add' ? 'add' : 'cut', tool: t.shape })));
          if (f.consume !== false) solids = solids.filter((s) => !tools.includes(s)); // else the tool bodies are kept
          if (!solidsOf(shape).length) {
            solids = solids.filter((s) => s !== main);
            body = compoundOf(solids);
            throw new Error('The result is empty (the bodies do not overlap?)');
          }
          replaceSolid(main, unify(shape), f.id);
          break;
        }
        case 'split': {
          let tool, plane = null;
          if (f.tool && (STD[f.tool] || planes.has(f.tool))) { const fr = resolveFrame(f.tool); plane = { p: fr.o, n: fr.n }; tool = planeFace(fr.o, fr.n); }
          else if (f.tool) { const sb = needBody(f.tool, 'surface'); if (!surfaces.includes(sb)) throw new Error('Choose a plane or a surface body to split with'); tool = sb.shape; }
          else if (f.toolFace) { const hit = findFace(body, f.toolFace); if (!hit) throw new Error('The selected face could not be found'); plane = hit; tool = planeFace(hit.p, hit.n); }
          else throw new Error('Choose a plane, a flat face or a surface body to split with');
          const targets = f.bodies?.length ? f.bodies.map((id) => needBody(id)).filter((b) => solids.includes(b)) : [...solids];
          if (!targets.length) throw new Error('There is no solid body to split');
          let splitAny = false;
          for (const rec of targets) {
            let pieces = splitBy(rec.shape, tool);
            if (pieces.length > 1) splitAny = true;
            if (plane && f.keep !== 'all') {
              const side = (sh) => Math.sign(dot(sub(bbox(sh).center, plane.p), plane.n));
              const want = f.keep === 'negative' ? -1 : 1;
              const kept = pieces.filter((sh) => side(sh) === want);
              if (kept.length) pieces = kept;
            }
            replaceSolid(rec, compoundOf(pieces.map((shape) => ({ shape }))), f.id);
          }
          if (!splitAny) throw new Error('The tool does not cut through the selected bodies');
          break;
        }
        case 'moveBody': {
          const recs = (f.bodies || []).map((id) => needBody(id));
          if (!recs.length) throw new Error('Select the bodies to move');
          let r = [0, 0, 0], t = [0, 0, 0];
          if (f.mode === 'mates') {
            if (!f.mates?.length) throw new Error('Add at least one mate');
            const mates = f.mates.map((m, i) => {
              const e1 = mateEntity(m.a), e2 = mateEntity(m.b);
              const isMoving = (e) => !!e.body && recs.includes(e.body);
              let A = e1, B = e2;
              if (!isMoving(A) && isMoving(B)) [A, B] = [B, A];
              if (!isMoving(A) || isMoving(B)) throw new Error(`Mate ${i + 1}: one entity must be on a moving body and the other on something fixed`);
              const n1 = A.geo.n || A.geo.d, n2 = B.geo.n || B.geo.d;
              let align = 1;
              if (m.type === 'coincident' || m.type === 'distance') align = A.geo.kind === 'plane' && B.geo.kind === 'plane' ? -1 : 1;
              else if (n1 && n2) align = dot(n1, n2) >= 0 ? 1 : -1;
              if (m.flip) align = -align;
              return { type: m.type, A: A.geo, B: B.geo, v: m.type === 'distance' || m.type === 'angle' ? ev(m.value ?? 0) : 0, align };
            });
            ({ r, t } = solveMates(mates, bbox(compoundOf(recs)).center));
          } else {
            const ang = ev(f.angle || 0);
            if (Math.abs(ang) > 1e-12 && f.rotAxis && f.rotAxis !== 'none') {
              const ax = resolveAxis(f.rotAxis);
              let c = ax.o;
              if (f.rotCenter === 'body') c = bbox(compoundOf(recs)).center;
              r = mul(unit(ax.d), (ang * Math.PI) / 180);
              const M = rotMat(r);
              t = sub(c, mv(M, c)); // rotate about c
            }
            t = add(t, [ev(f.dx || 0), ev(f.dy || 0), ev(f.dz || 0)]);
          }
          const copies = f.copy ? Math.max(1, Math.min(100, Math.round(ev(f.copies || 1)))) : 0;
          for (const rec of recs) {
            const list = solids.includes(rec) ? 'solids' : 'surfaces';
            const smM = rec.sheet ? (() => { const Rm = rotMat(r); return [Rm[0][0], Rm[0][1], Rm[0][2], t[0], Rm[1][0], Rm[1][1], Rm[1][2], t[1], Rm[2][0], Rm[2][1], Rm[2][2], t[2]]; })() : null;
            if (!copies) {
              const moved = moveShape(rec.shape, r, t);
              const nr = bodyRec(rec.id, moved, f.id);
              if (rec.sheet) nr.sheet = SM.moveSheet(rec.sheet, smM);
              if (list === 'solids') solids = solids.map((x) => (x === rec ? nr : x)); else surfaces = surfaces.map((x) => (x === rec ? nr : x));
              applied.push({ op: 'add', tool: moved });
            } else {
              // copy k: the motion applied k times (only translations/rotations repeat; mates copy once)
              let shape = rec.shape, smCur = rec.sheet;
              for (let k = 1; k <= (f.mode === 'mates' ? 1 : copies); k++) {
                shape = moveShape(shape, r, t);
                const nr = bodyRec(newId(f.id), shape, f.id);
                if (smCur) { smCur = SM.moveSheet(smCur, smM); nr.sheet = smCur; }
                if (list === 'solids') solids.push(nr); else surfaces.push(nr);
                applied.push({ op: 'add', tool: shape });
              }
            }
          }
          body = compoundOf(solids);
          break;
        }
        case 'smBase': {
          const sk = getSketch(f.sketch);
          const t = ev(f.thickness), R0 = ev(f.radius), K = ev(f.kFactor);
          if (!(t > 0)) throw new Error('The thickness must be greater than zero');
          if (!(R0 > 0)) throw new Error('The bend radius must be greater than zero');
          if (!(K >= 0 && K <= 1)) throw new Error('The K-factor must be between 0 and 1');
          const sheet = SM.baseFlange({ region: sketchRegion(sk), frame: sk.frame, t, R: R0, K, reverse: !!f.reverse });
          const shape = SM.toSolid(sheet);
          const rec = bodyRec(newId(f.id), shape, f.id);
          rec.sheet = sheet;
          solids.push(rec);
          body = compoundOf(solids);
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'smLoft': {
          // a sheet between two open profiles (one sketch each), bent from flat facets or formed smooth
          if (!f.profileA || !f.profileB) throw new Error('Select the two open profile sketches');
          if (f.profileA === f.profileB) throw new Error('Select two different sketches');
          const t = ev(f.thickness), K = ev(f.kFactor), R0 = ev(f.radius ?? 0);
          if (!(t > 0)) throw new Error('The thickness must be greater than zero');
          if (!(K >= 0 && K <= 1)) throw new Error('The K-factor must be between 0 and 1');
          const bent = f.method !== 'formed';
          // formed: the surface finer, a whole number of strips per forming line in the flat pattern
          const nDiv = Math.round(ev(f.bends ?? 12));
          if (!(nDiv >= 1 && nDiv <= 200)) throw new Error('The divisions along the profiles must be 1 to 200');
          const perLine = bent ? 1 : Math.max(1, Math.ceil(64 / nDiv)), nSeg = nDiv * perLine;
          // each profile as a fine polyline in model space, with where its corners are (fraction of its length)
          const profile = (id, which) => {
            const s = sketches.get(id);
            if (!s) throw new Error(`The ${which} profile sketch is missing, suppressed or has errors`);
            const chains = S.curveChains(s.sk);
            if (chains.length !== 1) throw new Error(`The ${which} profile sketch must hold one chain of lines / arcs joined end to end (it has ${chains.length})`);
            if (chains[0].closed) throw new Error(`The ${which} profile must be open: leave a gap where the seam of the part goes`);
            const pts = [], cornerAt = [];
            chains[0].items.forEach(({ c, rev }, k) => {
              let q = S.curvePoints(s.sk, c, 256);
              if (rev) q = [...q].reverse();
              if (k) { cornerAt.push(pts.length - 1); q = q.slice(1); }
              pts.push(...q);
            });
            const fr = s.frame, W3 = pts.map(([x, y]) => add(add(fr.o, mul(fr.u, x)), mul(fr.v, y)));
            const S0 = [0];
            for (let i = 1; i < W3.length; i++) S0.push(S0[i - 1] + len(sub(W3[i], W3[i - 1])));
            const total = S0[S0.length - 1];
            if (!(total > 0)) throw new Error(`The ${which} profile has no length`);
            // only real corners (not where a line runs smoothly into an arc)
            const corners = cornerAt.filter((i) => {
              const d0 = unit(sub(W3[i], W3[i - 1])), d1 = unit(sub(W3[i + 1], W3[i]));
              return dot(d0, d1) < Math.cos((1 * Math.PI) / 180);
            }).map((i) => S0[i] / total);
            const at = (fq) => {
              const target = fq * total;
              let i = 1;
              while (i < S0.length - 1 && S0[i] < target) i++;
              const k = (target - S0[i - 1]) / ((S0[i] - S0[i - 1]) || 1);
              return add(W3[i - 1], mul(sub(W3[i], W3[i - 1]), Math.max(0, Math.min(1, k))));
            };
            return { at, corners, first: W3[0], last: W3[W3.length - 1] };
          };
          const PA = profile(f.profileA, 'first'), PB0 = profile(f.profileB, 'second');
          // the profiles run the same way (the nearer ends together)
          const swapB = len(sub(PA.first, PB0.first)) + len(sub(PA.last, PB0.last)) > len(sub(PA.first, PB0.last)) + len(sub(PA.last, PB0.first));
          const PB = swapB ? { at: (q) => PB0.at(1 - q), corners: PB0.corners.map((q) => 1 - q) } : PB0;
          // matched points: evenly along both, plus every corner of either profile (so corners stay sharp)
          const fr = [...Array.from({ length: nSeg + 1 }, (_, i) => i / nSeg), ...PA.corners, ...PB.corners].sort((x, y) => x - y)
            .filter((q, i, arr) => !i || q - arr[i - 1] > 0.2 / nSeg || PA.corners.includes(q) || PB.corners.includes(q));
          const fracs = fr.filter((q, i, arr) => !i || q - arr[i - 1] > 1e-9);
          const A = fracs.map((q) => PA.at(q)), B = fracs.map((q) => PB.at(q));
          // where either profile has a corner (a formed part is smooth between them, sharp at them)
          const breaks = fracs.map((q, i) => (PA.corners.some((c) => Math.abs(c - q) < 1e-9) || PB.corners.some((c) => Math.abs(c - q) < 1e-9) ? i : -1)).filter((i) => i > 0);
          const sheet = SM.loftedSheet(A, B, { t, K, R: R0, method: bent ? 'bent' : 'formed', side: f.flip ? -1 : 1, breaks });
          if (!bent) sheet.lofted.bendLines = SM.formLines(sheet.lofted, { breaks });
          const shape = SM.toSolid(sheet);
          const rec = bodyRec(newId(f.id), shape, f.id);
          rec.sheet = sheet;
          solids.push(rec);
          body = compoundOf(solids);
          applied.push({ op: 'add', tool: shape });
          res.notes[f.id] = bent ? `${sheet.lofted.bendLines.length} bend${sheet.lofted.bendLines.length === 1 ? '' : 's'} between ${A.length - 1} strips (bent from flat facets)` : `Formed (smooth) — rolled from a flat pattern developed from the surface${sheet.lofted.bendLines.length ? `, with ${sheet.lofted.bendLines.length} sharp fold${sheet.lofted.bendLines.length === 1 ? '' : 's'} at its corners` : ''}`;
          break;
        }
        case 'draft': {
          // Draft: faces tilted by an angle about where they meet the neutral plane, along its normal
          needEdges('Draft');
          if (!f.face?.n) throw new Error('Click the neutral plane: a flat face that keeps its size');
          if (!f.faces?.length) throw new Error('Click the faces to draft');
          const ang = ev(f.angle);
          if (!(Math.abs(ang) > 1e-6 && Math.abs(ang) < 89)) throw new Error('The draft angle must be between 0° and 89°');
          const neutral = findFaceAny(solids, f.face);
          if (!neutral) throw new Error('The neutral plane face could not be found');
          const rec = neutral.body;
          const hits = f.faces.map((r) => findFaceAny([rec], r));
          if (hits.some((h) => !h)) throw new Error('Each face to draft must be on the body of the neutral plane');
          const n = unit(f.face.n), dir = f.reverse ? mul(n, -1) : n, p = f.face.p;
          const oc = R.getOC();
          const D = new oc.gp_Dir(dir[0], dir[1], dir[2]), N = new oc.gp_Dir(n[0], n[1], n[2]), P = new oc.gp_Pnt(p[0], p[1], p[2]);
          const pln = new oc.gp_Pln(P, N);
          const mk = new oc.BRepOffsetAPI_DraftAngle(rec.shape.wrapped);
          let out = null;
          try {
            for (const h of hits) {
              if (h.face.isSame(neutral.face)) continue;
              mk.Add(h.face.wrapped, D, (ang * Math.PI) / 180, pln, true);
              if (!mk.AddDone()) throw new Error('A face cannot be drafted from this neutral plane (it must not be parallel to the plane)');
            }
            mk.Build();
            out = R.cast(mk.Shape());
          } catch (e) {
            if (isFatal(e)) throw e;
            throw new Error(e.message?.startsWith('A face') ? e.message : 'The draft could not be made (a face that cannot tilt, or one whose neighbours cannot follow it)');
          } finally { mk.delete(); pln.delete(); P.delete(); N.delete(); D.delete(); }
          if (!out || !solidsOf(out).length) throw new Error('The draft could not be made');
          replaceSolid(rec, unify(out), f.id);
          res.notes[f.id] = `${hits.length} face${hits.length === 1 ? '' : 's'} drafted ${ang}°`;
          break;
        }
        case 'rib': {
          // Rib: an open sketch thickened and run out until it meets the model, in the sketch plane
          // (parallel) or square to it (normal)
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('Select an open sketch for the rib (a line from face to face)');
          if (!body) throw new Error('There is no body for the rib to join');
          const t = ev(f.thickness);
          if (!(t > 0)) throw new Error('The thickness must be greater than zero');
          const fr = s.frame, n = unit(fr.n), L = 2 * bbox(body).diag + 10;
          const P3 = (q) => S.fromFrame2D(fr, q[0], q[1]);
          const runs = [];
          for (const ch of S.curveChains(s.sk)) {
            for (const g of S.chainSegs(s.sk, ch)) {
              if (g.type === 'line') { runs.push([g.a, g.b]); continue; }
              let pts = [];
              if (g.type === 'bezier') pts = Array.from({ length: 9 }, (_, i) => S.bezierAt(g, i / 8));
              else if (g.type === 'arc' && g.m) {
                const C = S.circleThrough(g.a, g.b, g.m);
                if (!C) { runs.push([g.a, g.b]); continue; }
                const a0 = Math.atan2(g.a[1] - C.cy, g.a[0] - C.cx), am = Math.atan2(g.m[1] - C.cy, g.m[0] - C.cx), a1 = Math.atan2(g.b[1] - C.cy, g.b[0] - C.cx);
                let sp = a1 - a0, sm = am - a0;
                const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
                sp = norm(sp); sm = norm(sm);
                if (sm > sp) sp -= 2 * Math.PI;
                pts = Array.from({ length: 9 }, (_, i) => [C.cx + C.r * Math.cos(a0 + (sp * i) / 8), C.cy + C.r * Math.sin(a0 + (sp * i) / 8)]);
              } else continue;
              for (let i = 0; i + 1 < pts.length; i++) runs.push([pts[i], pts[i + 1]]);
            }
          }
          if (!runs.length) throw new Error('The sketch has no lines for the rib');
          const prism = (poly, v) => R.basicFaceExtrusion(R.makePolygon(poly), new R.Vector(v));
          const parts = [];
          for (const [a, b] of runs) {
            const A = P3(a), B = P3(b), u = unit(sub(B, A)), w = unit(cross(n, u)), M = mul(add(A, B), 0.5);
            const signs = f.flip ? [-1, 1] : [1, -1];
            let got = null;
            for (const sg of signs) {
              let tool, d;
              if (f.ribDir === 'normal') {
                d = mul(n, sg);
                tool = prism([add(A, mul(w, -t / 2)), add(B, mul(w, -t / 2)), add(B, mul(w, t / 2)), add(A, mul(w, t / 2))], mul(d, L));
              } else {
                d = mul(w, sg);
                const lo = mul(n, -t / 2);
                tool = prism([add(A, lo), add(B, lo), add(add(B, mul(d, L)), lo), add(add(A, mul(d, L)), lo)], mul(n, t));
              }
              // the piece next to the sketch line, short of the far end (closed in by the model)
              const q = new R.DistanceQuery(R.makeVertex(add(M, mul(d, 1e-3 * t))));
              const pcs = solidsOf(tool.cut(body)).filter((pc) => q.distanceTo(pc) < 1e-6);
              const ok = pcs.filter((pc) => {
                const bb = bbox(pc), corners = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [m & 1 ? bb.max[0] : bb.min[0], m & 2 ? bb.max[1] : bb.min[1], m & 4 ? bb.max[2] : bb.min[2]]);
                return Math.max(...corners.map((c) => dot(sub(c, M), d))) < 0.9 * L;
              });
              if (ok.length) { got = ok; break; }
            }
            if (!got) throw new Error('The rib is not closed in by the model: draw its line so both ends meet faces of the body (or flip the side)');
            parts.push(...got);
          }
          let tool = parts[0];
          for (const pc of parts.slice(1)) tool = tool.fuse(pc);
          tools.set(f.id, { shape: tool, op: 'add', merge: true, scope: null });
          apply('add', tool, true, null);
          res.notes[f.id] = `${runs.length} segment${runs.length === 1 ? '' : 's'}, ${t} thick, volume ${+parts.reduce((v, pc) => v + R.measureVolume(pc), 0).toFixed(3)}`;
          break;
        }
        case 'dome': {
          // Dome: a rounded cap on flat faces (exact sphere / ellipsoid on a round face, a filled surface on
          // any other outline); reversed it is pressed in
          needEdges('Dome');
          if (!f.faces?.length) throw new Error('Click the flat faces for the dome');
          const h = ev(f.height);
          if (!(h > 0)) throw new Error('The height must be greater than zero');
          for (const r of f.faces) {
            if (!r.n) throw new Error('A dome goes on a flat face');
            const hit = findFaceAny(solids, r);
            if (!hit) throw new Error('A dome face could not be found in the model');
            const n0 = unit(r.n), n = f.reverse ? mul(n0, -1) : n0;
            const wire = hit.face.clone().outerWire(), edges = wire.edges;
            let tool = null;
            if (edges.length === 1 && edges[0].geomType === 'CIRCLE') {
              const e = edges[0], bb = bbox(e), C = mul(add(bb.min, bb.max), 0.5), rr = R.measureLength(e) / (2 * Math.PI);
              const x = unit(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
              const Q = (rad, ax) => add(add(C, mul(x, rad)), mul(n, ax));
              let arc;
              if (f.elliptical) {
                const pts = Array.from({ length: 13 }, (_, i) => { const th = (i / 12) * (Math.PI / 2); return Q(rr * Math.cos(th), h * Math.sin(th)); });
                arc = R.makeBSplineApproximation(pts.map((q) => new R.Vector(q)));
              } else {
                const Rs = (rr * rr + h * h) / (2 * h), zc = h - Rs, a0 = Math.atan2(-zc, rr), am = (a0 + Math.PI / 2) / 2;
                arc = R.makeThreePointArc(Q(rr, 0), Q(Rs * Math.cos(am), zc + Rs * Math.sin(am)), Q(0, h));
              }
              const prof = R.makeFace(R.assembleWire([R.makeLine(C, Q(rr, 0)), arc, R.makeLine(Q(0, h), C)]));
              tool = R.revolution(prof, C, n, 360);
            } else {
              // a filled surface through the outline, up to the height over the middle of the face
              const oc = R.getOC();
              const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
              let top;
              try {
                for (const e of edges) mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
                const ctr = domeCentre(hit.face, wire, r.p, n0);
                const g = new oc.gp_Pnt(...add(ctr, mul(n, h)));
                mk.Add(g);
                mk.Build();
                top = R.cast(mk.Shape());
              } catch (e) { if (isFatal(e)) throw e; throw new Error('The dome surface could not be made over that outline'); } finally { mk.delete(); }
              // the dome takes the face's place in the body (sewn in along the same edges)
              const rec = solids.find((x) => x.id === hit.body.id);
              const keep = rec.shape.faces.filter((x) => !x.isSame(hit.face));
              const sol = solidFromSewn(sewShapes([...keep, top], Math.max(1e-5, bbox(rec.shape).diag * 1e-6)));
              if (!sol) throw new Error('The dome could not be joined to the body (a face with holes, or a dome running into other faces?)');
              replaceSolid(rec, unify(sol), f.id);
              continue;
            }
            if (f.reverse) apply('cut', tool, true, [hit.body.id]);
            else apply('add', tool, true, null);
          }
          res.notes[f.id] = `${f.faces.length} dome${f.faces.length === 1 ? '' : 's'}, ${h} ${f.reverse ? 'deep' : 'high'}`;
          break;
        }
        case 'scale': {
          // Scale: every body (solids and surfaces) by one factor about the origin or their centre
          const k = ev(f.factor);
          if (!(k > 0)) throw new Error('The scale factor must be greater than zero');
          const all = [...solids, ...surfaces];
          if (!all.length) throw new Error('There is no body to scale');
          let ctr = [0, 0, 0];
          if (f.about === 'centroid') { const bb = bboxOfAll(all.map((b) => b.shape)); ctr = mul(add(bb.min, bb.max), 0.5); }
          solids = solids.map((rec) => bodyRec(rec.id, rec.shape.clone().scale(k, ctr), f.id));
          surfaces = surfaces.map((rec) => { const nr = bodyRec(rec.id, rec.shape.clone().scale(k, ctr), f.id); if (rec.mesh) nr.mesh = true; return nr; });
          body = compoundOf(solids);
          res.notes[f.id] = `Scaled ×${k} about ${f.about === 'centroid' ? 'the centre of the bodies' : 'the origin'}`;
          break;
        }
        case 'moveFace': {
          // Move Face: flat faces pushed / pulled along their normal, or turned about an edge
          needEdges('Move Face');
          if (!f.faces?.length) throw new Error('Click the flat faces to move');
          const hits = f.faces.map((r) => findFaceAny(solids, r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          if (f.faces.some((r) => !r.n)) throw new Error('Move Face works on flat faces');
          if (f.mode === 'rotate') {
            if (!f.edge) throw new Error('Click the edge to turn the face about (an edge of the face)');
            const ang = ev(f.angle);
            if (!(Math.abs(ang) > 1e-6 && Math.abs(ang) < 89)) throw new Error('The angle must be between 0° and 89°');
            const rec = hits[0].body;
            if (hits.some((h) => h.body !== rec)) throw new Error('The faces must be on the same body');
            const eh = findEdgeInfo(rec.shape, f.edge);
            if (!eh || eh.e.geomType !== 'LINE') throw new Error('The hinge must be a straight edge');
            const a = eh.e.startPoint.toTuple ? eh.e.startPoint.toTuple() : [eh.e.startPoint.x, eh.e.startPoint.y, eh.e.startPoint.z];
            const b = eh.e.endPoint.toTuple ? eh.e.endPoint.toTuple() : [eh.e.endPoint.x, eh.e.endPoint.y, eh.e.endPoint.z];
            const hd = unit(sub(b, a)), fn = unit(f.faces[0].n);
            // pull direction: in the face, square to the hinge, towards the face
            let pd = unit(cross(fn, hd));
            if (dot(sub(f.faces[0].p, a), pd) < 0) pd = mul(pd, -1);
            if (f.reverse) pd = mul(pd, -1);
            const oc = R.getOC();
            const D = new oc.gp_Dir(...pd), P = new oc.gp_Pnt(...a), pln = new oc.gp_Pln(P, D);
            const mk = new oc.BRepOffsetAPI_DraftAngle(rec.shape.wrapped);
            let out = null;
            try {
              for (const h of hits) {
                mk.Add(h.face.wrapped, D, (ang * Math.PI) / 180, pln, true);
                if (!mk.AddDone()) throw new Error('The face cannot turn about that edge');
              }
              mk.Build();
              out = R.cast(mk.Shape());
            } catch (e) { if (isFatal(e)) throw e; throw new Error(e.message?.startsWith('The face') ? e.message : 'The face could not be turned (its neighbours cannot follow it)'); } finally { mk.delete(); pln.delete(); P.delete(); D.delete(); }
            if (!out || !solidsOf(out).length) throw new Error('The face could not be turned');
            replaceSolid(rec, unify(out), f.id);
            break;
          }
          const d = ev(f.distance);
          if (!(Math.abs(d) > 1e-9)) throw new Error('The distance must not be zero');
          for (const [i, h] of hits.entries()) {
            const nn = unit(f.faces[i].n);
            const tool = R.basicFaceExtrusion(h.face, new R.Vector(mul(nn, d)));
            const rec = solids.find((x) => x.id === h.body.id);
            if (!rec) continue;
            const out = d > 0 ? rec.shape.fuse(tool) : rec.shape.cut(tool);
            if (!solidsOf(out).length) throw new Error('Moving the face removed the whole body');
            replaceSolid(rec, unify(out), f.id);
          }
          res.notes[f.id] = `${hits.length} face${hits.length === 1 ? '' : 's'} moved ${d > 0 ? 'out' : 'in'} ${Math.abs(d)}`;
          break;
        }
        case 'hole': {
          // Hole: simple, counterbored, countersunk or tapped holes at sketch points / circle centres
          // or clicked points on a flat face, square into the material
          const spec = holeSpec(f, ev);
          if (!(spec.d > 0)) throw new Error('The hole diameter must be greater than zero');
          if (spec.type === 'cbore' && !(spec.cbD > spec.d && spec.cbDepth > 0)) throw new Error('The counterbore must be wider than the hole and have a depth');
          if (spec.type === 'csink' && !(spec.csD > spec.d && spec.csAng > 0 && spec.csAng < 180)) throw new Error('The countersink must be wider than the hole, at an angle between 0° and 180°');
          const locs = [];
          if (f.sketch) {
            const s = sketches.get(f.sketch);
            if (!s) throw new Error('The placement sketch is missing, suppressed or has errors');
            const P3 = (id) => { const q = S.getPoint(s.sk, id); return S.fromFrame2D(s.frame, q.x, q.y); };
            const used = new Set(s.sk.curves.flatMap((c) => [c.p1, c.p2, ...(c.pts || [])]).filter(Boolean));
            const centres = new Set(s.sk.curves.filter((c) => (c.type === 'circle' || c.type === 'arc') && !c.construction).map((c) => c.c));
            const dir = mul(s.frame.n, f.reverse ? 1 : -1);
            for (const pt of s.sk.points) if (pt.id !== 'O' && (centres.has(pt.id) || !used.has(pt.id))) locs.push({ p: P3(pt.id), dir });
          }
          for (const fc of f.faces || []) if (fc.n) locs.push({ p: fc.p, dir: mul(unit(fc.n), f.reverse ? 1 : -1) });
          if (!locs.length) throw new Error('Click points on a flat face for the holes, or select a sketch with points (or circles) on the face');
          if (!body) throw new Error('There is no body to put holes in');
          const through = f.end === 'through';
          const depth = through ? 2 * bbox(body).diag + 1 : ev(f.depth);
          if (!(depth > 0)) throw new Error('The hole depth must be greater than zero');
          if (spec.type === 'cbore' && depth <= spec.cbDepth) throw new Error('The hole must be deeper than its counterbore');
          const prof = holeProfile(spec, depth, !through && f.drillPoint !== false);
          let tool = null;
          for (const { p, dir } of locs) {
            const u = unit(cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
            const face = R.makePolygon(prof.map(([r, z]) => add(add(p, mul(u, r)), mul(dir, z))));
            const one = R.revolution(face, p, dir, 360);
            tool = tool ? tool.fuse(one) : one;
          }
          tools.set(f.id, { shape: tool, op: 'cut', merge: true, scope: null });
          apply('cut', tool, true, null);
          res.features[f.id] = { faces: f.faces || [], holes: locs.map((l) => ({ p: l.p, dir: l.dir })), spec: spec.label, sizes: { type: spec.type, d: spec.d, cbD: spec.cbD, cbDepth: spec.cbDepth, csD: spec.csD, csAng: spec.csAng }, through, depth: through ? null : depth, thread: spec.thread ? { label: spec.thread.label, depth: f.threadDepth === '' || f.threadDepth == null ? null : ev(f.threadDepth) } : null };
          res.notes[f.id] = `${locs.length} hole${locs.length === 1 ? '' : 's'}: ${spec.label}${through ? ', through all' : `, ${+depth.toFixed(3)} deep`}${spec.thread ? ' (cosmetic thread: add Thread Cut on the hole for a modelled one)' : ''}`;
          break;
        }
        case 'smProfileFlange': {
          // a flange of several segments (lengths / angles) along the picked edges, corners mitred
          needEdges('Profile flange');
          if (!f.edges?.length) throw new Error('Click the edges to add the flange to (straight edges on the top or bottom face of the sheet)');
          const { rec, edges } = sheetEdges(f.edges);
          res.features[f.id] = { edges: f.edges };
          const sheet = sheetChecked(rec);
          const R0 = f.useDefaultRadius !== false ? sheet.R : ev(f.radius);
          if (!(R0 > 0)) throw new Error('The bend radius must be greater than zero');
          const n = Math.max(1, Math.min(4, Math.round(+f.segments || 1)));
          const segs = Array.from({ length: n }, (_, i) => ({ L: ev(f['len' + (i + 1)]), ang: ev(f['ang' + (i + 1)]) }));
          const out = SM.addProfileFlanges(sheet, edges, segs, { R: R0, position: f.position || 'inside', flip: !!f.flip, gap: f.corner === 'open' ? null : ev(f.cornerGap ?? 0.1), relief: { type: f.reliefType || 'rect', ratio: ev(f.reliefRatio ?? 0.5) } });
          setSheet(rec, out);
          res.notes[f.id] = `${n} segment${n === 1 ? '' : 's'} on ${edges.length} edge${edges.length === 1 ? '' : 's'}: ${out.bends.length - sheet.bends.length} bends`;
          break;
        }
        case 'smForm': {
          // dimples / extruded holes at sketch points or clicked points, louvers on sketch lines
          const kind = f.formType || 'dimple', flip = !!f.flip;
          const par = kind === 'dimple' ? { D: ev(f.diameter), h: ev(f.depth) }
            : kind === 'louver' ? { W: ev(f.width), H: ev(f.height), side: !!f.side }
              : { D: ev(f.holeDiameter), h: ev(f.collarHeight), R: f.useDefaultRadius !== false ? 0 : ev(f.radius) };
          const items = [];
          if (f.sketch) {
            const s = sketches.get(f.sketch);
            if (!s) throw new Error('The placement sketch is missing, suppressed or has errors');
            const P3 = (id) => { const q = S.getPoint(s.sk, id); return S.fromFrame2D(s.frame, q.x, q.y); };
            if (kind === 'louver') {
              for (const c of s.sk.curves) if (c.type === 'line' && !c.construction) items.push({ kind, line: { a: P3(c.p1), b: P3(c.p2) }, ...par, flip });
            } else {
              // circle centres, and points of their own (not the ends of lines or arcs)
              const used = new Set(s.sk.curves.flatMap((c) => [c.p1, c.p2, ...(c.pts || [])]).filter(Boolean));
              const at = new Set(s.sk.curves.filter((c) => c.type === 'circle' && !c.construction).map((c) => c.c));
              for (const pt of s.sk.points) if (pt.id !== 'O' && (at.has(pt.id) || !used.has(pt.id))) items.push({ kind, p: P3(pt.id), ...par, flip });
            }
          }
          if (kind !== 'louver') for (const fc of f.faces || []) items.push({ kind, p: fc.p, ...par, flip });
          if (!items.length) throw new Error(kind === 'louver' ? 'Select a sketch with lines on a face of the sheet: each line is a louver\'s slit' : 'Click points on a flat face of the sheet, or select a sketch with points (or circles) on it');
          const first = items[0];
          const rec = sheetRecs().find((r) => !r.sheet.stale && (first.line ? SM.lineOnSheet(r.sheet, first.line.a, first.line.b) : SM.pointOnSheet(r.sheet, first.p)));
          if (!rec) throw new Error('The form is not on a flat face of a sheet metal body');
          setSheet(rec, SM.addForms(sheetChecked(rec), items));
          res.features[f.id] = { faces: f.faces || [] };
          res.notes[f.id] = `${items.length} ${{ dimple: 'dimple', louver: 'louver', exthole: 'extruded hole' }[kind]}${items.length === 1 ? '' : 's'}`;
          break;
        }
        case 'smGusset': {
          // a stiffening dart across a bend at each clicked point on its round face
          if (!f.faces?.length) throw new Error('Click a bend (its round face) where each gusset goes');
          const rec = sheetRecs().find((r) => !r.sheet.stale && SM.onBend(r.sheet, f.faces[0].p));
          if (!rec) throw new Error('Click on a bend (its round face) of a sheet metal body');
          setSheet(rec, SM.addForms(sheetChecked(rec), f.faces.map((fc) => ({ kind: 'gusset', p: fc.p, L: ev(f.size), w: ev(f.width) }))));
          res.features[f.id] = { faces: f.faces };
          res.notes[f.id] = `${f.faces.length} gusset${f.faces.length === 1 ? '' : 's'}`;
          break;
        }
        case 'smTabSlot': {
          // tabs on an edge of one sheet metal part, slots through the face of the other where they meet
          if (!f.edge) throw new Error('Click the edge of the part that gets the tabs (where it meets the other part)');
          if (!f.face) throw new Error('Now click the face of the other part that gets the slots');
          needEdges('Tab and slot');
          const { rec: A, edges } = sheetEdges([f.edge]);
          const B = sheetRecs().find((r) => r !== A && !r.sheet.stale && SM.pointOnSheet(r.sheet, f.face.p));
          if (!B) throw new Error('The slot face must be a flat face of another sheet metal body');
          res.features[f.id] = { edges: [f.edge] };
          const opt = (v) => (v === '' || v == null ? null : ev(v));
          const out = SM.addTabsSlots(sheetChecked(A), edges[0], sheetChecked(B), { count: ev(f.count), length: ev(f.length), height: opt(f.height) ?? 0, clearance: ev(f.clearance ?? 0.1), margin: opt(f.margin) });
          setSheet(A, out.a);
          setSheet(B, out.b);
          res.notes[f.id] = `${out.starts.length} tab${out.starts.length === 1 ? '' : 's'} ${+ev(f.length).toFixed(3)} × ${+out.h.toFixed(3)} mm, slots ${+ev(f.clearance ?? 0.1).toFixed(3)} mm clearance`;
          break;
        }
        case 'smCrossBreak': {
          // an X of shallow folds across each picked flat face: marks in the flat pattern and DXF
          if (!f.faces?.length) throw new Error('Click the flat faces of the sheet to cross break');
          let rec = null;
          f.faces.forEach((fc, i) => {
            const r = sheetRecs().find((x) => !x.sheet.stale && SM.pointOnSheet(x.sheet, fc.p));
            if (!r) throw new Error(`Face ${i + 1} is not a flat face of a sheet metal body`);
            if (rec && r !== rec) throw new Error('Pick faces of one sheet metal body at a time');
            rec = r;
          });
          const out = SM.addCrossBreaks(sheetChecked(rec), f.faces.map((x) => x.p), { up: !f.flip });
          setSheet(rec, out);
          res.features[f.id] = { faces: f.faces };
          res.notes[f.id] = `${f.faces.length} cross break${f.faces.length === 1 ? '' : 's'} (in the flat pattern and DXF)`;
          break;
        }
        case 'smSketchBend':
        case 'smJog': {
          // bend lines drawn on a flat face of a sheet metal body (a jog: one line, two opposite bends)
          const jog = f.type === 'smJog';
          if (!f.sketch) throw new Error(`Select the sketch with the ${jog ? 'jog line' : 'bend line(s)'}, drawn on a flat face of the sheet`);
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('The sketch is missing, suppressed or has errors');
          const lines = s.sk.curves.filter((c) => c.type === 'line' && !c.construction);
          if (!lines.length) throw new Error(`Draw ${jog ? 'the jog line' : 'the bend line(s)'} in the sketch (straight lines on the sheet's face)`);
          if (jog && lines.length !== 1) throw new Error('A jog is made from one line: keep one line in the sketch');
          const segs = lines.map((c) => { const p = S.getPoint(s.sk, c.p1), q = S.getPoint(s.sk, c.p2); return { a: S.fromFrame2D(s.frame, p.x, p.y), b: S.fromFrame2D(s.frame, q.x, q.y) }; });
          const rec = sheetRecs().find((r) => !r.sheet.stale && SM.lineOnSheet(r.sheet, segs[0].a, segs[0].b));
          if (!rec) throw new Error('The line is not on a flat face of a sheet metal body: draw the sketch on the top or bottom face of the sheet');
          const sheet = sheetChecked(rec);
          const R0 = f.useDefaultRadius !== false ? sheet.R : ev(f.radius);
          const common = { angle: ev(f.angle ?? 90), R: R0, position: f.position || (jog ? 'start' : 'center'), flip: !!f.flip, swapFixed: !!f.swapFixed };
          const out = jog ? SM.addJog(sheet, segs[0], { ...common, height: ev(f.height), ref: f.heightRef || 'face' }) : SM.addSketchedBends(sheet, segs, common);
          setSheet(rec, out);
          res.notes[f.id] = jog ? `Two ${+ev(f.angle ?? 90).toFixed(2)}° bends, ${+out.jogFlat.toFixed(3)} mm of flat between them` : `${segs.length} bend${segs.length === 1 ? '' : 's'}`;
          break;
        }
        case 'smExtrude': {
          // sheet metal extruded from an open sketch profile (drawn arcs are bends; sharp corners get the bend
          // radius) or a lone circle (rolled, with a seam gap)
          if (!f.sketch) throw new Error('Select the sketch: an open chain of lines / arcs, or a circle');
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('The sketch is missing, suppressed or has errors');
          const chains = S.curveChains(s.sk);
          if (chains.length !== 1) throw new Error(`The sketch must hold one chain of lines / arcs joined end to end, or one circle (it has ${chains.length || 'none'})`);
          const segs = S.chainSegs(s.sk, chains[0]);
          if (chains[0].closed && !(segs.length === 1 && segs[0].type === 'circle')) throw new Error('The profile is closed: leave a gap where the seam goes (only a lone circle is rolled closed, with its seam gap)');
          const t = ev(f.thickness), K = ev(f.kFactor), R0 = ev(f.radius), depth = ev(f.depth);
          if (!(K >= 0 && K <= 1)) throw new Error('The K-factor must be between 0 and 1');
          if (!(R0 >= 0)) throw new Error('The bend radius can\'t be negative');
          if (!(depth > 0)) throw new Error('The depth must be greater than zero');
          const [z0, z1] = f.direction === 'mid' ? [-depth / 2, depth / 2] : f.direction === 'reverse' ? [-depth, 0] : [0, depth];
          const out = SM.extrudedSheet(segs, { frame: s.frame, z0, z1, t, K, R: R0, side: f.side || 'one', gap: ev(f.seamGap ?? 0.5) });
          const shape = SM.toSolid(out.sheet);
          const rec = bodyRec(newId(f.id), shape, f.id);
          rec.sheet = out.sheet;
          solids.push(rec);
          body = compoundOf(solids);
          applied.push({ op: 'add', tool: shape });
          const pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
          res.notes[f.id] = out.rolled ? 'Rolled from flat (a cylinder with its seam gap)' : !out.sheet.bends.length ? 'A flat plate (no bends)' : [out.drawn ? pl(out.drawn, 'drawn bend') : '', out.corners ? `${pl(out.corners, 'bend')} at sharp corners` : ''].filter(Boolean).join(' · ');
          break;
        }
        case 'smTransition': {
          // a transition / reducer: two ends (round or a polygon) on the axis of a sketch line (bottom centre
          // to top centre: its length is the height), in equal parts, each a sheet metal body of its own
          if (!f.sketch) throw new Error('Select the sketch with the axis line (or sketch one: bottom centre to top centre)');
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('The sketch is missing, suppressed or has errors');
          const lines = s.sk.curves.filter((c) => c.type === 'line'), solid = lines.filter((c) => !c.construction);
          const line = lines.length === 1 ? lines[0] : solid.length === 1 ? solid[0] : null;
          if (!line) throw new Error(lines.length ? 'The sketch has more than one line: keep one line for the axis (bottom centre to top centre)' : 'Draw a line in the sketch from the bottom centre to the top centre (its length is the height)');
          const q1 = S.getPoint(s.sk, line.p1), q2 = S.getPoint(s.sk, line.p2), fr = s.frame;
          const W3 = (q) => add(add(fr.o, mul(fr.u, q.x)), mul(fr.v, q.y));
          let o = W3(q1), tp = W3(q2);
          if (f.reverse) [o, tp] = [tp, o];
          const h = len(sub(tp, o));
          if (!(h > 1e-6)) throw new Error('The axis line has no length');
          const d = unit(sub(tp, o));
          // X: in the sketch plane, square to the line; turned about the axis by the rotation
          const X0 = unit(cross(d, fr.n)), Y0 = cross(d, X0), rot = (ev(f.rotation ?? 0) * Math.PI) / 180;
          const X = add(mul(X0, Math.cos(rot)), mul(Y0, Math.sin(rot))), Y = cross(d, X);
          const t = ev(f.thickness), K = ev(f.kFactor), R0 = ev(f.radius ?? 0);
          if (!(t > 0)) throw new Error('The thickness must be greater than zero');
          if (!(K >= 0 && K <= 1)) throw new Error('The K-factor must be between 0 and 1');
          const spec = (k) => ({ shape: f[k + 'Shape'], d: ev(f[k + 'D']), w: ev(f[k + 'W']), l: ev(f[k + 'L']), size: ev(f[k + 'Size']), basis: f[k + 'Basis'] });
          const raw = [SM.transitionEnd(spec('b')), SM.transitionEnd(spec('t'))];
          // the sizes are of the inside (material outward), the outside (material inward) or the middle of
          // the thickness (the outside surface half a thickness out, across the slope of the wall)
          const dims = f.dims || 'inside';
          const rEq = (e) => (e.kind === 'round' ? e.r : e.corners.reduce((a, c) => a + Math.hypot(c[0], c[1]), 0) / e.M);
          const slope = Math.hypot(h, rEq(raw[0]) - rEq(raw[1])) / h;
          const grow = dims === 'mean' ? (t / 2) * slope : 0;
          const [bot, top] = grow ? [SM.transitionEnd(spec('b'), grow), SM.transitionEnd(spec('t'), grow)] : raw;
          const bent = f.method === 'bent', rr = bot.kind === 'round' && top.kind === 'round';
          // bent: one fold per division; formed: the surface finer (a whole number of facets a line) and the
          // division count the forming lines in the flat pattern
          const nLines = Math.round(ev(rr ? f.divsRound ?? 24 : f.divs ?? 6));
          if (!(nLines >= 1 && nLines <= 200)) throw new Error(bent ? 'The number of bends must be 1 to 200' : 'The number of forming lines must be 1 to 200');
          const perLine = bent ? 1 : Math.max(1, Math.ceil((rr ? 96 : 16) / nLines)), div = nLines * perLine;
          const pieces = SM.transitionParts({
            o, d, X, Y, h, bot, top, off: [ev(f.offX ?? 0), ev(f.offY ?? 0)], parts: ev(f.parts), seamAt: f.seamAt || 'mid',
            seamShift: !!f.seamShift, seamAngle: (ev(f.seamAngle ?? 0) * Math.PI) / 180, div, gap: ev(f.seamGap ?? 0),
          });
          let nb = 0;
          for (const pc of pieces) {
            const sheet = SM.loftedSheet(pc.A, pc.B, { t, K, R: R0, method: bent ? 'bent' : 'formed', side: dims === 'inside' ? 1 : -1, breaks: pc.breaks });
            if (!bent) sheet.lofted.bendLines = SM.formLines(sheet.lofted, { breaks: pc.breaks });
            nb += sheet.lofted.bendLines.length;
            const shape = SM.toSolid(sheet);
            const rec = bodyRec(newId(f.id), shape, f.id);
            rec.sheet = sheet;
            solids.push(rec);
            applied.push({ op: 'add', tool: shape });
          }
          body = compoundOf(solids);
          const n = pieces.length;
          res.notes[f.id] = `${n} part${n === 1 ? '' : 's'}, height ${+h.toFixed(3)} mm` + (bent ? ` · ${nb / n} bend${nb / n === 1 ? '' : 's'} a part` : ` · formed (rolled)${nb ? `, ${nb / n} sharp fold${nb / n === 1 ? '' : 's'} a part` : ''}`);
          break;
        }
        case 'smHem': {
          needEdges('Hem');
          if (!f.edges?.length) throw new Error('Click the edges to hem (straight edges on the top or bottom face of the sheet)');
          const { rec, edges } = sheetEdges(f.edges);
          res.features[f.id] = { edges: f.edges };
          const sheet = sheetChecked(rec);
          const out = SM.addHems(sheet, edges, {
            type: f.hemType || 'closed', length: ev(f.length), gap: ev(f.gap ?? 0), R: ev(f.radius ?? 1), angle: f.hemType === 'teardrop' ? ev(f.tearAngle ?? 225) : ev(f.angle ?? 270),
            position: f.position || 'inside', flip: !!f.flip, relief: { type: f.reliefType || 'rect', ratio: ev(f.reliefRatio ?? 0.5) },
          });
          setSheet(rec, out);
          break;
        }
        case 'smFlange': {
          needEdges('Edge flange');
          if (!f.edges?.length) throw new Error('Click the edges to add flanges to (straight edges on the top or bottom face of the sheet)');
          const { rec, edges } = sheetEdges(f.edges);
          res.features[f.id] = { edges: f.edges };
          const sheet = sheetChecked(rec);
          const R0 = f.useDefaultRadius !== false ? sheet.R : ev(f.radius);
          if (!(R0 > 0)) throw new Error('The bend radius must be greater than zero');
          let out = SM.addFlanges(sheet, edges, {
            length: ev(f.length), lengthRef: f.lengthRef, angle: ev(f.angle), position: f.position, offset: ev(f.offset || 0),
            R: R0, flip: !!f.flip, relief: { type: f.reliefType || 'rect', ratio: ev(f.reliefRatio ?? 0.5) },
          });
          // corners between these flanges: closed with the gap (older parts: open)
          if ((f.corner === 'closed' || f.corner === 'butt') && edges.length > 1) {
            const gap = ev(f.cornerGap ?? 0.1);
            if (!(gap >= 0)) throw new Error('The corner gap can\'t be negative');
            const only = new Set(out.bends.slice(sheet.bends.length).map((b) => b.id));
            out = SM.closedCorner(out, { gap, swap: !!f.cornerSwap, only, quiet: true, type: f.corner === 'butt' ? 'butt' : 'overlap', bend: f.cornerBend || 'vcut' });
            if (out.cornerCount) res.notes[f.id] = `${out.cornerCount} corner${out.cornerCount === 1 ? '' : 's'} closed`;
          }
          setSheet(rec, out);
          break;
        }
        case 'smCornerRelief': {
          const rec = sheetOf(f.body);
          const out = SM.cornerRelief(sheetChecked(rec), { type: f.reliefType || 'rect', size: ev(f.size) });
          setSheet(rec, out);
          res.notes[f.id] = `${out.cornerCount} corner${out.cornerCount === 1 ? '' : 's'}`;
          break;
        }
        case 'smClosedCorner': {
          // picked flange faces: each closes the corner nearest to it (the matching flange is found);
          // none picked: every corner of the body
          let rec = null, picks = null;
          if (f.faces?.length) {
            picks = [];
            f.faces.forEach((fc, i) => {
              let best = null;
              for (const r of sheetRecs()) {
                if (!r.sheet || r.sheet.flat) continue;
                const c = SM.cornerAt(r.sheet, fc.p);
                if (c && (!best || c.dist < best.c.dist)) best = { r, c };
              }
              if (!best || best.c.dist > Math.max(0.5, best.r.sheet.t)) throw new Error(`Corner ${i + 1}: click a face of a flange next to a corner`);
              if (rec && best.r !== rec) throw new Error('Pick corners on one sheet metal body at a time');
              rec = best.r;
              picks.push(best.c);
            });
          } else rec = sheetOf(f.body);
          const gap = ev(f.gap || 0);
          if (!(gap >= 0)) throw new Error('The gap can\'t be negative');
          const out = SM.closedCorner(sheetChecked(rec), { gap, swap: !!f.swap, type: f.cornerType || 'overlap', picks, bend: f.bendCorner || 'vcut' });
          setSheet(rec, out);
          res.notes[f.id] = `${out.cornerCount} corner${out.cornerCount === 1 ? '' : 's'} closed`;
          break;
        }
        case 'smUnfold': {
          let rec, pt = null;
          if (f.face) {
            const hit = findFaceAny(sheetRecs(), f.face);
            if (!hit) throw new Error('The fixed face could not be found on a sheet metal body');
            rec = hit.body; pt = f.face.p;
          } else rec = sheetOf(f.body);
          setSheet(rec, SM.unfoldSheet(sheetChecked(rec), pt));
          break;
        }
        case 'smFold': {
          const recs = f.body ? [sheetOf(f.body)] : sheetRecs().filter((r) => r.sheet.flat);
          if (!recs.length) throw new Error('No sheet metal body is unbent (use Unbend first)');
          for (const rec of recs) {
            if (!rec.sheet.flat) throw new Error('This sheet metal body is not unbent');
            setSheet(rec, SM.refoldSheet(sheetChecked(rec)));
          }
          break;
        }
        case 'smConvert': {
          if (!f.face) throw new Error('Click the face of the body that stays fixed (it becomes the flat reference)');
          // (surfaces first: a face copied from a solid lies on the solid's face)
          const hit = findFaceAny([...surfaces, ...solids], f.face);
          if (!hit) throw new Error('The selected face could not be found');
          const rec = hit.body;
          if (rec.sheet) throw new Error('This body is already sheet metal');
          const isSurface = surfaces.includes(rec);
          // a curved surface is rolled from the flat (its bends follow its own curvature)
          const rolledSurf = isSurface && rec.shape.faces.some((fc) => fc.geomType !== 'PLANE');
          // a solid's thickness and bend radii are read from it unless set instead (autoThickness / autoRadius off)
          const autoT = f.autoThickness !== false, autoR = f.autoRadius !== false;
          const R0 = ev(f.radius), K = ev(f.kFactor);
          if (((isSurface && !rolledSurf) || (!isSurface && !autoR)) && !(R0 > 0)) throw new Error('The bend radius must be greater than zero');
          if (!(K >= 0 && K <= 1)) throw new Error('The K-factor must be between 0 and 1');
          let faces, t;
          const normalOf = (fc) => { const nv = fc.normalAt(); const n = vec(nv); nv.delete?.(); return unit(n); };
          // a surface's thickness goes behind it ('one', against the face normals), in front ('other') or
          // half each side ('mid'); older parts: the Flip tick box
          const thickSide = f.thickSide || (f.flip ? 'other' : 'one');
          let flatSurf = rec.shape, fixedAt = null;
          if (isSurface) {
            res.detected[f.id] = { kind: 'surface', curved: rolledSurf };
            t = ev(f.thickness);
            if (!(t > 0)) throw new Error('The thickness must be greater than zero');
            if (rolledSurf && rec.shape.faces.length > 1) throw new Error('A curved surface can be converted when it is one face: copy just the face you want (Surfaces ▸ Copy Surface) and convert the copy');
            if (!rolledSurf && thickSide === 'mid') {
              // symmetric: the sheet's own side is the surface moved half a thickness forward (its faces still
              // meeting at their edges); the picked face is then the moved face nearest the click
              try { flatSurf = offsetShell(rec.shape, t / 2); } catch { flatSurf = null; }
              if (!flatSurf?.faces?.length) throw new Error('The surface could not be offset by half the thickness: put the thickness on one side');
              const q = new R.DistanceQuery(R.makeVertex(f.face.p));
              try { let bd = Infinity; for (const fc of flatSurf.faces) { const d = q.distanceTo(fc); if (d < bd) { bd = d; fixedAt = fc; } } } finally { q.delete?.(); }
            }
            if (!rolledSurf) faces = flatSurf.faces.map((fc) => {
              if (fc.geomType !== 'PLANE') throw new Error('A surface of flat faces and curved faces together cannot be converted: convert a curved face on its own (copy it with Copy Surface)');
              const n = normalOf(fc);
              return { face: fc, n: thickSide === 'other' ? mul(n, -1) : n };
            });
          }
          let sheet, exact = false, detected = null, rolled = null;
          if (rolledSurf) {
            const tol = ev(f.rollTol ?? SM.ROLL_TOL);
            if (!(tol > 0)) throw new Error('The arc fit tolerance must be greater than zero');
            ({ sheet, rolled } = SM.fromCurvedFace(rec.shape.faces[0], { t, K, side: thickSide, tol, trim: f.trimSelf !== false }));
            res.detected[f.id] = { kind: 'surface', curved: true, ...rolled };
          } else if (isSurface) {
            const fixed = faces.findIndex((x) => x.face.isSame(fixedAt || hit.face));
            if (fixed < 0) throw new Error('Pick a flat face of the sheet (not one of its edge faces)');
            sheet = SM.fromFaces(faces, fixed, { t, R: R0, K });
          } else {
            // a solid: follow the picked side of the sheet through its flat faces and bends
            const tSet = autoT ? null : ev(f.thickness);
            if (!autoT && !(tSet > 0)) throw new Error('The thickness must be greater than zero');
            ({ sheet, exact, detected } = SM.fromSolid(rec.shape, hit.face, { R: R0, K, t: tSet, Rset: autoR ? null : R0 }));
            res.detected[f.id] = detected;
            if (detected.sharp && !(R0 > 0)) throw new Error('The bend radius for sharp edges must be greater than zero');
            t = sheet.t;
          }
          const shape = SM.toSolid(sheet);
          // does the sheet account for the whole body? (only when all its bends are the body's own: sharp
          // edges turned into bends change the corners)
          let match = '';
          if (exact) {
            try {
              const v0 = R.measureVolume(rec.shape), v1 = R.measureVolume(shape), dv = (v1 - v0) / v0;
              if (Math.abs(dv) > 0.005) match = ` · ⚠ ${dv > 0 ? 'more' : 'less'} material than the body (${(dv * 100).toFixed(1)} %): check for features that are not part of the sheet`;
            } catch { /* no check */ }
          }
          if (isSurface) {
            surfaces = surfaces.filter((x) => x !== rec);
            const nr = bodyRec(newId(f.id), shape, f.id);
            nr.sheet = sheet;
            solids.push(nr);
            body = compoundOf(solids);
          } else {
            const recs = replaceSolid(rec, shape, f.id);
            for (const r of recs) r.sheet = sheet;
          }
          applied.push({ op: 'add', tool: shape });
          const set = (auto, what) => (isSurface ? '' : auto ? ` (${what} the body)` : ' (set)');
          const radii = [...new Set(sheet.bends.map((b) => +b.R.toFixed(3)))].map((r) => 'R' + r).join(', ');
          // (radii from the body with a thickness set instead: the picked side's radii are kept, so a bend
          // whose outside was picked has a different inside radius than in the body)
          const sharp = detected?.sharp || 0, formed = detected?.bends || 0;
          const rWhy = isSurface ? '' : !autoR ? ' (set)' : !formed ? ' (sharp edges: the radius set)'
            : `${autoT ? ' (as in the body)' : ' (the picked side\'s bends kept)'}${sharp ? `, sharp edges R${+R0.toFixed(3)}` : ''}`;
          res.notes[f.id] = rolled
            ? `Thickness ${+t.toFixed(4)} mm · rolled: ${rolled.bends} bend${rolled.bends === 1 ? '' : 's'}${rolled.bends ? ` R${+rolled.rMin.toFixed(2)}${rolled.rMax - rolled.rMin > 0.005 ? `–R${+rolled.rMax.toFixed(2)}` : ''}` : ''}${rolled.straight ? ` + ${rolled.straight} straight run${rolled.straight === 1 ? '' : 's'}` : ''}, following the surface to within ${rolled.tol} mm${rolled.trimmed?.at ? ` · trimmed back ${+rolled.trimmed.length.toFixed(2)} mm at its ${rolled.trimmed.at} (it would run into itself)` : rolled.trimmed?.overlaps ? ' · ⚠ the sheet runs into itself (tick "Trim where it would run into itself")' : ''}`
            : `Thickness ${+t.toFixed(4)} mm${set(autoT, 'from')} · ${sheet.bends.length} bend${sheet.bends.length === 1 ? '' : 's'}${radii ? ` ${radii}${rWhy}` : ''}${match}`;
          break;
        }
        case 'axis': {
          let o, d;
          if (f.axisType === 'twoPlanes') {
            const A = resolveFrame(f.planeA), B = resolveFrame(f.planeB);
            const n1 = A.n, n2 = B.n, h1 = dot(n1, A.o), h2 = dot(n2, B.o);
            d = cross(n1, n2);
            const det = dot(n1, n1) * dot(n2, n2) - dot(n1, n2) ** 2;
            if (len(d) < 1e-9 || det < 1e-12) throw new Error('The two planes are parallel');
            o = add(mul(n1, (h1 * dot(n2, n2) - h2 * dot(n1, n2)) / det), mul(n2, (h2 * dot(n1, n1) - h1 * dot(n1, n2)) / det));
          } else if (f.axisType === 'twoPoints') {
            const a = resolvePoint(f.pointA), b = resolvePoint(f.pointB);
            o = a; d = sub(b, a);
            if (len(d) < 1e-9) throw new Error('The two points coincide');
          } else if (f.axisType === 'edge') {
            if (!f.edge) throw new Error('Select a straight or circular edge on the model');
            needEdges('Axis from an edge');
            const e = findEdge(body, f.edge);
            if (!e) throw new Error('The selected edge could not be found in the model');
            updateEdgeRef(f.edge, e, body);
            res.features[f.id] = { edge: f.edge };
            const g = edgeGeom(e, bbox(body).diag);
            if (g?.type === 'line') { o = g.a; d = sub(g.b, g.a); }
            else if (g?.type === 'circle' || g?.type === 'arc') { o = g.c; d = g.normal; }
            else throw new Error('Select a straight or circular edge');
          } else if (f.axisType === 'cylinder') {
            if (!f.face) throw new Error('Click a cylindrical or conical face on the model');
            const hit = findFaceAny([...solids, ...surfaces], f.face);
            if (!hit) throw new Error('The selected face could not be found in the model');
            const ax = faceAxis(hit.face);
            if (!ax) throw new Error('Select a cylindrical or conical face');
            const c = vec(hit.face.center); // centre the axis on the face
            o = add(ax.o, mul(ax.d, dot(sub(c, ax.o), ax.d)));
            d = ax.d;
          } else if (f.axisType === 'sketchLine') {
            const [fid, cid] = String(f.sketchLine || '').split(':');
            const s = sketches.get(fid);
            const c = s && S.getCurve(s.sk, cid);
            if (!c || c.type !== 'line') throw new Error('Select a sketch line');
            const p1 = S.getPoint(s.sk, c.p1), p2 = S.getPoint(s.sk, c.p2);
            o = S.fromFrame2D(s.frame, p1.x, p1.y); d = sub(S.fromFrame2D(s.frame, p2.x, p2.y), o);
          } else throw new Error('Choose how to define the axis');
          d = mul(d, 1 / len(d));
          axes.set(f.id, { o, d });
          res.axes[f.id] = { o, d };
          break;
        }
        case 'point': {
          let p;
          if (f.pointType === 'coords') p = [ev(f.x), ev(f.y), ev(f.z)];
          else if (f.pointType === 'vertex') p = resolvePoint(null, f.vertex);
          else if (f.pointType === 'arcCenter' || f.pointType === 'edgeMid') {
            if (!f.edge) throw new Error('Select an edge on the model');
            needEdges('Point from an edge');
            const e = findEdge(body, f.edge);
            if (!e) throw new Error('The selected edge could not be found in the model');
            updateEdgeRef(f.edge, e, body);
            if (f.pointType === 'edgeMid') p = vec(e.pointAt(0.5));
            else {
              const g = edgeGeom(e, bbox(body).diag);
              if (g?.type !== 'circle' && g?.type !== 'arc') throw new Error('Select a circular edge (arc or circle)');
              p = g.c;
            }
          } else throw new Error('Choose how to define the point');
          if (f.vertex || f.edge) res.features[f.id] = { vertex: f.vertex, edge: f.edge };
          points.set(f.id, p);
          res.points[f.id] = p;
          break;
        }
      }
      };
      await runFeature(f);
    } catch (e) {
      // a broken kernel is not a feature error: stop, so the worker is replaced and the rebuild retried
      if (isFatal(e)) throw e;
      resetStack();
      // OpenCascade failures arrive as WebAssembly exceptions (or numbers) without a message
      const raw = typeof e === 'number' || (typeof WebAssembly !== 'undefined' && WebAssembly.Exception && e instanceof WebAssembly.Exception) || !e?.message;
      const hint = { shell: ' — try a smaller thickness (inward shells fail where a fillet radius is smaller than the wall), or remove different faces',
        thicken: ' — try a smaller thickness', surfOffset: ' — try a smaller distance', split: ' — check that the tool cuts right through the bodies' }[f.type] || '';
      res.errors.push([f.id, raw ? `The geometry kernel could not compute this ${f.type === 'moveBody' ? 'move' : 'feature'}${hint}` : e.message]);
    }
    timing.features.push([f.name, Math.round(performance.now() - tf)]);
    // any other feature that changes the solid ends the run of blends
    if (body !== bodyIn && f.type !== 'fillet' && f.type !== 'chamfer') blendChain = null;
    // a blend recomputed in a different order replays the features in between; only boolean
    // features (and blends) can be replayed that way
    if (body !== bodyIn) steps.push({ before: bodyIn, applied: [...applied], blend: blendStep, opaque: !blendStep && !['extrude', 'revolve', 'lpattern', 'cpattern', 'mirror'].includes(f.type) });
    if (body !== bodyIn) featureDiffs.set(f.id, { before: bodyIn, after: body });
    if (f.id === previewId) {
      // show the model as it was before this feature, with the feature's effect as a preview
      const tp = performance.now();
      try { res.preview = makePreview(f, bodyIn, body, applied, blendPair); } catch (e) { if (isFatal(e)) throw e; res.preview = null; }
      timing.preview = performance.now() - tp;
      body = bodyIn;
      solids = solidsIn;
      surfaces = surfacesIn;
      break;
    }
    if (entries) entries[fi] = { json: fjson[fi], snap: takeSnap() };
  }
  if (useCache) rebuildCache = { eqKey, entries };


  if (opts.partial) return { solids, surfaces, features: res.features };
  lastFeatureDiffs = featureDiffs;
  lastSketchBodies = sketchBodies;
  lastFacePts = [];
  lastBody = body;
  lastSolids = solids;
  lastSurfaces = surfaces;
  lastName = doc.name || 'Part';
  const transfer = [];
  if (body || surfaces.length) {
    const parts = [...(solids.length ? solids : body ? [{ id: 'body', shape: body, last: null }] : []).map((x) => ({ ...x, kind: 'solid' })), ...surfaces.map((x) => ({ ...x, kind: 'surface' }))];
    const b = bboxOfAll(parts.map((s) => s.shape));
    // tolerances in steps of 2x, so they (and the cached meshes) only change when the model size really does
    const tol = 2 ** Math.round(Math.log2(Math.max(0.005, b.diag * 0.0004)));
    const diagQ = 2 ** Math.round(Math.log2(Math.max(1e-3, b.diag)));
    // each body is meshed on its own (so every face and edge knows its body), and only when it changed
    timing.meshStart = performance.now();
    progressFeature = null; // (meshing: no one feature to blame)
    const meshes = parts.map((s, i) => meshPart(s, tol, diagQ, () => progress(0.8 + (0.2 * i) / parts.length, parts.length > 1 ? `Meshing body ${i + 1} of ${parts.length}…` : 'Meshing…')));
    const key = `${KERNEL_SESSION}|${tol}|` + parts.map((s) => `${shapeId(s.shape)}:${s.id}:${s.kind}:${s.last}`).join('|');
    const dense = meshes.some((m) => m.dense);
    const bodies = [];
    let nv = 0, nt = 0, nf = 0, ne = 0;
    parts.forEach((s, i) => {
      const m = meshes[i];
      // (color / transparency: the look an import gave the body)
      bodies.push({ id: s.id, kind: s.kind, last: s.last, feats: s.feats, sheet: s.sheet ? SM.sheetInfo(s.sheet) : null, member: s.member || null, ...(s.look ? { color: s.look.c, transparency: s.look.t } : {}), faceStart: nf, faceCount: m.m.faceGroups.length, triStart: nt, triCount: m.m.triangles.length, edgeStart: ne, edgeCount: m.edges.length });
      for (const pts of m.facePts) lastFacePts.push(pts);
      nv += m.m.vertices.length; nt += m.m.triangles.length; nf += m.m.faceGroups.length; ne += m.edges.length;
    });
    if (opts.haveMesh && opts.haveMesh === key) {
      // the interface already shows exactly this mesh
      res.body = { same: true, key, bodies, dense };
    } else {
      const vertices = new Float32Array(nv), normals = new Float32Array(nv), triangles = new Uint32Array(nt);
      const faceGroups = [], edges = [];
      let ov = 0, ot = 0;
      parts.forEach((s, i) => {
        const { m, gs } = meshes[i];
        vertices.set(m.vertices, ov); normals.set(m.normals, ov);
        const base = ov / 3;
        for (let q = 0; q < m.triangles.length; q++) triangles[ot + q] = m.triangles[q] + base;
        // face groups in index units (replicad may count triangles or indices)
        m.faceGroups.forEach((g, gi) => faceGroups.push({ start: ot + g.start * gs, count: g.count * gs, faceId: g.faceId, ...(meshes[i].surfs?.[gi] ? { surf: meshes[i].surfs[gi] } : {}), ...(meshes[i].faceLooks?.[gi] ? { look: meshes[i].faceLooks[gi] } : {}) }));
        for (const e of meshes[i].edges) edges.push(e);
        ov += m.vertices.length; ot += m.triangles.length;
      });
      res.body = { key, vertices, normals, triangles, faceGroups, edges, dense, bodies };
      transfer.push(vertices.buffer, normals.buffer, triangles.buffer);
    }
    lastDiag = b.diag;
    lastMeshTol = tol;
  } else res.body = null;
  if (res.body) timing.mesh = Math.round(performance.now() - (timing.meshStart ?? performance.now()));
  res.time = performance.now() - t0;
  res.timing = timing;
  return { res, transfer };
}

// Refresh the targets of projected (linked) geometry from their sources.
function updateProjections(f, frame, body, sketches, surfaceShapes = []) {
  let lost = 0;
  const cache = new Map();
  const diag = body ? bbox(body).diag : 100;
  for (const k of f.constraints) {
    if (k.type !== 'projected' || !k.src) continue;
    const src = k.src;
    let prims = null;
    try {
      if (src.kind === 'sketch') {
        const key = 's:' + src.fid + ':' + src.cid;
        if (!cache.has(key)) {
          const s = sketches.get(src.fid);
          const c = s && S.getCurve(s.sk, src.cid);
          cache.set(key, c ? S.projectCurve(frame, S.curve3D(s.sk, c, s.frame)) : null);
        }
        prims = cache.get(key);
      } else if (src.kind === 'sketchPoint') {
        const s = sketches.get(src.fid);
        const p = s && S.getPoint(s.sk, src.pid);
        prims = p ? [{ type: 'point', p: S.toFrame2D(frame, S.fromFrame2D(s.frame, p.x, p.y)) }] : null;
      } else if (src.kind === 'edge') {
        const key = 'e:' + src.p.join(',');
        if (!cache.has(key)) {
          const e = findEdge(body, src);
          cache.set(key, e ? { e, prims: S.projectCurve(frame, edgeGeom(e, diag)) } : null);
        }
        const hit = cache.get(key);
        if (hit) { prims = hit.prims; updateEdgeRef(src, hit.e, body); }
      } else if (src.kind === 'section') {
        // intersection curves: where the sketch plane cuts the bodies
        if (!cache.has('section')) cache.set('section', sectionPrims([...(body ? solidsOf(body) : []), ...surfaceShapes], frame, diag));
        prims = cache.get('section');
      } else if (src.kind === 'vertex') {
        const best = findVertex(body, src);
        if (best) {
          src.p = best;
          const b = bbox(body);
          src.box = { min: b.min, max: b.max };
          prims = [{ type: 'point', p: S.toFrame2D(frame, best) }];
        }
      }

    } catch { prims = null; }
    if (!prims || !S.updateProjected(f, k, prims)) lost++;
  }
  return lost;
}

// Export all bodies, or just one (bodyId). `info` maps body ids to { name, color } so the
// STEP file carries each body's name and material colour.
async function exportBody(format, bodyId = null, info = {}) {
  if (!lastBody && !lastSurfaces.length) throw new Error('There is no body to export');
  let list = [...(lastSolids.length ? lastSolids : lastBody ? [{ id: 'body', shape: lastBody }] : []), ...lastSurfaces];
  if (bodyId) {
    list = list.filter((s) => s.id === bodyId);
    if (!list.length) throw new Error('That body no longer exists');
  }
  const shape = compoundOf(list);
  let blob;
  if (format === 'step') {
    blob = R.exportSTEP(list.map((s) => ({ shape: s.shape, name: info[s.id]?.name || lastName, ...(info[s.id]?.color ? { color: info[s.id].color } : {}) })), { unit: 'mm' });
  } else if (format === 'obj' || format === '3mf') {
    const parts = list.map((r) => ({ name: info[r.id]?.name || lastName, ...meshArrays(r.shape) }));
    return format === 'obj' ? new TextEncoder().encode(objText(parts)) : threeMF(parts);
  } else {
    const b = bbox(shape);
    blob = shape.blobSTL({ binary: true, tolerance: Math.max(0.002, b.diag * 0.0002), angularTolerance: 0.1 });
  }
  return new Uint8Array(await blob.arrayBuffer());
}

// ------------------------------------------------------------ surfaces, shells, splitting, moving
const ocList = (shapes) => { const L = new (R.getOC()).NCollection_List_TopoDS_Shape(); for (const x of shapes) L.Append(x.wrapped || x); return L; };

// ---- measure
// refs: { kind: 'vertex' | 'point', p } | { kind: 'edge' | 'face', p } | { kind: 'body', id } |
// { kind: 'seg', a, b } (a sketch line) | { kind: 'plane', o, n }. One entity: its size; two:
// the shortest distance between them (with the closest points) and the angle when there is one.
function measureRefs(refs) {
  const all = [...(lastSolids.length ? lastSolids : lastBody ? [{ id: 'body', shape: lastBody }] : []), ...lastSurfaces];
  const allShape = all.length ? compoundOf(all) : null;
  const diag = allShape ? bbox(allShape).diag : 100;
  const dirOf = (g) => (g?.type === 'line' ? unit(sub(g.b, g.a)) : null);
  const item = (r) => {
    if (r.kind === 'vertex' || r.kind === 'point') return { shape: R.makeVertex(r.p), info: { type: 'point', p: r.p } };
    if (r.kind === 'edge') {
      const e = allShape && findEdge(allShape, r);
      if (!e) throw new Error('A selected edge could not be found');
      const g = edgeGeom(e, diag);
      return { shape: e, dir: dirOf(g), info: { type: 'edge', length: R.measureLength(e), curve: g?.type, radius: g?.r ?? null } };
    }
    if (r.kind === 'face') {
      const h = findFaceAny(all, r);
      if (!h) throw new Error('A selected face could not be found');
      const planar = h.face.geomType === 'PLANE';
      const n = planar ? unit(vec(h.face.normalAt())) : null;
      const ax = planar ? null : faceAxis(h.face);
      return { shape: h.face, normal: n, axis: ax, info: { type: 'face', area: R.measureArea(h.face), planar, radius: ax ? radiusOfFace(h.face) : null } };
    }
    if (r.kind === 'body') {
      const b = all.find((x) => x.id === r.id);
      if (!b) throw new Error('A selected body no longer exists');
      const solid = lastSolids.includes(b);
      return { shape: b.shape, info: { type: 'body', solid, volume: solid ? R.measureVolume(b.shape) : null, area: R.measureArea(b.shape) } };
    }
    if (r.kind === 'seg') return { shape: R.makeLine(r.a, r.b), dir: unit(sub(r.b, r.a)), info: { type: 'edge', length: len(sub(r.b, r.a)), curve: 'line' } };
    if (r.kind === 'plane') return { shape: planeFace(r.o, r.n), normal: unit(r.n), info: { type: 'plane' } };
    throw new Error('That item cannot be measured');
  };
  const items = refs.map(item);
  const out = { items: items.map((i) => i.info) };
  if (items.length === 2) {
    const oc = R.getOC();
    const t = new oc.BRepExtrema_DistShapeShape();
    try {
      t.LoadS1(items[0].shape.wrapped);
      t.LoadS2(items[1].shape.wrapped);
      t.Perform();
      if (t.IsDone() && t.NbSolution() > 0) {
        const p1 = t.PointOnShape1(1), p2 = t.PointOnShape2(1);
        out.distance = t.Value();
        out.a = [p1.X(), p1.Y(), p1.Z()];
        out.b = [p2.X(), p2.Y(), p2.Z()];
      }
    } finally { t.delete(); }
    // the angle between two lines, two flat faces/planes, or a line and a flat face
    const [A, B] = items;
    const ang = (u, v) => (Math.acos(Math.min(1, Math.abs(dot(u, v)))) * 180) / Math.PI;
    if (A.dir && B.dir) out.angle = ang(A.dir, B.dir);
    else if (A.normal && B.normal) out.angle = ang(A.normal, B.normal);
    else if (A.dir && B.normal) out.angle = 90 - ang(A.dir, B.normal);
    else if (A.normal && B.dir) out.angle = 90 - ang(B.dir, A.normal);
    // centre to centre for two round faces / circular edges
    if (A.axis && B.axis) out.centerDistance = len(rej(sub(B.axis.o, A.axis.o), A.axis.d));
  }
  return out;
}

function radiusOfFace(face) {
  const oc = R.getOC();
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, false);
  try { return face.geomType === 'CYLINDRE' ? ad.Cylinder().Radius() : null; } finally { ad.delete(); }
}

// Sketch frame with its axes turned by `rot` degrees (multiples of 90) about the normal.
function orientFrame(fr, rot) {
  let { o, u, v, n } = fr;
  for (let i = 0; i < ((((rot || 0) / 90) % 4) + 4) % 4; i++) [u, v] = [v, mul(u, -1)];
  return { o, u, v, n };
}

// Curves where a sketch plane cuts solid and surface bodies, as 2D primitives in the sketch.
function sectionPrims(shapes, fr, diag) {
  const oc = R.getOC(), face = planeFace(fr.o, fr.n);
  const out = [];
  for (const s of shapes) {
    let sec = null;
    const op = new oc.BRepAlgoAPI_Section(s.wrapped, face.wrapped, false);
    try { op.Build(new oc.Message_ProgressRange()); if (!op.HasErrors()) sec = R.cast(op.Shape()); } catch (e) { if (isFatal(e)) throw e; } finally { op.delete(); }
    if (sec) for (const e of sec.edges) out.push(...S.projectCurve(fr, edgeGeom(e, diag)));
  }
  return out.filter((g) => g.type !== 'point');
}

// ------------------------------------------------------------ drawings
// Views of a part for a drawing (drawing.js). views: [{ id, dir, up, section: { o, n } | null }]:
// dir points from the model toward the viewer, up is the view's vertical. A section view cuts the
// part with the plane through o with normal n (the part on the n side is removed) and also returns
// the cut faces (for hatching). Output per view, in view coordinates (x right, y up, model mm):
// { edges: [{ k, g }], cut: [[loop, hole loops…]…], box } where k: 'v' visible, 't' visible tangent,
// 'h' hidden, 'ht' hidden tangent, and g: { t: 'l', a, b } | { t: 'c', c, r } | { t: 'a', c, r, a0, a1 }
// (counter-clockwise, radians) | { t: 'p', pts }.
let drawingCache = { key: null, shape: null, solids: [], doc: null };
async function drawingViews(docJson, views) {
  await ensureDrawingCache(docJson);
  const shape = drawingCache.shape;
  if (!shape) throw new Error('The part has no solid body to draw');
  return drawingViewsOf(shape, views);
}
async function ensureDrawingCache(docJson) {
  if (drawingCache.key !== docJson) {
    const doc = JSON.parse(docJson);
    doc.rollbackAt = null;
    const part = await rebuild(doc, null, { partial: true });
    const list = part.solids.length ? part.solids : [];
    // holes made by the Hole feature (for hole callouts)
    const holes = [];
    for (const r of Object.values(part.features || {})) for (const h of r.holes || []) if (r.sizes) holes.push({ p: h.p, dir: h.dir, sizes: r.sizes, through: r.through, depth: r.depth, thread: r.thread });
    drawingCache = { key: docJson, shape: list.length ? compoundOf(list) : null, solids: list, doc, holes };
  }
}
function drawingViewsOf(shape, views) {
  const box = bbox(shape);
  return views.map((v) => {
    try {
      const out = { id: v.id, ...(v.flat ? flatView(drawingCache.solids, v) : projectView(shape, box, v, drawingCache.solids)) };
      if (!v.flat) {
        // holes seen end on in this view: their centres in view coordinates
        const dir = unit(v.dir), x = unit(cross(v.up || [0, 1, 0], dir)), y = cross(dir, x);
        out.holes = drawingCache.holes.filter((h) => Math.abs(dot(unit(h.dir), dir)) > 0.999).map((h) => ({ c: [dot(h.p, x), dot(h.p, y)], sizes: h.sizes, through: h.through, depth: h.depth, thread: h.thread, near: dot(h.dir, dir) < 0 }));
      }
      return out;
    } catch (e) { if (isFatal(e)) throw e; return { id: v.id, error: e?.message || String(e), edges: [], cut: [] }; }
  });
}

// A flat pattern view: the unfolded sheet metal body (v.body, or the first one) in flat coordinates.
// Edge kinds: 'v' outline and holes, 'bu' / 'bd' bend lines up / down, 'br' bend region lines;
// notes: the bend notes ({ p, rot, text } — the drawing sizes the text).
function flatView(solids, v) {
  const sheets = solids.filter((r) => r.sheet);
  if (!sheets.length) throw new Error('The part has no sheet metal body');
  const rec = (v.body && sheets.find((r) => r.id === v.body)) || sheets[0];
  const flip = drawingCache.doc?.bodies?.[rec.id]?.flatSide === 'bottom';
  const { ents, fp, bends } = flatEnts(rec.sheet, flip);
  const edges = [];
  for (const e of ents) {
    const k = e.layer === 'OUTLINE' || e.layer === 'HOLES' ? 'v' : e.layer === 'BEND_UP' ? 'bu' : e.layer === 'BEND_DOWN' ? 'bd' : e.layer === 'BEND_REGION' ? 'br' : e.layer === 'FORMING' ? 'fm' : null;
    if (!k) continue;
    if (e.type === 'LINE') edges.push({ k, g: { t: 'l', a: e.a, b: e.b } });
    else if (e.type === 'CIRCLE') edges.push({ k, g: { t: 'c', c: e.c, r: e.r } });
    else if (e.type === 'ARC') edges.push({ k, g: { t: 'a', c: e.c, r: e.r, a0: (e.a0 * Math.PI) / 180, a1: (e.a1 * Math.PI) / 180 } });
    else if (e.type === 'POLYLINE') edges.push({ k, g: { t: 'p', pts: e.closed ? [...e.pts, e.pts[0]] : e.pts } });
  }
  const notes = bends.map((b, i) => ({ p: [(b.a[0] + b.b[0]) / 2, (b.a[1] + b.b[1]) / 2], rot: b.rot, text: b.note, len: b.len, n: i + 1, up: b.up, deg: b.deg, R: b.R }));
  return {
    edges, cut: [], notes, box: { min: [0, 0], max: [fp.size[0], fp.size[1]] },
    flat: { size: fp.size, area: fp.area, cut: SM.cutInfo(fp.region), t: rec.sheet.t, K: rec.sheet.K, R: rec.sheet.R, bends: bends.length, body: rec.id, bodies: sheets.map((r) => r.id), stale: rec.sheet.stale || null, flip },
  };
}

function projectView(shape, box, v, solids = null) {
  const oc = R.getOC();
  const dir = unit(v.dir), up0 = v.up || [0, 1, 0];
  const x = unit(cross(up0, dir)), y = cross(dir, x);
  const to2 = (p) => [dot(p, x), dot(p, y)];
  let s = shape, cut = [];
  const cutBody = []; // which body each cut region is of (its index), for its own hatching
  if (v.section) {
    const n = unit(v.section.n), o = v.section.o;
    // remove everything on the n side of the plane (a big box)
    const L = box.diag * 4 + 10;
    const u = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), w = cross(n, u);
    const c0 = add(o, add(mul(u, -L), mul(w, -L)));
    const pts = [c0, add(c0, mul(u, 2 * L)), add(add(c0, mul(u, 2 * L)), mul(w, 2 * L)), add(c0, mul(w, 2 * L))];
    const makeTool = () => R.basicFaceExtrusion(R.makePolygon(pts), new R.Vector(mul(n, L)));
    s = shape.cut(makeTool());
    // the cut faces: planar faces of the result lying in the plane
    const cutFaces = (sh, k) => {
      for (const f of sh.faces) {
        if (f.geomType !== 'PLANE') continue;
        const c = vec(f.center), nf = vec(f.normalAt());
        if (Math.abs(dot(sub(c, o), n)) > 1e-4 * Math.max(1, box.diag) || Math.abs(dot(nf, n)) < 0.9999) continue;
        const loops = [f.clone().outerWire(), ...f.clone().innerWires()].map((wire) => loopPts2(wire, to2, box.diag));
        cut.push(loops);
        cutBody.push(k);
      }
    };
    let done = false;
    if (solids && solids.length > 1) {
      // several bodies: each cut on its own, so each region is hatched as its body
      try { solids.forEach((sol, k) => cutFaces((sol.shape || sol).cut(makeTool()), k)); done = true; } catch (e) { if (isFatal(e)) throw e; cut = []; cutBody.length = 0; }
    }
    if (!done) cutFaces(s, 0);
  }
  const hlr = new oc.HLRBRep_Algo();
  hlr.Add(s.wrapped, 0);
  const ax = new oc.gp_Ax2(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(dir[0], dir[1], dir[2]), new oc.gp_Dir(x[0], x[1], x[2]));
  const proj = new oc.HLRAlgo_Projector(ax);
  hlr.Projector(proj);
  hlr.Update();
  hlr.Hide();
  const shapes = new oc.HLRBRep_HLRToShape(hlr);
  const edges = [];
  const take = (comp, k) => {
    if (comp.IsNull()) return;
    for (const e of R.cast(comp).edges) {
      oc.BRepLib.BuildCurves3d(e.wrapped);
      const g = edge2(e, box.diag);
      if (g) edges.push({ k, g });
    }
  };
  try {
    take(shapes.VCompound(), 'v');
    take(shapes.OutLineVCompound(), 'v');
    take(shapes.Rg1LineVCompound(), 't');
    take(shapes.HCompound(), 'h');
    take(shapes.OutLineHCompound(), 'h');
    take(shapes.Rg1LineHCompound(), 'ht');
  } finally {
    shapes.delete(); proj.delete(); ax.delete(); hlr.delete();
  }
  // (an edge reaching far outside the part itself is a projection fault, e.g. a swept bead seen end on: dropped)
  {
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [m & 1 ? box.max[0] : box.min[0], m & 2 ? box.max[1] : box.min[1], m & 4 ? box.max[2] : box.min[2]]);
    const xs = corners.map((q) => dot(q, x)), ys = corners.map((q) => dot(q, y)), mg = box.diag * 0.002 + 0.01;
    const lo = [Math.min(...xs) - mg, Math.min(...ys) - mg], hi = [Math.max(...xs) + mg, Math.max(...ys) + mg];
    const inside = (q) => q[0] >= lo[0] && q[0] <= hi[0] && q[1] >= lo[1] && q[1] <= hi[1];
    const ok = ({ g }) => (g.t === 'l' ? inside(g.a) && inside(g.b) : g.t === 'p' ? g.pts.every(inside) : inside([g.c[0] - g.r, g.c[1] - g.r]) && inside([g.c[0] + g.r, g.c[1] + g.r]));
    for (let i = edges.length - 1; i >= 0; i--) if (!ok(edges[i])) edges.splice(i, 1);
  }
  // the view's extent (visible and hidden lines)
  const b2 = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  const grow = (p) => { b2.min[0] = Math.min(b2.min[0], p[0]); b2.min[1] = Math.min(b2.min[1], p[1]); b2.max[0] = Math.max(b2.max[0], p[0]); b2.max[1] = Math.max(b2.max[1], p[1]); };
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
  return { edges, cut, cutBody, box: isFinite(b2.min[0]) ? b2 : { min: [0, 0], max: [0, 0] } };
}

// An HLR result edge (already in the projection plane: x, y) as a 2D primitive.
function edge2(e, diag) {
  const pts = sampleEdge(e, diag).map((p) => [p[0], p[1], 0]);
  if (pts.length < 2) return null;
  const g = S.classifyPolyline3(pts);
  const p2 = (p) => [p[0], p[1]];
  if (!g) return null;
  if (g.type === 'line') return Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) < 1e-9 ? null : { t: 'l', a: p2(g.a), b: p2(g.b) };
  if (g.type === 'circle') return { t: 'c', c: p2(g.c), r: g.r };
  if (g.type === 'arc') {
    const ang = (p) => Math.atan2(p[1] - g.c[1], p[0] - g.c[0]);
    let a0 = ang(g.a), a1 = ang(g.b);
    const am = ang(g.m), TAU = 2 * Math.PI, norm = (t) => ((t % TAU) + TAU) % TAU;
    if (norm(am - a0) > norm(a1 - a0)) [a0, a1] = [a1, a0];
    return { t: 'a', c: p2(g.c), r: g.r, a0, a1 };
  }
  return { t: 'p', pts: pts.map(p2) };
}

// A wire's points in view coordinates (a closed loop). The wire's edges do not always come in order
// round the loop: each next edge is the unused one with an end nearest the loop's end so far (and the
// first edge is turned round when the rest join at its start), else the loop crosses itself.
function loopPts2(wire, to2, diag) {
  const segs = wire.edges.map((e) => sampleEdge(e, diag)).filter((s) => s.length);
  if (!segs.length) return [];
  const gap = (s, p) => Math.min(len(sub(s[0], p)), len(sub(s[s.length - 1], p)));
  const out = segs[0].slice();
  if (segs.length > 1) {
    const near = (p) => Math.min(...segs.slice(1).map((s) => gap(s, p)));
    if (near(out[0]) < near(out[out.length - 1])) out.reverse();
  }
  const used = new Set([0]);
  while (used.size < segs.length) {
    const last = out[out.length - 1];
    let best = -1, bd = Infinity, rev = false;
    segs.forEach((s, i) => {
      if (used.has(i)) return;
      const d0 = len(sub(s[0], last)), d1 = len(sub(s[s.length - 1], last));
      if (d0 < bd) { bd = d0; best = i; rev = false; }
      if (d1 < bd) { bd = d1; best = i; rev = true; }
    });
    used.add(best);
    const pts = rev ? segs[best].slice().reverse() : segs[best];
    for (const p of pts.slice(1)) out.push(p);
  }
  return out.map(to2);
}

// ---- threads
// A thread coil: the profile corners (radius, axial offset) each follow a helix; neighbouring helices
// are joined by ruled faces and the ends are capped. (A profile swept along a helix gives a solid that
// booleans often fail to cut; this one cuts cleanly.)
function threadCoil(center, dir, pitch, length, corners, leftHand) {
  const oc = R.getOC();
  const hel = corners.map(([r, z]) => R.makeHelix(pitch, length, r, add(center, mul(dir, z)), dir, leftHand));
  const sw = new oc.BRepBuilderAPI_Sewing(1e-5, true, true, true, false);
  try {
    for (let i = 0; i < hel.length; i++) sw.Add(R.loft([hel[i], hel[(i + 1) % hel.length]], { ruled: true }, true).wrapped);
    sw.Add(R.makePolygon(hel.map((w) => vec(w.startPoint))).wrapped);
    sw.Add(R.makePolygon(hel.map((w) => vec(w.endPoint))).wrapped);
    sw.Perform(new oc.Message_ProgressRange());
    const shell = R.iterTopo(sw.SewedShape(), 'shell').next().value;
    if (!shell) throw new Error('The thread could not be built');
    const ms = new oc.BRepBuilderAPI_MakeSolid(shell);
    const solid = R.cast(ms.Solid());
    ms.delete();
    oc.BRepLib.OrientClosedSolid(solid.wrapped);
    return solid;
  } finally { sw.delete(); }
}

// ---- loft
// One closed outline of a loft profile in 3D: { circle: { c, r, n, u } } or { segs: [{ type, a, m, b }] }.
function loftSection(fr, segs) {
  const P3 = (q) => S.fromFrame2D(fr, q[0], q[1]);
  if (segs.length === 1 && segs[0].type === 'circle') return { circle: { c: P3(segs[0].c), r: segs[0].r, n: fr.n, u: fr.u } };
  return { segs: segs.map((g) => (g.type === 'line' ? { type: 'line', a: P3(g.a), b: P3(g.b) } : g.type === 'bezier' ? { type: 'bezier', a: P3(g.a), c1: P3(g.c1), c2: P3(g.c2), b: P3(g.b) } : { type: 'arc', a: P3(g.a), m: P3(g.m), b: P3(g.b) })) };
}

// Give every section the same number of segments, starting at matching points and running the same
// way round, so the loft twists as little as possible. A circle is split into as many equal arcs as
// the other profiles have segments; profiles with different segment counts are an error.
function matchLoftSections(secs, names) {
  const counts = secs.map((s) => s.segs?.length ?? 0);
  const N = Math.max(...counts);
  if (N === 0) return secs.map((s) => ({ circle: s.circle }));
  const ref = counts.findIndex((n) => n > 0);
  secs.forEach((s, i) => {
    if (s.segs && s.segs.length !== N) throw new Error(`${names[i]} has ${s.segs.length} segments but ${names[counts.indexOf(N)]} has ${N}. A loft needs the same number of points on every profile (circles are split automatically) — split the curves so the counts match.`);
  });
  const centroid = (pts) => mul(pts.reduce((a, b) => add(a, b), [0, 0, 0]), 1 / pts.length);
  const newell = (pts) => { let n = [0, 0, 0]; pts.forEach((p, i) => { n = add(n, cross(p, pts[(i + 1) % pts.length])); }); return n; };
  const refPts = secs[ref].segs.map((g) => g.a), refC = centroid(refPts), refN = unit(newell(refPts));
  const dirs = (pts, c) => pts.map((q) => unit(sub(q, c)));
  const refDirs = dirs(refPts, refC);
  return secs.map((s) => {
    if (s.circle) {
      const { c, r, n } = s.circle;
      const w = dot(n, refN) >= 0 ? n : mul(n, -1);
      let e1 = rej(refDirs[0], w);
      e1 = len(e1) > 1e-9 ? unit(e1) : unit(rej(s.circle.u, w));
      const e2 = cross(w, e1);
      const at = (t) => add(c, add(mul(e1, r * Math.cos(t)), mul(e2, r * Math.sin(t))));
      // equal arcs, starting at the reference's first point; their ends follow the reference's directions
      const ang = refDirs.map((d) => { const x = dot(d, e1), y = dot(d, e2); return Math.atan2(y, x); });
      const segs = [];
      for (let i = 0; i < N; i++) {
        const t0 = (2 * Math.PI * i) / N, t1 = (2 * Math.PI * (i + 1)) / N;
        segs.push({ type: 'arc', a: at(t0), m: at((t0 + t1) / 2), b: at(t1) });
      }
      void ang;
      return { segs };
    }
    let segs = s.segs;
    const pts = segs.map((g) => g.a);
    if (dot(newell(pts), refN) < 0) segs = segs.slice().reverse().map((g) => ({ ...g, a: g.b, b: g.a }));
    const d = dirs(segs.map((g) => g.a), centroid(segs.map((g) => g.a)));
    let best = 0, bd = Infinity;
    for (let m = 0; m < N; m++) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += len(sub(d[(i + m) % N], refDirs[i]));
      if (sum < bd) { bd = sum; best = m; }
    }
    return { segs: [...segs.slice(best), ...segs.slice(0, best)] };
  });
}

function sectionWire(s) {
  if (s.circle) return R.assembleWire([R.makeCircle(s.circle.r, s.circle.c, s.circle.n)]);
  return R.assembleWire(s.segs.map((g) => (g.type === 'line' ? R.makeLine(g.a, g.b) : g.type === 'bezier' ? R.makeBezierCurve([g.a, g.c1, g.c2, g.b]) : R.makeThreePointArc(g.a, g.m, g.b))));
}

// A closed loop of 2D sketch segments as a 3D wire.
function loopWire(fr, segs) {
  const sec = loftSection(fr, segs);
  return sectionWire(sec);
}

// ---- text
// Fonts are sent by the interface (from the PC's font folder) and registered under "Family|BI".
const fontKey = (t) => `${t.font || 'Arial'}|${t.bold ? 'B' : ''}${t.italic ? 'I' : ''}`;
function fontFor(t) {
  const f = R.getFont(fontKey(t));
  if (!f) throw new Error(`The font "${t.font || 'Arial'}" is not available`);
  return f;
}
// The text height is the height of capital letters.
const fontSizeFor = (font, h) => (h * font.unitsPerEm) / (font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7);

// One drawing per gear of the sketch's gear trains: { outline, bore }.
function gearDrawings(sk) {
  const out = [];
  for (const tr of sk.gearTrains || []) {
    const probs = S.trainProblems(sk, tr);
    if (probs.length) throw new Error(`The gear train in the sketch doesn't work: ${probs[0]}. Edit the sketch and click Fit gears to the lines`);
    for (const g of S.trainGears(sk, tr)) {
      const pts = S.gearOutline(g);
      const pen = R.draw(pts[0]);
      for (let i = 1; i < pts.length; i++) pen.lineTo(pts[i]);
      out.push({ outline: pen.close(), bore: g.bore > 0 ? R.drawSingleCircle(g.bore / 2).translate(g.cx, g.cy) : null });
    }
  }
  return out;
}

// One drawing per airfoil of the sketch (smooth Bézier pieces): { outline }.
function airfoilDrawings(sk) {
  const out = [];
  for (const af of sk.airfoils || []) {
    const why = S.airfoilProblem(sk, af);
    if (why) throw new Error(`An airfoil in the sketch can't be drawn: ${why}`);
    const pieces = S.airfoilPieces(sk, af);
    const pen = R.draw(pieces[0].a);
    pieces.forEach((q, i) => {
      const last = i === pieces.length - 1;
      if (last && !q.c1) return; // (the straight piece across a blunt trailing edge: close() draws it)
      if (q.c1) pen.cubicBezierCurveTo(q.b, q.c1, q.c2); else pen.lineTo(q.b);
    });
    out.push({ outline: pen.close(), bore: null });
  }
  return out;
}

function textDrawing(sk) {
  let all = null;
  for (const t of sk.texts || []) {
    if (!t.text?.trim()) continue;
    const font = fontFor(t);
    let d = R.drawText(t.text, { fontSize: fontSizeFor(font, t.h), fontFamily: fontKey(t) });
    if (t.angle) d = d.rotate(t.angle, [0, 0]);
    d = d.translate(t.x, t.y);
    all = all ? all.fuse(d) : d;
  }
  return all;
}

// Outlines of texts as polylines in sketch coordinates: { textId: [[x, y], ...][] }.
function textOutlines(texts) {
  const out = {};
  for (const t of texts || []) {
    let font;
    try { font = fontFor(t); } catch { out[t.id] = []; continue; }
    const size = fontSizeFor(font, t.h), a = ((t.angle || 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const P2 = (x, y) => [t.x + x * ca - y * sa, t.y + x * sa + y * ca];
    const polys = [];
    let cur = null, lx = 0, ly = 0;
    for (const c of font.getPath(t.text || '', 0, 0, size).commands) {
      if (c.type === 'M') { if (cur?.length > 1) polys.push(cur); cur = [P2(c.x, -c.y)]; lx = c.x; ly = c.y; }
      else if (c.type === 'L') { cur?.push(P2(c.x, -c.y)); lx = c.x; ly = c.y; }
      else if (c.type === 'Q') {
        for (let i = 1; i <= 8; i++) { const s = i / 8, u = 1 - s; cur?.push(P2(u * u * lx + 2 * u * s * c.x1 + s * s * c.x, -(u * u * ly + 2 * u * s * c.y1 + s * s * c.y))); }
        lx = c.x; ly = c.y;
      } else if (c.type === 'C') {
        for (let i = 1; i <= 10; i++) { const s = i / 10, u = 1 - s; cur?.push(P2(u * u * u * lx + 3 * u * u * s * c.x1 + 3 * u * s * s * c.x2 + s * s * s * c.x, -(u * u * u * ly + 3 * u * u * s * c.y1 + 3 * u * s * s * c.y2 + s * s * s * c.y))); }
        lx = c.x; ly = c.y;
      } else if (c.type === 'Z' && cur?.length) { cur.push(cur[0]); polys.push(cur); cur = null; }
    }
    if (cur?.length > 1) polys.push(cur);
    out[t.id] = polys;
  }
  return out;
}

// Axis { o, d } of a cylindrical or conical face (null for other faces).
function faceAxis(face) {
  const t = face.geomType;
  if (t !== 'CYLINDRE' && t !== 'CONE') return null;
  const oc = R.getOC();
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, false);
  try {
    const ax = (t === 'CYLINDRE' ? ad.Cylinder() : ad.Cone()).Axis(), L = ax.Location(), D = ax.Direction();
    return { o: [L.X(), L.Y(), L.Z()], d: unit([D.X(), D.Y(), D.Z()]) };
  } catch {
    return null; // (this kernel build cannot read a cone's axis: the face is measured without it)
  } finally { ad.delete(); }
}

// The faces of `body` that contain `edge`, in a stable order (by face centre).
function adjacentFaces(body, edge) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum;
  const out = [];
  for (const face of body.faces) {
    const ex = new oc.TopExp_Explorer(face.wrapped, T.TopAbs_EDGE, T.TopAbs_SHAPE);
    let hit = false;
    while (ex.More()) { if (ex.Current().IsSame(edge.wrapped)) { hit = true; break; } ex.Next(); }
    ex.delete();
    if (hit) out.push({ face, c: vec(face.center) });
  }
  const r = (x) => Math.round(x * 1e4);
  out.sort((a, b) => r(a.c[0]) - r(b.c[0]) || r(a.c[1]) - r(b.c[1]) || r(a.c[2]) - r(b.c[2]));
  return out.map((x) => x.face);
}

// Chamfer by two distances (type 'twoDist', x = second distance) or a distance and an angle
// ('angleDist', x in degrees). The first distance is measured on one of the edge's two faces;
// flip uses the other one.
function chamferAsym(body, edges, type, d1, x, flip) {
  const oc = R.getOC();
  const mk = new oc.BRepFilletAPI_MakeChamfer(body.wrapped);
  try {
    for (const e of edges) {
      const faces = adjacentFaces(body, e);
      const face = faces[flip && faces.length > 1 ? 1 : 0];
      if (!face) throw new Error('A chamfer edge has no face');
      if (type === 'twoDist') mk.Add(d1, x, e.wrapped, face.wrapped);
      else mk.AddDA(d1, (x * Math.PI) / 180, e.wrapped, face.wrapped);
    }
    return R.cast(mk.Shape());
  } finally { mk.delete(); }
}

// A face of any body near a picked point (faces of dense STL bodies are not searched).
function findFaceAny(bodies, ref) {
  const cands = [];
  for (const b of bodies) {
    if (b.dense) continue;
    for (const x of facesWithBox(b.shape)) cands.push([boxDist(x.box, ref.p), b, x.face]);
  }
  cands.sort((x, y) => x[0] - y[0]);
  let q = null, best = null, bd = Infinity;
  for (const [lb, b, face] of cands) {
    if (lb > bd + 1e-9) break; // no remaining face can be nearer
    q ||= new R.DistanceQuery(R.makeVertex(ref.p));
    const d = q.distanceTo(face);
    // (faces on top of each other, e.g. a copied surface on its solid: the body that was clicked)
    if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && ref.body && b.id === ref.body)) { bd = d; best = { body: b, face }; }
  }
  if (!best) return null;
  const diag = bbox(best.body.shape).diag;
  return bd < Math.max(1e-3, diag * 2e-3) ? best : null;
}

// The body nearest to a point (for vertices).
function bodyAt(bodies, p) {
  const q = new R.DistanceQuery(R.makeVertex(p));
  let best = null, bd = Infinity;
  for (const b of bodies) { const d = q.distanceTo(b.shape); if (d < bd) { bd = d; best = b; } }
  return best && bd < Math.max(1e-3, bbox(best.shape).diag * 1e-4) ? best : null;
}

// Wires of a sketch's (non-construction) chains, on the sketch plane.
function sketchWires(sk, fr) {
  const wires = [];
  for (const ch of S.curveChains(sk)) {
    const segs = S.chainSegs(sk, ch);
    if (segs.length === 1 && segs[0].type === 'circle') {
      wires.push(R.drawSingleCircle(segs[0].r).translate(segs[0].c[0], segs[0].c[1]).sketchOnPlane(rPlane(fr)).wire);
      continue;
    }
    const pen = R.draw(segs[0].a);
    segs.forEach((g, i) => {
      const last = i === segs.length - 1;
      if (g.type === 'line') { if (!(ch.closed && last)) pen.lineTo(g.b); }
      else if (g.type === 'bezier') pen.cubicBezierCurveTo(g.b, g.c1, g.c2);
      else pen.threePointsArcTo(g.b, g.m);
    });
    wires.push((ch.closed ? pen.close() : pen.done()).sketchOnPlane(rPlane(fr)).wire);
  }
  if (!wires.length) throw new Error('The sketch has no (non-construction) curves');
  return wires;
}

function asShape(list) { return compoundOf(list.map((shape) => ({ shape }))); }

// A surface (one or more faces) moved d along its faces' normals, the moved faces trimmed or extended to
// meet again at their edges (sharp, not rounded).
function offsetShell(shape, d) {
  const oc = R.getOC();
  const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    mk.PerformByJoin(shape.wrapped, d, 1e-6, oc.BRepOffset_Mode.BRepOffset_Skin, true, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false);
    return R.cast(mk.Shape());
  } finally { mk.delete(); }
}
function offsetFace(face, d) {
  const oc = R.getOC();
  const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
  mk.PerformByJoin(face.wrapped, d, 1e-6, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
  const out = R.cast(mk.Shape());
  mk.delete();
  return out;
}

// Split shape by a tool (an infinite plane face or a surface). Returns the solid pieces.
function splitBy(shape, tool) {
  const oc = R.getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const A = ocList([shape]), T = ocList([tool]);
  sp.SetArguments(A);
  sp.SetTools(T);
  sp.Build(new oc.Message_ProgressRange());
  if (sp.HasErrors()) { sp.delete(); throw new Error('The body could not be split'); }
  const res = R.cast(sp.Shape());
  sp.delete(); A.delete(); T.delete();
  return solidsOf(res);
}

// Edges sorted into connected chains: [{ wire, pts }] (each chain joined end to end; pts for showing it).
function chainEdges(edges) {
  const left = [...edges], out = [];
  const tol = 1e-5;
  const near = (a, b) => len(sub(a, b)) < tol;
  while (left.length) {
    const chain = [left.shift()];
    let grew = true;
    while (grew) {
      grew = false;
      const s0 = vec(chain[0].startPoint), e0 = vec(chain[chain.length - 1].endPoint);
      for (let i = 0; i < left.length; i++) {
        const e = left[i], a = vec(e.startPoint), b = vec(e.endPoint);
        if (near(a, e0)) chain.push(e);
        else if (near(b, e0)) chain.push(R.cast(e.wrapped.Reversed()));
        else if (near(b, s0)) chain.unshift(e);
        else if (near(a, s0)) chain.unshift(R.cast(e.wrapped.Reversed()));
        else continue;
        left.splice(i, 1); grew = true; break;
      }
    }
    let wire = null;
    try { wire = R.assembleWire(chain.map((e) => e.clone())); } catch { wire = null; }
    const pts = [];
    for (const e of chain) { const m = e.geomType === 'LINE' ? 1 : 24; for (let i = pts.length ? 1 : 0; i <= m; i++) pts.push(vec(e.pointAt(i / m))); }
    out.push({ wire, pts });
  }
  return out.filter((c) => c.wire);
}

// Faces unrolled into the plane: their (welded) triangles laid out one after another across shared edges,
// then relaxed so every edge keeps its length. Returns { outer, holes (2D loops), min, max, area2, area3, maxStrain }.
function flattenFaces(faces, iterations = 300) {
  const diag = bboxOfAll(faces).diag;
  const P = [], T = [], grid = new Map(), tol = Math.max(1e-6, diag * 1e-7);
  // (points are joined with other faces' points only: a face's own seam, e.g. down a tube, stays open so it can unroll)
  const weld = (q, fi, local) => {
    const k = q.map((v) => Math.round(v / tol)).join(',');
    const lk = local.get(k);
    if (lk !== undefined) return lk;
    const g = grid.get(k);
    let i;
    if (g && g.face !== fi) i = g.i;
    else { i = P.length; P.push(q); if (!g) grid.set(k, { i, face: fi }); }
    return i;
  };
  for (const [fi, fc] of faces.entries()) {
    const m = fc.mesh({ tolerance: Math.max(5e-4, diag * 1e-4), angularTolerance: 0.04 });
    const ids = [], local = new Map();
    for (let i = 0; i < m.vertices.length / 3; i++) ids.push(weld([m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]], fi, local));
    // a pole (e.g. the top of a dome) has many nodes at one point, joined by edges of no length: one point
    const root = new Map(), find = (i) => { while (root.has(i)) i = root.get(i); return i; };
    for (let k = 0; k < m.triangles.length; k += 3) for (let e = 0; e < 3; e++) {
      const a = find(ids[m.triangles[k + e]]), b = find(ids[m.triangles[k + ((e + 1) % 3)]]);
      if (a !== b && len(sub(P[a], P[b])) <= tol * 2) root.set(Math.max(a, b), Math.min(a, b));
    }
    for (let k = 0; k < m.triangles.length; k += 3) { const t = [find(ids[m.triangles[k]]), find(ids[m.triangles[k + 1]]), find(ids[m.triangles[k + 2]])]; if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) T.push(t); }
  }
  if (!T.length) throw new Error('The faces could not be meshed');
  if (T.length > 120000) throw new Error('The faces are too finely detailed to flatten (over 120,000 triangles)');
  // edges → triangles
  const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const edgeTris = new Map();
  T.forEach((t, ti) => { for (let k = 0; k < 3; k++) { const key = ek(t[k], t[(k + 1) % 3]); if (!edgeTris.has(key)) edgeTris.set(key, []); edgeTris.get(key).push(ti); } });
  const d3 = (a, b) => len(sub(P[a], P[b]));
  // lay the triangles out, breadth first from the largest one
  const U = new Array(P.length).fill(null), placed = new Array(T.length).fill(false);
  const area3 = (t) => len(cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]]))) / 2;
  let t0 = 0;
  T.forEach((t, i) => { if (area3(t) > area3(T[t0])) t0 = i; });
  const third = (A, B, la, lb, away) => {
    // the point la from A and lb from B, on the side away from `away`
    const dx = B[0] - A[0], dy = B[1] - A[1], dd = Math.hypot(dx, dy) || 1e-12;
    const x = (la * la - lb * lb + dd * dd) / (2 * dd), h = Math.sqrt(Math.max(0, la * la - x * x));
    const ux = dx / dd, uy = dy / dd, m = [A[0] + ux * x, A[1] + uy * x];
    const c1 = [m[0] - uy * h, m[1] + ux * h], c2 = [m[0] + uy * h, m[1] - ux * h];
    if (!away) return c1;
    const s1 = (c1[0] - A[0]) * dy - (c1[1] - A[1]) * dx, sa = (away[0] - A[0]) * dy - (away[1] - A[1]) * dx;
    return Math.sign(s1) !== Math.sign(sa) ? c1 : c2;
  };
  const queue = [];
  let comp = 0;
  const seed = (ti, offset) => {
    const [a, b, c] = T[ti];
    U[a] = [offset, 0]; U[b] = [offset + d3(a, b), 0]; U[c] = third(U[a], U[b], d3(a, c), d3(b, c), null);
    placed[ti] = true; queue.push(ti);
  };
  seed(t0, 0);
  for (;;) {
    while (queue.length) {
      const ti = queue.shift(), t = T[ti];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3], c0 = t[(k + 2) % 3];
        for (const nj of edgeTris.get(ek(a, b))) {
          if (placed[nj]) continue;
          const c = T[nj].find((v) => v !== a && v !== b);
          if (!U[c]) U[c] = third(U[a], U[b], d3(a, c), d3(b, c), U[c0]);
          placed[nj] = true; queue.push(nj);
        }
      }
    }
    const next = placed.indexOf(false);
    if (next < 0) break;
    // a separate piece: laid out to the right
    comp++;
    const xs = U.filter(Boolean).map((q) => q[0]);
    seed(next, Math.max(...xs) + diag * 0.1);
  }
  // Two starts, each relaxed so every edge keeps its length as well as it can:
  //  - the triangles laid out one after another (exact for surfaces that unroll; seams stay open)
  //  - the surface projected onto its best plane, seams closed (better for doubly curved ones, e.g. a dome)
  // The one with the smaller length change (and nothing folded over) wins.
  const topo = (TT) => {
    const et = new Map();
    TT.forEach((t, ti) => { for (let k = 0; k < 3; k++) { const key = ek(t[k], t[(k + 1) % 3]); if (!et.has(key)) et.set(key, []); et.get(key).push(ti); } });
    return { T: TT, et, edges: [...et.keys()].map((k) => { const [x, y] = k.split(',').map(Number); return [x, y, d3(x, y)]; }) };
  };
  const score = (tp, V) => {
    let rms = 0, mx = 0;
    for (const [x, y, L] of tp.edges) { const st2 = Math.abs(Math.hypot(V[y][0] - V[x][0], V[y][1] - V[x][1]) - L) / (L || 1); rms += st2 * st2; mx = Math.max(mx, st2); }
    let pos = 0, neg = 0;
    for (const t of tp.T) { const A = V[t[0]], B = V[t[1]], C = V[t[2]], ar = ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / 2; if (ar >= 0) pos += ar; else neg -= ar; }
    const flip = Math.min(pos, neg) / ((pos + neg) || 1);
    rms = Math.sqrt(rms / tp.edges.length);
    return { rms, mx, flip, s: rms + 3 * flip };
  };
  const relax = (tp, V, damp = 1) => {
    const snap = () => V.map((q) => (q ? [...q] : null));
    let best = { ...score(tp, V), V: snap(), tp };
    for (let it = 0; it < iterations; it++) {
      let worst = 0;
      for (const [x, y, L] of tp.edges) {
        const dx = V[y][0] - V[x][0], dy = V[y][1] - V[x][1], d = Math.hypot(dx, dy) || 1e-12, e = ((d - L) / d / 2) * damp;
        worst = Math.max(worst, Math.abs(d - L) / (L || 1));
        V[x][0] += dx * e; V[x][1] += dy * e; V[y][0] -= dx * e; V[y][1] -= dy * e;
      }
      if (worst < 1e-7 || (it + 1) % 50 === 0 || it === iterations - 1) {
        const sc = score(tp, V);
        if (sc.s < best.s) best = { ...sc, V: snap(), tp };
        if (worst < 1e-7) break;
      }
    }
    return best;
  };
  const runs = [relax(topo(T), U.map((q) => (q ? [...q] : null)))];
  {
    let nrm = [0, 0, 0], cen = [0, 0, 0], wsum = 0;
    for (const t of T) { const c3 = cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]])), w = len(c3) / 2; nrm = add(nrm, c3); cen = add(cen, mul(add(add(P[t[0]], P[t[1]]), P[t[2]]), w / 3)); wsum += w; }
    if (len(nrm) > 0.2 * 2 * wsum && !comp) {
      // seams closed: points at the same place joined
      const firstAt = new Map(), canon = P.map((q, i) => { const k = q.map((v) => Math.round(v / tol)).join(','); if (!firstAt.has(k)) firstAt.set(k, i); return firstAt.get(k); });
      const Tc = T.map((t) => t.map((i) => canon[i])).filter((t) => t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]);
      const n0 = unit(nrm), c0 = mul(cen, 1 / wsum), u = unit(cross(n0, Math.abs(n0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(n0, u);
      const proj = () => P.map((q, i) => (canon[i] === i ? [dot(sub(q, c0), u), dot(sub(q, c0), v)] : null)), tc = topo(Tc);
      runs.push(relax(tc, proj()), relax(tc, proj(), 0.35));
    }
  }
  runs.sort((x, y) => x.s - y.s);
  const win = runs[0], V = win.V, maxStrain = win.mx, rmsStrain = win.rms;
  // the outline: edges of one triangle, chained into loops
  const bnd = win.tp.edges.filter(([x, y]) => win.tp.et.get(ek(x, y)).length === 1).map(([x, y]) => [x, y]);
  const nextOf = new Map();
  for (const [x, y] of bnd) { if (!nextOf.has(x)) nextOf.set(x, []); nextOf.get(x).push(y); if (!nextOf.has(y)) nextOf.set(y, []); nextOf.get(y).push(x); }
  const used = new Set(), loops = [];
  for (const [a0, b0] of bnd) {
    if (used.has(ek(a0, b0))) continue;
    const loop = [a0];
    let prev = a0, cur = b0;
    used.add(ek(a0, b0));
    while (cur !== a0 && loop.length < bnd.length + 2) {
      loop.push(cur);
      const nx = (nextOf.get(cur) || []).find((x) => x !== prev && !used.has(ek(cur, x)));
      if (nx === undefined) break;
      used.add(ek(cur, nx));
      prev = cur; cur = nx;
    }
    if (loop.length >= 3) loops.push(loop.map((i) => V[i]));
  }
  if (!loops.length) throw new Error('The faces form a closed surface: there is no edge to open it out from (split it first)');
  const sArea = (l) => l.reduce((acc, q, i) => { const r = l[(i + 1) % l.length]; return acc + q[0] * r[1] - r[0] * q[1]; }, 0) / 2;
  // (straight runs merged)
  const simplify = (l) => l.filter((q, i) => { const a = l[(i - 1 + l.length) % l.length], b = l[(i + 1) % l.length]; return Math.abs((q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0])) > 1e-9 * diag * diag; });
  loops.sort((x, y) => Math.abs(sArea(y)) - Math.abs(sArea(x)));
  if (comp) throw new Error('The faces are not joined into one piece (flatten each piece on its own)');
  // turned to its smallest bounding rectangle (straight sides along x / y)
  {
    for (let k = 0; k < loops.length; k++) loops[k] = loops[k].map((q) => [...q]); // (own copies: turned once each)
    const L0 = loops[0];
    let best = 0, bestA = Infinity;
    const step = Math.max(1, Math.floor(L0.length / 720));
    for (let i = 0; i < L0.length; i += step) {
      const q = L0[i], r = L0[(i + 1) % L0.length], ang = -Math.atan2(r[1] - q[1], r[0] - q[0]);
      const c = Math.cos(ang), sn = Math.sin(ang);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p2 of L0) { const x = p2[0] * c - p2[1] * sn, y = p2[0] * sn + p2[1] * c; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const A = (x1 - x0) * (y1 - y0) * (1 + 1e-9 * i);
      if (A < bestA) { bestA = A; best = ang; }
    }
    const c = Math.cos(best), sn = Math.sin(best);
    for (const l of loops) for (const p2 of l) { const x = p2[0] * c - p2[1] * sn, y = p2[0] * sn + p2[1] * c; p2[0] = x; p2[1] = y; }
  }
  const outer = simplify(loops[0]), holes = loops.slice(1).map(simplify);
  const xs = outer.map((q) => q[0]), ys = outer.map((q) => q[1]);
  const area2 = Math.abs(sArea(loops[0])) - holes.reduce((acc, h) => acc + Math.abs(sArea(h)), 0);
  const a3 = T.reduce((acc, t) => acc + area3(t), 0);
  return { outer, holes, min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)], area2, area3: a3, maxStrain, rmsStrain };
}

function planeFace(p, n) {
  const oc = R.getOC();
  const pln = new oc.gp_Pln(new oc.gp_Pnt(p[0], p[1], p[2]), new oc.gp_Dir(n[0], n[1], n[2]));
  const mk = new oc.BRepBuilderAPI_MakeFace(pln);
  const f = R.cast(mk.Face());
  mk.delete(); pln.delete();
  return f;
}

// ---- rigid transforms and mates
function rotMat(r) {
  const th = len(r);
  if (th < 1e-14) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = mul(r, 1 / th), c = Math.cos(th), sn = Math.sin(th), v = 1 - c;
  return [[c + x * x * v, x * y * v - z * sn, x * z * v + y * sn], [y * x * v + z * sn, c + y * y * v, y * z * v - x * sn], [z * x * v - y * sn, z * y * v + x * sn, c + z * z * v]];
}
const mv = (M, p) => [M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2], M[2][0] * p[0] + M[2][1] * p[1] + M[2][2] * p[2]];
const rej = (v, d) => sub(v, mul(d, dot(v, d)));

// Residuals of one mate between a moved entity A and a fixed entity B.
// Entities: { kind: 'plane', p, n } | { kind: 'line', p, d } | { kind: 'point', p }.
function mateResidual(type, A, B, v, align) {
  let a = A, b = B, swapped = false;
  const order = { plane: 0, line: 1, point: 2 };
  if (order[a.kind] > order[b.kind]) { [a, b] = [b, a]; swapped = true; }
  const k = a.kind + '-' + b.kind;
  const dist = type === 'distance' ? v : 0;
  void swapped;
  switch (k) {
    case 'plane-plane':
      if (type === 'coincident' || type === 'distance') return [...sub(a.n, mul(b.n, align)), dot(sub(A.p, B.p), B.kind === 'plane' ? B.n : A.n) - dist];
      if (type === 'parallel') return sub(a.n, mul(b.n, align));
      if (type === 'perpendicular') return [dot(a.n, b.n)];
      if (type === 'angle') return [dot(a.n, b.n) - align * Math.cos((v * Math.PI) / 180)];
      break;
    case 'plane-line':
      if (type === 'coincident') return [dot(b.d, a.n), dot(sub(b.p, a.p), a.n)];
      if (type === 'distance') return [dot(b.d, a.n), dot(sub(b.p, a.p), a.n) - v];
      if (type === 'parallel') return [dot(b.d, a.n)];
      if (type === 'perpendicular') return cross(b.d, a.n);
      if (type === 'angle') return [Math.abs(dot(b.d, a.n)) - Math.sin((v * Math.PI) / 180)];
      break;
    case 'plane-point':
      if (type === 'coincident' || type === 'distance') return [dot(sub(b.p, a.p), a.n) - dist];
      break;
    case 'line-line':
      if (type === 'coincident' || type === 'concentric') return [...cross(a.d, b.d), ...rej(sub(A.p, B.p), B.d)];
      if (type === 'distance') return [...cross(a.d, b.d), len(rej(sub(A.p, B.p), B.d)) - v];
      if (type === 'parallel') return cross(a.d, b.d);
      if (type === 'perpendicular') return [dot(a.d, b.d)];
      if (type === 'angle') return [Math.abs(dot(a.d, b.d)) - Math.cos((v * Math.PI) / 180)];
      break;
    case 'line-point':
      if (type === 'coincident' || type === 'concentric') return rej(sub(b.p, a.p), a.d);
      if (type === 'distance') return [len(rej(sub(b.p, a.p), a.d)) - v];
      break;
    case 'point-point':
      if (type === 'coincident' || type === 'concentric') return sub(a.p, b.p);
      if (type === 'distance') return [len(sub(a.p, b.p)) - v];
      break;
  }
  throw new Error(`A ${type} mate can't be made between a ${A.kind === 'line' ? 'axis/edge' : A.kind} and a ${B.kind === 'line' ? 'axis/edge' : B.kind}`);
}

// Find the rigid motion that satisfies the mates, moving as little as possible: a rotation r
// about the moving bodies' center c, then a translation. Several starting orientations avoid
// wrong flips. Returns the motion as rotation vector r about the origin plus translation t.
function solveMates(mates, c = [0, 0, 0]) {
  const P = (M, p, t) => add(add(mv(M, sub(p, c)), c), t);
  const moved = (e, M, t) => (e.kind === 'plane' ? { kind: 'plane', p: P(M, e.p, t), n: mv(M, e.n) }
    : e.kind === 'line' ? { kind: 'line', p: P(M, e.p, t), d: mv(M, e.d) } : { kind: 'point', p: P(M, e.p, t) });
  const resid = (x) => {
    const M = rotMat([x[0], x[1], x[2]]), t = [x[3], x[4], x[5]];
    const out = [];
    for (const m of mates) out.push(...mateResidual(m.type, moved(m.A, M, t), m.B, m.v, m.align));
    return out;
  };
  const norm2 = (r) => r.reduce((s, v) => s + v * v, 0);
  const run = (x0) => {
    const x = [...x0];
    let r = resid(x), err = norm2(r), lambda = 1e-6;
    for (let it = 0; it < 200 && err > 1e-22; it++) {
      const J = [];
      for (let j = 0; j < 6; j++) {
        const h = 1e-7 * Math.max(1, Math.abs(x[j]));
        const xp = [...x]; xp[j] += h; const xm = [...x]; xm[j] -= h;
        const rp = resid(xp), rm = resid(xm);
        J.push(rp.map((v, i) => (v - rm[i]) / (2 * h)));
      }
      const A = [...Array(6)].map((_, i) => [...Array(6)].map((__, j) => J[i].reduce((s, v, k) => s + v * J[j][k], 0)));
      const g = [...Array(6)].map((_, i) => J[i].reduce((s, v, k) => s + v * r[k], 0));
      let improved = false;
      for (let tries = 0; tries < 10; tries++) {
        const Ad = A.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (1 + v) + 1e-12 : 0)));
        const dx = gauss(Ad, g.map((v) => -v));
        const xn = x.map((v, i) => v + dx[i]);
        const rn = resid(xn), en = norm2(rn);
        if (Number.isFinite(en) && en < err) { x.splice(0, 6, ...xn); r = rn; err = en; lambda = Math.max(lambda / 10, 1e-15); improved = true; break; }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { x, err };
  };
  const starts = [[0, 0, 0]];
  for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) for (const a of [Math.PI, Math.PI / 2, -Math.PI / 2]) starts.push(mul(ax, a));
  let best = null;
  for (const r0 of starts) {
    const res = run([...r0, 0, 0, 0]);
    const motion = len(res.x.slice(0, 3)) * 1000 + len(res.x.slice(3));
    if (!best || res.err < best.err - 1e-12 || (Math.abs(res.err - best.err) <= 1e-12 && motion < best.motion)) best = { ...res, motion };
    if (best.err < 1e-20 && r0 === starts[0]) break;
  }
  if (best.err > 1e-8) throw new Error('The mates cannot all be satisfied (check the entities, values and alignments)');
  const r = best.x.slice(0, 3), M = rotMat(r);
  return { r, t: add(sub(c, mv(M, c)), best.x.slice(3)) }; // x -> M(x - c) + c + t  ==  M x + (c - M c + t)
}

function gauss(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-300) continue;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let sum = M[r][n]; for (let k = r + 1; k < n; k++) sum -= M[r][k] * x[k]; x[r] = Math.abs(M[r][r]) < 1e-300 ? 0 : sum / M[r][r]; }
  return x;
}

// Apply rotation vector r (about the origin, radians) then translation t to a shape.
function moveShape(shape, r, t) {
  let out = shape.clone();
  const th = len(r);
  if (th > 1e-14) out = out.rotate((th * 180) / Math.PI, [0, 0, 0], mul(r, 1 / th));
  if (len(t) > 1e-14) out = out.translate(t);
  return out;
}

// ------------------------------------------------------------ DXF export of a flat face
// The face's outer boundary and holes are written as a 2D drawing in the face's own plane,
// seen from outside the part (x right, y up). Lines, arcs and circles are exact; other
// curves (splines, ellipses) become fine polylines unless they are really lines or arcs.
function findPlanarFace(body, ref) {
  const n = unit(ref.n);
  const cands = faceInfos(body).filter((c) => Math.abs(dot(c.n, n)) > 0.999);
  const q = new R.DistanceQuery(R.makeVertex(ref.p));
  let best = null, bd = Infinity;
  for (const c of cands) {
    const d = q.distanceTo(c.face);
    if (d < bd) { bd = d; best = c; }
  }
  return best && bd < Math.max(1e-3, bbox(body).diag * 1e-5) ? best.face : null;
}

function faceToDXF(face, n, diag) {
  const c = vec(face.center);
  const fr = frameOnPlane(c, n); // origin: the part origin projected onto the face's plane
  const to2 = (pt) => { const d = sub(vec(pt), fr.o); return [dot(d, fr.u), dot(d, fr.v)]; };
  const pointAt = (e, t) => { const v = e.pointAt(t); const r = to2(v); v.delete?.(); return r; };
  const ents = [];
  const tol = Math.max(1e-6, diag * 1e-7);
  const circleFrom3 = (a, b, m) => {
    const d = 2 * (a[0] * (b[1] - m[1]) + b[0] * (m[1] - a[1]) + m[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, m2 = m[0] ** 2 + m[1] ** 2;
    const cx = (a2 * (b[1] - m[1]) + b2 * (m[1] - a[1]) + m2 * (a[1] - b[1])) / d;
    const cy = (a2 * (m[0] - b[0]) + b2 * (a[0] - m[0]) + m2 * (b[0] - a[0])) / d;
    return { c: [cx, cy], r: Math.hypot(a[0] - cx, a[1] - cy) };
  };
  const arc = (layer, p0, pm, p1, k) => {
    // DXF arcs run counter-clockwise from the start angle to the end angle
    const ccw = (pm[0] - p0[0]) * (p1[1] - p0[1]) - (pm[1] - p0[1]) * (p1[0] - p0[0]) > 0;
    const ang = (q) => (Math.atan2(q[1] - k.c[1], q[0] - k.c[0]) * 180) / Math.PI;
    const [s0, s1] = ccw ? [p0, p1] : [p1, p0];
    ents.push({ type: 'ARC', layer, c: k.c, r: k.r, a0: ang(s0), a1: ang(s1) });
  };
  const fitTol = Math.max(1e-4, diag * 1e-6);
  const offLine = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / l; };
  const wires = [['OUTLINE', face.clone().outerWire()], ...face.clone().innerWires().map((w) => ['HOLES', w])];
  for (const [layer, wire] of wires) {
    for (const e of wire.edges) {
      const type = e.geomType;
      const p0 = pointAt(e, 0), p1 = pointAt(e, 1);
      const closed = e.isClosed || Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) < tol;
      if (type === 'LINE') {
        ents.push({ type: 'LINE', layer, a: p0, b: p1 });
      } else if (type === 'CIRCLE') {
        if (closed) {
          const k = circleFrom3(p0, pointAt(e, 1 / 3), pointAt(e, 2 / 3));
          if (k) ents.push({ type: 'CIRCLE', layer, c: k.c, r: k.r });
        } else {
          const pm = pointAt(e, 0.5);
          const k = circleFrom3(p0, p1, pm);
          if (k) arc(layer, p0, pm, p1, k); else ents.push({ type: 'LINE', layer, a: p0, b: p1 });
        }
      } else {
        // splines, ellipses, intersection curves: keep them exact when they are really lines or arcs
        const L = e.length;
        const nSeg = Math.max(16, Math.min(720, Math.ceil(L / Math.max(diag * 0.002, 0.01))));
        const pts = [];
        for (let i = 0; i <= nSeg; i++) pts.push(pointAt(e, i / nSeg));
        if (!closed && pts.every((q) => offLine(q, p0, p1) < fitTol)) { ents.push({ type: 'LINE', layer, a: p0, b: p1 }); continue; }
        const pm = pts[Math.round(nSeg / 2)];
        const k = closed ? circleFrom3(pts[0], pts[Math.round(nSeg / 3)], pts[Math.round((2 * nSeg) / 3)]) : circleFrom3(p0, p1, pm);
        if (k && pts.every((q) => Math.abs(Math.hypot(q[0] - k.c[0], q[1] - k.c[1]) - k.r) < fitTol)) {
          if (closed) ents.push({ type: 'CIRCLE', layer, c: k.c, r: k.r }); else arc(layer, p0, pm, p1, k);
          continue;
        }
        ents.push({ type: 'POLYLINE', layer, pts, closed });
      }
    }
  }
  return writeDXF(ents);
}

function writeDXF(ents) {
  const out = [];
  const intCode = (c) => (c >= 60 && c <= 99) || (c >= 170 && c <= 179) || (c >= 270 && c <= 289);
  const num = (c, v) => (intCode(c) ? String(Math.round(v)) : Math.abs(v) < 1e-12 ? '0.0' : String(+v.toFixed(9)));
  const g = (code, v) => out.push(String(code), typeof v === 'number' ? num(code, v) : String(v));
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const ext = (p, r = 0) => { xmin = Math.min(xmin, p[0] - r); ymin = Math.min(ymin, p[1] - r); xmax = Math.max(xmax, p[0] + r); ymax = Math.max(ymax, p[1] + r); };
  for (const e of ents) {
    if (e.type === 'LINE') { ext(e.a); ext(e.b); } else if (e.c) ext(e.c, e.r); else e.pts.forEach((p) => ext(p));
  }
  if (!isFinite(xmin)) { xmin = ymin = 0; xmax = ymax = 1; }
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4); // millimetres
  g(9, '$EXTMIN'); g(10, xmin); g(20, ymin); g(30, 0);
  g(9, '$EXTMAX'); g(10, xmax); g(20, ymax); g(30, 0);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 2);
  for (const [name, color] of [['OUTLINE', 7], ['HOLES', 1]]) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const e of ents) {
    if (e.type === 'LINE') { g(0, 'LINE'); g(8, e.layer); g(10, e.a[0]); g(20, e.a[1]); g(30, 0); g(11, e.b[0]); g(21, e.b[1]); g(31, 0); }
    else if (e.type === 'CIRCLE') { g(0, 'CIRCLE'); g(8, e.layer); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); }
    else if (e.type === 'ARC') { g(0, 'ARC'); g(8, e.layer); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); g(50, e.a0); g(51, e.a1); }
    else {
      g(0, 'POLYLINE'); g(8, e.layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, e.closed ? 1 : 0);
      const pts = e.closed ? e.pts.slice(0, -1) : e.pts;
      for (const p of pts) { g(0, 'VERTEX'); g(8, e.layer); g(10, p[0]); g(20, p[1]); g(30, 0); }
      g(0, 'SEQEND'); g(8, e.layer);
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

// ------------------------------------------------------------ sheet metal flat pattern
// 2D drawing entities of a sheet metal body's flat pattern (top face up, lower-left corner at 0,0):
// OUTLINE / HOLES (the cut), BEND_UP / BEND_DOWN (bend centre lines), BEND_REGION (where the bends
// start and end) and NOTES (bend notes, as TEXT). Also a mesh of the flat part where it lies in the
// model (the panel that stays put when folding), for showing it in the view.
function sheetFlatData(bodyId, flip = false) {
  const rec = lastSolids.find((r) => r.id === bodyId && r.sheet);
  if (!rec) throw new Error('That body is not sheet metal');
  const sheet = rec.sheet;
  const { ents, fp, bends, x0, y0 } = flatEnts(sheet, flip);
  // the flat part in the model, for the Flatten view
  const flatSolid = SM.toSolid({ ...sheet, flat: { pt: sheet.rootPt } });
  const mesh = meshData([flatSolid], bbox(flatSolid).diag);
  return {
    ents, size: fp.size, area: fp.area, bends, t: sheet.t, R: sheet.R, K: sheet.K,
    cut: SM.cutInfo(fp.region),
    frame: sheet.frame, origin: [x0, y0], mesh, stale: sheet.stale || null, flip: !!flip,
  };
}

// The flat pattern of a sheet as DXF-style entities (flat coordinates, from its lower-left corner):
// OUTLINE / HOLES, BEND_UP / BEND_DOWN lines (with their notes), BEND_REGION lines and NOTES texts.
// flip: seen from the other face of the sheet (mirrored left to right; up bends become down bends).
function flatEnts(sheet, flip = false) {
  const out = flatEntsTop(sheet);
  if (flip) mirrorFlat(out);
  return out;
}
function mirrorFlat(out) {
  const W = out.fp.size[0];
  const mx = (p) => [W - p[0], p[1]];
  const swapNote = (s) => s.replace(/^UP\b/, '\u0001').replace(/^DOWN\b/, 'UP').replace('\u0001', 'DOWN');
  const layer = (l) => (l === 'BEND_UP' ? 'BEND_DOWN' : l === 'BEND_DOWN' ? 'BEND_UP' : l);
  const readable = (r) => { let x = -(r || 0); if (x > 90.001) x -= 180; if (x < -89.999) x += 180; return x; };
  out.ents = out.ents.map((e) => {
    const r = { ...e, layer: layer(e.layer) };
    if (e.a) r.a = mx(e.a);
    if (e.b) r.b = mx(e.b);
    if (e.c) r.c = mx(e.c);
    if (e.p) r.p = mx(e.p);
    if (e.pts) r.pts = e.pts.map(mx);
    if (e.type === 'ARC') { r.a0 = 180 - e.a1; r.a1 = 180 - e.a0; }
    if (e.type === 'TEXT') { r.rot = readable(e.rot); r.text = swapNote(e.text); }
    if (e.note) r.note = swapNote(e.note);
    return r;
  });
  out.bends = out.bends.map((b) => ({ ...b, up: !b.up, a: mx(b.a), b: mx(b.b), rot: readable(b.rot), note: swapNote(b.note) }));
}
function flatEntsTop(sheet) {
  const fp = SM.flatPattern(sheet);
  const [x0, y0] = fp.min;
  const to2 = (p) => { const v = vec(p); return [v[0] - x0, v[1] - y0]; };
  const diag = Math.hypot(fp.size[0], fp.size[1]) || 1;
  const ents = [];
  for (const face of SM.facesOf(fp.region)) {
    const wires = [['OUTLINE', face.clone().outerWire()], ...face.clone().innerWires().map((w) => ['HOLES', w])];
    for (const [layer, wire] of wires) for (const e of wire.edges) edgeEnts(e, layer, to2, diag, ents);
  }
  const sh = (p) => [p[0] - x0, p[1] - y0];
  const bends = [];
  for (const bl of fp.bendLines) {
    const a = sh(bl.a), b = sh(bl.b);
    const deg = +((bl.ang * 180) / Math.PI).toFixed(2);
    const note = `${bl.up ? 'UP' : 'DOWN'} ${deg}° R${+bl.R.toFixed(3)}`;
    ents.push({ type: 'LINE', layer: bl.up ? 'BEND_UP' : 'BEND_DOWN', a, b, note });
    for (const seg of [...bl.t0, ...bl.t1]) ents.push({ type: 'LINE', layer: 'BEND_REGION', a: sh(seg[0]), b: sh(seg[1]) });
    const len2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let rot = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (rot > 90.001) rot -= 180; if (rot < -89.999) rot += 180; // readable: never upside down
    const h = Math.min(Math.max(diag * 0.012, 1.5), 6);
    const r = (rot * Math.PI) / 180, nrm = [-Math.sin(r), Math.cos(r)];
    const mid = [(a[0] + b[0]) / 2 + nrm[0] * h * 0.4, (a[1] + b[1]) / 2 + nrm[1] * h * 0.4];
    if (len2 > h * 3) ents.push({ type: 'TEXT', layer: 'NOTES', p: mid, h, rot, text: note, align: 'center' });
    bends.push({ up: bl.up, deg, R: bl.R, len: len2, a, b, note, rot });
  }
  // forming marks (cross breaks, forms; a louver's slit is cut), with one note per mark
  const noted = new Set();
  for (const mk of fp.marks || []) {
    const a = sh(mk.a), b = sh(mk.b);
    ents.push({ type: 'LINE', layer: mk.kind === 'slit' ? 'HOLES' : 'FORMING', a, b });
    const text = mk.kind === 'crossbreak' ? `CROSS BREAK ${mk.up ? 'UP' : 'DOWN'}` : mk.note;
    if (text && !noted.has(mk.id)) {
      noted.add(mk.id);
      const h = Math.min(Math.max(diag * 0.012, 1.5), 6), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      ents.push({ type: 'TEXT', layer: 'NOTES', p: [m[0], m[1] + h * 0.8], h, rot: 0, text, align: 'center' });
    }
  }
  return { ents, fp, bends, x0, y0 };
}

// DXF entities of one edge (lines, arcs and circles exact; other curves as fine polylines).
function edgeEnts(e, layer, to2, diag, ents) {
  const pointAt = (t) => { const v = e.pointAt(t); const r = to2(v); v.delete?.(); return r; };
  const tol = Math.max(1e-6, diag * 1e-7), fitTol = Math.max(1e-4, diag * 1e-6);
  const circleFrom3 = (a, b, m) => {
    const d = 2 * (a[0] * (b[1] - m[1]) + b[0] * (m[1] - a[1]) + m[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, m2 = m[0] ** 2 + m[1] ** 2;
    const cx = (a2 * (b[1] - m[1]) + b2 * (m[1] - a[1]) + m2 * (a[1] - b[1])) / d;
    const cy = (a2 * (m[0] - b[0]) + b2 * (a[0] - m[0]) + m2 * (b[0] - a[0])) / d;
    return { c: [cx, cy], r: Math.hypot(a[0] - cx, a[1] - cy) };
  };
  const arc = (p0, pm, p1, k) => {
    const ccw = (pm[0] - p0[0]) * (p1[1] - p0[1]) - (pm[1] - p0[1]) * (p1[0] - p0[0]) > 0;
    const ang = (q) => (Math.atan2(q[1] - k.c[1], q[0] - k.c[0]) * 180) / Math.PI;
    const [s0, s1] = ccw ? [p0, p1] : [p1, p0];
    ents.push({ type: 'ARC', layer, c: k.c, r: k.r, a0: ang(s0), a1: ang(s1) });
  };
  const offLine = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / l; };
  const type = e.geomType;
  const p0 = pointAt(0), p1 = pointAt(1);
  const closed = e.isClosed || Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) < tol;
  if (type === 'LINE') { ents.push({ type: 'LINE', layer, a: p0, b: p1 }); return; }
  if (type === 'CIRCLE') {
    if (closed) { const k = circleFrom3(p0, pointAt(1 / 3), pointAt(2 / 3)); if (k) ents.push({ type: 'CIRCLE', layer, c: k.c, r: k.r }); }
    else { const pm = pointAt(0.5); const k = circleFrom3(p0, p1, pm); if (k) arc(p0, pm, p1, k); else ents.push({ type: 'LINE', layer, a: p0, b: p1 }); }
    return;
  }
  const L = e.length;
  const nSeg = Math.max(16, Math.min(720, Math.ceil(L / Math.max(diag * 0.002, 0.01))));
  const pts = [];
  for (let i = 0; i <= nSeg; i++) pts.push(pointAt(i / nSeg));
  if (!closed && pts.every((q) => offLine(q, p0, p1) < fitTol)) { ents.push({ type: 'LINE', layer, a: p0, b: p1 }); return; }
  const pm = pts[Math.round(nSeg / 2)];
  const k = closed ? circleFrom3(pts[0], pts[Math.round(nSeg / 3)], pts[Math.round((2 * nSeg) / 3)]) : circleFrom3(p0, p1, pm);
  if (k && pts.every((q) => Math.abs(Math.hypot(q[0] - k.c[0], q[1] - k.c[1]) - k.r) < fitTol)) {
    if (closed) ents.push({ type: 'CIRCLE', layer, c: k.c, r: k.r }); else arc(p0, pm, p1, k);
    return;
  }
  ents.push({ type: 'POLYLINE', layer, pts, closed });
}

function exportFaceDXF(ref) {
  if (!lastBody) throw new Error('There is no solid body');
  const face = findPlanarFace(lastBody, ref);
  if (!face) throw new Error('Select a flat face to export as DXF');
  return new TextEncoder().encode(faceToDXF(face, unit(ref.n), bbox(lastBody).diag));
}

// Faces of the current model that a feature made: they lie on the solid's surface after the
// feature but not before it. Returns face-group indices (as in the mesh).
function featureFaces(id) {
  const d = lastFeatureDiffs.get(id);
  if (!d?.after || !lastFacePts.length) return [];
  // sample points are triangle centroids, up to the mesh tolerance off the true surface
  // (the same tight tolerance both ways, so faces of later blends near this feature's corners don't count)
  const onTol = Math.max(1e-5, lastMeshTol * 1.5), offTol = onTol;
  if (!d.cache) {
    // only the faces this feature made or changed: a face it left alone has the same centre and area
    // before and after (a large model, e.g. an imported assembly, has thousands that need no checking)
    const boxed = (shape) => (shape ? shape.faces.map((face) => {
      const b = face.boundingBox.bounds, c = vec(face.center);
      return { face, lo: b[0].map((x) => x - onTol), hi: b[1].map((x) => x + onTol), key: `${c.map((x) => Math.round(x * 1e5)).join(',')},${Math.round(R.measureArea(face) * 1e5)}` };
    }) : []);
    const before = boxed(d.before), had = new Set(before.map((f) => f.key));
    d.cache = { after: boxed(d.after).filter((f) => !had.has(f.key)), before };
  }
  if (!d.cache.after.length) return [];
  // distance from p to the nearest of the faces whose box holds it (Infinity: none near)
  const dist = (p, faces) => {
    let best = Infinity, v = null;
    for (const f of faces) {
      if (p[0] < f.lo[0] || p[1] < f.lo[1] || p[2] < f.lo[2] || p[0] > f.hi[0] || p[1] > f.hi[1] || p[2] > f.hi[2]) continue;
      v ||= R.makeVertex(p);
      const q = new R.DistanceQuery(v);
      try { best = Math.min(best, q.distanceTo(f.face)); } finally { q.delete?.(); }
      if (best <= 1e-12) break;
    }
    v?.delete?.();
    return best;
  };
  const out = [];
  lastFacePts.forEach((pts, i) => {
    if (!pts) return;
    // the face lies on the surface the feature made, and part of it was not there before
    const onAfter = pts.filter((p) => dist(p, d.cache.after) <= onTol).length;
    if (onAfter * 2 < pts.length) return;
    if (d.before && !pts.some((p) => dist(p, d.cache.before) > offTol)) return;
    out.push(i);
  });
  return out;
}

self.onmessage = async (e) => {
  const { id, type, data } = e.data;
  try {
    await ready;
    if (kernelDead) throw new Error(kernelDead);
    resetStack();
    let result, transfer = [];
    if (type === 'rebuild') {
      ({ res: result, transfer } = await rebuild(JSON.parse(data.doc), data.previewId || null, { haveMesh: data.haveMesh || null }));
      for (const k of ['add', 'remove', 'tool']) {
        const m = result.preview?.[k];
        if (m) transfer.push(m.vertices.buffer, m.normals.buffer, m.triangles.buffer);
      }
      result.kernelMemoryMB = Math.round(R.getOC().wasmMemory.buffer.byteLength / 1048576);
    } else if (type === 'export') {
      result = await exportBody(data.format, data.bodyId || null, data.info || {});
      transfer = [result.buffer];
    } else if (type === 'exportFaceDXF') {
      result = exportFaceDXF(data.ref);
      transfer = [result.buffer];
    } else if (type === 'featureFaces') {
      result = featureFaces(data.id);
    } else if (type === 'loadFont') {
      await R.loadFont(data.data, data.key, true);
      result = true;
    } else if (type === 'textOutlines') {
      result = textOutlines(data.texts || []);
    } else if (type === 'measure') {
      result = measureRefs(data.refs || []);
    } else if (type === 'sectionCurves') {
      const sb = lastSketchBodies.get(data.sketchId);
      const shapes = [...(sb?.body ? solidsOf(sb.body) : []), ...(sb?.surfaces || [])];
      if (!shapes.length) throw new Error('There is no body or surface for the sketch plane to cut');
      result = sectionPrims(shapes, sb.frame, bboxOfAll(shapes).diag);
    } else if (type === 'stats') {
      // for crash reports: kernel memory and stack state
      resetStack();
      result = { memoryMB: Math.round(R.getOC().wasmMemory.buffer.byteLength / 1048576), stackReset: !!stack, stackRecovered: stackLost, freeing: freeStats.installed, freed: freeStats.freed };
    } else if (type === 'partMesh') {
      const doc = JSON.parse(data.doc);
      doc.rollbackAt = null;
      const out = await rebuild(doc, null, {});
      const r = out.res;
      result = { body: r.body, errors: [...(r.errors instanceof Map ? r.errors : Object.entries(r.errors || {}))].length };
      transfer = out.transfer;
    } else if (type === 'drawingViews') {
      result = await drawingViews(data.doc, data.views || []);
    } else if (type === 'sheetCheck') {
      const rec = lastSolids.find((r) => r.id === data.bodyId && r.sheet);
      if (!rec) throw new Error('That body is not sheet metal');
      result = SM.sheetCheck(rec.sheet);
    } else if (type === 'sheetFlat') {
      result = sheetFlatData(data.bodyId, !!data.flip);
      transfer = [result.mesh.vertices.buffer, result.mesh.normals.buffer, result.mesh.triangles.buffer];
    } else if (type === 'cutList') {
      let list = lastSolids;
      if (data.doc) { await ensureDrawingCache(data.doc); list = drawingCache.solids; }
      result = list.filter((r) => r.member).map((r) => ({ id: r.id, ...r.member, axis: undefined, volume: R.measureVolume(r.shape) }));
    } else if (type === 'interference') {
      result = interference();
      if (result.mesh) transfer = [result.mesh.vertices.buffer, result.mesh.normals.buffer, result.mesh.triangles.buffer];
    } else if (type === 'ping') {
      result = 'ready';
    } else if (type === 'ocHas') {
      // (diagnostics) which kernel classes this build has
      const oc = R.getOC();
      result = (data.names || []).filter((n) => n in oc);
      if (data.proto) result = Object.fromEntries(result.map((n) => [n, oc[n].prototype ? Object.getOwnPropertyNames(oc[n].prototype) : Object.keys(oc[n])]));
    }
    // the kernel aborted while handling this (the error was swallowed somewhere): don't trust the result
    if (kernelDead) throw new Error(kernelDead);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    const fatal = isFatal(err);
    if (fatal && !kernelDead) kernelDead = `the geometry kernel failed: ${err?.message || err}`;
    self.postMessage({ id, ok: false, fatal, error: err?.message || String(err), stack: err?.stack || null });
  } finally {
    try { if (!kernelDead) resetStack(); } catch { /* ignore */ }
  }
};
