'use strict';
// Worker wiring of holder removal (vb_holderwire.js): the request the page sends, the monotone progress share, and how
// the worker turns a saved holder and a chosen STL into buildBody's holderInput.
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../app/vb_holderwire.js');
const F = require('../app/vb_holderframe.js');
const P = require('../app/ct_pores.js');
const S = require('../app/vb_synthetic.js');

const FIND = 'Finding the holder', FIT = 'Fitting the holder STL';
const post = (id, center) => ({ id, kind: 'post', foundBy: 'shape', center, axes: [0, 0, 1, 1, 0, 0, 0, 1, 0], half: [6, 3, 3], voxels: 100, mm3: 0.4 });
const pose = { R: [6.25, 0, 0, 0, 6.25, 0, 0, 0, 6.25], t: [10, 10, 2] };
const stlNative = (hash) => ({ id: 'h1', kind: 'stl', foundBy: 'stl', name: 'post holder', hash, pose, voxels: 50, mm3: 0.2 });
const triangles = new Float32Array(9);
const dims = { nx: 16, ny: 16, nz: 16 };
const frame = { scale: { bin: 2, binFactor: 1 }, orient: null, dims, voxelMm: 0.16 };

test('the progress share never goes back within one build', () => {
  const share = W.progressTracker({ [FIND]: [0, 0.7], [FIT]: [0.7, 1] });
  assert.equal(share(FIND, 0, 100), 0);
  assert.ok(Math.abs(share(FIND, 50, 100) - 0.35) < 1e-12);
  assert.equal(share(FIND, 10, 100), null, 'a restarted slice count does not move the bar back');
  assert.equal(share(FIND, 50, 100), null, 'nor repeats a share');
  assert.ok(Math.abs(share(FIND, 60, 100) - 0.42) < 1e-12, 'it moves again past the last share');
  assert.equal(share(FIT, 0, 0), 0.7, 'a stage without slices starts at its span');
  assert.equal(share(FIND, 100, 100), null, 'an earlier stage cannot pull it back');
  assert.equal(W.progressTracker({})(FIND, 3, 4), 0.75, 'an unknown stage spans the whole bar');
  const next = W.progressTracker({ [FIND]: [0, 0.7], [FIT]: [0.7, 1] });
  next(FIND, 100, 100);
  assert.equal(next(FIT, 0, 0), 0.7, 'a new stage starting where the last ended is still shown');
  assert.equal(next(FIT, 0, 0), null);
});

test('the request carries the saved record and the loaded STL', () => {
  assert.equal(W.holderMessage(null, []), null, 'nothing saved, nothing chosen: find');
  const record = { pieces: [post('h1', [1, 2, 3])], given_back: ['h1'], method: 'shape', reviewed_at: 'x', stls: [{ name: 'post holder', hash: 'aa' }] };
  assert.deepEqual(W.holderMessage(record, []), { pieces: record.pieces, givenBack: ['h1'], method: 'shape', stls: [{ name: 'post holder', hash: 'aa', triangles: null }] }, 'a chosen STL not loaded is sent without triangles');
  const loaded = { name: 'post holder', hash: 'aa', triangles };
  assert.deepEqual(W.holderMessage(record, [loaded]).stls, [loaded]);
  assert.deepEqual(W.holderMessage({ stls: [{ name: 'p', hash: 'b' }] }, []), { pieces: null, givenBack: [], method: null, stls: [{ name: 'p', hash: 'b', triangles: null }] }, 'an STL chosen before any pieces were saved: fit');
});

test('no saved holder: buildBody finds it', () => {
  const r = W.prepareHolder({ holder: null, ...frame });
  assert.equal(r.input.pieces, null);
  assert.equal(r.input.find, undefined, 'plain detection');
  assert.deepEqual(r.input.givenBack, []);
  assert.equal(r.input.voxelMm, 0.16);
  assert.equal(r.given, false);
  assert.deepEqual(r.reports, []);
});

test('saved pieces are mapped onto the grid and given, keeping the method that found them', () => {
  const grid = [post('h1', [5, 6, 7]), post('h2', [9, 6, 7])], native = F.piecesToNative(grid, frame.scale, null);
  const r = W.prepareHolder({ holder: { pieces: native, givenBack: ['h2'], method: 'bright', stls: [] }, ...frame });
  assert.equal(r.given, true);
  assert.equal(r.input.method, 'bright');
  assert.deepEqual(r.input.givenBack, ['h2']);
  r.input.pieces.forEach((p, k) => p.center.forEach((c, j) => assert.ok(Math.abs(c - grid[k].center[j]) < 1e-9)));
  assert.equal(W.prepareHolder({ holder: { pieces: native, givenBack: [], method: null, stls: [] }, ...frame }).input.method, 'given', 'given when the method is not known');
});

