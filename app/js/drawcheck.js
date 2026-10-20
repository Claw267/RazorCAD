// Drawing checks: what a drawing still lacks before it is issued.
//   title block — its fields left empty (the sheet format's own fields, else the standard ones);
//   dimensions per view — part views without any, crowded views, annotations whose view was deleted;
//   undimensioned features — the sizes Auto Dimension would add (overall sizes, hole diameters, radii, hole
//     positions) that no dimension or hole callout in the drawing gives (a size given in one view of a part is
//     not asked for in its others).
// checkDrawing(dwg, geos) → { items: [{ level: 'error' | 'warn' | 'info', group, text, view?, ann?, fix? }],
//   missing: Map view id → the dimensions it lacks (as Auto Dimension would add them) }

import * as D from './drawing.js';
import { autoDims } from './autodim.js';
import { titleFields } from './drawingformats.js';

const DIMMED = ['model', 'projected', 'section', 'aux', 'detail', 'flat'];
// the title block fields a drawing should not go out without (the others are noted)
const NEEDED = new Set(['title', 'number', 'drawnBy', 'date', 'revision', 'material']);
const LATER = new Set(['checkedBy', 'approvedBy']);
const CROWDED = 30;

export function checkDrawing(dwg, geos) {
  const items = [], f = (x) => D.fmtLen(x, dwg);
  // ---- title block
  const props = dwg.props || {};
  for (const [key, label] of titleFields(dwg.format)) {
    if (key === 'mass' || String(props[key] ?? '').trim()) continue;
    const level = NEEDED.has(key) ? 'error' : LATER.has(key) ? 'info' : 'warn';
    items.push({ level, group: 'Title block', text: `${label} is empty${LATER.has(key) ? ' (to be filled in when it is signed off)' : ''}`, fix: 'props' });
  }
  // ---- views and their dimensions
  const views = dwg.views || [], byId = new Map(views.map((v) => [v.id, v]));
  const isAsm = (v) => (dwg.models || []).find((m) => m.id === v.model)?.doc?.kind === 'assembly';
  const dims = (v) => dwg.anns.filter((a) => a.view === v.id && (a.type === 'dim' || a.type === 'ordinate' || (a.type === 'note' && a.leader)));
  for (const a of dwg.anns) {
    if (a.view && !byId.has(a.view)) items.push({ level: 'error', group: 'Annotations', text: `${a.type === 'dim' ? 'A dimension' : 'An annotation'} belongs to a view that was deleted`, ann: a.id });
    else if (a.type === 'dim' && !Number.isFinite(D.dimValue(dwg, a))) items.push({ level: 'error', group: 'Annotations', text: 'A dimension has lost what it measures', ann: a.id, view: a.view });
  }
  // ---- what is not dimensioned: the sizes each view's own dimensions give first (for all of the drawing),
  // then what Auto Dimension would still add
  const part = views.filter((v) => DIMMED.includes(v.type) && !isAsm(v) && D.viewGeom(dwg, v, geos));
  const order = (v) => (v.type === 'model' || v.type === 'flat' ? 0 : 1);
  const list = [...part].sort((p, q) => order(p) - order(q));
  const had = new Set();
  for (const v of list) autoDims(dwg, [v], geos, new Set(), { spread: false, had });
  const missing = new Map();
  const callouts = calloutTexts(dwg);
  // (a hole position counts as dimensioned when any style gives it: baseline, chain or ordinate; by the hole's
  // coordinate across the view)
  const posKey = (a) => (a.type === 'ordinate' ? `${a.view}|${a.axis === 'y' ? 'v' : 'h'}|${(a.axis === 'y' ? a.p[1] : a.p[0]).toFixed(4)}` : `${a.view}|${a.orient}|${a.p2[a.orient === 'v' ? 1 : 0].toFixed(4)}`);
  const isPos = (a) => a.why === 'pos' || a.type === 'ordinate';
  const posMissing = ['chain', 'ordinate'].map((style) => new Set(autoDims(dwg, list, geos, new Set(had), { spread: false, style, overall: false, holes: false, radii: false }).filter(isPos).map(posKey)));
  for (const a of autoDims(dwg, list, geos, new Set(had), { spread: false })) {
    if (isPos(a) && !posMissing.every((set) => set.has(posKey(a)))) continue;
    // (a hole with a callout giving its diameter is dimensioned)
    if (a.kind === 'diameter' && gives(callouts.get(byId.get(a.view)?.model), 2 * a.r, dwg)) continue;
    if (!missing.has(a.view)) missing.set(a.view, []);
    missing.get(a.view).push(a);
  }
  for (const v of part) {
    const n = dims(v).length, miss = missing.get(v.id) || [];
    if (!n && !miss.length && v.type !== 'detail') items.push({ level: 'info', group: 'Dimensions per view', text: `${v.name} has no dimensions (its sizes are given in other views)`, view: v.id });
    else if (!n && v.type !== 'detail') items.push({ level: 'warn', group: 'Dimensions per view', text: `${v.name} has no dimensions`, view: v.id, fix: 'dims' });
    else if (n > CROWDED) items.push({ level: 'info', group: 'Dimensions per view', text: `${v.name} has ${n} dimensions: some could go in another view`, view: v.id });
    for (const a of miss) {
      const val = D.dimValue(dwg, a), more = a.prefix ? ` (${a.prefix.trim()} holes)` : '';
      const text = a.type === 'ordinate' ? `a position (${f(Math.abs(a.p[a.axis === 'y' ? 1 : 0] - a.o[a.axis === 'y' ? 1 : 0]))}) is not dimensioned`
        : a.why === 'size' ? `the overall ${a.orient === 'h' ? 'width' : 'height'} (${f(val)}) is not dimensioned`
          : a.why === 'd' ? `hole Ø${f(val)}${more} has no diameter or hole callout`
            : a.why === 'r' ? `radius R${f(val)}${more} is not dimensioned`
              : `a hole position (${f(val)}) is not dimensioned`;
      items.push({ level: a.why === 'pos' || a.type === 'ordinate' ? 'warn' : 'error', group: 'Undimensioned features', text: `${v.name}: ${text}`, view: v.id, fix: 'dims' });
    }
  }
  const rank = { error: 0, warn: 1, info: 2 };
  items.sort((p, q) => rank[p.level] - rank[q.level]);
  return { items, missing };
}

// the hole callouts' texts (notes with a leader), by model: Map model id → [text…]
function calloutTexts(dwg) {
  const out = new Map();
  for (const a of dwg.anns) {
    if (a.type !== 'note' || !a.leader || !a.text) continue;
    const m = (dwg.views || []).find((v) => v.id === a.view)?.model;
    if (m) { if (!out.has(m)) out.set(m, []); out.get(m).push(String(a.text)); }
  }
  return out;
}
// a callout giving this diameter (as the drawing writes it: Ø9, not Ø9.5)
const gives = (texts, d, dwg) => { const s = 'Ø' + D.fmtLen(d, dwg); return (texts || []).some((t) => t.split(s).length > 1 && t.split(s).slice(1).some((rest) => !/^[0-9.,]/.test(rest))); };
