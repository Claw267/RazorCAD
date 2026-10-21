# RazorCAD changelog

Newest first. Each entry is stamped with the date and time (local time, NZDT) the change was built into RazorCAD.exe.
Entries before 2026-10-13 21:00 were reconstructed from the development log; later entries are added as each change is made.
Detailed status of the change-request documents: `Change requests\Progress.md`.

---

## 2026-10-21 13:56 — Multi-threaded geometry kernel
- **Each open part's kernel now runs multi-threaded.** Open CASCADE splits booleans (cuts, joins and the features built on them) and meshing over several threads. It uses replicad's multi-threaded build of the same kernel (the same Open CASCADE bindings, commit a0bc495), so parts build exactly as before: the same volumes, areas, faces and edges.
  - Measured: a sheet metal tray 4.5 s → 2.0 s; the feature-states test (13 parts) 8.4 s → 4.5 s; the Giant Golfball 6.0 s → 4.7 s; the whole regression run 56 s → 51 s. Small parts are about the same.
  - Threads per kernel come from the PC: half its threads beyond two, 2 to 8. On the golf ball 4 threads gave 4.9 s and 8 gave 4.7 s; 16 or 22 were no faster and only slower to start. A PC with fewer than 6 threads keeps the single-thread kernel.
  - The kernels for assemblies and drawings stay single-threaded: they already build several parts side by side.
  - A multi-threaded kernel takes longer to start (about 3.8 s with 8 threads, against 1.3 s) and an idle one uses about 210 MB instead of 90 MB. The spare kernel started ahead hides most of the start.
- Threads need shared memory, so RazorCAD's pages are now **cross-origin isolated**: the desktop app's built-in server, `serve.py` and the tests' server send the headers for it. Where a page isn't isolated, the single-thread kernel is used, as before.
- The browser version on the website keeps the single-thread kernel (built in its own folder, RazorCAD Web), so nothing changes there.
- The session log and crash reports say which kernel started ("Geometry kernel ready: multi-threaded, 8 threads").
- RazorCAD.exe carries both kernels (34 MB instead of 27 MB). `tools/patch_replicad_multi.py` makes RazorCAD's changes to replicad's published `replicad_multi.js` (the same two memory hooks as the single-thread one, and the thread count); THIRD-PARTY-NOTICES lists them.
- User manual: Speed on your PC and the kernel builds (For Developers).
- Rolling back: the 0.14.0-beta build with the single-thread kernel is in RazorCAD Backups, with how to roll back.

## 2026-10-21 13:33 — The browser version built in its own folder
- `tools/build_web_app.py` now builds the browser version in **RazorCAD Web** (next to the project folder, outside it) and copies it from there into website/app for publishing. It always uses the single-thread geometry kernel: a multi-threaded kernel needs cross-origin isolation, which the website's host may not give. Without that folder (another PC, GitHub) it builds straight into website/app, as before.
- A backup of 0.14.0-beta (RazorCAD.exe, the setup, the kernel files and the source as a git bundle) is in **RazorCAD Backups**, with how to roll back.

## 2026-10-21 10:25 — Version 0.14.0-beta: installer, user manual and website
- **RazorCAD-Setup-0.14.0-beta.exe** built (in "RazorCAD Install"), with everything since 0.13.0-beta:
  - standard parts and fastener sets, assembly holes and cuts with fasteners, motion studies, collision detection, equations shared with the parts, bill of materials with mass and cost, STEP export of assemblies, Speed Mode;
  - Auto Dimension (with its options), Check Drawing, DXF drawings on the sheet, BOM table columns;
  - fillets set at each vertex and setback corners, curvature-continuous 3D splines and loft continuity, etch lines, Compare With, IGES import, part properties;
  - macros (also recorded in assemblies and drawings), languages, the dark theme, keyboard use and screen-reader labels, Update Now, Report a Problem, the fonts that come with RazorCAD, the browser version;
  - faster rebuilds and meshing, big parts reopening ready, and geometry kernels sized to the PC.
- **User manual** brought up to date (76 pages): new sections for all of the above, in Manual/manual_source.md, the PDF and the online manual (website/docs).
- **Website**: the home page lists the new assembly and drawing features, IGES, the browser version for Mac and Linux users, and version 0.14.0-beta; the browser version (website/app) rebuilt.
- The release workflow leaves a version that already has a release alone (this one is published by hand, as before).

## 2026-10-21 09:59 — Geometry kernels sized to the PC; a kernel for each open part
- **How many geometry kernels work at once now comes from the PC RazorCAD runs on.** It is worked out from the processor threads (one per kernel, two left for the window and the rest of the PC) and the free memory (about 1 GB per kernel beyond 2 GB), read from Windows when RazorCAD starts: at least 2, at most 16. The browser version uses the browser's rough figure for the PC's memory.
  - Before, it was a quarter of the threads, at most 4, whatever the memory.
  - The kernels for an assembly's parts and drawing views use the budget, and those idle for 3 minutes are stopped to give their memory back.
- **Each open part keeps a kernel of its own** (as many as the budget allows, up to 8):
  - Switching back to a part is immediate, with no rebuild: the Giant Golfball back in front 86 ms after another part, where its kernel had to build it again before.
  - A part still building goes on building while you work in another tab.
  - One kernel is kept started ahead, so a new part doesn't wait for one to start.
  - A closed part's kernel is stopped. Past the budget, a new part takes the kernel of the part used longest ago, which then builds the new part (as all parts did before).
