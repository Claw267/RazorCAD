// Differential checks on the underlying CAD surfaces (not their display mesh or boundary edges).
// Kept independent of the loft builder so other guided constructions can use the same checks.
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const sub = (a, b) => a.map((x, i) => x - b[i]);
const mul = (a, s) => a.map((x) => x * s);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => {
  const length = Math.hypot(...a);
  if (!(length > 0) || !Number.isFinite(length)) throw new Error('Surface continuity is undefined at a singular point');
  return mul(a, 1 / length);
};
const xyz = (p) => [p.X(), p.Y(), p.Z()];

// Known pcurve coordinates avoid inverse projection onto a dense spline.
export function surfaceNormalAtUV(R, face, uv) {
  const oc=R.getOC(), surface=face.surface, position=new oc.gp_Pnt();
  const du=new oc.gp_Vec(0,0,0),dv=new oc.gp_Vec(0,0,0);
  try {
    surface.wrapped.D1(...uv,position,du,dv);
    const p=xyz(position),u=xyz(du),v=xyz(dv);
    if(![...p,...u,...v].every(Number.isFinite))throw new Error('CAD surface derivatives are not finite');
    return {normal:unit(cross(u,v)),position:p,uDerivative:u,vDerivative:v};
  } finally {du.delete();dv.delete();position.delete();surface.delete();}
}

export function surfaceDifferential(R, face, point, uv = null) {
  const oc = R.getOC(), surface = face.surface;
  const position = new oc.gp_Pnt(), derivatives = Array.from({ length: 5 }, () => new oc.gp_Vec(0, 0, 0));
  try {
    const [u, v] = uv || face.uvCoordinates(point);
    surface.wrapped.D2(u, v, position, ...derivatives);
    const p = xyz(position), [du, dv, duu, dvv, duv] = derivatives.map(xyz);
    if (![...p, ...du, ...dv, ...duu, ...dvv, ...duv].every(Number.isFinite)) throw new Error('CAD surface derivatives are not finite');
    const E = dot(du, du), F = dot(du, dv), G = dot(dv, dv), determinant = E * G - F * F;
    if (!(determinant > 1e-14 * E * G)) throw new Error('Surface continuity is undefined at a singular parameterization');
    const normal = unit(cross(du, dv));
    const L = dot(normal, duu), M = dot(normal, duv), N = dot(normal, dvv);
    const coordinates = (w) => [(dot(w, du) * G - dot(w, dv) * F) / determinant, (dot(w, dv) * E - dot(w, du) * F) / determinant];
    const second = (w, z) => {
      const [a, b] = coordinates(w), [c, d] = coordinates(z);
      return L * a * c + M * (a * d + b * c) + N * b * d;
    };
    return { normal, position: p, positionError: Math.hypot(...sub(p, point)), second,
      normalCurvature: (direction) => { const w = unit(sub(direction, mul(normal, dot(direction, normal)))); return second(w, w); } };
  } finally { derivatives.forEach((d) => d.delete()); position.delete(); surface.delete(); }
}

export function compareSurfaceContinuity(R, left, right, point, direction, { leftUV = null, rightUV = null } = {}) {
  const a = surfaceDifferential(R, left, point, leftUV), b = surfaceDifferential(R, right, point, rightUV);
  const tangent = unit(sub(direction, mul(a.normal, dot(direction, a.normal))));
  const across = unit(cross(a.normal, tangent)), sign = dot(a.normal, b.normal) < 0 ? -1 : 1;
  const differences = [[tangent, tangent], [across, across], [tangent, across]].map(([w, z]) => Math.abs(a.second(w, z) - sign * b.second(w, z)));
  const angle = Math.acos(Math.min(1, Math.abs(dot(a.normal, b.normal)))) * 180 / Math.PI;
  const curvatureError = Math.max(...differences), positionError = Math.max(a.positionError, b.positionError);
  if (![angle, curvatureError, positionError].every(Number.isFinite)) throw new Error('CAD continuity comparison is not finite');
  return { angle, curvatureError, positionError };
}

