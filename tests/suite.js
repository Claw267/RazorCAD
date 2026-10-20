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
