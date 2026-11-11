/* Runs pore detection off the page's main thread. The main thread sends the binned volume once, and sends full-
   resolution slices only when the smoothing changes; smoothed slices are kept here so threshold reruns are quick. */
importScripts('ct_core.js', 'ct_pores.js', 'vb_calibration.js', 'ct_regions.js', 'ct_zones.js', 'ct_sheetdata.js', 'vb_connectivity.js', 'vb_align.js', 'vb_deviation.js', 'vb_cad.js', 'vb_filler.js', 'vb_wall.js', 'vb_masks.js',
  'vb_stl.js', 'vb_holderseeds.js', 'vb_holderguard.js', 'vb_holderfit.js', 'vb_holder.js', 'vb_holdertape.js', 'vb_holderremoval.js', 'vb_holderframe.js', 'vb_holderstl.js', 'vb_holderwire.js', 'vb_figure.js');
const P = self.CTPores, R = self.CTRegions, Z = self.CTZones, D = self.CTSheetData, HW = self.VBHolderWire;
const MODEL_DOWNSAMPLE = 2;
const COARSE_STEP = 2; // binned voxels per coarse cell: 4 full voxels, about 0.16 mm at 40 um
const MESH_FACTOR = 2; // full voxels per cell of the 3D void surfaces, about 0.08 mm at 40 um
let vol = null, body = null, bodyKey = '', bodyAlias = '', smoothed = null, smoothedSigma = null, pending = null, pores = null, smoother = null;
const ORIENTATION_RETRY_BELOW = 0.5, ORIENTATION_STEP = 8; // Dice under which the cross-check tries other orientations; slices sampled
let poreCoarse = null; // detectPores' coarse result: its interior minus edge zone is where pore voxels are counted
let coarse = null, voidShare = null, zoneReady = null, airGray = null, patchLabels = null, solidGray = null;
// The holder: the frame its saved pieces are in ({ binFactor, orient }, sent with each request), and the last mask
// build's result (buildBody's holder info on the grid, plus given and one report per chosen STL).
let frame = { binFactor: 1, orient: null }, holder = null;
const HOLDER_SPANS = { [HW.FIND_STAGE]: [0, 0.7], [HW.FIT_STAGE]: [0.7, 1] }, FIND_ONLY = { [HW.FIND_STAGE]: [0, 1] };

const say = (text) => postMessage({ type: 'status', text });

const scale = () => ({ bin: vol.bin, binFactor: frame.binFactor });

/** The sample mask without the holder, rebuilt when the settings, crops or saved holder change; a rebuilt mask drops
    every result made on the old one. data.holder is the page's request holder (vb_holderwire.js), data.frame its frame.
    A request whose saved holder is the one this mask was built with (the page saved what it was sent) is the same mask. */
function ensureBody({ settings, crops, holder: request = null, frame: f }) {
  if (f) frame = f;
  const base = JSON.stringify([settings.sigma, settings.bodyThreshold, settings.closeRadius, settings.closeShape, crops.map((c) => [c.plane, c.points])]);
  const key = base + HW.holderKey(request);
  if (body && key === bodyAlias) bodyKey = key;
  if (key === bodyKey && body) return false;
  say('Building the sample mask');
  const crop = P.cropMask(crops, vol.dims, vol.bin);
  const fitting = Boolean(request && (request.stls || []).some((t) => t.triangles)), share = HW.progressTracker(fitting ? HOLDER_SPANS : FIND_ONLY);
  const onProgress = (stage, k, total) => { const s = share(stage, k, total); if (s !== null) postMessage({ type: 'progress', text: HW.progressText(stage, k, total), share: s }); };
  let prep;
  try {
    prep = HW.prepareHolder({ holder: request, scale: scale(), orient: frame.orient, dims: vol.dims, voxelMm: vol.bin * vol.voxelMm, onProgress });
  } catch (e) { e.stage = 'holder'; throw e; } // the page says "removal failed" only for the holder's own failures
  body = P.buildBody(vol.gray, vol.outside, vol.dims, settings, crop, prep.input);
  holder = { ...body.holder, given: prep.given, carried: prep.carried, stls: prep.reports, keep: prep.keep };
  holder.native = self.VBHolderFrame.piecesToNative(holder.pieces, scale(), frame.orient);
  bodyKey = key;
  bodyAlias = base + HW.holderKey({ pieces: holder.native, givenBack: holder.givenBack, stls: request ? request.stls : [] });
  poreCoarse = null; coarse = null; voidShare = null; zoneReady = null; patchLabels = null; solidGray = null; airGray = null; pores = null;
  return true;
}

