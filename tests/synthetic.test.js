'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CT = require('../app/ct_core.js');
const S = require('../app/vb_synthetic.js');
const H = require('../tools/headless_run.js');

test('writeTiff writes a slice parseTiff reads back, voxel size included', () => {
  const pixels = Uint16Array.from([1, 2, 3, 400, 500, 65535]);
  const t = CT.parseTiff(CT.writeTiff(3, 2, pixels, 0.04));
  assert.equal(t.width, 3); assert.equal(t.height, 2);
  assert.deepEqual([...t.pixels], [...pixels]);
  assert.ok(Math.abs(t.voxelMm - 0.04) < 1e-6, String(t.voxelMm));
});

test('makeScan is reproducible from its seed', async () => {
  const a = S.makeScan({ size: 40, seed: 3 }), b = S.makeScan({ size: 40, seed: 3 });
  assert.equal(a.files.length, 40);
  assert.equal(a.files[0].webkitRelativePath, 'synthetic_scan/synthetic_001.tif');
  assert.deepEqual(new Uint8Array(await a.files[20].arrayBuffer()), new Uint8Array(await b.files[20].arrayBuffer()));
  assert.deepEqual(a.truth, b.truth);
});

test('segmenting the synthetic scan finds every pore and its porosity', async () => {
  const { files, truth } = S.makeScan({});
  const tiffs = await Promise.all(files.map(async (f) => CT.parseTiff(await f.arrayBuffer())));
  const stack = { slices: tiffs.map((t) => t.pixels), voxelMm: tiffs[0].voxelMm, dims: { nx: tiffs[0].width, ny: tiffs[0].height, nz: tiffs.length } };
  const a = H.analyze(stack, { settings: { poreThreshold: 1350 } }, { patches: false });
  assert.equal(a.base.result.pores.length, truth.pore_count);
  const got = a.summary.all_void_percent_of_body;
  assert.ok(Math.abs(got - truth.porosity_percent) / truth.porosity_percent < 0.1, `porosity ${got} vs ${truth.porosity_percent}`);
});

test('the synthetic scan with phantom rods calibrates the matrix to its true density', async () => {
  const R = require('../app/ct_regions.js');
  const Cal = require('../app/vb_calibration.js');
  const size = 160;
  const { files, truth } = S.makeScan({ size, phantoms: true });
  assert.equal(truth.phantoms.length, 2);
  const tiffs = await Promise.all(files.map(async (f) => CT.parseTiff(await f.arrayBuffer())));
  const slices = tiffs.map((t) => t.pixels), dims = { nx: size, ny: size, nz: size }, voxelMm = tiffs[0].voxelMm;
  const circle = CT.fitCircle(slices[size >> 1], size, size);
  const disk = (cx, cy, r) => Array.from({ length: 16 }, (_, k) => ({ col: cx + r * Math.cos((k * Math.PI) / 8), row: cy + r * Math.sin((k * Math.PI) / 8) }));
  const statsOf = (points) => R.regionStats({ slices, dims, region: { plane: 'XY', points, slice_from: 20, slice_to: size - 20 }, voxelMm, pores: null, circle });
  const phantoms = truth.phantoms.map((p) => ({ name: p.name, density_g_cm3: p.density_g_cm3, gray: statsOf(disk(p.center.x, p.center.y, 0.7 * p.radius)).gray_p50 }));
  const c = (size - 1) / 2;
  const airGray = statsOf(disk(c - 0.39 * size * Math.SQRT1_2, c + 0.39 * size * Math.SQRT1_2, 5)).gray_p50; // between part and FOV edge, no rod
  const fit = Cal.fitCalibration(Cal.calibrationPoints(phantoms, { airGray, includeAir: true }));
  assert.equal(fit.ok, true);
  assert.equal(fit.n, 3);
  const matrix = Cal.applyCalibration(fit, statsOf(disk(c, c, 20)).gray_p50);
  assert.ok(Math.abs(matrix.value - truth.matrix_density) < 0.01, `${matrix.value} vs ${truth.matrix_density}`);
  assert.equal(matrix.extrapolated, false);
});

