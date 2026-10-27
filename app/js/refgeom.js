// Reference-plane definitions shared by the UI and the geometry worker.
// A plane is defined by up to three references; its type is inferred from them,
// as in the Plane Property panel.
//
// Reference kinds: plane (std / plane feature id), face (model face ref: a flat one carries its normal n, a
// cylindrical one none), axis (axis feature id), edge (model edge ref), point (point feature id), vertex (model
// vertex ref).

export const PLANE_TYPES = {
  offset: 'Offset from a plane or face',
  midPlane: 'Mid plane between two planes/faces',
  atAngle: 'Through an edge, at an angle to a plane/face',
  normalToEdge: 'Normal to an edge or axis',
  parallelThrough: 'Parallel to a plane/face, through a point',
  threePoints: 'Through three points',
  lineAndPoint: 'Through an edge or axis and a point',
  twoLines: 'Through two edges or axes',
  tangent: 'Tangent to a cylindrical face',
};

export const refGroup = (r) => (r.kind === 'sketch' ? (r.point ? 'X' : 'L') : r.kind === 'face' && !r.n ? 'C' : r.kind === 'plane' || r.kind === 'face' ? 'P' : r.kind === 'edge' || r.kind === 'axis' ? 'L' : 'X');

// Infer the plane type from its references (null if they don't define a plane). through: an edge and a point make
// a plane through both (else normal to the edge at the point).
export function inferPlaneType(refs = [], through = false) {
  const n = { P: 0, L: 0, X: 0, C: 0 };
  for (const r of refs) n[refGroup(r)]++;
  const total = refs.length;
  if (n.C === 1 && (total === 1 || (n.P === 1 && total === 2))) return 'tangent';
  if (n.C) return null;
  if (n.P === 1 && total === 1) return 'offset';
  if (n.P === 2 && total === 2) return 'midPlane';
  if (n.P === 1 && n.L === 1 && total === 2) return 'atAngle';
  if (n.L === 2 && total === 2) return 'twoLines';
  if (n.L === 1 && n.X === 1 && total === 2 && through) return 'lineAndPoint';
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

// Upgrade only when opening the Property panel; unchanged older documents still
// replay through their original kernel paths. Cancel restores the original fields.
export function legacyDatumRefs(f){
  if(Array.isArray(f.refs))return f.refs;
  if(f.type==='plane')return planeRefs(f);
  if(f.type==='axis'){
    if(f.axisType==='twoPlanes')return [f.planeA,f.planeB].filter(Boolean).map(id=>({kind:'plane',id}));
    if(f.axisType==='twoPoints')return [f.pointA,f.pointB].filter(Boolean).map(id=>({kind:'point',id}));
    if(f.axisType==='edge')return f.edge?[{kind:'edge',...f.edge}]:[];
    if(f.axisType==='cylinder')return f.face?[{kind:'face',...f.face}]:[];
    if(f.axisType==='sketchLine'){const [sketch,curve]=String(f.sketchLine||'').split(':');return sketch&&curve?[{kind:'sketch',sketch,curve}]:[];}
  }
  if(f.type==='point'){
    if(f.pointType==='vertex')return f.vertex?[{kind:'vertex',...f.vertex}]:[];
    if(f.edge)return [{kind:'edge',...f.edge,relation:f.pointType==='arcCenter'?'center':'midpoint'}];
  }
  return [];
}

export function useReferenceRelations(f){
  delete f.referenceLegacy;f.referenceDefinition=true;
  if(f.type==='plane')delete f.base;
  if(f.type==='axis'){
    f.axisType='references';
    for(const key of ['planeA','planeB','pointA','pointB','edge','face','sketchLine'])delete f[key];
  }
  if(f.type==='point'){f.pointType='references';delete f.vertex;delete f.edge;}
}
