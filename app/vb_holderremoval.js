/* Holder removal step of the sample-mask build (ct_pores.js buildBody): find the holder pieces (or use the ones given),
   add tape, and return the voxels to cut from the solid, with a warning when the cut looks too deep. Volume index
   i = x + nx * (y + ny * z), binned grid. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'), require('./vb_holder.js'), require('./vb_holdertape.js'));
  else root.VBHolderRemoval = factory(root.CTPores, root.VBHolder, root.VBHolderTape);
}(typeof self !== 'undefined' ? self : this, function (P, Holder, Tape) {
  'use strict';

  const KEEP_BODY = 0.5;   // warn when the largest remaining body is under this share of the largest body before removal
  const MAX_REMOVED = 0.5; // warn when removal takes more than this share of the solid

  function largest(mask, dims) {
    const { sizes, count } = P.label(mask, dims);
    let top = 0;
    for (let l = 1; l <= count; l++) if (sizes[l] > top) top = sizes[l];
    return top;
  }

  /** The R5 rule: removal that cuts the part itself (a round part's tiers taken as post steps) shows as the largest
      body shrinking to under half, or removal taking over half of the solid. */
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

  /** input = { pieces: Piece[] | null (null: find), givenBack: string[], voxelMm, onProgress?, method?, find?, modules? };
      find (the holder STL fit, vb_holderwire.js) replaces findHolder and takes the same arguments; modules ({ holder,
      tape }) overrides single functions of the real modules (tests). Returns { holder: Uint8Array of voxels to cut, info }; solid is the
      threshold mask before the crop, crop (or null) is applied to the warning test only. */
  function removeHolder({ smoothed, solid, outside, dims, crop }, input) {
    const mods = input.modules || {}, holderModule = { ...Holder, ...mods.holder }, tapeModule = { ...Tape, ...mods.tape };
    const givenBack = input.givenBack || [];
    try {
      let pieces = input.pieces, method = input.method || 'given';
      if (!pieces) {
        const found = (input.find || holderModule.findHolder)({ smoothed, solid, outside, dims, voxelMm: input.voxelMm, onProgress: input.onProgress });
        const first = holderModule.holderMask({ solid, dims, pieces: found.pieces, givenBack: [] }).holder;
        const tape = tapeModule.findTape({ solid, holder: first, dims, voxelMm: input.voxelMm, firstId: found.pieces.length + 1 });
        pieces = found.pieces.concat(tape);
        method = found.method === 'none' && tape.length ? 'shape' : found.method;
      }
      const { holder, labels } = holderModule.holderMask({ solid, dims, pieces, givenBack });
      const cropped = crop ? solid.map((v, i) => v & crop[i]) : solid;
      let removedVoxels = 0;
      for (let i = 0; i < holder.length; i++) removedVoxels += holder[i];
      return { holder, info: { method, pieces, givenBack, labels, removedVoxels, warning: cutWarning(cropped, holder, dims) } };
    } catch (err) {
      const n = solid.length;
      return { holder: new Uint8Array(n), info: { method: 'none', pieces: [], givenBack, labels: new Uint8Array(n), removedVoxels: 0, warning: `Holder detection failed: ${err.message}` } };
    }
  }

  return { removeHolder, cutWarning };
}));
