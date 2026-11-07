/* Tape for holder removal: thin sheets of solid (at most 2 voxels thick along some axis) that lie outside the part's
   thick body and outside the fitted holder pieces, such as tape wrapped from the part to its holder. Each sheet is
   returned as an axis-aligned box piece of kind 'tape'; holderMask then takes only the thin solid inside the box, so
   the part's thick body is never cut. Coordinates are voxels of the binned grid, volume index i = x + nx * (y + ny * z). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'), require('./vb_holder.js'));
  else root.VBHolderTape = factory(root.CTPores, root.VBHolder);
}(typeof self !== 'undefined' ? self : this, function (P, H) {
  'use strict';

  const THIN = 2;         // voxels: tape is the solid at most this thick (the same limit holderMask applies)
  const NEAR_CORE = 1;    // voxels: thin solid this close to the thick body is the body's own silhouette, not tape
  const MIN_REACH = 0.25; // a sheet counts as tape when its box diagonal is at least this share of the thick body's

  const diagonal = (lo, hi) => Math.hypot(hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1);

  /** Tape pieces in the solid outside the holder mask `holder`. ids continue from `firstId` (h<firstId>, ...). */
  function findTape({ solid, holder, dims, voxelMm = 0, firstId = 1 }) {
    const { nx, ny } = dims, n = solid.length, rest = new Uint8Array(n);
    for (let i = 0; i < n; i++) rest[i] = solid[i] && !(holder && holder[i]) ? 1 : 0;
    const run = H.shortestRun(dims, rest), thick = new Uint8Array(n), thin = new Uint8Array(n);
    for (let i = 0; i < n; i++) { if (rest[i]) { if (run[i] > THIN) thick[i] = 1; else thin[i] = 1; } }
    const body = P.label(thick, dims);
    let main = 0;
    for (let l = 1; l <= body.count; l++) if (body.sizes[l] > body.sizes[main]) main = l;
    if (!main) return [];
    const core = new Uint8Array(n), lo = [Infinity, Infinity, Infinity], hi = [-1, -1, -1];
    for (let i = 0; i < n; i++) {
      if (body.labels[i] !== main) continue;
      core[i] = 1;
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      [x, y, z].forEach((v, k) => { if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; });
    }
    const reach = MIN_REACH * diagonal(lo, hi), near = P.boxDilate(core, dims, NEAR_CORE);
    for (let i = 0; i < n; i++) if (near[i]) thin[i] = 0;
    // Sheets are grouped through a one-voxel dilation, so diagonal neighbors join.
    const sheets = P.label(P.boxDilate(thin, dims, 1), dims), box = new Map(), count = new Map();
    for (let i = 0; i < n; i++) {
      const l = sheets.labels[i];
      if (!l || !thin[i]) continue;
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      if (!box.has(l)) box.set(l, { lo: [x, y, z], hi: [x, y, z] });
      const b = box.get(l);
      [x, y, z].forEach((v, k) => { if (v < b.lo[k]) b.lo[k] = v; if (v > b.hi[k]) b.hi[k] = v; });
      count.set(l, (count.get(l) || 0) + 1);
    }
    const found = [];
    for (const [l, b] of box) {
      if (diagonal(b.lo, b.hi) < reach) continue;
      found.push({ kind: 'tape', foundBy: 'shape', center: b.lo.map((v, k) => (v + b.hi[k]) / 2), axes: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        half: b.lo.map((v, k) => (b.hi[k] - v) / 2 + 1), voxels: count.get(l), mm3: count.get(l) * voxelMm ** 3 });
    }
    found.sort((a, b) => b.voxels - a.voxels);
    found.forEach((p, k) => { p.id = 'h' + (firstId + k); });
    return found;
  }

  return { findTape };
}));
