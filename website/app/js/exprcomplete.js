// Complete only the identifier under the caret; leave the surrounding formula intact.
import { fmt, isValidName } from './expr.js';

let active = null, serial = 0;
export function completeExpression(input, candidates) {
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  let menu = null, matches = [], index = 0, token = null, observer = null, ownEscape = null, inserting = false, anchor = null;
  const close = () => {
    if (!menu) return;
    menu?.remove(); menu = null;
    observer?.disconnect(); observer = null;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-controls'); input.removeAttribute('aria-activedescendant');
    if (ownEscape === null) input.removeAttribute('data-own-escape');
    else input.setAttribute('data-own-escape', ownEscape);
    window.removeEventListener('resize', close);
    document.removeEventListener('scroll', onScroll, true);
    if (active === close) active = null;
  };
  const onScroll = (e) => {
    if (menu?.contains(e.target) || !anchor) return;
    const r = input.getBoundingClientRect();
    if (Math.abs(r.left - anchor.left) > 0.5 || Math.abs(r.top - anchor.top) > 0.5) close();
  };
  const choose = () => {
    const name = matches[index]?.name, t = token;
    if (!name || !t || !input.isConnected) return close();
    close();
    input.setRangeText(name, t.start, t.end, 'end');
    inserting = true;
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } finally { inserting = false; }
  };
  const highlight = () => {
    [...menu.children].forEach((row, i) => row.setAttribute('aria-selected', String(i === index)));
    input.setAttribute('aria-activedescendant', menu.children[index].id);
    const row = menu.children[index];
    if (row.offsetTop < menu.scrollTop) menu.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
  };
  const update = () => {
    if (inserting) return;
    if (document.activeElement !== input || input.disabled || input.readOnly || input.selectionStart !== input.selectionEnd) return close();
    const caret = input.selectionStart, value = input.value;
    let start = caret, end = caret;
    while (start && /[\w]/.test(value[start - 1])) start--;
    while (end < value.length && /[\w]/.test(value[end])) end++;
    const prefix = value.slice(start, caret);
    if (!/^[A-Za-z_]\w*$/.test(prefix)) return close();
    const names = new Map(candidates().filter((q) => typeof q.name === 'string' && isValidName(q.name)).map((q) => [q.name, q]));
    const next = [...names.values()].filter((q) => q.name.toLowerCase().startsWith(prefix.toLowerCase()) && q.name !== value.slice(start, end))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!next.length) return close();
    if (active && active !== close) active();
    matches = next; index = 0; token = { start, end };
    if (!menu) {
      ownEscape = input.getAttribute('data-own-escape');
      menu = document.createElement('div'); menu.className = 'expr-complete';
      menu.id = `expr-complete-${++serial}`; menu.setAttribute('role', 'listbox');
      document.body.appendChild(menu); active = close;
      input.setAttribute('data-own-escape', '');
      input.setAttribute('aria-controls', menu.id); input.setAttribute('aria-expanded', 'true');
      window.addEventListener('resize', close);
      document.addEventListener('scroll', onScroll, true);
      observer = new MutationObserver(() => { if (!input.isConnected) close(); });
      observer.observe(document.body, { subtree: true, childList: true });
    }
    menu.replaceChildren();
    matches.forEach((q, i) => {
      const row = document.createElement('div'); row.id = `${menu.id}-${i}`; row.setAttribute('role', 'option');
      const name = document.createElement('span'), value = document.createElement('span');
      name.textContent = q.name; value.className = 'expr-complete-value';
      value.textContent = Number.isFinite(q.value) ? fmt(q.value, 4) : '—';
      row.append(name, value);
      row.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); index = i; choose(); });
      menu.appendChild(row);
    });
    const r = input.getBoundingClientRect(), width = Math.min(Math.max(r.width, 260), window.innerWidth - 16);
    anchor = r;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    const height = Math.min(menu.scrollHeight, 220);
    menu.style.top = `${r.bottom + height + 4 > window.innerHeight ? Math.max(8, r.top - height - 4) : r.bottom + 4}px`;
    highlight();
  };
  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (!menu || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(e.key) && !(e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape') close();
      else if (e.key === 'Enter' || e.key === 'Tab') choose();
      else { index = (index + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; highlight(); }
    } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) close();
  }, true);
}
