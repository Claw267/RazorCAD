// Bill of materials of an assembly document: one row per part / sub-assembly and configuration used (a
// sub-assembly's own rows under it, indented, with the quantities in one of it); suppressed components left
// out. Used by the assembly's Bill of Materials window and by the BOM table and balloons on drawings.
import { materialById } from './model.js';
import { propsOf } from './custprops.js';

const isAsm = (doc) => doc?.kind === 'assembly';
const configName = (p, id) => (id ? (p?.doc?.configs || []).find((c) => c.id === id)?.name || '?' : 'Default');
// a component as the document's active configuration shows it
function effIn(doc, c) {
  const o = (doc.activeConfig ? (doc.configs || []).find((x) => x.id === doc.activeConfig) : null)?.comps?.[c.id] || {};
  return { config: 'config' in o ? o.config : (c.config ?? null), suppressed: 'suppressed' in o ? o.suppressed : !!c.suppressed };
}

// [{ item ('1', '2.1'…), depth, name, qty, material, file, sub, part (its part id), config, props (its custom
// properties), key (the same for the row however the list changes) }]
export function bomRows(asm) {
  const rows = [];
  const level = (doc, prefix, depth, parentKey = '') => {
    let k = 0;
    for (const p of doc.parts || []) {
      const by = new Map();
      for (const c of doc.components || []) {
        const e = effIn(doc, c);
        if (c.part !== p.id || e.suppressed) continue;
        by.set(e.config, (by.get(e.config) || 0) + 1);
      }
      for (const [cfgId, n] of by) {
        const item = prefix + ++k, sub = isAsm(p.doc);
        const key = `${parentKey}${p.id}|${cfgId ?? ''}`;
        rows.push({ item, depth, name: (p.name || 'Part') + ((p.doc?.configs || []).length ? ` (${configName(p, cfgId)})` : ''), qty: n,
          material: sub ? '' : materialById(p.doc?.material)?.name || '', file: p.path ? String(p.path).split(/[\\/]/).pop() : '(not saved)', sub,
          part: p.id, config: cfgId, configName: (p.doc?.configs || []).length ? configName(p, cfgId) : '', props: propsOf(p.doc), key });
        if (sub && depth < 16) {
          const sd = { ...p.doc, activeConfig: cfgId && (p.doc.configs || []).some((x) => x.id === cfgId) ? cfgId : null };
          level(sd, item + '.', depth + 1, key + '/');
        }
      }
    }
  };
  if (isAsm(asm)) level(asm, '', 0);
  return rows;
}

// What a BOM column can show: these, a custom property ('prop:<name>'), or values typed into the table ('text').
export const BOM_FIELDS = [['item', 'Item'], ['qty', 'Qty'], ['name', 'Part'], ['material', 'Material'], ['file', 'File'], ['config', 'Configuration']];
// the custom property names the assembly's parts and sub-assemblies have (in the order first met)
export function bomPropNames(asm) {
  const out = [];
  for (const r of bomRows(asm)) for (const k of Object.keys(r.props || {})) if (!out.includes(k)) out.push(k);
  return out;
}
// a row's text in a column { key, values }
export function bomCell(row, col) {
  const k = col?.key || '';
  if (k === 'config') return row.configName || '';
  if (k.startsWith('prop:')) return row.props?.[k.slice(5)] ?? '';
  if (k === 'text') return col.values?.[row.key] ?? '';
  return row[k] ?? '';
}

// The (top level) item number of a component of the assembly, or null.
export function bomItemOf(asm, compId, rows = bomRows(asm)) {
  const c = (asm?.components || []).find((x) => x.id === compId);
  if (!c) return null;
  const e = effIn(asm, c);
  return rows.find((r) => !r.depth && r.part === c.part && (r.config ?? null) === (e.config ?? null))?.item || null;
}
