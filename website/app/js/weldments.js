// Weldment cut list: the members (and plates, welds) of a part grouped into items: the same profile cut to the
// same length with the same end angles is one item with a quantity. members: [{ label, type, length, angles,
// volume, density? (g/cm³) }]. Returns rows { item, qty, description, length, angle1, angle2, totalLength, mass }
// (mass in kg each, null without a density) and totals by profile.
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

export function cutListRows(members) {
  const groups = new Map();
  for (const m of members) {
    const isWeld = m.type === 'weld';
    const angles = (m.angles || [null, null]).map(r1).sort((a, b) => (b ?? -1) - (a ?? -1));
    const key = isWeld ? `weld|${m.label}` : `${m.type}|${m.label}|${r1(m.length)}|${angles.join(',')}`;
    if (!groups.has(key)) groups.set(key, { m, angles, qty: 0, totalLength: 0, mass: 0, hasMass: true, weld: isWeld });
    const g = groups.get(key);
    g.qty++;
    g.totalLength += m.length || 0;
    if (m.density > 0 && m.volume > 0) g.mass += (m.volume * m.density) / 1e6; else g.hasMass = false;
  }
  // members first (by profile, longest first), then plates, then welds
  const order = (g) => (g.weld ? 2 : g.m.type === 'plate' ? 1 : 0);
  const list = [...groups.values()].sort((a, b) => order(a) - order(b) || a.m.label.localeCompare(b.m.label) || (b.m.length || 0) - (a.m.length || 0));
  const rows = list.map((g, i) => ({
    item: i + 1,
    qty: g.weld ? 1 : g.qty,
    description: g.weld ? `${g.m.label} fillet weld (${g.qty} joint${g.qty === 1 ? '' : 's'})` : g.m.label,
    length: g.weld ? null : r1(g.m.length),
    angle1: g.weld ? null : g.angles[0],
    angle2: g.weld ? null : g.angles[1],
    totalLength: r1(g.totalLength),
    mass: g.hasMass && !g.weld ? Math.round((g.mass / g.qty) * 1000) / 1000 : null,
    weld: g.weld,
  }));
  const byProfile = new Map();
  for (const g of list) if (!g.weld && g.m.type !== 'plate') byProfile.set(g.m.label, (byProfile.get(g.m.label) || 0) + g.totalLength);
  return { rows, totals: [...byProfile].map(([label, len]) => ({ label, length: r1(len) })) };
}

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function cutListCSV({ rows, totals }) {
  const out = [['Item', 'Qty', 'Description', 'Length (mm)', 'Angle 1 (deg)', 'Angle 2 (deg)', 'Total length (mm)', 'Mass each (kg)'].join(',')];
  for (const r of rows) out.push([r.item, r.qty, r.description, r.length, r.angle1, r.angle2, r.totalLength, r.mass].map(csvCell).join(','));
  if (totals.length) {
    out.push('', 'Total length by profile', ...totals.map((t) => [csvCell(t.label), t.length].join(',')));
  }
  return out.join('\r\n') + '\r\n';
}
