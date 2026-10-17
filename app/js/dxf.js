// DXF output of flat patterns (sheet metal): layers with colours and line types (the "DXF mapping"),
// options for what to include, and the writer (DXF R12, readable by laser / punch software).

// DXF colour index (ACI): the standard colours
export const ACI = [
  [1, 'Red', '#ff0000'], [2, 'Yellow', '#ffff00'], [3, 'Green', '#00ff00'], [4, 'Cyan', '#00ffff'],
  [5, 'Blue', '#0000ff'], [6, 'Magenta', '#ff00ff'], [7, 'White / black', '#ffffff'], [8, 'Dark grey', '#808080'], [9, 'Light grey', '#c0c0c0'],
  [30, 'Orange', '#ff7f00'], [40, 'Light orange', '#ffbf00'], [140, 'Light blue', '#0080ff'], [210, 'Pink', '#ff00bf'],
];
export const aciColor = (n) => ACI.find((c) => c[0] === n)?.[2] || '#ffffff';

// line types: pattern in drawing units (dash > 0, gap < 0, 0 = dot)
export const LTYPES = {
  CONTINUOUS: { label: 'Continuous', pattern: [] },
  DASHED: { label: 'Dashed', pattern: [5, -2.5] },
  HIDDEN: { label: 'Hidden', pattern: [2.5, -1.25] },
  CENTER: { label: 'Center', pattern: [12.5, -2.5, 2.5, -2.5] },
  PHANTOM: { label: 'Phantom', pattern: [12.5, -2.5, 2.5, -2.5, 2.5, -2.5] },
  DASHDOT: { label: 'Dash dot', pattern: [5, -2.5, 0, -2.5] },
  DOT: { label: 'Dotted', pattern: [0, -1.25] },
};

// default layers: up bends red, down bends blue, etch yellow dashed
export const DEFAULT_MAPPING = {
  OUTLINE: { label: 'Outline (cut)', color: 7, ltype: 'CONTINUOUS' },
  HOLES: { label: 'Holes and cut-outs', color: 7, ltype: 'CONTINUOUS' },
  BEND_UP: { label: 'Bend lines — up', color: 1, ltype: 'CENTER' },
  BEND_DOWN: { label: 'Bend lines — down', color: 5, ltype: 'CENTER' },
  BEND_REGION: { label: 'Bend region (hidden) lines', color: 8, ltype: 'HIDDEN' },
  ETCH: { label: 'Etch lines', color: 2, ltype: 'DASHED' },
  FORMING: { label: 'Forming marks (cross breaks, forms)', color: 6, ltype: 'DASHDOT' },
  NOTES: { label: 'Bend notes and part info', color: 3, ltype: 'CONTINUOUS' },
};
export const DEFAULT_OPTIONS = { bendLines: true, bendNotes: true, bendRegion: false, etch: true, forming: true, partInfo: false };
export const OPTION_LABELS = {
  bendLines: 'Bend lines (centre of each bend)',
  bendNotes: 'Bend notes (direction, angle, radius)',
  bendRegion: 'Bend region lines (where each bend starts and ends, hidden line type)',
  etch: 'Etch lines',
  forming: 'Forming marks (cross breaks, forms)',
  partInfo: 'Part information (name, material, thickness, quantity, size)',
};

const KEY = 'razorcad.dxfMapping.v1';
export function loadDxfSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* no storage */ }
  const mapping = structuredClone(DEFAULT_MAPPING);
  for (const [k, v] of Object.entries(s?.mapping || {})) if (mapping[k]) Object.assign(mapping[k], { color: v.color, ltype: v.ltype });
  return { mapping, options: { ...DEFAULT_OPTIONS, ...(s?.options || {}) } };
}
export function saveDxfSettings({ mapping, options }) {
  const m = {};
  for (const [k, v] of Object.entries(mapping)) m[k] = { color: v.color, ltype: v.ltype };
  try { localStorage.setItem(KEY, JSON.stringify({ mapping: m, options })); } catch { /* no storage */ }
}

// which entities an export includes, with the part information block (below the pattern) when wanted
export function selectEnts(ents, options, info = null) {
  const out = ents.filter((e) => {
    if (e.layer === 'BEND_UP' || e.layer === 'BEND_DOWN') return options.bendLines;
    if (e.layer === 'BEND_REGION') return options.bendRegion;
    if (e.layer === 'ETCH') return options.etch;
    if (e.layer === 'FORMING') return options.forming !== false;
    if (e.layer === 'NOTES') return options.bendNotes;
    return true;
  });
  if (options.partInfo && info?.lines?.length) {
    const h = info.h || 3;
    info.lines.forEach((text, i) => out.push({ type: 'TEXT', layer: 'NOTES', p: [0, -h * 2 - i * h * 1.6], h, rot: 0, text, _id: 'info' + i }));
  }
  return out;
}

