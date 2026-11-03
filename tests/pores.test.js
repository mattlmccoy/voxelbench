'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../app/ct_pores.js');

const idx = (d, x, y, z) => (z * d.ny + y) * d.nx + x;

function grid(nx, ny, nz, fn) {
  const d = { nx, ny, nz };
  const a = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) a[idx(d, x, y, z)] = fn(x, y, z) ? 1 : 0;
  return { d, a };
}

test('binVolume averages 2 x 2 x 2 blocks, drops the trailing slice, and marks blocks touching exact zero', () => {
  const dims = { nx: 4, ny: 2, nz: 3 };
  const slices = [Uint16Array.from([10, 20, 100, 100, 30, 40, 100, 100]), Uint16Array.from([50, 60, 100, 100, 70, 80, 0, 100]), new Uint16Array(8).fill(9999)];
  const out = P.binVolume(slices, dims, 2);
  assert.deepEqual(out.dims, { nx: 2, ny: 1, nz: 1 });
  assert.equal(out.gray[0], 45);
  assert.equal(out.outside[0], 0);
  assert.equal(out.outside[1], 1);
});

test('binVolume takes the outside from the fitted circle, so a zero voxel inside a dark pore is not outside', () => {
  const dims = { nx: 40, ny: 40, nz: 2 };
  const a = new Uint16Array(1600).fill(1000);
  a[20 * 40 + 20] = 0;
  const out = P.binVolume([a, a], dims, 2, { cx: 20, cy: 20, r: 18 });
  assert.equal(out.outside[10 * 20 + 10], 0, 'zero inside the circle');
  assert.equal(out.outside[0], 1, 'corner is outside the circle');
});

test('binnedToFull gives the full-resolution index of a binned voxel center', () => {
  assert.equal(P.binnedToFull(0, 2), 0.5);
  assert.equal(P.binnedToFull(10, 2), 20.5);
});

test('fullToBinned inverts binnedToFull for any voxel in the block', () => {
  assert.equal(P.fullToBinned(20, 2), 10);
  assert.equal(P.fullToBinned(21, 2), 10);
});

test('gaussian keeps a uniform volume unchanged, and sigma 0 is a no-op', () => {
  const dims = { nx: 12, ny: 12, nz: 12 };
  const gray = new Float32Array(1728).fill(700);
  const g = P.gaussian(gray, dims, 1);
  for (const v of g) assert.ok(Math.abs(v - 700) < 1e-2);
  assert.equal(P.gaussian(gray, dims, 0), gray);
});

test('gaussian spreads an impulse symmetrically and conserves its total', () => {
  const dims = { nx: 21, ny: 21, nz: 21 };
  const gray = new Float32Array(9261);
  gray[idx(dims, 10, 10, 10)] = 1000;
  const g = P.gaussian(gray, dims, 1);
  assert.ok(Math.abs(g.reduce((s, v) => s + v, 0) - 1000) < 0.5);
  assert.ok(Math.abs(g[idx(dims, 9, 10, 10)] - g[idx(dims, 10, 11, 10)]) < 1e-3);
  assert.ok(g[idx(dims, 10, 10, 10)] > g[idx(dims, 11, 10, 10)]);
});

test('label finds 6-connected components; diagonal neighbors stay separate', () => {
  const { d, a } = grid(5, 1, 1, (x) => x === 0 || x === 1 || x === 3);
  const { labels, count } = P.label(a, d);
  assert.equal(count, 2);
  assert.equal(labels[0], labels[1]);
  assert.notEqual(labels[0], labels[3]);
  assert.equal(labels[2], 0);
  const diag = grid(2, 2, 1, (x, y) => x === y);
  assert.equal(P.label(diag.a, diag.d).count, 2);
});

test('boxDilate and boxErode use a cube of the given radius, and the stack edge does not erode', () => {
  const { d, a } = grid(9, 9, 9, (x, y, z) => x === 4 && y === 4 && z === 4);
  const dil = P.boxDilate(a, d, 2);
  assert.equal(dil.reduce((s, v) => s + v, 0), 125);
  assert.equal(dil[idx(d, 2, 2, 2)], 1);
  assert.equal(dil[idx(d, 1, 4, 4)], 0);
  assert.equal(P.boxErode(dil, d, 2).reduce((s, v) => s + v, 0), 1);
  const full = new Uint8Array(729).fill(1);
  assert.equal(P.boxErode(full, d, 3).reduce((s, v) => s + v, 0), 729);
});

