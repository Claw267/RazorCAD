// Main-thread geometry helpers: sketch-plane frames (three.js vectors) and mesh
// analysis. Solid modeling itself happens in the OpenCascade kernel worker.
import * as THREE from 'three';

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// A frame is a sketch plane: origin o, in-plane axes u (right) and v (up), normal n.
export const STD_PLANES = {
  front: { name: 'Front Plane', u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  top: { name: 'Top Plane', u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
  right: { name: 'Right Plane', u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] },
};

export function stdFrame(key) {
  const p = STD_PLANES[key];
  return { o: new THREE.Vector3(), u: v3(p.u), v: v3(p.v), n: v3(p.n) };
}

// Frame from an arbitrary point + normal; "up" follows world Y where possible
// (matching how the camera orients itself for Normal To).
export function frameFromNormal(o, n) {
  const N = (n.isVector3 ? n.clone() : v3(n)).normalize();
  let V;
  if (Math.abs(N.y) > 0.999) V = new THREE.Vector3(0, 0, -1);
  else V = new THREE.Vector3(0, 1, 0).addScaledVector(N, -N.y).normalize();
  const U = V.clone().cross(N).normalize();
  return { o: o.isVector3 ? o.clone() : v3(o), u: U, v: V, n: N };
}

export function frameMatrix(f) {
  return new THREE.Matrix4().makeBasis(f.u, f.v, f.n).setPosition(f.o);
}

export function frameToJSON(f) {
  return { o: f.o.toArray(), u: f.u.toArray(), v: f.v.toArray(), n: f.n.toArray() };
}
export function frameFromJSON(j) {
  return { o: v3(j.o), u: v3(j.u), v: v3(j.v), n: v3(j.n) };
}

export function toWorld(f, x, y, z = 0) {
  return f.o.clone().addScaledVector(f.u, x).addScaledVector(f.v, y).addScaledVector(f.n, z);
}
export function toLocal(f, p) {
  const d = p.clone().sub(f.o);
  return { x: d.dot(f.u), y: d.dot(f.v) };
}

// Volume, area, center of mass and bounding box of a closed indexed triangle mesh.
export function massProps(geo) {
  const pos = geo.getAttribute('position').array;
  const idx = geo.index ? geo.index.array : null;
  const triCount = idx ? idx.length / 3 : pos.length / 9;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cr = new THREE.Vector3();
  let vol = 0, area = 0;
  const com = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    a.fromArray(pos, i0 * 3); b.fromArray(pos, i1 * 3); c.fromArray(pos, i2 * 3);
    const v = a.dot(cr.crossVectors(b, c)) / 6;
    vol += v;
    com.addScaledVector(a.clone().add(b).add(c), v / 4);
    area += cr.subVectors(b, a).cross(c.clone().sub(a)).length() / 2;
  }
  if (Math.abs(vol) > 1e-12) com.divideScalar(vol);
  geo.computeBoundingBox();
  return { volume: Math.abs(vol), area, com, bbox: geo.boundingBox.clone(), triangles: triCount };
}
