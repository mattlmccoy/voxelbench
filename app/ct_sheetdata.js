/* Numbers behind the review sheet, computed in the page so the export matches the Python report
   (ct_pipeline/sample_report.py). Volumes are raster order (z, y, x). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CTSheetData = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE_EDGES_MM = [0.08, 0.12, 0.16, 0.25, 0.4, 0.63, 1, 1.6, 2.5, 4, 6.3, 10];
  // Matplotlib magma, reversed: low porosity pale, high porosity dark.
  const MAGMA_R = [[252, 253, 191], [254, 194, 135], [251, 135, 97], [229, 80, 100], [181, 54, 122], [129, 37, 129], [79, 18, 123], [28, 16, 68], [0, 0, 4]];

  /** Pore thickness over sample thickness through z at each (y, x), percent; NaN where the sample is thinner than minHeightMm. */
  function columnPorosity(voids, body, { nx, ny, nz }, voxelMm, minHeightMm) {
    const out = new Float64Array(nx * ny);
    for (let i = 0; i < nx * ny; i++) {
      let h = 0, t = 0;
      for (let z = 0; z < nz; z++) {
        const k = z * nx * ny + i;
        if (body[k]) { h++; t += voids[k]; }
      }
      out[i] = h * voxelMm >= minHeightMm ? (100 * t) / h : NaN;
    }
    return out;
  }

  /** Porosity and solid-weighted matrix gray per slab normal to x. */
  function axialProfile(voids, body, gray, weight, { nx, ny, nz }, voxelMm) {
    const n = new Float64Array(nx), v = new Float64Array(nx), g = new Float64Array(nx), w = new Float64Array(nx);
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (!body[i]) continue;
          n[x]++; v[x] += voids[i]; g[x] += gray[i] * weight[i]; w[x] += weight[i];
        }
      }
    }
    const x = [], porosity = [], g2 = [], count = [];
    for (let k = 0; k < nx; k++) { x.push((k + 0.5) * voxelMm); porosity.push(n[k] ? (100 * v[k]) / n[k] : 0); g2.push(w[k] ? g[k] / w[k] : NaN); count.push(n[k]); }
    return { x, porosity, gray: g2, count };
  }

  function sizeBins(pores, rejected, edges) {
    const kept = pores.filter((p) => !rejected.has(p.id));
    const total = kept.reduce((s, p) => s + p.volume_mm3, 0);
    return edges.map((lo, k) => {
      const hi = k + 1 < edges.length ? edges[k + 1] : Infinity;
      const inside = kept.filter((p) => p.diameter_mm >= lo && p.diameter_mm < hi);
      const volume = inside.reduce((s, p) => s + p.volume_mm3, 0);
      return { label: hi === Infinity ? `≥ ${lo} mm` : `${lo} to ${hi} mm`, count: inside.length, volume_share: total ? volume / total : 0 };
    });
  }

  function sizeDistribution(pores, rejected) {
    const edges = SIZE_EDGES_MM;
    const count = new Array(edges.length - 1).fill(0), volume = new Array(edges.length - 1).fill(0);
    for (const p of pores) {
      if (rejected.has(p.id)) continue;
      let k = 0;
      while (k + 1 < edges.length - 1 && p.diameter_mm >= edges[k + 1]) k++;
      count[k]++; volume[k] += p.volume_mm3;
    }
    return { edges_mm: edges.slice(), count, volume_mm3: volume };
  }

  /** A copy of the mask without slices whose cross-section is under `share` of the largest, along x, y and z in turn
      (mask closing pushes small blocks out to the frame edge). */
  function sliceAreaFilter(mask, { nx, ny, nz }, share) {
    const out = mask.slice();
    for (const [n, coord] of [[nx, (i) => i % nx], [ny, (i) => Math.floor(i / nx) % ny], [nz, (i) => Math.floor(i / (nx * ny))]]) {
      const area = new Float64Array(n);
      for (let i = 0; i < out.length; i++) if (out[i]) area[coord(i)]++;
      let peak = 0;
      for (let k = 0; k < n; k++) if (area[k] > peak) peak = area[k];
      for (let i = 0; i < out.length; i++) if (out[i] && area[coord(i)] < share * peak) out[i] = 0;
    }
    return out;
  }

  // Eigenvectors of a symmetric 3x3 matrix by Jacobi rotation; columns of v, eigenvalues on the diagonal of a.
  function jacobi3(m) {
    const a = m.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
      for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
        if (Math.abs(a[p][q]) < 1e-12) continue;
        const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
        for (let k = 0; k < 3; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - s * kq; a[k][q] = s * kp + c * kq; }
        for (let k = 0; k < 3; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - s * qk; a[q][k] = s * pk + c * qk; }
        for (let k = 0; k < 3; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = c * kp - s * kq; v[k][q] = s * kp + c * kq; }
      }
    }
    return { values: [a[0][0], a[1][1], a[2][2]], vectors: [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]]) };
  }

  /** Box lengths along scan axes (cut where the mask meets the frame, or the circle where it faces that axis) and
      lengths along the principal axes, all in mm. circle is in this grid's cells. Matches sample_report.part_extents. */
  function extents(mask, { nx, ny, nz }, voxelMm, circle) {
    const lo = [Infinity, Infinity, Infinity], hi = [-1, -1, -1], n = [nx, ny, nz];
    let count = 0;
    const sum = [0, 0, 0], sq = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const cut = [false, false, false];
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (!mask[i]) continue;
          const c = [x, y, z];
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c[k]); hi[k] = Math.max(hi[k], c[k]); sum[k] += c[k]; for (let j = 0; j < 3; j++) sq[k][j] += c[k] * c[j]; }
          count++;
          if (circle && Math.hypot(x + 0.5 - circle.cx, y + 0.5 - circle.cy) >= circle.r - 2) {
            if (Math.abs(x + 0.5 - circle.cx) >= 0.7 * circle.r) cut[0] = true;
            if (Math.abs(y + 0.5 - circle.cy) >= 0.7 * circle.r) cut[1] = true;
          }
        }
      }
    }
    for (let k = 0; k < 3; k++) if (lo[k] === 0 || hi[k] === n[k] - 1) cut[k] = true;
    const mean = sum.map((s) => s / count);
    const cov = sq.map((r, k) => r.map((s, j) => s / count - mean[k] * mean[j]));
    const { values, vectors } = jacobi3(cov);
    const order = [0, 1, 2].sort((a, b) => values[b] - values[a]);
    const span = order.map(() => [Infinity, -Infinity]);
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (!mask[i]) continue;
          order.forEach((o, k) => { const t = (x - mean[0]) * vectors[o][0] + (y - mean[1]) * vectors[o][1] + (z - mean[2]) * vectors[o][2]; span[k][0] = Math.min(span[k][0], t); span[k][1] = Math.max(span[k][1], t); });
        }
      }
    }
    const axis = (k) => ({ mm: (hi[k] - lo[k] + 1) * voxelMm, cut: cut[k] });
    return { x: axis(0), y: axis(1), z: axis(2), principal_mm: span.map(([a, b]) => (b - a + 1) * voxelMm) };
  }

  function magmaR(t) {
    const s = Math.max(0, Math.min(1, t)) * (MAGMA_R.length - 1);
    const k = Math.min(MAGMA_R.length - 2, Math.floor(s)), f = s - k;
    return MAGMA_R[k].map((c, j) => Math.round(c + f * (MAGMA_R[k + 1][j] - c)));
  }

  function niceTicks(lo, hi, target) {
    const raw = (hi - lo) / target;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.999) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9 * step; v += step) out.push(Number(v.toFixed(10)));
    return out;
  }

  /** The Methods line on the review sheet: where the voxel size came from (the VOX header or the TIFF resolution tag) and
      the scanner settings when a DataInfo record was read. settingsText formats the record (VBVox.settingsText). */
  function methodsSourceLine({ voxelMm, binFactor, scanInfo, kind, settingsText }) {
    const source = kind === 'vox' ? 'the scan file spacing' : 'the TIFF tag';
    const how = binFactor > 1 ? `${binFactor}× ${source}, binned` : (kind === 'vox' ? 'from the scan file' : 'TIFF tag');
    return `Voxel ${(1000 * voxelMm).toFixed(2)} µm (${how}). ${scanInfo ? `Scanned at ${settingsText(scanInfo)}.` : 'Acquisition parameters not recorded.'}`;
  }

  return { methodsSourceLine, SIZE_EDGES_MM, columnPorosity, axialProfile, sliceAreaFilter, extents, sizeBins, sizeDistribution, magmaR, niceTicks };
}));
