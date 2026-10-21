// Exploded views, for assemblies (components) and multi-body parts (bodies): an exploded view is
// a list of steps, each moving some items along a direction by a distance. Only the display moves: the model (and
// the assembly's positions) stay as they are. Shown exploded or collapsed (or animated between the two), with
// dashed explode lines from where each item was.
//
// Stored in the document:  explodes: [{ id, name, steps: [{ id, items: [ids], dir: [x, y, z], dist }] }],
//                          exploded: the id of the exploded view shown (null: collapsed)
//
// The ExplodeTool is the Exploded View Property panel; a host (the assembly editor, or the part app) gives it:
//   host.app, host.vp, host.doc (with explodes / exploded), host.items() → [{ id, name }], host.itemAt(event) → id,
//   host.itemCenter(id) → [x, y, z] (collapsed), host.redisplay() (shows host.offsets()), host.commit(msg),
//   host.pmRoot() → the Property panel element, host.onToolClosed().

import * as THREE from 'three';
import { icon } from './icons.js';
import { fmt } from './expr.js';

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
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
const DIRS = [['+X', [1, 0, 0]], ['−X', [-1, 0, 0]], ['+Y', [0, 1, 0]], ['−Y', [0, -1, 0]], ['+Z', [0, 0, 1]], ['−Z', [0, 0, -1]]];
const dirName = (d) => DIRS.find(([, v]) => v.every((x, i) => Math.abs(x - d[i]) < 1e-9))?.[0] || `(${d.map((x) => fmt(x)).join(', ')})`;

// item id → its offset, from the steps (and a step being made), scaled by t (0 collapsed … 1 exploded)
export function explodeOffsets(ex, extra = null, t = 1) {
  const m = new Map();
  for (const st of [...(ex?.steps || []), ...(extra ? [extra] : [])]) {
    for (const id of st.items) { const o = m.get(id) || [0, 0, 0]; m.set(id, o.map((v, i) => v + st.dir[i] * Number(st.dist || 0) * t)); }
  }
  return m;
}

// A mesh with some of its bodies moved (offsets: body index → [dx, dy, dz]); the mesh given is left as it is.
export function offsetMesh(mesh, offsets) {
  if (!mesh || !offsets.size) return mesh;
  const V = Float32Array.from(mesh.vertices), T = mesh.triangles;
  const seen = new Uint8Array(V.length / 3);
  for (const [bi, o] of offsets) {
    const b = mesh.bodies?.[bi];
    if (!b) continue;
    for (let k = b.triStart; k < b.triStart + b.triCount; k++) {
      const v = T[k];
      if (seen[v]) continue;
      seen[v] = 1;
      V[3 * v] += o[0]; V[3 * v + 1] += o[1]; V[3 * v + 2] += o[2];
    }
  }
  const edges = mesh.edges.map((e) => e);
  for (const [bi, o] of offsets) {
    const b = mesh.bodies?.[bi];
    if (!b) continue;
    for (let k = b.edgeStart; k < b.edgeStart + b.edgeCount; k++) {
      const e = mesh.edges[k], pts = Array.from(e.pts);
      for (let j = 0; j < pts.length; j += 3) { pts[j] += o[0]; pts[j + 1] += o[1]; pts[j + 2] += o[2]; }
      edges[k] = { ...e, pts, mid: e.mid ? e.mid.map((x, i) => x + o[i]) : e.mid };
    }
  }
  return { ...mesh, key: (mesh.key || '') + '|x' + Math.random().toString(36).slice(2, 7), vertices: V, edges };
}

// dashed explode lines (from → to pairs), drawn over the model; returns the group (pass it back to replace)
export function drawExplodeLines(vp, old, pairs) {
  if (old) { vp.overlayGroup.remove(old); old.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); }
  if (!pairs.length) return null;
  const g = new THREE.Group();
  const w = vp.worldPerPixel();
  for (const [a, b] of pairs) {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]),
      new THREE.LineDashedMaterial({ color: 0xc2410c, dashSize: 6 * w, gapSize: 4 * w, depthTest: false, transparent: true, opacity: 0.85 }));
    l.computeLineDistances();
    l.renderOrder = 15;
    g.add(l);
  }
  vp.overlayGroup.add(g);
  return g;
}

