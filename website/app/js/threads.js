// Standard screw threads (ISO metric and Unified inch): nominal (major) diameter D and pitch P in mm.
// Used by the Thread Cut / Thread Extrude features (kernel and Property panel).
const inch = 25.4;

const METRIC = [
  ['M1.6', 1.6, 0.35], ['M2', 2, 0.4], ['M2.5', 2.5, 0.45], ['M3', 3, 0.5], ['M4', 4, 0.7], ['M5', 5, 0.8],
  ['M6', 6, 1], ['M8', 8, 1.25], ['M10', 10, 1.5], ['M12', 12, 1.75], ['M14', 14, 2], ['M16', 16, 2],
  ['M18', 18, 2.5], ['M20', 20, 2.5], ['M22', 22, 2.5], ['M24', 24, 3], ['M27', 27, 3], ['M30', 30, 3.5],
  ['M33', 33, 3.5], ['M36', 36, 4], ['M42', 42, 4.5], ['M48', 48, 5],
  // fine pitch
  ['M8×1', 8, 1], ['M10×1.25', 10, 1.25], ['M10×1', 10, 1], ['M12×1.5', 12, 1.5], ['M12×1.25', 12, 1.25],
  ['M14×1.5', 14, 1.5], ['M16×1.5', 16, 1.5], ['M18×1.5', 18, 1.5], ['M20×1.5', 20, 1.5], ['M24×2', 24, 2],
];

// [label, diameter in inches, threads per inch]
const IMPERIAL = [
  ['#2-56 UNC', 0.086, 56], ['#4-40 UNC', 0.112, 40], ['#6-32 UNC', 0.138, 32], ['#8-32 UNC', 0.164, 32],
  ['#10-24 UNC', 0.19, 24], ['#10-32 UNF', 0.19, 32], ['1/4-20 UNC', 0.25, 20], ['1/4-28 UNF', 0.25, 28],
  ['5/16-18 UNC', 0.3125, 18], ['5/16-24 UNF', 0.3125, 24], ['3/8-16 UNC', 0.375, 16], ['3/8-24 UNF', 0.375, 24],
  ['7/16-14 UNC', 0.4375, 14], ['1/2-13 UNC', 0.5, 13], ['1/2-20 UNF', 0.5, 20], ['9/16-12 UNC', 0.5625, 12],
  ['5/8-11 UNC', 0.625, 11], ['5/8-18 UNF', 0.625, 18], ['3/4-10 UNC', 0.75, 10], ['3/4-16 UNF', 0.75, 16],
  ['7/8-9 UNC', 0.875, 9], ['1-8 UNC', 1, 8], ['1-12 UNF', 1, 12],
];

export function threadList(system = 'metric') {
  if (system === 'imperial') return IMPERIAL.map(([label, d, tpi]) => ({ id: label, label, D: d * inch, P: inch / tpi }));
  return METRIC.map(([label, D, P]) => ({ id: label, label: `${label}${label.includes('×') ? '' : '×' + P}`, D, P }));
}

// Minor diameter of the basic ISO / Unified profile (thread depth 5H/8, H = 0.866 P).
export const minorDiameter = (D, P) => D - 1.0825318 * P;

// The standard whose size fits a cylinder of diameter `dia`: a bore is drilled to the minor
// diameter, a shaft is turned to the major diameter. Coarse / UNC sizes are preferred.
export function nearestThread(system, dia, internal) {
  const list = threadList(system);
  let best = null, bd = Infinity;
  for (const t of list) {
    const size = internal ? minorDiameter(t.D, t.P) : t.D;
    const fine = /×\d|UNF/.test(t.id) ? 1e-3 : 0; // prefer coarse on a tie
    const d = Math.abs(size - dia) + fine;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}
