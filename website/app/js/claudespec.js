// Modelling with Claude: what Claude is told about RazorCAD's part format, a compact description of the
// open part, reading Claude's reply, and adding the features it wrote to the part.
// The same guide is used by the "Ask Claude" panel in RazorCAD and by the RazorCAD modelling page on claude.ai.
import * as M from './model.js';

export const CLAUDE_MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (most capable)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster, lower cost)'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 (fastest, lowest cost)'],
];

export const RAZORCAD_GUIDE = `You are the modelling assistant of RazorCAD, a parametric 3D part modeller (like other feature-based CAD programs).
You build parts by writing features for the feature tree. Units: millimetres and degrees.

Answer with a short plain-language explanation (one to four sentences) and then ONE fenced \`\`\`json block:
{ "replace": false, "features": [ ...features to add at the end of the tree... ] }
Use "replace": true only when the user asks for a new part (the features then form the whole part).
If the request is unclear or impossible, ask a short question instead and leave out the json block.

COORDINATES
World axes: X right, Y up, Z toward the viewer. Standard sketch planes and their sketch axes (u = sketch x, v = sketch y, n = normal; a sketch point (x, y) is at x·u + y·v in the world):
- "front": u = +X, v = +Y, n = +Z
- "top":   u = +X, v = -Z, n = +Y   (so sketch y = -Z world)
- "right": u = -Z, v = +Y, n = +X
Extrusions go along n (reverse: true goes the other way).

FEATURES (each an object; "id" is your own temporary id, other features refer to it by that id;
existing features are referred to by the ids given in the part description)
1. Sketch: { "id": "s1", "type": "sketch", "plane": { "ref": "top" }, "points": [{ "id": "p1", "x": 0, "y": 0 }, ...],
   "curves": [ { "id": "c1", "type": "line", "p1": "p1", "p2": "p2" },
               { "id": "c2", "type": "circle", "c": "p5", "r": 10 },
               { "id": "c3", "type": "arc", "c": "p6", "p1": "p7", "p2": "p8" } ] }
   - plane.ref: "front" | "top" | "right" | the id of a plane feature.
   - "O" is the sketch origin point (0, 0); do not add it to points.
   - Arcs run counter-clockwise from p1 to p2 about the centre c; p1 and p2 must be at the same distance from c.
   - Closed profiles must join exactly (lines share point ids). Profiles may be nested (holes).
   - "construction": true makes a curve a reference only (e.g. a revolve axis).
   - Ids inside a sketch are local to it (p1, c1 ... may repeat in another sketch).
2. Extrude: { "type": "extrude", "sketch": "s1", "op": "add" | "cut", "end": "blind" | "midplane" | "through" | "through2",
   "depth": 20, "reverse": false, "merge": true }   (through = through all one way, through2 = both ways; cuts usually "through2")
   Thin wall from open or closed curves: add "thin": true, "thinT": 2, "thinDir": "one" | "other" | "mid".
3. Revolve: { "type": "revolve", "sketch": "s1", "op": "add" | "cut", "axis": "<id of a line in that sketch>" | "u" | "v", "angle": 360 }
   ("u"/"v" = the sketch's horizontal / vertical axis through its origin). The profile must not cross the axis.
4. Fillet / Chamfer: { "type": "fillet", "radius": 2, "edges": [{ "p": [x, y, z] }, ...] }
   { "type": "chamfer", "distance": 1, "edges": [{ "p": [x, y, z] }] } — each "p" is a point ON the edge (world coordinates),
   best the middle of the edge. Only use them when you can work out the edge positions exactly.
5. Reference plane offset from another: { "id": "pl1", "type": "plane", "refs": [{ "kind": "plane", "id": "top" }], "offset": 30, "flip": false }
6. Linear pattern: { "type": "lpattern", "feature": "<feature id>", "dir1": "x" | "y" | "z", "dist1": 20, "count1": 4, "dir2": "none" | "x" | "y" | "z", "dist2": 20, "count2": 2 }
   Circular pattern: { "type": "cpattern", "feature": "<feature id>", "axis": "x" | "y" | "z", "angle": 360, "count": 6, "equal": true }
   Mirror: { "type": "mirror", "feature": "<feature id>", "plane": "front" | "top" | "right" | "<plane id>" }
7. Shell: { "type": "shell", "thickness": 2, "faces": [{ "p": [x, y, z], "n": [nx, ny, nz] }] } (faces to remove: a point on each face and its outward normal)
8. Sheet metal:
   Base flange: { "type": "smBase", "sketch": "s1", "thickness": 2, "radius": 2, "kFactor": 0.44, "reverse": false } (closed sketch → flat sheet along n)
   Edge flange: { "type": "smFlange", "edges": [{ "p": [x, y, z] }], "length": 25, "angle": 90, "lengthRef": "outer",
                  "position": "inside", "flip": false, "corner": "square" | "butt" | "closed" | "open", "cornerGap": 0.5 } — edges: straight edges on the TOP face of the sheet (the face at +thickness along n); the flange goes up.
                  Flanges in one feature that meet at a corner each run square up to the other's inside face, their inside edges cornerGap apart ("square", the default); "butt" mitres them on the diagonal; "closed" makes one overlap the other's end; "open" leaves the corner open.
   Closed corner: { "type": "smClosedCorner", "cornerType": "overlap" | "underlap" | "square" | "butt", "gap": 0.1 } (every corner of the sheet)   Corner relief: { "type": "smCornerRelief", "reliefType": "rect" | "circle", "size": 4 }

RULES
- Prefer simple, exact geometry; put round numbers on the coordinates the user gives.
- Sketch on a standard plane and extrude, rather than trying to sketch on model faces.
- Use only the feature types and fields above. Numbers may also be written as strings with equations, e.g. "20*2".
- Keep the part a single connected body unless asked otherwise.

EXAMPLE — "a 100 x 60 x 10 plate with a 20 mm hole in the middle":
\`\`\`json
{ "replace": true, "features": [
  { "id": "s1", "type": "sketch", "plane": { "ref": "top" },
    "points": [{ "id": "p1", "x": -50, "y": -30 }, { "id": "p2", "x": 50, "y": -30 }, { "id": "p3", "x": 50, "y": 30 }, { "id": "p4", "x": -50, "y": 30 }],
    "curves": [{ "id": "c1", "type": "line", "p1": "p1", "p2": "p2" }, { "id": "c2", "type": "line", "p1": "p2", "p2": "p3" },
               { "id": "c3", "type": "line", "p1": "p3", "p2": "p4" }, { "id": "c4", "type": "line", "p1": "p4", "p2": "p1" },
               { "id": "c5", "type": "circle", "c": "O", "r": 10 }] },
  { "id": "e1", "type": "extrude", "sketch": "s1", "op": "add", "end": "blind", "depth": 10 }
] }
\`\`\`
(The plate lies on the top plane, from Y = 0 to Y = 10; the hole goes through because the circle is inside the profile.)`;

