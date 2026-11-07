/* Holder pieces in other frames. A piece is fitted on the worker's binned grid; it is saved with the sample in native
   scan voxels (so it rebuilds the same holder at any binning) and mapped into a leveled frame when the scan is rotated.
   - Grid to native: a grid voxel g covers native voxels g·s .. g·s + s - 1, so a center c becomes c·s + (s - 1)/2 and a
     half extent h becomes h·s (s = gridScale, native voxels per grid voxel); axes (unit directions) do not change.
   - Leveled to scan (vb_orient: q = R(p - center) - origin): p = center + Rᵀ(q + origin); axes rows turn by Rᵀ.
   Pieces are { id, kind, foundBy, center, axes (3 rows), half, voxels, mm3 }; the converters return new objects. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBHolderFrame = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const apply = (M, v) => [0, 1, 2].map((r) => M[3 * r] * v[0] + M[3 * r + 1] * v[1] + M[3 * r + 2] * v[2]);
  const applyT = (M, v) => [0, 1, 2].map((c) => M[c] * v[0] + M[3 + c] * v[1] + M[6 + c] * v[2]);
  const rows = (axes, f) => [0, 3, 6].flatMap((o) => f(axes.slice(o, o + 3)));

  // One entry per piece kind: how its pose moves. Kinds with only center/axes/half share the default.
  const KINDS = {
    default: {
      scale: (p, s) => ({ ...p, center: p.center.map((c) => c * s + (s - 1) / 2), half: p.half.map((h) => h * s) }),
      unscale: (p, s) => ({ ...p, center: p.center.map((c) => (c - (s - 1) / 2) / s), half: p.half.map((h) => h / s) }),
      toScan: (p, o) => ({ ...p, center: applyT(o.R, p.center.map((c, k) => c + o.origin[k])).map((v, k) => v + o.center[k]), axes: rows(p.axes, (a) => applyT(o.R, a)) }),
      toLeveled: (p, o) => ({ ...p, center: apply(o.R, p.center.map((c, k) => c - o.center[k])).map((v, k) => v - o.origin[k]), axes: rows(p.axes, (a) => apply(o.R, a)) }),
    },
  };
  const kind = (p) => KINDS[p.kind] || KINDS.default;

  /** Grid pieces (grid voxels, in the frame orient levels to, if any) to native scan voxels. orient is the saved native
      orientation { R, center, origin, dims } or null. */
  function piecesToNative(pieces, gridScale, orient) {
    return pieces.map((p) => { const k = kind(p), s = k.scale(p, gridScale); return orient ? k.toScan(s, orient) : s; });
  }

  /** The inverse of piecesToNative. */
  function piecesFromNative(pieces, gridScale, orient) {
    return pieces.map((p) => { const k = kind(p); return k.unscale(orient ? k.toLeveled(p, orient) : p, gridScale); });
  }

  return { piecesToNative, piecesFromNative };
}));
