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
  function surfacePoints({ gray, dims, bin, voxelMm, level, circle = null, near = null, maxPoints = 60000 }) {
    const { nx, ny, nz } = dims, out = [];
    const full = (b) => b * bin + (bin - 1) / 2;
    const steps = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (gray[i] < level || (near && !near[i])) continue;
      if (circle && (full(x) - circle.cx) ** 2 + (full(y) - circle.cy) ** 2 > circle.r * circle.r) continue;
      for (const [dx, dy, dz] of steps) {
        const X = x + dx, Y = y + dy, Zb = z + dz;
        if (X < 0 || Y < 0 || Zb < 0 || X >= nx || Y >= ny || Zb >= nz) continue;
        const g = gray[(Zb * ny + Y) * nx + X];
        if (g >= level) continue;
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

  /** Signed deviation (mm) of every nominal point, NaN where no crossing lies within ±rangeMm inside the volume. */
  function deviations({ gray, dims, bin, voxelMm, level, circle = null, points, normals, transform, rangeMm = 2 }) {
    const at = sampler({ gray, dims, bin, voxelMm, circle });
    const { R, t, s } = transform, step = STEP_VOXELS * bin * voxelMm, n = Math.ceil(rangeMm / step);
    const out = new Float32Array(points.length / 3);
    for (let k = 0; k < out.length; k++) {
      const px = points[3 * k], py = points[3 * k + 1], pz = points[3 * k + 2], qx = normals[3 * k], qy = normals[3 * k + 1], qz = normals[3 * k + 2];
      const c = [0, 1, 2].map((r) => s * (R[3 * r] * px + R[3 * r + 1] * py + R[3 * r + 2] * pz) + t[r]);
      const d = [0, 1, 2].map((r) => R[3 * r] * qx + R[3 * r + 1] * qy + R[3 * r + 2] * qz);
      let best = NaN, prev = at(c[0] - n * step * d[0], c[1] - n * step * d[1], c[2] - n * step * d[2]);
      for (let j = -n + 1; j <= n; j++) {
        const g = at(c[0] + j * step * d[0], c[1] + j * step * d[1], c[2] + j * step * d[2]);
        if (prev >= level && g < level) { // NaN on either side fails both comparisons
          const sCross = (j - 1 + (prev - level) / (prev - g)) * step;
          if (!(Math.abs(sCross) >= Math.abs(best))) best = sCross;
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

  function deviationStats(dev, toleranceMm) {
    const v = Array.from(dev).filter(Number.isFinite).sort((a, b) => a - b), n = v.length;
    if (!n) return { measured: 0, unmeasured: dev.length, mean: null, sd: null, min: null, p05: null, p50: null, p95: null, max: null, within_percent: null };
    const mean = v.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    const within = v.filter((d) => Math.abs(d) <= toleranceMm + EPS).length;
    return { measured: n, unmeasured: dev.length - n, mean, sd, min: v[0], p05: quantile(v, 0.05), p50: quantile(v, 0.5), p95: quantile(v, 0.95), max: v[n - 1], within_percent: (100 * within) / n };
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

  return { isoLevel, matrixGray, sampler, surfacePoints, deviations, deviationStats, histogram };
}));
