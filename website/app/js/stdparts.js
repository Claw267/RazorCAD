// Standard parts for assemblies, each made as an ordinary RazorCAD part from its standard's dimensions (threads as
// cosmetic threads, so they build fast):
//   metric: hex bolts (ISO 4017), socket head cap screws (ISO 4762), hex nuts (ISO 4032), washers (ISO 7089),
//     socket set screws (ISO 4026), dowel pins (ISO 8734), circlips for shafts and bores (DIN 471 / 472, the ring
//     simplified: no lugs), parallel keys (DIN 6885 A), round head rivets (ISO 1051), ball bearings (6000 / 6200);
//   inch: hex bolts (ASME B18.2.1), socket head cap screws (ASME B18.3), hex nuts (ASME B18.2.2), SAE flat washers.
//
// Every part is made on the same axis: the part's Y axis, +Y pointing out of the hole it goes in. Its seat is
// where it meets the face round the hole: a head's or nut's or washer's underside (on y = 0, facing −Y: align −1,
// against the face), or a face that ends flush with the hole's end (align +1: a bearing, a set screw, a circlip,
// a dowel pin's middle). makeStdPart(type, size, length) → { doc, name, key, axis, seat, align, top }; top: the
// plane a part stacked on this one seats on (a washer's upper face).
import { newDoc, createFeature } from './model.js';

