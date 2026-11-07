/* Holder removal for CT scans: the holder (a plate, a round post or tape) is fitted as a simple solid and cut out of
   the sample mask. All coordinates are voxels of the binned grid, volume index i = x + nx * (y + ny * z).
   A piece is { id, kind: 'plate' | 'post' | 'tape', foundBy: 'bright' | 'shape', center, axes, half, voxels, mm3 }:
   axes are row-major rows (long, mid, short); a plate's normal is row 3 and a post's axis row 1; half is the half
   extent along each row (a post: [half length, radius, radius]). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_align.js'));
  else root.VBHolder = factory(root.VBAlign);
}(typeof self !== 'undefined' ? self : this, function (A) {
  'use strict';

  const TRIM = 0.005;       // robust extents: the 0.5 and 99.5 percentiles of the projections
  const TAPE_THICKNESS = 2; // tape is the solid that is at most this many voxels thick along some axis
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
      to the axis, which for a filled disk is R / sqrt(2), so it is scaled back up by sqrt(2). */
  function fitCylinder(points) {
    const { mean, vectors: all, values } = pca(points);
    const k = roundAxis(values), rest = all.filter((_, j) => j !== k), vectors = [all[k], rest[0], cross(all[k], rest[0])];
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

  /** Whether a voxel center lies inside the piece: a post is a capped cylinder, a plate or tape piece a box. */
  function insidePiece(piece, x, y, z) {
    const { center: c, axes: a, half: h } = piece, dx = x - c[0], dy = y - c[1], dz = z - c[2];
    const q = [0, 3, 6].map((o) => dx * a[o] + dy * a[o + 1] + dz * a[o + 2]);
    if (Math.abs(q[0]) > h[0]) return false;
    return piece.kind === 'post' ? Math.hypot(q[1], q[2]) <= h[1] : Math.abs(q[1]) <= h[1] && Math.abs(q[2]) <= h[2];
  }

  /** Per solid voxel, the shortest run of solid voxels through it along x, y or z (0 for air). */
  function shortestRun({ nx, ny, nz }, solid) {
    const out = new Uint16Array(solid.length).fill(65535), strides = [1, nx, nx * ny], sizes = [nx, ny, nz];
    for (let ax = 0; ax < 3; ax++) {
      const s = strides[ax], len = sizes[ax], o1 = strides[(ax + 1) % 3], n1 = sizes[(ax + 1) % 3], o2 = strides[(ax + 2) % 3], n2 = sizes[(ax + 2) % 3];
      for (let b = 0; b < n2; b++) for (let a = 0; a < n1; a++) {
        const base = a * o1 + b * o2;
        for (let k = 0; k < len;) {
          if (!solid[base + k * s]) { k++; continue; }
          let e = k;
          while (e < len && solid[base + e * s]) e++;
          for (let j = k; j < e; j++) if (e - k < out[base + j * s]) out[base + j * s] = e - k;
          k = e;
        }
      }
    }
    for (let i = 0; i < out.length; i++) if (!solid[i]) out[i] = 0;
    return out;
  }

  /** Widen a mask by one 6-neighbor step into solid voxels that touch air (or the volume edge). Those are the holder's
      partial-volume rim; a solid neighbor with solid on every side, such as the part's layer against the holder, stays. */
  function dilateIntoSolid(mask, solid, { nx, ny, nz }) {
    const out = new Uint8Array(mask.length), plane = nx * ny;
    const open = (i, x, y, z) => x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || z === 0 || z === nz - 1
      || !solid[i - 1] || !solid[i + 1] || !solid[i - nx] || !solid[i + nx] || !solid[i - plane] || !solid[i + plane];
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (!solid[i]) continue;
      if (mask[i]) { out[i] = 1; continue; }
      const near = (x > 0 && mask[i - 1]) || (x < nx - 1 && mask[i + 1]) || (y > 0 && mask[i - nx]) || (y < ny - 1 && mask[i + nx])
        || (z > 0 && mask[i - plane]) || (z < nz - 1 && mask[i + plane]);
      if (near && open(i, x, y, z)) out[i] = 1;
    }
    return out;
  }

  /** The holder mask: solid voxels inside a piece not given back (tape pieces only where the solid is at most 2 voxels
      thick), widened by one voxel into the solid. labels holds piece index + 1 for every piece, given back or not. */
  function holderMask({ solid, dims, pieces, givenBack = [] }) {
    const { nx, ny, nz } = dims, labels = new Uint8Array(solid.length), taken = new Uint8Array(solid.length);
    const thin = pieces.some((p) => p.kind === 'tape') ? shortestRun(dims, solid) : null;
    const back = new Set(givenBack);
    pieces.forEach((p, k) => {
      const r = [0, 1, 2].map((c) => Math.abs(p.axes[c]) * p.half[0] + Math.abs(p.axes[3 + c]) * p.half[1] + Math.abs(p.axes[6 + c]) * p.half[2] + 1);
      const lo = [0, 1, 2].map((c) => Math.max(0, Math.floor(p.center[c] - r[c]))), hi = [nx, ny, nz].map((m, c) => Math.min(m - 1, Math.ceil(p.center[c] + r[c])));
      for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
        const i = x + nx * (y + ny * z);
        if (!solid[i] || !insidePiece(p, x, y, z)) continue;
        if (!labels[i]) labels[i] = k + 1;
        if (!back.has(p.id) && (p.kind !== 'tape' || thin[i] <= TAPE_THICKNESS)) taken[i] = 1;
      }
    });
    return { holder: dilateIntoSolid(taken, solid, dims), labels };
  }

  return { fitSlab, fitCylinder, insidePiece, holderMask };
}));
