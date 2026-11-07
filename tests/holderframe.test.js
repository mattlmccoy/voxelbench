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
  for (const o of [null, orient]) for (const g of [1, 2, 4]) {
    const back = F.piecesFromNative(F.piecesToNative([plate, tilted], g, o), g, o);
    back.forEach((p, k) => {
      const q = [plate, tilted][k];
      assert.ok(close(p.center, q.center) && close(p.axes, q.axes) && close(p.half, q.half), `g=${g} ${JSON.stringify(p)}`);
      assert.deepEqual([p.id, p.kind, p.foundBy, p.voxels, p.mm3], [q.id, q.kind, q.foundBy, q.voxels, q.mm3]);
    });
  }
});

test('conversion scales centers and half extents, and never mutates its input', () => {
  const copy = JSON.parse(JSON.stringify(plate)), [n] = F.piecesToNative([plate], 2, null);
  assert.deepEqual(plate, copy);
  assert.ok(close(n.center, [21.5, 41, 14.5]), n.center.join());
  assert.ok(close(n.half, [16, 12, 3]));
  assert.ok(close(n.axes, plate.axes));
});

test('the same pieces rebuild the same holder at another binning', () => {
  const n = 96, c = (n - 1) / 2, fine = solidPost(n, c, 24, 0, 60), solidAll = (m) => new Uint8Array(m * m * m).fill(1);
  const p = post([c, c, 30], [0, 0, 1, 1, 0, 0, 0, 1, 0], [30.5, 24, 24]);
  const coarse = F.piecesFromNative([p], 2, null)[0], m = n / 2;
  const a = H.holderMask({ solid: solidAll(n), dims: { nx: n, ny: n, nz: n }, pieces: [p] }).holder;
  const b = H.holderMask({ solid: solidAll(m), dims: { nx: m, ny: m, nz: m }, pieces: [coarse] }).holder;
  let inter = 0, sa = 0, sb = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const va = a[x + n * (y + n * z)], vb = b[(x >> 1) + m * ((y >> 1) + m * (z >> 1))];
    inter += va & vb; sa += va; sb += vb;
  }
  const dice = (2 * inter) / (sa + sb);
  assert.ok(sa > 0 && dice >= 0.97, `dice ${dice}`);
  assert.ok(fine.length === n * n * n);
});

test('pieces follow a leveled frame', () => {
  const n = 64, c = (n - 1) / 2, solid = solidPost(n, c, 10, 0, 40), slices = [];
  for (let z = 0; z < n; z++) slices.push(Uint16Array.from(solid.subarray(z * n * n, (z + 1) * n * n), (v) => 2 * v)); // gray 2 = post, 0 reads as 1 (air inside the scan)
  const R = rotX(20), tmp = { R, center: [c, c, c] };
  const grid = O.gridFor(tmp, solid, { nx: n, ny: n, nz: n }, 1, 2), orient = { ...tmp, ...grid };
  const lev = O.resample({ slices, dims: { nx: n, ny: n, nz: n }, circle: null, orient });
  const p = post([c, c, 20], [0, 0, 1, 1, 0, 0, 0, 1, 0], [20.5, 10, 10]);
  const [q] = F.piecesFromNative([p], 1, orient);
  const { nx, ny, nz } = orient.dims;
  let total = 0, inside = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (lev[z][x + nx * y] < 2) continue;
    total++; if (H.insidePiece(q, x, y, z)) inside++;
  }
  assert.ok(total > 1000 && inside >= 0.95 * total, `${inside}/${total}`);
  // an unrotated-frame piece would miss most of the rotated post
  const [raw] = F.piecesToNative([p], 1, null);
  let rawIn = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (lev[z][x + nx * y] > 1 && H.insidePiece(raw, x, y, z)) rawIn++;
  assert.ok(rawIn < inside);
});
