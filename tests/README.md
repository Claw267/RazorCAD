# RazorCAD regression tests

One command checks that the geometry kernel and the main workflows still give the same results after a change:

```
python tests/run_tests.py
```

It serves `app/` on a free local port, opens it in headless Microsoft Edge (Playwright, `pip install playwright`;
no browser download is needed, the installed Edge is used) and:

- **Parts:** rebuilds every `tests/parts/*.rcad` with the real kernel, in each configuration, and compares the
  feature errors and, per body, its kind, face and edge count, volume and area (and for sheet metal the flat
  pattern's size and bend count) with `tests/expected.json`. Numbers must agree to 1 part in a million.
- **Drawings:** draws some of the test parts in the standard views (front, top, right, isometric; sheet metal also
  flat) with the kernel and compares each view's count of each kind of line and its size with `expected.json`.
- **UI:** does a few things the way a user does them, with pointer events on the view: sketch a rectangle,
  dimension it and extrude it; make a drawing of the part; build an assembly from two components; check the
  mouse buttons (Shift + right-drag pans, a plain right-drag changes nothing, middle-drag turns).

The exit code is 1 when anything fails, so it can be run before every build. GitHub runs it on every push and pull
request too (`.github/workflows/tests.yml`, on Windows with Edge; there the software renderer draws the 3D view).

| Option | |
|---|---|
| `--only NAME ...` | just these parts or UI tests |
| `--update` | store the current results as the expected ones (after a deliberate change; check the numbers first) |
| `--make-parts` | rebuild `tests/parts/*.rcad` from `tests/make_parts.js` |
| `--headed` | show the browser window |
| `--jobs N` | pages run side by side (default: one per 6 processor threads, at most 4; `--jobs 1`: one page, everything in turn) |

With several jobs, each page has its own storage and kernels and is told its share of the processor threads; the first
runs the parts and drawings, and the UI tests are shared out by their usual times. A UI test must not need what an
earlier one left behind (or must make it itself, as drawing-from-part does). Times are kept apart per number of jobs.

To cover a new feature, add a part to `make_parts.js`, run `python tests/run_tests.py --make-parts --only <name> --update`,
and check the recorded numbers by hand (for example a plate's volume) before committing them.

To check a single-guide loft through the app's continuity panel and sketch editor:

```sh
python tests/run_tests.py --only loft-guide-edit-regeneration --jobs 1
```

This checks C0/G1/G2 before and after increasing the end profile height from 40 to
48 mm and changing the guide's control-point offset from 6 to 9 mm. It measures
solid volumes, guide contact, continuity and kernel memory. Open
`tests/data/guided-loft-edit.rcad` in the app to inspect the final edited G2 model.

To check Sweep with a path and guide, including native geometry and panel editing:

```sh
python tests/run_tests.py --only sweep-path-guide sweep-loft --jobs 1
```

This checks analytic volumes, a curved path with varying section, nonlinear and
reversed guides, rotation of a rectangular section by a helical guide, Sweep Cut,
invalid inputs, guide dependencies and editing. Both guide modes are exercised.

Open `tests/data/sweep-path-guide.rcad` for a curved path with a guide that varies
the circular section size.

For guided swept surfaces, run:

```sh
python tests/run_tests.py --only surface-sweep-path-guide sweep-path-guide --jobs 1
```

This checks open, polyline and closed profiles, uncapped circular shells, analytic
areas, nonlinear/reversed guides, curved paths, invalid inputs and panel editing.
An example is available in `tests/data/surface-sweep-path-guide.rcad`.

For Shell cavity validation and face picking:

```sh
python tests/run_tests.py --only shell-valid-cavity shell-box references-follow-edits --jobs 1
```

This checks analytic inward/outward volumes, fillets and chamfers, duplicate
face references, rejection of collapsed cavities, recovery after failure and
confirmed thickness edits. Open `tests/data/shell-fillet.rcad` for the small-fillet
case that previously returned the original full solid without an error.

### Sweep orientation and twist

`python tests/run_tests.py --only sweep-orientation-and-twist sweep-path-guide surface-sweep-path-guide --jobs 1`

Checks signed and multiple-turn twist, analytical volumes, fixed-orientation translation on a curved path, uncapped/open surfaces, holes, Thin, cuts, nonuniform spline arc length and a 3D helix path. Includes explicit invalid-input rejection, legacy defaults and actual UI edits, expression persistence, orientation switching and cancellation. Run with both kernel configurations. Example: `tests/data/sweep-twist.rcad`.

### Loft endpoint constraints

`python tests/run_tests.py --only loft-end-conditions loft-guide-edit-regeneration shell-valid-cavity --jobs 1`

Checks normal/direction/G1/G2 endpoint construction for solids and surfaces, intermediate profile interpolation, analytical box/cylinder volumes, reference axes, open/reversed profiles, influence, real adjacent cone, sphere, torus and rectangular faces, both endpoints and explicit rejection of missing/nonadjacent supports or unsupported combinations. The app test picks actual CAD support faces in the viewport, confirms influence expressions, saves/reopens and cancels edits, switches G1/G2 and persists G2 support references. Curvature is checked on the final CAD surfaces, including both G2 endpoints and mixed G1/G2 conditions. Run for both kernel configurations. Examples: `tests/data/loft-end-tangent.rcad` and `tests/data/loft-end-curvature.rcad` (G2 at both spherical supports).

### Loft endpoints with guides, holes and Thin

`python tests/run_tests.py --only loft-end-guides-and-walls loft-end-conditions loft-guide-edit-regeneration --jobs 1`

Checks analytic volumes for holes and all three Thin directions, open Thin profiles, circular and rectangular walls, G1/G2 inner/outer supports, G2 with a compatible guide, guide reversal, multiple guides/sections, open and closed surfaces, guided holes and Thin, and incompatible guide tangents/directions. Guide checks use bounded projections on the final CAD side surfaces. Native CAD guide-seam construction with constrained endpoints is rejected explicitly; this combination uses Adaptive approximation. Example: `tests/data/loft-guided-thin-ends.rcad`.

### Surface Patch continuity

`python tests/run_tests.py --only surface-patch-continuity surface-differential-analysis --jobs 1`

Checks G0/G1/G2 on planar, circular, spherical and cylindrical boundaries; mixed edge conditions; explicit and ambiguous supports; legacy Tangent files; knitting and solid closure; missing/disconnected/duplicate boundaries; and incompatible requests without a G0 fallback. The UI test picks a real support face, switches boundary and face selection, overrides an individual edge, saves/reopens and cancels an edit. Final CAD checks use native trimming curves and independent differential comparisons. Run on both kernels. Example: `tests/data/surface-patch-g2.rcad`.
