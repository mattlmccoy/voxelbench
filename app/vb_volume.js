/* Large scans: pick a binning factor that fits the memory budget, and block-mean slices into it as they are read,
   so the full-resolution stack is never held at once. The rest of the page treats a binned volume as a scan with
   larger voxels. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBVolume = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Bytes for the stored 16-bit volume. Safari's per-page memory ceiling is lower than Chromium's.
  const MEMORY_BUDGET = { default: 1.2e9, safari: 0.6e9 };
  const MAX_FACTOR = 4;

  /** Budget in bytes: ?budget=<GB> in the page address overrides; Safari gets the lower default. */
  function budgetBytes(userAgent, search) {
    const asked = Number(new URLSearchParams(search || '').get('budget'));
    if (asked > 0) return asked * 1e9;
    const safari = /Safari\//.test(userAgent || '') && !/Chrome\/|Chromium\//.test(userAgent || '');
    return safari ? MEMORY_BUDGET.safari : MEMORY_BUDGET.default;
  }

  /** Smallest factor f (1 to 4) whose binned 16-bit volume fits the budget. */
  function planBinning({ width, height, depth }, budget) {
    for (let f = 1; f <= MAX_FACTOR; f++) {
      if (Math.floor(width / f) * Math.floor(height / f) * Math.floor(depth / f) * 2 <= budget) return f;
    }
    throw new Error('Too large even at 4× binning');
  }

  /** Block mean over f x f x f of f consecutive slices; trailing rows and columns that do not fill a block are dropped,
      as in ct_pipeline's _block_mean. Rounded to the nearest gray value. */
  function binGroup(slices, width, height, f) {
    const bw = Math.floor(width / f), bh = Math.floor(height / f);
    const sum = new Float64Array(bw * bh);
    for (const s of slices) {
      for (let y = 0; y < bh * f; y++) {
        const row = y * width, out = Math.floor(y / f) * bw;
        for (let x = 0; x < bw * f; x++) sum[out + Math.floor(x / f)] += s[row + x];
      }
    }
    const n = f * f * slices.length;
    return Uint16Array.from(sum, (v) => Math.round(v / n));
  }

  /** Every slice must match the first in size and voxel size; a stray file (a preview, a thumbnail) stops the load.
      Both files are named, since the stray one may be the first. */
  function checkSlice(first, t, name, firstName) {
    if (t.width === first.width && t.height === first.height && t.voxelMm === first.voxelMm) return;
    const size = (s) => `${s.width} × ${s.height} px at ${s.voxelMm.toFixed(4)} mm`;
    throw new Error(`${name} is ${size(t)}, but the first file, ${firstName}, is ${size(first)}. Remove the file that is not a slice.`);
  }

  return { MEMORY_BUDGET, budgetBytes, planBinning, binGroup, checkSlice };
}));
