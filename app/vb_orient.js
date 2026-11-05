/* Re-orienting a scan taken at an angle. An orientation is { R, center, origin, dims }:
   - R: row-major 3 x 3, its rows the part's x, y, z axes in scan coordinates (a proper rotation, det +1);
   - center: the point it turns about, in scan voxels of the loaded grid;
   - origin, dims: the leveled grid, in voxels of the part's frame relative to center.
   Leveled voxel (i, j, k) sits at p = origin + (i, j, k) in the part's frame, which is scan point center + Rᵀp.
   Resampling is nearest neighbor, so every leveled gray value is a measured voxel; points outside the scan or its
   reconstruction circle read 0, and measured zeros read 1, so "gray 0" means outside and nothing else. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_align.js'));
  else root.VBOrient = factory(root.VBAlign);
}(typeof self !== 'undefined' ? self : this, function (A) {
  'use strict';

  const AMBIGUOUS = 0.10; // part extents within 10 % of each other leave their axes uncertain
  const AXES = ['x', 'y', 'z'];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const mul = (P, Q) => { const C = new Array(9).fill(0); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) C[3 * r + c] += P[3 * r + k] * Q[3 * k + c]; return C; };
  // A sign rule, so the same mask always gives the same axes: each axis points along + of the scan axis it is nearest.
  const signed = (v) => { let k = 0; for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[k])) k = i; return v[k] < 0 ? v.map((x) => -x) : v; };

  /** The part's axes from its sample mask (binned grid, factor bin; a binned voxel b is loaded voxel b·bin + (bin-1)/2):
      { R, center, extents, ambiguous }, with the long axis as x and the thinnest as z. extents are RMS spreads in
      loaded voxels; ambiguous lists the axes whose spread is within 10 % of a neighbor's. */
  function levelFromMask(mask, { nx, ny, nz }, bin) {
    const off = (bin - 1) / 2;
    let n = 0; const s = [0, 0, 0], ss = new Array(9).fill(0);
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (!mask[i]) continue;
      const p = [x * bin + off, y * bin + off, z * bin + off];
      n++;
      for (let r = 0; r < 3; r++) { s[r] += p[r]; for (let c = 0; c < 3; c++) ss[3 * r + c] += p[r] * p[c]; }
    }
    if (!n) throw new Error('The sample mask is empty: segment the part first.');
    const center = s.map((v) => v / n);
    const C = ss.map((v, k) => v / n - center[Math.floor(k / 3)] * center[k % 3]);
    const { values, vectors } = A.eigenSymmetric(C, 3);
    const ex = signed(vectors[0]), ey = signed(vectors[1]), ez = cross(ex, ey);
    const extents = values.map((v) => Math.sqrt(Math.max(v, 0)));
    const ambiguous = new Set();
    for (let k = 0; k < 2; k++) if (extents[k + 1] >= (1 - AMBIGUOUS) * extents[k]) { ambiguous.add(AXES[k]); ambiguous.add(AXES[k + 1]); }
    return { R: [...ex, ...ey, ...ez], center, extents, ambiguous: [...ambiguous] };
  }

  /** Small turns about the part's own axes, in degrees (x, then y, then z). */
  function nudge(R, { rx = 0, ry = 0, rz = 0 }) {
    if (!rx && !ry && !rz) return R.slice();
    const d = Math.PI / 180, c = (a) => Math.cos(a * d), s = (a) => Math.sin(a * d);
    const X = [1, 0, 0, 0, c(rx), -s(rx), 0, s(rx), c(rx)], Y = [c(ry), 0, s(ry), 0, 1, 0, -s(ry), 0, c(ry)], Z = [c(rz), -s(rz), 0, s(rz), c(rz), 0, 0, 0, 1];
    return mul(Z, mul(Y, mul(X, R)));
  }
  /** Upside down: 180 degrees about the part's x. */
  const flip = (R) => [R[0], R[1], R[2], -R[3], -R[4], -R[5], -R[6], -R[7], -R[8]];
  /** A quarter turn about the part's z: the old y becomes x. */
  const turn = (R) => [R[3], R[4], R[5], -R[0], -R[1], -R[2], R[6], R[7], R[8]];

  /** The leveled grid from the part's extremes (lo, hi along each part axis, loaded voxels) plus marginVox of air. */
  function gridFromBounds(lo, hi, half, marginVox) {
    if (lo[0] === Infinity) throw new Error('The sample mask is empty: segment the part first.');
    const origin = lo.map((v) => Math.floor(v - half - marginVox));
    const top = hi.map((v) => Math.ceil(v + half + marginVox));
    return { origin, dims: { nx: top[0] - origin[0] + 1, ny: top[1] - origin[1] + 1, nz: top[2] - origin[2] + 1 } };
  }
  function widen(R, d, lo, hi) {
    for (let r = 0; r < 3; r++) {
      const p = R[3 * r] * d[0] + R[3 * r + 1] * d[1] + R[3 * r + 2] * d[2];
      if (p < lo[r]) lo[r] = p;
      if (p > hi[r]) hi[r] = p;
    }
  }

  /** The leveled grid around the part: its box in the part's frame plus marginVox voxels of air on every side. */
  function gridFor({ R, center }, mask, { nx, ny, nz }, bin, marginVox) {
    const off = (bin - 1) / 2;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (mask[i]) widen(R, [x * bin + off - center[0], y * bin + off - center[1], z * bin + off - center[2]], lo, hi);
    }
    return gridFromBounds(lo, hi, bin / 2, marginVox);
  }

  /** The mask voxels with a face neighbor outside the mask (or on the grid's edge), as loaded-grid positions
      [x0, y0, z0, x1, ...]: the part's extremes in any direction are among them, so the sliders need only these. */
  function surfacePoints(mask, { nx, ny, nz }, bin) {
    const off = (bin - 1) / 2, out = [], plane = nx * ny;
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (!mask[i]) continue;
      const edge = !x || !y || !z || x === nx - 1 || y === ny - 1 || z === nz - 1;
      if (edge || !mask[i - 1] || !mask[i + 1] || !mask[i - nx] || !mask[i + nx] || !mask[i - plane] || !mask[i + plane]) out.push(x * bin + off, y * bin + off, z * bin + off);
    }
    return Float32Array.from(out);
  }

  /** gridFor over surfacePoints: the same grid, fast enough to follow a slider. */
  function gridForPoints({ R, center }, pts, bin, marginVox) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pts.length; i += 3) widen(R, [pts[i] - center[0], pts[i + 1] - center[1], pts[i + 2] - center[2]], lo, hi);
    return gridFromBounds(lo, hi, bin / 2, marginVox);
  }

  /** The measured gray nearest to scan point (sx, sy, sz): 0 outside the scan or its circle, 1 for a measured 0. */
  function grayAt(slices, { nx, ny, nz }, circle, sx, sy, sz) {
    const x = Math.round(sx), y = Math.round(sy), z = Math.round(sz);
    if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return 0;
    if (circle && (x + 0.5 - circle.cx) ** 2 + (y + 0.5 - circle.cy) ** 2 > circle.r * circle.r) return 0;
    const v = slices[z][y * nx + x];
    return v === 0 ? 1 : v;
  }

  /** Fills out[row·width + col] with the leveled voxels at origin-relative point a + col·u + row·v (part frame). */
  function walk({ slices, dims, circle, orient }, a, u, v, width, height, out) {
    const { R, center } = orient;
    const scanOf = (p) => [0, 1, 2].map((k) => R[k] * p[0] + R[3 + k] * p[1] + R[6 + k] * p[2]);
    const s0 = scanOf(a).map((x, k) => x + center[k]), su = scanOf(u), sv = scanOf(v);
    for (let r = 0; r < height; r++) {
      const bx = s0[0] + r * sv[0], by = s0[1] + r * sv[1], bz = s0[2] + r * sv[2], at = r * width;
      for (let c = 0; c < width; c++) out[at + c] = grayAt(slices, dims, circle, bx + c * su[0], by + c * su[1], bz + c * su[2]);
    }
    return out;
  }

  /** Leveled slice k (an XY plane of the leveled grid). */
  function resampleSlice(src, k) {
    const { origin: o, dims: d } = src.orient;
    return walk(src, [o[0], o[1], o[2] + k], [1, 0, 0], [0, 1, 0], d.nx, d.ny, new Uint16Array(d.nx * d.ny));
  }

  /** The whole leveled scan, one Uint16Array per slice; onSlice(k) after each, for progress. */
  function resample({ slices, dims, circle, orient, onSlice = null }) {
    const out = new Array(orient.dims.nz);
    for (let k = 0; k < out.length; k++) { out[k] = resampleSlice({ slices, dims, circle, orient }, k); if (onSlice) onSlice(k); }
    return out;
  }

  /** resample, pausing (await pause()) every `every` slices so the page stays responsive; onProgress(done, total). */
  async function resamplePaced({ slices, dims, circle, orient, pause, every = 4, onProgress = null }) {
    const n = orient.dims.nz, out = new Array(n);
    for (let k = 0; k < n; k++) {
      out[k] = resampleSlice({ slices, dims, circle, orient }, k);
      if ((k + 1) % every === 0 || k === n - 1) { if (onProgress) onProgress(k + 1, n); await pause(); }
    }
    return out;
  }

  /** One plane of the leveled scan, laid out as the scan's own planes are (XY: x across, y down; XZ: x across,
      z down; YZ: y across, z down), for the live preview. */
  function samplePlane({ slices, dims, circle, orient, plane, index }) {
    const { origin: o, dims: d } = orient;
    const src = { slices, dims, circle, orient };
    if (plane === 'XY') return { width: d.nx, height: d.ny, pixels: walk(src, [o[0], o[1], o[2] + index], [1, 0, 0], [0, 1, 0], d.nx, d.ny, new Uint16Array(d.nx * d.ny)) };
    if (plane === 'XZ') return { width: d.nx, height: d.nz, pixels: walk(src, [o[0], o[1] + index, o[2]], [1, 0, 0], [0, 0, 1], d.nx, d.nz, new Uint16Array(d.nx * d.nz)) };
    return { width: d.ny, height: d.nz, pixels: walk(src, [o[0] + index, o[1], o[2]], [0, 1, 0], [0, 0, 1], d.ny, d.nz, new Uint16Array(d.ny * d.nz)) };
  }

  /** An orientation is saved in native voxels (binning 1), so it applies at any binning; loaded voxel k of a binned
      scan is native k·f + (f-1)/2. */
  const onGrid = (o, f) => ({ ...o, center: o.center.map((c) => (c - (f - 1) / 2) / f), origin: o.origin.map((v) => v / f), dims: { nx: Math.ceil(o.dims.nx / f), ny: Math.ceil(o.dims.ny / f), nz: Math.ceil(o.dims.nz / f) } });
  const toNative = (o, f) => ({ ...o, center: o.center.map((c) => c * f + (f - 1) / 2), origin: o.origin.map((v) => v * f), dims: { nx: o.dims.nx * f, ny: o.dims.ny * f, nz: o.dims.nz * f } });

  /** A short id for one orientation (null for scan axes), stamped on the marks made in it. */
  function orientId(o) {
    if (!o) return null;
    const text = JSON.stringify([o.R.map((v) => Math.round(v * 1e6)), o.center.map((v) => Math.round(v * 1e3)), o.origin, o.dims]);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `o${h.toString(16).padStart(8, '0')}`;
  }
  /** A mark belongs to the frame it was made in; marks from before this feature belong to scan axes. */
  const sameFrame = (record, id) => (record.orientation || null) === (id || null);

  const voxels = (d) => d.nx * d.ny * d.nz;
  /** The loaded scan and its leveled copy (16-bit each) both fit within limit bytes. */
  const fits = ({ loaded, out, limit }) => 2 * (voxels(loaded) + voxels(out)) <= limit;
  /** The binning for reopening a leveled scan: the smallest factor at which the scan and its leveled copy both fit. */
  function planOrientedBinning({ width, height, depth }, outNative, limit) {
    for (let f = 1; f <= 4; f++) {
      const loaded = { nx: Math.floor(width / f), ny: Math.floor(height / f), nz: Math.floor(depth / f) };
      const out = { nx: Math.ceil(outNative.nx / f), ny: Math.ceil(outNative.ny / f), nz: Math.ceil(outNative.nz / f) };
      if (fits({ loaded, out, limit })) return f;
    }
    throw new Error('Too large even at 4× binning with the leveled copy.');
  }

  return { levelFromMask, nudge, flip, turn, gridFor, surfacePoints, gridForPoints, resample, resamplePaced, resampleSlice, samplePlane, onGrid, toNative, orientId, sameFrame, fits, planOrientedBinning };
}));
