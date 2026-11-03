'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../app/ct_regions.js');

const DIMS = { nx: 6, ny: 6, nz: 4 };
function slicesOf(fn) {
  const out = [];
  for (let z = 0; z < 4; z++) {
    const s = new Uint16Array(36);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) s[y * 6 + x] = fn(x, y, z);
    out.push(s);
  }
  return out;
}
const SQUARE = [{ col: 1, row: 1 }, { col: 4.99, row: 1 }, { col: 4.99, row: 4.99 }, { col: 1, row: 4.99 }];

test('simplifyFreehand drops points closer than the tolerance and keeps the last one', () => {
  const pts = [{ col: 0, row: 0 }, { col: 0.4, row: 0 }, { col: 3, row: 0 }, { col: 3.2, row: 0.1 }, { col: 3, row: 4 }];
  assert.deepEqual(R.simplifyFreehand(pts, 2), [{ col: 0, row: 0 }, { col: 3, row: 0 }, { col: 3, row: 4 }]);
});

const LOT = [{ id: 'lot_7', label: 'Lot 7', color: '#123456' }];

test('makeRegion accepts a user label and refuses one that is not defined', () => {
  const args = { id: 'r', now: 't', sample: {}, plane: 'XY', sliceFrom: 0, sliceTo: 0, points: SQUARE, note: '', voxelMm: 0.04, dims: DIMS };
  const r = R.makeRegion({ ...args, label: 'lot_7' }, LOT);
  assert.equal(r.label, 'lot_7');
  assert.equal(r.belief_not_measurement, true);
  assert.equal(R.makeRegion({ ...args, label: 'crop' }, LOT).belief_not_measurement, false);
  assert.throws(() => R.makeRegion({ ...args, label: 'region_a' }, LOT), /Unknown region label/);
});

test('labelOf names a deleted label instead of failing', () => {
  assert.deepEqual(R.labelOf('lot_7', LOT), LOT[0]);
  assert.deepEqual(R.labelOf('crop', LOT), R.CROP);
  assert.deepEqual(R.labelOf('gone', LOT), { id: 'gone', label: '(deleted label)', color: '#8b97a5' });
});

test('default labels are generic', () => {
  assert.deepEqual(R.DEFAULT_LABELS.map((l) => l.label), ['Region A', 'Region B', 'Other']);
});

test('makeRegion stores a labeled outline with its slice range, and refuses a bad one', () => {
  const r = R.makeRegion({ id: 'r1', now: 't', sample: { folder: 'S' }, plane: 'XZ', sliceFrom: 5, sliceTo: 3, points: SQUARE, label: 'region_b', note: 'n', voxelMm: 0.04, dims: DIMS });
  assert.equal(r.slice_from, 3); assert.equal(r.slice_to, 5);
  assert.equal(r.label, 'region_b');
  assert.equal(r.belief_not_measurement, true);
  assert.throws(() => R.makeRegion({ id: 'r', now: 't', sample: {}, plane: 'XY', sliceFrom: 0, sliceTo: 0, points: SQUARE, label: 'doped', note: '', voxelMm: 0.04, dims: DIMS }), /label/);
  assert.throws(() => R.makeRegion({ id: 'r', now: 't', sample: {}, plane: 'XY', sliceFrom: 0, sliceTo: 0, points: SQUARE.slice(0, 2), label: 'crop', note: '', voxelMm: 0.04, dims: DIMS }), /3 points/);
});

test('regionStats measures gray and volume only inside the outline, across its slice range', () => {
  const slices = slicesOf((x, y, z) => (x >= 1 && x < 5 && y >= 1 && y < 5 ? 1000 + z : 7));
  const region = { plane: 'XY', slice_from: 1, slice_to: 2, points: SQUARE };
  const s = R.regionStats({ slices, dims: DIMS, region, voxelMm: 0.1 });
  assert.equal(s.voxels, 32);
  assert.ok(Math.abs(s.volume_mm3 - 0.032) < 1e-9);
  assert.equal(s.gray_mean, 1001.5);
  assert.equal(s.gray_p50, 1001);
  assert.ok(s.gray_sd > 0.4 && s.gray_sd < 0.6);
});

test('regionStats leaves pore numbers null, not zero, until pores have been detected', () => {
  const slices = slicesOf(() => 1000);
  const s = R.regionStats({ slices, dims: DIMS, region: { plane: 'XY', slice_from: 0, slice_to: 0, points: SQUARE }, voxelMm: 0.1 });
  assert.equal(s.pore_fraction, null);
  assert.equal(s.matrix_gray_mean, null);
});

