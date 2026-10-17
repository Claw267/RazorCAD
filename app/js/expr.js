// Safe-ish arithmetic expression evaluator used by every dimension field.
// Supports + - * / ^ %, parentheses, global variables (from Equations) and
// a few math functions. Trig functions work in degrees, like most CAD tools.

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
export const RESERVED = new Set(Object.keys(FUNCS));

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

  const ids = s.match(/(?<![\w.])[A-Za-z_]\w*/g) || [];
  for (const id of ids) {
    if (!(id in vars) && !(id in FUNCS)) throw new Error(`Unknown name "${id}"`);
  }
  const body = s.replace(/\^/g, '**');
  const names = [...Object.keys(FUNCS), ...Object.keys(vars).filter((k) => !(k in FUNCS))];
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
  const args = names.map((n) => (n in FUNCS ? FUNCS[n] : vars[n]));
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
