// A small PDF writer for drawings: one page per sheet, vector lines, fills, hatching (clipped to
// the cut faces), clipped detail views, text in the standard Helvetica fonts (not embedded) or in a
// TrueType font from the PC (embedded, for a sheet format's own font) and JPEG pictures (a logo).
// Input: pages [{ size: [w, h] mm, prims }] with primitives as described in drawing.js.
import { CAP, capOf, textWidth } from './drawing.js';
import { drawingFont } from './fonts.js';

// WinAnsi (Windows-1252) byte -> character, for an embedded font's widths
const CP1252 = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 256 }, (_, i) => i));

const PT = 72 / 25.4; // points per mm

// WinAnsi bytes for a string (unknown characters become '?').
const WIN = { '°': 0xb0, '±': 0xb1, 'Ø': 0xd8, '×': 0xd7, '²': 0xb2, '³': 0xb3, 'µ': 0xb5, '·': 0xb7, '–': 0x96, '—': 0x97, 'é': 0xe9, 'ë': 0xeb, 'è': 0xe8, 'ä': 0xe4, 'ö': 0xf6, 'ü': 0xfc, 'Ä': 0xc4, 'Ö': 0xd6, 'Ü': 0xdc, 'ß': 0xdf, '€': 0x80 };
function pdfString(s) {
  let out = '(';
  for (const ch of String(s)) {
    let c = ch.charCodeAt(0);
    if (c > 126 || c < 32) c = WIN[ch] ?? 63;
    if (c === 40 || c === 41 || c === 92) out += '\\' + String.fromCharCode(c);
    else if (c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

const n = (x) => (Math.abs(x) < 1e-9 ? '0' : (+x.toFixed(3)).toString());
function rgb(color) {
  if (!color) return [0, 0, 0];
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// A JPEG data: URL as bytes with its size and colour channels, or null (other pictures are left out).
function jpegOf(src) {
  const m = /^data:image\/jpe?g;base64,(.*)$/i.exec(String(src || ''));
  if (!m) return null;
  const bin = atob(m[1]), b = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const mk = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    // a start-of-frame marker (not DHT C4, JPG C8, DAC CC) holds the height, width and channels
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      return { bytes: b, h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], comps: b[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

// One page's content stream. image(src) / font(family, bold): the picture's / font's resource name, or
// null when it can't be embedded (a font then falls back to Helvetica).
function pageStream(page, image = () => null, font = () => null) {
  const [W, H] = page.size;
  const X = (x) => n(x * PT), Y = (y) => n((H - y) * PT);
  const ops = ['1 J 1 j'];
  const stroke = (p) => {
    const [r, g, b] = rgb(p.color);
    ops.push(`${n(r)} ${n(g)} ${n(b)} RG ${n((p.w || 0.18) * PT)} w`);
    ops.push(p.dash ? `[${p.dash.map((d) => n(d * PT)).join(' ')}] 0 d` : '[] 0 d');
  };
  const fillColor = (p) => { const [r, g, b] = rgb(typeof p.fill === 'string' ? p.fill : p.color); ops.push(`${n(r)} ${n(g)} ${n(b)} rg`); };
  const circlePath = (c, r) => {
    const k = 0.5522847498 * r;
    const [cx, cy] = c;
    ops.push(`${X(cx + r)} ${Y(cy)} m`);
    ops.push(`${X(cx + r)} ${Y(cy + k)} ${X(cx + k)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c`);
    ops.push(`${X(cx - k)} ${Y(cy + r)} ${X(cx - r)} ${Y(cy + k)} ${X(cx - r)} ${Y(cy)} c`);
    ops.push(`${X(cx - r)} ${Y(cy - k)} ${X(cx - k)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c`);
    ops.push(`${X(cx + k)} ${Y(cy - r)} ${X(cx + r)} ${Y(cy - k)} ${X(cx + r)} ${Y(cy)} c h`);
  };
  const draw = (list) => {
    for (const p of list) {
      if (p.paper) continue; // the trimmed paper edge is the page itself
      if (p.t === 'line') { stroke(p); ops.push(`${X(p.a[0])} ${Y(p.a[1])} m ${X(p.b[0])} ${Y(p.b[1])} l S`); }
      else if (p.t === 'poly') {
        if (p.pts.length < 2) continue;
        ops.push(p.pts.map((q, i) => `${X(q[0])} ${Y(q[1])} ${i ? 'l' : 'm'}`).join(' ') + (p.closed ? ' h' : ''));
        if (p.fill) { fillColor(p); stroke(p); ops.push('B'); } else { stroke(p); ops.push('S'); }
      } else if (p.t === 'circle') {
        circlePath(p.c, p.r);
        if (p.fill) { fillColor(p); stroke(p); ops.push('B'); } else { stroke(p); ops.push('S'); }
      } else if (p.t === 'text') text(p);
      else if (p.t === 'image') {
        const name = image(p.src);
        if (name) ops.push(`q ${n(p.w * PT)} 0 0 ${n(p.h * PT)} ${X(p.x)} ${Y(p.y + p.h)} cm /${name} Do Q`);
      } else if (p.t === 'hatch') hatch(p);
      else if (p.t === 'clip') {
        ops.push('q');
        if (p.poly) ops.push(p.poly.map((q, i) => `${X(q[0])} ${Y(q[1])} ${i ? 'l' : 'm'}`).join(' ') + ' h');
        else circlePath(p.circle.c, p.circle.r);
        ops.push('W n');
        draw(p.prims);
        ops.push('Q');
      }
    }
  };
  const text = (p) => {
    const res = p.font ? font(p.font, !!p.bold) : null;
    let size = p.h / (res ? capOf(p.font, p.bold) : CAP);
    let w = res ? textWidth(p.text, p.h, p.bold, p.font) : textWidth(p.text, p.h, p.bold);
    let hs = 100;
    if (p.fit && w > p.fit) { hs = Math.max(40, (100 * p.fit) / w); w = p.fit; }
    const dx = p.anchor === 'middle' ? -w / 2 : p.anchor === 'end' ? -w : 0;
    const dy = p.base === 'middle' ? -p.h / 2 : p.base === 'top' ? -p.h : 0; // baseline offset, paper up
    const rad = ((p.rot || 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
    // position of the baseline start (paper: y up)
    const x0 = p.p[0] * PT, y0 = (H - p.p[1]) * PT;
    const ox = (dx * c - dy * s) * PT, oy = (dx * s + dy * c) * PT;
    const [r, g, b] = rgb(p.color);
    ops.push(`BT ${n(r)} ${n(g)} ${n(b)} rg /${res || (p.bold ? 'F2' : 'F1')} ${n(size * PT)} Tf ${n(hs)} Tz ${n(c)} ${n(s)} ${n(-s)} ${n(c)} ${n(x0 + ox)} ${n(y0 + oy)} Tm ${pdfString(p.text)} Tj ET`);
  };
  const hatch = (p) => {
    // clip to the cut faces (even-odd: holes stay empty), then draw parallel lines across their extent
    const pts = p.loops.flat();
    if (!pts.length) return;
    ops.push('q');
    for (const loop of p.loops) ops.push(loop.map((q, i) => `${X(q[0])} ${Y(q[1])} ${i ? 'l' : 'm'}`).join(' ') + ' h');
    ops.push('W* n');
    stroke({ w: p.w, color: p.color });
    const a = ((p.angle || 45) * Math.PI) / 180, d = [Math.cos(a), -Math.sin(a)], nrm = [-d[1], d[0]];
    let lo = Infinity, hi = -Infinity, mn = Infinity, mx = -Infinity;
    for (const q of pts) { const s1 = q[0] * nrm[0] + q[1] * nrm[1], s2 = q[0] * d[0] + q[1] * d[1]; lo = Math.min(lo, s1); hi = Math.max(hi, s1); mn = Math.min(mn, s2); mx = Math.max(mx, s2); }
    const gap = p.gap || 2.5;
    for (let s1 = Math.ceil(lo / gap) * gap; s1 <= hi; s1 += gap) {
      const A = [nrm[0] * s1 + d[0] * mn, nrm[1] * s1 + d[1] * mn], B = [nrm[0] * s1 + d[0] * mx, nrm[1] * s1 + d[1] * mx];
      ops.push(`${X(A[0])} ${Y(A[1])} m ${X(B[0])} ${Y(B[1])} l S`);
    }
    ops.push('Q');
    // the outline of the cut faces is drawn by the view's edges
  };
  draw(page.prims);
  return ops.join('\n');
}

// Build the PDF file (Uint8Array).
export function buildPDF(pages, info = {}) {
  const objs = []; // [index] = body string, or { head, bin } for a binary stream
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  // pictures: one image object each, shared by the pages that show it
  const imgObjs = new Map(); // src -> { name, obj } (obj null: not embeddable)
  const image = (src) => {
    if (!imgObjs.has(src)) {
      const j = jpegOf(src);
      const cs = j?.comps === 1 ? '/DeviceGray' : j?.comps === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      const obj = j ? add({ head: `<< /Type /XObject /Subtype /Image /Width ${j.w} /Height ${j.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.bytes.length} >>`, bin: j.bytes }) : null;
      imgObjs.set(src, { name: `Im${imgObjs.size + 1}`, obj });
    }
    const r = imgObjs.get(src);
    return r.obj ? r.name : null;
  };
  // TrueType fonts: embedded once each (the whole file), WinAnsi encoded
  const fontObjs = new Map(); // 'family|B' -> { name, obj } (obj null: not loaded or not embeddable)
  const font = (family, bold) => {
    const key = `${family}|${bold ? 'B' : ''}`;
    if (!fontObjs.has(key)) {
      const f = drawingFont(family, bold);
      let obj = null;
      if (f?.metrics.embeddable) {
        const m = f.metrics, bytes = new Uint8Array(f.data);
        const file = add({ head: `<< /Length ${bytes.length} /Length1 ${bytes.length} >>`, bin: bytes });
        const desc = add(`<< /Type /FontDescriptor /FontName /${m.psName} /Flags 32 /FontBBox [${m.bbox.map(n).join(' ')}] /ItalicAngle ${n(m.italicAngle)} /Ascent ${n(m.ascent)} /Descent ${n(m.descent)} /CapHeight ${n(m.capHeight)} /StemV ${bold ? 120 : 80} /FontFile2 ${file} 0 R >>`);
        const widths = [];
        for (let c = 32; c <= 255; c++) widths.push(n(m.width(CP1252[c])));
        obj = add(`<< /Type /Font /Subtype /TrueType /BaseFont /${m.psName} /FirstChar 32 /LastChar 255 /Widths [${widths.join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor ${desc} 0 R >>`);
      }
      fontObjs.set(key, { name: `F${fontObjs.size + 3}`, obj });
    }
    const r = fontObjs.get(key);
    return r.obj ? r.name : null;
  };
  for (const page of pages) {
    const used = new Set(), usedFonts = new Set();
    const content = pageStream(page, (src) => { const name = image(src); if (name) used.add(src); return name; },
      (family, bold) => { const name = font(family, bold); if (name) usedFonts.add(`${family}|${bold ? 'B' : ''}`); return name; });
    const fonts = [...usedFonts].map((k) => ` /${fontObjs.get(k).name} ${fontObjs.get(k).obj} 0 R`).join('');
    const xobj = [...used].map((src) => `/${imgObjs.get(src).name} ${imgObjs.get(src).obj} 0 R`).join(' ');
    const bytes = new TextEncoder().encode(content); // ASCII only (strings are escaped)
    const cs = add(`<< /Length ${bytes.length} >>\nstream\n${content}\nendstream`);
    const pg = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${n(page.size[0] * PT)} ${n(page.size[1] * PT)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R${fonts} >>${xobj ? ` /XObject << ${xobj} >>` : ''} >> /Contents ${cs} 0 R >>`);
    kids.push(pg);
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const infoObj = add(`<< /Title ${pdfString(info.title || 'Drawing')} /Producer (RazorCAD) /Creator (RazorCAD) >>`);
  const offsets = [];
  // (the binary comment line is written as Latin-1 bytes; everything else is ASCII)
  const parts = [];
  let pos = 0;
  const push = (s, latin = false) => {
    const b = latin ? Uint8Array.from(s, (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(s);
    parts.push(b); pos += b.length;
  };
  push('%PDF-1.4\n');
  push('%\xE2\xE3\xCF\xD3\n', true);
  objs.forEach((body, i) => {
    offsets.push(pos);
    if (typeof body === 'string') { push(`${i + 1} 0 obj\n${body}\nendobj\n`); return; }
    // a binary stream (a picture)
    push(`${i + 1} 0 obj\n${body.head}\nstream\n`);
    parts.push(body.bin); pos += body.bin.length;
    push('\nendstream\nendobj\n');
  });
  const xref = pos;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) x += `${String(o).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(x);
  const total = parts.reduce((s, b) => s + b.length, 0);
  const file = new Uint8Array(total);
  let o = 0;
  for (const b of parts) { file.set(b, o); o += b.length; }
  return file;
}
