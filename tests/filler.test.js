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