test('fillHoles fills an enclosed cavity and leaves an open one', () => {
  const closed = grid(7, 7, 7, (x, y, z) => x >= 1 && x <= 5 && y >= 1 && y <= 5 && z >= 1 && z <= 5 && !(x === 3 && y === 3 && z === 3));
  assert.equal(P.fillHoles(closed.a, closed.d)[idx(closed.d, 3, 3, 3)], 1);
  const open = grid(7, 7, 7, (x, y, z) => x >= 1 && x <= 5 && y >= 1 && y <= 5 && z >= 1 && z <= 5 && !(x === 3 && y === 3));
  assert.equal(P.fillHoles(open.a, open.d)[idx(open.d, 3, 3, 3)], 0);
});

test('cropMask keeps inside a polygon extruded through its plane, and several polygons intersect', () => {
  const dims = { nx: 10, ny: 10, nz: 10 };
  const xz = { plane: 'XZ', points: [{ col: 0, row: 0 }, { col: 9, row: 0 }, { col: 9, row: 5 }, { col: 0, row: 5 }] };
  const m = P.cropMask([xz], dims, 1);
  assert.equal(m[idx(dims, 5, 3, 2)], 1);
  assert.equal(m[idx(dims, 5, 9, 2)], 1, 'extruded along y');
  assert.equal(m[idx(dims, 5, 3, 8)], 0, 'below the outline');
  const yz = { plane: 'YZ', points: [{ col: 0, row: 0 }, { col: 4, row: 0 }, { col: 4, row: 9 }, { col: 0, row: 9 }] };
  const both = P.cropMask([xz, yz], dims, 1);
  assert.equal(both[idx(dims, 5, 2, 2)], 1);
  assert.equal(both[idx(dims, 5, 8, 2)], 0, 'outside the second outline');
  assert.equal(P.cropMask([], dims, 1), null);
});

test('cropMask takes full-resolution outlines and returns a binned mask', () => {
  const binned = { nx: 10, ny: 10, nz: 10 };
  const xy = { plane: 'XY', points: [{ col: 0, row: 0 }, { col: 8, row: 0 }, { col: 8, row: 8 }, { col: 0, row: 8 }] };
  const m = P.cropMask([xy], binned, 2);
  assert.equal(m[idx(binned, 3, 3, 5)], 1);
  assert.equal(m[idx(binned, 6, 3, 5)], 0);
});

test('shapeStats gives elongation near 1 for a ball and large for a rod', () => {
  const ball = P.elongation({ xx: 10, yy: 10, zz: 10, xy: 0, xz: 0, yz: 0 });
  assert.ok(Math.abs(ball - 1) < 1e-6);
  const rod = P.elongation({ xx: 100, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 });
  assert.ok(Math.abs(rod - 10) < 1e-6);
  const rotated = P.elongation({ xx: 50.5, yy: 50.5, zz: 1, xy: 49.5, xz: 0, yz: 0 });
  assert.ok(Math.abs(rotated - 10) < 1e-6);
});

// Phantom built from what the real scan shows: air 650, part 2050, a holder under the part, a crack that reaches
// outside air and links a big pore to it (the case that defeated plain connected components), and a separate small pore.
function phantom() {
  const dims = { nx: 80, ny: 60, nz: 50 };
  const n = 80 * 60 * 50;
  const gray = new Float32Array(n).fill(650);
  const outside = new Uint8Array(n);
  const inBall = (x, y, z, cx, cy, cz, r) => (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r * r;
  for (let z = 0; z < 50; z++) for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) {
    const i = idx(dims, x, y, z);
    if (x >= 10 && x < 70 && y >= 10 && y < 50 && z >= 8 && z < 38) gray[i] = 2050;
    if (z >= 42 && x >= 25 && x < 55 && y >= 15 && y < 45) gray[i] = 2050;       // holder
    if (z >= 38 && z < 42 && x >= 35 && x < 45 && y >= 25 && y < 35) gray[i] = 2050; // contact with the holder
    if (inBall(x, y, z, 30, 30, 22, 5)) gray[i] = 650;                          // big pore
    if (inBall(x, y, z, 55, 30, 22, 3)) gray[i] = 650;                          // small pore
    if (x >= 10 && x <= 30 && y >= 29 && y <= 31 && z >= 21 && z <= 23) gray[i] = 650; // crack from the left face to the big pore
  }
  return { gray, outside, dims };
}

