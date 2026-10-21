// CAD-style view navigation for an orthographic camera.
//
//   Middle-drag ........ rotate freely about the screen axes (no locked "up")
//   Ctrl+middle-drag ... pan            Shift+middle-drag ... zoom
//   Alt+middle-drag .... roll (rotate about the view direction)
//   Shift+right-drag ... pan (Ctrl+right-drag too)            Wheel ... zoom toward the cursor
//   Left-drag .......... rotate (part mode only; off while sketching)
//   Right press-and-hold, or a plain right-drag, calls `onButtonHold` if set (the sketch tool wheel);
//   a plain right click stays a right click (the context menu)
//   Arrow keys ......... rotate 15° (Shift: 90°), Alt+←/→ roll, Ctrl+arrows pan
//
// A drag rotates (and rolls) about the point under the cursor where it started (`pickPivot`: the model's
// surface there, or that spot at the model's depth), so a part zoomed in on turns about what is being looked
// at; `onPivot` shows it while dragging. The arrow keys (and a drag without pickPivot) rotate about
// `getPivot()` (the model's center), so the part spins in place even after panning.
import * as THREE from 'three';

const ROTATE_PER_PIXEL = Math.PI / 600; // ~0.3° per pixel
const HOLD_MS = 220;                      // right-button hold time before onButtonHold fires

export class CadControls {
  constructor(camera, dom, { getPivot, pickPivot, onPivot, onChange } = {}) {
    this.camera = camera;
    this.dom = dom;
    this.target = new THREE.Vector3();
    this.leftRotate = true;
    this.minZoom = 1e-9; // (no real limit out: a site layout tens of metres across still fits)
    this.maxZoom = 400;
    this.getPivot = getPivot || (() => this.target);
    this.pickPivot = pickPivot || null; // (pointer event) => the point to rotate about, or null
    this.onPivot = onPivot || (() => {}); // (point | null): the pivot while a rotation drag lasts
    this.onChange = onChange || (() => {});
    this.drag = null;
    this.onButtonHold = null; // (event) => true if it took over the press (the right button)
    this.consumed = false;    // (the last press opened the tool wheel: it is not also a click)
    this._bind();
  }

  // Keep the camera looking at the target, preserving its current roll.
  update() {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.camera.up.copy(up);
    this.camera.lookAt(this.target);
  }

  axes() {
    const q = this.camera.quaternion;
    return {
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
      back: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    };
  }

  // Rotate the whole view (camera, target) by quaternion q about the pivot.
  rotateAbout(q, pivot = this.getPivot()) {
    const cam = this.camera;
    cam.position.sub(pivot).applyQuaternion(q).add(pivot);
    this.target.sub(pivot).applyQuaternion(q).add(pivot);
    cam.quaternion.premultiply(q);
    cam.updateMatrixWorld();
    this.onChange();
  }

