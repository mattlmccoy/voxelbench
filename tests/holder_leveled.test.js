'use strict';
// Leveling a scan carries its scan-axes holder into the leveled frame (vb_orientrail.js, vb_holderreview.js
// carriedRecord): the leveled grid keeps only the part plus a margin, so only stubs of the holder are left there to
// find; the leveled build uses the carried pieces instead of finding them again. Same path as the page and worker:
// carriedRecord, holderMessage, prepareHolder (piecesFromNative with the saved orientation), removeHolder.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../app/ct_pores.js');
const S = require('../app/vb_synthetic.js');
const O = require('../app/vb_orient.js');
const F = require('../app/vb_holderframe.js');
const W = require('../app/vb_holderwire.js');
const Rv = require('../app/vb_holderreview.js');
const Rm = require('../app/vb_holderremoval.js');

const SCALE = { bin: 1, binFactor: 1 }; // the worker grid is the loaded grid, which is native
const turnX = (deg) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };

/** The scene, its scan-axes build with holder removal, and the scene leveled by R about its center (grid: the part plus
    marginVox), with the truth labels resampled the same way (0 outside, 1 air or other, 2 holder, 3 part). */
function leveledScene(R, marginVox = 4) {
  const s = S.makeHolderScene({ holder: 'post' }), { nx, ny, nz } = s.dims, cut = (s.truth.matrix_gray + s.truth.air_gray) / 2;
  const body = P.buildBody(s.gray, s.outside, s.dims, { ...P.DEFAULT_SETTINGS, sigma: 1, bodyThreshold: cut }, null, { pieces: null, givenBack: [], voxelMm: s.voxelMm });
  const c = (nx - 1) / 2, circle = { cx: c + 0.5, cy: c + 0.5, r: 0.47 * nx }, center = [c, c, c];
  const orient = { R, center, ...O.gridFor({ R, center }, s.truth.part, s.dims, 1, marginVox) };
  const plane = nx * ny, slicesOf = (v) => Array.from({ length: nz }, (_, z) => v.subarray(z * plane, (z + 1) * plane));
  const labels = new Uint16Array(s.gray.length).map((_, i) => 1 + (s.truth.holder[i] ? 1 : 0) + (s.truth.part[i] ? 2 : 0));
  const flat = (slices) => { const out = new Float32Array(slices.length * slices[0].length); slices.forEach((sl, k) => out.set(sl, k * sl.length)); return out; };
  const gray = flat(O.resample({ slices: slicesOf(s.gray), dims: s.dims, circle, orient }));
  const truth = flat(O.resample({ slices: slicesOf(labels), dims: s.dims, circle, orient }));
  const dims = { ...orient.dims }, outside = gray.map((v) => (v === 0 ? 1 : 0));
  const smoothed = P.gaussian(gray, dims, 1), solid = smoothed.map((v, i) => (v > cut && !outside[i] ? 1 : 0));
  return { s, body, orient, lev: { gray, outside, smoothed, solid, dims, truth } };
}

/** The leveled build's holder from a carried record, as the worker makes it. */
function leveledHolder({ lev, orient, s }, record) {
  const prep = W.prepareHolder({ holder: W.holderMessage(record, []), scale: SCALE, orient: O.toNative(orient, 1), dims: lev.dims, voxelMm: s.voxelMm });
  return { prep, ...Rm.removeHolder({ smoothed: lev.smoothed, solid: lev.solid, outside: lev.outside, dims: lev.dims, crop: null }, prep.input) };
}

test('a scene leveled by a known turn is built with the carried scan-axes holder: it covers the holder and leaves the part', () => {
  const scene = leveledScene(turnX(20)), { body, lev, orient } = scene;
  assert.equal(body.holder.method, 'shape');
  const page = { method: body.holder.method, given: false, pieces: F.piecesToNative(body.holder.pieces, SCALE, null), givenBack: body.holder.givenBack, stls: [] };
  const record = Rv.carriedRecord(page, null);
  const { prep, holder, info } = leveledHolder(scene, record);
  assert.equal(prep.given, false);
  assert.equal(prep.carried, true);
  let hold = 0, hit = 0, part = 0, leak = 0;
  for (let i = 0; i < holder.length; i++) {
    if (lev.truth[i] === 2 && lev.solid[i]) { hold++; hit += holder[i]; }
    if (lev.truth[i] === 3) { part++; leak += holder[i]; }
  }
  assert.ok(hold > 0, 'a holder stub is in the leveled grid');
  assert.ok(hit >= 0.95 * hold, `covers ${hit}/${hold} of the leveled holder`);
  assert.ok(leak <= 0.01 * part, `takes ${leak}/${part} of the part`);
  assert.equal(info.warning, null);
  // The worker reports the pieces back in native voxels: the record is unchanged by the round trip.
  const back = F.piecesToNative(info.pieces, SCALE, O.toNative(orient, 1));
  back.forEach((p, k) => p.center.forEach((v, j) => assert.ok(Math.abs(v - record.pieces[k].center[j]) < 1e-6)));
  // The page: not reviewed until Accept.
  const h = { ...page, pieces: back, carried: prep.carried, given: prep.given };
  assert.equal(Rv.isReviewed(h, record), false);
  assert.equal(Rv.isReviewed(h, Rv.holderRecord(h, h.givenBack)), true, 'Accept marks it reviewed');
});

test('a carried piece whose box lies outside the leveled grid takes nothing and stays in the record', () => {
  const scene = leveledScene(turnX(20)), { body } = scene, n = scene.s.dims.nx;
  const far = { id: 'h9', kind: 'plate', foundBy: 'shape', center: [n / 2, n / 2, 4 * n], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [4, 4, 2], voxels: 10, mm3: 0.1 };
  const pieces = [...F.piecesToNative(body.holder.pieces, SCALE, null), far];
  const record = Rv.carriedRecord({ method: 'shape', given: false, pieces, givenBack: body.holder.givenBack, stls: [] }, null);
  const { holder, info } = leveledHolder(scene, record);
  assert.equal(info.pieces.length, pieces.length, 'every carried piece is listed');
  const k = info.pieces.findIndex((p) => p.id === 'h9');
  assert.ok(!info.labels.some((l) => l === k + 1), 'labels nothing');
  const without = leveledHolder(scene, { ...record, pieces: pieces.slice(0, -1) }).holder;
  assert.ok(holder.every((v, i) => v === without[i]), 'cuts nothing');
  assert.equal(record.pieces.length, pieces.length);
});
