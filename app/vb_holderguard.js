/* Guard on shape-found holder pieces (vb_holder.js findHolder): removing them must leave the part. A flat dense part
   standing on a base slab inside the field reaches the scan edge through the base once extended, as a stand's plate
   does, and passes the plate cues; by shape and gray alone it is a plate. What gives it away is that taking it leaves
   no body of the sample behind. Volume index i = x + nx * (y + ny * z), binned grid. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'));
  else root.VBHolderGuard = factory(root.CTPores);
}(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const PART_SHARE = 0.01; // a body left is the sample when it holds this share of the solid: the same "real share of
                           // the solid" a bright holder body must hold (vb_holderseeds.js BRIGHT_MIN_SHARE)

  /** The largest connected body of solid less the pieces' holder mask (holderMask: vb_holder.js's). */
  function largestLeft(pieces, solid, dims, holderMask) {
    const { holder } = holderMask({ solid, dims, pieces, givenBack: [] }), rest = new Uint8Array(solid.length);
    for (let i = 0; i < solid.length; i++) rest[i] = solid[i] && !holder[i] ? 1 : 0;
    const { sizes, count } = P.label(rest, dims);
    let top = 0;
    for (let l = 1; l <= count; l++) if (sizes[l] > top) top = sizes[l];
    return top;
  }

  /** The pieces, less shape-found pieces that reached the scan edge only once extended (through: true), dropped largest
      first while the largest body left once the kept pieces are removed is under PART_SHARE of the solid: the part must
      stay a body (buildBody keeps the largest one). A piece whose own seed reached the edge, or found by brightness, is
      never dropped here; if only those are left, the cut stands and removeHolder's warning says so. Ids are numbered
      again (h1, h2, ... in order of size) and the through mark is dropped. */
  function keepPart(pieces, { solid, dims }, holderMask) {
    let kept = pieces.slice(), all = 0;
    for (let i = 0; i < solid.length; i++) all += solid[i];
    while (largestLeft(kept, solid, dims, holderMask) < PART_SHARE * all) {
      const through = kept.filter((p) => p.foundBy === 'shape' && p.through);
      if (!through.length) break;
      const worst = through.reduce((a, b) => (b.voxels > a.voxels ? b : a));
      kept = kept.filter((p) => p !== worst);
    }
    return kept.map(({ through, ...p }, k) => ({ ...p, id: 'h' + (k + 1) }));
  }

  return { keepPart };
}));
