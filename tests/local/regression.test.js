'use strict';
// Version 10 regression gate: VoxelBench must reproduce the Sinter CT Annotator's Sample 2 numbers with the same
// settings, crop and end baseline. Needs the scan and the saved run in VOXELBENCH_LOCAL_DIR (never in this repository):
//   scan/              the scan folder
//   sample2_run.json   version 10's saved run (settings, crop, zone threshold)
// Run with: VOXELBENCH_LOCAL_DIR=... npm run test:local
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../../tools/headless_run.js');

const LOCAL = process.env.VOXELBENCH_LOCAL_DIR || '';
const SCAN = LOCAL && path.join(LOCAL, 'scan'), RUN = LOCAL && path.join(LOCAL, 'sample2_run.json');
const ready = Boolean(LOCAL) && fs.existsSync(SCAN) && fs.existsSync(RUN);

// From the version 10 report (report.json, saved run of 2026-11-02 22:54 UTC).
const V10 = { porosity: 5.253631849247991, poreMm3: 726.5131288159308, pores: 14383, bodyMm3: 13828.778826973275, patches: 222,
  zones: { 2: 4525.0946110556415, 3: 3561.8746220148355, 1: 5820.610982333773 } };

test('Sample 2 matches version 10 with its settings and the end baseline', { skip: !ready && 'VOXELBENCH_LOCAL_DIR with scan/ and sample2_run.json not set' }, () => {
  const parsed = JSON.parse(fs.readFileSync(RUN, 'utf8'));
  const a = H.analyze(H.readStack(SCAN), parsed.data || parsed, { zoneBaseline: 'ends' });
  const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} vs ${want}`);
  near(a.summary.all_void_percent_of_body, V10.porosity, 1e-6, 'porosity %');
  near(a.summary.all_void_volume_mm3, V10.poreMm3, 1e-4, 'pore volume mm3');
  assert.equal(a.base.result.pores.length, V10.pores);
  near(a.base.bodyMm3, V10.bodyMm3, 1e-3, 'sample mask mm3');
  assert.equal(a.patches.length, V10.patches);
  assert.equal(a.chosen.threshold, 0.04);
  for (const [zone, mm3] of Object.entries(V10.zones)) near(a.chosen.stats.find((s) => s.zone === Number(zone)).volume_mm3, mm3, 0.01, `zone ${zone} mm3`);
});

test('Sample 2 gets zones from the automatic threshold with the default (automatic) baseline, with and without the crop', { skip: !ready && 'local data not set' }, () => {
  const parsed = JSON.parse(fs.readFileSync(RUN, 'utf8'));
  const run = parsed.data || parsed;
  const stack = H.readStack(SCAN);
  for (const crops of [run.crops, []]) {
    const a = H.analyze(stack, { settings: run.settings, crops }, { zoneBaseline: 'auto' });
    assert.ok(!a.automatic.refused, `${crops.length ? 'cropped' : 'uncropped'}: ${a.automatic.refused}`);
    assert.ok(a.automatic.threshold > -0.1 && a.automatic.threshold < 0.2, `threshold ${a.automatic.threshold}`);
    console.log(`${crops.length ? 'cropped' : 'uncropped'}: ${a.ready.method} baseline, automatic threshold ${a.automatic.threshold.toFixed(3)}; zones ${a.automatic.stats.map((s) => `${s.zone}:${Math.round(s.volume_mm3)}`).join(' ')}`);
  }
});
