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

test('plates that reach the scan edge only through the base they stand on are found', () => {
  const r = detect(Scenes.standScene());
  assert.equal(r.method, 'shape');
  const t = r.truth.thicknessVox, plates = r.pieces.filter((p) => p.kind === 'plate');
  assert.ok(plates.filter((p) => Math.abs(2 * p.half[2] - t) <= 1).length >= 2, `both plates: ${plates.map((p) => (2 * p.half[2]).toFixed(1)).join(', ')} vs ${t}`);
  assertCoverage(r);
});

test('a stepped post whose cap has a chamfered edge is still found as a post', () => {
  const r = detect(Scenes.chamferPostScene());
  assert.equal(r.method, 'shape');
  assert.ok(r.pieces.length >= 2 && r.pieces.every((p) => p.kind === 'post'), r.pieces.map((p) => `${p.kind} r${p.half[1].toFixed(1)}`).join());
  assertCoverage(r);
});

test('a bright post only a few part spreads above the part, with a shallow valley, goes the bright path', () => {
  // The resin reads 40 gray over the part (noise SD 60 before smoothing): about 4.4 of the part's spreads, a valley
  // dipping about a third of the resin's peak; the 5-spread, half-height rule saw no population.
  const scene = Scenes.diskOnPostScene({ holderGray: 40 }), Seeds = require('../app/vb_holderseeds.js');
  const sm = P.gaussian(scene.gray, scene.dims, 1), cut = (scene.truth.matrix_gray + scene.truth.air_gray) / 2;
  const st = Seeds.grayStats(sm, Uint8Array.from(sm, (v, i) => (v > cut && !scene.outside[i] ? 1 : 0)), scene.dims);
  const pops = Seeds.brightPopulations(st);
  assert.equal(pops.length, 1, 'one resolved population above the part');
  assert.ok((pops[0].peak - st.peak) / st.spread < 5, `scene: ${((pops[0].peak - st.peak) / st.spread).toFixed(2)} spreads`);
  const r = detect(scene);
  assert.equal(r.method, 'bright');
  assert.ok(r.pieces.every((p) => p.kind === 'post'), r.pieces.map((p) => p.kind).join());
  assertCoverage(r);
});

test('a bright post 3.4 part spreads above the part goes the bright path; it is covered outside its contact layer', () => {
  // At this contrast the post's one-voxel layer against the part reads like the part (partial volume), so coverage is
  // judged on the holder outside that layer; nothing of the part may be taken.
  const r = detect(Scenes.chamferPostScene({ holderGray: 36 })), { nx, ny } = r.dims, plane = nx * ny, t = r.truth;
  assert.equal(r.method, 'bright');
  assert.ok(r.pieces.every((p) => p.kind === 'post'), r.pieces.map((p) => p.kind).join());
  const contact = (i) => [1, -1, nx, -nx, plane, -plane].some((d) => t.part[i + d]);
  let total = 0, hit = 0;
  t.holder.forEach((v, i) => { if (v && !contact(i)) { total++; hit += r.holder[i]; } });
  assert.ok(hit >= 0.95 * total, `covers ${hit}/${total} outside the contact layer`);
  const [leak, partTotal] = count(r.holder, t.part);
  assert.ok(leak <= 0.01 * partTotal, `takes ${leak}/${partTotal} of the part`);
});

test('a bright post of two printed parts meeting at a seam that reads below the bright cut goes the bright path', () => {
  const r = detect(Scenes.diskOnPostScene({ holderGray: 'bright', seam: 4 }));
  assert.equal(r.method, 'bright');
  assert.ok(r.pieces.length >= 2 && r.pieces.every((p) => p.kind === 'post'), r.pieces.map((p) => p.kind).join());
  assertCoverage(r);
});

test('a part cylinder as wide as a bright post, standing on it, is not taken as the post\'s face ramp', () => {
  const r = detect(Scenes.cylinderOnPostScene());
  assert.equal(r.method, 'bright');
  assertCoverage(r);
});

test('a round boss of the part coaxial with the post, far above it across the part, is not a post step', () => {
  const r = detect(Scenes.bossOnCubeScene());
  const [kept, total] = count(r.holder.map((v) => 1 - v), r.truth.part);
  assert.ok(kept >= 0.99 * total, `keeps ${kept}/${total} of the part (${r.pieces.map((p) => `${p.kind} r${p.half[1].toFixed(1)}`).join()})`);
  assertCoverage(r);
});

