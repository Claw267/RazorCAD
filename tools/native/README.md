# Guided surface kernel

`surface-patch.cpp` is compiled into the single- and multi-threaded OCCT kernels.
The worker uses it for constrained G2 lofts and internal G1 guide networks.
C0, other G1 patch layouts and adaptive construction retain their existing algorithms.

## Construction

`BuildNetwork` solves the outer boundaries and internal guides together on one
GeomPlate surface, then trims the requested domains from a shared B-spline
(C2 for both G1 and G2; G1 requests a minimum of tangent continuity).
This preserves curvature continuity across internal guide seams without imposing
arbitrary curvature from a separately built first patch. Each native guide edge
remains a shared trimming boundary. `Build` additionally supports boundary
constraints against neighboring CAD faces using derivative orders 0/1/2.

G2 conversion uses tensor cubic interpolation with simple interior knots (C2),
analytic endpoint derivatives and mixed derivatives from the plate. Tridiagonal
systems preserve the original UV coordinates and guide parameter curves. It does
not estimate end tangents or attempt to remove knots from a C1 approximation.
Refinement is bounded to 16/32/64/128 subdivisions per direction in the worker.

The builder checks off-node samples and all boundary curves. These are sampled
positional checks, not a certified global error bound. Before returning, it checks:

- Contact within the requested tolerance (0.0001 mm in the app).
- Normal mismatch <= 0.5 degrees.
- All three components of the second fundamental form for G2, including the mixed
  component, within 0.001 1/mm.
- C2 internal continuity for G2 and valid boundary representation.
- Contact and continuity again on the final trimming curves.
- Explicit rejection of support faces without matching native edges.

The worker independently checks final seam positions, normals and curvature with
`app/js/surfacecontinuity.js`. Known pcurve coordinates are used rather than an
expensive inverse point projection onto a dense spline. The application still
requires two compatible profiles without holes or Thin Feature. Incompatible
constraints fail explicitly; continuity is never silently lowered.

Circular profiles rotate only their artificial quarter boundaries to keep guide
contacts inside smooth patches. Straight guides already on the original loft
preserve that exact surface. Plate fitting reserves 90% of the contact tolerance
for conversion, and deterministic fit failures are not retried at larger grids.
A transverse guide through a sharp physical profile corner is rejected for G2;
C0 remains available.

The lifetime shim calls native destructors for distance and inverse-projection
queries only after confirming the generated binding has an empty destructor.
This releases their internal allocations as well as the outer query object.
For contact measurements on dense splines, a bounded local CAD projection is
accepted only within 1e-7 mm and inside the trimmed face. Other distances retain
the global solver. This avoids constructing its large extrema grid for points
already on a face; it does not bound memory for arbitrary distant queries.

## Rebuild

Clone `sgenoud/replicad` with commit
`a0bc495676b65ef79ad8ab496238fa145fd0ff67` available locally:

```sh
python tools/native/prepare_probe.py /path/to/replicad /path/to/new-build --release
```

Use the matching AMD64 OCCT compiler image for each configuration:

- Single: `ghcr.io/taucad/opencascade.js@sha256:deb9be8470038652c060b47f2d2e7e2e46d899bb896ecabb007bf60307ee2d54`
- Multi: `ghcr.io/taucad/opencascade.js@sha256:51ced244be5c949f0195ac1999fe76058c9e8f9f2b64db8d51397f7ab5f5574e`

Mount the staged build directory at `/src` and preserve the image environment.
Inside each image run (replace `single` with `multi` for the shared-memory build):

```sh
cd /opencascade.js
./build-wasm.sh bind-symbols /src/custom_build_single.yml
OCJS_SKIP_WASM_OPT=1 ./build-wasm.sh link-core /src/custom_build_single.yml
./build-wasm.sh materialize /src/custom_build_single.yml
```

`--release` retains `-O3` and exports stable stack/free functions. The additional
post-link wasm-opt pass is skipped; Emscripten's optimized link still runs.
Without `--release`, configurations use an unoptimized link for development.
Patch the generated loaders before installation, adding `--multi` for that build:

```sh
python tools/patch_surface_kernel_loader.py raw/replicad_single.js staged/replicad_single.js
python tools/patch_surface_kernel_loader.py raw/replicad_multi.js staged/replicad_multi.js --multi
```

This preserves raw destructor recording, automatic handle lifetime tracking and
the app's thread budget. The worker prefers explicitly exported stack functions
and retains compatibility with the previous kernel exports.

## Verify before installation

With Playwright installed, run against staged artifacts (optionally add
`--browser /path/to/chromium`):

```sh
python tools/native/run_probe.py /path/to/artifacts --resolution 16
python tools/native/run_probe.py /path/to/artifacts --resolution 32
python tools/native/run_probe.py /path/to/artifacts --resolution 128
python tools/native/run_loft_probe.py /path/to/artifacts --require-lifetime-hooks
python tools/native/run_loft_probe.py /path/to/artifacts --multi --require-lifetime-hooks
python tools/native/run_loft_probe.py /path/to/artifacts --hard-cases --require-lifetime-hooks
```

The primitive probe checks analytic cylinders with all boundaries supported or
one shared guide, plus unmatched-support rejection. The loft probe runs the actual
worker on one- and two-spline guided surfaces and a closed solid. It checks stack
and lifetime hooks, repeated edited rebuilds, memory and worker restarts.
The normal suite also covers G2 panel restoration/cancel, G1 compatibility,
unknown-mode rejection and native solid validation. Its differential test covers
planes, spheres, offsets, explicit UV coordinates and tilted cylinders with equal
diagonal curvatures but different mixed curvature.

After both builds pass, install the matching JS/WASM pairs in app/vendor/replicad
and regenerate the website with `python tools/build_website_docs.py`.
