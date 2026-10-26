# Known geometry failures

## Outward shell on guided loft

Open `shell-guided-loft.rcad`. This is a synthetic square-to-circle loft with two circular-arc rails; it contains no user model data. The circular top cap is selected for removal. On commit e5e35fa the related reproduction failed with outward thicknesses of 0.5, 1 and 2 mm, while inward passed at those values. The default example is outward 1 mm.

This is an open issue, not an expected-success baseline in the normal part suite. To accept a future fix, require all of:

- An actual solid passing geometric/topological validation.
- A hollow result at the requested thickness, checked by wall volume and section measurements.
- The selected cap stays open (a ray through the centre from above must reach the cavity bottom, not a new lid).
- Both inward/outward and multiple thicknesses remain correct, including ordinary box shells.

Intersecting-offset joins alone produced invalid solids in experiments. Topology repair could produce a valid *filled* solid, so a validity check alone is insufficient. No experimental Shell fallback was retained or published.
