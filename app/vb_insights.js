/* Plain-language reads of each step's result: what the numbers say about the part and what to check next. Pure: the
   page passes in the result each step already has. Field names follow the producing code: pores from ct_pores.js
   fineDetect and vb_connectivity.js annotatePores; zones from ct_zones.js; CAD from vb_deviation.js; filler from
   vb_filler.js analyzeFiller; walls from vb_wall.js wallReport. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBInsights = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ONE_VOID = 0.25; // one void holding at least this share of the void volume dominates
  const FEW_VOXELS = 4; // a median ESD under this many voxels: sizes and shapes are rough
  const SHARE = 0.2; // crack-like or near-surface volume worth naming
  const CLIPPED = 0.05;
  const NEAR_SURFACE_MM = 0.5;
  const GATHER = 1.5; // near-surface void share at least this many times the shell's share of the part
  const SAME_WALL = 0.05; // walls whose median is within 5 % of the thinnest are one thickness
  const pct = (f) => `${Math.round(100 * f)} %`;
  const signed = (v, d = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

  /** Linear-interpolated quantile of sorted values. */
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const at = q * (sorted.length - 1), lo = Math.floor(at), hi = Math.ceil(at);
    return sorted[lo] + (at - lo) * (sorted[hi] - sorted[lo]);
  }

  /** Pores: pores (annotated list), rejected (Set of ids), summary (CTPores.summarize), voxelMm; optional split
      (VBConnectivity.openClosed) and through ({ x, y, z } booleans). */
  function poreInsights({ pores, rejected, summary, voxelMm, split = null, through = null, shellShare = null }) {
    const kept = pores.filter((p) => !rejected.has(p.id)), total = summary.all_void_volume_mm3, out = [];
    if (!kept.length || !(total > 0)) return ['No voids were found at this threshold.'];
    const largest = kept.reduce((a, p) => (p.volume_mm3 > a.volume_mm3 ? p : a));
    const share = largest.volume_mm3 / total;
    const where = `ESD ${largest.diameter_mm.toFixed(2)} mm at ${largest.x_mm.toFixed(1)}, ${largest.y_mm.toFixed(1)}, ${largest.z_mm.toFixed(1)} mm`;
    out.push(share >= ONE_VOID ? `One void holds ${pct(share)} of the void volume (${where}): the porosity is mostly one defect, not spread porosity.`
      : `The porosity is spread over many voids: the largest holds ${pct(share)} of the void volume (${where}).`);
    const esd = kept.map((p) => p.diameter_mm).sort((a, b) => a - b), median = quantile(esd, 0.5);
    out.push(`Half the voids are under ${median.toFixed(2)} mm ESD; 90 % are under ${quantile(esd, 0.9).toFixed(2)} mm.`);
    if (median < FEW_VOXELS * voxelMm) out.push(`Many voids are only a few voxels across (median ESD under ${FEW_VOXELS} voxels): their sizes and shapes are rough.`);
    const crack = summary.crack_like_volume_mm3 / total;
    if (crack >= SHARE) out.push(`${pct(crack)} of the void volume is elongated (aspect ratio over 2.5): cracks or lack of fusion; the layer "Pores, AR > 2.5" shows only those.`);
    const clipped = summary.clipped_volume_mm3 / total;
    if (clipped >= CLIPPED) out.push(`${pct(clipped)} of the void volume is cut by the field-of-view edge: those volumes are lower bounds.`);
    // Near-surface voids only mean something against the shell's own share of the part: in a small part the outer
    // 0.5 mm can be half the volume, so evenly spread voids put half their volume there too.
    const placed = kept.filter((p) => Number.isFinite(p.surface_distance_mm));
    if (placed.length && Number.isFinite(shellShare) && shellShare > 0) {
      const near = placed.filter((p) => p.surface_distance_mm <= NEAR_SURFACE_MM).reduce((s, p) => s + p.volume_mm3, 0) / total;
      if (near >= SHARE && near >= GATHER * shellShare) out.push(`${pct(near)} of the void volume lies within ${NEAR_SURFACE_MM} mm of the surface, a shell that is ${pct(shellShare)} of the part: voids gather near the surface (skin or contour), not in the core.`);
    }
    if (split && split.open_percent >= 0.5 * (split.open_percent + split.closed_percent + split.unknown_percent) && split.open_percent > 0) {
      out.push(`Most of the porosity is open to the surface (${split.open_percent.toFixed(2)} of ${summary.all_void_percent_of_body.toFixed(2)} %): water gets into it, so seal the sample for an Archimedes bulk density.`);
    }
    const axes = through ? ['x', 'y', 'z'].filter((a) => through[a]) : [];
    if (axes.length) out.push(`Open voids reach both ends of the part along ${axes.join(' and ')}: the part may leak along that axis.`);
    const n = summary.rejected_count;
    if (n) out.push(`${n} void${n > 1 ? 's' : ''} rejected by hand ${n > 1 ? 'are' : 'is'} left out of these numbers.`);
    return out;
  }

  /** Zones: stats from ct_zones.js ({ zone: 1 baseline, 2 high-gray, 3 low-gray, volume_mm3, void_percent, excess_median }). */
  function zoneInsights({ stats }) {
    const base = stats.find((s) => s.zone === 1), total = stats.reduce((s, z) => s + z.volume_mm3, 0), out = [];
    for (const [zone, name, word] of [[2, 'high-gray', 'over'], [3, 'low-gray', 'under']]) {
      const z = stats.find((s) => s.zone === zone);
      if (!z || !(z.volume_mm3 > 0) || !total) continue;
      const gray = z.excess_median === null ? '' : `, ${zone === 2 ? '+' : ''}${(100 * (zone === 2 ? z.excess_median : Math.abs(z.excess_median))).toFixed(1)} % gray ${word} the baseline`;
      out.push(`The ${name} zone is ${pct(z.volume_mm3 / total)} of the part (${z.volume_mm3.toFixed(0)} mm³)${gray}, with ${z.void_percent.toFixed(2)} % porosity${base ? ` vs ${base.void_percent.toFixed(2)} % in the baseline` : ''}.`);
    }
    if (!out.length) out.push('No high-gray or low-gray zone: the gray is even across the part at this threshold.');
    return out;
  }

  /** CAD: stats (deviationStats), toleranceMm, shrinkagePercent (null without a fitted scale), unmeasuredPercent. */
  function cadInsights({ stats, toleranceMm, shrinkagePercent, unmeasuredPercent }) {
    if (!stats || !stats.measured) return ['No surface points were measured: press Align, or check the STL units.'];
    const out = [], m = stats.p50;
    out.push(Math.abs(m) <= toleranceMm / 4 ? `The surface is centered on the nominal (median ${signed(m)} mm).`
      : `The part is ${m > 0 ? 'oversize' : 'undersize'} on average by ${Math.abs(m).toFixed(3)} mm (median deviation): material ${m > 0 ? 'outside' : 'missing from'} the nominal.`);
    if (Number.isFinite(stats.within_percent) && stats.within_percent >= 99.5) out.push(`The whole measured surface is within ±${toleranceMm.toFixed(3)} mm.`);
    else if (Number.isFinite(stats.within_percent)) out.push(`${stats.within_percent.toFixed(0)} % of the surface is within ±${toleranceMm.toFixed(3)} mm; ${(100 - stats.within_percent).toFixed(0)} % is outside (red on the model: extra material, blue: missing).`);
    out.push(`90 % of the surface lies between ${signed(stats.p05)} and ${signed(stats.p95)} mm.`);
    if (Number.isFinite(shrinkagePercent)) out.push(`The best uniform scale says the part ${shrinkagePercent > 0 ? 'shrank' : 'grew'} ${Math.abs(shrinkagePercent).toFixed(2)} % against the CAD.`);
    if (unmeasuredPercent >= 5) out.push(`${unmeasuredPercent.toFixed(0)} % of the CAD surface found no scan surface within the search range: check the alignment, or the part runs out of the scan.`);
    return out;
  }

  const AXES = ['x', 'y', 'z'];

  /** Filler: summary and dispersion from vb_filler.js analyzeFiller. */
  function fillerInsights({ summary, dispersion }) {
    if (!summary || !summary.count) return ['No bright particles above the threshold.'];
    const out = [`${summary.count} particles, ${summary.volume_percent.toFixed(2)} % of the sample volume; median ESD ${summary.esd_p50_mm === null ? 'n/a' : `${summary.esd_p50_mm.toFixed(3)} mm`}.`];
    if (summary.near_noise >= 0.1 * summary.count) out.push(`${summary.near_noise} particles are close to the noise threshold: raise the sensitivity (SD) to drop them if they are noise.`);
    const R = dispersion && dispersion.clark_evans;
    if (Number.isFinite(R)) {
      out.push(R < 0.8 ? `Particles are clustered (Clark-Evans R ${R.toFixed(2)}): agglomerates or poor mixing; R = 1 is random.`
        : R > 1.2 ? `Particles are evenly spaced (Clark-Evans R ${R.toFixed(2)}); R = 1 is random.` : `Particles are spread at random (Clark-Evans R ${R.toFixed(2)}).`);
    }
    const o = summary.orientation;
    if (o && !o.too_few && o.eigenvalues) {
      const e1 = o.eigenvalues[0], axis = AXES[o.direction.map(Math.abs).indexOf(Math.max(...o.direction.map(Math.abs)))];
      out.push(e1 >= 0.6 ? `Fibers are aligned, mostly along ${axis} (largest orientation eigenvalue ${e1.toFixed(2)}); 1/3 would be random.`
        : `Fibers point in many directions (largest orientation eigenvalue ${e1.toFixed(2)}); 1/3 would be random.`);
    }
    if (summary.clipped > 0) out.push(`${summary.clipped} particles are cut by the scan edge: their sizes are lower bounds.`);
    return out;
  }

  /** Walls: stats, resolvedMinMm and beyondStack from vb_wall.js wallReport. */
  function wallInsights({ stats, resolvedMinMm, beyondStack }) {
    if (!stats || !stats.count || stats.min_mm === null) return ['No walls thick enough to measure (at least about 3 analysis voxels).'];
    const out = [stats.p50_mm - stats.min_mm <= SAME_WALL * stats.p50_mm ? `The walls are all about ${stats.p50_mm.toFixed(2)} mm thick (thinnest ${stats.min_mm.toFixed(2)} mm).`
      : `The thinnest wall is ${stats.min_mm.toFixed(2)} mm; half the walls are thinner than ${stats.p50_mm.toFixed(2)} mm.`];
    if (stats.min_mm <= 1.1 * resolvedMinMm) out.push(`The thinnest walls are at the resolution limit (${resolvedMinMm.toFixed(2)} mm): thinner walls, if any, are not reported.`);
    if (beyondStack > 0) out.push(`${beyondStack.toLocaleString('en-US')} wall points touch the first or last slice and are left out: their walls run past the scan.`);
    return out;
  }

  return { poreInsights, zoneInsights, cadInsights, fillerInsights, wallInsights, quantile };
}));
