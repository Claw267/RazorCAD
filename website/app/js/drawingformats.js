// Drawing sheet formats: paper sizes, the frame with its zones, the title block and the projection
// symbol. A format is drawn as display-list primitives (see drawing.js) in sheet millimetres, origin
// at the top-left corner of the paper, y downward.

export const SHEET_SIZES = {
  A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210],
};

// ISO line widths (mm)
// Section hatching per body / component (by its index): the angle alternates and the spacing varies, so
// neighbouring parts read apart. [angle in degrees, spacing × the base gap]
export const HATCH_STYLES = [[45, 1], [135, 1.5], [30, 1], [150, 1.5], [60, 2], [120, 0.75], [45, 2], [135, 0.75]];
export function hatchStyle(k) { const [angle, mult] = HATCH_STYLES[((k % HATCH_STYLES.length) + HATCH_STYLES.length) % HATCH_STYLES.length]; return { angle, mult }; }

export const LW = { thick: 0.5, visible: 0.35, thin: 0.18, frame: 0.7, hatch: 0.13 };

// The paper's size in mm [width, height] for a sheet (orientation applied).
export function paperSize(sheet) {
  const [a, b] = SHEET_SIZES[sheet.size] || SHEET_SIZES.A3;
  const land = sheet.orientation !== 'portrait';
  return land ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)];
}

// A drawing's own sheet format (a company border and title block, brought in by its template):
// { name, size, orientation, font, frame: {x0,y0,x1,y1}, titleBlock: {x0,y0,x1,y1}, fields: [[key, label]…],
//   prims: [display primitives in sheet mm; text may show {title}, {number}… (the drawing's properties)
//   and {scale}, {size}, {sheet}, {sheets}; { t: 'projection', c } is the projection symbol] }.
// font: the family (fonts.js) its text is set in, unless a text names its own.
// It is used on the sheets of its size and orientation; other sheets get the standard format.
export function sheetFormat(sheet, fmt) {
  if (!fmt || !Array.isArray(fmt.prims) || fmt.size !== sheet.size) return null;
  return (fmt.orientation === 'portrait') === (sheet.orientation === 'portrait') ? fmt : null;
}

// The frame (ISO 5457): 20 mm filing margin on the left, 10 mm on the other sides.
export function frameRect(sheet, fmt) {
  const cf = sheetFormat(sheet, fmt);
  if (cf?.frame) return { ...cf.frame };
  const [W, H] = paperSize(sheet);
  return { x0: 20, y0: 10, x1: W - 10, y1: H - 10 };
}

// Title block fields: [key, label]. Values come from the drawing's properties (drawing.props).
export const TITLE_FIELDS = [
  ['title', 'Title'], ['number', 'Drawing No.'], ['material', 'Material'], ['finish', 'Finish'],
  ['drawnBy', 'Drawn'], ['checkedBy', 'Checked'], ['approvedBy', 'Approved'], ['date', 'Date'],
  ['company', 'Company'], ['revision', 'Rev'], ['tolerance', 'General tolerances'], ['mass', 'Mass'],
];

const TB_W = 180, TB_H = 44;

// The title block's rectangle (bottom right, inside the frame).
export function titleBlockRect(sheet, fmt) {
  const cf = sheetFormat(sheet, fmt);
  if (cf?.titleBlock) return { ...cf.titleBlock };
  const f = frameRect(sheet);
  return { x0: f.x1 - TB_W, y0: f.y1 - TB_H, x1: f.x1, y1: f.y1 };
}

// The fonts a drawing's text needs: [[family, bold]…] (from its sheet format).
export function formatFonts(fmt) {
  const out = new Map();
  for (const q of fmt?.prims || []) if (q.t === 'text' && (q.font || fmt.font)) out.set(`${q.font || fmt.font}|${q.bold ? 1 : 0}`, [q.font || fmt.font, !!q.bold]);
  return [...out.values()];
}

// The title block fields shown in the Drawing Properties dialog: the format's own, else the standard ones.
export function titleFields(fmt) {
  return Array.isArray(fmt?.fields) && fmt.fields.length ? fmt.fields : TITLE_FIELDS;
}

