'use strict';
/* Masks for the Dragonfly 3D cross-check: writing VoxelBench's counting region and pore voxels as TIFF stacks, reading
   the mask Dragonfly exports, and comparing two masks. Spec: docs/plans/2026-11-03-dragonfly-crosscheck.md. */

/** One uncompressed 8-bit slice; a nonzero input pixel is written as 255. The voxel size goes in the resolution tags
    (pixels per cm), as in CT.writeTiff. */
function writeMaskTiff(width, height, pixels, voxelMm) {
  const n = width * height;
  const tags = [[256, 3, width], [257, 3, height], [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, 8], [277, 3, 1], [278, 3, height],
    [279, 4, n], [282, 5, 'res'], [283, 5, 'res'], [296, 3, 3]];
  const ifd = 8 + n + (n % 2), res = ifd + 2 + tags.length * 12 + 4;
  const buf = new ArrayBuffer(res + 8), d = new DataView(buf), out = new Uint8Array(buf, 8, n);
  d.setUint16(0, 0x4949, true); d.setUint16(2, 42, true); d.setUint32(4, ifd, true);
  for (let i = 0; i < n; i++) if (pixels[i]) out[i] = 255;
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

const TYPE_BYTES = { 3: 2, 4: 4, 5: 8 };

function tagValues(d, entry, le) {
  const type = d.getUint16(entry + 2, le), count = d.getUint32(entry + 4, le), size = (TYPE_BYTES[type] || 1) * count;
  const at = size <= 4 ? entry + 8 : d.getUint32(entry + 8, le), out = [];
  for (let k = 0; k < count; k++) {
    if (type === 3) out.push(d.getUint16(at + 2 * k, le));
    else if (type === 4) out.push(d.getUint32(at + 4 * k, le));
    else if (type === 5) out.push(d.getUint32(at + 8 * k, le) / d.getUint32(at + 8 * k + 4, le));
    else out.push(d.getUint8(at + k));
  }
  return out;
}

/** Every page of an uncompressed 8- or 16-bit gray TIFF as { width, height, voxelMm (null when the file has no physical
    resolution), pixels: Uint8Array of 0/1 }. Any nonzero value counts as 1. */
function readMaskPages(buffer) {
  const d = new DataView(buffer), order = d.getUint16(0, false);
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('This file is not a TIFF.');
  const le = order === 0x4949, src = new Uint8Array(buffer), pages = [];
  for (let ifd = d.getUint32(4, le); ifd; ) {
    const n = d.getUint16(ifd, le), tags = {};
    for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; tags[d.getUint16(e, le)] = tagValues(d, e, le); }
    if ((tags[259] || [1])[0] !== 1) throw new Error('The mask is compressed; export it from Dragonfly as an uncompressed TIFF.');
    const bits = (tags[258] || [1])[0];
    if (bits !== 8 && bits !== 16) throw new Error(`Expected an 8- or 16-bit mask, found ${bits}-bit.`);
    if ((tags[277] || [1])[0] !== 1) throw new Error('Expected one gray channel per pixel.');
    const width = tags[256][0], height = tags[257][0], bytesPer = bits / 8, pixels = new Uint8Array(width * height);
    let p = 0;
    tags[273].forEach((offset, s) => {
      const len = tags[279][s];
      for (let b = 0; b < len && p < pixels.length; b += bytesPer, p++) pixels[p] = bytesPer === 1 ? (src[offset + b] ? 1 : 0) : (d.getUint16(offset + b, le) ? 1 : 0);
    });
    if (p !== pixels.length) throw new Error(`Expected ${pixels.length} pixels in a page, found ${p}.`);
    const unitMm = { 2: 25.4, 3: 10 }[(tags[296] || [])[0]];
    const voxelMm = tags[282] && unitMm ? unitMm / tags[282][0] : null;
    pages.push({ width, height, voxelMm, pixels });
    ifd = d.getUint32(ifd + 2 + n * 12, le);
  }
  return pages;
}

/** Full-resolution slice z of the region where VoxelBench counts pore voxels: blocks in the coarse interior and not in
    the edge zone (ct_pores.js fineDetect). Voxels past the last whole block are never counted. */
function regionSlice({ interior, edgeZone, binnedDims: b, bin, fullDims: { nx, ny } }, z) {
  const out = new Uint8Array(nx * ny), bz = Math.floor(z / bin);
  if (bz >= b.nz) return out;
  for (let y = 0; y < b.ny * bin; y++) {
    const base = (bz * b.ny + Math.floor(y / bin)) * b.nx;
    for (let x = 0; x < b.nx * bin; x++) {
      const at = base + Math.floor(x / bin);
      if (interior[at] && !edgeZone[at]) out[y * nx + x] = 1;
    }
  }
  return out;
}

/** Full-resolution slice z of the pore voxels in fineDetect's runs, leaving out the voids whose id is in excluded. */
function poreSlice(runs, { nx, ny }, z, excluded) {
  const out = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const row = z * ny + y;
    for (let k = runs.offsets[row]; k < runs.offsets[row + 1]; k++) {
      if (excluded.has(runs.id[k])) continue;
      out.fill(1, y * nx + runs.start[k], y * nx + runs.end[k]);
    }
  }
  return out;
}

