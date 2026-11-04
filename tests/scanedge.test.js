'use strict';
// The scan-edge band: the dark outer ring of a reconstruction is left out of zones, as deep as the ring actually reaches
// (never more than 2 mm, the depth set on Sample 2).
const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../app/ct_zones.js');

// 60 solid voxels per 0.25 mm of scan depth from 0 to maxMm, all 1 mm inside the part; gray from grayAt(scanDepth).
function profile(maxMm, grayAt) {
  const sd = [], g = [];
  for (let d = 0.125; d < maxMm; d += 0.25) for (let k = 0; k < 60; k++) { sd.push(d); g.push(grayAt(d)); }
  const n = sd.length;
  return { gray: Float32Array.from(g), scanDepth: Float32Array.from(sd), w: new Float32Array(n).fill(1), depth: new Float32Array(n).fill(1), body: new Uint8Array(n).fill(1), airGray: 0 };
}

test('a scan without a dark ring gets no scan-edge band', () => {
  assert.equal(Z.scanEdgeBand(profile(3, () => 1000)), 0);
});

test('the band reaches as deep as the ring stays darker than the interior', () => {
  assert.equal(Z.scanEdgeBand(profile(3, (d) => (d < 1.5 ? 900 : 1000))), 1.5);
});

test('the band never exceeds 2 mm', () => {
  assert.equal(Z.scanEdgeBand(profile(4, (d) => (d < 2.75 ? 900 : 1000))), 2);
});

test('with nothing deeper than 2 mm to compare against, the band stays 2 mm', () => {
  assert.equal(Z.scanEdgeBand(profile(1.9, () => 1000)), 2);
});

test('voxels near the part surface do not count as ring', () => {
  const p = profile(3, (d) => 1000);
  for (let i = 0; i < p.gray.length; i++) if (p.scanDepth[i] < 1) { p.gray[i] = 800; p.depth[i] = 0.2; }
  assert.equal(Z.scanEdgeBand(p), 0);
});
