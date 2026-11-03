'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CT = require('../app/ct_core.js');
const S = require('../app/vb_synthetic.js');
const H = require('../tools/headless_run.js');

test('the synthetic scan without filler is unchanged by the filler option existing', () => {
  const a = S.makeScan({ size: 40, seed: 3 }), b = S.makeScan({ size: 40, seed: 3, filler: false });
  assert.deepEqual(a.truth, b.truth);
});

test('the synthetic filled scan: spheres counted, volume fraction and the fibers lying along x recovered', async () => {
  const { files, truth } = S.makeScan({ filler: true });
  assert.ok(truth.filler.spheres > 30 && truth.filler.fibers > 10, JSON.stringify(truth.filler));
  const tiffs = await Promise.all(files.map(async (f) => CT.parseTiff(await f.arrayBuffer())));
  const stack = { slices: tiffs.map((t) => t.pixels), voxelMm: tiffs[0].voxelMm, dims: { nx: 160, ny: 160, nz: 160 } };
  const a = H.analyze(stack, { settings: { poreThreshold: 1350 } }, { patches: false });
  const r = H.analyzeFiller(a, {});
  const s = r.summary;
  const round = r.particles.filter((p) => p.aspect < 2).length;
  assert.ok(Math.abs(round - truth.filler.spheres) <= 0.1 * truth.filler.spheres, `spheres ${round} vs ${truth.filler.spheres}`);
  assert.ok(Math.abs(s.fibers - truth.filler.fibers) <= 0.1 * truth.filler.fibers + 1, `fibers ${s.fibers} vs ${truth.filler.fibers}`);
  assert.ok(Math.abs(s.volume_percent - truth.filler.volume_percent) / truth.filler.volume_percent < 0.15, `volume ${s.volume_percent} vs ${truth.filler.volume_percent}`);
  const d = s.orientation.direction;
  assert.ok(Math.abs(d[0]) > Math.cos((10 * Math.PI) / 180), `direction ${d}`);
  assert.ok(s.orientation.eigenvalues[0] > 0.8, `alignment ${s.orientation.eigenvalues[0]}`);
  assert.ok(r.threshold.threshold > truth.matrix_gray && r.threshold.threshold < truth.filler.gray, `${r.threshold.threshold}`);
});
