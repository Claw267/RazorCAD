// Freeing kernel objects.
// In the bundled replicad_single.wasm, 171 of the 271 kernel classes reached from JavaScript are registered
// with an empty destructor, so obj.delete() did nothing for them: no C++ destructor, no free. Every boolean
// builder (with its whole intersection data structure), every TopoDS_Shape (with the reference it holds on
// its geometry, which then could never be freed either), every explorer, point and box stayed in memory,
// and the kernel's memory grew with every rebuild (e.g. a raw fuse of a box and a cylinder: ~165 KB a call).
// On top of that, objects the code simply drops (never deleted) were never freed, even for classes whose
// destructor works.
//
// 1. delete() is replaced (on the prototype every kernel class shares) so that, when the last JavaScript
//    reference to an object of such a class goes, it is released the way its C++ destructor would have:
//    - objects with a vtable whose class derives from BRepBuilderAPI_Command (all the BRep*API builders),
//      NCollection_Array1, or Standard_Transient (only when nothing else holds it): their own virtual
//      deleting destructor (vtable slot 1, checked in the binary for each of these roots);
//    - TopoDS_Shape and its subclasses: Nullify() (drops the geometry reference and location), then free;
//    - TopLoc_Location: Clear(), then free; TopExp_Explorer: Clear() and re-Init on a null shape, then free;
//    - distance and surface projection queries: native deleting destructors when available; older
//      distance-query bindings clear their shapes/results then free the outer object;
//    - plain value classes (gp_*, Bnd_Box, ...): free.
//    Anything else keeps the old behaviour (nothing freed). Classes with a real destructor (Geom_*,
//    adaptors, NCollection lists, handles, ...) go through embind's own delete as before.
// 2. Every kernel object (handles aside: embind already does this for them) is registered in a
//    FinalizationRegistry as embind creates it, so an object the code drops without delete() is deleted
//    (as above) once JavaScript has collected it.
// Two small patches in replicad_single.js make this possible: the registered destructor of each class is
// recorded (oc.razorcadDtors) and embind calls oc.razorcadOnHandle for each object it creates. Without them,
// or if anything here doesn't look as expected, nothing is installed (the old behaviour).

const SHAPE = /^TopoDS_(Shape|Solid|CompSolid|Shell|Face|Wire|Edge|Vertex|Compound)$/;
const PLAIN = /^(gp_\w+|Bnd_Box|Bnd_Box2d|Bnd_OBB|GProp_GProps|Poly_Triangle|Quantity_Color|TopoDS_Builder)$/;

export const freeStats = { installed: false, freed: 0, collected: 0, kinds: {}, kept: {} }; // kept: deletes that freed nothing, by class

