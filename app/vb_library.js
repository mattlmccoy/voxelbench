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

  const INDEX_VERSION = 1;

  /** A library with no scans. `now` is passed in (never read from the clock) so callers and tests control time. */
  function emptyIndex(now) {
    return { schema: 'voxelbench-library-index', version: INDEX_VERSION, created: now, scans: {} };
  }

  /** Whether a file seen during a scan of the root must be opened again. Same path, size and modified time as an
      indexed entry means nothing changed, so the (slow) read that yields the id can be skipped. */
  function needsRead(index, { path, bytes, mtime }) {
    return !Object.values(index.scans).some((e) => e.path === path && e.bytes === bytes && e.mtime === mtime);
  }

  /** Fold the scans found this time into the index. Returns a new index; the input is not changed. Nothing is ever
      dropped: a scan not found now is kept with missing:true, because its records live elsewhere and must stay
      attached for when the drive is back or the scan is moved. first_seen survives; last_seen moves only for scans
      found now. */
  function mergeIndex(index, scans, now) {
    const next = {};
    for (const [id, e] of Object.entries(index.scans)) next[id] = { ...e, missing: true };
    for (const { id, path, kind, bytes, mtime, study } of scans) {
      const old = index.scans[id];
      next[id] = { path, kind, bytes, mtime, study, first_seen: old ? old.first_seen : now, last_seen: now, missing: false };
    }
    return { ...index, scans: next };
  }

  return { scanId, INDEX_VERSION, emptyIndex, needsRead, mergeIndex };
}));
