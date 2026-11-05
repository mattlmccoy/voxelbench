'use strict';
// Re-orienting a scan taken at an angle: the part's axes from its sample mask, nudges in the part's frame, the leveled
// grid around the part, nearest-neighbor resampling, the preview plane, and the bookkeeping (frame ids, memory).
// The volumes are synthetic: a box of known size turned by a known rotation, so every expected value is exact.
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../app/vb_orient.js');

const deg = Math.PI / 180;
const rotX = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotZ = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const mul = (A, B) => { const C = new Array(9).fill(0); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) C[3 * r + c] += A[3 * r + k] * B[3 * k + c]; return C; };
const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
const row = (m, r) => [m[3 * r], m[3 * r + 1], m[3 * r + 2]];
const col = (m, c) => [m[c], m[3 + c], m[6 + c]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

// The box's axes in scan coordinates are the columns of T: long (size L) along col 0, middle (W) col 1, thin (H) col 2.
const T = mul(rotZ(35 * deg), mul(rotY(-15 * deg), rotX(20 * deg)));
const DIMS = { nx: 96, ny: 80, nz: 64 };
const C0 = [47.5, 39.5, 31.5];
function boxInside(p, [L, W, H] = [60, 30, 10]) {
  const d = [p[0] - C0[0], p[1] - C0[1], p[2] - C0[2]];
  const u = dot(col(T, 0), d), v = dot(col(T, 1), d), w = dot(col(T, 2), d);
  return Math.abs(u) <= L / 2 && Math.abs(v) <= W / 2 && Math.abs(w) <= H / 2;
}
function boxMask(size) {
  const { nx, ny, nz } = DIMS, m = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (boxInside([x, y, z], size)) m[(z * ny + y) * nx + x] = 1;
  return m;
}
function boxSlices() {
  const { nx, ny, nz } = DIMS, slices = [];
  for (let z = 0; z < nz; z++) {
    const s = new Uint16Array(nx * ny).fill(300);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (boxInside([x, y, z])) s[y * nx + x] = 1000;
    slices.push(s);
  }
  return slices;
}

test('level: the long axis goes to x, the thinnest to z, right-handed, about the part centroid', () => {
  const L = O.levelFromMask(boxMask(), DIMS, 1);
  close(det(L.R), 1, 1e-9, 'det');
  close(Math.abs(dot(row(L.R, 0), col(T, 0))), 1, 1 - Math.cos(1 * deg), 'long axis');
  close(Math.abs(dot(row(L.R, 2), col(T, 2))), 1, 1 - Math.cos(1 * deg), 'thin axis');
  for (let k = 0; k < 3; k++) close(L.center[k], C0[k], 0.5, `center ${k}`);
  assert.deepEqual(L.ambiguous, []);
});

test('level reads a binned mask in loaded-grid voxels', () => {
  // The same box on a 2x binned grid: a binned voxel b sits at loaded position 2b + 0.5.
  const { nx, ny, nz } = DIMS, b = { nx: nx / 2, ny: ny / 2, nz: nz / 2 }, m = new Uint8Array(b.nx * b.ny * b.nz);
  for (let z = 0; z < b.nz; z++) for (let y = 0; y < b.ny; y++) for (let x = 0; x < b.nx; x++) if (boxInside([2 * x + 0.5, 2 * y + 0.5, 2 * z + 0.5])) m[(z * b.ny + y) * b.nx + x] = 1;
  const L = O.levelFromMask(m, b, 2);
  for (let k = 0; k < 3; k++) close(L.center[k], C0[k], 1, `center ${k}`);
  close(Math.abs(dot(row(L.R, 0), col(T, 0))), 1, 1 - Math.cos(2 * deg), 'long axis');
});

test('a cube has no preferred axes: level says which are uncertain', () => {
  assert.deepEqual(O.levelFromMask(boxMask([30, 30, 30]), DIMS, 1).ambiguous.sort(), ['x', 'y', 'z']);
  assert.deepEqual(O.levelFromMask(boxMask([60, 30, 29]), DIMS, 1).ambiguous.sort(), ['y', 'z']);
});

test('nudges turn in the part frame and keep a proper rotation; flip and turn are 180 and 90 degrees', () => {
  const R = O.levelFromMask(boxMask(), DIMS, 1).R;
  assert.deepEqual(O.nudge(R, { rx: 0, ry: 0, rz: 0 }), R);
  const n = O.nudge(R, { rx: 3, ry: -7, rz: 12 });
  close(det(n), 1, 1e-9, 'det after nudge');
  // A turn about the part's own z keeps its z axis.
  const t = O.nudge(R, { rx: 0, ry: 0, rz: 30 });
  for (let k = 0; k < 3; k++) close(row(t, 2)[k], row(R, 2)[k], 1e-12, 'z kept');
  close(dot(row(t, 0), row(R, 0)), Math.cos(30 * deg), 1e-12, 'x turned 30');
  const f = O.flip(R);
  for (let k = 0; k < 3; k++) { close(row(f, 0)[k], row(R, 0)[k], 1e-12, 'flip keeps x'); close(row(f, 2)[k], -row(R, 2)[k], 1e-12, 'flip reverses z'); }
  close(det(f), 1, 1e-12, 'det after flip');
  const q = O.turn(R);
  for (let k = 0; k < 3; k++) close(row(q, 0)[k], row(R, 1)[k], 1e-12, 'turn: new x is old y');
});

test('the leveled grid is the part plus the margin on every side', () => {
  const L = O.levelFromMask(boxMask(), DIMS, 1);
  const g = O.gridFor({ R: L.R, center: L.center }, boxMask(), DIMS, 1, 5);
  close(g.dims.nx, 60 + 10, 3, 'nx'); close(g.dims.ny, 30 + 10, 3, 'ny'); close(g.dims.nz, 10 + 10, 3, 'nz');
});

test('scan axes resample to an exact copy, with measured zeros raised to 1', () => {
  const slices = boxSlices();
  slices[5][7] = 0;
  const id = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], center: [0, 0, 0], origin: [0, 0, 0], dims: { ...DIMS } };
  const out = O.resample({ slices, dims: DIMS, circle: null, orient: id });
  assert.equal(out.length, DIMS.nz);
  assert.equal(out[5][7], 1);
  out[5][7] = 0;
  for (let z = 0; z < DIMS.nz; z++) assert.deepEqual(out[z], slices[z]);
});

