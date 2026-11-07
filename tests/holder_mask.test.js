'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../app/ct_pores.js');
const S = require('../app/vb_synthetic.js');
const Scenes = require('./holder_scenes.js');

const sum = (a) => a.reduce((t, v) => t + v, 0);
const overlap = (a, b) => { let c = 0; for (let i = 0; i < a.length; i++) if (a[i] && b[i]) c++; return c; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const midCut = (t) => (t.matrix_gray + t.air_gray) / 2;
const settingsFor = (s, sigma = 1) => ({ ...P.DEFAULT_SETTINGS, sigma, bodyThreshold: midCut(s.truth) });
const build = (s, input, { crop = null, sigma } = {}) =>
  P.buildBody(s.gray, s.outside, s.dims, settingsFor(s, sigma), crop, { pieces: null, givenBack: [], voxelMm: s.voxelMm, ...input });

test('the sample mask leaves the holder out', () => {
  const s = S.makeHolderScene({ holder: 'post', holderGray: 'bright' });
  const body = build(s);
  assert.equal(body.holder.method, 'bright');
  assert.ok(overlap(body.filled, s.truth.holder) <= 0.01 * sum(s.truth.holder), `holder voxels kept ${overlap(body.filled, s.truth.holder)}`);
  assert.ok(overlap(body.filled, s.truth.part) >= 0.98 * sum(s.truth.part), 'part kept');
  assert.ok(body.holder.removedVoxels > 0);
  assert.equal(body.holder.warning, null);
});

test('tape is stripped and the air under it is not counted', () => {
  // Light smoothing (sigma 0.5) keeps the one-voxel shell above the threshold and thin.
  const tape = S.makeHolderScene({ holder: 'post', holderGray: 'bright', tape: true }), bare = S.makeHolderScene({ holder: 'post', holderGray: 'bright' });
  const withTape = build(tape, {}, { sigma: 0.5 }), without = build(bare, {}, { sigma: 0.5 });
  assert.ok(withTape.holder.pieces.some((p) => p.kind === 'tape'), withTape.holder.pieces.map((p) => p.kind).join());
  assert.ok(sum(withTape.filled) <= 1.01 * sum(without.filled), `${sum(withTape.filled)} vs ${sum(without.filled)}`);
});

test('a crop through the post does not stop removal', () => {
  const s = S.makeHolderScene({ holder: 'post', holderGray: 'bright' }), { nx, ny, nz } = s.dims, crop = new Uint8Array(s.gray.length);
  for (let i = 0; i < crop.length; i++) crop[i] = Math.floor(i / (nx * ny)) >= 0.4 * nz ? 1 : 0;
  const body = build(s, {}, { crop });
  assert.ok(body.holder.pieces.some((p) => p.kind === 'post'));
  assert.ok(overlap(body.filled, s.truth.holder) <= 0.01 * sum(s.truth.holder));
  assert.ok(overlap(body.filled, crop) === sum(body.filled), 'nothing outside the crop');
});

test('a piece given back returns to the part', () => {
  const s = S.makeHolderScene({ holder: 'post', holderGray: 'bright' }), { nx, ny } = s.dims;
  const first = build(s), ids = first.holder.pieces.filter((p) => p.kind === 'post').map((p) => p.id);
  const back = build(s, { pieces: first.holder.pieces, givenBack: ids });
  let touching = 0, kept = 0;
  const plane = nx * ny;
  for (let i = plane; i < s.truth.holder.length - plane; i++) {
    if (!s.truth.holder[i]) continue;
    const near = [i - 1, i + 1, i - nx, i + nx, i - plane, i + plane].some((j) => s.truth.part[j]);
    if (near) { touching++; if (back.filled[i]) kept++; }
  }
  assert.ok(touching > 0 && kept >= 0.95 * touching, `${kept}/${touching} post voxels at the part came back`);
  assert.ok(sum(back.filled) > sum(first.filled));
});

test('given pieces are used, not found again', () => {
  const s = S.makeHolderScene({ holder: 'post', holderGray: 'bright', tape: true });
  const first = build(s, {}, { sigma: 0.5 });
  const calls = [];
  const again = build(s, { pieces: first.holder.pieces, modules: { holder: { findHolder: () => { calls.push(1); throw new Error('no'); } } } }, { sigma: 0.5 });
  assert.equal(calls.length, 0);
  assert.ok(same(again.filled, first.filled));
});

test('removal that takes most of the solid warns when a piece accepted via extension or support was removed', () => {
  const s = S.makeHolderScene({ holder: 'post', holderGray: 'bright' }), { nx } = s.dims, c = (nx - 1) / 2;
  const all = { id: 'h1', kind: 'plate', foundBy: 'shape', center: [c, c, c], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [nx, nx, nx], voxels: 0, mm3: 0 };
  for (const via of ['extension', 'support']) {
    const body = build(s, { pieces: [{ ...all, via }] });
    assert.match(body.holder.warning, /part of the sample may have been taken as holder/, via);
    assert.equal(body.holder.note, null);
    assert.ok(body.holder.removedVoxels > 0);
  }
});

test('removal that takes most of the solid by pieces that reached the edge themselves is a note, not a warning', () => {
  const s = S.makeHolderScene({ holder: 'post', holderGray: 'bright' }), { nx } = s.dims, c = (nx - 1) / 2;
  const all = { id: 'h1', kind: 'plate', foundBy: 'shape', center: [c, c, c], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [nx, nx, nx], voxels: 0, mm3: 0 };
  const body = build(s, { pieces: [all] });
  assert.equal(body.holder.warning, null);
  assert.match(body.holder.note, /^The holder is 100 % of the solid\.$/);
  // An ambiguous piece given back is not removed: still a note.
  const back = build(s, { pieces: [all, { ...all, id: 'h2', via: 'extension', half: [2, 2, 2] }], givenBack: ['h2'] });
  assert.equal(back.holder.warning, null);
});

test('a correct removal of plates larger than the part shows the holder share as a note, no warning', () => {
  for (const seed of [1, 2]) {
    const s = S.makeHolderScene({ holder: 'plates', seed }), body = build(s), h = body.holder;
    assert.ok(overlap(body.filled, s.truth.part) >= 0.98 * sum(s.truth.part), 'part kept');
    assert.equal(h.warning, null, `seed ${seed}`);
    assert.match(h.note, /^The holder is \d+ % of the solid\.$/, `seed ${seed}`);
    assert.doesNotMatch(require('../app/vb_holderreview.js').statusLine({ ...h, given: false, stls: [] }), /may have been taken/);
  }
});

test('a coupon standing on a base slab stays in the mask as a proposal, given back and named in the status', () => {
  const s = Scenes.couponOnSlabScene(), body = build(s, {}), h = body.holder, proposed = h.pieces.filter((p) => p.removed === false);
  assert.equal(proposed.length, 1, h.pieces.map((p) => `${p.id} ${p.kind} ${p.removed}`).join());
  assert.deepEqual(h.givenBack, [proposed[0].id]);
  // Against the mask built without removal (the mask's own edges), outside the coupon's one-voxel contact with the slab.
  const plain = P.buildBody(s.gray, s.outside, s.dims, settingsFor(s), null), { nx, ny } = s.dims, t = s.truth;
  const away = t.part.map((v, i) => (v && ![1, -1, nx, -nx, nx * ny, -nx * ny].some((d) => t.holder[i + d]) ? 1 : 0));
  assert.ok(overlap(body.filled, away) >= 0.99 * overlap(plain.filled, away), `the coupon is in the mask: ${overlap(body.filled, away)} vs ${overlap(plain.filled, away)} without removal`);
  assert.match(require('../app/vb_holderreview.js').statusLine({ ...h, given: false, stls: [] }), new RegExp(`Holder piece ${proposed[0].id} was found but not removed`));
});

test('a round part cut into tiers by shape detection is kept or warns', () => {
  const s = Scenes.twoTierRoundScene(), body = build(s, {}), kept = overlap(body.filled, s.truth.part), total = sum(s.truth.part);
  const what = `${body.holder.method}: ${body.holder.pieces.map((p) => p.kind).join()}, kept ${kept}/${total}`;
  assert.ok(kept >= 0.95 * total || /may have been taken/.test(body.holder.warning), what);
  console.log(`two-tier part: ${kept >= 0.95 * total ? 'kept' : 'cut, with the warning'} (${what})`);
});

test('a failure in holder detection leaves the mask unremoved and says so', () => {
  const s = S.makeHolderScene({ holder: 'post', holderGray: 'bright' });
  const plain = P.buildBody(s.gray, s.outside, s.dims, settingsFor(s), null);
  const body = build(s, { modules: { holder: { findHolder: () => { throw new Error('too many pieces'); } } } });
  assert.ok(same(body.filled, plain.filled));
  assert.equal(body.holder.method, 'none');
  assert.deepEqual(body.holder.pieces, []);
  assert.match(body.holder.warning, /^Holder detection failed: too many pieces$/);
  assert.equal(body.holder.failed, 'too many pieces', 'the reason, so the status reads "removal failed", never "no holder found"');
});

test('without holder input the result has no holder field', () => {
  const s = S.makeHolderScene({ holder: 'post' });
  assert.equal(P.buildBody(s.gray, s.outside, s.dims, settingsFor(s), null).holder, undefined);
});

test('every voxel removal cuts carries the label of a piece it was cut for, contact band included', () => {
  const Rm = require('../app/vb_holderremoval.js');
  const n = 20, dims = { nx: n, ny: n, nz: n }, solid = new Uint8Array(n ** 3);
  for (let z = 2; z < 18; z++) for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) solid[x + n * (y + n * z)] = 1;
  // A slab piece under the solid's lower half; the part above it is cut one voxel deeper (the contact rule).
  const plate = { id: 'h1', kind: 'plate', foundBy: 'shape', center: [9.5, 9.5, 5], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [8, 8, 3], voxels: 0, mm3: 0 };
  const post = { id: 'h2', kind: 'post', foundBy: 'shape', center: [9.5, 9.5, 14], axes: [0, 0, 1, 1, 0, 0, 0, 1, 0], half: [2, 2, 2], voxels: 0, mm3: 0 };
  const { holder, info } = Rm.removeHolder({ smoothed: null, solid, outside: new Uint8Array(n ** 3), dims, crop: null }, { pieces: [plate, post], givenBack: ['h2'], voxelMm: 0.1 });
  let removed = 0, unlabeled = 0, wrong = 0;
  for (let i = 0; i < holder.length; i++) {
    if (!holder[i]) continue;
    removed++;
    if (!info.labels[i]) unlabeled++;
    else if (info.labels[i] !== 1) wrong++;
  }
  assert.ok(removed > 0);
  assert.equal(unlabeled, 0, 'the contact band shows as the piece it was cut for');
  assert.equal(wrong, 0, 'never labeled as a piece given back');
});
