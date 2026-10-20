// RazorCAD regression tests, run inside the app page by run_tests.py (headless Edge).
//  - Parts: each test part (tests/parts/*.rcad) rebuilt by the real geometry kernel, in every configuration:
//    errors, and per body its volume, area, face and edge count (sheet metal: the flat pattern's size).
//    run_tests.py compares these with tests/expected.json.
//  - UI: a few things done the way a user does them (real pointer events on the view): sketch, dimension
//    and extrude; a drawing from the part; an assembly; the mouse buttons on the view.
import * as M from '/js/model.js';
import { BUILTIN_TEMPLATES } from '/js/drawtemplates.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60000, step = 100) {
  const t0 = performance.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (performance.now() - t0 > ms) return null;
    await wait(step);
  }
}
const r6 = (x) => (typeof x === 'number' ? +x.toPrecision(10) : x);
const closeModals = () => document.querySelectorAll('.modal-back').forEach((x) => x.remove());

// ---------------------------------------------------------------- parts
async function partResult(doc) {
  const k = window.app.kernel;
  const out = {};
  const configs = [null, ...(doc.configs || []).map((c) => c.id)];
  for (const cfg of configs) {
    const d = { ...doc, activeConfig: cfg };
    const t0 = performance.now();
    const r = await k.rebuild(d, null, null);
    const ms = Math.round(performance.now() - t0);
    const name = (id) => (d.features.find((f) => f.id === id)?.name || id);
    const bodies = [];
    for (const b of r.body?.bodies || []) {
      let m = {};
      try { const res = await k.request('measure', { refs: [{ kind: 'body', id: b.id }] }); m = res.items?.[0] || res; } catch (e) { m = { error: e.message }; }
      const body = { kind: b.kind, faces: b.faceCount, edges: b.edgeCount, volume: r6(m.volume ?? null), area: r6(m.area ?? null) };
      if (b.sheet) {
        try { const f = await k.request('sheetFlat', { bodyId: b.id, flip: false }); body.flat = { size: f.size.map(r6), bends: f.bends.length }; } catch (e) { body.flat = { error: e.message }; }
      }
      bodies.push(body);
    }
    out[cfg || 'default'] = { errors: (r.errors || []).map(([id, m]) => `${name(id)}: ${m}`), bodies, ms };
  }
  return out;
}

// ---------------------------------------------------------------- UI helpers
function viewEvents() {
  const vp = window.app.viewport, cv = vp.renderer.domElement;
  vp.resize();
  const R = cv.getBoundingClientRect();
  const fire = (type, x, y, o = {}) => cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 11, ...o }));
  const toScreen = (p) => { const v = p.clone().project(vp.camera); return [R.left + ((v.x + 1) / 2) * R.width, R.top + ((1 - v.y) / 2) * R.height]; };
  const click = async (x, y, button = 0) => {
    const b = { button, buttons: button === 2 ? 2 : button === 1 ? 4 : 1 };
    fire('pointerdown', x, y, b); await wait(30); fire('pointerup', x, y, { ...b, buttons: 0 }); await wait(60);
  };
  return { vp, cv, R, fire, toScreen, click };
}

