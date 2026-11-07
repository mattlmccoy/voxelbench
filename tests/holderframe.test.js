'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../app/vb_holder.js');
const F = require('../app/vb_holderframe.js');
const O = require('../app/vb_orient.js');

const post = (c, a, half) => ({ id: 'p1', kind: 'post', foundBy: 'shape', center: c, axes: [...a, 0, 1, 0, 0, 0, 1].slice(0, 9), half, voxels: 500, mm3: 12.5 });
const close = (a, b, tol = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const rotX = (deg) => { const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const plate = { id: 'pl', kind: 'plate', foundBy: 'bright', center: [10.5, 20.25, 7], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [8, 6, 1.5], voxels: 900, mm3: 40 };
const solidPost = (n, c, r, z0, z1) => { const m = new Uint8Array(n * n * n); for (let z = z0; z <= z1; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (Math.hypot(x - c, y - c) <= r) m[x + n * (y + n * z)] = 1; return m; };

test('pieces survive a round trip through native voxels', () => {
  const orient = { R: rotX(20), center: [30, 31, 32], origin: [-12, -9, -20], dims: { nx: 40, ny: 50, nz: 60 } };
  const tilted = { ...plate, axes: [0.6, 0.8, 0, -0.8, 0.6, 0, 0, 0, 1] };
  for (const o of [null, orient]) for (const g of [{ bin: 1, binFactor: 1 }, { bin: 2, binFactor: 1 }, { bin: 2, binFactor: 2 }, { bin: 1, binFactor: 4 }]) {
    const back = F.piecesFromNative(F.piecesToNative([plate, tilted], g, o), g, o);
    back.forEach((p, k) => {
      const q = [plate, tilted][k];
      assert.ok(close(p.center, q.center) && close(p.axes, q.axes) && close(p.half, q.half), `g=${JSON.stringify(g)} ${JSON.stringify(p)}`);
      assert.deepEqual([p.id, p.kind, p.foundBy, p.voxels, p.mm3], [q.id, q.kind, q.foundBy, q.voxels, q.mm3]);
    });
  }
});

test('conversion scales centers and half extents, and never mutates its input', () => {
  const copy = JSON.parse(JSON.stringify(plate)), [n] = F.piecesToNative([plate], { bin: 1, binFactor: 2 }, null);
  assert.deepEqual(plate, copy);
  assert.ok(close(n.center, [21.5, 41, 14.5]), n.center.join());
  assert.ok(close(n.half, [16, 12, 3]));
  assert.ok(close(n.axes, plate.axes));
});

test('the same pieces rebuild the same holder at another binning', () => {
  const n = 96, c = (n - 1) / 2, solidAll = (m) => new Uint8Array(m * m * m).fill(1);
  const p = post([c, c, 30], [0, 0, 1, 1, 0, 0, 0, 1, 0], [30.5, 24, 24]);
  const coarse = F.piecesFromNative([p], { bin: 1, binFactor: 2 }, null)[0], m = n / 2;
  const a = H.holderMask({ solid: solidAll(n), dims: { nx: n, ny: n, nz: n }, pieces: [p] }).holder;
  const b = H.holderMask({ solid: solidAll(m), dims: { nx: m, ny: m, nz: m }, pieces: [coarse] }).holder;
  let inter = 0, sa = 0, sb = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const va = a[x + n * (y + n * z)], vb = b[(x >> 1) + m * ((y >> 1) + m * (z >> 1))];
    inter += va & vb; sa += va; sb += vb;
  }
  const dice = (2 * inter) / (sa + sb);
  assert.ok(sa > 0 && dice >= 0.97, `dice ${dice}`);
});

// A native post (n = 64, tilted 20 deg about x in the saved orientation) as the app sees it: the scan binned by
// binFactor, resampled into the leveled loaded grid through onGrid, then (bin > 1) averaged in bin-blocks as the worker does.
function leveledCase(binFactor, bin) {
  const n = 96, c = 48 + (binFactor - 1) / 2 /* the binned scan's center is then an integer voxel: no round-half ties */, solid = solidPost(n, c, 28, 0, 61), R = rotX(20), tmp = { R, center: [c, c, c] };
  const saved = { ...tmp, ...O.gridFor(tmp, solid, { nx: n, ny: n, nz: n }, 1, 2) };
  const m = n / binFactor, slices = [];
  for (let z = 0; z < m; z++) {
    const s = new Uint16Array(m * m);
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      let k = 0;
      for (let dz = 0; dz < binFactor; dz++) for (let dy = 0; dy < binFactor; dy++) for (let dx = 0; dx < binFactor; dx++) k += solid[(x * binFactor + dx) + n * ((y * binFactor + dy) + n * (z * binFactor + dz))];
      s[x + m * y] = k * 2 >= binFactor ** 3 ? 2 : 0; // gray 2 = post; 0 reads as 1 (air inside the scan)
    }
    slices.push(s);
  }
  const orient = O.onGrid(saved, binFactor), lev = O.resample({ slices, dims: { nx: m, ny: m, nz: m }, circle: null, orient });
  const { nx, ny, nz } = orient.dims, wx = Math.floor(nx / bin), wy = Math.floor(ny / bin), wz = Math.floor(nz / bin), post = new Uint8Array(wx * wy * wz);
  for (let z = 0; z < wz; z++) for (let y = 0; y < wy; y++) for (let x = 0; x < wx; x++) {
    let sum = 0;
    for (let dz = 0; dz < bin; dz++) for (let dy = 0; dy < bin; dy++) for (let dx = 0; dx < bin; dx++) sum += lev[z * bin + dz][(x * bin + dx) + nx * (y * bin + dy)] > 1 ? 1 : 0;
    post[x + wx * (y + wy * z)] = sum * 2 >= bin ** 3 ? 1 : 0;
  }
  const truth = post_([c, c, 30.5], [31, 28, 28]);
  return { saved, post, dims: [wx, wy, wz], truth };
}
function post_(c, half) { return post(c, [0, 0, 1, 1, 0, 0, 0, 1, 0], half); }
const coverage = ({ saved, post: mask, dims, truth }, scale, orient) => {
  const [q0] = F.piecesFromNative([truth], scale, orient ? saved : null), [wx, wy] = dims;
  const q = { ...q0, half: q0.half.map((h) => h + 0.5) }; // a voxel counts when its cell overlaps the piece (half a worker voxel)
  let total = 0, inside = 0, rast = 0, both = 0;
  const cen = [0, 0, 0];
  for (let i = 0; i < mask.length; i++) {
    const x = i % wx, y = Math.floor(i / wx) % wy, z = Math.floor(i / (wx * wy)), tight = H.insidePiece(q0, x, y, z);
    if (tight) rast++;
    if (tight && mask[i]) both++;
    if (!mask[i]) continue;
    cen[0] += x; cen[1] += y; cen[2] += z;
    total++; if (H.insidePiece(q, x, y, z)) inside++;
  }
  const off = Math.hypot(...cen.map((v, k) => v / total - q0.center[k])); // the post is symmetric, so its mask centroid is its center
  return { total, inside, dice: (2 * both) / (rast + total), off };
};

for (const [binFactor, bin] of [[1, 1], [2, 1], [2, 2], [1, 2]]) {
  test(`pieces follow a leveled frame at binFactor ${binFactor}, bin ${bin}`, () => {
    const sc = leveledCase(binFactor, bin), { total, inside, off } = coverage(sc, { bin, binFactor }, true);
    assert.ok(total > 200 && inside >= 0.95 * total, `${inside}/${total}`);
    assert.ok(off < 0.1, `piece center is ${off} worker voxels from the post's centroid`); // the offset that a wrong half-voxel shift causes
    const wrong = coverage(sc, { bin, binFactor }, false); // an unrotated-frame piece misses most of the rotated post
    assert.ok(wrong.inside < inside);
  });
}
