---
title: RazorCAD User Manual
subtitle: Parametric part modelling, sheet metal and drawings
---

# Introduction

## What RazorCAD is

RazorCAD is a parametric part modeller for Windows with a classic feature-tree interface. You build a part as a **feature history**: sketches, extrudes, revolves, cuts, fillets, patterns and so on, each of which can be edited later. Changing a dimension or an equation rebuilds every feature after it. {idx:parametric modelling}

Solid modelling runs on the **OpenCascade** B-rep kernel (the engine behind FreeCAD), through the replicad library. Display uses three.js. RazorCAD runs fully offline. {idx:OpenCascade}

Main capabilities:

- Constraint-driven 2D sketches with relations, Smart Dimensions and equations
- Solid features: extrude, revolve, sweep, loft, helix, threads, wrap, patterns, mirror, fillet, chamfer, shell
- Multi-body parts with combine, subtract, split, move/copy and per-body materials
- Surface modelling: extruded, revolved, planar, offset, knit and thicken
- Sheet metal: base and edge flanges, corner reliefs, closed corners, unbend/bend, flat patterns and DXF export
- 2D drawings with projected, section, detail and flat pattern views, dimensions and PDF export
- STEP and STL import and export, DXF export of faces and flat patterns
- An **Ask Claude** panel that builds features from a plain-language description

## About this manual

This manual describes RazorCAD as it is in the version shown on the cover. It is checked against the software every day and updated when features change; Appendix C lists what changed in each revision.

The **Contents** and the **Index** are clickable. The footer of every page has a **Back to Contents** link. Your PDF viewer's bookmarks pane shows the same outline.

## Conventions

| Convention | Meaning |
|---|---|
| **File ▸ Save** | A menu command: the File menu, then Save |
| [[Ctrl+S]] | A key or key combination |
| **Property panel** | The panel on the left that holds a feature's settings while you edit it |
| **Feature tree** | The feature history list on the left |
| **Command ribbon** | The tabbed toolbar across the top (Features, Sketch, Surfaces …) |
| `width/2` | Text you type, such as a value or an equation |

> Note: RazorCAD works in **millimetres**. Angles are in **degrees**.

# Installing and Starting RazorCAD

## Running RazorCAD

Double-click **RazorCAD.exe**. It is one standalone program: it needs no browser, Python or installation, and it runs offline. It uses the Microsoft Edge WebView2 runtime, which comes with Windows 10 and 11. {idx:RazorCAD.exe}

## Installing with the setup program

Testers can be given **RazorCAD-Setup.exe**, a single setup program with RazorCAD inside it. {idx:installer}

- Install for the current user (`%LOCALAPPDATA%\Programs\RazorCAD`, no administrator rights), for all users (Program Files), or into a folder you choose.
- Setup installs the Microsoft Edge WebView2 Runtime and .NET Framework 4.8 from Microsoft if they are missing.
- It creates Start-menu and desktop shortcuts and registers RazorCAD under Windows **Installed apps** with an uninstaller.
- The uninstaller asks before removing settings and crash reports. Part files are never touched.
- Running setup again updates an existing installation.

Silent install and uninstall:

| Command | Effect |
|---|---|
| `RazorCAD-Setup.exe /S` | Silent install for the current user |
| `/D=folder` | Install into this folder |
| `/ALLUSERS` | Install for all users |
| `/NODESKTOP`, `/NOSTARTMENU` | Skip the desktop or Start-menu shortcut |
| `uninstall.exe /S` | Silent uninstall |

## The start window

At launch RazorCAD shows a start window with: {idx:start window}

- **New Part** and **New Drawing**
- **Open…**
- **Sample Part**, a ready-made part to explore
- **Recent Parts**: name, folder and date. Missing files are greyed out and can be removed with ✕. Parts that have an auto-save waiting are marked.
- **Recover Previous Session**, offered once when unsaved work from an earlier version is found
- A notice when new crash reports have been written

Reopen it any time with **File ▸ Recent Parts / Start…**.

## The RazorCAD window

| Area | What it does |
|---|---|
| **Menu bar** | File, Edit, View, Insert, Tools, Help. Next to the menus are quick buttons for **Save**, **Save As** and **Rebuild**. |
| **Document tabs** | Each open part or drawing has its own tab. ✕ closes a tab and asks to save. |
| **Command ribbon** | Tabs of tool buttons: **Features**, **Sketch**, **Surfaces**, **Sheet Metal**, **Evaluate** and **Claude**. Buttons with a shortcut show the key in their bottom-right corner. |
| **Feature tree** | The part's history, with folders for Solid Bodies, Sheet Metal Bodies and Surface Bodies, the material, the planes and every feature |
| **Property panel** | Opens in place of the tree while you create or edit a feature. ✔ accepts ([[Enter]]), ✕ cancels ([[Esc]]). |
| **Heads-up toolbar** | Above the 3D view: view orientation, display style, selection filters, visibility (eye button) and section view |
| **Confirm corner** | The top-right corner of the view holds ✔ / ✕ for the active feature or sketch |
| **Status line and progress bar** | Bottom left. Long operations (opening, rebuilding, importing, meshing, exporting) show progress here. |

{idx:Command ribbon}{idx:Feature tree}{idx:Property panel}{idx:heads-up toolbar}

# Working with Files

## Part files

Parts are saved as **.rcad** files, assemblies as **.rasm** and drawings as **.rdrw** files (see the Drawings chapter). {idx:.rcad}

| Command | Shortcut | Notes |
|---|---|---|
| **File ▸ New Part** | [[Ctrl+N]] | Opens in a new tab |
| **File ▸ Open…** | [[Ctrl+O]] | Opens parts, drawings, STEP and STL files |
| **File ▸ Open Sample Part** | | The built-in sample, in a new tab |
| **File ▸ Save** | [[Ctrl+S]] | Uses the normal Windows save dialog the first time |
| **File ▸ Save As…** | [[Ctrl+Shift+S]] | Saves a copy under a new name |

## Tabs and closing

Several parts and drawings can be open at once, each in its own tab. New, Open and Sample all open a new tab. Closing a tab with unsaved changes asks whether to save it, and closing RazorCAD asks to save every unsaved part. {idx:tabs}

## Auto-save and recovery

Auto-save starts once a part has been saved for the first time. While the part has unsaved changes it is written next to the part file, at most every 20 seconds, as `Name.autosave.rcad`. The title bar shows the time of the last auto-save. Saving the part removes the auto-save file. {idx:auto-save}{idx:recovery}

If RazorCAD closes with unsaved changes, opening the part again offers to **recover** the auto-saved version. It is also marked in the recent list.

> Warning: A part that was never saved is not auto-saved. RazorCAD warns before closing it. Save new parts early.

The recent-files list is kept in `%APPDATA%\RazorCAD\recent.json`.

