// A minimal TrueType reader for drawing text: the metrics needed to measure text (advance widths
// by character) and to embed the font in a PDF (name, em size, ascent, descent, cap height, box,
// italic angle). Fonts come from the PC (fonts.js); nothing here is font-specific.

// Parse a .ttf file (ArrayBuffer). Throws on files it can't read.
export function parseTTF(buf) {
  const dv = new DataView(buf);
  const u16 = (o) => dv.getUint16(o), i16 = (o) => dv.getInt16(o), u32 = (o) => dv.getUint32(o);
  const tables = {};
  const n = u16(4);
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    tables[String.fromCharCode(dv.getUint8(r), dv.getUint8(r + 1), dv.getUint8(r + 2), dv.getUint8(r + 3))] = u32(r + 8);
  }
  for (const t of ['head', 'hhea', 'hmtx', 'cmap', 'maxp']) if (tables[t] === undefined) throw new Error(`Font has no ${t} table`);
  const head = tables.head, hhea = tables.hhea;
  const upm = u16(head + 18);
  const bbox = [i16(head + 36), i16(head + 38), i16(head + 40), i16(head + 42)];
  const locFormat = i16(head + 50);
  const ascent = i16(hhea + 4), descent = i16(hhea + 6), nHM = u16(hhea + 34);
  const nGlyphs = u16(tables.maxp + 4);
  const adv = (g) => u16(tables.hmtx + 4 * Math.min(g, nHM - 1));

  // character -> glyph (Windows Unicode cmap, format 4)
  let sub = null;
  const cm = tables.cmap;
  for (let i = 0; i < u16(cm + 2); i++) {
    const r = cm + 4 + i * 8;
    if (u16(r) === 3 && (u16(r + 2) === 1 || u16(r + 2) === 0)) { const o = cm + u32(r + 4); if (u16(o) === 4) { sub = o; break; } }
  }
  if (sub === null) throw new Error('Font has no Unicode character map');
  const segX2 = u16(sub + 6), ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  const glyphOf = (c) => {
    for (let s = 0; s < segX2; s += 2) {
      if (c > u16(ends + s)) continue;
      const start = u16(starts + s);
      if (c < start) return 0;
      const ro = u16(ranges + s);
      if (!ro) return (c + i16(deltas + s)) & 0xffff;
      const g = u16(ranges + s + ro + 2 * (c - start));
      return g ? (g + i16(deltas + s)) & 0xffff : 0;
    }
    return 0;
  };

  // cap height: OS/2 (version 2 on), else the top of the capital H
  let capHeight = 0;
  const os2 = tables['OS/2'];
  if (os2 !== undefined && u16(os2) >= 2) capHeight = i16(os2 + 88);
  if (!capHeight && tables.glyf !== undefined && tables.loca !== undefined) {
    const g = glyphOf(72);
    if (g && g < nGlyphs) {
      const off = locFormat ? u32(tables.loca + 4 * g) : 2 * u16(tables.loca + 2 * g);
      capHeight = i16(tables.glyf + off + 8);
    }
  }
  if (!capHeight) capHeight = Math.round(ascent * 0.7);
  const fsType = os2 !== undefined ? u16(os2 + 8) : 0;
  const italicAngle = tables.post !== undefined ? dv.getInt32(tables.post + 4) / 65536 : 0;

  // the PostScript name (name ID 6), Windows Unicode or Mac Roman
  let psName = 'Font';
  const nm = tables.name;
  if (nm !== undefined) {
    const strs = nm + u16(nm + 4);
    for (let i = 0; i < u16(nm + 2); i++) {
      const r = nm + 6 + i * 12;
      if (u16(r + 6) !== 6) continue;
      const len = u16(r + 8), o = strs + u16(r + 10), wide = u16(r) === 3 || u16(r) === 0;
      let s = '';
      for (let k = 0; k < len; k += wide ? 2 : 1) s += String.fromCharCode(wide ? u16(o + k) : dv.getUint8(o + k));
      psName = s.replace(/[^\x21-\x7e]|[()<>[\]{}/%#]/g, '') || psName;
      break;
    }
  }

  const cache = new Map();
  // advance width of a character in 1/1000 em
  const width = (ch) => {
    const c = typeof ch === 'number' ? ch : ch.codePointAt(0);
    if (!cache.has(c)) cache.set(c, (adv(glyphOf(c)) * 1000) / upm);
    return cache.get(c);
  };
  const k = 1000 / upm;
  return {
    psName, upm, width, fsType, italicAngle,
    ascent: ascent * k, descent: descent * k, cap: capHeight / upm, capHeight: capHeight * k, bbox: bbox.map((v) => v * k),
    // embedding allowed unless the font is marked "restricted licence"
    embeddable: (fsType & 0x000f) !== 2,
  };
}
