// Standard parts for assemblies: ISO bolts, screws, nuts, washers, dowel pins and ball bearings, each made as
// an ordinary RazorCAD part from the standard's dimensions (threads as cosmetic threads, so they build fast).
//
// Every part is made on the same axis: the part's Y axis, with its seat (a bolt head's underside, a nut's or
// washer's or bearing's bottom face, a pin's end) on the plane y = 0 facing −Y and the rest of it along −Y
// (a bolt's shank) or +Y (a head, a nut). makeStdPart(type, size, length) → { doc, name, key, axis, seat, align }:
// axis / seat are mate references in the part's coordinates, +Y pointing out of the hole the part goes in; align
// is how the seat meets the face round the hole (−1: against it, a head or nut; +1: flush with it, a bearing
// pressed into a bore, or a dowel pin's middle).
import { newDoc, createFeature } from './model.js';

const HEX_BOLT = { // ISO 4017: s across flats, k head height
  M3: [5.5, 2], M4: [7, 2.8], M5: [8, 3.5], M6: [10, 4], M8: [13, 5.3], M10: [16, 6.4], M12: [18, 7.5], M14: [21, 8.8], M16: [24, 10], M20: [30, 12.5], M24: [36, 15],
};
const SOCKET = { // ISO 4762: dk head diameter, k head height, s socket across flats, t socket depth
  M3: [5.5, 3, 2.5, 1.3], M4: [7, 4, 3, 2], M5: [8.5, 5, 4, 2.5], M6: [10, 6, 5, 3], M8: [13, 8, 6, 4], M10: [16, 10, 8, 5], M12: [18, 12, 10, 6], M16: [24, 16, 14, 8], M20: [30, 20, 17, 10], M24: [36, 24, 19, 12],
};
const NUT = { // ISO 4032: s across flats, m height
  M3: [5.5, 2.4], M4: [7, 3.2], M5: [8, 4.7], M6: [10, 5.2], M8: [13, 6.8], M10: [16, 8.4], M12: [18, 10.8], M14: [21, 12.8], M16: [24, 14.8], M20: [30, 18], M24: [36, 21.5],
};
const WASHER = { // ISO 7089: d1 inside, d2 outside, h thickness
  M3: [3.2, 7, 0.5], M4: [4.3, 9, 0.8], M5: [5.3, 10, 1], M6: [6.4, 12, 1.6], M8: [8.4, 16, 1.6], M10: [10.5, 20, 2], M12: [13, 24, 2.5], M14: [15, 28, 2.5], M16: [17, 30, 3], M20: [21, 37, 3], M24: [25, 44, 4],
};
const PITCH = { M3: 0.5, M4: 0.7, M5: 0.8, M6: 1, M8: 1.25, M10: 1.5, M12: 1.75, M14: 2, M16: 2, M20: 2.5, M24: 3 };
const CLEARANCE = { M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5, M14: 15.5, M16: 17.5, M20: 22, M24: 26 }; // ISO 273 normal
const PINS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20]; // ISO 8734 diameters
const BEARINGS = { // 6000 and 6200 series: d bore, D outside, B width
  6000: [10, 26, 8], 6001: [12, 28, 8], 6002: [15, 32, 9], 6003: [17, 35, 10], 6004: [20, 42, 12], 6005: [25, 47, 12], 6006: [30, 55, 13], 6007: [35, 62, 14], 6008: [40, 68, 15],
  6200: [10, 30, 9], 6201: [12, 32, 10], 6202: [15, 35, 11], 6203: [17, 40, 12], 6204: [20, 47, 14], 6205: [25, 52, 15], 6206: [30, 62, 16], 6207: [35, 72, 17], 6208: [40, 80, 18],
};
const LENGTHS = [4, 5, 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200];
const nominal = (m) => Number(m.slice(1));

export const STD_TYPES = [
  { id: 'hexBolt', label: 'Hex Bolt (ISO 4017)', sizes: Object.keys(HEX_BOLT), length: true },
  { id: 'socketScrew', label: 'Socket Head Cap Screw (ISO 4762)', sizes: Object.keys(SOCKET), length: true },
  { id: 'hexNut', label: 'Hex Nut (ISO 4032)', sizes: Object.keys(NUT) },
  { id: 'washer', label: 'Washer (ISO 7089)', sizes: Object.keys(WASHER) },
  { id: 'dowelPin', label: 'Dowel Pin (ISO 8734)', sizes: PINS.map((d) => 'Ø' + d), length: true },
  { id: 'bearing', label: 'Ball Bearing (6000 / 6200)', sizes: Object.keys(BEARINGS) },
];
// the standard lengths that make sense for a size (bolts: about 1.5 d to 10 d; pins 2 d to 10 d)
export function stdLengths(type, size) {
  const d = type === 'dowelPin' ? Number(String(size).slice(1)) : nominal(size);
  return LENGTHS.filter((L) => L >= Math.max(4, (type === 'dowelPin' ? 2 : 1.2) * d) && L <= Math.max(30, 12 * d));
}

