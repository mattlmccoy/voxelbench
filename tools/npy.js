'use strict';
// A minimal .npy reader for the local gate's reference masks: one-byte dtypes (uint8 or bool), C order, versions 1-3.

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY
const ONE_BYTE = ['|u1', '|b1', 'u1', 'b1'];

/** { shape: number[], data: Uint8Array } from the bytes of a .npy file (a Uint8Array or Buffer). data is a view. */
function readNpy(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 10 || MAGIC.some((b, k) => u8[k] !== b)) throw new Error('This is not a .npy file.');
  const major = u8[6], view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const pre = major === 1 ? 10 : 12, length = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const header = new TextDecoder('latin1').decode(u8.subarray(pre, pre + length));
  const descr = (header.match(/'descr'\s*:\s*'([^']*)'/) || [])[1];
  if (!ONE_BYTE.includes(descr)) throw new Error(`Only uint8 or bool .npy files are read (this one is ${descr}).`);
  if (/'fortran_order'\s*:\s*True/.test(header)) throw new Error('Fortran-order .npy files are not read.');
  const dims = (header.match(/'shape'\s*:\s*\(([^)]*)\)/) || [])[1];
  if (dims === undefined) throw new Error('The .npy header has no shape.');
  const shape = dims.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const count = shape.reduce((a, b) => a * b, 1), start = pre + length;
  if (u8.length - start < count) throw new Error(`The .npy data is short: ${u8.length - start} bytes for ${count} bytes.`);
  return { shape, data: u8.subarray(start, start + count) };
}

module.exports = { readNpy };
