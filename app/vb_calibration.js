/* Density calibration: a straight line from gray value to density through reference phantoms scanned with the
   sample (and air, when chosen). The result is the equivalent density of the reference material: material that
   attenuates differently per gram (doped, filled) does not read its true density. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBCalibration = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const AIR_DENSITY = 0.0012; // g/cm³ at room temperature
  const EXTRAPOLATION_MARGIN = 0.02; // of the phantom gray span

  /** Fit points from phantoms ({ name, density_g_cm3, gray }); air first when included and its gray is known. */
  function calibrationPoints(phantoms, { airGray, includeAir }) {
    const points = phantoms.map((p) => ({ name: p.name, gray: p.gray, density: p.density_g_cm3 }));
    return includeAir && Number.isFinite(airGray) ? [{ name: 'Air', gray: airGray, density: AIR_DENSITY }, ...points] : points;
  }

  /** Least squares of density on gray. Two points give an exact line, so R² is null. */
  function fitCalibration(points) {
    const n = points.length;
    if (n < 2) return { ok: false, reason: 'A calibration needs at least 2 points (phantoms, or one phantom and air).' };
    const mg = points.reduce((s, p) => s + p.gray, 0) / n, md = points.reduce((s, p) => s + p.density, 0) / n;
    let sgg = 0, sgd = 0, sdd = 0;
    for (const p of points) { sgg += (p.gray - mg) ** 2; sgd += (p.gray - mg) * (p.density - md); sdd += (p.density - md) ** 2; }
    if (!(sgg > 1e-9)) return { ok: false, reason: 'The points must have different gray values.' };
    const slope = sgd / sgg, intercept = md - slope * mg;
    const residuals = points.map((p) => p.density - (intercept + slope * p.gray));
    const sse = residuals.reduce((s, r) => s + r * r, 0);
    const grays = points.map((p) => p.gray);
    return { ok: true, method: 'linear', n, intercept, slope, r2: n > 2 && sdd > 0 ? 1 - sse / sdd : null, residuals, gray_range: [Math.min(...grays), Math.max(...grays)] };
  }

  /** Equivalent density at a gray value; extrapolated when the gray lies outside the phantoms' range. */
  function applyCalibration(fit, gray) {
    if (!fit || !fit.ok || gray === null || gray === undefined || !Number.isFinite(gray)) return null;
    const [lo, hi] = fit.gray_range, margin = EXTRAPOLATION_MARGIN * (hi - lo);
    return { value: fit.intercept + fit.slope * gray, extrapolated: gray < lo - margin || gray > hi + margin };
  }

  return { AIR_DENSITY, calibrationPoints, fitCalibration, applyCalibration };
}));