- Fixed: a rebuild started just before another tab came to the front could leave the first tab's kernel waiting for good.
- The kernels in use are noted in crash reports, e.g. "up to 12 at once (24 threads, 14.8 GB free)" on a PC with 24 threads and 14.8 GB free (memory is what limits it there).
- Regression test: kernel-per-tab (budgets for a small, mid-size and big PC; two parts each with their own kernel, the first still holding its part when it comes back; the closed part's kernel stopped; with a budget of one, the kernel lent).

## 2026-10-21 09:24 — Meshing only what changed; opening big parts at once
- **Editing a feature remeshes only what it changed.** A feature usually leaves most of a body's faces and edges as they were. Their triangles and edge points are now kept and reused, and only the new faces are meshed. The geometry library's mesher used to mesh every face again each time.
  - Giant Golfball, the last dimple edited: 2.3 s → 1.15 s; its meshing 1.75 s → 0.58 s.
  - The mesh is exactly the same as before (every vertex, normal, triangle and face).
- **Opening a big part: the kernel picks up where it left off.** The state after each feature is kept with the stored model, so after opening the kernel doesn't build the part again.
  - Giant Golfball: ready about 1.5 s after opening, instead of a 6 s rebuild.
  - Keeping those states now takes 0.3 s instead of 4.5 s. Before, every body's exact box was worked out while writing them, and the kernel was busy for those 4.5 s after the first build.
  - The stored model now shows while the states are read in, not after.
- **Stored models survive RazorCAD updates that leave the geometry kernel alone.** They used to be thrown away with every new RazorCAD.exe. They are now kept per geometry kernel: a hash of its code (`kernelsig.py`). A new kernel still starts afresh, as it may build differently.
- **The browser version keeps stored models too**, in the browser's own storage (up to 400 MB, the least recently used let go), so a big part opens quickly the second time there as well.
- Regression test: incremental-mesh (a plate with five holes, the last moved: the mesh the main kernel makes from its kept faces is exactly the one a fresh kernel makes).

## 2026-10-21 08:56 — Faster rebuilds of parts with many cuts
- **Giant Golfball: 12.9 s → 6.0 s to rebuild**, with the same geometry (volume, area, 179 faces, 367 edges, the same triangles).
- More than half of each cut's time went on bookkeeping around it, not on the cut:
  - An exact bounding box of the whole body after every cut (OpenCascade's precise box, slow on a body with many curved faces). The box is only used to skip tools that can't reach a body, and a cut body only gets smaller, so the box from before the cut is used for that. The exact box is worked out only when something needs it.
  - Two volume measurements of the whole body after every cut, to see whether the cut missed it. A cut that changed the faces hit the body, so the volumes are now measured only when the face count stayed the same.
  - Every sketch worked out the body's exact box for projected edges, even with none in it. Now only when a projection needs it.
- Editing the golf ball's last dimple: about 2.3 s, most of it meshing the whole ball again.

## 2026-10-21 08:40 — Accessibility: Property panels from the keyboard, labels for screen readers
- **Property panels from the keyboard**: Tab goes through a panel's fields and buttons. The group headings are buttons: Enter or Space opens or closes them. The small ✕ / ▲ buttons in lists can be pressed the same way. Tab on a panel button now moves the focus (it used to hide what was under the cursor), and Enter on a button presses it (it used to OK the whole panel).
- **F6 / Shift+F6** move the focus round the window: the Property panel (or the tree), the ribbon, the view.
- **Screen readers**: every panel field is named by its label and unit (e.g. "Depth (mm)"), fields with an invalid value are marked so, and icon-only buttons are named by their tooltips. Panel headings are headings. The status bar and panel messages are read out as they change, and errors and pop-up messages at once.
- **Dialogs** are named by their title. They take the focus when they open (their first field), keep Tab inside, and give the focus back when they close.
- The keyboard focus is outlined when it comes from the keyboard.
- Regression test: accessibility (the Extrude panel's fields named, headings open and close with Enter, Tab / Enter left to a focused button, F6 round the window, a dialog's focus in, round and back).

## 2026-10-21 08:35 — Performance tracking in the regression tests
- `tests/run_tests.py` keeps every run's times (each part's rebuild per configuration, each drawing, each UI test, the whole run) for each machine, the last 10 of each, in `tests/perf-history.json` (not in git).
- A **Performance** section after the results compares each time with the test's usual time (the median of its earlier runs, after 3 of them). A test markedly slower (1.5× and 300 ms more) is listed as SLOWER. The three slowest tests are listed too.
- `--perf` lists every time against its usual one; `--perf-strict` fails the run when something got slower. `--only` runs are timed but leave the whole-run time alone.
- On GitHub the Tests workflow keeps the history between runs, so slowdowns show there too.

## 2026-10-21 08:31 — Releases from a version tag
- New GitHub workflow **Release** (`.github/workflows/release.yml`), run only when a version tag is pushed (e.g. `v0.14.0-beta`), never on ordinary pushes. It checks the tag against `version.txt`, runs the regression tests, builds RazorCAD.exe and the setup (signed when signing secrets are set up), and drafts a release with the setup, its read-me and SHA-256 checksums. Betas are marked as pre-releases. Nothing is published until the draft is reviewed.
- `tools/release_notes.py`: the release notes from CHANGELOG.md, the entries added since the previous tag (test notes left out).
- `installer/RELEASING.md`: how to tag a release, and how to set up signing for it.

## 2026-10-21 08:29 — Speed mode for very large assemblies
- **Speed Mode** (Assembly ribbon, View menu): the parts are shown from simplified display meshes, made coarser by the kernel, with far fewer triangles to draw and keep in memory (a test assembly of round parts: 2096 → 600). The faces and edges stay the same, so mates, measuring, picking and collision detection work as before.
- A component you select is loaded in full. Turning speed mode off shows everything in full again.
- Saved with the assembly. The simplified meshes are cached like the full ones, so the assembly opens quickly next time.
- A large assembly (3 million triangles or 300 components) suggests speed mode in the status bar, once.
- Drawings, exports and Interference Check always use the exact geometry.
- Regression test: speed-mode (fewer triangles with the same faces, the selected component in full, back to full when off).

## 2026-10-21 08:25 — Check Drawing
- **Check Drawing** (Annotation ribbon, Tools menu) lists what a drawing still lacks before it goes out, most important first, grouped:
  - **Title block**: fields left empty (the sheet format's own fields, else the standard ones). Title, drawing number, drawn by, date, revision and material are to fix; checked and approved are noted, to be filled in at sign-off.
  - **Dimensions per view**: part views with no dimensions (a view whose sizes all show in other views is only noted), crowded views, annotations whose view was deleted and dimensions that lost what they measured.
  - **Undimensioned features**: the overall sizes, hole diameters, radii and hole positions that no dimension gives. A size given in one view is not asked for again in the part's other views, a hole callout gives a hole's diameter, and hole positions count in baseline, chain or ordinate style.
- Click an item to show its view or annotation. **Add Missing Dimensions** puts in what Auto Dimension would; **Title Block…** opens the drawing's properties.
- Regression test: drawing-check (a plate with three holes: the empty fields, 2 views without dimensions, the overall sizes and 3× Ø4; a hole callout covers the diameter; after chain Auto Dimension and the title block filled in, only notes are left; a note on a deleted view is reported).

## 2026-10-21 08:19 — Assembly features: holes and cuts made in the assembly, with fasteners
- **Assembly Hole** and **Assembly Cut** (Assembly ribbon, Insert menu): click points on a flat face of a component; the hole or cut goes in square from there, through all or to a depth, through every component behind it (listed in the panel, each can be left out).
- Holes: simple, counterbore, countersink or tapped, standard sizes (ISO 273 close / normal / loose) or custom. The first component gets the hole as chosen, the ones behind it a plain hole of the drill size; **Tap the last component** makes the last one tapped for the size (a cosmetic thread). Cuts: a rectangle, width × length, turned by an angle.
- **Fasteners**: hex bolts or socket head cap screws put in each hole as it is made, with washers and a nut on the far side if wanted, the length taken from the whole stack (a standard length), mated in the hole (into a tapped last component: a screw without a nut, about one diameter into the thread).
- Made in the assembly only: the parts' files are not changed. Each component cut gets the feature in its copy of its part, so the assembly's drawings (hole callouts too), BOM and exports have the holes. Move a component and its holes are worked out again (they stay with the component they were clicked on).
- The features are listed in the tree (Assembly Features): edit, suppress, rename, delete. Undo includes them.
- Regression test: assembly-features (two M8 holes through two plates, bolts / washers / nuts with no collisions, the kernel's assembly cut too, the tapped last component, a rectangular cut through both and its undo, and the holes following a moved plate).

## 2026-10-21 08:07 — Collision detection while dragging and in motion studies
- **Collision Detection** (Assembly ribbon, and Tools ▸ Collision Detection Off / Show Collisions While Dragging / Stop at Collisions While Dragging). While a component is dragged, the parts that run into others are shown in red with their names in the status bar; with Stop at Collisions the dragged component (and what its mates carry along) stops where it meets the other part, brought right up to it.
- Faces that only touch (mated faces) are not collisions, nor a shaft in a hole of its size, nor a screw in a nut or tapped hole (threads are cosmetic, so the screw is its full diameter in a bore of about its minor diameter). Parts that overlap already when the drag starts are left out.
- **Motion studies: Detect collisions** (on for new studies) checks every step: the parts that collide are shown in red as the motion plays, and the panel names the first collision and its step. **Stop at the first collision** ends the motion at the step before it.
- Quick: worked out from the parts' display meshes (a tree of each part's triangles, built once), not from the solids, so it keeps up with the mouse. Interference Check still gives the exact overlap volumes.
- Regression tests: collision-detection (pin in its hole and block on the plate clear; block 2 mm into the plate collides; the drag stops at the plate; the motion stops before step 5); standard-parts-2 now also checks that the bolts, washers and nuts seated in their holes do not collide.

## 2026-10-21 07:56 — Equations shared across an assembly
- **Assembly ▸ Equations…** (also in the Insert ribbon): the assembly's own variables, e.g. `base = 6`, `thickness = 2*base`. A variable that **drives the parts** sets the variable of the same name in every part that has one, through the sub-assemblies, so related parts are sized together from the top (top-down design).
- The table shows each variable's value, the parts it drives and a Drives the parts check box (off: a variable used only to work out others).
- The values are written into the assembly's copies of the parts, so the assembly, its drawings, BOM and exports use them, and they are applied again when a part is read again from its file. **Update Open Parts** writes them into the parts open in tabs too, to be saved there.
- Undo and redo include the equations.
- Regression test: assembly-equations (two parts made 5 thick by their own variable become 12 thick from the assembly; a part without it stays; undo puts it back).

## 2026-10-21 07:51 — Curvature control: 3D splines, curvature combs, lofts
- **3D sketch splines: Shape ▸ Curvature-continuous (C2).** The spline's curvature runs on smoothly through every point it passes, where the tangent-smooth shape (C1, as before) has small kinks in curvature. Select a spline to set it.
- **End weights:** how strongly a spline's end tangents pull (1 as before; more leaves the ends straighter), with a Tangent relation or a free end.
- **Show curvature:** combs drawn on the 3D sketch's splines (the selected ones when some are), so the curvature can be seen as it is shaped.
- **Lofts: Through the profiles ▸ Curvature-continuous (C2, as before) or Tangent-continuous (C1)**, and **Smooth the surface**, which evens out its bends.
- The 3D sketch's Selected list names splines properly (it showed "undefined").
- Regression test: curvature-splines (the C2 spline's curvature matches on both sides of every point: 3e-16 against 0.05 for C1).

## 2026-10-21 07:45 — Fillets: radius at each vertex, setback corners
- **Variable size fillets: Radius ▸ Set at each vertex.**
  - The Property panel lists the vertices of the selected edges (the ends of each run of edges) with a radius for each; ones left empty use the fillet's radius.
  - Along each edge the radius changes from the one at its start to the one at its end, so a run of edges can grow and shrink vertex by vertex.
  - The older "from the start to the end of each edge" stays.
- **Setback at corners** (constant and variable fillets): where three or more fillets meet, a distance blends the corner smoothly from that far out, instead of the usual small corner patch. It works by taking a ball of that radius out at the corner and filling it with a surface tangent to the faces round it; a little more than the radius works well. 0 keeps the usual corner. The fillet's note says how many corners were blended.
- Regression test: fillet-vertex-setback (R2 → R6 along a cube edge: the top face ends exactly 2 and 6 mm short of each end; three R4 fillets with an 8 mm setback: one solid with a blended corner).

## 2026-10-21 06:59 — IGES import, DXF into drawings, exact volumes of NURBS bodies
- **IGES files** (.igs, .iges) open and import like STEP files (File ▸ Open, Import).
  - Read: trimmed and bounded surfaces, B-rep solids, B-spline / plane / revolved / extruded / cylinder / cone / sphere / torus surfaces, lines, arcs, B-spline curves, composite curves, polylines, and the file's units and transformations.
  - Faces that close up are sewn into a solid; the rest come in as surface bodies.
  - (The geometry kernel has no IGES reader of its own, so RazorCAD translates IGES into STEP for it.)
- **Insert ▸ DXF Drawing…** on drawings places a DXF file's lines, circles, arcs, polylines (with bulges), ellipses, splines and texts on the sheet as one item. It goes in the middle of the frame at full size, or scaled down to a standard scale that fits. Drag it, right-click ▸ Scale…, or delete it; it prints and exports with the sheet.
- DWG is left out: no free DWG reader exists that could run in RazorCAD. Save the drawing as DXF from the program that made it.
- **Volumes are now exact for bodies with B-spline faces** (imported NURBS, IGES). The old measure could be off by up to about 1% on them; e.g. a NURBS cylinder came out 9501.6 mm³ instead of 9424.8. Bodies made of planes, cylinders and other plain faces are unchanged.
- Regression tests: iges-import (a box of trimmed planes, a NURBS cylinder and a B-rep tetrahedron, all to their exact volumes; written by tests/make_iges.py), dxf-into-drawing.

## 2026-10-21 06:45 — Compare two versions of a part
- **File ▸ Compare With…** compares the part in front with its last saved version, another part file, or another open part.
- **Features and settings:**
  - features added or removed;
  - features changed, with which settings (depth, sketch points, end condition, renamed from …);
  - features moved in the tree;
  - the part's own settings (material, equations, units, configurations, properties).
- **Shapes:** both versions' volumes, and the material this version **adds** (shown yellow on the model) and **removes** (red), with their volumes.
- Regression test: compare-versions (a plate made 2 mm thicker with a Ø10 hole: added 4642.92 mm³ and removed 785.40 mm³, both exactly as worked out by hand).

## 2026-10-21 06:41 — BOM mass, cost and totals; columns edited on the table
- **Mass and cost in bills of materials:** new column kinds Mass, Total mass, Cost and Total cost, with a **TOTAL** row (quantity, total mass, total cost).
  - Mass comes from each part's material and volume, worked out when the assembly builds the part; a sub-assembly adds up its parts.
  - Cost comes from a part's **Cost** property (e.g. 12.50, $3 or R12,50).
- **Columns edited right on the table:**
  - **Assembly ▸ Bill of Materials:** click a column heading. You can change what it shows (any field, property, mass, cost, or values typed in), insert a column left or right, move, rename or remove it. Typed values are edited in the table itself.
  - **Drawing BOM table:** right-click a column for the same menu; double-click a typed value to edit it. Columns… still has everything in one dialog.
  - The window's columns are kept with the assembly (Default Columns goes back to the usual ones), are part of undo, and are what Copy / Save CSV write.
- Context menus now also open over dialogs.
- Regression test: bom-mass-cost.

## 2026-10-21 06:35 — Auto Dimension options
- **Auto Dimension** now asks how to dimension. Your choices are kept for next time.
  - **Positions:** baseline (each hole from the edge, as before), chain (edge → hole → hole, on one row), or ordinate (values from the view's bottom left corner, on a row above and a column to the right).
  - **Tolerance:** e.g. ±0.1, added to the new lengths and diameters.
  - **Spread labels that would overlap:** texts on one row are moved apart, and hole and arc labels are moved further out along their leader.
  - **Add:** choose which kinds: overall sizes, hole diameters, hole positions, arc radii.
- Regression test: auto-dimension-styles (chain with ±0.1 and no overlapping texts, then ordinate).

## 2026-10-21 06:31 — Macros in assemblies and drawings
- **Record Macro** now records what you change in **assemblies and drawings** too, not only their commands:
  - in assemblies: parts inserted, components placed or moved, mates, explode steps, motion studies, configurations;
  - in drawings: views, annotations, sheets, models and the drawing's properties.
- Items made during the recording are kept in variables. Ones that were already there are found by name, so a recording plays back into another assembly or drawing.
- In macros: `rc.addItem`, `rc.setItem`, `rc.removeItem`, `rc.ref`, `rc.items` and `rc.setDoc` work on the assembly or drawing in front (see the API button). When the macro ends, parts are built, mates solved and views drawn, and its changes are one undo step there too.
- Regression test: macros-editors.

## 2026-10-21 06:27 — Standard parts: fastener sets, all holes, more types
- **Fastener sets:** a bolt or screw can take a **washer under its head** and a **washer and nut on the other side** of the hole. All of them are mated, and the bolt length is picked to suit (e.g. a 10 mm plate: M8 × 25).
- **Into all matching holes:** the same part (or set) goes into every hole of the same size, parallel to the selected one, in one go.
- **New types:**
  - socket set screws (ISO 4026), flush with the hole's end;
  - circlips for shafts and for bores (DIN 471 / 472, simplified rings with their gap);
  - parallel keys (DIN 6885 A, the size picked from the shaft);
  - round head rivets (ISO 1051).
- **Inch fasteners:** hex bolts (ASME B18.2.1), socket head cap screws (ASME B18.3), hex nuts (ASME B18.2.2) and SAE flat washers, 1/4" to 1", with UNC cosmetic threads and inch lengths (1-1/4" …). Fitted to clearance or tapped holes like the metric ones.
- **Holes ending on a curved face** (e.g. a cross hole in a round bar) now get a seat plane of their own. It follows the hole when the part changes.
- Regression test: standard-parts-2 (every type builds; four sets in a plate, 32 mates; the bar's hole end follows the hole).

## 2026-10-21 06:18 — Fonts that come with RazorCAD
- RazorCAD now includes the **DejaVu** fonts: Sans, Sans Mono and Serif, each in regular, bold, italic and bold italic. They are free to share, and their licence is in app/fonts.
- They are always in the font list for sketch text, and they work everywhere: in the browser version, in the tests and on PCs without the Windows fonts.
- A Windows font a PC (or the browser) doesn't have is drawn in the DejaVu font most like it: Times New Roman, Georgia and similar in DejaVu Serif; Consolas and Courier New in DejaVu Sans Mono; the rest in DejaVu Sans. This covers sketch text, engraving and drawing text, on screen and in PDFs.
- The browser version no longer asks for the PC's fonts it can't have.
- Regression test: bundled-fonts.

## 2026-10-21 00:21 — Report a problem on GitHub
- **Help ▸ Report a Problem…** and **Report on GitHub…** in the start window's crash notice turn a crash report into a GitHub issue in one click. Help ▸ Report a Problem can also send a plain report, without a crash.
- The report contains RazorCAD's version, Windows, what went wrong with its details, and the last lines of the session log. You see the whole text first and can edit it.
- Your user name and your folders are taken out, and the part you were working on is not included.
- **Open GitHub Issue** opens RazorCAD's new-issue page in your browser with the text filled in. Nothing is sent until you submit it there (with a GitHub account), so reporting stays your choice. **Copy Text** copies it instead.
- Regression test: report-problem.

## 2026-10-21 00:17 — More regression tests, and tests on GitHub
- **Tests on GitHub:** the regression tests now run on GitHub for every push and pull request (Windows, Microsoft Edge, the software renderer for the 3D view). The README shows whether they pass. They start running from the next push.
- **More tests:**
  - **Drawings against stored output:** six test parts drawn in the front, top, right and isometric views (sheet metal also as its flat pattern). The count of each kind of line and the size of every view must match the stored results.
  - **A sheet metal tray:** a 1.5 mm base with flanges on all four sides, closed corners, a hole and a slot. Its flat pattern (154.79 × 114.79 mm, 4 bends) checks out by hand.
  - **STEP round trip:** a part exported as STEP and imported again gives the same solid: volume, area, 12 faces and 20 edges.
  - **A big assembly:** 120 components of 3 parts. It loads, the bill of materials counts 3 × 40, and the assembly STEP export holds each part once.
- On small machines (such as GitHub's) the parallel-kernels test only asks for a smaller speed-up.

## 2026-10-21 00:10 — Other languages
- **View ▸ Language**: English, Deutsch, Français or Español, in parts, assemblies and drawings, kept with your preferences.
- Translated:
  - the menus, ribbons and their tabs;
  - the Property panels (headings, labels, choices);
  - dialog titles and buttons, the feature tree's fixed items and the start window;
  - the command search, which finds a command by its translated name or its English one.
- The common CAD terms are used for each language. Long German words break cleanly in the narrow toolbar buttons.
- Longer help texts and messages are still in English for now.
- Commands keep their English names inside, so macros, recorded macros and your keyboard shortcuts work in every language. Files are the same in every language.
- The dictionaries are built from tools/i18n (one numbered line per text) by tools/i18n/build_dicts.py.
- Regression test: languages.

## 2026-10-20 23:57 — Dark theme
- **View ▸ Theme**: Light, Dark, or Follow Windows (switches when Windows does). It is in the View menu of parts, assemblies and drawings, and kept with your preferences.
- In the dark theme:
  - the menus, ribbon, trees, Property panels, dialogs, messages and the start window are dark;
  - the 3D view has a dark background;
  - sketches draw fully defined geometry in light grey (instead of black) and the rest in a lighter blue, on a darker grid;
  - wireframe lines are light.
- Drawing sheets stay white paper.
- Regression test: dark-theme.

## 2026-10-20 23:52 — RazorCAD in the browser
- **A browser version** for the website (razorcad.com/app/, "Try it in your browser" on the home page). It is the same program running in the browser: parts, sketches, assemblies, drawings, macros, all on the same geometry kernel.
- In the browser, Save downloads the file and Open reads one from your PC; preferences stay in that browser.
- A notice at the top says what works differently (no auto-save, no Windows fonts, no Ask Claude sign-in) and links to the Windows app; ✕ closes it for good. Closing the tab with unsaved work asks first.
- Built by tools/build_web_app.py into website/app (also run by the website docs build). It goes online with the website, the next time that is published.

## 2026-10-20 23:47 — Part properties and BOM table columns
- **File ▸ Properties…** in parts and assemblies: custom properties such as Part Number, Description, Vendor or Finish (common names are suggested; any name works). Undo takes a change back. A drawing of a part takes its drawing number from the Part Number.
- **BOM table columns** on drawings: right-click the table ▸ **Columns…** (or double-click it). Each column shows one of:
  - a field: item, quantity, part, material, file or configuration;
  - any custom property the parts have;
  - values typed into the table, entered in a grid in the same dialog.
- Each column has its own heading and width and can be moved or removed. **Default Columns** goes back to ITEM | QTY | PART | MATERIAL. The table keeps its right edge where it was, so it stays inside the frame.
- The assembly's **Bill of Materials** window and its CSV have a column for each custom property too.
- Regression test: bom-columns.

## 2026-10-20 23:42 — Auto Dimension
- **Annotation ▸ Auto Dimension** (also Insert ▸ Annotations) dimensions the selected views, or every view on the sheet:
  - the overall sizes of each view, outermost;
  - hole diameters, one per size ("4× Ø9" for four holes of one size), with the leader pointing into the view;
  - arc radii;
  - hole positions from the view's left and bottom edges, one dimension per position.
- Each size is given once in the drawing: the front view's width and height, then the depth from the view below or beside it. Nothing is added that a view's own dimensions already give, so running it again adds nothing new.
- Only views looking along the part's axes are dimensioned (not isometric ones). A part with a round outline gets its diameter rather than its width and height.
- Everything it adds is one undo step; drag the dimensions to tidy them up.
- Regression test: auto-dimension (a 120 × 80 × 10 plate with four holes: 120, 80, 10, 4× Ø9 and the holes' positions; a second run adds nothing).

## 2026-10-20 23:36 — Macros
- **Tools ▸ Macros…**: write, run and save JavaScript macros that drive RazorCAD.
  - In parts they can sketch (lines, rectangles, circles, arcs, polygons), extrude, cut, revolve, add any feature, change or delete features, set equations and the material, and rebuild.
  - Anywhere they can run any command by its name in the command search, ask you for a value, and run other macros.
  - The **API** button lists what a macro can use, and a sample macro shows the idea.
  - A macro's changes to a part are one undo step. A part that was empty is zoomed to fit afterwards.
  - Errors show their line, which is selected in the editor. Ctrl+Enter runs; Ctrl+S saves.
- **Tools ▸ Record Macro** records what you do until **Stop Recording Macro** (or the red "● Recording macro" in the status bar):
  - the features you add, change, delete, reorder or undo in parts, and the part's own settings;
  - the commands you run from the menus, toolbars, command search or your shortcuts.
  - The recording opens in the Macros dialog to be saved or edited. Features made in the recording are kept in variables; other features are found by name, so a recording plays back into another part.
- Saved macros are in the Tools menu (**Macro: name**) and the command search, so they can have keyboard shortcuts. **Import…** / **Export…** share them as .js files.
- Macros can do anything RazorCAD can: run only macros you trust.
- Regression test: macros (a plate with four holes from one run; a recording played back into a new part).

## 2026-10-20 23:26 — Standard parts library
- **Assembly ▸ Standard Parts** (also Insert ▸ Standard Parts…) adds ISO parts made to size:
  - hex bolts (ISO 4017) and socket head cap screws (ISO 4762), M3–M24, in the standard lengths;
  - hex nuts (ISO 4032), washers (ISO 7089), dowel pins (ISO 8734, Ø2–Ø20);
  - 6000 and 6200 series ball bearings.
- Each is an ordinary part (threads shown as cosmetic threads, so they build fast). Choose its material: steel, stainless, brass or aluminium. The same type, size, length and material is one part however many times it is used, so the bill of materials counts them.
- **Select a hole first** (its round face or edge): the size is picked to fit it (a clearance or tapped hole for bolts, the bore for a bearing, the pin's diameter) and the length to go through it with room for a nut. The part goes into the hole at the end facing you, mated to it: Concentric, plus Coincident on the face round the hole. Heads, nuts and washers sit on that face; a bearing is flush with the bore's end; a dowel pin is half in.
- Regression test: standard-parts.

## 2026-10-20 23:15 — Update Now
- **One click to update.** When a newer version is out, the notice (and Help ▸ Check for Updates) offers **Update Now**. RazorCAD then:
  - downloads the new setup from its GitHub release and checks it against the release (size and SHA-256);
  - installs it in the background into the same folder, asking for administrator rights only when it was installed for all users;
  - closes, and starts again as the new version a few seconds later.
- Unsaved work is saved first (**Save All and Update**), or the update waits.
- If anything goes wrong (permission refused, the download fails), the version you had starts again. A copy of RazorCAD that wasn't installed with the setup keeps the **Download** button.

## 2026-10-20 23:11 — More geometry kernels at once
- **Assemblies build their parts side by side.** Extra geometry kernels start when they are first needed: up to 4, a quarter of the PC's processor threads. Six slow parts took 1.1 s instead of 2.8 s, and each part shows as soon as it is built.
- **Drawings use the extra kernels too:** views, fast assembly views (their parts built side by side), balloons and cut lists. Each model stays with the same kernel, so its build is reused. The interference check and assembly STEP export share one kernel, so they reuse the parts it built.
- The main kernel stays with the part you are editing. Building an assembly's parts no longer replaces its state, so editing the part right after is not slowed down.
- Regression test: parallel-kernels.

## 2026-10-20 23:08 — Motion studies
- **Assembly ▸ Motion Study** shows how an assembly moves. Choose a driver:
  - **turning a component** about the axis of one of its mates (360°, for example);
  - **sliding a component** along one of its mates' axes or faces;
  - **changing a Distance or Angle mate's value** from where it is to a new one.
- The motion is worked out step by step and the mates carry the other components along, gear and rack-pinion mates included. Turns of any size work: two full turns of a pinion slide its rack by two circumferences.
- **Play / Stop** (also Space), back to the start, a slider to go through the steps, the number of steps, the duration and **Loop**. Where the mates can't follow, it says at which step.
- ✔ keeps the study in the assembly's **Motion Studies** folder: double-click one to play it; right-click to edit, rename or delete it. Closing the panel puts the assembly back as it was; a motion study never moves the assembly itself.
- Regression test: motion-study.

## 2026-10-20 23:03 — Arrow keys in the trees
- **The feature tree, the assembly tree and the drawing tree can be used from the keyboard.** Click the tree, then:
  - **↑ / ↓** move from row to row, selecting each as a click does;
  - **←** closes a folder (or goes up to the folder a row is in), **→** opens it (or goes into it);
  - **Enter** opens the item, as a double-click does (edit a feature, open a part);
  - **Home / End** go to the first / last row.
- While the tree has the keyboard, the arrow keys no longer turn the view; click the view to give them back.
- Help ▸ Keyboard Shortcuts lists it.

## 2026-10-20 23:00 — Etch lines on sheet metal
- **Sheet Metal ▸ Etch Lines:** pick a sketch drawn on the top or bottom face of a flat part of the sheet. Its lines, arcs, circles, splines and text are marked in the flat pattern, for etching, scribing or marking part numbers and bend marks. They go on the DXF's **ETCH** layer (DXF Settings can leave them out) and show in drawing flat-pattern views (View Properties ▸ Etch lines). They are clipped to the face they are on.
- The folded part is not changed and keeps its name; the etch lines show on the model as thin lines.
- Regression test: sheet-metal-etch.

## 2026-10-20 22:54 — STEP export of assemblies
- **Assembly ▸ File ▸ Export ▸ STEP…** saves the whole assembly as one STEP file with its structure. Each part is stored once, in the configuration used. Every component is placed where it is and named after it, sub-assemblies stay assemblies, and the parts keep their colours (and multi-body parts their bodies' colours). Suppressed components are left out. Other CAD programs open it as an assembly; RazorCAD opens it back the same way.
- Fix: colours in exported STEP files (parts too) came out lighter than shown; they now match.
- Regression test: assembly-step-export (read back: 2 parts, 5 placed, the sub-assembly kept, names and positions).

## 2026-10-20 22:33 — Version 0.13.0-beta: installer
- **RazorCAD-Setup-0.13.0-beta.exe** built (in "RazorCAD Install"), with everything since 0.12.0-beta:
  - automated regression tests;
  - references that survive edits, with Fix References / Fix Mates;
  - the geometry kernel handling one request at a time;
  - cosmetic threads;
  - parts that reopen ready to edit;
  - faster patterns of added features;
  - code signing ready;
  - the update check;
  - inch units;
  - balloons and BOM tables;
  - exploded views on drawings;
  - assembly interference check;
  - gear and rack-pinion mates;
  - command search;
  - custom shortcuts;
  - the Getting Started Tour.

## 2026-10-20 22:32 — Getting Started Tour
- **A one-minute tour for new users:** eight short steps, each pointing at a part of the window: the toolbar, the feature tree, the view and its mouse buttons, how to make a first part (sketch, dimension, extrude), the command search and units. It ends with **Open the Sample Part**. Next / Back (or → / ←, Enter); Esc or Skip ends it.
- The first time RazorCAD starts, the start window offers it ("New to RazorCAD? Take the one-minute tour"). If the start window is closed on an empty part, the tour starts by itself, once. After that it is in **Help ▸ Getting Started Tour**.
- Regression test: getting-started-tour (the test runs skip the tour on their fresh first run).

## 2026-10-20 22:28 — Your own keyboard shortcuts
- **Help ▸ Customize Shortcuts…** (also from Help ▸ Keyboard Shortcuts ▸ Customize): find a command, click **Set** and press the keys you want (Ctrl+Shift+F, G, F6…). They work for the part, sketch, assembly or drawing in front, wherever that command exists. They are kept with your RazorCAD settings.
- A shortcut of your own takes the place of RazorCAD's own key, and the window says when it does (F instead of Zoom to Fit, for example). Giving a key to another command moves it there. Esc, Enter, Tab and Backspace can't be taken. ✕ removes one; Remove All removes them all.
- Your shortcuts show in the command search (Ctrl+K) and at the top of Help ▸ Keyboard Shortcuts.

## 2026-10-20 22:25 — Command search
- **Ctrl+K** (or **/**) opens a search box. Type part of a command's name, such as "fil" for Fillet or "circ pat" for Circular Pattern, then pick with ↑/↓ and Enter or click. It searches every command of the menus and toolbars of what is in front: part, sketch, 3D sketch, assembly or drawing. Each result shows where the command lives and its shortcut. The commands used lately come first. Also in Help ▸ Search Commands and as the magnifier next to Save.
- Help ▸ Keyboard Shortcuts lists it.

## 2026-10-20 22:22 — Gear and rack-and-pinion mates
- **Gear mate:** pick the cylinders of two gears (their pitch circles). Turn one and the other turns the other way, in the ratio of their radii; you can change the ratio. **Reverse** is for an internal gear (both turn the same way). In the tree it shows as e.g. "Gear1 1:2".
- **Rack-pinion mate:** pick the pinion's cylinder and a straight edge (or the flat face) of the rack. Turning the pinion slides the rack along it, by the pinion's circumference per turn (π × diameter, which you can change), and sliding the rack turns the pinion. **Reverse** changes the direction.
- Both relate the motion from where the parts are when the mate is made, so set the gears' teeth in mesh first. They follow turns of any size made step by step (dragging); one jump of more than half a turn can't be told from a turn the other way. Each removes one degree of freedom. The other mates still hold the gears on their axles (concentric and coincident mates).
- Regression test: gear-rack-mates.

## 2026-10-20 22:18 — Interference check for assemblies
- **Assembly ▸ Interference Check** (toolbar and Tools menu) finds where components overlap. Each overlap shows in red on the model and is listed with the two components (inside sub-assemblies too, as "Sub-assembly ▸ Part") and the overlap volume in the assembly's units. Faces that only touch, such as mated faces, are not counted, and nor are the bodies of one multi-body part against each other. An exploded assembly is collapsed first, so the check is of where the mates put the parts.
- Regression test: assembly-interference.

## 2026-10-20 22:15 — Exploded views on drawings
- **A drawing view of an assembly can show one of its exploded views:** View Properties ▸ Display ▸ **Exploded**. The components are where the exploded view moves them; the view keeps its place on the sheet. Its projected, section, auxiliary and detail views follow, and balloons placed on it pick the moved parts. Set it back to "Not exploded" at any time.
- Drawings with exploded and plain views of the same assembly no longer build its parts again for each: the kernel keeps the latest parts it built for drawings.
- Regression test: exploded-drawing-view.

## 2026-10-20 22:12 — Balloons and bill of materials on assembly drawings
- **Annotation ▸ BOM Table:** the drawing's assembly as a table (ITEM, QTY, PART, MATERIAL), placed at the top right of the sheet; drag it anywhere. Right-click it to show the sub-assemblies' parts too (indented). It follows the assembly when its parts change.
- **Annotation ▸ Balloon:** click a part in a view, then where the balloon goes. The circled number is that part's item in the bill of materials, found from the part under the click, also in sub-assemblies (their item at the top level). Keep clicking for more balloons; Esc ends. Where no part can be told, it asks for the number (the next free one is offered). Right-click a balloon ▸ Item Number to change it.
- The assembly's own Bill of Materials window and the drawing tables share the same rows.
- Regression test: assembly-drawing-bom-balloons.

## 2026-10-20 22:08 — Inch units
- **Each part, assembly and drawing can be in millimetres or inches.** Click **MMGS / IPS** in the status bar (or Tools ▸ Units). The sizes stay exactly as they are; only how they are shown and typed changes.
- **In an inch document:** feature fields show and take inches (the arrow keys step 0.1 in, Shift 1 in). Sketch dimensions, the Modify box and the drawing tips are in inches, and so are Measure (in, in², in³) and Mass Properties (also lb). New features start at round sizes (to 1/8 in).
- **Units in any value:** `2in`, `30 mm`, `1.5cm`, `2ft`, `(w/2)*in`; the result is in millimetres. In an inch document, variables count in inches when used in a length (`w/2` with w = 3 is 1.5 in). Values typed before a document became inch keep their size: an expression shows as `(…)*mm`.
- **Drawings:** an inch drawing (Drawing Properties, or the status bar) dimensions in inches with 3 decimals, and its title block says "in". A drawing made from an inch part starts in inches. Angles and the K-factor are never converted.
- Regression test: inch-units.

## 2026-10-20 22:01 — Update check
- **RazorCAD says when a newer version is out.** A little after it starts (at most once a day), it asks GitHub for the newest RazorCAD release. When that is newer, a notice in the corner offers **Download** (opens the release page), **Later** or **Skip this version**. Nothing is shown when you are up to date or offline, and only GitHub is asked.
- **Help ▸ Check for Updates…** checks now and says what it found. It also has the switch for the check at start.
- **Help ▸ About** shows the version. The session log and crash reports record it too.
- Pre-releases count (0.12.0-beta < 0.12.0-rc1 < 0.12.0). Only RazorCAD's own GitHub pages can be opened from the app this way.

## 2026-10-20 21:58 — Ready for code signing
- **The builds sign RazorCAD once a code-signing certificate is set up.** `build.bat` signs RazorCAD.exe and its thumbnail DLL; `installer\build_installer.bat` signs the DLL it installs and the setup itself. Each file gets SHA-256 with a timestamp and is checked with `signtool verify`; a failed signing stops the build. Without a certificate the builds say "Not signed" and carry on as before.
- **`tools\sign.py`**: takes a certificate on a USB token or in the Windows certificate store (by thumbprint), a .pfx file (password only from an environment variable), or a cloud signing service. `--check` shows what is set up; `--dry-run` shows the signtool command. Settings go in environment variables or a `signing.local.json`, which git ignores (as it does .pfx files).
- **installer\SIGNING.md**: how to get a certificate (a certificate authority, a cloud signing service, or free open-source programmes), how to install signtool, and how to set it up.
- The installer's **"Read me first.txt"** matches the setup: signed, it says how to check the publisher; unsigned, it keeps the "More info ▸ Run anyway" steps.

## 2026-10-20 21:54 — Faster patterns of bosses and other added features
- **Linear, circular and other patterns of an added feature** (bosses, ribs, pins…) now fuse all their copies into the body in one operation, as patterns of cuts already did. Before, each copy was fused on its own, and each fuse was slower than the last as the body grew. A plate with 200 bosses builds in 2.0 s instead of 8.8 s; 50 bosses in 0.58 s instead of 0.89 s. The result is the same.
- Copies that reach no body still become bodies of their own. Unusual cases (a copy bridging two bodies, loose copies overlapping each other) are still done copy by copy, as before.
- Mirrors were already a single operation (one copy).
- Regression test part: boss-pattern.

## 2026-10-20 21:51 — Parts reopen ready to edit
- **The geometry of every feature is kept between sessions.** When a part that takes a while to build is saved (or opened, then left unchanged), RazorCAD also stores the geometry kernel's state after each feature next to the stored model. Opening the part again restores it instead of building every feature, so the **first change after opening is as quick as any later one**. Before, the kernel rebuilt the whole part in the background first. Example: a sphere with 120 cut dimples was ready 1.8 s after opening before, now 0.09 s, and editing its last feature rebuilds only that feature.
- The stored states are checked feature by feature: anything changed since (in RazorCAD or in the file) is rebuilt from that feature on, as usual. They live with the stored models (%LOCALAPPDATA%\RazorCAD\modelcache, shared limit 1 GB, oldest removed first); shapes shared between features are written only once.
- Parts that build quickly (under 0.8 s, counting every feature) are not stored. The stored model now also follows the cost of the whole part, not just the last (quick) rebuild, so a big part saved after a small change is still stored.
- The session log notes how soon the model was ready after opening.
- Regression test: feature-states-kept (every test part written out, read back and rebuilt from it with the same result).

## 2026-10-20 21:36 — Cosmetic threads
- **Insert ▸ Features ▸ Cosmetic Thread** (also on the Features toolbar): click a bore or a shaft and choose the thread (metric or inch, automatic size from the face, custom, pitch, left-hand). Length: the whole face, a depth, or up to a plane / face; it starts at the end nearest where you clicked. The thread is **shown but not modelled**, so it costs nothing to rebuild, unlike Thread Cut / Thread Extrude. The feature's note says when the face is not the size the thread expects.
- **In the model:** a thin bronze helix on the bore or shaft. **Tapped holes** made with the Hole feature now show their thread the same way.
- **On drawings**, drawn by convention: from the side, thin lines at the thread's other diameter and a line where it ends (a bore's thread dashed, as it is hidden, unless a section cuts through it); end on, a ¾ circle. View ▸ Display ▸ **Cosmetic threads** turns them off for a view. Works in assembly drawings too.
- **Hole callouts** on a bore with a cosmetic thread give the thread: "M10×1.5 THRU ALL / TAP DRILL Ø8.5 THRU ALL".
- Fix: a feature reused from the rebuild cache keeps its list of missing references (Fix References ▸ Remove missing).
- Regression test: cosmetic-threads.

## 2026-10-20 21:30 — Geometry kernel: one request at a time
- The geometry kernel now finishes each request before it starts the next, in the order they were asked. A rebuild that pauses part way (while it reads an imported STEP or 3MF file, or an export being packed) no longer lets another request (a measurement, an export, a drawing view) run in that pause on a half-built model and reset the kernel under it. Before, an export asked for during such a pause could fail with "There is no body to export" or export the previous model.
- Crash reports also record how many kernel requests were waiting.
- Regression test: kernel-one-at-a-time.

## 2026-10-20 21:27 — References that survive edits; Fix References
- **Edges are found again after bigger changes.** An edge reference (fillets, chamfers, axes…) now also remembers the faces on its two sides and whether it is an outside or inside corner. When a dimension moves the edge so far that other edges lie nearer its old place, RazorCAD still finds the right one. It no longer takes a nearby edge of a different kind for it.
- **Faces that moved are found again** (shell, draft, faces picked for other features): the face facing the same way that is clearly nearest. A reference found this way is updated in the part, so it keeps following the model.
- **Mates follow their parts.** A mate's face or edge is checked by its geometry, not only by its number in the part. After a part gets a new feature (its faces numbered differently) or a dimension moves the face, the mate stays on the same face. A mate whose face or edge is gone is marked with a red **!** in the tree ("1 mate lost a face"), instead of quietly moving to another face.
- **Tools ▸ Fix References** (also: click the red error count in the status bar, or right-click a failed feature) lists every feature that failed to rebuild, what went wrong and which edges / faces are no longer found. For each: **Edit** (pick again), **Remove missing** (keep the references still found) or **Suppress**. The list updates after every rebuild. In assemblies: **Tools ▸ Fix Mates** (Edit / Suppress / Delete).
- Regression tests: references-follow-edits and mates-follow-part-edits.

## 2026-10-20 21:16 — Automated regression tests
- **`python tests/run_tests.py`** rebuilds 11 test parts with the real geometry kernel in headless Edge and compares the results with stored ones: feature errors and, per body, face / edge count, volume, area (sheet metal: flat-pattern size and bends), in every configuration. Covered: extrude, cut, linear and circular patterns, fillet, revolve, shell, sweep, loft, reference plane, sheet-metal base and edge flanges, multiple bodies and combine, counterbored holes, surface extrude and thicken, a one-operation cut pattern, structural members, equations and configurations.
- **UI checks** done with real pointer events: sketch a rectangle, dimension it, extrude it (checks the volume); a drawing with three views; an assembly of two components; the mouse buttons on the view.
- Exit code 1 on any difference; `--update` stores new expected results, `--only` runs a few, `--make-parts` regenerates the test parts from `tests/make_parts.js`. See `tests/README.md`.

## 2026-10-20 20:59 — Tool wheel on the right mouse button; Shift + right-drag pans
- **Sketch tool wheel:** press and hold the **right** mouse button in a sketch (or start dragging with it), move toward a tool and release. It no longer clashes with rotating the view: holding the middle button still while starting to rotate used to open the wheel.
- **A quick right click** (press and release without moving) still opens the right-click menu, in sketches and everywhere else. The browser's own menu no longer appears when the wheel closes.
- **Pan: Shift + right-drag** (Ctrl + right-drag and Ctrl + middle-drag also pan). A plain right-drag no longer pans.
- The middle button only turns the view (Ctrl: pan, Shift: zoom, Alt: roll). Drawings keep their own controls.
- Help ▸ Keyboard Shortcuts, README and the user manual describe the new buttons.

## 2026-10-20 20:36 — Version 0.12.0-beta
- `version.txt` 0.11.0-beta → **0.12.0-beta**, for the release with everything since 0.11.0-beta: drawings of assemblies (with fast hidden lines for big assemblies), the drawing tree fix, and some features and tools renamed.
- Installer `RazorCAD-Setup-0.12.0-beta.exe` and the user manual rebuilt.

## 2026-10-20 20:21 — Some features and tools renamed
- Some features, sketch tools, drawing tools and a ribbon tab have new, plainer names.
- Features in parts saved earlier that still carry an old default name are renamed when the part is opened; names you typed yourself are kept.
- README, user manual, website page and the Part Builder template use the new names.

## 2026-10-19 — Drawings of assemblies; drawing tree fix
- **Drawings of assemblies**: a drawing view can show an assembly as well as a part.
  - Model View and Standard Views list open assemblies, and Browse takes a .rasm file. **File ▸ Make Drawing from Assembly** (in an assembly) makes a drawing with its three standard views.
  - Every component is drawn where it sits, through its sub-assemblies, in the configurations shown. Suppressed and hidden components are left out.
  - Each part is built once and placed for every component that uses it. Section, detail, projected and other views, hole callouts and cut lists work on assemblies too.
  - **Big assemblies are drawn fast.** Above about 200 solids (or 600,000 display triangles), plain views are worked out from the parts' display meshes, the same ones the 3D view draws and keeps in the model cache. Hidden-line removal on thousands of solids took many minutes per view.
    - How it works: everything is drawn into a depth grid as the view sees it, then each edge, and the outline of each curved face, is followed over the grid. An edge is visible where nothing is in front of it and hidden where something is.
    - Lines, circles and arcs come out as they are, as exact as the 3D view's. Where an edge turns hidden is accurate to about two thousandths of the view's size.
    - On a 2,400-solid, 3.2-million-triangle site layout: a new drawing with its three standard views in about 25 s, and about 3 s per view after that (exact views took more than 9 minutes each). On a small test assembly, the visible lines matched exact hidden-line removal everywhere.
    - Each assembly view has **Hidden lines: Automatic / Exact / Fast** in its properties. Section and flat-pattern views are always exact.
- **The drawing tree's part row stays in its place.** It took on the look of a sketch dimension label (a white box floating over the tree), so it covered the drawing's name and moved off when the panel was widened.

## 2026-10-19 07:10 — Version 0.11.0-beta
- `version.txt` 0.10.0-beta → **0.11.0-beta**, for the release with everything below since 0.10.0-beta (STEP assemblies with their sub-assemblies and appearances, the assembly model cache and instanced display, sub-assemblies, drawing templates and sheet formats, PC fonts, the new logo, assembly picking, selection filters, planes, separate part files, no zoom-out limit).
- The installer is `RazorCAD-Setup-0.11.0-beta.exe`; the user manual is rebuilt for it.

## 2026-10-19 07:07 — Assembly picking, selection filters, planes, and saving parts as separate files
- **Picking in the 3D view is fixed**: the part under the cursor is the one picked, on any size of model. The pick ray used to start at the camera's position, which can be metres inside a big assembly, so it passed through the nearest parts and picked one behind them, and some parts couldn't be picked at all. On a 2,400-solid layout, picks now match what is drawn on top everywhere (they were right only 86–97% of the time).
- **Assemblies use the selection filters, as part files do.** With no filter, a click picks the vertex, edge, face or plane under the cursor; with the Bodies filter, whole components. Ctrl adds or takes away. The one under the cursor shows in orange. Dragging still moves the component.
  - Right-click a face, edge or vertex for Mate… and the component's commands. What is selected goes into Mate (M).
- **Every assembly has the standard planes and the origin** (Front, Top, Right Plane, Origin) at the top of its tree, imported or new. They show in the view like a part's (eye in the tree, View ▸ Show Planes), and mates can use them: they stay put, like the origin.
- **Mates find the other alignment** when the one chosen from how the faces sit can't be reached (e.g. faces at right angles), unless Flip was used.
- **Saving an assembly whose parts and sub-assemblies are only inside it** (e.g. from a STEP file) asks whether to keep them in one file, or save each as a file of its own beside the assembly (.rcad for parts, .rasm for sub-assemblies, those inside a sub-assembly saved before it). The assembly then uses those files, so each can be opened and changed on its own.
  - The same part used in several places is one file. Existing files are only replaced after asking.
  - The question is asked again on Save As, until the assembly is saved as one file.

## 2026-10-19 00:40 — No limit on zooming out
- **The view zooms out as far as you like.** It used to stop at about 10 m tall, so a big layout couldn't be zoomed out past Zoom to Fit, and the mouse wheel jumped back in.
- **The 3D view's depth follows the model's size and where the view has been panned to**, instead of a fixed ±20 m (still the least), so very large models are never cut off when turned.

## 2026-10-19 00:28 — Sub-assemblies, and STEP appearances kept
- **Sub-assemblies**: a component can use an assembly instead of a part, kept whole with its own parts, components, placements and configurations.
  - Insert Components ▸ Browse takes a .rasm file as well as a part. An assembly can't go inside itself.
  - A sub-assembly moves, hides, suppresses and explodes as one. Clicking any of its parts picks it, and selecting it highlights all its parts.
  - Mates can use faces, edges and vertices of the parts inside it, and follow them when they change.
  - The tree shows each sub-assembly's components under it (▶ to open), as deep as they go. Double-clicking one opens it in its own tab, and Open Sub-assembly does the same for the component. Changes made there come back to this assembly.
  - The Bill of Materials is indented: a sub-assembly's parts are listed under it (1.1, 1.2…), with quantities for one of it.
  - The same part in several places, inside sub-assemblies or not, is built once and drawn once.
- **STEP assemblies keep their structure**: Open as an Assembly makes a sub-assembly for each sub-assembly in the file, used wherever the file uses it, instead of flattening everything into one level.
- **STEP appearances are kept**: the colour of each solid and of single faces, and transparency.
  - Imported bodies and faces show them in parts and assemblies, whether the file opens as an assembly or as one part, is inserted into a part, or is a single-part file.
  - A body's own appearance or transparency setting still wins. An imported transparent body can be made opaque.
  - The appearances stay with the bodies through later features.
  - Each solid and face is found again by the box round its vertices, with solids that have none (spheres) in file order.
  - Part appearances set in RazorCAD (a body's colour, made transparent) now show in assemblies too.

## 2026-10-18 21:34 — New RazorCAD logo
- **The RazorCAD logo**: a sliced decahedron, its upper piece lifted clear to show a hatched section face, on the red tile.
  - It replaces the "R" mark in the title bar and shows in the About box, as the page icon, and in the Windows icon (`assets\razorcad.ico`).
  - `tools\make_icon.py` draws every size from one set of geometry: `assets\razorcad.svg` (copied to `app\razorcad.svg`), the multi-size `.ico` (no hatching below 48 px) and `assets\razorcad-512.png`.

## 2026-10-18 21:32 — Assemblies drawn part by part: moving a component is instant
- **An assembly draws each part once and places it at every component that uses it**: the part's mesh goes to the graphics card once, and each component is just a placement. Before, every component was copied into one big mesh.
  - Moving (dragging), hiding, suppressing or exploding a component only changes placements. On a 2,400-solid, 3.2-million-triangle layout, each drag step takes 0.2 ms instead of about 2.2 s, and showing the assembly takes 0.7 s instead of 2.2 s.
  - Without the copy, the 3D view uses about 1.3 GB less memory on that layout. Reopening it from the model cache takes 4 s instead of 6 s.
  - Edge lines are drawn per placement on the graphics card too.
  - Picking a component, face, edge or vertex goes through its placement to the part's own face and edge numbers. Face picks were checked against the old merged view and are identical.
  - Edge and vertex picking (for mates) only looks at the components near the cursor.
- Display styles (shaded, shaded with edges, hidden lines removed, wireframe), selection and hover highlights, Zoom to Fit and file previews work as before.

## 2026-10-18 21:25 — Assemblies reopen in seconds
- **Each part an assembly builds is kept in the model cache** (the one parts already use, in `%LOCALAPPDATA%\RazorCAD\modelcache`). It is keyed by a hash of the part as built, including the configuration used.
  - Opening the assembly again reads every stored part at once and shows them straight away. The kernel only builds parts that changed or were never built, then stores them for next time.
  - A part whose rebuild had errors is not stored.
  - Edge points are stored as 32-bit floats (the precision of the vertices), not as text, which halves the cache size.
  - On a 130 MB, 2,400-solid layout imported as an assembly: **reopening takes 6 s instead of 110 s**, from 40 MB of cache. The first open is unchanged.

## 2026-10-18 21:10 — STEP assemblies open as assemblies
- **Opening a STEP file that holds an assembly** asks whether to open it **as an assembly** or **as one part**.
  - As an assembly, each part of the file becomes a part of the assembly. A component is placed, fixed, where the file places each occurrence, with the part and product names from the file.
  - Each part holds only its own piece of the STEP file. It is read and built on its own, which takes less kernel memory than one huge part, and a part used several times is read once.
  - Parts take the colour the file gives most of their solids, until they get a material. Sub-assemblies are flattened into the one assembly.
  - The assembly structure is read straight from the file text, in a background worker (a few seconds for a 130 MB file).
  - On a 130 MB, 2,400-solid layout: 110 s to open instead of 131 s, and 930 MB of kernel memory instead of 1,445 MB, with the same placement to the millimetre.
- **Assembly undo no longer copies the parts**: each undo step keeps a reference to the part copies (a few KB) instead of copying them (which could be over 100 MB for imported parts).
- An assembly opened from a file is zoomed to fit once its parts are built.

## 2026-10-18 20:08 — Company sheet formats, drawing fonts and Change Template
- **A drawing template can carry its own sheet format**: a company border, title block and logo in place of the standard ISO one.
  - It is used on sheets of its size and orientation; a sheet changed to another size gets the standard format.
  - Its text shows the drawing's properties (title, drawing number, material…) and the scale, sheet size and sheet number.
  - Drawing Properties lists the title block's own fields (e.g. Ref No., Type, Status).
  - Views placed by Make Drawing from Part keep clear of its title block.
- **Pictures in drawings**: a sheet format's logo shows on screen, in file previews and in PDF exports (JPEG); DXF exports leave it out.
- **A sheet format can set its text in a font from the PC** (e.g. Century Gothic), read from the Windows Fonts folder like sketch text fonts (nothing is bundled). Text is measured in that font, and PDF exports embed it, so they look the same on any PC. If the PC doesn't have the font, the text falls back to Helvetica.
- **Century Gothic** is added to the fonts for sketch text.
- **Change Template…** (File menu, Sheet tab, and right-clicking the drawing in the tree) switches an existing drawing to another template.
  - The template brings its sheet format, sheet size, orientation and projection (on every sheet), drawing settings and notes. The old template's notes are replaced.
  - Company, tolerance and finish come from the new template. Other title block entries the drawing already has are kept.
  - Views, dimensions and annotations stay. Edit ▸ Undo goes back.
- **Changing the projection** (Change Template or Sheet Properties) lays the views out for the new projection. A view above or below its parent moves to the other side, so a top view stays a top view. A view beside its parent stays put and shows the side the new projection puts there. The views stay centred where they were.

## 2026-10-18 16:34 — Drawing templates and a New Drawing set-up dialog
- **Drawing templates (.rdrt), a file type of their own:**
  - A template keeps a drawing's set-up: its sheets (size, orientation, scale, projection), the drawing settings (text height, decimals…), the title block's standing entries (company, drawn / checked / approved by, finish, tolerances, revision) and notes placed on the sheet.
  - Part-specific entries (title, drawing number, material, mass, date), views and parts are not kept.
  - **File ▸ Save as Template…** in a drawing saves one, by default to `Documents\RazorCAD\Templates`.
  - Opening a .rdrt file edits the template in its own "Drawing Template" tab; Save writes it back.
  - Templates get an Explorer preview like other RazorCAD files, and .rdrt opens with RazorCAD.
- **New Drawing opens a set-up dialog** (also used by Make Drawing from Part):
  - Choose a template: your templates (from the Templates folder, or Browse… for one anywhere; browsed templates are remembered), or the standard ones: A4 portrait / landscape, A3, A2, A1, A0 landscape, and A3 / A4 in third angle projection.
  - Set the drawing name, title, drawing number, drawn by and company, and the first sheet's size, orientation, scale and projection. These are filled from the template and can be changed.
  - **"Use this template as my default"**: the default is marked and chosen first next time. Double-click a template to create the drawing at once.

## 2026-10-18 16:40 — Licensed under the GPL-3.0
- RazorCAD is free software under the GNU General Public License v3.0 or later (`LICENSE`).
- `THIRD-PARTY-NOTICES.md` lists the bundled libraries and their licenses (Open CASCADE under the LGPL-2.1; replicad, three.js and others under MIT) and the changes made to them.
- Help ▸ About RazorCAD shows the license and where the source is. The installer installs `LICENSE.txt` and `THIRD-PARTY-NOTICES.md` next to RazorCAD.exe and mentions the license on its first page.

## 2026-10-18 16:10 — First public release (GitHub)
- Source published at https://github.com/Labs9119/RazorCAD; the installer and manual are attached to the 0.10.0-beta release.
- Installer read-me: crash reports and feature requests go to GitHub Issues.

## 2026-10-18 15:44 — Project Edges works on selected edges
- **Select model edges first, then click Project Edges (or press E)**: the selected edges, vertices or other sketches' entities become real sketch geometry at once (solid, purple, linked to the source, ends joined), and the Select tool stays active.
  - Before, the tool ignored the selection. Clicking an edge with Select only makes a temporary reference for relations and dimensions: dotted construction geometry that is not part of the profile. So selected-then-converted edges stayed dotted and unusable.
- With nothing selected, Project Edges works as before: click the edges to convert.

## 2026-10-18 15:02 — Projected (converted) sketch geometry: visible, and usable as profiles
- **Projected / converted geometry is purple.** Lines, arcs and circles linked to model edges or other sketches (Project Edges, intersection curves, linked offsets) are now drawn in purple. Before, they were near-black like the model edges they usually lie on, so they could not be seen.
- **Converted entities join up.** Project Edges now joins the ends of the new lines with each other and with sketch geometry already at those points. Converting the edges of a face gives a closed outline that can be extruded or cut; before, each line kept its own ends and the sketch had "no closed profile".
- Converting something already in the sketch no longer stacks a copy on top: the status bar says it is already there.
- The linked outline still follows the model: widening the source part moves the converted corners, and the features made from them update.

## 2026-10-18 10:44 — Faster opening and tab switching; tabs show file names
- **Opening a part shows it at once:**
  - After a part that takes a while to build (over 0.8 s) is built, its finished model is stored, about 2 MB under `%LOCALAPPDATA%\RazorCAD\modelcache`.
  - Opening the unchanged file again shows that model straight away, and the kernel rebuilds it in the background ("Rebuilding…" in the status bar).
  - The store is keyed by the file's content, so a changed file is always rebuilt. It is cleared whenever RazorCAD.exe is rebuilt and kept under 1 GB.
  - Giant Golfball: 13 s → 0.3 s to see it.
- **Switching tabs shows the part at once:** each tab keeps its last model; the kernel catches up behind it. Before, every switch rebuilt the whole part.
- **Patterns of cuts are much faster:** the copies of a cut feature are cut out in one operation instead of one after another, which got slower with every cut.
  - Giant Golfball (11 circular patterns of dimples): 60 s → 13 s to rebuild, with identical geometry (same volume, area, faces and edges).
  - Sheet metal keeps the old one-by-one way.
- **Tabs and the title bar show the file's name.** A part, assembly or drawing still called by its default name (Part1, Assembly1…) takes its file's name when opened or saved, and assembly components are named after the part's file.
- Safer while a rebuild runs: other kernel requests (measure, export…) wait for it. A rebuild result arriving after another tab came to the front is no longer applied to that tab.

## 2026-10-18 10:24 — Explorer previews set up automatically
- Fixed: previews didn't show in Explorer because nothing was registered until Help ▸ Open Files With RazorCAD ▸ Register was clicked.
- RazorCAD.exe now sets this up itself when it starts:
  - `.rcad`, `.rasm` and `.rdrw` are made to open with it when they aren't set up yet, or when the RazorCAD they pointed to no longer exists.
  - Their Explorer previews are turned on.
  - Types set to another RazorCAD.exe that still exists are left alone.
- The previews are also registered under SystemFileAssociations, so they still show if the files are set to open with RazorCAD through "Open with".

## 2026-10-18 10:18 — File previews (thumbnails) for parts, assemblies and drawings
- **Saving keeps a preview in the file:** a picture of the view as it is when you save.
  - Parts and assemblies: the model framed as seen, on the view's background. A JPEG of up to 400 px, about 15 KB.
  - Drawings: the sheet shown. A PNG of up to 400 px.
  - It is written first in the file, so it can be read without loading the rest.
- **Windows Explorer and Open / Save dialogs** show the preview as the file's thumbnail.
  - New thumbnail handler (`shell\RazorCADThumbs.cs`), built by build.bat with the .NET Framework compiler that comes with Windows, and bundled in RazorCAD.exe.
  - It is set up with the file types: Help ▸ Open Files With RazorCAD ▸ Register (or Register Again), or by the installer. The dialog shows whether previews are on.
- **Start window:** each recent file shows its preview; files without one show their type's icon.
- Previews are dropped when a file is opened, so they never end up in memory, undo, or the copies of parts kept in assemblies and drawings.
- Files saved before this version show a preview after their next save.
- Installer script (not rebuilt): ships `RazorCADThumbs.dll`, registers the previews with the file types, and the uninstaller removes them.

## 2026-10-18 09:59 — DXF preview: zoom, pan, delete lines, change line type
- The DXF export preview (flat patterns) is now interactive:
  - **Zoom** with the mouse wheel (at the cursor), **pan** by dragging, **double-click** or **Fit** to see it all.
  - **Select** lines by clicking them (Ctrl / Shift + click adds or removes), **Shift+drag** for a box selection, Ctrl+A for all. The line under the cursor is highlighted.
  - **Delete** (Del key or button) removes the selected lines, text or notes from the file.
  - **Line type:** give the selected lines their own line type (Continuous, Dashed, Hidden, Center, Phantom, Dash-dot, Dot), or back to By layer.
  - **Layer:** move the selected lines or text to another layer (e.g. make a line a bend line or an etch line); they take that layer's colour and line type.
  - **Undo** (Ctrl+Z) and **Restore All** put deleted or changed lines back. Escape clears the selection (with nothing selected it closes the preview).
- What is shown is what is written. A line with its own line type is written with it (DXF group 6), and that line type is added to the file's line-type table.
- These edits are for that one export; the layer settings and options work as before.

## 2026-10-18 09:52 — DXF export from the flat pattern view
- While a flat pattern is shown (Sheet Metal ▸ Flatten, or right-click a sheet metal body ▸ View Flat Pattern), it can be exported straight to DXF:
  - **Export DXF…** button on the flat pattern banner, next to Exit Flatten.
  - **Right-click the view:** Export Flat Pattern as DXF (the body shown), Export All Flat Patterns as DXF, DXF Settings, Exit Flatten.
  - **File ▸ Export ▸ Flat Pattern as DXF…** (new), and File ▸ Export ▸ Face as DXF / the Export Face as DXF button, which export the flat pattern while one is shown.
  - Sheet Metal ▸ Export DXF exports the body being shown, even when the part has several sheet metal bodies and none is selected.
- The pattern already shown is exported as it is (no second flattening). The DXF preview with layer colours and options opens as before.

## 2026-10-18 09:40 — Own file extensions: .rcad, .rasm, .rdrw (open with a double-click)
- **New extensions:** parts save as **.rcad**, assemblies as **.rasm** and drawings as **.rdrw**. They are still JSON inside.
  - Windows picks the default app by the last extension, so the old `.json` names could only open with whatever opens `.json`.
  - Auto-saves keep the part's extension (`Bracket.autosave.rcad`).
- **Opening from Windows:** `RazorCAD.exe "file.rcad"` (double-click, Open with) opens the file instead of the start window.
  - If RazorCAD is already running, the file opens in a new tab there and that window comes to the front. No second copy stays open.
- **Help ▸ Open Files With RazorCAD (.rcad .rasm .rdrw)…** shows whether the types are registered and to which RazorCAD.exe. **Register** makes them open with this RazorCAD.exe for your Windows user.
  - Or right-click a file ▸ Open with ▸ Choose another app ▸ RazorCAD.exe ▸ Always.
- Installer script (not rebuilt): a new option, on by default, "Open .rcad, .rasm and .rdrw files with RazorCAD" (`/NOASSOC` to skip). The uninstaller removes the file types.
- Part files that start with a UTF-8 byte-order mark (e.g. edited in Notepad) now open.

## 2026-10-18 09:27 — Exploded views; section hatching per body with outlines
- **Exploded views for assemblies and multi-body parts** (the display moves only; the model and the mates stay put):
  - Assemblies: **Exploded View** on the ribbon or Insert menu. Parts: **Insert ▸ Exploded View…**, or right-click the Solid Bodies folder (two or more bodies).
  - In the Property panel:
    - Click components / bodies to pick them (click again to drop one).
    - Pick a direction: ±X / ±Y / ±Z, or along a face's normal.
    - Drag the picked items along the direction, or type the distance, then **Add Step**.
    - **Spread Out** spaces the picked items out along the direction, one step each.
    - Click a step to change it, ✕ to delete it.
    - **Explode lines** (dashed, from each item's place to where it is shown) can be switched off.
  - The tree has an **Exploded Views** folder:
    - Double-click a view to explode or collapse it (animated).
    - Right-click for Explode / Collapse, Animate, Edit, Rename, Delete.
    - Assemblies also get an Explode / Collapse ribbon button.
  - Dragging a component, adding a mate, or editing a feature or sketch collapses the view first (it is kept). Exploded views are saved with the file and are part of undo.
- **Section views show section lines (hatching) for each body / component:**
  - 3D Section View:
    - Each body or component gets its own cap, in its colour, with section lines.
    - The angle alternates and the spacing varies from body to body (45°, 135° wider, 30°, 150° wider, 60°, 120° closer…), so touching parts read apart.
    - Each cut body is outlined.
  - Drawing section views hatch each body with its own angle and spacing too.
  - Fixed: drawing section views of multi-body parts showed no hatching at all.

## 2026-10-18 09:07 — Part configurations in assemblies; assembly configurations
- **Components use a part configuration:**
  - Insert Components asks which configuration of the part to use (it starts on the one the part was saved showing; a browsed part file with configurations asks in a dialog).
  - Right-click a component to switch it to another configuration.
  - The tree shows each component's configuration, and the same part can be in the assembly in several configurations (e.g. a 40 mm and an 80 mm pin).
  - Mates on its faces follow the configuration used.
- **Assembly configurations, with the Configurations tab in assemblies too** (the same tab as for parts):
  - Default plus your own; Add, Copy, Rename, Delete, and double-click to show one.
  - While a configuration is shown, these change that configuration only: a component's part configuration, Hide / Show, **Suppress** (new: a suppressed component is left out, with its mates), and a mate's Suppress or value (Edit Mate).
  - Each configuration is listed with a summary of what it changes; the tree shows its name next to the assembly.
- **Bill of Materials:** one row per part and configuration used; suppressed components are left out.

## 2026-10-18 09:03 — Configurations tab
- A third tab at the top of the left panel, next to the Feature tree and the Property panel: the **Configurations tab**.
- It lists **Default** and every configuration of the part, the one shown ticked, each with a summary of what it changes (variable values, suppressed features).
  - **Double-click** one to show it.
  - **Right-click** for Show Configuration, Rename, Copy Configuration, Properties (Design Table) and Delete.
  - **+ Add Configuration** makes a new one starting from the one shown; **Design Table…** edits them all in a table.
- While a configuration is shown, **Suppress / Unsuppress** in the tree changes that configuration only; the other configurations keep the feature as it was. The tree shows the configuration's name next to the part and greys out what it suppresses.
- The tab is for parts only; drawings and assemblies don't show it.

## 2026-10-18 08:52 — Assemblies
- **File ▸ New Assembly** (also in the start window). An assembly opens in a tab of its own with the 3D view and saves as **.rasm**; File ▸ Open opens it.
- **Insert Components:** pick a part open in another tab, or browse for a part file.
  - The first component is **fixed** at the origin; the others are placed beside what is there.
  - The assembly keeps a copy of each part, refreshed from its tab or file whenever you come back to the assembly, so edit a part and the assembly follows.
  - Several instances of one part share it.
- **Mate** (M): click two faces, edges or vertices on different components, choose the type, and ✔ (it is ready for the next mate; Esc closes).
  - Types: **Coincident, Concentric, Parallel, Perpendicular, Tangent, Distance, Angle, Lock**. Each mate is shown applied while you choose; Flip swaps Aligned / Anti-Aligned (or the side for Distance / Tangent).
  - Faces count as planes (flat), axes (cylinders and cones; circular edges count too) or points (spheres, vertices).
  - A mate that conflicts with the others is refused with a message.
- **Moving components:** left-drag a component to move it, Alt+drag to turn it; it moves only as its mates allow. The middle button turns the view and the right button pans.
- **Feature tree:** the components with (f) fixed or (-) still free to move, an eye to hide or show each, and a **Mates** folder (right-click: Edit, Flip, Suppress, Delete).
- **Right-click a component:** Open Part (double-click too), Fix / Float, Hide / Show, Insert Another Instance, Rename, Delete.
- **Bill of Materials:** parts with quantities and materials; copy or save it as CSV.
- Undo / redo in the assembly.
- Not in yet: exploded views, interference detection, assembly drawings and STEP export of the whole assembly.

## 2026-10-18 08:26 — 3D Sketch: Project Edges, Spline, Tangent Arc, Move / Copy / Rotate
- **Project Edges** (Sketch tab, E): click model edges to bring them into a 3D sketch. Lines stay lines, circular edges become arcs or circles, and other curves become splines; edges that meet share their corner points.
  - The converted geometry (purple) stays **linked to the model**. When the part changes (say a box gets wider or taller), it follows the edges, and what is attached to it (lines drawn from its corners, dimensions) follows too.
  - "Unlink from the Model" in the Property panel makes it ordinary geometry.
- **Spline** (N): click the points it runs through (they snap like line points). Double-click or Enter ends it; clicking the first point closes it.
  - Drag its points to shape it.
  - A **Tangent** relation with a line at an end makes it leave the line smoothly.
  - Splines join lines and arcs into one curve for sweeps and routes.
- **Tangent Arc**: click the free end of a line, arc or spline, then where the arc should end. It carries on tangent (Tangent relation added); keep clicking for more arcs, Esc ends.
- **Move / Copy / Rotate**: select geometry, then:
  - **Drag** a selected line, arc or circle to move the selection; it snaps along X, Y and Z.
  - **Type** ΔX/ΔY/ΔZ and click Move or Copy, or rotate about X, Y, Z or the drawing plane's normal by an angle, with Rotate or Copy Rotated.
  - Copies keep the relations among the copied geometry. Rotations turn Along X/Y/Z relations with them (and drop the ones that no longer apply).
  - Fixed and converted geometry stays put.
- Also: two arcs that meet can be made Tangent.

## 2026-10-17 21:49 — 3D Trim and Chamfer; equal radii; fillets and chamfers made equal per use of the tool
- **Trim in 3D sketches** (Sketch tab, T): click the piece of a line, arc or circle to remove, up to where other entities cross or touch it.
  - A piece between two crossings splits the entity in two.
  - A circle loses the clicked piece between two crossings and becomes an arc.
  - With nothing crossing it, the whole entity goes.
  - New end points stay on the line that crosses there.
- **Sketch Chamfer in 3D sketches:** set the distance in the Property panel and click corners where two lines meet.
- **Equal radii:** two arcs or circles can be made Equal (3D: Equal Radius). 2D sketches already offered Equal for them.
- **Fillets and chamfers made equal, 2D and 3D:**
  - The first fillet made after picking Sketch Fillet gets the radius dimension. Each further fillet is made **Equal** to it instead of getting its own dimension, until you leave the tool. Changing the one radius changes them all.
  - Chamfers work the same way: the first gets one distance (both sides equal) and the later ones get **Equal Distance** to it.
  - Picking the tool again starts a new size.

## 2026-10-17 21:34 — 3D Sketch: Sketch Fillet, circles, arcs and polygons
- On the Sketch tab these now work in a 3D sketch too: **Circle, Centerpoint Arc, 3 Point Arc, Polygon and Sketch Fillet**. Each is drawn on the active drawing plane (the small grid) through its first click. Tab switches the plane before or between clicks, and a plane or face chosen with Ctrl+click works as well.
  - **Circle:** click the centre, then a point on the circle.
  - **Centerpoint Arc:** click the centre, the start, then the end. The arc follows the mouse round, either way.
  - **3 Point Arc:** click the start, the end, then a point it runs through.
  - **Polygon:** click the centre, then a corner (sides set in the Property panel, default 6). It stays regular (Regular Polygon relation).
  - **Sketch Fillet:** set the radius in the Property panel and click a corner where two lines meet. Both lines are trimmed and joined by a tangent arc, with a radius dimension (double-click to change it). The sharp corner stays as a point on both lines, so lengths measured to it keep their meaning.
- Arcs join lines end to end: a run of lines and arcs is one curve, e.g. a pipe route or sweep path with exact bends. Circles are curves of their own.
- Dimension: click an arc for its **radius**, a circle for its **diameter**. A Tangent relation can be added between an arc and a line that meet. Points snap to the midpoints of arcs too.
- A selected arc shows its radius, angle and length; a circle its diameter.

## 2026-10-17 21:23 — One set of sketch tools for 2D and 3D sketches
- The **Sketch** tab's tools now serve both kinds of sketch.
- With no sketch open, a tool such as Circle starts a **2D sketch**: you are asked for a plane or flat face, then the tool is ready.
- **3D Sketch** must be clicked to draw in 3D. While a 3D sketch is open:
  - The **3D Sketch** button stays highlighted and the first button becomes **Exit 3D Sketch**.
  - The tools a 3D sketch has stay available: **Select, Line, Centerline, Point and Dimension**, plus **Construction Geometry** (Q) for the selected lines and **Delete**.
  - Every 2D-only tool (rectangles, circles, arcs, splines, trim, offset, patterns, blocks, text, gears…) is **greyed out and can't be clicked**.
- The 3D sketch's Property panel no longer repeats the tool buttons. It names the active tool and keeps the drawing plane, the selection, exact points and the curve options.

## 2026-10-17 21:18 — 3D Sketch: snap to lines and their midpoints
- New points (line ends, points) now snap to the other lines of the 3D sketch, not just to their end points:
  - **Midpoint** of a line: shown with a green marker and the cursor note "Midpoint of the line". It gets a Midpoint relation.
  - **On a line**, anywhere along it: the line lights up and the cursor says "On the line". It gets an On Line relation.
- The relations keep the point there when the line changes (e.g. after a new dimension, or when dragging).
- Order of priority: points, then midpoints, then a point along a line, then the origin and model vertices, then along X/Y/Z, then the drawing plane.

## 2026-10-17 21:09 — 3D Sketch: draw along X, Y and Z in any view
- **Fixed: only two directions could be drawn.** Lines now snap along **X, Y or Z** from the last point whenever the mouse moves along that direction on screen, in any view and whatever the drawing plane. A dashed inference line shows it and an Along X/Y/Z relation is added. Hold Ctrl or Shift to draw freely. Before, a line could only follow the two axes of the current drawing plane until Tab was pressed.
- **Drawing plane:** away from the axes, lines follow the drawing plane through the last point. **Tab** cycles XY → YZ → ZX. The plane name shows at the cursor, and the space handle at the last point shows X, Y and Z.
- **3D sketch planes:** Ctrl+click a plane or flat face, or click a plane in the tree, to draw on it. Points placed there get an **On Plane** relation. Tab or Esc goes back to XY / YZ / ZX.
- **Dimensions:** while placing a length or distance, **Tab** cycles true length → ΔX → ΔY → ΔZ. Dimensions are placed with a click.
- **More 3D relations:** Collinear; Parallel to XY / YZ / ZX; On XY / YZ / ZX plane; On Plane. These come on top of Along X/Y/Z, Parallel, Perpendicular, Equal, Midpoint, On Line, Fix and Merge.
- **Point and line properties:** a selected point shows its X, Y and Z (type new values to move it; refused if its relations hold it). A selected line shows its length, ΔX/ΔY/ΔZ and end points.
- **Centerline tool** (and Make Construction): construction lines shape the sketch, e.g. a frame envelope to attach to, but make no curve.

## 2026-10-17 19:54 — Kernel memory no longer grows with every rebuild
- **Fixed: the geometry kernel kept almost everything it ever made.** In the bundled kernel (`replicad_single.wasm`), `delete()` did nothing for 171 of the 271 kernel classes RazorCAD uses. That includes every shape, every boolean, fillet and extrude builder, explorers, points and boxes: no destructor ran and no memory was freed. Each shape left behind also kept its geometry in memory, and objects the code dropped without deleting were never freed at all. So the kernel's memory grew with every rebuild until the worker was replaced at 3.6 GB. (The "Booleans about twice as fast" entry below blamed memory held inside OpenCascade itself. That was wrong.)
- New `app/js/ocfree.js` frees these objects properly. Builders go through their own C++ destructor, shapes drop their geometry reference, and plain values are freed directly. Objects the code drops are freed once JavaScript has collected them. Two small hooks in `app/vendor/replicad/replicad_single.js` make this possible; the kernel itself is not rebuilt. Replicad's edge queries (point, tangent, type and so on) also free their temporary curve straight away.
- Kernel memory over repeated rebuilds, before → after:
  - 464 BCAF impeller, 6 rebuilds: 163 → 287 → 413 → 595 → 595 → 811 MB → 100 MB every time.
  - Giant Golfball, 2 rebuilds: 287 → 496 MB → 127 → 127 MB.
  - BCL 400 Blade SM, 4 rebuilds: 100 → 163 → 239 → 344 MB → 100 MB every time. PBWE impeller, 5 rebuilds: 100 → 199 MB → 100 MB.
  - Part1: 444 → 1077 → 1077 MB, unchanged. That is working memory, not a leak. Fillet4 (a fillet that includes a B-spline edge) needs a few hundred MB while it runs, the kernel's memory never shrinks, and it doesn't grow after the second rebuild.
- Rebuilds are a little slower because of the extra freeing work: 464 impeller 2.55 → 2.8 s, PBWE impeller 0.57 → 0.63 s, Part1 6.6 → 6.8 s. Giant Golfball and BCL 400 Blade SM are unchanged.
- The worker is still replaced at 3.6 GB. A fresh worker takes about 1.3 s to start, plus a full rebuild of the part (Part1 7 s, Giant Golfball 61 s), and memory returns to the same peak within two rebuilds. Replacing it sooner would only add waits.
- Unchanged: these all rebuild with the same bodies, volumes, areas, and face, edge and triangle counts as without this change:
  - Part1 (and its autosave), BCL 400 Blade, BCL 400 Blade SM, the sample part, transition1, the PBWE impeller, the Giant Golfball and the 464 impeller;
  - three test parts with shells, lofts, sweeps, holes, threads, structural members, splits, patterns, mirrors, and sheet metal flanges, hems and corner reliefs.
- Tested on the 464 impeller: STEP and STL export, measure, drawing views, feature previews, interference and the flat pattern all work.

## 2026-10-17 19:54 — Booleans about twice as fast across the whole model
- **Every cut, join and intersect was computed twice.** This covered extrude, revolve and sweep cuts and joins, patterns of them, and the other features that combine bodies. Each one is now computed once, in the geometry library RazorCAD uses (replicad, in `app/vendor/replicad`). Its working data is freed as soon as the result is taken.
  - Part1: 11.3 s → 6.5 s. Giant Golfball: 79 s → 62 s. Sample part: 0.23 → 0.19 s. BCL 400 Blade: 0.26 → 0.15 s.
  - A test of 150 cuts on a 66-face part: 9.3 s → 4.8 s. 150 joins: 10.3 s → 5.5 s.
  - Rebuilds that are mostly sheet metal or patterns are unchanged (464 impeller about 2.5 s, BCL 400 Blade SM about 5.4 s, PBWE impeller about 0.56 s). The sheet-metal fix above already did this for folding.
- Booleans and moves, turns, mirrors and scales also free their temporary copy of the result, and each move frees its transform. Before, these stayed in memory for as long as the kernel ran.
- **Memory is about the same.** The kernel's memory (`kernelMemoryMB`) reached the same sizes before and after: Part1 444 MB on the first rebuild and 1077 MB on later ones; the 464 impeller 287 → 413 → 595 MB over three rebuilds. Measured inside the kernel, each cut still leaves about 0.7 MB in memory and each join about 1.5 MB, even with every result freed. That memory is kept inside the OpenCascade kernel itself, which RazorCAD's code can't free. The worker is still replaced at 3.6 GB.
- Unchanged: Part1 (and its autosave), BCL 400 Blade, BCL 400 Blade SM, the sample part, transition1, the PBWE impeller, the Giant Golfball and the 464 BCAF impeller all rebuild with the same bodies, volumes, areas and face and edge counts as before.

## 2026-10-17 19:54 — Patterns of sheet metal parts; much faster cuts across formed sheets
- **Fixed: Circular Pattern, Linear Pattern and Mirror of a sheet metal feature** (Base-Flange, SM-Extrude, Lofted-Bend, Transition) put every copy on top of the original, and the copies left out later changes such as flanges and cuts. Each copy is now the body as it is at the pattern, turned or moved into place. It stays sheet metal, with its own flat pattern. The same goes for Sketch, Curve and Fill Patterns.
  - **Mirror** gives the mirror-image part. Its flat pattern is mirrored, with every bend (and form) going the other way. A mirrored lofted bend becomes a plain solid, and the feature says so.
  - Tested on the 464 BCAF impeller: a Circular Pattern of the trimmed SM-Extrude blade gives 10 sheet metal blades, each 241.2 × 160.7 mm flat with 14 bends, matching the old solid copies. A Move/Copy Bodies of the trimmed blade gives the same result.
- **Fixed: a cut across many bends made the part slow, and copying it could crash the kernel** ("memory access out of bounds"). Example: the cone trim on the 14-bend 464 blade.
  - The cut's outline across each bend was traced as a polyline of 48 points per curve. That gave the flat pattern 675 short edges and the folded blade 703 faces. Each traced curve is now one smooth spline edge: the same blade now has 17 edges and 45 faces, with the same volume, flat size and flat area as before.
  - Folding a sheet now does each boolean once (before, every one was done twice), fuses the panels and bends together in one step, and frees its temporary shapes as it goes. Before, they stayed in memory until the rebuild ended.
  - The 464 impeller as it was saved (one sheet metal blade and 9 solid copies) now rebuilds in 7 s instead of 35 s. It uses 240 MB of kernel memory instead of 1.6 GB.
  - With all 10 blades as sheet metal, patterned after the trim, it rebuilds in about 4 s using about 300 MB. Patterned before the trim, so each blade is trimmed as sheet metal, it takes about 16 s.
- Unchanged: the existing test parts (Part1, BCL 400 Blade, BCL 400 Blade SM), the sample part, a flanged tray with closed corners, a transition, and the PBWE impeller all rebuild exactly as before: same bodies, volumes, face counts and flat patterns.

## 2026-10-17 13:45 — 3D sketches drawn in space; visibility column; hide single planes; Change Sketch Plane
- **3D Sketch rebuilt from scratch.** It opens empty, with no plane to pick, and the Line tool is ready.
  - Click points to draw lines in space. Lines are drawn on a drawing plane through the last point (XY, YZ or ZX); **Tab** switches it. Each line snaps to the X, Y and Z directions and gets an Along X/Y/Z relation.
  - Points snap to the sketch's own points, to model vertices and to the origin (both fixed there).
  - A "Next Point" box in the Property panel takes exact offsets (e.g. 0, 0, 250).
  - **3D relations:** Along X/Y/Z, Parallel, Perpendicular, Equal Length, Midpoint, On Line, Fix and Merge (coincident). **Dimensions:** length, distance between points, and angle between lines.
  - A solver keeps everything held and reports Fully defined or the degrees of freedom left. A relation or dimension that conflicts is refused with a message. You can drag points, and undo/redo works inside the sketch.
  - Each connected run of lines is a curve (a T-junction splits into separate runs), as straight runs with an optional bend radius or as a spline. Sweeps and structural members use it as before.
  - Older 3D sketches are converted when opened and keep their shape.
- **Visibility column** at the right of the feature tree: an eye on every sketch, plane (the three standard planes too), axis, point, curve, body and body-making feature. Click it to show or hide that item. Hiding a feature hides the bodies it built.
- **Hide single references:** planes, axes, points and curves can be hidden one at a time (eye, or right-click ▸ Hide), whatever the Planes/Axes/Points switches are set to.
- **Change Sketch Plane…** (right-click a sketch): pick another plane or flat face for an existing sketch, e.g. to repair one whose plane was deleted ("The reference plane is missing"). Its curves keep their sketch coordinates. Only planes above the sketch in the tree are offered.

## 2026-10-15 21:28 — Fixed: Claude Code not found when it came with the Store version of the Claude app
- The Claude desktop app from the Microsoft Store keeps its copy of Claude Code in `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\claude-code`. Only the Claude app itself sees that folder at `%APPDATA%\Claude`, so RazorCAD missed it. RazorCAD now looks in both places.
- Tested by signing in to Claude Code with a Claude subscription, then sending a request through RazorCAD's subscription backend. A plate with a hole came back as a valid feature list in about 3 seconds.

## 2026-10-15 21:23 — Ask Claude can use your Claude subscription (no API key)
- Claude Settings has a new choice: **My Claude subscription (Claude Code on this PC)** or **An Anthropic API key**. With the subscription, each request goes through the Claude Code command-line program installed on this PC, signed in to your own Claude Pro/Max plan. It counts toward that plan's usage limits, and there's no separate API bill.
- The dialog shows where Claude Code was found, its version and whether it's signed in. **Sign In…** opens a window running `claude auth login`, which you finish in the browser. **Check Again** re-reads the status.
- RazorCAD looks for Claude Code in this order: on PATH, `~\.local\bin\claude.exe` (the native installer), npm's `claude.cmd`, then the newest copy bundled with the Claude desktop app. To use a specific copy, set `"cliPath"` in `%APPDATA%\RazorCAD\claude.json`.
- Claude Code runs with no tools, no MCP servers and no settings, CLAUDE.md files or memory. It runs from an empty folder (`%APPDATA%\RazorCAD\claude-cli`), so it sees only RazorCAD's guide and your request. An `ANTHROPIC_API_KEY` in the environment is ignored, so the request uses the subscription sign-in.
- This is for each person's own use: everyone using it needs Claude Code installed and signed in as themselves. The API key option is unchanged, and the browser (development) version still uses only the API key.

## 2026-10-15 07:25 — Installer 0.10.0-beta, with the version on it
- New installer: `RazorCAD Install\RazorCAD-Setup-0.10.0-beta.exe`. It includes everything since 0.9.0-beta (11 Oct).
- The version is now in the installer's file name and in its Properties ▸ Details (file and product version). The setup window and Windows' Installed apps list already showed it.
- "Read me first.txt" names this version and its setup file.
- The previous installer was renamed `RazorCAD-Setup-0.9.0-beta.exe` (kept, not deleted).
- Building: set the version in `version.txt`, then run `installer\build_installer.bat`.

## 2026-10-14 23:28 — Fixed: Dimension did nothing in sketches
- Clicking a line, circle or point with Dimension again picks it, and the next click places the dimension and opens the Modify box.
- Cause: the 13:23 build ("Sketch tools: ellipse, … extend, split …") accidentally removed the line that passed Dimension clicks to the dimension code. Clicks then went to the code for two-click drawing tools, which created nothing. A check of the other changes made that day found nothing else removed this way.

## 2026-10-14 22:40 — Cut lofted bends have square edges; no rolling lines on formed parts
- A cut through a Lofted-Bend (or a Transition) now gives edges square to the sheet, as a laser-cut blank formed to shape has. Before, the body was cut by the tool as it was, so a trimmed edge followed the cutting surface at a slant through the thickness, which could leave a thin lip where it met the sheet at a shallow angle (e.g. a fan blade's tip on the A diameter).
- The 3D edges now follow the flat pattern exactly: each cut edge of the pattern is carried onto the sheet at its neutral layer, and the sheet is trimmed square to itself there. Holes cut through the sheet are square too.
- Formed (rolled) Lofted-Bends and Transitions no longer show bend lines across their smooth stretches in the flat pattern, DXF and drawings. A rolled part needs none, as with a cylinder. Real sharp folds at a profile's corners (e.g. a square-to-square transition) still get their bend lines, and Bent lofted bends keep all of theirs.

## 2026-10-14 21:21 — Fixed: formed lofted bends shown as facets; Thicken making inside-out solids
- Formed Lofted-Bends (e.g. a cone between two arcs) are smooth again where they came out as many flat strips. The smooth solid was right, but its volume was measured several % short (a quick integration that misjudges B-spline faces with many spans), so it failed the check against the facets and the facets were used. It is now measured span by span. A fan blade cone of 72 divisions: 6 faces instead of 372, same flat pattern.
- Thicken could make an inside-out solid (negative volume), depending on the side and Flip. It looked right, but Combine ▸ Common with it gave the material round it instead (e.g. a ring with a blade-shaped slot), and cuts and mass were wrong. Every Thicken solid now faces out. Checked for one side and both sides, Flip on and off, on a curved and a flat surface, with Combine ▸ Common.
- (A formed Transition with corners still uses facets: its smooth solid can't be made yet.)

## 2026-10-14 21:10 — Cuts on lofted bends carried into the flat pattern
- A cut (extruded, revolved, …) through a Lofted-Bend, or a Transition made from one, now cuts its flat pattern too. Before, the body was cut but the flat pattern and DXF still showed the uncut sheet.
- The cut is traced where it crosses the sheet's neutral layer and laid into the developed pattern, so a laser-cut blank formed to shape matches the cut body. Holes become cut-outs (with their pierces and cut length), and a cut that trims an edge trims the outline. Forming / bend lines are clipped to what is left.
- This makes trimmed conical parts possible, e.g. a fan blade: loft the cone between two arcs, then cut it to the blade outline with a revolved cut.
- The body is cut by the tool as it is, so trimmed edges follow the cut's surface rather than being square to the sheet.

## 2026-10-14 20:35 — Feature tree arrows: lines enter the arrowheads from behind
- Each arrow now runs straight for at least 28 px before its head. Before, when the related item sat right next to the arrow's lane, the vertical line ran into the side of the arrowhead.

## 2026-10-14 20:32 — Feature tree: straight parent/child arrows
- When a feature is selected, the arrows to its parents (blue) and children (purple) now use straight lines with square corners instead of curves. Each line runs right from the feature, straight up or down in its own lane, and back to the related item.
- Nearer items get the inner lanes and farther ones the outer lanes, so the lines nest without crossing. Lanes stay clear of the names they pass and of marks such as a rebuild error's "!".

## 2026-10-14 20:25 — Fixed: a deleted STL body stayed on screen (and in new parts); long operations can be stopped
- Cause: an Extrude cut through the imported 3DBenchy (79,000 mesh faces) takes several minutes. While it ran, every later change (deleting the Benchy, opening a new part) waited in line behind it, so the screen and the Solid Bodies list kept showing the old Benchy.
- Deleting or changing the feature being worked on (or anything before it), or opening another part, now stops the stale work at once. Deleting the Benchy and the cut now clears the model in about 1 second.
- After 4 seconds a banner above the model says what is being worked on ("Still working on Extrude Cut1 (12 s)…"), with a **Stop** button (also next to the progress bar in the status bar). Stop restarts the geometry kernel. A feature you are still editing is cancelled, and a finished feature is suppressed (unsuppress it to try again).
- Starting a cut, boss, fillet, shell, combine and similar features on a body with more than 20,000 mesh faces shows a warning that it can take several minutes.

## 2026-10-14 20:07 — Fixed: big STL files (e.g. 3DBenchy) would not import
- Large meshes (STL, OBJ, 3MF) are now simplified on import to 80,000 triangles. The triangles that change the shape least are merged, edges and outlines are kept, and no triangle is flipped. 3DBenchy (225,706 triangles) comes in as a closed solid in about 14 seconds, its volume unchanged to 0.001%.
- Before, a mesh over 200,000 triangles was refused. Raising that limit was not enough: the geometry kernel ran out of memory well before that size.
- The limit is in the import's properties ("Simplify meshes above … triangles"; 0 never simplifies), and the import's note says how far a mesh was simplified.
- Imported meshes are shown (and repaired by Repair Mesh / Convert to Solid) straight from their triangles instead of being meshed again by the kernel, which also ran it out of memory.
- Organic meshes (scans, sculpted models) skip the merge of flat areas, which only helps CAD-made STLs and took minutes on big ones.

## 2026-10-14 19:53 — Two-row ribbon with icon sizes
- The toolbar ribbon now shows its buttons in two rows of smaller icons, each label under its icon. Every toolbar fits across the window instead of running off the side; the Sketch toolbar is about half as wide as before.
- Toolbar icon size: Small, Medium or Large, from View ▸ Toolbar Icons or by right-clicking the ribbon (a button, a tab or the empty space). The ribbon's height follows the size, and the choice is remembered.
- Dragging buttons to rearrange them works across both rows.

## 2026-10-14 18:26 — Fast Structure: weld beads and cut list
- Weld Bead: beads of the weld size along every line where the chosen bodies touch (none chosen: every weldment member). Each joint is its own bead body.
- Cut List (Fast Structure tab): identical members counted together, with their length, end angles, total length and mass each (from the bodies' materials), then plates and welds (total weld length). It also shows the total length by profile and exports to CSV (opens in Excel).
- Drawings: Cut List Table (Annotation tab) for the part of the selected view. It updates when the part changes.
- Fixed: a drawing view could get a stray line far outside the part (seen with weld beads looked at end on), which spoiled the view's size and the sheet scale.

## 2026-10-14 15:46 — Fast Structure: Trim/Extend, End Cap, Gusset
- Trim/Extend: members trimmed or extended to a plane or another body at their nearer end, either cut square on the boundary's face or coped to it. Click the members on the model.
- End Cap: a plate on the open end of a tube or pipe, on the end or set inside it flush.
- Gusset: a triangular plate in the corner between two members (click a flat face on each), with leg lengths, thickness, a corner chamfer for weld clearance, and its position along the corner.
- Caps and gussets are bodies of their own, named by size for the cut list.

## 2026-10-14 15:43 — Fast Structure: Structural Member
- New Fast Structure tab with Structural Member: a standard profile along every line and arc of a sketch or 3D sketch (and of more sketches added to the list, for frames in 3D). Each member is its own body, named after its profile.
- Profiles: SHS, RHS, CHS (pipe), equal and unequal angle, channel (PFC / UPN), I-beams (UB, UC, IPE, HEA), flat and round bar. Size tables for AS/NZS and EN/ISO, or enter your own sizes.
- Corners where two members meet: mitred, or butted either way. A member ending on the middle of another (a T-joint), or under a corner (e.g. a table leg), is trimmed to it, square on its face. Pipes and round bars are coped (fish-mouthed).
- Alignment: which point of the profile the sketch line runs through (centre, corners, edges), profile rotation and mirror.

## 2026-10-14 15:22 — Zebra stripes, curvature and draft analysis, Flatten Surface
- Zebra Stripes (Evaluate tab): reflected stripes on every body. Smooth joins show the stripes running on without a kink.
- Curvature (Evaluate tab): bodies coloured from blue (flat) through green and yellow to red (tightest). The status bar gives the radius red stands for.
- Draft Analysis (Evaluate tab): choose a pull direction (an axis or a selected face's normal) and the draft needed. Faces turn green with enough draft, red with draft the other way, yellow where they need more. Click a button again to turn its display off.
- Flatten Surface (Surfaces tab): faces of a surface or a solid unrolled flat beside the model as a surface body. Surfaces that unroll (cylinders, cones, bent sheets) come out exact. Doubly curved ones (e.g. a dome) are spread out keeping their edge lengths as well as possible, and the note gives the size, the area change and how much the edge lengths changed.

## 2026-10-14 15:13 — Split Line, Projected Curve, Composite Curve, Boundary Surface
- Projected Curve: a sketch projected along its normal onto faces, as a 3D curve.
- Split Line: faces split along a sketch's projection, or where a plane or surface crosses them. The body stays one body with the faces split, e.g. for a part line, a draft or a colour.
- Composite Curve: edges of the model joined end to end into one curve.
- Boundary Surface: a surface through curves in two directions. The first and last of each direction bound it, and the ones between shape it.
- Projected and composite curves can be used as sweep paths, lofted-surface profiles, curve-driven pattern paths and boundary curves.

## 2026-10-14 15:10 — Delete Face, Replace Face, Ruled Surface, Untrim
- Delete Face: take faces out of a solid or surface. Either leave the hole (the body becomes a surface body) or patch each hole smoothly, optionally tangent, so the solid stays solid. Good for removing fillets and bad faces from imported parts.
- Replace Face: flat faces of a solid move onto a surface body, so the body grows or shrinks to meet it (e.g. a curved top).
- Ruled Surface: straight-sided surfaces standing on edges, either square to the surface or along a direction tapered by an angle, on one or both sides (e.g. mould parting surfaces). "Tangent" is left out because Extend Surface already does that.
- Untrim Surface: fill a surface's holes, or give it back its natural extent.
- Fixed: a Planar Surface from a sketch with holes in it failed to build.
- Fixed: the "make a solid" option of Filled Surface (and Delete Face) could close an open surface into a solid. It now only does so when nothing is left open.

## 2026-10-14 15:06 — Surfaces: lofted, swept, filled, trim and extend
- Lofted Surface: a surface through two or more profiles (sketches or 3D sketches), open or closed, optionally ruled. Open profiles drawn in opposite directions are lined up automatically.
- Swept Surface: an open or closed sketch profile (or a circle) swept along a sketch, 3D sketch or helix as a surface.
- Filled Surface: a smooth patch over a hole bounded by edges (of a surface or a solid), touching or tangent to the faces round it. It can be knit into the surface and close a solid. A flat loop gives a flat patch.
- Trim Surface: surfaces cut by a plane, a surface body (optionally trimming each other) or a sketch's curves. You click the pieces to keep, or to remove.
- Extend Surface: open edges of a surface carried straight on by a distance, following the surface's slope at the edge, and knit to it.

## 2026-10-14 13:56 — OBJ / 3MF, DXF into sketches, appearances, interference check, configurations
- Import and export OBJ and 3MF meshes (3MF in millimetres, with its units and build placement read on import). Closed meshes come in as solids, open ones as surfaces (Repair Mesh / Convert to Solid can close them).
- Import DXF (Sketch tab): lines, arcs, circles, polylines with arcs, ellipses (and elliptical arcs), splines, points and blocks go into the open sketch. The file's units are converted to millimetres, and you can scale it and place it as in the file, centred, or by its corner.
- Appearance: right-click a face (Appearance…) or a body (Body Appearance…) to give it a colour, or set it back to the default. Face colours stay with their face when the model changes.
- Interference Check (Evaluate tab): finds where solid bodies overlap, lists each pair with its overlap volume and shows the overlaps in red.
- Configurations / design table (Evaluate tab): each configuration gives the global variables other values and can suppress features. The active one is picked with a click, and the table can be copied to / pasted from Excel as CSV.
- IGES is not available: the geometry kernel in RazorCAD is built without its IGES module. STEP does the same job and is read by all CAD programs.

## 2026-10-14 13:49 — Drawings: callouts, baseline/ordinate/chamfer dimensions, auxiliary/break/crop views, GD&T and symbols, revision table, DXF export
- Hole Callout: click a hole and the callout gives its size and depth from the Hole feature (counterbore, countersink, tapped thread and tap drill), plus how many of the same holes the view shows (e.g. "4× Ø6.6 THRU ALL / CBORE Ø11 DEEP 6.5").
- Baseline Dimension (stacked from one base), Ordinate Dimension (distances from an origin along a row) and Chamfer Dimension ("3 × 45°").
- Auxiliary View (looking square at an inclined edge), Break (a long part shortened, with dimensions across the break keeping the true length) and Crop View (only the area drawn round). Views can be un-broken or un-cropped from the right-click menu.
- Datum Feature, Geometric Tolerance (feature control frames with the 14 characteristic symbols, Ø zone, material condition and up to three datums), Surface Finish and Weld Symbol (fillet, square, V, bevel, plug; arrow / other / both sides; all-around, field weld, tail), each with an optional leader.
- Revision Table: rows edited in one dialog; the latest revision goes into the title block.
- Export DXF of the current sheet (layers for visible, thin, hidden, centre lines, text and hatching). DWG can't be written: it is a closed proprietary format, and practically every CAD program opens DXF.

## 2026-10-14 13:40 — Pattern any feature; sketch, curve and fill patterns
- Linear Pattern, Circular Pattern and Mirror now copy any feature that changes the bodies at a place. That includes holes, cuts, fillets, chamfers, drafts, domes and sheet metal forms, not only extrudes and revolves. Features without a shape of their own (e.g. a fillet) are run again on the matching edges or faces of each copy.
- Sketch Driven Pattern: a copy at every point (or circle centre) of a sketch.
- Curve Driven Pattern: copies spaced along a sketch, 3D sketch or helix, either evenly to the end or at a set distance. They are moved, or turned to follow the curve.
- Fill Pattern: copies on a square or staggered grid over a flat face, kept a margin from its edges (e.g. perforated panels).

## 2026-10-14 13:35 — Draft, Rib, Dome, Move Face, Scale, variable and face fillets
- Draft: pick a neutral face, then the faces to tilt by an angle (reversible).
- Rib: an open sketch line is thickened and filled out until it meets the model, either in the sketch plane (e.g. a gusset across a bracket corner) or square to it.
- Dome: a spherical cap or half ellipsoid on round faces, and a smooth dome filled over any other flat outline. Reverse presses it in.
- Move Face: push or pull flat faces along their normal, or turn a face about one of its edges (the neighbouring faces follow).
- Scale: every body by one factor, about the origin or the centre of the bodies.
- Fillet: new Variable size (radius at the start → radius at the end of each edge) and Face fillet (pick faces; the edges where they meet are rounded).
- Toolbars you have rearranged now show commands added in later versions next to their usual neighbours, instead of at the end of the bar.

## 2026-10-14 13:23 — Sketch tools: ellipse, 3 point and tangent arcs, point, extend, split, sketch patterns, blocks
- Ellipse tool (centre, end of the major axis, minor radius). Trim an ellipse for an elliptical arc. Dimension on an ellipse sets the minor radius, or the major radius when placed nearer the major axis. Points can be put on ellipses with On Curve relations. Ellipses extrude, revolve and sweep exactly.
- 3 Point Arc (start, end, then a point it runs through) and Tangent Arc (from the end of a line or arc, kept tangent by a Tangent relation).
- Point tool: lone sketch points that stay (e.g. for Hole positions).
- Extend (a line or arc end runs on to the first entity in its way and stays on it) and Split (a line or arc split in two at the click, kept collinear / equal).
- Linear and Circular Sketch Patterns of the selected entities. The relations and dimensions among them are copied too (circular patterns copy only the ones a rotation keeps). A selected point is the circular pattern's centre.
- Blocks: Make Block saves the selection (with its relations) under a name in your settings. Insert Block places copies with a click, in any sketch, and can delete blocks from the library.

## 2026-10-14 11:47 — Hole
- New Hole (Features tab, Insert ▸ Features): clearance holes (ISO 273 close / normal / loose for M2–M24), counterbores (socket head cap screws, ISO 4762), countersinks (ISO 10642, 90°) and tapped holes (ISO metric and Unified, drilled at the tap drill size, the thread kept for callouts), or your own sizes. Blind with a 118° drill point, or through all; reversible. Placed at clicked points on a flat face, or exactly at the points and circle centres of a sketch on the face. Works on sheet metal too.

## 2026-10-14 11:28 — Miter Flange, Sheet Metal Check and bend tables
- New Miter Flange (Sheet Metal tab): a flange with a profile of up to four segments (length to the outside of the bends, angle; a negative angle folds back the other way — 90 / 90 makes a C, 90 / −90 a Z) along a chain of edges, the corners mitred (closed, with a gap) at every level.
- New Sheet Metal Check: lists every bend of the sheet metal body (direction, angle, inside radius, length, the straight flange on each side) and warns about flanges shorter than 3 × t past their bend and holes closer than 2t + R to a bend.
- Drawings: flat pattern views can show a bend table instead of notes — the bend lines numbered B1, B2 … and a table (direction, angle, inside radius) under the view.
- (Rip and normal cut: Convert to Sheet Metal already leaves a closed box's extra corners open, and cuts on sheet metal are already square to the sheet across bends.)

## 2026-10-14 11:23 — Forming tools and Gusset
- New Forming Tools (Sheet Metal tab): Dimple (diameter, depth), Extruded (flanged) hole (hole diameter, collar height, bend radius) and Louver (width, opening height; drawn as a line on the face — the slit). Placed at clicked points or exactly at the points / circle centres of a sketch on the face; pressed toward the face they are placed on, or the other way. The flat pattern gets a centre mark and a note for each, an extruded hole's pre-hole (the collar laid flat) and a louver's slit as a cut.
- New Gusset: click a bend (its round face) to press a stiffening dart across it at that point (size and width); the flat pattern marks it.
- Forms stay with the part through later sheet metal features and are left off (rather than breaking the part) if one cannot be made.

## 2026-10-14 11:17 — Tab and Slot
- New Tab and Slot (Sheet Metal tab): click the edge of one sheet metal part where it sits on another, then the face of the other part. Tabs are added along the edge (number, length, height — through the other part by default — and an optional margin at each end) and matching slots, with clearance all round, are cut through the other part. Both flat patterns and DXFs get them, so the parts locate each other for welding.

## 2026-10-14 11:13 — Sketched Bend, Jog, Cross Break and gauge tables
- New Sketched Bend (Sheet Metal tab): draw lines on the top or bottom face of a flat part of the sheet and it is bent along each one (angle, radius, bend centred on the line or starting / ending at it, fold direction, which side stays put). The flat pattern stays the plate it was.
- New Jog: one line, two opposite bends that step the sheet over by a height, measured face to face, outside to outside or inside to inside; it says when the height is too small for the bends.
- New Cross Break: click flat faces to mark an X of shallow stiffening folds; it shows in Flatten, the DXF (new Forming marks layer, with a note) and flat pattern drawings.
- Gauge tables: Base Flange, Sheet Metal Extrude and Transition have a Gauge list (mild steel, steel gauges, stainless 304, aluminium 5052 and 6061-T6) that sets thickness, inside radius and K-factor; Save… keeps your own values as a gauge.

## 2026-10-14 10:32 — Customisable toolbars
- Toolbar buttons can be dragged to a new place: the other buttons slide aside to make room, and the new order is kept.
- Your own toolbars: the + after the toolbar tabs (or right-click a tab ▸ New Toolbar…) makes one with a name of your choice; it shows as a tab like the others. Add any tool by dragging a button onto its tab, by right-clicking a button ▸ Add to "…", or in Customize Toolbars… (right-click any button or tab). Drag a button off your toolbar to remove it; right-click its tab to rename or delete it.
- Right-click a button on a built-in toolbar to hide it or add a separator after it; Customize Toolbars… shows hidden buttons again, and Reset puts a toolbar back as it was.
- The layout is kept by RazorCAD between sessions (prefs.json in its data folder).

## 2026-10-14 10:26 — Spline sketch tool
- New Spline tool (Sketch tab, key N): click the points the curve runs through — they snap to other points like the line tool — then double-click, Enter or Esc to finish, or click the first point again to close it into a loop. The curve runs smoothly through every point; drag a point to reshape it, or drag the curve to move it all. Deleting a point takes it out of the spline.
- Splines make profiles on their own (closed) or with lines and arcs, and are exact curves in the model: extrude, revolve, cut, loft profiles and sweep paths. Lines can be trimmed where they cross a spline; mirror works. Not yet: offsetting a spline (also thin-wall features from one) and trimming the spline itself.

## 2026-10-14 08:44 — Convert to Solid and Repair Mesh
- New Convert to Solid (Surfaces tab, Insert ▸ Surface, right-click a surface body): surface bodies that together enclose a volume — or an STL mesh — are joined (edges closer than the gap tolerance meet) and made into one solid. When they leave gaps it says how many open edges and holes there are.
- New Repair Mesh (same places): closes the holes of a surface body or STL with missing pieces — flat holes with one flat face, curved holes with a filling surface, holes in a mesh with triangles — turns any triangles that face the wrong way round, and makes a solid. Option: the largest hole to close.
- STL import: a mesh that is not closed now comes in as a surface body (with a note saying how many open edges it has) instead of a broken solid; the same triangle listed twice is ignored. Large meshes import faster.

## 2026-10-14 08:15 — Bend / forming lines on formed transitions and lofted bends
- Formed (rolled) transitions and lofted bends now have forming lines in the flat pattern, Flatten and DXF (bend layers, with UP / DOWN, angle and radius notes): each curved corner (cone) is split into the set number of lines (Transition: "Forming lines per corner" / "round the whole part"; Lofted Bend: "Forming lines along the profiles"), each line carrying the angle formed along its stretch; sharp corners (e.g. a rectangle-to-square frustum) are lines of their own. Bent parts keep one bend line per fold.
- The bend radius used in the line notes can now be set for formed parts too.

## 2026-10-13 23:27 — Transitions / lofted bends: square cut edges at the corners
- The other side of a transition or bent lofted bend is now each facet moved a thickness square to itself, so every cut edge is square to the sheet; where facets fold, the outside of the fold is a narrow strip, and at the bottom corners the cut edges of the two sides join round the end of the fold (as a real folded part looks), instead of meeting at one mitred point.
- A transition's flat side is one face again (it was drawn split in two along the line where a seam can go).

## 2026-10-13 23:15 — Sheet Metal Extrude and 3D Sketch
- New Sheet Metal Extrude (Sheet Metal tab): extrudes an open sketch of lines and arcs into a sheet metal part. Arcs drawn in the sketch are bends of their own radius; sharp corners get a bend of the radius set in the panel (inside radius). Material on one side, the other side or both sides of the sketch; depth one way, reversed or mid-plane. A circle on its own is rolled into a cylinder, leaving the seam gap. Flanges, hems, Flatten and DXF work on it.
- New 3D Sketch (Sketch tab and Insert menu): points anywhere in space, typed as X / Y / Z, added a step along an axis from the last point, or clicked on model vertices; joined by straight runs with rounded corners (bend radius) for pipe, duct and wiring routes, or by a smooth spline; optional closed loop. Sweep uses it as a path (with a circular profile, or a sketch profile at its start).
- Hem: a teardrop hem has its own angle (default 225°).

## 2026-10-13 23:05 — Sheet metal Transition / Reducer and Hem
- New Transition / Reducer (Sheet Metal tab): cones / concentric and eccentric reducers, square-, rectangle-, triangle-, pentagon- and hexagon-to-round transitions (either way up) and polygon frustums. Sizes, offset and rotation are set in the panel; a sketch line (bottom centre to top centre) places the part and sets its height — change the line and the part follows. Started with no sketch, it asks for a plane and opens the line tool.
- Made from a number of equal parts, each a sheet metal body with its own flat pattern: a cone from one part or more, a flat-sided transition from two or more (seams at the middle of the flat sides or at the corners). Sizes can be inside, outside or mean; formed (rolled) or bent (bump formed with a set number of bends).
- New Hem (Sheet Metal tab): closed, open (gap), teardrop and rolled hems on straight edges, inside or outside the edge; hems meeting at a corner are mitred.
- Lofted bends: the other side of the sheet keeps an even thickness at sharp corners (least-squares mitre).
- Flatten no longer shows a feature selected in the tree on top of the flat pattern.

## 2026-10-13 22:43 — Sheet metal Lofted Bend
- New Lofted Bend (Sheet Metal tab): a sheet metal part between two open profile sketches (each one chain of lines / arcs), e.g. a round-to-square transition, hopper or duct piece. Points are matched along both profiles by length, with every corner of either profile kept.
- Manufacturing method: Bent — flat facets folded along straight lines, each fold a bend line (angle, up / down) in the flat pattern and DXF; the number of divisions is set. Formed — a smooth sheet (rolled / pressed).
- The flat pattern of both is developed by triangulation at the neutral layer (K-factor) and works with Flatten, DXF export and flat pattern drawings; thickness side can be flipped.
- Edge flanges, corner reliefs and closed corners are refused on a lofted bend (its shape comes from the profiles); a cut on it is made on the body only.

## 2026-10-13 22:25 — Airfoil sketch generator (NACA and Clark Y)
- New Airfoil tool (Sketch tab): select a line and click Airfoil (or click Airfoil, then the line). The line becomes the chord (a construction line, leading edge at its start) and an airfoil is drawn on it. It follows the line: drag its ends or dimension it (or set "Chord length" in the panel) and the airfoil scales.
- Library: 28 NACA 4-digit sections (0006–6412), 10 NACA 5-digit sections (21012–25012, reflexed 23112) and Clark Y (11.7 %, 8, 10, 14 %). Or type a NACA code (e.g. 4415, 23012).
- Custom shapes by the NACA convention: 4-digit (max camber, its position, thickness), 5-digit (design lift coefficient, camber position, reflexed camber line, thickness), Clark Y thickness; decimals allowed.
- Options: sharp or blunt trailing edge, camber to the other side, leading edge at the other end. Extrudes as a smooth closed profile (follows the exact NACA shape to within 0.002 % of the chord).

## 2026-10-13 21:56 — Quick dimension readout of edges, sketch entities and faces
- Clicking an edge shows a small tag in the model view: its length, or R and length for an arc, Ø and circumference for a circle. Ctrl+click adds (or removes) more edges: the tag gives their total length, or the perimeter when they go all the way round.
- Sketch entities shown in the model view can be clicked outside the sketch the same way (picked ones turn orange), with the same total.
- Faces and surfaces: one face shows its area (and Ø when round); Ctrl+click a second face: "Parallel · 12 mm apart", "Perpendicular · 90°" or "Angle 45°"; two round faces give their centre distance; three or more faces their total area.
- Fixed: measuring a conical face (e.g. a countersink) failed with a kernel error.

## 2026-10-13 21:37 — Convert to Sheet Metal: self-intersection trim; thickness side for surfaces
- Rolled sheets that would run into themselves (e.g. the two sides of a blade meeting at the trailing edge) are trimmed back at one end, whichever needs the least, leaving a small clearance. Option "Trim where the sheet would run into itself" (on by default); with it off the feature note warns instead.
- Surfaces get a Thickness choice: behind the surface, in front of it, or both sides (symmetric), for curved and flat-faced surfaces.

## 2026-10-13 21:19 — Convert curved surfaces to sheet metal (rolled sheets)
- Convert to Sheet Metal now accepts a curved surface that is curved one way only (a cylinder, or a profile swept straight, e.g. a fan blade copied with Copy Surface). Its section is followed by smoothly joined arcs (and straight runs), each arc a bend of its own radius, so the sheet is rolled from a flat blank whose outline is the surface's own outline unrolled.
- New "Arc fit tolerance" (default 0.05 mm): how closely the rolled sheet follows the surface; smaller gives more, shorter bends.
- Sheet metal parts can now be all bends (no flat panel).
- The convert panel accepts curved faces; clicking a face records which body was clicked, so a copied surface lying on its (hidden) solid is picked, not the solid.
- Flat patterns with many bends are built about 3× faster.

## 2026-10-13 20:56 — Copy Surface
- New feature (Surfaces tab ▸ Copy Surface, or Insert ▸ Surface ▸ Copy…): click faces of any bodies (solid or surface, flat or curved) to copy them as surface bodies; the bodies themselves are not changed.
- Option "Join copies that touch into one surface body" (on by default); off: one surface body per face.

## 2026-10-13 20:48 — Changelog started
- This file. Earlier entries reconstructed from the development log (request and build times).

## 2026-10-13 20:41 — Convert to Sheet Metal: detected thickness and radii, with overrides
- Picking a face of a solid reads its thickness and bend radii and shows them in the panel ("Found in the body: thickness 3 mm · bend radii R300, R227, R13").
- "Use the body's thickness" and "Use the body's bend radii" are on by default; untick either to enter your own value (pre-filled with the detected one). A thickness set keeps the picked side in place; a radius set applies to every bend.
- The bend-radius field only appears when it is used (radius override, sharp edges, or a surface).
- The feature note says where each value came from (from the body / set / sharp edges).

## 2026-10-13 20:26 — Kernel crash on large assemblies fixed; Open loads STEP/STL as a new part
- Fixed: after converting a body in a large imported assembly the geometry kernel ran out of memory and restarted (crash reports 2026-10-13 08:20). Highlighting a feature's faces now only checks the faces that feature changed, and frees its memory.
- A kernel crash now writes one crash report instead of one per waiting request.
- File ▸ Open (and Open… in the start window) opens a STEP or STL file as its own part in a new tab, named after the file, without asking. Insert ▸ Import still offers new part / insert / insert with mates.

## 2026-10-13 20:21 — File ▸ Open fixed
- Fixed: File ▸ Open and the start window's Open… showed "… is not a valid file filter" instead of the file browser.

## 2026-10-13 08:37 — Convert to Sheet Metal rewritten for real sheet metal bodies
- Works on bodies modelled as sheet metal (e.g. STEP exports): follows the whole sheet from the picked face through its flat faces and bends.
- Bends keep their own radius and angle; bends that run straight into each other (rolled shapes such as a fan scroll) are supported.
- Bend faces are unrolled from their real outline (cut-outs kept); holes stay true circles and arcs in the flat pattern and DXF.
- Sharp-cornered bodies (e.g. a shelled box) still convert, with sharp edges bent at the set radius.
- Warns in the feature note when the sheet's volume differs from the body's by more than 0.5 % (body isn't really sheet metal).

## 2026-10-13 07:42 — Flat pattern matches the folded part at closed corners
- The flat pattern now includes each bend's run-on into a closed corner, the relief and the corner round, so a laser-cut blank folds to the modelled part (DXF, drawing flat views, Flatten, flat area, cut length all follow).
- The V lines of a corner can no longer make the bends collide when folded.
- No more zero-size "holes" in the flat outline (no extra pierces).

## 2026-10-13 07:28 — Closed corners: smooth teardrop relief; smoother curved edges
- V-cutout closed corners: each bend's edge is set back by a small relief near the corner point that fades into the V line, joined by one small round at the corner: one smooth teardrop opening, no sharp corners or self-intersection (replaces the 07:01 round relief and 07:14 slot).
- Overlap and underlap corners are exact mirror images.
- Curved model edges are drawn with more points, so small curves don't look kinked when zoomed in.

## 2026-10-13 07:14 — Closed corners: straight slot at the corner point (superseded 07:28)

## 2026-10-13 07:01 — Closed corners: small round relief at the corner point (superseded 07:28)

## 2026-10-13 06:55 — Drawing crash fixed
- Fixed: clicking a projected drawing view opened its panel with an error (crash report 2026-10-13 06:52).

## 2026-10-13 06:51 — Drawing views: change after placing, view panel, rotate
- Clicking a drawing view opens its panel; its orientation can be changed after placing, including to / from Flat Pattern.
- Rotate View: −90°, +90°, 180°, 0° buttons and an angle box; section lines, detail circles and annotations rotate with the view.

## 2026-10-13 06:44 — Model View panel layout fixed
- Fixed: the Flat Pattern button overlapped the orientation buttons in the Model View panel.

## 2026-10-13 06:40 — Closed corners: V line runs straight to the start of each bend
- Removed the small notch and hooks at the corner point; the two bends never overlap.

## 2026-10-13 06:34 — Closed corners: self-intersection near the corner point reduced

## 2026-10-13 06:30 — Claude tab
- New Claude tab in the Command ribbon (after Evaluate): Ask Claude, New Conversation, Claude Settings.

## 2026-10-13 06:18 — Identical bodies grouped with a count
- Identical bodies are listed once with ×N in Solid Bodies and Sheet Metal Bodies (expand to see each). DXF quantity follows the count; Export All DXF writes one file per group.

## 2026-10-13 06:14 — Sheet metal: flat pattern side, right-click flat pattern, cut length
- Body property "Flat pattern seen from" (top / bottom face): DXF, bend lines and notes, Flatten and drawing views follow it.
- Right-click a sheet metal body in the model view ▸ View Flat Pattern / Export Flat Pattern as DXF.
- Cut length (outline + holes) and number of pierces for laser cutting estimates: Body Properties, DXF part info, flat pattern drawing views.

## 2026-10-13 06:09 — Flat pattern drawing views
- Drawings can show a sheet metal body's flat pattern with bend lines and notes (UP/DOWN, angle, radius), flat size, thickness and bend count; dimensionable and exportable to PDF.

## 2026-10-12 22:58 — Drawings
- New drawing documents (.rdrw): File ▸ New Drawing, File ▸ Make Drawing from Part, New Drawing in the start window.
- Default A3 template (ISO frame and title block); sheet sizes A0–A4.
- Views: model views, standard 3 view, projected, section and detail views (hidden-line projection).
- Annotations: smart dimensions, notes, center marks, centerlines. Views and dimensions follow changes to the part.
- Multiple sheets, sheet and drawing properties, undo / redo, vector PDF export.

## 2026-10-12 22:32 — Closed corner "Bend region": V cutout
- Default V cutout: each bend runs on into the corner as formed from the flat, leaving a lens-shaped opening; "Closed" keeps the bends meeting on the diagonal. Also in Edge Flange ▸ Corners.

## 2026-10-12 21:53 — Closed corners: outside seam runs straight down through the bend

## 2026-10-12 21:45 — Closed corners: fixed an opening at the bend corner (R = thickness) and butt corners losing walls

## 2026-10-12 21:39 — Closed corners no longer twist at the bends (bends meet on the mitre)

## 2026-10-12 21:32 — Closed Corner: corner type and corner picking
- Corner type Overlap / Underlap / Butt; pick which corners to close by clicking a flange face (the adjacent flange is found automatically).

## 2026-10-12 21:23 — Edge Flange: corner gap
- Edge Flange ▸ Corners: flanges meeting at a corner are closed with a gap you set, or left open.

## 2026-10-12 21:21 — Closed Corner also closes the bend (radiused) corner

## 2026-10-12 21:09 — Model with Claude
- Ask Claude panel in RazorCAD (your own Anthropic API key): describe a part or a change and Claude adds the features.
- RazorCAD Part Builder page on claude.ai: describe a part and download it as a .rcad.

## 2026-10-12 20:56 — Sheet metal (Change request 4)
- Sheet Metal tab: Base Flange, Edge Flange, Corner Relief, Closed Corner, Unbend / Bend, Flatten, Convert to Sheet Metal.
- Sheet Metal Bodies folder, sheet metal properties (thickness, bends, flat size, mass, quantity).
- Flat pattern with K-factor; DXF export (single and bulk) with bend lines, notes, layer colours and a preview window.

## 2026-10-12 08:26 — Sketch view no longer flips on each edit; Flip Side button

## 2026-10-12 07:55 — Gears: setting teeth or a ratio adjusts the centre-line lengths

## 2026-10-12 07:44 — Gears validated; gear numbers; Tab hides the body under the cursor
- Gear trains must be valid (exact mesh distance, no overlaps, at least 6 teeth); broken trains show red with "Fit gears to the lines".
- Gear numbers shown on the gears in the sketch.
- Tab hides the body under the cursor; Shift+Tab shows a hidden body under the cursor.

## 2026-10-12 07:12 — Gears button works from anywhere; Gear Train panel crash fixed

## 2026-10-12 06:56 — Threads run all the way to the ends (no hard stop at a bore's mouth)

## 2026-10-12 02:05 — Threads stay within their face; body transparency
- Thread cuts / extrudes no longer protrude past the ends of the face.
- Right-click a body ▸ Make Transparent / Make Opaque.

## 2026-10-11 23:15 — Tree hover highlight no longer sticks in the view

## 2026-10-11 22:50 — Gear tool (Change request 3)
- Involute gear trains on centre lines: module, pressure angle, teeth / ratios, backlash and clearance, bores; extrude to one body per gear.

## 2026-10-11 22:43 — Change request 2
- Shortcut badges on tool buttons; Swept Boss/Cut; Lofted Boss/Cut; Helix; Thread Cut / Thread Extrude; full-round fillets where two blends meet; convert / offset entities from a section of the model; Text tool; Wrap (emboss / deboss) onto curved faces.

## 2026-10-11 21:42 — Sketch references to body edges and vertices without converting them

## 2026-10-11 21:30 — Faster feature previews (e.g. fillets)

## 2026-10-11 21:16 — Opening a recent part: the window closes at once, no duplicate tabs

## 2026-10-11 21:07 — Feature tree reference arrows point the right way

## 2026-10-11 21:01 — Change request 1
- Rollback bar, drag to reorder features, reference arrows; thin extrude; Delete Body; Subtract Bodies; chamfer options; cut scope; sketch orientation, mirror, fillet, chamfer, intersection curve; part tabs; STEP/STL insert with mates; body folders; Measure; hide / isolate bodies; visibility filters; Knit to solid; Delete / Move surfaces; reference axis from a cylinder.

## 2026-10-11 20:17 — Crash fixed: all bodies disappearing and the feature tree failing

## 2026-10-11 16:04 — Redundant files cleaned out of the project folder

## 2026-10-11 13:03 — Shift+right-click cycling: release Shift and click to select; Shift+left-click cycles back

## 2026-10-11 12:49 — Installer (RazorCAD-Setup.exe) for testers

## 2026-10-11 12:41 — Selected cuts are highlighted through the body (see-through preview)

## 2026-10-11 12:37 — Shell works on filleted bodies when the shell is thicker than the fillet; hovering tree features highlights them

## 2026-10-11 12:18 — Crash reports written to a folder for inspection

## 2026-10-11 12:11 — Start window, auto-save, progress bar, body cycling
- Start window on launch (recent files, new part) instead of reopening the last part.
- Auto-save only after the first save, to a separate file next to the part (recoverable after a crash).
- Progress bar for long operations (opening, STEP import); multi-body STEP bodies separate; Shift+right-click cycles through bodies / surfaces under the cursor.

## 2026-10-11 12:09 — Shell, offset, arc dimensions, surfaces, combine / split, move body, dotted construction lines
- Shell; offset sketch entities (including linked offsets from model edges); dimensions between arcs (min / max / centre); surface modelling; merge and split bodies; Move/Copy Body by coordinates or mates; construction lines drawn dotted; cut preview fixed.

## 2026-10-11 08:02 — Cylinders and their fillets / chamfers are one continuous face (no seams)

## 2026-10-11 07:39 — Selection filters, materials, Solid Bodies folder, body properties, export body as STEP

## 2026-10-11 07:20 — Sketch tool wheel (hold the middle mouse button); export a face as DXF

## 2026-10-11 07:05 — More reference plane options (at an angle to a face through an edge, mid-plane between faces)

## 2026-10-11 06:56 — Reference axes and points; extrude / cut up to references; coloured feature previews; fillet fixes

## 2026-10-11 06:09 — Fillet at a corner between other fillets fixed; CAD-style rotation

## 2026-10-11 01:13 — Project entities from other sketches; dimensions to model references; fillet / chamfer; STEP / STL import and export

## 2026-10-11 00:31 — Desktop executable; sketch relations; trim tool
- RazorCAD runs as its own Windows program instead of in a browser.
- Sketch relations (horizontal, vertical, coincident, midpoint, symmetric, …) and a trim tool.

## 2026-10-10 18:24 — Project started
- A parametric CAD program with a simple feature-tree interface.
