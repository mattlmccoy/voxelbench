/* Rainbow slice view: the turbo color map, display-only smoothing, a window from the air and matrix peaks, and
   outlines for overlays that would otherwise hide the colors. Nothing here changes the data or any measurement. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CTDisplay = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // matplotlib's turbo, 256 entries as RGB hex.
  const TURBO_HEX = '30123b32154333184a341b51351e5836215f37246638276d392a733a2d793b2f803c32863d358b3e38913f3b973f3e9c4040a24143a74146ac4249b1424bb5434eba4451bf4454c34456c74559cb455ccf455ed34661d64664da4666dd4669e0466be3476ee64771e94773eb4776ee4778f0477bf2467df44680f64682f84685fa4687fb458afc458cfd448ffe4391fe4294ff4196ff4099ff3e9bfe3d9efe3ba0fd3aa3fc38a5fb37a8fa35abf833adf731aff52fb2f42eb4f22cb7f02ab9ee28bceb27bee925c0e723c3e422c5e220c7df1fc9dd1ecbda1ccdd81bd0d51ad2d21ad4d019d5cd18d7ca18d9c818dbc518ddc218dec018e0bd19e2bb19e3b91ae4b61ce6b41de7b21fe9af20eaac22ebaa25eca727eea42aefa12cf09e2ff19b32f29835f39438f4913cf58e3ff68a43f78746f8844af8804ef97d52fa7a55fa7659fb735dfc6f61fc6c65fd6969fd666dfe6271fe5f75fe5c79fe597dff5680ff5384ff5188ff4e8bff4b8fff4992ff4796fe4499fe429cfe409ffd3fa1fd3da4fc3ca7fc3aa9fb39acfb38affa37b1f936b4f836b7f735b9f635bcf534bef434c1f334c3f134c6f034c8ef34cbed34cdec34d0ea34d2e935d4e735d7e535d9e436dbe236dde037dfdf37e1dd37e3db38e5d938e7d739e9d539ebd339ecd13aeecf3aefcd3af1cb3af2c93af4c73af5c53af6c33af7c13af8be39f9bc39faba39fbb838fbb637fcb336fcb136fdae35fdac34fea933fea732fea431fea130fe9e2ffe9b2dfe992cfe962bfe932afe9029fd8d27fd8a26fc8725fc8423fb8122fb7e21fa7b1ff9781ef9751df8721cf76f1af66c19f56918f46617f36315f26014f15d13f05b12ef5811ed5510ec530feb500eea4e0de84b0ce7490ce5470be4450ae2430ae14109df3f08dd3d08dc3b07da3907d83706d63506d43305d23105d02f05ce2d04cc2b04ca2a04c82803c52603c32503c12302be2102bc2002b91e02b71d02b41b01b21a01af1801ac1701a91601a71401a41301a112019e10019b0f01980e01950d01920b018e0a018b09028808028507028106027e05027a0403';
  const TURBO = Uint8Array.from(TURBO_HEX.match(/../g), (h) => parseInt(h, 16));
  const SMOOTH_SIGMA = 1.5;
  const BIN = 30, PEAK_GAP = 300;

  /** RGB of turbo at t in [0, 1]. */
  function turbo(t) {
    const i = 3 * Math.round(255 * Math.max(0, Math.min(1, t)));
    return [TURBO[i], TURBO[i + 1], TURBO[i + 2]];
  }

  /** Gray to turbo over [low, high]; gray below low (air) is black. */
  function rainbowToRgba(values, low, high, out) {
    const k = 255 / Math.max(1, high - low);
    for (let i = 0, j = 0; i < values.length; i++, j += 4) {
      const v = values[i];
      if (v < low) { out[j] = 0; out[j + 1] = 0; out[j + 2] = 0; } else {
        const c = 3 * Math.min(255, Math.round((v - low) * k));
        out[j] = TURBO[c]; out[j + 1] = TURBO[c + 1]; out[j + 2] = TURBO[c + 2];
      }
      out[j + 3] = 255;
    }
  }

  /** Separable Gaussian over one plane, as scipy.ndimage.gaussian_filter (reflect edges, truncate 4). */
  function smoothPlane(values, w, h, sigma = SMOOTH_SIGMA) {
    const r = Math.floor(4 * sigma + 0.5);
    const kern = new Float64Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += kern[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    for (let i = 0; i < kern.length; i++) kern[i] /= sum;
    const reflect = (i, n) => { while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1; return i; };
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += kern[i + r] * values[y * w + reflect(x + i, w)];
        tmp[y * w + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += kern[i + r] * tmp[reflect(y + i, h) * w + x];
        out[y * w + x] = s;
      }
    }
    return out;
  }

  /** Window from the histogram's two tallest peaks: air the lower gray, matrix the higher (air can be the taller one).
      Black starts 0.28 of the air-to-matrix gap above air; red ends 0.39 of the gap above matrix (approved on Sample 2). */
  function rainbowWindow(slices, { nx, ny, nz }, step) {
    const counts = new Float64Array(Math.ceil(65536 / BIN));
    for (let z = 0; z < nz; z += step) {
      for (let y = 0; y < ny; y += step) {
        for (let x = 0; x < nx; x += step) {
          const v = slices[z][y * nx + x];
          if (v) counts[Math.floor(v / BIN)]++;
        }
      }
    }
    // Box-smooth over 5 bins so noise does not make extra peaks; then the two tallest peaks PEAK_GAP apart.
    const s = counts.map((_, i) => counts.slice(Math.max(0, i - 2), i + 3).reduce((p, q) => p + q, 0));
    const peaks = [];
    for (let i = 0; i < s.length; i++) if (s[i] > 0 && (i === 0 || s[i] >= s[i - 1]) && (i === s.length - 1 || s[i] > s[i + 1])) peaks.push(i);
    peaks.sort((p, q) => s[q] - s[p]);
    const first = peaks[0] || 0, second = peaks.find((p) => Math.abs(p - first) * BIN >= PEAK_GAP);
    const center = (i) => (i + 0.5) * BIN;
    const matrix = center(second === undefined ? first : Math.max(first, second));
    const air = second === undefined ? 0 : center(Math.min(first, second));
    return { low: Math.round(air + 0.28 * (matrix - air)), high: Math.round(matrix + 0.39 * (matrix - air)), air, matrix };
  }

  /** Labeled pixels within r pixels (square neighborhood) of a pixel with a different label; label 0 is never outlined. */
  function outlineMask(labels, w, h, r) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = labels[y * w + x];
        if (!l) continue;
        search: for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || yy >= h || xx < 0 || xx >= w || labels[yy * w + xx] !== l) { out[y * w + x] = 1; break search; }
          }
        }
      }
    }
    return out;
  }

  return { turbo, rainbowToRgba, smoothPlane, rainbowWindow, outlineMask, SMOOTH_SIGMA };
}));