function sendModel() {
  let filled = 0;
  for (let i = 0; i < body.filled.length; i++) filled += body.filled[i];
  const small = P.downsampleMask(body.filled, vol.dims, MODEL_DOWNSAMPLE);
  const { positions, indices } = P.surfaceNets(small.mask, small.dims);
  for (let i = 0; i < positions.length; i++) positions[i] *= vol.bin * MODEL_DOWNSAMPLE;
  airGray = R.estimateAirGray(vol.gray, vol.outside, body.filled);
  // The holder for the page: pieces in native scan voxels (as saved), labels on the worker's grid (piece index + 1).
  const h = holder, labels = h.labels.slice();
  const out = { method: h.method, given: h.given, pieces: h.native, givenBack: h.givenBack,
    labels, labelsDims: vol.dims, labelsBin: vol.bin, removedVoxels: h.removedVoxels, warning: h.warning, note: h.note || null, failed: h.failed || null, carried: h.carried, stls: h.stls,
    keep: h.keep }; // keep (native, or null): the saved holder that stays saved while its STL is not loaded; never save pieces over it
  postMessage({ type: 'model', positions, indices, bodyMm3: filled * (vol.bin * vol.voxelMm) ** 3, airGray, holder: out }, [positions.buffer, indices.buffer, labels.buffer]);
}

function finishDetect({ settings }) {
  say('Coarse segmentation on the binned volume');
  const coarse = P.detectPores(vol.gray, vol.outside, vol.dims, body, settings, { bin: vol.bin, voxelMm: vol.voxelMm });
  poreCoarse = coarse;
  say('Fine segmentation on the loaded grid');
  const result = P.fineDetect({ dims: vol.full, bin: vol.bin, settings, voxelMm: vol.voxelMm, coarse, binnedDims: vol.dims, getSmoothed: (z) => smoothed[z] });
  say('Open and closed pores, networks, sphericity');
  const conn = self.VBConnectivity.annotatePores({ pores: result.pores, runs: result.runs, dims: vol.full, filled: body.filled, binnedDims: vol.dims, bin: vol.bin, voxelMm: vol.voxelMm, gray: vol.gray, poreThreshold: settings.poreThreshold, margin: settings.margin });
  result.pores = conn.pores;
  pores = result;
  pores.settings = settings;
  const { offsets, start, end, id, rows } = result.runs;
  postMessage({ type: 'pores', pores: result.pores, connectivity: conn.summary, settings, runs: { offsets, start: start.slice(), end: end.slice(), id: id.slice(), rows } });
  sendPatches();
}

/** The Dragonfly cross-check: VoxelBench's counting region and pore voxels (rejected voids left out) as runs, and,
    with another tool's mask runs, the comparison. */
