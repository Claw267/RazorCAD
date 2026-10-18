// The assembly structure of a STEP file, read straight from its text: the parts, each written out as a STEP
// file of its own, and where every occurrence of them sits. The kernel's STEP reader only gives one compound
// with no names, so the product tree is read here and each part goes to the kernel on its own (smaller, and
// a part used many times is read once).
//
// readStepAssembly(text) → null when the file holds a single part, else
//   { name, parts: [{ key, name, step, color, solids }], occurrences: [{ part, name, path, pos, rot, mirrored }], warnings }
//   pos in mm, rot a quaternion [x, y, z, w]; color 0xRRGGBB (the colour most of the part's solids have) or null.
//
// The STEP entities used (ISO 10303-21, AP203 / AP214 / AP242):
//   PRODUCT ← PRODUCT_DEFINITION_FORMATION ← PRODUCT_DEFINITION (PD)
//   NEXT_ASSEMBLY_USAGE_OCCURRENCE (NAUO): parent PD → child PD
//   PRODUCT_DEFINITION_SHAPE (PDS) of a PD, or of a NAUO
//   SHAPE_DEFINITION_REPRESENTATION: PDS → the PD's SHAPE_REPRESENTATION
//   CONTEXT_DEPENDENT_SHAPE_REPRESENTATION: (REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION, PDS of a NAUO)
//   ITEM_DEFINED_TRANSFORMATION (item1 in rep_1, item2 in rep_2): rep_1 is normally the child
//   SHAPE_REPRESENTATION_RELATIONSHIP (no transformation): a part's SHAPE_REPRESENTATION ↔ its B-rep representation

// ------------------------------------------------------------------ the entity index
// starts[id] / ends[id]: the record's text after "=" up to its ";" (0 = no such entity)
function indexEntities(text) {
  let cap = 1 << 16;
  let starts = new Int32Array(cap), ends = new Int32Array(cap);
  let maxId = 0;
  const data = text.indexOf('DATA;');
  if (data < 0) throw new Error('Not a STEP file (no DATA section)');
  let i = data + 5;
  const dataEnd = text.lastIndexOf('ENDSEC');
  // (searched for once and again only when passed: searching from every record would rescan the whole file)
  let comment = text.indexOf('/*', i), quote = text.indexOf("'", i);
  for (;;) {
    const h = text.indexOf('#', i);
    if (h < 0 || h > dataEnd) break;
    // a comment between records
    if (comment >= 0 && comment < i) comment = text.indexOf('/*', i);
    if (comment >= 0 && comment < h) { const e = text.indexOf('*/', comment + 2); if (e < 0) break; i = e + 2; continue; }
    let j = h + 1, id = 0;
    for (let ch = text.charCodeAt(j); ch >= 48 && ch <= 57; ch = text.charCodeAt(++j)) id = id * 10 + ch - 48;
    const eq = text.indexOf('=', j);
    if (eq < 0) break;
    // the record ends at the first ";" outside a string ('' inside a string is a quote)
    let k = eq + 1, end = -1;
    for (;;) {
      const semi = text.indexOf(';', k);
      if (semi < 0) break;
      if (quote >= 0 && quote < k) quote = text.indexOf("'", k);
      const q = quote;
      if (q < 0 || q > semi) { end = semi; break; }
      let m = q + 1;
      for (;;) {
        const q2 = text.indexOf("'", m);
        if (q2 < 0) { m = text.length; break; }
        if (text.charCodeAt(q2 + 1) === 39) { m = q2 + 2; continue; }
        m = q2 + 1; break;
      }
      k = m;
    }
    if (end < 0) break;
    if (id >= cap) {
      while (id >= cap) cap *= 2;
      const s2 = new Int32Array(cap), e2 = new Int32Array(cap);
      s2.set(starts); e2.set(ends); starts = s2; ends = e2;
    }
    starts[id] = eq + 1; ends[id] = end;
    if (id > maxId) maxId = id;
    i = end + 1;
  }
  return { starts, ends, maxId };
}

