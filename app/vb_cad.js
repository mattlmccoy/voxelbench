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
  function compareToCad({ gray, filled, dims, bin, voxelMm, circle, airGray, poreThreshold, points, normals, edge = null, pose = null, ...options }) {
    const o = { ...DEFAULTS, ...options };
    const matrix = D.matrixGray(gray, filled, poreThreshold);
    if (matrix === null || !Number.isFinite(airGray)) return { refused: 'No matrix or air gray: segment the scan first.' };
    const level = D.isoLevel(airGray, matrix);
    const fov = circle ? { ...circle, r: circle.r - o.fovInsetVoxels * bin } : null;
    const near = P.boxDilate(filled, dims, o.nearVoxels);
    const scan = D.surfacePoints({ gray, dims, bin, voxelMm, level, circle: fov, near });
    if (scan.length < 3 * 100) return { refused: 'Too few scan surface points near the sample to align to.' };
    const stride = Math.max(1, Math.ceil(points.length / 3 / o.maxAlignPoints));
    const few = new Float64Array(3 * Math.floor(points.length / 3 / stride));
    for (let k = 0; k < few.length / 3; k++) for (let a = 0; a < 3; a++) few[3 * k + a] = points[3 * k * stride + a];
    const fit = pose ? A.icp(few, scan, { init: pose, scale: o.scale }) : A.preAlign(few, scan, { scale: o.scale });
    const transform = { R: fit.R, t: fit.t, s: o.scale ? fit.s : 1 };
    const deviations = D.deviations({ gray, dims, bin, voxelMm, level, circle: fov, points, normals, edge, transform, rangeMm: o.rangeMm });
    return { transform, rms: fit.rms, level, matrixGray: matrix, airGray, scanPoints: scan.length / 3, deviations, points, normals, edge, stats: D.deviationStats(deviations, o.toleranceMm, edge), options: o };
  }

  return { DEFAULTS, compareToCad };
}));