test('a dense coupon standing upright on a base slab keeps its voxels; the slab is still removed', () => {
  for (const opts of [{}, { wideBase: true, thickness: 6 }, { wideBase: true, thickness: 10 }]) {
    const r = detect(Scenes.couponOnSlabScene(opts)), what = `${JSON.stringify(opts)} (${r.pieces.map((p) => p.kind).join()})`;
    const [kept, total] = count(r.holder.map((v) => 1 - v), r.truth.part), [hit, holderTotal] = count(r.holder, r.truth.holder);
    assert.ok(kept >= 0.99 * total, `keeps ${kept}/${total} of the coupon ${what}`);
    assert.ok(hit >= 0.95 * holderTotal, `covers ${hit}/${holderTotal} of the slab ${what}`);
  }
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

// A doped part reads brighter than natural nylon: raise the part's matrix voxels on one side (x past its center) by
// 12 % of (matrix - air), noise kept.
function brighterHalf(opts) {
  const s = opts.gray ? opts : S.makeHolderScene(opts), { nx } = s.dims, { part, matrix_gray: m, air_gray: a } = s.truth;
  let cx = 0, k = 0;
  part.forEach((v, i) => { if (v) { cx += i % nx; k++; } });
  cx /= k;
  for (let i = 0; i < part.length; i++) if (part[i] && i % nx > cx && s.gray[i] > (m + a) / 2) s.gray[i] += 0.12 * (m - a);
  return s;
}

test('a part with a brighter half is not a bright holder', () => {
  const r = detect(brighterHalf({ holder: 'none' }));
  assert.equal(r.pieces.length, 0, `${r.method}: ${r.pieces.map((p) => p.kind).join()}`);
});

test('a brighter half does not hide a same-gray post', () => {
  const r = detect(brighterHalf({ holder: 'post', holderGray: 'same' }));
  assert.equal(r.method, 'shape');
  assertCoverage(r);
});

test('a bright post still goes the bright path with a brighter half in the part', () => {
  const r = detect(brighterHalf({ holder: 'post', holderGray: 'bright' }));
  assert.equal(r.method, 'bright');
  assertCoverage(r);
});

test('a doped half of a flat part on a bright post is not a bright holder', () => {
  const r = detect(brighterHalf(Scenes.diskOnPostScene({ holderGray: 'bright' })));
  assert.equal(r.method, 'bright');
  assert.ok(r.pieces.every((p) => p.kind === 'post'), r.pieces.map((p) => p.kind).join());
  assertCoverage(r);
});

const W = require('../app/vb_holderwire.js');

test('holderKey changes with a toggle and not otherwise', () => {
  const post = { id: 'h1', kind: 'post', foundBy: 'shape', center: [40.5, 41, 12], axes: [0, 0, 1, 1, 0, 0, 0, 1, 0], half: [12, 6, 6], voxels: 900, mm3: 3.7 };
  const tape = { id: 'h2', kind: 'tape', foundBy: 'shape', center: [40, 50, 30], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [9, 4, 1], voxels: 80, mm3: 0.3 };
  const saved = { pieces: [post, tape], givenBack: [], method: 'shape' };
  const copy = JSON.parse(JSON.stringify(saved));
  assert.equal(W.holderKey(copy), W.holderKey(saved), 'equal holders, equal keys');
  assert.equal(W.holderKey({ ...saved, method: 'given' }), W.holderKey(saved), 'the method label does not change the mask');
  const toggled = { ...saved, givenBack: ['h2'] };
  assert.notEqual(W.holderKey(toggled), W.holderKey(saved), 'giving a piece back changes the key');
  assert.equal(W.holderKey({ ...saved, givenBack: ['h2', 'h1'] }), W.holderKey({ ...saved, givenBack: ['h1', 'h2'] }), 'order of the given-back ids does not matter');
  assert.notEqual(W.holderKey(null), W.holderKey(saved), 'no saved holder differs from a saved one');
  assert.notEqual(W.holderKey({ ...saved, pieces: null }), W.holderKey(saved), 'find again differs from saved pieces');
  const stl = { name: 'post holder', hash: '0badf00d', triangles: new Float32Array(9) };
  assert.notEqual(W.holderKey({ ...saved, stls: [stl] }), W.holderKey(saved), 'choosing an STL changes the key');
  assert.notEqual(W.holderKey({ ...saved, stls: [{ ...stl, hash: '12345678' }] }), W.holderKey({ ...saved, stls: [stl] }), 'a changed STL changes the key');
  assert.notEqual(W.holderKey({ ...saved, stls: [{ ...stl, triangles: null }] }), W.holderKey({ ...saved, stls: [stl] }), 'the STL arriving changes the key');
  assert.equal(W.holderKey({ ...saved, pieces: [{ ...post, mask: new Uint8Array(4) }, tape] }), W.holderKey(saved), 'a runtime mask is not part of the key');
  const reordered = { stls: [], method: 'shape', givenBack: [], pieces: [Object.fromEntries(Object.entries(post).reverse()), tape] };
  assert.equal(W.holderKey(reordered), W.holderKey(saved), 'a record stored with its fields in another order is the same holder');
});

test('progressText reads stage, slice and total', () => {
  assert.equal(W.progressText('Finding the holder', 120, 348), 'Finding the holder: slices 120 / 348');
  assert.equal(W.progressText('Fitting the holder STL', 0, 0), 'Fitting the holder STL');
});

const Rv = require('../app/vb_holderreview.js');

test('holder status names what was checked', () => {
  const p = (id) => ({ id, kind: 'post', foundBy: 'shape', center: [1, 2, 3], axes: [0, 0, 1, 1, 0, 0, 0, 1, 0], half: [6, 3, 3], voxels: 10, mm3: 0.1 });
  const three = [p('h1'), p('h2'), p('h3')];
  assert.equal(Rv.holderStatus(null), 'not run', 'nothing built yet');
  assert.notEqual(Rv.holderStatus(null), 'no holder found', 'not run never reads as a clean result');
  assert.equal(Rv.holderStatus({ method: 'none', pieces: [], givenBack: [], reviewed: false }), 'no holder found');
  assert.equal(Rv.holderStatus({ method: 'none', pieces: [], givenBack: [], reviewed: false }, 'Found 300 holder pieces'), 'removal failed: Found 300 holder pieces');
  assert.equal(Rv.holderStatus(null, 'out of memory'), 'removal failed: out of memory', 'a failed build is never "not run"');
  assert.equal(Rv.holderStatus({ method: 'shape', pieces: three, givenBack: [], reviewed: false }), '3 holder pieces, not reviewed');
  assert.equal(Rv.holderStatus({ method: 'bright', pieces: three, givenBack: ['h2'], reviewed: true }), '3 holder pieces, reviewed (1 given back)');
  assert.equal(Rv.holderStatus({ method: 'bright', pieces: three, givenBack: [], reviewed: true }), '3 holder pieces, reviewed');
  assert.equal(Rv.holderStatus({ method: 'shape', pieces: three.slice(0, 1), givenBack: [], reviewed: false }), '1 holder piece, not reviewed');
  assert.equal(Rv.holderMethod({ method: 'bright', pieces: three, stls: [] }), 'found by bright resin');
  assert.equal(Rv.holderMethod({ method: 'shape', pieces: three, stls: [] }), 'found by shape');
  const stl = { name: 'post holder', hash: 'aa' };
  assert.equal(Rv.holderMethod({ method: 'stl', pieces: three, stls: [{ ...stl, outcome: 'fitted', rmsMm: 0.1234 }] }), 'holder STL post holder fitted (RMS 0.12 mm)');
  assert.equal(Rv.holderMethod({ method: 'shape', pieces: three, stls: [{ ...stl, outcome: 'poor fit', fallback: 'shape' }] }), 'holder STL post holder did not fit; found by shape');
  assert.equal(Rv.holderMethod({ method: 'bright', pieces: three, stls: [{ ...stl, outcome: 'missing' }] }), 'holder STL post holder not loaded; found by bright resin');
});

test('the saved record holds native pieces and the toggles', () => {
  const native = { id: 'h1', kind: 'post', foundBy: 'bright', center: [63.5, 63.5, 24.5], axes: [0, 0, 1, 1, 0, 0, 0, 1, 0], half: [24, 10, 10], voxels: 900, mm3: 3.7 };
  const tape = { id: 'h2', kind: 'tape', foundBy: 'shape', center: [40, 50, 30], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [9, 4, 1], voxels: 80, mm3: 0.3 };
  const h = { method: 'bright', given: false, pieces: [native, tape], givenBack: [], stls: [], keep: null };
  const at = '2026-11-07T12:00:00.000Z';
  const r = Rv.holderRecord(h, ['h2'], at);
  assert.deepEqual(r, { pieces: [native, tape], given_back: ['h2'], method: 'bright', reviewed_at: at });
  assert.notEqual(r.pieces[0], native, 'the record is a copy');
  const fitted = { id: 'h1', kind: 'stl', foundBy: 'stl', name: 'post holder', hash: 'aa', pose: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, voxels: 50, mm3: 0.2, mask: new Uint8Array(4) };
  const s = Rv.holderRecord({ method: 'stl', given: false, pieces: [fitted], givenBack: [], stls: [{ name: 'post holder', hash: 'aa', outcome: 'fitted', rmsMm: 0.1 }], keep: null }, [], at);
  assert.equal('mask' in s.pieces[0], false, 'a runtime mask is never saved');
  assert.deepEqual(s.stls, [{ name: 'post holder', hash: 'aa' }], 'the chosen STLs stay with the review');
  assert.equal('stl' in s, false, 'the list replaces the older single field');
  assert.equal(s.pieces[0].hash, 'aa');
  const keep = { ...h, keep: { pieces: [fitted], givenBack: ['h1'], method: 'stl' }, stls: [{ name: 'post holder', hash: 'aa', outcome: 'missing' }] };
  assert.equal(Rv.holderRecord(keep, [], at), null, 'never saved while the saved review waits for its STL');
  assert.equal(Rv.holderRecord({ ...h, failed: 'boom' }, [], at), null, 'a failed removal is not a review');
  assert.equal(Rv.holderRecord(null, [], at), null);
  assert.match(Rv.reviewBlock(keep), /post holder is not loaded; the saved review is kept/);
  assert.equal(Rv.reviewBlock(h), null);
});
