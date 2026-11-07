/* Holder removal step of the sample-mask build (ct_pores.js buildBody): find the holder pieces (or use the ones given),
   add tape, and return the voxels to cut from the solid, with a warning or a note when the cut is deep (R5,
   vb_holderguard.js). Volume index
   i = x + nx * (y + ny * z), binned grid. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_holder.js'), require('./vb_holdertape.js'), require('./vb_holderguard.js'));
  else root.VBHolderRemoval = factory(root.VBHolder, root.VBHolderTape, root.VBHolderGuard);
}(typeof self !== 'undefined' ? self : this, function (Holder, Tape, Guard) {
  'use strict';

  /** The one-voxel contact band holderMask cuts past a piece's surface has no label; it takes the label of a cut,
      labeled neighbor (a piece not given back), so the review shows every voxel removal takes. Changes labels in place. */
  function labelBand(holder, labels, dims, pieces, givenBack) {
    const { nx, ny } = dims, plane = nx * ny, back = new Set(givenBack), kept = (l) => l && !back.has(pieces[l - 1].id);
    const band = [];
    for (let i = 0; i < holder.length; i++) if (holder[i] && !labels[i]) band.push(i);
    for (const i of band) {
      const x = i % nx, y = Math.floor(i / nx) % ny;
      const near = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1, i - plane, i + plane];
      const j = near.find((k) => k >= 0 && k < holder.length && holder[k] && kept(labels[k]));
      if (j !== undefined) labels[i] = labels[j];
    }
  }

  /** input = { pieces: Piece[] | null (null: find), givenBack: string[], voxelMm, onProgress?, method?, find?, modules? };
      find (the holder STL fit, vb_holderwire.js) replaces findHolder and takes the same arguments; modules ({ holder,
      tape }) overrides single functions of the real modules (tests). Returns { holder: Uint8Array of voxels to cut, info }; solid is the
      threshold mask before the crop, crop (or null) is applied to the R5 test only. */
  function removeHolder({ smoothed, solid, outside, dims, crop }, input) {
    const mods = input.modules || {}, holderModule = { ...Holder, ...mods.holder }, tapeModule = { ...Tape, ...mods.tape };
    let givenBack = input.givenBack || [];
    try {
      let pieces = input.pieces, method = input.method || 'given';
      if (!pieces) {
        const found = (input.find || holderModule.findHolder)({ smoothed, solid, outside, dims, voxelMm: input.voxelMm, onProgress: input.onProgress });
        // A found piece marked removed: false (vb_holderguard.js keepPart) is a proposal: listed, labeled, given back.
        givenBack = [...givenBack, ...found.pieces.filter((p) => p.removed === false).map((p) => p.id)];
        const first = holderModule.holderMask({ solid, dims, pieces: found.pieces, givenBack }).holder;
        const tape = tapeModule.findTape({ solid, holder: first, dims, voxelMm: input.voxelMm, firstId: found.pieces.length + 1 });
        pieces = found.pieces.concat(tape);
        method = found.method === 'none' && tape.length ? 'shape' : found.method;
      }
      const { holder, labels } = holderModule.holderMask({ solid, dims, pieces, givenBack });
      labelBand(holder, labels, dims, pieces, givenBack);
      const cropped = crop ? solid.map((v, i) => v & crop[i]) : solid;
      let removedVoxels = 0;
      for (let i = 0; i < holder.length; i++) removedVoxels += holder[i];
      return { holder, info: { method, pieces, givenBack, labels, removedVoxels, ...Guard.cutStatus(cropped, holder, dims, pieces, givenBack) } };
    } catch (err) {
      const n = solid.length;
      return { holder: new Uint8Array(n), info: { method: 'none', pieces: [], givenBack, labels: new Uint8Array(n), removedVoxels: 0, failed: err.message, warning: `Holder detection failed: ${err.message}`, note: null } };
    }
  }

  return { removeHolder };
}));
