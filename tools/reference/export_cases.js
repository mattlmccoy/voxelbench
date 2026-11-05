'use strict';
/* Writes the synthetic test scans as TIFF folders with their known truth and VoxelBench's own results (the headless
   pipeline, the same code the page runs), for the independent Python reference (vb_reference.py) to check.
   Usage: node tools/reference/export_cases.js <out-dir> [scan-folder] — with a scan folder (a real scan), only the
   VoxelBench results for it are written (no truth), next to nothing else: the TIFFs are read in place. */
const fs = require('node:fs');
const path = require('node:path');
const CT = require('../../app/ct_core.js');
const S = require('../../app/vb_synthetic.js');
const St = require('../../app/vb_stl.js');
const D = require('../../app/vb_deviation.js');
const K = require('../../app/vb_connectivity.js');
const H = require('../headless_run.js');

const SETTINGS = { poreThreshold: 1350, closeShape: 'ball' }; // today's default closing, stated: a headless run without it replays the old box

async function writeScan(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f.name), Buffer.from(await f.arrayBuffer()));
}

/** The numbers both sides compute, from VoxelBench's pipeline. */
function results(a, { cad = null } = {}) {
  const summary = a.summary, split = K.openClosed(a.connectivity.pores, a.base.bodyMm3, a.rejected);
  const filler = H.analyzeFiller(a, {}), wall = H.analyzeWall(a);
  const out = {
    settings: a.settings, voxel_mm: a.voxelMm, bin: H.BIN, circle: a.circle,
    porosity_percent: summary.all_void_percent_of_body, pore_count: a.base.result.pores.length, mask_mm3: a.base.bodyMm3,
    open_percent: split.open_percent, closed_percent: split.closed_percent,
    filler: filler.refused ? null : { count: filler.summary.count, volume_percent: filler.summary.volume_percent, fibers: filler.summary.fibers, threshold: filler.threshold.threshold,
      orientation: filler.summary.orientation.too_few ? null : { eigenvalues: filler.summary.orientation.eigenvalues, direction: filler.summary.orientation.direction } },
    wall: { median_mm: wall.stats.p50_mm, max_mm: wall.stats.max_mm, min_mm: wall.stats.min_mm },
  };
  if (cad) {
    // Deviation of the nominal at its true pose, from the binned gray: the Python side samples the same points.
    const mesh = St.parseStl(cad.stl), m = St.measurePoints(mesh, { spacing: 0.08 });
    const level = D.isoLevel(a.airGray, D.matrixGray(a.vol.gray, a.base.body.filled, a.settings.poreThreshold));
    const air = D.exteriorAir(a.vol.gray, a.vol.dims, level, a.base.body.filled);
    const dev = D.deviations({ gray: a.vol.gray, dims: a.vol.dims, bin: H.BIN, voxelMm: a.voxelMm, level, points: m.points, normals: m.normals, edge: m.edge, air, transform: cad.pose, rangeMm: 1 });
    out.cad = { level, pose: cad.pose, points: Array.from(m.points), normals: Array.from(m.normals), edge: Array.from(m.edge), deviations: Array.from(dev, (v) => (Number.isFinite(v) ? v : null)) };
  }
  return out;
}

async function main() {
  const [out, real] = process.argv.slice(2);
  if (!out) throw new Error('usage: node tools/reference/export_cases.js <out-dir> [scan-folder]');
  fs.mkdirSync(out, { recursive: true });
  if (real) {
    const run = { settings: { closeShape: 'ball' } }; // the page's defaults
    const a = H.analyze(H.readStack(real), run, { patches: false });
    fs.writeFileSync(path.join(out, 'real.json'), JSON.stringify({ folder: path.resolve(real), js: results(a) }));
    return;
  }
  const cases = [
    { name: 'filled', make: () => S.makeScan({ filler: true }) },
    { name: 'part', make: () => S.makePart({ scale: 0.97, bendMm: 0.12 }), cad: true },
  ];
  for (const c of cases) {
    const { files, truth } = c.make();
    const dir = path.join(out, c.name);
    await writeScan(path.join(dir, 'scan'), files);
    const a = H.analyze(H.readStack(path.join(dir, 'scan')), { settings: SETTINGS }, { patches: false });
    const js = results(a, c.cad ? { cad: { stl: S.partStl(), pose: truth.pose } } : {});
    const { pores, ...truthOut } = truth;
    fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify({ name: c.name, truth: truthOut, js }));
  }
}

main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
