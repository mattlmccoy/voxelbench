/* Holder pieces in other frames. A piece is fitted on the worker's binned grid; it is saved with the sample in native
   scan voxels (so it rebuilds the same holder at any binning) and mapped into a leveled frame when the scan is rotated.
   - Grid to native: worker voxel j is loaded voxel l = bin·j + (bin-1)/2, which is native binFactor·l + (binFactor-1)/2 in
     scan axes (binFactor·l in a leveled frame); a half extent h becomes h·bin·binFactor; axes do not change.
   - Leveled to scan (vb_orient: q = R(p - center) - origin): p = center + Rᵀ(q + origin); axes rows turn by Rᵀ.
   voxels and mm3 are copied unscaled.
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
  // Worker grid voxel j is loaded voxel l = bin·j + (bin-1)/2; native = binFactor·l + shift, where shift is
  // (binFactor-1)/2 in scan axes and 0 in a leveled frame (vb_orient.onGrid already absorbs that offset into center).
  const KINDS = {
    default: {
      scale: (p, { bin, binFactor }, shift) => ({ ...p, center: p.center.map((c) => (bin * c + (bin - 1) / 2) * binFactor + shift), half: p.half.map((h) => h * bin * binFactor) }),
      unscale: (p, { bin, binFactor }, shift) => ({ ...p, center: p.center.map((c) => ((c - shift) / binFactor - (bin - 1) / 2) / bin), half: p.half.map((h) => h / (bin * binFactor)) }),
      toScan: (p, o) => ({ ...p, center: applyT(o.R, p.center.map((c, k) => c + o.origin[k])).map((v, k) => v + o.center[k]), axes: rows(p.axes, (a) => applyT(o.R, a)) }),
      toLeveled: (p, o) => ({ ...p, center: apply(o.R, p.center.map((c, k) => c - o.center[k])).map((v, k) => v - o.origin[k]), axes: rows(p.axes, (a) => apply(o.R, a)) }),
    },
  };
  const kind = (p) => KINDS[p.kind] || KINDS.default;
  const shiftOf = ({ binFactor }, orient) => (orient ? 0 : (binFactor - 1) / 2);

  /** Worker-grid pieces to native scan voxels. scale = { bin, binFactor }: the worker's binning of the loaded grid and
      the loaded grid's binning of the native scan; orient is the saved native orientation { R, center, origin, dims }
      when the grid is a leveled frame (loaded voxel i then sits at leveled-native binFactor·i), else null. */
  function piecesToNative(pieces, scale, orient) {
    return pieces.map((p) => { const k = kind(p), n = k.scale(p, scale, shiftOf(scale, orient)); return orient ? k.toScan(n, orient) : n; });
  }

  /** The inverse of piecesToNative. */
  function piecesFromNative(pieces, scale, orient) {
    return pieces.map((p) => { const k = kind(p); return k.unscale(orient ? k.toLeveled(p, orient) : p, scale, shiftOf(scale, orient)); });
  }

  return { piecesToNative, piecesFromNative };
}));
