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
