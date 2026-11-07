'use strict';
// tools/npy.js: the minimal .npy reader the local gate uses for reference masks (uint8 or bool, C order).
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../tools/npy.js');

/** A version 1.0 .npy file as numpy writes it: magic, version, a little-endian uint16 header length, the header dict
    padded with spaces and ended by a newline so the data starts on a 64-byte boundary, then the raw bytes. */
function npy(descr, shape, data, { fortran = false, major = 1 } = {}) {
  const dict = `{'descr': '${descr}', 'fortran_order': ${fortran ? 'True' : 'False'}, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
  const pre = major === 1 ? 10 : 12, total = Math.ceil((pre + dict.length + 1) / 64) * 64, header = dict.padEnd(total - pre - 1, ' ') + '\n';
  const out = new Uint8Array(total + data.length);
  out.set([0x93, ...'NUMPY'.split('').map((c) => c.charCodeAt(0)), major, 0]);
  const view = new DataView(out.buffer);
  if (major === 1) view.setUint16(8, header.length, true); else view.setUint32(8, header.length, true);
  out.set(header.split('').map((c) => c.charCodeAt(0)), pre);
  out.set(data, total);
  return out;
}

test('npy reader reads shape and bytes', () => {
  const data = Uint8Array.from({ length: 24 }, (_, i) => i % 2);
  const a = N.readNpy(npy('|b1', [2, 3, 4], data));
  assert.deepEqual(a.shape, [2, 3, 4]);
  assert.deepEqual([...a.data], [...data]);
  const b = N.readNpy(npy('|u1', [5], Uint8Array.of(9, 8, 7, 6, 5), { major: 2 }));
  assert.deepEqual(b.shape, [5]);
  assert.deepEqual([...b.data], [9, 8, 7, 6, 5]);
});

test('npy reader refuses what it cannot read: another dtype, Fortran order, not a .npy file, short data', () => {
  assert.throws(() => N.readNpy(npy('<f4', [1], new Uint8Array(4))), /uint8 or bool/);
  assert.throws(() => N.readNpy(npy('|u1', [2, 2], new Uint8Array(4), { fortran: true })), /Fortran/);
  assert.throws(() => N.readNpy(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)), /not a \.npy/);
  assert.throws(() => N.readNpy(npy('|u1', [2, 3], new Uint8Array(5))), /6 bytes/);
});
