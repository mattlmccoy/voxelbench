'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../app/vb_connectivity.js');

/** Runs in the segmentation's layout (rows z*ny + y, runs along x) from a full-grid id volume. */
function runsFrom(ids, { nx, ny, nz }) {
  const offsets = new Int32Array(nz * ny + 1), start = [], end = [], id = [];
  for (let row = 0; row < nz * ny; row++) {
    offsets[row] = start.length;
    for (let x = 0; x < nx; x++) {
      const v = ids[row * nx + x];
      if (!v) continue;
      if (start.length > offsets[row] && end[end.length - 1] === x && id[id.length - 1] === v) end[end.length - 1] = x + 1;
      else { start.push(x); end.push(x + 1); id.push(v); }
    }
  }
  offsets[nz * ny] = start.length;
  return { offsets, start: Int32Array.from(start), end: Int32Array.from(end), id: Int32Array.from(id), rows: nz * ny };
}

const box = (dims, fn) => {
  const out = new Uint8Array(dims.nx * dims.ny * dims.nz);
  for (let z = 0, i = 0; z < dims.nz; z++) for (let y = 0; y < dims.ny; y++) for (let x = 0; x < dims.nx; x++, i++) out[i] = fn(x, y, z);
  return out;
};

test('a digital sphere is nearly spherical; an elongated ellipsoid is clearly less', () => {
  const dims = { nx: 31, ny: 21, nz: 21 };
  const sphere = box(dims, (x, y, z) => ((x - 15) ** 2 + (y - 10) ** 2 + (z - 10) ** 2 <= 64 ? 1 : 0));
  const ellipsoid = box(dims, (x, y, z) => (((x - 15) / 12) ** 2 + ((y - 10) / 4) ** 2 + ((z - 10) / 4) ** 2 <= 1 ? 1 : 0));
  const count = (m) => m.reduce((s, v) => s + v, 0);
  const s = K.sphericity(sphere, dims, count(sphere)), e = K.sphericity(ellipsoid, dims, count(ellipsoid));
  assert.ok(s > 0.9 && s <= 1.05, `sphere ${s}`);
  assert.ok(e < s - 0.1, `ellipsoid ${e} vs sphere ${s}`);
  assert.equal(K.sphericity(box(dims, () => 0).fill(1, 0, 8), dims, 8), null, 'fewer than 27 voxels');
});

// A 30^3 scan, binned by 2: the part fills full-grid 4..25 on every axis.
const dims = { nx: 30, ny: 30, nz: 30 }, bin = 2, binnedDims = { nx: 15, ny: 15, nz: 15 }, voxelMm = 0.1;
const filled = box(binnedDims, (x, y, z) => (x >= 2 && x <= 12 && y >= 2 && y <= 12 && z >= 2 && z <= 12 ? 1 : 0));
const pore = (id, x0, x1, y0, y1, z0, z1, extra = {}) => ({ id, x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, volume_mm3: (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) * voxelMm ** 3, clipped: false, ...extra });

function part(spec) {
  const ids = box(dims, (x, y, z) => {
    for (const [id, x0, x1, y0, y1, z0, z1] of spec) if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1) return id;
    return 0;
  });
  return { runs: runsFrom(ids, dims), pores: spec.map(([id, ...b]) => pore(id, ...b)) };
}

test('a pore at the top face is open, an interior one closed, and they add up to the total', () => {
  const { runs, pores } = part([[1, 10, 13, 10, 13, 4, 7], [2, 13, 16, 13, 16, 13, 16]]);
  pores[1].clipped = true;
  const out = K.annotatePores({ pores, runs, dims, filled, binnedDims, bin, voxelMm });
  const byId = new Map(out.pores.map((p) => [p.id, p]));
  assert.equal(byId.get(1).open, true);
  assert.equal(byId.get(2).open, false);
  assert.equal(byId.get(2).clipped, true, 'clipped flag kept');
  assert.ok(byId.get(2).surface_distance_mm > byId.get(1).surface_distance_mm);
  const body = filled.reduce((s, v) => s + v, 0) * (bin * voxelMm) ** 3;
  assert.ok(Math.abs(out.summary.open_percent + out.summary.closed_percent - (100 * (pores[0].volume_mm3 + pores[1].volume_mm3)) / body) < 1e-9);
  assert.equal(pores[0].open, undefined, 'input pores are not changed');
});

test('two touching pores from the top face to the bottom face form one network, through along z', () => {
  const { runs, pores } = part([[3, 20, 21, 20, 21, 4, 14], [4, 20, 21, 20, 21, 15, 25], [5, 8, 9, 8, 9, 12, 14]]);
  const out = K.annotatePores({ pores, runs, dims, filled, binnedDims, bin, voxelMm });
  const byId = new Map(out.pores.map((p) => [p.id, p]));
  assert.equal(byId.get(3).network, byId.get(4).network);
  assert.notEqual(byId.get(5).network, byId.get(3).network);
  assert.deepEqual(out.summary.through, { x: false, y: false, z: true });
  assert.equal(out.summary.networks, 2);
});

test('a part with no pores gives zeros and no networks', () => {
  const { runs } = part([]);
  const out = K.annotatePores({ pores: [], runs, dims, filled, binnedDims, bin, voxelMm });
  assert.deepEqual(out.summary, { open_mm3: 0, closed_mm3: 0, open_percent: 0, closed_percent: 0, networks: 0, through: { x: false, y: false, z: false } });
});
