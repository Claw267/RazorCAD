// Fonts for sketch text: the TrueType files Windows installs (C:\Windows\Fonts). They are read from
// the PC at run time (nothing is bundled). [regular, bold, italic, bold italic]; null = not there.
export const FONTS = {
  Arial: ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  'Arial Black': ['ariblk.ttf', null, null, null],
  Calibri: ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
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
