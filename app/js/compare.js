// Compare two versions of a part (File ▸ Compare With…): the part in front against its last saved version, another
// part file or another open part. Features are matched by their id (versions of one part keep them): added,
// removed, changed (which of their settings), moved in the tree, renamed; the part's own settings (material,
// equations, units, configurations…); and, by the kernel, the material this version adds and removes — shown on
// the model (added yellow, removed red) while the comparison is open.
import { TYPE_INFO, iconFor } from './model.js';
import { icon } from './icons.js';
import { platform } from './platform.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const IGNORE = new Set(['id', 'rev']);
// (what a setting is called in the list)
const KEY_NAMES = { depth: 'depth', depth2: 'depth 2', end: 'end condition', op: 'operation', sketch: 'sketch', points: 'sketch points', curves: 'sketch curves', constraints: 'sketch relations', plane: 'plane', radius: 'radius', distance: 'distance', angle: 'angle', suppressed: 'suppressed', name: 'name', texts: 'sketch text', count1: 'count', count2: 'count 2', dist1: 'spacing', dist2: 'spacing 2' };

// { added, removed, changed: [{ f, was, keys }], moved: [names], settings: [keys] }
export function compareDocs(a, b) {
  const A = new Map(a.features.map((f) => [f.id, f])), B = new Map(b.features.map((f) => [f.id, f]));
  const added = b.features.filter((f) => !A.has(f.id)), removed = a.features.filter((f) => !B.has(f.id));
  const changed = [];
  for (const f of b.features) {
    const o = A.get(f.id);
    if (!o) continue;
    const keys = [...new Set([...Object.keys(o), ...Object.keys(f)])].filter((k) => !IGNORE.has(k) && JSON.stringify(o[k]) !== JSON.stringify(f[k]));
    if (keys.length) changed.push({ f, was: o, keys });
  }
  // (features both have, in another order)
  const order = (list, other) => list.filter((f) => other.has(f.id)).map((f) => f.id);
  const oa = order(a.features, B), ob = order(b.features, A);
  const moved = ob.filter((id, i) => oa.indexOf(id) !== i && oa.indexOf(id) >= 0).map((id) => B.get(id).name);
  const settings = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !['features', 'nextId', 'version', 'thumbnail', 'name'].includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return { added, removed, changed, moved: oa.join() === ob.join() ? [] : moved, settings };
}

const vol = (v) => `${(+v).toLocaleString(undefined, { maximumFractionDigits: 1 })} mm³`;