const IN = 25.4;
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
const SET_SCREW = { // ISO 4026: s socket across flats, t socket depth
  M3: [1.5, 1.2], M4: [2, 1.6], M5: [2.5, 2], M6: [3, 2], M8: [4, 3], M10: [5, 4], M12: [6, 4.8], M16: [8, 6.4], M20: [10, 8],
};
const PITCH = { M3: 0.5, M4: 0.7, M5: 0.8, M6: 1, M8: 1.25, M10: 1.5, M12: 1.75, M14: 2, M16: 2, M20: 2.5, M24: 3 };
const CLEARANCE = { M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5, M14: 15.5, M16: 17.5, M20: 22, M24: 26 }; // ISO 273 normal
const PINS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20]; // ISO 8734 diameters
const BEARINGS = { // 6000 and 6200 series: d bore, D outside, B width
  6000: [10, 26, 8], 6001: [12, 28, 8], 6002: [15, 32, 9], 6003: [17, 35, 10], 6004: [20, 42, 12], 6005: [25, 47, 12], 6006: [30, 55, 13], 6007: [35, 62, 14], 6008: [40, 68, 15],
  6200: [10, 30, 9], 6201: [12, 32, 10], 6202: [15, 35, 11], 6203: [17, 40, 12], 6204: [20, 47, 14], 6205: [25, 52, 15], 6206: [30, 62, 16], 6207: [35, 72, 17], 6208: [40, 80, 18],
};
const CIRCLIP_EXT = { // DIN 471, for shafts: d1 shaft → [s thickness, d3 inside (free)]
  10: [1, 9.3], 12: [1, 11], 15: [1, 13.8], 17: [1, 15.7], 20: [1.2, 18.5], 25: [1.2, 23.2], 30: [1.5, 27.9], 35: [1.5, 32.2], 40: [1.75, 36.5], 45: [1.75, 41.5], 50: [2, 45.8],
};
const CIRCLIP_INT = { // DIN 472, for bores: d1 bore → [s thickness, d3 outside (free)]
  12: [1, 13], 15: [1, 16.2], 20: [1, 21.5], 25: [1.2, 26.9], 30: [1.2, 32.1], 35: [1.5, 37.8], 40: [1.75, 43.5], 47: [1.75, 50.8], 52: [2, 56.2], 62: [2, 66.9],
};
const KEYS = [ // DIN 6885 A: [shaft over, up to, b width, h height]
  [6, 8, 2, 2], [8, 10, 3, 3], [10, 12, 4, 4], [12, 17, 5, 5], [17, 22, 6, 6], [22, 30, 8, 7], [30, 38, 10, 8], [38, 44, 12, 8], [44, 50, 14, 9], [50, 58, 16, 10],
];
const KEY_LENGTHS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 32, 36, 40, 45, 50, 56, 63, 70, 80, 90, 100];
const RIVETS = [2, 2.5, 3, 4, 5, 6, 8, 10]; // ISO 1051 shank diameters (head ≈ 1.75 d across, 0.6 d high)
const LENGTHS = [3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200];
// inch (dimensions in inches): ASME B18.2.1 hex bolts [F across flats, H head height]; B18.2.2 hex nuts [F, H];
// B18.3 socket head cap screws [A head diameter, H head height, J hex key]; SAE washers [ID, OD, thickness];
// UNC thread, normal clearance hole, tap drill
const IN_SIZES = ['1/4-20', '5/16-18', '3/8-16', '7/16-14', '1/2-13', '5/8-11', '3/4-10', '7/8-9', '1-8'];
const IN_D = { '1/4-20': 0.25, '5/16-18': 0.3125, '3/8-16': 0.375, '7/16-14': 0.4375, '1/2-13': 0.5, '5/8-11': 0.625, '3/4-10': 0.75, '7/8-9': 0.875, '1-8': 1 };
const IN_BOLT = { '1/4-20': [0.4375, 0.156], '5/16-18': [0.5, 0.203], '3/8-16': [0.5625, 0.234], '7/16-14': [0.625, 0.281], '1/2-13': [0.75, 0.312], '5/8-11': [0.9375, 0.391], '3/4-10': [1.125, 0.469], '7/8-9': [1.3125, 0.547], '1-8': [1.5, 0.609] };
const IN_NUT = { '1/4-20': [0.4375, 0.219], '5/16-18': [0.5, 0.266], '3/8-16': [0.5625, 0.328], '7/16-14': [0.625, 0.375], '1/2-13': [0.75, 0.438], '5/8-11': [0.9375, 0.547], '3/4-10': [1.125, 0.641], '7/8-9': [1.3125, 0.75], '1-8': [1.5, 0.859] };
const IN_SOCKET = { '1/4-20': [0.375, 0.25, 0.1875], '5/16-18': [0.469, 0.3125, 0.25], '3/8-16': [0.5625, 0.375, 0.3125], '1/2-13': [0.75, 0.5, 0.375], '5/8-11': [0.9375, 0.625, 0.5], '3/4-10': [1.125, 0.75, 0.625], '1-8': [1.5, 1, 0.75] };
const IN_WASHER = { '1/4-20': [0.281, 0.625, 0.065], '5/16-18': [0.344, 0.688, 0.065], '3/8-16': [0.406, 0.812, 0.065], '7/16-14': [0.469, 0.922, 0.065], '1/2-13': [0.531, 1.062, 0.095], '5/8-11': [0.656, 1.312, 0.095], '3/4-10': [0.812, 1.469, 0.134], '7/8-9': [0.938, 1.75, 0.134], '1-8': [1.062, 2, 0.134] };
const IN_CLEAR = { '1/4-20': 0.281, '5/16-18': 0.344, '3/8-16': 0.406, '7/16-14': 0.469, '1/2-13': 0.531, '5/8-11': 0.656, '3/4-10': 0.812, '7/8-9': 0.938, '1-8': 1.062 };
const IN_TAP = { '1/4-20': 0.201, '5/16-18': 0.257, '3/8-16': 0.3125, '7/16-14': 0.368, '1/2-13': 0.4219, '5/8-11': 0.5312, '3/4-10': 0.6562, '7/8-9': 0.7656, '1-8': 0.875 };
const IN_LENGTHS = [0.5, 0.625, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5, 4, 4.5, 5, 6];
const nominal = (m) => Number(String(m).replace(/^[MØ]/, ''));
const inch = (t) => t.endsWith('In');