function crosscheck({ type, runs, rejected, bodyMm3, smallMm3 }) {
  const M = self.VBMasks, full = vol.full, skip = new Set(rejected || []);
  const regionInput = { interior: poreCoarse.interior, edgeZone: poreCoarse.edgeZone, binnedDims: vol.dims, bin: vol.bin, fullDims: full };
  say('Cross-check: the counting region');
  const region = M.maskRuns((z) => M.regionSlice(regionInput, z), full);
  const ours = M.maskRuns((z) => M.runsSlice(pores.runs, full, z, skip), full);
  const count = (r) => { let n = 0; for (let k = 0; k < r.start.length; k++) n += r.end[k] - r.start[k]; return n; };
  if (type === 'regionRuns') return { region, pores: ours, regionVoxels: count(region), poreVoxels: count(ours) };
  say('Cross-check: comparing the masks');
  const compare = (b) => M.compareRuns({ a: ours, b, region, dims: full, voxelMm: vol.voxelMm, bodyMm3, smallMm3 });
  const result = compare(runs);
  if (result.dice === null || result.dice >= ORIENTATION_RETRY_BELOW) return { result };
  // Barely any overlap: the export may be flipped or in reverse slice order. Score all eight orientations on every
  // ORIENTATION_STEP-th slice and compare in full the one that fits clearly better.
  say('Cross-check: the masks barely overlap; trying the mask flipped and reversed');
  const best = M.bestOrientation(ours, runs, full, ORIENTATION_STEP);
  const asIs = M.overlapScore(ours, runs, full, ORIENTATION_STEP);
  if (!(best.flip.x || best.flip.y || best.flip.z) || best.score <= Math.max(asIs, ORIENTATION_RETRY_BELOW)) return { result: { ...result, orientation_scores: { as_is: asIs, best: best.score } } };
  say('Cross-check: comparing the mask turned back');
  return { result: { ...compare(M.flipRuns(runs, full, best.flip)), orientation: best.flip, orientation_scores: { as_is: asIs, best: best.score } } };
}

function sendPatches() {
  say('Segmenting low-density regions');
  coarse = Z.prepareCoarse({ runs: pores.runs, pores: pores.pores, gray: vol.gray, filled: body.filled, binnedDims: vol.dims, fullDims: vol.full, bin: vol.bin, step: COARSE_STEP, voxelMm: vol.voxelMm, circle: vol.circle });
  voidShare = coarse.voidShare;
  zoneReady = null;
  const found = Z.findPatches({ gray: coarse.gray, voids: voidShare, weight: coarse.weight, scanDepth: coarse.scanDepth, body: coarse.body, dims: coarse.dims, airGray, voxelMm: coarse.voxelMm, settings: Z.DEFAULT_PATCH_SETTINGS });
  const toFull = (i) => (i + 0.5) * coarse.factor - 0.5;
  const list = found.patches.map((p) => ({ ...p, x: toFull(p.x), y: toFull(p.y), z: toFull(p.z), x_mm: toFull(p.x) * vol.voxelMm, y_mm: toFull(p.y) * vol.voxelMm, z_mm: toFull(p.z) * vol.voxelMm }));
  patchLabels = found.labels;
  solidGray = found.solidGray;
  postMessage({ type: 'patches', patches: list, labels: found.labels.slice(), dims: coarse.dims, factor: coarse.factor, solidGray: found.solidGray });
}

// Review-sheet settings, matching ct_pipeline: projection columns under 1.5 mm are blank; 3D surfaces only for pores of
// 2 mm ESD and up; sweep the pore threshold (and the air-matrix midpoint) and the mask threshold, not the smoothing.
const SHEET = { minColumnMm: 1.5, openMm: 0.5, sliceShare: 0.02, surfaceEdgesMm: [2, 4], poreThresholds: [1100, 1200, 1400, 1500], bodyThresholds: [1300, 1500] };

function variantSummary(settings, crops, rejected) {
  const crop = P.cropMask(crops, vol.dims, vol.bin);
  const sameBody = settings.bodyThreshold === pores.settings.bodyThreshold;
  // Another mask threshold: the same holder pieces (with their runtime STL masks) cut from the new solid, never found again.
  const b = sameBody ? body : P.buildBody(vol.gray, vol.outside, vol.dims, settings, crop, { pieces: holder.pieces, givenBack: holder.givenBack, method: holder.method, voxelMm: vol.bin * vol.voxelMm });
  let filled = 0;
  for (let i = 0; i < b.filled.length; i++) filled += b.filled[i];
  const c = P.detectPores(vol.gray, vol.outside, vol.dims, b, settings, { bin: vol.bin, voxelMm: vol.voxelMm });
  const f = P.fineDetect({ dims: vol.full, bin: vol.bin, settings, voxelMm: vol.voxelMm, coarse: c, binnedDims: vol.dims, getSmoothed: (z) => smoothed[z] });
  const bodyMm3 = filled * (vol.bin * vol.voxelMm) ** 3;
  const s = P.summarize(f.pores, bodyMm3, new Set());
  return { all_void_percent: s.all_void_percent_of_body, body_mm3: bodyMm3, regions: f.pores.length };
}