test('a tilted box comes out axis-aligned with its volume kept; outside the scan reads 0', () => {
  const mask = boxMask(), L = O.levelFromMask(mask, DIMS, 1);
  const orient = { R: L.R, center: L.center, ...O.gridFor({ R: L.R, center: L.center }, mask, DIMS, 1, 5) };
  const out = O.resample({ slices: boxSlices(), dims: DIMS, circle: null, orient });
  const { nx, ny, nz } = orient.dims;
  let solid = 0, zeros = 0; const span = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const v = out[z][y * nx + x];
    if (v === 0) zeros++;
    if (v !== 1000) continue;
    solid++;
    for (const [k, c] of [[0, x], [1, y], [2, z]]) { span[k][0] = Math.min(span[k][0], c); span[k][1] = Math.max(span[k][1], c); }
  }
  close(solid / (60 * 30 * 10), 1, 0.04, 'box volume');
  close(span[0][1] - span[0][0] + 1, 60, 2, 'length along x'); close(span[1][1] - span[1][0] + 1, 30, 2, 'width along y'); close(span[2][1] - span[2][0] + 1, 10, 2, 'thickness along z');
  assert.equal(zeros, 0); // this box sits well inside the scan
  // Shifting the grid half outside the scan: those voxels are written 0.
  const shifted = O.resample({ slices: boxSlices(), dims: DIMS, circle: null, orient: { ...orient, origin: [orient.origin[0] + 200, orient.origin[1], orient.origin[2]] } });
  assert.ok(shifted.every((s) => s.every((v) => v === 0)));
});

test('outside the reconstruction circle reads 0', () => {
  const id = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], center: [0, 0, 0], origin: [0, 0, 0], dims: { ...DIMS } };
  const circle = { cx: 48, cy: 40, r: 20 };
  const out = O.resample({ slices: boxSlices(), dims: DIMS, circle, orient: id });
  assert.equal(out[10][40 * DIMS.nx + 48], 300); // the center
  assert.equal(out[10][0], 0); // a corner
});

