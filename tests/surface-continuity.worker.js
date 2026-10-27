import Module from '/vendor/replicad/replicad_single.js';
import * as R from '/vendor/replicad/replicad.js';
import { surfaceDifferential, compareSurfaceContinuity } from '/js/surfacecontinuity.js';

try {
  const oc = await Module({ locateFile: (name) => '/vendor/replicad/' + name });
  R.setOC(oc);
  const bodies = [], faces = [];
  const cylinder = (radius, x) => {
    const body = R.makeCylinder(radius, 100, [x, 0, 0]); bodies.push(body);
    const face = body.faces.find((f) => f.geomType === 'CYLINDRE'); faces.push(face); return face;
  };
  const a = cylinder(20, -20), b = cylinder(25, -25), p = [0, 0, 50];
  const sphere = R.makeSphere(20); bodies.push(sphere);
  const round = sphere.faces[0]; faces.push(round);
  const plane = R.makeFace(R.assembleWire([R.makeLine([-10, -10, 0], [10, -10, 0]), R.makeLine([10, -10, 0], [10, 10, 0]), R.makeLine([10, 10, 0], [-10, 10, 0]), R.makeLine([-10, 10, 0], [-10, -10, 0])])); faces.push(plane);
  const reversed = a.flipOrientation(); faces.push(reversed);
  const tilted = (sign) => {
    const body = R.makeCylinder(20, 100, [-20, 0, 50], [0, sign * Math.SQRT1_2, Math.SQRT1_2]); bodies.push(body);
    const face = body.faces.find((f) => f.geomType === 'CYLINDRE'); faces.push(face); return face;
  };
  const tiltedA = tilted(1), tiltedB = tilted(-1);
  const tiltedDataA = surfaceDifferential(R, tiltedA, p), tiltedDataB = surfaceDifferential(R, tiltedB, p);
  const cylinderData = surfaceDifferential(R, a, p), sphereData = surfaceDifferential(R, round, [20, 0, 0]), planeData = surfaceDifferential(R, plane, [0, 0, 0]);
  const result = {
    cylinderAcross: Math.abs(cylinderData.normalCurvature([0, 1, 0])), cylinderAlong: Math.abs(cylinderData.normalCurvature([0, 0, 1])),
    sphereY: Math.abs(sphereData.normalCurvature([0, 1, 0])), sphereZ: Math.abs(sphereData.normalCurvature([0, 0, 1])),
    plane: Math.abs(planeData.normalCurvature([1, 1, 0])),
    equal: compareSurfaceContinuity(R, a, reversed, p, [0, 0, 1]),
    equalParametric: compareSurfaceContinuity(R, a, reversed, p, [0, 0, 1], { leftUV: [0, 50], rightUV: [0, 50] }),
    unequal: compareSurfaceContinuity(R, a, b, p, [0, 0, 1]),
    mixedOnly: compareSurfaceContinuity(R, tiltedA, tiltedB, p, [0, 0, 1]),
    tiltedDiagonal: [tiltedDataA, tiltedDataB].flatMap((d) => [[0, 1, 0], [0, 0, 1]].map((v) => Math.abs(d.normalCurvature(v)))),
    offset: surfaceDifferential(R, a, [0.02, 0, 50]).positionError,
    offsetParametric: surfaceDifferential(R, a, [0.02, 0, 50], [0, 50]).positionError,
  };
  faces.forEach((face) => face.delete()); bodies.forEach((body) => body.delete());
  self.postMessage({ result });
} catch (e) { self.postMessage({ error: e?.message || String(e) }); }
