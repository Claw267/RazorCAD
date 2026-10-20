// Length units of a document (doc.units: 'mm', the default, or 'in'). Lengths are kept in millimetres
// everywhere — the geometry, the kernel, the files — and an inch document only shows them in inches and
// reads what is typed in a length field as inches:
//   typed 2        → stored 50.8 (a number, in mm)        shown 2
//   typed w/2      → stored "(w/2)*in"                     shown w/2   (variables count in the document's unit)
//   typed 30mm     → stored "30mm" (an explicit unit stays) shown 30mm
// Values stored before the document became inch keep their meaning: a number is shown converted, an
// expression as "(…)*mm".
import { isNumeric, normalizeValue } from './expr.js';

export const MM_PER = { mm: 1, in: 25.4 };
export const unitOf = (doc) => (doc?.units === 'in' ? 'in' : 'mm');
export const UNIT_SYSTEM = { mm: 'MMGS', in: 'IPS' };

const trim = (x, d) => { const r = +x.toFixed(d); return String(Object.is(r, -0) ? 0 : r); };
const WRAP = /^\((.*)\)\*in$/s;
// does an expression name a unit of its own?
export const hasUnits = (s) => /(?<![A-Za-z_])(mm|cm|inch|in|ft)(?![A-Za-z_0-9])/.test(String(s));

// A length (mm) as text in a unit, with up to `digits` decimals (inches: 4 by default).
export function fmtLen(mm, unit = 'mm', digits = null) {
  if (!Number.isFinite(mm)) return '—';
  return trim(mm / MM_PER[unit], digits ?? (unit === 'in' ? 4 : 2));
}
// … with its unit
export const lenWithUnit = (mm, unit = 'mm', digits = null) => `${fmtLen(mm, unit, digits)} ${unit}`;
export const areaWithUnit = (mm2, unit = 'mm', digits = 3) => `${trim(mm2 / MM_PER[unit] ** 2, unit === 'in' ? Math.max(digits, 4) : digits)} ${unit}²`;
export const volWithUnit = (mm3, unit = 'mm', digits = 3) => `${trim(mm3 / MM_PER[unit] ** 3, unit === 'in' ? Math.max(digits, 4) : digits)} ${unit}³`;

// What a length field shows for a stored value.
export function lenText(value, unit) {
  if (unit !== 'in' || value === '' || value == null) return value ?? '';
  if (typeof value === 'number') return trim(value / 25.4, 6);
  const s = String(value).trim();
  if (isNumeric(s)) return trim(parseFloat(s) / 25.4, 6);
  const m = s.match(WRAP);
  if (m) return m[1];
  return hasUnits(s) ? s : `(${s})*mm`;
}
// What a length field stores for typed text.
export function lenValue(text, unit) {
  if (unit !== 'in') return normalizeValue(text);
  const s = String(text ?? '').trim().replace(/^=/, '').trim();
  if (s === '') return '';
  if (isNumeric(s)) return parseFloat(s) * 25.4;
  return hasUnits(s) ? s : `(${s})*in`;
}
