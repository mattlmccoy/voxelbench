/* 3D figures of a scan: a label volume of material phases (dense, porous, pore, clump; doped or base material) on a
   figure grid of about 80 µm, the pores closed from outside air (enclosed gas), and two renders of it: an opaque
   cutaway with the near quarter removed and a see-through view. Pure functions on flat arrays (index (z*ny + y)*nx + x);
   the worker runs them and the page draws callouts, the field arrow and the scale bar on the result.
   The classes follow the lab's 2026-11-06 method: smoothed gray on a relative density scale (air 0, dense base
   material 1), pore below 0.40, porous 0.40 to 0.85, dense from 0.85; clumps are compact mid-density blobs inside
   dense material; a region is the doped material where the dense phase reads above 1.07 or clustered clumps are near. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBFigure = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Label codes of the figure volume.
  const CODE = { EMPTY: 0, DOPED_DENSE: 1, DOPED_POROUS: 2, BASE_DENSE: 3, BASE_POROUS: 4, DOPED_PORE: 5, CLUMP: 6, BASE_PORE: 7 };
  const COLORS = [[1, 1, 1], [0.86, 0.43, 0.15], [0.97, 0.74, 0.48], [0.20, 0.45, 0.85], [0.64, 0.77, 0.95], [0.78, 0.10, 0.18], [0.10, 0.62, 0.32], [0.78, 0.10, 0.18]];
  const XRAY_ALPHA = [0, 0.026, 0.013, 0.006, 0.003, 0.9, 0.85, 0];
  const TURN_ALPHA = [0, 0.06, 0.035, 0.011, 0.006, 0.9, 0.9, 0];
  const VIEW = { az: 35, el: 28 };
  const TARGET_MM = 0.08, MAX_VOXELS = 16e6;
  const DEFAULTS = {
    sigmaVox: 0.8, poreBelow: 0.40, denseFrom: 0.85, split: 1.07, windowMm: 1.2, denseShare: 0.6, fovEdgeMm: 2, coneBandMm: 7,
    clusterMm: 4, nearClumpMm: 1.5, endClumpMm: 2.5, majorityMm: 0.88, clumpMm3: [0.1, 20], clumpLevel: [0.45, 0.80], cupping: true,
    levelMm: 2.4, coreSplit: 1.075, coreOpenMm: 0.24, // dense core (composition v2)
  };

  // ---------- grid helpers ----------
  const sizeOf = (d) => d.nx * d.ny * d.nz;

  /** Smallest integer block factor of the worker grid (voxel baseMm) that reaches about 80 µm and keeps the cropped
      box under MAX_VOXELS. */
  function planFactor(baseMm, box) {
    let s = Math.max(1, Math.round(TARGET_MM / baseMm));
    while ((box.nx / s) * (box.ny / s) * (box.nz / s) > MAX_VOXELS) s++;
    return s;
  }

  /** The envelope's bounding box on the worker grid, with a margin in voxels, clamped to the volume. */
  function boundsOf(mask, dims, margin) {
    const { nx, ny, nz } = dims;
    let x0 = nx, x1 = -1, y0 = ny, y1 = -1, z0 = nz, z1 = -1;
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      if (!mask[i]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    if (x1 < 0) return null;
    const lo = (a) => Math.max(0, a - margin);
    return { x0: lo(x0), y0: lo(y0), z0: lo(z0), x1: Math.min(nx - 1, x1 + margin), y1: Math.min(ny - 1, y1 + margin), z1: Math.min(nz - 1, z1 + margin) };
  }

  /** Block mean of gray, any-of of the envelope and outside masks, over s x s x s blocks of the box. */
  function blockGrid({ gray, envelope, outside, dims, box, s }) {
    const out = { nx: Math.floor((box.x1 - box.x0 + 1) / s), ny: Math.floor((box.y1 - box.y0 + 1) / s), nz: Math.floor((box.z1 - box.z0 + 1) / s) };
    const n = sizeOf(out), g = new Float32Array(n), env = new Uint8Array(n), outs = new Uint8Array(n);
    const cnt = new Uint16Array(n), envCnt = new Uint16Array(n), half = (s ** 3) / 2;
    for (let z = 0; z < out.nz * s; z++) {
      const zz = z + box.z0, oz = Math.floor(z / s);
      for (let y = 0; y < out.ny * s; y++) {
        const yy = y + box.y0, row = (zz * dims.ny + yy) * dims.nx + box.x0, orow = (oz * out.ny + Math.floor(y / s)) * out.nx;
        for (let x = 0; x < out.nx * s; x++) {
          const i = row + x, o = orow + Math.floor(x / s);
          if (outside && outside[i]) { outs[o] = 1; continue; }
          g[o] += gray[i]; cnt[o]++;
          if (envelope[i]) envCnt[o]++;
        }
      }
    }
    for (let o = 0; o < n; o++) { g[o] = cnt[o] ? g[o] / cnt[o] : 0; env[o] = envCnt[o] >= half ? 1 : 0; if (outs[o] && cnt[o] < half) env[o] = 0; }
    return { gray: g, envelope: env, outside: outs, dims: out };
  }

  /** Block mean of the loaded slices over s x s x s blocks of box (loaded voxels), for a figure grid finer than the
      worker's: gray, and outside where any sample reads 0 (outside the reconstruction). */
  function sliceGrid(slices, dims, box, s) {
    const out = { nx: Math.floor((box.x1 - box.x0 + 1) / s), ny: Math.floor((box.y1 - box.y0 + 1) / s), nz: Math.floor((box.z1 - box.z0 + 1) / s) };
    const n = sizeOf(out), gray = new Float32Array(n), outside = new Uint8Array(n), per = s ** 3;
    for (let z = 0; z < out.nz * s; z++) {
      const sl = slices[box.z0 + z], oz = Math.floor(z / s);
      for (let y = 0; y < out.ny * s; y++) {
        const row = (box.y0 + y) * dims.nx + box.x0, orow = (oz * out.ny + Math.floor(y / s)) * out.nx;
        for (let x = 0; x < out.nx * s; x++) { const v = sl[row + x], o = orow + Math.floor(x / s); gray[o] += v; if (v === 0) outside[o] = 1; }
      }
    }
    for (let o = 0; o < n; o++) gray[o] /= per;
    return { gray, outside, dims: out };
  }

  /** The worker's mask on a finer grid (nearest): the cell centers of box (loaded voxels, block s) looked up on the
      worker grid binned by bin. */
  function maskOnGrid(mask, mdims, bin, box, s, dims) {
    const out = new Uint8Array(sizeOf(dims));
    for (let z = 0, o = 0; z < dims.nz; z++) {
      const bz = Math.min(mdims.nz - 1, Math.floor((box.z0 + (z + 0.5) * s) / bin));
      for (let y = 0; y < dims.ny; y++) {
        const by = Math.min(mdims.ny - 1, Math.floor((box.y0 + (y + 0.5) * s) / bin)), row = (bz * mdims.ny + by) * mdims.nx;
        for (let x = 0; x < dims.nx; x++, o++) out[o] = mask[row + Math.min(mdims.nx - 1, Math.floor((box.x0 + (x + 0.5) * s) / bin))];
      }
    }
    return out;
  }

  /** In-place separable filter along one axis with clamped edges: kernel taps centered on the sample. */
  function convolveAxis(src, dims, axis, kernel) {
    const { nx, ny, nz } = dims, r = (kernel.length - 1) / 2;
    const len = [nx, ny, nz][axis], stride = [1, nx, nx * ny][axis];
    const line = new Float32Array(len), out = new Float32Array(src.length);
    const outer = axis === 0 ? [ny * nz, (k) => k * nx] : axis === 1 ? [nx * nz, (k) => (k % nx) + Math.floor(k / nx) * nx * ny] : [nx * ny, (k) => k];
    for (let k = 0; k < outer[0]; k++) {
      const base = outer[1](k);
      for (let i = 0; i < len; i++) line[i] = src[base + i * stride];
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let t = -r; t <= r; t++) v += kernel[t + r] * line[Math.min(len - 1, Math.max(0, i + t))];
        out[base + i * stride] = v;
      }
    }
    return out;
  }

  function gaussianKernel(sigma) {
    const r = Math.max(1, Math.ceil(3 * sigma)), k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
  }
  function gaussian3(src, dims, sigma) { const k = gaussianKernel(sigma); return convolveAxis(convolveAxis(convolveAxis(src, dims, 0, k), dims, 1, k), dims, 2, k); }

  /** Mean over a w x w x w box (w odd), clamped edges, by running sums along each axis. */
  function boxMean(src, dims, w) {
    const r = (w - 1) >> 1;
    let a = Float32Array.from(src);
    const { nx, ny, nz } = dims;
    for (let axis = 0; axis < 3; axis++) {
      const len = [nx, ny, nz][axis], stride = [1, nx, nx * ny][axis];
      const lines = axis === 0 ? ny * nz : axis === 1 ? nx * nz : nx * ny;
      const out = new Float32Array(a.length), pre = new Float64Array(len + 1);
      for (let k = 0; k < lines; k++) {
        const base = axis === 0 ? k * nx : axis === 1 ? (k % nx) + Math.floor(k / nx) * nx * ny : k;
        for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + a[base + i * stride];
        for (let i = 0; i < len; i++) {
          const lo = Math.max(0, i - r), hi = Math.min(len, i + r + 1);
          out[base + i * stride] = (pre[hi] - pre[lo]) / (hi - lo);
        }
      }
      a = out;
    }
    return a;
  }

  /** 6-connected components of mask: labels 1..n (Int32Array) and n. */
  function label6(mask, dims) {
    const { nx, ny } = dims, n = mask.length, lab = new Int32Array(n);
    const parent = [0];
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); return Math.min(a, b); };
    const plane = nx * ny;
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const x = i % nx, y = Math.floor(i / nx) % ny;
      let l = 0;
      for (const j of [x > 0 ? i - 1 : -1, y > 0 ? i - nx : -1, i >= plane ? i - plane : -1]) {
        if (j < 0 || !lab[j]) continue;
        l = l ? unite(l, lab[j]) : find(lab[j]);
      }
      if (!l) { l = parent.length; parent.push(l); }
      lab[i] = l;
    }
    const map = new Int32Array(parent.length);
    let count = 0;
    for (let a = 1; a < parent.length; a++) { const r = find(a); if (!map[r]) map[r] = ++count; map[a] = map[r]; }
    for (let i = 0; i < n; i++) if (lab[i]) lab[i] = map[lab[i]];
    return { labels: lab, n: count };
  }

  /** Euclidean distance (voxels) from each voxel to the nearest source voxel, exact (separable lower envelope,
      Felzenszwalb and Huttenlocher); carry, when given, is copied from that nearest source (nearest decision). */
  function distanceFrom(source, dims, carry = null) {
    const { nx, ny, nz } = dims, n = source.length, BIG = 1e20;
    const f = new Float32Array(n), idx = carry ? new Int32Array(n) : null;
    for (let i = 0; i < n; i++) { f[i] = source[i] ? 0 : BIG; if (idx) idx[i] = source[i] ? i : -1; }
    const len = Math.max(nx, ny, nz), lf = new Float64Array(len), li = new Int32Array(len), v = new Int32Array(len), zb = new Float64Array(len + 1);
    const pass = (count, stride, lines, baseOf) => {
      for (let k = 0; k < lines; k++) {
        const base = baseOf(k);
        let any = false;
        for (let q = 0; q < count; q++) { lf[q] = f[base + q * stride]; if (lf[q] < BIG) any = true; if (idx) li[q] = idx[base + q * stride]; }
        if (!any) continue;
        let h = -1;
        for (let q = 0; q < count; q++) {
          if (lf[q] >= BIG) continue;
          if (h < 0) { h = 0; v[0] = q; zb[0] = -Infinity; zb[1] = Infinity; continue; }
          let sx;
          for (;;) { const p = v[h]; sx = ((lf[q] + q * q) - (lf[p] + p * p)) / (2 * q - 2 * p); if (sx <= zb[h] && h > 0) h--; else break; }
          if (sx <= zb[h]) { v[h] = q; zb[h + 1] = Infinity; continue; } // h is 0 and q dominates it
          h++; v[h] = q; zb[h] = sx; zb[h + 1] = Infinity;
        }
        for (let q = 0, t = 0; q < count; q++) {
          while (zb[t + 1] < q) t++;
          const p = v[t], o = base + q * stride;
          f[o] = (q - p) * (q - p) + lf[p];
          if (idx) idx[o] = li[p];
        }
      }
    };
    pass(nx, 1, ny * nz, (k) => k * nx);
    pass(ny, nx, nx * nz, (k) => (k % nx) + Math.floor(k / nx) * nx * ny);
    pass(nz, nx * ny, nx * ny, (k) => k);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = f[i] >= BIG ? Infinity : Math.sqrt(f[i]);
    let c = null;
    if (carry) { c = new Uint8Array(n); for (let i = 0; i < n; i++) c[i] = idx[i] >= 0 ? carry[idx[i]] : carry[i]; }
    return { distance: d, carry: c };
  }
  const notOf = (m) => { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] ? 0 : 1; return o; };

  /** Depth below the mask surface in voxels (0 outside). */
  function depthInside(mask, dims) { return distanceFrom(notOf(mask), dims).distance; }

  /** 2D chamfer distance to the nearest 0 of mask (w x h), for callout anchors. */
  function distance2(mask, w, h) {
    const d = new Float32Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = mask[i] ? Infinity : 0;
    const S = Math.SQRT2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) { v = Math.min(v, d[i - w] + 1); if (x > 0) v = Math.min(v, d[i - w - 1] + S); if (x < w - 1) v = Math.min(v, d[i - w + 1] + S); }
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) v = Math.min(v, 1);
      d[i] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x; let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) { v = Math.min(v, d[i + w] + 1); if (x < w - 1) v = Math.min(v, d[i + w + 1] + S); if (x > 0) v = Math.min(v, d[i + w - 1] + S); }
      d[i] = v;
    }
    return d;
  }

  const median = (list) => { if (!list.length) return NaN; const a = Float64Array.from(list).sort(); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const percentile = (list, p) => { const a = Float64Array.from(list).sort(); return a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * (a.length - 1)))] : NaN; };

  // ---------- clumps ----------
  /** Pass-1 clumps (agglom.py): mid-density blobs of the size and level windows that touch neither a pore nor the
      envelope's 2-voxel rim. Returns the blob labels, accepted flags and centroids (voxels) of the accepted ones. */
  function findClumps({ rho, mid, pore, envelope, dims, cellMm, o, envDepth = null }) {
    const { labels, n } = label6(mid, dims);
    const cnt = new Float64Array(n + 1), sum = new Float64Array(n + 1), sx = new Float64Array(n + 1), sy = new Float64Array(n + 1), sz = new Float64Array(n + 1);
    const { nx, ny } = dims;
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i]; if (!l) continue;
      cnt[l]++; sum[l] += rho[i]; sx[l] += i % nx; sy[l] += Math.floor(i / nx) % ny; sz[l] += Math.floor(i / (nx * ny));
    }
    const touch = new Uint8Array(n + 1), plane = nx * ny;
    if (!envDepth) envDepth = depthInside(envelope, dims);
    const poreNear = (i) => pore[i] || (i % nx > 0 && pore[i - 1]) || (i % nx < nx - 1 && pore[i + 1]) || (i >= nx && pore[i - nx]) || (i + nx < labels.length && pore[i + nx]) || (i >= plane && pore[i - plane]) || (i + plane < labels.length && pore[i + plane]);
    for (let i = 0; i < labels.length; i++) if (labels[i] && !touch[labels[i]] && (envDepth[i] <= 2 || poreNear(i))) touch[labels[i]] = 1;
    const vox = cellMm ** 3, ok = new Uint8Array(n + 1), centroids = [];
    for (let l = 1; l <= n; l++) {
      const size = cnt[l] * vox, mean = sum[l] / cnt[l];
      if (size >= o.clumpMm3[0] && size <= o.clumpMm3[1] && !touch[l] && mean >= o.clumpLevel[0] && mean <= o.clumpLevel[1]) {
        ok[l] = 1; centroids.push({ id: l, x: sx[l] / cnt[l], y: sy[l] / cnt[l], z: sz[l] / cnt[l] });
      }
    }
    return { labels, ok, centroids };
  }

  /** Clumps with at least two others within clusterMm (all of them when there are three or fewer). */
  function clusteredIds(centroids, cellMm, clusterMm) {
    if (centroids.length <= 2) return new Set(centroids.map((c) => c.id));
    const cell = clusterMm / cellMm, grid = new Map(), key = (a, b, c) => `${a},${b},${c}`;
    for (const c of centroids) { const k = key(Math.floor(c.x / cell), Math.floor(c.y / cell), Math.floor(c.z / cell)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(c); }
    const out = new Set();
    for (const c of centroids) {
      const gx = Math.floor(c.x / cell), gy = Math.floor(c.y / cell), gz = Math.floor(c.z / cell);
      let near = 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
        for (const o of grid.get(key(gx + a, gy + b, gz + d)) || []) if (o !== c && Math.hypot(o.x - c.x, o.y - c.y, o.z - c.z) < cell) near++;
      }
      if (near >= 2) out.add(c.id);
    }
    return out;
  }

  // ---------- classification ----------
  /** The figure label volume. gray, envelope (sample mask) and outside (outside the reconstruction) are on the figure
      grid; airGray the scan's air; denseGray, when given, the gray of fully dense base material (relative density 1),
      else it is found from the base material's dense mode; zMm the scan-axis position of each z plane and scanMm the
      scan's length along z, for the cone-beam band. Returns labels (codes, pores still open and closed), the scale and
      notes. */
  function classify({ gray, envelope, outside = null, dims, cellMm, airGray, denseGray = null, zMm = null, scanMm = null, options = {}, progress = () => {} }) {
    const o = { ...DEFAULTS, ...options }, n = gray.length, notes = [];
    progress('Smoothing');
    const g0 = new Float32Array(n);
    for (let i = 0; i < n; i++) g0[i] = gray[i] - airGray;
    let g = gaussian3(g0, dims, Math.max(0.3, o.sigmaVox * Math.min(1, TARGET_MM / cellMm))); // 0.8 voxel at 80 µm
    const inside = outside ? notOf(outside) : new Uint8Array(n).fill(1);
    const fov = depthInside(inside, dims);
    for (let i = 0; i < n; i++) fov[i] *= cellMm;
    // cone-beam band: only at a scan end the part reaches within 1 mm
    const dz = new Float32Array(n).fill(Infinity);
    if (zMm && scanMm) {
      let lo = Infinity, hi = -Infinity;
      const plane = dims.nx * dims.ny;
      for (let i = 0; i < n; i++) if (envelope[i]) { const z = zMm[Math.floor(i / plane)]; if (z < lo) lo = z; if (z > hi) hi = z; }
      const nearTop = lo < 1, nearBottom = hi > scanMm - 1;
      for (let i = 0; i < n; i++) {
        const z = zMm[Math.floor(i / plane)];
        if (nearTop && z < scanMm / 2) dz[i] = z;
        if (nearBottom && z >= scanMm / 2) dz[i] = Math.min(dz[i], scanMm - z);
      }
    }
    const envD = depthInside(envelope, dims);
    const minCount = (k) => Math.max(200, Math.round(k * (TARGET_MM / cellMm) ** 3));
    const masks = (K) => {
      const rho = new Float32Array(n), mid = new Uint8Array(n), pore = new Uint8Array(n), dense = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        rho[i] = g[i] / K;
        if (!envelope[i]) continue;
        if (rho[i] < o.poreBelow) pore[i] = 1; else if (rho[i] < o.denseFrom) mid[i] = 1; else dense[i] = 1;
      }
      return { rho, mid, pore, dense };
    };
    const clusterDistance = (m) => {
      const c = findClumps({ ...m, envelope, dims, cellMm, o, envDepth: envD });
      const keep = clusteredIds(c.centroids, cellMm, o.clusterMm), src = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (c.labels[i] && c.ok[c.labels[i]] && keep.has(c.labels[i])) src[i] = 1;
      const d = distanceFrom(src, dims).distance;
      for (let i = 0; i < n; i++) d[i] *= cellMm;
      return { clumps: c, dist: d, clustered: keep.size };
    };
    progress('Density scale and clumps');
    let K, source;
    let m, cd;
    if (Number.isFinite(denseGray) && denseGray > airGray) {
      K = denseGray - airGray; source = 'dense reference';
      m = masks(K); cd = clusterDistance(m);
    } else {
      const inEnv = [];
      for (let i = 0; i < n; i++) if (envelope[i]) inEnv.push(g[i]);
      K = percentile(inEnv, 75) / 1.05; source = 'provisional (75th percentile of the part)';
      for (let it = 0; it < 3; it++) {
        m = masks(K); cd = clusterDistance(m);
        let ref = null;
        for (const [far, ero] of [[4.0, 12], [3.0, 8], [2.5, 5]]) {
          const eroVox = ero * (TARGET_MM / cellMm), list = [];
          for (let i = 0; i < n; i++) if (m.dense[i] && cd.dist[i] > far && fov[i] > 3 && dz[i] > 7 && envD[i] > eroVox) list.push(g[i]);
          if (list.length >= minCount(5000)) { ref = list; break; }
        }
        if (!ref) { notes.push('Little dense base material away from clumps: the density scale stays provisional.'); break; }
        const bins = 300, lo = 0.6 * K, hi = 1.4 * K, h = new Float64Array(bins);
        for (const v of ref) { const b = Math.floor(((v - lo) / (hi - lo)) * bins); if (b >= 0 && b < bins) h[b]++; }
        let best = 0, at = 0;
        for (let b = 0; b < bins; b++) { let s = 0; for (let t = -4; t <= 4; t++) s += h[Math.min(bins - 1, Math.max(0, b + t))]; if (s > best) { best = s; at = b; } }
        K = lo + ((at + 0.5) / bins) * (hi - lo); source = 'dense base material away from clumps (mode)';
      }
      m = masks(K); cd = clusterDistance(m);
    }
    // depth cupping: divide out the dense base material's level against depth (0.5 mm bands to 5 mm)
    let cupping = null;
    progress('Depth cupping');
    if (o.cupping) {
      const depth = envD, edges = [];
      for (let e = 0; e < 10; e++) edges.push([e * 0.5, e * 0.5 + 0.5]);
      const bands = edges.map(() => []);
      for (let i = 0; i < n; i++) {
        if (!envelope[i] || cd.dist[i] <= 4 || m.rho[i] <= o.denseFrom || (outside && outside[i])) continue;
        const b = Math.floor((depth[i] * cellMm) / 0.5); if (b < 10) bands[b].push(m.rho[i]);
      }
      const cen = [], val = [];
      bands.forEach((list, b) => { if (list.length > minCount(2000)) { cen.push(edges[b][0] + 0.25); val.push(median(list)); } });
      if (cen.length >= 4) {
        const deep = val.filter((v, k) => cen[k] >= 2), norm = deep.length ? median(deep) : 1;
        const curve = (dmm) => {
          const d = Math.min(dmm, cen[cen.length - 1]);
          if (d <= cen[0]) return val[0] / norm;
          for (let k = 1; k < cen.length; k++) if (d <= cen[k]) { const t = (d - cen[k - 1]) / (cen[k] - cen[k - 1]); return (val[k - 1] + t * (val[k] - val[k - 1])) / norm; }
          return val[val.length - 1] / norm;
        };
        for (let i = 0; i < n; i++) if (envelope[i]) g[i] /= curve(depth[i] * cellMm);
        cupping = cen.map((c, k) => [c, val[k]]);
        m = masks(K); cd = clusterDistance(m);
      }
    }
    progress('Doped and base material');
    // composition: doped where the dense phase of a window reads above the split, or clustered clumps are near
    const w = Math.max(3, (Math.round(o.windowMm / cellMm) | 1));
    const denseRho = new Float32Array(n), denseF = new Float32Array(n);
    for (let i = 0; i < n; i++) if (m.dense[i]) { denseRho[i] = m.rho[i]; denseF[i] = 1; }
    const num = boxMean(denseRho, dims, w), den = boxMean(denseF, dims, w);
    const decided = new Uint8Array(n), comp = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!envelope[i]) continue;
      if (den[i] > 0.25 && den[i] >= o.denseShare && fov[i] > o.fovEdgeMm && dz[i] > o.coneBandMm) { decided[i] = 1; comp[i] = num[i] / den[i] > o.split ? 2 : 1; }
      if (cd.dist[i] < o.nearClumpMm) { decided[i] = 1; comp[i] = 2; }
      if (!decided[i] && (dz[i] <= o.coneBandMm || fov[i] <= o.fovEdgeMm)) { decided[i] = 1; comp[i] = cd.dist[i] < o.endClumpMm ? 2 : 1; }
    }
    let any = false;
    for (let i = 0; i < n && !any; i++) if (decided[i]) any = true;
    if (!any) { for (let i = 0; i < n; i++) if (envelope[i]) { decided[i] = 1; comp[i] = 1; } notes.push('No window was dense enough to decide the material: all of it is shown as base material.'); }
    const filled = distanceFrom(decided, dims, comp).carry;
    const doped = new Float32Array(n);
    for (let i = 0; i < n; i++) doped[i] = filled[i] === 2 ? 1 : 0;
    const maj = boxMean(doped, dims, Math.max(3, Math.round(o.majorityMm / cellMm) | 1));
    // labels
    const labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!envelope[i]) continue;
      const dop = maj[i] > 0.5;
      const clump = cd.clumps.labels[i] && cd.clumps.ok[cd.clumps.labels[i]] && dop;
      labels[i] = m.pore[i] ? (dop ? CODE.DOPED_PORE : CODE.BASE_PORE) : clump ? CODE.CLUMP : m.mid[i] ? (dop ? CODE.DOPED_POROUS : CODE.BASE_POROUS) : (dop ? CODE.DOPED_DENSE : CODE.BASE_DENSE);
    }
    return { labels, rho: m.rho, scale: { airGray, denseGray: airGray + K, K, source }, cupping, clumps: cd.clumps.centroids.length, clustered: cd.clustered, notes };
  }

  /** Pores that reach the volume's faces through pores or empty space are open: set to empty. Only enclosed gas stays.
      Returns the counts per code before the change and the number of open-pore voxels removed. */
  function closePores(labels, dims) {
    const n = labels.length, { nx, ny, nz } = dims, free = (v) => v === CODE.EMPTY || v === CODE.DOPED_PORE || v === CODE.BASE_PORE;
    const seen = new Uint8Array(n), stack = [];
    const push = (i) => { if (!seen[i] && free(labels[i])) { seen[i] = 1; stack.push(i); } };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) push((z * ny + y) * nx + x);
    }
    while (stack.length) {
      const i = stack.pop(), x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      if (x > 0) push(i - 1); if (x < nx - 1) push(i + 1); if (y > 0) push(i - nx); if (y < ny - 1) push(i + nx); if (z > 0) push(i - nx * ny); if (z < nz - 1) push(i + nx * ny);
    }
    let open = 0;
    for (let i = 0; i < n; i++) if (seen[i] && labels[i] !== CODE.EMPTY) { labels[i] = CODE.EMPTY; open++; }
    return open;
  }

  /** Numbers under each figure: volumes (mm³) and shares of the doped body; masses from the relative density
      (base material dense = 1, times baseDensity g/cm³; doped voxels divided by dopedMassFactor). The doped body is
      every doped voxel before the open pores were removed (openDopedVoxels of them), as the lab's composition table:
      dense, porous, clumps, enclosed gas and gas open to the surface. core, when given, is the dense core (denseCore). */
  function figureStats({ labels, rho, cellMm, openVoxels, openDopedVoxels = 0, core = null, baseDensity = 1.01, dopedMassFactor = 0.9715 }) {
    const counts = new Float64Array(8);
    let massBase = 0, massDoped = 0, massCore = 0;
    for (let i = 0; i < labels.length; i++) {
      const c = labels[i]; counts[c]++;
      if (core && core[i]) massCore += Math.max(0, rho[i]);
      if (!c) continue;
      const r = Math.max(0, rho[i]);
      if (c === 3 || c === 4 || c === 7) massBase += r; else massDoped += r;
    }
    const vox = cellMm ** 3;
    const doped = counts[1] + counts[2] + counts[5] + counts[6] + openDopedVoxels;
    const mm3 = (k) => counts[k] * vox, share = (k) => (doped ? (100 * counts[k]) / doped : null);
    const gramsDoped = (m) => (m * vox * baseDensity) / dopedMassFactor / 1000;
    return {
      cell_mm: cellMm,
      volume_mm3: { doped_dense: mm3(1), doped_porous: mm3(2), base_dense: mm3(3), base_porous: mm3(4), enclosed_gas_doped: mm3(5), clump: mm3(6), enclosed_gas_base: mm3(7),
        open_pores: openVoxels * vox, open_pores_doped: openDopedVoxels * vox },
      doped_mm3: doped * vox,
      dense_percent_of_doped: share(1),
      porous_percent_of_doped: share(2),
      clump_percent_of_doped: share(6),
      gas_percent_of_doped: share(5),
      base_mass_g: (massBase * vox * baseDensity) / 1000,
      doped_mass_g: gramsDoped(massDoped),
      core_mass_g: core ? gramsDoped(massCore) : null,
    };
  }

  /** The numbers printed under a figure: dense = dense core mass over the weighed doped charge (null without one),
      enclosed gas share of the doped body, and the base material fused on (weighed out minus in, else from CT). */
  function figureNumbers(stats, masses = {}) {
    const has = (v) => Number.isFinite(v);
    const weighed = has(masses.mass_in_g) && has(masses.mass_out_g) ? masses.mass_out_g - masses.mass_in_g : null;
    const dense = has(stats.core_mass_g) && has(masses.mass_in_g) && masses.mass_in_g > 0 ? (100 * stats.core_mass_g) / masses.mass_in_g : null;
    return { dense, gas: stats.gas_percent_of_doped, fused: weighed ?? stats.base_mass_g, fusedSource: weighed !== null ? 'weighed' : 'CT' };
  }

  const pct = (v) => (v === null || !Number.isFinite(v) ? 'n/a' : v.toFixed(v < 10 ? 1 : 0));
  /** The line printed under each part, e.g. '45 % dense · 2.3 % gas · 3.3 g base fused on'. */
  function numbersLine(nb, names) {
    const dense = nb.dense === null || !Number.isFinite(nb.dense) ? `dense: enter the ${names.doped} charge` : `${pct(nb.dense)} % dense`;
    const fused = `${Number.isFinite(nb.fused) ? nb.fused.toFixed(1) : 'n/a'} g ${names.base} fused on${nb.fusedSource === 'CT' ? ' (CT)' : ''}`;
    return `${dense} · ${pct(nb.gas)} % gas · ${fused}`;
  }

  // ---------- dense core (the lab's composition v2) ----------
  /** One step of erosion (or dilation) by the 6-neighbor cross; outside the grid counts as empty. */
  function crossStep(mask, dims, grow) {
    const { nx, ny, nz } = dims, plane = nx * ny, out = new Uint8Array(mask.length);
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const a = x > 0 ? mask[i - 1] : 0, b = x < nx - 1 ? mask[i + 1] : 0, c = y > 0 ? mask[i - nx] : 0;
      const d = y < ny - 1 ? mask[i + nx] : 0, e = z > 0 ? mask[i - plane] : 0, f = z < nz - 1 ? mask[i + plane] : 0;
      out[i] = grow ? (mask[i] || a || b || c || d || e || f ? 1 : 0) : (mask[i] && a && b && c && d && e && f ? 1 : 0);
    }
    return out;
  }

  /** Fill the holes of mask in each plane across axis ('x', 'y' or 'z'): what the plane's border can't reach through
      empty cells (4-connected) is filled. */
  function fillHolesInPlanes(mask, dims, axis) {
    const { nx, ny } = dims, out = Uint8Array.from(mask);
    const [U, V, W] = axis === 'x' ? [ny, dims.nz, nx] : axis === 'y' ? [nx, dims.nz, ny] : [nx, ny, dims.nz];
    const idx = axis === 'x' ? (u, v, w) => (v * ny + u) * nx + w : axis === 'y' ? (u, v, w) => (v * ny + w) * nx + u : (u, v, w) => (w * ny + v) * nx + u;
    const seen = new Uint8Array(U * V), stack = [];
    for (let w = 0; w < W; w++) {
      seen.fill(0);
      const push = (u, v) => { const k = v * U + u; if (!seen[k] && !mask[idx(u, v, w)]) { seen[k] = 1; stack.push(k); } };
      for (let u = 0; u < U; u++) { push(u, 0); push(u, V - 1); }
      for (let v = 0; v < V; v++) { push(0, v); push(U - 1, v); }
      while (stack.length) {
        const k = stack.pop(), u = k % U, v = (k - u) / U;
        if (u > 0) push(u - 1, v); if (u < U - 1) push(u + 1, v); if (v > 0) push(u, v - 1); if (v < V - 1) push(u, v + 1);
      }
      for (let v = 0; v < V; v++) for (let u = 0; u < U; u++) if (!seen[v * U + u]) out[idx(u, v, w)] = 1;
    }
    return out;
  }

  /** The dense core: the doped material that reached full composite density (the lab's composition v2). The dense-
      phase level is the mean relative density of dense voxels within a 2.4 mm window (where at least 30 % of it is
      dense); N is its median 4 mm or more from clumps (the base material's melt); the core is where the level is above
      N x 1.075, undecided voxels taking the nearest decision, opened by 0.24 mm, the largest piece kept, grown back
      within the decision, and holes filled in the planes across the field axis. */
  function denseCore({ rho, envelope, clump, dims, cellMm, fillAxis = 'x', options = {} }) {
    const o = { ...DEFAULTS, ...options }, n = rho.length, none = () => new Uint8Array(n);
    const dense = new Float32Array(n), dRho = new Float32Array(n);
    for (let i = 0; i < n; i++) if (envelope[i] && rho[i] >= o.denseFrom) { dense[i] = 1; dRho[i] = rho[i]; }
    const w = Math.max(3, Math.round(o.levelMm / cellMm) | 1);
    const num = boxMean(dRho, dims, w), den = boxMean(dense, dims, w);
    const level = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (envelope[i] && den[i] > 0.3) level[i] = num[i] / Math.max(den[i], 1e-6);
    let anyClump = false;
    for (let i = 0; i < n && !anyClump; i++) if (clump[i]) anyClump = true;
    const far = anyClump ? distanceFrom(clump, dims).distance : null, list = [];
    for (let i = 0; i < n; i++) if (Number.isFinite(level[i]) && (!far || far[i] * cellMm > o.clusterMm)) list.push(level[i]);
    if (!list.length) return { core: none(), level: null, split: null };
    const N = median(list), split = N * o.coreSplit;
    const decided = new Uint8Array(n), side = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (Number.isFinite(level[i])) { decided[i] = 1; side[i] = level[i] > split ? 2 : 1; }
    const filled = distanceFrom(decided, dims, side).carry;
    const doped = new Uint8Array(n);
    for (let i = 0; i < n; i++) doped[i] = envelope[i] && filled[i] === 2 ? 1 : 0;
    const r = Math.max(1, Math.round(o.coreOpenMm / cellMm));
    let m = doped;
    for (let k = 0; k < r; k++) m = crossStep(m, dims, false);
    for (let k = 0; k < r; k++) m = crossStep(m, dims, true);
    const { labels, n: pieces } = label6(m, dims);
    if (!pieces) return { core: none(), level: N, split };
    const size = new Float64Array(pieces + 1);
    for (let i = 0; i < n; i++) if (labels[i]) size[labels[i]]++;
    let best = 1;
    for (let l = 2; l <= pieces; l++) if (size[l] > size[best]) best = l;
    let core = none();
    for (let i = 0; i < n; i++) core[i] = labels[i] === best ? 1 : 0;
    for (let k = 0; k < r; k++) core = crossStep(core, dims, true);
    for (let i = 0; i < n; i++) core[i] = core[i] && doped[i] ? 1 : 0;
    core = fillHolesInPlanes(core, dims, fillAxis);
    for (let i = 0; i < n; i++) if (!envelope[i]) core[i] = 0;
    return { core, level: N, split };
  }

  // ---------- orientation and rendering ----------
  /** The figure frame: x along the field (scan x or y), y across it, z up. upIsLowZ: the first slice is the top. */
  function toFigureFrame(labels, dims, { fieldAxis = 'x', upIsLowZ = true } = {}) {
    const { nx, ny, nz } = dims, swap = fieldAxis === 'y';
    const out = { nx: swap ? ny : nx, ny: swap ? nx : ny, nz }, L = new Uint8Array(labels.length);
    for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
      const fx = swap ? y : x, fy = swap ? x : y, fz = upIsLowZ ? nz - 1 - z : z;
      L[(fz * out.ny + fy) * out.nx + fx] = labels[i];
    }
    return { labels: L, dims: out };
  }

  /** Rotate about the vertical axis by az degrees (nearest neighbor) into a box that holds the whole volume
      (size: the given square side, or the rotated bounding box). Also returns where the field axis points. */
  function rotate(labels, dims, az, side = null) {
    const { nx, ny, nz } = dims, a = (az * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const W = side || Math.ceil(Math.abs(nx * c) + Math.abs(ny * s)), D = side || Math.ceil(Math.abs(nx * s) + Math.abs(ny * c));
    const out = { nx: W, ny: D, nz }, R = new Uint8Array(W * D * nz);
    const cx = (nx - 1) / 2, cy = (ny - 1) / 2, ox = (W - 1) / 2, oy = (D - 1) / 2;
    const plane = nx * ny;
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
      const u = i - ox, v = j - oy;
      const x = Math.round(c * u + s * v + cx), y = Math.round(-s * u + c * v + cy);
      if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
      const src = y * nx + x, dst = j * W + i;
      for (let z = 0; z < nz; z++) R[z * W * D + dst] = labels[z * plane + src];
    }
    return { labels: R, dims: out, field: [c, s] }; // the field axis (source +x) in (rotated x, depth)
  }

  /** Remove the near quarter: x from the median x of the doped region on, depth before its median depth. */
  function cutQuarter(labels, dims) {
    const { nx, ny } = dims, xs = [], ds = [];
    for (let i = 0; i < labels.length; i++) { const v = labels[i]; if (v === 1 || v === 2 || v === 5) { xs.push(i % nx); ds.push(Math.floor(i / nx) % ny); } }
    if (!xs.length) for (let i = 0; i < labels.length; i++) if (labels[i]) { xs.push(i % nx); ds.push(Math.floor(i / nx) % ny); }
    const cx = Math.floor(median(xs)), cd = Math.floor(median(ds)), out = Uint8Array.from(labels);
    for (let i = 0; i < out.length; i++) if (i % nx >= cx && Math.floor(i / nx) % ny < cd) out[i] = 0;
    return { labels: out, cut: { x: cx, d: cd } };
  }

  /** Resample rows by factor (linear for channels, nearest for labels): the view's vertical foreshortening. */
  function squashRows(src, w, h, channels, f, nearest) {
    const H = Math.max(1, Math.round(h * f)), out = new (src.constructor)(w * H * channels);
    for (let r = 0; r < H; r++) {
      const y = (r + 0.5) / f - 0.5, y0 = Math.max(0, Math.min(h - 1, Math.floor(y))), y1 = Math.min(h - 1, y0 + 1), t = nearest ? 0 : Math.max(0, Math.min(1, y - y0));
      const yn = nearest ? Math.max(0, Math.min(h - 1, Math.round(y))) : y0;
      for (let x = 0; x < w * channels; x++) out[r * w * channels + x] = nearest ? src[yn * w * channels + x] : src[y0 * w * channels + x] * (1 - t) + src[y1 * w * channels + x] * t;
    }
    return { data: out, height: H };
  }

  /** Opaque first-hit render (orthographic, elevation el): RGB (Float32, 0..1), the hit mask and the label image,
      width = nx, rows top to bottom. */
  function opaque(labels, dims, el = VIEW.el, light = [-0.35, 0.6, -0.72]) {
    const { nx: X, ny: D, nz: Z } = dims, t = Math.tan((el * Math.PI) / 180), cs = Math.cos((el * Math.PI) / 180);
    const H = Math.floor(Z + D * t) + 2;
    const lab = new Uint8Array(X * H), dep = new Float32Array(X * H).fill(-1);
    for (let d = 0; d < D; d++) {
      const off = Math.round(d * t);
      for (let z = 0; z < Z; z++) {
        const row = (z * D + d) * X, v = z + off;
        for (let x = 0; x < X; x++) {
          const c = labels[row + x];
          if (!c) continue;
          const p = (H - 1 - v) * X + x; // screen row from the top
          if (dep[p] >= 0) continue;
          dep[p] = d; lab[p] = c;
        }
      }
    }
    const zf = new Float32Array(X * H);
    for (let i = 0; i < zf.length; i++) zf[i] = dep[i] >= 0 ? dep[i] : D * 2;
    // smooth the depth (sigma 0.8) for normals
    const k = gaussianKernel(0.8), r = (k.length - 1) / 2, tmp = new Float32Array(zf.length), zs = new Float32Array(zf.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < X; x++) { let s = 0; for (let q = -r; q <= r; q++) s += k[q + r] * zf[y * X + Math.min(X - 1, Math.max(0, x + q))]; tmp[y * X + x] = s; }
    for (let y = 0; y < H; y++) for (let x = 0; x < X; x++) { let s = 0; for (let q = -r; q <= r; q++) s += k[q + r] * tmp[Math.min(H - 1, Math.max(0, y + q)) * X + x]; zs[y * X + x] = s; }
    const grad = (a, x, y, dx, dy) => {
      const xa = Math.max(0, x - dx), xb = Math.min(X - 1, x + dx), ya = Math.max(0, y - dy), yb = Math.min(H - 1, y + dy);
      return (a[yb * X + xb] - a[ya * X + xa]) / Math.max(1, (xb - xa) + (yb - ya));
    };
    const ln = Math.hypot(...light), L = light.map((v) => v / ln);
    const rgb = new Float32Array(X * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < X; x++) {
      const p = y * X + x;
      if (dep[p] < 0) { rgb[3 * p] = rgb[3 * p + 1] = rgb[3 * p + 2] = 1; continue; }
      const gx = grad(zs, x, y, 1, 0), gv = -grad(zs, x, y, 0, 1); // screen v runs up
      const nn = Math.hypot(gx, gv, 1), diff = Math.max(0, Math.min(1, (gx * L[0] + gv * L[1] - L[2]) / nn));
      let sh = 0.38 + 0.70 * diff;
      if (Math.abs(grad(zf, x, y, 1, 0)) + Math.abs(grad(zf, x, y, 0, 1)) > 6) sh *= 0.55;
      const col = COLORS[lab[p]];
      for (let ch = 0; ch < 3; ch++) rgb[3 * p + ch] = Math.min(1, col[ch] * sh);
    }
    const hit = new Float32Array(X * H);
    for (let i = 0; i < hit.length; i++) hit[i] = dep[i] >= 0 ? 1 : 0;
    const img = squashRows(rgb, X, H, 3, cs, false), hm = squashRows(hit, X, H, 1, cs, false), lb = squashRows(lab, X, H, 1, cs, true);
    const mask = new Uint8Array(X * img.height);
    for (let i = 0; i < mask.length; i++) mask[i] = hm.data[i] > 0.5 ? 1 : 0;
    return { rgb: img.data, mask, labels: lb.data, width: X, height: img.height };
  }

  /** See-through render: front-to-back alpha compositing with per-label alpha over a white background. */
  function xray(labels, dims, el = VIEW.el, alpha = XRAY_ALPHA) {
    const { nx: X, ny: D, nz: Z } = dims, t = Math.tan((el * Math.PI) / 180), cs = Math.cos((el * Math.PI) / 180);
    const H = Math.floor(Z + D * t) + 2;
    const rgb = new Float32Array(X * H * 3), T = new Float32Array(X * H).fill(1);
    for (let d = 0; d < D; d++) {
      const off = Math.round(d * t);
      for (let z = 0; z < Z; z++) {
        const row = (z * D + d) * X, p0 = (H - 1 - (z + off)) * X;
        for (let x = 0; x < X; x++) {
          const c = labels[row + x];
          if (!c) continue;
          const a = alpha[c], p = p0 + x, tw = T[p] * a, col = COLORS[c];
          rgb[3 * p] += tw * col[0]; rgb[3 * p + 1] += tw * col[1]; rgb[3 * p + 2] += tw * col[2];
          T[p] *= 1 - a;
        }
      }
    }
    for (let p = 0; p < X * H; p++) for (let ch = 0; ch < 3; ch++) rgb[3 * p + ch] = Math.min(1, rgb[3 * p + ch] + T[p]);
    const img = squashRows(rgb, X, H, 3, cs, false), tt = squashRows(T, X, H, 1, cs, false);
    const mask = new Uint8Array(X * img.height);
    for (let i = 0; i < mask.length; i++) mask[i] = tt.data[i] < 0.97 ? 1 : 0;
    return { rgb: img.data, mask, width: X, height: img.height };
  }

  /** Bounding box of a 2D mask with padding: { x0, y0, x1, y1 } (exclusive ends), or null. */
  function maskBox(mask, w, h, pad = 0) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    return { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(w, x1 + pad + 1), y1: Math.min(h, y1 + pad + 1) };
  }

  /** RGBA bytes of a crop of an RGB float image. */
  function toRGBA(rgb, w, box) {
    const W = box.x1 - box.x0, H = box.y1 - box.y0, out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = (y + box.y0) * w + x + box.x0, q = (y * W + x) * 4;
      out[q] = rgb[3 * p] * 255; out[q + 1] = rgb[3 * p + 1] * 255; out[q + 2] = rgb[3 * p + 2] * 255; out[q + 3] = 255;
    }
    return { data: out, width: W, height: H };
  }

  /** Callout anchors: for each class, the visible pixel farthest inside its own patch (image pixels), if the patch
      covers at least minMm2. */
  function anchors(labels, w, h, cellMm, classes = [1, 2, 3, 5], minMm2 = 2.56) {
    const out = [];
    for (const c of classes) {
      const m = new Uint8Array(w * h);
      let cnt = 0;
      for (let i = 0; i < m.length; i++) if (labels[i] === c) { m[i] = 1; cnt++; }
      if (cnt * cellMm * cellMm < minMm2) continue;
      const d = distance2(m, w, h);
      let best = -1, at = 0;
      for (let i = 0; i < d.length; i++) if (m[i] && d[i] > best) { best = d[i]; at = i; }
      out.push({ code: c, x: at % w, y: Math.floor(at / w) });
    }
    return out;
  }

  /** The screen direction of the field axis (unit, y down) after rotation field = [x, depth] in the rotated box. */
  function fieldOnScreen(field, el = VIEW.el) {
    const dx = field[0], dy = -field[1] * Math.sin((el * Math.PI) / 180), nn = Math.hypot(dx, dy) || 1;
    return [dx / nn, dy / nn];
  }

  /** Halve the grid for the turntable: gas and clumps are kept wherever any of the 8 voxels holds them. */
  function halve(labels, dims) {
    const out = { nx: dims.nx >> 1, ny: dims.ny >> 1, nz: dims.nz >> 1 }, L = new Uint8Array(sizeOf(out));
    for (let z = 0, o = 0; z < out.nz; z++) for (let y = 0; y < out.ny; y++) for (let x = 0; x < out.nx; x++, o++) {
      let v = labels[((2 * z) * dims.ny + 2 * y) * dims.nx + 2 * x], gas = false, clump = false;
      for (let k = 0; k < 8; k++) {
        const c = labels[((2 * z + (k >> 2)) * dims.ny + 2 * y + ((k >> 1) & 1)) * dims.nx + 2 * x + (k & 1)];
        if (c === CODE.DOPED_PORE) gas = true; else if (c === CODE.CLUMP) clump = true;
      }
      L[o] = gas ? CODE.DOPED_PORE : clump ? CODE.CLUMP : v;
    }
    return { labels: L, dims: out };
  }

  /** Run-length code of a label volume (pairs value, count), for keeping a figure set small. */
  function encode(labels) {
    const out = [];
    for (let i = 0; i < labels.length;) { let j = i; while (j < labels.length && labels[j] === labels[i] && j - i < 65535) j++; out.push(labels[i], j - i); i = j; }
    return Uint16Array.from(out);
  }
  function decode(runs, n) {
    const L = new Uint8Array(n);
    for (let k = 0, at = 0; k < runs.length; k += 2) { L.fill(runs[k], at, at + runs[k + 1]); at += runs[k + 1]; }
    return L;
  }

  return { CODE, COLORS, XRAY_ALPHA, TURN_ALPHA, VIEW, DEFAULTS, TARGET_MM, planFactor, boundsOf, blockGrid, sliceGrid, maskOnGrid, gaussian3, boxMean, label6, distanceFrom, depthInside, distance2,
    findClumps, clusteredIds, classify, closePores, figureStats, figureNumbers, numbersLine, pct, denseCore, fillHolesInPlanes, toFigureFrame, rotate, cutQuarter, opaque, xray, maskBox, toRGBA, anchors, fieldOnScreen, halve, encode, decode };
}));