test('the preview plane is the same plane of the full resample', () => {
  const mask = boxMask(), L = O.levelFromMask(mask, DIMS, 1);
  const orient = { R: O.nudge(L.R, { rx: 4, ry: 0, rz: -9 }), center: L.center, ...O.gridFor({ R: L.R, center: L.center }, mask, DIMS, 1, 5) };
  const out = O.resample({ slices: boxSlices(), dims: DIMS, circle: null, orient });
  const { nx, ny, nz } = orient.dims;
  const xy = O.samplePlane({ slices: boxSlices(), dims: DIMS, circle: null, orient, plane: 'XY', index: 7 });
  assert.deepEqual([...xy.pixels], [...out[7]]);
  assert.equal(xy.width, nx); assert.equal(xy.height, ny);
  const xz = O.samplePlane({ slices: boxSlices(), dims: DIMS, circle: null, orient, plane: 'XZ', index: 11 });
  assert.equal(xz.width, nx); assert.equal(xz.height, nz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) assert.equal(xz.pixels[z * nx + x], out[z][11 * nx + x]);
  const yz = O.samplePlane({ slices: boxSlices(), dims: DIMS, circle: null, orient, plane: 'YZ', index: 20 });
  assert.equal(yz.width, ny); assert.equal(yz.height, nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) assert.equal(yz.pixels[z * ny + y], out[z][y * nx + 20]);
});

test('an orientation is stored in native voxels and placed on any loaded grid', () => {
  const saved = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], center: [100.5, 50.5, 20.5], origin: [-40, -20, -8], dims: { nx: 80, ny: 40, nz: 16 } };
  const at2 = O.onGrid(saved, 2);
  assert.deepEqual(at2.center, [50, 25, 10]); // native 2k + 0.5 is loaded k
  assert.deepEqual(at2.origin, [-20, -10, -4]);
  assert.deepEqual(at2.dims, { nx: 40, ny: 20, nz: 8 });
  assert.deepEqual(O.toNative(at2, 2).center, saved.center);
  assert.deepEqual(O.onGrid(saved, 1), saved);
});

test('frame ids: stable for one orientation, different for another; records follow their frame', () => {
  const a = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], center: [1, 2, 3], origin: [0, 0, 0], dims: { nx: 4, ny: 4, nz: 4 } };
  assert.equal(O.orientId(a), O.orientId({ ...a }));
  assert.notEqual(O.orientId(a), O.orientId({ ...a, R: O.turn(a.R) }));
  assert.equal(O.orientId(null), null);
  assert.equal(O.sameFrame({}, null), true); // records from before this feature belong to scan axes
  assert.equal(O.sameFrame({ orientation: 'abc' }, null), false);
  assert.equal(O.sameFrame({ orientation: 'abc' }, 'abc'), true);
  assert.equal(O.sameFrame({}, 'abc'), false);
});

test('memory: the scan and its leveled copy must both fit; reopening bins until they do', () => {
  const bytes = (d) => 2 * d.nx * d.ny * d.nz;
  const scan = { width: 1392, height: 784, depth: 503 }, out = { nx: 1500, ny: 800, nz: 300 };
  assert.equal(O.fits({ loaded: { nx: 1392, ny: 784, nz: 503 }, out, limit: 2e9 }), bytes({ nx: 1392, ny: 784, nz: 503 }) + bytes(out) <= 2e9);
  assert.equal(O.planOrientedBinning(scan, out, 1.5e9), 2); // 1.10 + 0.72 GB = 1.82 GB: fits only at 2x
  assert.equal(O.planOrientedBinning(scan, out, 3e9), 1);
  assert.throws(() => O.planOrientedBinning(scan, out, 1e6), /Too large/);
});

test('the grid from the surface voxels alone equals the grid from the whole mask (sliders use the surface)', () => {
  const mask = boxMask(), L = O.levelFromMask(mask, DIMS, 1);
  const R = O.nudge(L.R, { rx: 5, ry: -3, rz: 10 });
  const pts = O.surfacePoints(mask, DIMS, 1);
  assert.ok(pts.length / 3 < 60 * 30 * 10 * 0.6, 'fewer points than voxels');
  assert.deepEqual(O.gridForPoints({ R, center: L.center }, pts, 1, 5), O.gridFor({ R, center: L.center }, mask, DIMS, 1, 5));
});

test('the paced resample (pausing between slices) gives the same leveled scan and reports progress', async () => {
  const mask = boxMask(), L = O.levelFromMask(mask, DIMS, 1);
  const orient = { R: L.R, center: L.center, ...O.gridFor({ R: L.R, center: L.center }, mask, DIMS, 1, 5) };
  const done = [];
  const paced = await O.resamplePaced({ slices: boxSlices(), dims: DIMS, circle: null, orient, pause: () => Promise.resolve(), every: 3, onProgress: (k, n) => done.push([k, n]) });
  const whole = O.resample({ slices: boxSlices(), dims: DIMS, circle: null, orient });
  assert.deepEqual(paced.map((s) => [...s]), whole.map((s) => [...s]));
  assert.deepEqual(done[done.length - 1], [orient.dims.nz, orient.dims.nz]);
});
