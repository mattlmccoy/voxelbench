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
    const points = phantoms.map((p) => ({ name: p.name, gray: p.gray, density: p.density_g_cm3, ...(Number.isFinite(p.sd) ? { sd: p.sd } : {}) }));
    return includeAir && Number.isFinite(airGray) ? [{ name: 'Air', gray: airGray, density: AIR_DENSITY }, ...points] : points;
  }

  /** Least squares of density on gray. Two points give an exact line, so R² is null. */
  function fitCalibration(points) {
    const n = points.length;
    if (n < 2) return { ok: false, reason: 'A calibration needs at least 2 points (phantoms, or one phantom and air).' };
    const empty = points.find((p) => !Number.isFinite(p.gray));
    if (empty) return { ok: false, reason: `${empty.name} has no voxels inside the field of view; outline it again.` };
    const mg = points.reduce((s, p) => s + p.gray, 0) / n, md = points.reduce((s, p) => s + p.density, 0) / n;
    let sgg = 0, sgd = 0, sdd = 0;
    for (const p of points) { sgg += (p.gray - mg) ** 2; sgd += (p.gray - mg) * (p.density - md); sdd += (p.density - md) ** 2; }
    if (!(sgg > 1e-9)) return { ok: false, reason: 'The points must have different gray values.' };
    const slope = sgd / sgg, intercept = md - slope * mg;
    if (!(slope > 0)) return { ok: false, reason: 'Density must rise with gray; check that each phantom has its own density.' };
    // Points closer in gray than about 3 SD of their noise cannot fix a slope.
    const sds = points.map((p) => p.sd).filter(Number.isFinite);
    const grays = points.map((p) => p.gray), span = Math.max(...grays) - Math.min(...grays);
    if (sds.length && span < 3 * Math.max(...sds)) return { ok: false, reason: `The points span ${span.toFixed(0)} gray, less than 3 times their noise (SD ${Math.max(...sds).toFixed(0)}); use phantoms of more different density.` };
    const residuals = points.map((p) => p.density - (intercept + slope * p.gray));
    const sse = residuals.reduce((s, r) => s + r * r, 0);
    return { ok: true, method: 'linear', n, intercept, slope, r2: n > 2 && sdd > 0 ? 1 - sse / sdd : null, residuals, gray_range: [Math.min(...grays), Math.max(...grays)] };
  }

  /** Equivalent density at a gray value; extrapolated when the gray lies outside the phantoms' range. */
  function applyCalibration(fit, gray) {
    if (!fit || !fit.ok || gray === null || gray === undefined || !Number.isFinite(gray)) return null;
    const [lo, hi] = fit.gray_range, margin = EXTRAPOLATION_MARGIN * (hi - lo);
    return { value: fit.intercept + fit.slope * gray, extrapolated: gray < lo - margin || gray > hi + margin };
  }

  const g3 = (d) => `${d.value.toFixed(3)}${d.extrapolated ? '*' : ''} g/cm³`;

  /** Text after a voxel's gray in the status bar: its equivalent density when calibrated. */
  /** Relative density on one scale: (gray - air) / (dense - air); 0 = air, 1 = the dense reference. Null without
      a usable scale. */
  function relativeDensity({ airGray, denseGray }, gray) {
    const span = denseGray - airGray;
    if (!Number.isFinite(gray) || !Number.isFinite(span) || !(Math.abs(span) > 1e-9)) return null;
    return (gray - airGray) / span;
  }

  /** The relative scales of a scan: one per material of its dense references (their median grays averaged), each
      from this scan's air. A material whose dense gray is not above air gives no scale. */
  function relativeScale({ airGray, dense }) {
    if (!Number.isFinite(airGray)) return [];
    const by = new Map();
    for (const d of dense) if (Number.isFinite(d.gray)) { if (!by.has(d.material)) by.set(d.material, []); by.get(d.material).push(d.gray); }
    return [...by].map(([material, g]) => ({ material, airGray, denseGray: g.reduce((a, b) => a + b, 0) / g.length })).filter((s) => s.denseGray > airGray);
  }

  /** The status-bar reading: the calibrated density (or "uncalibrated"), then the gray on each relative scale. */
  function grayReadout(fit, gray, relative = []) {
    const d = applyCalibration(fit, gray);
    return (d ? ` ≈ ${g3(d)} eq.` : ' uncalibrated') + relative.map((s) => ` · ${relativeDensity(s, gray).toFixed(2)} of ${s.material} dense`).join('');
  }

  /** The phantom materials used in a project, most recent first, with the density last entered for each, so a reference
      material is typed once and offered again. */
  function knownMaterials(regions) {
    const latest = new Map();
    for (const r of [...regions].filter((x) => x.phantom).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) latest.set(r.phantom.name, { at: r.created_at, density: r.phantom.density_g_cm3 });
    return [...latest].sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).map(([name, v]) => ({ name, density_g_cm3: v.density }));
  }

  /** The dense-reference materials used in a project, most recent first; none until one has been outlined. */
  function knownDenseMaterials(regions) {
    const latest = new Map();
    for (const r of [...regions].filter((x) => x.dense && x.dense.material).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) latest.set(r.dense.material, r.created_at);
    return [...latest].sort((a, b) => String(b[1]).localeCompare(String(a[1]))).map(([material]) => material);
  }

  /** What a calibration gives for the open scan: the solid matrix at its mean gray, the bulk with the pores (air in
      them), and the Archimedes measurement beside them; todo names the step to run when the matrix is not known. */
  function calibrationResults({ fit, solidGray, porosityPercent, archimedesDensity }) {
    if (!fit || !fit.ok) return { rows: [], todo: null };
    const matrix = applyCalibration(fit, solidGray);
    if (!matrix) return { rows: [], todo: 'Segment pores (step 2) to get the solid matrix and bulk densities of this scan.' };
    const rows = [['Solid matrix', g3(matrix)]];
    if (Number.isFinite(porosityPercent)) {
      const p = porosityPercent / 100;
      rows.push([`Bulk, with ${porosityPercent.toFixed(2)} % pores`, g3({ value: matrix.value * (1 - p) + AIR_DENSITY * p, extrapolated: matrix.extrapolated })]);
    }
    if (Number.isFinite(archimedesDensity)) rows.push(['Archimedes, measured', `${archimedesDensity.toFixed(3)} g/cm³`]);
    return { rows, todo: null };
  }

  return { AIR_DENSITY, calibrationPoints, fitCalibration, applyCalibration, relativeDensity, relativeScale, grayReadout, knownMaterials, knownDenseMaterials, calibrationResults };
}));