## Importing STEP and STL

There are two ways to bring in a STEP or STL file: {idx:STEP, import}{idx:STL, import}

- **File ▸ Open…** opens it as a part of its own in a new tab, named after the file, without asking. A STEP file that holds an assembly asks first: {idx:STEP, assembly}
  - **Open as an Assembly** makes a new assembly with the file's structure: a sub-assembly for each of its sub-assemblies, a part for each part, and a component, fixed, where the file places each one. Each part keeps its own piece of the STEP file and is built on its own, and a part used several times is built once. {idx:sub-assembly, from STEP}
  - The first build of each part is kept on disk (in `%LOCALAPPDATA%\RazorCAD\modelcache`, up to 1 GB, shared with parts). The next time the assembly opens, unchanged parts are shown straight from there instead of being rebuilt, so a big assembly reopens in seconds. {idx:assembly, opening quickly}
  - **Open as One Part** brings every solid into one part, as before.
- **File ▸ Import STEP / STL…** ([[Ctrl+I]], also on the Features and Evaluate tabs) offers three choices: a **new part**, **insert in place** into the current part, or **insert and locate with mates**. Locating with mates adds a separate "Locate …" Move Body feature under the import.

How imports behave:

- The file's contents are stored inside the part file, so the part does not depend on the original file.
- A STEP file's appearances come with it: the colour of each solid and of single faces, and transparency. Your own Appearance and Make Transparent / Make Opaque settings on a body win over them. {idx:appearance, imported}
- STEP imports as an exact solid. Every solid becomes its own body; a solid made of several separate shells is split into one body per shell; loose surfaces become surface bodies.
- The bodies of a multi-body STEP file are grouped in their own folder under Solid Bodies.
- Tick **Merge touching bodies into one body** in the import feature to fuse them instead.
- An STL is converted to a solid made of its triangles. Coplanar triangles are merged. Meshes up to 200,000 triangles are accepted.
- Imported bodies can be cut, extended, patterned and (for STEP) filleted like any other body.

## Sub-assemblies

An assembly can hold other assemblies as components. **Insert Components ▸ Browse for a Part or Assembly…** takes a .rasm file, and STEP assemblies keep their sub-assemblies when they open as an assembly. {idx:sub-assembly}

- A sub-assembly is kept whole, with its own parts, placements and configurations, and moves as one. Clicking any of its parts picks it.
- Mates can use the faces, edges and vertices of the parts inside it.
- In the tree, ▶ opens a sub-assembly to show its components. Double-click one, or right-click the sub-assembly ▸ **Open Sub-assembly**, to change it in its own tab; the changes come back to the assembly.
- The **Bill of Materials** is indented: a sub-assembly's parts are listed under it (1.1, 1.2…), with the quantities in one of it.

## Exporting

| Command | Result |
|---|---|
| **File ▸ Export ▸ STEP…** | An exact B-rep. Each body is written as its own named, coloured solid. |
| **File ▸ Export ▸ STL…** | A binary mesh |
| Right-click a body ▸ **Export Body as STEP…** | One body only |
| **File ▸ Export ▸ Face as DXF…** | The outline of a flat face (see below) |
| Sheet metal ▸ **Export DXF** | Flat patterns (see the Sheet Metal chapter) |
| Drawing ▸ **Export PDF** | Drawing sheets (see the Drawings chapter) |

{idx:STEP, export}{idx:STL, export}

### Export Face as DXF

Click a flat face, then right-click ▸ **Export Face as DXF…** (or **File ▸ Export ▸ Face as DXF…**). The face's outline (layer `OUTLINE`) and holes (layer `HOLES`) are written as a 2D drawing in millimetres, seen from outside the part. Use it for laser or waterjet cutting, or to take a profile into a 2D CAD program. {idx:DXF, face export}

Lines, arcs and circles are exact; other curves become fine polylines. The file is DXF R12, which practically every program can read.

# Navigating the 3D View

## Mouse and keyboard

| Action | Mouse / keys |
|---|---|
| Rotate (free, about the model centre) | Middle-drag, or left-drag on the model outside a sketch |
| Pan | [[Ctrl]] + middle-drag, or right-drag |
| Zoom | Mouse wheel (toward the cursor), or [[Shift]] + middle-drag |
| Roll | [[Alt]] + middle-drag, or [[Alt]] + ← / → |
| Rotate in steps | Arrow keys 15°, [[Shift]] + arrows 90° |
| Pan in steps | [[Ctrl]] + arrow keys |
| Zoom to fit | [[F]] |
| Standard views | [[Ctrl+1]] … [[Ctrl+7]] |
| Normal To | [[Ctrl+8]] (press again to flip to the back side) |

{idx:rotate view}{idx:pan}{idx:zoom}

## Standard views

**View** menu: Front ([[Ctrl+1]]), Back ([[Ctrl+2]]), Left ([[Ctrl+3]]), Right ([[Ctrl+4]]), Top ([[Ctrl+5]]), Bottom ([[Ctrl+6]]), Isometric ([[Ctrl+7]]) and Trimetric. **Normal To** ([[Ctrl+8]]) looks straight at the selected face or plane. {idx:standard views}{idx:Normal To}

## Display styles

**View** menu or the heads-up toolbar: **Shaded With Edges**, **Shaded**, **Hidden Lines Removed** and **Wireframe**. {idx:display styles}

## Visibility

- **View ▸ Show / Hide Planes** toggles the standard planes.
- The **eye button** on the heads-up toolbar (or **View ▸ Visibility…**) filters what is shown: sketches, axes, planes, points and surfaces, with select-all and deselect-all. {idx:visibility}
- Right-click a body (tree or view) ▸ **Hide**. [[Tab]] hides the body under the cursor; [[Shift+Tab]] shows the hidden body under the cursor.
- **View ▸ Show Hidden Bodies** shows hidden bodies so you can click them to show them again. Choose **Done Showing Hidden Bodies** to finish.
- Right-click a body ▸ **Isolate** hides everything else. The isolated body can still be edited. **View ▸ Exit Isolate** returns. {idx:isolate}
- Right-click a body, or any feature that made or changed it, ▸ **Make Transparent / Make Opaque**. Transparency is saved with the part and can be undone. {idx:transparency}

## Section view

**Tools ▸ Section View…** (or the Evaluate tab) cuts the model open on a plane so you can see inside. Choose the plane, an offset (equations are allowed) and flip the side kept. Cut faces are capped. Close the Property panel to remove the section. Section View can't be used inside a sketch. {idx:section view}

# Selecting

## Selecting in the part

A click selects what is under the cursor, in this order: a **vertex**, then an **edge**, then a **face**, then a **plane**. [[Ctrl]]+click adds to the selection. {idx:selection}

## Selection filters

The filter buttons on the heads-up toolbar limit what can be picked. Several filters can be on at once, and they also apply while picking references for features. {idx:selection filters}

