/* Surface deviation from the nominal (CAD) surface to the scanned surface. The scanned surface is the gray level
   halfway between air and matrix; each nominal point looks along its outward normal for the nearest place where the
   gray falls through that level going outward. Positive: the scan has material outside the nominal; negative:
   material is missing. Works on the binned analysis grid; positions are scan mm (full-grid index x voxel size). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBDeviation = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEP_VOXELS = 0.25; // search step, in analysis voxels
  const MIN_FACING = 0.5; // cos 60°: a crossing counts only where the scanned surface faces within 60° of the normal
  const MAX_MATRIX_SAMPLES = 2e6;

  const isoLevel = (air, matrix) => (air + matrix) / 2;

  /** Median gray inside the sample mask, pore voxels (below the threshold) left out. */
  function matrixGray(gray, filled, threshold) {
    let count = 0;
    for (let i = 0; i < gray.length; i++) if (filled[i] && gray[i] >= threshold) count++;
    if (!count) return null;
    const stride = Math.max(1, Math.floor(count / MAX_MATRIX_SAMPLES)), values = [];
    for (let i = 0, k = 0; i < gray.length; i++) if (filled[i] && gray[i] >= threshold && k++ % stride === 0) values.push(gray[i]);
    values.sort((a, b) => a - b);
    return values[(values.length - 1) >> 1];
  }

  /** Analysis voxels of air joined to the outside: below the level and 6-connected to the volume's faces or, when
      filled is given, to below-level voxels outside the sample mask. Pores inside the part are not reached, so their
      walls are not the part's surface; dents and open cracks are. */
  function exteriorAir(gray, dims, level, filled = null) {
    const { nx, ny, nz } = dims, n = gray.length, air = new Uint8Array(n), stack = [];
    const seed = (i) => { if (!air[i] && gray[i] < level) { air[i] = 1; stack.push(i); } };
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1 || (filled && !filled[i])) seed(i);
    }
    while (stack.length) {
      const i = stack.pop(), x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      if (x > 0) seed(i - 1); if (x < nx - 1) seed(i + 1);
      if (y > 0) seed(i - nx); if (y < ny - 1) seed(i + nx);
      if (z > 0) seed(i - nx * ny); if (z < nz - 1) seed(i + nx * ny);
    }
    return air;
  }

  /** A sampler on the binned grid: gray at a scan-mm position by trilinear interpolation, or NaN outside the volume
      or the FOV circle (full-grid { cx, cy, r }). */
  function sampler({ gray, dims, bin, voxelMm, circle = null }) {
    const { nx, ny, nz } = dims, half = (bin - 1) / 2;
    return (x, y, z) => {
      const fx = x / voxelMm, fy = y / voxelMm, fz = z / voxelMm;
      if (circle && (fx - circle.cx) ** 2 + (fy - circle.cy) ** 2 > circle.r * circle.r) return NaN;
      const bx = (fx - half) / bin, by = (fy - half) / bin, bz = (fz - half) / bin;
      if (!(bx >= 0 && by >= 0 && bz >= 0 && bx <= nx - 1 && by <= ny - 1 && bz <= nz - 1)) return NaN;
      const x0 = Math.min(nx - 2, Math.floor(bx)), y0 = Math.min(ny - 2, Math.floor(by)), z0 = Math.min(nz - 2, Math.floor(bz));
      const u = bx - x0, v = by - y0, w = bz - z0, i = (z0 * ny + y0) * nx + x0, sx = 1, sy = nx, sz = nx * ny;
      const c00 = gray[i] * (1 - u) + gray[i + sx] * u, c10 = gray[i + sy] * (1 - u) + gray[i + sy + sx] * u;
      const c01 = gray[i + sz] * (1 - u) + gray[i + sz + sx] * u, c11 = gray[i + sz + sy] * (1 - u) + gray[i + sz + sy + sx] * u;
      return (c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w;
    };
  }

  /** Points on the scanned surface: for each pair of neighboring analysis voxels across the level (the upper one in
      the FOV and, when given, in `near`), the interpolated crossing between their centers. Thinned to maxPoints. */
  function surfacePoints({ gray, dims, bin, voxelMm, level, circle = null, near = null, air = null, maxPoints = 60000 }) {
    const { nx, ny, nz } = dims, out = [];
    const full = (b) => b * bin + (bin - 1) / 2;
    const steps = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (gray[i] < level || (near && !near[i])) continue;
      if (circle && (full(x) - circle.cx) ** 2 + (full(y) - circle.cy) ** 2 > circle.r * circle.r) continue;
      for (const [dx, dy, dz] of steps) {
        const X = x + dx, Y = y + dy, Zb = z + dz;
        if (X < 0 || Y < 0 || Zb < 0 || X >= nx || Y >= ny || Zb >= nz) continue;
        const j = (Zb * ny + Y) * nx + X, g = gray[j];
        if (g >= level || (air && !air[j])) continue;
        const t = (gray[i] - level) / (gray[i] - g);
        out.push((full(x) + t * dx * bin) * voxelMm, (full(y) + t * dy * bin) * voxelMm, (full(z) + t * dz * bin) * voxelMm);
      }
    }
    const n = out.length / 3;
    if (n <= maxPoints) return Float32Array.from(out);
    const thin = new Float32Array(3 * maxPoints), step = n / maxPoints;
    for (let k = 0; k < maxPoints; k++) { const j = 3 * Math.floor(k * step); thin[3 * k] = out[j]; thin[3 * k + 1] = out[j + 1]; thin[3 * k + 2] = out[j + 2]; }
    return thin;
  }

  /** Cosine between the scanned surface's outward normal (minus the gray gradient) at a point and direction d. */
  function facing(at, x, y, z, d, h) {
    const gx = at(x + h, y, z) - at(x - h, y, z), gy = at(x, y + h, z) - at(x, y - h, z), gz = at(x, y, z + h) - at(x, y, z - h);
    const len = Math.hypot(gx, gy, gz);
    return len > 0 ? -(gx * d[0] + gy * d[1] + gz * d[2]) / len : NaN;
  }

  /** Signed deviation (mm) of every nominal point: the nearest crossing within ±rangeMm inside the volume where the
      scanned surface faces within 60° of the normal; NaN where there is none. */
  function deviations({ gray, dims, bin, voxelMm, level, circle = null, points, normals, edge = null, air = null, transform, rangeMm = 2 }) {
    const at = sampler({ gray, dims, bin, voxelMm, circle });
    const { nx, ny, nz } = dims, half = (bin - 1) / 2;
    const outside = (x, y, z) => { // any of the 8 analysis voxels around a scan-mm point is outside air
      if (!air) return true;
      const b = [x, y, z].map((v) => (v / voxelMm - half) / bin), lo = b.map(Math.floor);
      for (let k = 0; k < 8; k++) {
        const X = lo[0] + (k & 1), Y = lo[1] + ((k >> 1) & 1), Z = lo[2] + ((k >> 2) & 1);
        if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz && air[(Z * ny + Y) * nx + X]) return true;
      }
      return false;
    };
    const { R, t, s } = transform, step = STEP_VOXELS * bin * voxelMm, n = Math.ceil(rangeMm / step);
    const out = new Float32Array(points.length / 3);
    for (let k = 0; k < out.length; k++) {
      if (edge && edge[k]) { out[k] = NaN; continue; }
      const px = points[3 * k], py = points[3 * k + 1], pz = points[3 * k + 2], qx = normals[3 * k], qy = normals[3 * k + 1], qz = normals[3 * k + 2];
      const c = [0, 1, 2].map((r) => s * (R[3 * r] * px + R[3 * r + 1] * py + R[3 * r + 2] * pz) + t[r]);
      const d = [0, 1, 2].map((r) => R[3 * r] * qx + R[3 * r + 1] * qy + R[3 * r + 2] * qz);
      let best = NaN, prev = at(c[0] - n * step * d[0], c[1] - n * step * d[1], c[2] - n * step * d[2]);
      for (let j = -n + 1; j <= n; j++) {
        const g = at(c[0] + j * step * d[0], c[1] + j * step * d[1], c[2] + j * step * d[2]);
        if (prev >= level && g < level) { // NaN on either side fails both comparisons
          const sCross = (j - 1 + (prev - level) / (prev - g)) * step;
          const ahead = [0, 1, 2].map((r) => c[r] + j * step * d[r]);
          if (!(Math.abs(sCross) >= Math.abs(best)) && outside(...ahead) && facing(at, c[0] + sCross * d[0], c[1] + sCross * d[1], c[2] + sCross * d[2], d, bin * voxelMm) >= MIN_FACING) best = sCross;
        }
        prev = g;
      }
      out[k] = best;
    }
    return out;
  }

  const EPS = 1e-6;

  function quantile(sorted, q) {
    const pos = q * (sorted.length - 1), lo = Math.floor(pos), hi = Math.min(sorted.length - 1, lo + 1);
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
  }

  /** Statistics of the measured points; points on sharp edges (edge mask) are counted as on_edge, the rest that found
      no surface as unmeasured. With weights (area per point), mean, SD, percentiles and the share within tolerance
      follow area; counts stay counts. */
  function deviationStats(dev, toleranceMm, edge = null, weight = null) {
    let onEdge = 0;
    if (edge) for (let k = 0; k < dev.length; k++) if (edge[k]) onEdge++;
    const idx = [];
    for (let k = 0; k < dev.length; k++) if (Number.isFinite(dev[k])) idx.push(k);
    const n = idx.length;
    if (!n) return { measured: 0, unmeasured: dev.length - onEdge, on_edge: onEdge, mean: null, sd: null, min: null, p05: null, p50: null, p95: null, max: null, within_percent: null };
    idx.sort((a, b) => dev[a] - dev[b]);
    const v = idx.map((k) => dev[k]), w = idx.map((k) => (weight ? weight[k] : 1)), W = w.reduce((a, b) => a + b, 0);
    const mean = v.reduce((s, x, i) => s + w[i] * x, 0) / W;
    const sd = Math.sqrt(v.reduce((s, x, i) => s + w[i] * (x - mean) ** 2, 0) / (weight ? W : Math.max(1, n - 1)));
    const within = v.reduce((s, x, i) => s + (Math.abs(x) <= toleranceMm + EPS ? w[i] : 0), 0);
    const q = (f) => {
      if (!weight) return quantile(v, f);
      let c = 0;
      for (let i = 0; i < n; i++) { c += w[i]; if (c >= f * W - EPS) return v[i]; }
      return v[n - 1];
    };
    return { measured: n, unmeasured: dev.length - n - onEdge, on_edge: onEdge, mean, sd, min: v[0], p05: q(0.05), p50: q(0.5), p95: q(0.95), max: v[n - 1], within_percent: (100 * within) / W };
  }

  function histogram(dev, { bins = 40, range }) {
    const [lo, hi] = range, w = (hi - lo) / bins;
    const counts = new Array(bins).fill(0);
    let below = 0, above = 0;
    for (const d of dev) {
      if (!Number.isFinite(d)) continue;
      const k = Math.floor((d - lo) / w + EPS);
      if (k < 0) below++; else if (k >= bins) { if (d <= hi + EPS && k === bins) counts[bins - 1]++; else above++; } else counts[k]++;
    }
    return { edges: Array.from({ length: bins + 1 }, (_, k) => lo + k * w), counts, below, above };
  }

  // Diverging map (Moreland's cool-warm): blue where material is missing, red where there is extra.
  const COOL = [0.23, 0.299, 0.754], MID = [0.865, 0.865, 0.865], WARM = [0.706, 0.016, 0.15], UNMEASURED = [0.35, 0.35, 0.35];
  function deviationColor(d, limit) {
    if (!Number.isFinite(d)) return UNMEASURED.slice();
    const x = Math.max(-1, Math.min(1, d / limit)), end = x < 0 ? COOL : WARM, f = Math.abs(x);
    return MID.map((m, k) => m + f * (end[k] - m));
  }

  /** What is saved with the sample: the pose to reopen the comparison from, and the numbers the page reported. */
  function cadSummary(result, { file, unitMm, spacingMm, points }) {
    const { transform, rms, level, stats, options } = result, total = stats.measured + stats.unmeasured; // edge points left out
    return { file, unit_mm: unitMm, spacing_mm: spacingMm, points, transform, rms_mm: rms, iso_level: level, scale_fitted: Boolean(options.scale),
      shrinkage_percent: options.scale ? (1 - transform.s) * 100 : null, tolerance_mm: options.toleranceMm, range_mm: options.rangeMm,
      unmeasured_percent: total ? (100 * stats.unmeasured) / total : null, stats, saved_at: new Date().toISOString() };
  }

  return { exteriorAir, isoLevel, matrixGray, sampler, surfacePoints, deviations, deviationStats, histogram, deviationColor, cadSummary };
}));
