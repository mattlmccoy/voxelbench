'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../app/vb_wall.js');

const box = (dims, fn) => {
  const out = new Uint8Array(dims.nx * dims.ny * dims.nz);
  for (let z = 0, i = 0; z < dims.nz; z++) for (let y = 0; y < dims.ny; y++) for (let x = 0; x < dims.nx; x++, i++) out[i] = fn(x, y, z) ? 1 : 0;
  return out;
};

test('a plate 6 voxels thick reads 6 ± 1 voxels of wall', () => {
  const dims = { nx: 40, ny: 40, nz: 20 };
  const r = W.wallThickness(box(dims, (x, y, z) => x >= 5 && x < 35 && y >= 5 && y < 35 && z >= 7 && z < 13), dims, 0.1);
  assert.ok(r.ridge.length > 50, `${r.ridge.length}`);
  assert.ok(Math.abs(r.stats.p50_mm - 0.6) <= 0.1, `median ${r.stats.p50_mm}`);
});

test('a thin wall and a thick wall: the thin one is listed first, and the minimum is the thin wall', () => {
  const dims = { nx: 50, ny: 30, nz: 30 };
  const part = (x, y, z) => y >= 5 && y < 25 && z >= 5 && z < 25 && ((x >= 5 && x < 9) || (x >= 20 && x < 40) || (x >= 9 && x < 20 && z >= 5 && z < 9));
  const r = W.wallThickness(box(dims, part), dims, 0.1);
  assert.ok(r.thinnest.length > 0 && r.thinnest.length <= 20);
  assert.ok(r.thinnest[0].thickness_mm <= 0.5, `${r.thinnest[0].thickness_mm}`);
  assert.ok(r.thinnest[0].x < 20, `thin wall at x ${r.thinnest[0].x}`);
  assert.ok(Math.abs(r.stats.min_mm - r.thinnest[0].thickness_mm) < 1e-12);
  assert.ok(r.stats.max_mm >= 1.5, `${r.stats.max_mm}`); // the thick block; most ridge voxels lie in the two thin walls
});

test('an empty mask gives no ridge and null statistics', () => {
  const dims = { nx: 5, ny: 5, nz: 5 };
  const r = W.wallThickness(new Uint8Array(125), dims, 0.1);
  assert.equal(r.ridge.length, 0); assert.equal(r.stats.min_mm, null);
});

test('a one-voxel fin is below the resolved range and not listed; a flange in the first slice is not thin, since the part continues past the stack', () => {
  const dims = { nx: 30, ny: 30, nz: 30 };
  const slab = (x, y) => x >= 5 && x < 25 && y >= 5 && y < 25; // runs through every slice
  const fin = (x, y, z) => x === 25 && y >= 10 && y < 20 && z >= 10 && z < 20;
  const flange = (x, y, z) => z === 0 && x >= 1 && x < 29 && y >= 1 && y < 29;
  const r = W.wallThickness(box(dims, (x, y, z) => slab(x, y) || fin(x, y, z) || flange(x, y, z)), dims, 0.1);
  assert.ok(r.stats.min_mm >= 0.35, `thinnest ${r.stats.min_mm} at ${JSON.stringify(r.thinnest[0])}`);
});