// A compact description of the open part (features and bodies), so Claude can build on it.
// boxOf(bodyId) → { min: [x, y, z], max: [x, y, z] } (from the displayed mesh) or null.
export function describePart(doc, result, boxOf = null) {
  const lines = [`Part "${doc.name}" (${doc.features.length} features).`];
  // (a part the user sees Z up: their axes named, as they will speak of them; the features stay in the axes above)
  if (doc.upAxis === 'z') lines.push('The user sees this part Z up: their X, Y, Z are the X, -Z, Y above (their Top plane XY is the top plane, their Front plane XZ the front plane). Write the features in the axes above as always; when the user says up or Z they mean +Y here, and their Y is -Z here.');
  const num = (v) => (typeof v === 'number' ? +v.toFixed(4) : v);
  for (const f of doc.features) {
    if (f.suppressed) continue;
    const base = `- ${f.id} ${f.type} "${f.name}"`;
    if (f.type === 'sketch') {
      const ref = f.plane?.ref === 'face' ? 'a model face' : f.plane?.ref;
      const pts = (f.points || []).map((p) => `${p.id}(${num(p.x)},${num(p.y)})`).join(' ');
      const crv = (f.curves || []).map((c) => (c.type === 'circle' ? `${c.id}:circle ${c.c} r${num(c.r)}` : `${c.id}:${c.type} ${c.type === 'arc' ? c.c + ' ' : ''}${c.p1}-${c.p2}${c.construction ? ' (construction)' : ''}`)).join('; ');
      lines.push(`${base} on ${ref}: points ${pts || '-'}; curves ${crv || '-'}`.slice(0, 1500));
    } else {
      const keys = Object.entries(f).filter(([k, v]) => !['id', 'type', 'name', 'suppressed', 'rev'].includes(k) && v !== null && v !== '' && !(Array.isArray(v) && !v.length) && typeof v !== 'object').map(([k, v]) => `${k}=${num(v)}`);
      const refs = [];
      if (f.edges?.length) refs.push(`edges at ${f.edges.map((e) => `[${e.p.map(num).join(',')}]`).join(' ')}`);
      if (f.faces?.length) refs.push(`${f.faces.length} faces`);
      if (f.refs?.length) refs.push(`refs ${f.refs.map((r) => r.id || r.kind).join(',')}`);
      lines.push(`${base} ${keys.join(' ')} ${refs.join(' ')}`.trim());
    }
  }
  for (const b of result?.bodies || []) {
    const box = boxOf?.(b.id);
    const bb = box ? ` bounding box [${box.min.map(num)}] to [${box.max.map(num)}]` : '';
    lines.push(`Body "${b.name}" (${b.sheet ? `sheet metal, ${num(b.sheet.t)} mm` : b.kind || 'solid'})${bb}`);
  }
  if (!(result?.bodies || []).length) lines.push('No bodies yet.');
  const errs = [...(result?.errors || [])];
  if (errs.length) lines.push('Current errors: ' + errs.map(([id, m]) => `${id}: ${m}`).join(' | '));
  return lines.join('\n');
}