/** A growable Int32Array. */
function growable() {
  let a = new Int32Array(1 << 16), n = 0;
  return { push(v) { if (n === a.length) { const b = new Int32Array(a.length * 2); b.set(a); a = b; } a[n++] = v; }, get length() { return n; }, done: () => a.slice(0, n) };
}

/** The 1-voxels of a mask served slice by slice, as runs along x: { offsets (per row z * ny + y, plus one), start, end
    (exclusive) }, the layout fineDetect uses. */
function maskRuns(getSlice, { nx, ny, nz }) {
  const offsets = new Int32Array(nz * ny + 1), start = growable(), end = growable();
  for (let z = 0; z < nz; z++) {
    const s = getSlice(z);
    for (let y = 0; y < ny; y++) {
      offsets[z * ny + y] = start.length;
      const row = y * nx;
      for (let x = 0; x < nx; x++) {
        if (!s[row + x]) continue;
        let e = x + 1;
        while (e < nx && s[row + e]) e++;
        start.push(x); end.push(e); x = e;
      }
    }
  }
  offsets[nz * ny] = start.length;
  return { offsets, start: start.done(), end: end.done() };
}

/** Overlap of [s, e) with the runs of one row. */
function overlapInRow(runs, row, s, e) {
  let total = 0;
  for (let k = runs.offsets[row]; k < runs.offsets[row + 1] && runs.start[k] < e; k++) total += Math.max(0, Math.min(e, runs.end[k]) - Math.max(s, runs.start[k]));
  return total;
}

/** 6-connected components of a run set: label per run (1..count) and sizes[label] in voxels. */
function labelRuns(runs, { ny }) {
  const n = runs.start.length, parent = new Int32Array(n), rows = runs.offsets.length - 1;
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const joinRow = (i, row) => {
    for (let k = runs.offsets[row]; k < runs.offsets[row + 1] && runs.start[k] < runs.end[i]; k++) {
      if (runs.end[k] <= runs.start[i]) continue;
      const a = find(i), b = find(k);
      if (a !== b) parent[b] = a;
    }
  };
  for (let row = 0; row < rows; row++) {
    for (let i = runs.offsets[row]; i < runs.offsets[row + 1]; i++) {
      if (row % ny > 0) joinRow(i, row - 1);
      if (row >= ny) joinRow(i, row - ny);
    }
  }
  const label = new Int32Array(n), id = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) { const r = find(i); if (!id[r]) id[r] = ++count; label[i] = id[r]; }
  const sizes = new Float64Array(count + 1);
  for (let i = 0; i < n; i++) sizes[label[i]] += runs.end[i] - runs.start[i];
  return { label, count, sizes };
}

/** Voxels of mask `own` that the other mask lacks, sorted by cause (see the plan). */
function onlyIn(own, other, region, dims, smallVoxels) {
  const { label, count, sizes } = labelRuns(own, dims), shared = new Float64Array(count + 1);
  let outside = 0, both = 0, voxels = 0;
  for (let row = 0; row < own.offsets.length - 1; row++) {
    for (let i = own.offsets[row]; i < own.offsets[row + 1]; i++) {
      const s = own.start[i], e = own.end[i], inOther = overlapInRow(other, row, s, e);
      let inOtherAndRegion = 0;
      for (let k = other.offsets[row]; k < other.offsets[row + 1] && other.start[k] < e; k++) {
        const a = Math.max(s, other.start[k]), b = Math.min(e, other.end[k]);
        if (b > a) inOtherAndRegion += overlapInRow(region, row, a, b);
      }
      shared[label[i]] += inOther; both += inOther; voxels += e - s;
      outside += e - s - inOther - overlapInRow(region, row, s, e) + inOtherAndRegion;
    }
  }
  const out = { voxels: 0, whole_small: 0, whole_large: 0, boundary: 0, outside_region: outside };
  for (let c = 1; c <= count; c++) {
    const missing = sizes[c] - shared[c];
    if (!missing) continue;
    out.voxels += missing;
    if (shared[c]) out.boundary += missing;
    else if (sizes[c] < smallVoxels) out.whole_small += missing;
    else out.whole_large += missing;
  }
  return { out, both, voxels };
}

/** Compare two pore masks served slice by slice. Porosity is over bodyMm3, VoxelBench's sample-mask volume, for both;
    Dice = 2|A and B| / (|A| + |B|). smallMm3 separates small from large whole pores. */
function compareMasks({ a, b, region, dims, voxelMm, bodyMm3, smallMm3 = 0.01 }) {
  const ra = maskRuns(a, dims), rb = maskRuns(b, dims), rr = maskRuns(region, dims), small = smallMm3 / voxelMm ** 3;
  const A = onlyIn(ra, rb, rr, dims, small), B = onlyIn(rb, ra, rr, dims, small);
  const percent = (v) => (100 * v * voxelMm ** 3) / bodyMm3;
  return {
    a: { voxels: A.voxels, percent: percent(A.voxels) }, b: { voxels: B.voxels, percent: percent(B.voxels) }, both_voxels: A.both,
    dice: A.voxels + B.voxels ? (2 * A.both) / (A.voxels + B.voxels) : null, only_a: A.out, only_b: B.out, small_mm3: smallMm3,
  };
}

module.exports = { writeMaskTiff, readMaskPages, regionSlice, poreSlice, maskRuns, labelRuns, compareMasks };
