// Accessibility: keyboard use and screen-reader labels for the panels and dialogs. The Property panels are built
// by many tools and rebuilt often, so this is added to the markup as it appears, in one place:
//   * a Property panel group heading is a button (Tab reaches it, Enter or Space opens or closes it) that says
//     whether it is open; the small ✕ / ▲ buttons in lists are buttons too;
//   * every field is named by its row's label (and its unit), a field with an invalid value is marked so, and a
//     button showing only an icon is named by its tooltip;
//   * panel headings are headings; panel messages and the status bar are read out as they change, errors at once;
//   * a dialog is named by its title, takes the focus when it opens, keeps it (Tab / Shift+Tab go round it) and
//     gives it back when it closes;
//   * F6 / Shift+F6 move the focus to the next / previous part of the window: the Property panel (or the tree),
//     the ribbon, the view.
// focusRegion(dir) is also used by the tests.

const FOCUSABLE = 'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const visible = (e) => !!e && !e.closest('[hidden]') && e.getClientRects().length > 0;
const firstText = (e) => (e?.textContent || '').replace(/\s+/g, ' ').trim();
// (the elements in n, n itself too, that match)
const all = (n, sel) => [...(n.matches?.(sel) ? [n] : []), ...n.querySelectorAll(sel)];

function label(n) {
  // (group headings: buttons that open and close)
  for (const t of all(n, '.pm-gt:not([role])')) {
    t.setAttribute('role', 'button');
    t.tabIndex = 0;
  }
  for (const t of all(n, '.pm-gt')) t.setAttribute('aria-expanded', String(!t.closest('.pm-group')?.classList.contains('collapsed')));
  // (the small buttons in lists: remove, move up…)
  for (const x of all(n, '.pm-list .x:not([role]), .li .x:not([role])')) {
    x.setAttribute('role', 'button');
    x.tabIndex = 0;
    if (x.title) x.setAttribute('aria-label', x.title);
  }
  // (buttons with only an icon: their tooltip, without the shortcut key)
  for (const b of all(n, 'button[title]')) {
    if (b.hasAttribute('aria-label') && b.dataset.a11yTitle !== 'auto') continue;
    if (firstText(b)) continue;
    b.setAttribute('aria-label', b.title.replace(/\s*\([^)]*\)\s*$/, ''));
    b.dataset.a11yTitle = 'auto';
  }
  // (fields: named by their row's label, and unit)
  for (const r of all(n, '.pm-row')) {
    const lb = r.querySelector(':scope > label'), c = r.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea');
    if (!lb || !c || (c.hasAttribute('aria-label') && c.dataset.a11yLabel !== 'auto')) continue;
    const unit = firstText(r.querySelector('.pm-input .unit'));
    c.setAttribute('aria-label', firstText(lb) + (unit ? ` (${unit})` : ''));
    c.dataset.a11yLabel = 'auto';
  }
  for (const i of all(n, '.pm-input input')) i.setAttribute('aria-invalid', String(i.classList.contains('bad')));
  for (const h of all(n, '.pm-head:not([role])')) { h.setAttribute('role', 'heading'); h.setAttribute('aria-level', '2'); }
  for (const m of all(n, '.pm-msg')) {
    const role = m.classList.contains('err') ? 'alert' : 'status';
    if (m.getAttribute('role') !== role) m.setAttribute('role', role);
  }
  // (dialogs)
  for (const d of all(n, '.modal:not([role])')) {
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    const t = firstText(d.querySelector('.modal-h span'));
    if (t) d.setAttribute('aria-label', t);
    opened(d);
  }
}

// a dialog opened: the focus into it (its first field, else its main button), given back when it closes
let back = [];
function opened(d) {
  back.push(document.activeElement);
  setTimeout(() => {
    if (!d.isConnected || d.contains(document.activeElement)) return;
    const body = d.querySelector('.modal-b');
    const first = [...(body || d).querySelectorAll('input:not([type=hidden]):not([disabled]), select, textarea')].find(visible)
      || d.querySelector('.modal-f button.primary') || [...d.querySelectorAll(FOCUSABLE)].find(visible);
    first?.focus({ preventScroll: true });
  }, 0);
}
function closed() {
  if (document.querySelector('.modal')) return;
  const e = back.pop();
  back = [];
  if (e?.isConnected && e !== document.body) setTimeout(() => { if (!document.querySelector('.modal')) e.focus?.({ preventScroll: true }); }, 0);
}

