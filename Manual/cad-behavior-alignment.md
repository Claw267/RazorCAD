# CAD command behavior alignment

This tracks concrete workflows against the official Fusion and SolidWorks
documentation. It is an implementation inventory, not a claim of complete
feature parity. Geometry selection, options and result type must all work;
matching a menu label alone is insufficient.

## Implemented and verified in this pass

| Family | Geometry selection | Options and behavior |
| --- | --- | --- |
| Solid Extrude / Cut | Canvas regions, connected contours and individual entities; legacy whole sketches remain supported | One side, symmetric depth and two independent depths; Join/New body/Cut; existing up-to/through options and cut scope retained |
| Solid Revolve / Cut | Selected coplanar regions/contours; profile and axis picking are separate | Full or angle; one side, symmetric or two independent angles; reverse; optional axis projection; Thin for open contours; Join/New body/Cut and explicit target-body selection |
| Surface Extrude | Selected regions or open/closed contours; manual entity selection | One side, symmetric or two independent depths; reverse; produces surface geometry rather than a capped solid |
| Surface Revolve | Selected regions or open/closed contours; profile and axis picking are separate | Same Full/Angle and directional controls as solid Revolve, optional axis projection; keeps a surface result |
| Planar Surface | Previously added canvas regions, individual sketch entities and closed model-edge loops | Preserves region holes, rejects open/nonplanar model boundaries; explicit whole-sketch fallback |

Sketch/reference/model axes remain supported. A picked sketch axis may come
from another earlier sketch; the profile subset does not discard its axis.
Partial revolutions reject totals above 360 degrees and negative second angles.
Coplanar profiles that cross the rotation axis are rejected. Inactive values
are ignored (for example the stored angle in Full mode). Symmetric depth means
the specified **total** depth, split equally between both sides.

Old files without profile selections keep their whole-sketch geometry. Older
revolutions clamped angles above 360 degrees; editing one migrates it to Full
instead of changing the resulting geometry.

## Differences still open

| Family | Existing behavior | Remaining alignment work |
| --- | --- | --- |
| Extrude | Region selection, Thin, through/up-to/offset and scoped cuts | Start from offset/object, draft, independent end conditions for each side, Intersect operation and direct face inputs |
| Revolve | Features listed above | To Object extent; direct planar-face inputs; additional component-level operations |
| Surface Extrude | Features listed above | Start offsets/objects, To Object termination, direct model-edge/face inputs and draft |
| Surface Revolve | Features listed above | To Object extent and direct model-edge/face inputs |
| Sweep / Surface Sweep | Path/guide modes, parallel/perpendicular orientation and twist already exist | Replace remaining whole-sketch profile/path fields with explicit contour slots; compare guide-surface and scale/twist controls |
| Loft / Surface Loft | Canvas profiles, guides and separate endpoint conditions through G2 already exist | Broader guide/endpoint combinations, continuity influence controls and model-face selection workflows |
| Patch | Per-edge G0/G1/G2 and connected model-edge selection already exist | Tangency weights, interior rails/points; sketch inputs need an explicit product decision (planar sketch creation currently belongs to Planar Surface) |
| Fillet/Chamfer, Shell, Hole, patterns, sheet metal, assemblies and drawings | Existing RazorCAD commands | Dedicated command-by-command comparison and interaction tests are still required |

## Official references

- [Fusion solid Revolve](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/GUID-D74BB28A-9570-43AD-97A4-E094021C036B.htm)
- [Fusion surface Revolve](https://help.autodesk.com/cloudhelp/ENU/Fusion-Patch/files/SFC-REVOLVE.htm)
- [Fusion surface Extrude](https://help.autodesk.com/cloudhelp/ENU/Fusion-Patch/files/SFC-EXTRUDE.htm)
- [SolidWorks Revolve PropertyManager and Selected Contours](https://help.solidworks.com/2024/english/SolidWorks/sldworks/HIDD_DVE_FEAT_REV.htm)
- [SolidWorks Planar Surface](https://help.solidworks.com/2024/english/solidworks/sldworks/HIDD_DVE_PLANAR_SURFACE.htm)
- [Fusion Patch](https://help.autodesk.com/cloudhelp/ENU/Fusion-Patch/files/SFC-PATCH.htm)

## Validation

`tests/standard-feature-cases.js` checks analytical volumes/areas, native
directional contact probes, selected and legacy profiles, solid operations,
independent/projected axes, Thin, invalid angles and axis crossings. The
`standard-feature-workflows` app test uses real viewport profile and axis
picks, edits the shared controls and operations, selects a cut target body,
saves/reopens and cancels edits. Run it on both kernel configurations, alongside
the existing Extrude, Loft, Planar Surface, Patch and saved-part regressions.
