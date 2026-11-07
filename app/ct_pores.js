/* Pore detection in two passes. The binned pass finds the part's solid body (closed and filled), looks for low gray
   only inside it, and splits big regions at narrow necks by growing seeds back. Plain connected components fail here:
   on Sample 2 the largest pores reach outside air through cracks. The full-resolution pass then outlines every pore
   at 40 um, including ones too small for the binned pass. Arrays are raster order (z, y, x). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CTPores = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OPEN_ITERATIONS = 2;
  const DEFAULT_SETTINGS = { sigma: 1, bodyThreshold: 1400, closeRadius: 8, closeShape: 'ball', margin: 2, poreThreshold: 1300, neck: 3, fineSigma: 1, minVolumeMm3: 0.0005, maxElongation: 2.5 };
  const MAX_GROW_ROUNDS = 200;

  const binnedToFull = (i, bin) => i * bin + (bin - 1) / 2;
  const fullToBinned = (i, bin) => Math.floor(i / bin);

  /** Block means. outside comes from the fitted circle: exact 0 is not enough, because dark voxels inside big pores
      also read 0. Without a circle, a block holding any 0 counts as outside. */
  function binVolume(slices, { nx, ny, nz }, bin, circle) {
    const dims = { nx: Math.floor(nx / bin), ny: Math.floor(ny / bin), nz: Math.floor(nz / bin) };
    const n = dims.nx * dims.ny * dims.nz;
    const gray = new Float32Array(n);
    const outside = new Uint8Array(n);
    const perBlock = bin ** 3;
    for (let bz = 0; bz < dims.nz; bz++) {
      for (let k = 0; k < bin; k++) {
        const s = slices[bz * bin + k];
        for (let by = 0; by < dims.ny; by++) {
          const at = (bz * dims.ny + by) * dims.nx;
          for (let j = 0; j < bin; j++) {
            const row = (by * bin + j) * nx;
            for (let bx = 0; bx < dims.nx; bx++) {
              for (let i = 0; i < bin; i++) {
                const v = s[row + bx * bin + i];
                gray[at + bx] += v;
                if (v === 0 && !circle) outside[at + bx] = 1;
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < n; i++) gray[i] /= perBlock;
    if (circle) {
      const half = (bin * Math.SQRT2) / 2;
      for (let by = 0; by < dims.ny; by++) {
        const dy = (by + 0.5) * bin - circle.cy;
        for (let bx = 0; bx < dims.nx; bx++) {
          const dx = (bx + 0.5) * bin - circle.cx;
          if (Math.hypot(dx, dy) + half > circle.r) {
            for (let bz = 0; bz < dims.nz; bz++) outside[(bz * dims.ny + by) * dims.nx + bx] = 1;
          }
        }
      }
    }
    return { gray, outside, dims };
  }

  // Calls fn(start, stride, length) once per line along each axis in turn.
  function forLines({ nx, ny, nz }, axis, fn) {
    if (axis === 0) { for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) fn((z * ny + y) * nx, 1, nx); return; }
    if (axis === 1) { for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) fn(z * ny * nx + x, nx, ny); return; }
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) fn(y * nx + x, nx * ny, nz);
  }

  function gaussian(gray, dims, sigma) {
    if (!(sigma > 0)) return gray;
    const r = Math.ceil(3 * sigma);
    const kernel = new Float32Array(2 * r + 1);
    let total = 0;
    for (let i = -r; i <= r; i++) { kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); total += kernel[i + r]; }
    for (let i = 0; i <= 2 * r; i++) kernel[i] /= total;
    let src = gray;
    const line = new Float32Array(Math.max(dims.nx, dims.ny, dims.nz));
    for (let axis = 0; axis < 3; axis++) {
      const out = new Float32Array(gray.length);
      forLines(dims, axis, (start, stride, len) => {
        for (let i = 0; i < len; i++) line[i] = src[start + i * stride];
        for (let i = 0; i < len; i++) {
          let v = 0;
          for (let t = -r; t <= r; t++) {
            const at = i + t;
            v += kernel[t + r] * line[at < 0 ? 0 : at >= len ? len - 1 : at];
          }
          out[start + i * stride] = v;
        }
      });
      src = out;
    }
    return src;
  }

  /** Same result as gaussian(), for a volume too large to hold: push slices in order; emit(z, smoothed) follows. */
  function createSliceSmoother({ nx, ny, nz }, sigma, emit) {
    if (!(sigma > 0)) {
      let z = 0;
      return (slice) => emit(z++, slice);
    }
    const r = Math.ceil(3 * sigma);
    const kernel = new Float32Array(2 * r + 1);
    let total = 0;
    for (let i = -r; i <= r; i++) { kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); total += kernel[i + r]; }
    for (let i = 0; i <= 2 * r; i++) kernel[i] /= total;
    const line = new Float32Array(nx);
    const blurXY = (slice) => {
      const inX = new Float32Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        const at = y * nx;
        for (let x = 0; x < nx; x++) line[x] = slice[at + x];
        for (let x = 0; x < nx; x++) {
          let v = 0;
          for (let t = -r; t <= r; t++) { const q = x + t; v += kernel[t + r] * line[q < 0 ? 0 : q >= nx ? nx - 1 : q]; }
          inX[at + x] = v;
        }
      }
      const out = new Float32Array(nx * ny);
      for (let t = -r; t <= r; t++) {
        const w = kernel[t + r];
        for (let y = 0; y < ny; y++) {
          const q = y + t, from = (q < 0 ? 0 : q >= ny ? ny - 1 : q) * nx, to = y * nx;
          for (let x = 0; x < nx; x++) out[to + x] += w * inX[from + x];
        }
      }
      return out;
    };
    const held = new Map();
    let pushed = 0;
    const emitCenter = (z) => {
      const out = new Float32Array(nx * ny);
      for (let t = -r; t <= r; t++) {
        const q = z + t;
        const src = held.get(q < 0 ? 0 : q >= nz ? nz - 1 : q);
        const w = kernel[t + r];
        for (let i = 0; i < out.length; i++) out[i] += w * src[i];
      }
      emit(z, out);
      if (z - r !== 0 && held.has(z - r)) held.delete(z - r);
    };
    return (slice) => {
      held.set(pushed, blurXY(slice));
      if (pushed >= r) emitCenter(pushed - r);
      pushed++;
      if (pushed === nz) for (let z = Math.max(0, nz - r); z < nz; z++) emitCenter(z);
    };
  }

  /** 6-connected components. labels are 1..count in raster order of first appearance; sizes[label] = voxels. */
  function label(mask, { nx, ny, nz }) {
    const labels = new Uint32Array(mask.length);
    let parent = new Uint32Array(1 << 16);
    let next = 1;
    const find = (a) => {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    };
    const plane = nx * ny;
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (!mask[i]) continue;
          const a = x > 0 ? labels[i - 1] : 0;
          const b = y > 0 ? labels[i - nx] : 0;
          const c = z > 0 ? labels[i - plane] : 0;
          let root = 0;
          for (const l of [a, b, c]) {
            if (!l) continue;
            const r = find(l);
            if (!root) root = r;
            else if (r !== root) { if (r < root) { parent[root] = r; root = r; } else parent[r] = root; }
          }
          if (!root) {
            if (next >= parent.length) { const bigger = new Uint32Array(parent.length * 2); bigger.set(parent); parent = bigger; }
            parent[next] = next;
            root = next++;
          }
          labels[i] = root;
        }
      }
    }
    const remap = new Uint32Array(next);
    let count = 0;
    for (let l = 1; l < next; l++) if (find(l) === l) remap[l] = ++count;
    const sizes = new Uint32Array(count + 1);
    for (let i = 0; i < labels.length; i++) {
      if (labels[i]) { const l = remap[find(labels[i])]; labels[i] = l; sizes[l]++; }
    }
    return { labels, count, sizes };
  }

  function boxDilate(mask, dims, radius) {
    let src = mask;
    for (let axis = 0; axis < 3; axis++) {
      const out = new Uint8Array(mask.length);
      forLines(dims, axis, (start, stride, len) => {
        let last = -Infinity;
        for (let i = 0; i < len; i++) {
          if (src[start + i * stride]) last = i;
          if (i - last <= radius) out[start + i * stride] = 1;
        }
        last = Infinity;
        for (let i = len - 1; i >= 0; i--) {
          if (src[start + i * stride]) last = i;
          if (last - i <= radius) out[start + i * stride] = 1;
        }
      });
      src = out;
    }
    return src;
  }

  const invert = (mask) => {
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
    return out;
  };

  /** Cube erosion. Past the stack edge counts as set, so the edge itself does not erode. */
  const boxErode = (mask, dims, radius) => invert(boxDilate(invert(mask), dims, radius));

  const FAR = 1e9;
  /** One line of the squared distance transform (Felzenszwalb and Huttenlocher): d[q] = min over p of (q-p)² + f[p]. */
  function distanceLine(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
  }
  /** Squared Euclidean distance (voxels²) from each voxel to the nearest voxel whose mask value is target, one axis at
      a time; voxels outside the stack never count as target. */
  function squaredDistance(mask, dims, target) {
    const out = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) out[i] = (mask[i] ? 1 : 0) === target ? 0 : FAR;
    const longest = Math.max(dims.nx, dims.ny, dims.nz);
    const f = new Float64Array(longest), d = new Float64Array(longest), v = new Int32Array(longest), z = new Float64Array(longest + 1);
    for (let axis = 0; axis < 3; axis++) {
      forLines(dims, axis, (start, stride, len) => {
        for (let i = 0; i < len; i++) f[i] = out[start + i * stride];
        distanceLine(f, len, d, v, z);
        for (let i = 0; i < len; i++) out[start + i * stride] = Math.min(d[i], FAR);
      });
    }
    return out;
  }
  /** Dilation by a ball of the radius (voxels within it of the mask, x² + y² + z² ≤ r²). */
  function ballDilate(mask, dims, radius) {
    const d = squaredDistance(mask, dims, 1), out = new Uint8Array(mask.length), r2 = radius * radius;
    for (let i = 0; i < out.length; i++) if (d[i] <= r2) out[i] = 1;
    return out;
  }
  /** Erosion by a ball of the radius; the stack edge does not erode, as with the box. */
  function ballErode(mask, dims, radius) {
    const d = squaredDistance(mask, dims, 0), out = new Uint8Array(mask.length), r2 = radius * radius;
    for (let i = 0; i < out.length; i++) if (mask[i] && d[i] > r2) out[i] = 1;
    return out;
  }
  /** Closing (dilate, then erode) by a ball (default) or, for settings saved before 2026-11-05, a box. A box reaches
      √3 times farther along its diagonals, so its closing depends on how the part sits in the voxel grid. */
  function closeMask(mask, dims, radius, shape) {
    if (radius <= 0) return mask.slice();
    return shape === 'ball' ? ballErode(ballDilate(mask, dims, radius), dims, radius) : boxErode(boxDilate(mask, dims, radius), dims, radius);
  }
  /** Settings read back from a saved run, bookmark or preset: those saved before the round closing have no closeShape
      and were made with the box, so they keep it and reproduce their numbers. */
  const savedSettings = (saved) => ({ ...DEFAULT_SETTINGS, closeShape: 'box', ...saved });

  // Diamond (6-neighbor) erosion, repeated; past the stack edge counts as empty.
  function erodeSteps(mask, { nx, ny, nz }, steps) {
    let src = mask;
    const plane = nx * ny;
    for (let s = 0; s < steps; s++) {
      const out = new Uint8Array(mask.length);
      for (let z = 1, zEnd = nz - 1; z < zEnd; z++) {
        for (let y = 1, yEnd = ny - 1; y < yEnd; y++) {
          let i = (z * ny + y) * nx + 1;
          for (let x = 1, xEnd = nx - 1; x < xEnd; x++, i++) {
            if (src[i] && src[i - 1] && src[i + 1] && src[i - nx] && src[i + nx] && src[i - plane] && src[i + plane]) out[i] = 1;
          }
        }
      }
      src = out;
    }
    return src;
  }

  function dilateSteps(mask, { nx, ny, nz }, steps) {
    let src = mask;
    const plane = nx * ny;
    for (let s = 0; s < steps; s++) {
      const out = new Uint8Array(src);
      for (let z = 0, i = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++, i++) {
            if (!src[i]) continue;
            if (x > 0) out[i - 1] = 1;
            if (x < nx - 1) out[i + 1] = 1;
            if (y > 0) out[i - nx] = 1;
            if (y < ny - 1) out[i + nx] = 1;
            if (z > 0) out[i - plane] = 1;
            if (z < nz - 1) out[i + plane] = 1;
          }
        }
      }
      src = out;
    }
    return src;
  }

  function fillHoles(mask, dims) {
    const { nx, ny, nz } = dims;
    const { labels, count } = label(invert(mask), dims);
    const open = new Uint8Array(count + 1);
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (labels[i] && (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1)) open[labels[i]] = 1;
        }
      }
    }
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) out[i] = mask[i] || !open[labels[i]] ? 1 : 0;
    return out;
  }

  /** Even-odd scanline fill. toPoint(pixel) gives the polygon coordinate of a pixel center. */
  function rasterPolygon(points, width, height, toPoint = (i) => i + 0.5) {
    const out = new Uint8Array(width * height);
    const n = points.length;
    for (let row = 0; row < height; row++) {
      const py = toPoint(row);
      const crossings = [];
      for (let i = 0; i < n; i++) {
        const a = points[i], b = points[(i + 1) % n];
        if ((a.row <= py && b.row > py) || (b.row <= py && a.row > py)) {
          crossings.push(a.col + ((py - a.row) / (b.row - a.row)) * (b.col - a.col));
        }
      }
      crossings.sort((p, q) => p - q);
      for (let c = 0; c + 1 < crossings.length; c += 2) {
        for (let col = 0; col < width; col++) {
          const px = toPoint(col);
          if (px >= crossings[c] && px <= crossings[c + 1]) out[row * width + col] = 1;
        }
      }
    }
    return out;
  }

  /** Keep-mask at binned resolution from full-resolution outlines, each extruded through its plane; null if no crop. */
  function cropMask(outlines, dims, bin) {
    if (!outlines.length) return null;
    const { nx, ny, nz } = dims;
    const out = new Uint8Array(nx * ny * nz).fill(1);
    const toPoint = (i) => binnedToFull(i, bin) + 0.5;
    for (const { plane, points } of outlines) {
      const w = plane === 'YZ' ? ny : nx;
      const h = plane === 'XY' ? ny : nz;
      const r = rasterPolygon(points, w, h, toPoint);
      for (let z = 0, i = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++, i++) {
            const at = plane === 'XY' ? y * w + x : plane === 'XZ' ? z * w + x : z * w + y;
            if (!r[at]) out[i] = 0;
          }
        }
      }
    }
    return out;
  }

  /** Keep-mask over one slice from crop outlines, or null with no crop. Records are frozen, so rasters are cached in
      the Map the caller passes, by record id. */
  function planeCropKeep(crops, plane, slice, { nx, ny, nz }, cache) {
    if (!crops.length) return null;
    const width = plane === 'YZ' ? ny : nx, height = plane === 'XY' ? ny : nz;
    const keep = new Uint8Array(width * height).fill(1);
    for (const c of crops) {
      const w = c.plane === 'YZ' ? ny : nx, h = c.plane === 'XY' ? ny : nz;
      if (!cache.has(c.id)) cache.set(c.id, rasterPolygon(c.points, w, h));
      const raster = cache.get(c.id);
      for (let row = 0, at = 0; row < height; row++) {
        for (let col = 0; col < width; col++, at++) {
          const x = plane === 'YZ' ? slice : col;
          const y = plane === 'XY' ? row : plane === 'XZ' ? slice : col;
          const z = plane === 'XY' ? slice : row;
          if (!raster[c.plane === 'XY' ? y * w + x : c.plane === 'XZ' ? z * w + x : z * w + y]) keep[at] = 0;
        }
      }
    }
    return keep;
  }

  /** The part: largest solid component above the body threshold (within the crop), closed and filled. With holderInput
      ({ pieces | null, givenBack, voxelMm, onProgress? }) the holder is found (or the given pieces used) on the solid
      without the crop, cut out before the opening (then the crop) and cut again from the result; the return also holds
      holder: { method, pieces, givenBack, labels, removedVoxels, warning }. Lazy require: a load-time one would cycle. */
  function buildBody(gray, outside, dims, settings, crop, holderInput) {
    const smoothed = gaussian(gray, dims, settings.sigma);
    const n = gray.length;
    const solid = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (smoothed[i] > settings.bodyThreshold && !outside[i] && (holderInput || !crop || crop[i])) solid[i] = 1;
    }
    let cut = null;
    if (holderInput) {
      cut = (typeof module === 'object' && module.exports ? require('./vb_holderremoval.js') : globalThis.VBHolderRemoval)
        .removeHolder({ smoothed, solid, outside, dims, crop }, holderInput);
      for (let i = 0; i < n; i++) if (cut.holder[i] || (crop && !crop[i])) solid[i] = 0;
    }
    const opened = dilateSteps(erodeSteps(solid, dims, OPEN_ITERATIONS), dims, OPEN_ITERATIONS);
    const { labels, count, sizes } = label(opened, dims);
    let biggest = 0;
    for (let l = 1; l <= count; l++) if (sizes[l] > sizes[biggest]) biggest = l;
    const main = new Uint8Array(n);
    if (biggest) for (let i = 0; i < n; i++) if (labels[i] === biggest) main[i] = 1;
    const closed = closeMask(main, dims, settings.closeRadius, settings.closeShape);
    const filled = fillHoles(closed, dims);
    if (crop) for (let i = 0; i < n; i++) if (!crop[i]) filled[i] = 0;
    if (!cut) return { smoothed, filled };
    for (let i = 0; i < n; i++) if (cut.holder[i]) filled[i] = 0;
    return { smoothed, filled, holder: cut.info };
  }

  /** Ratio of longest to shortest axis from second moments: sqrt of the largest over smallest eigenvalue. */
  function elongation({ xx, yy, zz, xy, xz, yz }) {
    const p1 = xy * xy + xz * xz + yz * yz;
    if (p1 < 1e-12) {
      const low = Math.min(xx, yy, zz);
      return low > 0 ? Math.sqrt(Math.max(xx, yy, zz) / low) : Infinity;
    }
    const q = (xx + yy + zz) / 3;
    const p = Math.sqrt(((xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * p1) / 6);
    const a = (xx - q) / p, b = (yy - q) / p, c = (zz - q) / p, d = xy / p, e = xz / p, f = yz / p;
    const r = Math.max(-1, Math.min(1, (a * (b * c - f * f) - d * (d * c - f * e) + e * (d * f - b * e)) / 2));
    const phi = Math.acos(r) / 3;
    const high = q + 2 * p * Math.cos(phi);
    const low = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
    return low > 0 ? Math.sqrt(high / low) : Infinity;
  }

  // Grow seed labels into the low mask, one 6-neighbor shell per round, visiting only unclaimed low voxels.
  function growLabels(labels, low, { nx, ny }, rounds) {
    const plane = nx * ny;
    let waiting = 0;
    for (let i = 0; i < low.length; i++) if (low[i] && !labels[i]) waiting++;
    let list = new Int32Array(waiting);
    for (let i = 0, w = 0; i < low.length; i++) if (low[i] && !labels[i]) list[w++] = i;
    const n = low.length;
    for (let round = 0; round < rounds && list.length; round++) {
      const hits = [];
      const rest = new Int32Array(list.length);
      let r = 0;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        const x = i % nx;
        const y = Math.floor(i / nx) % ny;
        const l = (x > 0 && labels[i - 1]) || (x < nx - 1 && labels[i + 1]) || (y > 0 && labels[i - nx])
          || (y < ny - 1 && labels[i + nx]) || (i >= plane && labels[i - plane]) || (i + plane < n && labels[i + plane]);
        if (l) hits.push(i, l);
        else rest[r++] = i;
      }
      if (!hits.length) return;
      for (let k = 0; k < hits.length; k += 2) labels[hits[k]] = hits[k + 1];
      list = rest.subarray(0, r);
    }
  }

  /** Coarse pass on the binned volume. Pores are numbered by volume, largest first. Coordinates are full-resolution
      indices. A region touching the reconstruction edge stays in the list, flagged clipped: it may be a big pore
      joined to a crack network, so dropping it would lose real pores. */
  function detectPores(gray, outside, dims, body, settings, { bin, voxelMm }) {
    const { nx, ny, nz } = dims;
    const n = gray.length;
    const edgeZone = boxDilate(outside, dims, settings.margin + 1);
    const interior = settings.margin > 0 ? boxErode(body.filled, dims, settings.margin) : body.filled;
    const low = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (interior[i] && body.smoothed[i] < settings.poreThreshold && !outside[i]) low[i] = 1;
    const seeds = settings.neck > 0 ? erodeSteps(low, dims, settings.neck) : low;
    const { labels, count } = label(seeds, dims);
    if (settings.neck > 0) growLabels(labels, low, dims, MAX_GROW_ROUNDS);

    const size = new Float64Array(count + 1);
    const moments = new Float64Array((count + 1) * 9);
    const clipped = new Uint8Array(count + 1);
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          const l = labels[i];
          if (!l) continue;
          size[l]++;
          if (edgeZone[i]) clipped[l] = 1;
          const m = l * 9;
          moments[m] += x; moments[m + 1] += y; moments[m + 2] += z;
          moments[m + 3] += x * x; moments[m + 4] += y * y; moments[m + 5] += z * z;
          moments[m + 6] += x * y; moments[m + 7] += x * z; moments[m + 8] += y * z;
        }
      }
    }
    const voxelVolume = (bin * voxelMm) ** 3;
    const kept = [];
    for (let l = 1; l <= count; l++) {
      if (!size[l]) continue;
      const volume = size[l] * voxelVolume;
      if (volume < settings.minVolumeMm3) continue;
      const m = l * 9, c = size[l];
      const mx = moments[m] / c, my = moments[m + 1] / c, mz = moments[m + 2] / c;
      // 1/12 is a voxel's own variance, so a single voxel reads as round rather than undefined.
      const stretch = elongation({ xx: moments[m + 3] / c - mx * mx + 1 / 12, yy: moments[m + 4] / c - my * my + 1 / 12, zz: moments[m + 5] / c - mz * mz + 1 / 12,
        xy: moments[m + 6] / c - mx * my, xz: moments[m + 7] / c - mx * mz, yz: moments[m + 8] / c - my * mz });
      const x = binnedToFull(mx, bin), y = binnedToFull(my, bin), z = binnedToFull(mz, bin);
      kept.push({ source: l, x, y, z, x_mm: x * voxelMm, y_mm: y * voxelMm, z_mm: z * voxelMm, volume_mm3: volume,
        diameter_mm: ((6 * volume) / Math.PI) ** (1 / 3), elongation: stretch, crack_like: stretch > settings.maxElongation, clipped: Boolean(clipped[l]), fine: false });
    }
    kept.sort((a, b) => b.volume_mm3 - a.volume_mm3);
    const remap = new Uint32Array(count + 1);
    kept.forEach((p, i) => { p.id = i + 1; remap[p.source] = p.id; delete p.source; });
    for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
    return { labels, pores: kept, interior, edgeZone };
  }

  function summarize(pores, bodyVolumeMm3, rejected) {
    const s = { pore_count: 0, pore_volume_mm3: 0, crack_like_count: 0, crack_like_volume_mm3: 0, rejected_count: 0, clipped_count: 0, clipped_volume_mm3: 0, fine_count: 0, body_volume_mm3: bodyVolumeMm3 };
    for (const p of pores) {
      if (p.fine) s.fine_count++;
      if (rejected.has(p.id)) s.rejected_count++;
      else if (p.clipped) { s.clipped_count++; s.clipped_volume_mm3 += p.volume_mm3; }
      else if (p.crack_like) { s.crack_like_count++; s.crack_like_volume_mm3 += p.volume_mm3; }
      else { s.pore_count++; s.pore_volume_mm3 += p.volume_mm3; }
    }
    s.pore_percent_of_body = (100 * s.pore_volume_mm3) / bodyVolumeMm3;
    s.all_void_volume_mm3 = s.pore_volume_mm3 + s.crack_like_volume_mm3 + s.clipped_volume_mm3;
    s.all_void_percent_of_body = (100 * s.all_void_volume_mm3) / bodyVolumeMm3;
    return s;
  }

  /** A rejection is remembered as a voxel, so it survives a rerun when a new pore covers that voxel. */
  function rejectedAfterRerun(rejectedVoxels, runs, dims) {
    const out = new Set();
    for (const { x, y, z } of rejectedVoxels) {
      const id = poreIdAt(runs, dims, x, y, z);
      if (id) out.add(id);
    }
    return out;
  }

  /** Full-resolution pass. Each low voxel inside the body becomes part of a run along x; a run joins the coarse pore
      under it, runs touching that pore join it too (so its fringe is not a shell of fragments), and whatever is left
      forms new small pores. Runs are kept instead of a label volume, which would be several gigabytes. */
  function fineDetect({ dims, bin, settings, voxelMm, coarse, binnedDims, getSmoothed }) {
    const { nx, ny } = dims;
    const b = binnedDims;
    const nz = b.nz * bin;
    let cap = 1 << 20, used = 0;
    let start = new Int32Array(cap), end = new Int32Array(cap), rowOf = new Int32Array(cap), owner = new Int32Array(cap);
    const offsets = new Int32Array(nz * ny + 2);
    const grow = () => {
      cap *= 2;
      for (const [get, set] of [[start, (v) => { start = v; }], [end, (v) => { end = v; }], [rowOf, (v) => { rowOf = v; }], [owner, (v) => { owner = v; }]]) {
        const bigger = new Int32Array(cap);
        bigger.set(get);
        set(bigger);
      }
    };
    const usableX = b.nx * bin;
    for (let z = 0; z < nz; z++) {
      const s = getSmoothed(z);
      const bz = Math.floor(z / bin);
      for (let y = 0; y < ny; y++) {
        const rowIndex = z * ny + y;
        offsets[rowIndex] = used;
        if (y >= b.ny * bin) continue;
        const row = y * nx;
        const base = (bz * b.ny + Math.floor(y / bin)) * b.nx;
        let open = -1, openId = 0;
        for (let x = 0; x <= usableX; x++) {
          let id = -1;
          if (x < usableX && s[row + x] < settings.poreThreshold) {
            const at = base + Math.floor(x / bin);
            if (coarse.interior[at] && !coarse.edgeZone[at]) id = coarse.labels[at];
          }
          if (open >= 0 && id !== openId) {
            if (used === cap) grow();
            start[used] = open; end[used] = x; rowOf[used] = rowIndex; owner[used] = openId; used++;
            open = -1;
          }
          if (id >= 0 && open < 0) { open = x; openId = id; }
        }
      }
    }
    offsets[nz * ny] = used;
    offsets[nz * ny + 1] = used;

    // Union-find over runs. A set belongs to at most one coarse pore; two different coarse pores never merge.
    const parent = new Int32Array(used);
    for (let i = 0; i < used; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const join = (a, c) => {
      const ra = find(a), rc = find(c);
      if (ra === rc || (owner[ra] && owner[rc] && owner[ra] !== owner[rc])) return;
      parent[rc] = ra;
      if (!owner[ra]) owner[ra] = owner[rc];
    };
    const overlap = (i, rowIndex) => {
      let j = offsets[rowIndex];
      const stop = offsets[rowIndex + 1];
      while (j < stop && start[j] < end[i]) {
        if (end[j] > start[i]) join(i, j);
        j++;
      }
    };
    for (let i = 0; i < used; i++) {
      const rowIndex = rowOf[i];
      if (i > 0 && rowOf[i - 1] === rowIndex && end[i - 1] === start[i]) join(i, i - 1);
      if (rowIndex % ny > 0) overlap(i, rowIndex - 1);
      if (rowIndex >= ny) overlap(i, rowIndex - ny);
    }

    const sets = new Map();
    const coarseById = new Map(coarse.pores.map((p) => [p.id, p]));
    for (let i = 0; i < used; i++) {
      const root = find(i);
      const key = owner[root] ? -owner[root] : root;
      let m = sets.get(key);
      if (!m) { m = { key, c: 0, sx: 0, sy: 0, sz: 0, xx: 0, yy: 0, zz: 0, xy: 0, xz: 0, yz: 0 }; sets.set(key, m); }
      const n = end[i] - start[i];
      const y = rowOf[i] % ny, z = Math.floor(rowOf[i] / ny);
      const sumX = (n * (start[i] + end[i] - 1)) / 2;
      const a = start[i] - 1, e = end[i] - 1;
      const sumXX = (e * (e + 1) * (2 * e + 1) - a * (a + 1) * (2 * a + 1)) / 6;
      m.c += n; m.sx += sumX; m.sy += n * y; m.sz += n * z;
      m.xx += sumXX; m.yy += n * y * y; m.zz += n * z * z; m.xy += sumX * y; m.xz += sumX * z; m.yz += n * y * z;
    }
    const voxelVolume = voxelMm ** 3;
    const pores = [];
    for (const m of sets.values()) {
      const volume = m.c * voxelVolume;
      if (volume < settings.minVolumeMm3) continue;
      const x = m.sx / m.c, y = m.sy / m.c, z = m.sz / m.c;
      const stretch = elongation({ xx: m.xx / m.c - x * x + 1 / 12, yy: m.yy / m.c - y * y + 1 / 12, zz: m.zz / m.c - z * z + 1 / 12,
        xy: m.xy / m.c - x * y, xz: m.xz / m.c - x * z, yz: m.yz / m.c - y * z });
      const from = m.key < 0 ? coarseById.get(-m.key) : null;
      pores.push({ key: m.key, x, y, z, x_mm: x * voxelMm, y_mm: y * voxelMm, z_mm: z * voxelMm, volume_mm3: volume, diameter_mm: ((6 * volume) / Math.PI) ** (1 / 3),
        elongation: stretch, crack_like: stretch > settings.maxElongation, clipped: from ? from.clipped : false, fine: !from });
    }
    pores.sort((p, q) => q.volume_mm3 - p.volume_mm3);
    const idOf = new Map();
    pores.forEach((p, i) => { p.id = i + 1; idOf.set(p.key, p.id); delete p.key; });

    // Compact the runs that belong to a kept pore.
    const finalOffsets = new Int32Array(nz * ny + 1);
    let w = 0, nextRow = 0;
    for (let i = 0; i < used; i++) {
      const root = find(i);
      const id = idOf.get(owner[root] ? -owner[root] : root);
      if (!id) continue;
      const rowIndex = rowOf[i];
      while (nextRow <= rowIndex) finalOffsets[nextRow++] = w;
      start[w] = start[i]; end[w] = end[i]; owner[w] = id; w++;
    }
    while (nextRow <= nz * ny) finalOffsets[nextRow++] = w;
    return { pores, runs: { offsets: finalOffsets, start: start.slice(0, w), end: end.slice(0, w), id: owner.slice(0, w), rows: nz * ny } };
  }

  /** Pore id at a full-resolution voxel, or 0. */
  function poreIdAt(runs, { ny }, x, y, z) {
    const rowIndex = z * ny + y;
    if (rowIndex >= runs.rows) return 0;
    let lo = runs.offsets[rowIndex], hi = runs.offsets[rowIndex + 1] - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (x < runs.start[mid]) hi = mid - 1;
      else if (x >= runs.end[mid]) lo = mid + 1;
      else return runs.id[mid];
    }
    return 0;
  }

  /** Pore ids over one plane at full resolution, written into out (raster order of that plane). */
  function planePoreIds(runs, dims, plane, slice, out) {
    const { nx, ny, nz } = dims;
    out.fill(0);
    if (plane === 'YZ') {
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) out[z * ny + y] = poreIdAt(runs, dims, slice, y, z);
      return out;
    }
    const zs = plane === 'XY' ? [slice] : Array.from({ length: nz }, (_, z) => z);
    for (const z of zs) {
      const ys = plane === 'XY' ? Array.from({ length: ny }, (_, y) => y) : [slice];
      for (const y of ys) {
        const rowIndex = z * ny + y;
        if (rowIndex >= runs.rows) continue;
        const to = plane === 'XY' ? y * nx : z * nx;
        for (let r = runs.offsets[rowIndex]; r < runs.offsets[rowIndex + 1]; r++) out.fill(runs.id[r], to + runs.start[r], to + runs.end[r]);
      }
    }
    return out;
  }

  function firstVoxelOf(runs, { ny }, id) {
    const at = runs.id.indexOf(id);
    if (at < 0) return null;
    let lo = 0, hi = runs.rows - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (runs.offsets[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return { x: runs.start[at], y: lo % ny, z: Math.floor(lo / ny) };
  }

  /** A binned label volume from the full-resolution runs: a binned voxel takes any pore that covers part of it. */
  function runsToBinned(runs, { ny }, binned, bin) {
    const out = new Uint32Array(binned.nx * binned.ny * binned.nz);
    for (let rowIndex = 0; rowIndex < runs.rows; rowIndex++) {
      const y = Math.floor((rowIndex % ny) / bin), z = Math.floor(Math.floor(rowIndex / ny) / bin);
      if (y >= binned.ny || z >= binned.nz) continue;
      const base = (z * binned.ny + y) * binned.nx;
      for (let r = runs.offsets[rowIndex]; r < runs.offsets[rowIndex + 1]; r++) {
        for (let b = Math.floor(runs.start[r] / bin); b <= Math.floor((runs.end[r] - 1) / bin) && b < binned.nx; b++) out[base + b] = runs.id[r];
      }
    }
    return out;
  }

  function downsampleMask(mask, { nx, ny, nz }, f) {
    const dims = { nx: Math.floor(nx / f), ny: Math.floor(ny / f), nz: Math.floor(nz / f) };
    const out = new Uint8Array(dims.nx * dims.ny * dims.nz);
    const half = f ** 3 / 2;
    for (let z = 0, o = 0; z < dims.nz; z++) {
      for (let y = 0; y < dims.ny; y++) {
        for (let x = 0; x < dims.nx; x++, o++) {
          let c = 0;
          for (let k = 0; k < f; k++) for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) c += mask[((z * f + k) * ny + y * f + j) * nx + x * f + i];
          out[o] = c >= half ? 1 : 0;
        }
      }
    }
    return { mask: out, dims };
  }

  /** Naive surface nets on a binary mask. Positions are in continuous voxel coordinates (voxel i covers [i, i + 1)).
      Work follows the set voxels rather than the grid, so a sparse void mask stays quick. */
  function surfaceNets(mask, { nx, ny, nz }) {
    const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 0 : mask[(z * ny + y) * nx + x]);
    const cx = nx + 1, cy = ny + 1;
    const vertex = new Int32Array(cx * cy * (nz + 1)).fill(-1);
    const cell = (x, y, z) => (z * cy + y) * cx + x;
    let positions = new Float32Array(3 << 12), used = 0;
    let indices = new Uint32Array(6 << 12), written = 0;
    const vertexAt = (x, y, z) => {
      const key = cell(x, y, z);
      if (vertex[key] >= 0) return vertex[key];
      let sx = 0, sy = 0, sz = 0, c = 0;
      for (let k = 0; k < 8; k++) {
        const a = at(x - 1 + (k & 1), y - 1 + ((k >> 1) & 1), z - 1 + ((k >> 2) & 1));
        for (const bit of [1, 2, 4]) {
          if (k & bit) continue;
          const j = k | bit;
          if (a === at(x - 1 + (j & 1), y - 1 + ((j >> 1) & 1), z - 1 + ((j >> 2) & 1))) continue;
          sx += ((k & 1) + (j & 1)) / 2; sy += (((k >> 1) & 1) + ((j >> 1) & 1)) / 2; sz += (((k >> 2) & 1) + ((j >> 2) & 1)) / 2;
          c++;
        }
      }
      if (used + 3 > positions.length) { const bigger = new Float32Array(positions.length * 2); bigger.set(positions); positions = bigger; }
      positions[used++] = x - 0.5 + sx / c; positions[used++] = y - 0.5 + sy / c; positions[used++] = z - 0.5 + sz / c;
      vertex[key] = used / 3 - 1;
      return vertex[key];
    };
    const quad = (a, b, c, d, flip) => {
      if (written + 6 > indices.length) { const bigger = new Uint32Array(indices.length * 2); bigger.set(indices); indices = bigger; }
      const list = flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
      for (const v of list) indices[written++] = v;
    };
    const faceX = (x, y, z, flip) => quad(vertexAt(x, y, z), vertexAt(x, y + 1, z), vertexAt(x, y + 1, z + 1), vertexAt(x, y, z + 1), flip);
    const faceY = (x, y, z, flip) => quad(vertexAt(x, y, z), vertexAt(x, y, z + 1), vertexAt(x + 1, y, z + 1), vertexAt(x + 1, y, z), flip);
    const faceZ = (x, y, z, flip) => quad(vertexAt(x, y, z), vertexAt(x + 1, y, z), vertexAt(x + 1, y + 1, z), vertexAt(x, y + 1, z), flip);
    for (let z = 0, i = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++, i++) {
          if (!mask[i]) continue;
          if (!at(x - 1, y, z)) faceX(x, y, z, false);
          if (!at(x + 1, y, z)) faceX(x + 1, y, z, true);
          if (!at(x, y - 1, z)) faceY(x, y, z, false);
          if (!at(x, y + 1, z)) faceY(x, y + 1, z, true);
          if (!at(x, y, z - 1)) faceZ(x, y, z, false);
          if (!at(x, y, z + 1)) faceZ(x, y, z + 1, true);
        }
      }
    }
    return { positions: positions.slice(0, used), indices: indices.slice(0, written) };
  }

  return { DEFAULT_SETTINGS, savedSettings, binnedToFull, fullToBinned, binVolume, gaussian, createSliceSmoother, label, boxDilate, boxErode, ballDilate, ballErode, closeMask, fillHoles, rasterPolygon, cropMask, planeCropKeep, buildBody,
    elongation, detectPores, fineDetect, poreIdAt, planePoreIds, firstVoxelOf, runsToBinned, summarize, rejectedAfterRerun, downsampleMask, surfaceNets };
}));
