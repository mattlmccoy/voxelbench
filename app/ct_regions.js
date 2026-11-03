/* Labeled regions: freehand outlines across a slice range, their statistics and density estimates.
   Region labels record what the operator assigns; gray measures bulk attenuation, not composition. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'), require('./ct_core.js'));
  else root.CTRegions = factory(root.CTPores, root.CT);
}(typeof self !== 'undefined' ? self : this, function (P, CT) {
  'use strict';

  // Labels are the user's own (stored with the project); these are the starting set. Crop is built in.
  const DEFAULT_LABELS = [
    { id: 'region_a', label: 'Region A', color: '#6ec3ff' },
    { id: 'region_b', label: 'Region B', color: '#ff8ad8' },
    { id: 'other_region', label: 'Other', color: '#c9d64f' },
  ];
  const CROP = { id: 'crop', label: 'Crop', color: '#ffb454' };
  // A reference of known density scanned with the sample, for the density calibration (vb_calibration.js).
  const PHANTOM = { id: 'phantom', label: 'Phantom', color: '#f5f7fa' };
  const BUILT_IN = [CROP.id, PHANTOM.id];

  /** The label for an id; a label deleted after regions used it still draws, under a neutral name. */
  function labelOf(id, labels) {
    if (id === CROP.id) return CROP;
    if (id === PHANTOM.id) return PHANTOM;
    return labels.find((l) => l.id === id) || { id, label: '(deleted label)', color: '#8b97a5' };
  }

  function simplifyFreehand(points, tolerance) {
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const last = out[out.length - 1];
      if (Math.hypot(points[i].col - last.col, points[i].row - last.row) >= tolerance) out.push(points[i]);
    }
    const end = points[points.length - 1];
    if (out[out.length - 1] !== end && points.length > 1 && out.length < 2) out.push(end);
    return out;
  }

  function makeRegion({ id, now, sample, plane, sliceFrom, sliceTo, points, label, note, voxelMm, dims, binFactor = 1, phantom }, labels = DEFAULT_LABELS) {
    if (!BUILT_IN.includes(label) && !labels.some((l) => l.id === label)) throw new Error(`Unknown region label: ${label}`);
    if (label === PHANTOM.id && !(phantom && String(phantom.name || '').trim() && Number.isFinite(phantom.density_g_cm3) && phantom.density_g_cm3 > 0)) {
      throw new Error('A phantom needs a name and a measured density above 0 g/cm³.');
    }
    if (points.length < 3) throw new Error('An outline needs at least 3 points.');
    const depth = CT.planeShape(plane, dims).depth;
    const from = Math.max(0, Math.min(sliceFrom, sliceTo));
    const to = Math.min(depth - 1, Math.max(sliceFrom, sliceTo));
    return { schema: 1, id, created_at: now, sample, plane, slice_from: from, slice_to: to, points, label, note, voxel_mm: voxelMm, stack_shape: dims, bin_factor: binFactor,
      belief_not_measurement: !BUILT_IN.includes(label), ...(label === PHANTOM.id ? { phantom: { name: String(phantom.name).trim(), density_g_cm3: phantom.density_g_cm3 } } : {}) };
  }

  function percentile(counts, total, q) {
    const rank = Math.floor(q * (total - 1));
    let seen = 0;
    for (let v = 0; v < counts.length; v++) {
      seen += counts[v];
      if (seen > rank) return v;
    }
    return null;
  }

  /** Statistics at full resolution over an outline's slice range. Pore numbers are null until pores exist. */
  function regionStats({ slices, dims, region, voxelMm, pores, circle }) {
    const { width, height } = CT.planeShape(region.plane, dims);
    const inside = P.rasterPolygon(region.points, width, height);
    const counts = new Uint32Array(65536);
    let voxels = 0, sum = 0, sum2 = 0, poreVoxels = 0, crackVoxels = 0, matrixVoxels = 0, matrixSum = 0;
    const seen = new Set();
    const byId = pores ? new Map(pores.list.map((p) => [p.id, p])) : null;
    for (let slice = region.slice_from; slice <= region.slice_to; slice++) {
      const img = CT.extractPlane(slices, dims, region.plane, slice);
      for (let row = 0, at = 0; row < height; row++) {
        for (let col = 0; col < width; col++, at++) {
          if (!inside[at]) continue;
          const p = CT.voxelOf(region.plane, slice, col, row);
          if (!CT.insideCircle(circle, p.x, p.y)) continue;
          const v = img[at];
          voxels++; sum += v; sum2 += v * v; counts[v]++;
          if (!pores) continue;
          const id = pores.idAt(p.x, p.y, p.z);
          const pore = id && !pores.rejected.has(id) ? byId.get(id) : null;
          if (!pore) { matrixVoxels++; matrixSum += v; } else if (pore.crack_like) crackVoxels++;
          else { poreVoxels++; seen.add(id); }
        }
      }
    }
    const mean = voxels ? sum / voxels : null;
    return { voxels, volume_mm3: voxels * voxelMm ** 3, gray_mean: mean, gray_sd: voxels ? Math.sqrt(Math.max(0, sum2 / voxels - mean * mean)) : null,
      gray_p05: voxels ? percentile(counts, voxels, 0.05) : null, gray_p50: voxels ? percentile(counts, voxels, 0.5) : null, gray_p95: voxels ? percentile(counts, voxels, 0.95) : null,
      matrix_gray_mean: pores && matrixVoxels ? matrixSum / matrixVoxels : null, pore_fraction: pores && voxels ? poreVoxels / voxels : null,
      crack_like_fraction: pores && voxels ? crackVoxels / voxels : null, pore_count: pores ? seen.size : null };
  }

  function estimateAirGray(gray, outside, filled) {
    const values = [];
    for (let i = 0; i < gray.length; i += gray.length > 4e6 ? 31 : 1) if (!outside[i] && !filled[i]) values.push(gray[i]);
    values.sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : null;
  }

  /** Air counts as zero density. g_cm3 exists only when the person supplies an assumed reference density. */
  function densityEstimate({ gray, airGray, referenceGray, referenceDensity }) {
    const span = referenceGray - airGray;
    if (!(Math.abs(span) > 1e-9) || gray === null) return { relative: null, g_cm3: null };
    const relative = (gray - airGray) / span;
    return { relative, g_cm3: Number.isFinite(referenceDensity) ? relative * referenceDensity : null };
  }

  /** What deleting a label writes. Labels never stored are the defaults: save the list without it, so the removal
      does not wait on a database round trip. A stored label is removed. */
  function labelDelete(list, id, stored) {
    return stored ? { save: null, remove: id } : { save: list.filter((l) => l.id !== id), remove: null };
  }

  /** The label drawing continues with: built-in labels (crop, phantom) are one-off, so the next region is the
      first user label. */
  const drawLabel = (label, labels) => (BUILT_IN.includes(label) ? labels[0].id : label);

  return { DEFAULT_LABELS, CROP, PHANTOM, labelOf, drawLabel, labelDelete, simplifyFreehand, makeRegion, regionStats, estimateAirGray, densityEstimate };
}));
