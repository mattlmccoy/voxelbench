'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../app/vb_volume.js');
const CT = require('../app/ct_core.js');

const REF = require('./fixtures/block_mean_reference.json');

test('binGroup matches the Python block mean, rounded to the nearest gray value', () => {
  const [nz, ny, nx] = REF.shape_zyx, f = REF.factor;
  const [oz, oy, ox] = REF.output_shape_zyx;
  const slice = (z) => Uint16Array.from(REF.input.slice(z * ny * nx, (z + 1) * ny * nx));
  for (let k = 0; k < oz; k++) {
    const got = V.binGroup(Array.from({ length: f }, (_, j) => slice(k * f + j)), nx, ny, f);
    assert.equal(got.length, oy * ox);
    const want = REF.output.slice(k * oy * ox, (k + 1) * oy * ox).map(Math.round);
    assert.deepEqual([...got], want, `binned slice ${k}`);
  }
  assert.ok(nz >= oz * f);
});

test('planBinning keeps a Sample-2-sized scan at full resolution', () => {
  assert.equal(V.planBinning({ width: 1392, height: 784, depth: 503 }, 1.2e9), 1);
});

test('planBinning bins a large scan, and a scan just over the budget, by 2', () => {
  assert.equal(V.planBinning({ width: 1800, height: 1800, depth: 1200 }, 1.2e9), 2);
  assert.equal(V.planBinning({ width: 2000, height: 2000, depth: 1500 }, 1.2e9), 3, '1.5 GB at 2x is still over');
  assert.equal(V.planBinning({ width: 1000, height: 1000, depth: 618 }, 1.2e9), 2, '3 % over the budget');
});

test('planBinning refuses a scan too large even at 4x', () => {
  assert.throws(() => V.planBinning({ width: 20000, height: 20000, depth: 20000 }, 1.2e9), /Too large even at 4× binning/);
});

test('budgetBytes reads the URL override and lowers the budget on Safari', () => {
  const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const safari = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  assert.equal(V.budgetBytes(chrome, ''), 1.2e9);
  assert.equal(V.budgetBytes(safari, ''), 6e8);
  assert.equal(V.budgetBytes(chrome, '?budget=0.5'), 5e8);
});

test('provenanceLine states resolution, binning, calibration and version', () => {
  assert.equal(CT.provenanceLine({ voxelMm: 0.08, binFactor: 2, calibration: null, toolVersion: '0.1.0' }),
    'Computed at 80 µm voxels (2× binned from 40 µm); smallest resolved pore ESD 0.24 mm; gray uncalibrated; VoxelBench 0.1.0');
  assert.equal(CT.provenanceLine({ voxelMm: 0.04, binFactor: 1, calibration: null, toolVersion: '0.1.0' }),
    'Computed at 40 µm voxels (full resolution); smallest resolved pore ESD 0.12 mm; gray uncalibrated; VoxelBench 0.1.0');
});

test('checkSlice names both files and both sizes when a slice differs from the first', () => {
  const first = { width: 10, height: 8, voxelMm: 0.04 };
  assert.doesNotThrow(() => V.checkSlice(first, { width: 10, height: 8, voxelMm: 0.04 }, 'b.tiff', 'a.tiff'));
  assert.throws(() => V.checkSlice(first, { width: 12, height: 8, voxelMm: 0.04 }, 'slice_0001.tif', 'preview.tif'),
    { message: 'slice_0001.tif is 12 × 8 px at 0.0400 mm, but the first file, preview.tif, is 10 × 8 px at 0.0400 mm. Remove the file that is not a slice.' });
});

test('gridText names the grid numbers are on', () => {
  assert.equal(CT.gridText(1), 'full resolution');
  assert.equal(CT.gridText(2), '2× binned');
});

