'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CT = require('../app/ct_core.js');
const S = require('../app/vb_synthetic.js');
const P = require('../app/ct_pores.js');
const H = require('../tools/headless_run.js');
const Kit = require('../tools/crosscheck/dragonfly_kit.js');
const Cmp = require('../tools/crosscheck/compare.js');

async function syntheticRun(run) {
  const { files } = S.makeScan({ filler: false });
  const tiffs = await Promise.all(files.map(async (f) => CT.parseTiff(await f.arrayBuffer())));
  const stack = { slices: tiffs.map((t) => t.pixels), voxelMm: tiffs[0].voxelMm, dims: { nx: tiffs[0].width, ny: tiffs[0].height, nz: tiffs.length } };
  return H.analyze(stack, run, { patches: false });
}

test('the kit pore mask reproduces VoxelBench porosity exactly, rejected voids left out', async () => {
  const first = await syntheticRun({ settings: { poreThreshold: 1350 } });
  const v = P.firstVoxelOf(first.base.result.runs, first.dims, 1);
  const a = await syntheticRun({ settings: { poreThreshold: 1350 }, rejected_voxels: [v] });
  assert.equal(a.rejected.size, 1);
  const kit = Kit.buildKit(a);
  let pores = 0, region = 0, outsideRegion = 0;
  for (let z = 0; z < a.dims.nz; z++) {
    const p = kit.poreSlice(z), r = kit.regionSlice(z);
    for (let i = 0; i < p.length; i++) { pores += p[i]; region += r[i]; if (p[i] && !r[i]) outsideRegion++; }
  }
  assert.equal(outsideRegion, 0);
  assert.equal(kit.info.voxelbench.pore_voxels, pores);
  assert.equal(kit.info.voxelbench.region_voxels, region);
  assert.ok(Math.abs((100 * pores * a.voxelMm ** 3) / a.base.bodyMm3 - a.summary.all_void_percent_of_body) < 1e-9);
  assert.equal(kit.info.voxelbench.all_void_percent_of_body, a.summary.all_void_percent_of_body);
  assert.equal(kit.info.settings.poreThreshold, 1350);
  // The smallest group VoxelBench keeps, in voxels: a group under minVolumeMm3 is dropped.
  const n = kit.info.min_group_voxels, v3 = a.voxelMm ** 3;
  assert.ok(n * v3 >= a.settings.minVolumeMm3 && (n - 1) * v3 < a.settings.minVolumeMm3, `${n}`);
});

test('a kit written to disk compares with its own pore mask at Dice 1, and refuses a stack of the wrong length', async () => {
  const a = await syntheticRun({ settings: { poreThreshold: 1350 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-kit-'));
  try {
    Kit.writeKit(Kit.buildKit(a), dir, { scanFiles: ['s_000.tif', 's_063.tif'] });
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'kit.json'), 'utf8'));
    assert.equal(fs.readdirSync(path.join(dir, 'region')).length, a.dims.nz);
    assert.deepEqual(info.scan_files, { first: 's_000.tif', last: 's_063.tif', count: 2 });
    const r = Cmp.compareWithKit(dir, path.join(dir, 'voxelbench_pores'));
    assert.equal(r.dice, 1);
    assert.ok(Math.abs(r.a.percent - a.summary.all_void_percent_of_body) < 1e-9);
    fs.rmSync(path.join(dir, 'voxelbench_pores', fs.readdirSync(path.join(dir, 'voxelbench_pores')).sort().pop()));
    assert.throws(() => Cmp.compareWithKit(dir, path.join(dir, 'voxelbench_pores')), /slices/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the kit records how the sample envelope was closed (round or box), since it sets the counting region', () => {
  const M2 = require('../app/vb_masks.js');
  const base = { dims: { nx: 4, ny: 4, nz: 4 }, voxelMm: 0.04, bin: 2, bodyMm3: 1, porosityPercent: 1, voidCount: 1, rejectedCount: 0, poreVoxels: 1, regionVoxels: 10 };
  const s = { poreThreshold: 1300, fineSigma: 1, margin: 2, minVolumeMm3: 0.0005, bodyThreshold: 1400, closeRadius: 8 };
  assert.equal(M2.kitInfo({ ...base, settings: { ...s, closeShape: 'ball' } }).settings.closeShape, 'ball');
  assert.equal(M2.kitInfo({ ...base, settings: s }).settings.closeShape, 'box');
});
