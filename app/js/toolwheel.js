// Radial tool wheel (a mouse-gesture wheel).
// Shown while the middle mouse button is held; the tool under the pointer's
// direction is highlighted and activated when the button is released.
import { icon } from './icons.js';

const RADIUS = 96;     // distance of the tool buttons from the center
const DEAD_ZONE = 24;  // releasing inside this radius cancels

export class ToolWheel {
  constructor(host = document.body) {
    this.host = host;
    this.el = null;
    this.items = [];
    this.index = -1;
    this.onMove = (e) => this._move(e);
    this.onUp = (e) => { if (e.button === this.button) this.close(true); };
    this.onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(false); } };
    this.onBlur = () => this.close(false);
  }

  get isOpen() { return !!this.el; }

  // items: [{ id, label, icon, active }]; onPick(item) runs on release over an item.
  open(x, y, items, onPick, button = 1) {
    this.close(false);
    this.items = items;
    this.onPick = onPick;
    this.button = button;
    this.cx = x;
    this.cy = y;
    this.index = -1;
    const el = document.createElement('div');
    el.className = 'toolwheel';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    const n = items.length;
    const ring = `<div class="tw-ring"></div>`;
    const btns = items.map((it, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2; // first item at the top, clockwise
      const bx = Math.cos(a) * RADIUS, by = Math.sin(a) * RADIUS;
      return `<div class="tw-item${it.active ? ' current' : ''}" style="left:${bx}px;top:${by}px">${icon(it.icon)}</div>`;
    }).join('');
    el.innerHTML = `${ring}${btns}<div class="tw-center"><span class="tw-label"></span></div>`;
    this.host.appendChild(el);
    this.el = el;
    this.btnEls = [...el.querySelectorAll('.tw-item')];
    this.labelEl = el.querySelector('.tw-label');
    this._setIndex(-1);
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('blur', this.onBlur);
  }

  _move(e) {
    const dx = e.clientX - this.cx, dy = e.clientY - this.cy;
    if (Math.hypot(dx, dy) < DEAD_ZONE) return this._setIndex(-1);
    const n = this.items.length;
    let a = Math.atan2(dy, dx) + Math.PI / 2; // 0 at the top, clockwise
    a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    this._setIndex(Math.round(a / ((Math.PI * 2) / n)) % n);
  }

  _setIndex(i) {
    this.index = i;
    this.btnEls.forEach((b, k) => b.classList.toggle('hot', k === i));
    this.labelEl.textContent = i >= 0 ? this.items[i].label : 'Sketch tools';
    this.el.classList.toggle('idle', i < 0);
  }

  close(pick) {
    if (!this.el) return;
    window.removeEventListener('pointermove', this.onMove, true);
    window.removeEventListener('pointerup', this.onUp, true);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('blur', this.onBlur);
    const item = pick && this.index >= 0 ? this.items[this.index] : null;
    this.el.remove();
    this.el = null;
    if (item) this.onPick?.(item);
  }
}