test('a saved STL piece with the same STL is rebuilt with its mask', () => {
  const calls = [];
  const modules = { stl: { voxelizeMesh: (a) => { calls.push(a); return new Uint8Array(16 * 16 * 16).fill(1); } } };
  const r = W.prepareHolder({ holder: { pieces: [stlNative('aa')], givenBack: [], method: 'stl', stls: [{ name: 'post holder', hash: 'aa', triangles }] }, ...frame, modules });
  assert.equal(r.given, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].triangles, triangles);
  assert.deepEqual(calls[0].dims, dims);
  assert.ok(r.input.pieces[0].mask instanceof Uint8Array, 'holderMask needs the runtime mask');
  assert.deepEqual(r.input.pieces[0].pose.t, F.piecesFromNative([stlNative('aa')], frame.scale, null)[0].pose.t, 'pose on the grid');
  assert.deepEqual(r.reports, [{ name: 'post holder', hash: 'aa', outcome: 'reused' }]);
});

test('a saved STL piece without its STL is found for this build only; the saved holder and its give-backs are kept', () => {
  const tape = { id: 'h2', kind: 'tape', foundBy: 'shape', center: [4, 5, 6], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [3, 2, 1], voxels: 9, mm3: 0.1 };
  const saved = { pieces: [stlNative('aa'), tape], givenBack: ['h2'], method: 'stl', stls: [{ name: 'post holder', hash: 'aa', triangles: null }] };
  const before = JSON.parse(JSON.stringify(saved));
  const r = W.prepareHolder({ holder: saved, ...frame });
  assert.equal(r.input.pieces, null, 'detection for this build');
  assert.equal(r.input.find, undefined);
  assert.deepEqual(r.input.givenBack, [], 'the saved ids name no detected piece');
  assert.deepEqual(r.keep, { pieces: before.pieces, givenBack: ['h2'], method: 'stl' }, 'the save-state is the saved holder, unchanged');
  assert.deepEqual(saved, before, 'the request is not mutated');
  assert.deepEqual(r.reports, [{ name: 'post holder', hash: 'aa', outcome: 'missing' }]);
  const chosen = W.prepareHolder({ holder: { pieces: null, givenBack: [], method: null, stls: [{ name: 'post holder', hash: 'aa', triangles: null }] }, ...frame });
  assert.equal(chosen.keep, null, 'nothing saved, nothing to keep');
  assert.equal(chosen.reports[0].outcome, 'missing');
});

test('only the not-loaded case keeps a saved holder apart from the build', () => {
  const native = F.piecesToNative([post('h1', [5, 6, 7])], frame.scale, null);
  assert.equal(W.prepareHolder({ holder: null, ...frame }).keep, null);
  assert.equal(W.prepareHolder({ holder: { pieces: native, givenBack: [], method: 'shape', stls: [] }, ...frame }).keep, null, 'given pieces are what is built');
});

test('a failed mask build outside segmentation is said in the status', () => {
  assert.equal(W.maskErrorText('model', 'idle', 'boom'), 'Could not build the sample mask: boom');
  assert.equal(W.maskErrorText('volume', 'done', 'out of memory'), 'Could not build the sample mask: out of memory');
  assert.equal(W.maskErrorText('model', 'running', 'boom'), null, 'segmentation reports its own failure');
  assert.equal(W.maskErrorText('detect', 'idle', 'boom'), null, 'not a mask-only request');
  assert.equal(W.maskErrorText('wall', 'idle', 'boom'), null);
});

const found = { method: 'shape', pieces: [post('h1', [5, 6, 7])] };
const ctx = { smoothed: new Float32Array(4096), solid: new Uint8Array(4096).fill(1), outside: new Uint8Array(4096), dims, voxelMm: 0.32 };

