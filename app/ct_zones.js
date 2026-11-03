/* Low-density patches and the candidate material map. Both read bulk density from gray: a zone is a candidate for a
   material, not a measurement of composition. Everything runs on a coarse grid (about 0.16 mm), which is fine enough
   for features near 1 mm and keeps the smoothing quick. Arrays are raster order (z, y, x). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'));
  else root.CTZones = factory(root.CTPores);
}(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  // Drawn regions paint DRAWN_BASE + the index of their label, for up to MAX_DRAWN labels.
  const ZONE = { BASE: 1, BRIGHT: 2, LOW: 3, DRAWN_BASE: 4 };
  const MAX_DRAWN = 8;
  const ZONE_NAMES = { 1: 'baseline', 2: 'high_gray', 3: 'low_gray' };

  /** Machine name of a zone value: a gray zone, or drawn_<label id> for a region painted over the draft. */
  function zoneName(value, labels = []) {
    if (value < ZONE.DRAWN_BASE) return ZONE_NAMES[value];
    const l = labels[value - ZONE.DRAWN_BASE];
    return l ? `drawn_${l.id}` : 'drawn_deleted_label';
  }
  const DEFAULT_PATCH_SETTINGS = { patchSigma: 1.5, patchFraction: 0.8, patchMinMm3: 0.1, patchMaxMm3: 20, patchSkin: 3, patchEdgeMm: 2 };
  // baseline: 'whole' takes the median of all pore-free solid material at each depth; 'ends' only the two ends of the
  // long axis (version 10's method, for parts graded along one axis).
  const DEFAULT_ZONE_SETTINGS = { sigma: 3, endShare: 0.16, voidFree: 0.005, voidSigma: 6, lowDrop: 0.08, baseline: 'whole' };
  const DEPTH_BIN_MM = 0.5;
  const SKIN_MM = 0.5; // gray falls toward any surface, so a dark zone must have a core deeper than this
  const SCAN_EDGE_MM = 2; // the outer ring of the reconstruction reads dark on Sample 2 (gray recovers over 2 to 3 mm)
  const MIN_END_SHARE = 0.03; // of the body: fewer pore-free end voxels than this gives no usable baseline
  const INNER_DEPTH_MM = 1;
  const CLOSE_MM = 0.64;
  const DIP_RATIO = 0.97; // the dip between two groups must fall this far below the smaller peak
  const MOSTLY_SOLID = 0.5;
  const HIST = { low: -0.3, high: 0.3, step: 0.01 };

  // One-dimensional squared distance transform (Felzenszwalb and Huttenlocher), in place along a line.
  function edtLine(f, d, v, z, n) {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s;
      do {
        const p = v[k];
        s = (f[q] + q * q - f[p] - p * p) / (2 * q - 2 * p);
      } while (s <= z[k] && --k >= 0);
      k++;
      v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      d[q] = (q - p) * (q - p) + f[p];
    }
  }

  /** Euclidean distance in voxels from each set voxel to the nearest unset voxel; past the stack edge counts as unset. */
  function distanceInside(mask, dims) {
    const { nx, ny, nz } = dims;
    const big = nx * nx + ny * ny + nz * nz;
    const out = new Float32Array(mask.length);
    // One padding voxel at each end of a line stands for the outside of the stack.
    const size = Math.max(nx, ny, nz) + 2;
    const f = new Float64Array(size), d = new Float64Array(size), v = new Int32Array(size), z = new Float64Array(size + 1);
    for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? big : 0;
    const sweep = (start, stride, len) => {
      f[0] = 0; f[len + 1] = 0;
      for (let i = 0; i < len; i++) f[i + 1] = out[start + i * stride];
      edtLine(f, d, v, z, len + 2);
      for (let i = 0; i < len; i++) out[start + i * stride] = d[i + 1];
    };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) sweep((k * ny + j) * nx, 1, nx);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) sweep(k * ny * nx + i, nx, ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sweep(j * nx + i, nx * ny, nz);
    for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(out[i]);
    return out;
  }

  // Solid voxels: inside the body and clear of any void, whose edge reads partly air.
  function solidWeights(voids, body, dims) {
    const near = P.boxDilate(voids, dims, 1);
    const w = new Float32Array(voids.length);
    for (let i = 0; i < w.length; i++) w[i] = body[i] && !near[i] ? 1 : 0;
    return w;
  }

  // Smooth values over weighted voxels only, so a pore or the outside never darkens its neighbors.
  function weightedSmooth(values, w, dims, sigma) {
    const top = new Float32Array(values.length);
    for (let i = 0; i < top.length; i++) top[i] = values[i] * w[i];
    const a = P.gaussian(top, dims, sigma), b = P.gaussian(w, dims, sigma);
    const out = new Float32Array(values.length);
    for (let i = 0; i < out.length; i++) out[i] = b[i] > 1e-3 ? a[i] / b[i] : 0;
    return out;
  }

  function medianOf(values) {
    if (!values.length) return null;
    const s = Float32Array.from(values).sort();
    return s[s.length >> 1];
  }

  /** Blobs of mid gray that the void threshold passes over: solid-looking at this resolution, but with less mass per
      volume than the surrounding solid. Anything above patchMaxMm3 is a zone, not a patch, and stays out of the list. */
  function findPatches({ gray, voids, weight, scanDepth, body, dims, airGray, voxelMm, settings }) {
    const { nx, ny, nz } = dims;
    const n = gray.length;
    const w = weight || solidWeights(voids, body, dims);
    const s = weightedSmooth(gray, w, dims, settings.patchSigma);
    const sample = [];
    const step = n > 4e6 ? 7 : 1;
    for (let i = 0; i < n; i += step) if (w[i] >= MOSTLY_SOLID) sample.push(s[i]);
    const solidGray = medianOf(sample);
    const out = { labels: new Uint32Array(n), patches: [], solidGray };
    if (solidGray === null) return out;
    const limit = airGray + settings.patchFraction * (solidGray - airGray);
    const inner = P.boxErode(body, dims, settings.patchSkin);
    const low = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (inner[i] && w[i] >= MOSTLY_SOLID && s[i] < limit && !(scanDepth && scanDepth[i] < settings.patchEdgeMm)) low[i] = 1;
    const { labels, count } = P.label(low, dims);
    const stat = Array.from({ length: count + 1 }, () => ({ c: 0, x: 0, y: 0, z: 0, g: 0 }));
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (!labels[i]) continue;
          const m = stat[labels[i]];
          m.c++; m.x += x; m.y += y; m.z += z; m.g += gray[i];
        }
      }
    }
    const voxelVolume = voxelMm ** 3;
    const kept = [];
    for (let l = 1; l <= count; l++) {
      const m = stat[l], volume = m.c * voxelVolume;
      if (volume < settings.patchMinMm3 || volume > settings.patchMaxMm3) continue;
      const mean = m.g / m.c;
      kept.push({ source: l, x: m.x / m.c, y: m.y / m.c, z: m.z / m.c, volume_mm3: volume, diameter_mm: ((6 * volume) / Math.PI) ** (1 / 3), gray_mean: mean, relative_gray: (mean - airGray) / (solidGray - airGray) });
    }
    kept.sort((a, b) => b.volume_mm3 - a.volume_mm3);
    const remap = new Uint32Array(count + 1);
    kept.forEach((p, i) => { p.id = i + 1; remap[p.source] = p.id; delete p.source; });
    for (let i = 0; i < n; i++) if (labels[i]) out.labels[i] = remap[labels[i]];
    out.patches = kept;
    return out;
  }

  // The longest axis of the body's bounding box, and its extent.
  function longestAxis(body, { nx, ny, nz }) {
    const lo = [Infinity, Infinity, Infinity], hi = [-1, -1, -1];
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (!body[i]) continue;
          if (x < lo[0]) lo[0] = x;
          if (x > hi[0]) hi[0] = x;
          if (y < lo[1]) lo[1] = y;
          if (y > hi[1]) hi[1] = y;
          if (z < lo[2]) lo[2] = z;
          if (z > hi[2]) hi[2] = z;
        }
      }
    }
    const span = hi.map((h, a) => h - lo[a]);
    const axis = span.indexOf(Math.max(...span));
    return { axis, lo: lo[axis], hi: hi[axis], name: 'xyz'[axis] };
  }

  /** Everything that does not depend on the threshold: gray relative to the pore-free ends at the same depth, which
      removes the scanner's shading from surface to center. refused says why no baseline exists. */
  function prepareZones({ gray, voids, weight, scanDepth, body, dims, airGray, voxelMm, settings }) {
    const { nx, ny, nz } = dims;
    const n = gray.length;
    const depth = distanceInside(body, dims);
    for (let i = 0; i < n; i++) depth[i] *= voxelMm;
    const w = weight || solidWeights(voids, body, dims);
    const { axis, lo, hi, name } = longestAxis(body, dims);
    const voidTop = new Float32Array(n), bodyF = new Float32Array(n);
    let bodyCount = 0;
    for (let i = 0; i < n; i++) { voidTop[i] = body[i] ? voids[i] : 0; bodyF[i] = body[i] ? 1 : 0; bodyCount += body[i] ? 1 : 0; }
    const vs = P.gaussian(voidTop, dims, settings.voidSigma), bs = P.gaussian(bodyF, dims, settings.voidSigma);
    const method = settings.baseline === 'ends' ? 'ends' : 'whole';
    const share = settings.endShare * (hi - lo + 1);
    const bins = [];
    let endCount = 0;
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (w[i] < MOSTLY_SOLID || depth[i] < DEPTH_BIN_MM || (scanDepth && scanDepth[i] < SCAN_EDGE_MM)) continue;
          const a = axis === 0 ? x : axis === 1 ? y : z;
          if (method === 'ends' && a >= lo + share && a <= hi - share) continue;
          if (vs[i] >= settings.voidFree * Math.max(bs[i], 1e-3)) continue;
          endCount++;
          const b = Math.floor(depth[i] / DEPTH_BIN_MM);
          (bins[b] = bins[b] || []).push(gray[i]);
        }
      }
    }
    if (endCount < MIN_END_SHARE * bodyCount) {
      if (method === 'whole') return { refused: `No baseline: less than ${(100 * MIN_END_SHARE).toFixed(0)}% of the body is pore-free solid (${(100 * endCount / bodyCount).toFixed(1)}%). Outline regions by hand instead.`, method };
      return { method, refused: `No baseline: the two ends of the part along its long axis are not pore-free (${(100 * endCount / bodyCount).toFixed(1)}% of the body qualifies, ${(100 * MIN_END_SHARE).toFixed(0)}% needed). Outline regions by hand instead.` };
    }
    const mids = [], base = [];
    bins.forEach((list, b) => { if (list.length >= 50) { mids.push((b + 0.5) * DEPTH_BIN_MM); base.push(medianOf(list)); } });
    const baseAt = (d) => {
      if (d <= mids[0]) return base[0];
      for (let k = 1; k < mids.length; k++) if (d <= mids[k]) return base[k - 1] + ((d - mids[k - 1]) / (mids[k] - mids[k - 1])) * (base[k] - base[k - 1]);
      return base[base.length - 1];
    };
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) if (w[i] > 0) { const c = baseAt(depth[i]); raw[i] = (gray[i] - c) / (c - airGray); }
    return { refused: null, method, excess: weightedSmooth(raw, w, dims, settings.sigma), depth, w, axis: name, baseline: mids.map((d, k) => ({ depth_mm: d, gray: base[k] })) };
  }

  /** Gray value of the dip between the baseline group near zero and a brighter group, from a histogram with HIST's
      bins; null when no later peak rises clearly above the valley. */
  function dipInHistogram(raw) {
    const count = raw.length;
    const h = raw.map((_, i) => (raw[Math.max(0, i - 1)] + raw[i] + raw[Math.min(count - 1, i + 1)]) / 3);
    const value = (i) => HIST.low + (i + 0.5) * HIST.step;
    let first = -1;
    for (let i = 0; i < count; i++) if (Math.abs(value(i)) <= 0.03 && (first < 0 || h[i] > h[first])) first = i;
    if (first < 0) return null;
    let best = null, valley = first;
    for (let i = first + 1; i < count; i++) {
      if (h[i] < h[valley]) valley = i;
      const ratio = h[valley] / Math.min(h[first], h[i] || Infinity);
      if (i > valley && h[i] > h[valley] && (!best || ratio < best.ratio)) best = { ratio, at: valley };
    }
    return best && best.ratio < DIP_RATIO ? value(best.at) : null;
  }

  function histogramCounts(excess, depth, w) {
    const raw = new Float64Array(Math.round((HIST.high - HIST.low) / HIST.step));
    for (let i = 0; i < excess.length; i++) {
      if (w[i] < MOSTLY_SOLID || depth[i] < INNER_DEPTH_MM) continue;
      const b = Math.floor((excess[i] - HIST.low) / HIST.step);
      if (b >= 0 && b < raw.length) raw[b]++;
    }
    return raw;
  }

  function findDip(excess, depth, w) {
    return dipInHistogram(histogramCounts(excess, depth, w));
  }

  /** The gray-offset histogram the zone threshold is chosen from, as volume per bin. */
  function offsetHistogram(ready, voxelMm) {
    const counts = histogramCounts(ready.excess, ready.depth, ready.w);
    return { low: HIST.low, step: HIST.step, volume_mm3: Array.from(counts, (c) => c * voxelMm ** 3) };
  }

  function finishZones(ready, { gray, voids, scanDepth, body, dims, voxelMm, settings }) {
    const { excess, depth, w } = ready;
    let threshold = settings.threshold;
    if (threshold === undefined) {
      threshold = findDip(excess, depth, w);
      if (threshold === null) return { refused: 'Gray shows one group here, not two, so no zones are drawn. Outline regions by hand instead.', zones: null };
    }
    const n = gray.length;
    const bright = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (w[i] >= MOSTLY_SOLID && depth[i] >= INNER_DEPTH_MM && excess[i] > threshold) bright[i] = 1;
    const { labels, count, sizes } = P.label(bright, dims);
    let main = 0;
    for (let l = 1; l <= count; l++) if (sizes[l] > sizes[main]) main = l;
    const biggest = new Uint8Array(n);
    if (main) for (let i = 0; i < n; i++) if (labels[i] === main) biggest[i] = 1;
    const radius = Math.max(1, Math.round(CLOSE_MM / voxelMm));
    const closed = P.boxErode(P.boxDilate(biggest, dims, radius), dims, radius);
    // Darker means a real dark core plus its own skin, so the shading along every surface and scan edge stays out.
    const candidate = new Uint8Array(n), core = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!body[i] || !(excess[i] < -settings.lowDrop) || (scanDepth && scanDepth[i] < SCAN_EDGE_MM)) continue;
      candidate[i] = 1;
      if (depth[i] >= SKIN_MM) core[i] = 1;
    }
    const reach = P.boxDilate(core, dims, Math.max(1, Math.round(SKIN_MM / voxelMm)));
    const zones = new Uint8Array(n);
    const lists = { [ZONE.BASE]: [], [ZONE.BRIGHT]: [], [ZONE.LOW]: [] };
    const stat = { [ZONE.BASE]: { c: 0, g: 0, gc: 0 }, [ZONE.BRIGHT]: { c: 0, g: 0, gc: 0 }, [ZONE.LOW]: { c: 0, g: 0, gc: 0 } };
    for (let i = 0; i < n; i++) {
      if (!body[i]) continue;
      const z = closed[i] ? ZONE.BRIGHT : candidate[i] && reach[i] ? ZONE.LOW : ZONE.BASE;
      zones[i] = z;
      const m = stat[z];
      m.c++;
      if (w[i] >= MOSTLY_SOLID) { m.g += gray[i]; m.gc++; if (i % 5 === 0) lists[z].push(excess[i]); }
    }
    const voidPercent = voidPercentByZone(zones, voids);
    const stats = [ZONE.BRIGHT, ZONE.LOW, ZONE.BASE].map((zone) => {
      const m = stat[zone];
      return { zone, volume_mm3: m.c * voxelMm ** 3, void_percent: voidPercent[zone], solid_gray_mean: m.gc ? m.g / m.gc : null, excess_median: medianOf(lists[zone]) };
    });
    return { refused: null, zones, threshold, stats, axis: ready.axis, baseline: ready.baseline, method: ready.method };
  }

  /** The candidate map. The ends of the long axis set the baseline at each depth from the surface. Zones: BRIGHT above
      the dip between the two gray groups, LOW well below the baseline, BASE the rest. */
  function draftZones(input) {
    const ready = prepareZones(input);
    if (ready.refused) return { refused: ready.refused, zones: null };
    return finishZones(ready, input);
  }

  /** A copy of the zones with drawn regions painted over them, for voxels inside the body. labelIds orders the
      labels (value DRAWN_BASE + index). Outlines are in full-resolution coordinates and extrude through their plane
      over their slice range. */
  function paintZones(zones, dims, factor, regions, labelIds) {
    const out = zones.slice();
    const { nx, ny, nz } = dims;
    const toPoint = (i) => (i + 0.5) * factor;
    for (const r of regions) {
      const k = labelIds.indexOf(r.label);
      if (k < 0 || k >= MAX_DRAWN) continue;
      const value = ZONE.DRAWN_BASE + k;
      const w = r.plane === 'YZ' ? ny : nx, h = r.plane === 'XY' ? ny : nz;
      const raster = P.rasterPolygon(r.points, w, h, toPoint);
      for (let z = 0, i = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++, i++) {
            if (!out[i]) continue;
            const slice = toPoint(r.plane === 'XY' ? z : r.plane === 'XZ' ? y : x);
            if (slice < r.slice_from || slice > r.slice_to + 1) continue;
            if (raster[r.plane === 'XY' ? y * w + x : r.plane === 'XZ' ? z * w + x : z * w + y]) out[i] = value;
          }
        }
      }
    }
    return out;
  }

  /** Volume and void percent of every zone present, from a painted map. */
  function zoneTotals(zones, fractions, voxelMm) {
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < zones.length; i++) counts[zones[i]]++;
    const percent = voidPercentByZone(zones, fractions);
    return Object.values(ZONE).filter((z) => counts[z]).map((zone) => ({ zone, volume_mm3: counts[zone] * voxelMm ** 3, void_percent: percent[zone] }));
  }

  /** Percent of each zone's volume that is void, from per-cell void fractions. */
  function voidPercentByZone(zones, fractions) {
    const count = [0, 0, 0, 0, 0, 0], sum = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < zones.length; i++) if (zones[i]) { count[zones[i]]++; sum[zones[i]] += fractions[i]; }
    return count.map((c, z) => (c ? (100 * sum[z]) / c : null));
  }

  /** Exact share of each coarse cell covered by voids that were not rejected. */
  function voidFractions({ runs, rejected, dims, factor }) {
    const out = { nx: Math.floor(dims.nx / factor), ny: Math.floor(dims.ny / factor), nz: Math.floor(dims.nz / factor) };
    const counts = new Float32Array(out.nx * out.ny * out.nz);
    for (let rowIndex = 0; rowIndex < runs.rows; rowIndex++) {
      const y = Math.floor((rowIndex % dims.ny) / factor), z = Math.floor(Math.floor(rowIndex / dims.ny) / factor);
      if (y >= out.ny || z >= out.nz) continue;
      const base = (z * out.ny + y) * out.nx;
      for (let r = runs.offsets[rowIndex]; r < runs.offsets[rowIndex + 1]; r++) {
        if (rejected.has(runs.id[r])) continue;
        for (let x = runs.start[r]; x < runs.end[r]; x++) { const b = Math.floor(x / factor); if (b < out.nx) counts[base + b]++; }
      }
    }
    const cube = factor ** 3;
    for (let i = 0; i < counts.length; i++) counts[i] /= cube;
    return counts;
  }

  /** Gray averaged over solid voxels only, the solid share of each coarse cell, and the body at the coarse grid. */
  function coarsenSolid(gray, anyVoid, body, { nx, ny, nz }, f) {
    const dims = { nx: Math.floor(nx / f), ny: Math.floor(ny / f), nz: Math.floor(nz / f) };
    const size = dims.nx * dims.ny * dims.nz;
    const sum = new Float32Array(size), solid = new Float32Array(size), inside = new Float32Array(size);
    for (let z = 0; z < dims.nz * f; z++) {
      for (let y = 0; y < dims.ny * f; y++) {
        const base = (Math.floor(z / f) * dims.ny + Math.floor(y / f)) * dims.nx;
        const row = (z * ny + y) * nx;
        for (let x = 0; x < dims.nx * f; x++) {
          const i = row + x, b = base + Math.floor(x / f);
          if (!body[i]) continue;
          inside[b]++;
          if (!anyVoid[i]) { sum[b] += gray[i]; solid[b]++; }
        }
      }
    }
    const cube = f ** 3;
    const out = { gray: new Float32Array(size), weight: new Float32Array(size), body: new Uint8Array(size), dims };
    for (let i = 0; i < size; i++) {
      out.gray[i] = solid[i] ? sum[i] / solid[i] : 0;
      out.weight[i] = solid[i] / cube;
      out.body[i] = inside[i] >= cube / 2 ? 1 : 0;
    }
    return out;
  }

  /** Everything patches and zones need, on the coarse grid: gray over solid voxels only (pore edges read partly air,
      so they are left out with the pores) and the exact void share of each cell. */
  function prepareCoarse({ runs, pores, gray, filled, binnedDims, fullDims, bin, step, voxelMm, circle }) {
    const none = new Set();
    const { masks } = voidClassMasks({ runs, pores, rejected: none, dims: fullDims, factor: bin, minDiameterMm: 0 });
    const any = new Uint8Array(masks.pore.length);
    for (let i = 0; i < any.length; i++) if (masks.pore[i] || masks.crack[i] || masks.clipped[i]) any[i] = 1;
    const c = coarsenSolid(gray, P.boxDilate(any, binnedDims, 1), filled, binnedDims, step);
    c.factor = bin * step;
    c.voxelMm = voxelMm * c.factor;
    c.voidShare = voidFractions({ runs, rejected: none, dims: fullDims, factor: c.factor });
    if (circle) {
      const { nx, ny, nz } = c.dims;
      c.scanDepth = new Float32Array(nx * ny * nz);
      for (let y = 0, at = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, at++) {
          const d = (circle.r - Math.hypot((x + 0.5) * c.factor - circle.cx, (y + 0.5) * c.factor - circle.cy)) * voxelMm;
          for (let z = 0; z < nz; z++) c.scanDepth[z * ny * nx + at] = d;
        }
      }
    }
    return c;
  }

  /** One mask per diameter bin [edges[k], edges[k + 1]); the last bin is open-ended. Any coverage sets a cell. */
  function voidSizeMasks({ runs, pores, rejected, dims, factor, edges }) {
    const out = { nx: Math.floor(dims.nx / factor), ny: Math.floor(dims.ny / factor), nz: Math.floor(dims.nz / factor) };
    const size = out.nx * out.ny * out.nz;
    const masks = edges.slice(0, -1).map(() => new Uint8Array(size));
    const target = new Array(pores.length + 2);
    for (const p of pores) {
      if (rejected.has(p.id) || p.diameter_mm < edges[0]) continue;
      let k = 0;
      while (k + 1 < masks.length && p.diameter_mm >= edges[k + 1]) k++;
      target[p.id] = masks[k];
    }
    for (let rowIndex = 0; rowIndex < runs.rows; rowIndex++) {
      const y = Math.floor((rowIndex % dims.ny) / factor), z = Math.floor(Math.floor(rowIndex / dims.ny) / factor);
      if (y >= out.ny || z >= out.nz) continue;
      const base = (z * out.ny + y) * out.nx;
      for (let r = runs.offsets[rowIndex]; r < runs.offsets[rowIndex + 1]; r++) {
        const m = target[runs.id[r]];
        if (!m) continue;
        const stop = Math.min(out.nx - 1, Math.floor((runs.end[r] - 1) / factor));
        for (let b = Math.floor(runs.start[r] / factor); b <= stop; b++) m[base + b] = 1;
      }
    }
    return { masks, dims: out };
  }

  /** One mask per void class on a coarser grid. Any coverage sets a cell, so a thin crack survives. */
  function voidClassMasks({ runs, pores, rejected, dims, factor, minDiameterMm }) {
    const out = { nx: Math.floor(dims.nx / factor), ny: Math.floor(dims.ny / factor), nz: Math.floor(dims.nz / factor) };
    const size = out.nx * out.ny * out.nz;
    const masks = { pore: new Uint8Array(size), crack: new Uint8Array(size), clipped: new Uint8Array(size) };
    const target = new Array(pores.length + 2);
    for (const p of pores) {
      if (rejected.has(p.id) || p.diameter_mm < minDiameterMm) continue;
      target[p.id] = p.clipped ? masks.clipped : p.crack_like ? masks.crack : masks.pore;
    }
    for (let rowIndex = 0; rowIndex < runs.rows; rowIndex++) {
      const y = Math.floor((rowIndex % dims.ny) / factor), z = Math.floor(Math.floor(rowIndex / dims.ny) / factor);
      if (y >= out.ny || z >= out.nz) continue;
      const base = (z * out.ny + y) * out.nx;
      for (let r = runs.offsets[rowIndex]; r < runs.offsets[rowIndex + 1]; r++) {
        const m = target[runs.id[r]];
        if (!m) continue;
        const stop = Math.min(out.nx - 1, Math.floor((runs.end[r] - 1) / factor));
        for (let b = Math.floor(runs.start[r] / factor); b <= stop; b++) m[base + b] = 1;
      }
    }
    return { masks, dims: out };
  }

  /** One phrase for what the gray offset is measured against, used in the page, the sheet and the CSV. */
  const baselineText = (method, axis) => (method === 'ends' ? `the pore-free ends of the ${axis} axis at equal depth below the surface` : 'the median of all pore-free solid at equal depth below the surface');

  return { ZONE, ZONE_NAMES, MAX_DRAWN, zoneName, baselineText, DEFAULT_PATCH_SETTINGS, DEFAULT_ZONE_SETTINGS, distanceInside, findPatches, prepareZones, finishZones, draftZones, dipInHistogram, offsetHistogram, voidSizeMasks, paintZones, zoneTotals, voidPercentByZone, voidFractions, coarsenSolid, prepareCoarse, voidClassMasks };
}));
