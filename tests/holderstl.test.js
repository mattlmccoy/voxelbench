'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const HS = require('../app/vb_holderstl.js');
const H = require('../app/vb_holder.js');
const F = require('../app/vb_holderframe.js');
const S = require('../app/vb_synthetic.js');
const P = require('../app/ct_pores.js');
const Scenes = require('./holder_scenes.js');

const { lathe, box, cross, mat, norm, rotation, displaced } = Scenes;

const place = (pose, p) => mat(pose.R, p).map((v, k) => v + pose.t[k]);
const angleDeg = (a, b) => (Math.acos(Math.min(1, Math.abs(norm(a).reduce((s, v, k) => s + v * norm(b)[k], 0)))) * 180) / Math.PI;

/** Solid as the mask build makes it: smoothed (sigma 1) above the midpoint of part and air, inside the FOV. */
function solidOf(s) {
  const smoothed = P.gaussian(s.gray, s.dims, 1), cut = (s.truth.matrix_gray + s.truth.air_gray) / 2, solid = new Uint8Array(smoothed.length);
  for (let i = 0; i < solid.length; i++) solid[i] = smoothed[i] > cut && !s.outside[i] ? 1 : 0;
  return { smoothed, solid };
}
/** Holder pieces from shape or brightness detection: the fit's start, as in the app. */
function seedsOf(scene) {
  const { smoothed, solid } = solidOf(scene);
  return H.findHolder({ smoothed, solid, outside: scene.outside, dims: scene.dims, voxelMm: scene.voxelMm }).pieces;
}
const count = (a, b) => { let c = 0, t = 0; for (let i = 0; i < a.length; i++) if (b[i]) { t++; if (a[i]) c++; } return [c, t]; };

/** Fit the STL to the scene and cut the holder with it; returns the fit, cover and leak. */
function fitScene(scene, stl, { seeds = [] } = {}) {
  const { solid } = solidOf(scene), { dims, voxelMm } = scene;
  const fit = HS.fitHolderStl({ triangles: stl.tri, solid, outside: scene.outside, dims, voxelMm, seeds });
  const mask = HS.voxelizeMesh({ triangles: stl.tri, pose: fit.pose, dims });
  const piece = HS.stlPiece({ name: 'holder', hash: 'h0', pose: fit.pose, mask });
  const { holder } = H.holderMask({ solid, dims, pieces: [piece] });
  const [hit, total] = count(holder, scene.truth.holder), [leak, partTotal] = count(holder, scene.truth.part);
  return { fit, hit, total, leak, partTotal, solid };
}
function assertCoverage(r) {
  assert.ok(r.hit >= 0.95 * r.total, `covers ${r.hit}/${r.total}`);
  assert.ok(r.leak <= 0.01 * r.partTotal, `takes ${r.leak}/${r.partTotal} of the part`);
}

/** The stepped post of makeHolderScene as an STL whose stem runs `below` voxels past slice 0. */
function postStl(scene, below = 10) {
  const n = scene.dims.nx, c = (n - 1) / 2, [cap, stem] = scene.truth.pieces, zs = cap.zFrom - 0.5, zt = cap.zTo + 0.5;
  const vox = lathe([[0, -below], [stem.radiusVox, -below], [stem.radiusVox, zs], [cap.radiusVox, zs], [cap.radiusVox, zt], [0, zt]], [c, c]);
  return { ...displaced(vox, scene.voxelMm, [c, c, zt / 2]), axisTop: [c, c, zt], axisLow: [c, c, 0] };
}

