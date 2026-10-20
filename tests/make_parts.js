// Makes the regression test parts (run by run_tests.py --make-parts in the app page). Each part is built
// from plain feature data, so the set is the same every time; they are saved in tests/parts/*.rcad and
// their results stored in tests/expected.json. Add a part here to cover a new feature.
import { applyPlan } from '/js/claudespec.js';
import { newDoc, createFeature } from '/js/model.js';

const P = (id, x, y) => ({ id, x, y });
const L = (id, a, b) => ({ id, type: 'line', p1: a, p2: b });
// a closed polygon from corner points: { points, curves }
function poly(pts) {
  return { points: pts.map(([x, y], i) => P('p' + (i + 1), x, y)), curves: pts.map((_, i) => L('c' + (i + 1), 'p' + (i + 1), 'p' + ((i + 1) % pts.length + 1))) };
}
const rect = (cx, cy, w, h) => poly([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]);
const circle = (cx, cy, r) => ({ points: [P('p1', cx, cy)], curves: [{ id: 'c1', type: 'circle', c: 'p1', r }] });
const sketch = (id, plane, geo) => ({ id, type: 'sketch', plane: { ref: plane }, ...geo });

// a part from a plan; `more(doc, ids)` adds features the plan format doesn't cover (ids: plan id → feature id)
function part(name, features, more) {
  const doc = newDoc();
  doc.name = name;
  const ids = new Map();
  const before = new Set();
  // (applyPlan maps its own temporary ids; read them back by order)
  const tmp = features.map((f) => f.id || null);
  applyPlan(doc, { replace: true, features });
  doc.features.forEach((f, i) => { if (tmp[i]) ids.set(tmp[i], f.id); before.add(f.id); });
  if (more) more(doc, ids);
  return doc;
}
const add = (doc, type, props) => { const f = createFeature(doc, type, props); doc.features.push(f); return f; };

