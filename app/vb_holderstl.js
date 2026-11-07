/* Holder removal from the holder's own STL: the STL (mm) is aligned rigidly to the scan's solid surface (vb_align
   pre-alignment, then trimmed ICP), and every solid voxel inside the aligned mesh is holder. The part touching the
   holder does not pull the fit: only STL samples inside the field are paired, from the STL to the scan, and where the
   part hides a holder face its samples pair with the part's face in the same plane; trimming bounds the outliers.
   The fit is reported by scoreFit (near share and in-field coverage). A pose { R, t } maps STL mm to voxels as R·p + t: R is a rotation times voxels
   per mm (the fit itself is rigid; R carries only the unit), so one pose form serves the worker grid and native voxels.
   Grid volume index i = x + nx * (y + ny * z). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_align.js'), require('./vb_stl.js'), require('./vb_cad.js'), require('./vb_holder.js'));
  else root.VBHolderStl = factory(root.VBAlign, root.VBStl, root.VBCad, root.VBHolder);
}(typeof self !== 'undefined' ? self : this, function (A, St, Cad, H) {
  'use strict';

  const FIT_MIN_NEAR = 0.6;  // a fit holds when this share of the in-field STL surface lies on the scanned surface
  const MIN_IN_FIELD = 0.1;  // and at least this share of the whole STL surface lies in the scan's field (else a patch)
  const MAX_SURFACE_POINTS = 250000; // ICP targets: face points thinned evenly beyond this (as vb_align thins sources)
  const ROUNDS = 3;          // refits, each pairing only the STL samples inside the scan's field at the last pose
  const FIT_POINTS = 5000;   // STL samples per fit, spread evenly by area (the share's sampling error is about 1 %)
  const TOL = 0.01;          // voxels: ICP stops when the trimmed RMS changes by less than this
  const START_CELLS = 16;    // the start search's grid spans the target in this many cells (vb_align uses 48): its
                             // clamped queries sit in empty box corners, which a coarse grid reaches in few rings
  const SEED_GROW = 1;       // voxels: seed pieces are grown by this to collect their surface points
  const MIN_POINTS = 100;    // too few points on either side to align
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  const place = ({ R, t }, x, y, z) => [R[0] * x + R[1] * y + R[2] * z + t[0], R[3] * x + R[4] * y + R[5] * z + t[1], R[6] * x + R[7] * y + R[8] * z + t[2]];

  /** Edge function of the (y, z) point p against edge a -> b, computed from the endpoints in a fixed order so the
      triangle on the other side of a shared edge gets exactly the negated value. */
  function edge(ay, az, by, bz, py, pz) {
    if (ay < by || (ay === by && az < bz)) return (by - ay) * (pz - az) - (bz - az) * (py - ay);
    return -((ay - by) * (pz - bz) - (az - bz) * (py - by));
  }
  // On an edge (w = 0), a counter-clockwise triangle owns the point when the edge runs this way: a fixed half-open
  // half-plane of directions, so of two triangles sharing an edge or a vertex exactly one counts a ray through it.
  const owns = (dy, dz) => dz > 0 || (dz === 0 && dy < 0);

  /** fn(column, x, sign) for every crossing of a ray along x through the voxel centers (y, z) with a triangle; sign is
      +1 entering (the face looks toward -x), -1 leaving. Faces parallel to x are skipped. */
  function crossings(v, { ny, nz }, fn) {
    for (let o = 0; o < v.length; o += 9) {
      let ay = v[o + 1], az = v[o + 2], by = v[o + 4], bz = v[o + 5], cy = v[o + 7], cz = v[o + 8], ax = v[o], bx = v[o + 3], cx = v[o + 6];
      const area = (by - ay) * (cz - az) - (bz - az) * (cy - ay); // the face normal's x times twice the area
      if (area === 0) continue;
      const sign = area < 0 ? 1 : -1;
      if (area < 0) { [by, cy] = [cy, by]; [bz, cz] = [cz, bz]; [bx, cx] = [cx, bx]; } // counter-clockwise in (y, z)
      const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy))), y1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy)));
      const z0 = Math.max(0, Math.ceil(Math.min(az, bz, cz))), z1 = Math.min(nz - 1, Math.floor(Math.max(az, bz, cz)));
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
        const wa = edge(by, bz, cy, cz, y, z), wb = edge(cy, cz, ay, az, y, z), wc = edge(ay, az, by, bz, y, z);
        if (wa < 0 || wb < 0 || wc < 0) continue;
        if ((wa === 0 && !owns(cy - by, cz - bz)) || (wb === 0 && !owns(ay - cy, az - cz)) || (wc === 0 && !owns(by - ay, bz - az))) continue;
        fn(y + ny * z, (wa * ax + wb * bx + wc * cx) / (wa + wb + wc), sign);
      }
    }
  }

  /** Voxels whose centers lie inside the mesh placed by pose, column by column along x. Inside is a nonzero winding
      count of the crossings before the voxel center; a column whose crossings do not sum to zero (an open mesh or a
      flipped face) falls back to ray parity. For one closed shell both rules agree; overlapping shells stay inside. */
  function voxelizeMesh({ triangles, pose, dims }) {
    const { nx, ny, nz } = dims, v = new Float64Array(triangles.length), out = new Uint8Array(nx * ny * nz);
    for (let i = 0; i < triangles.length; i += 3) v.set(place(pose, triangles[i], triangles[i + 1], triangles[i + 2]), i);
    const start = new Int32Array(ny * nz + 1);
    crossings(v, dims, (col) => { start[col + 1]++; });
    for (let c = 0; c < ny * nz; c++) start[c + 1] += start[c];
    const xs = new Float64Array(start[ny * nz]), sg = new Int8Array(xs.length), fill = start.slice(0, -1);
    crossings(v, dims, (col, x, sign) => { xs[fill[col]] = x; sg[fill[col]++] = sign; });
    for (let col = 0; col < ny * nz; col++) {
      const a = start[col], b = start[col + 1];
      if (b - a < 2) continue;
      for (let i = a + 1; i < b; i++) { // insertion sort by x: a column crosses few faces
        const x = xs[i], s = sg[i];
        let j = i - 1;
        for (; j >= a && xs[j] > x; j--) { xs[j + 1] = xs[j]; sg[j + 1] = sg[j]; }
        xs[j + 1] = x; sg[j + 1] = s;
      }
      let total = 0;
      for (let i = a; i < b; i++) total += sg[i];
      const base = nx * col;
      for (let i = a, w = 0; i < b - 1; i++) { // voxel x takes the state after every crossing below it
        w += total === 0 ? sg[i] : 1;
        if (total === 0 ? w === 0 : w % 2 === 0) continue;
        const x0 = Math.max(0, Math.floor(xs[i]) + 1), x1 = Math.min(nx - 1, Math.floor(xs[i + 1]));
        for (let x = x0; x <= x1; x++) out[base + x] = 1;
      }
    }
    return out;
  }

  /** Faces between a solid voxel and in-field air (bit d set for direction DIRS[d]; the volume edge and the outside
      of the FOV are cuts, not surface), and their midpoints in voxel coordinates, thinned to MAX_SURFACE_POINTS. */
  function scanSurface(solid, outside, { nx, ny, nz }) {
    const faces = new Uint8Array(solid.length), step = [1, -1, nx, -nx, nx * ny, -nx * ny];
    let total = 0;
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (!solid[i]) continue;
      const inside = [x < nx - 1, x > 0, y < ny - 1, y > 0, z < nz - 1, z > 0];
      for (let d = 0; d < 6; d++) {
        const j = i + step[d];
        if (inside[d] && !solid[j] && !(outside && outside[j])) { faces[i] |= 1 << d; total++; }
      }
    }
    const keep = Math.min(total, MAX_SURFACE_POINTS), every = total / (keep || 1), points = new Float64Array(3 * keep);
    for (let i = 0, k = 0, w = 0; i < faces.length && w < keep; i++) {
      if (!faces[i]) continue;
      for (let d = 0; d < 6; d++) {
        if (!(faces[i] & (1 << d))) continue;
        if (k++ !== Math.floor(w * every)) continue;
        const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
        points.set([x + DIRS[d][0] / 2, y + DIRS[d][1] / 2, z + DIRS[d][2] / 2], 3 * w++);
      }
    }
    return { faces, points };
  }

  /** Whether a scan face midpoint lies within one voxel of (x, y, z) (voxel coordinates). */
  function nearFace(faces, { nx, ny, nz }, x, y, z) {
    for (let k = Math.max(0, Math.ceil(z - 1.5)); k <= Math.min(nz - 1, Math.floor(z + 1.5)); k++) {
      for (let j = Math.max(0, Math.ceil(y - 1.5)); j <= Math.min(ny - 1, Math.floor(y + 1.5)); j++) {
        for (let i = Math.max(0, Math.ceil(x - 1.5)); i <= Math.min(nx - 1, Math.floor(x + 1.5)); i++) {
          const f = faces[i + nx * (j + ny * k)];
          if (f) for (let d = 0; d < 6; d++) if (f & (1 << d) && (i + DIRS[d][0] / 2 - x) ** 2 + (j + DIRS[d][1] / 2 - y) ** 2 + (k + DIRS[d][2] / 2 - z) ** 2 <= 1) return true;
        }
      }
    }
    return false;
  }

  /** A nearest-neighbor index for the start search (vb_align's grid, START_CELLS cells across) that pairs a query outside the
      points' bounding box through the query clamped into the box, reporting the true distance to that neighbor. An
      exact search from far off the box sweeps most of the grid; those pairs are outliers that trimming drops. */
  function clampedIndex(points) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.length; i++) { const k = i % 3; min[k] = Math.min(min[k], points[i]); max[k] = Math.max(max[k], points[i]); }
    const grid = A.nearestIndex(points, Math.max((Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2])) / START_CELLS, 1e-6));
    const clamp = (v, k) => Math.min(max[k], Math.max(min[k], v));
    return {
      nearest(x, y, z) {
        const { index } = grid.nearest(clamp(x, 0), clamp(y, 1), clamp(z, 2));
        return { index, d2: (points[3 * index] - x) ** 2 + (points[3 * index + 1] - y) ** 2 + (points[3 * index + 2] - z) ** 2 };
      },
    };
  }

  /** Whether voxel coordinates fall on a voxel of the volume inside the FOV. */
  function inField(outside, { nx, ny, nz }, x, y, z) {
    const i = Math.round(x), j = Math.round(y), k = Math.round(z);
    return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && !(outside && outside[i + nx * (j + ny * k)]);
  }

  /** Fit the holder STL (triangles in mm) to the solid's surface. seeds: holder pieces found by shape or brightness;
      when any, the surface inside them is first pre-aligned into the STL, else the whole surface is. Then trimmed
      rigid ICP against the whole surface, pairing the STL samples inside the scan's field. Returns { pose, rmsMm,
      nearShare, inField, inFieldShare, fits } (see scoreFit); pose is null when nothing could be aligned. cache (an
      object, one per mask build: the same solid) keeps the scan surface for every fit and each STL's samples for every
      fit of that STL. */
  function fitHolderStl({ triangles, solid, outside = null, dims, voxelMm, seeds = [], cache = null }) {
    const { scan, all, sample, score } = prepared(cache, { triangles, solid, outside, dims, voxelMm });
    const none = { pose: null, rmsMm: Infinity, nearShare: 0, inField: 0, inFieldShare: 0, fits: false };
    if (scan.length < 3 * MIN_POINTS || all.length < 3 * MIN_POINTS) return none;
    let target = scan;
    if (seeds.length) {
      const grown = seeds.map((s) => ({ ...s, half: s.half.map((h) => h + SEED_GROW) })), near = [];
      for (let k = 0; k < scan.length; k += 3) if (grown.some((s) => H.insidePiece(s, scan[k], scan[k + 1], scan[k + 2]))) near.push(scan[k], scan[k + 1], scan[k + 2]);
      const count = Math.min(near.length / 3, FIT_POINTS), every = near.length / 3 / count; // thinned evenly in scan order
      if (count >= MIN_POINTS) {
        target = new Float64Array(3 * count);
        for (let j = 0; j < count; j++) target.set(near.slice(3 * Math.floor(j * every), 3 * Math.floor(j * every) + 3), 3 * j);
      }
    }
    // Starts: the seeds' surface pre-aligned into the STL and inverted (a partial view pairs into the complete model,
    // and STL surface outside the field, far from every scan point and slow to pair, is never paired), with its three
    // half turns about the seeds' principal axes, which a symmetric seed (a cylinder, a slab) cannot tell apart; or,
    // without seeds, pre-alignment's scored start against the whole surface. The refit with the most surface wins.
    let starts;
    if (target !== scan) {
      const stl = sample(null), B = A.preAlign(target, stl, { index: clampedIndex(stl) }), Rt = [0, 1, 2].flatMap((r) => [B.R[r], B.R[3 + r], B.R[6 + r]]);
      const T0 = { R: Rt, t: place({ R: Rt, t: [0, 0, 0] }, ...B.t).map((v) => -v), s: 1 };
      starts = [T0, ...halfTurns(target).map((F) => A.compose(F, T0))];
    } else starts = [A.preAlign(sample(null), scan, { index: clampedIndex(scan) })];
    let best = none;
    for (let T of starts) {
      let src = null;
      for (let r = 0; r < ROUNDS && T; r++) {
        src = sample(T);
        T = src.length >= 3 * MIN_POINTS ? A.icp(src, scan, { init: T, tol: TOL }) : null;
      }
      if (!T) continue;
      const fit = score(T);
      if (better(fit, best)) best = { pose: { R: T.R.map((v) => v / voxelMm), t: T.t.slice() }, rmsMm: T.rms * voxelMm, ...fit };
    }
    return best;
  }

  /** The scan surface and the STL's samples for a fit: sample(T) gives area-even samples (voxel units) of the STL
      points inside the field at pose T (STL voxel units to grid voxels), or of all of them without T; score(T) rates
      pose T (see scoreFit). */
  function prepare({ triangles, solid, outside, dims, voxelMm, surface = scanSurface(solid, outside, dims) }) {
    const { faces, points: scan } = surface;
    const m = St.measurePoints(St.meshOf(triangles), { spacing: voxelMm }), all = Float64Array.from(m.points, (v) => v / voxelMm);
    let area = 0;
    for (let k = 0; k < m.weight.length; k++) area += m.weight[k];
    const inside = (T) => { // the STL points inside the field at T, and their share of the STL's area
      const idx = [];
      let a = 0;
      for (let k = 0; k < all.length / 3; k++) if (inField(outside, dims, ...place(T, all[3 * k], all[3 * k + 1], all[3 * k + 2]))) { idx.push(k); a += m.weight[k]; }
      return { idx, share: area > 0 ? a / area : 0 };
    };
    const sample = (T, idx = T && inside(T).idx) => {
      if (!T) return Cad.areaSample(all, m.weight, m.edge, FIT_POINTS);
      const p = new Float64Array(3 * idx.length), w = new Float32Array(idx.length), e = new Uint8Array(idx.length);
      idx.forEach((k, j) => { p.set(all.subarray(3 * k, 3 * k + 3), 3 * j); w[j] = m.weight[k]; e[j] = m.edge[k]; });
      return Cad.areaSample(p, w, e, FIT_POINTS);
    };
    const score = (T) => {
      const { idx, share } = inside(T), src = sample(T, idx);
      let near = 0;
      for (let k = 0; k < src.length; k += 3) if (nearFace(faces, dims, ...place(T, src[k], src[k + 1], src[k + 2]))) near++;
      const nearShare = src.length ? near / (src.length / 3) : 0;
      return { nearShare, inField: idx.length, inFieldShare: share, fits: nearShare >= FIT_MIN_NEAR && share >= MIN_IN_FIELD };
    };
    return { scan, all, sample, score };
  }

  /** prepare, kept in cache when one is given (see fitHolderStl). */
  function prepared(cache, args) {
    if (!cache) return prepare(args);
    if (!cache.surface) cache.surface = scanSurface(args.solid, args.outside, args.dims);
    if (!cache.stls) cache.stls = new Map();
    if (!cache.stls.has(args.triangles)) cache.stls.set(args.triangles, prepare({ ...args, surface: cache.surface }));
    return cache.stls.get(args.triangles);
  }

  /** How well the STL (mm) sits on the scan at pose (STL mm to grid voxels, as fitHolderStl returns): { nearShare,
      inField (STL measurement points, about one per voxel of surface, inside the scan's field; nearShare is counted on
      an area-even sample of them), inFieldShare (the in-field share of the
      STL's surface area), fits (nearShare at least FIT_MIN_NEAR on at least MIN_IN_FIELD of the surface) }. */
  function scoreFit({ triangles, pose, solid, outside = null, dims, voxelMm }) {
    return prepare({ triangles, solid, outside, dims, voxelMm }).score({ R: pose.R.map((v) => v * voxelMm), t: pose.t, s: 1 });
  }

  /** Whether fit a beats fit b: covering at least MIN_IN_FIELD of the STL comes first, then the higher near share. */
  const better = (a, b) => (a.inFieldShare >= MIN_IN_FIELD) !== (b.inFieldShare >= MIN_IN_FIELD) ? a.inFieldShare >= MIN_IN_FIELD : a.nearShare > b.nearShare;

  /** The three half turns about the principal axes of points, through their centroid, as { R, t, s } transforms. */
  function halfTurns(points) {
    const n = points.length / 3, c = [0, 0, 0], C = new Array(9).fill(0);
    for (let i = 0; i < points.length; i++) c[i % 3] += points[i] / n;
    for (let i = 0; i < points.length; i += 3) for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[3 * r + k] += (points[i + r] - c[r]) * (points[i + k] - c[k]);
    return A.eigenSymmetric(C, 3).vectors.map((e) => {
      const R = [0, 1, 2].flatMap((r) => [0, 1, 2].map((k) => 2 * e[r] * e[k] - (r === k ? 1 : 0)));
      return { R, t: c.map((v, r) => v - (R[3 * r] * c[0] + R[3 * r + 1] * c[1] + R[3 * r + 2] * c[2])), s: 1 };
    });
  }

  /** A holder piece from a fitted STL, with id ''. The caller must assign an id unique among the scan's pieces before
      saving or toggling it (holderMask's givenBack matches pieces by id). mask (the voxelized mesh on the grid, see
      voxelizeMesh) is runtime only and never saved; with solid it also sets the piece's voxel count. */
  function stlPiece({ name, hash, pose, mask = null, solid = null, voxelMm = 0 }) {
    let voxels = 0;
    if (mask && solid) for (let i = 0; i < mask.length; i++) voxels += mask[i] & solid[i];
    const piece = { id: '', kind: 'stl', foundBy: 'stl', name, hash, pose: { R: pose.R.slice(), t: pose.t.slice() }, voxels, mm3: voxels * voxelMm ** 3 };
    if (mask) piece.mask = mask;
    return piece;
  }

  /** FNV-1a over the file's bytes (as vb_orient orientId), 8 hex digits. */
  function stlHash(bytes) {
    const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }

  return { FIT_MIN_NEAR, MIN_IN_FIELD, voxelizeMesh, fitHolderStl, scoreFit, stlPiece, stlHash };
}));