test('voxelizeMesh fills a closed cube exactly', () => {
  const dims = { nx: 20, ny: 20, nz: 20 }, I = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  for (const c of [7, 7.5]) { // faces between voxel centers, and faces through them (the tie rule counts each once)
    const m = HS.voxelizeMesh({ triangles: Float32Array.from(box([c, c, c], [1, 0, 0], [0, 1, 0], [5, 5, 5])), pose: I, dims });
    assert.equal(m.reduce((a, v) => a + v, 0), 1000, `cube centered at ${c}`);
  }
  // In mm through a pose (0.5 mm voxels, a quarter turn about z, then shifted): still 1000 voxels.
  const mm = Float32Array.from(box([0, 0, 0], [1, 0, 0], [0, 1, 0], [2.5, 2.5, 2.5]));
  const m = HS.voxelizeMesh({ triangles: mm, pose: { R: [0, -2, 0, 2, 0, 0, 0, 0, 2], t: [9.5, 9.5, 9.5] }, dims });
  assert.equal(m.reduce((a, v) => a + v, 0), 1000);
});

test('a post STL fits the post scene', () => {
  const scene = S.makeHolderScene({ holder: 'post' }), stl = postStl(scene);
  const seeds = seedsOf(scene);
  assert.ok(seeds.length > 0, 'shape detection gives the fit its start');
  const r = fitScene(scene, stl, { seeds });
  for (const p of [stl.axisTop, stl.axisLow]) { // points on the axis: the post's turn about it is not observable
    const cad = stl.cadPoint(p), err = Math.hypot(...place(r.fit.pose, cad).map((v, k) => v - place(stl.truth, cad)[k]));
    assert.ok(err <= 1, `axis point ${p} off by ${err.toFixed(2)} voxels`);
  }
  const axis = stl.cadDir([0, 0, 1]), da = angleDeg(mat(r.fit.pose.R, axis), mat(stl.truth.R, axis));
  assert.ok(da <= 2, `axis off by ${da.toFixed(2)} deg`);
  assert.ok(r.fit.fits, `fit ${JSON.stringify({ ...r.fit, pose: undefined })}`);
  assertCoverage(r);
});

// ICP calls during a fit (vb_holderstl.js calls vb_align's icp through the module object).
const Al = require('../app/vb_align.js');
function countingIcp(fn) {
  const icp = Al.icp;
  let calls = 0;
  Al.icp = (...a) => { calls++; return icp(...a); };
  try { return { out: fn(), calls: () => calls }; } finally { Al.icp = icp; }
}
const ONE_START = 3; // ROUNDS in vb_holderstl.js: the ICP rounds of one start run to the end

test('a start whose fit clears the floors with margin ends the start search', () => {
  const scene = S.makeHolderScene({ holder: 'post' }), stl = postStl(scene), seeds = seedsOf(scene);
  const { out: r, calls } = countingIcp(() => fitScene(scene, stl, { seeds }));
  assert.ok(r.fit.fits && r.fit.nearShare >= HS.FIT_MIN_NEAR + 0.1, `fit ${JSON.stringify({ ...r.fit, pose: undefined })}`);
  assert.equal(calls(), ONE_START, 'the first start held with margin: no other start was refined');
  assertCoverage(r);
});

test('a symmetric seed (the stem alone) still fits the post the right way up', () => {
  const scene = S.makeHolderScene({ holder: 'post' }), stl = postStl(scene, 40); // a mount reaching far below the scan
  const stem = seedsOf(scene).filter((p) => p.half[1] < scene.truth.pieces[1].radiusVox + 1);
  assert.equal(stem.length, 1, 'the stem alone');
  const { out: r, calls } = countingIcp(() => fitScene(scene, stl, { seeds: stem }));
  assert.ok(calls() > ONE_START, 'the fit needed a later start (a half turn)');
  const cad = stl.cadPoint(stl.axisTop), err = Math.hypot(...place(r.fit.pose, cad).map((v, k) => v - place(stl.truth, cad)[k]));
  assert.ok(err <= 1, `the cap top is ${err.toFixed(2)} voxels off`);
  assertCoverage(r);
});

/** The plates of makeHolderScene as three overlapping slabs reaching a little past the FOV (0.47 size) and the
    volume, as a printed holder would. */