// ------------------------------------------------------------------ records
// A record's value: { type, args } for a simple entity, { complex: [{ type, args }…] } for a complex one.
// Arguments: #ref → { ref: n }, 'text' → string, .ENUM. → { enum: 'ENUM' }, $ / * → null, numbers, lists → arrays,
// typed values (LENGTH_MEASURE(2.0)) → { type, args }.
function parseRecord(src) {
  let i = 0;
  const n = src.length;
  const ws = () => { while (i < n && src.charCodeAt(i) <= 32) i++; };
  const ident = () => { const s = i; while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++; return src.slice(s, i).toUpperCase(); };
  const list = () => {
    const out = [];
    i++; // (
    ws();
    if (src[i] === ')') { i++; return out; }
    for (;;) {
      out.push(value());
      ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ')') { i++; break; }
      if (i >= n) break;
      i++;
    }
    return out;
  };
  const value = () => {
    ws();
    const ch = src[i];
    if (ch === '#') { i++; const s = i; while (i < n && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57) i++; return { ref: +src.slice(s, i) }; }
    if (ch === "'") {
      let out = '';
      i++;
      for (;;) {
        const q = src.indexOf("'", i);
        if (q < 0) { out += src.slice(i); i = n; break; }
        out += src.slice(i, q);
        if (src[q + 1] === "'") { out += "'"; i = q + 2; continue; }
        i = q + 1; break;
      }
      return out;
    }
    if (ch === '.') { const e = src.indexOf('.', i + 1); const v = src.slice(i + 1, e); i = e + 1; return { enum: v }; }
    if (ch === '$' || ch === '*') { i++; return null; }
    if (ch === '(') return list();
    if (/[A-Za-z]/.test(ch)) { const type = ident(); ws(); return { type, args: src[i] === '(' ? list() : [] }; }
    const s = i;
    while (i < n && /[-+0-9.Ee]/.test(src[i])) i++;
    return +src.slice(s, i);
  };
  ws();
  if (src[i] === '(') {
    // complex entity: ( A(…) B(…) … )
    i++;
    const parts = [];
    for (;;) {
      ws();
      if (i >= n || src[i] === ')') break;
      const type = ident();
      ws();
      parts.push({ type, args: src[i] === '(' ? list() : [] });
    }
    return { complex: parts };
  }
  const type = ident();
  ws();
  return { type, args: list() };
}

// the entity references in a record's text (outside strings)
function refsIn(text, s, e, out) {
  let i = s;
  while (i < e) {
    const ch = text.charCodeAt(i);
    if (ch === 39) { // '
      i++;
      while (i < e) { if (text.charCodeAt(i) === 39) { if (text.charCodeAt(i + 1) === 39) { i += 2; continue; } break; } i++; }
      i++;
    } else if (ch === 35) { // #
      let id = 0; i++;
      for (let c = text.charCodeAt(i); c >= 48 && c <= 57 && i < e; c = text.charCodeAt(++i)) id = id * 10 + c - 48;
      out.push(id);
    } else i++;
  }
  return out;
}

// ------------------------------------------------------------------ 4×4 placements (row-major, mm)
const IDENT = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function matMul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
    o[r * 4 + c] = s;
  }
  return o;
}
// the inverse of a rigid placement (rotation + translation)
function rigidInverse(m) {
  const o = IDENT();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 4 + c] = m[c * 4 + r];
  for (let r = 0; r < 3; r++) o[r * 4 + 3] = -(o[r * 4] * m[3] + o[r * 4 + 1] * m[7] + o[r * 4 + 2] * m[11]);
  return o;
}
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dotV = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// a rotation matrix (rows of a 4×4) as a quaternion [x, y, z, w]
function quatOf(m) {
  const m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[4], m11 = m[5], m12 = m[6], m20 = m[8], m21 = m[9], m22 = m[10];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s; }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}
const det3 = (m) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);