export function installRealDelete(oc, wasmExports, dataEnd, { autoFree = true } = {}) {
  try {
    const table = Object.values(wasmExports || {}).find((v) => v instanceof WebAssembly.Table);
    const dtors = oc.razorcadDtors;
    const free = oc.___libc_free;
    if (!table || !dtors || typeof free !== 'function' || !dtors.gp_Pnt) throw new Error('kernel internals not found');
    const noop = table.get(dtors.gp_Pnt); // (gp_Pnt is one of the classes with the empty destructor)
    // (Kernel Lab) a kernel whose destructors are real (a shape's is not the empty one): delete() already frees
    const realDtors = dtors.TopoDS_Shape !== undefined && table.get(dtors.TopoDS_Shape) !== noop;
    freeStats.realDtors = realDtors;
    // (views of kernel memory, renewed when it grows)
    let v32 = null, v8 = null;
    const u32 = () => { const b = oc.wasmMemory.buffer; if (v32?.buffer !== b) v32 = new Uint32Array(b); return v32; };
    const bytes = () => { const b = oc.wasmMemory.buffer; if (v8?.buffer !== b) v8 = new Uint8Array(b); return v8; };

    // where embind keeps an object's pointer and use count (minified names, so found from a sample)
    const probe = new oc.gp_Pnt();
    const recKey = Object.getOwnPropertyNames(probe).find((k) => probe[k] && typeof probe[k] === 'object' && probe[k].count);
    const rec0 = recKey && probe[recKey];
    const ptrKey = rec0 && Object.keys(rec0).find((k) => typeof rec0[k] === 'number' && rec0[k] > 0);
    if (!ptrKey || rec0.count.value !== 1) throw new Error('embind layout not recognised');
    const ptrOf = (o) => o[recKey][ptrKey];
    // (smart pointers, i.e. handles, have a second pointer in the record; their destructors are real)
    const isPlainRec = (r) => { for (const k in r) if (k !== ptrKey && typeof r[k] === 'number') return false; return true; };
    let base = Object.getPrototypeOf(probe);
    while (base && !Object.prototype.hasOwnProperty.call(base, 'delete')) base = Object.getPrototypeOf(base);
    const origDelete = base?.delete;
    if (typeof origDelete !== 'function') throw new Error('embind delete not found');
    origDelete.call(probe);

    // RTTI (Itanium ABI): vtable[-1] = type_info {vptr, name, ...}
    const inData = (p) => p > 1024 && p < dataEnd && !(p & 3);
    const cstr = (p) => { const b = bytes(); let s = ''; for (let i = 0; i < 256 && b[p + i]; i++) s += String.fromCharCode(b[p + i]); return s; };
    const tiName = (ti) => { const n = u32()[(ti + 4) >> 2]; return n > 1024 && n < dataEnd ? cstr(n) : null; };
    const tiKind = (ti) => { const vt = u32()[ti >> 2]; const t = vt && u32()[(vt - 4) >> 2]; return t && inData(t) ? tiName(t) : null; };
    // class names from the dynamic type up to the root of the primary base chain
    const chainCache = new Map();
    function chainOf(vt) {
      if (chainCache.has(vt)) return chainCache.get(vt);
      let names = null;
      try {
        let ti = u32()[(vt - 4) >> 2];
        names = [];
        for (let depth = 0; depth < 40 && inData(ti); depth++) {
          const n = tiName(ti); const kind = tiKind(ti);
          if (!n || !kind) { names = null; break; }
          names.push(n);
          if (kind.includes('__si_class_type_info')) ti = u32()[(ti + 8) >> 2];
          else if (kind.includes('__vmi_class_type_info')) {
            const count = u32()[(ti + 12) >> 2]; let next = 0;
            for (let k = 0; k < count && k < 16; k++) {
              const flags = u32()[(ti + 20 + 8 * k) >> 2];
              if (!(flags & 1) && (flags >> 8) === 0) { next = u32()[(ti + 16 + 8 * k) >> 2]; break; }
            }
            if (!next) break;
            ti = next;
          } else break; // __class_type_info: the root
        }
      } catch { names = null; }
      if (names && !names.length) names = null;
      chainCache.set(vt, names);
      return names;
    }
    const mangled = (n) => `${n.length}${n}`;
    const ROOTS = { [mangled('BRepBuilderAPI_Command')]: 'builder', [mangled('Standard_Transient')]: 'transient', '18NCollection_Array1': 'array' };
    const rootKind = (names) => {
      const root = names[names.length - 1];
      return ROOTS[root] || (root.startsWith('18NCollection_Array1I') && names.length === 1 ? 'array' : null);
    };

    const classKind = new Map();
    function kindOf(name) {
      let k = classKind.get(name);
      if (k !== undefined) return k;
      k = null;
      const i = dtors[name];
      if (i !== undefined && table.get(i) === noop) {
        if (SHAPE.test(name)) k = 'shape';
        else if (name === 'TopLoc_Location') k = 'location';
        else if (name === 'TopExp_Explorer') k = 'explorer';
        else if (name === 'BRepExtrema_DistShapeShape') k = 'distance';
        else if (name === 'GeomAPI_ProjectPointOnSurf' && oc.RazorCADSurfacePatch?.DestroyProjection) k = 'projection';
        else if (PLAIN.test(name)) k = 'plain';
        else k = 'virtual';
      }
      classKind.set(name, k);
      return k;
    }

    let nullShape = null;
    const count = (k) => { freeStats.freed++; freeStats.kinds[k] = (freeStats.kinds[k] || 0) + 1; };
    const keep = (name) => { freeStats.kept[name] = (freeStats.kept[name] || 0) + 1; };
    function release(obj, name, p) {
      const kind = kindOf(name);
      if (!kind) return;
      if (kind === 'shape') { obj.Nullify(); free(p); count(kind); return; }
      if (kind === 'location') { obj.Clear(); free(p); count(kind); return; }
      if (kind === 'explorer') {
        nullShape ??= new oc.TopoDS_Shape();
        obj.Clear(); obj.Init(nullShape, oc.TopAbs_ShapeEnum.TopAbs_SHAPE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        free(p); count(kind); return;
      }
      if (kind === 'projection') { oc.RazorCADSurfacePatch.DestroyProjection(obj); count(kind); return; }
      if (kind === 'distance') {
        if (oc.RazorCADSurfacePatch?.DestroyDistance) { oc.RazorCADSurfacePatch.DestroyDistance(obj); count(kind); return; }
        // Compatibility with older kernels lacking the native destructor bridge.
        nullShape ??= new oc.TopoDS_Shape();
        obj.LoadS1(nullShape); obj.LoadS2(nullShape); obj.Perform();
        free(p); count(kind); return;
      }
      if (kind === 'plain') { free(p); count(kind); return; }
      // virtual: only when the object's own type information says it is (or derives from) this class
      const vt = u32()[p >> 2];
      if (!inData(vt)) { keep(name); return; }
      const names = chainOf(vt);
      if (!names) { keep(name); return; }
      const me = mangled(name);
      const isMe = names.includes(me) || (name.startsWith('NCollection_Array1_') && names[0].startsWith('18NCollection_Array1I'));
      const root = isMe && rootKind(names);
      if (!root) { keep(name); return; }
      if (root === 'transient' && u32()[(p + 4) >> 2] !== 0) return; // a handle still holds it
      const del = u32()[(vt + 4) >> 2];
      table.get(del)(p);
      count(root);
    }

    // Objects the code drops without delete() are freed once JavaScript has collected them: e.g.
    // replicad's `new oc.BRepBuilderAPI_MakeEdge(...).Edge()` (the builder) and the shapes TopExp_Explorer
    // Current() hands out, thousands per rebuild of a large part, each holding on to the geometry it came
    // from. Every kernel object is registered here as embind creates it (a hook added to replicad_single.js);
    // one deleted in the meantime is skipped (unregistering each one on delete() costs more). (Objects that kernel calls return are always copies JavaScript owns: checked
    // for Shape(), Current(), First(), Location(), TopoDS.Face() and the like.) A Standard_Transient that a
    // kernel handle has taken over is left to the handle.
    const heldByHandle = (p) => {
      const vt = u32()[p >> 2];
      if (!inData(vt)) return false;
      const names = chainOf(vt);
      return !!names && names[names.length - 1] === mangled('Standard_Transient') && u32()[(p + 4) >> 2] !== 0;
    };
    const PROTO = Symbol('class'); // (kept on embind's record, which is what the registry holds)
    const dropped = autoFree && typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((r) => {
      const p = r[ptrKey], proto = r[PROTO];
      if (!p || r.count.value !== 1) return; // already deleted (or an embind clone of it is still in use)
      try {
        if (isPlainRec(r) && heldByHandle(p)) return;
        Object.create(proto, { [recKey]: { value: r, writable: true } }).delete();
        freeStats.collected++;
      } catch { /* already gone */ }
    }) : null;
    if (dropped) {
      oc.razorcadOnHandle = (h) => {
        const r = h[recKey];
        // (smart pointers, i.e. handles, already have embind's own clean-up)
        if (r && isPlainRec(r)) { r[PROTO] = Object.getPrototypeOf(h); dropped.register(h, r); }
      };
    }

    if (!realDtors) base.delete = function () {
      const r = this?.[recKey];
      const p = r?.[ptrKey];
      if (p && r.count.value === 1 && isPlainRec(r)) {
        let name = null;
        try { name = Object.getPrototypeOf(this).constructor.name; } catch { /* not a kernel class */ }
        if (name) {
          try { release(this, name, p); } catch (e) { console.warn('RazorCAD: could not free kernel object', name, e); }
        }
      }
      return origDelete.call(this);
    };
    // (a kernel with real destructors frees an object itself on its last delete(): counted, so freeStats.freed still
    // says how many objects were freed)
    else base.delete = function () {
      const r = this?.[recKey];
      if (r?.[ptrKey] && r.count?.value === 1) freeStats.freed++;
      return origDelete.call(this);
    };
    freeStats.installed = true;
  } catch (e) {
    console.warn('RazorCAD: kernel objects are not freed on delete():', e?.message || e);
  }
  return freeStats.installed;
}
