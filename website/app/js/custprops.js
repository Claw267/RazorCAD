// Custom properties of a part or assembly (File ▸ Properties…): name / value pairs such as Part Number, Description
// or Vendor, kept in doc.customProps = [{ name, value }]. Bills of materials can show them as columns, and a
// drawing's title block takes its drawing number from the Part Number.
import { icon } from './icons.js';

export const PROP_SUGGESTIONS = ['Part Number', 'Description', 'Vendor', 'Vendor Part Number', 'Finish', 'Revision', 'Project', 'Drawn By', 'Cost', 'Notes'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// { name: value } of a document's custom properties
export const propsOf = (doc) => Object.fromEntries((doc?.customProps || []).filter((p) => p?.name).map((p) => [p.name, p.value ?? '']));
export const propOf = (doc, name) => propsOf(doc)[name] ?? '';

// The Properties dialog: onApply(changed) after OK (the document's customProps replaced).
export function editCustomProps(ui, doc, onApply, what = 'part') {
  const rows = (doc.customProps || []).map((p) => ({ name: p.name, value: p.value ?? '' }));
  if (!rows.length) rows.push({ name: 'Part Number', value: '' }, { name: 'Description', value: '' });
  const body = document.createElement('div');
  body.className = 'cprops';
  const render = () => {
    body.innerHTML = `<p class="pm-hint" style="margin-top:0">Properties of this ${what}, shown in bills of materials (as columns of the BOM table) and used by drawings (Part Number → the drawing number).</p>
      <datalist id="cp-names">${PROP_SUGGESTIONS.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      <table class="cp-table"><tr><th>Property</th><th>Value</th><th></th></tr>${rows.map((r, i) => `<tr><td><input type="text" list="cp-names" data-i="${i}" data-k="name" value="${esc(r.name)}" spellcheck="false"></td><td><input type="text" data-i="${i}" data-k="value" value="${esc(r.value)}"></td><td><button class="cp-del" data-i="${i}" title="Remove">${icon('trash')}</button></td></tr>`).join('')}</table>
      <button class="cp-add">Add Property</button>`;
    body.querySelectorAll('input[data-i]').forEach((inp) => { inp.oninput = () => { rows[+inp.dataset.i][inp.dataset.k] = inp.value; }; inp.onkeydown = (e) => e.stopPropagation(); });
    body.querySelectorAll('.cp-del').forEach((b) => { b.onclick = () => { rows.splice(+b.dataset.i, 1); render(); }; });
    body.querySelector('.cp-add').onclick = () => { rows.push({ name: '', value: '' }); render(); body.querySelector(`input[data-i="${rows.length - 1}"][data-k="name"]`)?.focus(); };
  };
  render();
  ui.modal(`${what === 'assembly' ? 'Assembly' : 'Part'} Properties`, 'customProps', body, [
    { label: 'OK', primary: true, action: () => {
      // (one value per name: the last one given)
      const by = new Map();
      for (const r of rows) { const n = r.name.trim(); if (n) by.set(n, String(r.value ?? '')); }
      const next = [...by].map(([name, value]) => ({ name, value }));
      const changed = JSON.stringify(next) !== JSON.stringify(doc.customProps || []);
      if (next.length) doc.customProps = next; else delete doc.customProps;
      onApply?.(changed);
    } },
    { label: 'Cancel' },
  ]);
}