function sendSheet({ settings, crops, rejected, zoneThreshold, zoneBaseline }) {
  const rej = new Set(rejected);
  say('Review sheet: projection and profile');
  const radius = Math.max(1, Math.round(SHEET.openMm / coarse.voxelMm));
  const clean = D.sliceAreaFilter(P.boxDilate(P.boxErode(coarse.body, coarse.dims, radius), coarse.dims, radius), coarse.dims, SHEET.sliceShare);
  for (let i = 0; i < clean.length; i++) if (!coarse.body[i]) clean[i] = 0;
  const projection = Float32Array.from(D.columnPorosity(voidShare, clean, coarse.dims, coarse.voxelMm, SHEET.minColumnMm));
  const f = coarse.factor;
  const extents = D.extents(clean, coarse.dims, coarse.voxelMm, vol.circle ? { cx: vol.circle.cx / f, cy: vol.circle.cy / f, r: vol.circle.r / f } : null);
  const profile = D.axialProfile(voidShare, coarse.body, coarse.gray, coarse.weight, coarse.dims, coarse.voxelMm);
  const input = { gray: coarse.gray, voids: voidShare, weight: coarse.weight, scanDepth: coarse.scanDepth, body: coarse.body, dims: coarse.dims, airGray, voxelMm: coarse.voxelMm, settings: { ...Z.DEFAULT_ZONE_SETTINGS, baseline: zoneBaseline || Z.DEFAULT_ZONE_SETTINGS.baseline } };
  readyFor(input);
  const histogram = zoneReady.refused ? null : Z.offsetHistogram(zoneReady, coarse.voxelMm);
  const automatic = zoneReady.refused ? null : Z.finishZones(zoneReady, input).threshold ?? null;
  say('Review sheet: large-pore surfaces');
  const bySize = Z.voidSizeMasks({ runs: pores.runs, pores: pores.pores, rejected: rej, dims: vol.full, factor: MESH_FACTOR, edges: [...SHEET.surfaceEdgesMm, Infinity] });
  const surfaces = bySize.masks.map((m) => surfaceOf(m, bySize.dims, MESH_FACTOR));
  const midpoint = Math.round((airGray + solidGray) / 2);
  const sweep = [];
  const values = [...SHEET.poreThresholds, midpoint].filter((v) => v !== settings.poreThreshold);
  values.forEach((v, k) => {
    say(`Review sheet: threshold sweep ${k + 1} of ${values.length + SHEET.bodyThresholds.length}`);
    sweep.push({ parameter: 'poreThreshold', value: v, ...variantSummary({ ...settings, poreThreshold: v }, crops, rej) });
  });
  SHEET.bodyThresholds.filter((v) => v !== settings.bodyThreshold).forEach((v, k) => {
    say(`Review sheet: threshold sweep ${values.length + k + 1} of ${values.length + SHEET.bodyThresholds.length}`);
    sweep.push({ parameter: 'bodyThreshold', value: v, ...variantSummary({ ...settings, bodyThreshold: v }, crops, rej) });
  });
  const buffers = [projection.buffer, ...surfaces.flatMap((m) => [m.positions.buffer, m.indices.buffer])];
  postMessage({ type: 'sheet', extents, projection, coarseDims: coarse.dims, coarseVoxelMm: coarse.voxelMm, profile, histogram, automaticThreshold: automatic, zoneThreshold, surfaces, surfaceEdgesMm: SHEET.surfaceEdgesMm,
    sweep, midpoint, airGray, solidGray, minColumnMm: SHEET.minColumnMm }, buffers);
  say('Review sheet data ready');
}