test('a poor STL fit falls back to the detected pieces and reports the scores, even with a pose', () => {
  const modules = { holder: { findHolder: () => found }, stl: { fitHolderStl: () => ({ pose, rmsMm: 0.9, nearShare: 0.31, inField: 400, inFieldShare: 0.5, fits: false }) } };
  const progress = [];
  const r = W.prepareHolder({ holder: { pieces: [stlNative('old')], givenBack: ['h1'], method: 'stl', stls: [{ name: 'post holder', hash: 'aa', triangles }] }, ...frame, modules, onProgress: (...a) => progress.push(a) });
  assert.equal(r.input.pieces, null);
  assert.deepEqual(r.input.givenBack, []);
  assert.equal(typeof r.input.find, 'function');
  assert.equal(r.input.find({ ...ctx, onProgress: r.input.onProgress }), found);
  assert.deepEqual(r.reports, [{ name: 'post holder', hash: 'aa', outcome: 'poor fit', changedFrom: 'old', rmsMm: 0.9, nearShare: 0.31, inFieldShare: 0.5, fallback: 'shape' }]);
  assert.deepEqual(progress.at(-1), [FIT, 0, 1], 'the fit has its own stage: STL 1 of 1');
});

test('a good STL fit is the holder, with its runtime mask and the first STL id', () => {
  let seeds = null;
  const modules = { holder: { findHolder: () => found }, stl: { fitHolderStl: (a) => { seeds = a.seeds; return { pose, rmsMm: 0.12, nearShare: 0.8, inField: 900, inFieldShare: 0.6, fits: true }; }, voxelizeMesh: () => new Uint8Array(4096).fill(1) } };
  const r = W.prepareHolder({ holder: { pieces: null, givenBack: [], method: null, stls: [{ name: 'post holder', hash: 'aa', triangles }] }, ...frame, modules });
  const out = r.input.find(ctx);
  assert.deepEqual(seeds, found.pieces, 'detection seeds the fit');
  assert.equal(out.method, 'stl');
  assert.equal(out.pieces.length, 1);
  assert.deepEqual([out.pieces[0].id, out.pieces[0].kind, out.pieces[0].hash], ['stl1', 'stl', 'aa']);
  assert.ok(out.pieces[0].mask instanceof Uint8Array);
  assert.equal(out.pieces[0].voxels, 4096);
  assert.deepEqual(r.reports, [{ name: 'post holder', hash: 'aa', outcome: 'fitted', changedFrom: null, rmsMm: 0.12, nearShare: 0.8, inFieldShare: 0.6 }]);
});

test('buildBody uses the find given in holderInput (the STL path), then adds tape', () => {
  const s = S.makeHolderScene({ size: 64, holder: 'post', holderGray: 'bright' });
  const settings = { ...P.DEFAULT_SETTINGS, sigma: 1, bodyThreshold: (s.truth.matrix_gray + s.truth.air_gray) / 2 };
  let asked = null;
  const find = (a) => { asked = a; return { method: 'stl', pieces: [] }; };
  const body = P.buildBody(s.gray, s.outside, s.dims, settings, null, { pieces: null, givenBack: [], voxelMm: s.voxelMm, find });
  assert.ok(asked && asked.solid && asked.smoothed && asked.outside && asked.dims, 'find gets the detection inputs');
  assert.equal(body.holder.method, 'stl');
});

// Several STLs per holder: a holder made of separately printed parts, each part its own STL, fitted on its own.
const H = require('../app/vb_holder.js');
const Rv = require('../app/vb_holderreview.js');
const Scenes = require('./holder_scenes.js');

test('an older single holder.stl reads as a list of one', () => {
  const old = { pieces: [stlNative('aa')], given_back: ['h1'], method: 'stl', reviewed_at: 'x', stl: { name: 'post holder', hash: 'aa' } };
  assert.deepEqual(W.savedStls(old), [{ name: 'post holder', hash: 'aa' }]);
  assert.deepEqual(W.savedStls({ stls: [{ name: 'base', hash: '1' }, { name: 'top', hash: '2' }] }), [{ name: 'base', hash: '1' }, { name: 'top', hash: '2' }]);
  assert.deepEqual(W.savedStls(null), []);
  assert.deepEqual(W.savedStls({ pieces: [], given_back: [], method: 'shape' }), []);
  const loaded = { name: 'post holder', hash: 'aa', triangles };
  assert.deepEqual(W.holderMessage(old, []).stls, [{ name: 'post holder', hash: 'aa', triangles: null }]);
  const r = W.prepareHolder({ holder: W.holderMessage(old, [loaded]), ...frame, modules: { stl: { voxelizeMesh: () => new Uint8Array(4096) } } });
  assert.equal(r.given, true, 'the saved review stands');
  assert.deepEqual(r.input.givenBack, ['h1'], 'with its give-backs');
  assert.deepEqual(r.reports, [{ name: 'post holder', hash: 'aa', outcome: 'reused' }]);
  const h = { method: 'stl', given: true, pieces: [stlNative('aa')], givenBack: ['h1'], stls: r.reports, keep: null };
  assert.equal(Rv.isReviewed(h, old), true);
  assert.deepEqual(Rv.holderRecord(h, ['h1'], 'at').stls, [{ name: 'post holder', hash: 'aa' }], 'saved again as a list');
});

