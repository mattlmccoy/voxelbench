/* Pure logic for VoxelBench: TIFF reading, plane geometry, display window, annotation schema.
   Array convention matches ct_pipeline/ctio.py: (z, y, x) = (slice file, row, column), all indices 0-based. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CT = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';


  const FEATURE_TYPES = [
    { id: 'pore', label: 'Pore', color: '#ff9d2e' },
    { id: 'crack', label: 'Crack', color: '#ff5c8a' },
    { id: 'mid_gray_blob', label: 'Mid-gray region', color: '#45d0ff' },
    { id: 'not_sample', label: 'Not sample (holder, film)', color: '#b7c0cc' },
    { id: 'other', label: 'Other', color: '#b6f05a' },
  ];

  function tagValues(view, entry) {
    const type = view.getUint16(entry + 2, true);
    const count = view.getUint32(entry + 4, true);
    const size = { 3: 2, 4: 4, 5: 8 }[type];
    if (!size) return null;
    const start = size * count <= 4 ? entry + 8 : view.getUint32(entry + 8, true);
    const out = [];
    for (let i = 0; i < count; i++) {
      const at = start + i * size;
      if (type === 3) out.push(view.getUint16(at, true));
      else if (type === 4) out.push(view.getUint32(at, true));
      else out.push(view.getUint32(at, true) / view.getUint32(at + 4, true));
    }
    return out;
  }

  /** Read one uncompressed, single-page, unsigned 16-bit little-endian TIFF. Refuses anything else. */
  function parseTiff(buffer) {
    const view = new DataView(buffer);
    if (view.getUint16(0, true) !== 0x4949 || view.getUint16(2, true) !== 42) throw new Error('This file is not a little-endian TIFF.');
    const ifd = view.getUint32(4, true);
    const n = view.getUint16(ifd, true);
    const tags = {};
    for (let i = 0; i < n; i++) {
      const entry = ifd + 2 + i * 12;
      tags[view.getUint16(entry, true)] = tagValues(view, entry);
    }
    if (view.getUint32(ifd + 2 + n * 12, true) !== 0) throw new Error('Multipage TIFF files are not supported; expected one slice per file.');
    if ((tags[259] || [1])[0] !== 1) throw new Error('Compressed TIFF files are not supported.');
    if ((tags[258] || [0])[0] !== 16) throw new Error('Expected 16-bit gray values.');
    if ((tags[339] || [1])[0] !== 1) throw new Error('Expected unsigned gray values.');
    if ((tags[277] || [1])[0] !== 1) throw new Error('Expected one gray channel per pixel.');
    if (!tags[282] || !tags[283]) throw new Error('The resolution tag is missing, so the voxel size is unknown.');
    if (tags[282][0] !== tags[283][0]) throw new Error('X and Y resolution differ; expected square pixels.');
    const unitMm = { 2: 25.4, 3: 10 }[(tags[296] || [2])[0]];
    if (!unitMm) throw new Error('The resolution tag has no physical unit, so the voxel size is unknown.');

    const width = tags[256][0];
    const height = tags[257][0];
    const bytes = new Uint8Array(width * height * 2);
    const source = new Uint8Array(buffer);
    let filled = 0;
    tags[273].forEach((offset, i) => {
      bytes.set(source.subarray(offset, offset + tags[279][i]), filled);
      filled += tags[279][i];
    });
    if (filled !== bytes.length) throw new Error(`Expected ${bytes.length} bytes of pixels, found ${filled}.`);
    return { width, height, voxelMm: unitMm / tags[282][0], pixels: new Uint16Array(bytes.buffer) };
  }

  /** One slice as an uncompressed little-endian 16-bit TIFF in the layout parseTiff reads, with the voxel size in the
      resolution tags (pixels per cm). Used for generated test scans. */
  function writeTiff(width, height, pixels, voxelMm) {
    const tags = [[256, 3, width], [257, 3, height], [258, 3, 16], [259, 3, 1], [262, 3, 1], [273, 4, 8], [277, 3, 1], [278, 3, height],
      [279, 4, width * height * 2], [282, 5, 'res'], [283, 5, 'res'], [296, 3, 3], [339, 3, 1]];
    const ifd = 8 + width * height * 2, res = ifd + 2 + tags.length * 12 + 4;
    const buf = new ArrayBuffer(res + 8), d = new DataView(buf);
    d.setUint16(0, 0x4949, true); d.setUint16(2, 42, true); d.setUint32(4, ifd, true);
    new Uint16Array(buf, 8, width * height).set(pixels);
    d.setUint16(ifd, tags.length, true);
    tags.forEach(([id, type, value], i) => {
      const e = ifd + 2 + i * 12;
      d.setUint16(e, id, true); d.setUint16(e + 2, type, true); d.setUint32(e + 4, 1, true);
      if (value === 'res') d.setUint32(e + 8, res, true);
      else if (type === 3) d.setUint16(e + 8, value, true);
      else d.setUint32(e + 8, value, true);
    });
    d.setUint32(res, Math.round((10 / voxelMm) * 65536), true); d.setUint32(res + 4, 65536, true);
    return buf;
  }

  const naturalKey = (a, b) => a.localeCompare(b, 'en', { numeric: true });

  /** Group picked files by their parent folder, keeping only slice files, in slice order. */
  function groupStacks(files) {
    const groups = new Map();
    for (const file of files) {
      const parts = file.webkitRelativePath.split('/');
      const base = parts[parts.length - 1];
      if (base.startsWith('.') || !/\.tiff?$/i.test(base) || parts.length < 2) continue;
      const folder = parts[parts.length - 2];
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(file);
    }
    return [...groups.keys()].sort(naturalKey).map((folder) => ({
      folder,
      files: groups.get(folder).sort((a, b) => naturalKey(a.webkitRelativePath, b.webkitRelativePath)),
    }));
  }

  /** One line saying what a number was computed from: voxel size, binning, calibration, tool version. The smallest
      resolved pore is taken as 3 voxels across. */
  /** The grid that coordinates and voxel counts are on: the scan's own, or a binned copy of it. */
  const gridText = (binFactor) => (binFactor > 1 ? `${binFactor}× binned` : 'full resolution');

  /** A stored region or annotation on the grid now loaded. Records keep the grid they were drawn on (bin_factor;
      absent means full resolution, as in version 10); the copy is rescaled, the stored record is not touched. */
  function toGrid(record, binFactor) {
    const s = (record.bin_factor || 1) / binFactor;
    if (s === 1) return record;
    const out = { ...record, bin_factor: binFactor };
    if (record.voxel_mm) out.voxel_mm = record.voxel_mm / s;
    if (record.points) out.points = record.points.map((p) => ({ col: (p.col + 0.5) * s - 0.5, row: (p.row + 0.5) * s - 0.5 }));
    if (record.slice_from !== undefined) { out.slice_from = Math.floor(record.slice_from * s); out.slice_to = Math.max(out.slice_from, Math.ceil((record.slice_to + 1) * s) - 1); }
    if (record.voxels) out.voxels = record.voxels.map((v) => ({ x: Math.floor((v.x + 0.5) * s), y: Math.floor((v.y + 0.5) * s), z: Math.floor((v.z + 0.5) * s) }));
    if (record.slice !== undefined) out.slice = Math.floor((record.slice + 0.5) * s);
    return out;
  }

  function provenanceLine({ voxelMm, binFactor, calibration, toolVersion }) {
    const cal = calibration && calibration.ok ? `calibrated to equivalent density (${calibration.n} points, ${calibration.method})` : 'uncalibrated';
    const um = (mm) => `${Math.round(1000 * mm)} µm`;
    const res = binFactor > 1 ? `${gridText(binFactor)} from ${um(voxelMm / binFactor)}` : gridText(1);
    return `Computed at ${um(voxelMm)} voxels (${res}); smallest resolved pore ESD ${(3 * voxelMm).toFixed(2)} mm; gray ${cal}; VoxelBench ${toolVersion}`;
  }

  /** What the user recorded about a scan folder; a folder nobody described keeps its own name and blank fields. */
  function sampleInfo(folder, samples) {
    const s = samples && samples.get(folder);
    return { folder, name: (s && s.name) || folder, material: (s && s.material) || '', process: (s && s.process) || '', notes: (s && s.notes) || '', calibration_air: !(s && s.calibration_air === false) };
  }

  function planeShape(plane, { nx, ny, nz }) {
    if (plane === 'XY') return { width: nx, height: ny, depth: nz };
    if (plane === 'XZ') return { width: nx, height: nz, depth: ny };
    return { width: ny, height: nz, depth: nx };
  }

  function voxelOf(plane, slice, col, row) {
    if (plane === 'XY') return { x: col, y: row, z: slice };
    if (plane === 'XZ') return { x: col, y: slice, z: row };
    return { x: slice, y: col, z: row };
  }

  function planeOf(plane, { x, y, z }) {
    if (plane === 'XY') return { col: x, row: y, slice: z };
    if (plane === 'XZ') return { col: x, row: z, slice: y };
    return { col: y, row: z, slice: x };
  }

  function extractPlane(slices, { nx, ny, nz }, plane, index) {
    if (plane === 'XY') return slices[index];
    if (plane === 'XZ') {
      const out = new Uint16Array(nx * nz);
      for (let z = 0; z < nz; z++) out.set(slices[z].subarray(index * nx, (index + 1) * nx), z * nx);
      return out;
    }
    const out = new Uint16Array(ny * nz);
    for (let z = 0; z < nz; z++) {
      const s = slices[z];
      for (let y = 0; y < ny; y++) out[z * ny + y] = s[y * nx + index];
    }
    return out;
  }

  /** Canvas position to plane voxel, or null when the position is off the image. */
  function canvasToPlane(view, px, py, width, height) {
    const col = Math.floor((px - view.offsetX) / view.scale);
    const row = Math.floor((py - view.offsetY) / view.scale);
    return col < 0 || row < 0 || col >= width || row >= height ? null : { col, row };
  }

  function fitView(width, height, canvasWidth, canvasHeight) {
    const scale = Math.min(canvasWidth / width, canvasHeight / height);
    return { scale, offsetX: (canvasWidth - width * scale) / 2, offsetY: (canvasHeight - height * scale) / 2 };
  }

  const scaleForWidthMm = (widthMm, voxelMm, paneWidth) => paneWidth / (widthMm / voxelMm);
  const widthMmAtScale = (scale, voxelMm, paneWidth) => (paneWidth / scale) * voxelMm;

  function centerOn(scale, col, row, paneWidth, paneHeight) {
    return { scale, offsetX: paneWidth / 2 - (col + 0.5) * scale, offsetY: paneHeight / 2 - (row + 0.5) * scale };
  }

  const MIN_ZOOM_OF_FIT = 0.25;
  const MAX_SCALE = 32;
  const clampScale = (scale, fitScale) => Math.min(MAX_SCALE, Math.max(MIN_ZOOM_OF_FIT * fitScale, scale));

  function zoomAt(view, px, py, factor) {
    return {
      scale: view.scale * factor,
      offsetX: px - (px - view.offsetX) * factor,
      offsetY: py - (py - view.offsetY) * factor,
    };
  }

  /** Display window 0 to the 99.9th percentile, ignoring exact 0 (outside the reconstruction circle). */
  function autoWindow(slices, { nx, ny, nz }, step) {
    const counts = new Uint32Array(65536);
    let total = 0;
    for (let z = 0; z < nz; z += step) {
      for (let y = 0; y < ny; y += step) {
        for (let x = 0; x < nx; x += step) {
          const v = slices[z][y * nx + x];
          if (v) { counts[v]++; total++; }
        }
      }
    }
    const rank = Math.floor(0.999 * (total - 1));
    let seen = 0, high = null, max = 0;
    for (let v = 1; v < 65536; v++) {
      seen += counts[v];
      if (seen > rank && high === null) high = v;
      if (counts[v]) max = v;
    }
    return { low: 0, high: high === null ? 65535 : high, max };
  }

  function grayToRgba(values, low, high, out) {
    const k = 255 / Math.max(1, high - low);
    for (let i = 0, j = 0; i < values.length; i++, j += 4) {
      const g = (values[i] - low) * k;
      out[j] = g; out[j + 1] = g; out[j + 2] = g;
      out[j + 3] = 255;
    }
  }

  /** Least-squares circle through the edges of the nonzero area, in continuous pixel coordinates
      (pixel col covers [col, col + 1)). Row ends at the image border are not circle edges and are skipped. */
  function fitCircle(slice, width, height) {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    const add = (x, y) => {
      const z = x * x + y * y;
      n++; sx += x; sy += y; sz += z; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
    };
    for (let row = 0; row < height; row++) {
      const at = row * width;
      let first = 0;
      while (first < width && slice[at + first] === 0) first++;
      if (first === width) continue;
      let last = width - 1;
      while (slice[at + last] === 0) last--;
      if (first > 0) add(first, row + 0.5);
      if (last < width - 1) add(last + 1, row + 0.5);
    }
    if (n < 10) return null;
    const a11 = sxx - sx * sx / n, a12 = sxy - sx * sy / n, a22 = syy - sy * sy / n;
    const b1 = (sxz - sx * sz / n) / 2, b2 = (syz - sy * sz / n) / 2;
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-9) return null;
    const cx = (b1 * a22 - b2 * a12) / det;
    const cy = (a11 * b2 - a12 * b1) / det;
    return { cx, cy, r: Math.sqrt((sxx + syy - 2 * cx * sx - 2 * cy * sy) / n + cx * cx + cy * cy) };
  }

  const insideCircle = (c, x, y) => !c || (x + 0.5 - c.cx) ** 2 + (y + 0.5 - c.cy) ** 2 <= c.r * c.r;

  /** Where a straight line at the given perpendicular position crosses the circle, or null if it misses. */
  function chordAt({ cx, cy, r }, position, along = 'y') {
    const center = along === 'y' ? cy : cx;
    const middle = along === 'y' ? cx : cy;
    const half2 = r * r - (position - center) ** 2;
    if (half2 < 0) return null;
    const half = Math.sqrt(half2);
    return [middle - half, middle + half];
  }

  const round6 = (v) => Number(v.toFixed(6));

  /** Build the record stored for one annotation. Coordinates are full-resolution voxel indices;
      mm = index x voxel_mm, measured from the center of voxel 0. */
  function makeAnnotation({ sample, dims, voxelMm, binFactor = 1, window, id, now, plane, slice, kind, type, note, points: clicked }) {
    // A double click on a polygon lands the same voxel twice in a row.
    const points = kind !== 'polygon' ? clicked
      : clicked.filter((p, i) => i === 0 || p.col !== clicked[i - 1].col || p.row !== clicked[i - 1].row);
    const need = { point: 1, caliper: 2 }[kind];
    if (kind === 'polygon' ? points.length < 3 : points.length !== need) {
      throw new Error(kind === 'polygon' ? 'A polygon needs at least 3 points.' : `A ${kind} needs ${need === 2 ? '2 points' : '1 point'}.`);
    }
    if (!FEATURE_TYPES.some((t) => t.id === type)) throw new Error(`Unknown feature type: ${type}`);
    if (!Number.isFinite(voxelMm) || voxelMm <= 0) throw new Error('The voxel size is unknown.');
    const { width, height, depth } = planeShape(plane, dims);
    const inside = points.every((p) => p.col >= 0 && p.row >= 0 && p.col < width && p.row < height);
    if (!inside || slice < 0 || slice >= depth) throw new Error('A point is outside the stack.');

    const voxels = points.map((p) => voxelOf(plane, slice, p.col, p.row));
    const record = {
      schema: 1, id, created_at: now, sample, plane, slice, kind, type, note, voxels,
      mm: voxels.map((v) => ({ x: round6(v.x * voxelMm), y: round6(v.y * voxelMm), z: round6(v.z * voxelMm) })),
      voxel_mm: voxelMm,
      stack_shape: dims,
      bin_factor: binFactor,
      // File number of the first point's slice (the first file of its block when binned); files count from 1, z from 0.
      tiff_file_number: voxels[0].z * binFactor + 1,
      window,
      gray_calibrated: false,
    };
    if (kind === 'caliper') {
      record.length_mm = Math.hypot(points[1].col - points[0].col, points[1].row - points[0].row) * voxelMm;
    }
    if (kind === 'polygon') {
      let twice = 0;
      points.forEach((p, i) => {
        const q = points[(i + 1) % points.length];
        twice += p.col * q.row - q.col * p.row;
      });
      record.area_mm2 = (Math.abs(twice) / 2) * voxelMm * voxelMm;
    }
    return record;
  }

  return {
    FEATURE_TYPES, parseTiff, writeTiff, groupStacks, sampleInfo, gridText, toGrid, provenanceLine, planeShape, voxelOf, planeOf,
    extractPlane, canvasToPlane, fitView, scaleForWidthMm, widthMmAtScale, centerOn, clampScale, zoomAt, autoWindow, grayToRgba, fitCircle, insideCircle, chordAt, makeAnnotation,
  };
}));
