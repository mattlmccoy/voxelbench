/* Holder removal for CT scans: the holder (a plate, a round post or tape) is fitted as a simple solid and cut out of
   the sample mask. All coordinates are voxels of the binned grid, volume index i = x + nx * (y + ny * z).
   A piece is { id, kind: 'plate' | 'post' | 'tape', foundBy: 'bright' | 'shape', center, axes, half, voxels, mm3 }:
   axes are row-major rows (long, mid, short); a plate's normal is row 3 and a post's axis row 1; half is the half
   extent along each row (a post: [half length, radius, radius]). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_align.js'), require('./vb_holderseeds.js'), require('./vb_holderguard.js'));
  else root.VBHolder = factory(root.VBAlign, root.VBHolderSeeds, root.VBHolderGuard);
}(typeof self !== 'undefined' ? self : this, function (A, Seeds, Guard) {
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
      thick; an 'stl' piece is its runtime mask), widened by one voxel into the solid. labels holds piece index + 1 for
      every piece, given back or not. */
  function holderMask({ solid, dims, pieces, givenBack = [] }) {
    const { nx, ny, nz } = dims, labels = new Uint8Array(solid.length), taken = new Uint8Array(solid.length);
    const thin = pieces.some((p) => p.kind === 'tape') ? shortestRun(dims, solid) : null;
    const back = new Set(givenBack);
    pieces.forEach((p, k) => {
      const mark = (i) => { if (!labels[i]) labels[i] = k + 1; if (!back.has(p.id) && (p.kind !== 'tape' || thin[i] <= TAPE_THICKNESS)) taken[i] = 1; };
      if (p.kind === 'stl') { for (let i = 0; i < solid.length; i++) if (solid[i] && p.mask[i]) mark(i); return; } // inside the voxelized STL
      const r = [0, 1, 2].map((c) => Math.abs(p.axes[c]) * p.half[0] + Math.abs(p.axes[3 + c]) * p.half[1] + Math.abs(p.axes[6 + c]) * p.half[2] + 1);
      const lo = [0, 1, 2].map((c) => Math.max(0, Math.floor(p.center[c] - r[c]))), hi = [nx, ny, nz].map((m, c) => Math.min(m - 1, Math.ceil(p.center[c] + r[c])));
      for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
        const i = x + nx * (y + ny * z);
        if (solid[i] && insidePiece(p, x, y, z)) mark(i);
      }
    });
    return { holder: dilateIntoSolid(taken, solid, dims), labels };
  }

  // Holder finding: limits are scale-free ratios, few-voxel resolution allowances, or multiples of the part's gray spread.
  const FILL = 0.9;          // a piece's fitted shape is at least this share solid (counted inside the reconstruction)
  const EVEN_GRAY = 2;       // gray SD in a piece's core at most twice the part's main-peak spread
  const CORE = 2;            // voxels: a seed can miss this much rim; the thin size moves at most this far
  const GRAY_CORE = 3;       // voxels: the even-gray core stays this far inside the fitted surface (past the smoothing
                             // blur and the partial-volume voxel), or is the central voxel layer of a thinner piece
  const SAME_ANGLE = (5 * Math.PI) / 180; // two fits of one post: axes within 5 degrees
  const PLANE_TRY = (30 * Math.PI) / 180; // two plate fits are tried as one plate when their normals are within 30
                             // degrees (a cost bound only: the union-fit test below decides)
  const ONE_PLANE = 1.25;    // two plate fits are one plate when their points' spread across the union's best plane
                             // is at most this many times the larger member's own spread across its plane
  const SAME_SIZE = [1, 0.05]; // two fits of one post (or a post step on the next): radius or axis offset <= 1 voxel + 5 %
  const DUPLICATE = 0.5;     // a candidate with this share of its points inside a kept piece adds nothing new
  const SLACK = 1;           // voxels: a point counts as inside a piece within this of its surface (digitization)
  const RING = [0.5, 2];     // voxels: a post's wall ring, this far outside its radius
  const RING_SOLID = 0.1;    // a post grows along its axis only while its wall ring is bare (at most this share solid)
  const STEP_GAP = 2;        // voxels: a post step whose end is this close to an accepted step's end is the same post (or solid fills the gap)
  const SUPPORT = [2, 0.25]; // a post step not reaching the edge must hold something up: within 2 voxels past its far
                             // end, solid fills at least this share of its cross-section (a part's own top is bare)
  const BRIGHT_STEP = 0.5;   // an extension step on the bright path is the holder's when at least this share reads bright
  const MAX_PIECES = 254;    // holderMask labels are 8-bit (piece index + 1)

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const row = (p, k) => p.axes.slice(3 * k, 3 * k + 3);
  const angle = (a, b) => Math.acos(Math.min(1, Math.abs(dot(a, b))));
  const within = (a, b, [abs, rel]) => Math.abs(a - b) <= abs + rel * Math.max(a, b);
  const inShape = (kind, q, h) => Math.abs(q[0]) <= h[0] && (kind === 'post' ? Math.hypot(q[1], q[2]) <= h[1] : Math.abs(q[1]) <= h[1] && Math.abs(q[2]) <= h[2]);

  /** fn(i, q) for every voxel in the bounding box of the piece with its half extents grown by grow[k]; q is local. */
  function visit(piece, { nx, ny, nz }, grow, fn) {
    const { center: c, axes: a } = piece, h = piece.half.map((v, k) => v + grow[k]), q = [0, 0, 0];
    const r = [0, 1, 2].map((j) => Math.abs(a[j]) * h[0] + Math.abs(a[3 + j]) * h[1] + Math.abs(a[6 + j]) * h[2] + 1);
    const lo = [0, 1, 2].map((j) => Math.max(0, Math.floor(c[j] - r[j]))), hi = [nx, ny, nz].map((m, j) => Math.min(m - 1, Math.ceil(c[j] + r[j])));
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) {
      const d = [lo[0] - c[0], y - c[1], z - c[2]];
      for (let k = 0; k < 3; k++) q[k] = dot(d, [a[3 * k], a[3 * k + 1], a[3 * k + 2]]);
      for (let x = lo[0], i = lo[0] + nx * (y + ny * z); x <= hi[0]; x++, i++) {
        fn(i, q);
        q[0] += a[0]; q[1] += a[3]; q[2] += a[6];
      }
    }
  }

  /** Solid share of the fitted shape and the gray SD over its core, both away from the scan edge (the FOV rim reads
      dark after smoothing against the zeros outside). */
  function cues(p, { solid, nearEdge, smoothed, dims }) {
    const core = p.half.map((h) => Math.max(h - GRAY_CORE, 0.5));
    let n = 0, full = 0, m = 0, s = 0, ss = 0;
    visit(p, dims, [0, 0, 0], (i, q) => {
      if (nearEdge[i] || !inShape(p.kind, q, p.half)) return;
      n++; full += solid[i];
      if (inShape(p.kind, q, core)) { m++; s += smoothed[i]; ss += smoothed[i] * smoothed[i]; }
    });
    return { fill: n ? full / n : 0, sd: m ? Math.sqrt(Math.max(0, ss / m - (s / m) ** 2)) : Infinity };
  }

  /** Re-measure the thin size from the material's profile across it: a post's share in 0.5-voxel rings summed to an
      area, a plate's in 1-voxel layers along its normal summed to a thickness (centered on their weighted mean). Each
      bin is a share of its own voxels (unbiased by an edge cut); material past a face (a resting part, a crossing
      plate), the outermost margin bin's share, comes off that side. The window reaches 2 CORE past the fit and the
      size moves at most CORE. material is the solid, or on the bright path the solid above the holder's half-maximum
      (the part's threshold puts a brighter holder's edge past its true one, into the part where they touch). */
  function refine(p, { material, nearEdge, dims }) {
    const post = p.kind === 'post', grow = post ? [0, 2 * CORE, 2 * CORE] : [0, 0, 2 * CORE], w = p.half.map((h, k) => h + grow[k]);
    const step = post ? 0.5 : 1, bins = Math.ceil((post ? w[1] : 2 * w[2]) / step) + 1, n = new Float64Array(bins), full = new Float64Array(bins);
    visit(p, dims, grow, (i, q) => {
      if (nearEdge[i] || !inShape(p.kind, q, w)) return;
      const b = Math.floor((post ? Math.hypot(q[1], q[2]) : q[2] + w[2]) / step);
      n[b]++; full[b] += material[i];
    });
    const share = (b) => (n[b] ? full[b] / n[b] : 0), clamp = (v, h) => Math.max(h - CORE, Math.min(h + CORE, v));
    const most = Math.max(...n), span = post ? w[1] : 2 * w[2], mid = (bins - 1) / 2;
    const margin = (from, to) => { // the outermost well-filled bin (at least half the fullest) wholly past the face
      for (let b = from; from <= to ? b <= to : b >= to; b += from <= to ? 1 : -1) if (n[b] >= most / 2) return share(b);
      return 0;
    };
    const base = [post ? 0 : margin(0, Math.floor(CORE / step) - 1), margin(Math.floor(span / step), Math.ceil((span - CORE) / step))];
    let size = 0, moment = 0;
    for (let b = 0; b < bins; b++) {
      const f0 = base[post || b > mid ? 1 : 0], f = f0 < 1 ? Math.max(0, (share(b) - f0) / (1 - f0)) : 0;
      size += post ? f * Math.PI * ((b + 1) ** 2 - b ** 2) * step * step : f;
      moment += f * (b + 0.5);
    }
    if (!size) return p;
    if (post) { const r = clamp(Math.sqrt(size / Math.PI), p.half[1]); return { ...p, half: [p.half[0], r, r] }; }
    const shift = moment / size - w[2], u = row(p, 2);
    return { ...p, center: p.center.map((v, k) => v + shift * u[k]), half: [p.half[0], p.half[1], clamp(size / 2, p.half[2])] };
  }

  const passes = (p, ctx) => { const { fill, sd } = cues(p, ctx); return fill >= FILL && sd <= EVEN_GRAY * ctx.stats.spread; };
  const fit = (c, ctx) => refine({ kind: c.kind, edge: c.edge, voxels: c.voxels, points: c.points, axis: c.axis,
    ...(c.kind === 'post' ? fitCylinder(c.points, c.axis) : { ...fitSlab(c.points), flat: flatness(c.points) }) }, ctx);

  /** Two posts' center-line axes averaged by size (sign-aligned); undefined for plates. */
  function meanAxis(k, f) {
    if (!k.axis || !f.axis) return undefined;
    const sign = dot(k.axis, f.axis) < 0 ? -1 : 1, m = k.axis.map((v, j) => k.voxels * v + sign * f.voxels * f.axis[j]), len = Math.hypot(...m);
    return m.map((v) => v / len);
  }

  /** Spread of points across their best plane: the square root of the least principal variance. */
  const flatness = (points) => Math.sqrt(Math.max(0, pca(points).values[2]));

  /** Two fits of the same plate (their points lie on one plane about as tightly as each alone; fragments of one plate
      can tilt several degrees apart, more at finer voxels) or the same post step (coaxial, same radius). */
  function samePiece(a, b, union) {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'plate') return angle(row(a, 2), row(b, 2)) <= PLANE_TRY && flatness(union()) <= ONE_PLANE * Math.max(a.flat, b.flat);
    if (angle(row(a, 0), row(b, 0)) > SAME_ANGLE) return false;
    const d = sub(b.center, a.center), u = row(a, 0), t = dot(d, u), off = Math.hypot(d[0] - t * u[0], d[1] - t * u[1], d[2] - t * u[2]);
    return within(a.half[1], b.half[1], SAME_SIZE) && off <= SAME_SIZE[0] + SAME_SIZE[1] * a.half[1];
  }

  /** Share of the points (xyz triples) inside piece p grown by SLACK. */
  function shareInside(points, p) {
    const grown = { ...p, half: p.half.map((h) => h + SLACK) }; let k = 0;
    for (let i = 0; i < points.length; i += 3) if (insidePiece(grown, points[i], points[i + 1], points[i + 2])) k++;
    return k / (points.length / 3);
  }

  /** Fits that pass the fill and even-gray cues, with fits of the same piece merged until none is left to merge (a
      merge that fails the cues is not made), then candidates mostly inside a larger one dropped. */
  function candidates(chains, ctx) {
    const list = chains.map((c) => fit(c, ctx)).filter((f) => passes(f, ctx)).sort((a, b) => b.voxels - a.voxels);
    const failed = new Set(), ids = new Map(), pair = (k, f) => [k, f].map((x) => { if (!ids.has(x)) ids.set(x, ids.size); return ids.get(x); }).join();
    for (let merged = true; merged;) {
      merged = false;
      for (let a = 0; a < list.length && !merged; a++) for (let b = a + 1; b < list.length && !merged; b++) {
        const [k, f] = [list[a], list[b]];
        let points = null;
        const union = () => {
          if (!points) { points = new Float32Array(k.points.length + f.points.length); points.set(k.points); points.set(f.points, k.points.length); }
          return points;
        };
        if (failed.has(pair(k, f)) || !samePiece(k, f, union)) continue;
        union();
        const m = fit({ kind: k.kind, edge: k.edge || f.edge, voxels: k.voxels + f.voxels, points, axis: meanAxis(k, f) }, ctx);
        if (passes(m, ctx)) { list[a] = m; list.splice(b, 1); merged = true; } else failed.add(pair(k, f));
      }
    }
    const kept = [];
    list.sort((a, b) => b.voxels - a.voxels).forEach((f) => { if (!kept.some((k) => shareInside(f.points, k) >= DUPLICATE)) kept.push(f); });
    return kept;
  }

  /** A post step not reaching the edge itself sits on an accepted step (coaxial and end to end, or across a gap that solid
      fills no longer than the radius drop: a chamfer, a seam) and holds something up past its far end. Else a round part centered on a post is one more step. */
  function onStep(p, s, ctx) {
    if (p.kind !== 'post' || s.kind !== 'post' || angle(row(p, 0), row(s, 0)) > SAME_ANGLE) return false;
    const u = row(s, 0), d = sub(p.center, s.center), t = dot(d, u), off = Math.hypot(d[0] - t * u[0], d[1] - t * u[1], d[2] - t * u[2]);
    const gap = Math.abs(t) - p.half[0] - s.half[0], r = Math.max(Math.min(p.half[1], s.half[1]) - 1, Math.min(p.half[1], s.half[1]) / 2);
    if (off > SAME_SIZE[0] + SAME_SIZE[1] * Math.max(p.half[1], s.half[1]) || (gap > STEP_GAP && (gap > Math.abs(p.half[1] - s.half[1]) + STEP_GAP || cues({ kind: 'post', axes: s.axes, half: [gap / 2, r, r], center: s.center.map((v, k) => v + Math.sign(t) * (s.half[0] + gap / 2) * u[k]) }, ctx).fill < FILL))) return false;
    const away = Math.sign(dot(row(p, 0), d)) || 1, inner = Math.max(p.half[1] - 1, p.half[1] / 2);
    let n = 0, full = 0;
    visit(p, ctx.dims, [SUPPORT[0], 0, 0], (i, q) => {
      const over = away * q[0] - p.half[0];
      if (over <= 0 || over > SUPPORT[0] || ctx.nearEdge[i] || Math.hypot(q[1], q[2]) > inner) return;
      n++; full += ctx.solid[i];
    });
    return n > 0 && full >= SUPPORT[1] * n;
  }

  /** Grow a piece along its long axes (a post's axis; a plate's two in-plane axes) one voxel step at a time while the
      cross-section (less its rim) stays the piece's; a post also needs its wall ring bare of material (as in refine). */
  function extend(p, { material: solid, core, nearEdge, smoothed, dims }) {
    const reach = Math.ceil(Math.hypot(dims.nx, dims.ny, dims.nz));
    for (const a of p.kind === 'post' ? [0] : [0, 1]) {
      const cells = [0, 1].map(() => ({ n: new Float64Array(reach + 2), full: new Float64Array(reach + 2), mat: new Float64Array(reach + 2), ring: new Float64Array(reach + 2), ringFull: new Float64Array(reach + 2), gray: new Float64Array(reach + 2) }));
      const grow = [0, 0, 0];
      grow[a] = reach;
      if (p.kind === 'post') grow[1] = grow[2] = RING[1];
      const inner = p.half.map((h) => Math.max(h - 1, h / 2)); // the cross-section less its one-voxel rim
      visit(p, dims, grow, (i, q) => {
        const over = Math.abs(q[a]) - p.half[a];
        if (over <= 0 || nearEdge[i]) return;
        const j = Math.ceil(over);
        if (j > reach) return;
        const cell = cells[q[a] > 0 ? 1 : 0];
        if (p.kind === 'post') {
          const r = Math.hypot(q[1], q[2]);
          if (r <= inner[1]) { cell.n[j]++; cell.full[j] += core[i]; cell.mat[j] += solid[i]; cell.gray[j] += smoothed[i]; } else if (r > p.half[1] + RING[0] && r <= p.half[1] + RING[1]) { cell.ring[j]++; cell.ringFull[j] += solid[i]; }
        } else if (Math.abs(q[1 - a]) <= inner[1 - a] && Math.abs(q[2]) <= inner[2]) { cell.n[j]++; cell.full[j] += core[i]; cell.mat[j] += solid[i]; }
      });
      // A step passes when it and the one before are filled with material together (aliasing against a slightly tilted
      // fit) and a post's wall ring is bare. It is the piece's when at least BRIGHT_STEP of it is core (bright on the
      // bright path, which a part's facet is not) or it ends a run of filled layers before an unfilled one: a bright face
      // against air reads below the bright cut, one layer or (a post, its wall ring bare) a ramp darkening layer by layer away from it (a part reads level).
      // The piece ends at the last such step filled on its own.
      const steps = cells.map((c) => {
        const filled = (j) => c.n[j] > 0 && c.mat[j] >= FILL * c.n[j]; let last = 0;
        for (let j = 1; j <= reach && c.n[j] > 0 && c.ringFull[j] <= RING_SOLID * c.ring[j] && c.mat[j - 1] + c.mat[j] >= FILL * (c.n[j - 1] + c.n[j]); j++) {
          if (c.full[j] >= BRIGHT_STEP * c.n[j]) { if (filled(j)) last = j; continue; }
          const ramp = (k) => p.kind === 'post' && c.gray[k] * c.n[k - 1] < c.gray[k - 1] * c.n[k] && c.ringFull[k] <= RING_SOLID * c.ring[k] && c.full[k] < BRIGHT_STEP * c.n[k];
          for (let k = j; k <= reach && filled(k) && (k === j || ramp(k)); k++) if (!filled(k + 1)) last = k; break;
        }
        return last;
      });
      const u = row(p, a), shift = (steps[1] - steps[0]) / 2;
      p.center = p.center.map((v, k) => v + shift * u[k]);
      p.half = p.half.slice();
      p.half[a] += (steps[0] + steps[1]) / 2;
    }
    return p;
  }

  /** Candidates from chains to accepted, extended pieces with ids in order of size. */
  function accept(chains, ctx, foundBy) {
    const cands = candidates(chains, ctx);
    // Every piece, bright or not, reaches the scan edge (its seed, or itself once extended: plates on a base inside the field reach it only through the base,
    // their slice runs stopping where they meet) or is a post step holding something up on one that does: a doped region of a part, in a bright body, does neither.
    const ext = new Map(), grow = (c) => ext.get(c) || ext.set(c, extend({ kind: c.kind, center: c.center, axes: c.axes, half: c.half }, ctx)).get(c);
    const reaches = (p, hit = false) => { visit(p, ctx.dims, [0, 0, 0], (i, q) => { hit = hit || (ctx.material[i] === 1 && inShape(p.kind, q, p.half) && Seeds.atEdge(i, ctx.nearEdge, ctx.dims)); }); return hit; };
    const ok = cands.filter((c) => c.edge || (reaches(grow(c)) && (grow(c).through = true))); // through: reached the edge only once extended
    const steps = []; // [step, the step it sits on]: the solid between them (a chamfer, a seam) is the post's too
    for (let grew = true; grew;) { grew = false; for (const c of cands) { const s = !ok.includes(c) && ok.find((x) => onStep(c, x, ctx)); if (s) { ok.push(c); steps.push([c, s]); grew = true; } } }
    // Extend the largest first; a later candidate mostly inside an extended piece is a fragment of it.
    const grown = [];
    ok.sort((a, b) => b.voxels - a.voxels).forEach((c) => { if (!grown.some((g) => shareInside(c.points, g) >= DUPLICATE)) grown.push(grow(c)); });
    steps.forEach(([c, s]) => { const g = grow(c), h = grow(s), u = row(h, 0), t = dot(sub(g.center, h.center), u), gap = Math.abs(t) - g.half[0] - h.half[0]; if (gap > 0 && grown.includes(g) && grown.includes(h)) { g.half = [g.half[0] + gap / 2, g.half[1], g.half[2]]; g.center = g.center.map((v, k) => v - Math.sign(t) * (gap / 2) * u[k]); } });
    if (grown.length > MAX_PIECES) throw new Error(`Found ${grown.length} holder pieces; at most ${MAX_PIECES} can be labeled.`);
    const pieces = grown.map((p) => {
      let voxels = 0;
      visit(p, ctx.dims, [0, 0, 0], (i, q) => { if (ctx.solid[i] && inShape(p.kind, q, p.half)) voxels++; });
      return { id: '', kind: p.kind, foundBy, center: p.center, axes: p.axes, half: p.half, voxels, mm3: voxels * ctx.voxelMm ** 3, ...(p.through ? { through: true } : {}) };
    }).filter((p) => p.voxels > 0).sort((a, b) => b.voxels - a.voxels);
    pieces.forEach((p, k) => { p.id = 'h' + (k + 1); });
    return pieces;
  }

  /** Find the holder pieces in a binned volume: by brightness when a bright holder-sized body exists, else by shape.
      onProgress('Finding the holder', k, total) runs once per slice per direction (total = nx + ny + nz). */
  function findHolder({ smoothed, solid, outside, dims, voxelMm, onProgress }) {
    const stage = 'Finding the holder', total = dims.nx + dims.ny + dims.nz;
    let k = 0;
    const tick = () => { if (onProgress) onProgress(stage, ++k, total); };
    const stats = Seeds.grayStats(smoothed, solid, dims);
    if (!stats) { if (onProgress) onProgress(stage, total, total); return { method: 'none', pieces: [] }; }
    const nearEdge = Seeds.nearEdgeMask(outside, dims), ctx = { solid, material: solid, core: solid, outside, nearEdge, smoothed, dims, stats, voxelMm };
    const run = (mask) => { k = 0; return Seeds.sliceChains(mask, nearEdge, dims, tick); };
    for (const pop of Seeds.brightPopulations(stats)) { // brightest first: resin before a doped part's brighter melt
      const bright = Seeds.brightBody(smoothed, solid, nearEdge, dims, stats, pop);
      if (!bright) continue;
      const edge = (bright.peak + Seeds.airPeak(smoothed, solid, outside)) / 2, material = new Uint8Array(solid.length);
      for (let i = 0; i < solid.length; i++) material[i] = solid[i] && smoothed[i] > edge ? 1 : 0;
      const pieces = accept(run(bright.mask), { ...ctx, material, core: bright.mask }, 'bright').map(({ through, ...p }) => p);
      if (pieces.length) return { method: 'bright', pieces };
    }
    const pieces = Guard.keepPart(accept(run(solid), ctx, 'shape'), ctx, holderMask); // taking the pieces must leave the part
    return { method: pieces.length ? 'shape' : 'none', pieces };
  }

  return { fitSlab, fitCylinder, insidePiece, shortestRun, holderMask, findHolder };
}));
