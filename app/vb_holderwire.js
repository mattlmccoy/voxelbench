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
    if (stage === FIT_STAGE) return total > 1 ? `${stage} ${k + 1} / ${total}` : stage;
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
      missing from the library) goes with triangles null; with nothing saved, the loaded STLs are the choice. */
  function holderMessage(record, loaded = []) {
    const chosen = savedStls(record).length ? savedStls(record) : loaded;
    if (!record && !chosen.length) return null;
    const r = record || {};
    const stls = chosen.map((c) => loaded.find((l) => l.name === c.name) || { name: c.name, hash: c.hash, triangles: null });
    return { pieces: Array.isArray(r.pieces) ? r.pieces : null, givenBack: r.given_back || [], method: r.method || null, stls };
  }

  const lib = (name, file) => (typeof module === 'object' && module.exports ? require(file) : globalThis[name]);
  const MOST = 0.5; // a detected piece with more than this share of its voxels inside an accepted STL piece is that piece

  /** buildBody's holderInput from the request's holder (see the header). frame: scale { bin, binFactor }, orient (the
      saved native orientation or null), dims and voxelMm of the worker's grid. modules ({ holder, stl, frame }) override
      single functions of the real modules (tests). Returns { input, given, reports, keep }:
      - saved pieces stand (mapped onto the grid, 'stl' pieces voxelized again) when every saved 'stl' piece's STL is
        sent loaded with the same hash; given is then true and the method is the saved one ('given' when unknown);
      - otherwise the holder is found again (givenBack cleared: the saved ids name pieces that are gone). Each loaded STL
        is handled on its own: a saved piece of the same hash is voxelized at its saved pose; else detection seeds
        fitHolderStl, and only a fit with fits === true is accepted. Accepted STLs are 'stl' pieces stl<k> (k: place in
        the choice); detection keeps only the pieces no accepted STL covers. With no STL loaded this is plain detection;
      - keep is the saved holder { pieces, givenBack, method }, untouched, when a saved 'stl' piece's STL is not loaded:
        it must stay saved (the build's pieces never replace it). Otherwise null.
      reports, one per sent STL in order: { name, hash, outcome: 'reused' | 'unused' | 'missing' | 'fitted' | 'poor
      fit', changedFrom (the saved piece's STL hash when it changed), rmsMm, nearShare, inFieldShare, fallback (the
      detection method that covers what the STL did not) }; the fit fields are filled when buildBody runs the find. */
  function prepareHolder({ holder, scale, orient, dims, voxelMm, onProgress, modules = {} }) {
    const F = { ...lib('VBHolderFrame', './vb_holderframe.js'), ...modules.frame };
    const HS = { ...lib('VBHolderStl', './vb_holderstl.js'), ...modules.stl };
    const H = { ...lib('VBHolder', './vb_holder.js'), ...modules.holder };
    const h = holder || { pieces: null, givenBack: [], method: null, stls: [] };
    const stls = h.stls || [], sent = (name) => stls.find((s) => s.name === name) || null;
    const saved = Array.isArray(h.pieces) ? h.pieces : null, savedStl = saved ? saved.filter((p) => p.kind === 'stl') : [];
    const pieceOf = (s) => savedStl.find((p) => p.name === s.name) || null;
    const base = { voxelMm, onProgress };
    if (saved && savedStl.every((p) => sent(p.name) && sent(p.name).triangles && sent(p.name).hash === p.hash)) {
      const pieces = F.piecesFromNative(saved, scale, orient).map((p) => (p.kind === 'stl' ? { ...p, mask: HS.voxelizeMesh({ triangles: sent(p.name).triangles, pose: p.pose, dims }) } : p));
      const reports = stls.map((s) => ({ name: s.name, hash: s.hash, outcome: pieceOf(s) ? 'reused' : s.triangles ? 'unused' : 'missing' }));
      return { input: { ...base, pieces, givenBack: h.givenBack || [], method: h.method || 'given' }, given: true, reports, keep: null };
    }
    const keep = savedStl.some((p) => !(sent(p.name) && sent(p.name).triangles)) ? { pieces: saved, givenBack: h.givenBack || [], method: h.method || null } : null;
    const input = { ...base, pieces: null, givenBack: [] };
    if (!stls.some((s) => s.triangles)) return { input, given: false, reports: stls.map((s) => ({ name: s.name, hash: s.hash, outcome: 'missing' })), keep };
    const same = (s) => Boolean(pieceOf(s) && pieceOf(s).hash === s.hash); // its saved piece stands at its saved pose
    const reports = stls.map((s) => (s.triangles && !same(s) ? { name: s.name, hash: s.hash, outcome: null, changedFrom: pieceOf(s) ? pieceOf(s).hash : null } : { name: s.name, hash: s.hash, outcome: s.triangles ? 'reused' : 'missing' }));
    input.find = (ctx) => {
      const found = H.findHolder(ctx), taken = new Uint8Array(ctx.solid.length), accepted = [];
      const own = found.pieces.map((p) => { const l = H.holderMask({ solid: ctx.solid, dims: ctx.dims, pieces: [p] }).labels, at = []; for (let i = 0; i < l.length; i++) if (l[i]) at.push(i); return at; });
      const open = () => found.pieces.filter((p, k) => { let inside = 0; for (const i of own[k]) inside += taken[i]; return !(own[k].length && inside > MOST * own[k].length); });
      const fitting = stls.filter((s) => s.triangles && !same(s));
      stls.forEach((s, k) => {
        const r = reports[k];
        if (!s.triangles) { r.fallback = found.method; return; }
        let pose = same(s) ? F.piecesFromNative([pieceOf(s)], scale, orient)[0].pose : null;
        if (!pose) {
          if (ctx.onProgress) ctx.onProgress(FIT_STAGE, fitting.indexOf(s), fitting.length);
          const fit = fitFrom(HS, { triangles: s.triangles, solid: ctx.solid, outside: ctx.outside, dims: ctx.dims, voxelMm: ctx.voxelMm }, open());
          Object.assign(r, { rmsMm: fit.rmsMm, nearShare: fit.nearShare, inFieldShare: fit.inFieldShare });
          if (fit.fits !== true) { Object.assign(r, { outcome: 'poor fit', fallback: found.method }); return; }
          pose = fit.pose; r.outcome = 'fitted';
        }
        const mask = HS.voxelizeMesh({ triangles: s.triangles, pose, dims: ctx.dims });
        const piece = HS.stlPiece({ name: s.name, hash: s.hash, pose, mask, solid: ctx.solid, voxelMm: ctx.voxelMm });
        piece.id = `stl${k + 1}`;
        accepted.push(piece);
        for (let i = 0; i < mask.length; i++) if (mask[i]) taken[i] = 1;
      });
      if (!accepted.length) return found;
      // The detected pieces left are numbered again (h1, h2, ...), so tape (numbered after them) never repeats an id.
      return { method: 'stl', pieces: [...accepted, ...open().map((p, j) => ({ ...p, id: `h${j + 1}` }))] };
    };
    return { input, given: false, reports, keep };
  }

  /** fitHolderStl from the detected pieces as seeds: all of them, then, when that does not fit and there are several,
      each alone (a part of an assembly matches one detected piece; pre-aligning it to all of them can miss). The first
      fit that holds, else the one with the most surface on the scan. */
  function fitFrom(HS, args, seeds) {
    let best = null;
    for (const s of seeds.length > 1 ? [seeds, ...seeds.map((p) => [p])] : [seeds]) {
      const fit = HS.fitHolderStl({ ...args, seeds: s });
      if (fit.fits === true) return fit;
      if (!best || fit.nearShare > best.nearShare) best = fit;
    }
    return best;
  }

  /** The status for a failed request that only builds the sample mask ('volume', 'model') while segmentation is not
      running (a running segmentation reports its own failure); null otherwise. */
  const maskErrorText = (requestType, porePhase, message) =>
    ((requestType === 'volume' || requestType === 'model') && porePhase !== 'running' ? `Could not build the sample mask: ${message}` : null);

  return { FIND_STAGE, FIT_STAGE, holderKey, progressText, progressTracker, savedStls, holderMessage, prepareHolder, maskErrorText };
}));