function surfaceOf(mask, dims, factor) {
  const { positions, indices } = P.surfaceNets(mask, dims);
  for (let i = 0; i < positions.length; i++) positions[i] *= factor;
  return { positions, indices };
}

function sendVoidMeshes({ rejected, minDiameterMm }) {
  say('Building 3D pore surfaces');
  const { masks, dims } = Z.voidClassMasks({ runs: pores.runs, pores: pores.pores, rejected: new Set(rejected), dims: vol.full, factor: MESH_FACTOR, minDiameterMm });
  const meshes = {};
  for (const key of Object.keys(masks)) meshes[key] = surfaceOf(masks[key], dims, MESH_FACTOR);
  const patchMask = new Uint8Array(patchLabels.length);
  for (let i = 0; i < patchMask.length; i++) if (patchLabels[i]) patchMask[i] = 1;
  meshes.patch = surfaceOf(patchMask, coarse.dims, coarse.factor);
  const buffers = Object.values(meshes).flatMap((m) => [m.positions.buffer, m.indices.buffer]);
  postMessage({ type: 'voidMeshes', meshes, cellMm: MESH_FACTOR * vol.voxelMm }, buffers);
}

// The threshold-free zone step is kept until the coarse data or the baseline method changes.
function readyFor(input) {
  const key = input.settings.baseline;
  if (!zoneReady || zoneReady.requested !== key) { zoneReady = Z.prepareZones(input); zoneReady.requested = key; }
}

function sendZones({ threshold, regions, labelIds, baseline }) {
  say('Segmenting gray-value zones');
  const settings = { ...Z.DEFAULT_ZONE_SETTINGS, threshold: threshold ?? undefined, baseline: baseline || Z.DEFAULT_ZONE_SETTINGS.baseline };
  const input = { gray: coarse.gray, voids: voidShare, weight: coarse.weight, scanDepth: coarse.scanDepth, body: coarse.body, dims: coarse.dims, airGray, voxelMm: coarse.voxelMm, settings };
  readyFor(input);
  const draft = zoneReady.refused ? { refused: zoneReady.refused, zones: null } : Z.finishZones(zoneReady, input);
  if (draft.refused) { postMessage({ type: 'zones', refused: draft.refused }); return; }
  const painted = Z.paintZones(draft.zones, coarse.dims, coarse.factor, regions, labelIds || []);
  const byZone = new Map(draft.stats.map((s) => [s.zone, s]));
  const stats = Z.zoneTotals(painted, voidShare, coarse.voxelMm).map((t) => ({ solid_gray_mean: null, excess_median: null, ...byZone.get(t.zone), ...t }));
  postMessage({ type: 'zones', refused: null, map: painted, dims: coarse.dims, factor: coarse.factor, threshold: draft.threshold, axis: draft.axis, baseline: draft.baseline, method: draft.method, stats }, [painted.buffer]);
}

