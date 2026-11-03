'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../app/vb_align.js');

function random(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Rotation matrix (row-major) about a unit axis. */
function rotation([x, y, z], angle) {
  const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
}
const unit = (v) => { const n = Math.hypot(...v); return v.map((a) => a / n); };

/** Points on the surface of an L-shaped solid (10 x 6 x 3 with a 4 x 3 notch), so it has no symmetry. */
function lShape(count, rnd) {
  const inside = (x, y, z) => x >= 0 && x <= 10 && y >= 0 && y <= 6 && z >= 0 && z <= 3 && !(x > 4 && y > 3);
  const pts = [];
  while (pts.length < 3 * count) {
    const x = rnd() * 10, y = rnd() * 6, z = rnd() * 3;
    const faces = [[0, y, z], [10, y, z], [x, 0, z], [x, 6, z], [x, y, 0], [x, y, 3], [4, y, z], [x, 3, z]];
    const p = faces[Math.floor(rnd() * faces.length)];
    const e = 1e-6;
    if (inside(...p) && !(inside(p[0] + e, p[1] + e, p[2] + e) && inside(p[0] - e, p[1] - e, p[2] - e) && inside(p[0] + e, p[1] - e, p[2] + e) && inside(p[0] - e, p[1] + e, p[2] - e))) pts.push(...p);
  }
  return Float64Array.from(pts);
}

function cubeSurface(count, rnd, side = 10) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const f = Math.floor(rnd() * 6), a = rnd() * side, b = rnd() * side, c = f & 1 ? side : 0;
    pts.push(...(f < 2 ? [c, a, b] : f < 4 ? [a, c, b] : [a, b, c]));
  }
  return Float64Array.from(pts);
}

const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

test('fitTransform recovers a known rotation, translation and scale from paired points', () => {
  const rnd = random(1);
  const src = Float64Array.from({ length: 300 }, () => rnd() * 20 - 10);
  const truth = { R: rotation(unit([1, 2, -0.5]), 1.1), t: [3, -4, 7], s: 0.97 };
  const dst = A.apply(truth, src);
  const fit = A.fitTransform(src, dst, { scale: true });
  assert.ok(maxDiff(fit.R, truth.R) < 1e-6, `R off by ${maxDiff(fit.R, truth.R)}`);
  assert.ok(maxDiff(fit.t, truth.t) < 1e-5);
  assert.ok(Math.abs(fit.s - 0.97) < 1e-7);
  assert.equal(A.fitTransform(src, dst, { scale: false }).s, 1);
});

test('ICP recovers an L shape from a 25° turn; pre-alignment recovers it from a 160° turn', () => {
  const rnd = random(2);
  const src = lShape(3000, rnd), dstBase = lShape(3000, rnd);
  for (const [angle, method] of [[25, 'icp'], [160, 'preAlign']]) {
    const truth = { R: rotation(unit([0.3, 1, 0.2]), (angle * Math.PI) / 180), t: [5, 1, -2], s: 1 };
    const dst = A.apply(truth, dstBase);
    const fit = method === 'icp' ? A.icp(src, dst, {}) : A.preAlign(src, dst, {});
    assert.ok(maxDiff(fit.R, truth.R) < 0.02, `${method} ${angle}°: R off by ${maxDiff(fit.R, truth.R)}`);
    assert.ok(maxDiff(fit.t, truth.t) < 0.1, `${method} ${angle}°: t ${fit.t}`);
    assert.ok(fit.rms < 0.2, `rms ${fit.rms}`);
  }
});

test('trimmed ICP ignores 5 % of points moved 3 mm off a cube, and recovers a 0.97 scale', () => {
  const rnd = random(3);
  const src = cubeSurface(4000, rnd);
  const dst = cubeSurface(4000, rnd);
  for (let i = 0; i < 200; i++) dst[3 * i] += 3;
  const truth = { R: rotation(unit([1, 0, 1]), 0.15), t: [1, 2, 3], s: 1 };
  const fit = A.icp(src, A.apply(truth, dst), {});
  assert.ok(maxDiff(fit.R, truth.R) < 0.01, `R off by ${maxDiff(fit.R, truth.R)}`);
  const scaled = { ...truth, s: 0.97 };
  const s = A.icp(src, A.apply(scaled, dst), { scale: true });
  assert.ok(Math.abs(s.s - 0.97) < 1e-3, `s ${s.s}`);
  assert.equal(A.icp(src, A.apply(scaled, dst), { scale: false }).s, 1);
});

test('a cube pre-aligns to an equivalent pose even though its principal axes are arbitrary', () => {
  const rnd = random(4);
  const src = cubeSurface(3000, rnd), raw = cubeSurface(3000, rnd);
  const floor = A.icp(src, raw, { iterations: 1 }).rms; // two independent samplings at the true pose
  const fit = A.preAlign(src, A.apply({ R: rotation(unit([0.2, 0.9, 0.4]), 2.4), t: [-3, 8, 1], s: 1 }, raw), {});
  assert.ok(fit.rms < 1.05 * floor, `rms ${fit.rms} vs floor ${floor}`);
});

test('rotate90 turns a pose a quarter turn about an axis through a point, and compose chains transforms', () => {
  const T = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1 };
  const r = A.rotate90(T, 'z', [1, 1, 0]);
  assert.ok(maxDiff(A.apply(r, Float64Array.from([2, 1, 0])), [1, 2, 0]) < 1e-12);
  const a = { R: rotation([0, 0, 1], 0.3), t: [1, 0, 0], s: 2 }, b = { R: rotation([1, 0, 0], 0.7), t: [0, 3, 0], s: 0.5 };
  const p = Float64Array.from([1, 2, 3]);
  assert.ok(maxDiff(A.apply(A.compose(a, b), p), A.apply(a, A.apply(b, p))) < 1e-12);
});

test('scaled ICP from a wrong pose does not collapse the model: scale stays within 0.5 to 1.5', () => {
  const rnd = random(5);
  const src = lShape(2000, rnd), dst = lShape(2000, rnd);
  const wrong = { R: rotation([1, 0, 0], Math.PI / 2), t: [0, 0, 0], s: 1 };
  const fit = A.icp(src, dst, { init: wrong, scale: true });
  assert.ok(fit.s >= 0.5 && fit.s <= 1.5, `s ${fit.s}`);
  const right = A.icp(src, A.apply({ R: rotation([0, 0, 1], 0.1), t: [0.5, 0, 0], s: 0.8 }, dst), { scale: true });
  assert.ok(Math.abs(right.s - 0.8) < 0.01, `s ${right.s}`);
});
