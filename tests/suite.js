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

  // the state after each feature written out and read back (as between sessions): every test part rebuilt
  // from it without building a feature again, with the same results; a change to the last feature rebuilds
  // only that one
  async 'feature-states-kept'(parts) {
    const k = window.app.kernel;
    const sum = (r) => JSON.stringify([(r.errors || []).length, (r.body?.bodies || []).map((b) => [b.faceCount, b.edgeCount])]);
    const notes = [];
    let bytes = 0, mesh1 = 0, mesh2 = 0;
    for (const p of parts) {
      const d = JSON.parse(p.json);
      const r1 = await k.rebuild(d, null, null);
      const snaps = await k.request('exportSnaps', { ids: d.features.map((f) => f.id) });
      if (!snaps?.brep) return { ok: false, detail: `${p.name}: not written out (${snaps?.error || 'nothing'})` };
      bytes += snaps.brep.length;
      await k.rebuild(M.newDoc(), null, null); // (the cache now holds another part)
      if (!(await k.request('importSnaps', { snaps }))) return { ok: false, detail: `${p.name}: not read back` };
      const r2 = await k.rebuild(d, null, null);
      if (r2.timing?.reused !== d.features.length) return { ok: false, detail: `${p.name}: ${r2.timing?.reused} of ${d.features.length} features reused` };
      if (sum(r1) !== sum(r2)) return { ok: false, detail: `${p.name}: ${sum(r1)} before, ${sum(r2)} after` };
      mesh1 += r1.timing?.mesh || 0; mesh2 += r2.timing?.mesh || 0;
      // (a renamed last feature: rebuilt alone)
      const d3 = JSON.parse(p.json); d3.features[d3.features.length - 1].name += ' (renamed)';
      const r3 = await k.rebuild(d3, null, null);
      if (r3.timing?.reused !== d.features.length - 1 || sum(r3) !== sum(r1)) return { ok: false, detail: `${p.name}: after a change to the last feature ${r3.timing?.reused} reused, ${sum(r3)}` };
      notes.push(p.name);
    }
    return { ok: true, detail: `${notes.length} parts restored without rebuilding (${(bytes / 1048576).toFixed(1)} MB of BRep; meshing ${mesh1} ms → ${mesh2} ms)` };
  },

  // an inch document: a sketch dimension shown and changed in inches, an extrude depth typed in inches (and
  // as an expression of a variable), the defaults in round inches; the geometry stays in millimetres
  async 'inch-units'() {
    const a = window.app;
    await a.newDocument?.();
    closeModals();
    a.setUnits('in');
    if (document.querySelector('#status-units').textContent !== 'IPS') return { ok: false, detail: 'the status bar does not say IPS' };
    const f = M.createFeature(a.doc, 'sketch', { plane: { ref: 'top' } });
    a.doc.features.push(f); a.commit();
    await a.enterSketch(f, true);
    await wait(300);
    const { toScreen, click, vp } = viewEvents();
    vp.setStandardView('top', false); vp.zoomToFit(); await wait(200);
    const sk = a.sketcher, fr = sk.frame;
    const at = (x, y) => toScreen(fr.o.clone().addScaledVector(fr.u, x).addScaledVector(fr.v, y));
    sk.setTool('rect');
    await click(...at(-20, -10)); await click(...at(20, 10));
    sk.setTool('dim');
    await click(...at(0, -10)); await click(...at(0, -18));
    closeModals();
    const k = sk.f.constraints.find((c) => c.type === 'dim');
    if (!k) return { ok: false, detail: 'no dimension' };
    const i = sk.dims.findIndex((d) => d.k === k);
    const label = sk.dimPool[i]?.textContent;
    sk.openModify(i);
    const box = document.querySelector('.modify input');
    const shown = box.value;
    box.value = '2';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(100);
    if (Math.abs(k.value - 50.8) > 1e-9) return { ok: false, detail: `dimension label ${label}, box ${shown}, stored ${k.value}` };
    const label2 = sk.dimPool[sk.dims.findIndex((d) => d.k === k)]?.textContent;
    sk.setTool('select');
    await a.exitSketch(true);
    await wait(300);
    a.doc.equations = [{ name: 'w', expr: '3' }];
    a.commit(); await a.rebuild();
    a.selection = { kind: 'feature', id: f.id };
    a.startFeature('extrude', 'add');
    await wait(400);
    const field = [...document.querySelectorAll('#pm .pm-input')].find((w) => w.querySelector('.unit')?.textContent === 'in');
    const inp = field?.querySelector('input');
    const def = inp?.value;
    inp.value = 'w/2'; inp.dispatchEvent(new Event('input'));
    const stored = a.pm.feature.depth;
    a.okPM();
    const body = await until(() => (!a.kernel.pending && a.result?.bodies?.length ? a.result.bodies : null), 30000);
    if (!body) return { ok: false, detail: 'no body' };
    const m = await a.kernel.request('measure', { refs: [{ kind: 'body', id: body[0].id }] });
    const vol = (m.items?.[0] || m).volume, want = 50.8 * 20 * 1.5 * 25.4;
    const ok = label === '1.575' && shown === '1.574803' && label2 === '2' && def === '0.375' && stored === '(w/2)*in' && Math.abs(vol - want) < 1e-6 * want;
    a.setUnits('mm');
    return ok ? { ok: true, detail: `dimension 1.575 → 2 in, default depth 0.375 in, w/2 → ${stored}, volume ${r6(vol)}` }
      : { ok: false, detail: `label ${label}, box ${shown}, label after ${label2}, default ${def}, stored ${stored}, volume ${vol} (want ${want})` };
  },

  // an assembly drawing: a BOM table (2 blocks, 1 plate) and balloons whose numbers come from the part clicked
  async 'assembly-drawing-bom-balloons'() {
    const a = window.app;
    const box = (name, w, d, h) => {
      const p = M.newDoc(); p.name = name;
      const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
      const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
      Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
      p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: h }));
      return p;
    };
    a.newAssembly();
    await wait(400);
    closeModals();
    const asm = a.drawing;
    const plate = asm.addPart(box('Plate', 60, 40, 5), null, null), block = asm.addPart(box('Block', 20, 20, 15), null, null);
    await asm.addComponent(plate); await asm.addComponent(block); await asm.addComponent(block);
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh), 30000);
    const keep = a.ui.newDrawingSetup;
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'Assembly drawing', props: {}, sheet: null });
    try { await a.newDrawing(true); } finally { a.ui.newDrawingSetup = keep; }
    const ed = a.drawing;
    if (!ed?.doc?.views?.length) return { ok: false, detail: 'no drawing views' };
    await until(() => ed.doc.views.every((v) => ed.geos.get(v.id)?.edges?.length), 60000, 250);
    // the BOM table
    ed.addBOM();
    const bomAnn = ed.doc.anns.find((x) => x.type === 'bom');
    const Dm = await import('/js/drawing.js');
    const texts = Dm.annPrims(ed.doc, bomAnn, {}).filter((p) => p.t === 'text').map((p) => p.text);
    const bomOk = texts.includes('BILL OF MATERIALS') && texts.includes('Plate') && texts.includes('Block');
    // a balloon on the second block: the middle of its top seen from above (or its middle from the front)
    const v = ed.doc.views.find((x) => x.orient === 'front') || ed.doc.views[0];
    const req = Dm.viewRequest(ed.doc, v);
    const c3 = asm.doc.components[2], g = asm.geo(c3)?.box;
    const mid = [0, 1, 2].map((k) => c3.pos[k] + (g.min[k] + g.max[k]) / 2);
    const un = (q) => { const l = Math.hypot(...q); return q.map((t) => t / l); }, cr = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]], dt = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const dir = un(req.dir), x = un(cr(req.up, dir)), y = cr(dir, x);
    const X = Dm.viewXform(ed.doc, v), P = X.toSheet([dt(mid, x), dt(mid, y)]);
    ed.startTool('balloon');
    await ed.toolClick(P, {});
    await ed.toolClick([P[0] + 15, P[1] - 15], {});
    const bl = ed.doc.anns.find((x) => x.type === 'balloon');
    const blockItem = (await import('/js/bom.js')).bomItemOf(ed.doc.models[0].doc, c3.id);
    ed.cancelTool?.();
    return bomOk && bl && String(bl.item) === String(blockItem) ? { ok: true, detail: `BOM: ${texts.filter((t) => /^(Plate|Block)$/.test(t)).join(', ')}; balloon on a block → item ${bl.item}` }
      : { ok: false, detail: `bom ${bomOk} (${texts.join('|')}), balloon ${JSON.stringify(bl)} (block item ${blockItem})` };
  },

  // an exploded view of an assembly on a drawing sheet: the view switched to the assembly's exploded view
  // shows the moved component where the explode puts it (and its projected view follows)
  async 'exploded-drawing-view'() {
    const a = window.app;
    const p = M.newDoc(); p.name = 'Cube';
    const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
    const pts = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
    p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: 20 }));
    a.newAssembly();
    await wait(400);
    closeModals();
    const asm = a.drawing;
    const pid = asm.addPart(p, null, null);
    await asm.addComponent(pid); await asm.addComponent(pid);
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh), 30000);
    const c2 = asm.doc.components[1];
    asm.doc.explodes.push({ id: 'ex1', name: 'Exploded View 1', steps: [{ items: [c2.id], dir: [1, 0, 0], dist: 50 }] });
    const keep = a.ui.newDrawingSetup;
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'Exploded drawing', props: {}, sheet: null });
    try { await a.newDrawing(true); } finally { a.ui.newDrawingSetup = keep; }
    const ed = a.drawing;
    const ready = () => until(() => ed.doc.views.every((v) => ed.geos.get(v.id)?.box && !ed.errors.get(v.id)), 60000, 200);
    await ready();
    const front = ed.doc.views.find((v) => v.type === 'model');
    const width = (v) => { const b = ed.geos.get(v.id).box; return b.max[0] - b.min[0]; };
    const kids = ed.doc.views.filter((v) => v.parent === front.id);
    const w0 = width(front), k0 = kids.map(width);
    front.explode = 'ex1';
    const before = ed.geos.get(front.id);
    await ed.updateGeometry();
    await until(() => ed.geos.get(front.id) !== before, 30000, 100);
    await ready();
    const w1 = width(front), k1 = kids.map(width);
    const grew = Math.abs(w1 - w0 - 50) < 1e-3;
    // (the projected views: the one beside it, looking along x, is unchanged in width; the one above grows too)
    const kidsFollow = k1.some((w, i) => Math.abs(w - k0[i] - 50) < 1e-3);
    return grew && kidsFollow ? { ok: true, detail: `front view ${r6(w0)} → ${r6(w1)} mm wide; projected views follow` } : { ok: false, detail: `front ${w0} → ${w1}, projected ${JSON.stringify(k0)} → ${JSON.stringify(k1)}` };
  },

  // assembly interference: of three 20 mm cubes, one overlapping another by 5 mm (2000 mm³) and one only
  // touching (not counted)
  async 'assembly-interference'() {
    const a = window.app;
    const p = M.newDoc(); p.name = 'Cube';
    const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
    const pts = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
    p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: 20 }));
    a.newAssembly();
    await wait(400);
    closeModals();
    const asm = a.drawing;
    const pid = asm.addPart(p, null, null);
    await asm.addComponent(pid); await asm.addComponent(pid); await asm.addComponent(pid);
    const [c1, c2, c3] = asm.doc.components;
    c1.pos = [0, 0, 0]; c2.pos = [15, 0, 0]; c3.pos = [-20, 0, 0];
    let html = '';
    const keep = a.ui.choose;
    a.ui.choose = async (title, ic, h) => { html = h; return 'ok'; };
    try { await asm.checkInterference(); } finally { a.ui.choose = keep; }
    const r = await a.kernel.request('asmInterference', { doc: JSON.stringify(asm.doc) });
    const ok = r.pairs.length === 1 && Math.abs(r.pairs[0].volume - 2000) < 1e-6 && html.includes('2000 mm³') && [c1, c2].every((c) => html.includes(c.name.replace(/</g, '&lt;').replace(/>/g, '&gt;')));
    return ok ? { ok: true, detail: `1 interference, ${r6(r.pairs[0].volume)} mm³ (${c1.name} / ${c2.name}); touching cube not counted` } : { ok: false, detail: `${JSON.stringify(r.pairs)} | ${html.replace(/<[^>]+>/g, ' ').slice(0, 200)}` };
  },

  // gear and rack-pinion mates, through the assembly solver: gear A (R10) turned 30° turns gear B (R20) −15°,
  // the rack slides 2π·10 · 30/360 = 5.236 mm; then 200° more in four steps (turns past half a turn add up)
  async 'gear-rack-mates'() {
    const A = await import('/js/assembly.js');
    const THREE = await import('three');
    const ax = (p, d, r) => ({ kind: 'axis', p, d, r });
    const pl = (p, n) => ({ kind: 'plane', p, n });
    const comp = (id, fixed = false, pos = [0, 0, 0]) => ({ id, part: 'p', name: id, pos, rot: [0, 0, 0, 1], fixed });
    const doc = {
      components: [comp('base', true), comp('ga'), comp('gb', false, [30, 0, 0]), comp('rack', false, [0, -10, 0])],
      mates: [
        { id: 'm1', type: 'concentric', a: { comp: 'base', ...ax([0, 0, 0], [0, 0, 1]) }, b: { comp: 'ga', ...ax([0, 0, 0], [0, 0, 1], 10) } },
        { id: 'm2', type: 'coincident', align: 1, a: { comp: 'base', ...pl([0, 0, 0], [0, 0, 1]) }, b: { comp: 'ga', ...pl([0, 0, 0], [0, 0, 1]) } },
        { id: 'm3', type: 'concentric', a: { comp: 'base', ...ax([30, 0, 0], [0, 0, 1]) }, b: { comp: 'gb', ...ax([0, 0, 0], [0, 0, 1], 20) } },
        { id: 'm4', type: 'coincident', align: 1, a: { comp: 'base', ...pl([0, 0, 0], [0, 0, 1]) }, b: { comp: 'gb', ...pl([0, 0, 0], [0, 0, 1]) } },
        // the rack: on the base plane, against a wall (y), free to slide along x
        { id: 'm5', type: 'coincident', align: 1, a: { comp: 'base', ...pl([0, 0, 0], [0, 0, 1]) }, b: { comp: 'rack', ...pl([0, 0, 0], [0, 0, 1]) } },
        { id: 'm6', type: 'coincident', align: 1, a: { comp: 'base', ...pl([0, -10, 0], [0, 1, 0]) }, b: { comp: 'rack', ...pl([0, 0, 0], [0, 1, 0]) } },
      ],
    };
    const byId = (id) => doc.components.find((c) => c.id === id);
    const poseOf = (id) => { const c = byId(id); return { p: c.pos.slice(), q: new THREE.Quaternion(...c.rot) }; };
    const worldRef = (r) => { const ps = poseOf(r.comp); const v = (x) => new THREE.Vector3(...x).applyQuaternion(ps.q).toArray(); return { kind: r.kind, p: v(r.p).map((x, i) => x + ps.p[i]), n: r.n && v(r.n), d: r.d && v(r.d), r: r.r }; };
    const gear = { id: 'g', type: 'gear', side: 1, value: 0.5, a: doc.mates[0].b, b: doc.mates[2].b };
    const rack = { id: 'r', type: 'rack', side: 1, value: 2 * Math.PI * 10, a: doc.mates[0].b, b: { comp: 'rack', ...ax([0, 0, 0], [1, 0, 0]) } };
    gear.ref = A.mechRef(gear, poseOf, worldRef);
    rack.ref = A.mechRef(rack, poseOf, worldRef);
    doc.mates.push(gear, rack);
    let r0 = A.solveAssembly(doc);
    const turnA = (deg) => { const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (deg * Math.PI) / 180).multiply(new THREE.Quaternion(...byId('ga').rot)); byId('ga').rot = [q.x, q.y, q.z, q.w]; };
    const angleOf = (id) => { const q = byId(id).rot; return (2 * Math.atan2(q[2], q[3]) * 180) / Math.PI; };
    turnA(30);
    const r1 = A.solveAssembly(doc, { pinned: new Set(['ga']) });
    const b1 = angleOf('gb'), x1 = byId('rack').pos[0];
    // (in steps, as a drag turns it: one jump of more than half a turn can't be told from a turn the other way)
    let r2 = null;
    for (let k = 0; k < 4; k++) { turnA(50); r2 = A.solveAssembly(doc, { pinned: new Set(['ga']) }); if (!r2.ok) break; }
    // (B has now turned −115° in all; the rack has slid 2π·10·230/360)
    const b2 = angleOf('gb'), x2 = byId('rack').pos[0];
    const ok = r0.ok && r1.ok && r2.ok && Math.abs(b1 + 15) < 1e-4 && Math.abs(x1 - (2 * Math.PI * 10 * 30) / 360) < 1e-4 && Math.abs(b2 + 115) < 1e-3 && Math.abs(x2 - (2 * Math.PI * 10 * 230) / 360) < 1e-3;
    return ok ? { ok: true, detail: `A +30° → B ${r6(b1)}°, rack ${r6(x1)} mm; +200° more → B ${r6(b2)}°, rack ${r6(x2)} mm` } : { ok: false, detail: `ok ${r0.ok}/${r1.ok}/${r2.ok}; B ${b1}, rack ${x1}; then B ${b2}, rack ${x2}` };
  },

  // the Getting Started Tour: steps with → and ←, each pointing at its part of the window; done at the end
  async 'getting-started-tour'() {
    const ui = window.app.ui;
    closeModals();
    // (the tour shows the part window: an assembly or drawing left in front by another test is put behind)
    if (window.app.mode !== 'part') { await window.app.newDocument?.(); closeModals(); }
    const keep = ui.prefs.tourDone;
    ui.startTour();
    const titles = [];
    for (let k = 0; k < 12 && document.querySelector('#tour'); k++) {
      titles.push(document.querySelector('#tour .tb-t').textContent);
      const last = [...document.querySelectorAll('#tour .tb-nav button')].some((b) => b.textContent === 'Finish');
      if (last) { [...document.querySelectorAll('#tour .tb-nav button')].find((b) => b.textContent === 'Finish').click(); break; }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await wait(20);
      if (k === 1) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await wait(20); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await wait(20); }
    }
    const ok = !document.querySelector('#tour') && ui.prefs.tourDone === true && titles.length >= 6 && titles[0].startsWith('Welcome');
    ui.prefs.tourDone = keep ?? true;
    return ok ? { ok: true, detail: `${titles.length} steps: ${titles.join(' · ')}` } : { ok: false, detail: `${titles.join(' · ')}; open ${!!document.querySelector('#tour')}` };
  },

  // STEP export of an assembly with its structure: a plate, two blocks and a sub-assembly of two more blocks;
  // read back, each part is in it once, every component placed where it was, named as in the assembly
  async 'assembly-step-export'() {
    const a = window.app;
    const box = (name, w, d, h) => {
      const p = M.newDoc(); p.name = name;
      const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
      const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
      Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
      p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: h }));
      return p;
    };
    const plateDoc = box('Plate', 60, 40, 5), blockDoc = box('Block', 20, 20, 15);
    const comp = (id, part, name, pos) => ({ id, part, name, pos, rot: [0, 0, 0, 1], fixed: false, hidden: false });
    const sub = { kind: 'assembly', version: 1, name: 'Pair', nextId: 3, parts: [{ id: 'pt1', name: 'Block', doc: blockDoc }], components: [comp('s1', 'pt1', 'Block<1>', [0, 0, 0]), comp('s2', 'pt1', 'Block<2>', [30, 0, 0])], mates: [] };
    const asm = { kind: 'assembly', version: 1, name: 'Top', nextId: 9, parts: [{ id: 'pa', name: 'Plate', doc: plateDoc }, { id: 'pb', name: 'Block', doc: blockDoc }, { id: 'pc', name: 'Pair', doc: sub }],
      components: [comp('c1', 'pa', 'Plate<1>', [0, 0, 0]), comp('c2', 'pb', 'Block<1>', [100, 0, 0]), comp('c3', 'pb', 'Block<2>', [150, 0, 0]), comp('c4', 'pc', 'Pair<1>', [0, 50, 0]), { ...comp('c5', 'pb', 'Block<3>', [0, 0, 300]), suppressed: true }], mates: [] };
    const r = await a.kernel.request('exportAssemblySTEP', { doc: JSON.stringify(asm) });
    const text = new TextDecoder().decode(r.bytes);
    const { readStepAssembly } = await import('/js/stepasm.js');
    const s = readStepAssembly(text);
    const top = s.assemblies?.find((x) => x.key === s.root);
    const pair = s.assemblies?.find((x) => x.name === 'Pair');
    const names = (top?.children || []).map((c) => c.name).sort();
    const at = (n) => top?.children.find((c) => c.name === n)?.pos?.map((v) => Math.round(v * 1e6) / 1e6).join(',');
    const ok = r.parts === 2 && s.parts?.length === 2 && s.occurrences?.length === 5 && pair?.children?.length === 2
      && JSON.stringify(names) === JSON.stringify(['Block<1>', 'Block<2>', 'Pair<1>', 'Plate<1>']) && at('Block<2>') === '150,0,0' && at('Pair<1>') === '0,50,0';
    return ok ? { ok: true, detail: `${s.parts.length} parts, ${s.occurrences.length} placed, sub-assembly kept; names ${names.join(', ')}` }
      : { ok: false, detail: `stats ${JSON.stringify({ parts: r.parts, comps: r.components })}, read: parts ${s.parts?.length}, occ ${s.occurrences?.length}, top ${JSON.stringify(top?.children?.map((c) => [c.name, c.kind, c.pos]))}, warnings ${JSON.stringify(s.warnings)}` };
  },

  // etch lines: a line and a circle sketched on the top face of a sheet metal plate are marked in its flat
  // pattern (the flat view's 'et' lines, inside the outline); the folded body is unchanged
  async 'sheet-metal-etch'() {
    const k = window.app.kernel;
    const d = M.newDoc();
    const s = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
    const pts = [[-50, -30], [50, -30], [50, 30], [-50, 30]];
    Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
    d.features.push(s, M.createFeature(d, 'smBase', { sketch: s.id, thickness: 2, radius: 2, kFactor: 0.44 }));
    let r = await k.rebuild(d, null, null);
    const vol = async (x) => { const m = await k.request('measure', { refs: [{ kind: 'body', id: x.body.bodies[0].id }] }); return (m.items?.[0] || m).volume; };
    const v0 = await vol(r);
    // the plate's top face: a plane through it (the base flange grows from the sketch plane one way or the other)
    const b = r.body.bodies[0];
    const m0 = await k.request('measure', { refs: [{ kind: 'body', id: b.id }] });
    const up = (m0.items?.[0] || m0).centroid?.[1] > 0;
    const pl = M.createFeature(d, 'plane', { refs: [{ kind: 'plane', id: 'top' }], offset: up ? 2 : 0 });
    const es = M.createFeature(d, 'sketch', { plane: { ref: pl.id } });
    Object.assign(es, { points: [{ id: 'a', x: -30, y: 0 }, { id: 'b', x: 20, y: 0 }, { id: 'o', x: 30, y: 10 }], curves: [{ id: 'l', type: 'line', p1: 'a', p2: 'b', construction: false }, { id: 'k', type: 'circle', c: 'o', r: 6, construction: false }], constraints: [] });
    const et = M.createFeature(d, 'smEtch', { sketch: es.id });
    d.features.push(pl, es, et);
    r = await k.rebuild(d, null, null);
    if (r.errors?.length) {
      // (the plate went the other way: the plane on its other face)
      pl.offset = up ? 0 : 2; r = await k.rebuild(d, null, null);
      if (r.errors?.length) return { ok: false, detail: JSON.stringify(r.errors) };
    }
    const v1 = await vol(r);
    const [fv] = await k.request('drawingViews', { doc: JSON.stringify(d), views: [{ id: 'f', flat: true, body: null, dir: [0, 0, 1], up: [0, 1, 0] }] });
    const etch = (fv.edges || []).filter((e) => e.k === 'et');
    const inside = etch.every((e) => [e.g.a, e.g.b].every((p) => p[0] >= fv.box.min[0] - 1e-6 && p[0] <= fv.box.max[0] + 1e-6 && p[1] >= fv.box.min[1] - 1e-6 && p[1] <= fv.box.max[1] + 1e-6));
    const len = etch.reduce((t, e) => t + Math.hypot(e.g.b[0] - e.g.a[0], e.g.b[1] - e.g.a[1]), 0);
    const want = 50 + 2 * Math.PI * 6;
    // (and in the DXF, on its ETCH layer)
    const flat = await k.request('sheetFlat', { bodyId: r.body.bodies[0].id, flip: false });
    const X = await import('/js/dxf.js');
    const dxf = X.buildDXF(X.selectEnts(flat.ents, X.DEFAULT_OPTIONS), {});
    const inDxf = flat.ents.some((e) => e.layer === 'ETCH') && dxf.includes('ETCH');
    const ok = Math.abs(v1 - v0) < 1e-6 * v0 && etch.length >= 2 && inside && Math.abs(len - want) < 0.05 * want && inDxf;
    return ok ? { ok: true, detail: `${etch.length} etch segments, ${r6(len)} mm long (line + circle ≈ ${r6(want)}); volume unchanged` } : { ok: false, detail: `dxf ${inDxf}, volume ${v0} → ${v1}, ${etch.length} segments, inside ${inside}, length ${len} (want ${want}); notes ${JSON.stringify(r.notes?.[et.id])}` };
  },

  // motion studies: gear A turned two full turns (72 steps) carries gear B (−360°) and the rack (2π·10·2 mm) with
  // it, past the half turn one jump couldn't do; a Distance mate driven from 10 to 40 mm
  async 'motion-study'() {
    const A = await import('/js/assembly.js');
    const { motionFrames } = await import('/js/motion.js');
    const THREE = await import('three');
    const ax = (p, d, r) => ({ kind: 'axis', p, d, r });
    const pl = (p, n) => ({ kind: 'plane', p, n });
    const comp = (id, fixed = false, pos = [0, 0, 0]) => ({ id, part: 'p', name: id, pos, rot: [0, 0, 0, 1], fixed });
    const doc = {
      components: [comp('base', true), comp('ga'), comp('gb', false, [30, 0, 0]), comp('rack', false, [0, -10, 0])],
      mates: [
        { id: 'm1', name: 'Concentric1', type: 'concentric', a: { comp: 'base', ...ax([0, 0, 0], [0, 0, 1]) }, b: { comp: 'ga', ...ax([0, 0, 0], [0, 0, 1], 10) } },
        { id: 'm2', name: 'Coincident1', type: 'coincident', align: 1, a: { comp: 'base', ...pl([0, 0, 0], [0, 0, 1]) }, b: { comp: 'ga', ...pl([0, 0, 0], [0, 0, 1]) } },
        { id: 'm3', name: 'Concentric2', type: 'concentric', a: { comp: 'base', ...ax([30, 0, 0], [0, 0, 1]) }, b: { comp: 'gb', ...ax([0, 0, 0], [0, 0, 1], 20) } },
        { id: 'm4', name: 'Coincident2', type: 'coincident', align: 1, a: { comp: 'base', ...pl([0, 0, 0], [0, 0, 1]) }, b: { comp: 'gb', ...pl([0, 0, 0], [0, 0, 1]) } },
        { id: 'm5', name: 'Coincident3', type: 'coincident', align: 1, a: { comp: 'base', ...pl([0, 0, 0], [0, 0, 1]) }, b: { comp: 'rack', ...pl([0, 0, 0], [0, 0, 1]) } },
        { id: 'm6', name: 'Coincident4', type: 'coincident', align: 1, a: { comp: 'base', ...pl([0, -10, 0], [0, 1, 0]) }, b: { comp: 'rack', ...pl([0, 0, 0], [0, 1, 0]) } },
      ],
    };
    const byId = (id) => doc.components.find((c) => c.id === id);
    const poseOf = (id) => { const c = byId(id); return { p: c.pos.slice(), q: new THREE.Quaternion(...c.rot) }; };
    const worldRef = (r) => { const ps = poseOf(r.comp); const v = (x) => new THREE.Vector3(...x).applyQuaternion(ps.q).toArray(); return { kind: r.kind, p: v(r.p).map((x, i) => x + ps.p[i]), n: r.n && v(r.n), d: r.d && v(r.d), r: r.r }; };
    const gear = { id: 'g', name: 'Gear1', type: 'gear', side: 1, value: 0.5, a: doc.mates[0].b, b: doc.mates[2].b };
    const rack = { id: 'r', name: 'Rack1', type: 'rack', side: 1, value: 2 * Math.PI * 10, a: doc.mates[0].b, b: { comp: 'rack', ...ax([0, 0, 0], [1, 0, 0]) } };
    gear.ref = A.mechRef(gear, poseOf, worldRef); rack.ref = A.mechRef(rack, poseOf, worldRef);
    doc.mates.push(gear, rack);
    A.solveAssembly(doc);
    const study = { driver: { kind: 'turn', comp: 'ga', mate: 'm1', side: 'b', amount: 720 }, steps: 72 };
    const r = motionFrames(doc, study, (v, o) => A.solveAssembly(v, o));
    // gear B's total turn: summed over the frames (it passes ±180° on the way)
    let turnB = 0;
    const ang = (q) => 2 * Math.atan2(q[2], q[3]);
    for (let i = 1; i < r.frames.length; i++) {
      const qa = r.frames[i - 1].find((f) => f.id === 'gb').rot, qb = r.frames[i].find((f) => f.id === 'gb').rot;
      let d = ang(qb) - ang(qa); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      turnB += d;
    }
    const rackX = r.frames[r.frames.length - 1].find((f) => f.id === 'rack').pos[0];
    // a Distance mate driven: two blocks on a rail
    const doc2 = { components: [comp('a', true), comp('b', false, [10, 0, 0])], mates: [
      { id: 'd1', name: 'Distance1', type: 'distance', value: 10, side: 1, align: 1, a: { comp: 'a', ...pl([0, 0, 0], [1, 0, 0]) }, b: { comp: 'b', ...pl([0, 0, 0], [1, 0, 0]) } },
      { id: 'd2', name: 'Lock-ish', type: 'parallel', align: 1, a: { comp: 'a', ...pl([0, 0, 0], [0, 1, 0]) }, b: { comp: 'b', ...pl([0, 0, 0], [0, 1, 0]) } },
    ] };
    const r2 = motionFrames(doc2, { driver: { kind: 'mate', mate: 'd1', to: 40 }, steps: 10 }, (v, o) => A.solveAssembly(v, o));
    const bx = r2.frames[r2.frames.length - 1].find((f) => f.id === 'b').pos[0];
    const ok = !r.error && r.done === 72 && Math.abs((turnB * 180) / Math.PI + 360) < 0.01 && Math.abs(rackX - 2 * Math.PI * 10 * 2) < 0.01 && !r2.error && Math.abs(bx - 40) < 1e-4;
    return ok ? { ok: true, detail: `720° of gear A → B ${r6((turnB * 180) / Math.PI)}°, rack ${r6(rackX)} mm; Distance mate 10 → ${r6(bx)} mm` }
      : { ok: false, detail: `error ${r.error}, done ${r.done}, B ${(turnB * 180) / Math.PI}°, rack ${rackX}; mate: ${r2.error} b ${bx}` };
  },

  // more kernels at once: an assembly of six different (slow) parts built side by side, faster than in one kernel
  // and with the same meshes
  async 'parallel-kernels'(parts) {
    const a = window.app, pool = a.kernelPool;
    if (!pool) return { ok: false, detail: 'no kernel pool' };
    const base = JSON.parse(parts.find((p) => p.name === 'dimple-pattern').json);
    // (six different parts: the dimple pattern with other counts; `salt` keeps them from earlier builds)
    const make = (salt) => [0, 1, 2, 3, 4, 5].map((i) => { const d = JSON.parse(JSON.stringify(base)); d.name = `Ball${i}`; for (const f of d.features) if (f.type === 'cpattern') f.count = 18 + i * 2 + salt; return d; });
    const build = async (docs) => {
      a.newAssembly(); await wait(300); closeModals();
      const asm = a.drawing;
      const ids = docs.map((d) => asm.addPart(d, null, null));
      for (const [i, pid] of ids.entries()) { asm.doc.components.push({ id: 'c' + i, part: pid, name: `Ball${i}<1>`, pos: [i * 80, 0, 0], rot: [0, 0, 0, 1], fixed: !i, hidden: false }); }
      const t0 = performance.now();
      await asm.loadParts();
      const ms = performance.now() - t0;
      const tris = asm.doc.components.map((c) => asm.geo(c)?.mesh?.triangles?.length || 0);
      return { ms, tris };
    };
    const size = pool.size;
    pool.size = 1;
    const one = await build(make(0));
    pool.size = Math.max(2, size);
    const many = await build(make(0).map((d, i) => { d.features.find((f) => f.type === 'cpattern').count += 1000; d.features.find((f) => f.type === 'cpattern').count -= 1000; d.name += 'b'; return d; }));
    pool.size = size;
    // (the second set is the same geometry under other names: the same meshes, built again)
    const same = JSON.stringify(one.tris) === JSON.stringify(many.tris) && one.tris.every((n) => n > 0);
    // (a small machine, e.g. a CI runner, gains less from a second kernel)
    const faster = many.ms < one.ms * ((navigator.hardwareConcurrency || 4) >= 8 ? 0.8 : 0.97);
    return same && faster ? { ok: true, detail: `6 parts: ${Math.round(one.ms)} ms in 1 kernel, ${Math.round(many.ms)} ms in ${Math.max(2, size)} (${pool.stats().started} started)` }
      : { ok: false, detail: `same ${same} (${JSON.stringify(one.tris)} / ${JSON.stringify(many.tris)}), ${Math.round(one.ms)} ms vs ${Math.round(many.ms)} ms` };
  },

  // standard parts: a 9 mm hole through a 10 mm plate picked → an M8 bolt, 20 mm long (through it with room for a nut), in it (mated concentric
  // and seated on the plate's top); a second one reuses the part; a nut and a bearing build too
  async 'standard-parts'() {
    const a = window.app;
    const S = await import('/js/stdparts.js');
    const p = M.newDoc(); p.name = 'Plate';
    const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
    const pts = [[-30, -20], [30, -20], [30, 20], [-30, 20]];
    Object.assign(s, { points: [...pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), { id: 'p5', x: 0, y: 0 }], curves: [...pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), { id: 'c5', type: 'circle', c: 'p5', r: 4.5, construction: false }], constraints: [] });
    p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: 10 }));
    a.newAssembly(); await wait(300); closeModals();
    const asm = a.drawing;
    await asm.addComponent(asm.addPart(p, null, null));
    const plate = asm.doc.components[0];
    await until(() => asm.geo(plate)?.mesh, 30000);
    asm.vp.setStandardView('iso');
    const mesh = asm.geo(plate).mesh, gi = mesh.faceGroups.findIndex((g) => g.surf?.t === 'CYLINDER');
    const sf = mesh.faceGroups[gi].surf;
    const ref = { comp: plate.id, kind: 'axis', p: sf.p, d: sf.d, r: sf.r, face: gi, gi: `0:f${gi}`, what: 'Cylindrical face' };
    const hole = asm.holeOf(ref);
    const fit = S.fitToHole('hexBolt', 2 * hole.r, hole.depth);
    const bolt = await asm.insertStdPart('hexBolt', fit.size, fit.length, 'steel', hole);
    await until(() => asm.geo(bolt)?.mesh, 30000);
    const mates = asm.doc.mates.filter((m) => m.b.comp === bolt.id).map((m) => m.type).sort().join(',');
    const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000).join(',');
    const placed = r3(bolt.pos) === '0,10,0' && r3(bolt.rot) === '0,0,0,1';
    const bbox = asm.geo(bolt).box, bh = Math.round((bbox.max[1] - bbox.min[1]) * 100) / 100;
    const bolt2 = await asm.insertStdPart('hexBolt', fit.size, fit.length, 'steel', null);
    const nut = await asm.insertStdPart('hexNut', 'M8', null, 'steel', null);
    const brg = await asm.insertStdPart('bearing', '6204', null, 'steel', null);
    await until(() => [bolt2, nut, brg].every((c) => asm.geo(c)?.mesh), 30000);
    const parts = asm.doc.parts.length;
    const ok = fit.size === 'M8' && fit.length === 20 && Math.abs(hole.depth - 10) < 1e-3 && hole.face.face !== undefined && mates === 'coincident,concentric'
      && asm.solveOk && placed && bh === 25.3 && parts === 4 && bolt2.part === bolt.part;
    return ok ? { ok: true, detail: `Ø9 × 10 hole → ${fit.size}×${fit.length}, mated (${mates}), at ${r3(bolt.pos)}, ${bh} mm tall; ${parts} parts for 5 components` }
      : { ok: false, detail: `fit ${JSON.stringify(fit)}, depth ${hole.depth}, face ${hole.face.face}, mates ${mates}, solved ${asm.solveOk}, pos ${r3(bolt.pos)} rot ${r3(bolt.rot)}, height ${bh}, parts ${parts}` };
  },

  // macros: one run builds a plate with four holes (one undo step); a recording of features added, changed and
  // undone, and of a command, plays back into a new part as the same features
  async 'macros'() {
    const a = window.app, mc = a.macros;
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    a.newDocument(); await wait(200);
    const idx0 = a.history.idx;
    const r = await mc.run(`const p = await rc.sketch('top', (s) => s.centerRect(0, 0, 120, 80));
await rc.extrude(p, 10);
const h = await rc.sketch('top', (s) => { for (const x of [-1, 1]) for (const y of [-1, 1]) s.circle(x * 50, y * 30, 4.5); });
await rc.cut(h, 10);
const b = await rc.rebuild();
rc.log(b.bodies, b.errors.length);`, 'test');
    const vol = async () => { const m = await a.kernel.request('measure', { refs: [{ kind: 'body', id: a.result.bodies[0].id }] }); return (m.items?.[0] || m).volume; };
    const v1 = await vol(), want = 120 * 80 * 10 - 4 * Math.PI * 4.5 * 4.5 * 10;
    const ran = r.ok && r.log[0] === '1 0' && a.doc.features.length === 4 && Math.abs(v1 - want) < 1 && a.history.idx === idx0 + 1;
    // recording
    a.newDocument(); await wait(200);
    mc.startRecording();
    const d = a.doc, sk = M.createFeature(d, 'sketch', { plane: { ref: 'front' } });
    const S = await import('/js/sketchmodel.js');
    S.addCircle(sk, S.addPoint(sk, 0, 0), 15);
    M.insertFeature(d, sk); a.commit();
    mc.note('Features ▸ Extrude…');
    const ex = M.createFeature(d, 'extrude', { sketch: sk.id, depth: 30 });
    M.insertFeature(d, ex); a.commit();
    const ch = M.createFeature(d, 'chamfer', { distance: 1 });
    M.insertFeature(d, ch); a.commit();
    a.undo();
    mc.note('Zoom to Fit');
    M.findFeature(a.doc, ex.id).depth = 40; a.commit();
    mc.note('Isometric');
    await a.rebuild();
    const code = mc.stopRecording();
    document.querySelectorAll('.modal-back').forEach((x) => x.remove());
    const v2 = await vol();
    a.newDocument(); await wait(200);
    const r2 = await mc.run(code, 'recorded');
    await wait(100);
    const v3 = r2.ok ? await vol() : 0;
    const types = a.doc.features.map((f) => f.type).join(',');
    const recOk = r2.ok && types === 'sketch,extrude' && M.findFeature(a.doc, a.doc.features[1].id).depth === 40 && Math.abs(v3 - v2) < 1e-6
      && code.includes('await rc.command("Isometric");') && !code.includes('"Extrude"') && code.includes('rc.remove(') && code.includes('rc.set(');
    return ran && recOk ? { ok: true, detail: `plate ${Math.round(v1)} mm³ in one undo step; recorded ${code.split('\n').length - 2} lines, played back: ${types}, ${Math.round(v3)} mm³` }
      : { ok: false, detail: `run ${JSON.stringify(r)}, ${a.history.idx - idx0} steps, vol ${v1} vs ${want}; playback ${JSON.stringify(r2)} types ${types}, vol ${v3} vs ${v2}; code:\n${code}` };
  },

  // auto dimensions: a 120 × 80 × 10 plate with four Ø9 holes in three standard views → each overall size once,
  // one "4× Ø9", the holes' positions from the edges; a second run adds nothing
  async 'auto-dimension'() {
    const a = window.app;
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    a.newDocument(); await wait(200);
    const r = await a.macros.run(`const p = await rc.sketch('top', (s) => s.centerRect(0, 0, 120, 80));
await rc.extrude(p, 10);
const h = await rc.sketch('top', (s) => { for (const x of [-1, 1]) for (const y of [-1, 1]) s.circle(x * 50, y * 30, 4.5); });
await rc.cut(h, 10);`, 'plate');
    if (!r.ok) return { ok: false, detail: 'plate: ' + r.error };
    const keep = a.ui.newDrawingSetup;
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'Auto dims', props: {}, sheet: null });
    try { await a.newDrawing(true); } finally { a.ui.newDrawingSetup = keep; }
    const ed = a.drawing;
    await until(() => ed.doc.views.length === 3 && ed.doc.views.every((v) => (ed.geos.get(v.id)?.edges?.length || 0) > 0), 60000, 250);
    const Dm = await import('/js/drawing.js');
    const n1 = ed.autoDimension();
    const dims = ed.doc.anns.filter((x) => x.type === 'dim');
    const lin = dims.filter((x) => x.kind === 'linear').map((x) => Math.round(Dm.dimValue(ed.doc, x) * 1000) / 1000).sort((p, q) => p - q);
    const dia = dims.filter((x) => x.kind === 'diameter').map((x) => Dm.dimText(ed.doc, x));
    const n2 = ed.autoDimension();
    const ok = JSON.stringify(lin) === JSON.stringify([10, 10, 10, 70, 80, 110, 120]) && JSON.stringify(dia) === JSON.stringify(['4× Ø9']) && n1 === 8 && n2 === 0;
    return ok ? { ok: true, detail: `${n1} dimensions: ${lin.join(', ')} and ${dia.join(', ')}; again: ${n2}` }
      : { ok: false, detail: `added ${n1} (${lin.join(', ')} | ${dia.join(', ')}), again ${n2}` };
  },

  // BOM columns: parts' custom properties in the assembly's bill of materials and as BOM table columns on its
  // drawing, with a column of values typed into the table; a part's drawing takes its number from Part Number
  async 'bom-columns'() {
    const a = window.app;
    const box = (name, w, h, props) => {
      const p = M.newDoc(); p.name = name; p.customProps = props;
      const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
      const pts = [[-w / 2, -w / 2], [w / 2, -w / 2], [w / 2, w / 2], [-w / 2, w / 2]];
      Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
      p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: h }));
      return p;
    };
    const base = box('Base', 60, 5, [{ name: 'Part Number', value: 'PN-100' }, { name: 'Vendor', value: 'Acme' }]);
    const pin = box('Pin', 8, 20, [{ name: 'Part Number', value: 'PN-200' }, { name: 'Finish', value: 'Zinc' }]);
    a.newAssembly(); await wait(300); closeModals();
    const asm = a.drawing;
    const pb = asm.addPart(base, null, null), pp = asm.addPart(pin, null, null);
    await asm.addComponent(pb); await asm.addComponent(pp); await asm.addComponent(pp);
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh), 30000);
    const B = await import('/js/bom.js'), Dm = await import('/js/drawing.js');
    const names = B.bomPropNames(asm.doc).join(',');
    asm.showBOM();
    const win = document.querySelector('.modal-back table.bom')?.textContent || '';
    closeModals();
    const keep = a.ui.newDrawingSetup;
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'BOM cols', props: {}, sheet: null });
    try { await a.newDrawing(true); } finally { a.ui.newDrawingSetup = keep; }
    const ed = a.drawing;
    ed.addBOM();
    const ann = ed.doc.anns.find((x) => x.type === 'bom');
    const rows = B.bomRows(ed.doc.models[0].doc);
    const pinRow = rows.find((r) => r.name === 'Pin');
    ann.cols = [{ key: 'item', title: 'ITEM', w: 12 }, { key: 'prop:Part Number', title: 'PART NO.', w: 30 }, { key: 'name', title: 'PART', w: 40 }, { key: 'qty', title: 'QTY', w: 11 }, { key: 'text', title: 'NOTES', w: 30, values: { [pinRow.key]: 'press fit' } }];
    ed.changed();
    const texts = Dm.annPrims(ed.doc, ann, {}).filter((p) => p.t === 'text').map((p) => p.text);
    const tableOk = ['PART NO.', 'NOTES', 'PN-100', 'PN-200', 'press fit', 'Pin', '2'].every((t) => texts.includes(t)) && !texts.includes('MATERIAL');
    // a drawing of the pin part: its number from Part Number
    const pi = a.tabs.findIndex((t) => t.kind !== 'drawing');
    if (pi >= 0) await a.activateTab(pi);
    a.newDocument(); await wait(200);
    Object.assign(a.doc, JSON.parse(JSON.stringify(pin))); a.commit(); await a.rebuild();
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'Pin drawing', props: {}, sheet: null });
    try { await a.newDrawing(true); } finally { a.ui.newDrawingSetup = keep; }
    const num = a.drawing.doc.props.number;
    const ok = names === 'Part Number,Vendor,Finish' && win.includes('Vendor') && win.includes('Acme') && win.includes('Zinc') && tableOk && num === 'PN-200';
    return ok ? { ok: true, detail: `properties ${names}; table ${texts.slice(0, 6).join(' | ')}…; drawing number ${num}` }
      : { ok: false, detail: `names ${names}; window ${win.slice(0, 120)}; table ${texts.join(' | ')}; number ${num}` };
  },

  // the dark theme: View ▸ Theme ▸ Dark turns the window and the 3D view dark (fully defined sketch lines light),
  // Light turns it back; the choice is kept in the preferences
  async 'dark-theme'() {
    const a = window.app, T = await import('/js/theme.js');
    const bg = () => getComputedStyle(document.body).backgroundColor;
    const light = bg(), before = a.ui.prefs?.theme;
    a.ui.menuDefs().View.find((x) => /Theme ▸ .*Dark/.test(x.label)).action();
    await wait(50);
    const dark = bg(), vp = getComputedStyle(document.getElementById('viewport')).backgroundImage, kept = a.ui.prefs.theme;
    const sk = T.sketchDefined(), menu = a.ui.menuDefs().View.find((x) => /● Dark/.test(x.label));
    a.ui.setTheme(before || 'light');
    await wait(50);
    const back = bg();
    const lum = (c) => { const m = c.match(/\d+/g).map(Number); return (m[0] + m[1] + m[2]) / 3; };
    const ok = lum(dark) < 60 && lum(light) > 180 && back === light && /rgb\(4[0-9], 5[0-9], 6[0-9]\)|44, 53, 66/.test(vp) && kept === 'dark' && sk === 0xe5e7eb && !!menu;
    return ok ? { ok: true, detail: `window ${light} → ${dark} → ${back}` } : { ok: false, detail: `bg ${light} / ${dark} / ${back}, viewport ${vp.slice(0, 80)}, kept ${kept}, sketch ${sk.toString(16)}, menu ${!!menu}` };
  },

  // languages: View ▸ Language ▸ Deutsch shows the menus, ribbon and dialogs in German (labels in parts too);
  // commands keep their English names for macros; English again afterwards
  async 'languages'() {
    const a = window.app, I = await import('/js/i18n.js');
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    const before = I.language();
    await a.ui.setLang('de');
    await wait(50);
    const menubar = [...document.querySelectorAll('#menubar > button[data-menu]')].map((b) => b.textContent).join(',');
    const ribbon = document.getElementById('cm-buttons').innerText.replace(/\u00ad/g, '');
    const parts = I.t('Features ▸ Fillet…'), counted = I.t('Mates (2)'), kept = I.t('Some text nobody wrote');
    a.ui.modal('Bill of Materials', 'bom', '<p>x</p>', [{ label: 'Close' }]);
    const modal = document.querySelector('.modal-back:last-child .modal-h span')?.textContent.replace(/\u00ad/g, '') + '|' + document.querySelector('.modal-back:last-child .modal-f button')?.textContent;
    closeModals();
    const r = await a.macros.run(`await rc.command('Zoom to Fit');`, 'cmd');
    await a.ui.setLang(before === 'en' ? 'en' : before);
    await wait(50);
    const back = document.querySelector('#menubar > button[data-menu]')?.textContent;
    const ok = menubar === 'Datei,Bearbeiten,Ansicht,Einfügen,Extras,Hilfe' && ribbon.includes('Verrundung') && ribbon.includes('Extrusion') && parts === 'Features ▸ Verrundung…'
      && counted === 'Verknüpfungen (2)' && kept === 'Some text nobody wrote' && modal === 'Stückliste|Schließen' && r.ok && back === 'File';
    return ok ? { ok: true, detail: `${menubar}; ${parts}; ${modal}; macro command ok; back to ${back}` }
      : { ok: false, detail: `menubar ${menubar}; ribbon has Verrundung ${ribbon.includes('Verrundung')}; ${parts}; ${counted}; ${modal}; macro ${JSON.stringify(r)}; back ${back}` };
  },

  // STEP round trip: a test part exported as STEP and imported into a new part gives the same solid (volume,
  // area, faces and edges)
  async 'step-roundtrip'(parts) {
    const a = window.app;
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    const src = JSON.parse(parts.find((p) => p.name === 'holes').json);
    const k = a.kernel;
    const r0 = await k.rebuild(src, null, null);
    const m = async (r) => { const x = await k.request('measure', { refs: [{ kind: 'body', id: r.body.bodies[0].id }] }); return x.items?.[0] || x; };
    const g0 = await m(r0), b0 = r0.body.bodies[0];
    const bytes = await k.exportBody('step', null, { name: 'holes' });
    const text = new TextDecoder().decode(bytes);
    const d = M.newDoc(); d.name = 'reimported';
    d.features.push(M.createFeature(d, 'import', { format: 'step', fileName: 'holes.step', data: text, name: 'holes' }));
    const r1 = await k.rebuild(d, null, null);
    const g1 = r1.body?.bodies?.length ? await m(r1) : {};
    const b1 = r1.body?.bodies?.[0] || {};
    const same = (x, y) => Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x));
    const ok = text.startsWith('ISO-10303-21') && r1.errors.length === 0 && same(g1.volume, g0.volume) && same(g1.area, g0.area) && b0.faceCount > 0 && b1.faceCount === b0.faceCount && b1.edgeCount === b0.edgeCount;
    return ok ? { ok: true, detail: `${Math.round(text.length / 1024)} kB of STEP; volume ${r6(g1.volume)}, ${b1.faceCount} faces, ${b1.edgeCount} edges, as before` }
      : { ok: false, detail: `errors ${JSON.stringify(r1.errors)}; volume ${g1.volume} vs ${g0.volume}, area ${g1.area} vs ${g0.area}, faces ${b1.faceCount}/${b0.faceCount}, edges ${b1.edgeCount}/${b0.edgeCount}` };
  },

  // a big assembly: 3 parts placed 40 times each (120 components) loads, counts right in the bill of materials and
  // exports as one STEP assembly with each part once
  async 'big-assembly'(parts) {
    const a = window.app;
    const docs = ['plate-features', 'holes', 'shell-box'].map((n) => JSON.parse(parts.find((p) => p.name === n).json));
    a.newAssembly(); await wait(300); closeModals();
    const asm = a.drawing;
    const ids = docs.map((d) => asm.addPart(d, null, null));
    let n = 0;
    ids.forEach((pid, j) => { for (let i = 0; i < 40; i++) asm.doc.components.push({ id: 'c' + ++n, part: pid, name: `${docs[j].name}<${i + 1}>`, pos: [(i % 8) * 160, j * 120, Math.floor(i / 8) * 120], rot: [0, 0, 0, 1], fixed: n === 1, hidden: false }); });
    const t0 = performance.now();
    await asm.loadParts();
    const ms = Math.round(performance.now() - t0);
    const built = asm.doc.components.every((c) => asm.geo(c)?.mesh);
    const B = await import('/js/bom.js');
    const rows = B.bomRows(asm.doc);
    const r = await (a.kernelPool || a.kernel).request('exportAssemblySTEP', { doc: JSON.stringify(asm.exportDoc()) }, 'asm-parts');
    const ok = built && rows.length === 3 && rows.every((x) => x.qty === 40) && r.parts === 3 && r.components === 120;
    return ok ? { ok: true, detail: `120 components of 3 parts loaded in ${ms} ms; BOM 3 × 40; STEP: ${r.parts} parts, ${r.components} placed` }
      : { ok: false, detail: `built ${built}, BOM ${JSON.stringify(rows.map((x) => [x.name, x.qty]))}, STEP ${JSON.stringify({ parts: r.parts, comps: r.components })}` };
  },

  // the browser version's notice: above the window, as wide as it (the text wraps), gone with ✕
  async 'web-notice'() {
    const a = window.app, root = document.getElementById('app');
    let kept = null;
    try { kept = localStorage.getItem('razorcad.webNoticeClosed'); localStorage.removeItem('razorcad.webNoticeClosed'); } catch { /* no storage */ }
    a.ui.showWebNotice();
    const n = document.getElementById('web-notice');
    const fits = !!n && n.getBoundingClientRect().width <= root.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 && root.classList.contains('with-notice');
    n?.querySelector('.x').click();
    const gone = !document.getElementById('web-notice') && !root.classList.contains('with-notice');
    try { if (kept === null) localStorage.removeItem('razorcad.webNoticeClosed'); else localStorage.setItem('razorcad.webNoticeClosed', kept); } catch { /* no storage */ }
    return fits && gone ? { ok: true, detail: 'fits the window; closes' } : { ok: false, detail: `fits ${fits}, gone ${gone}` };
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

// Drawings against stored output: these test parts drawn in the standard views by the kernel (hidden lines
// removed), each view as the count of each kind of line (visible / hidden / tangent…, line / circle / arc /
// curve) and its extent; sheet metal also as its flat pattern.
const DRAWING_PARTS = ['plate-features', 'holes', 'revolve-pattern', 'shell-box', 'sheet-metal', 'sweep-loft'];
async function drawingResult(doc) {
  const Dm = await import('/js/drawing.js');
  const O = Dm.ORIENTATIONS;
  const views = ['front', 'top', 'right', 'iso'].map((k) => ({ id: k, dir: O[k].dir, up: O[k].up, section: null }));
  if (doc.features.some((f) => f.type?.startsWith('sm'))) views.push({ id: 'flat', flat: true, body: null, dir: [0, 0, 1], up: [0, 1, 0] });
  const t0 = performance.now();
  const res = await window.app.kernel.request('drawingViews', { doc: JSON.stringify(doc), views });
  const out = {};
  for (const r of res) {
    if (r.error) { out[r.id] = { error: r.error }; continue; }
    const counts = {};
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const pt = (p) => { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; };
    for (const { k, g } of r.edges || []) {
      const key = `${k}:${g.t}`;
      counts[key] = (counts[key] || 0) + 1;
      if (k !== 'v' && k !== 't') continue;
      if (g.t === 'l') { pt(g.a); pt(g.b); } else if (g.t === 'c' || g.t === 'a') { pt([g.c[0] - g.r, g.c[1] - g.r]); pt([g.c[0] + g.r, g.c[1] + g.r]); } else if (g.pts) g.pts.forEach(pt);
    }
    out[r.id] = { counts: Object.fromEntries(Object.entries(counts).sort()), size: Number.isFinite(x0) ? [r6(x1 - x0), r6(y1 - y0)] : null };
  }
  out.ms = Math.round(performance.now() - t0);
  return out;
}

export async function run(parts, only = null) {
  const out = { parts: {}, ui: {}, drawings: {} };
  closeModals();
  for (const p of parts) {
    if (only && !only.includes(p.name)) continue;
    try { out.parts[p.name] = await partResult(JSON.parse(p.json)); } catch (e) { out.parts[p.name] = { crash: String(e?.message || e) }; }
  }
  for (const p of parts) {
    if (!DRAWING_PARTS.includes(p.name) || (only && !only.includes(p.name) && !only.includes('drawings'))) continue;
    try { out.drawings[p.name] = await drawingResult(JSON.parse(p.json)); } catch (e) { out.drawings[p.name] = { crash: String(e?.message || e) }; }
  }
  for (const [name, fn] of Object.entries(UI)) {
    if (only && !only.includes(name)) continue;
    const t0 = performance.now();
    try { out.ui[name] = await fn(parts); } catch (e) { out.ui[name] = { ok: false, detail: 'crashed: ' + (e?.stack || e) }; }
    out.ui[name].ms = Math.round(performance.now() - t0);
  }
  return out;
}