// ---------- 3D figures (vb_figure.js): the phase label volume on a grid of about 80 µm, a cutaway and a see-through view.
let figurePending = null; // a figure waiting for the page's finer gray grid
function sendFigure(data) {
  const F = self.VBFigure, baseMm = vol.bin * vol.voxelMm;
  if (airGray === null) airGray = R.estimateAirGray(vol.gray, vol.outside, body.filled);
  const box = F.boundsOf(body.filled, vol.dims, Math.ceil(2 / baseMm));
  if (!box) throw new Error('The sample mask is empty: there is no part to draw.');
  const span = { nx: box.x1 - box.x0 + 1, ny: box.y1 - box.y0 + 1, nz: box.z1 - box.z0 + 1 };
  // The loaded grid is finer than the worker's: ask the page for a block mean of its slices at about 80 µm.
  const fine = F.planFactor(vol.voxelMm, { nx: span.nx * vol.bin, ny: span.ny * vol.bin, nz: span.nz * vol.bin });
  if (fine < vol.bin) {
    const lbox = { x0: box.x0 * vol.bin, y0: box.y0 * vol.bin, z0: box.z0 * vol.bin, x1: Math.min(vol.full.nx - 1, (box.x1 + 1) * vol.bin - 1), y1: Math.min(vol.full.ny - 1, (box.y1 + 1) * vol.bin - 1), z1: Math.min(vol.full.nz - 1, (box.z1 + 1) * vol.bin - 1) };
    figurePending = { data, box: lbox, s: fine };
    say('3D figure: reading the slices at the figure grid');
    postMessage({ type: 'figureNeed', id: data.id, box: lbox, s: fine });
    return;
  }
  const s = F.planFactor(baseMm, span);
  const grid = F.blockGrid({ gray: vol.gray, envelope: body.filled, outside: vol.outside, dims: vol.dims, box, s });
  const zMm = new Float32Array(grid.dims.nz);
  for (let z = 0; z < zMm.length; z++) zMm[z] = (box.z0 + (z + 0.5) * s) * baseMm;
  finishFigure(data, grid, baseMm * s, zMm, s * vol.bin);
}

function figureGrid({ gray, outside, dims }) {
  const F = self.VBFigure, { data, box, s } = figurePending;
  figurePending = null;
  const envelope = F.maskOnGrid(body.filled, vol.dims, vol.bin, box, s, dims);
  const zMm = new Float32Array(dims.nz);
  for (let z = 0; z < zMm.length; z++) zMm[z] = (box.z0 + (z + 0.5) * s) * vol.voxelMm;
  finishFigure(data, { gray, envelope, outside, dims }, vol.voxelMm * s, zMm, s);
}

function finishFigure({ id, options }, grid, cellMm, zMm, factor) {
  const F = self.VBFigure, baseMm = vol.bin * vol.voxelMm, s = factor;
  const r = F.classify({ gray: grid.gray, envelope: grid.envelope, outside: grid.outside, dims: grid.dims, cellMm, airGray, denseGray: options.denseGray,
    zMm: options.coneBand === false ? null : zMm, scanMm: vol.dims.nz * baseMm, options: options.classify || {}, progress: (t) => say(`3D figure: ${t}`) });
  say('3D figure: dense core');
  const n = r.labels.length, clump = new Uint8Array(n);
  let dopedPores = 0;
  for (let i = 0; i < n; i++) { if (r.labels[i] === F.CODE.CLUMP) clump[i] = 1; else if (r.labels[i] === F.CODE.DOPED_PORE) dopedPores++; }
  const core = F.denseCore({ rho: r.rho, envelope: grid.envelope, clump, dims: grid.dims, cellMm, fillAxis: options.fieldAxis === 'y' ? 'y' : 'x', options: options.classify || {} }).core;
  say('3D figure: enclosed gas');
  const open = F.closePores(r.labels, grid.dims);
  let enclosed = 0;
  for (let i = 0; i < n; i++) if (r.labels[i] === F.CODE.DOPED_PORE) enclosed++;
  const stats = F.figureStats({ labels: r.labels, rho: r.rho, cellMm, openVoxels: open, openDopedVoxels: dopedPores - enclosed, core, baseDensity: options.baseDensity, dopedMassFactor: options.dopedMassFactor });
  say('3D figure: rendering');
  const frame = F.toFigureFrame(r.labels, grid.dims, { fieldAxis: options.fieldAxis, upIsLowZ: options.upIsLowZ !== false });
  const R3 = F.rotate(frame.labels, frame.dims, F.VIEW.az);
  const cutView = F.opaque(F.cutQuarter(R3.labels, R3.dims).labels, R3.dims);
  const cb = F.maskBox(cutView.mask, cutView.width, cutView.height, 10);
  const cut = F.toRGBA(cutView.rgb, cutView.width, cb);
  const cutLabels = new Uint8Array(cut.width * cut.height);
  for (let y = 0; y < cut.height; y++) cutLabels.set(cutView.labels.subarray((y + cb.y0) * cutView.width + cb.x0, (y + cb.y0) * cutView.width + cb.x1), y * cut.width);
  const anchors = F.anchors(cutLabels, cut.width, cut.height, cellMm);
  const see = F.xray(R3.labels, R3.dims);
  const xb = F.maskBox(see.mask, see.width, see.height, 12) || { x0: 0, y0: 0, x1: see.width, y1: see.height };
  const xr = F.toRGBA(see.rgb, see.width, xb);
  const half = F.halve(frame.labels, frame.dims);
  const turn = { runs: F.encode(half.labels), dims: half.dims, cellMm: cellMm * 2 };
  say('3D figure ready');
  postMessage({ type: 'figure', id, cellMm, factor: s, stats, scale: r.scale, cupping: r.cupping, clumps: r.clumps, clustered: r.clustered, notes: r.notes,
    cut: { data: cut.data, width: cut.width, height: cut.height }, anchors, field: F.fieldOnScreen(R3.field), xray: { data: xr.data, width: xr.width, height: xr.height }, turn },
  [cut.data.buffer, xr.data.buffer, turn.runs.buffer]);
}

