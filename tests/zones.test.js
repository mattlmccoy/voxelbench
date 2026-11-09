'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../app/ct_pores.js');
const Z = require('../app/ct_zones.js');

const dims = { nx: 60, ny: 40, nz: 40 };
const at = (x, y, z) => (z * dims.ny + y) * dims.nx + x;
function block(fill) {
  const v = new Float32Array(dims.nx * dims.ny * dims.nz);
  for (let z = 0; z < dims.nz; z++) for (let y = 0; y < dims.ny; y++) for (let x = 0; x < dims.nx; x++) v[at(x, y, z)] = fill(x, y, z);
  return v;
}
const inBox = (x, y, z, m = 2) => x >= m && x < dims.nx - m && y >= m && y < dims.ny - m && z >= m && z < dims.nz - m;
const bodyOf = () => Uint8Array.from(block((x, y, z) => (inBox(x, y, z) ? 1 : 0)));

test('distanceInside gives the distance in voxels to the nearest voxel outside the mask', () => {
  const small = { nx: 7, ny: 5, nz: 5 };
  const mask = new Uint8Array(175).fill(1);
  for (let z = 0; z < 5; z++) for (let y = 0; y < 5; y++) mask[(z * 5 + y) * 7] = 0;
  const d = Z.distanceInside(mask, small);
  assert.equal(d[(2 * 5 + 2) * 7 + 0], 0);
  assert.ok(Math.abs(d[(2 * 5 + 2) * 7 + 3] - 3) < 1e-6);
  const hole = new Uint8Array(175).fill(1);
  hole[(2 * 5 + 2) * 7 + 3] = 0;
  assert.ok(Math.abs(Z.distanceInside(hole, small)[(3 * 5 + 3) * 7 + 4] - Math.sqrt(3)) < 1e-5);
});

test('findPatches finds mid-gray blobs, ignores voids and the surface skin, and reports their gray', () => {
  const blob = (x, y, z) => (x - 30) ** 2 + (y - 20) ** 2 + (z - 20) ** 2 <= 16;
  const gray = block((x, y, z) => {
    if (!inBox(x, y, z)) return 700;
    if ((x - 12) ** 2 + (y - 20) ** 2 + (z - 20) ** 2 <= 16) return 700;
    if (blob(x, y, z)) return 1640;
    return x === 3 || x === 56 ? 1500 : 2080;
  });
  const voids = Uint8Array.from(block((x, y, z) => (inBox(x, y, z) && (x - 12) ** 2 + (y - 20) ** 2 + (z - 20) ** 2 <= 16 ? 1 : 0)));
  const out = Z.findPatches({ gray, voids, body: bodyOf(), dims, airGray: 700, voxelMm: 0.16, settings: { patchSigma: 0.7, patchFraction: 0.8, patchMinMm3: 0.1, patchMaxMm3: 20, patchSkin: 4 } });
  assert.equal(out.patches.length, 1);
  const p = out.patches[0];
  assert.equal(p.id, 1);
  assert.ok(Math.abs(p.x - 30) < 1 && Math.abs(p.y - 20) < 1 && Math.abs(p.z - 20) < 1);
  assert.ok(p.gray_mean < 1800 && p.gray_mean > 1500);
  assert.ok(p.relative_gray > 0.55 && p.relative_gray < 0.8);
  assert.equal(out.labels[at(30, 20, 20)], 1);
  assert.equal(out.labels[at(12, 20, 20)], 0);
  assert.equal(out.labels[at(3, 20, 20)], 0);
});

test('findPatches keeps a region too large to be a patch out of the list', () => {
  const gray = block((x, y, z) => (!inBox(x, y, z) ? 700 : y < 14 ? 1600 : 2080));
  const out = Z.findPatches({ gray, voids: new Uint8Array(gray.length), body: bodyOf(), dims, airGray: 700, voxelMm: 0.16, settings: { patchSigma: 0.7, patchFraction: 0.8, patchMinMm3: 0.1, patchMaxMm3: 2, patchSkin: 1 } });
  assert.equal(out.patches.length, 0);
  assert.ok(out.labels.every((l) => l === 0));
});

