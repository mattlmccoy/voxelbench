'use strict';
// Plain-language reads of each step's result. Field names follow the producing code: pores from ct_pores.js fineDetect
// plus vb_connectivity.js annotatePores; zones from ct_zones.js; CAD from vb_deviation.js deviationStats and cadSummary;
// filler from vb_filler.js analyzeFiller; walls from vb_wall.js wallReport.
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../app/vb_insights.js');

const pore = (id, volume_mm3, diameter_mm, over = {}) => ({ id, volume_mm3, diameter_mm, x_mm: id, y_mm: 2, z_mm: 3, crack_like: false, clipped: false, surface_distance_mm: 2, ...over });
const summaryOf = (pores, extra = {}) => {
  const v = (f) => pores.filter(f).reduce((s, p) => s + p.volume_mm3, 0);
  return { all_void_volume_mm3: v(() => true), crack_like_volume_mm3: v((p) => p.crack_like), clipped_volume_mm3: v((p) => p.clipped), all_void_percent_of_body: 3, rejected_count: 0, ...extra };
};
const said = (list) => list.join(' ');

test('pores: one dominant void, or porosity spread over many', () => {
  const one = [pore(1, 8, 2.5), pore(2, 1, 0.3), pore(3, 1, 0.3)];
  assert.match(said(I.poreInsights({ pores: one, rejected: new Set(), summary: summaryOf(one), voxelMm: 0.04 })), /One void holds 80 % of the void volume \(ESD 2\.50 mm at 1\.0, 2\.0, 3\.0 mm\)/);
  const many = Array.from({ length: 20 }, (_, i) => pore(i + 1, 1, 0.3));
  assert.match(said(I.poreInsights({ pores: many, rejected: new Set(), summary: summaryOf(many), voxelMm: 0.04 })), /spread over many voids: the largest holds 5 %/);
});

test('pores: size spread, and voids near the resolution limit', () => {
  const many = Array.from({ length: 10 }, (_, i) => pore(i + 1, 1, 0.1 + 0.02 * i)); // 0.10 to 0.28 mm
  const s = said(I.poreInsights({ pores: many, rejected: new Set(), summary: summaryOf(many), voxelMm: 0.05 }));
  assert.match(s, /Half the voids are under 0\.19 mm ESD; 90 % are under 0\.26 mm/); // linear quantiles
  assert.match(s, /only a few voxels across/); // median 0.19 mm < 4 voxels of 0.05 mm
  assert.doesNotMatch(said(I.poreInsights({ pores: many, rejected: new Set(), summary: summaryOf(many), voxelMm: 0.02 })), /few voxels/);
});

test('pores: crack-like and edge-cut volume, near-surface share, open and through-paths', () => {
  const list = [pore(1, 3, 1, { crack_like: true }), pore(2, 3, 1, { clipped: true }), pore(3, 4, 1, { surface_distance_mm: 0.2 })];
  const s = said(I.poreInsights({ pores: list, rejected: new Set(), summary: summaryOf(list), voxelMm: 0.04, shellShare: 0.15,
    split: { open_percent: 2, closed_percent: 1, unknown_percent: 0 }, through: { x: false, y: true, z: false } }));
  assert.match(s, /30 % of the void volume is elongated/);
  assert.match(s, /30 % of the void volume is cut by the field-of-view edge/);
  assert.match(s, /40 % of the void volume lies within 0\.5 mm of the surface, a shell that is 15 % of the part: voids gather near the surface/);
  // the same share in a small part whose shell is half its volume is no sign of near-surface porosity, and an unknown shell says nothing
  assert.doesNotMatch(said(I.poreInsights({ pores: list, rejected: new Set(), summary: summaryOf(list), voxelMm: 0.04, shellShare: 0.45 })), /gather near the surface/);
  assert.doesNotMatch(said(I.poreInsights({ pores: list, rejected: new Set(), summary: summaryOf(list), voxelMm: 0.04 })), /within 0\.5 mm/);
  assert.match(s, /Most of the porosity is open to the surface \(2\.00 of 3\.00 %\)/);
  assert.match(s, /reach both ends of the part along y/);
});

test('pores: rejected voids are named, and rejected ones never count as the largest', () => {
  const list = [pore(1, 50, 4), pore(2, 1, 0.3), pore(3, 1, 0.3)];
  const s = said(I.poreInsights({ pores: list, rejected: new Set([1]), summary: summaryOf(list.slice(1), { rejected_count: 1 }), voxelMm: 0.04 }));
  assert.match(s, /1 void rejected by hand is left out/);
  assert.doesNotMatch(s, /ESD 4\.00/);
});

