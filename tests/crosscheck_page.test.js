'use strict';
// The in-page Dragonfly cross-check: comparing from runs, the biggest disagreements, streaming a mask into runs, the
// kit zip, and the plain-language read of a comparison.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../app/vb_masks.js');
const E = require('../app/ct_export.js');

function volume(dims, voxels) {
  const v = new Uint8Array(dims.nx * dims.ny * dims.nz);
  for (const [x, y, z] of voxels) v[(z * dims.ny + y) * dims.nx + x] = 1;
  return (z) => v.subarray(z * dims.nx * dims.ny, (z + 1) * dims.nx * dims.ny);
}
const DIMS = { nx: 6, ny: 3, nz: 2 };
const ALL = []; for (let z = 0; z < 2; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 6; x++) ALL.push([x, y, z]);
const PORE = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]];
const FAR = [[4, 0, 0], [5, 0, 0], [4, 1, 0], [5, 1, 0]]; // a large pore only Dragonfly finds
const runs = (voxels) => M.maskRuns(volume(DIMS, voxels), DIMS);

test('comparing runs gives the same answer as comparing slices', () => {
  const args = { dims: DIMS, voxelMm: 1, bodyMm3: 100, smallMm3: 3 };
  const fromSlices = M.compareMasks({ ...args, a: volume(DIMS, PORE), b: volume(DIMS, [...PORE, ...FAR]), region: volume(DIMS, ALL) });
  const fromRuns = M.compareRuns({ ...args, a: runs(PORE), b: runs([...PORE, ...FAR]), region: runs(ALL) });
  assert.deepEqual(fromRuns, fromSlices);
});

test('the biggest pores found by one tool only are listed with their center, largest first; edge differences are not', () => {
  const r = M.compareRuns({ a: runs([...PORE, [3, 2, 1]]), b: runs([...PORE, [2, 0, 0], ...FAR]), region: runs(ALL), dims: DIMS, voxelMm: 1, bodyMm3: 100, smallMm3: 3 });
  assert.deepEqual(r.largest_only_b, [{ voxels: 4, x: 4.5, y: 0.5, z: 0 }]); // [2,0,0] grows a shared pore: not whole
  assert.deepEqual(r.largest_only_a, [{ voxels: 1, x: 3, y: 2, z: 1 }]);
});

test('a mask streamed page by page gives the same runs, and a wrong page count is refused', () => {
  const b = M.runsBuilder(DIMS), get = volume(DIMS, [...PORE, ...FAR]);
  b.add(get(0)); b.add(get(1));
  assert.deepEqual(b.done(), runs([...PORE, ...FAR]));
  const short = M.runsBuilder(DIMS);
  short.add(get(0));
  assert.throws(() => short.done(), /2 slices.*1/);
  assert.throws(() => M.runsBuilder(DIMS).add(new Uint8Array(5)), /6 × 3/);
});

test('every page of a TIFF reaches the callback in order without keeping the others', () => {
  const p = new Uint8Array(15); p[3] = 1;
  const seen = [];
  M.eachMaskPage(M.writeMaskTiff(5, 3, p, 0.04), (page, k) => seen.push([k, page.width, page.height, Array.from(page.pixels).indexOf(1)]));
  assert.deepEqual(seen, [[0, 5, 3, 3]]);
});

test('a slice back out of runs matches the mask it came from', () => {
  const r = runs([...PORE, ...FAR]), get = volume(DIMS, [...PORE, ...FAR]);
  for (let z = 0; z < 2; z++) assert.deepEqual(Array.from(M.runsSlice(r, DIMS, z)), Array.from(get(z)));
});

async function unzip(blob) {
  const u = new Uint8Array(await blob.arrayBuffer()), d = new DataView(u.buffer), out = new Map();
  for (let at = 0; d.getUint32(at, true) === 0x04034b50;) {
    const size = d.getUint32(at + 18, true), nameLen = d.getUint16(at + 26, true), extra = d.getUint16(at + 28, true);
    const name = new TextDecoder().decode(u.subarray(at + 30, at + 30 + nameLen)), start = at + 30 + nameLen + extra;
    const packed = u.slice(start, start + size);
    const raw = new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    out.set(name, raw);
    at = start + size;
  }
  return out;
}

test('the kit zip holds every file, deflated, readable back byte for byte', async () => {
  const files = [{ name: 'kit.json', bytes: new TextEncoder().encode('{"a":1}') }, { name: 'region/region_0000.tif', bytes: new Uint8Array(4000).fill(7) }];
  const blob = await E.zipFiles(files);
  assert.ok(blob.size < 4000, 'deflated');
  const back = await unzip(blob);
  assert.deepEqual([...back.keys()], ['kit.json', 'region/region_0000.tif']);
  assert.equal(new TextDecoder().decode(back.get('kit.json')), '{"a":1}');
  assert.deepEqual(Array.from(back.get('region/region_0000.tif').subarray(0, 3)), [7, 7, 7]);
});

const cmp = (over) => ({ a: { voxels: 1000, percent: 5.0 }, b: { voxels: 1010, percent: 5.05 }, both_voxels: 995, dice: 0.9925,
  only_a: { voxels: 5, whole_small: 0, whole_large: 0, boundary: 5, outside_region: 0 }, only_b: { voxels: 15, whole_small: 3, whole_large: 0, boundary: 12, outside_region: 0 },
  small_mm3: 0.01, largest_only_a: [], largest_only_b: [], ...over });

