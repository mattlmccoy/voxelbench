'use strict';
// The holder review (vb_holderreview.js): which piece a voxel shows, toggles, piece sizes, the status line, and the
// holder STL library (vb_holderlib.js) in the library folder's VoxelBench/holders/.
const test = require('node:test');
const assert = require('node:assert/strict');
const Rv = require('../app/vb_holderreview.js');
const Lib = require('../app/vb_holderlib.js');
const St = require('../app/vb_stl.js');
const HS = require('../app/vb_holderstl.js');
const { makeFakeDir } = require('./fake_dir.js');

const post = (id) => ({ id, kind: 'post', foundBy: 'shape', center: [20, 20, 10], axes: [0, 0, 1, 1, 0, 0, 0, 1, 0], half: [32, 18, 18], voxels: 900, mm3: 123.456 });
const plate = (id) => ({ id, kind: 'plate', foundBy: 'shape', center: [20, 20, 4], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], half: [50, 40, 4], voxels: 900, mm3: 50 });
const stl = { id: 'h1', kind: 'stl', foundBy: 'stl', name: 'post holder', hash: 'aa', pose: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, voxels: 50, mm3: 2 };

test('a loaded-grid voxel maps to the piece its worker-grid label names', () => {
  const labelsDims = { nx: 4, ny: 3, nz: 2 }, labels = new Uint8Array(24);
  labels[1 + 4 * (2 + 3 * 1)] = 2; // worker voxel (1, 2, 1)
  const h = { pieces: [post('h1'), plate('h2')], labels, labelsDims, labelsBin: 2 };
  assert.equal(Rv.labelAt(h, 2, 4, 2), 1, 'loaded (2, 4, 2) is worker (1, 2, 1)');
  assert.equal(Rv.labelAt(h, 3, 5, 3), 1, 'loaded (3, 5, 3) too');
  assert.equal(Rv.labelAt(h, 0, 0, 0), -1, 'no piece');
  assert.equal(Rv.labelAt(h, 9, 0, 0), -1, 'past the worker grid (an odd loaded size)');
  assert.equal(Rv.labelAt(null, 2, 4, 2), -1);
});

test('a toggle gives a piece back or takes it again, by id', () => {
  assert.deepEqual(Rv.toggleGiven([], 'h2'), ['h2']);
  assert.deepEqual(Rv.toggleGiven(['h1', 'h2'], 'h1'), ['h2']);
  const back = ['h3'];
  Rv.toggleGiven(back, 'h1');
  assert.deepEqual(back, ['h3'], 'the input is not changed');
});

test('a piece reads as its kind, size, extents and volume in mm', () => {
  assert.deepEqual(Rv.pieceSummary(post('h1'), 0.15), { kind: 'post', size: 'radius 2.7 mm', extents: '9.6 mm long', volume: '123.5 mm³' });
  assert.deepEqual(Rv.pieceSummary(plate('h2'), 0.1), { kind: 'plate', size: '0.8 mm thick', extents: '10.0 × 8.0 mm', volume: '50.0 mm³' });
  assert.deepEqual(Rv.pieceSummary(stl, 0.1), { kind: 'STL', size: 'post holder', extents: '', volume: '2.0 mm³' });
  assert.equal(Rv.readoutText(post('h2'), false, 0.15), ' | holder h2 (post, radius 2.7 mm)');
  assert.equal(Rv.readoutText(post('h2'), true, 0.15), ' | holder h2, given back to the part (post, radius 2.7 mm)');
  assert.equal(Rv.readoutText(stl, false, 0.1), ' | holder h1 (STL post holder)');
});

test('a piece found but not removed (it would take most of the part) is named in the status until the user removes it', () => {
  const kept = { ...post('h1'), removed: false, reason: 'would take most of the part' }, h = { method: 'shape', pieces: [kept, post('h2')], givenBack: ['h1'], given: false, warning: null, stls: [] };
  assert.equal(Rv.statusLine(h), 'Holder: 2 holder pieces, not reviewed; found by shape. Holder piece h1 was found but not removed: removing it would take most of the part. Click it to remove it.');
  const two = { ...h, pieces: [kept, { ...post('h2'), removed: false, reason: 'would take most of the part' }], givenBack: ['h1', 'h2'] };
  assert.match(Rv.statusLine(two), /Holder pieces h1, h2 were found but not removed: removing them would take most of the part\. Click one to remove it\.$/);
  assert.equal(Rv.statusLine({ ...h, givenBack: [] }), 'Holder: 2 holder pieces, not reviewed; found by shape.', 'removed by the user: no note');
});

