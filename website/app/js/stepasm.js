// The assembly structure of a STEP file, read straight from its text: the tree of assemblies and
// sub-assemblies as it is, the parts (each written out as a STEP file of its own) and their appearances. The
// kernel's STEP reader only gives one compound with no names or colours, so all that is read here and each
// part goes to the kernel on its own (smaller, and a part used many times is read once).
//
// readStepAssembly(text) → for a file holding a single part: { single: true, appearance, parts, warnings } (its
// appearances, see below; null when there is nothing in it), else
//   { name, root, assemblies, parts, occurrences, oneAppearance, warnings }
//   oneAppearance: the appearances placed as the whole file is (for importing it all as one part)
//   assemblies: [{ key, name, children: [{ kind: 'part' | 'asm', ref (a part or assembly key), name, pos, rot, mirrored }] }]
//     each (sub-)assembly once, its children placed in it (pos in mm, rot a quaternion [x, y, z, w]); root: the top one's key
//   parts: [{ key, name, step, solids, appearance }]
//     appearance: null, { c, t } (one look for the whole part), or { solids: [{ b, c, t }], faces: [{ b, c, t }] }
//     c: colour 0xRRGGBB or null, t: transparency (0 opaque … 1 clear), b: the box round the solid's or face's
//     vertices [x0, y0, z0, x1, y1, z1] in mm (how the kernel finds it again), or null when it has none
//   occurrences: every part occurrence placed in the top assembly, through the sub-assemblies (for counts and checks)
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
  const single = !nauos.length; // (a single part: only its appearances are read)

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
  if (!single && !roots.length) throw new Error('The assembly structure of the STEP file is circular');

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

  // the tree as it is: each (sub-)assembly once, its children placed in it
  const assemblies = new Map(); // PD → { key, name, children: [{ pd, sub, M }] }
  const leafPds = new Set();
  const visit = (pd, depth, stack) => {
    if (depth > 64) throw new Error('The assembly structure of the STEP file is too deep');
    if (stack.has(pd)) throw new Error('The assembly structure of the STEP file is circular');
    if (assemblies.has(pd)) return;
    const a = { key: 'a' + pd, name: pdName(pd), children: [] };
    assemblies.set(pd, a);
    stack.add(pd);
    for (const nauo of children.get(pd) || []) {
      const child = ref(rec(nauo).args[4]);
      const sub = children.has(child);
      if (sub) visit(child, depth + 1, stack); else leafPds.add(child);
      a.children.push({ pd: child, sub, M: placeOf.get(nauo) || IDENT() });
    }
    stack.delete(pd);
  };
  for (const root of roots) visit(root, 0, new Set());
  // (a single part: every product with a shape is a part, in place)
  if (single) for (const pd of byType.get('PRODUCT_DEFINITION')) if (repOfPd(pd)) leafPds.add(pd);
  // A product can contain both its own B-rep and child components (Fusion exports necks and
  // fretboards this way). Keep that geometry as a part inside its assembly, in local coordinates.
  const ownGeometryPds = new Set();
  if (!single) for (const pd of assemblies.keys()) if (repOfPd(pd)) {
    ownGeometryPds.add(pd);
    leafPds.add(pd);
  }
  if (!leafPds.size) return null;
  // (several top-level products: one assembly holding them all)
  let rootKey = 'a' + roots[0];
  if (roots.length > 1) {
    rootKey = 'root';
    assemblies.set(0, { key: rootKey, name: '', children: roots.map((pd) => ({ pd, sub: true, M: IDENT() })) });
  }

  // the representations that carry each part's geometry: its SHAPE_REPRESENTATION and those tied to it by
  // relationships without a transformation (the B-rep representation)
  const srrLinks = new Map(); // rep → [SRR id, other rep]
  for (const id of byType.get('SHAPE_REPRESENTATION_RELATIONSHIP')) {
    const r = rec(id), a = ref(r.args[2]), b = ref(r.args[3]);
    for (const [x, y] of [[a, b], [b, a]]) { if (!srrLinks.has(x)) srrLinks.set(x, []); srrLinks.get(x).push([id, y]); }
  }

  // ---- appearances: the styled items by the item they style (a solid, a shell or a face)
  const styleOf = new Map();
  for (const t of ['STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM']) for (const id of byType.get(t)) { const item = ref(rec(id).args[2]); if (item && !styleOf.has(item)) styleOf.set(item, id); }
  const NAMED = { red: 0xff0000, green: 0x00ff00, blue: 0x0000ff, yellow: 0xffff00, magenta: 0xff00ff, cyan: 0x00ffff, black: 0x000000, white: 0xffffff };
  const lookCache = new Map();
  // a style's surface colour (0xRRGGBB or null) and transparency (0 opaque … 1 clear): { c, t }
  const lookOf = (styled) => {
    if (lookCache.has(styled)) return lookCache.get(styled);
    let surfColour = null, anyColour = null, t = 0;
    const seen = new Set(), queue = [[styled, false]];
    while (queue.length && seen.size < 400) {
      const [id, surf] = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const r = rec(id), ty = typeOf(r);
      let c = null;
      if (ty === 'COLOUR_RGB') { const [, cr, cg, cb] = r.args; c = (Math.round(cr * 255) << 16) | (Math.round(cg * 255) << 8) | Math.round(cb * 255); }
      else if (ty === 'DRAUGHTING_PRE_DEFINED_COLOUR') c = NAMED[String(r.args[0]).toLowerCase()] ?? null;
      else if (ty === 'SURFACE_STYLE_TRANSPARENT') t = Math.max(0, Math.min(1, +r.args[0] || 0));
      if (c !== null) { if (surf && surfColour === null) surfColour = c; if (anyColour === null) anyColour = c; continue; }
      // (a curve style's colour is the edges': the faces' colour is the one under a surface style)
      const under = surf || ty === 'SURFACE_STYLE_USAGE' || ty === 'SURFACE_SIDE_STYLE';
      const next = id === styled ? (r.args[1] || []).map(ref).filter(Boolean) : refsIn(text, starts[id], ends[id], []);
      for (const x of next) if (x !== styled && !seen.has(x)) queue.push([x, under]);
    }
    const look = { c: surfColour ?? anyColour, t };
    lookCache.set(styled, look);
    return look;
  };
  // the points of an item's vertices (in mm, xyz…): what its box is measured from, placed or not
  const vertexPts = (item, mm) => {
    const pts = [];
    const seen = new Set([item]), stack = [item], buf = [];
    while (stack.length) {
      const id = stack.pop();
      head.lastIndex = starts[id];
      const m = head.exec(text);
      const ty = m && m[1].toUpperCase();
      if (ty === 'VERTEX_POINT') {
        const p = rec(ref(rec(id).args[1]))?.args?.[1];
        if (p) pts.push(p[0] * mm, p[1] * mm, p[2] * mm);
        continue;
      }
      // (only topology leads to vertices: not the surfaces and curves)
      if (ty && !/^(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|CLOSED_SHELL|OPEN_SHELL|ORIENTED_CLOSED_SHELL|ADVANCED_FACE|FACE_SURFACE|FACE_OUTER_BOUND|FACE_BOUND|EDGE_LOOP|ORIENTED_EDGE|EDGE_CURVE|SHELL_BASED_SURFACE_MODEL|FACETED_BREP|POLY_LOOP|VERTEX_LOOP)$/.test(ty)) continue;
      buf.length = 0;
      refsIn(text, starts[id], ends[id], buf);
      for (const x of buf) if (!seen.has(x) && starts[x]) { seen.add(x); stack.push(x); }
    }
    return pts;
  };
  // the box round points [x0, y0, z0, x1, y1, z1] (placed by a 4×4 W when given), or null when there are none
  const boxOf = (pts, W = null) => {
    if (!pts.length) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pts.length; i += 3) {
      let x = pts[i], y = pts[i + 1], z = pts[i + 2];
      if (W) [x, y, z] = [W[0] * x + W[1] * y + W[2] * z + W[3], W[4] * x + W[5] * y + W[6] * z + W[7], W[8] * x + W[9] * y + W[10] * z + W[11]];
      const q = [x, y, z];
      for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
    }
    return [...lo, ...hi].map((v) => Math.round(v * 1e6) / 1e6);
  };
  // appearances of styled items [{ face, look, pts }] (placed by W): one look, or each solid's and face's
  const appearanceOf = (items) => {
    if (!items.length) return null;
    const same = (a, b) => a.c === b.c && a.t === b.t;
    if (!items.some((s) => s.face) && items.every((s) => same(s.look, items[0].look))) return { ...items[0].look };
    const out = { solids: [], faces: [] };
    for (const s of items) (s.face ? out.faces : out.solids).push({ b: boxOf(s.pts, s.W), ...s.look });
    return out;
  };
  const SOLIDISH = /^(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP|SHELL_BASED_SURFACE_MODEL|CLOSED_SHELL|OPEN_SHELL)$/;
  const FACEISH = /^(ADVANCED_FACE|FACE_SURFACE)$/;

  // (one look in the whole file, on solids only: then no boxes are needed anywhere)
  let fileUniform = true, first = null;
  for (const [item, st] of styleOf) {
    head.lastIndex = starts[item];
    const m = head.exec(text), ty = m && m[1].toUpperCase();
    if (!ty || (!SOLIDISH.test(ty) && !FACEISH.test(ty))) continue;
    const lk = lookOf(st);
    if (FACEISH.test(ty) || (first && (lk.c !== first.c || lk.t !== first.t))) { fileUniform = false; break; }
    first ||= lk;
  }
  const styledOf = new Map(); // part PD → its styled items [{ id, face, look, pts }]

  // each part as a STEP file of its own (the records its product and geometry need), with its appearances
  const headerEnd = text.indexOf('DATA;');
  const header = text.slice(0, headerEnd);
  const parts = [];
  const keyOfPd = new Map();
  const names = new Map();
  let done = 0;
  for (const pd of leafPds) {
    report(`Separating part ${++done} of ${leafPds.size}…`);
    const pds = pdsOf.get(pd), sdr = repOfPds.get(pds);
    if (!sdr) { if (!ownGeometryPds.has(pd)) warnings.push(`${pdName(pd)}: no shape (left out)`); continue; }
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
    // its solids and the appearance of each styled solid or face
    let solids = 0;
    const styled = [];
    for (const id of keep) {
      head.lastIndex = starts[id];
      const m = head.exec(text);
      const ty = m && m[1].toUpperCase();
      if (!ty) continue;
      if (/^(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP|SHELL_BASED_SURFACE_MODEL)$/.test(ty)) solids++;
      const st = styleOf.get(id);
      if (st && (SOLIDISH.test(ty) || FACEISH.test(ty))) styled.push({ id, face: FACEISH.test(ty), look: lookOf(st) });
    }
    if (ownGeometryPds.has(pd) && !solids) continue;
    if (ownGeometryPds.has(pd)) assemblies.get(pd).children.unshift({ pd, sub: false, M: IDENT() });
    // (the geometry's unit: of the representation holding the B-rep, else the part's own)
    const mm = mmPerUnit([...seenRep].find((r) => r !== sdr[1]) || sdr[1]);
    // (the points only when they are needed: the looks differ, or for placing in one part)
    const uniform = !styled.some((s) => s.face) && styled.every((s) => s.look.c === styled[0]?.look.c && s.look.t === styled[0]?.look.t);
    for (const s of styled) s.pts = uniform && (single || fileUniform) ? [] : vertexPts(s.id, mm);
    styledOf.set(pd, styled);
    const appearance = uniform ? (styled.length ? { ...styled[0].look } : null) : appearanceOf(styled);
    // (a single part's file is used as it is)
    const out = [];
    if (!single) {
      out.push(header, 'DATA;\n');
      for (const id of [...keep].sort((a, b) => a - b)) out.push('#', id, '=', text.slice(starts[id], ends[id]), ';\n');
      out.push('ENDSEC;\nEND-ISO-10303-21;\n');
    }
    // a unique name per part (two products can share one)
    let nm = pdName(pd);
    const k = names.get(nm) || 0;
    names.set(nm, k + 1);
    if (k) nm = `${nm} (${k + 1})`;
    const key = 'p' + pd;
    keyOfPd.set(pd, key);
    parts.push({ key, name: nm, step: out.join(''), solids, appearance });
  }
  // a single part: its appearances, for the import of the whole file
  if (single) {
    const all = [...leafPds].flatMap((pd) => styledOf.get(pd) || []);
    return { single: true, appearance: fileUniform ? (first ? { ...first } : null) : appearanceOf(all), parts, warnings };
  }

  // the assemblies, children numbered per thing they use: { key, name, children: [{ kind, ref, name, pos, rot }] }
  let mirrored = 0;
  const asmList = [];
  for (const a of assemblies.values()) {
    const count = new Map();
    const kids = [];
    for (const ch of a.children) {
      const refKey = ch.sub ? assemblies.get(ch.pd)?.key : keyOfPd.get(ch.pd);
      if (!refKey) continue;
      const n = (count.get(refKey) || 0) + 1;
      count.set(refKey, n);
      const flip = det3(ch.M) < 0;
      if (flip) mirrored++;
      const nm = ch.sub ? assemblies.get(ch.pd).name : parts.find((p) => p.key === refKey).name;
      kids.push({ kind: ch.sub ? 'asm' : 'part', ref: refKey, name: `${nm}<${n}>`, pos: [ch.M[3], ch.M[7], ch.M[11]], rot: quatOf(ch.M), mirrored: flip });
    }
    asmList.push({ key: a.key, name: a.name, children: kids });
  }
  if (mirrored) warnings.push(`${mirrored} occurrence${mirrored > 1 ? 's are' : ' is'} mirrored, which an assembly component cannot be: placed unmirrored`);

  // every part occurrence in the whole tree, placed in the top assembly (for counts and checks), and the
  // appearances placed the same way (oneAppearance: for opening the whole file as one part, or inserting it)
  const occurrences = [], placed = [];
  const flat = (pd, W, path, depth) => {
    const a = assemblies.get(pd);
    if (!a || depth > 64) return;
    for (const ch of a.children) {
      const Wc = matMul(W, ch.M);
      if (ch.sub) { flat(ch.pd, Wc, [...path, assemblies.get(ch.pd)?.name || ''], depth + 1); continue; }
      const key = keyOfPd.get(ch.pd);
      if (!key) continue;
      occurrences.push({ part: key, name: parts.find((p) => p.key === key).name, path, pos: [Wc[3], Wc[7], Wc[11]], rot: quatOf(Wc) });
      if (!fileUniform) for (const s of styledOf.get(ch.pd) || []) placed.push({ ...s, W: Wc });
    }
  };
  flat(roots.length > 1 ? 0 : roots[0], IDENT(), [], 0);
  const oneAppearance = fileUniform ? (first ? { ...first } : null) : appearanceOf(placed);
  const top = asmList.find((a) => a.key === rootKey);
  return { name: top.name, root: rootKey, assemblies: asmList, parts, occurrences, oneAppearance, warnings };
}