// Ends read 2000, a center zone reads 2130, a crust above the center reads 1600, and gray rises toward the surface.
function material({ core = 2130, voidInEnds = false } = {}) {
  const body = bodyOf();
  const depth = Z.distanceInside(body, dims);
  const gray = block((x, y, z) => {
    if (!body[at(x, y, z)]) return 700;
    const cup = 40 * Math.exp(-depth[at(x, y, z)] / 3);
    if (x >= 16 && x < 44 && z < 8) return 1600 + cup;
    if (x >= 16 && x < 44) return core + cup;
    return 2000 + cup;
  });
  const voids = voidInEnds ? Uint8Array.from(block((x, y, z) => (body[at(x, y, z)] && (x + y + z) % 5 === 0 ? 1 : 0))) : new Uint8Array(gray.length);
  return { gray, voids, body, dims, airGray: 700, voxelMm: 0.16 };
}
const ZONE_SETTINGS = { sigma: 1, endShare: 0.16, voidFree: 0.005, voidSigma: 3, lowDrop: 0.08, baseline: 'ends' };

// Pores only in the two ends of the long axis (x < 16 or x >= 44), so the end baseline has no pore-free material.
function porousEnds() {
  const m = material();
  const voids = Uint8Array.from(block((x, y, z) => (m.body[at(x, y, z)] && (x < 16 || x >= 44) && (x + y + z) % 5 === 0 ? 1 : 0)));
  return { ...m, voids };
}

test('whole-part baseline works when the ends hold pores; the end baseline refuses', () => {
  const ends = Z.prepareZones({ ...porousEnds(), settings: ZONE_SETTINGS });
  assert.match(ends.refused, /pore-free/);
  const whole = Z.prepareZones({ ...porousEnds(), settings: { ...ZONE_SETTINGS, baseline: 'whole' } });
  assert.equal(whole.refused, null);
  assert.equal(whole.method, 'whole');
  assert.ok(whole.baseline.length > 0);
});

test('the automatic baseline (the default) uses the ends when they are pore-free, else the whole part', () => {
  assert.equal(Z.DEFAULT_ZONE_SETTINGS.baseline, 'auto');
  assert.equal(Z.prepareZones({ ...material(), settings: { ...ZONE_SETTINGS, baseline: 'auto' } }).method, 'ends');
  const porous = Z.prepareZones({ ...porousEnds(), settings: { ...ZONE_SETTINGS, baseline: 'auto' } });
  assert.equal(porous.refused, null);
  assert.equal(porous.method, 'whole');
});

test('draftZones separates the bright zone, the low-gray zone and the rest, relative to the ends at equal depth', () => {
  const out = Z.draftZones({ ...material(), settings: ZONE_SETTINGS });
  assert.equal(out.refused, null);
  assert.equal(out.zones[at(30, 20, 20)], Z.ZONE.BRIGHT);
  assert.equal(out.zones[at(30, 20, 4)], Z.ZONE.LOW);
  assert.equal(out.zones[at(6, 20, 20)], Z.ZONE.BASE);
  assert.equal(out.zones[at(0, 0, 0)], 0);
  assert.ok(out.threshold > 0 && out.threshold < 0.1);
  const bright = out.stats.find((s) => s.zone === Z.ZONE.BRIGHT);
  assert.ok(bright.excess_median > 0.06 && bright.excess_median < 0.13);
  assert.ok(bright.volume_mm3 > 0);
  assert.equal(out.axis, 'x');
});

test('draftZones refuses without pore-free ends rather than drawing a baseline from bad material', () => {
  const out = Z.draftZones({ ...material({ voidInEnds: true }), settings: ZONE_SETTINGS });
  assert.match(out.refused, /pore-free/);
  assert.equal(out.zones, null);
});