export function newExplodeId(list) { let k = 1; while (list.some((x) => x.id === 'ex' + k)) k++; return 'ex' + k; }

// ------------------------------------------------------------------ the Exploded View Property panel
export class ExplodeTool {
  constructor(host) {
    this.host = host;
    this.ex = null;        // the exploded view being edited (a working copy)
    this.sel = new Set();  // the items of the step being made
    this.dir = [0, 1, 0];
    this.dist = 0;
    this.editStep = null;  // id of a step being changed
    this.lines = true;
  }
  get app() { return this.host.app; }
  get vp() { return this.host.vp; }

  open(id = null) {
    const list = (this.host.doc.explodes ||= []);
    const ex = id ? list.find((x) => x.id === id) : null;
    this.orig = ex ? JSON.stringify(ex) : null;
    this.ex = ex ? JSON.parse(JSON.stringify(ex)) : { id: newExplodeId(list), name: `ExplView${list.length + 1}`, steps: [] };
    this.sel.clear();
    this.dist = 0;
    this.editStep = null;
    this.host.doc.exploded = this.ex.id;
    this.vp.setLeftRotate(false);
    this.app.status('Exploded View: click components / bodies, pick a direction, then drag them (or type the distance) and Add Step. The middle button turns the view.');
    this.refresh();
  }
  close(keep) {
    const list = this.host.doc.explodes;
    if (keep) {
      this.commitPending();
      const i = list.findIndex((x) => x.id === this.ex.id);
      if (this.ex.steps.length) { if (i >= 0) list[i] = this.ex; else list.push(this.ex); }
      else if (i >= 0) list.splice(i, 1);
      this.host.doc.exploded = this.ex.steps.length ? this.ex.id : null;
    } else {
      // (as it was)
      if (this.orig) { const i = list.findIndex((x) => x.id === this.ex.id); if (i >= 0) list[i] = JSON.parse(this.orig); }
      else if (this.host.doc.exploded === this.ex.id) this.host.doc.exploded = null;
    }
    const name = this.ex.name;
    this.ex = null;
    this.vp.setLeftRotate(true);
    this.host.onToolClosed();
    this.host.redisplay();
    if (keep) this.host.commit(`${name} kept. Right-click it in the tree to collapse, explode or animate it.`);
  }

  // the step being made, as a step (or null when it moves nothing)
  pending() { return this.sel.size && Number(this.dist) ? { id: this.editStep || '__pending', items: [...this.sel], dir: this.dir.slice(), dist: Number(this.dist) } : null; }
  commitPending() {
    const st = this.pending();
    if (!st) return false;
    if (this.editStep) { const i = this.ex.steps.findIndex((x) => x.id === this.editStep); if (i >= 0) this.ex.steps[i] = { ...st, id: this.editStep }; }
    else { let k = 1; while (this.ex.steps.some((x) => x.id === 's' + k)) k++; this.ex.steps.push({ ...st, id: 's' + k }); }
    this.sel.clear(); this.dist = 0; this.editStep = null;
    return true;
  }
  // the offsets now shown: the steps (less the one being changed) and the step being made
  offsets() {
    if (!this.ex) return new Map();
    const steps = this.editStep ? { ...this.ex, steps: this.ex.steps.filter((s) => s.id !== this.editStep) } : this.ex;
    return explodeOffsets(steps, this.pending());
  }
  refresh() { this.host.redisplay(); this.renderPM(); }