export function makeParts() {
  const parts = [];

  // 1. a plate: extrude, a hole cut through, a 2 × 2 linear pattern of it, rounded corners
  parts.push(part('plate-features', [
    sketch('s1', 'top', rect(0, 0, 120, 80)),
    { id: 'e1', type: 'extrude', sketch: 's1', op: 'add', end: 'blind', depth: 12 },
    sketch('s2', 'top', circle(45, 25, 4)),
    { id: 'h1', type: 'extrude', sketch: 's2', op: 'cut', end: 'through2' },
  ], (doc, ids) => {
    add(doc, 'lpattern', { feature: ids.get('h1'), dir1: 'x', rev1: true, dist1: 90, count1: 2, dir2: 'z', dist2: 50, count2: 2 });
    add(doc, 'fillet', { radius: 5, edges: [{ p: [60, 6, 40] }, { p: [-60, 6, 40] }, { p: [60, 6, -40] }, { p: [-60, 6, -40] }] });
  }));

  // 2. a revolved hub with six bolt holes (circular pattern of a cut)
  parts.push(part('revolve-pattern', [
    sketch('s1', 'front', poly([[0, 0], [40, 0], [40, 10], [15, 10], [15, 30], [0, 30]])),
    { id: 'r1', type: 'revolve', sketch: 's1', op: 'add', axis: 'v', angle: 360 },
    sketch('s2', 'top', circle(30, 0, 3)),
    { id: 'h1', type: 'extrude', sketch: 's2', op: 'cut', end: 'through2' },
  ], (doc, ids) => { add(doc, 'cpattern', { feature: ids.get('h1'), axis: 'y', angle: 360, count: 6, equal: true }); }));

  // 3. an open box: shell with the top face removed
  parts.push(part('shell-box', [
    sketch('s1', 'top', rect(0, 0, 100, 60)),
    { id: 'e1', type: 'extrude', sketch: 's1', op: 'add', end: 'blind', depth: 40 },
  ], (doc) => { add(doc, 'shell', { thickness: 3, faces: [{ p: [0, 40, 0], n: [0, 1, 0] }] }); }));

  // 4. a sweep (a circle along a line) and a loft (square to circle), two bodies
  parts.push(part('sweep-loft', [
    sketch('path', 'front', { points: [P('p1', 0, 0), P('p2', 0, 80)], curves: [L('c1', 'p1', 'p2')] }),
    sketch('prof', 'top', circle(0, 0, 5)),
    sketch('sq', 'top', rect(100, 0, 40, 40)),
    { id: 'pl', type: 'plane', refs: [{ kind: 'plane', id: 'top' }], offset: 50 },
    sketch('ci', 'pl', circle(100, 0, 15)),
  ], (doc, ids) => {
    add(doc, 'sweep', { profileType: 'sketch', profile: ids.get('prof'), path: ids.get('path') });
    add(doc, 'loft', { profiles: [ids.get('sq'), ids.get('ci')] });
  }));

  // 5. sheet metal: a base flange with two edge flanges (and its flat pattern)
  parts.push(part('sheet-metal', [
    sketch('s1', 'top', rect(0, 0, 100, 60)),
    { id: 'b1', type: 'smBase', sketch: 's1', thickness: 2, radius: 2, kFactor: 0.44 },
    { type: 'smFlange', edges: [{ p: [0, 2, 30] }, { p: [0, 2, -30] }], length: 25, angle: 90, lengthRef: 'outer', position: 'inside', corner: 'closed', cornerGap: 0.1 },
  ]));

  // 6. two separate bodies (merge off) combined into one
  parts.push(part('multibody-combine', [
    sketch('s1', 'top', rect(0, 0, 60, 40)),
    { id: 'e1', type: 'extrude', sketch: 's1', op: 'add', end: 'blind', depth: 10 },
    sketch('s2', 'top', circle(30, 0, 15)),
    { id: 'e2', type: 'extrude', sketch: 's2', op: 'add', end: 'blind', depth: 25, merge: false },
  ], (doc, ids) => { add(doc, 'combine', { op: 'add', main: ids.get('e1'), bodies: [ids.get('e2')] }); }));

  // 7. counterbored holes at the points of a sketch on a plane at the top face
  parts.push(part('holes', [
    sketch('s1', 'top', rect(0, 0, 60, 40)),
    { id: 'e1', type: 'extrude', sketch: 's1', op: 'add', end: 'blind', depth: 20 },
    { id: 'pl', type: 'plane', refs: [{ kind: 'plane', id: 'top' }], offset: 20 },
    sketch('hp', 'pl', { points: [P('p1', -15, 0), P('p2', 15, 0)], curves: [] }),
  ], (doc, ids) => { add(doc, 'hole', { holeType: 'cbore', size: 'M6', end: 'through', sketch: ids.get('hp') }); }));

  // 8. a surface from open curves, thickened into a solid
  parts.push(part('surface-thicken', [
    sketch('s1', 'front', { points: [P('p1', 0, 0), P('p2', 40, 0), P('p3', 60, 20)], curves: [L('c1', 'p1', 'p2'), L('c2', 'p2', 'p3')] }),
  ], (doc, ids) => {
    const s = add(doc, 'surfExtrude', { sketch: ids.get('s1'), depth: 30 });
    add(doc, 'thicken', { body: s.id, thickness: 2 });
  }));

  // 9. a pattern of cut dimples on a sphere (the one-operation cut pattern)
  parts.push(part('dimple-pattern', [
    sketch('s1', 'front', { points: [P('p1', 0, -30), P('p2', 0, 30), P('o', 0, 0)], curves: [{ id: 'c1', type: 'arc', c: 'o', p1: 'p1', p2: 'p2' }, { id: 'c2', type: 'line', p1: 'p2', p2: 'p1' }] }),
    { id: 'r1', type: 'revolve', sketch: 's1', op: 'add', axis: 'c2', angle: 360 },
    sketch('s2', 'front', { points: [P('p1', 27, 4), P('p2', 27, -4), P('p3', 33, -4), P('p4', 33, 4)], curves: [L('c1', 'p1', 'p2'), L('c2', 'p2', 'p3'), L('c3', 'p3', 'p4'), L('c4', 'p4', 'p1')] }),
  ], (doc, ids) => {
    const cut = add(doc, 'revolve', { sketch: ids.get('s2'), op: 'cut', axis: 'v', angle: 20 });
    add(doc, 'cpattern', { feature: cut.id, axis: 'y', angle: 360, count: 12, equal: true });
  }));

  // 10. a frame: structural members along a rectangle of lines
  parts.push(part('frame-members', [
    sketch('s1', 'front', rect(0, 200, 600, 400)),
  ], (doc, ids) => { add(doc, 'structMember', { path: ids.get('s1'), paths: [ids.get('s1')] }); }));

  // 11. configurations: the same plate in two widths (rebuilt in each)
  parts.push(part('configurations', [
    sketch('s1', 'top', poly([[-50, -30], [50, -30], [50, 30], [-50, 30]])),
    { id: 'e1', type: 'extrude', sketch: 's1', op: 'add', end: 'blind', depth: 'thickness' },
  ], (doc) => {
    doc.equations = [{ name: 'thickness', expr: '10' }];
    doc.configs = [{ id: 'cfg1', name: 'Thick', vals: { thickness: '25' }, suppressed: [], unsuppressed: [] }];
  }));

  return parts.map((d) => ({ name: d.name, doc: d }));
}