// the parts of the window F6 goes round: the Property panel or the tree, the ribbon, the view
function regions() {
  const pm = document.querySelector('#pm'), tree = document.querySelector('#tree');
  const left = pm && visible(pm) && pm.children.length ? pm : tree && visible(tree) ? tree : null;
  const ribbon = document.querySelector('#cm-buttons');
  const view = document.querySelector('#c');
  return [left, ribbon, view].filter((x) => x && visible(x));
}
export function focusRegion(dir = 1) {
  const rs = regions();
  if (!rs.length) return null;
  const at = rs.findIndex((r) => r.contains(document.activeElement));
  const r = rs[((at < 0 ? (dir > 0 ? -1 : 0) : at) + dir + rs.length) % rs.length];
  // (into the region: its first control, or the region itself)
  const t = r.matches?.('canvas, #tree') ? r : [...r.querySelectorAll(FOCUSABLE)].find(visible) || r;
  if (t.tabIndex < 0 && !t.matches(FOCUSABLE)) t.tabIndex = -1;
  t.focus({ preventScroll: true });
  return t;
}

export function installA11y() {
  const status = document.querySelector('#status-msg');
  if (status) { status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); }
  const toast = document.querySelector('#toast');
  if (toast) { toast.setAttribute('role', 'alert'); toast.setAttribute('aria-live', 'assertive'); }
  const canvas = document.querySelector('#c');
  if (canvas && !canvas.hasAttribute('aria-label')) { canvas.setAttribute('aria-label', 'Model view'); canvas.setAttribute('role', 'img'); }
  // (the markup as it changes, labelled in one go after each change)
  const roots = new Set();
  let queued = false;
  const flush = () => {
    queued = false;
    for (const r of roots) if (r.isConnected) label(r);
    roots.clear();
  };
  new MutationObserver((list) => {
    let gone = false;
    for (const m of list) {
      if (m.type === 'attributes') { roots.add(m.target.closest?.('.pm-group, .pm-input, .modal, #pm') || m.target); continue; }
      for (const x of m.addedNodes) if (x.nodeType === 1) roots.add(x);
      for (const x of m.removedNodes) if (x.nodeType === 1 && (x.matches?.('.modal-back, .modal') || x.querySelector?.('.modal'))) gone = true;
    }
    if (gone) closed();
    if (!queued && roots.size) { queued = true; queueMicrotask(flush); }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'title'] });
  label(document.body);

  document.addEventListener('keydown', (e) => {
    // Enter / Space press a button that is not a <button>
    const t = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && t?.getAttribute?.('role') === 'button' && t.tagName !== 'BUTTON') {
      e.preventDefault(); e.stopPropagation();
      t.click();
      return;
    }
    if (e.key === 'F6' && !e.ctrlKey && !e.altKey && !document.querySelector('.modal')) {
      e.preventDefault(); e.stopPropagation();
      focusRegion(e.shiftKey ? -1 : 1);
      return;
    }
    // Tab stays inside an open dialog
    if (e.key === 'Tab' && !e.altKey && !e.ctrlKey) {
      const ds = [...document.querySelectorAll('.modal')], d = ds[ds.length - 1];
      if (!d) return;
      const list = [...d.querySelectorAll(FOCUSABLE)].filter(visible);
      if (!list.length) return;
      const i = list.indexOf(document.activeElement);
      if (i < 0 || (!e.shiftKey && i === list.length - 1) || (e.shiftKey && i === 0)) {
        e.preventDefault(); e.stopPropagation();
        list[e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i < 0 || i === list.length - 1 ? 0 : i + 1)].focus();
      }
    }
  }, true);
}

// A key on a focused control (a button, a link…) is the control's: the app's own shortcuts leave it alone.
export function onControl(e) {
  return !!e.target?.closest?.('button, [role="button"], a[href], [role="tab"], [role="menuitem"], summary');
}
