// Reference-plane definitions shared by the UI and the geometry worker.
// A plane is defined by up to three references; its type is inferred from them,
// as in the Plane Property panel.
//
// Reference kinds: plane (std / plane feature id), face (planar model face ref),
// axis (axis feature id), edge (model edge ref), point (point feature id), vertex (model vertex ref).

export const PLANE_TYPES = {
  offset: 'Offset from a plane or face',
  midPlane: 'Mid plane between two planes/faces',
  atAngle: 'Through an edge, at an angle to a plane/face',
  normalToEdge: 'Normal to an edge or axis',
  parallelThrough: 'Parallel to a plane/face, through a point',
  threePoints: 'Through three points',
};

export const refGroup = (r) => (r.kind === 'plane' || r.kind === 'face' ? 'P' : r.kind === 'edge' || r.kind === 'axis' ? 'L' : 'X');

// Infer the plane type from its references (null if they don't define a plane).
export function inferPlaneType(refs = []) {
  const n = { P: 0, L: 0, X: 0 };
  for (const r of refs) n[refGroup(r)]++;
  const total = refs.length;
  if (n.P === 1 && total === 1) return 'offset';
  if (n.P === 2 && total === 2) return 'midPlane';
  if (n.P === 1 && n.L === 1 && total === 2) return 'atAngle';
  if (n.L === 1 && (total === 1 || (n.X === 1 && total === 2))) return 'normalToEdge';
  if (n.P === 1 && n.X === 1 && total === 2) return 'parallelThrough';
  if (n.X === 3 && total === 3) return 'threePoints';
  return null;
}

// Plane features saved before references existed used { base, offset, flip }.
export function planeRefs(f) {
  if (Array.isArray(f.refs) && (f.refs.length || !f.base)) return f.refs;
  return [{ kind: 'plane', id: f.base || 'front' }];
}
