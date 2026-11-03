/* Runs pore detection off the page's main thread. The main thread sends the binned volume once, and sends full-
   resolution slices only when the smoothing changes; smoothed slices are kept here so threshold reruns are quick. */
importScripts('ct_core.js', 'ct_pores.js', 'ct_regions.js', 'ct_zones.js', 'ct_sheetdata.js', 'vb_connectivity.js');
const P = self.CTPores, R = self.CTRegions, Z = self.CTZones, D = self.CTSheetData;
const MODEL_DOWNSAMPLE = 2;
const COARSE_STEP = 2; // binned voxels per coarse cell: 4 full voxels, about 0.16 mm at 40 um
const MESH_FACTOR = 2; // full voxels per cell of the 3D void surfaces, about 0.08 mm at 40 um
let vol = null, body = null, bodyKey = '', smoothed = null, smoothedSigma = null, pending = null, pores = null, smoother = null;
let coarse = null, voidShare = null, zoneReady = null, airGray = null, patchLabels = null, solidGray = null;

const say = (text) => postMessage({ type: 'status', text });

function ensureBody(settings, crops) {
  const key = JSON.stringify([settings.sigma, settings.bodyThreshold, settings.closeRadius, crops.map((c) => [c.plane, c.points])]);
  if (key === bodyKey && body) return false;
  say('Building the sample mask');
  const crop = P.cropMask(crops, vol.dims, vol.bin);
  body = P.buildBody(vol.gray, vol.outside, vol.dims, settings, crop);
  bodyKey = key;
  return true;
}

function sendModel() {
  let filled = 0;
  for (let i = 0; i < body.filled.length; i++) filled += body.filled[i];
  const small = P.downsampleMask(body.filled, vol.dims, MODEL_DOWNSAMPLE);
  const { positions, indices } = P.surfaceNets(small.mask, small.dims);
  for (let i = 0; i < positions.length; i++) positions[i] *= vol.bin * MODEL_DOWNSAMPLE;
  airGray = R.estimateAirGray(vol.gray, vol.outside, body.filled);
  postMessage({ type: 'model', positions, indices, bodyMm3: filled * (vol.bin * vol.voxelMm) ** 3, airGray }, [positions.buffer, indices.buffer]);
}

function finishDetect({ settings }) {
  say('Coarse segmentation on the binned volume');
  const coarse = P.detectPores(vol.gray, vol.outside, vol.dims, body, settings, { bin: vol.bin, voxelMm: vol.voxelMm });
  say('Fine segmentation on the loaded grid');
  const result = P.fineDetect({ dims: vol.full, bin: vol.bin, settings, voxelMm: vol.voxelMm, coarse, binnedDims: vol.dims, getSmoothed: (z) => smoothed[z] });
  say('Open and closed pores, networks, sphericity');
  const conn = self.VBConnectivity.annotatePores({ pores: result.pores, runs: result.runs, dims: vol.full, filled: body.filled, binnedDims: vol.dims, bin: vol.bin, voxelMm: vol.voxelMm });
  result.pores = conn.pores;
  pores = result;
  pores.settings = settings;
  const { offsets, start, end, id, rows } = result.runs;
  postMessage({ type: 'pores', pores: result.pores, connectivity: conn.summary, runs: { offsets, start: start.slice(), end: end.slice(), id: id.slice(), rows } });
  sendPatches();
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
  const b = sameBody ? body : P.buildBody(vol.gray, vol.outside, vol.dims, settings, crop);
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

onmessage = ({ data }) => {
  try {
    if (data.type === 'volume') {
      vol = data;
      body = null; smoothed = null; smoothedSigma = null; pores = null; coarse = null; zoneReady = null; patchLabels = null;
      ensureBody(data.settings, data.crops);
      sendModel();
    } else if (data.type === 'model') {
      if (ensureBody(data.settings, data.crops)) sendModel();
      postMessage({ type: 'modelDone' });
    } else if (data.type === 'detect') {
      if (ensureBody(data.settings, data.crops)) sendModel();
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
    }
  } catch (e) {
    postMessage({ type: 'error', message: e.name === 'RangeError' ? 'The browser ran out of memory for this step.' : e.message });
  }
};
