// Drawing templates: a drawing's set-up kept as its own file (.rdrt): the sheets (size, orientation,
// scale, projection), the drawing settings (text height, decimals…), the title block's standing entries
// (company, drawn / checked / approved by, tolerances…), notes placed on the sheet and, optionally, a sheet
// format of its own (a company border, title block and logo: see sheetFormat in drawingformats.js).
// New drawings start from one (the New Drawing dialog); File ▸ Save as Template… makes one from a drawing.
import { newDrawing } from './drawing.js';
import { SHEET_SIZES } from './drawingformats.js';

export const TEMPLATE_EXT = '.rdrt';
export const isTemplate = (doc) => doc?.kind === 'drawingTemplate' && Array.isArray(doc.sheets);

// title block entries that belong to the drawing of one part (not kept in a template)
const PART_FIELDS = ['title', 'number', 'material', 'mass', 'date'];
// entries that are the company's standard: switching templates takes the new template's
const STANDARD_FIELDS = ['company', 'tolerance', 'finish'];

// A template's key: a standard template's id, else its file's path.
export const templateKey = (t) => t?.id || t?.path || null;

// The standard templates that come with RazorCAD (ISO sheet sizes, ISO title block).
const STD = (id, name, size, orientation, projection = 'first') => ({
  id: 'builtin:' + id, builtin: true, kind: 'drawingTemplate', version: 1, name,
  description: `${size} ${orientation}, ${projection === 'first' ? 'first' : 'third'} angle projection`,
  props: {}, settings: {}, sheets: [{ name: 'Sheet1', size, orientation, scale: [1, 1], projection }], anns: [],
});
export const BUILTIN_TEMPLATES = [
  STD('A4P', 'A4 portrait', 'A4', 'portrait'),
  STD('A4L', 'A4 landscape', 'A4', 'landscape'),
  STD('A3L', 'A3 landscape', 'A3', 'landscape'),
  STD('A2L', 'A2 landscape', 'A2', 'landscape'),
  STD('A1L', 'A1 landscape', 'A1', 'landscape'),
  STD('A0L', 'A0 landscape', 'A0', 'landscape'),
  STD('A3L3', 'A3 landscape, third angle', 'A3', 'landscape', 'third'),
  STD('A4P3', 'A4 portrait, third angle', 'A4', 'portrait', 'third'),
];
export const DEFAULT_TEMPLATE_ID = 'builtin:A3L';

// A short description of a template's sheets ("A3 landscape · 1:1 · first angle", "+1 sheet").
export function templateSummary(t) {
  const s = t.sheets?.[0];
  if (!s) return '';
  const size = SHEET_SIZES[s.size] ? s.size : 'A3';
  return `${size} ${s.orientation || 'landscape'} · ${s.scale?.[0] ?? 1}:${s.scale?.[1] ?? 1} · ${s.projection === 'third' ? 'third' : 'first'} angle${t.sheets.length > 1 ? ` · ${t.sheets.length} sheets` : ''}`;
}

// A template made from a drawing: its set-up only (no parts, views or what belongs to them).
export function templateFromDrawing(doc, name = doc.name, description = '') {
  const props = { ...(doc.props || {}) };
  for (const k of PART_FIELDS) delete props[k];
  const anns = (doc.anns || []).filter((a) => !a.view && !a.model).map((a) => { const c = JSON.parse(JSON.stringify(a)); delete c.tpl; return c; });
  return {
    kind: 'drawingTemplate', version: 1, name: name || 'Template', description: description || doc.templateDescription || '',
    props, settings: { ...(doc.settings || {}) },
    sheets: doc.sheets.map((s) => ({ id: s.id, name: s.name, size: s.size, orientation: s.orientation, scale: [...(s.scale || [1, 1])], projection: s.projection })),
    anns,
    ...(doc.revisions ? { revisions: JSON.parse(JSON.stringify(doc.revisions)) } : {}),
    ...(doc.format ? { format: JSON.parse(JSON.stringify(doc.format)) } : {}),
  };
}

// A new drawing from a template. over: { name, props: {…title block entries}, sheet: {size, orientation, scale, projection} }
export function drawingFromTemplate(t, over = {}) {
  const doc = newDrawing(over.name || 'Drawing1');
  const today = doc.props.date;
  doc.props = { ...doc.props, ...(t.props || {}), date: today, ...(over.props || {}) };
  doc.settings = { ...doc.settings, ...(t.settings || {}) };
  if (t.sheets?.length) doc.sheets = t.sheets.map((s, i) => ({ id: s.id || `s${i + 1}`, name: s.name || `Sheet${i + 1}`, size: SHEET_SIZES[s.size] ? s.size : 'A3', orientation: s.orientation === 'portrait' ? 'portrait' : 'landscape', scale: [...(s.scale || [1, 1])], projection: s.projection === 'third' ? 'third' : 'first' }));
  if (over.sheet) Object.assign(doc.sheets[0], over.sheet);
  const sheetIds = new Set(doc.sheets.map((s) => s.id));
  // (the template's notes are marked, so switching templates later replaces them)
  doc.anns = (t.anns || []).filter((a) => !a.view && !a.model).map((a) => ({ ...JSON.parse(JSON.stringify(a)), sheet: sheetIds.has(a.sheet) ? a.sheet : doc.sheets[0].id, tpl: true }));
  if (t.revisions) doc.revisions = JSON.parse(JSON.stringify(t.revisions));
  if (t.format?.prims) doc.format = JSON.parse(JSON.stringify(t.format));
  doc.template = { name: t.name || '', key: templateKey(t) };
  // ids after the template's own
  const n = Math.max(0, ...doc.anns.map((a) => +String(a.id).replace(/\D/g, '') || 0));
  doc.nextId = n + 1;
  return doc;
}

// Switch a drawing to another template. From the template: its sheet format, the sheet size,
// orientation and projection (on every sheet; scales, views and annotations stay), the drawing
// settings, its notes (replacing the old template's) and the company's standard entries (company,
// tolerances, finish); other title block entries are only filled in where the drawing has none.
// sheet: { size, orientation, projection } chosen in the dialog (else the template's first sheet).
export function applyTemplate(doc, t, sheet = null) {
  const s0 = { ...(t.sheets?.[0] || {}), ...(sheet || {}) };
  for (const s of doc.sheets) {
    s.size = SHEET_SIZES[s0.size] ? s0.size : 'A3';
    s.orientation = s0.orientation === 'portrait' ? 'portrait' : 'landscape';
    s.projection = s0.projection === 'third' ? 'third' : 'first';
  }
  if (t.format?.prims) doc.format = JSON.parse(JSON.stringify(t.format));
  else delete doc.format;
  doc.settings = { ...doc.settings, ...(t.settings || {}) };
  for (const [k, v] of Object.entries(t.props || {})) {
    if (PART_FIELDS.includes(k) || v === undefined || v === null || v === '') continue;
    if (STANDARD_FIELDS.includes(k) || !doc.props[k]) doc.props[k] = v;
  }
  const sheetIds = new Set(doc.sheets.map((s) => s.id));
  doc.anns = doc.anns.filter((a) => !a.tpl);
  for (const a of (t.anns || []).filter((x) => !x.view && !x.model)) {
    doc.anns.push({ ...JSON.parse(JSON.stringify(a)), id: `a${doc.nextId++}`, sheet: sheetIds.has(a.sheet) ? a.sheet : doc.sheets[0].id, tpl: true });
  }
  doc.template = { name: t.name || '', key: templateKey(t) };
  return doc;
}
