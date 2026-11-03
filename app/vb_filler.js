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

  // Accumulator layout per label: n, sx, sy, sz, sxx, syy, szz, sxy, sxz, syz, clipped.
  const N_ACC = 11;

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
      for (let k = 0; k < N_ACC - 1; k++) acc[N_ACC * a + k] += acc[N_ACC * b + k];
      acc[N_ACC * a + 10] = Math.max(acc[N_ACC * a + 10], acc[N_ACC * b + 10]);
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
        let x0 = -1;
        for (let x = 0; x <= nx; x++) {
          const bright = x < nx && s[y * nx + x] >= threshold && !outsideCircle(x, y) && keep(x, y, z);
          if (bright && x0 < 0) x0 = x;
          if (!bright && x0 >= 0) { runs.push({ x0, x1: x - 1, label: -1 }); x0 = -1; }
        }
        for (const r of runs) {
          const l = fresh(), o = N_ACC * l, n = r.x1 - r.x0 + 1;
          const sx = (n * (r.x0 + r.x1)) / 2, sxx = (r.x1 * (r.x1 + 1) * (2 * r.x1 + 1) - (r.x0 - 1) * r.x0 * (2 * r.x0 - 1)) / 6;
          acc[o] = n; acc[o + 1] = sx; acc[o + 2] = n * y; acc[o + 3] = n * z;
          acc[o + 4] = sxx; acc[o + 5] = n * y * y; acc[o + 6] = n * z * z; acc[o + 7] = y * sx; acc[o + 8] = z * sx; acc[o + 9] = n * y * z;
          const edge = z === 0 || z === nz - 1 || y === 0 || y === ny - 1 || r.x0 === 0 || r.x1 === nx - 1
            || (circle && ((r.x0 - circle.cx) ** 2 + (y - circle.cy) ** 2 > rEdge || (r.x1 - circle.cx) ** 2 + (y - circle.cy) ** 2 > rEdge));
          acc[o + 10] = edge ? 1 : 0;
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
      particles.push({ id: particles.length + 1, voxels: acc[o], clipped: acc[o + 10] > 0, ...particleShape(acc.subarray(o, o + 10)) });
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

  return { robustThreshold, labelBright, particleShape, isFiber, FIBER_ASPECT, FIBER_MIN_LENGTH_VOX };
}));