  // Screen-space rotation: horizontal motion turns about the screen's vertical axis,
  // vertical motion about the screen's horizontal axis.
  rotateScreen(angleH, angleV, pivot) {
    const { right, up } = this.axes();
    const q = new THREE.Quaternion().setFromAxisAngle(up, -angleH);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(right, -angleV));
    this.rotateAbout(q, pivot || undefined);
  }

  roll(angle, pivot) {
    const { back } = this.axes();
    this.rotateAbout(new THREE.Quaternion().setFromAxisAngle(back, angle), pivot || undefined);
  }

  worldPerPixel() {
    return (this.camera.top - this.camera.bottom) / this.camera.zoom / (this.dom.clientHeight || 1);
  }

  pan(dxPx, dyPx) {
    const { right, up } = this.axes();
    const w = this.worldPerPixel();
    const delta = right.multiplyScalar(-dxPx * w).addScaledVector(up, dyPx * w);
    this.camera.position.add(delta);
    this.target.add(delta);
    this.camera.updateMatrixWorld();
    this.onChange();
  }

  // Zoom by `factor` keeping the world point under (clientX, clientY) fixed.
  zoomAt(factor, clientX, clientY) {
    const cam = this.camera;
    const before = clientX == null ? null : this._worldAt(clientX, clientY);
    cam.zoom = THREE.MathUtils.clamp(cam.zoom * factor, this.minZoom, this.maxZoom);
    cam.updateProjectionMatrix();
    if (before) {
      const after = this._worldAt(clientX, clientY);
      const shift = before.sub(after);
      cam.position.add(shift);
      this.target.add(shift);
      cam.updateMatrixWorld();
    }
    this.onChange();
  }

  _worldAt(clientX, clientY) {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector3(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1, 0);
    this.camera.updateMatrixWorld();
    return ndc.unproject(this.camera);
  }

  // Keyboard navigation (returns true if the key was used).
  key(e) {
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const a = arrows[e.key];
    if (!a) return false;
    if (e.ctrlKey || e.metaKey) { this.pan(-a[0] * 40, -a[1] * 40); return true; }
    const step = ((e.shiftKey ? 90 : 15) * Math.PI) / 180;
    if (e.altKey) { if (a[0]) this.roll(-a[0] * step); return true; }
    this.rotateScreen(a[0] * step, a[1] * step);
    return true;
  }

  _bind() {
    const el = this.dom;
    el.addEventListener('pointerdown', (e) => {
      let mode = null;
      this.consumed = false;
      if (e.button === 1) {
        e.preventDefault(); // no browser auto-scroll
        mode = e.ctrlKey ? 'pan' : e.shiftKey ? 'zoom' : e.altKey ? 'roll' : 'rotate';
      } else if (e.button === 2) mode = e.shiftKey || e.ctrlKey ? 'pan' : 'hold';
      else if (e.button === 0 && this.leftRotate) mode = e.ctrlKey ? 'pan' : 'rotate';
      if (!mode) return;
      const d = { mode, x: e.clientX, y: e.clientY, id: e.pointerId, started: false, sx: e.clientX, sy: e.clientY };
      this.drag = d;
      if (mode === 'hold') {
        // the tool wheel: after a moment held still, or at once when the pointer starts to move
        const at = { clientX: e.clientX, clientY: e.clientY, button: 2 };
        d.fire = () => {
          clearTimeout(d.hold);
          if (this.drag !== d) return;
          this.drag = null;
          if (this.onButtonHold?.(at)) this.consumed = true;
        };
        d.hold = setTimeout(d.fire, HOLD_MS);
      }
    });
    el.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      // small threshold so plain clicks still select things
      if (!d.started) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
        if (d.mode === 'hold') { d.fire(); return; } // (a plain right-drag: the wheel, no view change)
        d.started = true;
        clearTimeout(d.hold);
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        d.x = e.clientX; d.y = e.clientY;
        // (the pivot: what was under the cursor where the drag started; found once the drag really starts, so
        // a plain click costs nothing)
        if ((d.mode === 'rotate' || d.mode === 'roll') && this.pickPivot) {
          try { d.pivot = this.pickPivot({ clientX: d.sx, clientY: d.sy }) || null; } catch { d.pivot = null; }
          if (d.pivot) this.onPivot(d.pivot);
        }
      }
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      if (d.mode === 'rotate') this.rotateScreen(dx * ROTATE_PER_PIXEL, dy * ROTATE_PER_PIXEL, d.pivot);
      else if (d.mode === 'pan') this.pan(dx, dy);
      else if (d.mode === 'zoom') this.zoomAt(Math.exp(-dy * 0.01), d.sx, d.sy);
      else if (d.mode === 'roll') this.roll(dx * ROTATE_PER_PIXEL, d.pivot);
    });
    const end = (e) => {
      if (this.drag && e.pointerId === this.drag.id) {
        clearTimeout(this.drag.hold);
        try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        if (this.drag.pivot) this.onPivot(null);
        this.drag = null;
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomAt(factor, e.clientX, e.clientY);
    }, { passive: false });
    el.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
  }
}
