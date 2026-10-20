// Languages of the interface (View ▸ Language). t(text) gives the English text in the language chosen, from its
// dictionary (app/js/i18n/<code>.js: { "English": "Translation" }); anything not in it stays English. Labels made of
// parts ("Features ▸ Fillet…", "● Shaded") are translated part by part.
//
// Only what is shown is translated: commands keep their English names inside (macros, shortcuts and the command
// search use them), and documents are the same in every language.
export const LANGUAGES = [['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español']];

let lang = 'en', dict = null;

export const language = () => lang;
export function t(s) {
  if (!dict || s == null) return s;
  const str = String(s);
  const hit = dict[str];
  if (hit != null) return hit;
  const m = /^([●　\s]*)([\s\S]*?)(…?)$/.exec(str);
  const pre = m[1], core = m[2], ell = m[3];
  if (core.includes(' ▸ ')) return pre + core.split(' ▸ ').map((x) => dict[x] ?? dict[x + '…']?.replace(/…$/, '') ?? x).join(' ▸ ') + ell;
  if (pre || ell) { const c = dict[core]; if (c != null) return pre + c + ell; }
  // (a count after it: "Mates (2)")
  const n = /^(.*?)(\s?\(\d+\))$/.exec(str);
  if (n && dict[n[1]] != null) return dict[n[1]] + n[2];
  return str;
}

// The language set (loading its dictionary); the 'razorcad-lang' event tells the interface to draw itself again.
export async function setLanguage(code) {
  const known = LANGUAGES.some(([c]) => c === code) ? code : 'en';
  if (known === 'en') dict = null;
  else {
    try { dict = (await import(`./i18n/${known}.js`)).default; } catch { dict = null; return setLanguage('en'); }
  }
  lang = known;
  document.documentElement.lang = known;
  window.dispatchEvent(new CustomEvent('razorcad-lang', { detail: known }));
  return known;
}