// ---- building blocks
const P = (id, x, y) => ({ id, x, y });
function sketchOf(doc, plane, loops) {
  const s = createFeature(doc, 'sketch', { plane: { ref: plane } });
  const points = [], curves = [];
  let n = 0;
  for (const l of loops) {
    if (l.circle) { const c = 'p' + ++n; points.push(P(c, l.c[0], l.c[1])); curves.push({ id: 'c' + n, type: 'circle', c, r: l.r, construction: false }); continue; }
    const ids = l.pts.map(([x, y]) => { const id = 'p' + ++n; points.push(P(id, x, y)); return id; });
    ids.forEach((id, i) => curves.push({ id: 'c' + ++n, type: 'line', p1: id, p2: ids[(i + 1) % ids.length], construction: false }));
  }
  Object.assign(s, { points, curves, constraints: [] });
  doc.features.push(s);
  return s;
}
const hexagon = (s) => ({ pts: Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 3) * i, R = s / Math.sqrt(3); return [R * Math.cos(a), R * Math.sin(a)]; }) });
const circle = (r) => ({ circle: true, c: [0, 0], r });
const add = (doc, type, props) => { const f = createFeature(doc, type, props); doc.features.push(f); return f; };
const thread = (doc, size, p, end = 'through', depth = 10) => add(doc, 'cosmeticThread', { face: { p }, system: 'metric', size, end, depth });

// The part, and where it seats.
export function makeStdPart(type, size, length = null, material = 'steel') {
  const doc = newDoc();
  doc.material = material;
  const axis = { kind: 'axis', p: [0, 0, 0], d: [0, 1, 0], what: 'Axis' };
  let seat = { kind: 'plane', p: [0, 0, 0], n: [0, -1, 0], what: 'Seat' }, align = -1;
  let name;
  if (type === 'hexBolt' || type === 'socketScrew') {
    const d = nominal(size), L = Number(length) || stdLengths(type, size)[3] || 20;
    if (type === 'hexBolt') {
      const [s, k] = HEX_BOLT[size];
      add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [hexagon(s)]).id, depth: k });
      name = `Hex Bolt ${size}×${L} ISO 4017`;
    } else {
      const [dk, k, s, t] = SOCKET[size];
      add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(dk / 2)]).id, depth: k });
      const pl = add(doc, 'plane', { refs: [{ kind: 'plane', id: 'top' }], offset: k });
      add(doc, 'extrude', { sketch: sketchOf(doc, pl.id, [hexagon(s)]).id, op: 'cut', depth: t, reverse: true });
      name = `Socket Head Cap Screw ${size}×${L} ISO 4762`;
    }
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(d / 2)]).id, depth: L, reverse: true });
    thread(doc, size, [d / 2, -L / 2, 0]);
    axis.r = d / 2;
  } else if (type === 'hexNut') {
    const d = nominal(size), [s, m] = NUT[size], D1 = d - 1.0825 * PITCH[size];
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [hexagon(s), circle(D1 / 2)]).id, depth: m });
    thread(doc, size, [D1 / 2, m / 2, 0]);
    axis.r = D1 / 2;
    name = `Hex Nut ${size} ISO 4032`;
  } else if (type === 'washer') {
    const [d1, d2, h] = WASHER[size];
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(d2 / 2), circle(d1 / 2)]).id, depth: h });
    axis.r = d1 / 2;
    name = `Washer ${size} ISO 7089`;
  } else if (type === 'dowelPin') {
    const d = Number(String(size).slice(1)), L = Number(length) || stdLengths(type, size)[2] || 10;
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(d / 2)]).id, depth: L, reverse: true });
    axis.r = d / 2;
    seat = { kind: 'plane', p: [0, -L / 2, 0], n: [0, 1, 0], what: 'Middle' }; align = 1; // (half in the hole)
    name = `Dowel Pin Ø${d}×${L} ISO 8734`;
  } else if (type === 'bearing') {
    const [d, D, B] = BEARINGS[size], w = (D - d) * 0.3;
    // (inner and outer rings, the balls between them left out)
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(D / 2), circle(D / 2 - w), circle(d / 2 + w), circle(d / 2)]).id, depth: B });
    axis.r = D / 2;
    seat = { kind: 'plane', p: [0, B, 0], n: [0, 1, 0], what: 'Face' }; align = 1; // (flush with the bore's end)
    name = `Ball Bearing ${size} (${d}×${D}×${B})`;
  } else throw new Error('Unknown standard part');
  doc.name = name;
  doc.stdPart = { type, size, length: length ?? null };
  return { doc, name, key: `${type}|${size}|${length ?? ''}|${material}`, axis, seat, align };
}

// The size that fits a hole of diameter `dia` (and, for bolts and pins, a length for a hole `depth` deep).
export function fitToHole(type, dia, depth = 0) {
  const t = STD_TYPES.find((x) => x.id === type);
  let size;
  if (type === 'bearing') size = Object.entries(BEARINGS).reduce((b, [k, v]) => (Math.abs(v[1] - dia) < Math.abs(BEARINGS[b][1] - dia) ? k : b), '6000');
  else if (type === 'dowelPin') size = 'Ø' + PINS.reduce((b, d) => (Math.abs(d - dia) < Math.abs(b - dia) ? d : b), PINS[0]);
  else {
    // a clearance hole or a tapped one (drilled at about the minor diameter)
    const score = (m) => Math.min(Math.abs(CLEARANCE[m] - dia), Math.abs(nominal(m) - PITCH[m] - dia), Math.abs(nominal(m) - dia) + 0.3);
    size = t.sizes.reduce((b, m) => (score(m) < score(b) ? m : b), t.sizes[0]);
  }
  return { size, length: fitLength(type, size, depth) };
}
// the standard length for a hole `depth` deep: a bolt through it with room for a nut, a pin half in it (null:
// the part has no length)
export function fitLength(type, size, depth = 0) {
  if (!STD_TYPES.find((x) => x.id === type)?.length) return null;
  const want = type === 'dowelPin' ? 2 * depth : depth + 0.8 * nominal(size);
  const ls = stdLengths(type, size);
  return ls.find((L) => L >= want - 1e-6) ?? ls[ls.length - 1];
}
