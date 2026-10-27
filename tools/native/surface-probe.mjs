// Opt-in native-kernel regression, run with tools/native/run_probe.py.
import Module from '/native/replicad_single.js';
import * as R from '/vendor/replicad/replicad.js';
import { compareSurfaceContinuity, surfaceDifferential } from '/js/surfacecontinuity.js';

let oc, stage = 'module';
const results = [], resolution = Number(new URL(import.meta.url).searchParams.get('resolution')) || 16;
const point = (edge, t) => { const p = edge.pointAt(t); try { return p.toTuple(); } finally { p.delete(); } };
const near = (a, b) => Math.hypot(...a.map((x, i) => x-b[i])) < 1e-7;
const sameEnds = (a, b) => {
  const [x, y, u, v] = [point(a, 0), point(a, 1), point(b, 0), point(b, 1)];
  return (near(x, u) && near(y, v)) || (near(x, v) && near(y, u));
};
try {
  oc = await Module({ locateFile: (name) => '/native/' + name }); R.setOC(oc);
  for (const radius of [20, 35]) {
    stage = 'analytic cylinder';
    const axis = R.makeAx3([0, 0, 0], [0, 0, 1]), cylinder = new oc.gp_Cylinder(axis, radius);
    const makeFace = (from, to) => {
      const maker = new oc.BRepBuilderAPI_MakeFace(cylinder, from, to, 0, 10), raw = maker.Face();
      try { return R.cast(raw); } finally { raw.delete(); maker.delete(); }
    };
    const target = makeFace(0, 0.4), adjacent = makeFace(-0.4, 0);
    for(const [name,angle,offset,expected] of [['contact',0.2,0,true],['outside trim',0.6,0,false],['off surface',0.2,1,false]]) {
      const p=new oc.gp_Pnt((radius+offset)*Math.cos(angle),(radius+offset)*Math.sin(angle),5);
      const q=oc.RazorCADSurfacePatch.NearPoint(target.wrapped,p,1e-7);
      try {
        const found=Number.isFinite(q.X());
        if(found!==expected || (found&&q.Distance(p)>1e-7))throw new Error('Near-point '+name+' failed');
      } finally {q.delete();p.delete();}
    }

    const adjacentEdges = adjacent.edges;
    for (const mode of ['all boundaries', 'shared guide']) {
      const support = mode === 'all boundaries' ? target : adjacent;
      const targetEdges = target.edges;
      const replaced = targetEdges.map((edge) => adjacentEdges.find((other) => sameEnds(edge, other)) || edge);
      const guideEdges = mode === 'all boundaries' ? targetEdges : replaced.filter((edge, i) => edge !== targetEdges[i]);
      if (mode === 'shared guide' && guideEdges.length !== 1) throw new Error('The fixture did not identify exactly one shared guide');
      const wire = mode === 'all boundaries' ? target.clone().outerWire() : R.assembleWire(replaced);
      const edges = wire.edges;
      for (const order of [0, 1, 2]) {
        stage = `${mode}, radius ${radius}, order ${order}`;
        let face; const owned = [];
        try {
          const raw = oc.RazorCADSurfacePatch.Build(wire.wrapped, support.wrapped, order, 1e-4, resolution, 12, 1);
          try { face = R.cast(raw); } finally { raw.delete(); }
          const nativeEdges = face.edges; owned.push(...nativeEdges);
          const parameters = new Map(edges.map((edge) => {
            const native = nativeEdges.find((candidate) => sameEnds(candidate, edge));
            if (!native) throw new Error('The final surface lost an original boundary edge');
            return [edge, (t) => {
              const p = oc.RazorCADSurfacePatch.UV(native.wrapped,face.wrapped,t);
              try { return [p.X(),p.Y()]; } finally { p.delete(); }
            }];
          }));
          const uvAt = (edge,t) => {
            const native = edges.find((candidate) => sameEnds(candidate,edge));
            if (!native) throw new Error('A guide has no final parameter curve');
            return parameters.get(native)(t);
          };
          let position = 0, angle = 0, curvature = 0;
          for (const edge of edges) for (let j = 1; j < 25; j++) {
            const t = (1-Math.cos(Math.PI*j/25))/2, p = point(edge, t);
            position = Math.max(position, surfaceDifferential(R, face, p, uvAt(edge,t)).positionError);
          }
          for (const edge of guideEdges) for (let j = 1; j < 33; j++) {
            const t = (1-Math.cos(Math.PI*j/33))/2, p = point(edge, t), tangent = edge.tangentAt(t);
            let q;
            try { q = compareSurfaceContinuity(R, support, face, p, tangent.toTuple(), {rightUV:uvAt(edge,t)}); }
            finally { tangent.delete(); }
            position = Math.max(position, q.positionError); angle = Math.max(angle, q.angle); curvature = Math.max(curvature, q.curvatureError);
          }
          const ok = position <= 1e-4 && (order < 1 || angle <= 0.5) && (order < 2 || curvature <= 0.001);
          results.push({ mode, radius, order, resolution, ok, position, angle, curvature });
        } catch (e) {
          const error = e instanceof WebAssembly.Exception ? oc.getExceptionMessage(e) : e.message || String(e);
          results.push({ mode, radius, order, resolution, ok: false, error, stack: e.stack });
          if (e instanceof WebAssembly.RuntimeError) throw e;
        } finally { owned.forEach((x) => x.delete()); face?.delete(); }
      }
      edges.forEach((e) => e.delete()); wire.delete(); targetEdges.forEach((e) => e.delete());
    }
    // Spatially coincident curves are not proof of shared native support topology.
    const unmatched = target.clone().outerWire();
    let rejected = false;
    try {
      const raw = oc.RazorCADSurfacePatch.Build(unmatched.wrapped, adjacent.wrapped, 2, 1e-4, resolution, 12, 1); raw.delete();
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) throw e;
      const error = e instanceof WebAssembly.Exception ? oc.getExceptionMessage(e).join(': ') : e.message || String(e);
      rejected = error.includes('no matching support boundary');
    } finally { unmatched.delete(); }
    results.push({mode:'unmatched support rejected',radius,resolution,ok:rejected});
    adjacentEdges.forEach((e) => e.delete()); adjacent.delete(); target.delete(); cylinder.delete(); axis.delete();
  }
  self.postMessage({ ok: results.every((r) => r.ok), results });
} catch (e) { self.postMessage({ ok: false, error: e.message || String(e), stack: e.stack, stage, results }); }
