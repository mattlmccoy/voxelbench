'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../app/vb_calibration.js');

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('two points give an exact line with no R²', () => {
  const fit = C.fitCalibration([{ name: 'Air', gray: 700, density: 0.0012 }, { name: 'PA12 rod', gray: 2000, density: 1.01 }]);
  assert.equal(fit.ok, true);
  assert.equal(fit.method, 'linear');
  assert.equal(fit.n, 2);
  near(fit.slope, (1.01 - 0.0012) / 1300, 1e-12, 'slope');
  near(fit.intercept, 0.0012 - 700 * fit.slope, 1e-9, 'intercept');
  assert.equal(fit.r2, null);
  fit.residuals.forEach((r) => near(r, 0, 1e-12, 'residual'));
  assert.deepEqual(fit.gray_range, [700, 2000]);
});

test('three collinear points give R² of 1; noisy ones give residuals that sum to zero', () => {
  const line = (g) => 0.1 + 0.0005 * g;
  const exact = C.fitCalibration([700, 1500, 2600].map((g) => ({ name: String(g), gray: g, density: line(g) })));
  near(exact.r2, 1, 1e-12, 'r2');
  const noisy = C.fitCalibration([{ name: 'a', gray: 700, density: 0.46 }, { name: 'b', gray: 1500, density: 0.84 }, { name: 'c', gray: 2600, density: 1.42 }]);
  assert.ok(noisy.r2 > 0.99 && noisy.r2 < 1);
  near(noisy.residuals.reduce((s, r) => s + r, 0), 0, 1e-12, 'sum of residuals');
});

test('fewer than 2 points, or 2 at the same gray, is not a calibration', () => {
  const one = C.fitCalibration([{ name: 'a', gray: 2000, density: 1.01 }]);
  assert.equal(one.ok, false);
  assert.match(one.reason, /2 points/);
  const same = C.fitCalibration([{ name: 'a', gray: 2000, density: 1.01 }, { name: 'b', gray: 2000, density: 1.2 }]);
  assert.equal(same.ok, false);
  assert.match(same.reason, /different gray/);
});

test('applyCalibration marks gray outside the phantom range as extrapolated', () => {
  const fit = C.fitCalibration([{ name: 'Air', gray: 700, density: 0.0012 }, { name: 'rod', gray: 2000, density: 1.01 }]);
  const inside = C.applyCalibration(fit, 1350);
  near(inside.value, (0.0012 + 1.01) / 2, 1e-9, 'midpoint');
  assert.equal(inside.extrapolated, false);
  assert.equal(C.applyCalibration(fit, 2020).extrapolated, false, 'within 2 % of the span');
  assert.equal(C.applyCalibration(fit, 300).extrapolated, true);
  assert.equal(C.applyCalibration({ ok: false, reason: 'x' }, 1000), null);
  assert.equal(C.applyCalibration(fit, null), null);
});

test('calibrationPoints adds air first when asked and air gray is known', () => {
  const phantoms = [{ name: 'PA12 rod', density_g_cm3: 1.01, gray: 2000 }];
  assert.deepEqual(C.calibrationPoints(phantoms, { airGray: 711, includeAir: true }), [{ name: 'Air', gray: 711, density: 0.0012 }, { name: 'PA12 rod', gray: 2000, density: 1.01 }]);
  assert.deepEqual(C.calibrationPoints(phantoms, { airGray: null, includeAir: true }), [{ name: 'PA12 rod', gray: 2000, density: 1.01 }]);
  assert.deepEqual(C.calibrationPoints(phantoms, { airGray: 711, includeAir: false }), [{ name: 'PA12 rod', gray: 2000, density: 1.01 }]);
});

test('the fit refuses an empty phantom, a falling line and points closer than their noise', () => {
  const air = { name: 'Air', gray: 700, density: 0.0012 };
  const empty = C.fitCalibration([air, { name: 'Rod A', gray: null, density: 0.5 }]);
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /Rod A/);
  const falling = C.fitCalibration([{ name: 'Rod A', gray: 1345, density: 1.4 }, { name: 'Rod B', gray: 2506, density: 0.5 }]); // densities in swapped rows
  assert.equal(falling.ok, false);
  assert.match(falling.reason, /rise with gray/);
  const close = C.fitCalibration([{ name: 'Rod A', gray: 1345, density: 0.5, sd: 60 }, { name: 'Rod B', gray: 1400, density: 0.55, sd: 60 }]);
  assert.equal(close.ok, false);
  assert.match(close.reason, /noise/);
});