export const STD_TYPES = [
  { id: 'hexBolt', label: 'Hex Bolt (ISO 4017)', sizes: Object.keys(HEX_BOLT), length: true, fastener: true },
  { id: 'socketScrew', label: 'Socket Head Cap Screw (ISO 4762)', sizes: Object.keys(SOCKET), length: true, fastener: true },
  { id: 'setScrew', label: 'Socket Set Screw (ISO 4026)', sizes: Object.keys(SET_SCREW), length: true },
  { id: 'hexNut', label: 'Hex Nut (ISO 4032)', sizes: Object.keys(NUT) },
  { id: 'washer', label: 'Washer (ISO 7089)', sizes: Object.keys(WASHER) },
  { id: 'dowelPin', label: 'Dowel Pin (ISO 8734)', sizes: PINS.map((d) => 'Ø' + d), length: true },
  { id: 'rivet', label: 'Round Head Rivet (ISO 1051)', sizes: RIVETS.map((d) => 'Ø' + d), length: true },
  { id: 'circlipExt', label: 'Circlip for Shafts (DIN 471)', sizes: Object.keys(CIRCLIP_EXT).map((d) => 'Ø' + d) },
  { id: 'circlipInt', label: 'Circlip for Bores (DIN 472)', sizes: Object.keys(CIRCLIP_INT).map((d) => 'Ø' + d) },
  { id: 'key', label: 'Parallel Key (DIN 6885 A)', sizes: KEYS.map(([, , b, h]) => `${b}×${h}`), length: true },
  { id: 'bearing', label: 'Ball Bearing (6000 / 6200)', sizes: Object.keys(BEARINGS) },
  { id: 'hexBoltIn', label: 'Hex Bolt (ASME, inch)', sizes: IN_SIZES, length: true, fastener: true, inch: true },
  { id: 'socketScrewIn', label: 'Socket Head Cap Screw (ASME, inch)', sizes: Object.keys(IN_SOCKET), length: true, fastener: true, inch: true },
  { id: 'hexNutIn', label: 'Hex Nut (ASME, inch)', sizes: IN_SIZES, inch: true },
  { id: 'washerIn', label: 'Flat Washer (SAE, inch)', sizes: IN_SIZES, inch: true },
];
const typeOf = (id) => STD_TYPES.find((x) => x.id === id);
// the washer and nut that go with a bolt or screw (fastener sets)
export function setParts(type, size) {
  return inch(type) ? { washer: ['washerIn', size], nut: ['hexNutIn', size] } : { washer: ['washer', size], nut: ['hexNut', size] };
}

