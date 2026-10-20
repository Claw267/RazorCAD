// Fonts for sketch text and drawing text: the TrueType files Windows installs (C:\Windows\Fonts). They
// are read from the PC at run time (nothing is bundled). [regular, bold, italic, bold italic]; null = not there.
import { parseTTF } from './ttf.js';

export const FONTS = {
  Arial: ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  'Arial Black': ['ariblk.ttf', null, null, null],
  Calibri: ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
  'Century Gothic': ['gothic.ttf', 'gothicb.ttf', 'gothici.ttf', 'gothicbi.ttf'],
  'Comic Sans MS': ['comic.ttf', 'comicbd.ttf', 'comici.ttf', 'comicz.ttf'],
  Consolas: ['consola.ttf', 'consolab.ttf', 'consolai.ttf', 'consolaz.ttf'],
  'Courier New': ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'],
  Georgia: ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'],
  Impact: ['impact.ttf', null, null, null],
  'Segoe UI': ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
  Tahoma: ['tahoma.ttf', 'tahomabd.ttf', null, null],
  'Times New Roman': ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
  'Trebuchet MS': ['trebuc.ttf', 'trebucbd.ttf', 'trebucit.ttf', 'trebucbi.ttf'],
  Verdana: ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'],
};

// The file for a style, falling back to the nearest style the family has.
export function fontFile(family, bold, italic) {
  const f = FONTS[family] || FONTS.Arial;
  return f[(bold ? 1 : 0) + (italic ? 2 : 0)] || (italic && f[2]) || (bold && f[1]) || f[0];
}

// The key a font is registered under in the geometry kernel (must match kernel.worker.js).
export const fontKey = (t) => `${t.font || 'Arial'}|${t.bold ? 'B' : ''}${t.italic ? 'I' : ''}`;

// ---- drawing text fonts
// Loaded so far: 'Family|B' -> { metrics (ttf.js), data (ArrayBuffer) }, or null when the PC doesn't
// have the font. Text in a font that isn't loaded is measured and drawn as Helvetica.
const loaded = new Map();
const drawKey = (family, bold) => `${family}|${bold ? 'B' : ''}`;
export const hasDrawingFont = (family, bold) => loaded.has(drawKey(family, bold));
export const drawingFont = (family, bold) => (family && loaded.get(drawKey(family, bold))) || null;
export const fontMetrics = (family, bold) => drawingFont(family, bold)?.metrics || null;

// Read a family's regular or bold file (read(file) -> ArrayBuffer | null) and keep its metrics; on
// screen the page gets it as a web font too, so it shows even where it isn't installed.
export async function loadDrawingFont(family, bold, read) {
  const key = drawKey(family, bold);
  if (loaded.has(key)) return loaded.get(key);
  let entry = null;
  try {
    const data = FONTS[family] ? await read(fontFile(family, bold, false)) : null;
    if (data) {
      entry = { metrics: parseTTF(data), data };
      if (typeof FontFace !== 'undefined' && typeof document !== 'undefined') {
        const face = new FontFace(family, data, { weight: bold ? 'bold' : 'normal' });
        await face.load();
        document.fonts.add(face);
      }
    }
  } catch { entry = null; }
  loaded.set(key, entry);
  return entry;
}
