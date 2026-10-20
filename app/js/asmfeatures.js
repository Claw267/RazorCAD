// Assembly features: holes and cuts made in the assembly, through the components they pass. The parts' own files
// are not changed: each component cut gets the feature added to its copy of its part (placed in that part's
// coordinates), so the assembly, its drawings and its exports show it.
//
// Stored in the assembly:  asmFeatures: [{ id, name, type: 'hole' | 'cut', suppressed,
//   at: { comp, n, pts: [[x, y, z]…], u },   on a flat face of `comp` (its coordinates): the face's outward normal,
//                                            the points clicked on it, an in-plane direction (for cuts)
//   holeType 'simple' | 'cbore' | 'csink' | 'tapped', size (M8… or 'custom'), fit, diameter, cboreD, cboreDepth,
//   csinkD, csinkAngle, thread (tapped), tapLast (the last component tapped for the size)   (holes)
//   w, l, angle                                                                              (rectangular cuts)
//   end 'through' | 'blind', depth,
//   comps: [{ id, role: 'first' | 'next' | 'last' }] }]     the components it cuts, in order along it
//
// asmPartFeatures (asmcuts.js): the part features each component cut gets. The HoleTool is the Assembly Hole / Cut Property panel; its host is the assembly editor.

import * as THREE from 'three';
import { icon } from './icons.js';
import { fmt } from './expr.js';
import { HOLE_SIZES, holeSpec } from './holes.js';
import { threadList } from './threads.js';
import { rayHits } from './collide.js';
import { STD_TYPES, setParts, heightOf, fitLength } from './stdparts.js';
import { asmPartFeatures, qrot, toWorld, toLocal, r6 } from './asmcuts.js';

export { asmPartFeatures };

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

// The hole's drill diameter (what a fastener goes through), as the part feature makes it
export function holeDiameter(f, role = 'first') {
  const pf = asmPartFeatures({ components: [{ id: 'a', pos: [0, 0, 0], rot: [0, 0, 0, 1], part: 'p' }], parts: [{ id: 'p', doc: {} }], asmFeatures: [{ ...f, at: { comp: 'a', n: [0, 0, 1], pts: [[0, 0, 0]] }, comps: [{ id: 'a', role }] }] }).get('a')?.[0];
  try { return holeSpec(pf, (x) => Number(x)).d; } catch { return null; }
}

// The fasteners that suit a hole size: [type id, label]
export function fastenerTypes(size) {
  return [['none', 'None'], ...['hexBolt', 'socketScrew', 'countersunkScrew'].map((id) => STD_TYPES.find((t) => t.id === id)).filter((t) => t && t.sizes.includes(size)).map((t) => [t.id, t.label])];
}

export class HoleTool {
  constructor(host) { this.host = host; this.f = null; }
  get app() { return this.host.app; }

