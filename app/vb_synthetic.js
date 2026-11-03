/* A generated test scan with known answers: a solid cylinder in air with non-overlapping spherical pores and noise,
   inside a circular field of view (FOV) that reads exact 0 outside, as a real reconstruction does.
   New users can try every step on it without a real scan, and the tests check porosity against its truth. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_core.js'));
  else root.VBSynthetic = factory(root.CT);
}(typeof self !== 'undefined' ? self : this, function (CT) {
  'use strict';

  const MATRIX_GRAY = 2000, AIR_GRAY = 700, NOISE_SD = 60, PORES = 40, RADIUS = [3, 8];

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
      0.47 size. */
  function makeScan({ size = 160, voxelMm = 0.04, seed = 1 } = {}) {
    const rnd = random(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    const c = (size - 1) / 2, R = 0.3 * size, FOV = 0.47 * size;
    const pores = [];
    for (let tries = 0; pores.length < PORES && tries < 20000; tries++) {
      const r = RADIUS[0] + rnd() * (RADIUS[1] - RADIUS[0]);
      const p = { x: c + (rnd() * 2 - 1) * (R - r - 3), y: c + (rnd() * 2 - 1) * (R - r - 3), z: r + 4 + rnd() * (size - 2 * r - 9), r };
      if (Math.hypot(p.x - c, p.y - c) > R - r - 3) continue;
      if (pores.some((q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < p.r + q.r + 3)) continue;
      pores.push(p);
    }
    let body = 0, open = 0;
    const slices = [];
    for (let z = 0; z < size; z++) {
      const s = new Uint16Array(size * size);
      const near = pores.filter((p) => Math.abs(z - p.z) <= p.r);
      for (let y = 0, i = 0; y < size; y++) {
        for (let x = 0; x < size; x++, i++) {
          const inside = Math.hypot(x - c, y - c) <= R;
          const pore = inside && near.some((p) => (x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2 <= p.r * p.r);
          if (inside) { body++; if (pore) open++; }
          const gray = Math.max(1, Math.round((inside && !pore ? MATRIX_GRAY : AIR_GRAY) + NOISE_SD * gauss()));
          s[i] = Math.hypot(x - c, y - c) <= FOV ? gray : 0;
        }
      }
      slices.push(s);
    }
    const files = slices.map((s, z) => {
      const name = `synthetic_${String(z + 1).padStart(3, '0')}.tif`;
      return { name, webkitRelativePath: `synthetic_scan/${name}`, arrayBuffer: async () => CT.writeTiff(size, size, s, voxelMm) };
    });
    return { files, truth: { porosity_percent: (100 * open) / body, pore_count: pores.length, matrix_gray: MATRIX_GRAY, air_gray: AIR_GRAY } };
  }

  return { makeScan };
}));