// the standard lengths that make sense for a size (mm; bolts about 1.2 d to 12 d)
export function stdLengths(type, size) {
  if (inch(type)) { const d = IN_D[size] || 0.25; return IN_LENGTHS.filter((L) => L >= 1.5 * d && L <= Math.max(2, 12 * d)).map((L) => L * IN); }
  if (type === 'key') { const k = KEYS.find(([, , b, h]) => `${b}×${h}` === size) || KEYS[0]; return KEY_LENGTHS.filter((L) => L >= 2 * k[2] && L <= 12 * k[2]); }
  const d = nominal(size), lo = type === 'dowelPin' ? 2 : type === 'setScrew' ? 0.8 : 1.2;
  return LENGTHS.filter((L) => L >= Math.max(3, lo * d) && L <= Math.max(30, (type === 'setScrew' ? 6 : 12) * d));
}
// a length as it is written for the part ("20", "1-1/4")
export function lengthLabel(type, L) {
  if (!inch(type)) return String(+(+L).toFixed(2));
  const x = L / IN, w = Math.floor(x + 1e-9), f = Math.round((x - w) * 16);
  if (!f) return `${w}`;
  const g = f % 8 === 0 ? [f / 8, 2] : f % 4 === 0 ? [f / 4, 4] : f % 2 === 0 ? [f / 2, 8] : [f, 16];
  return `${w ? w + '-' : ''}${g[0]}/${g[1]}`;
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
    ids.forEach((id, i) => { if (l.open && i === ids.length - 1) return; curves.push({ id: 'c' + ++n, type: 'line', p1: id, p2: ids[(i + 1) % ids.length], construction: false }); });
  }
  Object.assign(s, { points, curves, constraints: [] });
  doc.features.push(s);
  return s;
}
const hexagon = (s) => ({ pts: Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 3) * i, R = s / Math.sqrt(3); return [R * Math.cos(a), R * Math.sin(a)]; }) });
const circle = (r, c = [0, 0]) => ({ circle: true, c, r });
const rect = (x0, y0, x1, y1) => ({ pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const add = (doc, type, props) => { const f = createFeature(doc, type, props); doc.features.push(f); return f; };
const thread = (doc, system, size, p, end = 'through', depth = 10) => add(doc, 'cosmeticThread', { face: { p }, system, size, end, depth });
const r3 = (x) => +x.toFixed(3);

// The part, and where it seats.
export function makeStdPart(type, size, length = null, material = 'steel') {
  const doc = newDoc();
  doc.material = material;
  const axis = { kind: 'axis', p: [0, 0, 0], d: [0, 1, 0], what: 'Axis' };
  let seat = { kind: 'plane', p: [0, 0, 0], n: [0, -1, 0], what: 'Seat' }, align = -1, top = null;
  let name;
  const lenOf = (i) => Number(length) || stdLengths(type, size)[i] || stdLengths(type, size)[0] || 10;
  if (type === 'hexBolt' || type === 'socketScrew' || type === 'hexBoltIn' || type === 'socketScrewIn') {
    const isIn = inch(type), d = isIn ? IN_D[size] * IN : nominal(size), L = lenOf(3);
    if (type === 'hexBolt' || type === 'hexBoltIn') {
      const [s, k] = isIn ? IN_BOLT[size].map((x) => x * IN) : HEX_BOLT[size];
      add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [hexagon(s)]).id, depth: k });
      name = isIn ? `Hex Bolt ${size}×${lengthLabel(type, L)}" ASME B18.2.1` : `Hex Bolt ${size}×${L} ISO 4017`;
    } else {
      const [dk, k, s, t] = isIn ? [...IN_SOCKET[size].map((x) => x * IN), IN_SOCKET[size][1] * IN * 0.5] : SOCKET[size];
      add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(dk / 2)]).id, depth: k });
      const pl = add(doc, 'plane', { refs: [{ kind: 'plane', id: 'top' }], offset: k });
      add(doc, 'extrude', { sketch: sketchOf(doc, pl.id, [hexagon(s)]).id, op: 'cut', depth: t, reverse: true });
      name = isIn ? `Socket Head Cap Screw ${size}×${lengthLabel(type, L)}" ASME B18.3` : `Socket Head Cap Screw ${size}×${L} ISO 4762`;
    }
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(d / 2)]).id, depth: L, reverse: true });
    thread(doc, isIn ? 'imperial' : 'metric', isIn ? `${size} UNC` : size, [d / 2, -L / 2, 0]);
    axis.r = d / 2;
  } else if (type === 'setScrew') {
    const d = nominal(size), [s, t] = SET_SCREW[size], L = lenOf(2);
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(d / 2)]).id, depth: L, reverse: true });
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [hexagon(s)]).id, op: 'cut', depth: t, reverse: true });
    thread(doc, 'metric', size, [d / 2, -L / 2, 0]);
    axis.r = d / 2;
    seat = { kind: 'plane', p: [0, 0, 0], n: [0, 1, 0], what: 'Top' }; align = 1; // (flush with the hole's end)
    name = `Socket Set Screw ${size}×${L} ISO 4026`;
  } else if (type === 'hexNut' || type === 'hexNutIn') {
    const isIn = inch(type);
    const d = isIn ? IN_D[size] * IN : nominal(size), [s, m] = isIn ? IN_NUT[size].map((x) => x * IN) : NUT[size];
    const P0 = isIn ? IN / Number(size.split('-')[1]) : PITCH[size], D1 = d - 1.0825 * P0;
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [hexagon(s), circle(D1 / 2)]).id, depth: m });
    thread(doc, isIn ? 'imperial' : 'metric', isIn ? `${size} UNC` : size, [D1 / 2, m / 2, 0]);
    axis.r = D1 / 2;
    name = isIn ? `Hex Nut ${size} ASME B18.2.2` : `Hex Nut ${size} ISO 4032`;
  } else if (type === 'washer' || type === 'washerIn') {
    const [d1, d2, h] = type === 'washerIn' ? IN_WASHER[size].map((x) => x * IN) : WASHER[size];
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(d2 / 2), circle(d1 / 2)]).id, depth: h });
    axis.r = d1 / 2;
    top = { kind: 'plane', p: [0, r3(h), 0], n: [0, 1, 0], what: 'Top' };
    name = type === 'washerIn' ? `Flat Washer ${size.split('-')[0]}" SAE` : `Washer ${size} ISO 7089`;
  } else if (type === 'dowelPin') {
    const d = nominal(size), L = lenOf(2);
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(d / 2)]).id, depth: L, reverse: true });
    axis.r = d / 2;
    seat = { kind: 'plane', p: [0, -L / 2, 0], n: [0, 1, 0], what: 'Middle' }; align = 1; // (half in the hole)
    name = `Dowel Pin Ø${d}×${L} ISO 8734`;
  } else if (type === 'rivet') {
    // (a round head, made by turning its profile: the shank down from the head's underside)
    const d = nominal(size), L = lenOf(2), R = 0.875 * d, k = 0.6 * d;
    const arc = Array.from({ length: 9 }, (_, i) => { const a = (Math.PI / 2) * (i / 8); return [r3(R * Math.cos(a)), r3(k * Math.sin(a))]; });
    const prof = sketchOf(doc, 'front', [{ pts: [[0, 0], ...arc.slice(0, -1), [0, k]] }]);
    add(doc, 'revolve', { sketch: prof.id, axis: 'v', angle: 360 });
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(d / 2)]).id, depth: L, reverse: true });
    axis.r = d / 2;
    name = `Round Head Rivet Ø${d}×${L} ISO 1051`;
  } else if (type === 'circlipExt' || type === 'circlipInt') {
    // (a flat ring with its gap; the lugs left out). On a shaft its inside is the groove's, in a bore its outside.
    const d1 = nominal(size), ext = type === 'circlipExt', [s, d3] = (ext ? CIRCLIP_EXT : CIRCLIP_INT)[d1];
    const w = r3(0.08 * d1 + 1.2), ri = ext ? d3 / 2 : d3 / 2 - w, ro = ext ? d3 / 2 + w : d3 / 2;
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(ro), circle(ri)]).id, depth: s });
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [rect(-0.12 * d1, ri - 1, 0.12 * d1, ro + 1)]).id, op: 'cut', depth: s });
    axis.r = d1 / 2;
    seat = { kind: 'plane', p: [0, s, 0], n: [0, 1, 0], what: 'Face' }; align = 1; // (just inside the end)
    name = `Circlip ${ext ? 'for Shafts' : 'for Bores'} Ø${d1} ${ext ? 'DIN 471' : 'DIN 472'}`;
  } else if (type === 'key') {
    const k = KEYS.find(([, , b, h]) => `${b}×${h}` === size) || KEYS[0], b = k[2], h = k[3], L = lenOf(3);
    // (round ends: a block and a half round at each end)
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [rect(-(L - b) / 2, -b / 2, (L - b) / 2, b / 2)]).id, depth: h });
    add(doc, 'extrude', { sketch: sketchOf(doc, 'top', [circle(b / 2, [-(L - b) / 2, 0]), circle(b / 2, [(L - b) / 2, 0])]).id, depth: h });
    axis.r = b / 2;
    name = `Parallel Key ${b}×${h}×${L} DIN 6885 A`;
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
  return { doc, name, key: `${type}|${size}|${length ?? ''}|${material}`, axis, seat, align, top };
}

