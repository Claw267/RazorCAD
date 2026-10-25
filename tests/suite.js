// RazorCAD regression tests, run inside the app page by run_tests.py (headless Edge).
//  - Parts: each test part (tests/parts/*.rcad) rebuilt by the real geometry kernel, in every configuration:
//    errors, and per body its volume, area, face and edge count (sheet metal: the flat pattern's size).
//    run_tests.py compares these with tests/expected.json.
//  - UI: a few things done the way a user does them (real pointer events on the view): sketch, dimension
//    and extrude; a drawing from the part; an assembly; the mouse buttons on the view.
import * as M from '/js/model.js';
import { threadsPerKernel } from '/js/machine.js';
import { BUILTIN_TEMPLATES } from '/js/drawtemplates.js';
import * as D2 from '/js/drawing.js';
import { checkDrawing } from '/js/drawcheck.js';

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

// big imports kept in the store of models built (here the browser version's): read from the file the first time, by
// a fresh kernel then from the store (OpenCascade's own format, several times quicker), the same solid: a STEP (a
// comment makes the test tray's file big enough to be kept) and an STL (a finely divided sphere, made here)
async function importStore(which) {
  const a = window.app, was = window.RAZORCAD_WEB, { KernelClient, forgetImportTexts } = await import('/js/kernelclient.js');
  const tray = JSON.parse(await (await fetch('/tests/parts/sheet-metal-tray.rcad')).text());
  const kernels = [];
  try {
    window.RAZORCAD_WEB = { ...(was || {}), kernel: 'test-' + Math.random().toString(36).slice(2) };
    const docs = [];
    if (which === 'STEP') {
    const r0 = await a.kernel.request('rebuild', { doc: JSON.stringify(tray) });
    if (!r0.body?.bodies?.length) throw new Error(`the tray: no body (${JSON.stringify(r0.errors)}, ${JSON.stringify(r0.body)?.slice(0, 80)})`);
    let step = new TextDecoder().decode(await a.kernel.request('export', { format: 'step', bodyId: r0.body.bodies[0].id }));
    // (a comment of many short lines: the STEP reader does not take a line megabytes long)
    step = step.replace('ISO-10303-21;', 'ISO-10303-21;\n/* ' + 'RazorCAD test padding\n'.repeat(100000) + ' */');
    const d = M.newDoc(); d.name = 'Big import';
    d.features.push(M.createFeature(d, 'import', { format: 'step', fileName: 'tray.step', data: step }));
    docs.push(['STEP', d, step.length]);
    } else {
    // a binary STL: a sphere of 120 × 130 quads (31 200 triangles), as base64
    const nu = 130, nv = 120, rad = 40, P = (i, j) => { const th = (2 * Math.PI * i) / nu, ph = (Math.PI * j) / nv; return [rad * Math.sin(ph) * Math.cos(th), rad * Math.sin(ph) * Math.sin(th), rad * Math.cos(ph)]; };
    const tris = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a0 = P(i, j), b0 = P(i + 1, j), c0 = P(i + 1, j + 1), d0 = P(i, j + 1);
      if (j > 0) tris.push([a0, b0, c0]);
      if (j < nv - 1) tris.push([a0, c0, d0]);
    }
    const stl = new DataView(new ArrayBuffer(84 + 50 * tris.length));
    stl.setUint32(80, tris.length, true);
    tris.forEach((t, k) => t.forEach((q, v) => q.forEach((x, c) => stl.setFloat32(84 + 50 * k + 12 + 12 * v + 4 * c, x, true))));
    const bytes = new Uint8Array(stl.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const dm = M.newDoc(); dm.name = 'Big mesh';
    dm.features.push(M.createFeature(dm, 'import', { format: 'stl', fileName: 'sphere.stl', data: btoa(bin) }));
    docs.push(['STL', dm, dm.features[0].data.length]);
    }
    const build = async (d) => {
      const k = new KernelClient({ threads: threadsPerKernel() }); kernels.push(k); await k.ready;
      let stored = false; k.onStored = () => { stored = true; };
      const r = await k.request('rebuild', { doc: JSON.stringify(d) });
      if (!r.body?.bodies?.length) throw new Error(`${d.name}: no body: ${JSON.stringify(r.errors)}`);
      // (the volume from the mesh: a precise measure of 30 000 faces takes a while)
      const V = r.body.vertices, T = r.body.triangles;
      let v6 = 0;
      for (let i = 0; i < T.length; i += 3) {
        const [p, q, w] = [0, 1, 2].map((j) => 3 * T[i + j]);
        v6 += V[p] * (V[q + 1] * V[w + 2] - V[q + 2] * V[w + 1]) - V[p + 1] * (V[q] * V[w + 2] - V[q + 2] * V[w]) + V[p + 2] * (V[q] * V[w + 1] - V[q + 1] * V[w]);
      }
      return { r, k, from: r.timing.imports?.[0]?.[1], vol: Math.abs(v6 / 6), faces: r.body.bodies[0].faceCount, stored: () => stored };
    };
    const out = [], bad = [];
    for (const [name, doc, size] of docs) {
      const b1 = await build(doc);
      for (let i = 0; i < 150 && !b1.stored(); i++) await wait(100);
      forgetImportTexts();
      const b2 = await build(doc);
      const ok = size > 2e6 && b1.from === 'file' && b1.stored() && b2.from === 'store' && b2.faces === b1.faces && Math.abs(b2.vol - b1.vol) < 1e-6 * b1.vol;
      if (ok) out.push(`${(size / 1e6).toFixed(1)} MB ${name}: from the file and kept, then from the store (${b2.faces} faces, volume the same)`);
      else bad.push(`${name}, ${size} characters: first from ${b1.from}, kept ${b1.stored()}; second from ${b2.from}; faces ${b1.faces} / ${b2.faces}, volume ${b1.vol} / ${b2.vol}`);
    }
    return !bad.length ? { ok: true, detail: out.join('; ') } : { ok: false, detail: bad.join('; ') };
  } finally {
    kernels.forEach((k) => k.dispose());
    if (was === undefined) delete window.RAZORCAD_WEB; else window.RAZORCAD_WEB = was;
  }
}

