'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/ct_sheetdata.js');

const dims = { nx: 2, ny: 2, nz: 10 };
const at = (x, y, z) => (z * dims.ny + y) * dims.nx + x;

test('columnPorosity divides pore thickness by sample thickness and blanks thin columns', () => {
  const body = new Uint8Array(40), voids = new Float32Array(40);
  for (let z = 0; z < 10; z++) body[at(0, 0, z)] = 1;
  for (let z = 0; z < 4; z++) voids[at(0, 0, z)] = 0.5;
  for (let z = 0; z < 2; z++) body[at(1, 1, z)] = 1;
  const out = D.columnPorosity(voids, body, dims, 0.5, 1.5);
  assert.ok(Math.abs(out[0] - 100 * (2 * 0.5) / (10 * 0.5)) < 1e-9);
  assert.ok(Number.isNaN(out[3]), 'a 1 mm column is too thin to report');
  assert.ok(Number.isNaN(out[1]));
});

test('axialProfile reports porosity and weighted matrix gray per x slab', () => {
  const d = { nx: 2, ny: 1, nz: 2 };
  const body = Uint8Array.from([1, 1, 1, 0]);
  const voids = Float32Array.from([0.5, 0, 0.1, 0]);
  const gray = Float32Array.from([2000, 1000, 2200, 0]);
  const weight = Float32Array.from([1, 1, 1, 0]);
  const p = D.axialProfile(voids, body, gray, weight, d, 0.5);
  assert.deepEqual(p.x, [0.25, 0.75]);
  assert.ok(Math.abs(p.porosity[0] - 100 * 0.6 / 2) < 1e-5, "float32 inputs");
  assert.equal(p.porosity[1], 0);
  assert.ok(Math.abs(p.gray[0] - 2100) < 1e-9);
});

test('sizeBins counts kept pores and their share of pore volume, last bin open', () => {
  const pores = [{ id: 1, diameter_mm: 0.3, volume_mm3: 1 }, { id: 2, diameter_mm: 0.7, volume_mm3: 2 }, { id: 3, diameter_mm: 5, volume_mm3: 7 }, { id: 4, diameter_mm: 5, volume_mm3: 90 }];
  const out = D.sizeBins(pores, new Set([4]), [0.5, 1, 2, 4]);
  assert.deepEqual(out.map((b) => b.label), ['0.5 to 1 mm', '1 to 2 mm', '2 to 4 mm', '≥ 4 mm']);
  assert.deepEqual(out.map((b) => b.count), [1, 0, 0, 1]);
  assert.deepEqual(out.map((b) => b.volume_share), [0.2, 0, 0, 0.7]);
});

test('sizeDistribution conserves count and volume over logarithmic ESD bins', () => {
  const pores = [{ id: 1, diameter_mm: 0.09, volume_mm3: 0.1 }, { id: 2, diameter_mm: 0.13, volume_mm3: 0.2 }, { id: 3, diameter_mm: 20, volume_mm3: 9 }];
  const d = D.sizeDistribution(pores, new Set());
  assert.equal(d.count.reduce((a, b) => a + b, 0), 3);
  assert.ok(Math.abs(d.volume_mm3.reduce((a, b) => a + b, 0) - 9.3) < 1e-9);
  assert.equal(d.edges_mm.length, d.count.length + 1);
  assert.equal(d.count[d.count.length - 1], 1, 'past the last edge counts in the last bin');
});

test('magma maps 0 to pale yellow and 1 to near black', () => {
  const lo = D.magmaR(0), hi = D.magmaR(1);
  assert.ok(lo[0] > 240 && lo[1] > 230 && lo[2] > 150);
  assert.ok(hi[0] < 20 && hi[1] < 20 && hi[2] < 20);
});

test('niceTicks gives round steps covering the range', () => {
  assert.deepEqual(D.niceTicks(0, 9.3, 5), [0, 2, 4, 6, 8]);
  assert.deepEqual(D.niceTicks(1100, 1500, 5), [1100, 1200, 1300, 1400, 1500]);
});

test('sliceAreaFilter drops slices whose cross-section is under the share of the largest, along every axis', () => {
  const d = { nx: 10, ny: 10, nz: 10 };
  const m = new Uint8Array(1000);
  const at = (x, y, z) => (z * 10 + y) * 10 + x;
  for (let z = 2; z < 8; z++) for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) m[at(x, y, z)] = 1;
  m[at(5, 0, 5)] = 1; m[at(5, 1, 5)] = 1;
  const out = D.sliceAreaFilter(m, d, 0.1);
  assert.equal(out[at(5, 0, 5)], 0);
  assert.equal(out[at(4, 4, 4)], 1);
  assert.equal(m[at(5, 0, 5)], 1, 'input unchanged');
});

test('extents give box lengths, a circle cut only on the facing axis, and principal lengths of a tilted bar', () => {
  const d = { nx: 40, ny: 40, nz: 10 };
  const m = new Uint8Array(d.nx * d.ny * d.nz);
  for (let z = 2; z < 8; z++) for (let y = 15; y < 25; y++) for (let x = 1; x < 39; x++) m[(z * 40 + y) * 40 + x] = 1;
  const e = D.extents(m, d, 1.0, { cx: 20, cy: 20, r: 20 });
  assert.equal(e.x.mm, 38); assert.equal(e.y.mm, 10); assert.equal(e.z.mm, 6);
  assert.equal(e.x.cut, true); assert.equal(e.y.cut, false); assert.equal(e.z.cut, false);
  const t = new Uint8Array(80 * 80 * 30);
  for (let z = 10; z < 20; z++) for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) if (Math.abs(x - y) < 5 && Math.abs(x + y - 80) < 60) t[(z * 80 + y) * 80 + x] = 1;
  const p = D.extents(t, { nx: 80, ny: 80, nz: 30 }, 1.0, null).principal_mm;
  assert.ok(p[0] > 1.5 * p[1], `principal ${p}`);
});

test('methods line names where the voxel size and scan settings came from', () => {
  const VX = require('../app/vb_vox.js');
  const m = (o) => D.methodsSourceLine({ voxelMm: 0.0123, binFactor: 1, scanInfo: null, kind: 'tiff', settingsText: VX.settingsText, ...o });
  assert.equal(m({}), 'Voxel 12.30 µm (TIFF tag). Acquisition parameters not recorded.');
  assert.equal(m({ binFactor: 2 }), 'Voxel 12.30 µm (2× the TIFF tag, binned). Acquisition parameters not recorded.');
  const info = { kv: 80, ua: 220, scanSeconds: 256 };
  assert.equal(m({ kind: 'vox', scanInfo: info }), 'Voxel 12.30 µm (from the scan file). Scanned at 80 kV, 220 µA, 4 min 16 s scan.');
  assert.equal(m({ kind: 'vox' }), 'Voxel 12.30 µm (from the scan file). Acquisition parameters not recorded.');
  assert.equal(m({ kind: 'vox', binFactor: 2 }), 'Voxel 12.30 µm (2× the scan file spacing, binned). Acquisition parameters not recorded.');
  assert.match(m({ scanInfo: info }), /^Voxel 12\.30 µm \(TIFF tag\)\. Scanned at 80 kV/);
});