// A drawing's own format drawn on a sheet: its primitives with the fields filled in.
function customFormatPrims(sheet, fmt, info) {
  const [W, H] = paperSize(sheet);
  const vals = { ...(info.props || {}), scale: info.scaleText, size: info.sizeName, sheet: info.sheetNo, sheets: info.sheetCount };
  const P = [{ t: 'poly', pts: [[0, 0], [W, 0], [W, H], [0, H]], closed: true, w: 0.1, color: '#9aa3ad', paper: true }];
  for (const q of fmt.prims) {
    if (q.t === 'text') {
      const s = String(q.text ?? '').replace(/\{(\w+)\}/g, (_, k) => vals[k] ?? '');
      const font = q.font || fmt.font;
      if (s.trim()) P.push({ ...q, text: s, ...(font ? { font } : {}) });
    } else if (q.t === 'projection') P.push(...projectionSymbol(q.c, info.projection));
    else P.push({ ...q });
  }
  return P;
}

// Display list of the sheet format. info: { props, scaleText, sheetNo, sheetCount, projection, sizeName, format }
export function formatPrims(sheet, info) {
  const cf = sheetFormat(sheet, info.format);
  if (cf) return customFormatPrims(sheet, cf, info);
  const P = [];
  const line = (a, b, w = LW.thin) => P.push({ t: 'line', a, b, w });
  const text = (p, s, h, o = {}) => { if (s !== undefined && s !== null && String(s) !== '') P.push({ t: 'text', p, text: String(s), h, ...o }); };
  const [W, H] = paperSize(sheet);
  const f = frameRect(sheet);
  // paper edge (thin, for the trimmed sheet) and the frame
  P.push({ t: 'poly', pts: [[0, 0], [W, 0], [W, H], [0, H]], closed: true, w: 0.1, color: '#9aa3ad', paper: true });
  P.push({ t: 'poly', pts: [[f.x0, f.y0], [f.x1, f.y0], [f.x1, f.y1], [f.x0, f.y1]], closed: true, w: LW.frame });
  // centring marks
  line([W / 2, 0], [W / 2, f.y0 + 5], LW.frame); line([W / 2, H], [W / 2, f.y1 - 5], LW.frame);
  line([0, H / 2], [f.x0 + 5, H / 2], LW.frame); line([W, H / 2], [f.x1 - 5, H / 2], LW.frame);
  // zones: numbers across, letters down (about 50 mm fields)
  const nx = Math.max(2, Math.round((f.x1 - f.x0) / 50)), ny = Math.max(2, Math.round((f.y1 - f.y0) / 50));
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let i = 0; i < nx; i++) {
    const x = f.x0 + ((f.x1 - f.x0) * (i + 0.5)) / nx;
    if (i) { const xs = f.x0 + ((f.x1 - f.x0) * i) / nx; line([xs, f.y0 - 5], [xs, f.y0]); line([xs, f.y1], [xs, f.y1 + 5]); }
    text([x, f.y0 - 2.5], i + 1, 2.5, { anchor: 'middle', base: 'middle' });
    text([x, f.y1 + 2.5], i + 1, 2.5, { anchor: 'middle', base: 'middle' });
  }
  for (let j = 0; j < ny; j++) {
    const y = f.y0 + ((f.y1 - f.y0) * (j + 0.5)) / ny;
    if (j) { const ys = f.y0 + ((f.y1 - f.y0) * j) / ny; line([f.x0 - 5, ys], [f.x0, ys]); line([f.x1, ys], [f.x1 + 5, ys]); }
    text([f.x0 - 2.5 - 5, y], letters[j], 2.5, { anchor: 'middle', base: 'middle' });
    text([f.x1 + 2.5 + 0, y], letters[j], 2.5, { anchor: 'middle', base: 'middle' });
  }
  // the zone band on the left sits in the filing margin: a line 5 mm outside the frame
  line([f.x0 - 5, f.y0], [f.x0 - 5, f.y1]);
  line([f.x1 + 5, f.y0], [f.x1 + 5, f.y1]);
  line([f.x0, f.y0 - 5], [f.x1, f.y0 - 5]);
  line([f.x0, f.y1 + 5], [f.x1, f.y1 + 5]);

  // ---- title block
  const tb = titleBlockRect(sheet), pr = info.props || {};
  const x0 = tb.x0, y0 = tb.y0;
  P.push({ t: 'poly', pts: [[tb.x0, tb.y0], [tb.x1, tb.y0], [tb.x1, tb.y1], [tb.x0, tb.y1]], closed: true, w: LW.frame, fill: '#ffffff' });
  // cell: label (small, top left) and value
  const cell = (cx, cy, w, h, label, value, vh = 3.5, o = {}) => {
    P.push({ t: 'poly', pts: [[cx, cy], [cx + w, cy], [cx + w, cy + h], [cx, cy + h]], closed: true, w: LW.thin });
    text([cx + 1, cy + 2.6], label, 1.8, { color: '#444' });
    text(o.center ? [cx + w / 2, cy + h / 2 + 1.6] : [cx + 2, cy + h - 2.2], value, vh, { anchor: o.center ? 'middle' : 'start', base: o.center ? 'middle' : 'bottom', bold: !!o.bold, fit: w - 4 });
  };
  // row 1 (h 10): projection symbol | scale | size | units | material
  let y = y0;
  P.push({ t: 'poly', pts: [[x0, y], [x0 + 26, y], [x0 + 26, y + 10], [x0, y + 10]], closed: true, w: LW.thin });
  P.push(...projectionSymbol([x0 + 13, y + 5], info.projection));
  cell(x0 + 26, y, 22, 10, 'Scale', info.scaleText, 3.5);
  cell(x0 + 48, y, 14, 10, 'Size', info.sizeName, 3.5);
  cell(x0 + 62, y, 18, 10, 'Units', info.units || 'mm', 3.5);
  cell(x0 + 80, y, 100, 10, 'Material', pr.material, 3.5);
  // row 2 (h 10): drawn | checked | approved | date | mass
  y += 10;
  cell(x0, y, 36, 10, 'Drawn', pr.drawnBy, 3);
  cell(x0 + 36, y, 36, 10, 'Checked', pr.checkedBy, 3);
  cell(x0 + 72, y, 36, 10, 'Approved', pr.approvedBy, 3);
  cell(x0 + 108, y, 36, 10, 'Date', pr.date, 3);
  cell(x0 + 144, y, 36, 10, 'Mass', pr.mass, 3);
  // row 3 (h 14): company | title
  y += 10;
  cell(x0, y, 60, 14, 'Company', pr.company, 3.5);
  cell(x0 + 60, y, 120, 14, 'Title', pr.title, 5, { bold: true });
  // row 4 (h 10): drawing number | revision | sheet | general tolerances
  y += 14;
  cell(x0, y, 60, 10, 'Drawing No.', pr.number, 3.5, { bold: true });
  cell(x0 + 60, y, 16, 10, 'Rev', pr.revision, 3.5);
  cell(x0 + 76, y, 24, 10, 'Sheet', `${info.sheetNo} of ${info.sheetCount}`, 3);
  cell(x0 + 100, y, 80, 10, 'General tolerances', pr.tolerance, 2.5);
  return P;
}