  addStep() {
    if (!this.sel.size) { this.app.toast('Click the components / bodies to move first'); return; }
    if (!Number(this.dist)) { this.app.toast('Drag them, or type a distance, first'); return; }
    this.commitPending();
    this.refresh();
    this.app.status('Step added. Pick the next items to move, or ✔ to finish.');
  }
  // the selected items spaced out along the direction, one step each (each a size further than the last)
  spreadOut() {
    const ids = [...this.sel];
    if (ids.length < 1) { this.app.toast('Click the components / bodies to spread out first'); return; }
    const gap = Number(this.dist) || this.host.itemSize?.(ids[0]) || 50;
    const along = (id) => { const c = this.host.itemCenter(id); return c[0] * this.dir[0] + c[1] * this.dir[1] + c[2] * this.dir[2]; };
    ids.sort((a, b) => along(a) - along(b));
    ids.forEach((id, k) => { let n = 1; while (this.ex.steps.some((x) => x.id === 's' + n)) n++; this.ex.steps.push({ id: 's' + n, items: [id], dir: this.dir.slice(), dist: Math.round(gap * (k + 1) * 1000) / 1000 }); });
    this.sel.clear(); this.dist = 0;
    this.refresh();
  }

  // ---- viewport
  click(e) {
    const id = this.host.itemAt(e);
    if (!id) return;
    if (this.pickDir) {
      // a face's normal (outward) as the direction
      const n = this.host.faceNormalAt?.(e);
      this.pickDir = false;
      if (n) { this.dir = unit(n).map((x) => Math.round(x * 1e9) / 1e9); this.refresh(); }
      return;
    }
    this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id);
    this.refresh();
  }
  down(e) {
    if (e.button !== 0 || this.pickDir) return false;
    const id = this.host.itemAt(e);
    if (!id || !this.sel.has(id)) return false;
    const dir = new THREE.Vector3(...this.dir).normalize();
    const off = this.offsets().get(id) || [0, 0, 0];
    const o = new THREE.Vector3(...this.host.itemCenter(id).map((x, i) => x + off[i]));
    // (dragged along the direction as the screen shows it; seen end on, up the screen is toward the viewer)
    this.drag = { o, dir, from: { clientX: e.clientX, clientY: e.clientY }, dist0: Number(this.dist) || 0, x: e.clientX, y: e.clientY };
    return true;
  }
  move(e) {
    const d = this.drag;
    if (!d) return false;
    const s = this.vp.dragAlong(d.dir, d.o, d.from, e);
    const step = Math.max(0.5, this.vp.worldPerPixel() * 4);
    this.dist = Math.round((d.dist0 + s) / step) * step;
    this.dist = Math.round(this.dist * 1000) / 1000;
    this.host.redisplay();
    this.updateDistField();
    return true;
  }
  up() { if (!this.drag) return false; this.drag = null; this.renderPM(); return true; }
  key(e) {
    if (e.key === 'Escape') { if (this.pickDir) { this.pickDir = false; this.renderPM(); } else this.close(false); return true; }
    if (e.key === 'Enter' && !e.target.closest?.('input')) { this.close(true); return true; }
    return false;
  }

  updateDistField() { const i = this.host.pmRoot()?.querySelector('.ex-dist input'); if (i && document.activeElement !== i) i.value = String(this.dist); }

  // ---- the Property panel
  renderPM() {
    const root = this.host.pmRoot();
    if (!root || !this.ex) return;
    const ui = this.app.ui;
    root.innerHTML = '';
    ui.showLeft('pm');
    root.appendChild(el('div', { class: 'pm-head' }, `<span class="ti">${icon('explode')}</span><span>${esc(this.ex.name)}</span>`));
    const act = el('div', { class: 'pm-actions' });
    act.appendChild(el('button', { title: 'Keep the exploded view', onclick: () => this.close(true) }, icon('ok')));
    act.appendChild(el('button', { title: 'Cancel (Esc)', onclick: () => this.close(false) }, icon('cancel')));
    root.appendChild(act);
    const names = new Map(this.host.items().map((x) => [x.id, x.name]));

    const g1 = ui.pmGroup(root, this.editStep ? 'Change Step' : 'Explode Step', 'ex:step');
    const list = el('div', { class: 'pm-list' });
    for (const id of this.sel) {
      const li = el('div', { class: 'li sel' }, `<span>${esc(names.get(id) || id)}</span><span class="x" title="Remove">✕</span>`);
      li.querySelector('.x').onclick = () => { this.sel.delete(id); this.refresh(); };
      list.appendChild(li);
    }
    if (!this.sel.size) list.appendChild(el('div', { class: 'pm-hint', style: 'padding:4px 6px' }, 'Click the items to move in the view (click again to drop one).'));
    g1.appendChild(list);
    g1.appendChild(el('div', { class: 'pm-label' }, 'Direction'));
    const db = el('div', { class: 's3-planes ex-dirs' });
    for (const [label, v] of DIRS) {
      const b = el('button', { class: 's3-plane' + (v.every((x, i) => Math.abs(x - this.dir[i]) < 1e-9) ? ' active' : '') }, label);
      b.onclick = () => { this.dir = v.slice(); this.refresh(); };
      db.appendChild(b);
    }
    g1.appendChild(db);
    const pick = el('button', { class: 'pm-btn' + (this.pickDir ? ' active' : '') }, this.pickDir ? 'Click a flat face…' : `Along a face's normal (now ${dirName(this.dir)})`);
    pick.onclick = () => { this.pickDir = !this.pickDir; this.renderPM(); this.app.status(this.pickDir ? 'Click a flat face: its normal becomes the direction.' : 'Ready'); };
    if (this.host.faceNormalAt) g1.appendChild(pick);
    g1.appendChild(el('label', { class: 'pm-label' }, 'Distance (or drag a selected item)'));
    const dw = el('div', { class: 'ex-dist' });
    dw.appendChild(ui.exprInput(this.dist, 'mm', (v) => { if (Number.isFinite(+v)) { this.dist = +v; this.host.redisplay(); } }));
    g1.appendChild(dw);
    const bar = el('div', { class: 's3-rels' });
    const addB = el('button', { class: 'pm-btn' }, this.editStep ? 'Done Changing Step' : 'Add Step');
    addB.onclick = () => this.addStep();
    const spread = el('button', { class: 'pm-btn', title: 'Each selected item its own step, spaced out one after the other along the direction (the distance is the spacing)' }, 'Spread Out');
    spread.onclick = () => this.spreadOut();
    bar.append(addB, spread);
    g1.appendChild(bar);

    const g2 = ui.pmGroup(root, `Explode Steps (${this.ex.steps.length})`, 'ex:steps');
    const sl = el('div', { class: 'pm-list' });
    this.ex.steps.forEach((st, i) => {
      const li = el('div', { class: 'li' + (this.editStep === st.id ? ' sel' : '') }, `<span>${i + 1}. ${esc(st.items.map((x) => names.get(x) || x).join(', '))} — ${dirName(st.dir)} ${fmt(st.dist)} mm</span><span class="x" title="Delete">✕</span>`);
      li.querySelector('.x').onclick = (e) => { e.stopPropagation(); this.ex.steps.splice(i, 1); if (this.editStep === st.id) { this.editStep = null; this.sel.clear(); this.dist = 0; } this.refresh(); };
      li.onclick = () => { this.commitPending(); this.editStep = st.id; this.sel = new Set(st.items); this.dir = st.dir.slice(); this.dist = st.dist; this.refresh(); };
      sl.appendChild(li);
    });
    if (!this.ex.steps.length) sl.appendChild(el('div', { class: 'pm-hint', style: 'padding:4px 6px' }, 'No steps yet.'));
    g2.appendChild(sl);
    const lc = el('label', { class: 'pm-check' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = this.lines;
    cb.onchange = () => { this.lines = cb.checked; this.host.showLines = cb.checked; this.host.redisplay(); };
    lc.append(cb, document.createTextNode(' Explode lines'));
    g2.appendChild(lc);
    g2.appendChild(el('div', { class: 'pm-hint' }, 'Click a step to change it. ✔ keeps the exploded view (shown exploded); the model itself does not move.'));
  }
}

// Animate between collapsed and exploded: calls show(t) with t going from a to b over ms, then done().
export function animateExplode(show, a, b, done, ms = 1200) {
  const t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / ms), s = k * k * (3 - 2 * k);
    show(a + (b - a) * s);
    if (k < 1) { if (document.hidden) setTimeout(tick, 16); else requestAnimationFrame(tick); } else done?.();
  };
  tick();
}