/** The stepped post of makeHolderScene as two printed parts in a CAD frame off the scan: the stem (running 10 voxels
    past slice 0, up to the cap) and the cap. */
function postParts(scene) {
  const n = scene.dims.nx, c = (n - 1) / 2, [cap, stem] = scene.truth.pieces, zs = cap.zFrom - 0.5, zt = cap.zTo + 0.5;
  const part = (profile) => Scenes.displaced(Scenes.lathe(profile, [c, c]), scene.voxelMm, [c, c, zt / 2]).tri;
  return { cap: part([[0, zs], [cap.radiusVox, zs], [cap.radiusVox, zt], [0, zt]]), stem: part([[0, -10], [stem.radiusVox, -10], [stem.radiusVox, zs], [0, zs]]) };
}
/** What removeHolder passes to find: the solid as the mask build makes it (sigma 1, midpoint of part and air). */
function sceneCtx(scene, onProgress) {
  const smoothed = P.gaussian(scene.gray, scene.dims, 1), cut = (scene.truth.matrix_gray + scene.truth.air_gray) / 2, solid = new Uint8Array(smoothed.length);
  for (let i = 0; i < solid.length; i++) solid[i] = smoothed[i] > cut && !scene.outside[i] ? 1 : 0;
  return { smoothed, solid, outside: scene.outside, dims: scene.dims, voxelMm: scene.voxelMm, onProgress };
}
function assertCovers(scene, solid, pieces) {
  const { holder } = H.holderMask({ solid, dims: scene.dims, pieces });
  let hit = 0, total = 0, leak = 0, part = 0;
  for (let i = 0; i < holder.length; i++) {
    if (scene.truth.holder[i]) { total++; hit += holder[i]; }
    if (scene.truth.part[i]) { part++; leak += holder[i]; }
  }
  assert.ok(hit >= 0.95 * total, `covers ${hit}/${total}`);
  assert.ok(leak <= 0.01 * part, `takes ${leak}/${part} of the part`);
}
const fullFrame = (scene) => ({ scale: { bin: 1, binFactor: 1 }, orient: null, dims: scene.dims, voxelMm: scene.voxelMm });

test('two STLs give two stl pieces with unique ids', () => {
  const scene = S.makeHolderScene({ holder: 'post' }), parts = postParts(scene), progress = [];
  // The stem first: fitted against every detected piece it does not fit, so it is tried from each piece alone.
  const stls = [{ name: 'stem', hash: 's1', triangles: parts.stem }, { name: 'cap', hash: 'c1', triangles: parts.cap }];
  const r = W.prepareHolder({ holder: { pieces: null, givenBack: [], method: null, stls }, ...fullFrame(scene) });
  const ctx = sceneCtx(scene, (...a) => progress.push(a)), out = r.input.find(ctx);
  assert.equal(out.method, 'stl');
  assert.deepEqual(out.pieces.map((p) => [p.id, p.kind, p.name]), [['stl1', 'stl', 'stem'], ['stl2', 'stl', 'cap']], 'the detected pieces both cover are dropped');
  assert.deepEqual(r.reports.map((x) => [x.name, x.outcome]), [['stem', 'fitted'], ['cap', 'fitted']]);
  assert.deepEqual(progress.filter((a) => a[0] === FIT), [[FIT, 0, 2], [FIT, 1, 2]]);
  assert.equal(W.progressText(FIT, 1, 2), 'Fitting the holder STL 2 / 2');
  assertCovers(scene, ctx.solid, out.pieces);
});