test('CSV comments name a binned grid instead of claiming full resolution', () => {
  const E = require('../app/ct_export.js');
  const ctx = { sample: { folder: 'S', name: 'S' }, settings: {}, summary: {}, binFactor: 2 };
  for (const csv of [E.poreCsv([], new Set(), ctx), E.patchCsv([], ctx)]) {
    assert.ok(!/full.resolution/i.test(csv), csv.slice(0, 300));
    assert.ok(/2× binned grid/.test(csv), csv.slice(0, 300));
  }
});

const REGION = { id: 'r', plane: 'XY', points: [{ col: 4, row: 6 }, { col: 10, row: 6 }, { col: 10, row: 12 }], slice_from: 10, slice_to: 19, voxel_mm: 0.04 };

test('toGrid returns a record already on the loaded grid unchanged', () => {
  assert.equal(CT.toGrid(REGION, 1), REGION, 'no bin_factor means full resolution');
  const binned = { ...REGION, bin_factor: 2 };
  assert.equal(CT.toGrid(binned, 2), binned);
});

test('toGrid maps a full-resolution region onto a 2x binned grid and back', () => {
  const half = CT.toGrid(REGION, 2);
  assert.deepEqual(half.points, [{ col: 1.75, row: 2.75 }, { col: 4.75, row: 2.75 }, { col: 4.75, row: 5.75 }]);
  assert.equal(half.slice_from, 5); assert.equal(half.slice_to, 9);
  assert.equal(half.bin_factor, 2); assert.equal(half.voxel_mm, 0.08);
  const back = CT.toGrid(half, 1);
  assert.deepEqual(back.points, REGION.points);
  assert.equal(back.slice_from, 10); assert.equal(back.slice_to, 19);
});

test('toGrid keeps every slice of an odd range when binning', () => {
  const r = CT.toGrid({ ...REGION, slice_from: 11, slice_to: 18 }, 2);
  assert.equal(r.slice_from, 5); assert.equal(r.slice_to, 9);
});

test('toGrid moves annotation voxels and the slice index to the loaded grid', () => {
  const a = { id: 'a', plane: 'XZ', slice: 7, voxels: [{ x: 3, y: 7, z: 9 }], mm: [{ x: 0.12, y: 0.28, z: 0.36 }], voxel_mm: 0.04 };
  const b = CT.toGrid(a, 2);
  assert.deepEqual(b.voxels, [{ x: 1, y: 3, z: 4 }]);
  assert.equal(b.slice, 3);
  assert.deepEqual(b.mm, a.mm, 'mm do not depend on the grid');
});

test('new records note the grid they were drawn on', () => {
  const R = require('../app/ct_regions.js');
  const dims = { nx: 50, ny: 40, nz: 30 };
  const a = CT.makeAnnotation({ sample: { folder: 'S' }, dims, voxelMm: 0.08, binFactor: 2, window: { low: 0, high: 1 }, id: 'a', now: 't', plane: 'XY', slice: 7, kind: 'point', type: 'pore', note: '', points: [{ col: 3, row: 4 }] });
  assert.equal(a.bin_factor, 2);
  assert.equal(a.tiff_file_number, 15, 'binned slice 7 starts at file 15');
  const r = R.makeRegion({ id: 'r', now: 't', sample: {}, plane: 'XY', sliceFrom: 0, sliceTo: 3, points: [{ col: 0, row: 0 }, { col: 5, row: 0 }, { col: 5, row: 5 }], label: 'crop', note: '', voxelMm: 0.08, dims, binFactor: 2 });
  assert.equal(r.bin_factor, 2);
});

test('provenanceLine names a calibration by its point count', () => {
  const fit = { ok: true, method: 'linear', n: 3 };
  assert.equal(CT.provenanceLine({ voxelMm: 0.04, binFactor: 1, calibration: fit, toolVersion: '0.1.0' }),
    'Computed at 40 µm voxels (full resolution); smallest resolved pore ESD 0.12 mm; gray calibrated to equivalent density (3 points, linear); VoxelBench 0.1.0');
  assert.match(CT.provenanceLine({ voxelMm: 0.04, binFactor: 1, calibration: { ok: false }, toolVersion: '0.1.0' }), /gray uncalibrated/);
});
