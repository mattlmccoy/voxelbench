/* Filler and fiber analysis: the bright phase inside the sample, labeled slice by slice into 26-connected particles
   that keep only their moments (count, centroid, second moments), so a full-resolution scan needs no label volume.
   Shape from the moments, nearest-neighbor dispersion, and the orientation tensor of resolved fibers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_align.js'));
  else root.VBFiller = factory(root.VBAlign);
}(typeof self !== 'undefined' ? self : this, function (A) {
  'use strict';

  const CLIP_ITERATIONS = 4;
  const FIBER_ASPECT = 3, FIBER_MIN_LENGTH_VOX = 3;
  const MIN_FOR_DISPERSION = 20, MIN_FIBERS_FOR_TENSOR = 5; // fewer give no Clark–Evans ratio or orientation tensor

  const medianOf = (sorted) => (sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

  /** Median and robust SD (1.4826 x MAD) of the matrix gray, re-estimated after clipping values above median + k SD
      so a bright phase does not move them; threshold = median + k SD. */
  function robustThreshold(values, k = 4) {
    let v = Float64Array.from(values).sort(), median = 0, sd = 0;
    for (let it = 0; it < CLIP_ITERATIONS; it++) {
      median = medianOf(v);
      sd = 1.4826 * medianOf(v.map((x) => Math.abs(x - median)).sort());
      const kept = v.filter((x) => x <= median + k * sd);
      if (kept.length === v.length || !kept.length) break;
      v = kept;
    }
    return { median, sd, threshold: median + k * sd, k };
  }

  // Accumulator layout per label: n, sx, sy, sz, sxx, syy, szz, sxy, sxz, syz (summed), clipped, peak gray (maxed).
  const N_ACC = 12, SUMMED = 10;

  /** 26-connected bright components over full-grid slices (getSlice(z) → Uint16/Float array of nx*ny). keep(x, y, z)
      is the sample-mask test; circle (full grid) marks particles touching the FOV edge as clipped, as are those on the
      volume's outer faces. Components under minVoxels are dropped and counted. */
  function labelBright({ getSlice, dims, keep, threshold, minVoxels = 8, circle = null }) {
    const { nx, ny, nz } = dims;
    let parent = new Int32Array(1 << 16), acc = new Float64Array(N_ACC << 16), used = 0;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => {
      a = find(a); b = find(b);
      if (a === b) return;
      if (a > b) [a, b] = [b, a];
      parent[b] = a;
      for (let k = 0; k < SUMMED; k++) acc[N_ACC * a + k] += acc[N_ACC * b + k];
      for (let k = SUMMED; k < N_ACC; k++) acc[N_ACC * a + k] = Math.max(acc[N_ACC * a + k], acc[N_ACC * b + k]);
    };
    const fresh = () => {
      if (used === parent.length) {
        const p = new Int32Array(2 * used); p.set(parent); parent = p;
        const q = new Float64Array(2 * N_ACC * used); q.set(acc); acc = q;
      }
      parent[used] = used;
      return used++;
    };
    const rEdge = circle ? (circle.r - 1.5) ** 2 : Infinity;
    const outsideCircle = (x, y) => circle && (x - circle.cx) ** 2 + (y - circle.cy) ** 2 > circle.r * circle.r;
    const overlaps = (a, b) => a.x0 <= b.x1 + 1 && b.x0 <= a.x1 + 1;
    let prev = null;
    for (let z = 0; z < nz; z++) {
      const s = getSlice(z), cur = new Array(ny);
      for (let y = 0; y < ny; y++) {
        const runs = [];
        let x0 = -1, peak = 0;
        for (let x = 0; x <= nx; x++) {
          const bright = x < nx && s[y * nx + x] >= threshold && !outsideCircle(x, y) && keep(x, y, z);
          if (bright && x0 < 0) { x0 = x; peak = 0; }
          if (bright) peak = Math.max(peak, s[y * nx + x]);
          if (!bright && x0 >= 0) { runs.push({ x0, x1: x - 1, peak, label: -1 }); x0 = -1; }
        }
        for (const r of runs) {
          const l = fresh(), o = N_ACC * l, n = r.x1 - r.x0 + 1;
          const sx = (n * (r.x0 + r.x1)) / 2, sxx = (r.x1 * (r.x1 + 1) * (2 * r.x1 + 1) - (r.x0 - 1) * r.x0 * (2 * r.x0 - 1)) / 6;
          acc[o] = n; acc[o + 1] = sx; acc[o + 2] = n * y; acc[o + 3] = n * z;
          acc[o + 4] = sxx; acc[o + 5] = n * y * y; acc[o + 6] = n * z * z; acc[o + 7] = y * sx; acc[o + 8] = z * sx; acc[o + 9] = n * y * z;
          const edge = z === 0 || z === nz - 1 || y === 0 || y === ny - 1 || r.x0 === 0 || r.x1 === nx - 1
            || (circle && ((r.x0 - circle.cx) ** 2 + (y - circle.cy) ** 2 > rEdge || (r.x1 - circle.cx) ** 2 + (y - circle.cy) ** 2 > rEdge));
          acc[o + 10] = edge ? 1 : 0;
          acc[o + 11] = r.peak;
          r.label = l;
          const join = (rows) => { if (rows) for (const q of rows) if (overlaps(q, r)) union(q.label, l); };
          if (y > 0) join(cur[y - 1]);
          if (prev) { if (y > 0) join(prev[y - 1]); join(prev[y]); if (y < ny - 1) join(prev[y + 1]); }
        }
        cur[y] = runs;
      }
      prev = cur;
    }
    const particles = [];
    let dropped = 0;
    for (let l = 0; l < used; l++) {
      if (parent[l] !== l) continue;
      const o = N_ACC * l;
      if (acc[o] < minVoxels) { dropped++; continue; }
      particles.push({ id: particles.length + 1, voxels: acc[o], clipped: acc[o + 10] > 0, peak: acc[o + 11], ...particleShape(acc.subarray(o, o + 10)) });
    }
    return { particles, dropped };
  }

  /** Shape from the moments: centroid, principal variances (each voxel's own extent of 1/12 included), aspect ratio
      √(λ1/λ3), length √(12 λ1) and diameter √(12 λ3) as for a rod, main direction, and equivalent sphere diameter. */
  function particleShape(m) {
    const n = m[0], c = [m[1] / n, m[2] / n, m[3] / n];
    const C = [m[4] / n - c[0] * c[0], m[7] / n - c[0] * c[1], m[8] / n - c[0] * c[2], 0, m[5] / n - c[1] * c[1], m[9] / n - c[1] * c[2], 0, 0, m[6] / n - c[2] * c[2]];
    C[3] = C[1]; C[6] = C[2]; C[7] = C[5];
    for (const k of [0, 4, 8]) C[k] += 1 / 12;
    const { values, vectors } = A.eigenSymmetric(C, 3);
    const lambdas = values.map((v) => Math.max(v, 1 / 12));
    return { centroid: c, lambdas, aspect: Math.sqrt(lambdas[0] / lambdas[2]), length_vox: Math.sqrt(12 * lambdas[0]), diameter_vox: Math.sqrt(12 * lambdas[2]),
      direction: vectors[0], esd_vox: Math.cbrt((6 * n) / Math.PI) };
  }

  const isFiber = (p) => p.aspect >= FIBER_ASPECT && p.length_vox >= FIBER_MIN_LENGTH_VOX;

  /** Nearest-neighbor distance of every centroid to another (voxels), by a uniform grid. */
  function nearestOther(c) {
    const n = c.length / 3, out = new Float64Array(n);
    if (n < 2) return out.fill(NaN);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < c.length; i++) { min[i % 3] = Math.min(min[i % 3], c[i]); max[i % 3] = Math.max(max[i % 3], c[i]); }
    const cell = Math.max(1e-6, Math.cbrt(((max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1)) / n));
    const g = [0, 1, 2].map((k) => Math.max(1, Math.ceil((max[k] - min[k]) / cell) + 1));
    const cellOf = (v, k) => Math.min(g[k] - 1, Math.max(0, Math.floor((v - min[k]) / cell)));
    const buckets = new Map();
    for (let i = 0; i < n; i++) { const key = (cellOf(c[3 * i + 2], 2) * g[1] + cellOf(c[3 * i + 1], 1)) * g[0] + cellOf(c[3 * i], 0); (buckets.get(key) || buckets.set(key, []).get(key)).push(i); }
    for (let i = 0; i < n; i++) {
      const q = [cellOf(c[3 * i], 0), cellOf(c[3 * i + 1], 1), cellOf(c[3 * i + 2], 2)];
      let best = Infinity;
      for (let r = 0; r <= Math.max(...g); r++) {
        if (((r - 1) * cell) ** 2 > best) break;
        for (let z = q[2] - r; z <= q[2] + r; z++) for (let y = q[1] - r; y <= q[1] + r; y++) for (let x = q[0] - r; x <= q[0] + r; x++) {
          if (Math.max(Math.abs(x - q[0]), Math.abs(y - q[1]), Math.abs(z - q[2])) !== r || x < 0 || y < 0 || z < 0 || x >= g[0] || y >= g[1] || z >= g[2]) continue;
          for (const j of buckets.get((z * g[1] + y) * g[0] + x) || []) {
            if (j === i) continue;
            const d = (c[3 * i] - c[3 * j]) ** 2 + (c[3 * i + 1] - c[3 * j + 1]) ** 2 + (c[3 * i + 2] - c[3 * j + 2]) ** 2;
            if (d < best) best = d;
          }
        }
      }
      out[i] = Math.sqrt(best);
    }
    return out;
  }

  /** Nearest-neighbor distances (voxels) and the Clark–Evans ratio: mean NN over 0.554 ρ^(−1/3), the mean NN of a
      random (Poisson) arrangement at the same number density; 1 random, below 1 clustered, above 1 regular. */
  function dispersion(particles, maskVoxels) {
    const c = new Float64Array(3 * particles.length);
    particles.forEach((p, i) => c.set(p.centroid, 3 * i));
    const nn = nearestOther(c);
    if (particles.length < 2) return { nn, mean_nn: null, clark_evans: null };
    const mean = nn.reduce((s, d) => s + d, 0) / nn.length, rho = particles.length / maskVoxels;
    return { nn, mean_nn: mean, clark_evans: particles.length >= MIN_FOR_DISPERSION ? mean / (0.554 * rho ** (-1 / 3)) : null };
  }

  /** Second-order orientation tensor a2 = Σ w p pᵀ / Σ w of the fibers' main directions, weighted by voxel count. */
  function orientationTensor(fibers) {
    if (fibers.length < MIN_FIBERS_FOR_TENSOR) return { a2: null, eigenvalues: null, direction: null, count: fibers.length, too_few: true };
    const a2 = new Array(9).fill(0);
    let w = 0;
    for (const f of fibers) {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) a2[3 * r + c] += f.voxels * f.direction[r] * f.direction[c];
      w += f.voxels;
    }
    for (let k = 0; k < 9; k++) a2[k] /= w;
    const { values, vectors } = A.eigenSymmetric(a2, 3);
    return { a2, eigenvalues: values, direction: vectors[0], count: fibers.length, too_few: false };
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = q * (sorted.length - 1), lo = Math.floor(pos), hi = Math.min(sorted.length - 1, lo + 1);
    return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
  }

  /** Counts, bright volume fraction of the mask (clipped particles included), ESD percentiles of the unclipped
      particles (mm) and the fibers' orientation tensor. */
  function summarize(particles, { maskVoxels, voxelMm }) {
    const whole = particles.filter((p) => !p.clipped), esd = whole.map((p) => p.esd_vox * voxelMm).sort((a, b) => a - b);
    const fibers = particles.filter(isFiber), voxels = particles.reduce((s, p) => s + p.voxels, 0);
    return { count: particles.length, clipped: particles.length - whole.length, fibers: fibers.length, volume_percent: maskVoxels ? (100 * voxels) / maskVoxels : null,
      esd_p10_mm: quantile(esd, 0.1), esd_p50_mm: quantile(esd, 0.5), esd_p90_mm: quantile(esd, 0.9), orientation: orientationTensor(fibers) };
  }

  const MAX_THRESHOLD_SAMPLES = 2e6;

  /** A candidate whose peak gray is within one robust SD of the detection threshold may be matrix noise. */
  const nearNoise = (peak, { sd, detection }) => peak < detection + sd;

  /** The measurement threshold: halfway between the matrix median and the bright phase's own gray, the median peak
      gray of the particles found at the detection threshold, so volumes are not inflated by the blur around small
      particles; never below detection, and detection itself when there are no particles. */
  function measurementThreshold({ median, detection }, peaks) {
    if (!peaks.length) return { bright_gray: null, threshold: detection };
    const brightGray = medianOf(Float64Array.from(peaks).sort());
    return { bright_gray: brightGray, threshold: Math.max(detection, (median + brightGray) / 2) };
  }

  /** The whole analysis on one scan: full-grid smoothed slices (getSlice), the binned sample mask (filled), the FOV
      circle on the full grid. Particles are found at the detection threshold (median + k robust SD of the sampled
      matrix gray), then labeled again at the measurement threshold, or at the given one. Lengths in the result are mm. */
  function analyzeFiller({ getSlice, dims, filled, binnedDims, bin, voxelMm, circle = null, poreThreshold, k = 4, minVoxels = 8, threshold = null }) {
    const b = binnedDims;
    const keep = (x, y, z) => {
      const bx = Math.floor(x / bin), by = Math.floor(y / bin), bz = Math.floor(z / bin);
      return bx < b.nx && by < b.ny && bz < b.nz && filled[(bz * b.ny + by) * b.nx + bx] === 1;
    };
    let maskVoxels = 0;
    for (let i = 0; i < filled.length; i++) maskVoxels += filled[i];
    maskVoxels *= bin ** 3;
    const stride = Math.max(1, Math.round(Math.cbrt(maskVoxels / MAX_THRESHOLD_SAMPLES)));
    const values = [];
    for (let z = 0; z < dims.nz; z += stride) {
      const s = getSlice(z);
      for (let y = 0; y < dims.ny; y += stride) for (let x = 0; x < dims.nx; x += stride) { const v = s[y * dims.nx + x]; if (v >= poreThreshold && keep(x, y, z)) values.push(v); }
    }
    const noise = robustThreshold(values, k);
    const label = (level) => labelBright({ getSlice, dims, keep, threshold: level, minVoxels, circle });
    const found = label(noise.threshold);
    const m = measurementThreshold({ median: noise.median, detection: noise.threshold }, found.particles.filter((p) => !p.clipped).map((p) => p.peak));
    const t = { detection: noise.threshold, median: noise.median, sd: noise.sd, k, bright_gray: m.bright_gray, threshold: threshold !== null ? threshold : m.threshold, manual: threshold !== null };
    const { particles, dropped } = t.threshold === noise.threshold ? found : label(t.threshold);
    const mm = particles.map((p) => ({ ...p, volume_mm3: p.voxels * voxelMm ** 3, esd_mm: p.esd_vox * voxelMm, length_mm: p.length_vox * voxelMm, diameter_mm: p.diameter_vox * voxelMm,
      x_mm: p.centroid[0] * voxelMm, y_mm: p.centroid[1] * voxelMm, z_mm: p.centroid[2] * voxelMm, fiber: isFiber(p), near_noise: nearNoise(p.peak, t) }));
    const d = dispersion(particles, maskVoxels);
    return { threshold: t, particles: mm, dropped, summary: { ...summarize(particles, { maskVoxels, voxelMm }), near_noise: mm.filter((p) => p.near_noise).length }, dispersion: { mean_nn_mm: d.mean_nn === null ? null : d.mean_nn * voxelMm, clark_evans: d.clark_evans },
      nn_mm: Float32Array.from(d.nn, (v) => v * voxelMm), maskVoxels, minVoxels };
  }

  return { analyzeFiller, measurementThreshold, nearNoise, MIN_FOR_DISPERSION, MIN_FIBERS_FOR_TENSOR, robustThreshold, labelBright, particleShape, isFiber, dispersion, orientationTensor, summarize, FIBER_ASPECT, FIBER_MIN_LENGTH_VOX };
}));
