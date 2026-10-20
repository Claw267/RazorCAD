// Motion studies, for assemblies: one driver moves the assembly step by step and the mates (gear and
// rack-pinion mates too) carry the rest along; the steps are then played back. The assembly's own positions are
// put back afterwards: a motion study only shows how the assembly moves.
//
// Stored in the assembly:  motions: [{ id, name, driver, steps, duration, loop }]
//   driver: { kind: 'turn', comp, mate, side, amount (°) }   turns comp about the axis of one of its mates' references
//           { kind: 'slide', comp, mate, side, amount (mm) } slides comp along that reference (an axis, or a face's normal)
//           { kind: 'mate', mate, to }                      a Distance or Angle mate's value from its own to `to`
//
// motionFrames(view, study, solve) works the motion out: view = { components, mates } (as the assembly shows them;
// they are moved), solve(view, opts) the assembly solver. Returns { frames: [[{ id, pos, rot }]], done, error }.
// The MotionTool is the Motion Study Property panel; its host is the assembly editor.

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

const ORIGIN = '#origin';
// The references a component can be driven by: those of its mates (axes turn or slide it; flat faces slide it
// along their normal).
export function driverRefs(view, compId) {
  const out = [];
  for (const m of view.mates || []) for (const side of ['a', 'b']) {
    const r = m[side];
    if (r?.comp !== compId) continue;
    if (r.kind === 'axis' || r.kind === 'plane') out.push({ mate: m.id, side, kind: r.kind, label: `${m.name}: ${r.what || (r.kind === 'axis' ? 'Axis' : 'Face')}` });
  }
  return out;
}

// a reference of a component, in the world (its pose now)
function worldRef(c, r) {
  const q = new THREE.Quaternion(...c.rot);
  const p = new THREE.Vector3(...r.p).applyQuaternion(q).add(new THREE.Vector3(...c.pos));
  const d = new THREE.Vector3(...(r.d || r.n)).applyQuaternion(q).normalize();
  return { p, d };
}

export function motionFrames(view, study, solve) {
  const D = study.driver || {}, n = Math.max(1, Math.min(2000, Math.round(Number(study.steps) || 1)));
  const comps = view.components, byId = new Map(comps.map((c) => [c.id, c]));
  const snap = () => comps.map((c) => ({ id: c.id, pos: c.pos.slice(), rot: c.rot.slice() }));
  const frames = [snap()];
  let mate = null, ref = null, comp = null, v0 = 0;
  if (D.kind === 'mate') {
    mate = (view.mates || []).find((m) => m.id === D.mate);
    if (!mate) return { frames, done: 0, error: 'Choose the mate to drive' };
    v0 = Number(mate.value) || 0;
  } else {
    comp = byId.get(D.comp);
    if (!comp) return { frames, done: 0, error: 'Choose the component to move' };
    if (comp.fixed) return { frames, done: 0, error: `${comp.name} is fixed: float it, or drive another component` };
    const m = (view.mates || []).find((x) => x.id === D.mate);
    ref = m?.[D.side];
    if (!ref || ref.comp !== comp.id) return { frames, done: 0, error: 'Choose the axis (or face) to move it by' };
    if (D.kind === 'turn' && ref.kind !== 'axis') return { frames, done: 0, error: 'Turning needs an axis (a round face or edge of one of its mates)' };
  }
  const amount = Number(D.kind === 'mate' ? D.to : D.amount) || 0;
  for (let k = 1; k <= n; k++) {
    if (D.kind === 'mate') {
      mate.value = v0 + ((amount - v0) * k) / n;
      const r = solve(view, {});
      if (!r.ok) { mate.value = v0 + ((amount - v0) * (k - 1)) / n; return { frames, done: k - 1, error: `The mates can't follow past step ${k - 1} of ${n} (${fmt(mate.value, 3)})` }; }
    } else {
      // the driven component moved by one step (about / along its reference as it is now), the rest solved with it held
      const { p, d } = worldRef(comp, ref);
      if (D.kind === 'turn') {
        const dq = new THREE.Quaternion().setFromAxisAngle(d, ((amount / n) * Math.PI) / 180);
        const pos = new THREE.Vector3(...comp.pos).sub(p).applyQuaternion(dq).add(p);
        const q = dq.multiply(new THREE.Quaternion(...comp.rot));
        comp.pos = pos.toArray(); comp.rot = [q.x, q.y, q.z, q.w];
      } else comp.pos = comp.pos.map((x, i) => x + d.getComponent(i) * (amount / n));
      const r = solve(view, { pinned: new Set([comp.id]) });
      if (!r.ok) return { frames, done: k - 1, error: `The mates can't follow past step ${k - 1} of ${n} (${fmt(((k - 1) * amount) / n, 3)}${D.kind === 'turn' ? '°' : ' mm'})` };
    }
    frames.push(snap());
  }
  return { frames, done: n, error: null };
}

export class MotionTool {
  constructor(host) {
    this.host = host;
    this.study = null;
    this.frames = null;
    this.frame = 0;
    this.playing = false;
  }
  get app() { return this.host.app; }

