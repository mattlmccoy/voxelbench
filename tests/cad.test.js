'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CT = require('../app/ct_core.js');
const S = require('../app/vb_synthetic.js');
const St = require('../app/vb_stl.js');
const H = require('../tools/headless_run.js');
const D = require('../app/vb_deviation.js');

async function stackOf(files) {
  const tiffs = await Promise.all(files.map(async (f) => CT.parseTiff(await f.arrayBuffer())));
  return { slices: tiffs.map((t) => t.pixels), voxelMm: tiffs[0].voxelMm, dims: { nx: tiffs[0].width, ny: tiffs[0].height, nz: tiffs.length } };
}

test('the synthetic L part and its nominal STL: the nominal is closed with outward normals', () => {
  const mesh = St.parseStl(S.partStl());
  let volume = 0;
  for (let t = 0; t < mesh.triangles; t++) {
    const p = mesh.positions.subarray(9 * t, 9 * t + 9);
    volume += (p[0] * (p[4] * p[8] - p[5] * p[7]) - p[1] * (p[3] * p[8] - p[5] * p[6]) + p[2] * (p[3] * p[7] - p[4] * p[6])) / 6;
  }
  const v = 0.04; // mm per voxel: L of 100 x 40 plus 30 x 60 voxels in section, 40 voxels deep
  assert.ok(Math.abs(volume - (100 * 40 + 30 * 60) * 40 * v ** 3) < 1e-6, `volume ${volume}`);
});

test('an undistorted part aligns from its CAD pose and reads near-zero deviation', async () => {
  const { files } = S.makePart({});
  const a = H.analyze(await stackOf(files), { settings: { poreThreshold: 1350 } }, { patches: false });
  const r = H.compareCad(a, St.parseStl(S.partStl()), { spacingMm: 0.08, toleranceMm: 0.02 });
  const vox = a.voxelMm * 2;
  assert.ok(r.rms < 0.5 * vox, `rms ${r.rms}`);
  assert.ok(Math.abs(r.stats.p50) < 0.25 * vox, `median ${r.stats.p50}`);
  assert.ok(r.stats.unmeasured / (r.stats.measured + r.stats.unmeasured) < 0.05, `unmeasured ${r.stats.unmeasured}`);
  assert.equal(r.transform.s, 1);
});

test('a part shrunk to 97 % reads its scale from the fit, and at the true pose the bent upright reads its bend', async () => {
  const { files, truth } = S.makePart({ scale: 0.97, bendMm: 0.12 });
  const a = H.analyze(await stackOf(files), { settings: { poreThreshold: 1350 } }, { patches: false });
  const r = H.compareCad(a, St.parseStl(S.partStl()), { spacingMm: 0.08, toleranceMm: 0.02, scale: true });
  assert.ok(Math.abs(r.transform.s - truth.scale) < 0.006, `s ${r.transform.s}`);
  // At the true pose the deviations are the distortion itself: the upright's outer face (CAD x = 0) leans outward by
  // bend x (w - 40) / 60 x scale, the base's bottom face (CAD y = 0) not at all. (A best fit shares the bend out over
  // the whole part, so the fitted map shows it only in part.)
  const dev = D.deviations({ gray: a.vol.gray, dims: a.vol.dims, bin: 2, voxelMm: a.voxelMm, level: D.isoLevel(700, 2000), points: r.points, normals: r.normals, transform: truth.pose, rangeMm: 1 });
  const pts = r.points, outer = [], bottom = [];
  for (let k = 0; k < dev.length; k++) {
    if (!Number.isFinite(dev[k])) continue;
    const y = pts[3 * k + 1], w = y / 0.04;
    if (Math.abs(pts[3 * k]) < 1e-6 && w > 50 && w < 95) outer.push(dev[k] - (truth.bend_mm * (w - 40) / 60) * truth.scale);
    if (Math.abs(y) < 1e-6 && pts[3 * k] > 0.4 && pts[3 * k] < 3.6) bottom.push(dev[k]);
  }
  const mean = (v) => v.reduce((s, d) => s + d, 0) / v.length;
  assert.ok(outer.length > 20 && Math.abs(mean(outer)) < 0.01, `upright outer face off its bend by ${mean(outer)}`);
  assert.ok(bottom.length > 20 && Math.abs(mean(bottom)) < 0.01, `base bottom ${mean(bottom)}`);
});