test('regionStats separates pore and matrix voxels, and skips rejected pores', () => {
  const slices = slicesOf((x) => (x === 1 ? 500 : 2000));
  const labels = new Uint32Array(6 * 6 * 4);
  for (let z = 0; z < 4; z++) for (let y = 0; y < 6; y++) { labels[(z * 6 + y) * 6 + 1] = 1; labels[(z * 6 + y) * 6 + 2] = 2; }
  const pores = [{ id: 1, crack_like: false, diameter_mm: 0.5 }, { id: 2, crack_like: false, diameter_mm: 0.5 }];
  const s = R.regionStats({ slices, dims: DIMS, region: { plane: 'XY', slice_from: 0, slice_to: 3, points: SQUARE }, voxelMm: 0.1, pores: { idAt: (x, y, z) => labels[(z * 6 + y) * 6 + x], list: pores, rejected: new Set([2]) } });
  assert.equal(s.pore_fraction, 0.25);
  assert.equal(s.pore_count, 1);
  assert.equal(s.matrix_gray_mean, (2000 * 48) / 48 * 1);
});

test('regionStats excludes voxels outside the circle but counts a zero voxel inside it', () => {
  const slices = slicesOf((x) => (x === 1 ? 0 : 1000));
  const region = { plane: 'XY', slice_from: 0, slice_to: 0, points: SQUARE };
  const inCircle = R.regionStats({ slices, dims: DIMS, region, voxelMm: 0.1, circle: { cx: 3, cy: 3, r: 100 } });
  assert.equal(inCircle.voxels, 16);
  assert.equal(inCircle.gray_mean, 750);
  const cut = R.regionStats({ slices, dims: DIMS, region, voxelMm: 0.1, circle: { cx: 5, cy: 3, r: 2.2 } });
  assert.ok(cut.voxels < 16);
  assert.equal(cut.gray_mean, 1000);
});

test('estimateAirGray takes the median outside the body and outside the reconstruction', () => {
  const gray = Float32Array.from([0, 640, 650, 660, 2000, 2000]);
  const outside = Uint8Array.from([1, 0, 0, 0, 0, 0]);
  const filled = Uint8Array.from([0, 0, 0, 0, 1, 1]);
  assert.equal(R.estimateAirGray(gray, outside, filled), 650);
});

test('densityEstimate is relative to the reference with air as zero, and g/cm3 only with an assumed value', () => {
  const rel = R.densityEstimate({ gray: 1350, airGray: 650, referenceGray: 2050 });
  assert.equal(rel.relative, 0.5);
  assert.equal(rel.g_cm3, null);
  const est = R.densityEstimate({ gray: 1350, airGray: 650, referenceGray: 2050, referenceDensity: 1.01 });
  assert.ok(Math.abs(est.g_cm3 - 0.505) < 1e-9);
  assert.equal(R.densityEstimate({ gray: 1350, airGray: 650, referenceGray: 650 }).relative, null);
});



test('deleting a label that was never stored saves the list without it; a stored one is removed', () => {
  const list = R.DEFAULT_LABELS;
  assert.deepEqual(R.labelDelete(list, 'region_b', false), { save: list.filter((l) => l.id !== 'region_b'), remove: null });
  assert.deepEqual(R.labelDelete(list, 'region_b', true), { save: null, remove: 'region_b' });
});

test('a phantom region carries its name and measured density, and is a measurement', () => {
  const args = { id: 'p', now: 't', sample: {}, plane: 'XY', sliceFrom: 0, sliceTo: 2, points: SQUARE, note: '', voxelMm: 0.04, dims: DIMS, label: 'phantom' };
  const p = R.makeRegion({ ...args, phantom: { name: 'PA12 rod', density_g_cm3: 1.01 } }, R.DEFAULT_LABELS);
  assert.deepEqual(p.phantom, { name: 'PA12 rod', density_g_cm3: 1.01 });
  assert.equal(p.belief_not_measurement, false);
  assert.deepEqual(R.labelOf('phantom', R.DEFAULT_LABELS), R.PHANTOM);
  for (const bad of [{ name: '', density_g_cm3: 1 }, { name: 'x', density_g_cm3: 0 }, { name: 'x', density_g_cm3: NaN }, undefined]) {
    assert.throws(() => R.makeRegion({ ...args, phantom: bad }, R.DEFAULT_LABELS), /phantom needs a name and a measured density/);
  }
});

test('after saving a phantom or a crop, drawing continues with a user label', () => {
  const labels = [{ id: 'lot_7', label: 'Lot 7', color: '#123456' }, { id: 'other_region', label: 'Other', color: '#c9d64f' }];
  assert.equal(R.drawLabel('phantom', labels), 'lot_7');
  assert.equal(R.drawLabel('crop', labels), 'lot_7');
  assert.equal(R.drawLabel('other_region', labels), 'other_region');
});