  open(id = null) {
    const list = (this.host.doc.motions ||= []);
    const st = id ? list.find((x) => x.id === id) : null;
    let k = 1;
    while (list.some((x) => x.id === 'mo' + k)) k++;
    const free = this.host.doc.components.find((c) => !c.fixed && !this.host.eff(c).suppressed);
    const first = free && driverRefs(this.host.view(), free.id).find((r) => r.kind === 'axis');
    this.study = st ? JSON.parse(JSON.stringify(st)) : { id: 'mo' + k, name: `Motion${list.length + 1}`, driver: { kind: 'turn', comp: free?.id || null, mate: first?.mate || null, side: first?.side || null, amount: 360 }, steps: 72, duration: 4, loop: true };
    // (the assembly as it is now: put back when the panel closes)
    this.before = JSON.stringify({ comps: this.host.doc.components, mates: this.host.doc.mates });
    this.frames = null;
    this.frame = 0;
    this.app.status('Motion Study: choose what drives the motion, then Play. The assembly goes back as it was when the panel closes.');
    this.renderPM();
  }
  restore() {
    const b = JSON.parse(this.before);
    this.host.doc.components.forEach((c, i) => { const o = b.comps[i]; if (o && o.id === c.id) { c.pos = o.pos; c.rot = o.rot; } });
    this.host.doc.mates.forEach((m, i) => { const o = b.mates[i]; if (o && o.id === m.id) { if ('ref' in o) m.ref = o.ref; m.value = o.value; } });
  }
  close(keep) {
    this.stop();
    this.restore();
    if (keep) {
      const list = this.host.doc.motions;
      const i = list.findIndex((x) => x.id === this.study.id);
      if (i >= 0) list[i] = this.study; else list.push(this.study);
    }
    const name = this.study.name;
    this.study = null; this.frames = null;
    this.host.onMotionClosed();
    if (keep) this.host.commit(`${name} kept: double-click it in the tree to play it.`);
  }
  // works the motion out (again), from the assembly as it was when the panel opened
  compute() {
    this.stop();
    this.restore();
    const view = this.host.view();
    const r = motionFrames(view, this.study, (v, o) => this.host.solveView(v, o));
    this.restore();
    this.frames = r.frames;
    this.error = r.error;
    this.frame = 0;
    return r;
  }
  show(i) {
    if (!this.frames?.length) return;
    this.frame = Math.max(0, Math.min(this.frames.length - 1, i));
    const byId = new Map(this.host.doc.components.map((c) => [c.id, c]));
    for (const f of this.frames[this.frame]) { const c = byId.get(f.id); if (c) { c.pos = f.pos; c.rot = f.rot; } }
    this.host.buildMesh();
    const s = this.slider;
    if (s) s.value = String(this.frame);
  }
  play() {
    if (!this.frames) this.compute();
    if (!this.frames || this.frames.length < 2) { this.renderPM(); return; }
    this.playing = true;
    const n = this.frames.length - 1, dur = Math.max(0.2, Number(this.study.duration) || 4) * 1000;
    const start = performance.now() - (this.frame / n) * dur;
    const tick = () => {
      if (!this.playing || !this.study) return;
      let t = (performance.now() - start) / dur;
      if (t >= 1 && !this.study.loop) { this.show(n); this.playing = false; this.renderPM(); return; }
      t %= 1;
      this.show(Math.round(t * n));
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
    this.renderPM();
  }
  stop() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
  changed() { this.frames = null; this.stop(); this.restore(); this.host.buildMesh(); this.renderPM(); }
  key(e) {
    if (!this.study) return false;
    if (e.key === 'Escape') { this.close(false); return true; }
    if (e.key === ' ' && !e.target.closest?.('input, select, textarea')) { e.preventDefault(); this.playing ? (this.stop(), this.renderPM()) : this.play(); return true; }
    return false;
  }

  renderPM() {
    const root = this.host.pmRoot();
    if (!root || !this.study) return;
    const ui = this.app.ui, st = this.study, D = st.driver, view = this.host.view();
    root.innerHTML = '';
    ui.showLeft('pm');
    root.appendChild(el('div', { class: 'pm-head' }, `<span class="ti">${icon('motion')}</span><span>${esc(st.name)}</span>`));
    const act = el('div', { class: 'pm-actions' });
    act.appendChild(el('button', { title: 'Keep this motion study', onclick: () => this.close(true) }, icon('ok')));
    act.appendChild(el('button', { title: 'Close (Esc)', onclick: () => this.close(false) }, icon('cancel')));
    root.appendChild(act);
    const sel = (opts, value, onchange) => { const s = el('select'); for (const [v, l] of opts) { const o = el('option', { value: v }, esc(l)); if (String(v) === String(value ?? '')) o.selected = true; s.appendChild(o); } s.onchange = () => onchange(s.value); return s; };

    const g1 = ui.pmGroup(root, 'Driver', 'mo:drv');
    g1.appendChild(ui.row('Name', (() => { const i = el('input', { type: 'text', value: st.name }); i.onchange = () => { st.name = i.value.trim() || st.name; }; return i; })()));
    g1.appendChild(ui.row('Drive by', sel([['turn', 'Turning a component'], ['slide', 'Sliding a component'], ['mate', 'Changing a mate\'s value']], D.kind, (v) => {
      D.kind = v;
      if (v === 'mate') { const m = view.mates.find((x) => x.type === 'distance' || x.type === 'angle'); D.mate = m?.id || null; D.to = m ? (Number(m.value) || 0) + (m.type === 'angle' ? 90 : 20) : 0; }
      else { const refs = driverRefs(view, D.comp).filter((r) => v === 'slide' || r.kind === 'axis'); D.mate = refs[0]?.mate || null; D.side = refs[0]?.side || null; D.amount = v === 'turn' ? 360 : 50; }
      this.changed();
    })));
    if (D.kind === 'mate') {
      const ms = view.mates.filter((x) => x.type === 'distance' || x.type === 'angle');
      g1.appendChild(ui.row('Mate', sel(ms.length ? ms.map((m) => [m.id, `${m.name} (now ${fmt(Number(m.value) || 0, 3)}${m.type === 'angle' ? '°' : ''})`]) : [['', '— no Distance or Angle mate —']], D.mate, (v) => { D.mate = v; this.changed(); })));
      const m = ms.find((x) => x.id === D.mate);
      g1.appendChild(ui.row('To', ui.exprInput(D.to ?? 0, m?.type === 'angle' ? '°' : 'mm', (v) => { D.to = Number(v); this.changed(); })));
    } else {
      const comps = this.host.doc.components.filter((c) => !c.fixed && !this.host.eff(c).suppressed);
      g1.appendChild(ui.row('Component', sel(comps.length ? comps.map((c) => [c.id, c.name]) : [['', '— every component is fixed —']], D.comp, (v) => {
        D.comp = v;
        const refs = driverRefs(view, v).filter((r) => D.kind === 'slide' || r.kind === 'axis');
        D.mate = refs[0]?.mate || null; D.side = refs[0]?.side || null;
        this.changed();
      })));
      const refs = driverRefs(view, D.comp).filter((r) => D.kind === 'slide' || r.kind === 'axis');
      g1.appendChild(ui.row(D.kind === 'turn' ? 'About' : 'Along', sel(refs.length ? refs.map((r) => [`${r.mate}|${r.side}`, r.label]) : [['', D.kind === 'turn' ? '— mate it on an axis first (Concentric) —' : '— mate it first —']], D.mate ? `${D.mate}|${D.side}` : '', (v) => { [D.mate, D.side] = v.split('|'); this.changed(); })));
      g1.appendChild(ui.row(D.kind === 'turn' ? 'Angle' : 'Distance', ui.exprInput(D.amount ?? 0, D.kind === 'turn' ? '°' : 'mm', (v) => { D.amount = Number(v); this.changed(); })));
    }
    const g2 = ui.pmGroup(root, 'Playback', 'mo:play');
    g2.appendChild(ui.row('Steps', ui.exprInput(st.steps, '', (v) => { st.steps = Math.max(1, Math.min(2000, Math.round(Number(v) || 1))); this.changed(); }, { min: 1 })));
    g2.appendChild(ui.row('Duration', ui.exprInput(st.duration, 's', (v) => { st.duration = Math.max(0.2, Number(v) || 4); this.stop(); this.renderPM(); }, { min: 0.2 })));
    const loop = el('label', {}, `<input type="checkbox" ${st.loop ? 'checked' : ''}> Loop`);
    loop.querySelector('input').onchange = (e) => { st.loop = e.target.checked; };
    g2.appendChild(loop);
    const bar = el('div', { class: 'mo-bar' });
    const pb = el('button', { class: 'pm-btn primary' }, this.playing ? '■ Stop' : '▶ Play');
    pb.onclick = () => { if (this.playing) { this.stop(); this.renderPM(); } else this.play(); };
    const rw = el('button', { class: 'pm-btn', title: 'Back to the start' }, '⏮');
    rw.onclick = () => { this.stop(); if (!this.frames) this.compute(); this.show(0); this.renderPM(); };
    bar.append(rw, pb);
    g2.appendChild(bar);
    if (this.frames?.length > 1) {
      const s = el('input', { type: 'range', min: '0', max: String(this.frames.length - 1), step: '1', value: String(this.frame), class: 'mo-slider' });
      s.oninput = () => { this.stop(); this.show(+s.value); };
      this.slider = s;
      g2.appendChild(s);
    } else this.slider = null;
    if (this.error) g2.appendChild(el('div', { class: 'pm-msg err' }, esc(this.error)));
    else if (this.frames) g2.appendChild(el('div', { class: 'pm-hint' }, `${this.frames.length - 1} steps worked out. Drag the slider to go through them; Space plays and stops.`));
    root.appendChild(el('div', { class: 'pm-hint', style: 'padding:6px 10px' }, 'The motion is worked out step by step: the mates (gear and rack-pinion mates too) carry the other components along. The assembly goes back as it was when the panel closes.'));
  }
}