test('the status line says what was checked, how, and passes warnings through', () => {
  const two = [post('h1'), post('h2')], s = { name: 'post holder', hash: 'aa' };
  assert.equal(Rv.statusLine({ method: 'none', pieces: [], givenBack: [], given: false, warning: null, stls: [] }), 'Holder: no holder found.');
  assert.equal(Rv.statusLine({ method: 'bright', pieces: two, givenBack: [], given: false, warning: null, stls: [] }), 'Holder: 2 holder pieces, not reviewed; found by bright resin.');
  assert.equal(Rv.statusLine({ method: 'shape', pieces: two, givenBack: ['h2'], given: true, warning: null, stls: [] }), 'Holder: 2 holder pieces, reviewed (1 given back); found by shape.');
  const failed = 'Found 300 holder pieces; at most 254 can be labeled.';
  assert.equal(Rv.statusLine({ method: 'none', pieces: [], givenBack: [], given: false, failed, warning: `Holder detection failed: ${failed}`, stls: [] }), `Holder: removal failed: ${failed}.`);
  const cut = 'Holder removal took 61 % of the solid. Check the pieces: part of the sample may have been taken as holder.';
  assert.equal(Rv.statusLine({ method: 'shape', pieces: two, givenBack: [], given: false, warning: cut, stls: [] }), `Holder: 2 holder pieces, not reviewed; found by shape. ${cut}`);
  assert.equal(Rv.statusLine({ method: 'shape', pieces: two, givenBack: [], given: false, warning: null, stls: [{ ...s, outcome: 'poor fit', nearShare: 0.314, inFieldShare: 0.5, fallback: 'shape' }] }),
    'Holder: 2 holder pieces, not reviewed; holder STL post holder did not fit; found by shape. Only 31 % of its surface in the field lies on the scan (50 % of it is in the field).');
  assert.equal(Rv.statusLine({ method: 'shape', pieces: two, givenBack: [], given: false, warning: null, keep: { pieces: two, givenBack: ['h2'], method: 'stl' }, stls: [{ ...s, outcome: 'missing' }] }),
    'Holder: 2 holder pieces, not reviewed; holder STL post holder not loaded; found by shape. The saved holder review is kept and applies when the STL loads.');
  assert.equal(Rv.statusLine({ method: 'none', pieces: [], givenBack: [], given: false, warning: null, stls: [{ ...s, outcome: 'missing' }] }), 'Holder: no holder found; holder STL post holder not loaded; nothing found by detection.');
  assert.equal(Rv.statusLine({ method: 'stl', pieces: [stl], givenBack: [], given: true, warning: null, stls: [{ ...s, outcome: 'reused' }] }), 'Holder: 1 holder piece, reviewed; holder STL post holder, fitted earlier.');
  assert.equal(Rv.holderMethod({ method: 'shape', pieces: two, stls: [{ ...s, outcome: 'unused' }] }), 'found by shape; holder STL post holder not used');
  assert.equal(Rv.holderMethod({ method: 'given', pieces: two, stls: [] }), 'found earlier');
});

// A closed box STL (12 triangles) of size s mm.
function boxStl(s) {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return St.writeStl(Float32Array.from(f.flatMap((t) => t.flatMap((k) => v[k]))));
}
const fileOf = (name, buf) => new File([buf], name);

test('a holder STL is added to the library\'s holders folder, listed and read back with its hash', async () => {
  const dir = makeFakeDir();
  assert.deepEqual(await Lib.listHolders(dir), [], 'no holders folder yet');
  const buf = boxStl(10);
  assert.equal(await Lib.addHolder(dir, fileOf('Post holder.STL', buf)), 'Post holder');
  assert.deepEqual(await Lib.listHolders(dir), ['Post holder']);
  const got = await Lib.readHolder(dir, 'Post holder');
  assert.equal(got.name, 'Post holder');
  assert.equal(got.hash, HS.stlHash(buf));
  assert.equal(got.triangles.length, 12 * 9, 'triangles in mm, 9 numbers each');
  assert.equal(await Lib.readHolder(dir, 'gone'), null, 'a holder not in the library');
  const listed = (await (await dir.getDirectoryHandle('VoxelBench')).getDirectoryHandle('holders')).values();
  assert.equal((await listed.next()).value.name, 'Post holder.STL', 'stored under VoxelBench/holders with its own file name');
});