| Filter | Key | Picks |
|---|---|---|
| Faces | [[X]] | Model faces |
| Edges | [[E]] | Model edges |
| Vertices | [[V]] | Corners (edge end points) |
| Solid Bodies | [[B]] | Whole bodies (a click on any face picks its body) |
| Planes | | Standard and reference planes |
| Clear filters | [[F5]] | Back to picking anything |

## Highlighting from the tree

Hovering a feature in the Feature tree highlights what it made in orange: the faces of a boss, cut, fillet, chamfer, shell, pattern or moved body; a sketch's curves; a plane, axis or point; a surface feature's surfaces. Clicking it keeps the highlight in blue while it is selected. {idx:highlight}

## Selecting hidden bodies

Hold [[Shift]] and **right-click** to step through the bodies and surfaces under the cursor, front to back; [[Shift]] + left-click steps back. The current one is shown in orange, through whatever is in front of it. Release [[Shift]] and **left-click** on the same spot to select it. [[Esc]] or a click elsewhere cancels. {idx:hidden bodies, selecting}

- With only the face filter on, or while a Property panel asks for faces (Shell, Offset Surface), it steps through faces instead.
- While a Property panel asks for bodies (Combine, Split, Move/Copy, Knit, Thicken), the click adds the body.

## Right-click menus

| Right-click on | Offers |
|---|---|
| A face | Sketch, Normal To, Export Face as DXF, Fillet, Chamfer |
| An edge | Fillet, Chamfer (started with that edge), Reference Axis |
| A vertex | Reference Point |
| A face, edge or body | Body Properties, Export Body as STEP, Hide, Isolate, Make Transparent, folder commands |
| A sheet metal body | View Flat Pattern, Export Flat Pattern as DXF |
| Empty space | Show Hidden Bodies, Measure and view commands |

{idx:context menus}

# Sketching

## Starting and ending a sketch

Click a plane or a flat face, then click **Sketch** (Sketch tab), or right-click a face ▸ **Sketch**. You can also start a feature such as Extrude without a sketch: RazorCAD asks you to pick a plane or face, you sketch, and when you exit the sketch the feature continues. If the profile is open you can keep editing or abort and keep the sketch. {idx:sketch, start}

- [[Esc]] ends the active sketch tool first; pressing it again closes the sketch and keeps it.
- [[Enter]] does **not** leave the sketch.
- The ✔ in the confirm corner, or **Exit Sketch**, closes the sketch.
- [[Ctrl+Z]] / [[Ctrl+Y]] undo and redo inside the sketch.

## The sketch tool wheel

While sketching, press and hold the middle mouse button without moving it. After a moment a wheel of sketch tools appears around the pointer. Keep the button held, move toward a tool (it highlights) and release to activate it. Releasing in the centre or pressing [[Esc]] cancels. Moving the mouse right away still rotates the view. {idx:tool wheel}

## Defined and under-defined sketches

Sketches are made of points, lines, arcs and circles held in place by **relations** and **dimensions**. A numerical constraint solver keeps them satisfied. {idx:fully defined}

- Geometry is **blue when under-defined** and **black when fully defined**.
- The Property panel shows the remaining degrees of freedom.
- An under-defined sketch shows **(-)** in the tree. Construction lines only need to be positioned.

## Sketch orientation

In the sketch Property panel, **Rotate 90°** turns the sketch axes about the sketch normal, and **Flip Side** looks at the sketch from the other side of the plane. Both are saved with the sketch. {idx:sketch orientation}

## Sketch tools

| Tool | Key | How it works |
|---|---|---|
| **Select** | [[S]] | Select entities, drag geometry |
| **Line** | [[L]] | Click a chain of points. Coincident, horizontal and vertical relations are added automatically; snapping to a midpoint or onto a curve adds those relations too. Double-click, [[Enter]] or [[Esc]] ends the chain. |
| **Centerline** | | Construction line for symmetry, mirroring, gears or as a revolve axis |
| **Corner Rectangle** | [[R]] | Built with horizontal and vertical relations |
| **Center Rectangle** | | Also adds construction diagonals with a midpoint relation |
| **Circle** | [[C]] | Centre, then radius |
| **Centerpoint Arc** | [[A]] | Centre, start, end; the direction follows the mouse |
| **Straight Slot** | | Built with tangent and equal relations |
| **Polygon** | [[P]] | Set the number of sides in the Property panel |
| **Smart Dimension** | [[D]] | See below |
| **Trim Entities** | [[T]] | See below |
| **Convert Entities** | [[E]] | See below |
| **Offset Entities** | [[O]] | See below |
| **Mirror Entities** | | Select the entities plus a centerline, then click Mirror Entities |
| **Text** | | See below |
| **Gears** | | See the Gears chapter |
| **Sketch Fillet / Sketch Chamfer** | | Set the radius or distance, then click corners |
| **Intersection Curve** | | Projects the outline where the sketch plane cuts the bodies |
| **Construction Geometry** | [[Q]] | Toggles the selected curves to or from construction (drawn dotted, ignored by features) |
| **Display Relations** | | Shows or hides the relation glyphs |
| **Delete** | [[Del]] | Deletes the selected entities or relations |

{idx:sketch tools}{idx:Line tool}{idx:rectangle}{idx:circle}{idx:arc}{idx:slot}{idx:polygon}{idx:construction geometry}{idx:Mirror Entities}{idx:sketch fillet}

## Smart Dimension

Click a line, circle or arc (or two entities), then click to place the dimension. {idx:Smart Dimension}

- Moving the mouse switches between horizontal, vertical and aligned.
- Two lines give an angle; a point and a line give a perpendicular distance.
- Values accept equations, such as `width/2`.
- A dimension that would over-define the sketch is added as a driven (reference) dimension.
- **Circles and arcs:** dimension from a circle or arc to another circle, arc, point or line by clicking both. The Modify box offers **Center** (centre to centre), **Min** (nearest) and **Max** (farthest). Min also measures the gap between concentric circles. Switching keeps the geometry in place and shows the new value.
- **Outside references:** you can also click model edges, model vertices or entities of earlier sketches. RazorCAD creates linked construction geometry and dimensions to it, so the dimension follows the model. Example: "keep this hole 25 mm from the right edge" still holds after the width changes.

## Trim Entities

Power trim: hover over a segment and it turns red; click to remove it up to the nearest intersections. Lines are shortened or split, circles become arcs, and new end points get on-curve relations. {idx:Trim Entities}

## Offset Entities

Click a line, arc or circle and its whole connected chain is offset. Move the mouse to the side and distance you want and click, then type the exact distance. Corners are re-trimmed or extended. {idx:Offset Entities}