// Convert to Sheet Metal, kinds of sheet: the tray (written to STEP, read back as a plain body and converted from its
// base) with open corners, with 120° flanges and with RazorCAD's own closed corners (mitred, square ended, mitred
// bends) comes out exactly as made (faces, volume, flat pattern); with a hem, a clear message; and one body of two
// converted, the other left as it was
async function convertSheetVariants(part) {
  // (the part's own kernel, with its threads: six sheet metal parts built, converted and flattened)
  const k = window.app.kernel, pool = { request: (type, data) => k.request(type, data) }, aff = null;
  const tray = JSON.parse(await (await fetch('/tests/parts/sheet-metal-tray.rcad')).text());
  const base = () => { const d = JSON.parse(JSON.stringify(tray)); d.features = d.features.slice(0, 3); return d; };
  const meshOf = (r, b) => {
    const V = r.body.vertices, T = r.body.triangles, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let v6 = 0;
    for (let k = b.triStart; k < b.triStart + b.triCount; k++) for (let j = 0; j < 3; j++) { const x = V[3 * T[k] + j]; min[j] = Math.min(min[j], x); max[j] = Math.max(max[j], x); }
    for (let k = b.triStart; k < b.triStart + b.triCount; k += 3) {
      const [a, c, e] = [0, 1, 2].map((j) => 3 * T[k + j]);
      v6 += V[a] * (V[c + 1] * V[e + 2] - V[c + 2] * V[e + 1]) - V[a + 1] * (V[c] * V[e + 2] - V[c + 2] * V[e]) + V[a + 2] * (V[c] * V[e + 1] - V[c + 1] * V[e]);
    }
    return { faces: b.faceCount, min, max, vol: Math.abs(v6 / 6) };
  };
  const flatSize = async (id) => (await pool.request('sheetFlat', { bodyId: id }, aff)).size.map((x) => +x.toFixed(3)).sort((x, y) => x - y).join(' × ');
  // a part's bodies to STEP, read back, the tray converted from its base (the flat face at y = 0)
  const convert = async (d) => {
    const r0 = await pool.request('rebuild', { doc: JSON.stringify(d) }, aff);
    const tray0 = r0.body.bodies.find((b) => b.sheet);
    const flat0 = tray0 ? await flatSize(tray0.id) : null;
    const step = new TextDecoder().decode(await pool.request('export', { format: 'step' }, aff));
    const di = M.newDoc(); di.name = 'Converted';
    di.features.push(M.createFeature(di, 'import', { format: 'step', fileName: 'tray.step', data: step }));
    const r1 = await pool.request('rebuild', { doc: JSON.stringify(di) }, aff);
    // (the precise volumes too: the meshes of the same solid made two ways can differ by a few parts in a million)
    const exact = async (id) => { const m = await pool.request('measure', { refs: [{ kind: 'body', id }] }, aff); return (m.items?.[0] || m).volume; };
    const e0 = await exact(r1.body.bodies[0].id);
    di.features.push(M.createFeature(di, 'smConvert', { face: { p: [0, 0, 0], n: [0, -1, 0] } }));
    const r2 = await pool.request('rebuild', { doc: JSON.stringify(di) }, aff);
    const conv = r2.body.bodies.find((b) => b.sheet);
    const before = r1.body.bodies.map((b) => meshOf(r1, b)), after = r2.body.bodies.map((b) => meshOf(r2, b));
    const i = conv ? r2.body.bodies.indexOf(conv) : -1;
    const e1 = conv ? await exact(conv.id) : NaN;
    return { r2, conv, before, after, i, e0, e1, flat0, flat1: conv ? await flatSize(conv.id) : null };
  };
  const inside = (a, b) => a.min.every((x, k) => x >= b.min[k] - 1e-3) && a.max.every((x, k) => x <= b.max[k] + 1e-3);
  const cases = {
    open: { set: (d) => { d.features[2].corner = 'open'; }, exact: true },
    angle120: { set: (d) => { Object.assign(d.features[2], { corner: 'open', angle: 120, edges: d.features[2].edges.slice(0, 2) }); }, exact: true },
    // (RazorCAD's own corners made again as it made them)
    butt: { set: (d) => { d.features[2].corner = 'butt'; }, exact: true },
    square: { set: (d) => { d.features[2].corner = 'square'; }, exact: true },
    mitre: { set: (d) => { d.features[2].cornerBend = 'mitre'; }, exact: true },
  };
  const out = [], bad = [];
  for (const [name, c] of part === 'corners' ? Object.entries(cases) : []) {
    const d = base(); c.set(d);
    const x = await convert(d);
    const a = x.before[0], b = x.after[x.i] || {}, dv = c.exact ? (x.e1 - x.e0) / x.e0 : (b.vol - a.vol) / a.vol;
    const ok = !x.r2.errors.length && x.conv && inside(b, a) && x.flat1 === x.flat0
      && (c.exact ? b.faces === a.faces && Math.abs(dv) < 1e-6 : Math.abs(dv) < c.within);
    out.push(`${name} ${(dv * 100).toFixed(c.exact ? 3 : 6)} %${b.faces !== a.faces ? ` (${a.faces} → ${b.faces} faces)` : ''}`);
    if (!ok) bad.push(`${name}: errors ${JSON.stringify(x.r2.errors)}, faces ${a.faces} → ${b.faces}, volume ${a.vol.toFixed(2)} → ${b.vol?.toFixed(2)}, inside ${x.conv && inside(b, a)}, flat ${x.flat0} → ${x.flat1}`);
  }
  // a hem: not converted, with the reason
  if (part === 'others') {
    const d = base();
    Object.assign(d.features[2], { corner: 'open', edges: d.features[2].edges.slice(0, 1) });
    d.features.push(M.createFeature(d, 'smHem', { edges: [{ p: [0, 1.5, -40] }], hemType: 'closed', length: 8 }));
    const x = await convert(d);
    const msg = x.r2.errors.map((e) => e[1]).join(' ');
    if (x.conv || !/hem/i.test(msg)) bad.push(`hem: converted ${!!x.conv}, message "${msg}"`); else out.push('hem: refused');
  }
  // two bodies (the tray and a block beside it): the tray converted, the block as it was
  if (part === 'others') {
    const d = base();
    d.features[2].corner = 'open';
    const sk = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
    const pts = [[100, -10], [120, -10], [120, 10], [100, 10]];
    Object.assign(sk, { points: pts.map(([px, py], k) => ({ id: 'p' + k, x: px, y: py })), curves: pts.map((_, k) => ({ id: 'c' + k, type: 'line', p1: 'p' + k, p2: 'p' + ((k + 1) % 4), construction: false })), constraints: [] });
    d.features.push(sk, M.createFeature(d, 'extrude', { sketch: sk.id, depth: 12, merge: false }));
    const x = await convert(d);
    const blockBefore = x.before.find((m) => m.max[0] > 90), blockAfter = x.after.find((m, k) => k !== x.i && m.max[0] > 90);
    const ok = x.r2.body.bodies.length === 2 && x.conv && blockAfter && Math.abs(blockAfter.vol - blockBefore.vol) < 1e-6 && blockAfter.faces === blockBefore.faces;
    if (!ok) bad.push(`two bodies: ${x.r2.body.bodies.length} bodies, converted ${!!x.conv}, block ${blockBefore?.vol} → ${blockAfter?.vol}`); else out.push('two bodies: one converted');
  }
  return !bad.length ? { ok: true, detail: out.join('; ') } : { ok: false, detail: bad.join(' | ') };
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

  // a drawing of the part: three standard views with lines in them (the part the test before made; made here when
  // this test runs on its own, as in a page of its own with run_tests.py --jobs)
  async 'drawing-from-part'() {
    const a = window.app;
    if (a.mode === 'drawing') return { ok: false, detail: 'no part in front' };
    if (!a.result?.bodies?.length) {
      const made = await UI['sketch-dimension-extrude']();
      if (!made.ok) return { ok: false, detail: 'the part to draw: ' + made.detail };
    }
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

  async 'sketch-rename-underdefined'() {
    const a = window.app;
    await a.newDocument?.(); closeModals();
    const S = await import('/js/sketchmodel.js');
    const f = M.createFeature(a.doc, 'sketch', { plane: { ref: 'front' } });
    const p = S.addPoint(f, 2, 3), q = S.addPoint(f, 20, 5);
    S.addLine(f, p, q);
    a.doc.features.push(f); a.commit(); a.ui.renderTree();
    const row = document.querySelector(`#tree .tn[data-fid="${f.id}"]`);
    if (!row?.querySelector('.tl')?.textContent.startsWith('(-)')) return { ok: false, detail: 'Expected an under-defined sketch' };
    a.ui.renameFeature(f.id);
    const input = row.querySelector('input.rename');
    if (!input) return { ok: false, detail: 'Rename did not open' };
    input.value = 'Neck outline';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { ok: f.name === 'Neck outline', detail: 'Renamed a sketch whose tree label includes (-)' };
  },

  async 'sketch-project-spline'() {
    const S = await import('/js/sketchmodel.js');
    const source = S.newSketchData(), dest = S.newSketchData();
    const pts = [[0, 0], [0, 4], [4, 8], [8, 8], [12, 4], [12, 0]].map(([x, y]) => S.addPoint(source, x, y));
    const id = S.addCtrlSpline(source, pts, 5), c = S.getCurve(source, id);
    const fr = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
    const target = { ...fr, o: [0, 0, 19] };
    const project = () => S.projectCurve(target, S.curve3D(source, c, fr), { preserveSpline: true });
    const ids = S.addProjected(dest, project(), { kind: 'sketch', fid: 'source', cid: id });
    const d = S.getCurve(dest, ids[0]), k = dest.constraints.find((k) => k.type === 'projected');
    if (ids.length !== 1 || d.type !== 'spline' || d.degree !== 5 || !k.src.spline) return { ok: false, detail: 'Projection did not preserve one linked spline' };
    const expected = S.curvePoints(source, c), actual = S.curvePoints(dest, d);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return { ok: false, detail: 'Projection changed the curve' };
    S.getPoint(source, pts[2]).y += 3;
    if (!S.updateProjected(dest, k, project()) || k.pts[d.pts[2]][1] !== 11) return { ok: false, detail: 'Source edit did not update projection targets' };
    const legacy = S.projectCurve(target, S.curve3D(source, c, fr));
    return { ok: legacy.length > 1 && legacy.every((g) => g.type === 'line'), detail: 'One degree-5 linked spline, source edits followed, legacy segment projections preserved' };
  },

  // a control-point spline crossing its own control polygon: a click where they cross picks the polygon's leg (the
  // spline can be picked anywhere else), so the leg can be dimensioned; elsewhere along the curve, the spline
  async 'sketch-pick-polygon-leg'() {
    const a = window.app;
    await a.newDocument?.();
    closeModals();
    const f = M.createFeature(a.doc, 'sketch', { plane: { ref: 'front' } });
    a.doc.features.push(f); a.commit();
    await a.enterSketch(f, true);
    await wait(300);
    const sk = a.sketcher, S = await import('/js/sketchmodel.js');
    const pts = [[0, 0], [20, 5], [20, 35], [40, 40]].map(([x, y]) => S.addPoint(sk.f, x, y));
    const sp = S.addCtrlSpline(sk.f, pts, 3);
    sk.changed(); a.viewport.zoomToFit(); await wait(200);
    // (the curve passes through (20, 20), on the middle leg; at its quarter it is off the polygon)
    const atCross = sk.hitTest({ x: 20, y: 20 }), q = S.splinePieces(sk.f, S.getCurve(sk.f, sp))[0], onCurve = S.bezierAt(q, 0.3);
    const elsewhere = sk.hitTest({ x: onCurve[0], y: onCurve[1] });
    const leg = S.getCurve(sk.f, atCross?.id);
    await a.exitSketch(true);
    const ok = leg?.ctrlOf === sp && elsewhere?.id === sp;
    return { ok, detail: `where they cross: ${leg ? (leg.ctrlOf ? 'the polygon leg' : leg.type) : 'nothing'}; along the curve: ${elsewhere?.id === sp ? 'the spline' : elsewhere?.kind}` };
  },

  // relations and dimensions of deleted geometry leave nothing on the screen: a line with Horizontal and two circles
  // with Equal and a diameter; the circles deleted, the labels shown are the ones left (the hidden ones are not drawn)
  async 'sketch-stale-labels'() {
    const a = window.app;
    await a.newDocument?.();
    closeModals();
    const f = M.createFeature(a.doc, 'sketch', { plane: { ref: 'top' } });
    a.doc.features.push(f); a.commit();
    await a.enterSketch(f, true);
    await wait(300);
    const sk = a.sketcher, S = await import('/js/sketchmodel.js');
    const L = S.addLine(sk.f, S.addPoint(sk.f, -30, 0), S.addPoint(sk.f, 30, 2));
    S.addRel(sk.f, 'horizontal', [L]);
    const c1 = S.addCircle(sk.f, S.addPoint(sk.f, -10, 20), 4), c2 = S.addCircle(sk.f, S.addPoint(sk.f, 10, 20), 4);
    S.addRel(sk.f, 'equal', [c1, c2]);
    S.addRel(sk.f, 'dim', [c1], { kind: 'diameter', value: 8 });
    sk.changed(); await wait(200);
    const shown = () => [[...sk.dimPool].filter((e) => getComputedStyle(e).display !== 'none').length, [...sk.relPool].filter((e) => getComputedStyle(e).display !== 'none').length];
    const before = shown();
    sk.sel = new Set([c1, c2]);
    sk.deleteSelected();
    await wait(200);
    const after = shown(), left = [sk.dims.length, sk.rels.length];
    await a.exitSketch(true);
    const ok = before[0] >= 1 && before[1] > after[1] && after[0] === left[0] && after[1] === left[1];
    return { ok, detail: `before: ${before[0]} dimension(s), ${before[1]} relation symbol(s); after deleting the circles: ${after[0]} and ${after[1]} shown (${left[0]} and ${left[1]} left)` };
  },

  // the sketch's selection box, with the pointer: a rectangle and a circle beside it. Dragged left to right round the
  // rectangle (a window): its four lines and four corners, not the circle; dragged right to left over part of the
  // circle (crossing): the circle and its centre, not the rectangle; Ctrl adds to what is selected
  async 'sketch-box-select'() {
    const a = window.app;
    await a.newDocument?.();
    closeModals();
    const f = M.createFeature(a.doc, 'sketch', { plane: { ref: 'top' } });
    a.doc.features.push(f); a.commit();
    await a.enterSketch(f, true);
    await wait(300);
    const { toScreen, fire, vp } = viewEvents();
    vp.setStandardView('top', false); vp.zoomToFit(); await wait(200);
    const sk = a.sketcher, fr = sk.frame, S = await import('/js/sketchmodel.js');
    const r = S.buildCenterRect(sk.f, 'O', 0, 0, 20, 10);
    const cc = S.addPoint(sk.f, 45, 0), circ = S.addCircle(sk.f, cc, 8);
    sk.changed();
    vp.zoomToFit(); await wait(200);
    const at = (x, y) => toScreen(fr.o.clone().addScaledVector(fr.u, x).addScaledVector(fr.v, y));
    const drag = async (p, q, o = {}) => {
      fire('pointerdown', ...p, { button: 0, buttons: 1, ...o }); await wait(30);
      fire('pointermove', ...q, { button: 0, buttons: 1, ...o }); await wait(30);
      fire('pointerup', ...q, { button: 0, buttons: 0, ...o }); await wait(60);
    };
    sk.setTool('select');
    await drag(at(-28, -16), at(28, 16));
    const win = new Set(sk.sel);
    const rectIds = [...r.lines, ...r.corners];
    // (a centre rectangle has its construction diagonals too: inside the window as well)
    const winOk = rectIds.every((id) => win.has(id)) && !win.has(circ) && !win.has(cc);
    // crossing, right to left over the circle's left part (x 40 to 50 takes in its centre too)
    sk.sel.clear();
    await drag(at(50, 12), at(40, -12));
    const cross = new Set(sk.sel);
    const crossOk = cross.has(circ) && cross.has(cc) && !rectIds.some((id) => cross.has(id));
    // Ctrl: the rectangle added
    await drag(at(-28, -16), at(28, 16), { ctrlKey: true });
    const both = sk.sel.size === win.size + cross.size;
    const crossNames = [...cross].map((id) => S.itemName(sk.f, id)).join(', ');
    // (and a Control-Point Spline drawn with the degree chosen before drawing: 5, from seven clicks)
    sk.setTool('cspline');
    const degSel = [...document.querySelectorAll('#pm select')].find((x) => x.options.length === S.CTRL_MAX_DEGREE);
    if (degSel) { degSel.value = '5'; degSel.dispatchEvent(new Event('change')); }
    const { click } = viewEvents();
    for (const [x, y] of [[-30, 30], [-20, 45], [-10, 30], [0, 45], [10, 30], [20, 45], [30, 30]]) await click(...at(x, y));
    sk.key(new KeyboardEvent('keydown', { key: 'Enter' }));
    await wait(100);
    const drawn = sk.f.curves.find((c) => c.ctrl);
    sk.setTool('select');
    await a.exitSketch(true);
    const degOk = !!degSel && drawn?.degree === 5 && drawn?.pts.length === 7;
    const ok = winOk && crossOk && both && degOk;
    return { ok, detail: `window: ${win.size} selected (the rectangle's ${rectIds.length}, circle ${win.has(circ)}); crossing: ${crossNames}; with Ctrl: ${both ? 'added' : 'not added'}; spline drawn with the degree chosen first: ${drawn ? `degree ${drawn.degree}, ${drawn.pts.length} control points` : 'none'}` };
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
    // (the speed is only checked on a PC with 8 threads or more: on a small shared machine such as the 4-thread CI
    // runner, which also draws the view in software, the time of a second kernel varies too much from run to run)
    const big = (navigator.hardwareConcurrency || 4) >= 8;
    const faster = !big || many.ms < one.ms * 0.8;
    return same && faster ? { ok: true, detail: `6 parts: ${Math.round(one.ms)} ms in 1 kernel, ${Math.round(many.ms)} ms in ${Math.max(2, size)} (${pool.stats().started} started)${big ? '' : '; speed not checked on this small machine'}` }
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
    // (the mates are solved after its mesh comes: under load that can be a moment later)
    await until(() => r3(bolt.pos) === '0,10,0' || null, 5000);
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
    // (the ribbon's Features tab, whatever a test before left open: a new part when only drawings are)
    if (a.mode === 'drawing') { await a.newDocument(); closeModals(); }
    if (a.mode === 'sketch') await a.exitSketch(true);
    a.ui.cmTab = 'features';
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
      : { ok: false, detail: `menubar ${menubar}; ribbon has Verrundung ${ribbon.includes('Verrundung')} (mode ${a.mode}, tab ${a.ui.cmTab}: ${ribbon.slice(0, 80)}); ${parts}; ${counted}; ${modal}; macro ${JSON.stringify(r)}; back ${back}` };
  },

  // STEP round trip: a test part exported as STEP and imported into a new part gives the same solid (volume,
  // area, faces and edges)
  async 'step-closed-shells'(parts) {
    // a STEP part written as a surface model (closed shells, no solid, as some programs write theirs): read as a
    // solid, the same volume; an open shell in the same file stays a surface
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient();
    try {
      const src = JSON.parse(parts.find((p) => p.name === 'holes').json);
      const r0 = await k.rebuild(src, null, null);
      const v0 = (await k.request('measure', { refs: [{ kind: 'body', id: r0.body.bodies[0].id }] })).items?.[0]?.volume;
      let text = new TextDecoder().decode(await k.exportBody('step', null, { name: 'holes' }));
      const brep = text.match(/#(\d+)\s*=\s*MANIFOLD_SOLID_BREP\s*\(\s*'([^']*)'\s*,\s*#(\d+)\s*\)/);
      if (!brep) return { ok: false, detail: 'no solid in the STEP written' };
      text = text.replace(brep[0], `#${brep[1]} = SHELL_BASED_SURFACE_MODEL('${brep[2]}', (#${brep[3]}))`).replace(/ADVANCED_BREP_SHAPE_REPRESENTATION/g, 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION');
      const d = M.newDoc(); d.name = 'surface model';
      d.features.push(M.createFeature(d, 'import', { format: 'step', fileName: 'shells.step', data: text }));
      const r1 = await k.rebuild(d, null, null);
      const solids = (r1.body?.bodies || []).filter((b) => b.kind === 'solid'), surfs = (r1.body?.bodies || []).filter((b) => b.kind === 'surface');
      const v1 = solids.length ? (await k.request('measure', { refs: [{ kind: 'body', id: solids[0].id }] })).items?.[0]?.volume : null;
      const ok = solids.length === 1 && !surfs.length && Math.abs(v1 - v0) <= 1e-6 * v0;
      return ok ? { ok: true, detail: `closed shell read as a solid, volume ${r6(v1)} as written` }
        : { ok: false, detail: `${solids.length} solids, ${surfs.length} surfaces, volume ${v1} (written ${v0}), errors ${JSON.stringify(r1.errors)}` };
    } finally { k.dispose(); }
  },

  async 'step-roundtrip'(parts) {
    const a = window.app;
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    const src = JSON.parse(parts.find((p) => p.name === 'holes').json);
    // (a kernel of its own: the app's coalesces rebuilds, and one the app makes meanwhile would answer this one's)
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient();
    try {
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
    } finally { k.dispose(); }
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

  // Report a Problem: the text shown first (editable); Open GitHub Issue opens the new-issue page filled in with
  // it (here caught instead of opened); nothing else is sent
  async 'report-problem'() {
    const a = window.app, P = (await import('/js/platform.js')).platform;
    const keep = P.openUrl;
    let opened = null;
    P.openUrl = async (u) => { opened = u; return true; };
    try {
      await a.ui.reportProblem('');
      const ti = document.querySelector('.report-issue .ri-title'), tb = document.querySelector('.report-issue .ri-body');
      ti.value = 'Problem: the fillet fails';
      tb.value += '\nIt happens with a 0.1 mm edge.';
      [...document.querySelectorAll('.modal-f button')].find((b) => b.textContent === 'Open GitHub Issue').click();
      await wait(20);
    } finally { P.openUrl = keep; closeModals(); }
    const u = opened ? new URL(opened) : null;
    const ok = !!u && u.origin + u.pathname === 'https://github.com/Labs9119/RazorCAD/issues/new' && u.searchParams.get('title') === 'Problem: the fillet fails'
      && u.searchParams.get('body').includes('It happens with a 0.1 mm edge.') && u.searchParams.get('body').includes('**Report**');
    return ok ? { ok: true, detail: `${opened.length} characters: ${u.searchParams.get('title')}` } : { ok: false, detail: `opened ${opened}` };
  },

  // the fonts that come with RazorCAD: sketch text in Arial (not there in the test browser) is made in DejaVu Sans,
  // text in DejaVu Serif builds as it is, and drawing text in Times New Roman gets DejaVu Serif's metrics
  async 'bundled-fonts'() {
    const a = window.app, F = await import('/js/fonts.js'), P = (await import('/js/platform.js')).platform;
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    a.newDocument(); await wait(200);
    const r = await a.macros.run(`
const s = await rc.add('sketch', { plane: { ref: 'top' }, nextSid: 3, texts: [
  { id: 't1', text: 'RAZOR', x: -40, y: 0, h: 12, font: 'Arial', bold: true, italic: false, angle: 0 },
  { id: 't2', text: 'cad', x: 20, y: 0, h: 12, font: 'DejaVu Serif', bold: false, italic: true, angle: 0 }] });
await rc.extrude(s, 2);
const b = await rc.rebuild();
rc.log(b.bodies, b.errors.length);`, 'text');
    const vol = r.ok && a.result.bodies.length ? (await a.kernel.request('measure', { refs: a.result.bodies.map((b) => ({ kind: 'body', id: b.id })) })) : null;
    const v = vol ? (vol.items || [vol]).reduce((s, x) => s + (x.volume || 0), 0) : 0;
    const m = await F.loadDrawingFont('Times New Roman', false, (file) => P.fontData(file));
    const fams = await a.fontFamilies();
    const ok = r.ok && Number(r.log[0]?.split(' ')[1]) === 0 && a.result.bodies.length >= 1 && v > 100 && !!m?.metrics && F.fallbackFamily('Courier New') === 'DejaVu Sans Mono' && fams.includes('DejaVu Serif');
    return ok ? { ok: true, detail: `text extruded (${a.result.bodies.length} bodies, ${Math.round(v)} mm³); drawing font metrics from DejaVu Serif; ${fams.length} families offered` }
      : { ok: false, detail: `run ${JSON.stringify(r)}, bodies ${a.result.bodies.length}, volume ${v}, metrics ${!!m?.metrics}, families ${fams.join(',')}` };
  },

  // standard parts, round two: every type builds as one solid; a bolt with a washer under its head and a washer and
  // nut on the far side goes into all four holes of a plate; a hole ending on a round bar (no flat face there) keeps
  // its seat when the hole is moved
  async 'standard-parts-2'() {
    const a = window.app, S = await import('/js/stdparts.js'), k = a.kernel;
    const bad = [];
    for (const t of S.STD_TYPES) {
      const sp = S.makeStdPart(t.id, t.sizes[Math.floor(t.sizes.length / 2)], null, 'steel');
      const r = await k.rebuild(sp.doc, null, null);
      // (a bearing is two rings)
      if (r.errors.length || (r.body?.bodies || []).length !== (t.id === 'bearing' ? 2 : 1)) bad.push(`${t.id}: ${r.errors.map(([, m]) => m).join('; ') || (r.body?.bodies || []).length + ' bodies'}`);
    }
    const box = (name, geo, more) => { const p = M.newDoc(); p.name = name; const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } }); Object.assign(s, geo, { constraints: [] }); p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: 10 })); more?.(p); return p; };
    const pts = [[-30, -20], [30, -20], [30, 20], [-30, 20]];
    const plate = box('Plate', { points: [...pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), ...[[-20, -10], [20, -10], [20, 10], [-20, 10]].map(([x, y], i) => ({ id: 'h' + i, x, y }))],
      curves: [...pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), ...[0, 1, 2, 3].map((i) => ({ id: 'k' + i, type: 'circle', c: 'h' + i, r: 4.5, construction: false }))] });
    a.newAssembly(); await wait(300); closeModals();
    const asm = a.drawing;
    await asm.addComponent(asm.addPart(plate, null, null));
    const pc = asm.doc.components[0];
    await until(() => asm.geo(pc)?.mesh, 30000);
    asm.vp.setStandardView('iso');
    const mesh = asm.geo(pc).mesh, gi = mesh.faceGroups.findIndex((g) => g.surf?.t === 'CYLINDER');
    const sf = mesh.faceGroups[gi].surf;
    const hole = asm.holeOf({ comp: pc.id, kind: 'axis', p: sf.p, d: sf.d, r: sf.r, face: gi, gi: `0:f${gi}`, what: 'Cylindrical face' });
    const others = asm.matchingHoles(hole).length;
    const set = S.setParts('hexBolt', 'M8'), extra = 2 * S.heightOf(...set.washer) + S.heightOf(...set.nut);
    const L = S.fitLength('hexBolt', 'M8', hole.depth, extra);
    await asm.insertStdPart('hexBolt', 'M8', L, 'steel', hole, { washer: true, nut: true, all: true });
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh), 30000);
    const count = (re) => asm.doc.components.filter((c) => re.test(c.name)).length;
    const y = (re) => [...new Set(asm.doc.components.filter((c) => re.test(c.name)).map((c) => Math.round(c.pos[1] * 1000) / 1000))].sort((p, q) => p - q).join('/');
    const stackOk = others === 3 && L === 25 && count(/^Hex Bolt/) === 4 && count(/^Washer/) === 8 && count(/^Hex Nut/) === 4 && asm.doc.mates.length === 32 && asm.solveOk
      && y(/^Hex Bolt/) === '11.6' && y(/^Hex Nut/) === '-1.6' && y(/^Washer/) === '0/10';
    // (bolts, washers and nuts seated in clearance holes do not collide)
    const clashes = asm.collisions();
    // a cross hole in a round bar: its end is on the curved surface, a plane of its own, kept up when the hole moves
    const bar = M.newDoc(); bar.name = 'Bar';
    const s1 = M.createFeature(bar, 'sketch', { plane: { ref: 'right' } }); Object.assign(s1, { points: [{ id: 'p1', x: 0, y: 0 }], curves: [{ id: 'c1', type: 'circle', c: 'p1', r: 15, construction: false }], constraints: [] });
    const s2 = M.createFeature(bar, 'sketch', { plane: { ref: 'top' } }); Object.assign(s2, { points: [{ id: 'p1', x: 10, y: 0 }], curves: [{ id: 'c1', type: 'circle', c: 'p1', r: 4, construction: false }], constraints: [] });
    bar.features.push(s1, M.createFeature(bar, 'extrude', { sketch: s1.id, depth: 40, end: 'midplane' }), s2, M.createFeature(bar, 'extrude', { sketch: s2.id, op: 'cut', end: 'through2' }));
    const pb = asm.addPart(bar, null, null);
    await asm.addComponent(pb);
    const bc = asm.doc.components[asm.doc.components.length - 1];
    await until(() => asm.geo(bc)?.mesh, 30000);
    const bm = asm.geo(bc).mesh, bgi = bm.faceGroups.findIndex((g) => g.surf?.t === 'CYLINDER' && Math.abs(g.surf.r - 4) < 1e-6);
    const bs = bm.faceGroups[bgi].surf;
    const bh = asm.holeOf({ comp: bc.id, kind: 'axis', p: bs.p, d: bs.d, r: bs.r, face: bgi, gi: `x:f${bgi}`, what: 'Cylindrical face' });
    const own = !!bh.face.holeEnd;
    const pin = await asm.insertStdPart('dowelPin', 'Ø8', 20, 'steel', bh, {});
    const seatMate = asm.doc.mates.find((m) => m.b.comp === pin.id && m.type === 'coincident');
    const before = seatMate.a.p.map((v) => Math.round(v * 1000) / 1000).join(',');
    // (the part changed, as when it is saved again: a new copy of it)
    const nd = JSON.parse(JSON.stringify(asm.part(pb).doc)), hs = nd.features.find((f) => f.id === s2.id);
    hs.points[0].x = 20; hs.rev = M.newRev();
    asm.part(pb).doc = nd;
    await asm.loadParts();
    const after = seatMate.a.p.map((v) => Math.round(v * 1000) / 1000).join(',');
    const moved = Math.abs(seatMate.a.p[0] - before.split(',').map(Number)[0]) > 9.99 || Math.abs(seatMate.a.p[2] - before.split(',').map(Number)[2]) > 9.99;
    const ok = !bad.length && stackOk && !clashes.length && own && moved;
    return ok ? { ok: true, detail: `${S.STD_TYPES.length} types build; 4 holes × (washer, M8×${L}, washer, nut), 32 mates; bar hole end ${before} → ${after}` }
      : { ok: false, detail: `bad ${bad.join(' | ')}; clashes ${JSON.stringify(clashes.slice(0, 4))}; others ${others}, L ${L}, bolts ${count(/^Hex Bolt/)}, washers ${count(/^Washer/)}, nuts ${count(/^Hex Nut/)}, mates ${asm.doc.mates.length}, solved ${asm.solveOk}, y bolt ${y(/^Hex Bolt/)} nut ${y(/^Hex Nut/)} washer ${y(/^Washer/)}; own end ${own}; ${before} → ${after}` };
  },

  // equations shared across an assembly: two parts made 5 thick by their own `thickness` variable are made 12
  // thick by the assembly's `thickness = 2*base` (base = 6); a part without the variable is left; undo puts it back
  async 'assembly-equations'() {
    const a = window.app;
    const box = (name, w, eq) => {
      const p = M.newDoc(); p.name = name; if (eq) p.equations = [{ name: 'thickness', expr: '5' }];
      const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
      const pts = [[0, 0], [w, 0], [w, 20], [0, 20]];
      Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
      p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: eq ? 'thickness' : 5 }));
      return p;
    };
    a.newAssembly(); await wait(300); closeModals();
    const asm = a.drawing;
    const parts = [box('Left', 30, true), box('Right', 50, true), box('Spacer', 10, false)].map((d) => asm.addPart(d, null, null));
    for (const p of parts) await asm.addComponent(p);
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh), 30000);
    const h = (c) => { const b = asm.geo(c).box; return Math.round((b.max[1] - b.min[1]) * 1000) / 1000; };
    const hs = () => asm.doc.components.map(h).join('/');
    const before = hs();
    const has = asm.partsWithVariable('thickness').join(',');
    asm.showEquations();
    await wait(200);
    const rowsBefore = document.querySelectorAll('.modal .grid tr').length;
    closeModals();
    asm.begin();
    asm.doc.equations = [{ name: 'base', expr: '6', drive: false }, { name: 'thickness', expr: '2*base' }];
    const n = asm.applyEquationLinks();
    await asm.loadParts(); asm.solve(); asm.change();
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh && asm.geo(c).box), 30000);
    await until(() => hs() !== before, 30000);
    const after = hs();
    // the dialog lists both variables and who they drive
    asm.showEquations();
    await wait(200);
    const txt = document.querySelector('.modal .grid')?.textContent || '';
    closeModals();
    asm.undo();
    await until(() => hs() === before, 30000);
    const undone = hs();
    const ok = before === '5/5/5' && has === 'Left,Right' && n === 2 && after === '12/12/5' && /Left, Right/.test(txt) && /12/.test(txt) && rowsBefore === 1 && undone === '5/5/5';
    return ok ? { ok: true, detail: `heights ${before} → ${after} (thickness = 2*base drives Left, Right), undo ${undone}` }
      : { ok: false, detail: `before ${before}, has ${has}, n ${n}, after ${after}, undo ${undone}, rows ${rowsBefore}, dialog "${txt.slice(0, 200)}"` };
  },

  // collision detection: a pin in its hole (the same radius, its end inside the hole) and a block resting on the
  // plate do not collide; the block pushed 2 mm into the plate does. Dragging with Stop at Collisions brings the
  // block up to the plate and no further, and a motion study that lowers it stops at the step before it reaches the plate.
  async 'collision-detection'() {
    const a = window.app;
    const part = (name, loops, depth) => {
      const p = M.newDoc(); p.name = name;
      const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
      const pts = [], curves = [];
      for (const l of loops) {
        if (l.r) { pts.push({ id: 'q' + pts.length, x: l.c[0], y: l.c[1] }); curves.push({ id: 'k' + curves.length, type: 'circle', c: pts[pts.length - 1].id, r: l.r, construction: false }); continue; }
        const b = pts.length;
        l.forEach(([x, y], i) => pts.push({ id: 'q' + (b + i), x, y }));
        l.forEach((_, i) => curves.push({ id: 'k' + curves.length, type: 'line', p1: 'q' + (b + i), p2: 'q' + (b + (i + 1) % l.length), construction: false }));
      }
      Object.assign(s, { points: pts, curves, constraints: [] });
      p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth }));
      return p;
    };
    const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    a.newAssembly(); await wait(300); closeModals();
    const asm = a.drawing;
    const ps = [part('Plate', [rect(-30, -20, 30, 20), { c: [0, 0], r: 5 }], 10), part('Pin', [{ c: [0, 0], r: 5 }], 6), part('Block', [rect(15, -5, 25, 5)], 8)].map((d) => asm.addPart(d, null, null));
    for (const p of ps) await asm.addComponent(p);
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh), 30000);
    const [plate, pin, block] = asm.doc.components;
    const place = (c, y) => { c.pos = [0, y, 0]; c.rot = [0, 0, 0, 1]; };
    place(plate, 0); place(pin, 2); place(block, 10);
    const ys = asm.doc.components.map((c) => c.pos[1] + asm.geo(c).box.min[1]).join('/');
    const clear = asm.collisions();
    place(block, 8);
    const hit = asm.collisions();
    // a drag that would push it in: held where it was clear
    const ui = a.ui, mode0 = ui.prefs?.collide;
    (ui.prefs ||= {}).collide = 'stop';
    place(block, 10.5);
    const d = { start: asm.doc.components.map((c) => ({ pos: c.pos.slice(), rot: c.rot.slice() })) };
    d.free = d.start; d.overlap = new Set();
    block.pos = [0, 9.5, 0]; asm.dragCollisions(d);
    const stopY = block.pos[1];
    const okStop = Math.abs(block.pos[1] - 10) < 0.01 && (asm.clash || []).length === 2;
    block.pos = [0, 10.2, 0]; asm.dragCollisions(d);
    const okFree = Math.abs(block.pos[1] - 10.2) < 1e-9 && !asm.clash;
    if (mode0 === undefined) delete ui.prefs.collide; else ui.prefs.collide = mode0;
    // a motion study lowering the block 1 mm a step from 14: it reaches the plate at step 4 (y = 10 just touches)
    place(block, 14);
    const { MotionTool } = await import('/js/motion.js');
    const mt = new MotionTool(asm);
    mt.study = { collide: true, stopAtCollision: true };
    mt.before = JSON.stringify({ comps: asm.doc.components, mates: asm.doc.mates });
    const snap = (y) => asm.doc.components.map((c) => ({ id: c.id, pos: c === block ? [0, y, 0] : c.pos.slice(), rot: c.rot.slice() }));
    mt.frames = [14, 13, 12, 11, 10, 9, 8].map(snap);
    const cl = mt.findClashes();
    const okMotion = mt.firstClash?.step === 5 && mt.frames.length === 5 && /Block/.test(mt.firstClash.names) && Math.abs(block.pos[1] - 14) < 1e-9 && cl.get(5)?.length === 2;
    asm.clash = null;
    const ok = ys === '0/2/10' && clear.length === 0 && hit.length === 1 && /Plate/.test(hit[0].join()) && /Block/.test(hit[0].join()) && okStop && okFree && okMotion;
    return ok ? { ok: true, detail: `pin in hole and block on plate clear; block 2 mm in: ${hit[0].join(' × ')}; drag stopped at ${stopY.toFixed(3)} (the plate at 10); motion stops before step ${mt.firstClash.step}` }
      : { ok: false, detail: `ys ${ys}; clear ${JSON.stringify(clear)}; hit ${JSON.stringify(hit)}; stop ${okStop} free ${okFree} (y ${block.pos[1]}); motion ${JSON.stringify(mt.firstClash)} frames ${mt.frames.length}` };
  },

  // assembly features: an M8 hole made in the assembly at two points through two stacked plates (10 and 12 thick)
  // cuts both (Ø9), the parts' own documents unchanged; a hex bolt, washers and a nut go in each (M8×35, no
  // collisions), and the kernel's assembly (drawings, exports) has the holes too. A rectangular cut through both
  // takes 20×10 out of each; undo puts it back; the bottom plate moved, its holes move with the top one's.
  async 'assembly-features'() {
    const a = window.app, { meshVolume } = await import('/js/bom.js'), { asmPartFeatures } = await import('/js/asmcuts.js');
    const plate = (name, t) => {
      const p = M.newDoc(); p.name = name;
      const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
      const pts = [[-30, -20], [30, -20], [30, 20], [-30, 20]];
      Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
      p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: t }));
      return p;
    };
    a.newAssembly(); await wait(300); closeModals();
    const asm = a.drawing;
    const docs = [plate('Top', 10), plate('Bottom', 12)];
    for (const d of docs) await asm.addComponent(asm.addPart(d, null, null));
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh), 30000);
    const [top, bot] = asm.doc.components;
    top.pos = [0, 12, 0]; bot.pos = [0, 0, 0]; top.rot = [0, 0, 0, 1]; bot.rot = [0, 0, 0, 1];
    asm.change();
    const built = () => asm.doc.components.every((c) => asm.geo(c)?.mesh);
    const vol = (c) => Math.round(meshVolume(asm.geo(c).mesh));
    asm.startAsmFeature('hole');
    const ht = asm.holeTool;
    ht.f.at = { comp: top.id, n: [0, 1, 0], pts: [[-20, 10, 0], [20, 10, 0]], u: [1, 0, 0] };
    ht.fast = { kind: 'hexBolt', washer: true, nut: true };
    ht.detect();
    const roles = ht.f.comps.map((e) => e.role).join(',');
    await ht.ok();
    await until(built, 30000);
    const cyl = (c) => asm.geo(c).mesh.faceGroups.filter((g) => g.surf?.t === 'CYLINDER').map((g) => g.surf.r.toFixed(2)).join(',');
    const cnt = (re) => asm.doc.components.filter((c) => re.test(c.name)).length;
    const holes = cyl(top) === '4.50,4.50' && cyl(bot) === '4.50,4.50' && Math.abs(vol(top) - (24000 - 2 * Math.PI * 4.5 ** 2 * 10)) < 10;
    const untouched = docs.every((d) => d.features.length === 2) && asm.doc.parts.every((p) => !p.doc.features.some((f) => f.type === 'hole'));
    const fast = cnt(/^Hex Bolt M8×35/) === 2 && cnt(/^Washer/) === 4 && cnt(/^Hex Nut/) === 2 && asm.solveOk && !asm.collisions().length;
    const r = await (a.kernelPool || a.kernel).request('asmInterference', { doc: JSON.stringify(asm.doc) }, 'asm-parts');
    const plates = new Set([top.id, bot.id]), kernelOk = !r.pairs.some((x) => plates.has(x.a.split('/')[0]) || plates.has(x.b.split('/')[0]));
    // (the last component tapped: its hole is tapped M8, the first plain clearance)
    const tl = asmPartFeatures({ ...asm.doc, asmFeatures: [{ ...asm.doc.asmFeatures[0], tapLast: true }] });
    const tapOk = tl.get(top.id)[0].holeType === 'simple' && tl.get(bot.id)[0].holeType === 'tapped' && tl.get(bot.id)[0].thread === 'M8';
    // a rectangular cut through both
    const v0 = vol(top);
    asm.startAsmFeature('cut');
    const ct = asm.holeTool;
    ct.f.at = { comp: top.id, n: [0, 1, 0], pts: [[0, 10, 0]], u: [1, 0, 0] };
    ct.detect();
    await ct.ok();
    await until(() => built() && vol(top) !== v0, 30000);
    const vCut = [vol(top), vol(bot)], cutOk = Math.abs(vCut[0] - (v0 - 2000)) < 2 && Math.abs(vCut[1] - (24000 * 1.2 - 2 * Math.PI * 4.5 ** 2 * 12 - 2400)) < 10;
    asm.undo();
    await until(() => built() && vol(top) === v0, 30000);
    const undoOk = vol(top) === v0 && asm.doc.asmFeatures.length === 1;
    // the bottom plate moved 5 along x: its holes are where the top one's are (undo put new components in)
    const bot2 = asm.doc.components[1];
    bot2.pos = [5, 0, 0];
    asm.change();
    await until(() => built() && /-25|15/.test(asm.geo(bot2).mesh.faceGroups.filter((g) => g.surf?.t === 'CYLINDER').map((g) => g.surf.p[0].toFixed(0)).join()), 30000);
    const xs = asm.geo(bot2).mesh.faceGroups.filter((g) => g.surf?.t === 'CYLINDER').map((g) => Math.round(g.surf.p[0])).sort((p, q) => p - q).join(',');
    const ok = roles === 'first,last' && holes && untouched && fast && kernelOk && tapOk && cutOk && undoOk && xs === '-25,15';
    return ok ? { ok: true, detail: `2 × M8 normal (Ø9) through both plates, 2 × (washer, M8×35, washer, nut); cut 20×10 through both, undone; bottom moved: its holes at x ${xs}` }
      : { ok: false, detail: `roles ${roles}; holes ${holes} (${cyl(top)} / ${cyl(bot)}, vol ${vol(top)}); untouched ${untouched}; fast ${fast} (${asm.doc.components.map((c) => c.name).join(', ')}, clashes ${JSON.stringify(asm.collisions())}); kernel ${kernelOk} ${JSON.stringify(r.pairs)}; tap ${tapOk}; cut ${cutOk} ${vCut}; undo ${undoOk}; xs ${xs}` };
  },

  // speed mode: an assembly of a round boss and a ring (curved faces), each twice, is shown from simplified meshes —
  // far fewer triangles, the same faces (so mates and picking hold); a component selected gets its part in full;
  // speed mode off shows everything in full again.
  async 'speed-mode'() {
    const a = window.app;
    const round = (name, R, r, h) => {
      const p = M.newDoc(); p.name = name;
      const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
      Object.assign(s, { points: [{ id: 'p1', x: 0, y: 0 }], curves: [{ id: 'c1', type: 'circle', c: 'p1', r: R, construction: false }, ...(r ? [{ id: 'c2', type: 'circle', c: 'p1', r, construction: false }] : [])], constraints: [] });
      p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: h }));
      return p;
    };
    a.newAssembly(); await wait(300); closeModals();
    const asm = a.drawing;
    const ps = [asm.addPart(round('Boss', 40, 0, 30), null, null), asm.addPart(round('Ring', 60, 45, 10), null, null)];
    for (const p of [...ps, ...ps]) await asm.addComponent(p);
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh), 30000);
    asm.flushGeometry();
    const tris = () => { asm.flushGeometry(); return asm.display.stats().triangles; };
    const faces = (c) => asm.geo(c).mesh.faceGroups.length;
    const full = tris(), f0 = asm.doc.components.map(faces).join(',');
    const after = await asm.setSpeedMode(true);
    const f1 = asm.doc.components.map(faces).join(',');
    const coarse = asm.doc.components.every((c) => asm.geo(c).coarse);
    // the ring selected: its part in full, the boss still simplified
    const ring = asm.doc.components[1];
    asm.select({ kind: 'comp', id: ring.id });
    await until(() => !asm.geo(ring).coarse, 30000);
    const mixed = !!asm.geo(asm.doc.components[0]).coarse;
    const back = await asm.setSpeedMode(false);
    const ok = after < full * 0.5 && f1 === f0 && coarse && mixed && !asm.geo(ring).coarse && back === full && !asm.doc.speedMode;
    return ok ? { ok: true, detail: `${full} → ${after} triangles shown (faces ${f0} kept); the selected ring in full; off: ${back}` }
      : { ok: false, detail: `full ${full}, speed ${after}, faces ${f0} / ${f1}, coarse ${coarse}, mixed ${mixed}, back ${back}` };
  },

  // macros in assemblies and drawings: a recording of a part inserted twice and mated plays back into a new
  // assembly as the same (2 components, 1 mate, solved); a note added to a drawing plays back into another drawing
  async 'macros-editors'() {
    const a = window.app, mc = a.macros;
    const part = M.newDoc(); part.name = 'Block';
    const s = M.createFeature(part, 'sketch', { plane: { ref: 'top' } });
    const pts = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
    part.features.push(s, M.createFeature(part, 'extrude', { sketch: s.id, depth: 15 }));
    a.newAssembly(); await wait(300); closeModals();
    let asm = a.drawing;
    mc.startRecording();
    const pid = asm.addPart(part, null, null);
    await asm.addComponent(pid); await asm.addComponent(pid);
    const [c1, c2] = asm.doc.components;
    await until(() => asm.geo(c2)?.mesh, 30000);
    asm.begin();
    asm.doc.mates.push({ id: asm.uid('m'), name: 'Coincident1', type: 'coincident', align: -1, side: 1, value: null, a: { comp: c1.id, kind: 'plane', p: [0, 15, 0], n: [0, 1, 0], what: 'Face' }, b: { comp: c2.id, kind: 'plane', p: [0, 0, 0], n: [0, -1, 0], what: 'Face' } });
    asm.solve(); asm.change('Mate added');
    const code = mc.stopRecording();
    closeModals();
    a.newAssembly(); await wait(300); closeModals();
    asm = a.drawing;
    const r = await mc.run(code, 'asm');
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh), 30000);
    const top = asm.doc.components[1];
    const asmOk = r.ok && asm.doc.parts.length === 1 && asm.doc.components.length === 2 && asm.doc.mates.length === 1 && asm.solveOk && Math.abs(top.pos[1] - 15) < 1e-6
      && asm.doc.mates[0].a.comp === asm.doc.components[0].id && asm.undoStack.length === 1;
    // a drawing: a note added
    const keep = a.ui.newDrawingSetup;
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'D1', props: {}, sheet: null });
    let ed;
    try { await a.newDrawing(); ed = a.drawing; } finally { a.ui.newDrawingSetup = keep; }
    mc.startRecording();
    ed.doc.anns.push({ id: D2.newId(ed.doc, 'a'), type: 'note', sheet: ed.sheetId, pos: [50, 50], text: 'Deburr all edges' });
    ed.changed();
    const code2 = mc.stopRecording();
    closeModals();
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'D2', props: {}, sheet: null });
    try { await a.newDrawing(); } finally { a.ui.newDrawingSetup = keep; }
    const ed2 = a.drawing;
    const r2 = await mc.run(code2, 'dwg');
    const note = ed2.doc.anns.find((x) => x.type === 'note');
    const dwgOk = r2.ok && note?.text === 'Deburr all edges' && note.sheet === ed2.sheetId;
    return asmOk && dwgOk ? { ok: true, detail: `assembly: ${code.split('\n').length - 2} lines → 2 components, 1 mate, solved, one undo step; drawing: the note` }
      : { ok: false, detail: `asm ${JSON.stringify(r)} parts ${asm.doc.parts.length} comps ${asm.doc.components.length} mates ${asm.doc.mates.length} solved ${asm.solveOk} y ${top?.pos} undo ${asm.undoStack.length}; dwg ${JSON.stringify(r2)} note ${JSON.stringify(note)}; code:\n${code.slice(0, 600)}\n${code2.slice(0, 400)}` };
  },

  // Auto Dimension options: chain style with a ±0.1 tolerance on the plate (edge → hole → hole), then ordinate
  // style (values from the corner); texts on a row do not overlap, also with holes close together
  async 'auto-dimension-styles'() {
    const a = window.app;
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    a.newDocument(); await wait(200);
    const r = await a.macros.run(`const p = await rc.sketch('top', (s) => s.centerRect(0, 0, 120, 80));
await rc.extrude(p, 10);
const h = await rc.sketch('top', (s) => { for (const x of [-50, -44, 50]) s.circle(x, 30, 2); });
await rc.cut(h, 10);`, 'plate');
    if (!r.ok) return { ok: false, detail: r.error };
    const keep = a.ui.newDrawingSetup;
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'Styles', props: {}, sheet: null });
    try { await a.newDrawing(true); } finally { a.ui.newDrawingSetup = keep; }
    const ed = a.drawing;
    await until(() => ed.doc.views.length === 3 && ed.doc.views.every((v) => (ed.geos.get(v.id)?.edges?.length || 0) > 0), 60000, 250);
    const n1 = ed.autoDimension({ style: 'chain', tol: '±0.1', spread: true });
    const dims = ed.doc.anns.filter((x) => x.type === 'dim' && x.kind === 'linear');
    const vals = dims.map((x) => Math.round(D2.dimValue(ed.doc, x) * 1000) / 1000).sort((p, q) => p - q).join(',');
    const tolOk = dims.every((x) => D2.dimText(ed.doc, x).endsWith(' ±0.1'));
    // (texts on one row: no two overlap)
    const th = ed.doc.settings?.textH || 3.5;
    let overlap = 0;
    for (const v of ed.doc.views) for (const o of ['h', 'v']) {
      const rows = new Map();
      for (const x of dims.filter((d) => d.view === v.id && d.orient === o)) { const k = Math.round(x.pos[o === 'h' ? 1 : 0] * 1000); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(x); }
      for (const list of rows.values()) {
        const iv = list.map((x) => { const w = D2.textWidth(D2.dimText(ed.doc, x), th), c = x.pos[o === 'h' ? 0 : 1]; return [c - w / 2, c + w / 2]; }).sort((p, q) => p[0] - q[0]);
        for (let i = 1; i < iv.length; i++) if (iv[i][0] < iv[i - 1][1]) overlap++;
      }
    }
    ed.undo();
    const n2 = ed.autoDimension({ style: 'ordinate', tol: '', spread: true });
    const ords = ed.doc.anns.filter((x) => x.type === 'ordinate');
    // (the view with the holes: the most ordinate values)
    const top = [...ed.doc.views].sort((p, q) => ords.filter((x) => x.view === q.id).length - ords.filter((x) => x.view === p.id).length)[0];
    const xvals = ords.filter((x) => x.view === top?.id && x.axis === 'x').map((x) => Math.round(Math.abs(x.p[0] - x.o[0]) * 1000) / 1000).sort((p, q) => p - q).join(',');
    const ok = vals === '6,10,10,70,80,94,120' && tolOk && overlap === 0 && n1 === 8 && xvals === '0,10,16,110,120' && n2 > 8;
    return ok ? { ok: true, detail: `chain: ${vals} (±0.1), no overlaps; ordinate: x ${xvals}` }
      : { ok: false, detail: `chain ${n1}: ${vals}, tol ${tolOk}, overlaps ${overlap}; ordinate ${n2}: x ${xvals}` };
  },

  // Check Drawing: a new drawing of a plate with three Ø4 holes lists the empty title block fields, the views with no
  // dimensions and the sizes not dimensioned (overall sizes, 3× Ø4); a hole callout gives the diameter; after Auto
  // Dimension (chain style) and the title block filled in nothing is left to fix; a note whose view was deleted is
  // reported.
  async 'drawing-check'() {
    const a = window.app;
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    a.newDocument(); await wait(200);
    const r = await a.macros.run(`const p = await rc.sketch('top', (s) => s.centerRect(0, 0, 120, 80));
await rc.extrude(p, 10);
const h = await rc.sketch('top', (s) => { for (const x of [-50, -44, 50]) s.circle(x, 30, 2); });
await rc.cut(h, 10);`, 'plate');
    if (!r.ok) return { ok: false, detail: r.error };
    const keep = a.ui.newDrawingSetup;
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'Check', props: {}, sheet: null });
    try { await a.newDrawing(true); } finally { a.ui.newDrawingSetup = keep; }
    const ed = a.drawing;
    await until(() => ed.doc.views.length === 3 && ed.doc.views.every((v) => (ed.geos.get(v.id)?.edges?.length || 0) > 0), 60000, 250);
    for (const k of ['title', 'number', 'drawnBy', 'material']) ed.doc.props[k] = '';
    const texts = (res, lv) => res.items.filter((x) => !lv || x.level === lv).map((x) => x.text);
    const r1 = ed.checkDrawingDialog();
    const shown = document.querySelectorAll('.modal .dc-item').length;
    closeModals();
    const t1 = texts(r1);
    const tb = ['Title', 'Drawing No.', 'Drawn', 'Material'].every((l) => t1.includes(`${l} is empty`));
    const noDims = t1.filter((t) => / has no dimensions$/.test(t)).length;
    const hole = t1.find((t) => /hole Ø4 \(3× holes\) has no diameter/.test(t));
    const sizes = t1.filter((t) => /the overall (width|height) \((120|80|10)\)/.test(t)).length;
    // a hole callout for them
    const hv = ed.doc.views.find((v) => r1.items.some((x) => x.view === v.id && /hole Ø4/.test(x.text)));
    ed.doc.anns.push({ id: D2.newId(ed.doc, 'a'), type: 'note', sheet: hv.sheet, view: hv.id, leader: [0, 0], text: '3× Ø4 THRU ALL', h: 3.5, pos: [10, 10] });
    const r2 = checkDrawing(ed.doc, ed.geos);
    const calloutOk = !texts(r2).some((t) => /hole Ø4/.test(t));
    // (chain dimensions give the hole positions as well as baseline ones)
    ed.autoDimension({ style: 'chain' });
    Object.assign(ed.doc.props, { title: 'Plate', number: 'P-100', drawnBy: 'Test', material: 'Steel', date: '2026-10-21', revision: 'A', company: 'Co', finish: 'None', tolerance: 'ISO 2768-m' });
    const r3 = checkDrawing(ed.doc, ed.geos);
    const clean = !r3.items.some((x) => x.level !== 'info');
    ed.doc.anns.push({ id: D2.newId(ed.doc, 'a'), type: 'note', sheet: hv.sheet, view: 'gone', text: 'x', h: 3.5, pos: [0, 0] });
    const r4 = checkDrawing(ed.doc, ed.geos);
    const orphan = texts(r4, 'error').some((t) => /view that was deleted/.test(t));
    ed.doc.anns.pop();
    const covered = t1.filter((t) => / has no dimensions \(its sizes are given in other views\)$/.test(t)).length;
    const ok = tb && noDims === 2 && covered === 1 && !!hole && sizes >= 3 && shown === r1.items.length && calloutOk && clean && orphan;
    return ok ? { ok: true, detail: `${r1.items.length} found (${texts(r1, 'error').length} to fix); after the callout, Auto Dimension and the title block: ${r3.items.length} notes (${texts(r3).join('; ')})` }
      : { ok: false, detail: `tb ${tb}, noDims ${noDims}, hole ${hole}, sizes ${sizes}, shown ${shown}/${r1.items.length}, callout ${calloutOk}, clean ${clean} (${texts(r3).join('; ')}), orphan ${orphan}; first: ${t1.join(' | ')}` };
  },

  // accessibility: in an Extrude's Property panel every field has a name (its label and unit), the group headings
  // are buttons that say whether they are open and open / close with Enter, the icon buttons are named; Tab and Enter
  // on a panel button are left to it (no hiding, no OK); F6 goes round the panel, the ribbon and the view; a dialog
  // is named, takes the focus, keeps Tab inside and gives the focus back.
  async 'accessibility'() {
    const a = window.app, { focusRegion } = await import('/js/a11y.js');
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    a.newDocument(); await wait(200);
    const r = await a.macros.run(`await rc.sketch('top', (s) => s.centerRect(0, 0, 40, 20));`, 'a11y');
    if (!r.ok) return { ok: false, detail: r.error };
    const sk = a.doc.features.find((f) => f.type === 'sketch');
    a.selection = { kind: 'feature', id: sk.id };
    a.startFeature('extrude', 'add');
    await wait(400);
    const pm = document.querySelector('#pm');
    const name = (c) => c.getAttribute('aria-label') || (c.id && document.querySelector(`label[for="${c.id}"]`)?.textContent) || c.closest('label')?.textContent?.trim();
    const fields = [...pm.querySelectorAll('input, select, textarea')].filter((c) => c.getClientRects().length);
    const unnamed = fields.filter((c) => !name(c)).map((c) => c.outerHTML.slice(0, 60));
    const depth = fields.find((c) => /Depth/.test(c.getAttribute('aria-label') || ''));
    const heads = [...pm.querySelectorAll('.pm-gt')];
    const headsOk = heads.length > 0 && heads.every((h) => h.getAttribute('role') === 'button' && h.tabIndex === 0 && h.getAttribute('aria-expanded') === 'true');
    const icons = [...pm.querySelectorAll('.pm-actions button')];
    const iconsOk = icons.length >= 2 && icons.every((b) => b.getAttribute('aria-label'));
    // Enter on a heading: the group closes (not the panel's OK)
    const h = heads[0];
    h.focus();
    h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(50);
    const closedOk = h.closest('.pm-group').classList.contains('collapsed') && h.getAttribute('aria-expanded') === 'false' && a.pm?.kind === 'feature';
    h.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    await wait(50);
    // Tab and Enter on the OK button: the browser's (moves the focus / presses it), not the app's shortcuts
    const okBtn = icons[0];
    okBtn.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    okBtn.dispatchEvent(tab);
    const ent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    okBtn.dispatchEvent(ent);
    const keysOk = !tab.defaultPrevented && !ent.defaultPrevented && a.pm?.kind === 'feature';
    // F6 round the window (from nowhere in particular)
    document.activeElement?.blur();
    const stops = [focusRegion(1), focusRegion(1), focusRegion(1)].map((t) => (t?.closest('#pm') ? 'pm' : t?.closest('#cm-buttons') ? 'ribbon' : t?.id === 'c' ? 'view' : t?.closest('#tree') ? 'tree' : '?')).join(',');
    a.cancelPM();
    await wait(100);
    // a dialog
    const before = document.querySelector('#cm-buttons button');
    before.focus();
    const body = document.createElement('div');
    body.innerHTML = '<input type="text"><select><option>a</option></select>';
    const m = a.ui.modal('Some Dialog', 'equations', body, [{ label: 'OK', primary: true }, { label: 'Cancel' }]);
    await wait(50);
    const dlg = document.querySelector('.modal');
    const named = dlg.getAttribute('role') === 'dialog' && dlg.getAttribute('aria-label') === 'Some Dialog';
    const inside = dlg.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    const btns = [...dlg.querySelectorAll('button')].filter((b) => b.getClientRects().length);
    btns[btns.length - 1].focus();
    const t2 = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(t2);
    const wrapped = t2.defaultPrevented && dlg.contains(document.activeElement) && document.activeElement !== btns[btns.length - 1];
    m.close();
    await wait(50);
    const restored = document.activeElement === before;
    const live = document.querySelector('#status-msg').getAttribute('role') === 'status';
    const ok = !unnamed.length && !!depth && headsOk && iconsOk && closedOk && keysOk && stops === 'pm,ribbon,view' && named && inside && wrapped && restored && live;
    return ok ? { ok: true, detail: `${fields.length} fields named (e.g. "${depth.getAttribute('aria-label')}"), ${heads.length} headings, F6 ${stops}, dialog focus in / round / back` }
      : { ok: false, detail: `unnamed ${JSON.stringify(unnamed)}, depth ${!!depth}, heads ${headsOk}, icons ${iconsOk}, closed ${closedOk}, keys ${keysOk} (tab ${tab.defaultPrevented}, enter ${ent.defaultPrevented}, pm ${a.pm?.kind}), F6 ${stops}, dialog named ${named} inside ${inside} wrapped ${wrapped} restored ${restored}, live ${live}` };
  },

  // meshing only what changed: a plate with five holes (cut one after another), its last hole moved — the main
  // kernel meshes only the faces and edges that changed, keeping the rest; its mesh is exactly what a fresh kernel
  // makes of the changed part (every vertex, normal, triangle, face group and edge point)
  async 'incremental-mesh'() {
    const a = window.app, k = a.kernel;
    const d = M.newDoc(); d.name = 'Holes';
    const s0 = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
    const pts = [[-50, -30], [50, -30], [50, 30], [-50, 30]];
    Object.assign(s0, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
    d.features.push(s0, M.createFeature(d, 'extrude', { sketch: s0.id, depth: 12 }));
    for (const [i, x] of [-36, -18, 0, 18, 36].entries()) {
      const sk = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
      Object.assign(sk, { points: [{ id: 'q1', x, y: i % 2 ? 10 : -10 }], curves: [{ id: 'k1', type: 'circle', c: 'q1', r: 4 + i, construction: false }], constraints: [] });
      d.features.push(sk, M.createFeature(d, 'extrude', { sketch: sk.id, op: 'cut', end: 'through2' }));
    }
    await k.rebuild(JSON.parse(JSON.stringify(d)), null, null);
    const d2 = JSON.parse(JSON.stringify(d));
    const last = d2.features.filter((f) => f.type === 'sketch').pop();
    last.points[0].x = 40; last.rev = M.newRev();
    const inc = await k.rebuild(d2, null, null);
    const fresh = await a.kernelPool.request('rebuild', { doc: JSON.stringify({ ...d2, features: d2.features.map((f) => ({ ...f, rev: (f.rev || '') + '-fresh' })) }) });
    const A = inc.body, B = fresh.body;
    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    // (face ids are hash codes of where the kernel keeps each face: different in another kernel)
    const groups = JSON.stringify(A.faceGroups.map((g) => [g.start, g.count, g.surf?.t])) === JSON.stringify(B.faceGroups.map((g) => [g.start, g.count, g.surf?.t]));
    const edges = A.edges.length === B.edges.length && A.edges.every((e, i) => same(e.pts, B.edges[i].pts));
    const ok = same(A.vertices, B.vertices) && same(A.triangles, B.triangles) && same(A.normals, B.normals) && groups && edges && !inc.errors.length;
    return ok ? { ok: true, detail: `${A.faceGroups.length} faces, ${A.triangles.length / 3} triangles, ${A.edges.length} edges: the same as a fresh build (mesh ${inc.timing?.mesh} ms)` }
      : { ok: false, detail: `vertices ${A.vertices.length}/${B.vertices.length} same ${same(A.vertices, B.vertices)}, triangles ${A.triangles.length}/${B.triangles.length} same ${same(A.triangles, B.triangles)}, normals ${same(A.normals, B.normals)}, groups ${groups}, edges ${edges}, errors ${inc.errors.length}` };
  },

  // kernels by what the PC has: the budget from threads and free memory (a small, a mid-size and a big PC); each
  // open part keeps a kernel of its own, so switching back to a part needs no rebuild (every feature reused) and it
  // can build while another part is in front; a closed part's kernel is stopped; past the budget, a new part takes
  // the kernel of the part used longest ago
  async 'kernel-per-tab'() {
    const a = window.app, { kernelBudget } = await import('/js/machine.js');
    const budgets = [[{ threads: 4, freeMB: 3000 }, 2], [{ threads: 8, freeMB: 12000 }, 6], [{ threads: 8, freeMB: 5000 }, 2], [{ threads: 24, freeMB: 30000 }, 16], [{ threads: 16, freeMB: null, totalMB: 8192 }, 4]];
    const budgetOk = budgets.every(([m, n]) => kernelBudget(m) === n);
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    const keep = a.tabKernelMax;
    a.tabKernelMax = Math.max(2, keep);
    try {
      a.newDocument(); await wait(200);
      const r = await a.macros.run(`const p = await rc.sketch('top', (s) => s.centerRect(0, 0, 60, 40)); await rc.extrude(p, 10);
const h = await rc.sketch('top', (s) => { s.circle(-20, 0, 4); s.circle(20, 0, 4); }); await rc.cut(h, 10);`, 'tab A');
      if (!r.ok) return { ok: false, detail: r.error };
      const iA = a.tabIndex, kA = a.kernel, nA = a.doc.features.length;
      a.newDocument(); await wait(200);
      const iB = a.tabIndex, kB = a.kernel;
      await a.macros.run(`await rc.extrude(await rc.sketch('top', (s) => s.centerRect(0, 0, 10, 10)), 5);`, 'tab B');
      // back to A: its own kernel, which still holds it
      await a.activateTab(iA);
      while (a.kernel.busy || a.kernel.pending) await wait(20);
      // (kernel A still holds part A: rebuilt again, every feature is reused)
      const again = await kA.rebuild(JSON.parse(JSON.stringify(a.doc)), null, null);
      const back = a.kernel === kA && again.timing?.reused === nA;
      // B closed: its kernel stopped
      await a.activateTab(iB);
      a.dirty = false; // (closed without the Save question)
      await a.closeTab(iB);
      const stopped = kB.disposed === true && a.kernel === kA;
      // only one kernel for parts: a new part borrows A's, and A rebuilds when it comes back
      a.tabKernelMax = 1;
      if (a._spareKernel) { a._spareKernel.dispose(); a._spareKernel = null; }
      const before = a.liveKernels();
      a.newDocument(); await wait(200);
      // (no new kernel: one already running, given up by the part that had it)
      const lent = before.has(a.kernel) && !a.tabs.some((t, i) => i !== a.tabIndex && t.kernel === a.kernel);
      const ok = budgetOk && kA !== kB && back && stopped && lent;
      return ok ? { ok: true, detail: `budgets ${budgets.map(([m]) => kernelBudget(m)).join('/')}; A and B each their own kernel, back to A with all ${nA} features reused; B's kernel stopped; with one, lent` }
        : { ok: false, detail: `budget ${budgetOk} (${budgets.map(([m]) => kernelBudget(m)).join('/')}), own ${kA !== kB}, back ${back} (reused ${again?.timing?.reused}/${nA}), stopped ${stopped}, lent ${lent}` };
    } finally { a.tabKernelMax = keep; }
  },

  // cuts made together: a plate with a run of cuts (holes, a slot, a linear pattern of a hole, a hole feature at
  // sketch points), then a boss (which needs the body: the waiting cuts are made first) and one more cut. Built with
  // the cuts made together and one by one (another kernel): the same volume, area, faces and edges. Editing the last
  // cut makes only its own cut again (the others remembered); a cut feature's faces are still found (highlighting);
  // the section of a sketch drawn while cuts were waiting is the same.
  async 'cuts-together'() {
    const a = window.app, k = a.kernel, pool = a.kernelPool;
    const d = M.newDoc(); d.name = 'Cuts';
    const rect = (sk, x0, y0, x1, y1) => {
      const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], b = sk.points.length;
      sk.points.push(...pts.map(([x, y], i) => ({ id: 'p' + (b + i), x, y })));
      sk.curves.push(...pts.map((_, i) => ({ id: 'c' + (b + i), type: 'line', p1: 'p' + (b + i), p2: 'p' + (b + (i + 1) % 4), construction: false })));
    };
    const sketch = (fill) => { const sk = M.createFeature(d, 'sketch', { plane: { ref: 'top' } }); Object.assign(sk, { points: [], curves: [], constraints: [] }); fill(sk); d.features.push(sk); return sk; };
    const circle = (sk, x, y, r) => { const id = 'q' + sk.points.length; sk.points.push({ id, x, y }); sk.curves.push({ id: 'k' + sk.curves.length, type: 'circle', c: id, r, construction: false }); };
    const base = sketch((sk) => rect(sk, -50, -30, 50, 30));
    d.features.push(M.createFeature(d, 'extrude', { sketch: base.id, depth: 20 }));
    const cuts = [];
    for (const [i, x] of [-40, -25, -10, 5, 20].entries()) {
      const sk = sketch((s2) => circle(s2, x, i % 2 ? 12 : -12, 2.5 + i * 0.5));
      const c = M.createFeature(d, 'extrude', { sketch: sk.id, op: 'cut', end: 'through2' });
      d.features.push(c); cuts.push(c);
    }
    const slot = sketch((sk) => rect(sk, 30, -20, 45, -5));
    d.features.push(M.createFeature(d, 'extrude', { sketch: slot.id, op: 'cut', depth: 6, reverse: true }));
    d.features.push(M.createFeature(d, 'lpattern', { feature: cuts[0].id, dir1: 'x', dist1: 4, count1: 3, dir2: 'none' }));
    const hp = sketch((sk) => { sk.points.push({ id: 'h1', x: 35, y: 15 }, { id: 'h2', x: 42, y: 15 }); });
    d.features.push(M.createFeature(d, 'hole', { sketch: hp.id, holeType: 'simple', size: 'custom', diameter: 3, end: 'through' }));
    // (a boss: needs the body, so the cuts so far are made first)
    const bs = sketch((sk) => rect(sk, -10, -5, 10, 5));
    const bossSketch = bs;
    d.features.push(M.createFeature(d, 'extrude', { sketch: bs.id, depth: 30 }));
    const lastSk = sketch((sk) => circle(sk, 0, 0, 2));
    const last = M.createFeature(d, 'extrude', { sketch: lastSk.id, op: 'cut', end: 'through2' });
    d.features.push(last);
    const props = async (kern, r, aff) => {
      const out = [];
      for (const b of r.body.bodies) {
        const m = aff ? await pool.request('measure', { refs: [{ kind: 'body', id: b.id }] }, aff) : await kern.request('measure', { refs: [{ kind: 'body', id: b.id }] });
        const x = m.items?.[0] || m;
        out.push(`${x.volume.toFixed(4)}/${x.area.toFixed(4)}/${b.faceCount}/${b.edgeCount}`);
      }
      return out.join(' ');
    };
    const fresh = (doc) => { const c = JSON.parse(JSON.stringify(doc)); c.features[0].rev = M.newRev(); return c; };
    const dT = fresh(d);
    const together = await k.rebuild(JSON.parse(JSON.stringify(dT)), null, null);
    const t1 = await props(k, together);
    const made = together.timing.features.filter(([n]) => /made together/.test(n)).map(([n]) => +n.match(/\d+/)[0]);
    const one = await pool.request('rebuild', { doc: JSON.stringify(fresh(d)), batchCuts: false }, 'cuts-together');
    const t0 = await props(pool, one, 'cuts-together');
    const noneOneByOne = !one.timing.features.some(([n]) => /made together/.test(n));
    // the last cut edited: only its own cut made again
    const d2 = JSON.parse(JSON.stringify(dT)); d2.features.find((f) => f.id === lastSk.id).curves[0].r = 3; d2.features.find((f) => f.id === lastSk.id).rev = M.newRev();
    const e1 = await k.rebuild(d2, null, null);
    // (the cuts the edit really made: its own only, the others remembered; counted by the kernel, as timing entries
    // carried over from the saved state can't be told from new ones)
    const madeByEdit = e1.timing.cutsMade;
    const e0 = await pool.request('rebuild', { doc: JSON.stringify(fresh(d2)), batchCuts: false }, 'cuts-together');
    const same2 = (await props(k, e1)) === (await props(pool, e0, 'cuts-together'));
    // a cut feature's faces (highlighting), and a sketch's section, as one by one
    const ff1 = await k.request('featureFaces', { id: cuts[2].id });
    const sec1 = await k.request('sectionCurves', { sketchId: bossSketch.id }).catch((e) => ({ err: e.message }));
    await pool.request('rebuild', { doc: JSON.stringify(fresh(d2)), batchCuts: false }, 'cuts-together');
    const ff0 = await pool.request('featureFaces', { id: cuts[2].id }, 'cuts-together');
    const sec0 = await pool.request('sectionCurves', { sketchId: bossSketch.id }, 'cuts-together').catch((e) => ({ err: e.message }));
    const n = (x) => (Array.isArray(x) ? x.length : -1);
    const ok = t1 === t0 && made.length >= 2 && made.some((m) => m >= 5) && noneOneByOne && same2 && !together.errors.length
      && together.timing.cutsMade >= 3 && madeByEdit === 1 && n(ff1) > 0 && n(ff1) === n(ff0) && n(sec1) > 0 && n(sec1) === n(sec0);
    return ok ? { ok: true, detail: `made together: ${made.join(' + ')}; same as one by one (${t1}); edit: only its own cut; faces ${n(ff1)}, section ${n(sec1)}` }
      : { ok: false, detail: `together ${t1} | one by one ${t0}; made ${made}; oneByOne clean ${noneOneByOne}; edit same ${same2}, cuts made ${together.timing.cutsMade} then ${madeByEdit}; faces ${n(ff1)}/${n(ff0)}; section ${n(sec1)}/${n(sec0)} ${JSON.stringify(sec1).slice(0, 80)}; errors ${JSON.stringify(together.errors)}` };
  },

  // previews of cuts: a pattern of overlapping holes previewed, the material it removes (one intersection with all
  // its copies) is what the pattern really removes (the body with and without it); previewing the last cut after a
  // full rebuild takes the other waiting cuts from it (none made again)
  async 'preview-cuts'() {
    const pool = window.app.kernelPool, aff = 'preview-cuts';
    const d = M.newDoc(); d.name = 'Preview cuts';
    const sketch = (fill) => { const sk = M.createFeature(d, 'sketch', { plane: { ref: 'top' } }); Object.assign(sk, { points: [], curves: [], constraints: [] }); fill(sk); d.features.push(sk); return sk; };
    const circle = (sk, x, y, r) => { const id = 'q' + sk.points.length; sk.points.push({ id, x, y }); sk.curves.push({ id: 'k' + sk.curves.length, type: 'circle', c: id, r, construction: false }); };
    const base = sketch((sk) => {
      const pts = [[-50, -30], [50, -30], [50, 30], [-50, 30]];
      sk.points.push(...pts.map(([x, y], i) => ({ id: 'p' + i, x, y })));
      sk.curves.push(...pts.map((_, i) => ({ id: 'c' + i, type: 'line', p1: 'p' + i, p2: 'p' + ((i + 1) % 4), construction: false })));
    });
    d.features.push(M.createFeature(d, 'extrude', { sketch: base.id, depth: 20 }));
    const hole = M.createFeature(d, 'extrude', { sketch: sketch((sk) => circle(sk, -40, -12, 2.5)).id, op: 'cut', end: 'through2' });
    d.features.push(hole);
    const pat = M.createFeature(d, 'lpattern', { feature: hole.id, dir1: 'x', dist1: 4, count1: 4, dir2: 'none' });
    d.features.push(pat);
    const last = M.createFeature(d, 'extrude', { sketch: sketch((sk) => circle(sk, 20, 12, 3)).id, op: 'cut', end: 'through2' });
    d.features.push(last);
    const fresh = (doc) => { const c = JSON.parse(JSON.stringify(doc)); c.features[0].rev = M.newRev(); return c; };
    const build = (doc, previewId = null) => pool.request('rebuild', { doc: JSON.stringify(doc), previewId }, aff);
    const volume = async (r) => {
      const m = await pool.request('measure', { refs: [{ kind: 'body', id: r.body.bodies[0].id }] }, aff);
      return (m.items?.[0] || m).volume;
    };
    const mvol = (m) => {
      if (!m) return 0;
      const v = m.vertices, t = m.triangles; let s6 = 0;
      for (let i = 0; i < t.length; i += 3) {
        const a = 3 * t[i], b = 3 * t[i + 1], c = 3 * t[i + 2];
        s6 += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
      }
      return Math.abs(s6 / 6);
    };
    const dn = fresh(d); dn.features.find((f) => f.id === pat.id).suppressed = true;
    const without = await volume(await build(dn));
    const full = fresh(d);
    const withIt = await volume(await build(full));
    const removedReally = without - withIt;
    // (the last cut first: a preview keeps the saved states up to its feature only)
    const pl = await build(JSON.parse(JSON.stringify(full)), last.id);
    const pp = await build(JSON.parse(JSON.stringify(full)), pat.id);
    const shown = mvol(pp.preview?.remove);
    // (the copies overlap: counted once each they would show a third more)
    const near = Math.abs(shown - removedReally) / removedReally;
    const ok = removedReally > 100 && near < 0.03 && pp.preview && !pp.preview.missed && pl.preview?.remove && pl.timing.cutsMade === 0 && !pp.errors.length && !pl.errors.length;
    return ok ? { ok: true, detail: `pattern removes ${removedReally.toFixed(1)} mm³, its preview shows ${shown.toFixed(1)}; last cut previewed with no waiting cut made again` }
      : { ok: false, detail: `removed ${removedReally.toFixed(1)}, preview ${shown.toFixed(1)} (${(near * 100).toFixed(1)}%), missed ${pp.preview?.missed}; last preview ${!!pl.preview?.remove}, cuts made ${pl.timing.cutsMade}; errors ${JSON.stringify([...pp.errors, ...pl.errors])}` };
  },

  // a flat face's centre (kept in assembly mates) by the quicker plain integration: on these test parts the same as
  // the adaptive one to well under 1e-6 mm, and every coordinate the same to the 6 decimals mates keep, so mates
  // (and the components they hold) don't move
  async 'flat-face-centres'() {
    const pool = window.app.kernelPool, aff = 'flat-face-centres', out = [], bad = [];
    for (const name of ['plate-features', 'holes', 'sheet-metal', 'shell-box', 'frame-members', 'multibody-combine']) {
      const doc = JSON.parse(await (await fetch(`/tests/parts/${name}.rcad`)).text());
      await pool.request('rebuild', { doc: JSON.stringify(doc) }, aff);
      const c = await pool.request('centreCheck', {}, aff);
      out.push(`${name} ${c.faces}`);
      if (!(c.faces > 0) || c.worst > 1e-7 || c.roundDiff) bad.push(`${name}: ${c.faces} faces, worst ${c.worst}, ${c.roundDiff} differ at 6 decimals`);
    }
    return !bad.length ? { ok: true, detail: `flat faces the same centre to 1e-7 mm (6 decimals all the same): ${out.join(', ')}` } : { ok: false, detail: bad.join('; ') };
  },

  // the part's size for meshing, from quick face boxes and the precise box of only the faces that reach furthest:
  // exactly the box of every face's precise box, on parts with lofts and sweeps (B-spline faces), revolves (tori),
  // a thickened surface, several bodies and a dimple pattern
  async 'quick-part-box'() {
    const pool = window.app.kernelPool, aff = 'quick-part-box', out = [], bad = [];
    for (const name of ['sweep-loft', 'revolve-pattern', 'surface-thicken', 'multibody-combine', 'dimple-pattern']) {
      const doc = JSON.parse(await (await fetch(`/tests/parts/${name}.rcad`)).text());
      await pool.request('rebuild', { doc: JSON.stringify(doc) }, aff);
      const c = await pool.request('boxCheck', {}, aff);
      const same = c.quick.every((v, i) => v.every((x, k) => x === c.full[i][k]));
      out.push(`${name} ${c.precise}/${c.faces}`);
      if (!same) bad.push(`${name}: ${JSON.stringify(c.quick)} vs ${JSON.stringify(c.full)}`);
    }
    return !bad.length ? { ok: true, detail: `the same box to the last digit; precise boxes worked out (of the faces): ${out.join(', ')}` }
      : { ok: false, detail: bad.join('; ') };
  },

  // the browser version's store of models built: written and read back, each model's size kept apart (so letting
  // old ones go reads only the sizes), nothing read under another kernel; an assembly's parts are kept there too
  // (built once: opened again, none is built)
  async 'web-model-store'() {
    const a = window.app, P = (await import('/js/platform.js')).platform, was = window.RAZORCAD_WEB;
    const kernel = 'test-' + Math.random().toString(36).slice(2);
    let builds = 0;
    const pool = a.kernelPool, orig = pool.request;
    try {
      window.RAZORCAD_WEB = { ...(was || {}), kernel };
      const key = 'k' + kernel, data = 'x'.repeat(5000);
      const wrote = await P.writeModelCache(key, data);
      const back = await P.readModelCache(key);
      const db = await new Promise((r) => { const q = indexedDB.open('razorcad-models'); q.onsuccess = () => r(q.result); });
      const meta = await new Promise((r) => { const q = db.transaction('meta').objectStore('meta').get(key); q.onsuccess = () => r(q.result); });
      db.close();
      window.RAZORCAD_WEB = { ...(was || {}), kernel: kernel + 'b' };
      const other = await P.readModelCache(key);
      window.RAZORCAD_WEB = { ...(was || {}), kernel };
      // an assembly of one small part, opened twice
      const part = M.newDoc(); part.name = 'Store block';
      const sk = M.createFeature(part, 'sketch', { plane: { ref: 'top' } });
      const pts = [[0, 0], [30, 0], [30, 20], [0, 20]];
      Object.assign(sk, { points: pts.map(([x, y], i) => ({ id: 'p' + i, x, y })), curves: pts.map((_, i) => ({ id: 'c' + i, type: 'line', p1: 'p' + i, p2: 'p' + ((i + 1) % 4), construction: false })), constraints: [] });
      part.features.push(sk, M.createFeature(part, 'extrude', { sketch: sk.id, depth: 7 + Math.random() }));
      const asm = { kind: 'assembly', version: 1, name: 'Store test', nextId: 3, parts: [{ id: 'pt1', name: part.name, path: null, doc: part }], components: [{ id: 'c1', part: 'pt1', name: 'Store block<1>', config: null, pos: [0, 0, 0], rot: [0, 0, 0, 1], fixed: true, hidden: false }], mates: [], configs: [], explodes: [] };
      pool.request = (t, d, x) => { if (t === 'partMesh') builds++; return orig.call(pool, t, d, x); };
      const opens = [];
      for (let i = 0; i < 2; i++) {
        builds = 0;
        await a.openFromFile({ content: JSON.stringify(asm), name: 'Store test.rasm', path: null });
        const ed = a.tabs[a.tabIndex].drawing;
        for (let w = 0; w < 100 && !(ed.parts?.size && [...ed.parts.values()].every((x) => x.mesh)); w++) await new Promise((r) => setTimeout(r, 100));
        opens.push({ builds, shown: !!(ed.parts?.size && [...ed.parts.values()].every((x) => x.mesh)) });
        await new Promise((r) => setTimeout(r, 400)); // (the write)
        ed.dirty = false;
        await a.closeTab(a.tabIndex);
      }
      const ok = wrote === true && back === data && meta?.size === data.length && meta?.kernel === kernel && other === null
        && opens[0].builds === 1 && opens[0].shown && opens[1].builds === 0 && opens[1].shown;
      return ok ? { ok: true, detail: `written and read back (${meta.size} characters, size kept apart); none under another kernel; assembly: built once, then from the store` }
        : { ok: false, detail: `wrote ${wrote}, back ${back === data}, meta ${JSON.stringify(meta)?.slice(0, 80)}, other ${other === null ? 'null' : 'found'}; opens ${JSON.stringify(opens)}` };
    } finally { pool.request = orig; if (was === undefined) delete window.RAZORCAD_WEB; else window.RAZORCAD_WEB = was; }
  },

  // Convert to Sheet Metal, corners: the sheet-metal tray (closed corners, V cutout) written to STEP, read back
  // as a plain body and converted: its four corners known for RazorCAD's own and made again as it made them (the
  // relief, the curved V lines): the same faces and volume, nothing outside the body; converted again, the same part
  // again. Measuring the tray (its closed corners' B-spline faces): the exact volume, quickly (it took 16 s)
  async 'convert-developed'() {
    // Convert to Sheet Metal of shapes curved other than as plain bends: a cone wall (radius 50 to 80 over 60 high,
    // 2 thick about that line), half way round and all the way (a ring: cut open at a seam), written to STEP, read
    // back and converted from its biggest face with K 0.5 (the neutral layer is the line turned round): unrolled,
    // the flat is the cone's own area; a spherical cap (curved both ways) is refused
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient({ threads: threadsPerKernel() });
    const convert = async (d) => {
      const r0 = await k.rebuild(d, null, null);
      const b0 = r0.body?.bodies?.[0];
      if (!b0) throw new Error(`no body: ${JSON.stringify(r0.errors)}`);
      const step = new TextDecoder().decode(await k.exportBody('step', b0.id, { name: d.name }));
      const di = M.newDoc(); di.name = 'Converted';
      di.features.push(M.createFeature(di, 'import', { format: 'step', fileName: 'wall.step', data: step }));
      const r1 = await k.rebuild(di, null, null);
      const b1 = r1.body.bodies[0], V = r1.body.vertices, Nm = r1.body.normals, T = r1.body.triangles;
      // (its biggest face: a point on it and the normal there)
      let best = null;
      for (let i = b1.faceStart; i < b1.faceStart + b1.faceCount; i++) {
        const g = r1.body.faceGroups[i];
        let A = 0;
        for (let q = g.start; q < g.start + g.count; q += 3) {
          const [p, u, w] = [0, 1, 2].map((j) => [0, 1, 2].map((c) => V[3 * T[q + j] + c]));
          const a = u.map((x, c) => x - p[c]), b = w.map((x, c) => x - p[c]);
          A += Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]) / 2;
        }
        const v0 = T[g.start];
        if (!best || A > best.A) best = { A, p: [0, 1, 2].map((c) => V[3 * v0 + c]), n: [0, 1, 2].map((c) => Nm[3 * v0 + c]) };
      }
      const cf = M.createFeature(di, 'smConvert', { face: { p: best.p, n: best.n, body: b1.id }, kFactor: 0.5 });
      di.features.push(cf);
      const r2 = await k.rebuild(di, null, null);
      return { di, sheet: r2.body?.bodies?.find((b) => b.sheet)?.sheet, errors: (r2.errors || []).map((e) => e[1]) };
    };
    // a closed profile in the front plane turned round its vertical axis
    const turned = (name, pts, curves, angle) => {
      const d = M.newDoc(); d.name = name;
      const s = M.createFeature(d, 'sketch', { plane: { ref: 'front' } });
      Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves, constraints: [] });
      d.features.push(s, M.createFeature(d, 'revolve', { sketch: s.id, axis: 'v', angle }));
      return d;
    };
    const line = (id, a, b) => ({ id, type: 'line', p1: a, p2: b, construction: false });
    try {
      // the wall: the line (50, 0)–(80, 60), a rectangle 1 each side of it
      const L = Math.hypot(30, 60), n = [60 / L, -30 / L];
      const quad = [[50 - n[0], -n[1]], [50 + n[0], n[1]], [80 + n[0], 60 + n[1]], [80 - n[0], 60 - n[1]]];
      const sides = [line('c1', 'p1', 'p2'), line('c2', 'p2', 'p3'), line('c3', 'p3', 'p4'), line('c4', 'p4', 'p1')];
      const out = [], bad = [];
      for (const angle of [180, 360]) {
        const want = (Math.PI * (50 + 80) * L * angle) / 360;
        const a = await convert(turned(`Cone ${angle}`, quad, sides, angle));
        const dA = a.sheet ? (a.sheet.flatArea - want) / want : NaN;
        const name = angle === 360 ? 'a ring (cut at a seam)' : 'half a cone';
        if (a.sheet?.lofted === 'developed' && Math.abs(dA) < 5e-4) out.push(`${name}: ${a.sheet.flatArea.toFixed(1)} mm² for ${want.toFixed(1)} (${(100 * dA).toFixed(4)} %)`);
        else bad.push(`${name}: ${a.sheet ? `${a.sheet.lofted}, ${a.sheet.flatArea} for ${want}` : JSON.stringify(a.errors)}`);
        if (angle !== 180 || !a.sheet) continue;
        // a hole 10 across straight through the wall (half way up, along z): unrolled again, a hole in the flat
        const hs = M.createFeature(a.di, 'sketch', { plane: { ref: 'front' } });
        Object.assign(hs, { points: [{ id: 'h0', x: 0, y: 30 }, { id: 'h1', x: 5, y: 30 }], curves: [{ id: 'hc', type: 'circle', c: 'h0', r: 5, construction: false }], constraints: [] });
        a.di.features.push(hs, M.createFeature(a.di, 'extrude', { sketch: hs.id, op: 'cut', end: 'through2' }));
        const r3 = await k.rebuild(a.di, null, null);
        const sh = r3.body?.bodies?.find((b) => b.sheet)?.sheet, lost = sh ? a.sheet.flatArea - sh.flatArea : NaN;
        // (the hole's area on the wall: a circle of 5 seen on a wall leaning 1 in 2 from the axis, a little more)
        if (sh?.lofted === 'developed' && sh.pierces === a.sheet.pierces + 1 && lost > Math.PI * 25 && lost < Math.PI * 25 * 1.2) out.push(`a hole cut in it: in the flat too (${lost.toFixed(1)} mm² less)`);
        else bad.push(`hole: ${sh ? `${sh.lofted}, pierces ${a.sheet.pierces} → ${sh.pierces}, ${lost} mm² less` : ""} errors ${JSON.stringify(r3.errors)} faces ${r3.body?.bodies?.map((b) => b.faceCount)} notes ${JSON.stringify(r3.notes)}`);
      }
      // a spherical cap 2 thick (radius 50 to 52, from the top down to 40° off the axis): curved both ways
      const s40 = Math.sin((40 * Math.PI) / 180), c40 = Math.cos((40 * Math.PI) / 180);
      const cap = turned('Cap', [[0, 50], [0, 52], [52 * s40, 52 * c40], [50 * s40, 50 * c40], [0, 0]], [
        line('c1', 'p1', 'p2'), { id: 'a1', type: 'arc', c: 'p5', p1: 'p3', p2: 'p2', construction: false },
        line('c2', 'p3', 'p4'), { id: 'a2', type: 'arc', c: 'p5', p1: 'p4', p2: 'p1', construction: false },
      ], 360);
      let b;
      try { b = await convert(cap); } catch (e) { b = { errors: ['(cap) ' + e.message] }; }
      if (b.sheet || !b.errors.some((e) => /curved both ways/i.test(e))) bad.push(`spherical cap: ${b.sheet ? 'converted' : JSON.stringify(b.errors)}`);
      else out.push('a spherical cap refused (curved both ways)');
      return !bad.length ? { ok: true, detail: out.join('; ') } : { ok: false, detail: bad.join('; ') + (out.length ? ' | ' + out.join('; ') : '') };
    } finally { k.dispose(); }
  },

  async 'convert-closed-tube'() {
    // Convert to Sheet Metal of a closed tube (bends all the way round, no flat end: the ordinary way refuses it):
    // unrolled instead, cut open at a seam. A rounded rectangle 100 × 60 (corners R10), 2 thick about the profile,
    // 50 deep, converted from a flat side with K 0.5: the flat is (the profile's length) × 50
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient({ threads: threadsPerKernel() });
    try {
      const d = M.newDoc(); d.name = 'Tube';
      const s = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
      const P = [[-40, -30], [40, -30], [50, -20], [50, 20], [40, 30], [-40, 30], [-50, 20], [-50, -20]];
      const C = [[40, -20], [40, 20], [-40, 20], [-40, -20]];
      Object.assign(s, {
        points: [...P.map(([x, y], i) => ({ id: 'p' + i, x, y })), ...C.map(([x, y], i) => ({ id: 'c' + i, x, y }))],
        curves: [
          { id: 'l0', type: 'line', p1: 'p0', p2: 'p1' }, { id: 'a0', type: 'arc', c: 'c0', p1: 'p1', p2: 'p2' },
          { id: 'l1', type: 'line', p1: 'p2', p2: 'p3' }, { id: 'a1', type: 'arc', c: 'c1', p1: 'p3', p2: 'p4' },
          { id: 'l2', type: 'line', p1: 'p4', p2: 'p5' }, { id: 'a2', type: 'arc', c: 'c2', p1: 'p5', p2: 'p6' },
          { id: 'l3', type: 'line', p1: 'p6', p2: 'p7' }, { id: 'a3', type: 'arc', c: 'c3', p1: 'p7', p2: 'p0' },
        ].map((c) => ({ ...c, construction: false })),
        constraints: [],
      });
      d.features.push(s, M.createFeature(d, 'extrude', { sketch: s.id, depth: 50, thin: true, thinT: 2, thinDir: 'mid' }));
      const r0 = await k.rebuild(d, null, null);
      if (!r0.body?.bodies?.length) return { ok: false, detail: `no tube: ${JSON.stringify(r0.errors)}` };
      // (the outside of the long side at y = -31: a flat face)
      d.features.push(M.createFeature(d, 'smConvert', { face: { p: [0, 25, 31], n: [0, 0, 1], body: r0.body.bodies[0].id }, kFactor: 0.5 }));
      const r = await k.rebuild(d, null, null);
      const sh = r.body?.bodies?.find((b) => b.sheet)?.sheet;
      const want = (2 * 80 + 2 * 40 + 2 * Math.PI * 10) * 50, dA = sh ? (sh.flatArea - want) / want : NaN;
      const ok = sh?.lofted === 'developed' && Math.abs(dA) < 5e-4 && sh.pierces === 1;
      return ok ? { ok: true, detail: `unrolled and cut open: ${sh.flatArea.toFixed(1)} mm² for ${want.toFixed(1)} (${(100 * dA).toFixed(4)} %), one outline` }
        : { ok: false, detail: sh ? `${sh.lofted}, ${sh.flatArea} for ${want}, ${sh.pierces} outlines` : `not converted: ${JSON.stringify(r.errors)}` };
    } finally { k.dispose(); }
  },

  async 'convert-sheet-corners'() {
    // (the part's own kernel, with its threads)
    const k = window.app.kernel, pool = { request: (type, data) => k.request(type, data) }, aff = null;
    const tray = JSON.parse(await (await fetch('/tests/parts/sheet-metal-tray.rcad')).text());
    const step = async (r) => new TextDecoder().decode(await pool.request('export', { format: 'step', bodyId: r.body.bodies[0].id }, aff));
    const shape = (r) => {
      const b = r.body.bodies.find((x) => x.sheet) || r.body.bodies[0], V = r.body.vertices, T = r.body.triangles;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let k = b.triStart; k < b.triStart + b.triCount; k++) for (let j = 0; j < 3; j++) { const x = V[3 * T[k] + j]; min[j] = Math.min(min[j], x); max[j] = Math.max(max[j], x); }
      // (the volume from the mesh: the precise measure of these curved corners takes many seconds)
      let v6 = 0;
      for (let k = b.triStart; k < b.triStart + b.triCount; k += 3) {
        const [a, c, e] = [0, 1, 2].map((j) => 3 * T[k + j]);
        v6 += V[a] * (V[c + 1] * V[e + 2] - V[c + 2] * V[e + 1]) - V[a + 1] * (V[c] * V[e + 2] - V[c + 2] * V[e]) + V[a + 2] * (V[c] * V[e + 1] - V[c + 1] * V[e]);
      }
      return { id: b.id, faces: b.faceCount, min, max, sheet: b.sheet, volume: Math.abs(v6 / 6) };
    };
    // a STEP body converted from its base (the flat face at y = 0)
    const convert = async (text) => {
      const d = M.newDoc(); d.name = 'Converted';
      const imp = M.createFeature(d, 'import', { format: 'step', fileName: 'tray.step', data: text });
      d.features.push(imp);
      const r0 = await pool.request('rebuild', { doc: JSON.stringify(d) }, aff);
      const before = shape(r0), v0 = before.volume;
      const cf = M.createFeature(d, 'smConvert', { face: { p: [0, 0, 0], n: [0, -1, 0], body: before.id } });
      d.features.push(cf);
      const r = await pool.request('rebuild', { doc: JSON.stringify(d) }, aff);
      const after = shape(r);
      return { r, before, after, v0, v1: after.volume, corners: r.detected?.[cf.id]?.corners || 0 };
    };
    const inside = (a, b, tol) => a.min.every((x, k) => x >= b.min[k] - tol) && a.max.every((x, k) => x <= b.max[k] + tol);
    const r0 = await pool.request('rebuild', { doc: JSON.stringify(tray) }, aff);
    const tm = performance.now(), m0 = await pool.request('measure', { refs: [{ kind: 'body', id: r0.body.bodies[0].id }] }, aff);
    const measureMs = performance.now() - tm, v0 = (m0.items?.[0] || m0).volume;
    const c1 = await convert(await step(r0));
    const c2 = await convert(await step(c1.r));
    const same = (a, b) => a.min.every((x, k) => Math.abs(x - b.min[k]) < 1e-4) && a.max.every((x, k) => Math.abs(x - b.max[k]) < 1e-4);
    const ok = measureMs < 3000 && Math.abs(v0 - 23759.4208) < 1e-3 && !c1.r.errors.length && !c2.r.errors.length && c1.after.sheet && c2.after.sheet
      && inside(c1.after, c1.before, 1e-3) && Math.abs(c1.v1 - c1.v0) / c1.v0 < 1e-5 && c1.after.faces === c1.before.faces && c1.corners === 4 && c2.corners === 4
      && c2.after.faces === c2.before.faces && same(c2.after, c2.before) && Math.abs(c2.v1 - c2.v0) / c2.v0 < 1e-5;
    return ok ? { ok: true, detail: `tray measured in ${Math.round(measureMs)} ms (${v0.toFixed(4)} mm³); converted: its ${c1.corners} corners as RazorCAD made them, ${c1.before.faces} → ${c1.after.faces} faces, inside the body, volume ${(100 * (c1.v1 - c1.v0) / c1.v0).toFixed(6)} %; converted again: the same to ${Math.abs(c2.v1 - c2.v0).toExponential(1)} mm³` }
      : { ok: false, detail: `measure ${Math.round(measureMs)} ms, ${v0}; corners ${c1.corners} / ${c2.corners}; errors ${JSON.stringify([...c1.r.errors, ...c2.r.errors])}; first: faces ${c1.before.faces} → ${c1.after.faces}, ${JSON.stringify([c1.before.min, c1.before.max])} → ${JSON.stringify([c1.after.min, c1.after.max].map((v) => v.map((x) => +x.toFixed(4))))}, volume ${c1.v0} → ${c1.v1}; again: faces ${c2.before.faces} → ${c2.after.faces}, volume ${c2.v0} → ${c2.v1}` };
  },

  // BOM mass and cost: a steel plate (60 × 40 × 5) and two aluminium blocks (20 × 20 × 15) with costs → masses from
  // the materials, totals 0.126 kg and 18.50; the window's column menu changes a column; on the drawing table the
  // column under a point is found, and a typed value is edited
  async 'bom-mass-cost'() {
    const a = window.app;
    const box = (name, w, d, h, material, cost) => {
      const p = M.newDoc(); p.name = name; p.material = material; p.customProps = [{ name: 'Cost', value: cost }];
      const s = M.createFeature(p, 'sketch', { plane: { ref: 'top' } });
      const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
      Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
      p.features.push(s, M.createFeature(p, 'extrude', { sketch: s.id, depth: h }));
      return p;
    };
    a.newAssembly(); await wait(300); closeModals();
    const asm = a.drawing;
    const pp = asm.addPart(box('Plate', 60, 40, 5, 'steel', '12.50'), null, null), pb = asm.addPart(box('Block', 20, 20, 15, 'al6061', '$3'), null, null);
    await asm.addComponent(pp); await asm.addComponent(pb); await asm.addComponent(pb);
    await until(() => asm.doc.components.every((c) => asm.geo(c)?.mesh), 30000);
    const B = await import('/js/bom.js');
    const cols = [{ key: 'item', title: 'ITEM', w: 12 }, { key: 'name', title: 'PART', w: 30 }, { key: 'qty', title: 'QTY', w: 11 }, { key: 'mass', title: 'MASS', w: 18 }, { key: 'totalMass', title: 'TOTAL MASS', w: 22 }, { key: 'cost', title: 'COST', w: 16 }, { key: 'totalCost', title: 'TOTAL COST', w: 22 }];
    asm.begin(); asm.doc.bomCols = JSON.parse(JSON.stringify(cols)); asm.change();
    const rows = B.bomRows(asm.doc), totals = B.bomTotals(rows, cols);
    const massOk = Math.abs(rows.find((r) => r.name === 'Plate').mass - 0.0936) < 1e-6 && Math.abs(rows.find((r) => r.name === 'Block').mass - 0.0162) < 1e-6;
    asm.showBOM();
    const win = document.querySelector('.modal-back:last-child table.bom')?.innerText || '';
    // the column menu: the MASS column shows the material instead
    const c2 = JSON.parse(JSON.stringify(asm.bomCols()));
    const menu = B.bomColumnMenu(c2, 3, B.bomSources(B.bomPropNames(asm.doc), c2), () => { asm.begin(); asm.doc.bomCols = c2; asm.change(); }, async () => null);
    menu.find((x) => x !== 'sep' && x.label === 'Shows ▸ Material').action();
    closeModals();
    const changed = asm.doc.bomCols[3].key === 'material' && asm.doc.bomCols[3].title === 'MATERIAL';
    asm.undo();
    const undone = asm.doc.bomCols[3].key === 'mass';
    // the drawing table
    const keep = a.ui.newDrawingSetup;
    a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'BOM mass', props: {}, sheet: null });
    try { await a.newDrawing(true); } finally { a.ui.newDrawingSetup = keep; }
    const ed = a.drawing;
    ed.addBOM();
    const ann = ed.doc.anns.find((x) => x.type === 'bom');
    ann.cols = [...JSON.parse(JSON.stringify(cols)), { key: 'text', title: 'NOTE', w: 20, values: {} }];
    const O = D2.annPos(ed.doc, ann), th = (ed.doc.settings?.textH || 3.5) * 0.85;
    const hit = D2.bomHit(ed.doc, ann, [O[0] + 12 + 30 + 11 + 2, O[1] + th * 2.2 * 1.5]);
    const keepP = a.ui.promptText;
    a.ui.promptText = async () => 'paint';
    try { await ed.editBomValue(ann, 7, hit.r); } finally { a.ui.promptText = keepP; }
    const texts = D2.annPrims(ed.doc, ann, {}).filter((p) => p.t === 'text').map((p) => p.text);
    const ok = massOk && totals[4] === '0.126' && totals[6] === '18.50' && totals[0] === 'TOTAL' && win.includes('0.126') && win.includes('18.50') && changed && undone
      && hit.col === 3 && hit.row === 1 && texts.includes('TOTAL') && texts.includes('18.50') && texts.includes('paint');
    return ok ? { ok: true, detail: `plate ${rows[0].mass} kg, block ${rows[1].mass} kg; totals ${totals[4]} kg, ${totals[6]}; column menu + undo; drawing table: column ${hit.col}, typed value` }
      : { ok: false, detail: `mass ${massOk} (${rows.map((r) => r.mass)}), totals ${JSON.stringify(totals)}, window ${win.slice(0, 160)}, changed ${changed}, undone ${undone}, hit ${JSON.stringify({ col: hit.col, row: hit.row })}, texts ${texts.join('|')}` };
  },

  // Compare With: a 60 × 40 × 10 plate against the same plate 2 mm thicker with a Ø10 hole through it and its
  // extrude renamed → 2 features added, the extrude changed (depth, name); added 4800 − π·25·2, removed π·25·10
  async 'compare-versions'() {
    const a = window.app, C = await import('/js/compare.js');
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    a.newDocument(); await wait(200);
    await a.macros.run(`const p = await rc.sketch('top', (s) => s.centerRect(0, 0, 60, 40)); await rc.extrude(p, 10);`, 'v1');
    const v1 = JSON.parse(JSON.stringify(a.doc));
    await a.macros.run(`await rc.set('Extrude1', { depth: 12, name: 'Plate' }); const h = await rc.sketch('top', (s) => s.circle(0, 0, 5)); await rc.cut(h, 12, { end: 'through2' });`, 'v2');
    const d = C.compareDocs(v1, a.doc);
    const r = await C.showCompare(a, v1, 'version 1');
    const text = document.querySelector('.compare')?.innerText || '';
    closeModals(); a.viewport.setPreview(null);
    const near = (x, y) => Math.abs(x - y) < 1e-3 * Math.max(1, y);
    const ok = d.added.length === 2 && d.removed.length === 0 && d.changed.length === 1 && d.changed[0].keys.sort().join() === 'depth,name'
      && !!r && near(r.added, 4800 - Math.PI * 25 * 2) && near(r.removed, Math.PI * 25 * 10) && near(r.volumeA, 24000) && !!r.mesh.add && !!r.mesh.remove
      && text.includes('renamed from Extrude1') && text.includes('added');
    return ok ? { ok: true, detail: `2 added, Plate changed (depth, name); added ${r.added.toFixed(2)} mm³, removed ${r.removed.toFixed(2)} mm³` }
      : { ok: false, detail: `diff ${JSON.stringify({ add: d.added.length, rem: d.removed.length, ch: d.changed.map((x) => x.keys) })}, kernel ${JSON.stringify(r && { added: r.added, removed: r.removed, a: r.volumeA, b: r.volumeB })}, text ${text.slice(0, 200)}` };
  },

  // IGES import (tests/data, written by tests/make_iges.py): a box of six trimmed planes and a cylinder (NURBS side,
  // planes trimmed by circles) sewn into solids, and a B-rep tetrahedron, each with the volume it should have
  async 'iges-import'() {
    const a = window.app, I = await import('/js/igesstep.js'), k = a.kernel;
    const want = { 'box_trimmed.igs': 20 * 30 * 40, 'cyl_trimmed.igs': Math.PI * 100 * 30, 'tetra_brep.igs': 1000 / 6 };
    const out = [];
    let ok = true;
    for (const [name, v] of Object.entries(want)) {
      const text = await (await fetch('/tests/data/' + name)).text();
      const t = I.igesToStep(text);
      const d = M.newDoc(); d.name = name;
      d.features.push(M.createFeature(d, 'import', { format: 'step', fileName: name, data: t.step, name, sew: true }));
      const r = await k.rebuild(d, null, null);
      const bodies = r.body?.bodies || [];
      let vol = 0, kind = bodies.map((b) => b.kind).join(',');
      for (const b of bodies) { const m = await k.request('measure', { refs: [{ kind: 'body', id: b.id }] }); vol += (m.items?.[0] || m).volume || 0; }
      const good = !r.errors.length && bodies.length === 1 && kind === 'solid' && Math.abs(vol - v) < 1e-3 * v;
      ok &&= good;
      out.push(`${name}: ${t.faces} faces / ${t.solids} solids → ${kind || 'nothing'} ${vol.toFixed(2)} mm³${good ? '' : ` (expected ${v.toFixed(2)}; ${r.errors.map(([, m]) => m).join('; ')}; skipped ${JSON.stringify(t.skipped)})`}`);
    }
    // (and as File ▸ Open does it: a new part with the import, sewn)
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); }
    const box = await (await fetch('/tests/data/box_trimmed.igs')).text();
    await a.handleImport({ name: 'box_trimmed.igs', format: 'iges', data: box }, { asPart: true });
    const imp = a.doc.features.find((f) => f.type === 'import');
    const opened = !!imp?.sew && a.doc.name === 'box_trimmed' && (a.result.bodies || []).length === 1 && a.result.bodies[0].kind === 'solid';
    ok &&= opened;
    out.push(`opened as a part: ${opened}`);
    return { ok, detail: out.join(' | ') };
  },

  // a DXF with old-style (R12) polylines read back: RazorCAD's own flat pattern of the sheet-metal tray (its curved V
  // corners are written as POLYLINE … VERTEX … SEQEND): every outline curve is read, and they join into closed loops
  async 'dxf-r12-polylines'(parts) {
    const { KernelClient } = await import('/js/kernelclient.js'), { parseDXF, dxfShapes } = await import('/js/dxfimport.js');
    const { buildDXF, DEFAULT_MAPPING } = await import('/js/dxf.js');
    const k = new KernelClient();
    try {
      const r = await k.rebuild(JSON.parse(parts.find((p) => p.name === 'sheet-metal-tray').json), null, null);
      const f = await k.request('sheetFlat', { bodyId: r.body.bodies.find((b) => b.sheet).id });
      const text = buildDXF(f.ents.filter((e) => e.layer === 'OUTLINE' || e.layer === 'HOLES'), DEFAULT_MAPPING);
      const polylines = (text.match(/\nPOLYLINE\r?\n/g) || []).length;
      const shapes = dxfShapes(parseDXF(text));
      // (the pieces' ends: in a closed outline each end meets another piece's)
      const ends = [];
      for (const s of shapes) {
        const pts = s.line || (s.arc ? [0, 1].map((j) => { const a = ((j ? s.arc.a1 : s.arc.a0) * Math.PI) / 180; return [s.arc.c[0] + s.arc.r * Math.cos(a), s.arc.c[1] + s.arc.r * Math.sin(a)]; }) : null);
        if (pts) ends.push(pts[0], pts[pts.length - 1]);
      }
      const loose = ends.filter((p) => ends.filter((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6).length < 2).length;
      const ok = polylines > 0 && shapes.length > 0 && loose === 0;
      return ok ? { ok: true, detail: `${polylines} R12 polylines read: ${shapes.length} pieces, every end joined` } : { ok: false, detail: `${polylines} polylines, ${shapes.length} pieces, ${loose} loose ends` };
    } finally { k.dispose(); }
  },

  // DXF into a drawing: a small DXF (line, circle, arc, polyline with a bulge, text) placed on the sheet at full
  // size, drawn as lines / circles / curves / text; a big one is scaled down to a standard scale
  async 'dxf-into-drawing'() {
    const a = window.app, P = (await import('/js/platform.js')).platform;
    const ent = (type, codes) => `0\n${type}\n8\n0\n${codes.map(([c, v]) => `${c}\n${v}`).join('\n')}`;
    const dxf = (s) => `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${s.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
    const small = dxf([ent('LINE', [[10, 0], [20, 0], [11, 100], [21, 0]]), ent('CIRCLE', [[10, 50], [20, 30], [40, 10]]), ent('ARC', [[10, 50], [20, 30], [40, 20], [50, 0], [51, 90]]),
      ent('LWPOLYLINE', [[90, 3], [70, 0], [10, 0], [20, 60], [42, 1], [10, 20], [20, 60], [10, 20], [20, 80]]), ent('TEXT', [[10, 0], [20, 90], [40, 5], [1, 'PLATE 1'], [50, 0]])]);
    const big = dxf([ent('LINE', [[10, 0], [20, 0], [11, 3000], [21, 2000]])]);
    const keep = P.openDXF;
    let text = small;
    P.openDXF = async () => ({ name: 'plate.dxf', text });
    let ed, a1, a2;
    try {
      const k2 = a.ui.newDrawingSetup;
      a.ui.newDrawingSetup = async () => ({ template: BUILTIN_TEMPLATES.find((t) => t.id === 'builtin:A3L'), name: 'DXF', props: {}, sheet: null });
      try { await a.newDrawing(); } finally { a.ui.newDrawingSetup = k2; }
      ed = a.drawing;
      a1 = await ed.insertDXF();
      text = big;
      a2 = await ed.insertDXF();
    } finally { P.openDXF = keep; }
    const prims = D2.annPrims(ed.doc, a1, {});
    const kinds = prims.reduce((m, p) => ({ ...m, [p.t]: (m[p.t] || 0) + 1 }), {});
    const xs = prims.flatMap((p) => (p.t === 'line' ? [p.a[0], p.b[0]] : p.t === 'circle' ? [p.c[0] - p.r, p.c[0] + p.r] : p.pts ? p.pts.map((q) => q[0]) : [p.p[0]]));
    const width = Math.max(...xs) - Math.min(...xs);
    const ok = a1.scale === 1 && kinds.line === 2 && kinds.circle === 1 && kinds.poly === 2 && kinds.text === 1 && prims.find((p) => p.t === 'text').text === 'PLATE 1' && Math.abs(width - 100) < 1e-6
      && a2.scale > 0 && a2.scale < 0.2 && ed.doc.anns.filter((x) => x.type === 'dxf').length === 2;
    return ok ? { ok: true, detail: `placed at 1:1 (${JSON.stringify(kinds)}, 100 mm wide); 3000 mm line at 1:${1 / a2.scale}` }
      : { ok: false, detail: `scale ${a1?.scale}, kinds ${JSON.stringify(kinds)}, width ${width}, big scale ${a2?.scale}` };
  },

  // fillets: radius set at each vertex (R2 at one end of a cube's top edge, R6 at the other: the top face stops
  // about r short of the edge at each end); setback corners (three R4 fillets meeting, blended from 8 mm: one solid,
  // a new corner, about the same volume)
  async 'fillet-vertex-setback'() {
    const k = window.app.kernel;
    const cube = () => {
      const d = M.newDoc();
      const s = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
      const pts = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
      Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] });
      d.features.push(s, M.createFeature(d, 'extrude', { sketch: s.id, depth: 40 }));
      return d;
    };
    const volOf = async (r) => { const m = await k.request('measure', { refs: [{ kind: 'body', id: r.body.bodies[0].id }] }); return (m.items?.[0] || m).volume; };
    // 1. radius at each vertex
    const d1 = cube();
    d1.features.push(M.createFeature(d1, 'fillet', { filletType: 'variable', radiusMode: 'vertices', radius: 3, edges: [{ p: [0, 40, 20] }], vertexRadii: [{ p: [-20, 40, 20], r: 2 }, { p: [20, 40, 20], r: 6 }] }));
    const r1 = await k.rebuild(d1, null, null);
    const fid = d1.features[2].id, vs = r1.info?.[fid]?.vertices || [];
    const V = r1.body?.vertices || [];
    // (the top face's edge near each end: the largest z of the top face's points there)
    const topZ = (x0) => { let z = -Infinity; for (let i = 0; i < V.length; i += 3) if (Math.abs(V[i + 1] - 40) < 1e-4 && Math.abs(V[i] - x0) < 1e-3 && V[i + 2] < 19.999) z = Math.max(z, V[i + 2]); return z; };
    const zl = topZ(-20), zr = topZ(20);
    const v1 = r1.body?.bodies?.length ? await volOf(r1) : 0, want = 64000 - (1 - Math.PI / 4) * 40 * (4 + 12 + 36) / 3;
    const vertexOk = !r1.errors.length && vs.length === 2 && Math.abs(v1 - want) < 0.02 * (64000 - want) + 2 && Math.abs(zl - 18) < 0.05 && Math.abs(zr - 14) < 0.05;
    // 2. setback corners
    const corner = [{ p: [0, 40, 20] }, { p: [20, 40, 0] }, { p: [20, 20, 20] }];
    const d2 = cube(); d2.features.push(M.createFeature(d2, 'fillet', { radius: 4, edges: corner }));
    const d3 = cube(); d3.features.push(M.createFeature(d3, 'fillet', { radius: 4, edges: corner, setback: 8 }));
    // (measured straight after each build: the kernel measures what it built last)
    const r2 = await k.rebuild(d2, null, null), v2 = await volOf(r2);
    const r3 = await k.rebuild(d3, null, null), v3 = r3.body?.bodies?.length ? await volOf(r3) : 0;
    const b2 = r2.body.bodies[0], b3 = r3.body?.bodies?.[0];
    const setbackOk = !r3.errors.length && r3.body.bodies.length === 1 && b3.kind === 'solid' && Math.abs(v3 - v2) < 0.01 * v2 && Math.abs(v3 - v2) > 0.01 && /1 corner/.test(r3.notes?.[d3.features[2].id] || '');
    return vertexOk && setbackOk ? { ok: true, detail: `vertex radii: ${vs.length} vertices, volume ${v1.toFixed(1)} (≈ ${want.toFixed(1)}), top face ends at z ${zl.toFixed(2)} / ${zr.toFixed(2)}; setback: ${b2.faceCount} → ${b3.faceCount} faces, volume ${v2.toFixed(1)} → ${v3.toFixed(1)}` }
      : { ok: false, detail: `vertex: errors ${JSON.stringify(r1.errors)}, vertices ${JSON.stringify(vs)}, vol ${v1} vs ${want}, z ${zl} / ${zr}; setback: note ${JSON.stringify(r3.notes)}, errors ${JSON.stringify(r3.errors)}, bodies ${r3.body?.bodies?.length}, kind ${b3?.kind}, faces ${b2.faceCount}/${b3?.faceCount}, vol ${v2} / ${v3}` };
  },

  // curvature control: a 3D spline set to C2 has the same curvature on both sides of every point it runs through
  // (the C1 one jumps); an end weight of 2 doubles the first handle; a loft through three profiles builds with C2,
  // C1 and smoothing, with about the same volume
  async 'curvature-splines'() {
    const S3 = await import('/js/sketch3dmodel.js'), k = window.app.kernel;
    const f = { pts: [[0, 0, 0], [20, 15, 0], [40, -5, 10], [60, 20, 0], [80, 0, 5]].map(([x, y, z], i) => ({ id: 'p' + i, x, y, z })), segs: [], rels: [] };
    const seg = (extra) => ({ id: 's', type: 'spline', pts: f.pts.map((p) => p.id), ...extra });
    const jumps = (s) => { const q = S3.splineGeom(f, s).pieces; let m = 0; for (let i = 1; i < q.length; i++) m = Math.max(m, Math.abs(S3.bezierCurvature(q[i - 1], 1).k - S3.bezierCurvature(q[i], 0).k)); return m; };
    const j1 = jumps(seg({})), j2 = jumps(seg({ smooth: 'c2' }));
    const h = (s) => { const q = S3.splineGeom(f, s).pieces[0]; return Math.hypot(...[0, 1, 2].map((i) => q[1][i] - q[0][i])); };
    const wOk = Math.abs(h(seg({ w0: 2 })) - 2 * h(seg({}))) < 1e-9;
    // lofts
    const loftDoc = (opts) => {
      const d = M.newDoc(), add = (t, p) => { const x = M.createFeature(d, t, p); d.features.push(x); return x; };
      const sq = (plane, w) => { const s = M.createFeature(d, 'sketch', { plane: { ref: plane } }); const pts = [[-w, -w], [w, -w], [w, w], [-w, w]]; Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })), constraints: [] }); d.features.push(s); return s; };
      const p1 = add('plane', { refs: [{ kind: 'plane', id: 'top' }], offset: 20 }), p2 = add('plane', { refs: [{ kind: 'plane', id: 'top' }], offset: 40 });
      const a = sq('top', 20), b = sq(p1.id, 10), c = sq(p2.id, 20);
      add('loft', { profiles: [a.id, b.id, c.id], ...opts });
      return d;
    };
    const vols = [];
    let loftOk = true;
    for (const opts of [{}, { continuity: 'C1' }, { continuity: 'C1', smoothing: true }]) {
      const r = await k.rebuild(loftDoc(opts), null, null);
      const b = r.body?.bodies?.[0];
      if (r.errors.length || !b || b.kind !== 'solid') { loftOk = false; vols.push(`${JSON.stringify(opts)}: ${JSON.stringify(r.errors)}`); continue; }
      const m = await k.request('measure', { refs: [{ kind: 'body', id: b.id }] });
      vols.push((m.items?.[0] || m).volume);
    }
    loftOk &&= vols.every((v) => typeof v === 'number' && Math.abs(v - vols[0]) < 0.15 * vols[0]);
    const ok = j1 > 1e-4 && j2 < 1e-9 && wOk && loftOk;
    return ok ? { ok: true, detail: `curvature jump at the points: C1 ${j1.toExponential(2)}, C2 ${j2.toExponential(2)}; end weight ok; lofts ${vols.map((v) => Math.round(v)).join(' / ')} mm³` }
      : { ok: false, detail: `jumps C1 ${j1} C2 ${j2}, weight ${wOk}, lofts ${vols.join(' | ')}` };
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
    // Many open tabs must not widen the app after closing the notice (and move the model off screen on zoom).
    const bar = document.getElementById('doc-title'), tabs = [];
    let bounded = false;
    try {
      for (let i = 0; i < 40; i++) {
        const tab = bar.querySelector('.doctab').cloneNode(true);
        tab.querySelector('span').textContent = `Layout regression part ${i + 1}`;
        bar.appendChild(tab); tabs.push(tab);
      }
      const view = document.getElementById('viewport').getBoundingClientRect();
      bounded = document.documentElement.scrollWidth <= innerWidth + 1 && view.right <= innerWidth + 1;
    } finally { tabs.forEach((tab) => tab.remove()); }
    return fits && gone && bounded ? { ok: true, detail: 'fits the window; closes; many tabs keep the viewport within the window' }
      : { ok: false, detail: `fits ${fits}, gone ${gone}, viewport bounded with many tabs ${bounded}` };
  },

  // no browser right-click menu over RazorCAD (the browser version): a right-click on a panel, the status bar or the
  // view is kept from the browser; a text field keeps its menu (cut, copy, paste); RazorCAD's own menu on a feature
  // in the tree still opens
  // a point at the midpoint of an arc: half way round it (a quarter arc of R50 from 0° to 90°: at 45°), also after
  // the arc's end moves; and the relation is offered for a point and an arc
  async 'sketch-arc-midpoint'() {
    const S = await import('/js/sketchmodel.js'), { solveSketch } = await import('/js/solver.js');
    const sk = S.newSketchData();
    const c = S.addPoint(sk, 0, 0), a = S.addPoint(sk, 50, 0), b = S.addPoint(sk, 0, 50), m = S.addPoint(sk, 10, 5);
    const arc = S.addArc(sk, c, a, b);
    S.addRel(sk, 'fix', [c], { x: 0, y: 0 }); S.addRel(sk, 'fix', [a], { x: 50, y: 0 });
    const fixB = S.addRel(sk, 'fix', [b], { x: 0, y: 50 });
    S.addRel(sk, 'midpoint', [m, arc]);
    const r1 = solveSketch(sk, (x) => +x);
    const M1 = { ...S.getPoint(sk, m) }, want = 50 / Math.SQRT2;
    const at45 = Math.abs(M1.x - want) < 1e-6 && Math.abs(M1.y - want) < 1e-6;
    // the end moved to 180°: the midpoint follows to 90°
    Object.assign(fixB, { x: -50, y: 0 });
    const r2 = solveSketch(sk, (x) => +x);
    const M2 = S.getPoint(sk, m);
    const at90 = Math.abs(M2.x) < 1e-6 && Math.abs(M2.y - 50) < 1e-6;
    // offered in the sketcher for a point and an arc
    const sketcher = window.app.sketcher, keep = sketcher.selectedItems;
    sketcher.selectedItems = () => [{ kind: 'point', id: m }, { kind: 'arc', id: arc }];
    let offered;
    try { offered = sketcher.applicableRelations().includes('midpoint'); } finally { sketcher.selectedItems = keep; }
    const ok = r1.ok && r2.ok && at45 && at90 && offered;
    return ok ? { ok: true, detail: `at 45° (${M1.x.toFixed(4)}, ${M1.y.toFixed(4)}); the arc's end moved, at 90°; offered for a point and an arc` }
      : { ok: false, detail: `solved ${r1.ok}/${r2.ok}, (${M1.x}, ${M1.y}) then (${M2.x}, ${M2.y}), offered ${offered}` };
  },

  // sketch pattern along a curve: a small circle on an arc of radius 50, four copies 20 apart along it (turned with it):
  // each copy's centre on the arc, 20 further along; past an open curve's end no more copies; along a line: the copies
  // go its way (45°)
  async 'sketch-pattern-parametric'() {
    const S = await import('/js/sketchmodel.js'), V = await import('/js/solver.js');
    const sk = S.newSketchData();
    const origin = S.addPoint(sk, 0, 0), circle = S.addCircle(sk, origin, 2);
    const start = S.addPoint(sk, -10, 0), end = S.addPoint(sk, 100, 0), path = S.addLine(sk, start, end, true);
    const radius = S.addRel(sk, 'dim', [circle], { kind: 'radius', value: 2 });
    let count = 3;
    const ev = (x) => x === 'count' ? count : Number(x);
    const p = S.setSketchPattern(sk, { sources: [circle], path, n1: 'count', d1: '10' }, ev);
    const first = p.generated.curves[0], centre = () => S.getPoint(sk, S.getCurve(sk, first).c);
    if (p.made !== 2 || Math.abs(centre().x - 10) > 1e-6) return { ok: false, detail: 'Initial placement' };
    radius.value = 5;
    S.getPoint(sk, end).x = -10; S.getPoint(sk, end).y = 100;
    count = 5; p.d1 = '7';
    const r = V.solveSketch(sk, ev);
    if (!r.ok || r.bad.length || p.generated.curves.length !== 4 || p.generated.curves[0] !== first || Math.abs(S.getCurve(sk, first).r - 5) > 1e-6 || Math.abs(centre().y - 7) > 1e-6) return { ok: false, detail: 'Source dimension, path, expression count or spacing did not update' };
    count = 2; V.solveSketch(sk, ev);
    count = 5; V.solveSketch(sk, ev);
    if (p.generated.curves[0] !== first || p.made !== 4) return { ok: false, detail: 'IDs changed after resizing' };
    const reopened = JSON.parse(JSON.stringify(sk));
    const rr = V.solveSketch(reopened, ev);
    const a = window.app, doc = M.newDoc(), f = M.createFeature(doc, 'sketch', { plane: { ref: 'front' } });
    doc.equations = [{ name: 'count', expr: String(count) }];
    Object.assign(f, reopened); doc.features.push(f);
    const built = await a.kernel.rebuild(doc, null, null);
    const errors = [...built.errors];
    if (!rr.ok || errors.length) return { ok: false, detail: `Reopen / kernel rebuild: ${JSON.stringify(errors)}` };
    doc.equations[0].expr = '3';
    const resized = await a.kernel.rebuild(doc, null, null);
    if (resized.errors.length || resized.sketches[f.id]?.data.patterns[0].made !== 2) return { ok: false, detail: 'Changing the quantity equation did not rebuild the stored pattern' };
    S.deleteItems(sk, [circle]);
    return { ok: !sk.patterns.length && !sk.curves.some((c) => c.id === first), detail: 'Source dimension, path, quantity expression and spacing followed; stable IDs; save/reopen and kernel rebuild; source deletion removes copies' };
  },

  async 'sketch-pattern-curved-updates'() {
    const S = await import('/js/sketchmodel.js'), V = await import('/js/solver.js');
    const sk = S.newSketchData(), o = S.addPoint(sk, 0, 0), a = S.addPoint(sk, 50, 0), b = S.addPoint(sk, 0, 50);
    const path = S.addArc(sk, o, a, b, true), centre = S.addPoint(sk, 50, 0), circle = S.addCircle(sk, centre, 2);
    const end = S.addPoint(sk, 54, 0), line = S.addLine(sk, centre, end, true);
    const p = S.setSketchPattern(sk, { sources: [circle, line], path, n1: '6', d1: '20', turn: true });
    if (p.made !== 3) return { ok: false, detail: 'Open end did not limit instances' };
    const first = p.generated.curves[0];
    S.getPoint(sk, a).x = 100; S.getPoint(sk, b).y = 100;
    S.getPoint(sk, centre).x = 100; S.getPoint(sk, end).x = 106;
    const r = V.solveSketch(sk, Number);
    if (!r.ok || p.made !== 5 || p.generated.curves[0] !== first) return { ok: false, detail: 'Path length edit did not regenerate instances' };
    for (let i = 0; i < p.made; i++) {
      const c = S.getCurve(sk, p.generated.curves[i * 2]), l = S.getCurve(sk, p.generated.curves[i * 2 + 1]);
      const q = S.getPoint(sk, c.c), tip = S.getPoint(sk, l.p2), angle = 20 * (i + 1) / 100;
      if (!l.construction || Math.hypot(q.x - 100 * Math.cos(angle), q.y - 100 * Math.sin(angle)) > 0.01 || Math.hypot(tip.x - q.x - 6 * Math.cos(angle), tip.y - q.y - 6 * Math.sin(angle)) > 0.03) return { ok: false, detail: 'Circle / construction-line source or tangent rotation did not update' };
    }
    p.path = ''; p.a1 = '0'; p.n1 = '2'; p.n2 = '3'; p.d2 = '8'; p.a2 = '90';
    const two = V.solveSketch(sk, Number);
    if (!two.ok || p.made !== 5) return { ok: false, detail: 'Second direction failed' };
    const splineSketch = S.newSketchData(), handles = [[0, 0], [20, 0], [20, 30], [40, 30]].map(([x, y]) => S.addPoint(splineSketch, x, y));
    const spline = S.addCtrlSpline(splineSketch, handles, 3, true), seed = S.addPoint(splineSketch, 0, 0), seedCircle = S.addCircle(splineSketch, seed, 2);
    const sp = S.setSketchPattern(splineSketch, { sources: [seedCircle], path: spline, n1: '3', d1: '10', turn: true });
    const copy = sp.generated.curves[0], before = { ...S.getPoint(splineSketch, S.getCurve(splineSketch, copy).c) };
    S.getPoint(splineSketch, handles[1]).y = 30;
    const moved = V.solveSketch(splineSketch, Number), after = S.getPoint(splineSketch, S.getCurve(splineSketch, copy).c);
    return { ok: moved.ok && sp.generated.curves[0] === copy && Math.hypot(after.x - before.x, after.y - before.y) > 1, detail: 'Arc and spline path edits, source circle / construction line, rotation, open ends and two-direction pattern followed' };
  },

  async 'sketch-pattern-panel'() {
    const a = window.app, S = await import('/js/sketchmodel.js');
    await a.newDocument?.(); closeModals();
    const f = M.createFeature(a.doc, 'sketch', { plane: { ref: 'front' } });
    a.doc.features.push(f); a.commit(); await a.enterSketch(f, true); await wait(300);
    const sk = a.sketcher;
    const origin = S.addPoint(sk.f, 0, 0), circle = S.addCircle(sk.f, origin, 3);
    const start = S.addPoint(sk.f, 0, -10), end = S.addPoint(sk.f, 100, -10), path = S.addLine(sk.f, start, end, true);
    sk.changed(); sk.sel = new Set([circle]);
    const before = sk.snapshotData();
    sk.linearPatternSel();
    if (document.querySelector('.modal-back') || !document.querySelector('#pm [data-pattern="d1"]') || !sk.patternPreview) return { ok: false, detail: `Missing docked panel / preview: ${sk.patternError}; sources ${JSON.stringify(sk.patternDraft?.sources)}` };
    const pathInput = document.querySelector('#pm [data-pattern="path"]');
    pathInput.value = path; pathInput.dispatchEvent(new Event('change'));
    const spacing = document.querySelector('#pm [data-pattern="d1"]');
    spacing.value = '12'; spacing.dispatchEvent(new Event('input'));
    if (sk.snapshotData() !== before) return { ok: false, detail: 'Preview changed the actual sketch' };
    a.cancelPM();
    if (sk.patternDraft || sk.snapshotData() !== before || a.mode !== 'sketch') return { ok: false, detail: 'Cancel modified or exited the sketch' };
    sk.sel.clear(); sk.linearPatternSel();
    const v = viewEvents();
    const onCircle = sk.frame.o.clone().addScaledVector(sk.frame.u, 3);
    await v.click(...v.toScreen(onCircle));
    if (!sk.patternDraft.sources.includes(circle)) return { ok: false, detail: 'Source could not be picked after opening the command' };
    const pick = [...document.querySelectorAll('#pm button')].find((b) => b.textContent === 'Pick a line or curve'); pick.click();
    const world = sk.frame.o.clone().addScaledVector(sk.frame.u, 50).addScaledVector(sk.frame.v, -10);
    const pos = v.toScreen(world); await v.click(...pos);
    if (sk.patternDraft.path !== path) return { ok: false, detail: 'Path could not be picked after opening the command' };
    await a.okPM();
    const id = sk.f.patterns?.[0]?.id;
    if (!id || a.mode !== 'sketch') return { ok: false, detail: 'Accept did not create a persistent pattern' };
    sk.undo();
    if (sk.f.patterns?.length) return { ok: false, detail: 'Undo left a pattern behind' };
    sk.redo();
    if (sk.f.patterns?.[0]?.id !== id) return { ok: false, detail: 'Redo lost the pattern' };
    sk.sel.clear(); sk.linearPatternSel(id);
    const n = document.querySelector('#pm [data-pattern="n1"]'); n.value = '4'; n.dispatchEvent(new Event('input'));
    await a.okPM();
    const ok = sk.f.patterns.length === 1 && sk.f.patterns[0].made === 3;
    return { ok, detail: 'Docked preview, preselection and path picking, cancel/accept, undo/redo, edit quantity' };
  },

  async 'sketch-pattern-path'() {
    const S = await import('/js/sketchmodel.js');
    const bad = [], out = [];
    {
      const sk = S.newSketchData();
      const O = S.addPoint(sk, 0, 0), A = S.addPoint(sk, 50, 0), B = S.addPoint(sk, 0, 50);
      const arc = S.addArc(sk, O, A, B);
      const c0 = S.addPoint(sk, 50, 0), circ = S.addCircle(sk, c0, 2);
      const r = S.patternAlongCurve(sk, [circ], arc, { n: 4, d: 20, turn: true });
      const centres = r.ids.map((id) => S.getPoint(sk, S.getCurve(sk, id).c));
      const off = centres.map((q, k) => { const a = (20 * (k + 1)) / 50; return Math.hypot(q.x - 50 * Math.cos(a), q.y - 50 * Math.sin(a)); });
      const worst = Math.max(...off);
      if (r.made !== 3 || worst > 0.01) bad.push(`along the arc: ${r.made} copies, ${worst.toFixed(4)} mm off`); else out.push(`along the arc: 3 copies on it (within ${worst.toFixed(4)} mm)`);
      // (the arc is 78.5 long: 5 copies 20 apart only fit 3)
      const r2 = S.patternAlongCurve(sk, [circ], arc, { n: 6, d: 20 });
      if (r2.made !== 3) bad.push(`past the end: ${r2.made} copies (3 fit)`); else out.push('past its end: no more copies');
    }
    {
      const sk = S.newSketchData();
      const c0 = S.addPoint(sk, 0, 0), circ = S.addCircle(sk, c0, 2);
      const r = S.linearPattern(sk, [circ], { n1: 3, d1: 10, a1: 45 });
      const q = S.getPoint(sk, S.getCurve(sk, r[1]).c), e = Math.hypot(q.x - 20 * Math.SQRT1_2, q.y - 20 * Math.SQRT1_2);
      if (e > 1e-9) bad.push(`along 45°: ${e} off`); else out.push('along 45°: on the line');
    }
    return bad.length ? { ok: false, detail: bad.join('; ') } : { ok: true, detail: out.join('; ') };
  },

  // Sketch Fillet where a line meets an arc, and where two arcs meet: the fillet is tangent to both (its centre r from
  // the line, R ± r from each arc's centre), the curves are cut back to it, and the sketch still solves
  async 'sketch-fillet-arcs-click'() {
    const a = window.app, S = await import('/js/sketchmodel.js');
    await a.newDocument?.(); closeModals();
    const f = M.createFeature(a.doc, 'sketch', { plane: { ref: 'front' } });
    a.doc.features.push(f); a.commit(); await a.enterSketch(f, true); await wait(300);
    const sk = a.sketcher;
    const p = S.addPoint(sk.f, 0, 15), q = S.addPoint(sk.f, 0, 15);
    const c1 = S.addPoint(sk.f, -20, 0), c2 = S.addPoint(sk.f, 20, 0), end1 = S.addPoint(sk.f, 5, 0), end2 = S.addPoint(sk.f, -5, 0);
    S.addArc(sk.f, c1, end1, p); S.addArc(sk.f, c2, q, end2);
    S.addRel(sk.f, 'coincident', [p, q]); sk.changed();
    sk.filletR = 3; sk.setTool('sfillet');
    const v = viewEvents(), corner = sk.frame.o.clone().addScaledVector(sk.frame.v, 15);
    await v.click(...v.toScreen(corner));
    const count = () => sk.f.curves.filter((c) => c.type === 'arc').length;
    if (count() !== 3 || !sk.solveOk) return { ok: false, detail: 'Clicking coincident arc endpoints did not create a valid fillet' };
    sk.undo(); if (count() !== 2) return { ok: false, detail: 'Undo did not restore both arcs' };
    sk.redo(); if (count() !== 3 || !sk.solveOk) return { ok: false, detail: 'Redo did not restore the fillet' };
    return { ok: true, detail: 'Pointer click creates an R3 arc fillet; undo restores two arcs and redo restores the solved fillet' };
  },

  async 'sketch-fillet-coincident-arcs'() {
    const S = await import('/js/sketchmodel.js'), { solveSketch } = await import('/js/solver.js');
    for (const variant of ['coincident', 'chain', 'origin', 'construction']) {
      const sk = S.newSketchData(), y = variant === 'origin' ? -15 : 0;
      const p = variant === 'origin' ? 'O' : S.addPoint(sk, 0, y + 15), q = S.addPoint(sk, 0, y + 15);
      const c1 = S.addPoint(sk, -20, y), c2 = S.addPoint(sk, 20, y), a = S.addPoint(sk, 5, y), b = S.addPoint(sk, -5, y);
      const first = S.addArc(sk, c1, a, p), second = S.addArc(sk, c2, q, b);
      if (variant === 'chain') {
        const mid = S.addPoint(sk, 0, y + 15);
        S.addRel(sk, 'coincident', [p, mid]); S.addRel(sk, 'coincident', [mid, q]);
      } else S.addRel(sk, 'coincident', [p, q]);
      if (variant === 'construction') S.addLine(sk, p, S.addPoint(sk, 0, 40), true);
      const before = JSON.stringify(sk);
      let failed = false;
      try { S.blendCorner(sk, q, 1000); } catch { failed = true; }
      if (!failed || JSON.stringify(sk) !== before) return { ok: false, detail: `${variant}: a failed fillet changed the sketch` };
      const ids = S.blendCorner(sk, q, 3), fillet = S.getCurve(sk, ids[3]);
      const solution = solveSketch(sk, Number);
      if (!solution.ok || solution.bad.length || Math.abs(S.radiusOf(sk, fillet) - 3) > 1e-6) return { ok: false, detail: `${variant}: fillet did not solve at R3` };
      for (const id of [first, second]) {
        const c = S.getCurve(sk, id), shared = [c.p1, c.p2].find((q) => [fillet.p1, fillet.p2].includes(q));
        if (!shared) return { ok: false, detail: `${variant}: disconnected fillet` };
        const p = S.getPoint(sk, shared), a = S.getPoint(sk, c.c), b = S.getPoint(sk, fillet.c);
        const u = [p.x - a.x, p.y - a.y], v = [p.x - b.x, p.y - b.y];
        if (Math.abs(u[0] * v[1] - u[1] * v[0]) / (Math.hypot(...u) * Math.hypot(...v)) > 1e-6) return { ok: false, detail: `${variant}: fillet is not tangent` };
      }
    }
    return { ok: true, detail: 'Two arcs joined by Coincident, a coincidence chain, the origin and a construction-line corner; R3, shared ends, tangency and no mutation on failure' };
  },

  async 'sketch-fillet-arcs'() {
    const S = await import('/js/sketchmodel.js'), { solveSketch } = await import('/js/solver.js');
    const out = [], bad = [];
    const check = (name, sk, ids, curves) => {
      const r0 = solveSketch(sk, (x) => +x);
      const arc = S.getCurve(sk, ids[3]), O = S.getPoint(sk, arc.c), R = S.radiusOf(sk, arc);
      const fits = curves.map((c) => {
        const cc = S.getCurve(sk, c);
        if (cc.type === 'line') { const a = S.getPoint(sk, cc.p1), b = S.getPoint(sk, cc.p2), L = Math.hypot(b.x - a.x, b.y - a.y); return Math.abs(Math.abs((b.x - a.x) * (a.y - O.y) - (a.x - O.x) * (b.y - a.y)) / L - R); }
        const C = S.getPoint(sk, cc.c), Rc = S.radiusOf(sk, cc), d = Math.hypot(O.x - C.x, O.y - C.y);
        return Math.min(Math.abs(d - (Rc + R)), Math.abs(d - Math.abs(Rc - R)));
      });
      const worst = Math.max(...fits);
      if (!r0.ok || Math.abs(R - 3) > 1e-6 || worst > 1e-6) bad.push(`${name}: solved ${r0.ok}, radius ${R}, ${worst} off tangent`);
      else out.push(`${name}: R${+R.toFixed(6)}, tangent to both`);
    };
    // a line from the corner at 45°, and an arc (centre (20, 0)) from (20, 20) round to the corner
    {
      const sk = S.newSketchData();
      const P = S.addPoint(sk, 0, 0), A = S.addPoint(sk, 30, 30), E = S.addPoint(sk, 20, 20), C = S.addPoint(sk, 20, 0);
      const L = S.addLine(sk, P, A), K = S.addArc(sk, C, E, P);
      let ids;
      try { ids = S.blendCorner(sk, P, 3); } catch (e) { bad.push('line and arc: ' + e.message); }
      if (ids) check('line and arc', sk, ids, [L, K]);
    }
    // two arcs meeting at a corner: centres (-20, 0) and (20, 0), both through (0, 15)
    {
      const sk = S.newSketchData();
      const R = Math.hypot(20, 15);
      const P = S.addPoint(sk, 0, 15), C1 = S.addPoint(sk, -20, 0), C2 = S.addPoint(sk, 20, 0);
      const E1 = S.addPoint(sk, -20 + R, 0), E2 = S.addPoint(sk, 20 - R, 0);
      const K1 = S.addArc(sk, C1, E1, P), K2 = S.addArc(sk, C2, P, E2);
      let ids;
      try { ids = S.blendCorner(sk, P, 3); } catch (e) { bad.push('two arcs: ' + e.message); }
      if (ids) check('two arcs', sk, ids, [K1, K2]);
    }
    return bad.length ? { ok: false, detail: bad.join('; ') } : { ok: true, detail: out.join('; ') };
  },

  // Z up: a 100 × 60 × 10 plate on the Top plane of a part shown Z up is 10 high along Z in its STEP file; read back
  // into a part shown Y up it stands on edge (10 along Z), into one shown Z up it lies flat again (10 along RazorCAD's
  // Y); the panels speak the user's axes: the Top plane is XY, a Move's ΔY is RazorCAD's −ΔZ, a direction "Z axis" is
  // RazorCAD's Y, and the triad's Z points along RazorCAD's Y
  async 'up-axis-z'() {
    const a = window.app, W = await import('/js/wcs.js');
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient({ threads: threadsPerKernel() });
    const box = (r) => { const V = r.body.vertices, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < V.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], V[i + c]); hi[c] = Math.max(hi[c], V[i + c]); } return hi.map((x, c) => +(x - lo[c]).toFixed(3)); };
    const bad = [], out = [];
    try {
      const d = M.newDoc(); d.name = 'Plate'; d.upAxis = 'z';
      const sk = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
      const P = [[-50, -30], [50, -30], [50, 30], [-50, 30]];
      Object.assign(sk, { points: P.map(([x, y], i) => ({ id: 'p' + i, x, y })), curves: P.map((_, i) => ({ id: 'c' + i, type: 'line', p1: 'p' + i, p2: 'p' + ((i + 1) % 4), construction: false })), constraints: [] });
      d.features.push(sk, M.createFeature(d, 'extrude', { sketch: sk.id, depth: 10 }));
      const r = await k.rebuild(d, null, null);
      const own = box(r);
      const step = new TextDecoder().decode(await k.request('export', { format: 'step' }));
      const imp = async (up) => {
        const di = M.newDoc(); if (up === 'z') di.upAxis = 'z';
        di.features.push(M.createFeature(di, 'import', { format: 'step', fileName: 'plate.step', data: step, ...(up === 'z' ? { upAxis: 'z' } : {}) }));
        return box(await k.rebuild(di, null, null));
      };
      const intoY = await imp('y'), intoZ = await imp('z');
      if (own.join() !== '100,10,60' || intoY.join() !== '100,60,10' || intoZ.join() !== '100,10,60') bad.push(`boxes: own ${own}, into Y up ${intoY}, into Z up ${intoZ}`);
      else out.push('exported Z up and read back either way');
    } finally { k.dispose(); }
    // the panels
    await a.newDocument?.();
    closeModals();
    a.setUpAxis('z');
    const top = [...document.querySelectorAll('#tree .tn')].find((n) => n.dataset.fid === 'top')?.querySelector('.tsub')?.textContent;
    const mv = M.createFeature(a.doc, 'moveBody', {});
    a.doc.features.push(mv); a.commit();
    a.editFeature(mv.id); await wait(300);
    const row = [...document.querySelectorAll('#pm .pm-row')].find((x) => x.textContent.trim().startsWith('ΔY'));
    const inp = row?.querySelector('input');
    if (inp) { inp.value = '5'; inp.dispatchEvent(new Event('input')); inp.dispatchEvent(new Event('change')); }
    const f = a.pm?.feature;
    const moved = f && String(f.dz) === '-5' && Number(f.dy || 0) === 0;
    a.cancelPM();
    const zAxis = W.internalAxis('z'), yAxis = W.internalAxis('y'), tri = W.fromUser([0, 0, 1]);
    a.setUpAxis('y');
    // (and from the Origin's right-click menu in the tree)
    const originNode = () => [...document.querySelectorAll('#tree .tn')].find((n) => n.querySelector('.tl')?.textContent === 'Origin');
    originNode()?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 300 }));
    const items = [...document.querySelectorAll('#ctxmenu .mi')];
    items.find((x) => x.textContent.includes('Z up'))?.click();
    const viaMenu = a.doc.upAxis === 'z' && originNode()?.querySelector('.tsub')?.textContent === 'Z up';
    a.setUpAxis('y');
    const back = W.getUp();
    if (items.length !== 2 || !viaMenu) bad.push(`the Origin's menu: ${items.length} items, Z up from it ${viaMenu}`);
    if (top !== 'XY') bad.push(`Top plane shown as ${top}`);
    if (!moved) bad.push(`ΔY 5 stored as dy ${f?.dy}, dz ${f?.dz}`);
    if (zAxis !== 'y' || yAxis !== '-z' || tri.join() !== '0,1,0') bad.push(`axes: Z ${zAxis}, Y ${yAxis}, triad Z ${tri}`);
    if (back !== 'y') bad.push('not back to Y up');
    if (!bad.length) out.push('Top plane XY, ΔY kept as −ΔZ, Z axis is RazorCAD\'s Y; Z up from the Origin\'s right-click menu');
    return bad.length ? { ok: false, detail: bad.join('; ') } : { ok: true, detail: out.join('; ') };
  },

  // a control-point spline: the B-spline of its control points for degree 2 to 5 (against a plain de Boor
  // evaluation, to a hundred-thousandth of a mm); its control polygon is construction lines that take relations
  // (the first leg made horizontal); deleting the spline takes its polygon; a profile closed by a line extrudes to
  // the area under the curve
  async 'ctrl-spline'() {
    const S = await import('/js/sketchmodel.js'), { solveSketch } = await import('/js/solver.js');
    const Pc = [[0, 0], [15, 35], [45, 40], [70, 10], [95, 30], [120, 0]];
    // (a clamped B-spline with even knots, by de Boor)
    const deBoor = (P, p, u) => {
      const n = P.length, spans = n - p, U = [...Array(p + 1).fill(0), ...Array.from({ length: spans - 1 }, (_, i) => i + 1), ...Array(p + 1).fill(spans)];
      const x = Math.min(u, spans - 1e-12);
      let k = p; while (k < n - 1 && U[k + 1] <= x) k++;
      const d = Array.from({ length: p + 1 }, (_, j) => [...P[j + k - p]]);
      for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
        const i = j + k - p, a = (x - U[i]) / (U[i + p - r + 1] - U[i]);
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
      }
      return d[p];
    };
    const bad = [], out = [];
    // (degrees 6 and 7 need eight control points or more)
    const P9 = [[0, 0], [15, 35], [45, 40], [70, 10], [95, 30], [120, 0], [140, 25], [160, 45], [180, 5]];
    for (const deg of [2, 3, 4, 5, 6, 7]) {
      const Pd = deg > 5 ? P9 : Pc;
      const pcs = S.ctrlSplineBeziers(Pd, deg), pts = pcs.flatMap((g) => Array.from({ length: 21 }, (_, i) => S.bezierAt(g, i / 20)));
      const spans = Pd.length - deg;
      // (each curve point's distance to the de Boor curve: to the nearest of its finely divided pieces)
      const ref = Array.from({ length: 4001 }, (_, i) => deBoor(Pd, deg, (spans * i) / 4000));
      const segD = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-30, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2)); return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy); };
      let worst = 0;
      for (const q of pts) { let dmin = Infinity; for (let i = 1; i < ref.length; i++) dmin = Math.min(dmin, segD(q, ref[i - 1], ref[i])); worst = Math.max(worst, dmin); }
      const ends = Math.hypot(pts[0][0] - Pd[0][0], pts[0][1] - Pd[0][1]) + Math.hypot(pts[pts.length - 1][0] - Pd[Pd.length - 1][0], pts[pts.length - 1][1] - Pd[Pd.length - 1][1]);
      // (to a hundred-thousandth of a mm, and the reference's own chords)
      if (worst > 1e-4 || ends > 1e-9) bad.push(`degree ${deg}: ${worst.toFixed(6)} mm off, ends ${ends}`);
      else out.push(`degree ${deg}`);
    }
    // in a sketch: its polygon, a relation on it, a profile
    const sk = S.newSketchData();
    const ids = Pc.map(([x, y]) => S.addPoint(sk, x, y));
    const sp = S.addCtrlSpline(sk, ids, 3);
    const legs = sk.curves.filter((c) => c.ctrlOf === sp);
    const polyOk = legs.length === 5 && legs.every((c) => c.construction && c.type === 'line');
    S.addRel(sk, 'horizontal', [legs[0].id]);
    S.addRel(sk, 'fix', [ids[0]], { x: 0, y: 0 });
    const r = solveSketch(sk, (x) => +x);
    const legFlat = r.ok && Math.abs(S.getPoint(sk, ids[1]).y - S.getPoint(sk, ids[0]).y) < 1e-9;
    // the closing line, and the profile extruded 10: the area under the curve × 10
    S.addLine(sk, ids[5], ids[0]);
    const c = S.getCurve(sk, sp), q = S.curvePoints(sk, c);
    let A = 0;
    for (let i = 0; i < q.length; i++) { const u = q[i], v = q[(i + 1) % q.length]; A += u[0] * v[1] - v[0] * u[1]; }
    A = Math.abs(A / 2);
    const d = M.newDoc(); d.name = 'Spline profile';
    const f = M.createFeature(d, 'sketch', { plane: { ref: 'front' } });
    Object.assign(f, { points: sk.points, curves: sk.curves, constraints: sk.constraints, nextSid: sk.nextSid });
    d.features.push(f, M.createFeature(d, 'extrude', { sketch: f.id, depth: 10 }));
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient();
    let vol = null, errs = [];
    try {
      const rb = await k.rebuild(d, null, null);
      errs = rb.errors || [];
      if (rb.body?.bodies?.length) vol = ((await k.request('measure', { refs: [{ kind: 'body', id: rb.body.bodies[0].id }] })).items?.[0] || {}).volume;
    } finally { k.dispose(); }
    const volOk = vol != null && Math.abs(vol - A * 10) < 1e-3 * A * 10;
    // deleted: its polygon with it
    S.deleteItems(sk, [sp]);
    const polyGone = !sk.curves.some((x) => x.ctrlOf === sp);
    const ok = !bad.length && polyOk && legFlat && volOk && polyGone;
    return ok ? { ok: true, detail: `${out.join(', ')}: the B-spline of its control points; a polygon of 5 construction legs, the first made horizontal; extruded ${vol.toFixed(2)} mm³ (area ${A.toFixed(2)} × 10); deleted with its polygon` }
      : { ok: false, detail: `${bad.join('; ')}; polygon ${polyOk}, leg horizontal ${legFlat}, volume ${vol} for ${A * 10} (${JSON.stringify(errs)}), polygon gone ${polyGone}` };
  },

  // reference planes from more references: through an edge and a point; through two parallel edges; normal to an
  // edge at a distance along it; tangent to a cylinder (at an angle round it, and parallel to a plane, on either side);
  // and placed: moved along its normal, its axes turned, its normal reversed
  // reference planes from a sketch's entities: on the front plane a line along y (x 0, y 0 to 40) and a line along x
  // (y 10, x 30 to 60). Normal to the first line: its normal along y; through the first line and the second's end
  // point, and through both lines: the front plane (normal along z); the sketch changed (the first line's top end
  // moved to x 40): the normal plane turns with it
  async 'plane-sketch-refs'() {
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient();
    try {
      const d = M.newDoc(); d.name = 'Sketch refs';
      const sk = M.createFeature(d, 'sketch', { plane: { ref: 'front' } });
      Object.assign(sk, { points: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 40 }, { id: 'c', x: 30, y: 10 }, { id: 'e', x: 60, y: 10 }],
        curves: [{ id: 'l1', type: 'line', p1: 'a', p2: 'b', construction: false }, { id: 'l2', type: 'line', p1: 'c', p2: 'e', construction: false }], constraints: [] });
      d.features.push(sk);
      const ref = (o) => ({ kind: 'sketch', sketch: sk.id, ...o });
      const planes = { normal: { refs: [ref({ curve: 'l1' })] }, lineAndPoint: { refs: [ref({ curve: 'l1' }), ref({ point: 'c' })], through: true }, twoLines: { refs: [ref({ curve: 'l1' }), ref({ curve: 'l2' })] } };
      const ids = {};
      for (const [name, props] of Object.entries(planes)) { const pf = M.createFeature(d, 'plane', props); d.features.push(pf); ids[name] = pf.id; }
      const r = await k.rebuild(d, null, null);
      const n = (name, rr = r) => rr.planes?.[ids[name]]?.n;
      const along = (v, i) => v && Math.abs(Math.abs(v[i]) - 1) < 1e-9;
      const ok1 = !r.errors.length && along(n('normal'), 1) && along(n('lineAndPoint'), 2) && along(n('twoLines'), 2);
      // (the line's top end moved: the line now runs to (40, 40), its direction (1, 1)/√2)
      sk.points[1].x = 40;
      const r2 = await k.rebuild(d, null, null);
      const n2 = n('normal', r2), turned = n2 && Math.abs(Math.abs(n2[0]) - Math.SQRT1_2) < 1e-9 && Math.abs(Math.abs(n2[1]) - Math.SQRT1_2) < 1e-9;
      const f = (v) => (v ? v.map((x) => +x.toFixed(4)).join(', ') : 'none');
      return { ok: ok1 && turned, detail: `normal to the line (${f(n('normal'))}); through the line and the point (${f(n('lineAndPoint'))}); through both lines (${f(n('twoLines'))}); the line moved: (${f(n2)})${r.errors.length ? ' ' + JSON.stringify(r.errors) : ''}` };
    } finally { k.dispose(); }
  },

  async 'plane-more-types'() {
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient();
    const rect = (d, plane, w, h, depth) => {
      const s = M.createFeature(d, 'sketch', { plane: { ref: plane } });
      const P = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
      Object.assign(s, { points: P.map(([x, y], i) => ({ id: 'p' + i, x, y })), curves: P.map((_, i) => ({ id: 'c' + i, type: 'line', p1: 'p' + i, p2: 'p' + ((i + 1) % 4), construction: false })), constraints: [] });
      d.features.push(s, M.createFeature(d, 'extrude', { sketch: s.id, depth }));
    };
    try {
      // a 20 × 20 × 20 box on the front plane (x, y from -10 to 10, z from 0 to 20) and a cylinder R10 on the top
      // plane round the y axis, 30 high, beside it
      const d = M.newDoc(); d.name = 'Planes';
      rect(d, 'front', 20, 20, 20);
      const cs = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
      Object.assign(cs, { points: [{ id: 'q0', x: 50, y: 0 }], curves: [{ id: 'k0', type: 'circle', c: 'q0', r: 10, construction: false }], constraints: [] });
      d.features.push(cs, M.createFeature(d, 'extrude', { sketch: cs.id, depth: 30, merge: false }));
      const r0 = await k.rebuild(d, null, null);
      if (r0.errors?.length) return { ok: false, detail: 'setup: ' + JSON.stringify(r0.errors) };
      // the cylinder's axis: where is it? (the top plane's sketch x is the model's x; its y is the model's -z or z)
      const cyl = r0.body.bodies.find((b) => b.faceCount === 3) || r0.body.bodies[1];
      const V = r0.body.vertices, T = r0.body.triangles;
      // (its axis: the middle of its box)
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let q = cyl.triStart; q < cyl.triStart + cyl.triCount; q++) { const x = V[3 * T[q]], z = V[3 * T[q] + 2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const side = (x, y, z) => ({ kind: 'face', p: [x, y, z] });
      const planes = [
        ['lineAndPoint', { refs: [{ kind: 'edge', p: [0, 10, 20] }, { kind: 'vertex', p: [10, -10, 0] }], through: true }],
        ['twoLines', { refs: [{ kind: 'edge', p: [0, 10, 20] }, { kind: 'edge', p: [0, -10, 0] }] }],
        ['along', { refs: [{ kind: 'edge', p: [0, 10, 20] }], position: 'distance', along: 5 }],
        ['tangent0', { refs: [side(cx + 10, 15, cz)], around: 0 }],
        ['tangentFront', { refs: [side(cx + 10, 15, cz), { kind: 'plane', id: 'front' }] }],
        ['tangentFrontFlip', { refs: [side(cx + 10, 15, cz), { kind: 'plane', id: 'front' }], flip: true }],
        ['placed', { refs: [{ kind: 'plane', id: 'front' }, { kind: 'edge', p: [0, 10, 20] }], angle: 0, moveBy: 5, turn: 90, reverse: true }],
      ];
      const fids = {};
      for (const [name, props] of planes) { const pf = M.createFeature(d, 'plane', props); d.features.push(pf); fids[name] = pf.id; }
      const r = await k.rebuild(d, null, null);
      const P = (name) => r.planes?.[fids[name]];
      const near = (a, b, t = 1e-6) => a && b && a.every((x, i) => Math.abs(x - b[i]) < t);
      const dist = (fr, q) => (fr.n[0] * (q[0] - fr.o[0]) + fr.n[1] * (q[1] - fr.o[1]) + fr.n[2] * (q[2] - fr.o[2]));
      const errs = (r.errors || []).map((e) => `${Object.entries(fids).find(([, v]) => v === e[0])?.[0]}: ${e[1]}`);
      const checks = {
        // the plane holds the edge (y 10, z 20, along x) and the vertex (10, -10, 0)
        lineAndPoint: P('lineAndPoint') && [[-10, 10, 20], [10, 10, 20], [10, -10, 0]].every((q) => Math.abs(dist(P('lineAndPoint'), q)) < 1e-6),
        // both edges (y 10, z 20 and y -10, z 0, along x): the diagonal plane
        twoLines: P('twoLines') && [[-10, 10, 20], [10, 10, 20], [-10, -10, 0], [10, -10, 0]].every((q) => Math.abs(dist(P('twoLines'), q)) < 1e-6),
        // normal to the edge (along x), 5 from its start (an end at x = -10 or 10)
        along: P('along') && Math.abs(Math.abs(P('along').n[0]) - 1) < 1e-9 && Math.abs(Math.abs(P('along').o[0]) - 5) < 1e-6,
        // tangent to the cylinder (axis along y at (cx, cz), R10): at 0°, 10 from the axis along x
        // (the axis found from the cylinder's mesh: to a hundredth of a mm)
        tangent0: P('tangent0') && Math.abs(P('tangent0').n[1]) < 1e-9 && Math.abs(Math.abs(dist(P('tangent0'), [cx, 15, cz])) - 10) < 0.02,
        // parallel to the front plane: normal along z, 10 from the axis, the two sides 20 apart
        tangentFront: P('tangentFront') && Math.abs(Math.abs(P('tangentFront').n[2]) - 1) < 1e-9 && Math.abs(Math.abs(dist(P('tangentFront'), [cx, 15, cz])) - 10) < 0.02
          && P('tangentFrontFlip') && Math.abs(P('tangentFront').o[2] - P('tangentFrontFlip').o[2]) > 19.99,
        // at 0° to the front plane through the edge (z 20): moved 5 along its normal, axes turned 90°, normal reversed
        placed: P('placed') && Math.abs(Math.abs(P('placed').o[2] - 20) - 5) < 1e-6 && P('placed').n[2] * 1 < 0.999,
      };
      const ok = !errs.length && Object.values(checks).every(Boolean);
      return ok ? { ok: true, detail: `planes ${Object.keys(checks).join(', ')}: as they should be` } : { ok: false, detail: `${JSON.stringify(checks)} ${errs.join('; ')} tangent0 ${JSON.stringify(P('tangent0'))} axis ${cx}, ${cz}` };
    } finally { k.dispose(); }
  },

  // a loft with guide curves: two squares 40 × 40, 100 apart; a guide (an arc in the front plane from the middle of
  // one side of the bottom square, out to x = 40 half way up, to the same side of the top one) pulls that side out
  // (without it the loft is a straight block, x to 20); with a second guide on the other side, both sides bulge
  // control-point splines, more: closed (periodic) for degree 2 to 5 against a plain de Boor evaluation, smooth where
  // it comes round, extruded to the area inside it; weighted, degree 2 with ½√2 on the middle of three square
  // corners an exact quarter circle; a spline through points converted runs through the same points (ends kept);
  // control points inserted and removed keep the polygon whole and the weights in step
  async 'ctrl-spline-more'() {
    const S = await import('/js/sketchmodel.js');
    const bad = [], out = [];
    const segD = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-30, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2)); return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy); };
    const polyD = (q, R) => { let d = Infinity; for (let i = 1; i < R.length; i++) d = Math.min(d, segD(q, R[i - 1], R[i])); return d; };
    const sample = (pcs, k = 20) => pcs.flatMap((g) => Array.from({ length: k + 1 }, (_, i) => S.bezierAt(g, i / k)));
    // 1. closed: a periodic B-spline (the points wrapped round, knots 0, 1, 2 …), by de Boor
    const Pc = [[0, 0], [40, -10], [80, 5], [90, 45], [50, 60], [5, 40]];
    const periodic = (P, p, u) => {
      const n = P.length, Q = [...P, ...P.slice(0, p)], U = Array.from({ length: n + 2 * p + 1 }, (_, i) => i);
      const x = Math.min(u, n + p - 1e-12);
      const k = Math.floor(x);
      const d = Array.from({ length: p + 1 }, (_, j) => [...Q[j + k - p]]);
      for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
        const i = j + k - p, a = (x - U[i]) / (U[i + p - r + 1] - U[i]);
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
      }
      return d[p];
    };
    for (const deg of [2, 3, 4, 5]) {
      const pcs = S.ctrlSplineBeziers(Pc, deg, true), pts = sample(pcs);
      const ref = Array.from({ length: 4001 }, (_, i) => periodic(Pc, deg, deg + (Pc.length * i) / 4000));
      let worst = 0;
      for (const q of pts) worst = Math.max(worst, polyD(q, ref));
      // (it comes round: the last piece ends where the first starts, in the same direction)
      const g0 = pcs[0], g1 = pcs[pcs.length - 1];
      const gap = Math.hypot(g0.a[0] - g1.b[0], g0.a[1] - g1.b[1]);
      const t0 = Math.atan2(g0.c1[1] - g0.a[1], g0.c1[0] - g0.a[0]), t1 = Math.atan2(g1.b[1] - g1.c2[1], g1.b[0] - g1.c2[0]);
      const kink = Math.abs(Math.atan2(Math.sin(t0 - t1), Math.cos(t0 - t1)));
      if (worst > 1e-4 || gap > 1e-9 || kink > 1e-6) bad.push(`closed degree ${deg}: ${worst.toFixed(6)} mm off, gap ${gap}, kink ${kink}`);
      else out.push(`closed degree ${deg}`);
    }
    // ... in a sketch, extruded: the area inside it × 10
    const sk = S.newSketchData();
    const ids = Pc.map(([x, y]) => S.addPoint(sk, x, y));
    const sp = S.addCtrlSpline(sk, ids, 3, false, true);
    const legs = sk.curves.filter((c) => c.ctrlOf === sp).length;
    const q = S.curvePoints(sk, S.getCurve(sk, sp));
    let A = 0;
    for (let i = 0; i < q.length; i++) { const u = q[i], v = q[(i + 1) % q.length]; A += u[0] * v[1] - v[0] * u[1]; }
    A = Math.abs(A / 2);
    const d = M.newDoc(); d.name = 'Closed spline';
    const f = M.createFeature(d, 'sketch', { plane: { ref: 'front' } });
    Object.assign(f, { points: sk.points, curves: sk.curves, constraints: sk.constraints, nextSid: sk.nextSid });
    d.features.push(f, M.createFeature(d, 'extrude', { sketch: f.id, depth: 10 }));
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient();
    let vol = null;
    try {
      const rb = await k.rebuild(d, null, null);
      if (rb.body?.bodies?.length) vol = ((await k.request('measure', { refs: [{ kind: 'body', id: rb.body.bodies[0].id }] })).items?.[0] || {}).volume;
      else bad.push(`closed: not extruded ${JSON.stringify(rb.errors)}`);
    } finally { k.dispose(); }
    if (legs !== 6) bad.push(`closed: ${legs} polygon legs (6 wanted)`);
    if (vol != null && Math.abs(vol - A * 10) > 1e-3 * A * 10) bad.push(`closed: volume ${vol} (area ${A} × 10)`);
    // 2. weighted: a quarter circle of radius 10
    const arc = S.ctrlSplineBeziers([[10, 0], [10, 10], [0, 10]], 2, false, [1, Math.SQRT1_2, 1]);
    const rr = sample(arc, 50).map(([x, y]) => Math.hypot(x, y));
    const rOff = Math.max(...rr.map((r) => Math.abs(r - 10)));
    if (rOff > 2e-5) bad.push(`weighted: radius off by ${rOff}`); else out.push(`weighted quarter circle (radius within ${rOff.toExponential(1)} mm)`);
    // 3. converted: through the same points, open (ends kept) and closed
    for (const closed of [false, true]) {
      const s2 = S.newSketchData();
      const Q = [[0, 0], [20, 15], [45, 10], [60, 30], [80, 20]];
      const qi = Q.map(([x, y]) => S.addPoint(s2, x, y));
      const cid = S.addSpline(s2, qi, closed);
      S.convertToCtrlSpline(s2, S.getCurve(s2, cid));
      const c = S.getCurve(s2, cid);
      const R = sample(S.splinePieces(s2, c), 4000);
      const off = Math.max(...Q.map((p) => polyD(p, R)));
      const endsKept = closed || (c.pts[0] === qi[0] && c.pts[c.pts.length - 1] === qi[4]);
      const legsC = s2.curves.filter((x) => x.ctrlOf === cid).length;
      if (!c.ctrl || off > 1e-4 || !endsKept || legsC !== (closed ? 5 : 4)) bad.push(`converted ${closed ? 'closed' : 'open'}: ctrl ${c.ctrl}, ${off.toFixed(6)} mm from its points, ends kept ${endsKept}, ${legsC} legs`);
      else out.push(`converted ${closed ? 'closed' : 'open'} (through its points to ${off.toExponential(1)} mm)`);
    }
    // 4. inserted and removed: the polygon whole, the weights in step
    const s3 = S.newSketchData();
    const p3 = [[0, 0], [10, 10], [20, 0], [30, 10]].map(([x, y]) => S.addPoint(s3, x, y));
    const c3 = S.getCurve(s3, S.addCtrlSpline(s3, p3, 3, false, false, [1, 2, 1, 1]));
    const ni = S.insertCtrlPoint(s3, c3, 1);
    const afterIns = c3.pts.length === 5 && c3.pts[2] === ni && c3.weights.join() === '1,2,1,1,1' && s3.curves.filter((x) => x.ctrlOf === c3.id).length === 4;
    S.removeCtrlPoint(s3, c3, p3[1]);
    const legs3 = s3.curves.filter((x) => x.ctrlOf === c3.id);
    const joined = legs3.some((l) => (l.p1 === p3[0] && l.p2 === ni) || (l.p1 === ni && l.p2 === p3[0]));
    const afterRem = c3.pts.length === 4 && !c3.weights && legs3.length === 3 && joined && !s3.points.some((p) => p.id === p3[1]);
    if (!afterIns || !afterRem) bad.push(`insert / remove: after insert ${afterIns} (${c3.pts.length} points), after remove ${afterRem} (${legs3.length} legs, joined ${joined}, weights ${c3.weights})`);
    else out.push('a control point inserted and removed');
    return bad.length ? { ok: false, detail: bad.join('; ') } : { ok: true, detail: `${out.join(', ')}; closed extruded ${vol.toFixed(2)} mm³ (area ${A.toFixed(2)} × 10)` };
  },

  // Convert to Sheet Metal, a flange flush against the material beside it (no relief): a 2 mm plate with a window,
  // a flange standing up off one edge of the window with its ends flush against the window's sides (as real parts
  // drawn elsewhere often are). It converts (ripped at the flange's ends, as it is made): one bend, the flat the
  // plate's size with the flange laid into the window, and folded it is the body again
  async 'convert-flush-flange'() {
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient({ threads: threadsPerKernel() });
    try {
      // fx: the flange's half width (30: flush with the window's sides; 29: a 1 mm relief at each end, to compare)
      const build = async (fx) => {
        const d = M.newDoc(); d.name = 'Flush flange';
        const rect = (sk, x0, y0, x1, y1) => {
          const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], b = sk.points.length;
          sk.points.push(...pts.map(([x, y], i) => ({ id: 'p' + (b + i), x, y })));
          sk.curves.push(...pts.map((_, i) => ({ id: 'c' + (b + i), type: 'line', p1: 'p' + (b + i), p2: 'p' + (b + (i + 1) % 4), construction: false })));
        };
        const sketch = (x0, y0, x1, y1) => { const sk = M.createFeature(d, 'sketch', { plane: { ref: 'top' } }); Object.assign(sk, { points: [], curves: [], constraints: [] }); rect(sk, x0, y0, x1, y1); d.features.push(sk); return sk; };
        // the plate (y 0 to 2), its window (x ±30, z ±20) and the flange in the window against its z = -20 edge
        const plate = sketch(-50, -50, 50, 50);
        d.features.push(M.createFeature(d, 'extrude', { sketch: plate.id, depth: 2 }));
        const win = sketch(-30, -20, 30, 20);
        d.features.push(M.createFeature(d, 'extrude', { sketch: win.id, op: 'cut', end: 'through2' }));
        const fl = sketch(-fx, 18, fx, 20);
        d.features.push(M.createFeature(d, 'extrude', { sketch: fl.id, depth: 20 }));
        const r0 = await k.rebuild(d, null, null);
        const v0 = (await k.request('measure', { refs: [{ kind: 'body', id: r0.body.bodies[0].id }] })).items?.[0]?.volume;
        d.features.push(M.createFeature(d, 'smConvert', { face: { p: [40, 0, 40], n: [0, -1, 0] } }));
        const r = await k.rebuild(d, null, null);
        const sb = r.body?.bodies?.find((b) => b.sheet);
        if (!sb) return { errors: r.errors };
        const v1 = (await k.request('measure', { refs: [{ kind: 'body', id: sb.id }] })).items?.[0]?.volume;
        const flat = await k.request('sheetFlat', { bodyId: sb.id, flip: false });
        // the cut lines along each side of the window (the window's edge, then the rip on along the flange and its
        // bend, one line each): lines on one line of the flat, end to end, none twice (a slot would be two lines)
        const holes = flat.ents.filter((e) => e.type === 'LINE' && e.layer === 'HOLES');
        const key = (e) => { const v = [e.b[0] - e.a[0], e.b[1] - e.a[1]], L = Math.hypot(...v); const n = [-v[1] / L, v[0] / L]; const c = n[0] * e.a[0] + n[1] * e.a[1]; return `${Math.abs(n[0]).toFixed(3)},${Math.abs(n[1]).toFixed(3)},${Math.abs(c).toFixed(3)}`; };
        const groups = new Map();
        for (const e of holes) { const k = key(e); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
        // (the window's sides: the lines that come in twos, its edge and the rip)
        const sides = [...groups.values()].filter((g) => g.length === 2).map((g) => {
          const v = [g[0].b[0] - g[0].a[0], g[0].b[1] - g[0].a[1]], L = Math.hypot(...v), u = [v[0] / L, v[1] / L];
          const ts = g.flatMap((e) => [e.a, e.b].map((p) => p[0] * u[0] + p[1] * u[1]));
          const span = Math.max(...ts) - Math.min(...ts), sum = g.reduce((t, e) => t + Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), 0);
          return { span, sum };
        });
        return { errors: r.errors, bends: sb.sheet.bends, dv: v1 - v0, size: flat.size.map((x) => +x.toFixed(3)).sort((x, y) => x - y), sides };
      };
      const flush = await build(30), relief = await build(29);
      if (!flush.bends) return { ok: false, detail: `not converted: ${JSON.stringify(flush.errors)}` };
      // (the sharp corner made a bend of radius 2 adds the same volume per mm of flange width either way)
      const per = (o, w) => o.dv / w;
      const ripped = flush.sides.length === 2 && flush.sides.every((x) => Math.abs(x.sum - x.span) < 1e-3 && x.span > 30);
      const ok = !flush.errors.length && flush.bends === 1 && flush.size.join() === '100,100' && ripped && Math.abs(per(flush, 60) - per(relief, 58)) < 0.005 * Math.abs(per(relief, 58));
      return { ok, detail: `${flush.bends} bend; flat ${flush.size.join(' × ')}; cut along each side of the window (its edge and the rip, end to end, one line each) ${flush.sides.map((x) => `${x.sum.toFixed(3)} of ${x.span.toFixed(3)}`).join(' and ')} mm; folded volume ${per(flush, 60).toFixed(3)} mm³ more per mm of flange (with reliefs ${per(relief, 58).toFixed(3)}: the bend made round)` };
    } finally { k.dispose(); }
  },

  // A variable fillet with points along its edges: on a slot shape's top edge (lines and arcs, one run of edges) a
  // point a quarter of the way along one line with a radius of 6 (the rest 2). The point is marked where it should
  // be, the fillet is big there (a slice of the body around the point has less left than one around the mirror
  // point), and a point out of range is refused
  async 'fillet-edge-points'() {
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient({ threads: threadsPerKernel() });
    try {
      const build = async (pt, slab, z = 10) => {
        const d = M.newDoc(); d.name = 'Fillet points';
        const sk = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
        // a slot: centres x ±30, radius 10 (sketch y = -z)
        Object.assign(sk, { points: [{ id: 'a', x: -30, y: -10 }, { id: 'b', x: 30, y: -10 }, { id: 'c', x: 30, y: 10 }, { id: 'e', x: -30, y: 10 }, { id: 'c1', x: 30, y: 0 }, { id: 'c2', x: -30, y: 0 }],
          curves: [{ id: 'l1', type: 'line', p1: 'a', p2: 'b', construction: false }, { id: 'k1', type: 'arc', c: 'c1', p1: 'b', p2: 'c', construction: false },
            { id: 'l2', type: 'line', p1: 'c', p2: 'e', construction: false }, { id: 'k2', type: 'arc', c: 'c2', p1: 'e', p2: 'a', construction: false }], constraints: [] });
        d.features.push(sk, M.createFeature(d, 'extrude', { sketch: sk.id, depth: 20 }));
        // the top line at z = +10 (sketch y -10), its middle at (0, 20, 10)
        const fl = M.createFeature(d, 'fillet', { filletType: 'variable', radiusMode: 'vertices', radius: 2, edges: [{ p: [0, 20, z] }], edgePoints: [{ edge: 0, ...pt }] });
        d.features.push(fl);
        // (a slice x0 .. x0 + 6 of the body kept: everything else cut away)
        if (slab != null) {
          for (const [x0, x1] of [[-60, slab], [slab + 6, 60]]) {
            const c = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
            Object.assign(c, { points: [{ id: 'p0', x: x0, y: -30 }, { id: 'p1', x: x1, y: -30 }, { id: 'p2', x: x1, y: 30 }, { id: 'p3', x: x0, y: 30 }],
              curves: [0, 1, 2, 3].map((i) => ({ id: 'c' + i, type: 'line', p1: 'p' + i, p2: 'p' + ((i + 1) % 4), construction: false })), constraints: [] });
            d.features.push(c, M.createFeature(d, 'extrude', { sketch: c.id, op: 'cut', end: 'through2' }));
          }
        }
        const r = await k.rebuild(d, null, null);
        const b = r.body?.bodies?.[0];
        const vol = b ? (await k.request('measure', { refs: [{ kind: 'body', id: b.id }] })).items?.[0]?.volume : null;
        return { r, vol, info: r.info?.[fl.id], err: r.errors.filter((e) => e[0] === fl.id).map((e) => e[1]) };
      };
      // (both lines: the run of edges goes one of them its own way and the other against it)
      const out = [], fails = [];
      for (const z of [10, -10]) {
        const one = await build({ t: 25, r: 6 }, null, z);
        const m = one.info?.points?.[0];
        if (!m) { fails.push(`z ${z}: no point reported ${JSON.stringify(one.err)}`); continue; }
        // the point: on the line, y = 20, a quarter of the way along it (x ±15)
        const onLine = Math.abs(m[1] - 20) < 1e-3 && Math.abs(m[2] - z) < 1e-3 && Math.abs(Math.abs(m[0]) - 15) < 1e-3;
        const here = await build({ t: 25, r: 6 }, m[0] - 3, z), there = await build({ t: 25, r: 6 }, -m[0] - 3, z);
        const ok1 = onLine && !one.err.length && here.vol < there.vol - 10;
        (ok1 ? out : fails).push(`line z ${z}: point at (${m.map((x) => +x.toFixed(3)).join(', ')}), slice there ${here.vol?.toFixed(2)} mm³, at the mirror point ${there.vol?.toFixed(2)}`);
      }
      const one = await build({ t: 25, r: 6 }), plain = await build({ t: 25, r: 2 }), bad = await build({ t: 120, r: 6 });
      // (15 mm from the start of the 60 mm line: the same as 25 %)
      const mm = await build({ t: 15, unit: 'mm', r: 6 });
      const same = Math.abs(mm.vol - one.vol) < 1e-6 * one.vol;
      const ok = !fails.length && one.vol < plain.vol - 20 && bad.err.length > 0 && same;
      return { ok, detail: `${[...out, ...fails].join('; ')}; body ${one.vol?.toFixed(1)} (all R2: ${plain.vol?.toFixed(1)}); 15 mm from the start: ${same ? 'the same as 25 %' : mm.vol}; 120 %: ${bad.err.length ? 'refused' : 'taken'}` };
    } finally { k.dispose(); }
  },

  // The example part of the manual's tutorial rebuilds as the tutorial says: no errors, the guided loft (one guide
  // curve), the fillet with its point along the edge, the tray with its four corners closed, two bodies (one sheet)
  async 'example-part'() {
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient({ threads: threadsPerKernel() });
    try {
      const d = M.exampleDoc();
      const r = await k.rebuild(d, null, null);
      const id = (type) => d.features.find((f) => f.type === type).id;
      const notes = [r.notes[id('loft')], r.notes[id('fillet')], r.notes[id('smFlange')]];
      const bodies = r.body?.bodies || [];
      const ok = !r.errors.length && notes[0] === '2 profiles, 1 guide curve' && /1 point along/.test(notes[1] || '') && notes[2] === '4 corners closed'
        && bodies.length === 2 && bodies.filter((b) => b.sheet).length === 1;
      return { ok, detail: `${bodies.length} bodies (${bodies.filter((b) => b.sheet).length} sheet metal); ${notes.join('; ')}${r.errors.length ? '; errors ' + JSON.stringify(r.errors) : ''}` };
    } finally { k.dispose(); }
  },

  // A new Edge-Flange's flanges meet corner to corner where they meet: each runs square up to the other's inside
  // face, not mitred and not one overlapping the other, the bends in plain V cuts from the corner point. The tray's
  // four flanges with the defaults close their four corners, the same body as with corner 'square' set and neither
  // the mitred one's nor the overlap's, its faces whole (1.5 and 3 thick)
  async 'flange-corner-default'() {
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient({ threads: threadsPerKernel() });
    try {
      const tray = JSON.parse(await (await fetch('/tests/parts/sheet-metal-tray.rcad')).text());
      const edges = tray.features[2].edges;
      const vol = (r) => {
        const b = r.body?.bodies?.[0], V = r.body?.vertices, T = r.body?.triangles;
        if (!b) return NaN;
        let v6 = 0;
        for (let q = b.triStart; q < b.triStart + b.triCount; q += 3) {
          const [a, c, e] = [0, 1, 2].map((j) => 3 * T[q + j]);
          v6 += V[a] * (V[c + 1] * V[e + 2] - V[c + 2] * V[e + 1]) - V[a + 1] * (V[c] * V[e + 2] - V[c + 2] * V[e]) + V[a + 2] * (V[c] * V[e + 1] - V[c + 1] * V[e]);
        }
        return Math.abs(v6 / 6);
      };
      const build = async (props, t = 0) => {
        const d = JSON.parse(JSON.stringify(tray)); d.features = d.features.slice(0, 2);
        if (t) Object.assign(d.features[1], { thickness: t, radius: t });
        const f = M.createFeature(d, 'smFlange', { edges: t ? edges.map((e) => ({ p: [e.p[0], t, e.p[2]] })) : edges, length: 20, ...props });
        d.features.push(f);
        const r = await k.rebuild(d, null, null);
        return { f, r, v: vol(r), note: r.notes?.[f.id] || '' };
      };
      const def = await build({}), sq = await build({ corner: 'square', cornerGap: 0.5 }), butt = await build({ corner: 'butt', cornerGap: 0.5 }), over = await build({ corner: 'closed', cornerGap: 0.5 });
      // square ends: the wall on the edge x = 60 (inside face x = 58.5) ends square at z = 40 − 1.5 − 0.5 / √2 (the default gap 0.5), short of
      // the other wall's inside face by the gap's share, its inside edge the gap from the other's; the outside corner open
      const V = def.r.body.vertices, T = def.r.body.triangles, zEnd = 40 - 1.5 - 0.5 / Math.SQRT2;
      const end = def.r.body.faceGroups.find((g) => {
        if (g.surf?.t !== 'PLANE' || Math.abs(Math.abs(g.surf.n[2]) - 1) > 1e-6) return false;
        const xs = [], zs = [];
        for (let q = g.start; q < g.start + g.count; q++) { xs.push(V[3 * T[q]]); zs.push(V[3 * T[q] + 2]); }
        return zs.every((z) => Math.abs(z - zEnd) < 1e-4) && Math.abs(Math.min(...xs) - 58.5) < 1e-4 && Math.abs(Math.max(...xs) - 60) < 1e-4;
      });
      // every face whole, and none of nothing: base 2, walls 4 × 3, wall ends 8, bends 8, the bends' V cut ends 8 (also
      // 3 thick, where a corner's run-on of the wall once came out a ten-millionth off and split the wall's end face)
      const nf = (x) => { const c = {}; for (const g of x.r.body.faceGroups) c[g.surf?.t] = (c[g.surf?.t] || 0) + 1; return `${x.r.body.faceGroups.length} (${c.PLANE} planes, ${c.CYLINDER} cylinders, ${c.OTHER} other)`; };
      const thick = await build({}, 3), want = '38 (22 planes, 8 cylinders, 8 other)';
      const ok = def.f.corner === 'square' && def.f.cornerGap === 0.5 && !def.r.errors.length && /4 corners closed/.test(def.note) && !!end && nf(def) === want && nf(thick) === want
        && Math.abs(def.v - sq.v) < 1e-6 * sq.v && Math.abs(def.v - butt.v) > 1e-5 * butt.v && Math.abs(def.v - over.v) > 1e-4 * over.v;
      return { ok, detail: `default corner '${def.f.corner}', ${def.note || JSON.stringify(def.r.errors)}; wall end square at z ${zEnd.toFixed(4)}: ${end ? 'yes' : 'no'}; faces ${nf(def)}, 3 thick ${nf(thick)}; volume ${def.v.toFixed(3)} (square ${sq.v.toFixed(3)}, mitred ${butt.v.toFixed(3)}, overlap ${over.v.toFixed(3)})` };
    } finally { k.dispose(); }
  },
  async 'loft-guides'() {
    const { KernelClient } = await import('/js/kernelclient.js'), k = new KernelClient({ threads: threadsPerKernel() });
    try {
      const square = (d, plane, hole = false) => {
        const s = M.createFeature(d, 'sketch', { plane });
        const P = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
        Object.assign(s, { points: P.map(([x, y], i) => ({ id: 'p' + i, x, y })), curves: P.map((_, i) => ({ id: 'c' + i, type: 'line', p1: 'p' + i, p2: 'p' + ((i + 1) % 4), construction: false })), constraints: [] });
        // (a round hole of radius 8 in the middle)
        if (hole) s.curves.push({ id: 'h', type: 'circle', c: 'O', r: 8, construction: false });
        d.features.push(s);
        return s.id;
      };
      // (an arc through (sx, 0), (sx + 20 sgn, 50), (sx, 100) in the front plane)
      const guide = (d, sgn) => {
        const s = M.createFeature(d, 'sketch', { plane: { ref: 'front' } });
        const cx = sgn * -32.5;
        Object.assign(s, { points: [{ id: 'g0', x: cx, y: 50 }, { id: 'g1', x: 20 * sgn, y: sgn > 0 ? 0 : 100 }, { id: 'g2', x: 20 * sgn, y: sgn > 0 ? 100 : 0 }],
          curves: [{ id: 'ga', type: 'arc', c: 'g0', p1: 'g1', p2: 'g2', construction: false }], constraints: [] });
        d.features.push(s);
        return s.id;
      };
      const build = async (nGuides, { hole = false, thin = false } = {}) => {
        const d = M.newDoc(); d.name = 'Guided loft';
        // the squares on planes square to the front plane: the top plane, and that plane moved 100 up
        const pl = M.createFeature(d, 'plane', { refs: [{ kind: 'plane', id: 'top' }], offset: 100 });
        d.features.push(pl);
        const a = square(d, { ref: 'top' }, hole), b = square(d, { ref: pl.id }, hole);
        const gs = [];
        if (nGuides >= 1) gs.push(guide(d, 1));
        if (nGuides >= 2) gs.push(guide(d, -1));
        d.features.push(M.createFeature(d, 'loft', { profiles: [a, b], guides: gs, ...(thin ? { thin: true, thinT: 2, thinDir: 'one' } : {}) }));
        const r = await k.rebuild(d, null, null);
        const bb = r.body?.bodies?.[0];
        if (!bb) return { errors: r.errors };
        const ms = (await k.request('measure', { refs: [{ kind: 'body', id: bb.id }] })).items?.[0] || {};
        const V = r.body.vertices, T = r.body.triangles;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let q = bb.triStart; q < bb.triStart + bb.triCount; q++) { const x = V[3 * T[q]], y = V[3 * T[q] + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        return { x0, x1, y0, y1, vol: ms.volume, area: ms.area, note: r.notes?.[d.features[d.features.length - 1].id], errors: r.errors };
      };
      const plain = await build(0), one = await build(1), two = await build(2);
      const ok1 = plain.x1 < 20.5 && one.x1 > 39 && one.x1 < 41 && one.x0 > -21 && two.x1 > 39 && two.x0 < -39 && Math.abs(two.y1 - two.y0 - 100) < 0.5;
      // a hole: it moves with the outline (one guide moves the whole section 20 out at mid-height: a hole left in
      // the middle would break out of the far side), so the whole hole is taken out, a little over π r² × 100
      const holed = await build(1, { hole: true });
      const removed = one.vol - holed.vol, cyl = Math.PI * 64 * 100;
      const ok2 = !holed.errors?.length && removed > 0.99 * cyl && removed < 1.12 * cyl;
      // a thin loft (2 mm walls inward) with both guides: the inside follows the outline, so the walls stay about
      // 2 mm (volume about 2 mm × half the surface; walls left where they were would be up to 20 mm thick)
      const thin = await build(2, { thin: true });
      const ratio = thin.vol / ((2 * thin.area) / 2);
      const ok3 = !thin.errors?.length && thin.x1 > 39 && ratio > 0.85 && ratio < 1.1;
      const f = (o) => (o.errors?.length && o.x1 == null ? JSON.stringify(o.errors) : `x ${o.x0?.toFixed(2)} to ${o.x1?.toFixed(2)}`);
      return ok1 && ok2 && ok3 ? { ok: true, detail: `no guide: ${f(plain)}; one guide: ${f(one)} (pulled out to it); two guides: ${f(two)}; a hole moves with it (${(removed / cyl).toFixed(3)} × π r² h taken out); thin with two guides: walls ${(ratio * 2).toFixed(2)} mm on average` }
        : { ok: false, detail: `no guide: ${f(plain)}; one: ${f(one)}; two: ${f(two)} (y ${two.y0}–${two.y1}); hole ${holed.errors?.length ? JSON.stringify(holed.errors) : (removed / cyl).toFixed(3)}; thin ${thin.errors?.length ? JSON.stringify(thin.errors) : `${f(thin)} ratio ${ratio.toFixed(3)}`}` };
    } finally { k.dispose(); }
  },

  async 'no-browser-menu'() {
    const a = window.app;
    if (a.mode === 'drawing') { const i = a.tabs.findIndex((t) => t.kind !== 'drawing'); if (i >= 0) await a.activateTab(i); else { a.newDocument(); closeModals(); } }
    const right = (target) => {
      const r = target.getBoundingClientRect();
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + Math.min(5, r.width / 2), clientY: r.top + Math.min(5, r.height / 2) });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const kept = { tree: right(document.getElementById('tree')), status: right(document.getElementById('statusbar')), view: right(a.viewport.canvas) };
    const field = document.createElement('input');
    document.body.appendChild(field);
    const fieldFree = !right(field);
    field.remove();
    a.ui.closeContext?.();
    const node = document.querySelector('#tree .tn[data-id]') || document.querySelector('#tree .tn');
    const opened = node ? (right(node), !document.getElementById('ctxmenu').hidden) : null;
    a.ui.closeContext?.();
    const ok = Object.values(kept).every(Boolean) && fieldFree && opened !== false;
    return ok ? { ok: true, detail: `kept from the browser: ${Object.keys(kept).join(', ')}; a text field keeps its menu; the tree's own menu opens${opened === null ? ' (no tree item)' : ''}` }
      : { ok: false, detail: `kept ${JSON.stringify(kept)}, field free ${fieldFree}, tree menu ${opened}` };
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



  // a big STEP import's bodies meshed in the pool's free kernels too (kernel.worker.js meshHelped): 12 copies of the
  // test tray in one file; a part kernel reading it from the store shares the meshing out, and its mesh is exactly
  // the one a kernel makes alone (every vertex, triangle, face and edge, and the faces' surfaces)
  async 'import-mesh-helpers'() {
    const a = window.app, was = window.RAZORCAD_WEB, { KernelClient } = await import('/js/kernelclient.js');
    const tray = JSON.parse(await (await fetch('/tests/parts/sheet-metal-tray.rcad')).text());
    const kernels = [];
    try {
      window.RAZORCAD_WEB = { ...(was || {}), kernel: 'test-' + Math.random().toString(36).slice(2) };
      const r0 = await a.kernel.request('rebuild', { doc: JSON.stringify(tray) });
      const id = r0.body?.bodies?.[0]?.id;
      if (!id) throw new Error('the tray: no body');
      const many = JSON.parse(JSON.stringify(tray));
      many.features.push(M.createFeature(many, 'moveBody', { bodies: [id], copy: true, copies: 11, dx: 400 }));
      const r1 = await a.kernel.request('rebuild', { doc: JSON.stringify(many) });
      if (r1.body?.bodies?.length !== 12) throw new Error(`12 trays: ${r1.body?.bodies?.length} bodies (${JSON.stringify(r1.errors)})`);
      let step = new TextDecoder().decode(await a.kernel.request('export', { format: 'step' }));
      if (step.length < 2e6) step = step.replace('ISO-10303-21;', 'ISO-10303-21;\n/* ' + 'RazorCAD test padding\n'.repeat(100000) + ' */');
      const d = M.newDoc(); d.name = 'Many trays';
      d.features.push(M.createFeature(d, 'import', { format: 'step', fileName: 'trays.step', data: step }));
      const build = async (helped, meshHelp = null) => {
        const k = new KernelClient({ threads: threadsPerKernel() }); kernels.push(k); await k.ready;
        if (helped) a.wireKernel(k);
        let stored = false; k.onStored = () => { stored = true; };
        const t0 = performance.now();
        const r = await k.request('rebuild', { doc: JSON.stringify(d), meshHelp });
        return { r, ms: Math.round(performance.now() - t0), stored: () => stored };
      };
      // (read from the file and kept; then read from the store, by a kernel alone and by one with helpers)
      const b0 = await build(false);
      for (let i = 0; i < 200 && !b0.stored(); i++) await wait(100);
      if (!b0.stored()) return { ok: false, detail: 'the import was not kept' };
      // (helpers made to help, whatever the times)
      const alone = await build(false), helped = await build(true, 'always');
      const A = alone.r.body, H = helped.r.body, bad = [];
      if (!A || !H) return { ok: false, detail: 'no mesh' };
      const n = helped.r.timing.meshHelpers;
      if (!(n > 0)) bad.push(`no kernel helped (${n})`);
      const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
      if (!same(A.vertices, H.vertices)) bad.push(`vertices ${A.vertices.length} / ${H.vertices.length}`);
      if (!same(A.normals, H.normals)) bad.push('normals differ');
      if (!same(A.triangles, H.triangles)) bad.push(`triangles ${A.triangles.length} / ${H.triangles.length}`);
      const fg = (b) => JSON.stringify(b.faceGroups.map((g) => [g.start, g.count, g.surf ?? null, g.look ?? null]));
      if (fg(A) !== fg(H)) bad.push(`faces ${A.faceGroups.length} / ${H.faceGroups.length}`);
      if (JSON.stringify(A.edges) !== JSON.stringify(H.edges)) bad.push(`edges ${A.edges.length} / ${H.edges.length}`);
      if (JSON.stringify(A.bodies) !== JSON.stringify(H.bodies)) bad.push('bodies differ');
      const detail = `${(step.length / 1e6).toFixed(1)} MB STEP, 12 bodies, ${A.faceGroups.length} faces: meshed in ${n + 1} kernels, the same mesh (${A.triangles.length / 3} triangles, ${A.edges.length} edges); mesh ${alone.r.timing.mesh} ms alone, ${helped.r.timing.mesh} ms helped`;
      return !bad.length ? { ok: true, detail } : { ok: false, detail: bad.join('; ') + ' — ' + detail };
    } finally {
      kernels.forEach((k) => k.dispose());
      if (was === undefined) delete window.RAZORCAD_WEB; else window.RAZORCAD_WEB = was;
    }
  },

  // (convertSheetVariants: the corner variants, and the hem and two bodies, each in a test of its own)
  'convert-sheet-variants'() { return convertSheetVariants('corners'); },
  'convert-sheet-others'() { return convertSheetVariants('others'); },

  // (importStore: a STEP, and an STL, each in a test of its own)
  'import-store-step'() { return importStore('STEP'); },
  'import-store-stl'() { return importStore('STL'); },

  // Section View from a face, and its arrow: with a flat face selected it starts on that face's plane (offset 0);
  // dragging the arrow moves the cut along the normal (the offset box follows, the view does not turn); clicking
  // another flat face moves the section onto it; OK keeps the cut and takes the arrow away
  async 'section-from-face'() {
    const a = window.app;
    const text = await (await fetch('/tests/parts/plate-features.rcad')).text();
    await a.openFromFile({ content: text, name: 'Section test.rcad', path: null });
    for (let i = 0; i < 80 && !a.result?.bodies?.length; i++) await wait(100);
    const { vp, fire, R, toScreen } = viewEvents();
    const faceWith = (k) => { for (let i = 0; i < 1000; i++) { const f = vp.faceInfo(i); if (!f) return null; if (f.planar && f.normal.getComponent(k) > 0.99) return f; } return null; };
    try {
      const side = faceWith(0);
      a.selection = { kind: 'face', face: side };
      a.startSection();
      const s = a.sectionState;
      const started = a.pm?.kind === 'section' && s.plane === 'custom' && s.custom.n.x > 0.999 && Math.abs(vp.section.constant - side.d) < 1e-6 && !!vp._secArrow;
      // drag the arrow 150 px back into the part, seen from the front
      vp.setStandardView('front', false); vp.zoomToFit(null, false); vp.camera.updateMatrixWorld(); vp._secArrow.place();
      const n = a.sectionFrame().n, wpp = vp.worldPerPixel(), g = vp._secArrow.group;
      const [x, y] = toScreen(g.position.clone().addScaledVector(n, 40 * wpp)), [tx, ty] = toScreen(g.position.clone().addScaledVector(n, 100 * wpp));
      const L = Math.hypot(tx - x, ty - y), u = [(tx - x) / L, (ty - y) / L];
      const q0 = vp.camera.quaternion.clone(), b = { button: 0, buttons: 1 };
      fire('pointerdown', x, y, b);
      for (let k = 1; k <= 10; k++) { fire('pointermove', x - u[0] * 15 * k, y - u[1] * 15 * k, b); await wait(5); }
      fire('pointerup', x - u[0] * 150, y - u[1] * 150, { ...b, buttons: 0 }); await wait(50);
      const step = 10 ** Math.ceil(Math.log10(wpp)), want = -150 * wpp;
      const field = document.querySelector('#pm .sec-offset input')?.value;
      const dragOff = s.offset;
      const dragged = Math.abs(s.offset - want) <= step && Math.abs(vp.section.constant - (side.d + s.offset)) < 1e-6 && q0.angleTo(vp.camera.quaternion) < 1e-9 && Number(field) === s.offset;
      // seen end on (looking along the arrow, from the side it points to): 100 px up the screen moves it toward the viewer
      vp.setStandardView('right', false); vp.zoomToFit(null, false); vp.camera.updateMatrixWorld(); vp._secArrow.place();
      const [ex, ey] = toScreen(g.position), wpp2 = vp.worldPerPixel(), step2 = 10 ** Math.ceil(Math.log10(wpp2)), off1 = s.offset;
      fire('pointerdown', ex, ey, b);
      for (let k = 1; k <= 10; k++) { fire('pointermove', ex, ey - 10 * k, b); await wait(5); }
      fire('pointerup', ex, ey - 100, { ...b, buttons: 0 }); await wait(50);
      const endOn = Math.abs(s.offset - off1 - 100 * wpp2) <= step2;
      // click the top face: the section moves onto it
      vp.setStandardView('iso', false); vp.zoomToFit(null, false); vp.camera.updateMatrixWorld();
      let at = null;
      for (let fx = 0.2; fx < 0.8 && !at; fx += 0.02) for (let fy = 0.2; fy < 0.8 && !at; fy += 0.02) {
        const e = { clientX: R.left + R.width * fx, clientY: R.top + R.height * fy }, p = a.pickAt(e);
        if (p?.kind === 'face' && vp.faceInfo(p.hit.face).normal.y > 0.99 && !vp.sectionArrowAt(e)) at = [e.clientX, e.clientY, vp.faceInfo(p.hit.face).d];
      }
      if (at) { fire('pointerdown', at[0], at[1], b); fire('pointerup', at[0], at[1], { ...b, buttons: 0 }); await wait(50); }
      const moved = !!at && s.custom.n.y > 0.999 && s.offset === 0 && Math.abs(vp.section.constant - at[2]) < 1e-6;
      await a.okPM();
      const kept = !a.pm && !!vp.section && !vp._secArrow;
      const ok = started && dragged && endOn && moved && kept;
      return ok ? { ok: true, detail: `started on the side face (x = ${side.d}); arrow dragged 150 px: offset ${dragOff} mm (${want.toFixed(2)} by the drag), the view unchanged; end on, up the screen moves it toward the viewer; clicked the top face: cut at y = ${at[2]}; OK: cut kept, arrow gone` }
        : { ok: false, detail: `started ${started}, dragged ${dragged} (offset ${dragOff}, want ${want.toFixed(2)}, field ${field}), end on ${endOn} (${s.offset}), moved ${moved}, kept ${kept}` };
    } finally {
      a.clearSection();
      a.dirty = false;
      await a.closeTab(a.tabIndex);
    }
  },

  // Section View with two planes (a quarter cut): Section 1 on the front plane and Section 2 on the right plane, both
  // at 0: only what both cut away is gone (a point in front of both), what only one cuts away is still there; both
  // capped; nothing cut away picked; the arrow moves the section last changed (Section 2) only; unticked, one plane
  async 'section-planes'() {
    const a = window.app;
    const text = await (await fetch('/tests/parts/plate-features.rcad')).text();
    await a.openFromFile({ content: text, name: 'Quarter test.rcad', path: null });
    for (let i = 0; i < 80 && !a.result?.bodies?.length; i++) await wait(100);
    const { vp, fire, R, toScreen } = viewEvents();
    try {
      a.selection = null;
      a.startSection();
      const s = a.sectionState;
      Object.assign(s, { plane: 'front', offset: 0, flip: false });
      Object.assign(s.more[0], { on: true, plane: 'right', offset: 0, flip: false });
      s.active = 1;
      a.applySection(); a.ui.renderPM();
      const two = vp.sectionPlanes().length === 2 && vp.bodyMat.clipIntersection === true && vp.capGroup?.children.length >= 6;
      // (front plane: z, right plane: x; the plate lies in x, z)
      const V3 = vp.camera.position.constructor;
      const both = !vp._sectionKeeps(new V3(30, 6, 20)), onlyOne = vp._sectionKeeps(new V3(30, 6, -20)) && vp._sectionKeeps(new V3(-30, 6, 20));
      let picks = 0, cutAway = 0;
      vp.setStandardView('iso', false); vp.zoomToFit(null, false); vp.camera.updateMatrixWorld();
      for (let fx = 0.1; fx < 0.95; fx += 0.05) for (let fy = 0.1; fy < 0.95; fy += 0.05) {
        const h = vp.pickBody({ clientX: R.left + R.width * fx, clientY: R.top + R.height * fy });
        if (h) { picks++; if (!vp._sectionKeeps(h.point)) cutAway++; }
      }
      // the arrow: on Section 2's plane; dragged, it moves Section 2 only
      vp.setStandardView('top', false); vp.zoomToFit(null, false); vp.camera.updateMatrixWorld(); vp._secArrow.place();
      const g = vp._secArrow.group, n = a.sectionFrame(s.more[0]).n, wpp = vp.worldPerPixel();
      const onRight = Math.abs(g.position.x) < 1e-6;
      const [x, y] = toScreen(g.position.clone().addScaledVector(n, 40 * wpp)), [tx, ty] = toScreen(g.position.clone().addScaledVector(n, 100 * wpp));
      const L = Math.hypot(tx - x, ty - y), u = [(tx - x) / L, (ty - y) / L], b = { button: 0, buttons: 1 };
      fire('pointerdown', x, y, b);
      for (let k = 1; k <= 10; k++) { fire('pointermove', x - u[0] * 10 * k, y - u[1] * 10 * k, b); await wait(5); }
      fire('pointerup', x - u[0] * 100, y - u[1] * 100, { ...b, buttons: 0 }); await wait(50);
      const moved = s.more[0].offset < -1 && s.offset === 0;
      const field = document.querySelector('#pm .sec-group[data-sec="1"] .sec-offset input')?.value;
      // unticked: one plane again
      s.more[0].on = false; a.applySection();
      const one = vp.sectionPlanes().length === 1 && vp.bodyMat.clipIntersection === false;
      const ok = two && both && onlyOne && picks > 0 && !cutAway && onRight && moved && Number(field) === s.more[0].offset && one;
      return ok ? { ok: true, detail: `two planes: only what both cut away gone, both capped; ${picks} picks, none cut away; the arrow moved Section 2 to ${s.more[0].offset} mm (Section 1 stayed at 0); unticked: one plane` }
        : { ok: false, detail: `two ${two} (caps ${vp.capGroup?.children.length}), both cut ${both}, one cut kept ${onlyOne}, picks ${picks} (cut away ${cutAway}), arrow on Section 2 ${onRight}, moved ${moved} (${s.more[0].offset}, ${s.offset}, field ${field}), one plane ${one}` };
    } finally {
      const s = a.sectionState;
      s.more.forEach((q) => { q.on = false; q.offset = 0; }); s.active = 0;
      if (a.pm?.kind === 'section') a.cancelPM();
      if (vp.section) a.clearSection();
      a.dirty = false;
      await a.closeTab(a.tabIndex);
    }
  },

  // a section view saved with the part: saved with the cut on (two planes, one picked from a face), the file opens
  // with the same cut; the model's key leaves it out; a tab keeps its own cut (another part's tab has none, and
  // coming back puts it on again); an assembly saved with a cut opens with it too
  async 'section-saved'() {
    const a = window.app, { platform } = await import('/js/platform.js'), keep = platform.saveText, THREE = await import('three');
    const text = await (await fetch('/tests/parts/plate-features.rcad')).text();
    let saved = null;
    platform.saveText = async (name, t) => { saved = t; return null; };
    const opened = [];
    try {
      await a.openFromFile({ content: text, name: 'Section saved.rcad', path: null });
      opened.push(a.tabIndex);
      for (let i = 0; i < 80 && !a.result?.bodies?.length; i++) await wait(100);
      a.selection = null;
      a.startSection();
      const s = a.sectionState;
      Object.assign(s, { plane: 'custom', custom: { o: new THREE.Vector3(1, 2, 3), n: new THREE.Vector3(0, 0, 1), name: 'Selected face' }, offset: 4.5, flip: true });
      Object.assign(s.more[0], { on: true, plane: 'right', offset: -7, flip: false });
      a.applySection(); a.okPM();
      await a.saveFile();
      const file = saved && JSON.parse(saved), fs = file?.section;
      const inFile = fs?.plane === 'custom' && fs.offset === 4.5 && fs.flip === true && fs.custom?.o?.join() === '1,2,3' && fs.more?.[0]?.on === true && fs.more[0].offset === -7;
      const { section: _s, ...plain } = M.stripThumbnail(JSON.parse(saved));
      const keySame = (await a.docKey(M.stripThumbnail(file))) === (await a.docKey(plain));
      // opened again (in a tab of its own): the same cut
      a.clearSection();
      await a.openFromFile({ content: saved, name: 'Section saved again.rcad', path: null });
      opened.push(a.tabIndex);
      const r = a.sectionState, vp = a.viewport;
      const back = !!vp.section && vp.sectionPlanes().length === 2 && r.plane === 'custom' && r.custom.o.z === 3 && r.offset === 4.5 && r.flip && r.more[0].on && r.more[0].offset === -7 && a.pm?.kind !== 'section';
      // another part in a tab: no cut there; back to this tab: the cut again
      const here = a.tabIndex;
      a.newDocument(); closeModals();
      opened.push(a.tabIndex);
      const noneThere = !vp.section;
      await a.activateTab(here);
      const tabBack = !!vp.section && vp.sectionPlanes().length === 2 && a.sectionState.offset === 4.5;
      // an assembly saved with a cut
      const ed = a.newAssembly(); await wait(300); closeModals();
      opened.push(a.tabIndex);
      Object.assign(a.sectionState, { plane: 'top', custom: null, offset: 2, flip: false }); a.sectionState.more.forEach((q) => { q.on = false; });
      a.applySection();
      await ed.save();
      const asmFile = saved && JSON.parse(saved);
      const asmSaved = asmFile?.section?.plane === 'top' && asmFile.section.offset === 2;
      a.clearSection();
      a.openAssemblyTab(asmFile, null); await wait(300);
      opened.push(a.tabIndex);
      const asmBack = !!vp.section && a.sectionState.plane === 'top' && a.sectionState.offset === 2;
      const ok = inFile && keySame && back && noneThere && tabBack && asmSaved && asmBack;
      return ok ? { ok: true, detail: `saved with the part (two planes, one from a face at offset 4.5, flipped), opened with the same cut; the model's key the same; another tab has none, back again it has; an assembly saved and opened with its cut` }
        : { ok: false, detail: `in the file ${inFile} (${JSON.stringify(fs)?.slice(0, 160)}), key same ${keySame}, opened with it ${back}, none in another tab ${noneThere}, back in the tab ${tabBack}, assembly saved ${asmSaved}, opened ${asmBack}` };
    } finally {
      platform.saveText = keep;
      const s = a.sectionState;
      s.more.forEach((q) => { q.on = false; q.offset = 0; }); Object.assign(s, { plane: 'front', custom: null, offset: 0, flip: false, active: 0 });
      if (a.pm?.kind === 'section') a.cancelPM();
      if (a.viewport.section) a.clearSection();
      for (const i of opened.sort((x, y) => y - x)) {
        if (!a.tabs[i]) continue;
        if (a.tabs[i].kind === 'drawing') a.tabs[i].drawing.dirty = false; else if (i === a.tabIndex) a.dirty = false; else a.tabs[i].dirty = false;
        await a.closeTab(i);
      }
    }
  },

  // Section View in an assembly: two blocks with a hole, cut on the front plane: the components clipped (faces and
  // edges), a cap for the part, nothing cut away picked; a click on a block's top face moves the cut onto it; OK keeps
  // the cut (the assembly still shown: nothing built into the view), the button opens the panel again, ✗ removes it
  async 'section-assembly'() {
    const a = window.app, vp = a.viewport;
    const part = M.newDoc(); part.name = 'Block';
    const sk = M.createFeature(part, 'sketch', { plane: { ref: 'top' } });
    const pts = [[0, 0], [40, 0], [40, 30], [0, 30]];
    Object.assign(sk, { points: pts.map(([x, y], i) => ({ id: 'p' + i, x, y })), curves: pts.map((_, i) => ({ id: 'c' + i, type: 'line', p1: 'p' + i, p2: 'p' + ((i + 1) % 4), construction: false })), constraints: [] });
    const hsk = M.createFeature(part, 'sketch', { plane: { ref: 'top' } });
    Object.assign(hsk, { points: [{ id: 'q0', x: 20, y: 15 }], curves: [{ id: 'k0', type: 'circle', c: 'q0', r: 6, construction: false }], constraints: [] });
    part.features.push(sk, M.createFeature(part, 'extrude', { sketch: sk.id, depth: 20 + Math.random() }), hsk, M.createFeature(part, 'extrude', { sketch: hsk.id, op: 'cut', end: 'through2' }));
    const asm = { kind: 'assembly', version: 1, name: 'Section test', nextId: 4, parts: [{ id: 'pt1', name: 'Block', path: null, doc: part }], components: [
      { id: 'c1', part: 'pt1', name: 'Block<1>', config: null, pos: [0, 0, 0], rot: [0, 0, 0, 1], fixed: true, hidden: false },
      { id: 'c2', part: 'pt1', name: 'Block<2>', config: null, pos: [50, 0, 0], rot: [0, 0, 0, 1], fixed: true, hidden: false }], mates: [], configs: [], explodes: [] };
    await a.openFromFile({ content: JSON.stringify(asm), name: 'Section test.rasm', path: null });
    const ed = a.tabs[a.tabIndex].drawing;
    for (let w = 0; w < 150 && !(ed.parts?.size && [...ed.parts.values()].every((x) => x.mesh)); w++) await wait(100);
    const { fire, R } = viewEvents();
    try {
      ed.toggleSection();
      Object.assign(a.sectionState, { plane: 'front', offset: -15, flip: false });
      a.applySection(); a.ui.renderPM();
      const panel = a.pm?.kind === 'section' && !document.querySelector('#pm').hidden && /Section View/.test(document.querySelector('#pm').innerText);
      const clipped = [...ed.display.mats.values()].every((m) => m.clippingPlanes?.length === 1) && ed.display.edgeMat.clippingPlanes?.length === 1;
      const caps = vp.capGroup?.children.length >= 3;
      // nothing cut away is picked: every hit kept by the cut
      let picks = 0, cutAway = 0;
      for (let fx = 0.1; fx < 0.95; fx += 0.05) for (let fy = 0.1; fy < 0.95; fy += 0.05) {
        const h = ed.display.pick({ clientX: R.left + R.width * fx, clientY: R.top + R.height * fy });
        if (h) { picks++; if (!vp._sectionKeeps(h.point)) cutAway++; }
      }
      // a click on a block's top face (y = the block's height)
      vp.setStandardView('iso', false); vp.zoomToFit(null, false); vp.camera.updateMatrixWorld();
      let at = null;
      for (let fx = 0.15; fx < 0.9 && !at; fx += 0.02) for (let fy = 0.15; fy < 0.9 && !at; fy += 0.02) {
        const e = { clientX: R.left + R.width * fx, clientY: R.top + R.height * fy }, r = !vp.sectionArrowAt(e) && ed.entityAt(e, true);
        const w = r?.kind === 'plane' && ed.worldRef(r);
        if (w?.n && w.n[1] > 0.99) at = [e.clientX, e.clientY, w.p[1]];
      }
      if (at) { fire('pointerdown', at[0], at[1], { button: 0, buttons: 1 }); fire('pointerup', at[0], at[1], { button: 0, buttons: 0 }); await wait(60); }
      const moved = !!at && a.sectionState.plane === 'custom' && a.sectionState.custom.n.y > 0.99 && Math.abs(vp.section.constant - at[2]) < 1e-6;
      await a.okPM();
      const kept = !a.pm && !!vp.section && !vp._secArrow && !!vp.asmView && ed.display.batches.size > 0 && a.mode === 'drawing';
      ed.toggleSection();
      const reopened = a.pm?.kind === 'section' && a.sectionState.plane === 'custom' && !!vp._secArrow;
      a.cancelPM();
      const removed = !a.pm && !vp.section && [...ed.display.mats.values()].every((m) => !m.clippingPlanes?.length);
      const ok = panel && clipped && caps && picks > 0 && !cutAway && moved && kept && reopened && removed;
      return ok ? { ok: true, detail: `panel shown; components clipped, capped; ${picks} picks, none cut away; a top face clicked: cut at y = ${at[2].toFixed(2)}; OK kept it, the button opened the panel again, ✗ removed it` }
        : { ok: false, detail: `panel ${panel}, clipped ${clipped}, caps ${caps}, picks ${picks} (cut away ${cutAway}), moved ${moved} (${!!at}), kept ${kept}, reopened ${reopened}, removed ${removed}` };
    } finally {
      if (a.pm?.kind === 'section') a.cancelPM();
      if (vp.section) a.clearSection();
      ed.dirty = false;
      await a.closeTab(a.tabIndex);
    }
  },

  // turning the view about the cursor: zoomed in off the part's centre, a middle-drag started on the part turns
  // about the point under the cursor (it stays there, and a dot shows it while dragging), one started over empty
  // space about that spot at the part's depth; the arrow keys still turn about the part's centre
  async 'rotate-about-cursor'() {
    const a = window.app;
    const text = await (await fetch('/tests/parts/plate-features.rcad')).text();
    await a.openFromFile({ content: text, name: 'Rotate test.rcad', path: null });
    for (let i = 0; i < 80 && !a.result?.bodies?.length; i++) await wait(100);
    const { vp, fire, R, toScreen } = viewEvents();
    try {
      vp.zoomToFit(null, false);
      vp.controls.zoomAt(4, R.left + R.width * 0.7, R.top + R.height * 0.4);
      // a spot on the part far from the middle of the view, and one over empty space
      let on = null, off = null;
      for (let fx = 0.1; fx < 0.95; fx += 0.05) {
        for (let fy = 0.1; fy < 0.95; fy += 0.05) {
          const x = R.left + R.width * fx, y = R.top + R.height * fy, far = Math.hypot(fx - 0.5, fy - 0.5);
          const slot = vp.pickBody({ clientX: x, clientY: y }) ? 'on' : 'off';
          const cur = slot === 'on' ? on : off;
          if (!cur || far > cur.far) { if (slot === 'on') on = { x, y, far }; else off = { x, y, far }; }
        }
      }
      if (!on || !off) return { ok: false, detail: `no spot found on the part (${!!on}) or off it (${!!off})` };
      const turn = async ({ x, y }) => {
        const p = vp.pivotAt({ clientX: x, clientY: y }), b = { button: 1, buttons: 4 };
        const q0 = vp.camera.quaternion.clone();
        fire('pointerdown', x, y, b);
        for (let i = 1; i <= 8; i++) { fire('pointermove', x + i * 15, y - i * 8, b); await wait(10); }
        const dot = !!vp._pivotDot?.visible;
        fire('pointerup', x + 120, y - 64, { ...b, buttons: 0 }); await wait(30);
        const [sx, sy] = toScreen(p);
        return { stays: Math.hypot(sx - x, sy - y), dot, gone: !vp._pivotDot?.visible, turned: q0.angleTo(vp.camera.quaternion) > 0.1 };
      };
      const r1 = await turn(on), r2 = await turn(off);
      // the arrow keys: about the part's centre
      const c = vp.rotationPivot(), [cx, cy] = toScreen(c);
      vp.controls.key({ key: 'ArrowLeft' });
      const [kx, ky] = toScreen(c), keyStays = Math.hypot(kx - cx, ky - cy);
      const ok = [r1, r2].every((r) => r.stays < 0.5 && r.dot && r.gone && r.turned) && keyStays < 0.5;
      return ok ? { ok: true, detail: `on the part: the point stays under the cursor (${r1.stays.toFixed(3)} px); empty space: ${r2.stays.toFixed(3)} px; the pivot shown while dragging; arrow keys about the centre` }
        : { ok: false, detail: `on the part ${JSON.stringify(r1)}; empty space ${JSON.stringify(r2)}; arrow key moved the centre ${keyStays.toFixed(2)} px` };
    } finally {
      a.dirty = false;
      await a.closeTab(a.tabIndex);
    }
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

// The UI tests' names, in the order they run.
export const uiTests = () => Object.keys(UI);

// share (when the run is split over several pages, run_tests.py --jobs): { parts: false } leaves out the parts and
// drawings, { ui: [names] } runs only these UI tests
export async function run(parts, only = null, share = {}) {
  const out = { parts: {}, ui: {}, drawings: {} };
  closeModals();
  for (const p of share.parts === false ? [] : parts) {
    if (only && !only.includes(p.name)) continue;
    try { out.parts[p.name] = await partResult(JSON.parse(p.json)); } catch (e) { out.parts[p.name] = { crash: String(e?.message || e) }; }
  }
  for (const p of share.parts === false ? [] : parts) {
    if (!DRAWING_PARTS.includes(p.name) || (only && !only.includes(p.name) && !only.includes('drawings'))) continue;
    try { out.drawings[p.name] = await drawingResult(JSON.parse(p.json)); } catch (e) { out.drawings[p.name] = { crash: String(e?.message || e) }; }
  }
  for (const [name, fn] of Object.entries(UI)) {
    if (only && !only.includes(name)) continue;
    if (share.ui && !share.ui.includes(name)) continue;
    const t0 = performance.now();
    try { out.ui[name] = await fn(parts); } catch (e) { out.ui[name] = { ok: false, detail: 'crashed: ' + (e?.stack || e) }; }
    out.ui[name].ms = Math.round(performance.now() - t0);
  }
  return out;
}
