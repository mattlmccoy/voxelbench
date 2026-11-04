'use strict';
// The page sorts slice files by the number in the name (CT.groupStacks); the command-line tools must read the same order.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CT = require('../app/ct_core.js');
const H = require('../tools/headless_run.js');

test('slice files sort by the number in the name, as the page does', () => {
  assert.deepEqual(CT.sliceOrder(['s_10.tif', 's_2.tif', 'notes.txt', 's_1.tiff']), ['s_1.tiff', 's_2.tif', 's_10.tif']);
});

test('readStack reads unpadded slice names in number order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-order-'));
  try {
    for (const z of [1, 2, 10]) fs.writeFileSync(path.join(dir, `s_${z}.tif`), Buffer.from(CT.writeTiff(2, 1, Uint16Array.from([z, z]), 0.04)));
    const { slices } = H.readStack(dir);
    assert.deepEqual(slices.map((s) => s[0]), [1, 2, 10]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
