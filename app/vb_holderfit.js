/* Fitting holder pieces: a flat plate or a round post from voxel coordinates (principal axes, robust extents), and the
   inside test of a fitted piece. Used by vb_holder.js; coordinates are voxels of the binned grid. A fitted piece is
   { center, axes (row-major rows: long, mid, short), half }: a plate's normal is row 3, a post's axis row 1, and a
   post's half is [half length, radius, radius]. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_align.js'));
  else root.VBHolderFit = factory(root.VBAlign);
}(typeof self !== 'undefined' ? self : this, function (A) {
  'use strict';

  const TRIM = 0.005;       // robust extents: the 0.5 and 99.5 percentiles of the projections
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  /** Centroid and principal axes of xyz triples: { mean, vectors } with vectors by decreasing variance, right-handed. */
  function pca(points) {
    const n = points.length / 3;
    if (!n) throw new Error('Cannot fit a piece to no points.');
    const mean = [0, 0, 0], ss = new Array(9).fill(0);
    for (let i = 0; i < points.length; i += 3) for (let r = 0; r < 3; r++) mean[r] += points[i + r] / n;
    for (let i = 0; i < points.length; i += 3) {
      const d = [points[i] - mean[0], points[i + 1] - mean[1], points[i + 2] - mean[2]];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) ss[3 * r + c] += (d[r] * d[c]) / n;
    }
    const { values, vectors } = A.eigenSymmetric(ss, 3);
    return { mean, values, vectors: [vectors[0], vectors[1], cross(vectors[0], vectors[1])] };
  }

  /** The [low, high] projection of the points on a direction, trimmed to the 0.5 and 99.5 percentiles. */
  function span(points, mean, dir) {
    const n = points.length / 3, p = new Float64Array(n);
    for (let i = 0; i < n; i++) p[i] = (points[3 * i] - mean[0]) * dir[0] + (points[3 * i + 1] - mean[1]) * dir[1] + (points[3 * i + 2] - mean[2]) * dir[2];
    p.sort();
    return [p[Math.floor(TRIM * (n - 1))], p[Math.ceil((1 - TRIM) * (n - 1))]];
  }

  function frame(points, mean, vectors, pad) {
    const center = mean.slice(), half = [];
    vectors.forEach((v, k) => {
      const [lo, hi] = span(points, mean, v), mid = (lo + hi) / 2;
      for (let r = 0; r < 3; r++) center[r] += mid * v[r];
      half.push((hi - lo) / 2 + pad[k]);
    });
    return { center, axes: vectors.flat(), half };
  }

  /** A flat plate from voxel coordinates: the normal is the least-variance axis; extents are robust, thickness gets
      a quarter voxel more at each face (0.5 voxel in all). */
  function fitSlab(points) {
    const { mean, vectors } = pca(points);
    return frame(points, mean, vectors, [0, 0, 0.25]);
  }

  /** The principal axis whose two partners have the most alike spreads: a round cross-section. A long post gives its
      greatest-variance axis; a short fat cap gives its least-variance one. Returned first, the others after it. */
  function roundAxis(values) {
    const alike = (c) => { const [a, b] = [0, 1, 2].filter((j) => j !== c).map((j) => values[j]); return Math.abs(Math.log(a / b)); };
    return [0, 1, 2].reduce((best, c) => (alike(c) < alike(best) ? c : best), 0);
  }

  /** A round post (or a short round cap) from the voxels of its solid body. The radius comes from the median distance
      to the axis, which for a filled disk is R / sqrt(2), so it is scaled back up by sqrt(2). axis (a unit vector),
      when known from elsewhere (the line through a chain's disk centers), replaces the principal-axis choice. */
  function fitCylinder(points, axis) {
    const { mean, vectors: all, values } = pca(points);
    const k = roundAxis(values), u0 = axis || all[k];
    const seed = Math.abs(u0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], w = cross(u0, seed), wl = Math.hypot(...w);
    const v0 = axis ? w.map((x) => x / wl) : all.filter((_, j) => j !== k)[0], vectors = [u0, v0, cross(u0, v0)];
    const [u] = vectors, n = points.length / 3, dist = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = [points[3 * i] - mean[0], points[3 * i + 1] - mean[1], points[3 * i + 2] - mean[2]];
      const a = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
      dist[i] = Math.hypot(d[0] - a * u[0], d[1] - a * u[1], d[2] - a * u[2]);
    }
    dist.sort();
    const radius = Math.SQRT2 * dist[Math.floor((n - 1) / 2)];
    const f = frame(points, mean, vectors, [0.25, 0, 0]);
    return { center: f.center, axes: f.axes, half: [f.half[0], radius, radius] };
  }

  /** Whether local coordinates q (along the piece's axes rows) lie inside a piece of this kind with half extents h. */
  const inShape = (kind, q, h) => Math.abs(q[0]) <= h[0] && (kind === 'post' ? Math.hypot(q[1], q[2]) <= h[1] : Math.abs(q[1]) <= h[1] && Math.abs(q[2]) <= h[2]);

  /** Whether a voxel center lies inside the piece: a post is a capped cylinder, a plate or tape piece a box. */
  function insidePiece(piece, x, y, z) {
    const { center: c, axes: a } = piece, dx = x - c[0], dy = y - c[1], dz = z - c[2];
    return inShape(piece.kind, [0, 3, 6].map((o) => dx * a[o] + dy * a[o + 1] + dz * a[o + 2]), piece.half);
  }

  return { pca, fitSlab, fitCylinder, inShape, insidePiece };
}));