test('adding refuses a file that is not an STL and a name already in the library', async () => {
  const dir = makeFakeDir();
  await assert.rejects(Lib.addHolder(dir, fileOf('notes.txt', boxStl(10))), /\.stl/);
  await assert.rejects(Lib.addHolder(dir, fileOf('broken.stl', new ArrayBuffer(10))), /Not an STL/);
  assert.deepEqual(await Lib.listHolders(dir), [], 'nothing written for a refused file');
  await Lib.addHolder(dir, fileOf('post.stl', boxStl(10)));
  await assert.rejects(Lib.addHolder(dir, fileOf('post.stl', boxStl(12))), /already/);
  assert.equal((await Lib.readHolder(dir, 'post')).hash, HS.stlHash(boxStl(10)), 'the first file stays');
});

test('the holder reads as reviewed when the mask was built from the saved review or the saved review is this build', () => {
  const h = { method: 'shape', given: false, pieces: [post('h1'), plate('h2')], givenBack: ['h2'], stls: [] };
  assert.equal(Rv.isReviewed(h, null), false, 'nothing saved');
  assert.equal(Rv.isReviewed({ ...h, given: true }, null), true, 'built from the saved review');
  const saved = Rv.holderRecord(h, ['h2'], '2026-11-07T12:00:00.000Z');
  assert.equal(Rv.isReviewed(h, saved), true, 'Accept saved exactly this build (the worker keeps the mask, no new model)');
  const reordered = { ...saved, pieces: saved.pieces.map((p) => Object.fromEntries(Object.entries(p).reverse())) };
  assert.equal(Rv.isReviewed(h, reordered), true, 'field order does not matter');
  assert.equal(Rv.isReviewed(h, { ...saved, given_back: [] }), false, 'another toggle');
  assert.equal(Rv.isReviewed(h, { stls: [{ name: 'post holder', hash: 'aa' }] }), false, 'an STL chosen, nothing reviewed');
  assert.equal(Rv.isReviewed({ ...h, keep: { pieces: saved.pieces, givenBack: ['h2'], method: 'shape' } }, saved), false, 'a kept review waiting for its STL is not this build');
  assert.equal(Rv.statusLine({ ...h, warning: null }, true), 'Holder: 2 holder pieces, reviewed (1 given back); found by shape.');
});

test('a holder STL changed since the review says it was refitted and the review cleared', () => {
  const s = { name: 'post holder', hash: 'bb', changedFrom: 'aa' };
  assert.equal(Rv.holderMethod({ method: 'stl', pieces: [stl], stls: [{ ...s, outcome: 'fitted', rmsMm: 0.1234 }] }),
    'holder STL post holder changed since the review; refitted, review cleared (RMS 0.12 mm)');
  assert.equal(Rv.holderMethod({ method: 'shape', pieces: [post('h1')], stls: [{ ...s, outcome: 'poor fit', fallback: 'shape' }] }),
    'holder STL post holder changed since the review; refitted, review cleared; it did not fit; found by shape');
  assert.equal(Rv.statusLine({ method: 'stl', pieces: [stl], givenBack: [], given: false, warning: null, stls: [{ ...s, outcome: 'fitted', rmsMm: 0.1 }] }),
    'Holder: 1 holder piece, not reviewed; holder STL post holder changed since the review; refitted, review cleared (RMS 0.10 mm).');
  assert.equal(Rv.holderMethod({ method: 'stl', pieces: [stl], stls: [{ ...s, changedFrom: null, outcome: 'fitted', rmsMm: 0.1 }] }), 'holder STL post holder fitted (RMS 0.10 mm)', 'a first fit is not a change');
});

test('the holder tag says a build is running, never the last result, and which stage failed', () => {
  const h = { method: 'shape', given: true, pieces: [post('h1')], givenBack: [], stls: [] };
  assert.equal(Rv.holderStatus(h, null, true), 'finding the holder…', 'a rebuild in flight hides the last build');
  assert.equal(Rv.holderStatus({ ...h, reviewed: true }, null, false), '1 holder piece, reviewed');
  assert.equal(Rv.holderStatus(null, null, true), 'finding the holder…', 'the first build');
  assert.equal(Rv.holderTag({ h, reviewed: true, error: null, building: true }), 'finding the holder…');
  assert.equal(Rv.holderTag({ h, reviewed: true, error: null, building: false }), '1 holder piece, reviewed');
  assert.equal(Rv.holderTag({ h, reviewed: true, error: { stage: 'holder', message: 'bad pose' }, building: false }), 'removal failed: bad pose');
  assert.equal(Rv.holderTag({ h, reviewed: true, error: { stage: null, message: 'out of memory' }, building: false }), 'Could not build the sample mask: out of memory', 'a failure outside holder removal is not a removal failure');
  assert.equal(Rv.holderTag({ h: { ...h, failed: 'too many' }, reviewed: false, error: null, building: false }), 'removal failed: too many');
  assert.equal(Rv.holderTag({ h: null, reviewed: false, error: null, building: false }), 'not run');
});