// ISO projection symbol (a truncated cone and its end view), centred at c, about 20 x 8 mm.
// First angle: the end view (circles) next to the cone's large end; third angle: next to its small end.
export function projectionSymbol(c, projection = 'first') {
  const P = [];
  const w = LW.thin, R1 = 3.2, R2 = 1.8, L = 7;
  const circ = [c[0] - 5.5, c[1]];
  const cone = c[0] + 1.5; // left end of the trapezoid
  P.push({ t: 'circle', c: circ, r: R1, w }, { t: 'circle', c: circ, r: R2, w });
  // the cone's side view: large end on the left (first angle) or on the right (third angle)
  const [rl, rr] = projection === 'third' ? [R2, R1] : [R1, R2];
  P.push({ t: 'poly', pts: [[cone, c[1] - rl], [cone + L, c[1] - rr], [cone + L, c[1] + rr], [cone, c[1] + rl]], closed: true, w });
  // centre lines
  P.push({ t: 'line', a: [circ[0] - R1 - 1, c[1]], b: [cone + L + 1, c[1]], w: 0.13, dash: [3, 0.8, 0.5, 0.8] });
  P.push({ t: 'line', a: [circ[0], c[1] - R1 - 1], b: [circ[0], c[1] + R1 + 1], w: 0.13, dash: [3, 0.8, 0.5, 0.8] });
  return P;
}
