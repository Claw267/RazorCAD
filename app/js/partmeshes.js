// Parts' display meshes (the triangles and edge polylines the 3D view draws), shared by assemblies and drawings:
// read from the model cache on disk when a part was built before (modelcache.js), else built by the kernel and
// stored for next time. And an assembly's parts with where each sits, through its sub-assemblies.
import { platform } from './platform.js';
import { hashText, packResult, unpackResult } from './modelcache.js';

// A mesh for the model cache: the edge points in one Float32Array (the vertices' precision). As JSON numbers
// they would be most of the file, and slow to read back.
export function packMesh(m) {
  let n = 0;
  for (const e of m.edges) n += e.pts.length;
  const edgePts = new Float32Array(n), edgeOff = new Uint32Array(m.edges.length + 1);
  let o = 0;
  m.edges.forEach((e, i) => { edgeOff[i] = o; edgePts.set(e.pts, o); o += e.pts.length; });
  edgeOff[m.edges.length] = o;
  return { ...m, edges: m.edges.map(({ pts, ...e }) => e), edgePts, edgeOff };
}
export function unpackMesh(m) {
  const { edgePts, edgeOff, ...out } = m;
  out.edges = m.edges.map((e, i) => ({ ...e, pts: Array.from(edgePts.subarray(edgeOff[i], edgeOff[i + 1])) }));
  return out;
}
export const MESH_CACHE = 'assembly part mesh 1\n'; // (changes when packMesh does)

// a part document as it is built in a configuration (the text the cache key is made from)
export function builtJSON(doc, cfgId) {
  return JSON.stringify({ ...doc, activeConfig: cfgId && (doc.configs || []).some((x) => x.id === cfgId) ? cfgId : null });
}

// A part's display mesh: { key, mesh } (key: the cache key; the same for the same part and configuration).
// From the cache on disk, else built by the kernel (onBuild(name) is told first) and stored. Kept in memory
// for this session too.
const memo = new Map();
export async function partMesh(kernel, doc, cfgId = null, { onBuild } = {}) {
  const json = builtJSON(doc, cfgId);
  const key = await hashText(MESH_CACHE + json);
  const id = key || json;
  if (memo.has(id)) return memo.get(id);
  const job = (async () => {
    if (key && platform.desktop) {
      try {
        const b64 = await platform.readModelCache(key);
        const r = b64 ? await unpackResult(b64) : null;
        if (r?.body?.vertices && r.body.edgePts) return { key: id, mesh: unpackMesh(r.body) };
      } catch { /* built below */ }
    }
    onBuild?.(doc.name || 'a part');
    const r = await kernel.request('partMesh', { doc: json });
    const mesh = r.body && r.body.vertices ? r.body : null;
    if (!mesh) throw new Error(`${doc.name || 'A part'} has no body`);
    if (!r.errors && key && platform.desktop) packResult({ body: packMesh(mesh) }).then((b64) => platform.writeModelCache(key, b64)).catch(() => {});
    return { key: id, mesh };
  })();
  memo.set(id, job);
  if (memo.size > 400) memo.delete(memo.keys().next().value);
  job.catch(() => memo.delete(id));
  return job;
}

// Every part an assembly shows, through its sub-assemblies, in the configuration each one shows (suppressed
// and hidden components left out): [{ part (the part record: { id, name, path, doc }), cfg, M, name }], M the
// part's placement in the assembly as a row-major 3×4 matrix.
export function assemblyParts(asm, depthMax = 16) {
  const out = [];
  const effIn = (d, c) => {
    const o = (d.activeConfig ? (d.configs || []).find((x) => x.id === d.activeConfig) : null)?.comps?.[c.id] || {};
    return { config: 'config' in o ? o.config : (c.config ?? null), hidden: 'hidden' in o ? o.hidden : !!c.hidden, suppressed: 'suppressed' in o ? o.suppressed : !!c.suppressed };
  };
  const poseM = (c) => {
    const [x, y, z, w] = c.rot || [0, 0, 0, 1], l = Math.hypot(x, y, z, w) || 1, [qx, qy, qz, qw] = [x / l, y / l, z / l, w / l], p = c.pos || [0, 0, 0];
    return [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw), p[0],
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw), p[1],
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy), p[2]];
  };
  const mul = (A, B) => {
    const o = new Array(12);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) o[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c] + (c === 3 ? A[r * 4 + 3] : 0);
    return o;
  };
  const walk = (d, M, names, depth) => {
    if (depth > depthMax) return;
    for (const c of d.components || []) {
      const e = effIn(d, c);
      if (e.suppressed || e.hidden) continue;
      const p = (d.parts || []).find((x) => x.id === c.part);
      if (!p?.doc) continue;
      const Mc = mul(M, poseM(c)), cfg = e.config && (p.doc.configs || []).some((x) => x.id === e.config) ? e.config : null;
      if (p.doc.kind === 'assembly') walk({ ...p.doc, activeConfig: cfg }, Mc, [...names, c.name], depth + 1);
      else out.push({ part: p, cfg, M: Mc, name: [...names, c.name].join(' / ') });
    }
  };
  walk(asm, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], [], 0);
  return out;
}
