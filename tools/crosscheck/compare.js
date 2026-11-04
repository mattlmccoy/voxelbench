'use strict';
/* Compares a pore mask exported from Dragonfly 3D with VoxelBench's, from a kit written by dragonfly_kit.js.
   Usage: node tools/crosscheck/compare.js <kit-dir> <dragonfly-pores: folder of slices or one multi-page TIFF> [label]
   Writes comparison_<label>.json into the kit and prints the report. */
const fs = require('node:fs');
const path = require('node:path');
const M = require('./masks.js');

const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const read = (file) => { const b = fs.readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };

/** A mask stack as getSlice(z) and its slice count: a folder holds one slice per file (in natural name order), a file
    holds every slice as a page. */
function openStack(where, { nx, ny }) {
  let count, getPage;
  if (fs.statSync(where).isDirectory()) {
    const files = fs.readdirSync(where).filter((n) => /\.tiff?$/i.test(n) && !n.startsWith('.')).sort(natural);
    count = files.length;
    getPage = (z) => {
      const pages = M.readMaskPages(read(path.join(where, files[z])));
      if (pages.length !== 1) throw new Error(`${files[z]} holds ${pages.length} pages; expected one slice per file.`);
      return pages[0];
    };
  } else {
    const pages = M.readMaskPages(read(where));
    count = pages.length;
    getPage = (z) => pages[z];
  }
  return {
    count,
    getSlice: (z) => {
      const p = getPage(z);
      if (p.width !== nx || p.height !== ny) throw new Error(`Slice ${z} is ${p.width} x ${p.height}; the scan is ${nx} x ${ny}.`);
      return p.pixels;
    },
  };
}

/** Comparison of VoxelBench's pore mask (a) with another (b) over the kit's scan. */
function compareWithKit(kitDir, otherPath, { smallMm3 = 0.01 } = {}) {
  const info = JSON.parse(fs.readFileSync(path.join(kitDir, 'kit.json'), 'utf8')), dims = info.dims;
  const own = openStack(path.join(kitDir, 'voxelbench_pores'), dims), region = openStack(path.join(kitDir, 'region'), dims), other = openStack(otherPath, dims);
  for (const [name, s] of [['VoxelBench pore', own], ['region', region], ['compared', other]]) {
    if (s.count !== dims.nz) throw new Error(`The ${name} stack has ${s.count} slices; the scan has ${dims.nz}.`);
  }
  const r = M.compareMasks({ a: own.getSlice, b: other.getSlice, region: region.getSlice, dims, voxelMm: info.voxel_mm, bodyMm3: info.body_mm3, smallMm3 });
  return { ...r, kit: { voxelbench_percent: info.voxelbench.all_void_percent_of_body, threshold: info.settings.poreThreshold, body_mm3: info.body_mm3 } };
}

function report(r, label) {
  const row = (name, o) => `| ${name} | ${o.voxels} | ${o.whole_small} | ${o.whole_large} | ${o.boundary} | ${o.outside_region} |`;
  return [
    `Cross-check: VoxelBench vs ${label}`,
    `Porosity over VoxelBench's sample mask (${r.kit.body_mm3.toFixed(1)} mm3): VoxelBench ${r.a.percent.toFixed(3)} %, ${label} ${r.b.percent.toFixed(3)} %`
      + ` (kit check: VoxelBench reported ${r.kit.voxelbench_percent.toFixed(3)} %)`,
    `Dice ${r.dice == null ? 'n/a (both masks empty)' : r.dice.toFixed(4)}; voxels in both: ${r.both_voxels}`,
    '',
    `| Found by one tool only (voxels) | total | whole pore < ${r.small_mm3} mm3 | whole pore >= ${r.small_mm3} mm3 | pore boundary | of all, outside VoxelBench's region |`,
    '|---|---|---|---|---|---|',
    row('VoxelBench only', r.only_a), row(`${label} only`, r.only_b),
    '',
    'Whole pore: a face-connected group the other mask does not touch at all. Pore boundary: both found the pore and differ on its edge.',
  ].join('\n');
}

function main([kitDir, otherPath, label = 'Dragonfly']) {
  if (!kitDir || !otherPath) throw new Error('usage: node tools/crosscheck/compare.js <kit-dir> <dragonfly-pores> [label]');
  const r = compareWithKit(kitDir, otherPath);
  const text = report(r, label), slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  fs.writeFileSync(path.join(kitDir, `comparison_${slug}.json`), `${JSON.stringify({ label, compared: path.resolve(otherPath), created_at: new Date().toISOString(), ...r }, null, 2)}\n`);
  process.stdout.write(`${text}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}

module.exports = { compareWithKit, openStack, report };