test('one STL fits and one does not', () => {
  const scene = S.makeHolderScene({ holder: 'post' }), parts = postParts(scene);
  const wrong = Float32Array.from(Scenes.box([3, 3, 3], [1, 0, 0], [0, 1, 0], [3, 3, 3])); // a 6 mm box (mm)
  const stls = [{ name: 'cap', hash: 'c1', triangles: parts.cap }, { name: 'wrong box', hash: 'w1', triangles: wrong }];
  const r = W.prepareHolder({ holder: { pieces: null, givenBack: [], method: null, stls }, ...fullFrame(scene) });
  const ctx = sceneCtx(scene), out = r.input.find(ctx);
  assert.deepEqual(out.pieces.filter((p) => p.kind === 'stl').map((p) => [p.id, p.name]), [['stl1', 'cap']], 'one STL piece');
  const rest = out.pieces.filter((p) => p.kind !== 'stl');
  assert.equal(rest.length, 1, 'detection keeps the stem the cap does not cover');
  assert.equal(new Set(out.pieces.map((p) => p.id)).size, out.pieces.length, 'ids unique');
  assert.deepEqual(r.reports.map((x) => [x.name, x.outcome, x.fallback]), [['cap', 'fitted', undefined], ['wrong box', 'poor fit', 'shape']]);
  const lines = Rv.methodLines({ method: out.method, pieces: out.pieces, stls: r.reports });
  assert.equal(lines.length, 2, 'one line per STL');
  assert.match(lines[0], /^holder STL cap fitted \(RMS 0\.\d\d mm\)$/);
  assert.equal(lines[1], 'holder STL wrong box did not fit; found by shape');
  assertCovers(scene, ctx.solid, out.pieces);
});

test('the keep rule holds when one of two saved STLs is not loaded', () => {
  const base = { ...stlNative('aa'), id: 'stl1', name: 'base' }, top = { ...stlNative('bb'), id: 'stl2', name: 'top' };
  const holder = { pieces: [base, top], givenBack: ['stl2'], method: 'stl', stls: [{ name: 'base', hash: 'aa', triangles }, { name: 'top', hash: 'bb', triangles: null }] };
  const modules = { holder: { findHolder: () => found }, stl: { voxelizeMesh: () => new Uint8Array(4096).fill(1), fitHolderStl: () => assert.fail('a loaded STL with its saved piece is not fitted again') } };
  const r = W.prepareHolder({ holder, ...frame, modules });
  assert.equal(r.given, false, 'not the saved review: one of its STLs is missing');
  assert.deepEqual(r.keep, { pieces: [base, top], givenBack: ['stl2'], method: 'stl' }, 'the saved holder stays saved');
  const out = r.input.find(ctx);
  assert.deepEqual(out.pieces.map((p) => p.id), ['stl1'], 'the loaded STL at its saved pose; the detected piece it covers dropped');
  assert.deepEqual(r.reports.map((x) => [x.name, x.outcome]), [['base', 'reused'], ['top', 'missing']]);
  const h = { method: out.method, given: false, pieces: out.pieces, givenBack: [], stls: r.reports, keep: r.keep, warning: null };
  assert.deepEqual(Rv.methodLines(h), ['holder STL base, fitted earlier', 'holder STL top not loaded; found by shape']);
  assert.match(Rv.reviewBlock(h), /top is not loaded; the saved review is kept/);
  assert.equal(Rv.holderRecord(h, []), null, 'no pieces are saved over the kept review');
  const none = W.prepareHolder({ holder: { ...holder, stls: holder.stls.map((s) => ({ ...s, triangles: null })) }, ...frame, modules });
  assert.equal(none.input.find, undefined, 'neither loaded: plain detection');
  assert.deepEqual(none.keep, r.keep);
});

test('holderKey changes when an STL is added, removed or reordered', () => {
  const a = { name: 'base', hash: 'aa', triangles }, b = { name: 'top', hash: 'bb', triangles };
  const key = (stls) => W.holderKey({ pieces: null, givenBack: [], method: null, stls });
  assert.notEqual(key([a, b]), key([a]), 'added');
  assert.notEqual(key([a, b]), key([b]), 'removed');
  assert.notEqual(key([a, b]), key([b, a]), 'reordered');
  assert.notEqual(key([a, b]), key([a, { ...b, triangles: null }]), 'one arriving');
  assert.equal(key([a, b]), key([{ ...a }, { ...b }]), 'the same choice');
});