/** Turntable frames of one or more saved figure grids: 120 see-through views a full turn apart, each sample cropped to
    the box its frames share. Posted one frame at a time ('figureFrame'), then 'figureTurn'. */
function sendTurntable({ id, grids, frames = 120 }) {
  const F = self.VBFigure, el = (F.VIEW.el * Math.PI) / 180, t = Math.tan(el), cs = Math.cos(el);
  // The box every frame of a sample fits: the part's widest radius about the turning axis and its height.
  const samples = grids.map((g) => {
    const { nx, ny, nz } = g.dims, L = F.decode(g.runs, nx * ny * nz), side = Math.ceil(Math.hypot(nx, ny)) + 2;
    let r = 0, z0 = nz, z1 = -1;
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (!L[i]) continue;
      r = Math.max(r, Math.hypot(x - (nx - 1) / 2, y - (ny - 1) / 2)); if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const o = (side - 1) / 2, H = Math.floor(nz + side * t) + 2, pad = 3;
    const vLo = z0 + Math.round((o - r) * t) - pad, vHi = z1 + Math.round((o + r) * t) + pad;
    const box = { x0: Math.max(0, Math.floor(o - r) - pad), x1: Math.min(side, Math.ceil(o + r) + pad + 1),
      y0: Math.max(0, Math.floor((H - 1 - vHi) * cs)), y1: Math.min(Math.round(H * cs), Math.ceil((H - 1 - vLo + 1) * cs) + 1) };
    return { L, dims: g.dims, side, box };
  });
  for (let f = 0; f < frames; f++) {
    if (f % 10 === 0) say(`Turntable: frame ${f + 1} of ${frames}`);
    const images = samples.map((smp) => {
      const R3 = F.rotate(smp.L, smp.dims, (360 * f) / frames, smp.side);
      const v = F.xray(R3.labels, R3.dims, F.VIEW.el, F.TURN_ALPHA);
      return F.toRGBA(v.rgb, v.width, { ...smp.box, y1: Math.min(v.height, smp.box.y1) });
    });
    postMessage({ type: 'figureFrame', id, frame: f, images }, images.map((o) => o.data.buffer));
  }
  say('Turntable ready');
  postMessage({ type: 'figureTurn', id, frames });
}

