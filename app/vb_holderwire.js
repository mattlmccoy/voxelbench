/* Holder removal between the page and the analysis worker (ct_worker.js). The page sends, with every request that builds
   the sample mask, the saved holder as holderMessage gives it: { pieces (native scan voxels) | null, givenBack, method,
   stl: { name, hash, triangles (mm) | null } | null }, or null when nothing is saved or chosen (find the holder). The
   worker keys its mask on holderKey, turns the message into buildBody's holderInput with prepareHolder, and reports the
   find as progress (progressText, progressTracker). The holder modules are looked up when prepareHolder runs, so the
   page can load this file without them. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBHolderWire = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIND_STAGE = 'Finding the holder'; // vb_holder.js findHolder's progress stage
  const FIT_STAGE = 'Fitting the holder STL';

  /** Part of the worker's mask key: equal for equal saved holders, different when a piece is given back or taken again,
      the pieces are found again, or the chosen STL changes or arrives. The method label and runtime masks are left out:
      they do not change the mask. Fields are compared in sorted order, so a record stored with its fields in another
      order is the same holder. */
  function holderKey(h) {
    if (!h) return 'none';
    const pieces = Array.isArray(h.pieces) ? h.pieces.map(({ mask, ...p }) => p) : null;
    const stl = h.stl ? [h.stl.name, h.stl.hash, !!h.stl.triangles] : null;
    return JSON.stringify(sorted([pieces, [...(h.givenBack || [])].sort(), stl]));
  }
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

  /** Status text for a stage counted in slices ("Finding the holder: slices 120 / 348"); a stage with no count reads
      as its name. */
  const progressText = (stage, k, total) => (total > 0 ? `${stage}: slices ${k} / ${total}` : stage);

  /** share(stage, k, total) for one mask build: the bar's share 0..1, with spans { stage: [from, to] } (an unknown stage
      spans the whole bar; a stage with no count sits at its start). Returns null when the share would not rise (unless a
      stage not shown before starts at the last share), so the bar never moves back when findHolder restarts its slice
      count for another gray population or the shape path. */
  function progressTracker(spans) {
    let top = -1;
    const shown = new Set();
    return (stage, k, total) => {
      const [a, b] = spans[stage] || [0, 1], s = a + (b - a) * (total > 0 ? Math.min(1, Math.max(0, k / total)) : 0);
      if (!(s > top || (s === top && !shown.has(stage)))) return null;
      top = s;
      shown.add(stage);
      return s;
    };
  }

  /** The request's holder from the sample's saved record ({ pieces, given_back, method, stl: { name, hash } }, Task 7's
      holderRecord) and the chosen STL as loaded ({ name, hash, triangles } or null). A chosen STL not loaded (yet, or
      missing from the library) goes with triangles null. */
  function holderMessage(record, stl) {
    if (!record && !stl) return null;
    const r = record || {};
    const chosen = stl || (r.stl ? { name: r.stl.name, hash: r.stl.hash, triangles: null } : null);
    return { pieces: Array.isArray(r.pieces) ? r.pieces : null, givenBack: r.given_back || [], method: r.method || null, stl: chosen };
  }

  const lib = (name, file) => (typeof module === 'object' && module.exports ? require(file) : globalThis[name]);

  /** buildBody's holderInput from the request's holder (see the header). frame: scale { bin, binFactor }, orient (the
      saved native orientation or null), dims and voxelMm of the worker's grid. modules ({ holder, stl, frame }) override
      single functions of the real modules (tests). Returns { input, given, report, keep }:
      - saved pieces stand (mapped onto the grid, 'stl' pieces voxelized again) when they need no STL or their STL is the
        one sent (same hash); given is then true and the method is the saved one ('given' when unknown);
      - a saved 'stl' piece whose STL is not loaded: the holder is found by detection for this build only; keep is the
        saved holder { pieces, givenBack, method }, untouched, which must stay saved (the build's pieces never replace it);
      - otherwise the holder is found again (givenBack cleared: the saved ids name pieces that are gone), by detection, or
        with the STL loaded: detection seeds fitHolderStl, and only a fit with fits === true is the holder.
      keep is null except in the not-loaded case.
      report (null when no STL is involved): { name, hash, outcome: 'reused' | 'unused' | 'missing' | 'fitted' | 'poor
      fit', changedFrom (the saved piece's STL hash when it changed), rmsMm, nearShare, inFieldShare, fallback (the
      detection method used after a poor fit) }; the fit fields are filled when buildBody runs the find. */
  function prepareHolder({ holder, scale, orient, dims, voxelMm, onProgress, modules = {} }) {
    const F = { ...lib('VBHolderFrame', './vb_holderframe.js'), ...modules.frame };
    const HS = { ...lib('VBHolderStl', './vb_holderstl.js'), ...modules.stl };
    const H = { ...lib('VBHolder', './vb_holder.js'), ...modules.holder };
    const h = holder || { pieces: null, givenBack: [], method: null, stl: null };
    const stl = h.stl || null, triangles = stl && stl.triangles ? stl.triangles : null;
    const saved = Array.isArray(h.pieces) ? h.pieces : null, savedStl = saved ? saved.filter((p) => p.kind === 'stl') : [];
    const base = { voxelMm, onProgress };
    if (saved && savedStl.every((p) => triangles && p.hash === stl.hash)) {
      const pieces = F.piecesFromNative(saved, scale, orient).map((p) => (p.kind === 'stl' ? { ...p, mask: HS.voxelizeMesh({ triangles, pose: p.pose, dims }) } : p));
      const report = stl ? { name: stl.name, hash: stl.hash, outcome: savedStl.length ? 'reused' : 'unused' } : null;
      return { input: { ...base, pieces, givenBack: h.givenBack || [], method: h.method || 'given' }, given: true, report, keep: null };
    }
    const old = savedStl[0] || null, input = { ...base, pieces: null, givenBack: [] };
    if (!triangles) {
      const named = stl || old, keep = old ? { pieces: saved, givenBack: h.givenBack || [], method: h.method || null } : null;
      return { input, given: false, report: named ? { name: named.name, hash: named.hash, outcome: 'missing' } : null, keep };
    }
    const report = { name: stl.name, hash: stl.hash, outcome: null, changedFrom: old ? old.hash : null };
    input.find = (ctx) => {
      const found = H.findHolder(ctx);
      if (ctx.onProgress) ctx.onProgress(FIT_STAGE, 0, 0);
      const fit = HS.fitHolderStl({ triangles, solid: ctx.solid, outside: ctx.outside, dims: ctx.dims, voxelMm: ctx.voxelMm, seeds: found.pieces });
      Object.assign(report, { rmsMm: fit.rmsMm, nearShare: fit.nearShare, inFieldShare: fit.inFieldShare });
      if (fit.fits !== true) { Object.assign(report, { outcome: 'poor fit', fallback: found.method }); return found; }
      const mask = HS.voxelizeMesh({ triangles, pose: fit.pose, dims: ctx.dims });
      const piece = HS.stlPiece({ name: stl.name, hash: stl.hash, pose: fit.pose, mask, solid: ctx.solid, voxelMm: ctx.voxelMm });
      piece.id = 'h1'; // the only piece before tape (vb_holderremoval numbers tape from 2)
      report.outcome = 'fitted';
      return { method: 'stl', pieces: [piece] };
    };
    return { input, given: false, report, keep: null };
  }

  /** The status for a failed request that only builds the sample mask ('volume', 'model') while segmentation is not
      running (a running segmentation reports its own failure); null otherwise. */
  const maskErrorText = (requestType, porePhase, message) =>
    ((requestType === 'volume' || requestType === 'model') && porePhase !== 'running' ? `Could not build the sample mask: ${message}` : null);

  return { FIND_STAGE, FIT_STAGE, holderKey, progressText, progressTracker, holderMessage, prepareHolder, maskErrorText };
}));