  open(id = null, type = 'hole') {
    const list = (this.host.doc.asmFeatures ||= []);
    const old = id ? list.find((x) => x.id === id) : null;
    let k = 1;
    while (list.some((x) => x.id === 'af' + k)) k++;
    const n = list.filter((x) => x.type === type).length + 1;
    const p = this.app.ui.prefs?.asmHole || {};
    this.f = old ? JSON.parse(JSON.stringify(old)) : {
      id: 'af' + k, name: type === 'cut' ? `Cut${n}` : `Hole${n}`, type, at: null,
      holeType: 'simple', size: 'M8', fit: 'normal', diameter: 9, cboreD: 15, cboreDepth: 8.6, csinkD: 18.3, csinkAngle: 90, thread: 'M8', tapLast: false,
      w: 20, l: 10, angle: 0, end: 'through', depth: 10, comps: [],
    };
    this.edit = !!old;
    this.fast = { kind: p.kind || 'none', washer: p.washer ?? true, nut: p.nut ?? true };
    this.app.status(this.f.type === 'cut' ? 'Assembly Cut: click points on a flat face of a component for the cut, then set its size.' : 'Assembly Hole: click points on a flat face of a component for the holes; they go through the components behind it.');
    this.markers();
    this.renderPM();
  }
  close() {
    this.f = null;
    this.host.vp.setVertexMarkers?.(null);
    this.host.onHoleToolClosed();
  }
  key(e) {
    if (!this.f) return false;
    if (e.key === 'Escape') { this.close(); return true; }
    if (e.key === 'Enter' && !e.target.closest?.('input, select, textarea')) { this.ok(); return true; }
    return false;
  }
  // a point clicked on a flat face (the first sets the face; then more on the same face)
  click(e) {
    const h = this.host, ch = h.compAt(e);
    if (!ch) return;
    const l = h._leaves?.[ch.leaf], mesh = l && h.parts.get(l.gk)?.mesh, s = mesh?.faceGroups[ch.hit.face]?.surf;
    if (!l || l.chain.length) { this.app.toast('Pick a face of a part in this assembly (not inside a sub-assembly)'); return; }
    if (s?.t !== 'PLANE') { this.app.toast('Pick a flat face'); return; }
    const c = l.comp, p = toLocal(c, ch.hit.point.toArray()).map(r6), nn = s.n.map(r6);
    const at = this.f.at;
    const same = at && at.comp === c.id && at.n.every((x, k) => Math.abs(x - nn[k]) < 1e-6) && Math.abs(at.n.reduce((t, x, k) => t + x * (p[k] - at.pts[0][k]), 0)) < 1e-4;
    if (same) at.pts.push(p);
    else {
      const u = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], d = u.reduce((t, x, k) => t + x * nn[k], 0);
      this.f.at = { comp: c.id, n: nn, pts: [p], u: u.map((x, k) => r6(x - d * nn[k])) };
    }
    this.detect();
    this.markers();
    this.renderPM();
  }
  markers() {
    const at = this.f?.at, c = at && this.host.comp(at.comp);
    this.host.vp.setVertexMarkers?.(c ? { selected: at.pts.map((p) => new THREE.Vector3(...toWorld(c, p))), hover: null } : null);
  }
  // the components it passes through (from the clicked points, along the hole, behind the face), in order
  detect() {
    const h = this.host, f = this.f, at = f.at, A = at && h.comp(at.comp);
    if (!A) { f.comps = []; return; }
    const leaves = h.leaves(), items = h.collideItems(leaves), nW = qrot(A.rot, at.n), dir = nW.map((x) => -x);
    const reach = f.end === 'blind' ? Number(f.depth) || 0 : Infinity;
    const first = new Map();
    // (a cut's corners too)
    const uW = qrot(A.rot, at.u || [1, 0, 0]), vW = [nW[1] * uW[2] - nW[2] * uW[1], nW[2] * uW[0] - nW[0] * uW[2], nW[0] * uW[1] - nW[1] * uW[0]];
    const offs = f.type === 'cut' ? [[0, 0], ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [a * 0.45 * f.w, b * 0.45 * f.l])] : [[0, 0]];
    for (const p0 of at.pts) for (const [a, b] of offs) {
      const pw = toWorld(A, p0).map((x, k) => x + uW[k] * a + vW[k] * b + nW[k] * 0.01);
      leaves.forEach((l, i) => {
        if (l.chain.length || !items[i]) return;
        const t = rayHits(items[i].mesh, items[i].matrix, pw, dir).find((x) => x > 0);
        if (t === undefined || t > reach + 0.01) return;
        if (!first.has(l.comp.id) || t < first.get(l.comp.id)) first.set(l.comp.id, t);
      });
    }
    if (!first.has(A.id)) first.set(A.id, 0);
    const ids = [...first].sort((x, y) => (x[0] === A.id ? -1 : y[0] === A.id ? 1 : x[1] - y[1])).map(([id]) => id);
    const off = new Set((f.comps || []).filter((e) => e.off).map((e) => e.id));
    f.comps = ids.map((id, i) => ({ id, role: i === 0 ? 'first' : i === ids.length - 1 ? 'last' : 'next', ...(off.has(id) ? { off: true } : {}) }));
  }
  async ok() {
    const f = this.f, h = this.host;
    if (!f.at?.pts?.length) { this.app.toast(f.type === 'cut' ? 'Click a point on a flat face for the cut first' : 'Click points on a flat face for the holes first'); return; }
    if (f.end === 'blind' && !(Number(f.depth) > 0)) { this.app.toast('The depth must be greater than zero'); return; }
    if (f.type === 'cut' && !(f.w > 0 && f.l > 0)) { this.app.toast('The cut needs a width and a length'); return; }
    const feat = { ...f, comps: f.comps.filter((e) => !e.off) };
    // (the roles again over the components kept)
    feat.comps = feat.comps.map((e, i) => ({ id: e.id, role: i === 0 && e.id === f.at.comp ? 'first' : i === feat.comps.length - 1 && i > 0 ? 'last' : 'next' }));
    const ui = this.app.ui;
    (ui.prefs ||= {}).asmHole = this.fast;
    ui.savePrefs?.();
    const fast = f.type === 'hole' && this.fast.kind !== 'none' && fastenerTypes(f.size).some(([id]) => id === this.fast.kind) ? { ...this.fast } : null;
    const edit = this.edit;
    this.close();
    h.begin();
    const list = (h.doc.asmFeatures ||= []), i = list.findIndex((x) => x.id === feat.id);
    if (i >= 0) list[i] = feat; else list.push(feat);
    await h.loadParts();
    h.solve();
    const nComp = feat.comps.length;
    h.change(`${feat.name} ${edit ? 'changed' : 'made'}: ${feat.at.pts.length} ${feat.type === 'cut' ? 'cut' : 'hole'}${feat.at.pts.length === 1 ? '' : 's'} through ${nComp} component${nComp === 1 ? '' : 's'}.`);
    if (fast) await h.fastenHoles(feat, fast);
  }

  renderPM() {
    const root = this.host.pmRoot();
    if (!root || !this.f) return;
    const ui = this.app.ui, f = this.f, h = this.host;
    root.innerHTML = '';
    ui.showLeft('pm');
    root.appendChild(el('div', { class: 'pm-head' }, `<span class="ti">${icon(f.type === 'cut' ? 'asmCut' : 'asmHole')}</span><span>${esc(f.name)}</span>`));
    const act = el('div', { class: 'pm-actions' });
    act.appendChild(el('button', { title: 'OK (Enter)', onclick: () => this.ok() }, icon('ok')));
    act.appendChild(el('button', { title: 'Close (Esc)', onclick: () => this.close() }, icon('cancel')));
    root.appendChild(act);
    const sel = (opts, value, onchange) => { const s = el('select'); for (const [v, l] of opts) { const o = el('option', { value: v }, esc(l)); if (String(v) === String(value ?? '')) o.selected = true; s.appendChild(o); } s.onchange = () => onchange(s.value); return s; };
    const num = (key, unit, again = false) => ui.exprInput(f[key], unit, (v) => { f[key] = Number(v); if (again) { this.detect(); this.renderPM(); } }, { min: 0 });

    const g0 = ui.pmGroup(root, 'Position', 'af:pos');
    const at = f.at, A = at && h.comp(at.comp);
    g0.appendChild(el('div', { class: 'pm-hint' }, A ? `${at.pts.length} point${at.pts.length === 1 ? '' : 's'} on a face of ${esc(A.name)}. Click more on the same face; clicking another face starts again.` : 'Click points on a flat face of a component.'));
    if (at?.pts.length) g0.appendChild(el('button', { class: 'pm-btn', onclick: () => { f.at = null; f.comps = []; this.markers(); this.renderPM(); } }, 'Clear the points'));

    if (f.type === 'cut') {
      const g = ui.pmGroup(root, 'Rectangle', 'af:rect');
      g.appendChild(ui.row('Width', num('w', 'mm', true)));
      g.appendChild(ui.row('Length', num('l', 'mm', true)));
      g.appendChild(ui.row('Angle', ui.exprInput(f.angle, '°', (v) => { f.angle = Number(v); })));
    } else {
      const g = ui.pmGroup(root, 'Hole', 'af:hole');
      g.appendChild(ui.row('Type', sel([['simple', 'Simple'], ['cbore', 'Counterbore'], ['csink', 'Countersink'], ['tapped', 'Tapped']], f.holeType, (v) => { f.holeType = v; this.renderPM(); })));
      if (f.holeType === 'tapped') g.appendChild(ui.row('Thread', sel(threadList('metric').map((t) => [t.id, t.label]), f.thread, (v) => { f.thread = v; })));
      else {
        g.appendChild(ui.row('Size', sel([...HOLE_SIZES.map((s) => [s, s]), ['custom', 'Custom']], f.size, (v) => { f.size = v; this.renderPM(); })));
        if (f.size === 'custom') {
          g.appendChild(ui.row('Diameter', num('diameter', 'mm')));
          if (f.holeType === 'cbore') { g.appendChild(ui.row('Counterbore Ø', num('cboreD', 'mm'))); g.appendChild(ui.row('Counterbore depth', num('cboreDepth', 'mm'))); }
          if (f.holeType === 'csink') { g.appendChild(ui.row('Countersink Ø', num('csinkD', 'mm'))); g.appendChild(ui.row('Angle', num('csinkAngle', '°'))); }
        } else {
          g.appendChild(ui.row('Fit', sel([['close', 'Close'], ['normal', 'Normal'], ['loose', 'Loose']], f.fit, (v) => { f.fit = v; })));
          const tl = el('label', { style: 'display:block' }, `<input type="checkbox" ${f.tapLast ? 'checked' : ''}> Tap the last component ${esc(f.size)}`);
          tl.querySelector('input').onchange = (e) => { f.tapLast = e.target.checked; this.renderPM(); };
          g.appendChild(tl);
        }
        if (f.holeType !== 'simple' || f.size !== 'custom') g.appendChild(el('div', { class: 'pm-hint' }, esc(`The first component: ${holeSpecLabel(f)}; the others plain Ø${fmt(holeDiameter(f, 'next') || 0, 3)}${f.tapLast && f.size !== 'custom' ? `, the last tapped ${f.size}` : ''}.`)));
      }
    }
    const g2 = ui.pmGroup(root, 'End', 'af:end');
    g2.appendChild(ui.row('End', sel([['through', 'Through all'], ['blind', 'Blind']], f.end, (v) => { f.end = v; this.detect(); this.renderPM(); })));
    if (f.end === 'blind') g2.appendChild(ui.row('Depth', num('depth', 'mm', true)));

    const g3 = ui.pmGroup(root, 'Components cut', 'af:comps');
    if (!f.comps.length) g3.appendChild(el('div', { class: 'pm-hint' }, 'The components it passes through are found when you click.'));
    for (const e of f.comps) {
      const c = h.comp(e.id);
      const lb = el('label', { style: 'display:block' }, `<input type="checkbox" ${e.off ? '' : 'checked'}> ${esc(c?.name || '?')}`);
      lb.querySelector('input').onchange = (ev) => { if (ev.target.checked) delete e.off; else e.off = true; };
      g3.appendChild(lb);
    }
    if (f.type === 'hole') {
      const g4 = ui.pmGroup(root, 'Fasteners', 'af:fast');
      const types = fastenerTypes(f.size);
      if (types.length < 2) g4.appendChild(el('div', { class: 'pm-hint' }, 'Fasteners go in standard-size clearance holes (pick a size).'));
      else {
        if (!types.some(([id]) => id === this.fast.kind)) this.fast.kind = 'none';
        g4.appendChild(ui.row('Insert', sel(types, this.fast.kind, (v) => { this.fast.kind = v; this.renderPM(); })));
        if (this.fast.kind !== 'none') {
          for (const [key, label] of [['washer', 'Washers'], ['nut', f.tapLast ? 'Nut (not with a tapped last component)' : 'Nut on the far side']]) {
            const lb = el('label', { style: 'display:block' }, `<input type="checkbox" ${this.fast[key] && !(key === 'nut' && f.tapLast) ? 'checked' : ''} ${key === 'nut' && f.tapLast ? 'disabled' : ''}> ${label}`);
            lb.querySelector('input').onchange = (ev) => { this.fast[key] = ev.target.checked; };
            g4.appendChild(lb);
          }
          g4.appendChild(el('div', { class: 'pm-hint' }, 'Each hole gets one, as long as the components it holds (to a standard length), mated in it.'));
        }
      }
    }
    root.appendChild(el('div', { class: 'pm-hint', style: 'padding:6px 10px' }, 'Made in the assembly: the parts\' own files are not changed. The components cut can be changed after.'));
  }
}
function holeSpecLabel(f) {
  try { return holeSpec({ ...f, system: 'metric' }, (x) => Number(x)).label; } catch { return ''; }
}

// the length of fastener a hole stack takes, and the parts of its set
export function fastenerLength(kind, size, depth, opts) {
  const set = setParts(kind, size);
  const extra = (opts.washer ? heightOf(...set.washer) : 0) + (opts.nut ? (opts.washer ? heightOf(...set.washer) : 0) + heightOf(...set.nut) : 0);
  return fitLength(kind, size, depth, extra);
}
