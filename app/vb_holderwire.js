/* Holder removal between the page and the analysis worker (ct_worker.js). The page sends, with every request that builds
   the sample mask, the saved holder as holderMessage gives it: { pieces (native scan voxels) | null, givenBack, method,
   stls: [{ name, hash, triangles (mm) | null }, ...] in choice order }, or null when nothing is saved or chosen (find the
   holder). A holder may be several printed parts, each its own STL, fitted on its own. The worker keys its mask on
   holderKey, turns the message into buildBody's holderInput with prepareHolder, and reports the find as progress
   (progressText, progressTracker). The holder modules are looked up when prepareHolder runs, so the page can load this
   file without them. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBHolderWire = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIND_STAGE = 'Finding the holder'; // vb_holder.js findHolder's progress stage
  const FIT_STAGE = 'Fitting the holder STL';

  /** Part of the worker's mask key: equal for equal saved holders, different when a piece is given back or taken again,
      the pieces are found again, or an STL is chosen, dropped, reordered, changed or arrives. The method label and runtime
      masks are left out: they do not change the mask. Fields are compared in sorted order, so a record stored with its
      fields in another order is the same holder. */
  function holderKey(h) {
    if (!h) return 'none';
    const pieces = Array.isArray(h.pieces) ? h.pieces.map(({ mask, ...p }) => p) : null;
    const stls = (h.stls || []).map((s) => [s.name, s.hash, !!s.triangles]);
    return JSON.stringify(sorted([pieces, [...(h.givenBack || [])].sort(), stls]));
  }
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

  /** Status text for a stage counted in slices ("Finding the holder: slices 120 / 348"), or for the fit of STL k + 1 of
      total ("Fitting the holder STL 2 / 3"; one STL reads as the stage); a stage with no count reads as its name. */
  function progressText(stage, k, total) {
    if (stage === FIT_STAGE) return total > 1 ? `${stage} ${Math.floor(k) + 1} / ${total}` : stage;
    return total > 0 ? `${stage}: slices ${k} / ${total}` : stage;
  }

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

  /** The STLs a saved record chose, in order: { name, hash } each. A record saved before several STLs per holder holds
      one as stl; it reads as a list of one. */
  const savedStls = (record) => (!record ? [] : Array.isArray(record.stls) ? record.stls : record.stl ? [record.stl] : []);

  /** The request's holder from the sample's saved record ({ pieces, given_back, method, stls: [{ name, hash }] }, Task 7's
      holderRecord) and the STLs loaded from the library ([{ name, hash, triangles }]). A chosen STL not loaded (yet, or
      missing from the library) goes with triangles null; one loaded with another hash than the record's carries the
      record's as was. With nothing saved, the loaded STLs are the choice. */
  function holderMessage(record, loaded = []) {
    const chosen = savedStls(record).length ? savedStls(record) : loaded;
    if (!record && !chosen.length) return null;
    const r = record || {};
    const stls = chosen.map((c) => {
      const l = loaded.find((x) => x.name === c.name);
      if (!l) return { name: c.name, hash: c.hash, triangles: null };
      return c.hash && c.hash !== l.hash ? { ...l, was: c.hash } : l;
    });
    return { pieces: Array.isArray(r.pieces) ? r.pieces : null, givenBack: r.given_back || [], method: r.method || null, stls, ...(r.carried ? { carried: true } : {}) };
  }

  const lib = (name, file) => (typeof module === 'object' && module.exports ? require(file) : globalThis[name]);
  const MOST = 0.5; // a detected piece with more than this share of its voxels inside an accepted STL piece is that piece
  // A fit from all detected pieces that does not hold is tried again from single pieces whose voxel count lies between
  // MIN_IN_FIELD (vb_holderstl.js: less of the STL in the field cannot fit) and RETRY_ABOVE times the STL's own volume
  // (a larger piece is more than this part), closest in volume first, at most MAX_RETRIES of them (a cost bound: each
  // try is a full fit).
  const RETRY_ABOVE = 2, MAX_RETRIES = 2;

  /** buildBody's holderInput from the request's holder (see the header). frame: scale { bin, binFactor }, orient (the
      saved native orientation or null), dims and voxelMm of the worker's grid. modules ({ holder, stl, frame }) override
      single functions of the real modules (tests). Returns { input, given, carried, reports, keep }:
      - saved pieces stand (mapped onto the grid, 'stl' pieces voxelized again) when every saved 'stl' piece's STL is
        sent loaded with the same hash and no chosen STL changed since the review (was); given is then true and the
        method is the saved one ('given' when unknown). Pieces carried over by leveling (holder.carried) stand the same
        way but are not a review: given false, carried true;
      - otherwise the holder is found again (givenBack cleared: the saved ids name pieces that are gone). Each loaded STL
        is handled on its own: a saved piece of the same hash is voxelized at its saved pose; else detection seeds
        fitHolderStl (fitFrom), and only a fit with fits === true is accepted. Accepted STLs are 'stl' pieces stl<k> (k:
        place in the choice); detection keeps only the pieces no accepted STL covers. With no STL loaded this is plain
        detection;
      - keep is the saved holder { pieces, givenBack, method }, untouched, when a saved 'stl' piece's STL is not loaded:
        it must stay saved (the build's pieces never replace it). Otherwise null.
      reports, one per sent STL in order, then one per saved 'stl' piece whose STL was not sent: { name, hash, outcome:
      'reused' | 'unused' | 'missing' | 'fitted' | 'poor fit', changedFrom (the hash the review used, when the file
      changed), rmsMm, nearShare, inFieldShare, fallback (the detection method that covers what the STL did not, or
      'covered' when the accepted STLs left detection nothing) }; the fit fields are filled when buildBody runs the find. */
  function prepareHolder({ holder, scale, orient, dims, voxelMm, onProgress, modules = {} }) {
    const F = { ...lib('VBHolderFrame', './vb_holderframe.js'), ...modules.frame };
    const HS = { ...lib('VBHolderStl', './vb_holderstl.js'), ...modules.stl };
    const H = { ...lib('VBHolder', './vb_holder.js'), ...modules.holder };
    const h = holder || { pieces: null, givenBack: [], method: null, stls: [] };
    const stls = h.stls || [], sent = (name) => stls.find((s) => s.name === name) || null;
    const saved = Array.isArray(h.pieces) ? h.pieces : null, savedStl = saved ? saved.filter((p) => p.kind === 'stl') : [];
    const pieceOf = (s) => savedStl.find((p) => p.name === s.name) || null;
    const loadedAs = (p) => { const s = sent(p.name); return Boolean(s && s.triangles && s.hash === p.hash); };
    const unsent = savedStl.filter((p) => !sent(p.name)).map((p) => ({ name: p.name, hash: p.hash, outcome: 'missing' }));
    const base = { voxelMm, onProgress };
    if (saved && savedStl.every(loadedAs) && !stls.some((s) => s.triangles && s.was)) {
      const pieces = F.piecesFromNative(saved, scale, orient).map((p) => (p.kind === 'stl' ? { ...p, mask: HS.voxelizeMesh({ triangles: sent(p.name).triangles, pose: p.pose, dims }) } : p));
      const reports = stls.map((s) => ({ name: s.name, hash: s.hash, outcome: pieceOf(s) ? 'reused' : s.triangles ? 'unused' : 'missing' }));
      return { input: { ...base, pieces, givenBack: h.givenBack || [], method: h.method || 'given' }, given: !h.carried, carried: Boolean(h.carried), reports, keep: null };
    }
    const notLoaded = savedStl.some((p) => !(sent(p.name) && sent(p.name).triangles));
    const keep = notLoaded ? { pieces: saved, givenBack: h.givenBack || [], method: h.method || null } : null;
    const input = { ...base, pieces: null, givenBack: [] };
    const same = (s) => Boolean(pieceOf(s) && pieceOf(s).hash === s.hash); // its saved piece stands at its saved pose
    const reports = [...stls.map((s) => reportOf(s, pieceOf(s), same(s), Boolean(saved))), ...unsent];
    if (!stls.some((s) => s.triangles)) return { input, given: false, carried: false, reports, keep };
    input.find = (ctx) => {
      const found = H.findHolder(ctx), own = ownVoxels(H, ctx, found.pieces), taken = new Uint8Array(ctx.solid.length), accepted = [];
      const open = () => found.pieces.filter((p, k) => !covered(own[k], taken));
      const fitting = stls.filter((s) => s.triangles && !same(s)), cache = {};
      stls.forEach((s, k) => {
        if (!s.triangles) return;
        const r = reports[k];
        let pose = same(s) ? F.piecesFromNative([pieceOf(s)], scale, orient)[0].pose : null;
        if (!pose) {
          const step = (j, tries) => { if (ctx.onProgress) ctx.onProgress(FIT_STAGE, fitting.indexOf(s) + j / tries, fitting.length); };
          const fit = fitFrom(HS, { triangles: s.triangles, solid: ctx.solid, outside: ctx.outside, dims: ctx.dims, voxelMm: ctx.voxelMm, cache }, open(), step);
          Object.assign(r, { rmsMm: fit.rmsMm, nearShare: fit.nearShare, inFieldShare: fit.inFieldShare });
          if (fit.fits !== true) { r.outcome = 'poor fit'; return; }
          pose = fit.pose; r.outcome = 'fitted';
        }
        const mask = HS.voxelizeMesh({ triangles: s.triangles, pose, dims: ctx.dims });
        const piece = HS.stlPiece({ name: s.name, hash: s.hash, pose, mask, solid: ctx.solid, voxelMm: ctx.voxelMm });
        piece.id = `stl${k + 1}`;
        accepted.push(piece);
        for (let i = 0; i < mask.length; i++) if (mask[i]) taken[i] = 1;
      });
      const rest = open(), fallback = found.pieces.length && !rest.length ? 'covered' : found.method;
      for (const r of reports) if (r.outcome === 'poor fit' || r.outcome === 'missing') r.fallback = fallback;
      if (!accepted.length) return found;
      // The detected pieces left are numbered again (h1, h2, ...), so tape (numbered after them) never repeats an id.
      return { method: 'stl', pieces: [...accepted, ...rest.map((p, j) => ({ ...p, id: `h${j + 1}` }))] };
    };
    return { input, given: false, carried: false, reports, keep };
  }

  /** An STL's report before the find: reused at its saved pose, missing, or to be fitted (changedFrom: the hash the
      saved review (reviewed) used when the file changed since; a choice never reviewed has no review to clear). */
  function reportOf(s, old, same, reviewed) {
    if (!s.triangles) return { name: s.name, hash: s.hash, outcome: 'missing' };
    if (same) return { name: s.name, hash: s.hash, outcome: 'reused' };
    return { name: s.name, hash: s.hash, outcome: null, changedFrom: old ? old.hash : (reviewed && s.was) || null };
  }

  /** Each detected piece's solid voxels (indices), from one holderMask labeling (a voxel two pieces share counts for the
      first, as the labels show it). */
  function ownVoxels(H, ctx, pieces) {
    const own = pieces.map(() => []);
    if (!pieces.length) return own;
    const { labels } = H.holderMask({ solid: ctx.solid, dims: ctx.dims, pieces });
    for (let i = 0; i < labels.length; i++) if (labels[i]) own[labels[i] - 1].push(i);
    return own;
  }

  /** Whether more than MOST of a piece's voxels are taken by accepted STL pieces. */
  function covered(voxels, taken) {
    let inside = 0;
    for (const i of voxels) inside += taken[i];
    return voxels.length > 0 && inside > MOST * voxels.length;
  }

  /** The STL's volume in grid voxels (a closed mesh in mm; the sign of its winding does not matter). */
  function meshVoxels(t, voxelMm) {
    let v = 0;
    for (let i = 0; i < t.length; i += 9) {
      v += t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6]);
    }
    return Math.abs(v) / 6 / voxelMm ** 3;
  }

  /** fitHolderStl from the detected pieces as seeds: all of them, then, when that does not hold and there are several,
      single pieces in the retry window (MIN_IN_FIELD to RETRY_ABOVE, MAX_RETRIES): a part of an assembly matches one detected piece, and
      pre-aligning it to all of them can miss. step(j, tries) reports each try. The first fit that holds, else the one
      with the most surface on the scan. */
  function fitFrom(HS, args, seeds, step) {
    const size = meshVoxels(args.triangles, args.voxelMm), off = (p) => Math.abs(Math.log(p.voxels / size));
    const alone = seeds.length > 1 ? seeds.filter((p) => p.voxels >= HS.MIN_IN_FIELD * size && p.voxels <= RETRY_ABOVE * size)
      .sort((a, b) => off(a) - off(b)).slice(0, MAX_RETRIES) : [];
    const tries = [seeds, ...alone.map((p) => [p])];
    let best = null;
    for (let j = 0; j < tries.length; j++) {
      step(j, tries.length);
      const fit = HS.fitHolderStl({ ...args, seeds: tries[j] });
      if (fit.fits === true) return fit;
      if (!best || fit.nearShare > best.nearShare) best = fit;
    }
    return best;
  }

  /** The status for a failed request that only builds the sample mask ('volume', 'model') while segmentation is not
      running (a running segmentation reports its own failure); null otherwise. */
  const maskErrorText = (requestType, porePhase, message) =>
    ((requestType === 'volume' || requestType === 'model') && porePhase !== 'running' ? `Could not build the sample mask: ${message}` : null);

  return { FIND_STAGE, FIT_STAGE, MAX_RETRIES, holderKey, progressText, progressTracker, savedStls, holderMessage, prepareHolder, maskErrorText };
}));
