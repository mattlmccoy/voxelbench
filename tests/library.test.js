'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../app/vb_library.js');

const slice = (n, seed) => Uint16Array.from({ length: n }, (_, i) => (i * 7 + seed) % 65536);

test('scan id: the same volume from VOX and TIFF has one id', async () => {
  // Both readers hand back Uint16Array slices of the same voxels; the id may not depend on which reader made them.
  const first = slice(16, 3), middle = slice(16, 11);
  const fromVox = await L.scanId({ width: 4, height: 4, count: 9, first, middle });
  const fromTiff = await L.scanId({ width: 4, height: 4, count: 9, first: Uint16Array.from(first), middle: Uint16Array.from(middle) });
  assert.equal(fromVox, fromTiff);
});

test('scan id: a different size or middle slice changes it', async () => {
  const zero = new Uint16Array(16);
  const a = await L.scanId({ width: 4, height: 4, count: 9, first: zero, middle: slice(16, 1) });
  const b = await L.scanId({ width: 4, height: 4, count: 9, first: zero, middle: slice(16, 2) });
  const c = await L.scanId({ width: 4, height: 4, count: 10, first: zero, middle: slice(16, 1) });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('scan id: the format is s + 16 hex', async () => {
  const id = await L.scanId({ width: 2, height: 2, count: 1, first: slice(4, 0), middle: slice(4, 0) });
  assert.match(id, /^s[0-9a-f]{16}$/);
});

const found = (over = {}) => ({ id: 'sa', path: 'scans/a', kind: 'vox', bytes: 100, mtime: 1000, study: 'ct', ...over });

test('index: a new scan is added', () => {
  const idx = L.mergeIndex(L.emptyIndex(5), [found()], 10);
  assert.equal(idx.schema, 'voxelbench-library-index');
  assert.equal(idx.version, L.INDEX_VERSION);
  assert.deepEqual(idx.scans.sa, { path: 'scans/a', kind: 'vox', bytes: 100, mtime: 1000, study: 'ct', first_seen: 10, last_seen: 10, missing: false });
});

test('index: a scan found at a new path keeps its id and gets the new path', () => {
  const before = L.mergeIndex(L.emptyIndex(1), [found()], 10);
  const snapshot = JSON.stringify(before);
  const after = L.mergeIndex(before, [found({ path: 'scans/b' })], 20);
  assert.deepEqual(Object.keys(after.scans), ['sa']);
  assert.equal(after.scans.sa.path, 'scans/b');
  assert.equal(after.scans.sa.first_seen, 10);
  assert.equal(after.scans.sa.last_seen, 20);
  assert.equal(JSON.stringify(before), snapshot, 'input index must not be mutated');
  assert.notEqual(after, before);
});

test('index: a scan not found is marked missing and kept', () => {
  const before = L.mergeIndex(L.emptyIndex(1), [found(), found({ id: 'sb', path: 'scans/b' })], 10);
  const after = L.mergeIndex(before, [found()], 20);
  assert.equal(after.scans.sb.missing, true);
  assert.equal(after.scans.sb.path, 'scans/b');
  assert.equal(after.scans.sb.last_seen, 10);
  assert.equal(after.scans.sa.missing, false);
  assert.equal(after.scans.sa.last_seen, 20);
});

test('index: a missing scan found again is not missing', () => {
  const gone = L.mergeIndex(L.mergeIndex(L.emptyIndex(1), [found()], 10), [], 20);
  assert.equal(gone.scans.sa.missing, true);
  const back = L.mergeIndex(gone, [found()], 30);
  assert.equal(back.scans.sa.missing, false);
  assert.equal(back.scans.sa.first_seen, 10);
  assert.equal(back.scans.sa.last_seen, 30);
});

test('index: an unchanged scan needs no read', () => {
  const idx = L.mergeIndex(L.emptyIndex(1), [found()], 10);
  assert.equal(L.needsRead(idx, { path: 'scans/a', bytes: 100, mtime: 1000 }), false);
  assert.equal(L.needsRead(idx, { path: 'scans/a', bytes: 101, mtime: 1000 }), true);
  assert.equal(L.needsRead(idx, { path: 'scans/a', bytes: 100, mtime: 2000 }), true);
  assert.equal(L.needsRead(idx, { path: 'scans/z', bytes: 100, mtime: 1000 }), true);
});