onmessage = ({ data }) => {
  try {
    if (data.type === 'volume') {
      vol = data;
      body = null; smoothed = null; smoothedSigma = null; pores = null; coarse = null; zoneReady = null; patchLabels = null; holder = null;
      ensureBody(data);
      sendModel();
    } else if (data.type === 'model') {
      if (ensureBody(data)) sendModel();
      postMessage({ type: 'modelDone' });
    } else if (data.type === 'detect') {
      if (ensureBody(data)) sendModel();
      if (smoothedSigma === data.settings.fineSigma && smoothed) { finishDetect(data); return; }
      pending = data;
      smoothed = new Array(vol.full.nz);
      smoother = P.createSliceSmoother(vol.full, data.settings.fineSigma, (z, s) => {
        const u = new Uint16Array(s.length);
        for (let i = 0; i < s.length; i++) u[i] = s[i];
        smoothed[z] = u;
      });
      smoothedSigma = data.settings.fineSigma;
      postMessage({ type: 'needSlices' });
    } else if (data.type === 'slice') {
      smoother(data.pixels);
      postMessage({ type: 'sliceDone', z: data.z });
    } else if (data.type === 'slicesDone') {
      smoother = null;
      finishDetect(pending);
    } else if (data.type === 'voidMeshes') {
      sendVoidMeshes(data);
    } else if (data.type === 'zones') {
      sendZones(data);
    } else if (data.type === 'sheet') {
      sendSheet(data);
    } else if (data.type === 'wall') {
      if (ensureBody(data)) sendModel();
      postMessage({ type: 'wall', id: data.id, ...self.VBWall.wallReport(body.filled, vol.dims, vol.bin, vol.voxelMm) });
    } else if (data.type === 'partMask') {
      // The sample mask, for leveling the part; a copy, so the worker keeps its own.
      if (ensureBody(data)) sendModel();
      const mask = body.filled.slice();
      postMessage({ type: 'partMask', id: data.id, mask, dims: vol.dims, bin: vol.bin }, [mask.buffer]);
    } else if (data.type === 'regionRuns' || data.type === 'crosscheck') {
      if (!pores || !poreCoarse) throw new Error('Segment pores first: the cross-check compares against that segmentation.');
      postMessage({ type: data.type, id: data.id, ...crosscheck(data) });
    } else if (data.type === 'filler') {
      if (ensureBody(data)) sendModel();
      if (!smoothed || smoothedSigma !== data.settings.fineSigma || smoothed.length !== vol.full.nz || !smoothed[vol.full.nz - 1]) {
        postMessage({ type: 'filler', id: data.id, refused: 'Segment pores first: the filler analysis reads the smoothed slices that step makes.' });
        return;
      }
      const r = self.VBFiller.analyzeFiller({ getSlice: (z) => smoothed[z], dims: vol.full, filled: body.filled, binnedDims: vol.dims, bin: vol.bin, voxelMm: vol.voxelMm, circle: vol.circle,
        poreThreshold: data.settings.poreThreshold, k: data.k, minVoxels: data.minVoxels, threshold: data.threshold });
      postMessage({ type: 'filler', id: data.id, ...r }, r.nn_mm ? [r.nn_mm.buffer] : []);
    } else if (data.type === 'figure') {
      if (ensureBody(data)) sendModel();
      sendFigure(data);
    } else if (data.type === 'figureGrid') {
      if (figurePending && figurePending.data.id === data.id) figureGrid(data);
    } else if (data.type === 'figureTurn') {
      sendTurntable(data);
    } else if (data.type === 'cad') {
      if (ensureBody(data)) sendModel();
      const r = self.VBCad.compareToCad({ gray: vol.gray, filled: body.filled, dims: vol.dims, bin: vol.bin, voxelMm: vol.voxelMm, circle: vol.circle, airGray,
        poreThreshold: data.settings.poreThreshold, points: data.points, normals: data.normals, edge: data.edge || null, weight: data.weight || null, pose: data.pose || null, ...data.options });
      const { points, normals, edge, weight, ...out } = r;
      postMessage({ type: 'cad', id: data.id, ...out }, out.deviations ? [out.deviations.buffer] : []);
    }
  } catch (e) {
    postMessage({ type: 'error', for: data && data.type, stage: e.stage || null, message: e.name === 'RangeError' ? 'The browser ran out of memory for this step.' : e.message });
  }
};