export function buildDXF(ents, mapping) {
  const out = [];
  const intCode = (c) => (c >= 60 && c <= 99) || (c >= 170 && c <= 179) || (c >= 270 && c <= 289);
  const num = (c, v) => (intCode(c) ? String(Math.round(v)) : Math.abs(v) < 1e-12 ? '0.0' : String(+v.toFixed(9)));
  const g = (code, v) => out.push(String(code), typeof v === 'number' ? num(code, v) : String(v));
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const ext = (p, r = 0) => { xmin = Math.min(xmin, p[0] - r); ymin = Math.min(ymin, p[1] - r); xmax = Math.max(xmax, p[0] + r); ymax = Math.max(ymax, p[1] + r); };
  for (const e of ents) {
    if (e.type === 'LINE') { ext(e.a); ext(e.b); } else if (e.type === 'TEXT') ext(e.p); else if (e.c) ext(e.c, e.r); else e.pts.forEach((p) => ext(p));
  }
  if (!isFinite(xmin)) { xmin = ymin = 0; xmax = ymax = 1; }
  const usedLayers = [...new Set(ents.map((e) => e.layer))];
  // (an entity may have its own line type, set in the preview: e.ltype; otherwise its layer's)
  const usedTypes = [...new Set([...usedLayers.map((l) => mapping[l]?.ltype || 'CONTINUOUS'), ...ents.filter((e) => e.type !== 'TEXT' && e.ltype && LTYPES[e.ltype]).map((e) => e.ltype)])];
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4); // millimetres
  g(9, '$EXTMIN'); g(10, xmin); g(20, ymin); g(30, 0);
  g(9, '$EXTMAX'); g(10, xmax); g(20, ymax); g(30, 0);
  g(9, '$LTSCALE'); g(40, 1);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, usedTypes.length + 1);
  for (const name of ['CONTINUOUS', ...usedTypes.filter((n) => n !== 'CONTINUOUS')]) {
    const lt = LTYPES[name] || LTYPES.CONTINUOUS;
    g(0, 'LTYPE'); g(2, name); g(70, 0); g(3, lt.label); g(72, 65); g(73, lt.pattern.length);
    g(40, lt.pattern.reduce((s, x) => s + Math.abs(x), 0));
    for (const x of lt.pattern) g(49, x);
  }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, usedLayers.length);
  for (const name of usedLayers) { const m = mapping[name] || { color: 7, ltype: 'CONTINUOUS' }; g(0, 'LAYER'); g(2, name); g(70, 0); g(62, m.color); g(6, m.ltype); }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const L = (e) => { g(8, e.layer); if (e.ltype && LTYPES[e.ltype]) g(6, e.ltype); };
  for (const e of ents) {
    if (e.type === 'LINE') { g(0, 'LINE'); L(e); g(10, e.a[0]); g(20, e.a[1]); g(30, 0); g(11, e.b[0]); g(21, e.b[1]); g(31, 0); }
    else if (e.type === 'CIRCLE') { g(0, 'CIRCLE'); L(e); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); }
    else if (e.type === 'ARC') { g(0, 'ARC'); L(e); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); g(50, e.a0); g(51, e.a1); }
    else if (e.type === 'TEXT') {
      g(0, 'TEXT'); g(8, e.layer); g(10, e.p[0]); g(20, e.p[1]); g(30, 0); g(40, e.h); g(1, e.text.replace(/°/g, '%%d').replace(/[ØⲐ⌀]/g, '%%c').replace(/±/g, '%%p').replace(/×/g, 'x').replace(/[^ -~%]/g, '?'));
      if (e.rot) g(50, e.rot);
      if (e.align === 'center') { g(72, 1); g(11, e.p[0]); g(21, e.p[1]); g(31, 0); }
    } else {
      g(0, 'POLYLINE'); L(e); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, e.closed ? 1 : 0);
      const pts = e.closed ? e.pts.slice(0, -1) : e.pts;
      for (const p of pts) { g(0, 'VERTEX'); g(8, e.layer); g(10, p[0]); g(20, p[1]); g(30, 0); }
      g(0, 'SEQEND'); g(8, e.layer);
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

// A file name from a body name (no characters Windows forbids).
export const dxfFileName = (name) => `${String(name || 'Flat pattern').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+$/, '') || 'Flat pattern'}.dxf`;
