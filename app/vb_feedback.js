/* What a drawn mark measured, for the result card shown when it is saved or picked: rows of numbers and plain
   insights that compare it with the whole part and say what to run when a number is missing. Pure: the page passes
   the statistics in. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_calibration.js'));
  else root.VBFeedback = factory(root.VBCalibration);
}(typeof self !== 'undefined' ? self : this, function (Cal) {
  'use strict';

  const SMALL_VOXELS = 1000; // fewer than this, and noise dominates the mean gray and the porosity
  const SAME_POROSITY = 0.2; // relative band (and at least 0.05 points) counted as "about the same"
  const SAME_GRAY = 0.01; // solid gray within 1 % of the part's solid, air-referenced
  const n0 = (v) => Math.round(v).toLocaleString('en-US'); // counts
  const gray = (v) => String(Math.round(v)); // gray as the rest of the page shows it
  const g3 = (d) => `${d.value.toFixed(3)}${d.extrapolated ? '*' : ''} g/cm³`;

  function porosityInsight(regionPercent, partPercent) {
    const p = regionPercent, P = partPercent;
    const whole = `${P.toFixed(2)} %`;
    if (p === 0) return `No pores inside; the whole part has ${whole}.`;
    if (Math.abs(p - P) <= Math.max(SAME_POROSITY * P, 0.05)) return `Porosity is about the same as the whole part (${whole}).`;
    return p > P ? `Porosity is ${(p / P).toFixed(1)}× the whole part's ${whole}: more porous here.`
      : `Porosity is ${(P / p).toFixed(1)}× lower than the whole part's ${whole}: denser here.`;
  }

  function grayInsight(matrixGray, part) {
    const rel = (matrixGray - part.airGray) / (part.matrixGray - part.airGray) - 1;
    if (Math.abs(rel) < SAME_GRAY) return "Solid gray is within 1 % of the part's solid: the same material response.";
    const pct = `${rel > 0 ? '+' : ''}${(100 * rel).toFixed(1)} %`;
    return `Solid gray is ${pct} vs the part's solid (air-referenced): ${rel > 0 ? 'higher attenuation here (denser, or more dopant or filler)' : 'lower attenuation here (less dense, or less dopant)'}.`;
  }

  /** Card for a measured region (or one slice of an outline): stats from CTRegions.regionStats; part = { porosityPercent,
      matrixGray, airGray } of the whole part, each null when not known; fit = the density calibration or null. */
  function regionCard({ title, stats, part, fit, relative = [] }) {
    if (!stats || !stats.voxels) return { title, rows: [], insights: ['The outline holds no voxels inside the field of view; draw it again on the part.'] };
    const rows = [['Volume', `${stats.volume_mm3.toFixed(2)} mm³ (${n0(stats.voxels)} voxels)`], ['Gray', `${gray(stats.gray_mean)} ± ${gray(stats.gray_sd)}`]];
    const insights = [];
    const pores = stats.pore_fraction !== null && stats.pore_fraction !== undefined;
    if (pores) rows.push(['Porosity', `${(100 * stats.pore_fraction).toFixed(2)} %`], ['Pores inside', String(stats.pore_count)]);
    if (stats.matrix_gray_mean !== null && stats.matrix_gray_mean !== undefined) rows.push(['Solid gray', gray(stats.matrix_gray_mean)]);
    const d = Cal.applyCalibration(fit, stats.matrix_gray_mean ?? stats.gray_mean);
    if (d) rows.push(['Eq. density (solid)', g3(d)]);
    for (const s of relative) rows.push([`Relative density (${s.material})`, `${Cal.relativeDensity(s, stats.gray_mean).toFixed(2)} of dense (mean gray, pores included)`]);
    if (pores && Number.isFinite(part.porosityPercent) && part.porosityPercent > 0) insights.push(porosityInsight(100 * stats.pore_fraction, part.porosityPercent));
    if (Number.isFinite(stats.matrix_gray_mean) && Number.isFinite(part.matrixGray) && Number.isFinite(part.airGray) && part.matrixGray !== part.airGray) insights.push(grayInsight(stats.matrix_gray_mean, part));
    if (stats.voxels < SMALL_VOXELS) insights.push(`Small region (${n0(stats.voxels)} voxels): treat the numbers as rough.`);
    const todo = [];
    if (!pores) todo.push('Segment pores (step 2) to get the porosity inside it.');
    if (!d) todo.push('Outline phantoms in step 5 to read density in g/cm³.');
    return { title, rows, insights: [...insights, ...todo], todo };
  }

  /** A measurement: its length, and against its nominal (check = CT.dimensionCheck) when one is entered. */
  function caliperCard(a, title, check) {
    const rows = [['Length', `${a.length_mm.toFixed(2)} mm (${a.plane} slice ${a.slice})`]];
    if (!Number.isFinite(a.nominal_mm) || !check || check.pass === null) return { title, rows, insights: ['Give it a nominal and tolerance in the dimension table (step 4) to check it.'] };
    const tm = a.tol_minus_mm ?? 0, tp = a.tol_plus_mm ?? 0;
    rows.push(['Nominal', `${a.nominal_mm.toFixed(3)} −${tm.toFixed(3)} / +${tp.toFixed(3)} mm`], ['Deviation', `${check.deviation >= 0 ? '+' : ''}${check.deviation.toFixed(3)} mm`]);
    const over = check.deviation > 0 ? check.deviation - tp : -check.deviation - tm;
    return { title, rows, insights: [check.pass ? 'Within tolerance.' : `Out of tolerance by ${over.toFixed(3)} mm (${check.deviation > 0 ? 'oversize' : 'undersize'}).`] };
  }

  /** Card for an annotation: a point (point = { gray, pore }), a measurement, or an outline (sliceStats over its slice). */
  function annotationCard({ annotation: a, title, sliceStats, point, check, part, fit }) {
    if (a.kind === 'caliper') return caliperCard(a, title, check);
    if (a.kind === 'point') {
      const m = a.mm[0];
      const rows = [['Position', `${m.x.toFixed(2)}, ${m.y.toFixed(2)}, ${m.z.toFixed(2)} mm`]];
      if (point && Number.isFinite(point.gray)) {
        rows.push(['Gray', String(point.gray)]);
        const d = Cal.applyCalibration(fit, point.gray);
        if (d) rows.push(['Eq. density', g3(d)]);
      }
      if (point && point.pore) rows.push(['Inside', `pore ${point.pore.id}, ESD ${point.pore.diameter_mm.toFixed(3)} mm`]);
      return { title, rows, insights: ['A point reads one voxel, so its gray carries the full noise; Draw region in step 3 averages over an area.'] };
    }
    const slice = regionCard({ title, stats: sliceStats, part, fit });
    const voxels = sliceStats && sliceStats.voxels ? `, ${n0(sliceStats.voxels)} voxels` : '';
    return { title, rows: [['Area', `${a.area_mm2.toFixed(2)} mm² (${a.plane} slice ${a.slice}${voxels})`], ...slice.rows.filter((r) => r[0] !== 'Volume')],
      insights: ['Measured on this one slice. For a 3-D measurement through several slices, use Draw region in step 3.', ...slice.insights] };
  }

  const PICK_VOXELS = 3; // a click this close to a point or a line picks it
  const inPlane = (plane, v) => (plane === 'XY' ? { col: v.x, row: v.y } : plane === 'XZ' ? { col: v.x, row: v.z } : { col: v.y, row: v.z });

  function inside(points, col, row) {
    let hit = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a.row > row) !== (b.row > row) && col < ((b.col - a.col) * (row - a.row)) / (b.row - a.row) + a.col) hit = !hit;
    }
    return hit;
  }

  function nearSegment(a, b, col, row) {
    const dx = b.col - a.col, dy = b.row - a.row, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((col - a.col) * dx + (row - a.row) * dy) / len2)) : 0;
    return Math.hypot(col - (a.col + t * dx), row - (a.row + t * dy)) <= PICK_VOXELS;
  }

  /** The mark under a click at (col, row) of a plane's slice: points and lines first, then one-slice outlines, then
      regions whose slice range holds the slice; null when none. Returns { collection, id }. */
  function markAt({ plane, slice, col, row }, { regions, annotations }) {
    const here = annotations.filter((a) => a.plane === plane && a.slice === slice);
    const pick = (collection, m) => (m ? { collection, id: m.id } : null);
    const small = here.find((a) => {
      const pts = a.voxels.map((v) => inPlane(plane, v));
      if (a.kind === 'point') return Math.hypot(pts[0].col - col, pts[0].row - row) <= PICK_VOXELS;
      if (a.kind === 'caliper') return nearSegment(pts[0], pts[1], col, row);
      return false;
    });
    return pick('annotations', small)
      || pick('annotations', here.find((a) => a.kind === 'polygon' && inside(a.voxels.map((v) => inPlane(plane, v)), col, row)))
      || pick('regions', regions.find((r) => r.plane === plane && slice >= r.slice_from && slice <= r.slice_to && inside(r.points, col, row)));
  }

  return { regionCard, annotationCard, markAt };
}));
