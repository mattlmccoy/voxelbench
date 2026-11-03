/* Files for analysis outside the page: pore and annotation tables, region reports, and a NumPy label volume. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_calibration.js'), require('./ct_core.js'));
  else root.CTExport = factory(root.VBCalibration, root.CT);
}(typeof self !== 'undefined' ? self : this, function (C, C2) {
  'use strict';

  const CHUNK_ROWS = 1500;
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const row = (values) => values.map(cell).join(',');

  const PORE_COLUMNS = ['id', 'x_voxel', 'y_voxel', 'z_voxel', 'x_mm', 'y_mm', 'z_mm', 'volume_mm3', 'equivalent_diameter_mm', 'elongation', 'crack_like', 'clipped', 'rejected', 'open', 'surface_distance_mm', 'network', 'sphericity'];
  const poreRow = (p, rejected) => [p.id, p.x, p.y, p.z, p.x_mm, p.y_mm, p.z_mm, p.volume_mm3, p.diameter_mm, p.elongation, p.crack_like, p.clipped, rejected.has(p.id), p.open, p.surface_distance_mm, p.network, p.sphericity];

  const describe = (s) => [s.name, s.material || 'material not recorded', s.process || 'process not recorded'].join(', ');

  const provenanceRows = (provenance) => (provenance ? [`# ${provenance}`] : []);

  const gridNote = (f) => (f > 1 ? `the ${f}× binned grid` : 'the full-resolution grid');

  function poreCsv(pores, rejected, { sample, settings, summary, provenance, binFactor = 1, calibration }) {
    return [
      `# Pore table for ${sample.folder} (${describe(sample)})`,
      ...provenanceRows(provenance),
      `# Settings: ${JSON.stringify(settings)}`,
      `# Summary: ${JSON.stringify(summary)}`,
      '# Smallest size kept is the minVolumeMm3 setting. Clipped pores touch the reconstruction edge.',
      '# open: outside air reaches the pore through binned gray below the pore threshold, starting at the sample surface or a crop face; a crack narrower than about a binned voxel reads as closed; empty when the pore touches the first or last slice and air does not reach it (unknown). surface_distance_mm: depth inside the sample mask, the stack ends not counted as surface. network: pores whose voxels touch share a number. sphericity: Wadell, from the area and volume of the surface mesh; empty below 100 voxels.',
      ...calibrationRows(calibration),
      `# Voxel indices are 0-based on ${gridNote(binFactor)}.`,
      row(PORE_COLUMNS),
      ...pores.map((p) => row(poreRow(p, rejected))),
    ].join('\n') + '\n';
  }

  const PATCH_COLUMNS = ['id', 'x_voxel', 'y_voxel', 'z_voxel', 'x_mm', 'y_mm', 'z_mm', 'volume_mm3', 'equivalent_diameter_mm', 'gray_mean', 'relative_gray'];

  function patchCsv(patches, { sample, provenance, binFactor = 1, calibration }) {
    return [
      `# Low-density regions for ${sample.folder} (${describe(sample)})`,
      ...provenanceRows(provenance),
      '# Regions with smoothed gray below 0.8 of matrix (air = 0) and above the pore threshold; excluded from porosity. relative_gray: air 0, matrix 1; gray_mean is scanner gray.',
      ...calibrationRows(calibration),
      `# Positions are voxel indices on ${gridNote(binFactor)}.`,
      row(PATCH_COLUMNS),
      ...patches.map((p) => row([p.id, p.x, p.y, p.z, p.x_mm, p.y_mm, p.z_mm, p.volume_mm3, p.diameter_mm, p.gray_mean, p.relative_gray])),
    ].join('\n') + '\n';
  }

  const ZONE_NAMES = { 1: 'baseline', 2: 'high_gray', 3: 'low_gray' };
  // Same naming as CTZones.zoneName: drawn zones are 4 + the index of their label.
  const zoneName = (z, labels) => ZONE_NAMES[z] || (labels[z - 4] ? `drawn_${labels[z - 4].id}` : 'drawn_deleted_label');

  function zoneCsv(zones, assigned, { sample, labels = [], provenance, calibration }) {
    const eq = (g) => C.applyCalibration(calibration, g);
    return [
      `# Gray-value zones for ${sample.folder} (${describe(sample)})`,
      ...provenanceRows(provenance),
      ...calibrationRows(calibration),
      `# Zones segmented on gray value (bulk attenuation), not composition. High-gray threshold: gray offset ${zones.threshold} relative to ${zones.method === 'ends' ? `the pore-free ends of the ${zones.axis} axis at equal depth` : 'the median of all pore-free solid at equal depth'}.`,
      row(['zone', 'assigned_label', 'volume_mm3', 'porosity_percent', 'matrix_gray_mean', 'median_gray_offset', 'matrix_equivalent_density_g_cm3', 'matrix_equivalent_density_extrapolated']),
      ...zones.stats.map((s) => row([zoneName(s.zone, labels), (labels.find((l) => l.id === assigned[s.zone]) || {}).label || 'unassigned', s.volume_mm3, s.void_percent, s.solid_gray_mean, s.excess_median, eq(s.solid_gray_mean) && eq(s.solid_gray_mean).value, eq(s.solid_gray_mean) && eq(s.solid_gray_mean).extrapolated])),
    ].join('\n') + '\n';
  }

  function annotationCsv(annotations) {
    const header = ['id', 'created_at', 'folder', 'name', 'material', 'process', 'plane', 'slice', 'kind', 'type', 'length_mm', 'area_mm2', 'window_low', 'window_high', 'note', 'voxels_xyz', 'mm_xyz',
      'nominal_mm', 'tol_minus_mm', 'tol_plus_mm', 'deviation_mm', 'pass'];
    const xyz = (list) => list.map((p) => `${p.x} ${p.y} ${p.z}`).join(';');
    const r5 = (v) => (Number.isFinite(v) ? Number(v.toFixed(5)) : null);
    return [row(header), ...annotations.map((a) => {
      const check = C2.dimensionCheck(a.length_mm, a.nominal_mm, a.tol_minus_mm, a.tol_plus_mm);
      return row([a.id, a.created_at, a.sample.folder, a.sample.name, a.sample.material, a.sample.process, a.plane, a.slice, a.kind, a.type,
        a.length_mm, a.area_mm2, a.window.low, a.window.high, a.note, xyz(a.voxels), xyz(a.mm), a.nominal_mm ?? null, a.tol_minus_mm ?? null, a.tol_plus_mm ?? null, r5(check.deviation), check.pass]);
    })].join('\n') + '\n';
  }

  // Calibration comment line, shared by the region and zone tables.
  const calibrationRows = (fit) => (fit && fit.ok
    ? [`# Equivalent density of the reference phantoms: density = ${fit.intercept} + ${fit.slope} × gray (${fit.n} points, linear${fit.r2 === null ? '' : `, R² ${fit.r2.toFixed(4)}`}). Material that attenuates differently per gram (doped, filled) does not read its true density. Extrapolated: gray outside the phantom range ${fit.gray_range[0]} to ${fit.gray_range[1]}.`]
    : ['# Gray is uncalibrated: no equivalent density.']);

  function regionCsv(regions, { calibration } = {}) {
    const header = ['id', 'label', 'plane', 'slice_from', 'slice_to', 'note', 'voxels', 'volume_mm3', 'gray_mean', 'gray_sd', 'matrix_gray_mean', 'pore_fraction', 'pore_count', 'relative_density', 'density_estimate_g_cm3',
      'equivalent_density_g_cm3', 'equivalent_density_extrapolated'];
    // Matrix gray when pores are segmented, so pores do not lower it; otherwise all gray in the region.
    const eq = (s) => C.applyCalibration(calibration, s.matrix_gray_mean ?? s.gray_mean);
    return [
      ...calibrationRows(calibration),
      '# Region labels are the operator\'s assignments, not measurements: gray reflects bulk attenuation, not composition.',
      '# relative_density uses air as zero and a chosen reference region as one. density_estimate_g_cm3 is an estimate from an assumed reference density, with no beam-hardening correction and equal attenuation per gram assumed.',
      row(header),
      ...regions.map((r) => row([r.id, r.label, r.plane, r.slice_from, r.slice_to, r.note, r.stats.voxels, r.stats.volume_mm3, r.stats.gray_mean, r.stats.gray_sd, r.stats.matrix_gray_mean,
        r.stats.pore_fraction, r.stats.pore_count, r.density && r.density.relative, r.density && r.density.g_cm3, eq(r.stats) && eq(r.stats).value, eq(r.stats) && eq(r.stats).extrapolated])),
    ].join('\n') + '\n';
  }

  function npyHeader(descr, shape) {
    let text = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`;
    text += ' '.repeat((64 - ((10 + text.length + 1) % 64)) % 64) + '\n';
    const out = new Uint8Array(10 + text.length);
    out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, text.length & 255, text.length >> 8]);
    out.set(new TextEncoder().encode(text), 10);
    return out;
  }

  /** Pieces of a NumPy file of pore ids, shape (z, y, x). fillSlice(z, out) writes one XY slice into out. */
  function* maskParts({ nx, ny, nz }, maxId, fillSlice) {
    const wide = maxId > 65535;
    yield npyHeader(wide ? '<u4' : '<u2', [nz, ny, nx]);
    for (let z = 0; z < nz; z++) {
      const ids = new Uint32Array(nx * ny);
      fillSlice(z, ids);
      const out = wide ? ids : Uint16Array.from(ids);
      yield new Uint8Array(out.buffer);
    }
  }

  let crcTable = null;
  function crcUpdate(crc, bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = crc;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return c;
  }

  /** One-file deflated zip, built piece by piece so a large volume never sits in one array. parts is iterable. */
  async function zipStream(name, parts) {
    const stream = new CompressionStream('deflate-raw');
    const packed = new Response(stream.readable).blob();
    const writer = stream.writable.getWriter();
    let crc = 0xffffffff, size = 0;
    for (const part of parts) {
      crc = crcUpdate(crc, part);
      size += part.length;
      await writer.write(part);
    }
    await writer.close();
    const body = await packed;
    crc = (crc ^ 0xffffffff) >>> 0;
    const nameBytes = new TextEncoder().encode(name);
    const fields = (d, at) => {
      d.setUint16(at, 20, true); d.setUint16(at + 4, 8, true);
      d.setUint32(at + 10, crc, true); d.setUint32(at + 14, body.size, true); d.setUint32(at + 18, size, true);
      d.setUint16(at + 22, nameBytes.length, true);
    };
    const local = new Uint8Array(30 + nameBytes.length);
    const dl = new DataView(local.buffer);
    dl.setUint32(0, 0x04034b50, true); fields(dl, 4); local.set(nameBytes, 30);
    const tail = new Uint8Array(46 + nameBytes.length + 22);
    const dt = new DataView(tail.buffer);
    dt.setUint32(0, 0x02014b50, true); dt.setUint16(4, 20, true); fields(dt, 6); tail.set(nameBytes, 46);
    const end = 46 + nameBytes.length;
    dt.setUint32(end, 0x06054b50, true); dt.setUint16(end + 8, 1, true); dt.setUint16(end + 10, 1, true);
    dt.setUint32(end + 12, end, true); dt.setUint32(end + 16, local.length + body.size, true);
    return new Blob([local, body, tail]);
  }

  /** Pore rows split so each stored database document stays well under its size limit. */
  function poreChunks(pores, rejected) {
    const chunks = [];
    for (let i = 0; i < pores.length; i += CHUNK_ROWS) {
      chunks.push({ columns: PORE_COLUMNS, rows: pores.slice(i, i + CHUNK_ROWS).map((p) => poreRow(p, rejected).map((v) => (typeof v === 'number' ? Number(v.toFixed(5)) : v))) });
    }
    return chunks;
  }

  /** The CAD comparison point by point, in scan mm: each nominal point and normal moved by the fitted pose, its
      deviation (empty where no surface was found or on a sharp edge), and the fit and statistics as comments. */
  function cadCsv({ points, normals, deviations, edge }, { sample, summary, provenance }) {
    const { R, t, s } = summary.transform, r5 = (v) => (Number.isFinite(v) ? Number(v.toFixed(5)) : null);
    const out = [
      `# CAD comparison for ${sample.folder} (${describe(sample)}) against ${summary.file}`,
      ...provenanceRows(provenance),
      '# deviation_mm: distance from the nominal surface to the scanned surface (gray halfway between air and matrix) along the nominal outward normal; positive: material outside the nominal, negative: material missing. Empty: no scanned surface facing within 60° of the normal within the search range, or a point on a sharp CAD edge.',
      `# Pose (nominal to scan mm): p_scan = s·R·p + t with s = ${s}, R = ${JSON.stringify(R)}, t = ${JSON.stringify(t)}. Uniform scale ${summary.scale_fitted ? `fitted: shrinkage ${summary.shrinkage_percent.toFixed(3)} %` : 'not fitted (rigid)'}. RMS of fit ${summary.rms_mm} mm. Iso level ${summary.iso_level}.`,
      `# Statistics (tolerance ±${summary.tolerance_mm} mm): ${JSON.stringify(summary.stats)}`,
      row(['x_mm', 'y_mm', 'z_mm', 'normal_x', 'normal_y', 'normal_z', 'deviation_mm', 'on_sharp_edge']),
    ];
    for (let k = 0; k < deviations.length; k++) {
      const p = points.subarray(3 * k, 3 * k + 3), n = normals.subarray(3 * k, 3 * k + 3);
      const q = [0, 1, 2].map((a) => s * (R[3 * a] * p[0] + R[3 * a + 1] * p[1] + R[3 * a + 2] * p[2]) + t[a]);
      const m = [0, 1, 2].map((a) => R[3 * a] * n[0] + R[3 * a + 1] * n[1] + R[3 * a + 2] * n[2]);
      out.push(row([...q.map(r5), ...m.map(r5), r5(deviations[k]), Boolean(edge && edge[k])]));
    }
    return out.join('\n') + '\n';
  }

  /** The filler and fiber particles, one row each, with the thresholds and definitions as comments. */
  function fillerCsv(particles, result, { sample, provenance }) {
    const t = result.threshold, r5 = (v) => (Number.isFinite(v) ? Number(v.toFixed(5)) : null);
    return [
      `# Filler and fiber particles for ${sample.folder} (${describe(sample)})`,
      ...provenanceRows(provenance),
      `# Thresholds: detection ${r5(t.detection)} (matrix median ${r5(t.median)} + ${t.k} robust SD ${r5(t.sd)}), measurement ${r5(t.threshold)}${t.manual ? ' (set by hand)' : ` (halfway to the median particle peak ${r5(t.bright_gray)})`}. Particles: 26-connected voxels at or above measurement inside the sample mask, at least ${result.minVoxels} voxels.`,
      '# Shape from second moments: aspect_ratio = sqrt(largest/smallest principal variance); length as for a rod, diameter as for a round cross-section; direction = main axis. shape: fiber (elongation sqrt(l1/l2) >= 3, length >= 3 voxels), flake (flatness sqrt(l2/l3) >= 3), else particle. near_noise: peak within 1 robust SD of detection (may be matrix noise). clipped: touches the FOV edge or the volume faces.',
      `# Summary: ${JSON.stringify(result.summary)} Dispersion: ${JSON.stringify(result.dispersion)}`,
      row(['id', 'x_mm', 'y_mm', 'z_mm', 'voxels', 'volume_mm3', 'esd_mm', 'length_mm', 'diameter_mm', 'aspect_ratio', 'direction_x', 'direction_y', 'direction_z', 'peak_gray', 'fiber', 'near_noise', 'clipped', 'shape']),
      ...particles.map((p) => row([p.id, r5(p.x_mm), r5(p.y_mm), r5(p.z_mm), p.voxels, r5(p.volume_mm3), r5(p.esd_mm), r5(p.length_mm), r5(p.diameter_mm), r5(p.aspect), ...p.direction.map(r5), p.peak, p.fiber, p.near_noise, p.clipped, p.shape ?? null])),
    ].join('\n') + '\n';
  }

  return { fillerCsv, cadCsv, poreCsv, annotationCsv, regionCsv, npyHeader, maskParts, zipStream, poreChunks, patchCsv, zoneCsv };
}));
