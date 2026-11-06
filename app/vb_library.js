/* The scan library. A scan is known by what it contains, not by where its file sits or which format carried it, so
   the same volume opened from a .VOX or from its TIFF stack is one entry. Pure: the page passes voxels in. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBLibrary = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** An id for a scan: 's' + 16 hex characters of SHA-256 over "WxHxN" and the bytes of the first and middle slices.
      Two slices are enough to tell scans apart (a dark first slice alone would not, hence the middle) and cheap to
      read from either format; the size guards against equal slices in volumes of different depth. */
  async function scanId({ width, height, count, first, middle }) {
    const head = new TextEncoder().encode(`${width}x${height}x${count}`);
    const a = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
    const b = new Uint8Array(middle.buffer, middle.byteOffset, middle.byteLength);
    const bytes = new Uint8Array(head.length + a.length + b.length);
    bytes.set(head, 0); bytes.set(a, head.length); bytes.set(b, head.length + a.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return 's' + Array.from(digest.subarray(0, 8), (v) => v.toString(16).padStart(2, '0')).join('');
  }

  return { scanId };
}));
