/* Pore connectivity: which pores reach the part surface (open) and which do not (closed), networks of touching pores
   and whether one runs through the part, plus each pore's sphericity and distance to the surface. Works on the
   pore runs (full grid) and the filled sample mask (binned grid), as segmentation produces them. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'), require('./ct_zones.js'));
  else root.VBConnectivity = factory(root.CTPores, root.CTZones);
}(typeof self !== 'undefined' ? self : this, function (P, Z) {
  'use strict';

  const OPEN_DEPTH = 1; // binned voxels: a pore this close to outside the mask touches the surface
  const FACE_TOLERANCE = 2; // binned voxels, for through-paths
  const MIN_SHAPE_VOXELS = 27;

  /** Wadell sphericity π^(1/3)(6V)^(2/3)/A, with A the area of the mask's surface-nets mesh; null for tiny pores. */
  function sphericity(mask, dims, voxels) {
    if (voxels < MIN_SHAPE_VOXELS) return null;
    const { positions, indices } = P.surfaceNets(mask, dims);
    let area = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const a = 3 * indices[t], b = 3 * indices[t + 1], c = 3 * indices[t + 2];
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    return area > 0 ? (Math.PI ** (1 / 3) * (6 * voxels) ** (2 / 3)) / area : null;
  }

  /** Binned voxels that outside air reaches through gray below the threshold: the mask's closing bridges crack mouths,
      so a pore joined to the outside by a crack sits deep inside the mask but is still open. */
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
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      if (touches || x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) { reach[i] = 1; stack.push(i); }
    }
    while (stack.length) neighbors(stack.pop(), (j) => { if (low(j)) { reach[j] = 1; stack.push(j); } });
    return reach;
  }

  function annotatePores({ pores, runs, dims, filled, binnedDims, bin, voxelMm, gray = null, poreThreshold = null }) {
    const { ny } = dims, b = binnedDims;
    const depth = Z.distanceInside(filled, b);
    const reach = gray && Number.isFinite(poreThreshold) ? airReach(filled, gray, poreThreshold, b) : null;
    const info = new Map(pores.map((p) => [p.id, { reached: false, minDepth: Infinity, x0: Infinity, x1: -1, y0: Infinity, y1: -1, z0: Infinity, z1: -1, voxels: 0, runs: [] }]));
    const parent = new Map(pores.map((p) => [p.id, p.id]));
    const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    const join = (a, c) => { if (info.has(a) && info.has(c)) { const ra = find(a), rc = find(c); if (ra !== rc) parent.set(rc, ra); } };
    const touch = (i, row) => { // runs in another row that overlap run i
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
    const tol = FACE_TOLERANCE * bin;

    const out = pores.map((p) => {
      const m = info.get(p.id);
      const w = m.x1 - m.x0 + 3, h = m.y1 - m.y0 + 3, d = m.z1 - m.z0 + 3;
      let shape = null;
      if (m.voxels >= MIN_SHAPE_VOXELS) {
        const mask = new Uint8Array(w * h * d);
        for (const [i, y, z] of m.runs) {
          for (let x = runs.start[i]; x < runs.end[i]; x++) mask[((z - m.z0 + 1) * h + (y - m.y0 + 1)) * w + (x - m.x0 + 1)] = 1;
        }
        shape = sphericity(mask, { nx: w, ny: h, nz: d }, m.voxels);
      }
      const open = m.minDepth <= OPEN_DEPTH || m.reached;
      return { ...p, surface_distance_mm: Number.isFinite(m.minDepth) ? m.minDepth * bin * voxelMm : null, open, sphericity: shape, network: find(p.id), box: [m.x0, m.x1, m.y0, m.y1, m.z0, m.z1] };
    });

    const groups = new Map();
    for (const p of out) (groups.get(p.network) || groups.set(p.network, []).get(p.network)).push(p);
    const through = { x: false, y: false, z: false };
    for (const members of groups.values()) {
      const open = members.filter((p) => p.open);
      ['x', 'y', 'z'].forEach((a, k) => {
        if (open.some((p) => p.box[2 * k] <= ext[a][0] + tol) && open.some((p) => p.box[2 * k + 1] >= ext[a][1] - tol)) through[a] = true;
      });
    }
    const body = maskVoxels * (bin * voxelMm) ** 3;
    const openMm3 = out.filter((p) => p.open).reduce((s, p) => s + p.volume_mm3, 0);
    const closedMm3 = out.filter((p) => !p.open).reduce((s, p) => s + p.volume_mm3, 0);
    return {
      pores: out.map(({ box, ...p }) => p),
      summary: { open_mm3: openMm3, closed_mm3: closedMm3, open_percent: body ? (100 * openMm3) / body : 0, closed_percent: body ? (100 * closedMm3) / body : 0, networks: groups.size, through },
    };
  }

  return { sphericity, annotatePores };
}));