// ------------------------------------------------------------------ the reader
export function readStepAssembly(text, onProgress = null) {
  const report = (msg) => { if (onProgress) onProgress(msg); };
  report('Indexing the STEP file…');
  const { starts, ends, maxId } = indexEntities(text);
  const warnings = [];
  const cache = new Map();
  const rec = (id) => {
    if (!id || id > maxId || !starts[id]) return null;
    let r = cache.get(id);
    if (!r) { r = parseRecord(text.slice(starts[id], ends[id])); cache.set(id, r); }
    return r;
  };
  const ref = (v) => (v && typeof v === 'object' && 'ref' in v ? v.ref : null);
  const typeOf = (r) => (r ? r.type || null : null);
  const part = (r, type) => (r?.complex ? r.complex.find((p) => p.type === type) || null : r?.type === type ? r : null);

  // the entities by type (only the few the structure needs)
  report('Reading the assembly structure…');
  const WANT = new Set(['PRODUCT_DEFINITION', 'NEXT_ASSEMBLY_USAGE_OCCURRENCE', 'PRODUCT_DEFINITION_SHAPE', 'SHAPE_DEFINITION_REPRESENTATION',
    'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION', 'SHAPE_REPRESENTATION_RELATIONSHIP', 'STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM']);
  const byType = new Map([...WANT].map((t) => [t, []]));
  const complexRR = [];
  const head = /\s*([A-Za-z0-9_]+|\()/y;
  for (let id = 1; id <= maxId; id++) {
    const s = starts[id];
    if (!s) continue;
    head.lastIndex = s;
    const m = head.exec(text);
    if (!m) continue;
    if (m[1] === '(') {
      // complex: only the placed representation relationships matter here
      const body = text.slice(s, Math.min(ends[id], s + 400));
      if (body.includes('REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')) complexRR.push(id);
      continue;
    }
    const list = byType.get(m[1].toUpperCase());
    if (list) list.push(id);
  }
  const nauos = byType.get('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  if (!nauos.length) return null; // a single part: read it whole

  // PD → product name; PDS by what it defines; SDR: PDS → representation
  const pdName = (pd) => {
    const r = rec(pd), pdf = rec(ref(r?.args?.[2])), prod = rec(ref(pdf?.args?.[2]));
    const nm = prod?.args?.[1] || prod?.args?.[0] || r?.args?.[0] || '';
    return String(nm).trim() || 'Part';
  };
  const pdsOf = new Map(); // PD or NAUO id → PDS id
  for (const id of byType.get('PRODUCT_DEFINITION_SHAPE')) { const d = ref(rec(id).args[2]); if (d) pdsOf.set(d, id); }
  const repOfPds = new Map(); // PDS → [SDR id, representation id]
  for (const id of byType.get('SHAPE_DEFINITION_REPRESENTATION')) { const r = rec(id); repOfPds.set(ref(r.args[0]), [id, ref(r.args[1])]); }
  const repOfPd = (pd) => repOfPds.get(pdsOf.get(pd))?.[1] || null;

  // the tree
  const children = new Map(); // parent PD → [NAUO ids]
  const isChild = new Set();
  for (const id of nauos) {
    const r = rec(id), parent = ref(r.args[3]), child = ref(r.args[4]);
    if (!parent || !child) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(id);
    isChild.add(child);
  }
  const roots = [...children.keys()].filter((pd) => !isChild.has(pd));
  if (!roots.length) throw new Error('The assembly structure of the STEP file is circular');

  // units: the length unit of a representation's context, as a factor to mm
  const unitCache = new Map();
  const mmPerUnit = (repId) => {
    const r = rec(repId);
    const ctxId = ref(r?.args?.[2] ?? (r?.complex && part(r, 'REPRESENTATION')?.args?.[2]));
    if (unitCache.has(ctxId)) return unitCache.get(ctxId);
    let f = 1;
    const ctx = rec(ctxId);
    const gu = part(ctx, 'GLOBAL_UNIT_ASSIGNED_CONTEXT');
    for (const u of gu?.args?.[0] || []) {
      const ur = rec(ref(u));
      if (!part(ur, 'LENGTH_UNIT')) continue;
      const si = part(ur, 'SI_UNIT');
      if (si) {
        const pre = si.args[0]?.enum || null;
        f = { MILLI: 1, CENTI: 10, DECI: 100, KILO: 1e6, MICRO: 1e-3 }[pre] ?? (pre ? 1 : 1000);
      } else {
        const cb = part(ur, 'CONVERSION_BASED_UNIT');
        const nm = String(cb?.args?.[0] || '').toUpperCase();
        f = /INCH/.test(nm) ? 25.4 : /FOOT|FEET/.test(nm) ? 304.8 : /MET/.test(nm) ? 1000 : 1;
      }
      break;
    }
    unitCache.set(ctxId, f);
    return f;
  };
  // an AXIS2_PLACEMENT_3D as a 4×4, in mm
  const placement = (id, mm) => {
    const r = rec(id);
    if (typeOf(r) !== 'AXIS2_PLACEMENT_3D') return IDENT();
    const p = rec(ref(r.args[1]))?.args?.[1] || [0, 0, 0];
    const z = norm(rec(ref(r.args[2]))?.args?.[1] || [0, 0, 1]);
    let x = rec(ref(r.args[3]))?.args?.[1] || (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    x = norm(x.map((v, k) => v - dotV(x, z) * z[k]));
    const y = crossV(z, x);
    return [x[0], y[0], z[0], p[0] * mm, x[1], y[1], z[1], p[1] * mm, x[2], y[2], z[2], p[2] * mm, 0, 0, 0, 1];
  };

  // the placement of each occurrence (NAUO) in its parent: from the CDSR that names its PDS
  const placeOf = new Map(); // NAUO → 4×4
  const nauoOfPds = new Map();
  for (const id of nauos) { const p = pdsOf.get(id); if (p) nauoOfPds.set(p, id); }
  for (const id of byType.get('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) {
    const r = rec(id), rr = rec(ref(r.args[0])), nauo = nauoOfPds.get(ref(r.args[1]));
    if (!nauo || !rr) continue;
    const base = part(rr, 'REPRESENTATION_RELATIONSHIP'), wt = part(rr, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
    if (!base || !wt) { warnings.push(`Occurrence #${nauo}: no placement found (left at the origin)`); continue; }
    const rep1 = ref(base.args[2]), rep2 = ref(base.args[3]);
    const tr = rec(ref(wt.args[0]));
    if (typeOf(tr) !== 'ITEM_DEFINED_TRANSFORMATION') { warnings.push(`Occurrence #${nauo}: ${typeOf(tr) || 'an unknown'} placement is not supported (left at the origin)`); continue; }
    const T = matMul(placement(ref(tr.args[3]), mmPerUnit(rep2)), rigidInverse(placement(ref(tr.args[2]), mmPerUnit(rep1))));
    // rep_1 is the child's representation (the usual way); the other way round the placement is inverted
    const childRep = repOfPd(ref(rec(nauo).args[4]));
    placeOf.set(nauo, childRep && childRep === rep2 && childRep !== rep1 ? rigidInverse(T) : T);
  }

  // flatten: every leaf occurrence with its world placement
  const occurrences = [];
  const leafPds = new Map(); // PD → occurrence count
  const walk = (pd, W, path, depth) => {
    if (depth > 64) throw new Error('The assembly structure of the STEP file is too deep');
    const kids = children.get(pd) || [];
    for (const nauo of kids) {
      const r = rec(nauo), child = ref(r.args[4]);
      const Wc = matMul(W, placeOf.get(nauo) || IDENT());
      const nm = pdName(child);
      if (children.has(child)) walk(child, Wc, [...path, nm], depth + 1);
      else {
        leafPds.set(child, (leafPds.get(child) || 0) + 1);
        occurrences.push({ pd: child, nauo, W: Wc, path });
      }
    }
  };
  for (const root of roots) walk(root, IDENT(), roots.length > 1 ? [pdName(root)] : [], 0);
  if (!occurrences.length) return null;

  // the representations that carry each part's geometry: its SHAPE_REPRESENTATION and those tied to it by
  // relationships without a transformation (the B-rep representation)
  const srrLinks = new Map(); // rep → [SRR id, other rep]
  for (const id of byType.get('SHAPE_REPRESENTATION_RELATIONSHIP')) {
    const r = rec(id), a = ref(r.args[2]), b = ref(r.args[3]);
    for (const [x, y] of [[a, b], [b, a]]) { if (!srrLinks.has(x)) srrLinks.set(x, []); srrLinks.get(x).push([id, y]); }
  }
  // colours: the styled items by the item they style
  const styleOf = new Map();
  for (const t of ['STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM']) for (const id of byType.get(t)) { const item = ref(rec(id).args[2]); if (item && !styleOf.has(item)) styleOf.set(item, id); }
  const colourCache = new Map();
  const colourOf = (styled) => {
    if (colourCache.has(styled)) return colourCache.get(styled);
    // follow the style's references to its first colour
    let found = null;
    const seen = new Set(), queue = [styled];
    while (queue.length && found === null && seen.size < 200) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const r = rec(id);
      const t = typeOf(r);
      if (t === 'COLOUR_RGB') { const [, cr, cg, cb] = r.args; found = (Math.round(cr * 255) << 16) | (Math.round(cg * 255) << 8) | Math.round(cb * 255); break; }
      if (t === 'DRAUGHTING_PRE_DEFINED_COLOUR') {
        found = { red: 0xff0000, green: 0x00ff00, blue: 0x0000ff, yellow: 0xffff00, magenta: 0xff00ff, cyan: 0x00ffff, black: 0x000000, white: 0xffffff }[String(r.args[0]).toLowerCase()] ?? null;
        if (found !== null) break;
      }
      if (id === styled) { for (const s of r.args[1] || []) if (ref(s)) queue.push(ref(s)); continue; }
      refsIn(text, starts[id], ends[id], []).forEach((x) => { if (x !== styled) queue.push(x); });
    }
    colourCache.set(styled, found);
    return found;
  };

  // each part as a STEP file of its own: the records its product and geometry need
  const headerEnd = text.indexOf('DATA;');
  const header = text.slice(0, headerEnd);
  const parts = [];
  const keyOfPd = new Map();
  const names = new Map();
  let done = 0;
  for (const [pd] of leafPds) {
    report(`Separating part ${++done} of ${leafPds.size}…`);
    const pds = pdsOf.get(pd), sdr = repOfPds.get(pds);
    if (!sdr) { warnings.push(`${pdName(pd)}: no shape (left out)`); continue; }
    const keep = new Set();
    const queue = [sdr[0]];
    const reps = [sdr[1]];
    const seenRep = new Set(reps);
    while (reps.length) {
      const rp = reps.pop();
      for (const [srr, other] of srrLinks.get(rp) || []) {
        queue.push(srr);
        if (!seenRep.has(other)) { seenRep.add(other); reps.push(other); }
      }
    }
    const buf = [];
    while (queue.length) {
      const id = queue.pop();
      if (keep.has(id) || !starts[id]) continue;
      keep.add(id);
      buf.length = 0;
      refsIn(text, starts[id], ends[id], buf);
      for (const x of buf) if (!keep.has(x)) queue.push(x);
    }
    // the colour most of its solids have
    const votes = new Map();
    let solids = 0;
    for (const id of keep) {
      head.lastIndex = starts[id];
      const m = head.exec(text);
      if (!m || !/^(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP|SHELL_BASED_SURFACE_MODEL)$/i.test(m[1])) continue;
      solids++;
      const st = styleOf.get(id);
      const c = st ? colourOf(st) : null;
      if (c !== null) votes.set(c, (votes.get(c) || 0) + 1);
    }
    let color = null, best = 0;
    for (const [c, n] of votes) if (n > best) { best = n; color = c; }
    const ids = [...keep].sort((a, b) => a - b);
    const out = [header, 'DATA;\n'];
    for (const id of ids) out.push('#', id, '=', text.slice(starts[id], ends[id]), ';\n');
    out.push('ENDSEC;\nEND-ISO-10303-21;\n');
    // a unique name per part (two products can share one)
    let nm = pdName(pd);
    const k = names.get(nm) || 0;
    names.set(nm, k + 1);
    if (k) nm = `${nm} (${k + 1})`;
    const key = 'p' + pd;
    keyOfPd.set(pd, key);
    parts.push({ key, name: nm, step: out.join(''), color, solids });
  }

  // the occurrences, numbered per part
  const count = new Map();
  const occ = [];
  let mirrored = 0;
  for (const o of occurrences) {
    const key = keyOfPd.get(o.pd);
    if (!key) continue;
    const n = (count.get(key) || 0) + 1;
    count.set(key, n);
    const flip = det3(o.W) < 0;
    if (flip) mirrored++;
    const pname = parts.find((p) => p.key === key).name;
    occ.push({ part: key, name: `${pname}<${n}>`, path: o.path, pos: [o.W[3], o.W[7], o.W[11]], rot: quatOf(o.W), mirrored: flip });
  }
  if (mirrored) warnings.push(`${mirrored} occurrence${mirrored > 1 ? 's are' : ' is'} mirrored, which an assembly component cannot be: placed unmirrored`);
  return { name: roots.length === 1 ? pdName(roots[0]) : '', parts, occurrences: occ, warnings };
}
