// The world coordinate system as the user sees it: Y up (RazorCAD's own) or Z up, chosen for each part (doc.upAxis).
// RazorCAD keeps its geometry Y up whichever is chosen. With Z up, every world coordinate shown or typed is turned
// +90° about X: the user's point (X, Y, Z) is RazorCAD's (X, Z, −Y). So the Top plane (horizontal) is the XY plane,
// the Front plane XZ and the Right plane YZ, and Z points up. Nothing in a part moves when the choice changes, only
// what its axes are called; files exported (STEP, STL, OBJ, 3MF) and imported are in the user's axes.
let up = 'y';
export const getUp = () => up;
export const setUp = (u) => { up = u === 'z' ? 'z' : 'y'; };

// a point or direction of RazorCAD's as the user sees it, and the other way
export const toUser = (p) => (up === 'z' ? [p[0], -p[2], p[1]] : [p[0], p[1], p[2]]);
export const fromUser = (p) => (up === 'z' ? [p[0], p[2], -p[1]] : [p[0], p[1], p[2]]);

// RazorCAD's axis keys ('x', '-y' …) as the user calls them, and the other way
const Z_UP = { x: 'x', y: 'z', z: '-y', '-x': '-x', '-y': '-z', '-z': 'y' };
export const userAxis = (k) => (up === 'z' ? Z_UP[k] ?? k : k);
export const internalAxis = (u) => (up === 'z' ? Object.keys(Z_UP).find((k) => Z_UP[k] === u) ?? u : u);
// its name: 'X', '−Y' …; letter: without the sign (along an axis either way)
export const axisLabel = (k) => { const u = userAxis(k); return (u.startsWith('-') ? '−' : '') + u.slice(-1).toUpperCase(); };
export const axisLetter = (k) => userAxis(k).slice(-1).toUpperCase();
// a plane of RazorCAD's axes ('XY', 'YZ', 'ZX') as the user calls it
export const planeLabel = (p) => (up === 'z' ? { XY: 'XZ', YZ: 'YZ', ZX: 'XY' }[p] ?? p : p);
// the standard planes' axes as the user calls them
export const stdPlaneAxes = (id) => (up === 'z' ? { front: 'XZ', top: 'XY', right: 'YZ' } : { front: 'XY', top: 'XZ', right: 'YZ' })[id];
