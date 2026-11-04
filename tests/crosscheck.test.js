'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../tools/crosscheck/masks.js');

const pixels = (w, h, on) => { const p = new Uint8Array(w * h); for (const i of on) p[i] = 1; return p; };

test('an 8-bit mask TIFF round-trips, nonzero read as 1, with the voxel size', () => {
  const p = pixels(5, 3, [0, 7, 14]);
  const pages = M.readMaskPages(M.writeMaskTiff(5, 3, p, 0.04));
  assert.equal(pages.length, 1);
  assert.equal(pages[0].width, 5); assert.equal(pages[0].height, 3);
  assert.deepEqual(Array.from(pages[0].pixels), Array.from(p));
  assert.ok(Math.abs(pages[0].voxelMm - 0.04) < 1e-6);
});

test('the written mask stores 255 for the region, so it shows white in other software', () => {
  const buf = M.writeMaskTiff(2, 1, pixels(2, 1, [1]), 0.04);
  const bytes = new Uint8Array(buf);
  assert.deepEqual(Array.from(bytes.subarray(8, 10)), [0, 255]);
});

const CT = require('../app/ct_core.js');

// Two 8-bit pages in one file, laid out by hand (the shape a multi-page export takes).
function twoPage(w, h, a, b) {
  const tags = (offset) => [[256, 3, w], [257, 3, h], [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, offset], [277, 3, 1], [278, 3, h], [279, 4, w * h]];
  const page = w * h, ifdBytes = 2 + 9 * 12 + 4;
  const buf = new ArrayBuffer(8 + 2 * (page + ifdBytes)), d = new DataView(buf), u = new Uint8Array(buf);
  let at = 8;
  d.setUint16(0, 0x4949, true); d.setUint16(2, 42, true);
  let link = 4;
  for (const px of [a, b]) {
    const data = at; u.set(px, data); at += page;
    d.setUint32(link, at, true);
    const t = tags(data);
    d.setUint16(at, t.length, true);
    t.forEach(([id, type, v], i) => { const e = at + 2 + i * 12; d.setUint16(e, id, true); d.setUint16(e + 2, type, true); d.setUint32(e + 4, 1, true); if (type === 3) d.setUint16(e + 8, v, true); else d.setUint32(e + 8, v, true); });
    link = at + 2 + t.length * 12; at = link + 4;
  }
  return buf;
}

function setTag(buf, id, value) {
  const d = new DataView(buf), ifd = d.getUint32(4, true), n = d.getUint16(ifd, true);
  for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (d.getUint16(e, true) === id) d.setUint16(e + 8, value, true); }
  return buf;
}