test('the synthetic pores are all closed and nearly spherical', async () => {
  const { files, truth } = S.makeScan({});
  const tiffs = await Promise.all(files.map(async (f) => CT.parseTiff(await f.arrayBuffer())));
  const stack = { slices: tiffs.map((t) => t.pixels), voxelMm: tiffs[0].voxelMm, dims: { nx: tiffs[0].width, ny: tiffs[0].height, nz: tiffs.length } };
  const a = H.analyze(stack, { settings: { poreThreshold: 1350 } }, { patches: false });
  const c = a.connectivity;
  assert.equal(c.pores.length, truth.pore_count);
  assert.equal(c.pores.filter((p) => p.open).length, 0);
  assert.equal(c.summary.open_percent, 0);
  for (const p of c.pores) if (p.sphericity !== null) assert.ok(p.sphericity >= 0.8, `pore ${p.id}: ${p.sphericity}`);
  assert.ok(c.pores.every((p) => p.surface_distance_mm > 0.1));
});

test('a crop face counts as surface: synthetic pores cut by it read as open, pores clear of it stay closed', async () => {
  const size = 160;
  const { files, truth } = S.makeScan({});
  const tiffs = await Promise.all(files.map(async (f) => CT.parseTiff(await f.arrayBuffer())));
  const stack = { slices: tiffs.map((t) => t.pixels), voxelMm: tiffs[0].voxelMm, dims: { nx: size, ny: size, nz: size } };
  const cut = 80; // keep x < cut
  const crops = [{ plane: 'XY', points: [{ col: 0, row: 0 }, { col: cut, row: 0 }, { col: cut, row: size }, { col: 0, row: size }] }];
  const a = H.analyze(stack, { settings: { poreThreshold: 1350 }, crops }, { patches: false });
  const found = a.connectivity.pores;
  const near = (p) => found.reduce((best, q) => (Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < Math.hypot(best.x - p.x, best.y - p.y, best.z - p.z) ? q : best));
  const straddle = truth.pores.filter((p) => p.x - p.r < cut - 5 && p.x + p.r > cut + 3); // keeps at least 5 voxels inside the crop
  const clear = truth.pores.filter((p) => p.x + p.r < cut - 6);
  assert.ok(straddle.length > 0 && clear.length > 0, `${straddle.length} cut, ${clear.length} clear`);
  for (const p of straddle) {
    const q = near(p);
    assert.ok(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < p.r, `cut pore at x=${p.x.toFixed(1)} was found`);
    assert.equal(q.open, true, `cut pore at x=${p.x.toFixed(1)}`);
  }
  for (const p of clear) assert.equal(near(p).open, false, `clear pore at x=${p.x.toFixed(1)}`);
});

test('the synthetic scan with a dense band gives step 3 a high-gray zone over pore-free ends', async () => {
  const { files, truth } = S.makeScan({ denseBand: true, voxelMm: 0.1 });
  const tiffs = await Promise.all(files.map(async (f) => CT.parseTiff(await f.arrayBuffer())));
  const stack = { slices: tiffs.map((t) => t.pixels), voxelMm: tiffs[0].voxelMm, dims: { nx: tiffs[0].width, ny: tiffs[0].height, nz: tiffs.length } };
  const a = H.analyze(stack, { settings: { poreThreshold: 1350 } }, { zoneBaseline: 'auto' });
  assert.equal(a.base.result.pores.length, truth.pore_count);
  assert.equal(a.automatic.refused, null);
  assert.equal(a.automatic.method, 'ends');
  const high = a.automatic.stats.find((s) => s.zone === 2);
  assert.ok(high.volume_mm3 > 100, `high-gray zone ${high.volume_mm3} mm³`);
  assert.ok(Math.abs(high.solid_gray_mean - truth.dense_band.gray) < 30, `${high.solid_gray_mean} vs ${truth.dense_band.gray}`);
});