const SETTINGS = { sigma: 0, bodyThreshold: 1400, closeRadius: 3, margin: 1, poreThreshold: 1300, neck: 1, minVolumeMm3: 0, maxElongation: 2.5 };

test('detectPores finds a big pore even when a crack links it to outside air', () => {
  const { gray, outside, dims } = phantom();
  const body = P.buildBody(gray, outside, dims, SETTINGS, null);
  const r = P.detectPores(gray, outside, dims, body, SETTINGS, { bin: 2, voxelMm: 0.04 });
  const big = r.pores.find((p) => Math.abs(p.x - P.binnedToFull(30, 2)) < 6 && Math.abs(p.z - P.binnedToFull(22, 2)) < 6);
  const small = r.pores.find((p) => Math.abs(p.x - P.binnedToFull(55, 2)) < 4);
  assert.ok(big, JSON.stringify(r.pores));
  assert.ok(small, JSON.stringify(r.pores));
  assert.ok(Math.abs(big.volume_mm3 - (4 / 3) * Math.PI * 125 * 0.08 ** 3) < 0.15, `big ${big.volume_mm3}`);
});

test('detectPores reports full-resolution coordinates and mm, with a label image that matches', () => {
  const { gray, outside, dims } = phantom();
  const body = P.buildBody(gray, outside, dims, SETTINGS, null);
  const r = P.detectPores(gray, outside, dims, body, SETTINGS, { bin: 2, voxelMm: 0.04 });
  const small = r.pores.find((p) => Math.abs(p.x - P.binnedToFull(55, 2)) < 4);
  assert.ok(Math.abs(small.x - 110.5) < 1 && Math.abs(small.y - 60.5) < 1 && Math.abs(small.z - 44.5) < 1, JSON.stringify(small));
  assert.ok(Math.abs(small.x_mm - small.x * 0.04) < 1e-9);
  assert.ok(Math.abs(small.diameter_mm - ((6 * small.volume_mm3) / Math.PI) ** (1 / 3)) < 1e-9);
  assert.equal(r.labels[idx(dims, 55, 30, 22)], small.id);
  assert.equal(r.labels[idx(dims, 20, 20, 12)], 0);
});

test('detectPores flags an elongated region as crack-like', () => {
  const dims = { nx: 60, ny: 30, nz: 30 };
  const gray = new Float32Array(60 * 30 * 30).fill(2050);
  for (let x = 10; x < 50; x++) for (let y = 14; y <= 16; y++) for (let z = 14; z <= 16; z++) gray[idx(dims, x, y, z)] = 650;
  const outside = new Uint8Array(gray.length);
  const body = P.buildBody(gray, outside, dims, SETTINGS, null);
  const r = P.detectPores(gray, outside, dims, body, { ...SETTINGS, neck: 0 }, { bin: 2, voxelMm: 0.04 });
  assert.equal(r.pores.length, 1);
  assert.equal(r.pores[0].crack_like, true);
});

test('crop removes the holder from the body, so the air beside the contact is not called a pore', () => {
  const { gray, outside, dims } = phantom();
  const crop = P.cropMask([{ plane: 'XZ', points: [{ col: 0, row: 0 }, { col: 159, row: 0 }, { col: 159, row: 75 }, { col: 0, row: 75 }] }], dims, 2);
  const body = P.buildBody(gray, outside, dims, SETTINGS, crop);
  assert.equal(body.filled[idx(dims, 40, 30, 45)], 0, 'holder is out of the body');
  assert.equal(body.filled[idx(dims, 40, 30, 20)], 1, 'part is in the body');
});