test('draftZones refuses when gray shows one group, not two', () => {
  const out = Z.draftZones({ ...material({ core: 2000 }), settings: ZONE_SETTINGS });
  assert.match(out.refused, /one group/);
  assert.equal(out.zones, null);
});

test('draftZones takes a threshold when given one, and its bright zone shrinks as it rises', () => {
  const m = material();
  const low = Z.draftZones({ ...m, settings: { ...ZONE_SETTINGS, threshold: 0.02 } });
  const high = Z.draftZones({ ...m, settings: { ...ZONE_SETTINGS, threshold: 0.12 } });
  const v = (o) => o.stats.find((s) => s.zone === Z.ZONE.BRIGHT).volume_mm3;
  assert.equal(low.threshold, 0.02);
  assert.ok(v(low) > v(high));
});

test('voidClassMasks splits runs by class at a coarser grid, with any coverage counting, and honors size and rejection', () => {
  const full = { nx: 8, ny: 2, nz: 2 };
  const runs = { rows: 4, offsets: Int32Array.from([0, 3, 3, 3, 3]), start: Int32Array.from([0, 3, 6]), end: Int32Array.from([1, 4, 7]), id: Int32Array.from([1, 2, 3]) };
  const pores = [{ id: 1, diameter_mm: 0.5, crack_like: false, clipped: false }, { id: 2, diameter_mm: 0.5, crack_like: true, clipped: false }, { id: 3, diameter_mm: 0.05, crack_like: false, clipped: false }];
  const m = Z.voidClassMasks({ runs, pores, rejected: new Set(), dims: full, factor: 2, minDiameterMm: 0.1 });
  assert.deepEqual(m.dims, { nx: 4, ny: 1, nz: 1 });
  assert.deepEqual([...m.masks.pore], [1, 0, 0, 0]);
  assert.deepEqual([...m.masks.crack], [0, 1, 0, 0]);
  assert.deepEqual([...m.masks.clipped], [0, 0, 0, 0]);
  const none = Z.voidClassMasks({ runs, pores, rejected: new Set([1]), dims: full, factor: 2, minDiameterMm: 0.01 });
  assert.deepEqual([...none.masks.pore], [0, 0, 0, 1]);
});

test('summarize reports the total void percent beside the separate classes', () => {
  const list = [{ id: 1, volume_mm3: 2, crack_like: false, clipped: false }, { id: 2, volume_mm3: 3, crack_like: true, clipped: false }, { id: 3, volume_mm3: 5, crack_like: true, clipped: true }, { id: 4, volume_mm3: 90, crack_like: false, clipped: false }];
  const s = P.summarize(list, 200, new Set([4]));
  assert.equal(s.all_void_volume_mm3, 10);
  assert.equal(s.all_void_percent_of_body, 5);
  assert.equal(s.clipped_volume_mm3, 5);
  assert.equal(s.pore_percent_of_body, 1);
});

test('surfaceNets stays closed on a thin mask: every edge belongs to exactly two triangles', () => {
  const small = { nx: 6, ny: 5, nz: 5 };
  const mask = new Uint8Array(150);
  for (const [x, y, z] of [[1, 1, 1], [2, 1, 1], [2, 2, 1], [4, 3, 3]]) mask[(z * 5 + y) * 6 + x] = 1;
  const { indices, positions } = P.surfaceNets(mask, small);
  assert.ok(positions.length > 0);
  const edges = new Map();
  for (let i = 0; i < indices.length; i += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
    const u = indices[i + a], v = indices[i + b], key = u < v ? `${u},${v}` : `${v},${u}`;
    edges.set(key, (edges.get(key) || 0) + 1);
  }
  assert.ok([...edges.values()].every((n) => n === 2));
});

// Captured from real Sample 2 (first 60 bins of 0.01 from -0.3): a tall baseline group with a long shoulder, then a dip and a second group.
const SAMPLE2_HISTOGRAM = [99, 128, 317, 529, 691, 989, 1313, 1763, 2276, 2906, 3505, 3890, 4576, 4973, 5637, 6266, 7565, 9238, 10625, 12544, 14650, 17396, 20300, 22038, 25496, 32260, 45262, 66403, 89515, 104048, 103701, 100630, 92701, 81721, 67780, 60802, 54080, 51813, 45526, 41087, 44021, 49321, 52160, 53753, 54293, 53143, 46500, 38578, 31309, 22689, 15982, 12575, 10296, 7528, 3454, 1641, 524, 98, 0, 0];

