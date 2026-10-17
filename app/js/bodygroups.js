// Identical bodies: bodies that are the same shape (moved or rotated copies, patterns) are listed once
// with a count (the tree, and later cut lists / bills of materials). Two bodies are identical when
// their volume, surface area and principal moments of inertia match, they have the same handedness
// (a mirrored copy is a different part), the same material and, for sheet metal, the same thickness
// and flat pattern. Everything is measured on the display mesh, so it costs next to nothing.

// Mass properties of one body's triangles (index range start..start+count of T into vertices V).
export function bodySignature(V, T, start, count) {
  let vol = 0, area = 0;
  const m1 = [0, 0, 0];
  const m2 = [0, 0, 0, 0, 0, 0]; // xx yy zz xy xz yz (volume integrals about the origin)
  const tris = [];
  for (let k = start; k < start + count; k += 3) {
    const a = [V[T[k] * 3], V[T[k] * 3 + 1], V[T[k] * 3 + 2]];
    const b = [V[T[k + 1] * 3], V[T[k + 1] * 3 + 1], V[T[k + 1] * 3 + 2]];
    const c = [V[T[k + 2] * 3], V[T[k + 2] * 3 + 1], V[T[k + 2] * 3 + 2]];
    const cx = b[1] * c[2] - b[2] * c[1], cy = b[2] * c[0] - b[0] * c[2], cz = b[0] * c[1] - b[1] * c[0];
    const det = a[0] * cx + a[1] * cy + a[2] * cz; // 6 × signed volume of the tetrahedron (0, a, b, c)
    vol += det / 6;
    for (let i = 0; i < 3; i++) m1[i] += (det / 24) * (a[i] + b[i] + c[i]);
    const sq = (i) => a[i] * a[i] + b[i] * b[i] + c[i] * c[i] + a[i] * b[i] + a[i] * c[i] + b[i] * c[i];
    const pr = (i, j) => 2 * (a[i] * a[j] + b[i] * b[j] + c[i] * c[j]) + a[i] * b[j] + a[j] * b[i] + a[i] * c[j] + a[j] * c[i] + b[i] * c[j] + b[j] * c[i];
    m2[0] += (det / 60) * sq(0); m2[1] += (det / 60) * sq(1); m2[2] += (det / 60) * sq(2);
    m2[3] += (det / 120) * pr(0, 1); m2[4] += (det / 120) * pr(0, 2); m2[5] += (det / 120) * pr(1, 2);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const ar = Math.hypot(n[0], n[1], n[2]) / 2;
    area += ar;
    tris.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3, ar]);
  }
  if (Math.abs(vol) < 1e-12) return { vol: 0, area, moments: [0, 0, 0], hand: 0 };
  const sgn = vol < 0 ? -1 : 1;
  vol = Math.abs(vol);
  const C = m1.map((x) => (sgn * x) / vol);
  // covariance of the volume about its centroid
  const cov = [
    [(sgn * m2[0]) / vol - C[0] * C[0], (sgn * m2[3]) / vol - C[0] * C[1], (sgn * m2[4]) / vol - C[0] * C[2]],
    [0, (sgn * m2[1]) / vol - C[1] * C[1], (sgn * m2[5]) / vol - C[1] * C[2]],
    [0, 0, (sgn * m2[2]) / vol - C[2] * C[2]],
  ];
  cov[1][0] = cov[0][1]; cov[2][0] = cov[0][2]; cov[2][1] = cov[1][2];
  const { values, vectors } = jacobi(cov);
  const order = [0, 1, 2].sort((i, j) => values[i] - values[j]);
  const moments = order.map((i) => values[i]);
  // handedness: point each principal axis toward the side with more surface (third moment), then
  // the axes' orientation (right or left handed) tells a part from its mirror image
  const axes = order.map((i) => [vectors[0][i], vectors[1][i], vectors[2][i]]);
  const size = Math.sqrt(Math.max(...moments, 1e-12));
  let hand = 0, defined = true;
  for (const ax of axes) {
    let s = 0;
    for (const t of tris) { const d = (t[0] - C[0]) * ax[0] + (t[1] - C[1]) * ax[1] + (t[2] - C[2]) * ax[2]; s += t[3] * d * d * d; }
    if (Math.abs(s) < 1e-4 * area * size ** 3) { defined = false; break; }
    if (s < 0) { ax[0] = -ax[0]; ax[1] = -ax[1]; ax[2] = -ax[2]; }
  }
  if (defined) {
    const [p, q, r] = axes;
    const det = p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]);
    hand = det > 0 ? 1 : -1;
  }
  return { vol, area, moments, hand };
}

// Eigen-decomposition of a symmetric 3×3 matrix (Jacobi rotations): values, vectors (columns).
function jacobi(A0) {
  const A = A0.map((r) => [...r]);
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
    if (off < 1e-14 * (Math.abs(A[0][0]) + Math.abs(A[1][1]) + Math.abs(A[2][2]) + 1e-30)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  return { values: [A[0][0], A[1][1], A[2][2]], vectors: V };
}

const close = (a, b, rel = 2e-3) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-9);

export function sameBody(a, b) {
  if (!a.sig || !b.sig || a.kind === 'surface' || b.kind === 'surface') return false;
  if (!!a.sheet !== !!b.sheet) return false;
  if ((a.material?.id || null) !== (b.material?.id || null)) return false;
  const s = a.sig, t = b.sig;
  if (!s.vol || !close(s.vol, t.vol) || !close(s.area, t.area)) return false;
  const scale = Math.max(...s.moments, 1e-12);
  for (let i = 0; i < 3; i++) if (Math.abs(s.moments[i] - t.moments[i]) > 2e-3 * scale) return false;
  if (s.hand && t.hand && s.hand !== t.hand) return false;
  if (a.sheet && b.sheet) {
    if (!close(a.sheet.t, b.sheet.t, 1e-6) || !close(a.sheet.flatArea, b.sheet.flatArea) || !close(a.sheet.cutLength ?? 0, b.sheet.cutLength ?? 0)) return false;
  }
  return true;
}

// Group a list of bodies: [{ rep, members }] in the list's order (rep: the first of each group).
export function groupBodies(bodies) {
  const groups = [];
  for (const b of bodies) {
    const g = groups.find((x) => sameBody(x.rep, b));
    if (g) g.members.push(b); else groups.push({ rep: b, members: [b] });
  }
  return groups;
}
