/* Wall thickness on the binned sample mask (pores filled: the part's walls). Ridge voxels are local maxima of the
   distance to the outside; the wall there is about 2 × that distance − ½ voxel thick (±½ voxel: a ridge voxel sits on
   or half a voxel off the wall's middle). Walls thinner than about 3 voxels are not reported (the thinnest reported is
   3.5 voxels, which means at or below that limit); the stack ends are not walls. Reports the distribution and the thinnest places, spread apart. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_zones.js'));
  else root.VBWall = factory(root.CTZones);
}(typeof self !== 'undefined' ? self : this, function (Z) {
  'use strict';

  const THINNEST = 20, SEPARATION = 4; // binned voxels between two listed thin places
  const MAX_SLOPE = 0.6; // |grad d| on a ridge: a wall tapering up to 1 voxel per voxel stays under 0.5, a spoke into a 90° corner is 0.71
  const HALF_DIRECTIONS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1], [0, 1, 1], [0, 1, -1], [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1]];
  const NEIGHBORS = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) NEIGHBORS.push([dx, dy, dz, Math.hypot(dx, dy, dz)]);
  NEIGHBORS.sort((a, b) => a[3] - b[3]); // face neighbors first: they reject most voxels soonest
  const MIN_RIDGE = 2; // ridge distance below this is not reported: walls thinner than about 3 voxels; the thinnest reported is 3.5 voxels

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = q * (sorted.length - 1), lo = Math.floor(pos), hi = Math.min(sorted.length - 1, lo + 1);
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
  }

  /** filled: binned mask; voxelMm: analysis voxel size. Returns ridge (thickness mm per ridge voxel), ridgeIndex,
      stats { count, min_mm, p05_mm, p50_mm, p95_mm, max_mm }, thinnest [{ x, y, z, thickness_mm }] (binned grid) and
      beyond_stack (ridge voxels left out because their inscribed ball reaches past the first or last slice, where the
      part may continue: their thickness is unknown). A voxel is ridge when no neighbor's inscribed ball contains its
      own (d[j] < d[i] + |offset|), so tapered walls keep their ridge, and the distance rises along it by at most
      MAX_SLOPE per voxel, which leaves out the spokes of the medial axis into convex corners. */
  function wallThickness(filled, dims, voxelMm) {
    const { nx, ny, nz } = dims, d = Z.distanceInside(filled, dims, { endsInside: true }), idx = [];
    let beyond = 0;
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (!filled[i] || d[i] < MIN_RIDGE) continue;
      let ridge = true;
      const inner = x > 0 && y > 0 && z > 0 && x < nx - 1 && y < ny - 1 && z < nz - 1;
      for (let k = 0; k < 26; k++) {
        const o = NEIGHBORS[k];
        if (!inner) { const X = x + o[0], Y = y + o[1], Zz = z + o[2]; if (X < 0 || Y < 0 || Zz < 0 || X >= nx || Y >= ny || Zz >= nz) continue; }
        if (d[i + o[0] + nx * (o[1] + ny * o[2])] >= d[i] + o[3] - 1e-6) { ridge = false; break; }
      }
      if (!ridge) continue;
      const at = (X, Y, Zz) => (X < 0 || Y < 0 || Zz < 0 || X >= nx || Y >= ny || Zz >= nz ? d[i] : d[(Zz * ny + Y) * nx + X]);
      // Slope along the ridge: directions in which this voxel is a local maximum run across the ridge and are skipped.
      let slope = 0;
      for (const [dx, dy, dz] of HALF_DIRECTIONS) {
        const up = at(x + dx, y + dy, z + dz), down = at(x - dx, y - dy, z - dz);
        if (up <= d[i] && down <= d[i]) continue;
        slope = Math.max(slope, Math.abs(up - down) / (2 * Math.hypot(dx, dy, dz)));
      }
      if (slope > MAX_SLOPE) continue; // the medial axis running into a convex corner, not a wall
      if (d[i] - 0.5 > Math.min(z + 0.5, nz - 0.5 - z)) { beyond++; continue; }
      idx.push(i);
    }
    const ridgeIndex = Int32Array.from(idx), ridge = Float32Array.from(idx, (i) => (2 * d[i] - 0.5) * voxelMm);
    const sorted = Float64Array.from(ridge).sort();
    const order = Array.from(ridgeIndex.keys()).sort((a, b) => ridge[a] - ridge[b]), thinnest = [];
    for (const k of order) {
      if (thinnest.length === THINNEST) break;
      const i = ridgeIndex[k], x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      if (thinnest.some((t) => Math.max(Math.abs(t.x - x), Math.abs(t.y - y), Math.abs(t.z - z)) < SEPARATION)) continue;
      thinnest.push({ x, y, z, thickness_mm: ridge[k] });
    }
    return { ridge, ridgeIndex, thinnest, beyond_stack: beyond, stats: { count: ridge.length, min_mm: sorted.length ? sorted[0] : null, p05_mm: quantile(sorted, 0.05), p50_mm: quantile(sorted, 0.5), p95_mm: quantile(sorted, 0.95), max_mm: sorted.length ? sorted[sorted.length - 1] : null } };
  }

  /** For the page: statistics, a histogram of ridge thickness, and the thinnest places on the full grid. */
  function wallReport(filled, dims, bin, voxelMm, bins = 30) {
    const r = wallThickness(filled, dims, bin * voxelMm), top = r.stats.max_mm || 1, counts = new Array(bins).fill(0);
    for (const t of r.ridge) counts[Math.min(bins - 1, Math.floor((t / top) * bins))]++;
    const full = (b) => b * bin + (bin - 1) / 2;
    return { stats: r.stats, beyond_stack: r.beyond_stack, resolved_min_mm: (2 * MIN_RIDGE - 0.5) * bin * voxelMm, histogram: { top_mm: top, counts }, thinnest: r.thinnest.map((t) => ({ x: full(t.x), y: full(t.y), z: full(t.z), thickness_mm: t.thickness_mm })), analysis_voxel_mm: bin * voxelMm };
  }

  return { wallThickness, wallReport };
}));