test('dipInHistogram finds the dip past the baseline group shoulder in the real Sample 2 histogram', () => {
  const dip = Z.dipInHistogram(Float64Array.from(SAMPLE2_HISTOGRAM));
  assert.ok(dip > 0.08 && dip < 0.11, `dip ${dip}`);
});

test('dipInHistogram returns null for a single falling shoulder', () => {
  const one = Float64Array.from(SAMPLE2_HISTOGRAM.map((v, i) => (i <= 29 ? v : Math.round(104048 * Math.exp(-(i - 29) / 6)))));
  assert.equal(Z.dipInHistogram(one), null);
});

test('voidFractions gives the exact covered share of each coarse cell and skips rejected voids', () => {
  const full = { nx: 4, ny: 2, nz: 2 };
  const runs = { rows: 4, offsets: Int32Array.from([0, 2, 2, 2, 2]), start: Int32Array.from([0, 2]), end: Int32Array.from([2, 3]), id: Int32Array.from([1, 2]) };
  const f = Z.voidFractions({ runs, rejected: new Set([2]), dims: full, factor: 2 });
  assert.deepEqual([...f], [2 / 8, 0]);
});

test('coarsenSolid averages gray over solid voxels only and reports the solid share', () => {
  const small = { nx: 2, ny: 2, nz: 2 };
  const gray = Float32Array.from([100, 100, 100, 100, 100, 100, 100, 900]);
  const anyVoid = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]);
  const body = new Uint8Array(8).fill(1);
  const c = Z.coarsenSolid(gray, anyVoid, body, small, 2);
  assert.deepEqual([...c.gray], [100]);
  assert.ok(Math.abs(c.weight[0] - 7 / 8) < 1e-6);
  assert.deepEqual([...c.body], [1]);
});

test('voidPercentByZone reads each zone from exact fractions', () => {
  const stats = Z.voidPercentByZone(Uint8Array.from([1, 1, 2, 0]), Float32Array.from([0.5, 0, 0.25, 1]));
  assert.equal(stats[1], 25);
  assert.equal(stats[2], 25);
});

test('paintZones lets a drawn region override the draft, only within its outline and slices', () => {
  const coarse = { nx: 4, ny: 4, nz: 2 };
  const zones = new Uint8Array(32).fill(Z.ZONE.BASE);
  zones[0] = 0;
  const region = { label: 'region_b', plane: 'XY', slice_from: 0, slice_to: 3, points: [{ col: 0, row: 0 }, { col: 8, row: 0 }, { col: 8, row: 8 }, { col: 0, row: 8 }] };
  const out = Z.paintZones(zones, coarse, 4, [region, { ...region, label: 'not_a_label' }], ['region_a', 'region_b']);
  assert.equal(out[1], Z.ZONE.DRAWN_BASE + 1, 'label index 1 paints zone 5');
  assert.equal(out[0], 0, 'outside the body stays outside');
  assert.equal(out[3], Z.ZONE.BASE, 'outside the outline is untouched');
  assert.equal(out[16 + 1], Z.ZONE.BASE, 'past the slice range is untouched');
  assert.equal(zones[1], Z.ZONE.BASE, 'the input is not changed');
});