test('detectPores ignores voxels outside the reconstruction', () => {
  const { gray, outside, dims } = phantom();
  for (let z = 0; z < 50; z++) for (let y = 0; y < 60; y++) for (let x = 50; x < 80; x++) outside[idx(dims, x, y, z)] = 1;
  const body = P.buildBody(gray, outside, dims, SETTINGS, null);
  const r = P.detectPores(gray, outside, dims, body, SETTINGS, { bin: 2, voxelMm: 0.04 });
  assert.equal(r.pores.find((p) => Math.abs(p.x - P.binnedToFull(55, 2)) < 4), undefined);
});

test('minimum volume drops small regions', () => {
  const { gray, outside, dims } = phantom();
  const body = P.buildBody(gray, outside, dims, SETTINGS, null);
  const r = P.detectPores(gray, outside, dims, body, { ...SETTINGS, minVolumeMm3: 0.1 }, { bin: 2, voxelMm: 0.04 });
  assert.equal(r.pores.find((p) => Math.abs(p.x - P.binnedToFull(55, 2)) < 4), undefined);
});

test('summarize states what the numbers cover and leaves rejected and crack-like pores out of the pore count', () => {
  const pores = [{ id: 1, volume_mm3: 1, crack_like: false }, { id: 2, volume_mm3: 2, crack_like: true }, { id: 3, volume_mm3: 4, crack_like: false }];
  const s = P.summarize(pores, 100, new Set([3]));
  assert.equal(s.pore_count, 1);
  assert.equal(s.pore_volume_mm3, 1);
  assert.equal(s.crack_like_count, 1);
  assert.equal(s.rejected_count, 1);
  assert.equal(s.pore_percent_of_body, 1);
});

test('rejectedAfterRerun keeps a rejection when a new pore covers the same voxel', () => {
  const dims = { nx: 8, ny: 1, nz: 1 };
  const runs = { offsets: Int32Array.from([0, 2]), start: Int32Array.from([2, 5]), end: Int32Array.from([4, 7]), id: Int32Array.from([7, 9]), rows: 1 };
  const kept = P.rejectedAfterRerun([{ x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }], runs, dims);
  assert.deepEqual([...kept], [7]);
});

