'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/vb_deviation.js');
const St = require('../app/vb_stl.js');

// A 40^3 scan at 0.1 mm, binned by 2 (20^3 analysis grid): a box of matrix (2000) in air (700) whose faces sit at
// full-grid 9.5 and 30.5, i.e. 0.95 and 3.05 mm, with a one-analysis-voxel ramp across each face.
const bin = 2, voxelMm = 0.1, dims = { nx: 20, ny: 20, nz: 20 }, AIR = 700, MATRIX = 2000;
const center = (b) => b * bin + (bin - 1) / 2; // binned index to full-grid coordinate
function boxGray(lo = 9.5, hi = 30.5) {
  const g = new Float32Array(dims.nx * dims.ny * dims.nz);
  for (let z = 0, i = 0; z < dims.nz; z++) for (let y = 0; y < dims.ny; y++) for (let x = 0; x < dims.nx; x++, i++) {
    const d = Math.min(...[x, y, z].map((b) => Math.min(center(b) - lo, hi - center(b)))) / bin; // analysis voxels, + inside
    g[i] = AIR + (MATRIX - AIR) * Math.min(1, Math.max(0, 0.5 + d));
  }
  return g;
}

function boxMesh(lo, hi) {
  const v = (i) => [i & 1 ? hi : lo, i & 2 ? hi : lo, i & 4 ? hi : lo];
  const out = [];
  for (const [a, b, c, d] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) out.push(...v(a), ...v(b), ...v(c), ...v(a), ...v(c), ...v(d));
  return St.parseStl(St.writeStl(Float32Array.from(out)));
}

const identity = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1 };
const level = D.isoLevel(AIR, MATRIX);

test('surface points sit on the iso surface, between voxel centers', () => {
  const pts = D.surfacePoints({ gray: boxGray(), dims, bin, voxelMm, level });
  assert.ok(pts.length / 3 > 500, `${pts.length / 3}`);
  for (let i = 0; i < pts.length; i += 3) {
    const off = Math.min(...[0, 1, 2].map((k) => Math.min(Math.abs(pts[i + k] - 0.95), Math.abs(pts[i + k] - 3.05))));
    assert.ok(off < 0.02, `point ${pts.slice(i, i + 3)} is ${off} mm off a face`);
  }
});

test('a scan larger than the nominal reads positive, smaller reads negative, by the face offset', () => {
  const gray = boxGray();
  for (const [lo, hi, expected] of [[1.25, 2.75, 0.3], [0.65, 3.35, -0.3]]) {
    const m = St.measurePoints(boxMesh(lo, hi), { spacing: 0.25 });
    const dev = D.deviations({ gray, dims, bin, voxelMm, level, points: m.points, normals: m.normals, transform: identity, rangeMm: 1 });
    // A point's normal line meets the scanned box when its two in-plane coordinates lie over the scanned face; within
    // one analysis voxel (0.2 mm) of a box edge the interpolated iso surface is rounded, so those points are not checked.
    const over = (k) => [0, 1, 2].filter((a) => Math.abs(m.normals[3 * k + a]) < 0.5).every((a) => m.points[3 * k + a] > 1.15 && m.points[3 * k + a] < 2.85);
    const beside = (k) => [0, 1, 2].filter((a) => Math.abs(m.normals[3 * k + a]) < 0.5).some((a) => m.points[3 * k + a] < 0.75 || m.points[3 * k + a] > 3.25);
    for (let k = 0; k < dev.length; k++) {
      if (over(k)) assert.ok(Math.abs(dev[k] - expected) < 0.05, `${lo}..${hi} point ${k}: ${dev[k]}`);
      if (beside(k)) assert.ok(Number.isNaN(dev[k]), `${lo}..${hi} point ${k} misses the scan but reads ${dev[k]}`);
    }
    if (expected > 0) assert.equal(D.deviationStats(dev, 0.1).unmeasured, 0);
  }
});

test('a point whose search segment lies outside the volume is not measured, never zero', () => {
  const points = Float32Array.from([-2, 2, 2, 2, 2, 2.75]), normals = Float32Array.from([-1, 0, 0, 0, 0, 1]);
  const dev = D.deviations({ gray: boxGray(), dims, bin, voxelMm, level, points, normals, transform: identity, rangeMm: 1 });
  assert.ok(Number.isNaN(dev[0]));
  assert.ok(Math.abs(dev[1] - 0.3) < 0.05, `${dev[1]}`);
  const s = D.deviationStats(dev, 0.1);
  assert.equal(s.measured, 1); assert.equal(s.unmeasured, 1);
});

test('the transform carries the nominal into the scan frame', () => {
  const m = St.measurePoints(boxMesh(0, 1.5), { spacing: 0.25 }); // nominal 0.3 mm smaller, shifted by 1.25 mm
  const dev = D.deviations({ gray: boxGray(), dims, bin, voxelMm, level, points: m.points, normals: m.normals, transform: { ...identity, t: [1.25, 1.25, 1.25] }, rangeMm: 1 });
  const s = D.deviationStats(dev, 0.1);
  assert.ok(Math.abs(s.p50 - 0.3) < 0.05, `${s.p50}`);
});

test('statistics and histogram on a fixed array', () => {
  const dev = Float32Array.from([-0.2, -0.1, 0, 0.05, 0.1, 0.3, NaN]);
  const s = D.deviationStats(dev, 0.1);
  assert.equal(s.measured, 6); assert.equal(s.unmeasured, 1);
  assert.ok(Math.abs(s.mean - 0.025) < 1e-6);
  assert.ok(Math.abs(s.p50 - 0.025) < 1e-6);
  assert.ok(Math.abs(s.within_percent - 100 * 4 / 6) < 1e-6);
  assert.ok(Math.abs(s.min + 0.2) < 1e-6 && Math.abs(s.max - 0.3) < 1e-6);
  const h = D.histogram(dev, { bins: 4, range: [-0.2, 0.2] });
  assert.equal(h.edges.length, 5);
  assert.deepEqual(h.counts, [1, 1, 2, 1]);
  assert.equal(h.above, 1); assert.equal(h.below, 0);
});

test('matrix gray is the median above the pore threshold inside the mask', () => {
  const gray = Float32Array.from([100, 1000, 2000, 2100, 2200, 5000]), filled = Uint8Array.from([1, 1, 1, 1, 1, 0]);
  assert.equal(D.matrixGray(gray, filled, 1300), 2100);
});