- You can also click a **model edge** (with **Select chain**, the connected edges lying in a plane parallel to the sketch, such as a face outline) or a curve of another sketch.
- **Linked offset** (default): the offset follows its source, including model edges when the model changes, and one dimension drives the chain (relation "Offset ⇉").
- Untick it for a **single offset**: plain geometry with no link.
- While the tool is active, the faces the sketch plane cuts are highlighted and the cut outline is drawn in teal. Clicking it offsets the whole outline.

## Convert Entities

Click a model edge, or an entity of an earlier sketch, to project it into this sketch. Projected geometry is linked and updates when the source changes (relation "On Edge ⇲"). While the tool is active, the outline where the sketch plane cuts the bodies is drawn in teal; clicking it converts the whole outline. This works for solids and surfaces. {idx:Convert Entities}

## Text

Click **Text** on the Sketch tab, then click to place. The panel sets the text, font (the PC's installed fonts), height (capital-letter height), angle, bold and italic. Drag the text to move it. Text extrudes as a boss or cut; text inside an outline is cut out of it. To put text on a curved face, use **Wrap** (Features chapter). {idx:text}

## Relations

Select entities ([[Ctrl]]+click for several). The Property panel lists the relations that apply: {idx:relations}

| Selection | Relations offered |
|---|---|
| 1 line | Horizontal, Vertical, Fixed |
| 2 or more points | Coincident, Horizontal, Vertical |
| 2 or more lines | Parallel, Perpendicular, Collinear, Equal, Horizontal, Vertical |
| Point + line | Coincident (on line), Midpoint |
| Point + circle/arc | Coincident (on curve) |
| Line + circle/arc | Tangent |
| Circles/arcs | Equal, Concentric, Tangent |
| 2 points + line | Symmetric (about the line) |
| 3 lines | Symmetric (two lines about a centerline) |

Relations are shown as small green glyphs next to the geometry. Click a glyph to select it, then press [[Del]] to remove it. Hovering a glyph highlights the entities it ties together. Redundant or conflicting relations are refused with a message.

## How profiles are found

Profiles are found automatically from all non-construction geometry and sent to the kernel as exact lines, arcs and circles. Intersections are split, dangling lines are ignored and nested loops become holes. A full circle (or arcs that make one) becomes a single closed curve, so an extruded circle has one continuous cylindrical face. {idx:profiles}

## Showing and hiding sketches

Sketches absorbed by a feature are hidden by default. Right-click a sketch in the tree ▸ **Show / Hide**. {idx:sketch, show/hide}

# Gears

RazorCAD's **Gears** tool on the Sketch tab draws involute gear trains as closed profiles, ready to extrude. {idx:gears}{idx:involute gear}

## Creating a gear train

1. Draw lines between the gear centres (centerlines work well).
2. Select the lines (or a single point for one gear) and click **Gears**. If you are not in a sketch, RazorCAD opens the selected sketch (or starts one) and asks you to click the centre lines, then press [[Enter]] or **Make Gears**.
3. Each line end point becomes a gear. Neighbouring gears mesh along the line, and teeth are turned automatically so they mesh.
4. Extrude the sketch: each gear becomes its own body.

Gear numbers are shown on the gears in the sketch (view labels only, not geometry).

## The Gear Train panel

Click a gear to open it.

| Setting | Meaning |
|---|---|
| Module and pressure angle | The tooth size and shape for the whole train |
| Teeth per gear, or ratio per mesh | Setting a ratio sets the next gear's teeth. Changing teeth or a ratio changes the centre-line lengths to suit, including your own length dimensions on those lines. |
| Backlash, tip/root clearance | Tolerances for prototyping and 3D printing |
| Bore diameter | The centre hole |
| Turn | Rotates the first gear |
| Set the line lengths to the mesh distance | Adds driving dimensions so the gears mesh exactly; each mesh shows ✔ or how far off it is |

## Rules for a valid train

Centres must be exactly at the mesh distance, gears must not overlap and each gear needs at least 6 teeth. Fixed line lengths get a module and teeth that fit. Edits that would break a train are refused. A broken train is drawn red with a **Fit gears to the lines** button and can't be extruded.

# Solid Features

## Live previews

While a feature's Property panel is open, the model is rolled back to just before that feature and the feature is shown in colour: **yellow** for material it adds and **red** (seen through the body) for material it removes. Fillets and chamfers show the material they add or remove; reference geometry being edited is drawn in orange. Click ✔ (or [[Enter]]) to finish. {idx:preview}

Every value field accepts numbers or equations (see Equations in the Evaluate chapter).

## Extruded Boss/Base and Extruded Cut

Extrudes a sketch profile into a solid, or cuts it out. {idx:extrude}{idx:Extruded Cut}

End conditions:

| End condition | Meaning |
|---|---|
| Blind | A set depth |
| Mid Plane | The depth split equally on both sides of the sketch |
| Through All / Through All – Both | Through every body, in one or both directions |
| Up To Vertex | Click a model vertex or choose a reference point |
| Up To Surface | Click a flat model face or choose a plane; angled surfaces are supported and the extrusion is trimmed to the surface |
| Offset From Surface | As Up To Surface, at a set distance from it |

Options:

- **Merge result** (boss): untick to keep the new material as a separate body even where it touches. A boss that doesn't touch existing material makes a new body anyway.
- **Thin Feature**: makes a wall of the given thickness from the profile; direction one side, other side or mid-plane. Open sketches switch it on automatically. {idx:thin feature}
- **Feature Scope** (cuts): **All bodies** by default; untick it and click the bodies to cut. {idx:feature scope}

## Revolved Boss/Base and Revolved Cut

Revolves a profile about an axis: the sketch axes, any line in the sketch (such as a centerline), a reference axis, a straight model edge or a cylindrical face (click it in the view). Cuts have the same Feature Scope option as extruded cuts. {idx:revolve}

## Swept Boss/Base and Swept Cut

Sweeps a profile along a path. {idx:sweep}

- **Profile**: a sketch, or **Circular** with a diameter (useful for springs).
- **Path**: a sketch chain or a helix.
- **Thin** option.

## Lofted Boss/Base and Lofted Cut

Blends between two or more profile sketches, in order. A third or later profile shapes the middle. {idx:loft}

- A circle is split into as many equal arcs as the other profile has corners.
- Profiles with different segment counts give an error naming the sketches.
- Options: straight (ruled) sides, Thin.

## Helix

Pick a sketch with a circle; it sets the axis and diameter. Define the helix by **pitch and revolutions**, **pitch and height**, or **height and revolutions**. Options: start angle, clockwise, reverse. Use a helix as a sweep path for springs and coils. {idx:helix}

## Thread Cut and Thread Extrude

Click a bore (Thread Cut) or a shaft (Thread Extrude). {idx:threads}

- The size is chosen automatically from the diameter, or choose a **metric** (ISO) or **inch** (Unified) standard size, or custom. Coarse / UNC sizes are preferred.
- Optional pitch; **left-hand** option.
- Length: the whole face, a depth, or up to a plane or face. Threads never reach past the ends of their face.
- The bore or shaft is resized to the thread size if needed (a bore to the minor diameter, a shaft to the major). A bore that would break out of the body is refused.
- Threads run all the way to the ends: grooves run out into open air, otherwise the thread is cut off flush with the end.

## Wrap (Emboss / Deboss)

Pick a sketch (outlines and/or text) and a face, flat or curved. The sketch is projected along its normal onto the face and raised (emboss) or sunk (deboss) by the depth. {idx:wrap}{idx:emboss}

## Linear Pattern, Circular Pattern and Mirror

Copy features or bodies. Pattern directions and the circular pattern axis can be X, Y, Z or any reference axis. Mirror copies about a plane or flat face. {idx:pattern}{idx:mirror}

A pattern or mirror of a sheet metal feature that makes a body (Base-Flange, SM-Extrude, Lofted-Bend, Transition) copies that body as it is at the pattern, with the flanges and cuts added to it so far. Each copy is sheet metal with its own flat pattern. A mirrored copy's flat pattern is the mirror image, with its bends going the other way. A mirrored lofted bend becomes a plain solid. {idx:pattern, sheet metal}

## Fillet

Open the feature and click edges on the model. The model is rolled back to just before the feature so every edge can be picked; tick **Preview** to see the result. The radius accepts equations. {idx:fillet}

- Edges are remembered by type, direction and position, and found again after parameter changes.
- Where a fillet can't be added on top of earlier fillets (a corner where several blends meet), RazorCAD recomputes it together with the preceding fillets in one operation.
- Where two blends exactly meet (for example R2 on both edges of a 4 mm wall) the result is a full round.

## Chamfer

Click edges as for a fillet. Chamfer types: **equal distance**, **distance + angle** or **two distances**. **Flip direction** swaps the sides. {idx:chamfer}

## Shell

Click the faces to remove and set the wall thickness, inward or outward. Where a fillet or chamfer is smaller than the wall, the outside keeps it and the inside gets a sharp corner. {idx:shell}

# Bodies and Multi-Body Parts

## Solid bodies

A part can contain several solid bodies. A boss that doesn't touch the existing material makes a new body; untick **Merge result** to keep a touching boss separate. A cut that slices a body in two leaves two bodies. {idx:bodies}{idx:multi-body}

The **Solid Bodies (n)** folder at the top of the tree lists the bodies:

- Click a body to select and highlight it.
- Double-click (or right-click ▸ **Rename**) to name it. Unnamed bodies are named after the last feature that changed them.
- Bodies are identified by the feature that created them, so names and materials stay attached when you change dimensions.
- **Folders**: right-click ▸ **Add to New Folder** or **Move to folder** to organise bodies.
- **Identical bodies** are listed once with their count (×N). Open the item to see each body. Right-click for Isolate, Hide or Show all of them. Identical means the same volume, surface area, principal moments of inertia, handedness and material (and for sheet metal, the same thickness and flat pattern). {idx:identical bodies}

## Body Properties

Right-click a body (tree or view) ▸ **Body Properties…**. It holds the body's name, **material**, description and any number of **custom properties** (name/value pairs such as part number or finish). It also shows the body's mass, volume, area and centre of mass. For sheet metal bodies it adds the sheet data (Sheet Metal chapter). {idx:Body Properties}{idx:custom properties}

## Materials

The **Material** item in the tree sets the part material (**Tools ▸ Edit Material…**). A body set to **Use part material** follows it. A body given its own material keeps it when the part material changes and is drawn in that material's colour. Mass Properties adds up every body with its own density. The material list is in Appendix B. {idx:materials}

## Combine and Subtract Bodies

**Combine** joins bodies with **Add**, **Subtract** or **Common**; the first body clicked is the main body. **Subtract Bodies** picks a cutting body and target body; **Consume cutting body** (on by default) removes the cutting body afterwards. {idx:combine}{idx:Subtract Bodies}

## Split

Cuts bodies into separate bodies with a plane, a flat face or a surface body. With a plane or face you can keep all the pieces or just the piece on one side. {idx:split}

## Move/Copy Bodies

Moves or copies solid and surface bodies. {idx:Move/Copy Bodies}{idx:mates}

- **By coordinates**: ΔX/ΔY/ΔZ plus a rotation about X/Y/Z or a reference axis, through the axis or the bodies' centre. Copies repeat the step.
- **With mates**: Coincident, Distance, Parallel, Perpendicular, Angle and Concentric between an entity of the moving bodies (face, edge, vertex) and fixed geometry (another body, a plane, axis or point). **Flip alignment** turns a mate around.

## Delete Body

Removes a body from the model from that point in the history. Deleting the Delete Body feature brings the body back. {idx:Delete Body}

# Surfaces

The **Surfaces** tab builds surface bodies (zero-thickness faces), listed under **Surface Bodies** in the tree. {idx:surfaces}

| Feature | What it does |
|---|---|
| **Extruded Surface** | Sweeps the sketch's curves in a straight line; open chains are fine |
| **Revolved Surface** | Revolves the sketch's curves about an axis |
| **Planar Surface** | Fills a closed sketch |
| **Offset Surface** | Offsets faces of any body |
| **Knit Surface** | Sews surfaces together. When they enclose a volume, **Try to form a solid** turns them into a solid. |
| **Thicken** | Gives a surface a wall thickness (one side or both) and makes it a solid |
| **Split (with a surface)** | Splits solid bodies with a surface body |
| **Move/Copy Surfaces** | As Move/Copy Bodies, for surfaces |
| **Delete Surface** | Removes a surface body |

{idx:knit}{idx:thicken}

Right-click a closed surface body ▸ **Convert to Solid (Knit)** to make it a solid directly. Cuts and Combine only act on solid bodies.

# Reference Geometry

## Reference Plane

Pick up to three references (faces, edges or vertices on the model; planes in the view; planes, axes or points in the tree). The plane type follows from what you pick. Click a reference again to remove it. {idx:reference plane}

| References | Plane made |
|---|---|
| One plane or face | Offset (distance, flip) |
| Two planes or faces | Mid plane: halfway between parallel faces, or the bisector of angled ones |
| Plane/face + edge/axis | Through the edge at an angle (Parallel 0° and Perpendicular 90° buttons) |
| Edge/axis (+ optional point) | Normal to the edge, at its start, middle, end or the point |
| Plane/face + point/vertex | Parallel, through the point |
| Three points or vertices | Through three points |

## Reference Axis

Made from two planes, two reference points, a straight or circular model edge, a sketch line, or a cylindrical face (axis at its centre). Right-click an edge ▸ **Reference Axis** to start one. Axes are drawn dashed and follow the model when it changes. A reference axis can drive a revolve or a pattern. {idx:reference axis}

## Reference Point

Coordinates (equations allowed), a model vertex, an arc centre or an edge midpoint. Right-click a vertex ▸ **Reference Point** to start one. {idx:reference point}

# The Feature Tree and History

## Editing features

- Double-click a feature, or right-click ▸ **Edit Feature**, to open its Property panel. {idx:edit feature}
- Select a feature and press [[Del]] (or **Edit ▸ Delete**) to delete it.
- **Edit ▸ Undo / Redo** ([[Ctrl+Z]] / [[Ctrl+Y]]) works on the whole part history.
- **Rebuild** ([[Ctrl+B]], or the quick button) rebuilds the part.
- A feature that fails shows an error in the tree so you can fix or re-pick its references.

## Rollback bar

The blue line at the bottom of the tree. Drag it up, or right-click a feature ▸ **Roll Back** / **Roll to End**. Features below the bar are suppressed, and new features are inserted above it. {idx:rollback bar}

## Reordering features

Drag a feature up or down the tree. Its absorbed sketch moves with it. A move that would break a reference is refused with the reason. {idx:reorder features}

## Reference arrows

Select a feature in the tree. Blue arrows come from what it uses; purple arrows go to what uses it. {idx:reference arrows}

## Tree symbols

Sheet metal features and bodies have their own icons. Under-defined sketches show **(-)**. Sketches absorbed by features are hidden by default.

# Sheet Metal

The **Sheet Metal** tab holds Base Flange, Edge Flange, Corner Relief, Closed Corner, Unbend, Bend, Flatten, Convert to Sheet Metal, Export DXF, Export All DXF and DXF Settings. Sheet metal bodies are listed in the **Sheet Metal Bodies** folder below Solid Bodies, with sheet metal icons. {idx:sheet metal}

## Base Flange

A closed sketch (holes allowed) becomes a sheet of the given **thickness**. The **bend radius** and **K-factor** set here become the part's defaults. {idx:Base Flange}{idx:K-factor}

## Edge Flange

Click straight edges on the top or bottom face. {idx:Edge Flange}

| Setting | Options |
|---|---|
| Length | Measured to the outer virtual sharp, inner virtual sharp or tangent |
| Angle | Flange angle |
| Position | Material inside, material outside, bend outside, plus an offset; flip |
| Bend radius | Its own radius, or the default |
| Auto relief | Rectangular, obround or tear relief where a bend ends next to material |
| Corners | Flanges picked together that meet at a corner are closed with a gap (default 0.1 mm), or left open. Corner type Overlap, Underlap or Butt; **Swap** reverses which covers; Bend region V cutout or Closed. |

## Corner Relief

Adds a rectangular, circular or tear relief at every corner where two bends meet. {idx:Corner Relief}

## Closed Corner

Closes the corners between 90° flanges: one flange covers the other's end, with a gap. {idx:Closed Corner}

- **Corner type**: Overlap, Underlap or Butt (mitred, gap across the mitre, bends included).
- **Which corners**: click a face of a flange next to a corner and the matching flange is found automatically; the clicked flange is the one that overlaps or tucks under. With no corners picked, every corner of the body is closed.
- **Swap** reverses which flange covers.
- **Bend region**: **V cutout** (default) runs each bend into the corner as it would form from the flat, leaving a small teardrop-shaped opening with a relief at the corner point. **Closed** keeps the bends meeting on the diagonal.
- The flat pattern matches the folded part at closed corners, including each bend's run-on, the relief and the corner round.

## Unbend and Bend

**Unbend** keeps the picked face in place and flattens the rest. Features after it (such as cuts across bends) are made in the flat. **Bend** folds it back to where it was. Both appear in the tree. {idx:Unbend}{idx:Bend}

## Cuts and other features on sheet metal

Cuts on sheet metal (extruded cut and so on) become holes in the flat pattern, so the flat pattern always matches. Other features that change a sheet metal body are allowed, but the flat pattern can't follow them; this is shown in Body Properties and the DXF preview.

## Flatten

Click **Flatten** on the tab, or right-click the body ▸ **View Flat Pattern**. The flat pattern is shown on its own; [[Esc]] or Flatten again restores the view as it was. {idx:Flatten}{idx:flat pattern}

## Convert to Sheet Metal

Turns an ordinary body into sheet metal. Pick a flat face of a thin-walled body (for example a STEP export of a sheet metal part, or a shelled box), or of a knitted surface of flat faces (enter the thickness). {idx:Convert to Sheet Metal}

- RazorCAD follows that side of the sheet across every smooth edge, through flat faces and cylindrical bend faces, so the whole body is found. Each bend keeps its own radius and angle.
- Bends that run straight into each other with no flat between (rolled shapes such as a fan scroll) are joined automatically. Cut-outs in bends are kept and holes stay true circles in the DXF.
- Sharp-cornered bodies (shelled boxes) get bends of the chosen radius at every edge between two flat faces.
- The panel shows what was found in the body, for example "thickness 3 mm · bend radii R300, R227, R13 (inside, 3 bends)" or "4 sharp edges".
- **Use the body's thickness** and **Use the body's bend radii** are on by default. Untick either to set your own value (pre-filled with the detected one).
- After converting, the sheet's volume is compared with the body's. The feature note warns when they differ by more than 0.5 % (for example a nut or motor part that isn't sheet metal).

## Sheet metal Body Properties

Body Properties for a sheet metal body shows thickness, bend radius and K-factor, number of bends, overall flat size, flat area, mass and **quantity**, plus: {idx:cut length}

- **Cut length**: the total length of the flat outline plus every hole and cut-out, and the number of **pierces** (closed contours), for laser-cutting estimates. Also shown in the DXF part information and under flat pattern drawing views.
- **Flat pattern seen from**: top face or bottom face. The bottom face mirrors the pattern and swaps UP / DOWN bend lines and notes. Flatten, DXF export and drawing views all follow it.

## Exporting flat patterns as DXF

- Right-click a sheet metal body (tree or view) ▸ **Export Flat Pattern as DXF**, or **Export DXF** on the tab. {idx:DXF, flat pattern}
- **Export All DXF**: choose a target folder; one file per body, named after the body. Identical bodies give one file with the quantity multiplied by the count.
- Each file is shown in a **preview window** with its layer colours and line types, which can be changed there. Buttons: **Export**, **Skip This One** and **Abort Export**.
- Options: bend lines, bend notes, bend region (hidden) lines, etch lines and part information.

## DXF Settings

**DXF Settings** on the Sheet Metal tab sets the defaults for every export: layer mapping (colours and line types) and options. Defaults: **up bends red**, **down bends blue**, **etch lines yellow dashed**. **Reset to Defaults** restores them. {idx:DXF Settings}

## Not yet available

Hems, sketched bends, miter flanges and etch lines from sketches (the layer exists).

# Drawings

RazorCAD makes 2D engineering drawings of parts, saved as **.rdrw** files and opened in their own tab. {idx:drawings}{idx:.rdrw}

## Starting a drawing

- **Start window ▸ New Drawing**, or **File ▸ New Drawing**: an empty A3 sheet.
- **File ▸ Make Drawing from Part** (in a part): places the standard three views at a scale that fits.

Drawings are opened, saved and listed in the recent files like parts.

## The sheet and its template

The default template is A3 with an ISO 5457 frame (zones and centring marks) and an ISO 7200-style title block: title, drawing number, material, scale, size, units, projection symbol, drawn / checked / approved, date, mass, company, revision, sheet n of m and general tolerances. Sheet sizes A0 to A4, landscape or portrait. {idx:title block}

## Working on the sheet

| Action | How |
|---|---|
| Zoom | Mouse wheel |
| Pan | Middle or right drag, or left drag on empty paper |
| Fit the sheet | [[F]] |
| Move views and annotations | Drag them |
| Edit | Double-click a view for its properties, a dimension or note to edit it |
| Menus | Right-click |
| Delete | [[Del]] |
| Undo / Redo | [[Ctrl+Z]] / [[Ctrl+Y]] |

## View Layout tab

| Command | What it does |
|---|---|
| **Model View** | Pick an open part or browse for a part file, pick the orientation (front, back, top, bottom, left, right, isometric, dimetric, trimetric or flat pattern) and click on the sheet. Then move around it to place projected views. |
| **Standard 3 View** | Three views laid out for first- or third-angle projection |
| **Projected View** | A view aligned with its parent |
| **Flat Pattern** | A sheet metal body unfolded (see below) |
| **Section View** | Horizontal or vertical cutting line, hatched cut faces, A-A labels and arrows, flip |
| **Detail View** | A circle with a letter, 2:1 by default |
| **Update Views** | Re-reads the parts and redraws the views |

{idx:Model View}{idx:Standard 3 View}{idx:Projected View}{idx:Section View, drawing}{idx:Detail View}

Views are hidden-line projections computed by the geometry kernel.

## View properties

Click a view to open its panel: {idx:view properties}

- Orientation, changeable after placing (also to and from Flat Pattern; projected and section views made from it are removed when it becomes a flat pattern, and [[Ctrl+Z]] brings them back).
- Display style: hidden lines removed, hidden lines visible, or wireframe; tangent edges on or off.
- Sheet scale or a custom scale; labels.
- **Rotate View**: −90°, +90°, 180° and 0° buttons and an angle box (degrees, counter-clockwise). Section lines, detail circles and annotations turn with the view.

Aligned views slide only along their alignment. Deleting a view deletes the views made from it.

## Flat pattern views

A flat pattern view shows a sheet metal body unfolded with its outline and holes, bend lines (chain lines) with notes (UP / DOWN, angle, radius), optional bend region lines, and its flat size, thickness, number of bends and cut length underneath. It can be dimensioned (bend lines too) and exported to PDF. If the part has several sheet metal bodies, pick the body in the view properties. {idx:flat pattern view}

## Annotation tab

| Command | How |
|---|---|
| **Smart Dimension** | Click a line for its length, a circle for its diameter (an arc: radius), two points, lines or circles for the distance between them (two lines at an angle: the angle), then click where the text goes. Horizontal, vertical or aligned depends on where you place it. Prefix, suffix, tolerance and override text can be set. |
| **Note** | Click on the sheet; click an edge first to add a leader |
| **Center Mark** | Click circles or arcs |
| **Centerline** | Click two lines (or two points); the centerline runs between them |

{idx:dimensions, drawing}{idx:note}{idx:center mark}

## Sheet tab

- **Sheet Properties**: size, orientation, scale, first or third angle. {idx:sheet properties}
- **Title Block** (Drawing Properties): title block fields, text height and decimals.
- **Add Sheet**: drawings can have several sheets, shown as tabs under the sheet.
- **Export PDF**: vector PDF, one page per sheet. {idx:PDF export}

## Views follow the part

Views and dimensions follow changes to the part, whether it is open in another tab or read from its file. A copy of the part is kept in the drawing so it still opens if the part file is missing.

## Not yet available

Broken, crop and auxiliary views; balloons and BOM tables; GD&T and surface finish symbols; ordinate and baseline dimensions; DXF/DWG export of drawings.

# Evaluate and Tools

## Measure

**Evaluate ▸ Measure**, **Tools ▸ Measure…** or the view's right-click menu. Click vertices, edges, faces, planes or sketch lines; with two items picked it shows the distance between them plus dX, dY and dZ. Use the body filter ([[B]]) to pick whole bodies. {idx:measure}

## Mass Properties

**Evaluate ▸ Mass Properties** shows mass, volume, surface area and centre of mass. It adds up every body with its own density and lists the bodies. A body with no material uses 1.00 g/cm³. {idx:mass properties}

## Equations and global variables

**Tools ▸ Equations…** holds global variables that can be used in any dimension or feature value. Example: `width = 120`, then set a depth to `width/4`. Each row shows the value it evaluates to; invalid or duplicate names are flagged. {idx:equations}{idx:global variables}

Every value field accepts:

| Item | Examples |
|---|---|
| Operators | `+ - * / ^ %` and parentheses |
| Variables | Any name from Equations |
| Trigonometry (degrees) | `sin cos tan asin acos atan` |
| Other functions | `sqrt abs min max round floor ceil pow` |
| Constants | `pi` |

A value may start with `=`. Variable names start with a letter or underscore and can't be a function name.

## Edit Material

**Tools ▸ Edit Material…** (or the Material item in the tree) sets the part material. See Appendix B for the list. {idx:Edit Material}

# Modelling with Claude

RazorCAD can build features from a plain-language description using Anthropic's Claude. {idx:Claude}{idx:Ask Claude}

## Setting up

Open **Tools ▸ Claude Settings…** (or the Claude tab ▸ **Claude Settings**). Enter your own Anthropic API key (create one at console.anthropic.com ▸ API Keys; requests are billed to that account) and choose a model: Opus, Sonnet or Haiku. The key is stored on this PC in `%APPDATA%\RazorCAD\claude.json` and is only sent to api.anthropic.com. **Remove Key** deletes it. {idx:API key}

## Ask Claude panel

Open it with the **Claude** tab ▸ **Ask Claude**, or **Tools ▸ Ask Claude…**.

- Describe a part or a change. Claude adds the features to the tree; each answer is **one undo step**.
- If the features don't build, Claude is told the error and corrects it, up to two more tries.
- Claude sees the feature list and body sizes of the part, not the picture.
- **New Conversation** (or **New chat** in the panel) starts fresh; the part stays as it is.
- The model can be switched in the panel.

## RazorCAD Part Builder on claude.ai

A companion page on claude.ai lets you describe a part, see the feature list with sketch previews, and download it as a .rcad file to open in RazorCAD. It uses the same modelling guide as the in-app panel.

# Troubleshooting

## Crash reports

RazorCAD writes a crash report whenever something goes wrong, to `%APPDATA%\RazorCAD\crashes\<date_time>_<kind>\`. Open the folder with **Help ▸ Open Crash Reports Folder**. The start window mentions new reports. The newest 30 are kept. {idx:crash reports}

| File | Contents |
|---|---|
| `report.json` | The kind of failure, the error message and stack trace, what RazorCAD was doing (mode, Property panel, sketch tool, selection, feature errors) and system information |
| `session.log` | The recent actions of the session, newest last |
| `part.rcad` | The part that was open, so the problem can be reproduced |

Kinds of report: `ui-error`, `kernel-error`, `kernel-worker-crash`, `python-exception`, `native-crash` and `unexpected-shutdown` (a session that ended without closing normally, found at the next launch).

## Common problems

| Problem | What to do |
|---|---|
| A fillet or projected edge loses its edge after a big change | Edge references are found again by geometry, not by true topological naming. Edit the feature and re-pick the edge. |
| A sketch on a model face doesn't follow the face | Sketches on faces are stored as fixed planes. Use a reference plane driven by an equation when that matters. |
| Convert Entities can't see a sketch | It only sees visible sketches earlier in the history. Show the sketch first. |
| An STL body can't be filleted | STL bodies with thousands of faces can't be filleted or chamfered and don't offer pickable edges. |
| A fillet won't blend across two touching bodies | Combine the bodies first. |
| Open fails with a file filter error | Fixed in 0.9.0-beta. Update RazorCAD. |
| Unsaved work after a crash | Reopen the part and accept the auto-save recovery. |

## Settings and data files

| Location | Contents |
|---|---|
| `%APPDATA%\RazorCAD\recent.json` | Recent files list |
| `%APPDATA%\RazorCAD\claude.json` | Claude API key and model |
| `%APPDATA%\RazorCAD\crashes\` | Crash reports |
| `Name.autosave.rcad` | Auto-save, next to the part file |

# For Developers

## Rebuilding the executable

```
python -m pip install pywebview pyinstaller pillow
build.bat
```

`build.bat` bundles `app/` (including the 23 MB OpenCascade WebAssembly kernel) and `razorcad.py` into `RazorCAD.exe` with PyInstaller. If RazorCAD is open, the running copy is renamed to `RazorCAD.old.exe` and the new build is used from the next launch. {idx:build.bat}

`installer\build_installer.bat` builds `RazorCAD.exe` and then `RazorCAD-Setup.exe`. Set the version in `version.txt` first.

## Working on the UI

Run `python serve.py` and open http://localhost:8765/ in a browser. In that mode files are downloaded instead of saved through dialogs. Set the `RAZORCAD_DATA_DIR` environment variable to keep a test run's recent-files list separate from your own. {idx:serve.py}

## Project layout

| Path | Purpose |
|---|---|
| `RazorCAD.exe` | The application (built by build.bat) |
| `razorcad.py` | Desktop shell: native window, file dialogs, auto-save (pywebview) |
| `app/js/main.js` | Application controller: documents, commands, selection, files |
| `app/js/ui.js` | Menus, Command ribbon, Feature tree, Property panel, dialogs |
| `app/js/model.js` | Feature definitions, undo history, materials, sample part |
| `app/js/kernel.worker.js` | Geometry kernel worker: replays the history with OpenCascade |
| `app/js/sketcher.js`, `sketchmodel.js`, `solver.js` | Sketch mode, sketch data and the constraint solver |
| `app/js/sheetmetal.js` | Sheet metal features and flat patterns |
| `app/js/drawing*.js`, `pdf.js` | Drawings, sheet formats and PDF export |
| `app/js/claudespec.js` | Modelling guide used by Ask Claude |
| `Manual/` | This manual: source, build script and change tracking |

# Appendix A: Keyboard and Mouse Reference

## General

| Action | Keys |
|---|---|
| New / Open / Save | [[Ctrl+N]] / [[Ctrl+O]] / [[Ctrl+S]] |
| Save As | [[Ctrl+Shift+S]] |
| Import STEP / STL | [[Ctrl+I]] |
| Undo / Redo | [[Ctrl+Z]] / [[Ctrl+Y]] |
| Rebuild | [[Ctrl+B]] |
| Delete feature or entity | [[Del]] |
| Accept / cancel Property panel | [[Enter]] / [[Esc]] |
| Edit a feature | Double-click it in the tree |

## View

| Action | Keys |
|---|---|
| Zoom to fit | [[F]] |
| Front, Back, Left, Right, Top, Bottom, Isometric | [[Ctrl+1]] … [[Ctrl+7]] |
| Normal To | [[Ctrl+8]] |
| Rotate in steps | Arrows 15°, [[Shift]] + arrows 90° |
| Pan in steps | [[Ctrl]] + arrows |
| Roll | [[Alt]] + ← / → |
| Hide body under cursor / show hidden body under cursor | [[Tab]] / [[Shift+Tab]] |

## Selection filters

| Filter | Key |
|---|---|
| Faces / Edges / Vertices / Bodies | [[X]] / [[E]] / [[V]] / [[B]] |
| Clear filters | [[F5]] |

## Sketch

| Tool | Key |
|---|---|
| Select | [[S]] |
| Line | [[L]] |
| Rectangle | [[R]] |
| Circle | [[C]] |
| Arc | [[A]] |
| Polygon | [[P]] |
| Trim | [[T]] |
| Smart Dimension | [[D]] |
| Convert Entities | [[E]] |
| Offset Entities | [[O]] |
| Construction Geometry | [[Q]] |
| Delete | [[Del]] |
| End tool, then exit sketch | [[Esc]] |
| Tool wheel | Hold the middle button still |

# Appendix B: Materials

| Material | Density (g/cm³) |
|---|---|
| Plain Carbon Steel | 7.80 |
| AISI 304 Stainless | 8.00 |
| 6061 Aluminum Alloy | 2.70 |
| Brass | 8.50 |
| Copper | 8.96 |
| Ti-6Al-4V | 4.43 |
| ABS Plastic | 1.04 |
| PLA Plastic | 1.24 |
| Nylon 6/6 | 1.14 |

A body or part with no material uses 1.00 g/cm³ for mass calculations.

# Appendix C: Manual Revision History

| Date | Software version | Changes |
|---|---|---|
| 2026-10-13 | 0.9.0-beta | First edition. Covers parts, sketching, gears, solid features, bodies, surfaces, reference geometry, the feature tree, sheet metal (including Convert to Sheet Metal with detected thickness and bend radii), drawings, evaluate tools, Ask Claude, troubleshooting and developer notes. |