test('calibrationPoints carries each phantom gray SD for the noise check', () => {
  assert.deepEqual(C.calibrationPoints([{ name: 'r', density_g_cm3: 1, gray: 2000, sd: 55 }], { includeAir: false }), [{ name: 'r', gray: 2000, density: 1, sd: 55 }]);
});

// Air at gray 700 and a 1.01 g/cm³ rod at gray 2000: an exact line.
const line = () => C.fitCalibration([{ name: 'Air', gray: 700, density: 0.0012 }, { name: 'PA12 rod', gray: 2000, density: 1.01 }]);

test('the voxel readout says uncalibrated without a fit and gives the equivalent density with one', () => {
  assert.equal(C.grayReadout(null, 1500), ' uncalibrated');
  assert.equal(C.grayReadout({ ok: false, reason: 'x' }, 1500), ' uncalibrated');
  assert.equal(C.grayReadout(line(), 2000), ' ≈ 1.010 g/cm³ eq.');
  assert.equal(C.grayReadout(line(), 3000), ' ≈ 1.786* g/cm³ eq.'); // beyond the rod: extrapolated
});

test('results for the scan: what to run first when the matrix gray is not known yet', () => {
  assert.deepEqual(C.calibrationResults({ fit: null, solidGray: 2000 }), { rows: [], todo: null });
  const r = C.calibrationResults({ fit: line(), solidGray: null, porosityPercent: null });
  assert.deepEqual(r.rows, []);
  assert.match(r.todo, /Segment pores \(step 2\)/);
});

test('results for the scan: solid matrix, bulk with the pores, and Archimedes beside them', () => {
  const r = C.calibrationResults({ fit: line(), solidGray: 2000, porosityPercent: 5, archimedesDensity: 0.95 });
  assert.equal(r.todo, null);
  assert.deepEqual(r.rows, [
    ['Solid matrix', '1.010 g/cm³'],
    ['Bulk, with 5.00 % pores', '0.960 g/cm³'], // 1.01 × 0.95 + 0.0012 × 0.05
    ['Archimedes, measured', '0.950 g/cm³'],
  ]);
});

// Relative density in every scan: air (0) and the part's own fully dense material (1), per material, so scans at
// different settings compare without phantoms. Gray values below are a lab scan's round numbers (air ~550, dense ~2700).
test('the relative scale runs from air (0) to each material\'s dense reference (1)', () => {
  const s = C.relativeScale({ airGray: 550, dense: [{ material: 'natural', gray: 2700 }, { material: 'natural', gray: 2720 }, { material: 'doped', gray: 3000 }] });
  assert.deepEqual(s.map((m) => [m.material, m.denseGray, m.airGray]), [['natural', 2710, 550], ['doped', 3000, 550]]);
  assert.equal(C.relativeDensity(s[0], 550), 0);
  assert.equal(C.relativeDensity(s[0], 2710), 1);
  assert.equal(C.relativeDensity(s[0], 1630), 0.5);
  assert.deepEqual(C.relativeScale({ airGray: null, dense: [{ material: 'natural', gray: 2700 }] }), []);
  assert.deepEqual(C.relativeScale({ airGray: 550, dense: [{ material: 'natural', gray: 500 }] }), []); // dense must read above air
});

test('the status bar adds each relative scale after the calibrated density', () => {
  const s = C.relativeScale({ airGray: 550, dense: [{ material: 'natural', gray: 2710 }] });
  assert.equal(C.grayReadout(null, 1630, s), ' uncalibrated · 0.50 of natural dense');
  assert.equal(C.grayReadout(null, 1630, []), ' uncalibrated');
});

test('phantom materials used before are offered again with their density (the holder is entered once)', () => {
  const regions = [
    { label: 'phantom', phantom: { name: 'clear resin holder', density_g_cm3: 1.19 }, created_at: '2026-11-05T10:00' },
    { label: 'phantom', phantom: { name: 'clear resin holder', density_g_cm3: 1.185 }, created_at: '2026-11-06T10:00' },
    { label: 'phantom', phantom: { name: 'PA12 rod', density_g_cm3: 1.01 }, created_at: '2026-11-04T10:00' },
    { label: 'region_a', created_at: '2026-11-06T10:00' },
  ];
  assert.deepEqual(C.knownMaterials(regions), [{ name: 'clear resin holder', density_g_cm3: 1.185 }, { name: 'PA12 rod', density_g_cm3: 1.01 }]);
});