test('prepareCoarse coarsens solid gray and exact void shares from runs, for the worker and the headless report alike', () => {
  const full = { nx: 8, ny: 8, nz: 8 };
  const binned = { nx: 4, ny: 4, nz: 4 };
  const gray = new Float32Array(64).fill(2000);
  const filled = new Uint8Array(64).fill(1);
  const offsets = new Int32Array(66);
  offsets.fill(2, 1);
  const runs = { rows: 64, offsets, start: Int32Array.from([0, 3]), end: Int32Array.from([2, 4]), id: Int32Array.from([1, 2]) };
  const pores = [{ id: 1, diameter_mm: 1, crack_like: false, clipped: false }, { id: 2, diameter_mm: 1, crack_like: true, clipped: false }];
  const c = Z.prepareCoarse({ runs, pores, gray, filled, binnedDims: binned, fullDims: full, bin: 2, step: 2, voxelMm: 0.04 });
  assert.equal(c.factor, 4);
  assert.ok(Math.abs(c.voxelMm - 0.16) < 1e-9);
  assert.deepEqual(c.dims, { nx: 2, ny: 2, nz: 2 });
  assert.equal(c.voidShare.length, 8);
  assert.ok(Math.abs(c.voidShare[0] - 3 / 64) < 1e-6);
  assert.equal(c.gray[7], 2000);
  assert.equal(c.body[0], 1);
});

// Found on real Sample 2: surface shading and the scan edge read dark, and were counted as crust and as patches.
test('draftZones keeps the surface skin and the scan edge out of the darker zone, but keeps a real crust with its skin', () => {
  const m = material();
  const depth = Z.distanceInside(m.body, dims);
  const gray = m.gray.slice();
  for (let i = 0; i < gray.length; i++) if (m.body[i] && depth[i] <= 1.5 && gray[i] > 1700) gray[i] = 1500;
  const scanDepth = new Float32Array(gray.length).fill(10);
  for (let z = 0; z < dims.nz; z++) for (let y = 0; y < dims.ny; y++) for (let x = 0; x < 4; x++) { scanDepth[at(x, y, z)] = 0.5; gray[at(x, y, z)] = m.body[at(x, y, z)] ? 1500 : gray[at(x, y, z)]; }
  const out = Z.draftZones({ ...m, gray, scanDepth, settings: { ...ZONE_SETTINGS, threshold: 0.05 } });
  assert.equal(out.refused, null);
  assert.equal(out.zones[at(30, 20, 2)], Z.ZONE.LOW, 'the crust keeps its outer skin');
  assert.equal(out.zones[at(30, 20, 5)], Z.ZONE.LOW);
  assert.equal(out.zones[at(10, 2, 20)], Z.ZONE.BASE, 'a rim with no deep dark core is not crust');
  assert.equal(out.zones[at(3, 20, 20)], Z.ZONE.BASE, 'the scan edge is not crust');
});

test('findPatches ignores blobs in the shaded zone next to the scan edge', () => {
  const blob = (x, y, z) => (x - 12) ** 2 + (y - 20) ** 2 + (z - 20) ** 2 <= 16;
  const gray = block((x, y, z) => (!inBox(x, y, z) ? 700 : blob(x, y, z) ? 1640 : 2080));
  const scanDepth = new Float32Array(gray.length).fill(10);
  for (let i = 0; i < gray.length; i++) if (i % dims.nx < 20) scanDepth[i] = 1;
  const settings = { patchSigma: 0.7, patchFraction: 0.8, patchMinMm3: 0.1, patchMaxMm3: 20, patchSkin: 4, patchEdgeMm: 2 };
  const input = { gray, voids: new Uint8Array(gray.length), body: bodyOf(), dims, airGray: 700, voxelMm: 0.16, settings };
  assert.equal(Z.findPatches(input).patches.length, 1);
  assert.equal(Z.findPatches({ ...input, scanDepth }).patches.length, 0);
});

test('prepareCoarse gives each cell its distance from the reconstruction edge in mm', () => {
  const full = { nx: 8, ny: 8, nz: 8 };
  const offsets = new Int32Array(66);
  const runs = { rows: 64, offsets, start: new Int32Array(0), end: new Int32Array(0), id: new Int32Array(0) };
  const c = Z.prepareCoarse({ runs, pores: [], gray: new Float32Array(64).fill(2000), filled: new Uint8Array(64).fill(1), binnedDims: { nx: 4, ny: 4, nz: 4 }, fullDims: full, bin: 2, step: 2, voxelMm: 0.5, circle: { cx: 2, cy: 2, r: 10 } });
  assert.ok(Math.abs(c.scanDepth[0] - 10 * 0.5) < 1e-5, 'cell center sits on the circle center');
  assert.ok(Math.abs(c.scanDepth[1] - 6 * 0.5) < 1e-5, 'one 4-voxel cell away');
});

