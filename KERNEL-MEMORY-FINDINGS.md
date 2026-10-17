# Kernel memory growth: findings (2026-10-17)

(Meant for the shared side-session notes folder, which the permission settings blocked; delete this file when read.)

## Cause
In the bundled `app/vendor/replicad/replicad_single.wasm`, **`delete()` frees nothing for 171 of the 271 kernel
classes** reached from JavaScript.
- How it was found: the embind raw destructor slot of each class was traced through the wasm function table,
  then disassembled from the binary. For those 171 classes it is one shared **empty function**.
- The 171 include TopoDS_Shape and all its subclasses, every BRep*API builder (booleans, fillets, extrudes,
  MakeEdge…), TopExp_Explorer, TopLoc_Location, BRepExtrema_DistShapeShape, gp_*, Bnd_Box and NCollection_Array1.
- Classes with a real destructor: Geom_*, the adaptors, NCollection_List/Map, ShapeFix/UnifySameDomain,
  BRepMesh, Message_ProgressRange, plus every handle (smart pointer).

Evidence:
- 3 million `new gp_Pnt().delete()` cycles: the heap grows 27 MB.
- After 1000 `Located()` copies of a shape, each deleted, the shape's TShape refcount went from 2 to 1002.
- A deleted, built BRepAlgoAPI_Fuse keeps its vtable and keeps its arguments referenced.
- A heap scan after 1000 raw fuses found exactly 1000 BRepAlgoAPI_Fuse, 1000 BOPAlgo_PaveFiller and 3000 Message_Report objects alive.

Raw boolean leak, measured in a worker:
- box + cylinder fuse: ~165 KB per call (100 → 344 MB over 1500 calls);
- cut: ~125 KB per call;
- 40-hole cut chain: ~270 KB per cut;
- copy transforms: none.

A second source: objects the code drops without delete() are never freed, even for classes with a real
destructor. Examples:
- replicad's `new oc.BRepBuilderAPI_MakeEdge(...).Edge()`;
- `TopExp_Explorer.Current()` copies: ~5,300 per 464-impeller rebuild, each holding a face or edge;
- replicad's per-call curve adaptors in `pointAt` and the like;
- distance queries.

Ruled out:
- **OCCT pools:** the binary has only Standard_MMgrRaw (plain malloc); no MMGT_OPT.
- **Global caches and fragmentation:** with the objects really freed, the heap stays flat.
- **The earlier "live = heap − free" probe** with 16 KB mallocs: misleading, because the allocator is
  **mimalloc**, which keeps freed small blocks in size-class pages that 16 KB requests can't use.
  200,000 `new BRepAlgoAPI_Cut().delete()` cycles kept the heap at 100 MB while the probe's "live" rose 37 → 87 MB.

## Fix (no wasm rebuild)
- `app/js/ocfree.js` (installed in `kernel.worker.js` right after the kernel loads) replaces embind's
  `delete()`. For classes with the empty destructor, it releases the object the way its destructor would:
  - **Builders** (BRepBuilderAPI_Command root), **NCollection_Array1**, and **Standard_Transient** with refcount 0:
    the virtual deleting destructor (vtable slot 1, checked by disassembly for each root).
  - **TopoDS_***: Nullify() and free.
  - **TopLoc_Location**: Clear() and free.
  - **TopExp_Explorer**: Clear(), Init(null) and free.
  - **BRepExtrema_DistShapeShape**: LoadS1/LoadS2(null), Perform() and free (it has no vtable).
  - **Plain values** (gp_*, Bnd_*, GProp_GProps…): free.
- Every non-handle object is registered in a FinalizationRegistry as embind creates it, so dropped objects
  are freed after JS GC. A Transient that a C++ handle holds is never freed this way.
- Two hooks in `replicad_single.js`: `oc.razorcadDtors` (destructor slot by class) and `oc.razorcadOnHandle`
  (called for each new embind object).
- `replicad.js` `_1DShape`: the curve adaptor is freed straight after `pointAt`, `tangentAt`, `geomType` and the like.
- Checked first: Shape(), Current(), First(), Location() and TopoDS.Face() all return copies, never
  aliases, so freeing them is safe.

## Results (kernelMemoryMB per rebuild, before → after)
| Part | Before | After |
|---|---|---|
| 464 impeller (6 rebuilds) | 163 287 413 595 595 811 | 100 ×6 |
| 464 impeller (30 rebuilds, before only) | … 811 | — |
| Giant Golfball (2) | 287 496 | 127 127 |
| BCL 400 Blade SM (4) | 100 163 239 344 | 100 ×4 |
| PBWE (5) | 100 127 127 163 199 | 100 ×5 |
| Part1 (4) | 444 1077 1077 1077 | 444 1077 1077 1077 |
| sample, Blade, transition1 | 100 | 100 |

Part1 is not a leak. Its Fillet4 (a fillet that includes a B-spline edge) needs ~270 MB of working memory on
the first rebuild and a fresh ~450 MB block on the second (the heap is fragmented by then). After that it is flat.
Clearing all retained state and forcing GC before the next rebuild changes nothing.

Same bodies, volumes, areas, and face, edge and triangle counts, with and without the fix, on all 9 real
parts and on 3 synthetic parts (shell, loft, sweep, hole, thread, structural member, split, patterns,
mirror, sheet-metal flange, hem and relief).

Cost: rebuilds are ~9% slower on booleans-heavy parts (464 impeller 2.55 → 2.8 s, PBWE 0.57 → 0.63 s),
2–4% on Part1, and unchanged on the Golfball and Blade SM. Of that, ~0.2 µs per kernel object is
FinalizationRegistry bookkeeping; the rest is destructor work that never ran before.

## Worker recycling
Keep RECYCLE_MB = 3600 as a safety net. A new worker takes ~1.3 s to start, plus a full rebuild of the last
part (Part1 7 s, Golfball 61 s), and memory returns to the same peak within two rebuilds (Part1 444 → 1077).
A lower threshold (e.g. 1 GB) would recycle Part1 after nearly every rebuild, for no gain.

## Still not freed (small)
These classes have no vtable and no method that releases their contents, so they still leak a little:
- GC_MakeSegment2d / GC_MakeCircle2d, Geom2dAPI_InterCurveCurve and Geom2dAPI_ProjectPointOnCurve:
  hold a few handles;
- GeomAPI_PointsToBSpline: holds its curve;
- BRepGProp_Face: holds an adaptor with a face.

Together that's well under 100 per rebuild of the 464 impeller.