// The explanation and the JSON block of Claude's reply.
export function parseReply(text) {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text || '');
  const message = (text || '').replace(/```(?:json)?[\s\S]*?```/, '').trim();
  if (!m) return { message, plan: null };
  let plan;
  try { plan = JSON.parse(m[1]); } catch (e) { return { message, plan: null, error: 'The reply\'s JSON could not be read: ' + e.message }; }
  if (!plan || !Array.isArray(plan.features)) return { message, plan: null, error: 'The reply has no "features" list' };
  return { message, plan };
}

const TYPES = new Set(['sketch', 'extrude', 'revolve', 'fillet', 'chamfer', 'plane', 'lpattern', 'cpattern', 'mirror', 'shell', 'smBase', 'smFlange', 'smClosedCorner', 'smCornerRelief']);

// Add the features Claude wrote to the document (or replace its features). Its temporary ids are
// changed to real ones. Returns the ids of the new features. Throws on anything that isn't valid.
export function applyPlan(doc, plan) {
  if (plan.replace) { doc.features = []; doc.rollbackAt = null; }
  const idMap = new Map();
  const existing = new Set(doc.features.map((f) => f.id));
  const ref = (v) => (typeof v === 'string' && idMap.has(v) ? idMap.get(v) : v);
  const added = [];
  for (const raw of plan.features) {
    if (!raw || !TYPES.has(raw.type)) throw new Error(`Unknown feature type "${raw?.type}"`);
    const { id: tmp, type, ...props } = raw;
    delete props.name;
    if (type === 'sketch') {
      const plane = props.plane?.ref ? { ref: ref(props.plane.ref) } : { ref: 'front' };
      if (!['front', 'top', 'right'].includes(plane.ref) && !existing.has(plane.ref) && ![...idMap.values()].includes(plane.ref)) throw new Error(`Sketch ${tmp || ''} is on an unknown plane "${props.plane?.ref}"`);
      const f = M.createFeature(doc, 'sketch', { plane });
      f.points = (props.points || []).map((p) => ({ id: String(p.id), x: +p.x, y: +p.y }));
      const pid = new Set(['O', ...f.points.map((p) => p.id)]);
      f.curves = (props.curves || []).map((c) => {
        const cu = { id: String(c.id), type: c.type, construction: !!c.construction };
        if (c.type === 'line') Object.assign(cu, { p1: String(c.p1), p2: String(c.p2) });
        else if (c.type === 'circle') Object.assign(cu, { c: String(c.c), r: +c.r });
        else if (c.type === 'arc') Object.assign(cu, { c: String(c.c), p1: String(c.p1), p2: String(c.p2) });
        else throw new Error(`Unknown sketch curve type "${c.type}"`);
        for (const k of ['p1', 'p2', 'c']) if (cu[k] !== undefined && !pid.has(cu[k])) throw new Error(`Sketch curve ${c.id} uses a missing point ${cu[k]}`);
        return cu;
      });
      f.constraints = [];
      f.nextSid = 1 + Math.max(0, ...[...f.points, ...f.curves].map((x) => +String(x.id).replace(/\D/g, '') || 0)) + 100;
      // keep generated ids clear of Claude's own ids
      M.insertFeature(doc, f);
      if (tmp) idMap.set(tmp, f.id);
      added.push(f.id);
      continue;
    }
    for (const k of ['sketch', 'feature', 'plane', 'profile', 'path', 'guide']) if (k in props) props[k] = ref(props[k]);
    if (Array.isArray(props.refs)) props.refs = props.refs.map((r) => ({ ...r, id: ref(r.id) }));
    const f = M.createFeature(doc, type, props);
    if (type === 'extrude' || type === 'revolve') f.op = props.op === 'cut' ? 'cut' : 'add';
    f.name = M.nextName(doc, type, f.op);
    M.insertFeature(doc, f);
    if (tmp) idMap.set(tmp, f.id);
    added.push(f.id);
  }
  return added;
}
