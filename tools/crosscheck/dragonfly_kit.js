'use strict';
/* The Dragonfly 3D cross-check kit: VoxelBench's counting region and pore voxels for one scan, as 8-bit TIFF stacks the
   same size as the scan, plus kit.json with everything Dragonfly needs to repeat the segmentation.
   Usage: node tools/crosscheck/dragonfly_kit.js <scan-folder> <saved-run.json> <out-dir>
   Spec and protocol: docs/plans/2026-11-03-dragonfly-crosscheck.md, docs/DRAGONFLY_CROSSCHECK.md. */
const fs = require('node:fs');
const path = require('node:path');
const CT = require('../../app/ct_core.js');
const H = require('../headless_run.js');
const M = require('./masks.js');

/** The kit for an analysis from headless_run.analyze: region and pore slices, and the facts for kit.json. */
function buildKit(a) {
  const { dims, voxelMm, settings, base, rejected } = a;
  const regionInput = { interior: base.coarse.interior, edgeZone: base.coarse.edgeZone, binnedDims: a.vol.dims, bin: H.BIN, fullDims: dims };
  const regionSlice = (z) => M.regionSlice(regionInput, z);
  const poreSlice = (z) => M.poreSlice(base.result.runs, dims, z, rejected);
  let poreVoxels = 0, regionVoxels = 0;
  for (let z = 0; z < dims.nz; z++) {
    for (const v of poreSlice(z)) poreVoxels += v;
    for (const v of regionSlice(z)) regionVoxels += v;
  }
  const info = M.kitInfo({ dims, voxelMm, bin: H.BIN, settings, bodyMm3: base.bodyMm3, porosityPercent: a.summary.all_void_percent_of_body,
    voidCount: base.result.pores.length - rejected.size, rejectedCount: rejected.size, poreVoxels, regionVoxels });
  return { info, regionSlice, poreSlice };
}

const sliceName = (prefix, z) => `${prefix}_${String(z).padStart(4, '0')}.tif`;

/** Writes region/, voxelbench_pores/ and kit.json into dir. scanFiles: the scan's slice files in the order read. */
function writeKit(kit, dir, { scanFiles = [] } = {}) {
  const { nx, ny, nz } = kit.info.dims;
  for (const [sub, prefix, get] of [['region', 'region', kit.regionSlice], ['voxelbench_pores', 'pores', kit.poreSlice]]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (let z = 0; z < nz; z++) fs.writeFileSync(path.join(dir, sub, sliceName(prefix, z)), Buffer.from(M.writeMaskTiff(nx, ny, get(z), kit.info.voxel_mm)));
  }
  const info = { ...kit.info, created_at: new Date().toISOString(), scan_files: { first: scanFiles[0] || null, last: scanFiles[scanFiles.length - 1] || null, count: scanFiles.length } };
  fs.writeFileSync(path.join(dir, 'kit.json'), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

function main([scan, runPath, out]) {
  if (!scan || !runPath || !out) throw new Error('usage: node tools/crosscheck/dragonfly_kit.js <scan-folder> <saved-run.json> <out-dir>');
  const parsed = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const run = parsed.data || parsed;
  const scanFiles = CT.sliceOrder(fs.readdirSync(scan)); // the order readStack uses
  const a = H.analyze(H.readStack(scan), run, { patches: false });
  const info = writeKit(buildKit(a), out, { scanFiles });
  const v = info.voxelbench;
  process.stdout.write(`Kit written to ${out}\n  ${info.dims.nx} x ${info.dims.ny} x ${info.dims.nz} voxels, ${info.voxel_mm} mm\n`
    + `  porosity ${v.all_void_percent_of_body.toFixed(3)} % (${v.void_count} voids, ${v.pore_voxels} voxels), threshold ${info.settings.poreThreshold}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.stack}\n`); process.exit(1); }
}

module.exports = { buildKit, writeKit };
