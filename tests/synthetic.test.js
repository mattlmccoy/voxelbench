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

test('holder scenes are reproducible and their truth masks are disjoint', () => {
  const a = S.makeHolderScene({ size: 48, seed: 5, holder: 'post', tape: true }), b = S.makeHolderScene({ size: 48, seed: 5, holder: 'post', tape: true });
  assert.deepEqual(a.gray, b.gray);
  for (const scene of [a, S.makeHolderScene({ size: 48, seed: 2, holder: 'plates', part: 'cube', tape: true })]) {
    const { part, holder, tape } = scene.truth;
    let overlap = 0, nPart = 0, nHolder = 0, nTape = 0;
    for (let i = 0; i < part.length; i++) { overlap += (part[i] && holder[i]) + (part[i] && tape[i]) + (holder[i] && tape[i]); nPart += part[i]; nHolder += holder[i]; nTape += tape[i]; }
    assert.equal(overlap, 0);
    assert.ok(nPart > 0 && nHolder > 0 && nTape > 0, `${nPart} ${nHolder} ${nTape}`);
  }
  let onSlice0 = 0;
  for (let i = 0; i < 48 * 48; i++) onSlice0 += a.truth.holder[i];
  assert.ok(onSlice0 > 0);
  const plates = S.makeHolderScene({ size: 48, holder: 'plates' });
  assert.deepEqual(plates.truth.pieces.map((p) => p.kind), ['plate', 'plate', 'plate']);
  assert.ok(plates.truth.pieces.every((p) => p.thicknessVox > 0));
  assert.ok(a.truth.pieces.every((p) => p.kind === 'post' && p.radiusVox > 0));
  assert.equal(S.makeHolderScene({ size: 48, holder: 'none' }).truth.holder.reduce((s, v) => s + v, 0), 0);
});

test('a bright holder reads brighter than the part', () => {
  const median = (scene, mask) => { const v = []; for (let i = 0; i < mask.length; i++) if (mask[i]) v.push(scene.gray[i]); v.sort((p, q) => p - q); return v[v.length >> 1]; };
  for (const [holderGray, test] of [['bright', (d) => d > 400], ['same', (d) => Math.abs(d) < 50]]) {
    const s = S.makeHolderScene({ size: 48, part: 'cube', holderGray });
    const d = median(s, s.truth.holder) - median(s, s.truth.part);
    assert.ok(test(d), `${holderGray}: ${d}`);
  }
});

test('holder scene parts rest on the holder, tape touches the part, and the options do what they say', () => {
  const touches = (n, a, b) => { // voxels of a face-adjacent to b
    let k = 0;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = x + n * (y + n * z);
      if (a[i] && ((x > 0 && b[i - 1]) || (x < n - 1 && b[i + 1]) || (y > 0 && b[i - n]) || (y < n - 1 && b[i + n]) || (z > 0 && b[i - n * n]) || (z < n - 1 && b[i + n * n]))) k++;
    }
    return k;
  };
  const n = 64, rimOf = (mask) => { let k = 0; for (let i = 0; i < n ** 3; i++) if (mask[i] && Math.hypot((i % n) - (n - 1) / 2, (Math.floor(i / n) % n) - (n - 1) / 2) > 0.47 * n - 2) k++; return k; };
  for (const holder of ['post', 'plates']) for (const part of ['blob', 'cube']) {
    const s = S.makeHolderScene({ size: n, holder, part, tape: true, inclusions: true });
    assert.ok(touches(n, s.truth.part, s.truth.holder) > 20, `${holder} ${part} rests`);
    const t = touches(n, s.truth.tape, s.truth.part);
    assert.equal(t, 3, `${holder} ${part} tape touches ${t}`);
    assert.ok(s.truth.tape.reduce((a, v) => a + v, 0) > 100);
  }
  assert.ok(rimOf(S.makeHolderScene({ size: n, holder: 'plates' }).truth.holder) > 50, 'plates reach the FOV edge');
  const inc = S.makeHolderScene({ size: n, part: 'cube', inclusions: true });
  let bright = 0;
  for (let i = 0; i < n ** 3; i++) if (inc.truth.part[i] && inc.gray[i] > 2400 + 3 * 60) bright++;
  assert.ok(bright > 30, `inclusions: ${bright}`);
  const edge = S.makeHolderScene({ size: n, touchEdge: true }), mid = S.makeHolderScene({ size: n });
  assert.ok(rimOf(edge.truth.part) > 20 && rimOf(mid.truth.part) === 0, `${rimOf(edge.truth.part)} ${rimOf(mid.truth.part)}`);
  assert.ok(edge.outside.some((v, i) => v && edge.gray[i] === 0));
});

test('a holder scene merges part and holder in the sample mask, as a real part resting flat does', () => {
  // The app's own body builder: smooth (sigma 1), threshold midway between matrix and air, open, keep the largest
  // component, close and fill. Default size: the stem (0.06 of the size) and plates (0.06) are thick enough to survive the opening.
  const P = require('../app/ct_pores.js');
  for (const [holder, part] of [['post', 'blob'], ['plates', 'blob'], ['post', 'cube']]) {
    const s = S.makeHolderScene({ holder, part }), n = Math.cbrt(s.gray.length), dims = { nx: n, ny: n, nz: n };
    const mid = (s.truth.matrix_gray + s.truth.air_gray) / 2;
    const { filled } = P.buildBody(s.gray, s.outside, dims, { ...P.DEFAULT_SETTINGS, sigma: 1, bodyThreshold: mid }, null);
    let nPart = 0, inPart = 0, nHolder = 0, inHolder = 0;
    for (let i = 0; i < filled.length; i++) { nPart += s.truth.part[i]; nHolder += s.truth.holder[i]; if (filled[i]) { inPart += s.truth.part[i]; inHolder += s.truth.holder[i]; } }
    assert.ok(inPart >= 0.95 * nPart && inHolder >= 0.95 * nHolder, `${holder} ${part}: part ${inPart}/${nPart}, holder ${inHolder}/${nHolder}`);
  }
});

test('the tape truth never marks voxels outside the scan', () => {
  const s = S.makeHolderScene({ size: 64, tape: true, touchEdge: true });
  let tape = 0, out = 0;
  for (let i = 0; i < s.outside.length; i++) if (s.truth.tape[i]) { tape++; out += s.outside[i]; }
  assert.ok(tape > 100);
  assert.equal(out, 0);
});

test('the doped-core scan: a lens 14 % denser than the base material at the top of a shorter cylinder, with clumps', () => {
  const d = S.makeScan({ doped: true, voxelMm: 0.08, size: 200 });
  assert.equal(d.files[0].webkitRelativePath.split('/')[0], 'synthetic_doped');
  assert.equal(d.truth.doped.relative, 1.14);
  assert.ok(d.truth.doped.clumps > 0);
});
