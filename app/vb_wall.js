/* Wall thickness on the binned sample mask (pores filled: the part's walls). Ridge voxels are local maxima of the
   distance to the outside; the wall there is about 2 × that distance − ½ voxel thick (±½ voxel: a ridge voxel sits on
   or half a voxel off the wall's middle). Ridges under 2 voxels (walls under about 3.5 voxels) are not resolved and not
   reported; the stack ends are not walls. Reports the distribution and the thinnest places, spread apart. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_zones.js'));
  else root.VBWall = factory(root.CTZones);
}(typeof self !== 'undefined' ? self : this, function (Z) {
  'use strict';

  const THINNEST = 20, SEPARATION = 4; // binned voxels between two listed thin places
  const MIN_RIDGE = 2; // ridge distance below this (walls under about 2 voxels) is not resolved and not reported

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = q * (sorted.length - 1), lo = Math.floor(pos), hi = Math.min(sorted.length - 1, lo + 1);
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
  }

  /** filled: binned mask; voxelMm: analysis voxel size. Returns ridge (thickness mm per ridge voxel), ridgeIndex,
      stats { count, min_mm, p05_mm, p50_mm, p95_mm, max_mm } and thinnest [{ x, y, z, thickness_mm }] (binned grid). */
  function wallThickness(filled, dims, voxelMm) {
    const { nx, ny, nz } = dims, d = Z.distanceInside(filled, dims, { endsInside: true }), idx = []; // the part may continue past the stack
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (!filled[i] || d[i] < MIN_RIDGE) continue;
      let top = true;
      for (let dz = -1; dz <= 1 && top; dz++) for (let dy = -1; dy <= 1 && top; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, Zz = z + dz;
        if (X < 0 || Y < 0 || Zz < 0 || X >= nx || Y >= ny || Zz >= nz) continue;
        if (d[(Zz * ny + Y) * nx + X] > d[i]) { top = false; break; }
      }
      if (top) idx.push(i);
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
    return { ridge, ridgeIndex, thinnest, stats: { count: ridge.length, min_mm: sorted.length ? sorted[0] : null, p05_mm: quantile(sorted, 0.05), p50_mm: quantile(sorted, 0.5), p95_mm: quantile(sorted, 0.95), max_mm: sorted.length ? sorted[sorted.length - 1] : null } };
  }

  /** For the page: statistics, a histogram of ridge thickness, and the thinnest places on the full grid. */
  function wallReport(filled, dims, bin, voxelMm, bins = 30) {
    const r = wallThickness(filled, dims, bin * voxelMm), top = r.stats.max_mm || 1, counts = new Array(bins).fill(0);
    for (const t of r.ridge) counts[Math.min(bins - 1, Math.floor((t / top) * bins))]++;
    const full = (b) => b * bin + (bin - 1) / 2;
    return { stats: r.stats, histogram: { top_mm: top, counts }, thinnest: r.thinnest.map((t) => ({ x: full(t.x), y: full(t.y), z: full(t.z), thickness_mm: t.thickness_mm })), analysis_voxel_mm: bin * voxelMm };
  }

  return { wallThickness, wallReport };
}));
