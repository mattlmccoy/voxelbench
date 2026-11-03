/* The CAD comparison on one scan, shared by the worker and the headless runner: the iso level from air and matrix
   gray, scan surface points near the sample, alignment of the nominal's measurement points (pre-alignment, or ICP
   from a given pose), then the deviation of every point and its statistics. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'), require('./vb_align.js'), require('./vb_deviation.js'));
  else root.VBCad = factory(root.CTPores, root.VBAlign, root.VBDeviation);
}(typeof self !== 'undefined' ? self : this, function (P, A, D) {
  'use strict';

  const DEFAULTS = { scale: false, rangeMm: 2, toleranceMm: 0.1, maxAlignPoints: 20000, nearVoxels: 3, fovInsetVoxels: 2 };

  /** gray, filled, dims, bin: the binned analysis grid; circle: FOV on the full grid; points, normals: the nominal's
      measurement points (CAD mm). With pose, ICP starts there; otherwise from pre-alignment. */
  function compareToCad({ gray, filled, dims, bin, voxelMm, circle, airGray, poreThreshold, points, normals, edge = null, weight = null, pose = null, ...options }) {
    const o = { ...DEFAULTS, ...options };
    const matrix = D.matrixGray(gray, filled, poreThreshold);
    if (matrix === null || !Number.isFinite(airGray)) return { refused: 'No matrix or air gray: segment the scan first.' };
    const level = D.isoLevel(airGray, matrix);
    const fov = circle ? { ...circle, r: circle.r - o.fovInsetVoxels * bin } : null;
    const near = P.boxDilate(filled, dims, o.nearVoxels), air = D.exteriorAir(gray, dims, level, filled);
    const scan = D.surfacePoints({ gray, dims, bin, voxelMm, level, circle: fov, near, air });
    if (scan.length < 3 * 100) return { refused: 'Too few scan surface points near the sample to align to.' };
    const few = areaSample(points, weight, edge, o.maxAlignPoints);
    const fit = pose ? A.icp(few, scan, { init: pose, scale: o.scale }) : A.preAlign(few, scan, { scale: o.scale });
    const transform = { R: fit.R, t: fit.t, s: o.scale ? fit.s : 1 };
    const deviations = D.deviations({ gray, dims, bin, voxelMm, level, circle: fov, points, normals, edge, air, transform, rangeMm: o.rangeMm });
    return { transform, rms: fit.rms, level, matrixGray: matrix, airGray, scanPoints: scan.length / 3, deviations, points, normals, edge, weight, stats: D.deviationStats(deviations, o.toleranceMm, edge, weight), options: o };
  }

  /** Up to max points for the alignment, spaced evenly in cumulative area (weight) so finely tessellated features do
      not dominate the fit; points on sharp edges are left out. */
  function areaSample(points, weight, edge, max) {
    const n = points.length / 3, w = (k) => (edge && edge[k] ? 0 : weight ? weight[k] : 1);
    let total = 0;
    for (let k = 0; k < n; k++) total += w(k);
    const m = Math.min(max, n), out = new Float64Array(3 * m), step = total / m;
    let next = step / 2, c = 0, j = 0;
    for (let k = 0; k < n && j < m; k++) {
      c += w(k);
      while (c >= next && j < m) { out.set(points.subarray(3 * k, 3 * k + 3), 3 * j); j++; next += step; }
    }
    return out.subarray(0, 3 * j);
  }

  return { DEFAULTS, compareToCad, areaSample };
}));