const UI = {
  // sketch a rectangle, dimension one side (the Dimension tool), extrude it
  async 'sketch-dimension-extrude'() {
    const a = window.app;
    await a.newDocument?.();
    closeModals();
    const f = M.createFeature(a.doc, 'sketch', { plane: { ref: 'top' } });
    a.doc.features.push(f); a.commit();
    await a.enterSketch(f, true);
    await wait(300);
    const { toScreen, click, vp } = viewEvents();
    vp.setStandardView('top', false); vp.zoomToFit(); await wait(200);
    const sk = a.sketcher, fr = sk.frame;
    const at = (x, y) => toScreen(fr.o.clone().addScaledVector(fr.u, x).addScaledVector(fr.v, y));
    // (a 40 × 20 rectangle about the origin)
    sk.setTool('rect');
    await click(...at(-20, -10)); await click(...at(20, 10));
    const lines = sk.f.curves.filter((c) => c.type === 'line').length;
    if (lines !== 4) return { ok: false, detail: `rectangle: ${lines} lines` };
    sk.setTool('dim');
    await click(...at(0, -10)); await click(...at(0, -18));
    closeModals();
    const dims = sk.f.constraints.filter((k) => k.type === 'dim').length;
    if (dims < 1) return { ok: false, detail: 'the Dimension tool added no dimension' };
    sk.setTool('select');
    await a.exitSketch(true);
    await wait(300);
    a.selection = { kind: 'feature', id: f.id };
    a.startFeature('extrude', 'add');
    await wait(400);
    if (a.pm?.kind !== 'feature') return { ok: false, detail: 'the Extrude panel did not open' };
    if (!a.pm.feature.sketch) a.pm.feature.sketch = f.id;
    a.okPM();
    const body = await until(() => (!a.kernel.pending && a.result?.bodies?.length ? a.result.bodies : null), 30000);
    if (!body) return { ok: false, detail: `no body (errors: ${JSON.stringify([...(a.result?.errors || [])])})` };
    const m = await a.kernel.request('measure', { refs: [{ kind: 'body', id: body[0].id }] });
    const vol = (m.items?.[0] || m).volume;
    const want = 40 * 20 * 10; // (the default depth)
    return Math.abs(vol - want) < 1e-6 * want ? { ok: true, detail: `volume ${r6(vol)}` } : { ok: false, detail: `volume ${vol}, expected ${want}` };
  },

  // a drawing of the part: three standard views with lines in them
  async 'drawing-from-part'() {
    const a = window.app;
    if (a.mode === 'drawing') return { ok: false, detail: 'no part in front' };
    const keep = a.ui.newDrawingSetup;
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'Test drawing', props: {}, sheet: null });
    try { await a.newDrawing(true); } finally { a.ui.newDrawingSetup = keep; }
    const ed = a.drawing;
    if (!ed || ed.doc.views.length !== 3) return { ok: false, detail: `${ed?.doc.views.length ?? 0} views` };
    const ok = await until(() => ed.doc.views.every((v) => (ed.geos.get(v.id)?.edges?.length || 0) > 0), 60000, 250);
    return ok ? { ok: true, detail: ed.doc.views.map((v) => ed.geos.get(v.id).edges.length).join(' / ') + ' lines' } : { ok: false, detail: 'views without lines' };
  },

  // an assembly with two copies of a part
  async 'assembly-two-components'() {
    const a = window.app;
    const part = M.newDoc(); part.name = 'Block';
    const s = M.createFeature(part, 'sketch', { plane: { ref: 'top' } });
    Object.assign(s, { points: [{ id: 'p1', x: -10, y: -10 }, { id: 'p2', x: 10, y: -10 }, { id: 'p3', x: 10, y: 10 }, { id: 'p4', x: -10, y: 10 }], curves: [1, 2, 3, 4].map((i) => ({ id: 'c' + i, type: 'line', p1: 'p' + i, p2: 'p' + ((i % 4) + 1), construction: false })) });
    part.features.push(s, M.createFeature(part, 'extrude', { sketch: s.id, depth: 15 }));
    a.newAssembly();
    await wait(400);
    closeModals();
    const ed = a.drawing;
    const pid = ed.addPart(part, null, null);
    await ed.addComponent(pid); await ed.addComponent(pid);
    // (each component's part mesh built, and the two placed apart)
    const tris = await until(() => {
      if (ed.doc.components.length !== 2) return null;
      const n = ed.doc.components.map((c) => ed.geo(c)?.mesh?.triangles?.length || 0);
      return n.every((x) => x > 0) ? n[0] : null;
    }, 60000, 250);
    const [c1, c2] = ed.doc.components;
    const apart = c1 && c2 && JSON.stringify(c1.pos) !== JSON.stringify(c2.pos);
    if (!tris) return { ok: false, detail: `${ed.doc.components.length} components, no mesh` };
    return apart ? { ok: true, detail: `2 components, ${tris / 3} triangles each, placed apart` } : { ok: false, detail: 'the second component was placed on the first' };
  },

  // references that follow edits: a fillet on the inside corner of a step still finds its edge after the step
  // moves (other edges now lie nearer its old place); a shell's removed face after the box gets taller; and
  // an edge that is gone is reported as a missing reference
  async 'references-follow-edits'() {
    const k = window.app.kernel;
    const stepped = (step) => {
      const d = M.newDoc();
      const s = M.createFeature(d, 'sketch', { plane: { ref: 'front' } });
      const pts = step === null ? [[0, 0], [100, 0], [100, 20], [0, 20]] : [[0, 0], [100, 0], [100, 20], [step, 20], [step, 50], [0, 50]];
      Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % pts.length + 1), construction: false })), constraints: [] });
      d.features.push(s, M.createFeature(d, 'extrude', { sketch: s.id, depth: 30 }));
      return d;
    };
    const vol = async (r) => { const b = r.body?.bodies?.[0]; if (!b) return null; const m = await k.request('measure', { refs: [{ kind: 'body', id: b.id }] }); return (m.items?.[0] || m).volume; };
    const near = (a, b) => a != null && Math.abs(a - b) < 1e-6 * b;
    // 1. the fillet picked with the step at x = 40 (the kernel completes the reference: box, faces at its sides)
    const d1 = stepped(40);
    const ext = d1.features[1];
    const z = ext.reverse ? -15 : 15;
    const fil = M.createFeature(d1, 'fillet', { radius: 5, edges: [{ p: [40, 20, z] }] });
    d1.features.push(fil);
    let r = await k.rebuild(d1, null, null);
    if (r.errors?.length) return { ok: false, detail: 'first build: ' + JSON.stringify(r.errors) };
    if (r.body?.bodies?.length !== 1) return { ok: false, detail: 'first build: no body' };
    Object.assign(fil, r.features?.[fil.id] || {});
    if (!fil.edges[0].fn) return { ok: false, detail: 'the edge reference was not given its sides' };
    // 2. the step moved to x = 85
    const d2 = stepped(85); d2.features[0].id = d1.features[0].id; d2.features[1] = { ...ext }; d2.features.push(JSON.parse(JSON.stringify(fil)));
    r = await k.rebuild(d2, null, null);
    const want = (100 * 20 + 85 * 30) * 30 + (25 - (25 * Math.PI) / 4) * 30;
    const v2 = await vol(r);
    if (r.errors?.length || !near(v2, want)) return { ok: false, detail: `moved step: errors ${JSON.stringify(r.errors)}, volume ${v2} (expected ${want.toFixed(3)})` };
    // 3. the step taken away: the fillet's edge is reported missing
    const d3 = stepped(null); d3.features[0].id = d1.features[0].id; d3.features[1] = { ...ext }; d3.features.push(JSON.parse(JSON.stringify(fil)));
    r = await k.rebuild(d3, null, null);
    const miss = r.missing?.[fil.id];
    if (!r.errors?.length || JSON.stringify(miss) !== '[["edges",0]]') return { ok: false, detail: `removed step: errors ${JSON.stringify(r.errors)}, missing ${JSON.stringify(r.missing)}` };
    // 4. a shell's removed top face after the box grows from 40 to 100 high
    const box = (h) => {
      const d = M.newDoc();
      const s = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
      const pts = [[-50, -30], [50, -30], [50, 30], [-50, 30]];
      Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
      d.features.push(s, M.createFeature(d, 'extrude', { sketch: s.id, depth: h }), M.createFeature(d, 'shell', { thickness: 3, faces: [{ p: [0, 40, 0], n: [0, 1, 0] }] }));
      return d;
    };
    r = await k.rebuild(box(100), null, null);
    const v4 = await vol(r), want4 = 100 * 60 * 100 - 94 * 54 * 97;
    if (r.errors?.length || !near(v4, want4)) return { ok: false, detail: `taller shell: errors ${JSON.stringify(r.errors)}, volume ${v4} (expected ${want4})` };
    return { ok: true, detail: 'moved edge found, missing edge reported, moved face found' };
  },

  // mates follow their part: a face found again after the part's faces are numbered differently, after it
  // moves with a dimension; a mate whose face is gone is reported
  async 'mates-follow-part-edits'() {
    const a = window.app;
    const square = (w) => [[-w / 2, -w / 2], [w / 2, -w / 2], [w / 2, w / 2], [-w / 2, w / 2]];
    const setSketch = (s, pts) => Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % pts.length + 1), construction: false })), constraints: [] });
    const part = M.newDoc(); part.name = 'MateBlock';
    const s = M.createFeature(part, 'sketch', { plane: { ref: 'top' } });
    setSketch(s, square(20));
    part.features.push(s, M.createFeature(part, 'extrude', { sketch: s.id, depth: 15 }));
    a.newAssembly();
    await wait(400);
    closeModals();
    const ed = a.drawing;
    const pid = ed.addPart(part, null, null);
    await ed.addComponent(pid); await ed.addComponent(pid);
    const [c1, c2] = ed.doc.components;
    const mesh = await until(() => ed.geo(c1)?.mesh, 30000);
    if (!mesh) return { ok: false, detail: 'no part mesh' };
    const faceOf = (m, n) => m.faceGroups.findIndex((g) => g.surf?.t === 'PLANE' && g.surf.n.every((v, k) => Math.abs(v - n[k]) < 1e-9));
    const fx = faceOf(mesh, [1, 0, 0]), fnx = faceOf(mesh, [-1, 0, 0]), fy = faceOf(mesh, [0, 1, 0]);
    if (fx < 0 || fnx < 0 || fy < 0) return { ok: false, detail: 'faces of the block not found' };
    const ref = (c, gi) => { const g = mesh.faceGroups[gi].surf; return { comp: c.id, kind: 'plane', face: gi, p: g.p.slice(), n: g.n.slice(), what: 'Face' }; };
    ed.doc.mates.push({ id: 'mtest', name: 'Coincident1', type: 'coincident', a: ref(c1, fx), b: ref(c2, fnx), value: 0 });
    const m = ed.doc.mates[ed.doc.mates.length - 1];
    // 1. the part's faces numbered differently: the mate points at another face number, the geometry is the +x face
    m.a.face = fy;
    ed.resyncRefs();
    if (m.a.face !== fx || ed.brokenMates.size) return { ok: false, detail: `renumbered: face ${m.a.face} (expected ${fx}), broken ${ed.brokenMates.size}` };
    // 2. the block made 30 wide: the +x face moved to x = 15
    // (a changed part arrives as a new document, as when its file is saved)
    let pd = JSON.parse(JSON.stringify(ed.part(pid).doc));
    setSketch(pd.features[0], square(30)); pd.features[0].rev = (pd.features[0].rev || 0) + 1;
    ed.part(pid).doc = pd;
    await ed.loadParts();
    const moved = await until(() => (Math.abs((ed.geo(c1)?.box?.max?.[0] ?? 0) - 15) < 1e-6 ? true : null), 30000);
    ed.resyncRefs();
    if (!moved || Math.abs(m.a.p[0] - 15) > 1e-6 || ed.brokenMates.size) return { ok: false, detail: `moved: p ${JSON.stringify(m.a.p)}, broken ${ed.brokenMates.size}` };
    // 3. the block made round: no +x face any more
    pd = JSON.parse(JSON.stringify(pd));
    const cs = pd.features[0];
    Object.assign(cs, { points: [{ id: 'p1', x: 0, y: 0 }], curves: [{ id: 'c1', type: 'circle', c: 'p1', r: 12, construction: false }], constraints: [] }); cs.rev++;
    ed.part(pid).doc = pd;
    await ed.loadParts();
    await until(() => (ed.geo(c1)?.mesh?.faceGroups?.some((g) => g.surf?.t === 'CYLINDER') ? true : null), 30000);
    ed.resyncRefs();
    if (JSON.stringify(ed.brokenMates.get('mtest')) !== '["a","b"]') return { ok: false, detail: `round: broken ${JSON.stringify([...ed.brokenMates])}` };
    return { ok: true, detail: 'renumbered face found, moved face followed, lost face reported' };
  },

  // the kernel handles requests one at a time, in order: an export sent while a rebuild is reading an imported
  // STEP file (a pause in that rebuild) waits for it and exports the new model, not the one before
  async 'kernel-one-at-a-time'() {
    const k = window.app.kernel;
    const cube = M.newDoc();
    const s = M.createFeature(cube, 'sketch', { plane: { ref: 'top' } });
    const pts = [[-15, -15], [15, -15], [15, 15], [-15, 15]];
    Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
    cube.features.push(s, M.createFeature(cube, 'extrude', { sketch: s.id, depth: 30 }));
    let r = await k.rebuild(cube, null, null);
    if (!r.body?.bodies?.length) return { ok: false, detail: 'no cube' };
    const step = new TextDecoder().decode(await k.request('export', { format: 'step' }));
    const imp = M.newDoc();
    imp.features.push(M.createFeature(imp, 'import', { format: 'step', fileName: 'cube.step', data: step }));
    // (an empty model first, so a request run too early has nothing to export)
    await k.rebuild(M.newDoc(), null, null);
    // both sent at once, straight to the worker
    const pr = k.call('rebuild', { doc: JSON.stringify(imp), previewId: null });
    const pe = k.call('export', { format: 'stl' });
    const [rr, stl] = await Promise.allSettled([pr, pe]);
    if (rr.status !== 'fulfilled' || rr.value.errors?.length) return { ok: false, detail: `import: ${rr.reason?.message || JSON.stringify(rr.value.errors)}` };
    if (stl.status !== 'fulfilled') return { ok: false, detail: `the export ran before the rebuild finished: ${stl.reason?.message}` };
    // (a binary STL: 80-byte header, then the triangle count; a cube is 12 triangles)
    const n = new DataView(stl.value.buffer || stl.value).getUint32(80, true);
    const st = await k.stats();
    // (the client's own state put back as it was: the worker's last model is the import)
    k.lastDoc = JSON.stringify(imp);
    return n === 12 ? { ok: true, detail: `export waited for the rebuild (12 triangles); ${st?.handled ?? '?'} requests handled` } : { ok: false, detail: `${n} triangles exported` };
  },

  // cosmetic threads: a plain Ø8.5 bore given an M10 thread (not modelled: the volume stays the same) and an M6
  // tapped hole; both shown in drawing views (lines from the side, ¾ circles end on) and called out
  async 'cosmetic-threads'() {
    const k = window.app.kernel;
    const d = M.newDoc();
    const s = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
    const pts = [[-40, -20], [40, -20], [40, 20], [-40, 20]];
    Object.assign(s, { points: [...pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), { id: 'hc', x: -20, y: 0 }], curves: [...pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false }))], constraints: [] });
    const s2 = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
    Object.assign(s2, { points: [{ id: 'q', x: -20, y: 0 }], curves: [{ id: 'k', type: 'circle', c: 'q', r: 4.25, construction: false }], constraints: [] });
    d.features.push(s, M.createFeature(d, 'extrude', { sketch: s.id, depth: 12 }), s2, M.createFeature(d, 'extrude', { sketch: s2.id, op: 'cut', end: 'through2' }));
    let r = await k.rebuild(d, null, null);
    const vol = async (x) => { const m = await k.request('measure', { refs: [{ kind: 'body', id: x.body.bodies[0].id }] }); return (m.items?.[0] || m).volume; };
    const v0 = await vol(r);
    // the bore's wall: a point on it (where the plate's top plane cuts it is y = 12 or -12: take the middle)
    const top = r.body.bodies[0];
    const wallY = 6 * Math.sign((await k.request('measure', { refs: [{ kind: 'body', id: top.id }] })).items?.[0]?.centroid?.[1] ?? 1) || 6;
    const ct = M.createFeature(d, 'cosmeticThread', { face: { p: [-20 + 4.25, wallY, 0] } });
    const hp = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
    Object.assign(hp, { points: [{ id: 'h1', x: 20, y: 0 }], curves: [], constraints: [] });
    d.features.push(ct, hp);
    r = await k.rebuild(d, null, null);
    if (r.errors?.length) {
      // (the plate may have been extruded down: try the wall the other way)
      ct.face.p[1] = -wallY;
      r = await k.rebuild(d, null, null);
      if (r.errors?.length) return { ok: false, detail: 'thread: ' + JSON.stringify(r.errors) };
    }
    const t = r.threads?.[ct.id]?.[0];
    if (!t || !t.internal || !/^M10/.test(t.label) || Math.abs(t.len - 12) > 1e-6) return { ok: false, detail: `thread data ${JSON.stringify(t)}` };
    const v1 = await vol(r);
    if (Math.abs(v1 - v0) > 1e-6 * v0) return { ok: false, detail: `the cosmetic thread changed the volume: ${v0} → ${v1}` };
    // an M6 tapped hole through the plate, from the sketch plane (into the plate: whichever way it lies)
    const holeF = M.createFeature(d, 'hole', { holeType: 'tapped', thread: 'M6', system: 'metric', end: 'through', sketch: hp.id, reverse: false });
    d.features.push(holeF);
    r = await k.rebuild(d, null, null);
    if (!r.threads?.[holeF.id]?.length) { holeF.reverse = true; r = await k.rebuild(d, null, null); }
    const ht = r.threads?.[holeF.id]?.[0];
    if (r.errors?.length || !ht || Math.abs(ht.len - 12) > 1e-3) return { ok: false, detail: `tapped hole: errors ${JSON.stringify(r.errors)}, thread ${JSON.stringify(ht)}` };
    // drawing views: from above (end on) and from the front (side on)
    const views = await k.request('drawingViews', { doc: JSON.stringify(d), views: [{ id: 'top', dir: [0, -1, 0], up: [0, 0, -1] }, { id: 'front', dir: [0, 0, -1], up: [0, 1, 0] }] });
    const [vt, vf] = views;
    const kinds = (v) => v.edges.filter((e) => e.k === 'th' || e.k === 'thd').map((e) => e.k + ':' + e.g.t).sort().join(',');
    const callouts = (vt.holes || []).map((h) => h.thread?.label).filter(Boolean).sort();
    const okTop = vt.edges.filter((e) => e.k.startsWith('th') && e.g.t === 'a').length === 2 && callouts.length === 2;
    const okFront = vf.edges.filter((e) => e.k === 'thd' && e.g.t === 'l').length === 6;
    return okTop && okFront ? { ok: true, detail: `${t.label} ${t.len} long, volume unchanged; drawing: ¾ circles + ${callouts.join(', ')} callouts, hidden thread lines from the side` }
      : { ok: false, detail: `top: ${kinds(vt)} callouts ${JSON.stringify(callouts)}; front: ${kinds(vf)}` };
  },

  // the view's mouse buttons: Shift + right-drag pans, middle-drag turns, a plain right-drag changes nothing
  async 'view-mouse-buttons'() {
    const a = window.app;
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    const { vp, fire, R } = viewEvents();
    const st = () => JSON.stringify([vp.controls.target.toArray().map((v) => +v.toFixed(4)), vp.camera.quaternion.toArray().map((v) => +v.toFixed(5))]);
    const drag = async (button, mods = {}) => {
      const b = { button, buttons: button === 2 ? 2 : 4, ...mods }, x = R.left + R.width / 2, y = R.top + R.height / 2;
      fire('pointerdown', x, y, b);
      for (let i = 1; i <= 6; i++) { fire('pointermove', x + i * 10, y + i * 5, b); await wait(16); }
      fire('pointerup', x + 60, y + 30, { ...b, buttons: 0 }); await wait(80);
    };
    const s0 = st(); await drag(2, { shiftKey: true }); const s1 = st();
    await drag(2); const s2 = st();
    await drag(1); const s3 = st();
    const [t0, q0] = JSON.parse(s0), [t1, q1] = JSON.parse(s1), [, q3] = JSON.parse(s3);
    const pans = JSON.stringify(t0) !== JSON.stringify(t1) && JSON.stringify(q0) === JSON.stringify(q1);
    const still = s1 === s2, turns = JSON.stringify(q3) !== JSON.stringify(q1);
    a.ui.closeContext?.();
    return pans && still && turns ? { ok: true, detail: 'pan / no-op / rotate' } : { ok: false, detail: `pan ${pans}, plain right-drag unchanged ${still}, middle rotates ${turns}` };
  },
};

export async function run(parts, only = null) {
  const out = { parts: {}, ui: {} };
  closeModals();
  for (const p of parts) {
    if (only && !only.includes(p.name)) continue;
    try { out.parts[p.name] = await partResult(JSON.parse(p.json)); } catch (e) { out.parts[p.name] = { crash: String(e?.message || e) }; }
  }
  for (const [name, fn] of Object.entries(UI)) {
    if (only && !only.includes(name)) continue;
    const t0 = performance.now();
    try { out.ui[name] = await fn(); } catch (e) { out.ui[name] = { ok: false, detail: 'crashed: ' + (e?.stack || e) }; }
    out.ui[name].ms = Math.round(performance.now() - t0);
  }
  return out;
}