test('offsetHistogram bins the gray offset of solid voxels at least 1 mm deep, as volume', () => {
  const ready = { excess: Float32Array.from([0.005, 0.005, 0.115, -0.2, 0.5]), depth: Float32Array.from([2, 2, 2, 0.4, 2]), w: Float32Array.from([1, 1, 1, 1, 1]) };
  const h = Z.offsetHistogram(ready, 0.1);
  assert.equal(h.step, 0.01);
  assert.equal(h.low, -0.3);
  assert.equal(h.volume_mm3.length, 60);
  assert.ok(Math.abs(h.volume_mm3[30] - 2 * 0.001) < 1e-12, 'two voxels of 0.1 mm at +0.5 %');
  assert.ok(Math.abs(h.volume_mm3[41] - 0.001) < 1e-12);
  assert.equal(h.volume_mm3.reduce((a, b) => a + b, 0).toFixed(6), (0.003).toFixed(6), 'shallow and out-of-range voxels left out');
});

test('voidSizeMasks splits kept pores into equivalent-diameter bins', () => {
  const full = { nx: 8, ny: 2, nz: 2 };
  const runs = { rows: 4, offsets: Int32Array.from([0, 3, 3, 3, 3]), start: Int32Array.from([0, 3, 6]), end: Int32Array.from([1, 4, 7]), id: Int32Array.from([1, 2, 3]) };
  const pores = [{ id: 1, diameter_mm: 0.7 }, { id: 2, diameter_mm: 3 }, { id: 3, diameter_mm: 0.2 }];
  const m = Z.voidSizeMasks({ runs, pores, rejected: new Set(), dims: full, factor: 2, edges: [0.5, 1, 2, 4] });
  assert.deepEqual(m.masks.map((a) => [...a]), [[1, 0, 0, 0], [0, 0, 0, 0], [0, 1, 0, 0]]);
  assert.deepEqual(m.dims, { nx: 4, ny: 1, nz: 1 });
});

test('zoneName names gray zones and drawn zones by label', () => {
  const labels = [{ id: 'region_a' }, { id: 'region_b' }];
  assert.equal(Z.zoneName(2, labels), 'high_gray');
  assert.equal(Z.zoneName(5, labels), 'drawn_region_b');
  assert.equal(Z.zoneName(7, labels), 'drawn_deleted_label');
});

test('paintZones never paints phantom regions', () => {
  const coarse = { nx: 4, ny: 4, nz: 2 };
  const zones = new Uint8Array(32).fill(Z.ZONE.BASE);
  const phantom = { label: 'phantom', plane: 'XY', slice_from: 0, slice_to: 7, points: [{ col: 0, row: 0 }, { col: 15, row: 0 }, { col: 15, row: 15 }, { col: 0, row: 15 }] };
  assert.deepEqual([...Z.paintZones(zones, coarse, 4, [phantom], ['region_a', 'region_b'])], [...zones]);
});

test('with a whole-part baseline the zone threshold is the valley between the two tallest groups, wherever they sit', () => {
  // Bins of 0.01 from -0.30: the larger (bright) group peaks at +0.02, a smaller darker group at -0.07.
  const raw = Float64Array.from({ length: 60 }, (_, i) => {
    const v = -0.3 + (i + 0.5) * 0.01;
    return 1000 * Math.exp(-(((v - 0.02) / 0.02) ** 2)) + 500 * Math.exp(-(((v + 0.07) / 0.02) ** 2));
  });
  assert.equal(Z.dipInHistogram(raw), null, 'the end-baseline search finds nothing right of the tallest peak');
  const dip = Z.valleyBetweenGroups(raw);
  assert.ok(dip > -0.05 && dip < 0, `valley at ${dip}`);
  assert.equal(Z.valleyBetweenGroups(Float64Array.from({ length: 60 }, (_, i) => Math.exp(-(((i - 30) / 5) ** 2)))), null, 'one group');
});

