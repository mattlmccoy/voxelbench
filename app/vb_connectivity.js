/* Pore connectivity: which pores outside air reaches (open), which it does not (closed) and which touch the first or
   last slice, where the scan cannot tell (unknown); networks of touching pores and whether one runs through the part;
   each pore's sphericity and distance to the surface. Works on the pore runs (full grid) and the filled sample mask
   and gray (binned grid), as segmentation produces them. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'), require('./ct_zones.js'));
  else root.VBConnectivity = factory(root.CTPores, root.CTZones);
}(typeof self !== 'undefined' ? self : this, function (P, Z) {
  'use strict';
  const NEAR_SURFACE_MM = 0.5; // the shell near-surface voids are counted in

  const THROUGH_SLACK = 2; // binned voxels beyond the segmentation margin, for through-paths
  const MIN_SHAPE_VOXELS = 100; // about 6 voxels across; smaller pores are too coarse for a shape
  const MAX_SHAPE_CELLS = 4e6; // a pore's box above this is meshed on a coarser copy

  /** Wadell sphericity π^(1/3)(6V)^(2/3)/A, with A and V the area and enclosed volume of the mask's surface-nets
      mesh (the mesh's own volume, so the ratio stays at or below 1); null for pores below MIN_SHAPE_VOXELS. */
  function sphericity(mask, dims, voxels) {
    if (voxels < MIN_SHAPE_VOXELS) return null;
    const { positions, indices } = P.surfaceNets(mask, dims);
    let area = 0, volume = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const a = 3 * indices[t], b = 3 * indices[t + 1], c = 3 * indices[t + 2];
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      area += Math.hypot(nx, ny, nz) / 2;
      volume += (positions[a] * nx + positions[a + 1] * ny + positions[a + 2] * nz) / 6;
    }
    volume = Math.abs(volume);
    return area > 0 && volume > 0 ? (Math.PI ** (1 / 3) * (6 * volume) ** (2 / 3)) / area : null;
  }

  /** Binned voxels that outside air reaches through gray below the threshold, starting next to voxels outside the
      mask (the part surface, or a crop face). The mask's closing bridges crack mouths, so a pore joined to the outside
      by a crack sits deep inside the mask but is still open. The volume's own edges are not air. */
  function airReach(filled, gray, threshold, { nx, ny, nz }) {
    const n = filled.length, reach = new Uint8Array(n), stack = [];
    const low = (i) => filled[i] && gray[i] < threshold && !reach[i];
    const neighbors = (i, fn) => {
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      if (x > 0) fn(i - 1); if (x < nx - 1) fn(i + 1);
      if (y > 0) fn(i - nx); if (y < ny - 1) fn(i + nx);
      if (z > 0) fn(i - nx * ny); if (z < nz - 1) fn(i + nx * ny);
    };
    for (let i = 0; i < n; i++) {
      if (!low(i)) continue;
      let touches = false;
      neighbors(i, (j) => { if (!filled[j]) touches = true; });
      if (touches) { reach[i] = 1; stack.push(i); }
    }
    while (stack.length) neighbors(stack.pop(), (j) => { if (low(j)) { reach[j] = 1; stack.push(j); } });
    return reach;
  }

  /** Open, closed and unknown pore volume, leaving out rejected pores as the total porosity does. */
  function openClosed(pores, bodyMm3, rejected = new Set()) {
    const s = { open_mm3: 0, closed_mm3: 0, unknown_mm3: 0 };
    for (const p of pores) {
      if (rejected.has(p.id)) continue;
      s[p.open === true ? 'open_mm3' : p.open === false ? 'closed_mm3' : 'unknown_mm3'] += p.volume_mm3;
    }
    const pct = (v) => (bodyMm3 ? (100 * v) / bodyMm3 : 0);
    return { ...s, open_percent: pct(s.open_mm3), closed_percent: pct(s.closed_mm3), unknown_percent: pct(s.unknown_mm3) };
  }

  /** The pore's own mask in its box (padded by one), on a copy coarse enough to fit maxCells; a coarse cell is set
      when at least half its voxels are. */
  function poreShape(m, runs, maxCells) {
    const w = m.x1 - m.x0 + 1, h = m.y1 - m.y0 + 1, d = m.z1 - m.z0 + 1;
    const f = Math.max(1, Math.ceil(Math.cbrt((w + 2) * (h + 2) * (d + 2) / maxCells)));
    const cw = Math.ceil(w / f) + 2, ch = Math.ceil(h / f) + 2, cd = Math.ceil(d / f) + 2;
    const count = f === 1 ? new Uint8Array(cw * ch * cd) : new Uint16Array(cw * ch * cd);
    for (const [i, y, z] of m.runs) {
      const row = (Math.floor((z - m.z0) / f) + 1) * ch + Math.floor((y - m.y0) / f) + 1;
      for (let x = runs.start[i]; x < runs.end[i]; x++) count[row * cw + Math.floor((x - m.x0) / f) + 1]++;
    }
    const half = (f * f * f) / 2, mask = new Uint8Array(count.length);
    for (let k = 0; k < count.length; k++) mask[k] = f === 1 ? count[k] : count[k] >= half ? 1 : 0;
    return { mask, dims: { nx: cw, ny: ch, nz: cd }, bin: f };
  }

  function annotatePores({ pores, runs, dims, filled, binnedDims, bin, voxelMm, gray = null, poreThreshold = null, margin = P.DEFAULT_SETTINGS.margin, maxShapeCells = MAX_SHAPE_CELLS }) {
    const { ny, nz } = dims, b = binnedDims;
    const depth = Z.distanceInside(filled, b, { endsInside: true });
    const reach = gray && Number.isFinite(poreThreshold) ? airReach(filled, gray, poreThreshold, b) : null;
    const info = new Map(pores.map((p) => [p.id, { reached: false, minDepth: Infinity, x0: Infinity, x1: -1, y0: Infinity, y1: -1, z0: Infinity, z1: -1, voxels: 0, runs: [] }]));
    const parent = new Map(pores.map((p) => [p.id, p.id]));
    const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    const join = (a, c) => { if (info.has(a) && info.has(c)) { const ra = find(a), rc = find(c); if (ra !== rc) parent.set(rc, ra); } };
    const touch = (i, row) => { // runs in another row that overlap run i (runs are sorted by start within a row)
      for (let j = runs.offsets[row]; j < runs.offsets[row + 1] && runs.start[j] < runs.end[i]; j++) if (runs.end[j] > runs.start[i] && runs.id[j] !== runs.id[i]) join(runs.id[i], runs.id[j]);
    };
    for (let row = 0; row < runs.rows; row++) {
      const y = row % ny, z = Math.floor(row / ny);
      for (let i = runs.offsets[row]; i < runs.offsets[row + 1]; i++) {
        const m = info.get(runs.id[i]);
        if (!m) continue;
        m.runs.push([i, y, z]);
        m.voxels += runs.end[i] - runs.start[i];
        m.x0 = Math.min(m.x0, runs.start[i]); m.x1 = Math.max(m.x1, runs.end[i] - 1);
        m.y0 = Math.min(m.y0, y); m.y1 = Math.max(m.y1, y); m.z0 = Math.min(m.z0, z); m.z1 = Math.max(m.z1, z);
        const by = Math.floor(y / bin), bz = Math.floor(z / bin);
        if (by < b.ny && bz < b.nz) {
          for (let bx = Math.floor(runs.start[i] / bin); bx <= Math.floor((runs.end[i] - 1) / bin) && bx < b.nx; bx++) {
            const k = (bz * b.ny + by) * b.nx + bx;
            m.minDepth = Math.min(m.minDepth, depth[k]);
            if (reach && reach[k]) m.reached = true;
          }
        }
        if (i > runs.offsets[row] && runs.end[i - 1] === runs.start[i] && runs.id[i - 1] !== runs.id[i]) join(runs.id[i - 1], runs.id[i]);
        if (y > 0) touch(i, row - 1);
        if (z > 0) touch(i, row - ny);
      }
    }

    // Extent of the mask on the full grid, for through-paths.
    const ext = { x: [Infinity, -1], y: [Infinity, -1], z: [Infinity, -1] };
    let maskVoxels = 0;
    for (let z = 0, i = 0; z < b.nz; z++) for (let y = 0; y < b.ny; y++) for (let x = 0; x < b.nx; x++, i++) {
      if (!filled[i]) continue;
      maskVoxels++;
      for (const [a, v] of [['x', x], ['y', y], ['z', z]]) { ext[a][0] = Math.min(ext[a][0], v * bin); ext[a][1] = Math.max(ext[a][1], v * bin + bin - 1); }
    }
    const tol = (margin + THROUGH_SLACK) * bin;

    const out = pores.map((p) => {
      const m = info.get(p.id);
      let shape = null, shapeBin = 1;
      if (m.voxels >= MIN_SHAPE_VOXELS) {
        const s = poreShape(m, runs, maxShapeCells);
        shape = sphericity(s.mask, s.dims, m.voxels);
        shapeBin = s.bin;
      }
      const atEnd = m.z0 === 0 || m.z1 === nz - 1;
      const open = reach && m.reached ? true : atEnd || !reach ? null : false;
      return { ...p, surface_distance_mm: Number.isFinite(m.minDepth) ? m.minDepth * bin * voxelMm : null, open, at_scan_end: atEnd, sphericity: shape, shape_bin: shapeBin, network: find(p.id), box: [m.x0, m.x1, m.y0, m.y1, m.z0, m.z1] };
    });

    const groups = new Map();
    for (const p of out) (groups.get(p.network) || groups.set(p.network, []).get(p.network)).push(p);
    const through = { x: false, y: false, z: false };
    for (const members of groups.values()) {
      const open = members.filter((p) => p.open === true);
      ['x', 'y', 'z'].forEach((a, k) => {
        if (open.some((p) => p.box[2 * k] <= ext[a][0] + tol) && open.some((p) => p.box[2 * k + 1] >= ext[a][1] - tol)) through[a] = true;
      });
    }
    const body = maskVoxels * (bin * voxelMm) ** 3;
    // The share of the part within NEAR_SURFACE_MM of its surface: what near-surface void volume is measured against.
    let shell = 0, inside = 0;
    for (let i = 0; i < filled.length; i++) { if (!filled[i]) continue; inside++; if (depth[i] * bin * voxelMm <= NEAR_SURFACE_MM + 1e-9) shell++; }
    return { pores: out.map(({ box, ...p }) => p), summary: { ...openClosed(out, body), networks: groups.size, through, near_surface: { mm: NEAR_SURFACE_MM, body_share: inside ? shell / inside : null } } };
  }

  return { sphericity, openClosed, annotatePores };
}));
