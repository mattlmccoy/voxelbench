/* A generated test scan with known answers: a solid cylinder in air with non-overlapping spherical pores and noise,
   inside a circular field of view (FOV) that reads exact 0 outside, as a real reconstruction does.
   New users can try every step on it without a real scan, and the tests check porosity against its truth. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_core.js'), require('./vb_stl.js'));
  else root.VBSynthetic = factory(root.CT, root.VBStl);
}(typeof self !== 'undefined' ? self : this, function (CT, St) {
  'use strict';

  const MATRIX_GRAY = 2000, AIR_GRAY = 700, NOISE_SD = 60, PORES = 40, RADIUS = [3, 8];
  // With filler: bright spheres and short fibers lying within 8° of x, from their own seed so pores and noise stay put.
  const FILLER_GRAY = 3000, FILLER_SPHERES = 50, SPHERE_RADIUS = [2, 3.5], FIBERS = 20, FIBER_HALF = 9, FIBER_RADIUS = 1.6, FIBER_SPREAD = (8 * Math.PI) / 180;
  // With phantoms: gray = AIR_GRAY + GRAY_PER_DENSITY x density, so the matrix is (2000 - 700) / 1290 g/cm³.
  const GRAY_PER_DENSITY = 1290;
  // With a dense band: matrix gray raised by this share of (matrix - air) over the middle 30 % of the length.
  // Its pores stay in the middle, so the two ends are pore-free and serve as the zone baseline.
  const DENSE_GAIN = 0.1, DENSE_BAND = [0.35, 0.65], PORE_BAND = [0.3, 0.7];
  const RODS = [{ name: 'Rod A (0.50 g/cm³)', density_g_cm3: 0.5, angle: Math.PI / 4 }, { name: 'Rod B (1.40 g/cm³)', density_g_cm3: 1.4, angle: (5 * Math.PI) / 4 }];

  // mulberry32: a small seeded generator, so a seed always gives the same scan.
  function random(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Scan of size^3 voxels: cylinder along z of radius 0.3 size, pores of radius 3 to 8 voxels inside it, FOV radius
      0.47 size. With filler, bright spheres and fibers fill part of the matrix (truth.filler). With a dense band, the
      matrix between 0.35 and 0.65 of the length (z) reads DENSE_GAIN brighter, a zone for step 3 (truth.dense_band). */
  function makeScan({ size = 160, voxelMm = 0.04, seed = 1, phantoms = false, filler = false, denseBand = false } = {}) {
    const rnd = random(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    const c = (size - 1) / 2, R = 0.3 * size, FOV = 0.47 * size;
    // Phantom rods along z between the part and the FOV edge, for the density calibration.
    const rods = phantoms ? RODS.map((r) => ({ name: r.name, density_g_cm3: r.density_g_cm3, radius: 0.06 * size,
      center: { x: c + 0.39 * size * Math.cos(r.angle), y: c + 0.39 * size * Math.sin(r.angle) } })) : [];
    const pores = [];
    for (let tries = 0; pores.length < PORES && tries < 20000; tries++) {
      const r = RADIUS[0] + rnd() * (RADIUS[1] - RADIUS[0]);
      const p = { x: c + (rnd() * 2 - 1) * (R - r - 3), y: c + (rnd() * 2 - 1) * (R - r - 3), z: denseBand ? (PORE_BAND[0] + rnd() * (PORE_BAND[1] - PORE_BAND[0])) * size : r + 4 + rnd() * (size - 2 * r - 9), r };
      if (Math.hypot(p.x - c, p.y - c) > R - r - 3) continue;
      if (pores.some((q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < p.r + q.r + 3)) continue;
      pores.push(p);
    }
    const items = filler ? placeFiller(random(seed + 1000), { c, R, size }, pores) : [];
    let body = 0, open = 0, bright = 0;
    const DENSE_GRAY = Math.round(MATRIX_GRAY + DENSE_GAIN * (MATRIX_GRAY - AIR_GRAY));
    const dense = (z) => denseBand && z >= DENSE_BAND[0] * size && z < DENSE_BAND[1] * size;
    const slices = [];
    for (let z = 0; z < size; z++) {
      const s = new Uint16Array(size * size);
      const near = pores.filter((p) => Math.abs(z - p.z) <= p.r);
      const nearItems = items.filter((f) => Math.abs(z - f.z) <= f.reach);
      for (let y = 0, i = 0; y < size; y++) {
        for (let x = 0; x < size; x++, i++) {
          const inside = Math.hypot(x - c, y - c) <= R;
          const pore = inside && near.some((p) => (x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2 <= p.r * p.r);
          if (inside) { body++; if (pore) open++; }
          const rod = rods.find((r) => Math.hypot(x - r.center.x, y - r.center.y) <= r.radius);
          const filled = inside && !pore && nearItems.some((f) => f.contains(x, y, z));
          if (filled) bright++;
          const mean = filled ? FILLER_GRAY : inside && !pore ? (dense(z) ? DENSE_GRAY : MATRIX_GRAY) : rod ? AIR_GRAY + GRAY_PER_DENSITY * rod.density_g_cm3 : AIR_GRAY;
          const gray = Math.max(1, Math.round(mean + NOISE_SD * gauss()));
          s[i] = Math.hypot(x - c, y - c) <= FOV ? gray : 0;
        }
      }
      slices.push(s);
    }
    // Each variant is its own sample, so records drawn on one (a crop, phantoms) do not appear on another.
    const folder = phantoms ? 'synthetic_phantoms' : filler ? 'synthetic_filler' : denseBand ? 'synthetic_dense_band' : 'synthetic_scan';
    const files = slices.map((s, z) => {
      const name = `synthetic_${String(z + 1).padStart(3, '0')}.tif`;
      return { name, webkitRelativePath: `${folder}/${name}`, arrayBuffer: async () => CT.writeTiff(size, size, s, voxelMm) };
    });
    return { files, truth: { porosity_percent: (100 * open) / body, pore_count: pores.length, pores: pores.map((p) => ({ ...p })), matrix_gray: MATRIX_GRAY, air_gray: AIR_GRAY,
      ...(phantoms ? { phantoms: rods, matrix_density: (MATRIX_GRAY - AIR_GRAY) / GRAY_PER_DENSITY } : {}),
      ...(denseBand ? { dense_band: { z_from: Math.ceil(DENSE_BAND[0] * size), z_to: Math.ceil(DENSE_BAND[1] * size) - 1, gray: DENSE_GRAY } } : {}),
      ...(filler ? { filler: { spheres: items.filter((f) => f.kind === 'sphere').length, fibers: items.filter((f) => f.kind === 'fiber').length, volume_percent: (100 * bright) / body, gray: FILLER_GRAY } } : {}) } };
  }

  /** Spheres and fibers inside the cylinder, clear of the pores and of each other (by bounding spheres). */
  function placeFiller(rnd, { c, R, size }, pores) {
    const items = [];
    const clear = (x, y, z, reach) => Math.hypot(x - c, y - c) <= R - reach - 3 && z >= reach + 3 && z <= size - reach - 4
      && !pores.some((p) => Math.hypot(x - p.x, y - p.y, z - p.z) < reach + p.r + 2) && !items.some((f) => Math.hypot(x - f.x, y - f.y, z - f.z) < reach + f.reach + 2);
    for (let tries = 0, n = 0; n < FIBERS && tries < 20000; tries++) {
      const x = c + (rnd() * 2 - 1) * R, y = c + (rnd() * 2 - 1) * R, z = rnd() * size, reach = FIBER_HALF + FIBER_RADIUS;
      if (!clear(x, y, z, reach)) continue;
      const tilt = rnd() * FIBER_SPREAD, turn = rnd() * 2 * Math.PI, u = [Math.cos(tilt), Math.sin(tilt) * Math.cos(turn), Math.sin(tilt) * Math.sin(turn)];
      items.push({ kind: 'fiber', x, y, z, reach, contains: (px, py, pz) => {
        const t = Math.max(-FIBER_HALF, Math.min(FIBER_HALF, (px - x) * u[0] + (py - y) * u[1] + (pz - z) * u[2]));
        return (px - x - t * u[0]) ** 2 + (py - y - t * u[1]) ** 2 + (pz - z - t * u[2]) ** 2 <= FIBER_RADIUS ** 2;
      } });
      n++;
    }
    for (let tries = 0, n = 0; n < FILLER_SPHERES && tries < 20000; tries++) {
      const r = SPHERE_RADIUS[0] + rnd() * (SPHERE_RADIUS[1] - SPHERE_RADIUS[0]), x = c + (rnd() * 2 - 1) * R, y = c + (rnd() * 2 - 1) * R, z = rnd() * size;
      if (!clear(x, y, z, r)) continue;
      items.push({ kind: 'sphere', x, y, z, reach: r, contains: (px, py, pz) => (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2 <= r * r });
      n++;
    }
    return items;
  }

  // The L part for the CAD comparison, in part voxels (u, v, w): an L section in (u, w) extruded 40 voxels along v.
  const L_SECTION = [[0, 0], [100, 0], [100, 40], [30, 40], [30, 100], [0, 100]];
  const L_DEPTH = 40;
  const inL = (u, v, w) => v >= 0 && v <= L_DEPTH && ((u >= 0 && u <= 100 && w >= 0 && w <= 40) || (u >= 0 && u <= 30 && w >= 40 && w <= 100));

  /** Scan of the L part (no pores), scaled about its center and with its upright bent outward (toward -u) by up to
      bendMm at the top, with partial-volume edges and noise. The part's corner sits at voxel (c-50, c-30, 30). */
  function makePart({ size = 160, voxelMm = 0.04, seed = 7, scale = 1, bendMm = 0 } = {}) {
    const rnd = random(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    const c = (size - 1) / 2, FOV = 0.47 * size, origin = [c - 50, c - 30, 30], mid = [50, 20, 50], bend = bendMm / voxelMm;
    const sub = [-0.25, 0.25];
    const slices = [];
    for (let z = 0; z < size; z++) {
      const s = new Uint16Array(size * size);
      for (let y = 0, i = 0; y < size; y++) {
        for (let x = 0; x < size; x++, i++) {
          let inside = 0;
          if (Math.abs(x - c) < 70 && Math.abs(y - c) < 45 && z > 20 && z < 145) {
            for (const dx of sub) for (const dy of sub) for (const dz of sub) {
              const q = [x + dx - origin[0], y + dy - origin[1], z + dz - origin[2]];
              const p = q.map((v, k) => mid[k] + (v - mid[k]) / scale);
              p[0] += (bend * Math.max(0, p[2] - 40)) / 60;
              if (inL(...p)) inside++;
            }
          }
          const gray = Math.max(1, Math.round(AIR_GRAY + ((MATRIX_GRAY - AIR_GRAY) * inside) / 8 + NOISE_SD * gauss()));
          s[i] = Math.hypot(x - c, y - c) <= FOV ? gray : 0;
        }
      }
      slices.push(s);
    }
    const files = slices.map((s, z) => {
      const name = `part_${String(z + 1).padStart(3, '0')}.tif`;
      return { name, webkitRelativePath: `synthetic_part/${name}`, arrayBuffer: async () => CT.writeTiff(size, size, s, voxelMm) };
    });
    // The nominal's CAD frame (see partStl) to scan mm: part voxel (u, v, w) = (X, -Z, Y) / voxelMm, then scaled.
    const pose = { R: [1, 0, 0, 0, 0, -1, 0, 1, 0], t: [0, 1, 2].map((k) => voxelMm * (origin[k] + mid[k] * (1 - scale))), s: scale };
    return { files, truth: { scale, bend_mm: bendMm, pose, matrix_gray: MATRIX_GRAY, air_gray: AIR_GRAY } };
  }

  /** The L part's nominal as binary STL in its own CAD frame (mm, y up): CAD (x, y, z) = (u, w, -v) x voxelMm. */
  function partStl({ voxelMm = 0.04 } = {}) {
    const cad = ([u, v, w]) => [u * voxelMm, w * voxelMm, -v * voxelMm];
    const tri = [];
    const add = (a, b, c) => tri.push(...cad(a), ...cad(b), ...cad(c));
    const n = L_SECTION.length, reflex = 3; // the L is star-shaped from its inner corner (30, 40)
    for (let k = 0; k < n; k++) {
      const a = L_SECTION[k], b = L_SECTION[(k + 1) % n];
      if (k !== reflex && (k + 1) % n !== reflex) {
        const r = L_SECTION[reflex];
        add([r[0], 0, r[1]], [a[0], 0, a[1]], [b[0], 0, b[1]]); // cap at v = 0, outward -v
        add([r[0], L_DEPTH, r[1]], [b[0], L_DEPTH, b[1]], [a[0], L_DEPTH, a[1]]); // cap at v = depth, outward +v
      }
      add([a[0], 0, a[1]], [a[0], L_DEPTH, a[1]], [b[0], L_DEPTH, b[1]]); // side wall
      add([a[0], 0, a[1]], [b[0], L_DEPTH, b[1]], [b[0], 0, b[1]]);
    }
    return St.writeStl(Float32Array.from(tri));
  }

  return { makeScan, makePart, partStl };
}));
