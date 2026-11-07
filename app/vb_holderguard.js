/* Guards on holder removal. cutWarning is the R5 rule: removal that cuts the part itself shows as the largest body
   shrinking to under half, or removal taking over half of the solid. keepPart applies it before removal to the shape
   pieces that reached the scan edge only once extended (vb_holder.js accept, through: true): a flat dense part
   standing on a base slab inside the field reaches the edge through the base the way a stand's plate does, and passes
   the plate cues. Such a piece is kept as a proposal, not removed, and the review says so; the user can remove it.
   Volume index i = x + nx * (y + ny * z), binned grid. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'));
  else root.VBHolderGuard = factory(root.CTPores);
}(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const KEEP_BODY = 0.5;   // R5: the largest remaining body must keep at least this share of the largest body before removal
  const MAX_REMOVED = 0.5; // R5: removal may take at most this share of the solid
  const NOT_REMOVED = 'would take most of the part';

  function largest(mask, dims) {
    const { sizes, count } = P.label(mask, dims);
    let top = 0;
    for (let l = 1; l <= count; l++) if (sizes[l] > top) top = sizes[l];
    return top;
  }

  /** The R5 warning for cutting holder from solid, or null. */
  function cutWarning(solid, holder, dims) {
    let total = 0, removed = 0;
    const rest = new Uint8Array(solid.length);
    for (let i = 0; i < solid.length; i++) {
      if (!solid[i]) continue;
      total++;
      if (holder[i]) removed++; else rest[i] = 1;
    }
    if (!removed) return null;
    if (removed > MAX_REMOVED * total) return `Holder removal took ${Math.round((100 * removed) / total)} % of the solid. Check the pieces: part of the sample may have been taken as holder.`;
    if (largest(rest, dims) < KEEP_BODY * largest(solid, dims)) return 'Holder removal split the sample: its largest body shrank to under half. Check the pieces: part of the sample may have been taken as holder.';
    return null;
  }

  /** The pieces, with the through mark dropped. While removing the pieces still marked for removal would trip R5, the
      largest shape piece that reached the edge only once extended is marked { removed: false, reason } instead (a
      proposal: removeHolder gives it back, the review names it). Pieces whose own seed reached the edge, and bright
      pieces, are never marked here. holderMask: vb_holder.js's. */
  function keepPart(pieces, { solid, dims }, holderMask) {
    const out = pieces.map(({ through, ...p }) => p), through = pieces.map((p) => p.foundBy === 'shape' && Boolean(p.through));
    if (!through.some(Boolean)) return out;
    const cut = () => holderMask({ solid, dims, pieces: out.filter((p) => p.removed !== false), givenBack: [] }).holder;
    while (cutWarning(solid, cut(), dims)) {
      let worst = -1;
      out.forEach((p, k) => { if (through[k] && p.removed !== false && (worst < 0 || p.voxels > out[worst].voxels)) worst = k; });
      if (worst < 0) break;
      out[worst] = { ...out[worst], removed: false, reason: NOT_REMOVED };
    }
    return out;
  }

  return { cutWarning, keepPart, NOT_REMOVED };
}));
