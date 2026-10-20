// The light / dark theme (View ▸ Theme): 'light', 'dark' or 'system' (as Windows is set). The page gets
// data-theme="light" | "dark" (style.css has the dark colours); the 3D view and sketches get the 'razorcad-theme'
// event to redraw in theirs.
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let pref = 'light';

export const isDark = () => document.documentElement.dataset.theme === 'dark';
export const themePref = () => pref;
export function setThemePref(p) {
  pref = ['light', 'dark', 'system'].includes(p) ? p : 'light';
  apply();
}
function apply() {
  const t = pref === 'dark' || (pref === 'system' && mq?.matches) ? 'dark' : 'light';
  if (document.documentElement.dataset.theme === t) return;
  document.documentElement.dataset.theme = t;
  window.dispatchEvent(new CustomEvent('razorcad-theme', { detail: t }));
}
mq?.addEventListener?.('change', () => { if (pref === 'system') apply(); });
if (typeof document !== 'undefined' && !document.documentElement.dataset.theme) document.documentElement.dataset.theme = 'light';

// colours that differ in the dark theme (3D lines that would vanish on a dark background)
export const sketchDefined = () => (isDark() ? 0xe5e7eb : 0x111827);
export const sketchUnder = () => (isDark() ? 0x60a5fa : 0x1d4ed8);
export const wireColor = () => (isDark() ? 0xb8c4d6 : 0x22314a);