test('a multi-page mask file reads as one page per slice', () => {
  const pages = M.readMaskPages(twoPage(3, 2, pixels(3, 2, [0]), [0, 0, 0, 0, 0, 200]));
  assert.equal(pages.length, 2);
  assert.deepEqual(Array.from(pages[0].pixels), [1, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(pages[1].pixels), [0, 0, 0, 0, 0, 1]);
  assert.equal(pages[1].voxelMm, null);
});

test('a 16-bit mask reads, any nonzero value counting as pore', () => {
  const pages = M.readMaskPages(CT.writeTiff(3, 1, Uint16Array.from([0, 1, 65535]), 0.04));
  assert.deepEqual(Array.from(pages[0].pixels), [0, 1, 1]);
});

test('a compressed mask is refused with a message saying to export uncompressed', () => {
  const buf = setTag(M.writeMaskTiff(2, 2, pixels(2, 2, [0]), 0.04), 259, 5);
  assert.throws(() => M.readMaskPages(buf), /uncompressed/);
});

test('the region slice is the interior blocks outside the edge zone, at full resolution, cut to whole blocks', () => {
  // Full 5 x 3 x 3 with bin 2 gives 2 x 1 x 1 blocks; block 0 counts, block 1 is in the edge zone.
  const full = { nx: 5, ny: 3, nz: 3 }, binned = { nx: 2, ny: 1, nz: 1 };
  const s0 = M.regionSlice({ interior: Uint8Array.from([1, 1]), edgeZone: Uint8Array.from([0, 1]), binnedDims: binned, bin: 2, fullDims: full }, 1);
  assert.deepEqual(Array.from(s0), [1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  const s2 = M.regionSlice({ interior: Uint8Array.from([1, 1]), edgeZone: Uint8Array.from([0, 1]), binnedDims: binned, bin: 2, fullDims: full }, 2);
  assert.deepEqual(Array.from(s2), new Array(15).fill(0));
});

test('the pore slice draws the runs of one slice, leaving out excluded voids', () => {
  const full = { nx: 4, ny: 2, nz: 2 };
  // Rows are z * ny + y: row 0 has void 1 at x 0-1, row 1 has void 2 at x 1-2, row 2 (z 1) has void 1 at x 3.
  const runs = { offsets: Int32Array.from([0, 1, 2, 3, 3]), start: Int32Array.from([0, 1, 3]), end: Int32Array.from([2, 3, 4]), id: Int32Array.from([1, 2, 1]), rows: 4 };
  assert.deepEqual(Array.from(M.poreSlice(runs, full, 0, new Set([2]))), [1, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(M.poreSlice(runs, full, 0, new Set())), [1, 1, 0, 0, 0, 1, 1, 0]);
  assert.deepEqual(Array.from(M.poreSlice(runs, full, 1, new Set())), [0, 0, 0, 1, 0, 0, 0, 0]);
});

// A volume from a list of [x, y, z] voxels, served one slice at a time like a TIFF stack.
function volume(dims, voxels) {
  const v = new Uint8Array(dims.nx * dims.ny * dims.nz);
  for (const [x, y, z] of voxels) v[(z * dims.ny + y) * dims.nx + x] = 1;
  return (z) => v.subarray(z * dims.nx * dims.ny, (z + 1) * dims.nx * dims.ny);
}

test('labeling joins face neighbors and keeps diagonal-only neighbors apart', () => {
  const dims = { nx: 3, ny: 3, nz: 2 };
  const runs = M.maskRuns(volume(dims, [[0, 0, 0], [1, 0, 0], [2, 1, 0], [2, 1, 1]]), dims);
  const { count, sizes } = M.labelRuns(runs, dims);
  assert.equal(count, 2);
  assert.deepEqual(Array.from(sizes.slice(1)).sort(), [2, 2]);
});

const DIMS = { nx: 6, ny: 3, nz: 2 };
const ALL = []; for (let z = 0; z < 2; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 6; x++) ALL.push([x, y, z]);
const LEFT = ALL.filter(([x]) => x < 4); // the counting region: x 0-3
const PORE = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]];
const compare = (a, b) => M.compareMasks({ a: volume(DIMS, a), b: volume(DIMS, b), region: volume(DIMS, LEFT), dims: DIMS, voxelMm: 1, bodyMm3: 100, smallMm3: 3 });

test('identical masks give Dice 1 and no voxels found by one tool only', () => {
  const r = compare(PORE, PORE);
  assert.equal(r.dice, 1);
  assert.equal(r.a.voxels, 4); assert.equal(r.a.percent, 4);
  assert.deepEqual(r.only_a, { voxels: 0, whole_small: 0, whole_large: 0, boundary: 0, outside_region: 0 });
});

test('a small blob only one tool found counts as a whole small pore', () => {
  const r = compare([...PORE, [3, 2, 1]], PORE);
  assert.deepEqual(r.only_a, { voxels: 1, whole_small: 1, whole_large: 0, boundary: 0, outside_region: 0 });
  assert.equal(r.dice, 8 / 9);
});

test('a pore one voxel bigger in one mask counts as a boundary difference', () => {
  const r = compare(PORE, [...PORE, [2, 0, 0]]);
  assert.deepEqual(r.only_b, { voxels: 1, whole_small: 0, whole_large: 0, boundary: 1, outside_region: 0 });
});

test('a large pore outside VoxelBench\'s region is a whole large pore, counted as outside the region', () => {
  const r = compare(PORE, [...PORE, [4, 0, 0], [5, 0, 0], [4, 1, 0], [5, 1, 0]]);
  assert.deepEqual(r.only_b, { voxels: 4, whole_small: 0, whole_large: 4, boundary: 0, outside_region: 4 });
  assert.equal(r.b.percent, 8);
});
