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
  assert.equal(W.holderMessage(null, null), null, 'nothing saved, nothing chosen: find');
  const record = { pieces: [post('h1', [1, 2, 3])], given_back: ['h1'], method: 'shape', reviewed_at: 'x', stl: { name: 'post holder', hash: 'aa' } };
  assert.deepEqual(W.holderMessage(record, null), { pieces: record.pieces, givenBack: ['h1'], method: 'shape', stl: { name: 'post holder', hash: 'aa', triangles: null } }, 'a chosen STL not loaded is sent without triangles');
  const loaded = { name: 'post holder', hash: 'aa', triangles };
  assert.equal(W.holderMessage(record, loaded).stl, loaded);
  assert.deepEqual(W.holderMessage({ stl: { name: 'p', hash: 'b' } }, null), { pieces: null, givenBack: [], method: null, stl: { name: 'p', hash: 'b', triangles: null } }, 'an STL chosen before any pieces were saved: fit');
});

test('no saved holder: buildBody finds it', () => {
  const r = W.prepareHolder({ holder: null, ...frame });
  assert.equal(r.input.pieces, null);
  assert.equal(r.input.find, undefined, 'plain detection');
  assert.deepEqual(r.input.givenBack, []);
  assert.equal(r.input.voxelMm, 0.16);
  assert.equal(r.given, false);
  assert.equal(r.report, null);
});

test('saved pieces are mapped onto the grid and given, keeping the method that found them', () => {
  const grid = [post('h1', [5, 6, 7]), post('h2', [9, 6, 7])], native = F.piecesToNative(grid, frame.scale, null);
  const r = W.prepareHolder({ holder: { pieces: native, givenBack: ['h2'], method: 'bright', stl: null }, ...frame });
  assert.equal(r.given, true);
  assert.equal(r.input.method, 'bright');
  assert.deepEqual(r.input.givenBack, ['h2']);
  r.input.pieces.forEach((p, k) => p.center.forEach((c, j) => assert.ok(Math.abs(c - grid[k].center[j]) < 1e-9)));
  assert.equal(W.prepareHolder({ holder: { pieces: native, givenBack: [], method: null, stl: null }, ...frame }).input.method, 'given', 'given when the method is not known');
});

test('a saved STL piece with the same STL is rebuilt with its mask', () => {
  const calls = [];
  const modules = { stl: { voxelizeMesh: (a) => { calls.push(a); return new Uint8Array(16 * 16 * 16).fill(1); } } };
  const r = W.prepareHolder({ holder: { pieces: [stlNative('aa')], givenBack: [], method: 'stl', stl: { name: 'post holder', hash: 'aa', triangles } }, ...frame, modules });
  assert.equal(r.given, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].triangles, triangles);
  assert.deepEqual(calls[0].dims, dims);
  assert.ok(r.input.pieces[0].mask instanceof Uint8Array, 'holderMask needs the runtime mask');
  assert.deepEqual(r.input.pieces[0].pose.t, F.piecesFromNative([stlNative('aa')], frame.scale, null)[0].pose.t, 'pose on the grid');
  assert.deepEqual(r.report, { name: 'post holder', hash: 'aa', outcome: 'reused' });
});

test('a saved STL piece without its STL is found for this build only; the saved holder and its give-backs are kept', () => {
  const tape = { id: 'h2', kind: 'tape', foundBy: 'shape', center: [4, 5, 6], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [3, 2, 1], voxels: 9, mm3: 0.1 };
  const saved = { pieces: [stlNative('aa'), tape], givenBack: ['h2'], method: 'stl', stl: null };
  const before = JSON.parse(JSON.stringify(saved));
  const r = W.prepareHolder({ holder: saved, ...frame });
  assert.equal(r.input.pieces, null, 'detection for this build');
  assert.equal(r.input.find, undefined);
  assert.deepEqual(r.input.givenBack, [], 'the saved ids name no detected piece');
  assert.deepEqual(r.keep, { pieces: before.pieces, givenBack: ['h2'], method: 'stl' }, 'the save-state is the saved holder, unchanged');
  assert.deepEqual(saved, before, 'the request is not mutated');
  assert.deepEqual(r.report, { name: 'post holder', hash: 'aa', outcome: 'missing' });
  const chosen = W.prepareHolder({ holder: { pieces: null, givenBack: [], method: null, stl: { name: 'post holder', hash: 'aa', triangles: null } }, ...frame });
  assert.equal(chosen.keep, null, 'nothing saved, nothing to keep');
  assert.equal(chosen.report.outcome, 'missing');
});

test('only the not-loaded case keeps a saved holder apart from the build', () => {
  const native = F.piecesToNative([post('h1', [5, 6, 7])], frame.scale, null);
  assert.equal(W.prepareHolder({ holder: null, ...frame }).keep, null);
  assert.equal(W.prepareHolder({ holder: { pieces: native, givenBack: [], method: 'shape', stl: null }, ...frame }).keep, null, 'given pieces are what is built');
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
  const r = W.prepareHolder({ holder: { pieces: [stlNative('old')], givenBack: ['h1'], method: 'stl', stl: { name: 'post holder', hash: 'aa', triangles } }, ...frame, modules, onProgress: (...a) => progress.push(a) });
  assert.equal(r.input.pieces, null);
  assert.deepEqual(r.input.givenBack, []);
  assert.equal(typeof r.input.find, 'function');
  assert.equal(r.input.find({ ...ctx, onProgress: r.input.onProgress }), found);
  assert.deepEqual(r.report, { name: 'post holder', hash: 'aa', outcome: 'poor fit', changedFrom: 'old', rmsMm: 0.9, nearShare: 0.31, inFieldShare: 0.5, fallback: 'shape' });
  assert.deepEqual(progress.at(-1), [FIT, 0, 0], 'the fit has its own stage');
});

test('a good STL fit is the holder, with its runtime mask and the first id', () => {
  let seeds = null;
  const modules = { holder: { findHolder: () => found }, stl: { fitHolderStl: (a) => { seeds = a.seeds; return { pose, rmsMm: 0.12, nearShare: 0.8, inField: 900, inFieldShare: 0.6, fits: true }; }, voxelizeMesh: () => new Uint8Array(4096).fill(1) } };
  const r = W.prepareHolder({ holder: { pieces: null, givenBack: [], method: null, stl: { name: 'post holder', hash: 'aa', triangles } }, ...frame, modules });
  const out = r.input.find(ctx);
  assert.equal(seeds, found.pieces, 'detection seeds the fit');
  assert.equal(out.method, 'stl');
  assert.equal(out.pieces.length, 1);
  assert.deepEqual([out.pieces[0].id, out.pieces[0].kind, out.pieces[0].hash], ['h1', 'stl', 'aa']);
  assert.ok(out.pieces[0].mask instanceof Uint8Array);
  assert.equal(out.pieces[0].voxels, 4096);
  assert.deepEqual(r.report, { name: 'post holder', hash: 'aa', outcome: 'fitted', changedFrom: null, rmsMm: 0.12, nearShare: 0.8, inFieldShare: 0.6 });
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