test('surfaceNets closes a ball with vertices near its radius', () => {
  const dims = { nx: 24, ny: 24, nz: 24 };
  const { a } = grid(24, 24, 24, (x, y, z) => (x - 12) ** 2 + (y - 12) ** 2 + (z - 12) ** 2 <= 64);
  const m = P.surfaceNets(a, dims);
  assert.ok(m.positions.length > 300);
  assert.equal(m.indices.length % 3, 0);
  for (let i = 0; i < m.positions.length; i += 3) {
    const r = Math.hypot(m.positions[i] - 12.5, m.positions[i + 1] - 12.5, m.positions[i + 2] - 12.5);
    assert.ok(r > 6.5 && r < 9.8, `radius ${r}`);
  }
  const edges = new Map();
  for (let i = 0; i < m.indices.length; i += 3) {
    for (const [p, q] of [[0, 1], [1, 2], [2, 0]]) {
      const a1 = m.indices[i + p], b1 = m.indices[i + q];
      const k = a1 < b1 ? `${a1},${b1}` : `${b1},${a1}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  for (const c of edges.values()) assert.equal(c, 2, 'watertight');
});

test('createSliceSmoother gives the same result as the full-volume gaussian, one slice at a time', () => {
  const dims = { nx: 14, ny: 11, nz: 13 };
  const n = 14 * 11 * 13;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = (Math.sin(i * 12.9898) * 43758.5453 % 1 + 1) * 1000;
  const whole = P.gaussian(gray, dims, 1);
  const seen = [];
  const push = P.createSliceSmoother(dims, 1, (z, s) => { seen.push(z); for (let i = 0; i < s.length; i++) assert.ok(Math.abs(s[i] - whole[z * 154 + i]) < 0.02, `z ${z} i ${i}`); });
  for (let z = 0; z < 13; z++) push(gray.slice(z * 154, (z + 1) * 154));
  assert.deepEqual(seen, [...Array(13).keys()]);
});

test('detectPores keeps a pore touching the reconstruction edge, flagged as clipped', () => {
  const { gray, outside, dims } = phantom();
  for (let z = 0; z < 50; z++) for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) if (x >= 58 && x < 61 && y >= 28 && y <= 32 && z >= 20 && z <= 24) outside[idx(dims, x, y, z)] = 1;
  const body = P.buildBody(gray, outside, dims, SETTINGS, null);
  const r = P.detectPores(gray, outside, dims, body, SETTINGS, { bin: 2, voxelMm: 0.04 });
  const near = r.pores.find((p) => Math.abs(p.x - P.binnedToFull(55, 2)) < 6);
  assert.ok(near, JSON.stringify(r.pores));
  assert.equal(near.clipped, true);
  const big = r.pores.find((p) => Math.abs(p.x - P.binnedToFull(30, 2)) < 6);
  assert.equal(big.clipped, false);
});

test('summarize leaves clipped pores out of the pore count and counts them', () => {
  const s = P.summarize([{ id: 1, volume_mm3: 1, crack_like: false, clipped: true }, { id: 2, volume_mm3: 2, crack_like: false, clipped: false }], 100, new Set());
  assert.equal(s.pore_count, 1);
  assert.equal(s.clipped_count, 1);
});

test('detectPores grows seeds until the whole low region is claimed', () => {
  const dims = { nx: 40, ny: 40, nz: 40 };
  const gray = new Float32Array(64000).fill(2050);
  for (let z = 0; z < 40; z++) for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if ((x - 20) ** 2 + (y - 20) ** 2 + (z - 20) ** 2 <= 100) gray[idx(dims, x, y, z)] = 650;
  const outside = new Uint8Array(64000);
  const body = P.buildBody(gray, outside, dims, SETTINGS, null);
  const r = P.detectPores(gray, outside, dims, body, { ...SETTINGS, neck: 6 }, { bin: 2, voxelMm: 0.04 });
  assert.equal(r.pores.length, 1);
  let claimed = 0; for (const v of r.labels) if (v) claimed++;
  let low = 0; for (const v of gray) if (v < 1300) low++;
  assert.ok(claimed > 0.97 * low, `${claimed} of ${low}`);
});

// Two-scale phantom at full resolution: a big pore the coarse pass sees, a tiny one only the fine pass can see.
function fineCase() {
  const dims = { nx: 120, ny: 80, nz: 80 };
  const slices = [];
  for (let z = 0; z < 80; z++) {
    const s = new Float32Array(9600);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 120; x++) {
      let v = 650;
      if (x >= 10 && x < 110 && y >= 10 && y < 70 && z >= 10 && z < 70) v = 2050;
      if ((x - 40) ** 2 + (y - 40) ** 2 + (z - 40) ** 2 <= 100) v = 650;
      if ((x - 85) ** 2 + (y - 40) ** 2 + (z - 40) ** 2 <= 2.5) v = 650;
      s[y * 120 + x] = v;
    }
    slices.push(s);
  }
  return { dims, slices };
}

function runBoth() {
  const { dims, slices } = fineCase();
  const binned = P.binVolume(slices.map((s) => Uint16Array.from(s)), dims, 2);
  const settings = { ...SETTINGS, closeRadius: 3, neck: 2, fineSigma: 0, minVolumeMm3: 0 };
  const body = P.buildBody(binned.gray, binned.outside, binned.dims, settings, null);
  const coarse = P.detectPores(binned.gray, binned.outside, binned.dims, body, settings, { bin: 2, voxelMm: 0.04 });
  const fine = P.fineDetect({ dims, bin: 2, settings, voxelMm: 0.04, coarse, binnedDims: binned.dims, getSmoothed: (z) => slices[z] });
  return { dims, slices, coarse, fine };
}

test('fineDetect finds a pore too small for the binned pass', () => {
  const { coarse, fine } = runBoth();
  assert.equal(coarse.pores.find((p) => Math.abs(p.x - 85) < 3), undefined, 'coarse should miss it');
  const tiny = fine.pores.find((p) => Math.abs(p.x - 85) < 2 && Math.abs(p.y - 40) < 2 && Math.abs(p.z - 40) < 2);
  assert.ok(tiny, JSON.stringify(fine.pores));
  assert.ok(tiny.volume_mm3 < 0.002);
  assert.equal(tiny.fine, true);
});

test('fineDetect measures the big pore at full resolution, as one pore with no shell of fragments', () => {
  const { fine } = runBoth();
  const big = fine.pores.filter((p) => Math.abs(p.x - 40) < 12);
  assert.equal(big.length, 1, JSON.stringify(big));
  const exact = (4 / 3) * Math.PI * 1000 * 0.04 ** 3;
  assert.ok(Math.abs(big[0].volume_mm3 - exact) < 0.05 * exact, `${big[0].volume_mm3} vs ${exact}`);
});

test('poreIdAt and planePoreIds agree with a brute-force check in every plane', () => {
  const { dims, slices, fine } = runBoth();
  const big = fine.pores.find((p) => Math.abs(p.x - 40) < 12);
  assert.equal(P.poreIdAt(fine.runs, dims, 40, 40, 40), big.id);
  assert.equal(P.poreIdAt(fine.runs, dims, 60, 40, 40), 0);
  for (const [plane, slice] of [['XY', 40], ['XZ', 40], ['YZ', 40]]) {
    const w = plane === 'YZ' ? dims.ny : dims.nx; const h = plane === 'XY' ? dims.ny : dims.nz;
    const out = new Uint32Array(w * h);
    P.planePoreIds(fine.runs, dims, plane, slice, out);
    for (let row = 0; row < h; row += 3) for (let col = 0; col < w; col += 3) {
      const v = plane === 'XY' ? [col, row, slice] : plane === 'XZ' ? [col, slice, row] : [slice, col, row];
      assert.equal(out[row * w + col], P.poreIdAt(fine.runs, dims, ...v), `${plane} ${col},${row}`);
    }
  }
  assert.equal(slices.length, 80);
});



test('firstVoxelOf returns a voxel that belongs to the pore', () => {
  const { dims, fine } = runBoth();
  const big = fine.pores[0];
  const v = P.firstVoxelOf(fine.runs, dims, big.id);
  assert.equal(P.poreIdAt(fine.runs, dims, v.x, v.y, v.z), big.id);
  assert.equal(P.firstVoxelOf(fine.runs, dims, 99999), null);
});

test('runsToBinned marks a binned voxel with the pore covering it', () => {
  const { dims, fine } = runBoth();
  const b = { nx: 60, ny: 40, nz: 40 };
  const big = fine.pores[0];
  const labels = P.runsToBinned(fine.runs, dims, b, 2);
  assert.equal(labels[(20 * 40 + 20) * 60 + 20], big.id);
  assert.equal(labels[0], 0);
});

// Database records reach the page frozen, so nothing may write onto them. This froze the slice views on 2026-11-02.
test('planeCropKeep accepts frozen records and matches the outline on every view of the crop', () => {
  const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
  const dims = { nx: 6, ny: 4, nz: 3 };
  const crop = deepFreeze({ id: 'c1', plane: 'XY', points: [{ col: 1, row: 1 }, { col: 4, row: 1 }, { col: 4, row: 3 }, { col: 1, row: 3 }] });
  const cache = new Map();
  const xy = P.planeCropKeep([crop], 'XY', 1, dims, cache);
  assert.equal(xy[1 * 6 + 2], 1);
  assert.equal(xy[0], 0);
  const xz = P.planeCropKeep([crop], 'XZ', 2, dims, cache);
  assert.deepEqual([...xz.slice(0, 6)], [0, 1, 1, 1, 0, 0]);
  assert.deepEqual([...P.planeCropKeep([crop], 'XZ', 0, dims, cache)], new Array(18).fill(0));
  const yz = P.planeCropKeep([crop], 'YZ', 2, dims, cache);
  assert.deepEqual([...yz.slice(0, 4)], [0, 1, 1, 0]);
  assert.equal(cache.size, 1);
  assert.equal(P.planeCropKeep([], 'XY', 0, dims, cache), null);
});