function platesStl(scene) {
  const n = scene.dims.nx, c = (n - 1) / 2, long = 0.75 * n, wide = 0.52 * n, vox = [], planes = [];
  for (const p of scene.truth.pieces) {
    const w = p.normal, base = p.tiltDeg === 0, u = norm(cross([0, 1, 0], w));
    const h = base ? [wide, wide, (p.offset + 10) / 2] : [long, wide, p.thicknessVox / 2];
    const mid = base ? (p.offset - 10) / 2 : p.offset - p.thicknessVox / 2; // the slab's middle plane offset
    const anchor = [c, c, c], s = mid - (anchor[0] * w[0] + anchor[1] * w[1] + anchor[2] * w[2]);
    vox.push(...box(anchor.map((v, k) => v + s * w[k]), u, [0, 1, 0], h));
    planes.push({ w, top: anchor.map((v, k) => v + (s + h[2]) * w[k]) }); // a point on the face toward the part
  }
  return { ...displaced(vox, scene.voxelMm, [c, c, c]), planes };
}

test('a plates STL fits the plates scene (no seeds: pre-alignment starts)', () => {
  const scene = S.makeHolderScene({ holder: 'plates' }), stl = platesStl(scene), r = fitScene(scene, stl);
  const y = [0, 1, 0]; // the plates run out of the FOV along y, so a shift along y is not observable
  for (const { w, top } of stl.planes) {
    const dw = angleDeg(mat(r.fit.pose.R, stl.cadDir(w)), mat(stl.truth.R, stl.cadDir(w)));
    assert.ok(dw <= 2, `plate normal ${w.map((v) => v.toFixed(2))} off by ${dw.toFixed(2)} deg`);
    const cad = stl.cadPoint(top), e = place(r.fit.pose, cad).map((v, k) => v - place(stl.truth, cad)[k]), along = e[1];
    const err = Math.hypot(...e.map((v, k) => v - along * y[k]));
    assert.ok(err <= 1, `plate face point off by ${err.toFixed(2)} voxels across y`);
  }
  assert.ok(r.fit.fits, `fit ${JSON.stringify({ ...r.fit, pose: undefined })}`);
  assertCoverage(r);
});

// The part does not pull the fit: STL samples pair to the scan, and the cap top hidden under the disk pairs with the
// disk's underside in the same plane (the review saw this pass with trimming off too; trimming only bounds outliers).
test('the part touching the holder does not pull the fit', () => {
  const scene = Scenes.diskOnPostScene(), n = scene.dims.nx, c = (n - 1) / 2;
  const zs = Math.round(0.15 * n) - 0.5, zb = Math.round(0.25 * n) - 0.5;
  const vox = lathe([[0, -10], [0.06 * n, -10], [0.06 * n, zs], [0.11 * n, zs], [0.11 * n, zb], [0, zb]], [c, c]);
  const r = fitScene(scene, displaced(vox, scene.voxelMm, [c, c, zb / 2]), { seeds: seedsOf(scene) });
  assert.ok(r.fit.fits, `fit ${JSON.stringify({ ...r.fit, pose: undefined })}`);
  assertCoverage(r);
});

test('a wrong STL reports a poor fit', () => {
  const plates = S.makeHolderScene({ holder: 'plates' }), stl = postStl(S.makeHolderScene({ holder: 'post' }));
  const r = fitScene(plates, stl, { seeds: seedsOf(plates) });
  assert.ok(r.fit.nearShare < HS.FIT_MIN_NEAR, `near share ${r.fit.nearShare} for a post on plates`);
  assert.equal(r.fit.fits, false);
});