test('the read of a comparison: porosity side by side, Dice, and agreement in words', () => {
  const r = M.crosscheckRead(cmp(), 'Dragonfly');
  assert.deepEqual(r.rows.slice(0, 4), [['VoxelBench porosity', '5.000 %'], ['Dragonfly porosity', '5.050 %'], ['Difference', '+0.050 points'], ['Dice', '0.9925']]);
  assert.match(r.insights[0], /agree.*Dice 0\.9925/);
  assert.match(r.insights.join(' '), /pore edges/); // 17 of the 20 differing voxels are at edges
});

test('the read names the cause: voxels outside the region, small pores, or large pores one tool missed', () => {
  const outside = M.crosscheckRead(cmp({ dice: 0.8, only_b: { voxels: 400, whole_small: 0, whole_large: 400, boundary: 0, outside_region: 380 } }), 'Dragonfly');
  assert.match(outside.insights[0], /disagree/);
  assert.match(outside.insights.join(' '), /380 voxels outside VoxelBench's counting region/);
  const small = M.crosscheckRead(cmp({ only_b: { voxels: 60, whole_small: 55, whole_large: 0, boundary: 5, outside_region: 0 } }), 'Dragonfly');
  assert.match(small.insights.join(' '), /small pores.*minimum size/);
  const large = M.crosscheckRead(cmp({ dice: 0.95, only_a: { voxels: 300, whole_small: 0, whole_large: 290, boundary: 10, outside_region: 0 }, largest_only_a: [{ voxels: 290, x: 1, y: 2, z: 3 }] }), 'Dragonfly');
  assert.match(large.insights.join(' '), /290 voxels in large pores only VoxelBench found/);
});

test('masks that barely overlap suggest a flipped export or another slice order', () => {
  const r = M.crosscheckRead(cmp({ dice: 0.2 }), 'Dragonfly');
  assert.match(r.insights.join(' '), /flipped or in another slice order/);
  assert.doesNotMatch(M.crosscheckRead(cmp(), 'Dragonfly').insights.join(' '), /flipped/);
});

test('a near-perfect Dice keeps its digits, and a zero difference has no sign', () => {
  const r = M.crosscheckRead(cmp({ a: { voxels: 11340707, percent: 5.2536318 }, b: { voxels: 11340701, percent: 5.2536291 }, dice: 0.99999956 }), 'Dragonfly');
  const row = (k) => r.rows.find((x) => x[0] === k)[1];
  assert.equal(row('Dice'), '0.9999996');
  assert.equal(row('Difference'), '0.000 points');
  assert.match(r.insights[0], /Dice 0\.9999996/);
  assert.equal(M.crosscheckRead(cmp({ dice: 1 }), 'Dragonfly').rows.find((x) => x[0] === 'Dice')[1], '1 (identical)');
});

// An asymmetric pore set, so every flip lands somewhere else.
const ODD = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [5, 2, 1], [4, 2, 1]];
const flipVox = ([x, y, z], f) => [f.x ? DIMS.nx - 1 - x : x, f.y ? DIMS.ny - 1 - y : y, f.z ? DIMS.nz - 1 - z : z];

test('flipping runs along x, y or z matches flipping the voxels', () => {
  for (const f of [{ x: true, y: false, z: false }, { x: false, y: true, z: false }, { x: false, y: false, z: true }, { x: true, y: true, z: true }]) {
    assert.deepEqual(M.flipRuns(runs(ODD), DIMS, f), runs(ODD.map((v) => flipVox(v, f))), JSON.stringify(f));
  }
});

test('the quick overlap score is the Dice of the sampled slices', () => {
  assert.equal(M.overlapScore(runs(ODD), runs(ODD), DIMS, 1), 1);
  assert.equal(M.overlapScore(runs(ODD), runs([[3, 2, 0]]), DIMS, 1), 0);
  assert.equal(M.overlapScore(runs(ODD), runs(ODD), DIMS, 2), 1); // slice 0 only: still identical there
});

test('the best orientation undoes a flipped export, and the scan orientation wins a tie', () => {
  const f = { x: false, y: true, z: true };
  const best = M.bestOrientation(runs(ODD), runs(ODD.map((v) => flipVox(v, f))), DIMS, 1);
  assert.deepEqual(best.flip, f);
  assert.equal(best.score, 1);
  assert.deepEqual(M.bestOrientation(runs(ODD), runs(ODD), DIMS, 1).flip, { x: false, y: false, z: false });
});

test('the read names an orientation the page had to undo', () => {
  const r = M.crosscheckRead(cmp({ orientation: { x: false, y: true, z: true } }), 'Dragonfly');
  assert.equal(r.rows.find((x) => x[0] === 'Mask orientation')[1], 'flipped in y, slices reversed');
  assert.match(r.insights[0], /Dragonfly's mask was flipped in y, slices reversed, against the scan; it was compared turned back/);
  assert.equal(M.crosscheckRead(cmp(), 'Dragonfly').rows.find((x) => x[0] === 'Mask orientation'), undefined);
  assert.equal(M.crosscheckRead(cmp({ orientation: { x: false, y: false, z: false } }), 'Dragonfly').rows.find((x) => x[0] === 'Mask orientation'), undefined);
});