// The comparison window. other: the other version's document; label: what it is ("the last saved version").
export async function showCompare(app, other, label) {
  if (app.mode === 'drawing') { app.toast('Open the part to compare it', true); return; }
  const cur = app.doc, d = compareDocs(other, cur);
  const typeName = (f) => (TYPE_INFO[f.type]?.base || f.type);
  const row = (cls, ic, name, what) => `<div class="cmp-row ${cls}">${icon(ic)}<span class="cmp-n">${esc(name)}</span><span class="cmp-w">${esc(what)}</span></div>`;
  const list = [
    ...d.added.map((f) => row('add', iconFor(f), f.name, `added (${typeName(f)})`)),
    ...d.removed.map((f) => row('rem', iconFor(f), f.name, `removed (${typeName(f)})`)),
    ...d.changed.map(({ f, was, keys }) => row('chg', iconFor(f), f.name, keys.includes('name') ? `renamed from ${was.name}${keys.length > 1 ? '; ' : ''}${keys.filter((k) => k !== 'name').map((k) => KEY_NAMES[k] || k).join(', ')}` : `changed: ${keys.map((k) => KEY_NAMES[k] || k).join(', ')}`)),
    ...(d.moved.length ? [row('chg', 'rollback', d.moved.join(', '), 'moved in the tree')] : []),
    ...d.settings.map((k) => row('chg', 'gear', { material: 'Material', equations: 'Equations', units: 'Units', configs: 'Configurations', customProps: 'Properties', activeConfig: 'Configuration shown', rollbackAt: 'Rollback bar' }[k] || k, 'changed')),
  ];
  const body = document.createElement('div');
  body.className = 'compare';
  body.innerHTML = `<p style="margin-top:0">This part (<b>${esc(cur.name)}</b>) against ${esc(label)}${other.name && other.name !== cur.name ? ` (<b>${esc(other.name)}</b>)` : ''}.</p>
    <div class="cmp-geo pm-hint">Comparing the shapes…</div>
    <div class="pm-label" style="margin-top:8px">Features and settings</div>
    <div class="cmp-list">${list.length ? list.join('') : '<div class="pm-hint" style="padding:6px">The features and settings are the same.</div>'}</div>`;
  const geo = body.querySelector('.cmp-geo');
  const dlg = app.ui.modal('Compare', 'compare', body, [{ label: 'Close', primary: true, action: () => { app.viewport.setPreview(null); } }]);
  // (closed any other way: the coloured overlay goes too)
  const obs = new MutationObserver(() => { if (!document.contains(body)) { obs.disconnect(); app.viewport.setPreview(null); } });
  obs.observe(document.getElementById('modal-root'), { childList: true });
  try {
    const k = app.kernelPool || app.kernel;
    const r = await k.request('compareParts', { a: JSON.stringify(other), b: JSON.stringify(cur) }, 'compare');
    if (!document.contains(body)) return r;
    const same = r.added === 0 && r.removed === 0;
    geo.innerHTML = same ? `The shapes are the same (${vol(r.volumeB)}).`
      : `Volume: this version ${vol(r.volumeB)}, the other ${vol(r.volumeA)}. <span class="cmp-add">■</span> Added ${vol(r.added)}${r.addedPieces > 1 ? ` in ${r.addedPieces} pieces` : ''}, <span class="cmp-rem">■</span> removed ${vol(r.removed)}${r.removedPieces > 1 ? ` in ${r.removedPieces} pieces` : ''} (shown on the model).`;
    app.viewport.setPreview(same ? null : { add: r.mesh.add, remove: r.mesh.remove });
    return r;
  } catch (e) {
    geo.textContent = 'The shapes could not be compared: ' + e.message;
    return null;
  }
}

// File ▸ Compare With…: the last saved version, another part file, or another open part
export async function compareWith(app) {
  if (app.mode === 'drawing') { app.toast('Compare With works on a part: open one first', true); return; }
  const others = app.tabs.map((t, i) => ({ t, i })).filter(({ t, i }) => i !== app.tabIndex && t.kind !== 'drawing' && t.doc);
  const choices = [
    ...(app.filePath && platform.desktop ? [['saved', 'Its last saved version', true]] : []),
    ['file', 'Another part file…', !(app.filePath && platform.desktop)],
    ...others.map(({ t, i }) => ['tab:' + i, `${t.doc.name} (open)`]),
  ];
  const c = await app.ui.choose('Compare With', 'compare', '<p>Compare this part with:</p>', choices);
  if (!c) return;
  let other = null, label = '';
  try {
    if (c === 'saved') { const text = await platform.readText(app.filePath); if (!text) throw new Error('The saved file could not be read'); other = JSON.parse(text); label = 'its last saved version'; }
    else if (c === 'file') {
      const f = await platform.openText();
      if (!f) return;
      if (!f.content) throw new Error('Choose a RazorCAD part (.rcad)');
      other = JSON.parse(f.content); label = f.name || 'the file';
    } else { const t = app.tabs[+c.slice(4)]; other = JSON.parse(JSON.stringify(t.doc)); label = `${t.doc.name} (open)`; }
    if (!Array.isArray(other?.features)) throw new Error('That is not a part');
  } catch (e) { app.toast(e.message, true); return; }
  return showCompare(app, other, label);
}
