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
