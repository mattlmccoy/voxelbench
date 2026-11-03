'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../app/ct_display.js');
const CT = require('../app/ct_core.js');

const REF = require('./fixtures/display_reference.json');
const LOCAL = process.env.VOXELBENCH_LOCAL_DIR || '';
const REAL_DIR = LOCAL && path.join(LOCAL, 'scan'); // a local scan folder; tests that need it skip without it

test('turbo table matches matplotlib', () => {
  for (const [i, rgb] of Object.entries(REF.turbo_rgb)) assert.deepEqual(D.turbo(Number(i) / 255), rgb);
});

test('rainbow: below the window low is black, the window spans the table', () => {
  const out = new Uint8ClampedArray(16);
  D.rainbowToRgba(Float32Array.from([999, 1000, 2000, 5000]), 1000, 2000, out);
  assert.deepEqual([...out.slice(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...out.slice(4, 7)], REF.turbo_rgb['0']);
  assert.deepEqual([...out.slice(8, 11)], REF.turbo_rgb['255']);
  assert.deepEqual([...out.slice(12, 15)], REF.turbo_rgb['255']);
});

test('smoothing matches scipy gaussian_filter (reflect edges)', () => {
  const { w, h, sigma, input, output } = REF.smooth;
  const got = D.smoothPlane(Float32Array.from(input), w, h, sigma);
  output.forEach((v, i) => assert.ok(Math.abs(got[i] - v) < 0.05, `pixel ${i}: ${got[i]} vs ${v}`));
});

test('outline keeps the band of a label next to a different label', () => {
  // A 5 x 5 square of label 7 inside a 9 x 9 frame of 0.
  const w = 9, labels = new Uint32Array(81);
  for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) labels[y * w + x] = 7;
  const one = D.outlineMask(labels, w, 9, 1);
  assert.equal(one[2 * w + 2], 1);
  assert.equal(one[4 * w + 4], 0);
  assert.equal(one[0], 0, 'background is never outlined');
  assert.equal(one.reduce((a, b) => a + b, 0), 16);
  const two = D.outlineMask(labels, w, 9, 2);
  assert.equal(two[3 * w + 3], 1);
  assert.equal(two[4 * w + 4], 0);
  assert.equal(two.reduce((a, b) => a + b, 0), 24);
});

test('rainbow window sits between the air and matrix peaks', () => {
  // Air near 700, matrix near 2100; exact 0 (outside the reconstruction) is ignored.
  const nx = 200, slice = new Uint16Array(nx);
  for (let i = 0; i < nx; i++) slice[i] = i < 20 ? 0 : i < 80 ? 700 + (i % 7) * 10 : 2100 + (i % 9) * 10;
  const w = D.rainbowWindow([slice], { nx, ny: 1, nz: 1 }, 1);
  assert.ok(Math.abs(w.air - 730) < 40, `air ${w.air}`);
  assert.ok(Math.abs(w.matrix - 2140) < 40, `matrix ${w.matrix}`);
  assert.equal(w.low, Math.round(w.air + 0.28 * (w.matrix - w.air)));
  assert.equal(w.high, Math.round(w.matrix + 0.39 * (w.matrix - w.air)));
});

test('rainbow window finds the matrix when air is the taller peak', () => {
  const nx = 300, slice = new Uint16Array(nx);
  for (let i = 0; i < nx; i++) slice[i] = i < 200 ? 700 + (i % 7) * 10 : 2100 + (i % 9) * 10;
  const w = D.rainbowWindow([slice], { nx, ny: 1, nz: 1 }, 1);
  assert.ok(Math.abs(w.air - 730) < 40, `air ${w.air}`);
  assert.ok(Math.abs(w.matrix - 2140) < 40, `matrix ${w.matrix}`);
});

test('rainbow window on the real Sample 2 stack is near the approved 1100 to 2600', { skip: !REAL_DIR || !fs.existsSync(REAL_DIR) }, () => {
  const files = fs.readdirSync(REAL_DIR).filter((f) => /\.tiff?$/.test(f)).sort();
  const pick = files.filter((_, i) => i % 25 === 0);
  const tiffs = pick.map((f) => { const b = fs.readFileSync(`${REAL_DIR}/${f}`); return CT.parseTiff(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); });
  const w = D.rainbowWindow(tiffs.map((t) => t.pixels), { nx: tiffs[0].width, ny: tiffs[0].height, nz: tiffs.length }, 2);
  assert.ok(Math.abs(w.low - 1100) < 80, `low ${w.low}`);
  assert.ok(Math.abs(w.high - 2600) < 80, `high ${w.high}`);
});
