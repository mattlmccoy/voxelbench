'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../app/vb_figure.js');

// A 12 x 10 x 6 mm block at 0.1 mm: base material (relative density 1.0) around a doped core (1.14) holding a cluster
// of clumps (0.6), an enclosed bubble and a pore open to the top face.
function phantom() {
  const dims = { nx: 120, ny: 100, nz: 60 }, n = dims.nx * dims.ny * dims.nz, air = 500, K = 1500;
  const gray = new Float32Array(n).fill(air), env = new Uint8Array(n);
  const ball = (x, y, z, cx, cy, cz, r) => (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r * r;
  const clumps = [[40, 40, 30], [48, 44, 32], [44, 52, 28], [70, 60, 30], [76, 52, 31]];
  for (let z = 0, i = 0; z < dims.nz; z++) for (let y = 0; y < dims.ny; y++) for (let x = 0; x < dims.nx; x++, i++) {
    if (x < 10 || x >= 110 || y < 10 || y >= 90 || z < 5 || z >= 55) continue;
    env[i] = 1;
    let rho = x >= 30 && x < 90 && y >= 25 && y < 75 && z >= 15 && z < 45 ? 1.14 : 1.0;
    if (clumps.some(([cx, cy, cz]) => ball(x, y, z, cx, cy, cz, 3))) rho = 0.6;
    if (ball(x, y, z, 60, 35, 30, 4)) rho = 0;
    if (ball(x, y, z, 20, 20, 5, 4)) rho = 0; // cut by the top face: open
    gray[i] = air + K * rho;
  }
  return { dims, gray, env, air, K };
}

test('classify: doped core, base material around it, clumps in the core, enclosed gas kept and the open pore removed', () => {
  const p = phantom();
  const r = F.classify({ gray: p.gray, envelope: p.env, dims: p.dims, cellMm: 0.1, airGray: p.air, denseGray: p.air + p.K, options: { cupping: false } });
  const at = (x, y, z) => r.labels[(z * p.dims.ny + y) * p.dims.nx + x];
  assert.equal(at(60, 50, 40), F.CODE.DOPED_DENSE);
  assert.equal(at(15, 50, 30), F.CODE.BASE_DENSE);
  assert.equal(at(40, 40, 30), F.CODE.CLUMP);
  assert.equal(at(60, 35, 30), F.CODE.DOPED_PORE);
  const open = F.closePores(r.labels, p.dims);
  assert.ok(open > 0);
  assert.equal(at(60, 35, 30), F.CODE.DOPED_PORE, 'the enclosed bubble stays');
  const s = F.figureStats({ labels: r.labels, rho: r.rho, cellMm: 0.1, openVoxels: open });
  const bubble = (4 / 3) * Math.PI * 0.4 ** 3;
  assert.ok(Math.abs(s.volume_mm3.enclosed_gas_doped - bubble) / bubble < 0.35, `${s.volume_mm3.enclosed_gas_doped} vs ${bubble}`);
  assert.ok(s.dense_percent_of_doped > 90, `${s.dense_percent_of_doped}`);
  const coreMm3 = 6 * 5 * 3;
  assert.ok(Math.abs(s.doped_mm3 - coreMm3) / coreMm3 < 0.15, `doped ${s.doped_mm3} vs ${coreMm3}`);
});

test('classify finds the scale itself from the dense base material', () => {
  const p = phantom();
  const r = F.classify({ gray: p.gray, envelope: p.env, dims: p.dims, cellMm: 0.1, airGray: p.air, options: { cupping: false } });
  assert.ok(Math.abs(r.scale.K - p.K) / p.K < 0.03, `K ${r.scale.K}`);
});

test('closePores: a pore reached from a face through empty space is open; one sealed in solid is kept', () => {
  const dims = { nx: 10, ny: 10, nz: 10 }, L = new Uint8Array(1000).fill(F.CODE.BASE_DENSE);
  const i = (x, y, z) => (z * 10 + y) * 10 + x;
  L[i(5, 5, 5)] = F.CODE.BASE_PORE;
  L[i(0, 3, 3)] = F.CODE.BASE_PORE; L[i(1, 3, 3)] = F.CODE.BASE_PORE;
  assert.equal(F.closePores(L, dims), 2);
  assert.equal(L[i(5, 5, 5)], F.CODE.BASE_PORE);
  assert.equal(L[i(1, 3, 3)], F.CODE.EMPTY);
});

test('renders: a cube seen from above-front fills the opaque image and the cut removes the near quarter', () => {
  const dims = { nx: 40, ny: 40, nz: 20 }, L = new Uint8Array(40 * 40 * 20);
  for (let z = 4; z < 16; z++) for (let y = 8; y < 32; y++) for (let x = 8; x < 32; x++) L[(z * 40 + y) * 40 + x] = F.CODE.DOPED_DENSE;
  const R = F.rotate(L, dims, 35);
  const full = F.opaque(R.labels, R.dims), cut = F.opaque(F.cutQuarter(R.labels, R.dims).labels, R.dims);
  const count = (m) => m.reduce((a, b) => a + b, 0);
  assert.ok(count(full.mask) > 300);
  assert.ok(count(cut.mask) < count(full.mask));
  const x = F.xray(R.labels, R.dims);
  assert.ok(count(x.mask) > 300);
  const box = F.maskBox(full.mask, full.width, full.height, 2);
  assert.ok(box.x1 - box.x0 > 20 && box.y1 - box.y0 > 15);
  const a = F.anchors(full.labels, full.width, full.height, 0.1, [1]);
  assert.equal(a.length, 1);
  assert.equal(full.labels[a[0].y * full.width + a[0].x], F.CODE.DOPED_DENSE);
});

test('toFigureFrame puts the first slice at the top and can swap the field axis', () => {
  const dims = { nx: 3, ny: 2, nz: 2 }, L = new Uint8Array(12);
  L[0] = 7; // x 0, y 0, z 0
  const f = F.toFigureFrame(L, dims, { fieldAxis: 'y' });
  assert.deepEqual(f.dims, { nx: 2, ny: 3, nz: 2 });
  assert.equal(f.labels[(1 * 3 + 0) * 2 + 0], 7);
});

test('halve keeps gas and clumps that cover any of the 8 voxels; run-length code round-trips', () => {
  const dims = { nx: 4, ny: 4, nz: 4 }, L = new Uint8Array(64).fill(1);
  L[0] = F.CODE.DOPED_PORE; L[63] = F.CODE.CLUMP;
  const h = F.halve(L, dims);
  assert.equal(h.labels[0], F.CODE.DOPED_PORE); assert.equal(h.labels[7], F.CODE.CLUMP); assert.equal(h.labels[3], 1);
  assert.deepEqual(F.decode(F.encode(L), 64), L);
});

test('distanceFrom is Euclidean and carries the nearest source value', () => {
  const dims = { nx: 12, ny: 10, nz: 6 }, src = new Uint8Array(720), val = new Uint8Array(720);
  src[0] = 1; val[0] = 2; src[719] = 1; val[719] = 1;
  const { distance, carry } = F.distanceFrom(src, dims, val);
  const at = (x, y, z) => (z * 10 + y) * 12 + x;
  assert.ok(Math.abs(distance[at(3, 4, 0)] - 5) < 1e-6);
  assert.equal(carry[at(1, 1, 1)], 2);
  assert.equal(carry[at(10, 8, 5)], 1);
});

test('figureStats: enclosed gas is a share of the whole doped body, open doped pores and clumps included', () => {
  const L = new Uint8Array(95);
  L.fill(F.CODE.DOPED_DENSE, 0, 80); L.fill(F.CODE.CLUMP, 80, 90); L.fill(F.CODE.DOPED_PORE, 90, 95); // 5 enclosed
  const s = F.figureStats({ labels: L, rho: new Float32Array(95).fill(1), cellMm: 0.1, openVoxels: 5, openDopedVoxels: 5 });
  assert.ok(Math.abs(s.gas_percent_of_doped - 5) < 1e-9, `${s.gas_percent_of_doped}`); // 5 of 80 + 10 + 5 + 5 open
  assert.ok(Math.abs(s.doped_mm3 - 0.1) < 1e-9, `${s.doped_mm3}`);
});

// Base material (1.0) around a large composite body (1.14) and a separate small composite block: the dense core is
// the large body only.
function corePhantom() {
  const dims = { nx: 160, ny: 100, nz: 60 }, n = dims.nx * dims.ny * dims.nz, rho = new Float32Array(n), env = new Uint8Array(n);
  const inBox = (x, y, z, b) => x >= b[0] && x < b[1] && y >= b[2] && y < b[3] && z >= b[4] && z < b[5];
  const BODY = [20, 80, 25, 75, 15, 45], SMALL = [115, 145, 35, 65, 15, 45];
  for (let z = 0, i = 0; z < dims.nz; z++) for (let y = 0; y < dims.ny; y++) for (let x = 0; x < dims.nx; x++, i++) {
    if (x < 5 || x >= 155 || y < 5 || y >= 95 || z < 5 || z >= 55) continue;
    env[i] = 1;
    rho[i] = inBox(x, y, z, BODY) || inBox(x, y, z, SMALL) ? 1.14 : 1.0;
  }
  return { dims, rho, env, clump: new Uint8Array(n), BODY, SMALL, inBox };
}

test('denseCore: the largest piece reading at composite level; a smaller separate block and the base material are left out', () => {
  const p = corePhantom();
  const { core } = F.denseCore({ rho: p.rho, envelope: p.env, clump: p.clump, dims: p.dims, cellMm: 0.1 });
  const at = (x, y, z) => core[(z * p.dims.ny + y) * p.dims.nx + x];
  assert.equal(at(50, 50, 30), 1, 'the body center');
  assert.equal(at(130, 50, 30), 0, 'the small block');
  assert.equal(at(10, 50, 30), 0, 'base material');
  // The 2.4 mm level window (12 cells either side) blurs the body's faces, so the core is inset; every body cell whose
  // window lies wholly inside the body is core, and the core stays inside the body.
  const B = p.BODY, deep = [B[0] + 12, B[1] - 12, B[2] + 12, B[3] - 12, B[4] + 12, B[5] - 12];
  let missing = 0, outside = 0, n = 0;
  for (let i = 0; i < core.length; i++) {
    const x = i % 160, y = Math.floor(i / 160) % 100, z = Math.floor(i / 16000);
    if (core[i]) { n++; if (!p.inBox(x, y, z, B)) outside++; } else if (p.inBox(x, y, z, deep)) missing++;
  }
  assert.equal(missing, 0, 'deep body cells left out');
  assert.ok(n > 0 && outside / n < 0.01, `${outside} of ${n} core cells outside the body`);
});

test('figureNumbers: dense is the core mass over the weighed charge; n/a without a charge weight', () => {
  const stats = { core_mass_g: 3, gas_percent_of_doped: 2.5, base_mass_g: 4 };
  const a = F.figureNumbers(stats, { mass_in_g: 6, mass_out_g: 11 });
  assert.equal(a.dense, 50);
  assert.equal(a.gas, 2.5);
  assert.equal(a.fused, 5); assert.equal(a.fusedSource, 'weighed');
  const b = F.figureNumbers(stats, {});
  assert.equal(b.dense, null); assert.equal(b.fused, 4); assert.equal(b.fusedSource, 'CT');
});

test('numbersLine: the line under each part, as the deck prints it; says what is missing instead of a bare n/a', () => {
  const names = { doped: 'doped', base: 'base', clump: 'clump' };
  assert.equal(F.numbersLine({ dense: 44.6, gas: 2.34, fused: 3.27, fusedSource: 'weighed' }, names), '45 % dense · 2.3 % gas · 3.3 g base fused on');
  assert.equal(F.numbersLine({ dense: null, gas: 12.5, fused: 2, fusedSource: 'CT' }, names), 'dense: enter the doped charge · 13 % gas · 2.0 g base fused on (CT)');
});