test('an STL pose survives native round trip', () => {
  const R = rotation([1, 2, 3], 40).map((v) => v / 0.16), pose = { R, t: [11.5, -3.25, 40] };
  const piece = { ...HS.stlPiece({ name: 'post holder', hash: HS.stlHash(new Uint8Array([1, 2, 3])), pose }), id: 'h1', mask: new Uint8Array(8) };
  assert.equal(piece.kind, 'stl');
  const orient = { R: rotation([1, 0, 0], 20), center: [30, 31, 32], origin: [-12, -9, -20], dims: { nx: 40, ny: 50, nz: 60 } };
  const p = [3, -7, 12]; // a CAD point (mm)
  for (const o of [null, orient]) for (const g of [{ bin: 1, binFactor: 1 }, { bin: 2, binFactor: 1 }, { bin: 2, binFactor: 2 }, { bin: 1, binFactor: 4 }]) {
    const [native] = F.piecesToNative([piece], g, o);
    assert.equal(native.mask, undefined, 'the runtime mask is never saved');
    assert.deepEqual([native.id, native.kind, native.name, native.hash], ['h1', 'stl', 'post holder', piece.hash]);
    // The native pose maps a CAD point where the grid pose's voxel lands in native voxels (as a post's center would).
    const [asCenter] = F.piecesToNative([{ id: 'c', kind: 'post', center: place(pose, p), axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [1, 1, 1] }], g, o);
    const d = Math.hypot(...place(native.pose, p).map((v, k) => v - asCenter.center[k]));
    assert.ok(d < 1e-9, `g=${JSON.stringify(g)} leveled=${!!o}: ${d}`);
    const [back] = F.piecesFromNative([native], g, o);
    assert.ok(back.pose.R.every((v, k) => Math.abs(v - R[k]) < 1e-9) && back.pose.t.every((v, k) => Math.abs(v - pose.t[k]) < 1e-9), JSON.stringify(back.pose));
  }
});

test('stlHash is a stable content hash', () => {
  const a = HS.stlHash(new Uint8Array([1, 2, 3])), b = HS.stlHash(new Uint8Array([1, 2, 4]));
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, HS.stlHash(new Uint8Array([1, 2, 3]).buffer));
  assert.notEqual(a, b);
});

test('a pose that leaves most of the STL outside the scan is a poor fit, even on the surface', () => {
  const scene = S.makeHolderScene({ holder: 'plates' }), stl = platesStl(scene), { solid } = solidOf(scene);
  const at = (pose) => HS.scoreFit({ triangles: stl.tri, pose, solid, outside: scene.outside, dims: scene.dims, voxelMm: scene.voxelMm });
  const right = at(stl.truth);
  assert.ok(right.fits && right.inFieldShare >= HS.MIN_IN_FIELD, JSON.stringify(right));
  // Slid along y (the plates' own direction) until a sliver stays in the field: the few samples there lie on the plates.
  const sliver = at({ R: stl.truth.R, t: stl.truth.t.map((v, k) => v + (k === 1 ? 110 : 0)) });
  assert.ok(sliver.nearShare >= HS.FIT_MIN_NEAR, `the share alone would pass: ${JSON.stringify(sliver)}`);
  assert.ok(sliver.inField > 0 && sliver.inField < right.inField && sliver.inFieldShare < HS.MIN_IN_FIELD, JSON.stringify(sliver));
  assert.equal(sliver.fits, false);
});

test('a fit cache shares the scan surface across fits and gives the same fit', () => {
  const scene = S.makeHolderScene({ size: 64, holder: 'post' }), stl = postStl(scene), { solid } = solidOf(scene);
  const args = { triangles: stl.tri, solid, outside: scene.outside, dims: scene.dims, voxelMm: scene.voxelMm, seeds: seedsOf(scene) };
  const cache = {}, plain = HS.fitHolderStl(args), first = HS.fitHolderStl({ ...args, cache });
  const surface = cache.surface;
  assert.ok(surface && surface.faces && surface.points, 'the scan surface is kept');
  const second = HS.fitHolderStl({ ...args, seeds: args.seeds.slice(0, 1), cache });
  assert.equal(cache.surface, surface, 'and not found again');
  assert.deepEqual(first, plain, 'the cached fit is the fit');
  assert.deepEqual(second, HS.fitHolderStl({ ...args, seeds: args.seeds.slice(0, 1) }));
});