test('a refusal with no second peak at all says so in words', () => {
  assert.match(Z.oneGroupText({ method: 'ends', axis: 'x', baseShare: 0.097 }, new Float64Array(60)), /no second peak after the baseline group/);
});

test('the one-group refusal says which baseline was used, how deep the deepest dip was and how much of the part was baseline', () => {
  const ends = Z.draftZones({ ...material({ core: 2000 }), settings: ZONE_SETTINGS });
  assert.match(ends.refused, /one group/);
  assert.match(ends.refused, /Baseline: the pore-free ends of the \w axis/);
  assert.match(ends.refused, /(deepest dip \d\.\d\d of the smaller peak \(0\.97 or lower needed\)|no second peak after the baseline group)/);
  assert.doesNotMatch(ends.refused, /dip none/);
  assert.match(ends.refused, /\d+(\.\d)?% of the part/);
});

// Two materials layered by depth with no shading: a darker skin over a brighter core. The skin thickens from lo to
// lo + 10 voxels along x and the edge is blurred as a scanner blurs it, so the share of each material changes gradually
// with depth; a baseline taken at equal depth then follows the material and smears the two groups into one. (lo is set
// in the middle of a range where the outcome holds, not at its edge.)
function skinned({ skin = 1700, core = 2100, lo = 4 } = {}) {
  const body = bodyOf();
  const depth = Z.distanceInside(body, dims);
  const sharp = block((x, y, z) => (!body[at(x, y, z)] ? 0 : depth[at(x, y, z)] < lo + (10 * x) / dims.nx ? skin : core));
  const w = Float32Array.from(body), a = P.gaussian(sharp, dims, 1.5), b = P.gaussian(w, dims, 1.5);
  const gray = block((x, y, z) => (body[at(x, y, z)] ? a[at(x, y, z)] / b[at(x, y, z)] : 700));
  return { gray, voids: new Uint8Array(gray.length), body, dims, airGray: 700, voxelMm: 0.16 };
}
const SKIN_SETTINGS = { ...ZONE_SETTINGS, sigma: 3 };

test('on auto, a brighter core under a darker skin gets zones from gray as-is when the depth-corrected gray shows one group', () => {
  const m = skinned();
  assert.match(Z.draftZones({ ...m, settings: SKIN_SETTINGS }).refused, /one group/, 'the ends baseline erases the layers');
  const out = Z.draftZones({ ...m, settings: { ...SKIN_SETTINGS, baseline: 'auto' } });
  assert.equal(out.refused, null);
  assert.equal(out.method, 'asis');
  assert.equal(out.zones[at(30, 20, 20)], Z.ZONE.BRIGHT, 'the core');
  assert.notEqual(out.zones[at(30, 20, 4)], Z.ZONE.BRIGHT, 'the skin');
  assert.match(Z.baselineText(out.method, out.axis), /without depth correction/);
});

test('gray as-is is refused when its brighter group lies nearer the surface, where shading puts it, and the refusal says so', () => {
  const out = Z.draftZones({ ...skinned({ skin: 2100, core: 1700, lo: 5 }), settings: { ...SKIN_SETTINGS, baseline: 'auto' } });
  assert.match(out.refused, /one group/);
  assert.match(out.refused, /without depth correction/);
  assert.match(out.refused, /nearer the surface/);
});

test('a chosen baseline never falls back to gray as-is', () => {
  for (const baseline of ['ends', 'whole']) {
    const ready = Z.prepareZones({ ...skinned(), settings: { ...SKIN_SETTINGS, baseline } });
    assert.equal(ready.method, baseline);
    assert.equal(ready.asIs, undefined, baseline);
  }
});