// The size that fits a hole (or shaft) of diameter `dia`, and for parts with a length one for a hole `depth` deep
// (extra: what else goes on the bolt, e.g. washers and a nut).
export function fitToHole(type, dia, depth = 0, extra = 0) {
  const t = typeOf(type);
  const near = (list, f) => list.reduce((b, x) => (Math.abs(f(x) - dia) < Math.abs(f(b) - dia) ? x : b), list[0]);
  let size;
  if (type === 'bearing') size = near(Object.keys(BEARINGS), (k) => BEARINGS[k][1]);
  else if (type === 'dowelPin' || type === 'rivet') size = near(t.sizes, (s) => nominal(s) * (type === 'rivet' ? 1.06 : 1));
  else if (type === 'circlipExt' || type === 'circlipInt') size = near(t.sizes, nominal);
  else if (type === 'key') { const k = KEYS.find(([lo, hi]) => dia > lo - 1e-6 && dia <= hi + 1e-6) || (dia > 58 ? KEYS[KEYS.length - 1] : KEYS[0]); size = `${k[2]}×${k[3]}`; }
  else if (t.inch) {
    const score = (m) => Math.min(Math.abs(IN_CLEAR[m] * IN - dia), Math.abs(IN_TAP[m] * IN - dia), Math.abs(IN_D[m] * IN - dia) + 0.3);
    size = t.sizes.reduce((b, m) => (score(m) < score(b) ? m : b), t.sizes[0]);
  } else {
    // a clearance hole or a tapped one (drilled at about the minor diameter)
    const score = (m) => Math.min(Math.abs((CLEARANCE[m] ?? 1e9) - dia), Math.abs(nominal(m) - PITCH[m] - dia), Math.abs(nominal(m) - dia) + 0.3);
    size = t.sizes.reduce((b, m) => (score(m) < score(b) ? m : b), t.sizes[0]);
  }
  return { size, length: fitLength(type, size, depth, extra) };
}
// the standard length for a hole `depth` deep: a bolt through it (and `extra`) with room for a nut, a set screw
// inside it, a pin half in it, a rivet through it with 1.5 d to form its head (null: the part has no length)
export function fitLength(type, size, depth = 0, extra = 0) {
  if (!typeOf(type)?.length) return null;
  const d = inch(type) ? (IN_D[size] || 0.25) * IN : type === 'key' ? 0 : nominal(size);
  const ls = stdLengths(type, size);
  if (type === 'setScrew') return [...ls].reverse().find((L) => L <= Math.max(depth, ls[0]) + 1e-6) ?? ls[0];
  if (type === 'key') return ls[Math.min(3, ls.length - 1)];
  const want = type === 'dowelPin' ? 2 * depth : type === 'rivet' ? depth + 1.5 * d : depth + extra + (extra ? 0.3 * d : 0.8 * d);
  return ls.find((L) => L >= want - 1e-6) ?? ls[ls.length - 1];
}
// how tall a washer / nut is (for the bolt length of a fastener set)
export function heightOf(type, size) {
  if (type === 'washer') return WASHER[size]?.[2] || 0;
  if (type === 'washerIn') return (IN_WASHER[size]?.[2] || 0) * IN;
  if (type === 'hexNut') return NUT[size]?.[1] || 0;
  if (type === 'hexNutIn') return (IN_NUT[size]?.[1] || 0) * IN;
  return 0;
}
