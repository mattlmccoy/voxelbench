/* Rigid (optionally uniformly scaled) alignment of the CAD points to the scan surface points: Horn's closed-form fit
   on paired points, trimmed point-to-point ICP over a uniform grid, and a principal-axes pre-alignment.
   A transform is { R: row-major 3x3, t: [3], s } and maps p to s·R·p + t. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBAlign = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const IDENTITY = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1 };
  const MAX_ICP_POINTS = 20000;
  const TRIAL_POINTS = 1000, TRIAL_STEPS = 4; // pre-alignment scores each starting pose by a short rigid ICP on few points
  const SCALE_RANGE = [0.5, 1.5]; // a fitted uniform scale is kept within this range, so the model cannot collapse

  /** Eigen-decomposition of a symmetric n x n matrix (row-major array) by cyclic Jacobi: { values, vectors } with
      vectors[k] the k-th eigenvector, sorted by decreasing value. */
  function eigenSymmetric(m, n) {
    const a = m.slice(), v = Array.from({ length: n * n }, (_, i) => (i % (n + 1) ? 0 : 1));
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
      if (off < 1e-30) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          const apq = a[p * n + q];
          if (Math.abs(apq) < 1e-300) continue;
          const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k * n + p], akq = a[k * n + q];
            a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p * n + k], aqk = a[q * n + k];
            a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k * n + p], vkq = v[k * n + q];
            v[k * n + p] = c * vkp - s * vkq; v[k * n + q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j * n + j] - a[i * n + i]);
    return { values: order.map((i) => a[i * n + i]), vectors: order.map((i) => Array.from({ length: n }, (_, k) => v[k * n + i])) };
  }

  function centroid(p, keep) {
    const c = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < p.length / 3; i++) { if (keep && !keep[i]) continue; c[0] += p[3 * i]; c[1] += p[3 * i + 1]; c[2] += p[3 * i + 2]; n++; }
    return c.map((v) => v / (n || 1));
  }

  /** Horn's quaternion fit: the transform taking src[i] to dst[i] in least squares (both flat xyz arrays). */
  function fitTransform(src, dst, { scale = false, keep = null, scaleRange = null } = {}) {
    const cs = centroid(src, keep), cd = centroid(dst, keep);
    const S = new Array(9).fill(0);
    let ss = 0;
    for (let i = 0; i < src.length / 3; i++) {
      if (keep && !keep[i]) continue;
      const a = [src[3 * i] - cs[0], src[3 * i + 1] - cs[1], src[3 * i + 2] - cs[2]], b = [dst[3 * i] - cd[0], dst[3 * i + 1] - cd[1], dst[3 * i + 2] - cd[2]];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[3 * r + c] += a[r] * b[c];
      ss += a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    }
    const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S;
    const N = [xx + yy + zz, yz - zy, zx - xz, xy - yx, yz - zy, xx - yy - zz, xy + yx, zx + xz, zx - xz, xy + yx, -xx + yy - zz, yz + zy, xy - yx, zx + xz, yz + zy, -xx - yy + zz];
    const [w, x, y, z] = eigenSymmetric(N, 4).vectors[0];
    const R = [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z];
    let s = 1;
    if (scale && ss > 0) {
      let dot = 0; // Σ b·(R a)
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) dot += R[3 * r + c] * S[3 * c + r];
      s = dot / ss;
      if (scaleRange) s = Math.min(scaleRange[1], Math.max(scaleRange[0], s));
    }
    const t = [0, 1, 2].map((r) => cd[r] - s * (R[3 * r] * cs[0] + R[3 * r + 1] * cs[1] + R[3 * r + 2] * cs[2]));
    return { R, t, s };
  }

  function apply({ R, t, s }, p) {
    const out = new Float64Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      for (let r = 0; r < 3; r++) out[i + r] = s * (R[3 * r] * x + R[3 * r + 1] * y + R[3 * r + 2] * z) + t[r];
    }
    return out;
  }

  const mul = (A, B) => Array.from({ length: 9 }, (_, i) => A[3 * Math.floor(i / 3)] * B[i % 3] + A[3 * Math.floor(i / 3) + 1] * B[3 + (i % 3)] + A[3 * Math.floor(i / 3) + 2] * B[6 + (i % 3)]);

  /** a after b. */
  function compose(a, b) {
    const Rt = [0, 1, 2].map((r) => a.R[3 * r] * b.t[0] + a.R[3 * r + 1] * b.t[1] + a.R[3 * r + 2] * b.t[2]);
    return { R: mul(a.R, b.R), t: Rt.map((v, r) => a.s * v + a.t[r]), s: a.s * b.s };
  }

  /** The pose turned 90° about a scan axis through the point `about`. */
  function rotate90(T, axis, about) {
    const R = { x: [1, 0, 0, 0, 0, -1, 0, 1, 0], y: [0, 0, 1, 0, 1, 0, -1, 0, 0], z: [0, -1, 0, 1, 0, 0, 0, 0, 1] }[axis];
    const turn = { R, t: [0, 1, 2].map((r) => about[r] - (R[3 * r] * about[0] + R[3 * r + 1] * about[1] + R[3 * r + 2] * about[2])), s: 1 };
    return compose(turn, T);
  }

  /** Nearest neighbors among fixed points over a uniform grid (CSR cells). */
  function nearestIndex(points, cell) {
    const n = points.length / 3, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.length; i++) { const k = i % 3; min[k] = Math.min(min[k], points[i]); max[k] = Math.max(max[k], points[i]); }
    const g = [0, 1, 2].map((k) => Math.max(1, Math.ceil((max[k] - min[k]) / cell) + 1));
    const cellOf = (v, k) => Math.min(g[k] - 1, Math.max(0, Math.floor((v - min[k]) / cell)));
    const key = new Int32Array(n), start = new Int32Array(g[0] * g[1] * g[2] + 1);
    for (let i = 0; i < n; i++) { key[i] = (cellOf(points[3 * i + 2], 2) * g[1] + cellOf(points[3 * i + 1], 1)) * g[0] + cellOf(points[3 * i], 0); start[key[i] + 1]++; }
    for (let c = 0; c < start.length - 1; c++) start[c + 1] += start[c];
    const fill = start.slice(0, -1), order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[fill[key[i]]++] = i;
    function nearest(x, y, z) {
      const c = [cellOf(x, 0), cellOf(y, 1), cellOf(z, 2)];
      let best = -1, d2 = Infinity;
      const visit = (ix, iy, iz) => {
        const k = (iz * g[1] + iy) * g[0] + ix;
        for (let j = start[k]; j < start[k + 1]; j++) {
          const i = order[j], d = (points[3 * i] - x) ** 2 + (points[3 * i + 1] - y) ** 2 + (points[3 * i + 2] - z) ** 2;
          if (d < d2) { d2 = d; best = i; }
        }
      };
      const reach = Math.max(...g);
      for (let r = 0; r <= reach; r++) {
        if (best >= 0 && ((r - 1) * cell) ** 2 > d2) break;
        for (let iz = c[2] - r; iz <= c[2] + r; iz++) {
          if (iz < 0 || iz >= g[2]) continue;
          for (let iy = c[1] - r; iy <= c[1] + r; iy++) {
            if (iy < 0 || iy >= g[1]) continue;
            const shell = Math.abs(iz - c[2]) === r || Math.abs(iy - c[1]) === r;
            for (let ix = c[0] - r; ix <= c[0] + r; ix += shell ? 1 : 2 * r || 1) if (ix >= 0 && ix < g[0]) visit(ix, iy, iz);
          }
        }
      }
      return { index: best, d2 };
    }
    return { nearest };
  }

  function thin(p, max) {
    const n = p.length / 3;
    if (n <= max) return p;
    const step = n / max, out = new Float64Array(3 * max);
    for (let k = 0; k < max; k++) { const i = Math.floor(k * step); out[3 * k] = p[3 * i]; out[3 * k + 1] = p[3 * i + 1]; out[3 * k + 2] = p[3 * i + 2]; }
    return out;
  }

  function extentOf(p) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) { const k = i % 3; min[k] = Math.min(min[k], p[i]); max[k] = Math.max(max[k], p[i]); }
    return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  }

  /** Trimmed point-to-point ICP from `init`: pairs farther than trim x the median pair distance are dropped. With
      scale, a rigid fit runs to convergence first and the scale is then freed within SCALE_RANGE: a free scale from a
      poor pose can otherwise shrink the model onto a patch of the target. */
  function icp(srcAll, dst, { init = IDENTITY, iterations = 60, scale = false, trim = 3, tol = 1e-4, index = null } = {}) {
    const grid = index || nearestIndex(dst, Math.max(extentOf(dst) / 48, 1e-6));
    const rigid = run(srcAll, dst, { init, iterations, scale: false, trim, tol, grid });
    return scale ? run(srcAll, dst, { init: rigid, iterations, scale: true, trim, tol, grid }) : rigid;
  }

  function run(srcAll, dst, { init, iterations, scale, trim, tol, grid }) {
    const src = thin(srcAll, MAX_ICP_POINTS), n = src.length / 3;
    const pair = new Float64Array(src.length), dist = new Float64Array(n), keep = new Uint8Array(n);
    let T = init, rms = Infinity, done = 0;
    for (;; done++) { // each pass pairs at the current pose, so the reported RMS is always that of the returned pose
      const moved = apply(T, src);
      for (let i = 0; i < n; i++) {
        const { index: j, d2 } = grid.nearest(moved[3 * i], moved[3 * i + 1], moved[3 * i + 2]);
        pair[3 * i] = dst[3 * j]; pair[3 * i + 1] = dst[3 * j + 1]; pair[3 * i + 2] = dst[3 * j + 2];
        dist[i] = Math.sqrt(d2);
      }
      const median = Float64Array.from(dist).sort()[n >> 1];
      let sum = 0, kept = 0;
      for (let i = 0; i < n; i++) { keep[i] = median === 0 || dist[i] <= trim * median ? 1 : 0; if (keep[i]) { sum += dist[i] ** 2; kept++; } }
      const now = Math.sqrt(sum / (kept || 1));
      const settled = Math.abs(rms - now) < tol;
      rms = now;
      if (settled || done === iterations) break;
      T = fitTransform(src, pair, { scale, keep, scaleRange: scale ? SCALE_RANGE : null });
    }
    return { ...T, rms, iterations: done };
  }

  function frame(p) {
    const c = centroid(p), C = new Array(9).fill(0);
    for (let i = 0; i < p.length; i += 3) {
      const d = [p[i] - c[0], p[i + 1] - c[1], p[i + 2] - c[2]];
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[3 * r + k] += d[r] * d[k];
    }
    const { vectors } = eigenSymmetric(C, 3);
    const [a, b] = vectors, e3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    return { c, axes: [a, b, e3] };
  }

  const halton = (i, b) => { let f = 1, r = 0; for (; i > 0; i = Math.floor(i / b)) { f /= b; r += f * (i % b); } return r; };
  /** Rotations spread over SO(3) (Shoemake's map of a Halton sequence), for shapes whose principal axes are
      degenerate (a cube, a cylinder's two equal axes). */
  const SPREAD = Array.from({ length: 72 }, (_, k) => {
    const u1 = halton(k + 1, 2), u2 = halton(k + 1, 3), u3 = halton(k + 1, 5);
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1), x = a * Math.sin(2 * Math.PI * u2), y = a * Math.cos(2 * Math.PI * u2), z = b * Math.sin(2 * Math.PI * u3), w = b * Math.cos(2 * Math.PI * u3);
    return [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z];
  });

  /** Starting poses: the principal axes matched under the four proper sign flips, plus the spread rotations about
      the centroids. Each is scored by a short ICP on a thinned copy; the best is refined fully. index: a nearest-
      neighbor index over dst to pair through (as icp takes), else one is built. */
  function preAlign(src, dst, { scale = false, index: given = null } = {}) {
    const fs = frame(src), fd = frame(dst), s = 1; // trial poses are scored rigid; the scale is freed only at the end
    const index = given || nearestIndex(dst, Math.max(extentOf(dst) / 48, 1e-6)), few = thin(src, TRIAL_POINTS);
    const poses = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map((flip) => {
      const R = new Array(9).fill(0); // source axis k to flip_k times target axis k
      for (let k = 0; k < 3; k++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) R[3 * r + c] += flip[k] * fd.axes[k][r] * fs.axes[k][c];
      return R;
    }).concat(SPREAD);
    let best = null;
    for (const R of poses) {
      const t = [0, 1, 2].map((r) => fd.c[r] - s * (R[3 * r] * fs.c[0] + R[3 * r + 1] * fs.c[1] + R[3 * r + 2] * fs.c[2]));
      const trial = icp(few, dst, { init: { R, t, s }, iterations: TRIAL_STEPS, index });
      if (!best || trial.rms < best.rms) best = trial;
    }
    return icp(src, dst, { init: best, scale, index });
  }

  return { IDENTITY, eigenSymmetric, fitTransform, apply, compose, rotate90, nearestIndex, icp, preAlign };
}));
