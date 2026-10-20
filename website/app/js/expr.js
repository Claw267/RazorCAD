// Safe-ish arithmetic expression evaluator used by every dimension field.
// Supports + - * / ^ %, parentheses, global variables (from Equations) and
// a few math functions. Trig functions work in degrees, like most CAD tools.
// Lengths may name their unit: 2in, 30 mm, 1.5cm, 2ft, (w/2)*in — the result is in millimetres.

const D2R = Math.PI / 180;
const FUNCS = {
  sin: (x) => Math.sin(x * D2R),
  cos: (x) => Math.cos(x * D2R),
  tan: (x) => Math.tan(x * D2R),
  asin: (x) => Math.asin(x) / D2R,
  acos: (x) => Math.acos(x) / D2R,
  atan: (x) => Math.atan(x) / D2R,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max,
  round: Math.round, floor: Math.floor, ceil: Math.ceil, pow: Math.pow,
  pi: Math.PI, PI: Math.PI,
};
// units of length (in millimetres); a variable of the same name wins over a unit ('in' can't be one)
const UNITS = { mm: 1, cm: 10, in: 25.4, inch: 25.4, ft: 304.8 };
export const RESERVED = new Set([...Object.keys(FUNCS), 'in']);

const cache = new Map();

export function isNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  return /^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(String(v));
}

export function isValidName(name) {
  return /^[A-Za-z_]\w*$/.test(name) && !RESERVED.has(name);
}

export function evaluate(expr, vars = {}) {
  if (typeof expr === 'number') {
    if (!Number.isFinite(expr)) throw new Error('Invalid number');
    return expr;
  }
  let s = String(expr ?? '').trim();
  if (s.startsWith('=')) s = s.slice(1).trim();
  if (s === '') throw new Error('Empty value');
  if (isNumeric(s)) return parseFloat(s);
  if (!/^[\w\s+\-*/().,^%]*$/.test(s)) throw new Error('Invalid characters in expression');
  // a number or bracket followed by a unit: multiplied by it (2in → 2*in)
  s = s.replace(/(\d|\))\s*(mm|cm|inch|in|ft)(?!\w)/g, '$1*$2');

  const ids = s.match(/(?<![\w.])[A-Za-z_]\w*/g) || [];
  const units = new Set();
  for (const id of ids) {
    if (id in vars || id in FUNCS) continue;
    if (id in UNITS) { units.add(id); continue; }
    throw new Error(`Unknown name "${id}"`);
  }
  // (units as parameters of their own: 'in' is a word of the language)
  const body = (units.size ? s.replace(/(?<![\w.])(mm|cm|inch|in|ft)(?!\w)/g, (u) => (units.has(u) ? `__u_${u}` : u)) : s).replace(/\^/g, '**');
  const unitNames = [...units].map((u) => `__u_${u}`);
  const names = [...Object.keys(FUNCS), ...Object.keys(vars).filter((k) => !(k in FUNCS)), ...unitNames];
  const key = names.join(',') + '|' + body;
  let fn = cache.get(key);
  if (!fn) {
    try {
      fn = new Function(...names, `"use strict"; return (${body});`);
    } catch {
      throw new Error('Syntax error');
    }
    if (cache.size > 2000) cache.clear();
    cache.set(key, fn);
  }
  const args = names.map((n) => (n in FUNCS ? FUNCS[n] : n.startsWith('__u_') ? UNITS[n.slice(4)] : vars[n]));
  const r = fn(...args);
  if (typeof r !== 'number' || !Number.isFinite(r)) throw new Error('Result is not a number');
  return r;
}

// Resolve the global variable table. Equations may reference each other in any order.
export function evalEquations(equations) {
  const vars = {};
  const errors = new Map();
  const pending = equations.filter((e) => e.name);
  for (const e of pending) {
    if (!isValidName(e.name)) errors.set(e.name, 'Invalid name');
  }
  let progress = true;
  let left = pending.filter((e) => !errors.has(e.name));
  while (progress && left.length) {
    progress = false;
    const next = [];
    for (const e of left) {
      try {
        vars[e.name] = evaluate(e.expr, vars);
        progress = true;
      } catch (err) {
        next.push(e);
        errors.set(e.name, err.message);
      }
    }
    for (const e of left) if (e.name in vars) errors.delete(e.name);
    left = next;
  }
  return { vars, errors };
}

export function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return String(Object.is(r, -0) ? 0 : r);
}

// Store a user-entered value: plain numbers as numbers, anything else as an expression string.
export function normalizeValue(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/^=/, '').trim();
  return isNumeric(s) ? parseFloat(s) : s;
}
