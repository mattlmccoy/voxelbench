'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../app/vb_holder.js');
const S = require('../app/vb_synthetic.js');

const angleDeg = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;

test('a slab fit recovers a plate\'s normal and thickness', () => {
  const tilt = (25 * Math.PI) / 180, nx = Math.sin(tilt), nz = Math.cos(tilt), t = 4, pts = [];
  for (let z = 0; z < 60; z++) for (let y = 0; y < 50; y++) for (let x = 0; x < 60; x++) {
    const s = nx * x + nz * z;
    if (s > 20 - t && s <= 20 && x > 8 && x < 52 && z > 5) pts.push(x, y, z);
  }
  const fit = H.fitSlab(Float32Array.from(pts));
  assert.ok(angleDeg(fit.axes.slice(6, 9), [nx, 0, nz]) < 2, 'normal');
  assert.ok(Math.abs(2 * fit.half[2] - t) < 1, `thickness ${2 * fit.half[2]}`);
  assert.ok(fit.half[0] >= fit.half[1] && fit.half[1] >= fit.half[2]);
});

test('a cylinder fit recovers a post\'s axis and radius', () => {
  const s = S.makeHolderScene({ size: 64, holder: 'post' }), n = 64, stem = s.truth.pieces[1], pts = [];
  for (let z = stem.zFrom; z <= stem.zTo; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (s.truth.holder[x + n * (y + n * z)]) pts.push(x, y, z);
  const fit = H.fitCylinder(Float32Array.from(pts));
  assert.ok(angleDeg(fit.axes.slice(0, 3), [0, 0, 1]) < 2, 'axis');
  assert.ok(Math.abs(fit.half[1] - stem.radiusVox) < 0.5, `radius ${fit.half[1]} vs ${stem.radiusVox}`);
  assert.equal(fit.half[1], fit.half[2]);
});

test('a cylinder fit also takes a short fat cap, whose axis is its least-spread direction', () => {
  const s = S.makeHolderScene({ size: 64, holder: 'post' }), n = 64, cap = s.truth.pieces[0], pts = [];
  for (let z = cap.zFrom; z <= cap.zTo; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (s.truth.holder[x + n * (y + n * z)]) pts.push(x, y, z);
  const fit = H.fitCylinder(Float32Array.from(pts));
  assert.ok(angleDeg(fit.axes.slice(0, 3), [0, 0, 1]) < 2, 'axis');
  assert.ok(Math.abs(fit.half[1] - cap.radiusVox) < 0.5, `radius ${fit.half[1]} vs ${cap.radiusVox}`);
});

// Post scene, solid = gray above the midpoint of matrix and air (no smoothing), pieces fit to each step's truth voxels.
function postCase() {
  const s = S.makeHolderScene({ size: 64, holder: 'post' }), n = 64, dims = s.dims, { truth } = s;
  const cut = (truth.matrix_gray + truth.air_gray) / 2, solid = new Uint8Array(s.gray.length);
  for (let i = 0; i < solid.length; i++) solid[i] = s.gray[i] > cut ? 1 : 0;
  const pieces = truth.pieces.map((p, k) => {
    const pts = [];
    for (let z = p.zFrom; z <= p.zTo; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (truth.holder[x + n * (y + n * z)]) pts.push(x, y, z);
    const f = H.fitCylinder(Float32Array.from(pts));
    return { id: 'p' + k, kind: 'post', foundBy: 'shape', ...f, voxels: pts.length / 3, mm3: 0 };
  });
  return { solid, dims, pieces, truth };
}
const count = (a, b) => { let c = 0, t = 0; for (let i = 0; i < a.length; i++) if (b[i]) { t++; if (a[i]) c++; } return [c, t]; };

test('holderMask takes the solid inside the pieces and nothing given back', () => {
  const { solid, dims, pieces, truth } = postCase();
  const { holder, labels } = H.holderMask({ solid, dims, pieces, givenBack: [] });
  const [hit, total] = count(holder, truth.holder), [leak, partTotal] = count(holder, truth.part);
  assert.ok(hit >= 0.95 * total, `covers ${hit}/${total}`);
  assert.ok(leak <= 0.01 * partTotal, `takes ${leak}/${partTotal} of the part`);
  const back = H.holderMask({ solid, dims, pieces, givenBack: pieces.map((p) => p.id) });
  assert.equal(back.holder.reduce((a, v) => a + v, 0), 0);
  assert.deepEqual([...back.labels], [...labels], 'labels still mark every piece');
  assert.ok(labels.some((v) => v === 1) && labels.some((v) => v === 2));
});

test('a tape piece takes only solid whose local thickness is at most 2', () => {
  const dims = { nx: 20, ny: 20, nz: 20 }, at = (x, y, z) => x + 20 * (y + 20 * z), solid = new Uint8Array(8000);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) solid[at(x, y, 15)] = 1;                  // one-voxel shell
  for (let z = 2; z < 8; z++) for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) solid[at(x, y, z)] = 1; // thick block
  const whole = { id: 't', kind: 'tape', foundBy: 'shape', center: [10, 10, 10], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [10, 10, 10], voxels: 0, mm3: 0 };
  const { holder } = H.holderMask({ solid, dims, pieces: [whole], givenBack: [] });
  assert.equal(holder[at(10, 10, 15)], 1, 'shell taken');
  assert.equal(holder[at(6, 6, 5)], 0, 'block kept');
  assert.equal(H.insidePiece(whole, 10, 10, 10), true);
  assert.equal(H.insidePiece(whole, 10, 10, 21), false);
});

// findHolder on full scenes: smoothed and solid as buildBody makes them (sigma 1, cut at the midpoint of part and air).
const P = require('../app/ct_pores.js');
const Scenes = require('./holder_scenes.js');
function detect(opts, onProgress) {
  const s = opts.gray ? opts : S.makeHolderScene(opts), { dims, truth } = s;
  const smoothed = P.gaussian(s.gray, dims, 1), cut = (truth.matrix_gray + truth.air_gray) / 2, solid = new Uint8Array(smoothed.length);
  for (let i = 0; i < solid.length; i++) solid[i] = smoothed[i] > cut && !s.outside[i] ? 1 : 0;
  const found = H.findHolder({ smoothed, solid, outside: s.outside, dims, voxelMm: s.voxelMm, onProgress });
  const { holder } = H.holderMask({ solid, dims, pieces: found.pieces, givenBack: [] });
  return { ...found, holder, truth, dims };
}
function assertCoverage({ holder, truth, pieces }) {
  const [hit, total] = count(holder, truth.holder), [leak, partTotal] = count(holder, truth.part);
  const kinds = pieces.map((p) => p.kind).join(',');
  assert.ok(hit >= 0.95 * total, `covers ${hit}/${total} (${kinds})`);
  assert.ok(leak <= 0.01 * partTotal, `takes ${leak}/${partTotal} of the part (${kinds})`);
}

test('a bright post is found by brightness', () => {
  const r = detect({ holder: 'post', holderGray: 'bright' });
  assert.equal(r.method, 'bright');
  assert.ok(r.pieces.length >= 1 && r.pieces.length <= 2 && r.pieces.every((p) => p.kind === 'post' && p.foundBy === 'bright'), r.pieces.map((p) => p.kind).join());
  assertCoverage(r);
});

test('a post at part gray is found by shape', () => {
  const r = detect({ holder: 'post', holderGray: 'same' });
  assert.equal(r.method, 'shape');
  assert.ok(r.pieces.length >= 1 && r.pieces.every((p) => p.kind === 'post' && p.foundBy === 'shape'), r.pieces.map((p) => p.kind).join());
  assertCoverage(r);
  assert.deepEqual(r.pieces.map((p) => p.id), r.pieces.map((_, k) => 'h' + (k + 1)));
  assert.ok(r.pieces.every((p, k) => k === 0 || r.pieces[k - 1].voxels >= p.voxels), 'ids in order of size');
});

test('tilted plates and a base slab are found as three plates', () => {
  const r = detect({ holder: 'plates' });
  assert.equal(r.method, 'shape');
  assert.deepEqual(r.pieces.map((p) => p.kind), ['plate', 'plate', 'plate']);
  const t = r.truth.pieces[0].thicknessVox;
  for (const p of r.pieces) assert.ok(Math.abs(2 * p.half[2] - t) <= 1, `thickness ${2 * p.half[2]} vs ${t}`);
  assertCoverage(r);
});

test('a flat-faced cube on a post keeps every face', () => {
  const r = detect({ part: 'cube', holder: 'post' }), { nx, ny } = r.dims;
  assert.ok(r.pieces.length > 0 && r.pieces.every((p) => p.kind === 'post'), r.pieces.map((p) => p.kind).join());
  assertCoverage(r);
  const [, partTotal] = count(r.holder, r.truth.part);
  const c = [0, 0, 0];
  r.truth.part.forEach((v, i) => { if (v) { c[0] += i % nx; c[1] += Math.floor(i / nx) % ny; c[2] += Math.floor(i / (nx * ny)); } });
  c.forEach((_, k) => { c[k] /= partTotal; });
  for (const p of r.pieces) {
    const q = [0, 3, 6].map((o) => (c[0] - p.center[0]) * p.axes[o] + (c[1] - p.center[1]) * p.axes[o + 1] + (c[2] - p.center[2]) * p.axes[o + 2]);
    assert.ok(q.some((v, k) => Math.abs(v) > p.half[k]), `${p.id} (${p.kind}) box holds the cube's center`);
  }
});

test('no holder, no pieces', () => {
  const r = detect({ holder: 'none' });
  assert.equal(r.method, 'none');
  assert.equal(r.pieces.length, 0);
});

test('a part running off the scan edge is not a holder', () => {
  const r = detect({ holder: 'none', touchEdge: true });
  assert.equal(r.pieces.length, 0, r.pieces.map((p) => p.kind).join());
});

test('bright inclusions are not a bright holder', () => {
  const none = detect({ holder: 'none', inclusions: true });
  assert.equal(none.pieces.length, 0, none.pieces.map((p) => p.kind).join());
  const post = detect({ holder: 'post', holderGray: 'same', inclusions: true });
  assert.equal(post.method, 'shape');
});

test('progress reaches its total', () => {
  const calls = [];
  detect({ size: 64, holder: 'post' }, (stage, k, total) => calls.push([stage, k, total]));
  assert.ok(calls.length > 0);
  const [stage, k, total] = calls[calls.length - 1];
  assert.equal(stage, 'Finding the holder');
  assert.equal(k, total);
  assert.equal(total, 3 * 64, 'once per slice per direction');
});

test('a large post tilted 10 or 20 degrees is found', () => {
  for (const tiltDeg of [10, 20]) {
    const r = detect(Scenes.tiltedPostScene({ radius: 0.15, tiltDeg }));
    assert.notEqual(r.method, 'none', `tilt ${tiltDeg}`);
    assert.ok(r.pieces.every((p) => p.kind === 'post'), r.pieces.map((p) => p.kind).join());
    assertCoverage(r);
  }
});

test('a flat round part on a stepped post keeps its voxels', () => {
  const r = detect(Scenes.diskOnPostScene());
  const [kept, total] = count(r.holder.map((v) => 1 - v), r.truth.part);
  assert.ok(kept >= 0.99 * total, `keeps ${kept}/${total} of the disk (${r.pieces.map((p) => p.kind).join()})`);
  const [hit, holderTotal] = count(r.holder, r.truth.holder);
  assert.ok(hit >= 0.95 * holderTotal, `covers ${hit}/${holderTotal}`);
});

test('a bright holder with more voxels than the part is found by brightness', () => {
  const r = detect({ holder: 'plates', holderGray: 'bright' });
  const holderVoxels = r.truth.holder.reduce((a, v) => a + v, 0), partVoxels = r.truth.part.reduce((a, v) => a + v, 0);
  assert.ok(holderVoxels > partVoxels, 'scene: holder outnumbers part');
  assert.equal(r.method, 'bright');
  assertCoverage(r);
});

test('plates at twice the resolution are still three plates', () => {
  const r = detect({ size: 256, holder: 'plates' });
  assert.deepEqual(r.pieces.map((p) => p.kind), ['plate', 'plate', 'plate']);
  assertCoverage(r);
});