test('zones: the high-gray zone compared with the baseline', () => {
  const stats = [{ zone: 1, volume_mm3: 900, void_percent: 1.0, excess_median: 0 }, { zone: 2, volume_mm3: 100, void_percent: 0.2, excess_median: 0.06 }, { zone: 3, volume_mm3: 0, void_percent: 0, excess_median: null }];
  const s = said(I.zoneInsights({ stats }));
  assert.match(s, /The high-gray zone is 10 % of the part \(100 mm³\), \+6\.0 % gray over the baseline, with 0\.20 % porosity vs 1\.00 %/);
  assert.match(I.zoneInsights({ stats: [stats[0]] }).join(' '), /No high-gray or low-gray zone/);
});

test('CAD: centered or offset, share in tolerance, shrinkage, unmeasured surface', () => {
  const stats = { measured: 900, unmeasured: 100, p05: -0.08, p50: 0.03, p95: 0.12, within_percent: 82 };
  const s = said(I.cadInsights({ stats, toleranceMm: 0.1, shrinkagePercent: 1.8, unmeasuredPercent: 10 }));
  assert.match(s, /oversize on average by 0\.030 mm/);
  assert.match(s, /82 % of the surface is within ±0\.100 mm; 18 % is outside/);
  assert.match(s, /90 % of the surface lies between -0\.080 and \+0\.120 mm/);
  assert.match(s, /shrank 1\.80 %/);
  assert.match(s, /10 % of the CAD surface found no scan surface/);
  assert.match(I.cadInsights({ stats: { ...stats, p50: 0.01, within_percent: 99 }, toleranceMm: 0.1, shrinkagePercent: null, unmeasuredPercent: 0 }).join(' '), /centered on the nominal/);
  const all = I.cadInsights({ stats: { ...stats, within_percent: 99.8 }, toleranceMm: 0.1, shrinkagePercent: null, unmeasuredPercent: 0 }).join(' ');
  assert.match(all, /The whole measured surface is within ±0\.100 mm/);
  assert.doesNotMatch(all, /is outside/);
});

test('filler: amount, size, noise, clustering, fiber alignment, edge cuts', () => {
  const summary = { count: 50, clipped: 4, fibers: 20, volume_percent: 3.2, esd_p50_mm: 0.11, near_noise: 15, orientation: { too_few: false, eigenvalues: [0.82, 0.12, 0.06], direction: [0.98, 0.1, 0.1] } };
  const s = said(I.fillerInsights({ summary, dispersion: { clark_evans: 0.62 } }));
  assert.match(s, /50 particles, 3\.20 % of the sample volume; median ESD 0\.110 mm/);
  assert.match(s, /15 particles are close to the noise threshold/);
  assert.match(s, /clustered \(Clark-Evans R 0\.62\)/);
  assert.match(s, /Fibers are aligned, mostly along x \(largest orientation eigenvalue 0\.82\)/);
  assert.match(s, /4 particles are cut by the scan edge/);
  assert.match(I.fillerInsights({ summary: { ...summary, near_noise: 0, clipped: 0, orientation: { too_few: true } }, dispersion: { clark_evans: 1.0 } }).join(' '), /spread at random/);
});

test('walls of one thickness are named as such', () => {
  assert.match(I.wallInsights({ stats: { count: 500, min_mm: 3.68, p05_mm: 3.68, p50_mm: 3.7 }, resolvedMinMm: 0.28, beyondStack: 0 }).join(' '), /The walls are all about 3\.70 mm thick/);
});

test('walls: thinnest and typical walls, the resolution limit, walls cut by the stack ends', () => {
  const s = said(I.wallInsights({ stats: { count: 1000, min_mm: 0.29, p05_mm: 0.4, p50_mm: 1.2 }, resolvedMinMm: 0.28, beyondStack: 50 }));
  assert.match(s, /The thinnest wall is 0\.29 mm; half the walls are thinner than 1\.20 mm/);
  assert.match(s, /at the resolution limit \(0\.28 mm\)/);
  assert.match(s, /50 wall points touch the first or last slice/);
  assert.match(I.wallInsights({ stats: { count: 0, min_mm: null }, resolvedMinMm: 0.28, beyondStack: 0 }).join(' '), /No walls thick enough to measure/);
});
