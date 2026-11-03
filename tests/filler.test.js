'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../app/vb_filler.js');

const dims = { nx: 40, ny: 40, nz: 40 };
/** Slices of matrix gray 1000 with bright voxels (3000) where bright(x, y, z) holds. */
function volume(bright) {
  return Array.from({ length: dims.nz }, (_, z) => {
    const s = new Uint16Array(dims.nx * dims.ny);
    for (let y = 0, i = 0; y < dims.ny; y++) for (let x = 0; x < dims.nx; x++, i++) s[i] = bright(x, y, z) ? 3000 : 1000;
    return s;
  });
}
const run = (slices, extra = {}) => F.labelBright({ getSlice: (z) => slices[z], dims, keep: () => true, threshold: 2000, minVoxels: 8, ...extra });

test('two spheres and a rod are three particles; the rod is long along x', () => {
  const ball = (cx, cy, cz, r) => (x, y, z) => (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r * r;
  const rod = (x, y, z) => x >= 10 && x < 30 && y >= 30 && y < 32 && z >= 20 && z < 22;
  const a = ball(10, 10, 10, 3), b = ball(28, 12, 28, 4);
  const { particles, dropped } = run(volume((x, y, z) => a(x, y, z) || b(x, y, z) || rod(x, y, z)));
  assert.equal(particles.length, 3);
  assert.equal(dropped, 0);
  const r = particles.find((p) => p.voxels === 80);
  assert.ok(r, `voxel counts ${particles.map((p) => p.voxels)}`);
  assert.ok(r.aspect >= 5, `aspect ${r.aspect}`);
  assert.ok(Math.abs(Math.abs(r.direction[0]) - 1) < 1e-6, `direction ${r.direction}`);
  assert.ok(Math.abs(r.centroid[0] - 19.5) < 1e-9 && Math.abs(r.centroid[1] - 30.5) < 1e-9 && Math.abs(r.centroid[2] - 20.5) < 1e-9);
  const s = particles.find((p) => Math.abs(p.centroid[0] - 10) < 1e-9);
  assert.ok(s.aspect < 1.2, `sphere aspect ${s.aspect}`);
  assert.equal(s.clipped, false);
});

test('diagonal neighbors join, across rows and across slices', () => {
  const diag = (x, y, z) => x === y && y === z && x >= 5 && x < 15;
  const { particles } = run(volume(diag));
  assert.equal(particles.length, 1);
  assert.equal(particles[0].voxels, 10);
});

test('components under minVoxels are dropped and counted; a particle on the first slice is clipped', () => {
  const { particles, dropped } = run(volume((x, y, z) => (x === 5 && y === 5 && z === 5) || (x >= 20 && x < 23 && y >= 20 && y < 23 && z < 3)));
  assert.equal(dropped, 1);
  assert.equal(particles.length, 1);
  assert.equal(particles[0].clipped, true);
});

test('voxels outside the keep test are not bright', () => {
  const { particles } = run(volume((x, y, z) => x >= 2 && x < 6 && y >= 2 && y < 6 && z >= 2 && z < 6), { keep: (x) => x >= 4 });
  assert.equal(particles[0].voxels, 2 * 4 * 4);
});

test('the robust threshold is the median plus k robust SDs of the matrix, unmoved by a 20 % bright phase', () => {
  let s = 12345;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const values = Float32Array.from({ length: 40000 }, (_, i) => (i % 5 === 0 ? 3000 : 1000 + 50 * gauss()));
  const t = F.robustThreshold(values, 4);
  assert.ok(Math.abs(t.median - 1000) < 5, `median ${t.median}`);
  assert.ok(Math.abs(t.sd - 50) / 50 < 0.05, `sd ${t.sd}`);
  assert.ok(Math.abs(t.threshold - 1200) / 1200 < 0.05, `threshold ${t.threshold}`);
});

const at = (centroid, extra = {}) => ({ voxels: 10, clipped: false, centroid, aspect: 1, length_vox: 3, diameter_vox: 3, esd_vox: 2.7, direction: [1, 0, 0], ...extra });

test('Clark–Evans R reads a lattice as regular and close pairs as clustered', () => {
  const lattice = [], pairs = [];
  for (let x = 5; x < 100; x += 10) for (let y = 5; y < 100; y += 10) for (let z = 5; z < 100; z += 10) {
    lattice.push(at([x, y, z]));
    pairs.push(at([x, y, z]), at([x + 1, y, z]));
  }
  const reg = F.dispersion(lattice, 1e6), clu = F.dispersion(pairs, 1e6);
  assert.ok(Math.abs(reg.mean_nn - 10) < 1e-9, `${reg.mean_nn}`);
  assert.ok(reg.clark_evans > 1.5, `regular ${reg.clark_evans}`);
  assert.ok(clu.clark_evans < 0.6, `clustered ${clu.clark_evans}`);
  assert.equal(F.dispersion([at([1, 1, 1])], 1e6).clark_evans, null, 'one particle has no neighbor');
});

test('the orientation tensor of fibers along z is diag(0, 0, 1); of evenly spread fibers about 1/3 each', () => {
  const along = Array.from({ length: 20 }, () => at([0, 0, 0], { direction: [0, 0, 1] }));
  const t = F.orientationTensor(along);
  assert.ok(Math.abs(t.eigenvalues[0] - 1) < 1e-9 && Math.abs(Math.abs(t.direction[2]) - 1) < 1e-9);
  const spread = Array.from({ length: 500 }, (_, k) => {
    const zc = 1 - (2 * (k + 0.5)) / 500, r = Math.sqrt(1 - zc * zc), phi = k * Math.PI * (3 - Math.sqrt(5));
    return at([0, 0, 0], { direction: [r * Math.cos(phi), r * Math.sin(phi), zc] });
  });
  for (const e of F.orientationTensor(spread).eigenvalues) assert.ok(Math.abs(e - 1 / 3) < 0.02, `${e}`);
  assert.equal(F.orientationTensor([]).count, 0);
});

test('summarize gives the count, volume fraction, ESD percentiles in mm and the fiber count', () => {
  const ps = [at([0, 0, 0], { voxels: 100, esd_vox: 5 }), at([9, 9, 9], { voxels: 300, esd_vox: 8, clipped: true }), at([5, 5, 5], { voxels: 200, esd_vox: 7, aspect: 6, length_vox: 12, direction: [0, 1, 0] })];
  const s = F.summarize(ps, { maskVoxels: 10000, voxelMm: 0.04 });
  assert.equal(s.count, 3); assert.equal(s.clipped, 1); assert.equal(s.fibers, 1);
  assert.ok(Math.abs(s.volume_percent - 6) < 1e-9);
  assert.ok(Math.abs(s.esd_p50_mm - 0.04 * 6) < 1e-9, `${s.esd_p50_mm}`); // median of the unclipped 5 and 7
  assert.equal(s.orientation.too_few, true, 'one fiber gives no tensor');
});

test('each particle keeps its peak gray, and the measurement threshold is halfway to the median peak', () => {
  const slices = volume((x, y, z) => x >= 5 && x < 9 && y >= 5 && y < 9 && z >= 5 && z < 9);
  slices[6][6 * 40 + 6] = 3500;
  const { particles } = run(slices);
  assert.equal(particles[0].peak, 3500);
  const t = F.measurementThreshold({ median: 1000, detection: 1200 }, [2800, 3000, 3200, 9000]);
  assert.equal(t.bright_gray, 3100);
  assert.equal(t.threshold, 2050);
  assert.equal(F.measurementThreshold({ median: 1000, detection: 1200 }, []).threshold, 1200, 'no particles: detection');
});

test('candidates whose peak is within 1 SD of the detection threshold are near noise; too few for a ratio or a tensor give none', () => {
  const t = { median: 2000, sd: 250, detection: 3000 };
  assert.equal(F.nearNoise(3200, t), true);
  assert.equal(F.nearNoise(3300, t), false);
  const few = Array.from({ length: 19 }, (_, i) => at([10 * i, 0, 0]));
  assert.equal(F.dispersion(few, 1e6).clark_evans, null);
  assert.ok(F.dispersion(few, 1e6).mean_nn > 0);
  const fibers = Array.from({ length: 4 }, () => at([0, 0, 0], { direction: [0, 0, 1], aspect: 5, length_vox: 9 }));
  const o = F.orientationTensor(fibers);
  assert.equal(o.count, 4); assert.equal(o.eigenvalues, null); assert.equal(o.too_few, true);
});
