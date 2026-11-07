/* Guards on holder removal (R5): removal that cuts the part itself shows as the largest body shrinking to under half,
   or removal taking over half of the solid. A holder larger than the part trips the share clause on a correct removal,
   so R5 alone is not evidence that the part was taken: removal warns only when R5 trips and an ambiguous piece was
   removed, one accepted via extension (it reached the scan edge only once extended) or via support (a post step
   holding something up; vb_holder.js accept). Otherwise a tripped R5 is a note with the holder's share of the solid.
   keepPart applies R5 before removal to the shape pieces accepted via extension: a flat dense part standing on a base
   slab inside the field reaches the edge through the base the way a stand's plate does, and passes the plate cues.
   Such a piece is kept as a proposal, not removed, and the review says so; the user can remove it.
   Volume index i = x + nx * (y + ny * z), binned grid. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'));
  else root.VBHolderGuard = factory(root.CTPores);
}(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const KEEP_BODY = 0.5;   // R5: the largest remaining body must keep at least this share of the largest body before removal
  const MAX_REMOVED = 0.5; // R5: removal may take at most this share of the solid
  const NOT_REMOVED = 'would take most of the part';
  const TAKEN = 'Check the pieces: part of the sample may have been taken as holder.';

  function largest(mask, dims) {
    const { sizes, count } = P.label(mask, dims);
    let top = 0;
    for (let l = 1; l <= count; l++) if (sizes[l] > top) top = sizes[l];
    return top;
  }

  /** R5 for cutting holder from solid: null when it holds, else { share (of the solid removed), split (the largest
      body shrank to under half) }. */
  function trips(solid, holder, dims) {
    let total = 0, removed = 0;
    const rest = new Uint8Array(solid.length);
    for (let i = 0; i < solid.length; i++) {
      if (!solid[i]) continue;
      total++;
      if (holder[i]) removed++; else rest[i] = 1;
    }
    if (!removed) return null;
    const share = removed / total;
    if (share > MAX_REMOVED) return { share, split: false };
    return largest(rest, dims) < KEEP_BODY * largest(solid, dims) ? { share, split: true } : null;
  }

  /** Removal's { warning, note } for cutting holder from solid with these pieces (those in givenBack not removed). */
  function cutStatus(solid, holder, dims, pieces, givenBack = []) {
    const r = trips(solid, holder, dims), pct = r && Math.round(100 * r.share);
    if (!r) return { warning: null, note: null };
    const back = new Set(givenBack);
    if (!pieces.some((p) => p.via && !back.has(p.id))) return { warning: null, note: `The holder is ${pct} % of the solid.` };
    return { warning: r.split ? `Holder removal split the sample: its largest body shrank to under half. ${TAKEN}` : `Holder removal took ${pct} % of the solid. ${TAKEN}`, note: null };
  }

  /** The pieces. While removing the pieces still marked for removal would trip R5, the largest shape piece accepted via
      extension is marked { removed: false, reason } instead (a proposal: removeHolder gives it back, the review names
      it). Pieces whose own seed reached the edge, steps and bright pieces are never marked here. holderMask:
      vb_holder.js's. */
  function keepPart(pieces, { solid, dims }, holderMask) {
    const out = pieces.map((p) => ({ ...p })), through = pieces.map((p) => p.foundBy === 'shape' && p.via === 'extension');
    if (!through.some(Boolean)) return out;
    const cut = () => holderMask({ solid, dims, pieces: out.filter((p) => p.removed !== false), givenBack: [] }).holder;
    while (trips(solid, cut(), dims)) {
      let worst = -1;
      out.forEach((p, k) => { if (through[k] && p.removed !== false && (worst < 0 || p.voxels > out[worst].voxels)) worst = k; });
      if (worst < 0) break;
      out[worst] = { ...out[worst], removed: false, reason: NOT_REMOVED };
    }
    return out;
  }

  return { trips, cutStatus, keepPart, NOT_REMOVED };
}));
