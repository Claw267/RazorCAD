// The part features an assembly's own features (holes and cuts made in the assembly, see asmfeatures.js) add to
// the components they cut: asmPartFeatures(asm) → Map component id → [part feature…], each placed in that
// component's part's coordinates. Plain functions only: the kernel uses this too, for the assembly's drawings and
// exports.

// (quaternions as [x, y, z, w], without three.js: the kernel uses this too)
export const qrot = (q, v) => {
  const [x, y, z, w] = q, l = Math.hypot(x, y, z, w) || 1, [qx, qy, qz, qw] = [x / l, y / l, z / l, w / l];
  const tx = 2 * (qy * v[2] - qz * v[1]), ty = 2 * (qz * v[0] - qx * v[2]), tz = 2 * (qx * v[1] - qy * v[0]);
  return [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)];
};
export const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
export const toWorld = (c, p) => { const r = qrot(c.rot, p); return [r[0] + c.pos[0], r[1] + c.pos[1], r[2] + c.pos[2]]; };
export const toLocal = (c, p) => qrot(qinv(c.rot), [p[0] - c.pos[0], p[1] - c.pos[1], p[2] - c.pos[2]]);
export const r6 = (x) => Math.round(x * 1e6) / 1e6;

export function asmPartFeatures(asm) {
  const out = new Map();
  const comps = new Map((asm.components || []).map((c) => [c.id, c]));
  for (const f of asm.asmFeatures || []) {
    if (f.suppressed || !f.at?.pts?.length) continue;
    const A = comps.get(f.at.comp);
    if (!A) continue;
    const nW = qrot(A.rot, f.at.n), uW = qrot(A.rot, f.at.u || [1, 0, 0]), ptsW = f.at.pts.map((p) => toWorld(A, p));
    for (const e of f.comps || []) {
      const C = comps.get(e.id);
      const part = C && (asm.parts || []).find((p) => p.id === C.part);
      if (!part?.doc || part.doc.kind === 'assembly') continue;
      const n = qrot(qinv(C.rot), nW).map(r6), pts = ptsW.map((p) => toLocal(C, p).map(r6));
      let pf;
      if (f.type === 'cut') {
        // (the rectangle turned by `angle` about the normal)
        const a = ((Number(f.angle) || 0) * Math.PI) / 180, u0 = qrot(qinv(C.rot), uW), v0 = [n[1] * u0[2] - n[2] * u0[1], n[2] * u0[0] - n[0] * u0[2], n[0] * u0[1] - n[1] * u0[0]];
        const u = u0.map((x, k) => r6(x * Math.cos(a) + v0[k] * Math.sin(a)));
        pf = { type: 'asmCut', cuts: pts.map((o) => ({ o, d: n.map((x) => -x), u, w: f.w, l: f.l })), end: f.end, depth: f.depth };
      } else {
        const tapped = f.holeType === 'tapped' || (e.role === 'last' && f.tapLast && f.size !== 'custom');
        pf = {
          type: 'hole', holeType: e.role === 'first' ? f.holeType : tapped ? 'tapped' : 'simple',
          size: f.size, fit: f.fit, diameter: f.diameter, cboreD: f.cboreD, cboreDepth: f.cboreDepth, csinkD: f.csinkD, csinkAngle: f.csinkAngle,
          thread: f.holeType === 'tapped' ? f.thread : f.size, system: 'metric', end: f.end, depth: f.depth, drillPoint: f.end === 'blind',
          faces: pts.map((p) => ({ p, n })),
        };
      }
      const list = out.get(C.id) || [];
      list.push({ id: 'asm_' + f.id, name: f.name, rev: 1, suppressed: false, ...pf });
      out.set(C.id, list);
    }
  }
  return out;
}
