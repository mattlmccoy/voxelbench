/* Runs the viewer's own detection on a scan folder without a browser, with a saved run's crop and settings, and sweeps
   the settings that move the void percent. The report reads this output, so its numbers are the page's numbers.
   Usage: node --max-old-space-size=12000 headless_run.js <scan folder> <saved run JSON> <output folder> [--no-sweep] */
'use strict';
const fs = require('fs');
const path = require('path');
const CT = require('../app/ct_core.js');
const P = require('../app/ct_pores.js');
const R = require('../app/ct_regions.js');
const Z = require('../app/ct_zones.js');
const K = require('../app/vb_connectivity.js');
const St = require('../app/vb_stl.js');
const Cad = require('../app/vb_cad.js');

const BIN = 2, COARSE_STEP = 2;
const SWEEP = { poreThreshold: [1100, 1200, 1400, 1500], fineSigma: [0.75, 1.25], bodyThreshold: [1300, 1500] };
const RENDER_SIZE_EDGES_MM = [0.5, 1, 2, 4, Infinity];
const ZONE_THRESHOLDS = [0.02, 0.03, 0.04, 0.05, 0.06, 0.075, 0.09, 0.11];
// Progress lines only when run from the command line, not when tests require this file.
const log = (text) => { if (require.main === module) console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`); };

function readStack(folder) {
  const names = fs.readdirSync(folder).filter((n) => /\.tiff?$/i.test(n)).sort();
  let voxelMm = null, width = 0, height = 0;
  const slices = names.map((n) => {
    const b = fs.readFileSync(path.join(folder, n));
    const t = CT.parseTiff(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    voxelMm = t.voxelMm; width = t.width; height = t.height;
    return t.pixels;
  });
  return { slices, voxelMm, dims: { nx: width, ny: height, nz: slices.length } };
}

function smoothAll(slices, dims, sigma) {
  const out = new Array(dims.nz);
  const push = P.createSliceSmoother(dims, sigma, (z, s) => {
    const u = new Uint16Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s[i];
    out[z] = u;
  });
  for (const s of slices) push(s);
  return out;
}

function detect({ vol, dims, voxelMm, settings, crops, smoothed }) {
  const crop = P.cropMask(crops, vol.dims, BIN);
  const body = P.buildBody(vol.gray, vol.outside, vol.dims, settings, crop);
  let filled = 0;
  for (let i = 0; i < body.filled.length; i++) filled += body.filled[i];
  const coarse = P.detectPores(vol.gray, vol.outside, vol.dims, body, settings, { bin: BIN, voxelMm });
  const result = P.fineDetect({ dims, bin: BIN, settings, voxelMm, coarse, binnedDims: vol.dims, getSmoothed: (z) => smoothed[z] });
  return { body, result, bodyMm3: filled * (BIN * voxelMm) ** 3 };
}

/** The viewer's own pipeline on one stack with a saved run's crop and settings: segmentation, then (unless
    patches: false) low-density regions and zones. The zone baseline is the run's method, else 'ends' (version 10
    runs record none and used the end baseline). */
function analyze({ slices, voxelMm, dims }, run, { patches: withPatches = true, zoneBaseline } = {}) {
  const crops = run.crops || [];
  const settings = { ...P.DEFAULT_SETTINGS, ...run.settings };
  const circle = CT.fitCircle(slices[dims.nz >> 1], dims.nx, dims.ny);
  const vol = P.binVolume(slices, dims, BIN, circle);
  log('Smoothing at full resolution');
  const smoothed = smoothAll(slices, dims, settings.fineSigma);
  log('Base detection');
  const base = detect({ vol, dims, voxelMm, settings, crops, smoothed });
  const rejected = P.rejectedAfterRerun(run.rejected_voxels || [], base.result.runs, dims);
  const summary = P.summarize(base.result.pores, base.bodyMm3, rejected);
  const airGray = R.estimateAirGray(vol.gray, vol.outside, base.body.filled);
  log(`Base: ${summary.all_void_percent_of_body.toFixed(3)} % void, ${base.result.pores.length} regions`);
  const connectivity = K.annotatePores({ pores: base.result.pores, runs: base.result.runs, dims, filled: base.body.filled, binnedDims: vol.dims, bin: BIN, voxelMm, gray: vol.gray, poreThreshold: settings.poreThreshold, margin: settings.margin });
  const out = { settings, crops, circle, vol, voxelMm, smoothed, base, rejected, summary, airGray, connectivity };
  if (!withPatches) return out;

  const coarse = Z.prepareCoarse({ runs: base.result.runs, pores: base.result.pores, gray: vol.gray, filled: base.body.filled, binnedDims: vol.dims, fullDims: dims, bin: BIN, step: COARSE_STEP, voxelMm, circle });
  const inputs = { gray: coarse.gray, voids: coarse.voidShare, weight: coarse.weight, scanDepth: coarse.scanDepth, body: coarse.body, dims: coarse.dims, airGray, voxelMm: coarse.voxelMm };
  const found = Z.findPatches({ ...inputs, settings: Z.DEFAULT_PATCH_SETTINGS });
  const toFull = (i) => (i + 0.5) * coarse.factor - 0.5;
  const patches = found.patches.map((p) => ({ ...p, x: toFull(p.x), y: toFull(p.y), z: toFull(p.z) }));
  log(`Patches: ${patches.length}. Zones next.`);
  const zoneSettings = { ...Z.DEFAULT_ZONE_SETTINGS, baseline: zoneBaseline || (run.zones && run.zones.method) || 'ends' };
  const zoneBase = { ...inputs, settings: zoneSettings };
  const ready = Z.prepareZones(zoneBase);
  const finish = (threshold) => (ready.refused ? { refused: ready.refused } : Z.finishZones(ready, { ...zoneBase, settings: { ...zoneSettings, threshold } }));
  const automatic = finish(undefined);
  const savedThreshold = run.zones && run.zones.threshold != null ? run.zones.threshold : automatic.threshold;
  const chosen = finish(savedThreshold);
  return { ...out, coarse, inputs, found, patches, ready, finish, automatic, chosen };
}

function main([folder, runPath, outDir]) {
  const parsed = JSON.parse(fs.readFileSync(runPath));
  const run = parsed.data || parsed;
  fs.mkdirSync(outDir, { recursive: true });
  log(`Reading ${folder}`);
  const { slices, voxelMm, dims } = readStack(folder);
  const a = analyze({ slices, voxelMm, dims }, run);
  const { settings, crops, circle, vol, base, rejected, summary, airGray, coarse, found, patches, ready, finish, automatic, chosen } = a;
  let { smoothed } = a;
  const toFull = (i) => (i + 0.5) * coarse.factor - 0.5;
  const zoneSweep = ready.refused ? [] : ZONE_THRESHOLDS.map((t) => ({ threshold: t, stats: finish(t).stats }));

  const write = (name, array) => fs.writeFileSync(path.join(outDir, name), Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  write('coarse_gray.f32', coarse.gray); write('coarse_weight.f32', coarse.weight); write('coarse_voids.f32', coarse.voidShare);
  write('coarse_body.u8', coarse.body); write('coarse_patches.u32', found.labels);
  if (chosen.zones) write('coarse_zones.u8', chosen.zones);

  // Surfaces for the 3D renders: the same meshes the viewer draws. Positions are full-resolution voxel coordinates.
  const writeMesh = (name, mask, meshDims, factor) => {
    const { positions, indices } = P.surfaceNets(mask, meshDims);
    for (let i = 0; i < positions.length; i++) positions[i] *= factor;
    write(`mesh_${name}.f32`, positions); write(`mesh_${name}.u32`, indices);
  };
  const part = P.downsampleMask(base.body.filled, vol.dims, 2);
  writeMesh('part', part.mask, part.dims, BIN * 2);
  const classes = Z.voidClassMasks({ runs: base.result.runs, pores: base.result.pores, rejected, dims, factor: BIN, minDiameterMm: 0 });
  for (const [name, mask] of Object.entries(classes.masks)) writeMesh(name, mask, classes.dims, BIN);
  // Pores by equivalent-diameter bin, for the 3D view colored by size.
  const bySize = Z.voidSizeMasks({ runs: base.result.runs, pores: base.result.pores, rejected, dims, factor: BIN, edges: RENDER_SIZE_EDGES_MM });
  bySize.masks.forEach((mask, k) => writeMesh(`size${k}`, mask, bySize.dims, BIN));
  const patchMask = new Uint8Array(found.labels.length);
  for (let i = 0; i < patchMask.length; i++) if (found.labels[i]) patchMask[i] = 1;
  writeMesh('patch', patchMask, coarse.dims, coarse.factor);

  // Slices through the middle of the part for the figures.
  const c = { x: 0, y: 0, z: 0, n: 0 };
  for (let z = 0, i = 0; z < coarse.dims.nz; z++) for (let y = 0; y < coarse.dims.ny; y++) for (let x = 0; x < coarse.dims.nx; x++, i++) if (coarse.body[i]) { c.x += x; c.y += y; c.z += z; c.n++; }
  const center = { x: Math.round(toFull(c.x / c.n)), y: Math.round(toFull(c.y / c.n)), z: Math.round(toFull(c.z / c.n)) };
  for (const [plane, slice] of [['XY', center.z], ['XZ', center.y], ['YZ', center.x]]) {
    const shape = CT.planeShape(plane, dims);
    write(`plane_${plane}_ids.u32`, P.planePoreIds(base.result.runs, dims, plane, slice, new Uint32Array(shape.width * shape.height)));
    write(`plane_${plane}_gray.u16`, CT.extractPlane(slices, dims, plane, slice));
  }

  const sweep = [{ parameter: 'base', value: null, all_void_percent: summary.all_void_percent_of_body, all_void_mm3: summary.all_void_volume_mm3, body_mm3: base.bodyMm3, regions: base.result.pores.length }];
  const addSweep = (parameter, value, got) => {
    const s = P.summarize(got.result.pores, got.bodyMm3, new Set());
    sweep.push({ parameter, value, all_void_percent: s.all_void_percent_of_body, all_void_mm3: s.all_void_volume_mm3, body_mm3: got.bodyMm3, regions: got.result.pores.length });
    log(`Sweep ${parameter}=${value}: ${s.all_void_percent_of_body.toFixed(3)} %`);
  };
  // The midpoint between air and solid gray: the usual rule for placing a surface in CT.
  const midpoint = Math.round((airGray + found.solidGray) / 2);
  if (process.argv.includes('--no-sweep')) SWEEP.poreThreshold.length = SWEEP.bodyThreshold.length = SWEEP.fineSigma.length = 0;
  for (const value of [...SWEEP.poreThreshold, midpoint]) addSweep('poreThreshold', value, detect({ vol, dims, voxelMm, settings: { ...settings, poreThreshold: value }, crops, smoothed }));
  for (const value of SWEEP.bodyThreshold) addSweep('bodyThreshold', value, detect({ vol, dims, voxelMm, settings: { ...settings, bodyThreshold: value }, crops, smoothed }));
  for (const value of SWEEP.fineSigma) {
    smoothed = smoothAll(slices, dims, value);
    addSweep('fineSigma', value, detect({ vol, dims, voxelMm, settings: { ...settings, fineSigma: value }, crops, smoothed }));
  }

  const strip = (z) => (z.refused ? { refused: z.refused } : { threshold: z.threshold, axis: z.axis, stats: z.stats, baseline: z.baseline });
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({
    schema: 1, folder: path.basename(folder), voxel_mm: voxelMm, stack_shape: dims, circle, settings, crops, air_gray: airGray, solid_gray: found.solidGray,
    summary, regions: base.result.pores.map((p) => ({ ...p, rejected: rejected.has(p.id) })), patches, zones_automatic: strip(automatic), zones_saved: strip(chosen), zone_labels: (run.zones && run.zones.labels) || {},
    zone_sweep: zoneSweep, sweep, center, render_size_edges_mm: RENDER_SIZE_EDGES_MM.slice(0, -1), offset_histogram: ready.refused ? null : Z.offsetHistogram(ready, coarse.voxelMm), coarse: { dims: coarse.dims, factor: coarse.factor, voxel_mm: coarse.voxelMm },
    saved_run: { created_at: run.created_at, summary: run.summary },
  }));
  log(`Wrote ${outDir}`);
}

if (require.main === module) main(process.argv.slice(2));

/** The CAD comparison on an analysis: the nominal mesh refined into measurement points (spacingMm, default 2
    analysis voxels; unitMm per file unit), then VBCad.compareToCad with the given options. */
function compareCad(a, mesh, { spacingMm, unitMm = 1, ...options } = {}) {
  const m = St.measurePoints(mesh, { spacing: spacingMm || 2 * BIN * a.voxelMm, unitMm });
  return Cad.compareToCad({ gray: a.vol.gray, filled: a.base.body.filled, dims: a.vol.dims, bin: BIN, voxelMm: a.voxelMm, circle: a.circle, airGray: a.airGray,
    poreThreshold: a.settings.poreThreshold, points: m.points, normals: m.normals, ...options });
}

module.exports = { analyze, compareCad, detect, readStack, smoothAll, BIN, COARSE_STEP };
