'use strict';
// Holder removal acceptance gate: the automatic holder removal must reproduce the Nov 5 Python part masks on the real
// scans. Needs, in VOXELBENCH_LOCAL_DIR/holder/ (never in this repository):
//   s6_32s/, s6_high/   TIFF stacks of the angled-stand scan (32 s and high-res)
//   s6_b4_part.npy      the Nov 5 part mask on the 0.16 mm grid (4x4x4 block mean from native index 0)
//   s4/                 the post scan's export folder (a .VOX volume)
//   s4_b4_part.npy      the Nov 5 part mask for it, same grid
//   stl/                holder STL candidates (<name>__*.stl)
//   expected.json       { s6: { envelope_cm3, body_threshold, plates_mm }, s4: { envelope_cm3, body_threshold } }
// Every test skips unless its own files exist. Run with: VOXELBENCH_LOCAL_DIR=... npm run test:local
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CT = require('../../app/ct_core.js');
const P = require('../../app/ct_pores.js');
const VB = require('../../app/vb_volume.js');
const X = require('../../app/vb_vox.js');
const H = require('../../app/vb_holder.js');
const HS = require('../../app/vb_holderstl.js');
const W = require('../../app/vb_holderwire.js');
const St = require('../../app/vb_stl.js');
const { readNpy } = require('../../tools/npy.js');

const LOCAL = process.env.VOXELBENCH_LOCAL_DIR || '';
const HOLD = LOCAL && path.join(LOCAL, 'holder');
const has = (...names) => Boolean(LOCAL) && names.every((n) => fs.existsSync(path.join(HOLD, n)));
const EXPECTED = has('expected.json') ? JSON.parse(fs.readFileSync(path.join(HOLD, 'expected.json'), 'utf8')) : null;
const why = (...names) => !(EXPECTED && has(...names)) && `VOXELBENCH_LOCAL_DIR with holder/${names.join(', holder/')} and holder/expected.json not set`;

const F = 2;           // read binned x2 while reading (to 0.08 mm), as the page does for a stack this size
const BIN = 2;         // the worker's grid: 0.16 mm, the Nov 5 grid
const LIMITS = { envelope: 0.02, dice: 0.97, plateMm: 0.3, holderSeconds: 15 };
const S6_PLATFORMS = ['ct_head_platform_big', 'ct_head_platform_turret'];
const S6_BLOCKS = ['ct_block_10deg', 'ct_block_15deg', 'ct_block_20deg', 'ct_block_30deg'];

/** A scan folder read binned F x F x F while reading: a TIFF stack, or the .VOX in an export folder. The circle is fitted on
    a native slice and scaled to the binned grid (ct_app.js). */
async function readScan(folder) {
  const vox = fs.readdirSync(folder).find((n) => /\.vox$/i.test(n) && !n.startsWith('.'));
  let count, read;
  if (vox) {
    const v = await X.openVox(await fs.openAsBlob(path.join(folder, vox)));
    ({ count, read } = v);
  } else {
    const names = CT.sliceOrder(fs.readdirSync(folder));
    count = names.length;
    read = async (i) => { const b = fs.readFileSync(path.join(folder, names[i])); return CT.parseTiff(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
  }
  const first = await read(0), { width, height } = first, groups = Math.floor(count / F), mid = Math.floor(count / 2), slices = [];
  let nativeMid = null;
  for (let k = 0; k < groups; k++) {
    const group = [];
    for (let j = 0; j < F; j++) { const i = k * F + j, t = await read(i); if (i === mid) nativeMid = t.pixels; group.push(t.pixels); }
    slices.push(VB.binGroup(group, width, height, F));
  }
  const c = CT.fitCircle(nativeMid, width, height);
  return { slices, dims: { nx: Math.floor(width / F), ny: Math.floor(height / F), nz: groups }, voxelMm: F * first.voxelMm, circle: c && { cx: c.cx / F, cy: c.cy / F, r: c.r / F } };
}

const stlCache = new Map();
function loadStl(name) {
  if (stlCache.has(name)) return stlCache.get(name);
  const file = fs.readdirSync(path.join(HOLD, 'stl')).find((n) => n.startsWith(`${name}__`) || n === `${name}.stl`);
  const b = fs.readFileSync(path.join(HOLD, 'stl', file)), u = new Uint8Array(b.buffer, b.byteOffset, b.length);
  const s = { name, hash: HS.stlHash(u), triangles: St.parseStl(u.slice().buffer).positions };
  stlCache.set(name, s);
  return s;
}

/** One sample-mask build with holder removal, as the worker runs it (prepareHolder, then buildBody), findHolder and every
    STL fit timed. stls: STL names to fit ([] = detection only). */
function build(scan, threshold, stls = []) {
  const vol = P.binVolume(scan.slices, scan.dims, BIN, scan.circle), voxelMm = BIN * scan.voxelMm, times = { find: 0, fits: [] };
  const modules = {
    holder: { findHolder: (a) => { const t = Date.now(); const r = H.findHolder(a); times.find += Date.now() - t; times.found = r; return r; } },
    stl: { fitHolderStl: (a) => { const t = Date.now(); const r = HS.fitHolderStl(a); times.fits.push(Date.now() - t); return r; } },
  };
  const holder = stls.length ? { pieces: null, givenBack: [], method: null, stls: stls.map(loadStl) } : null;
  const prep = W.prepareHolder({ holder, scale: { bin: BIN, binFactor: F }, orient: null, dims: vol.dims, voxelMm, modules });
  if (!prep.input.find) prep.input.modules = { holder: modules.holder };
  const body = P.buildBody(vol.gray, vol.outside, vol.dims, { ...P.DEFAULT_SETTINGS, bodyThreshold: threshold }, null, prep.input);
  let filled = 0;
  for (let i = 0; i < body.filled.length; i++) filled += body.filled[i];
  const holderSeconds = (times.find + times.fits.reduce((a, b) => a + b, 0)) / 1000;
  return { vol, voxelMm, body, info: body.holder, reports: prep.reports, envelopeCm3: (filled * voxelMm ** 3) / 1000, holderSeconds, times };
}

/** Dice of the mask against a reference .npy (z, y, x C order: the same index order) over the grid both cover. */
function dice(mask, dims, file) {
  const ref = readNpy(fs.readFileSync(file)), [rz, ry, rx] = ref.shape;
  const nz = Math.min(rz, dims.nz), ny = Math.min(ry, dims.ny), nx = Math.min(rx, dims.nx);
  let a = 0, b = 0, both = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const m = mask[x + dims.nx * (y + dims.ny * z)] ? 1 : 0, r = ref.data[x + rx * (y + ry * z)] ? 1 : 0;
    a += m; b += r; both += m & r;
  }
  return (2 * both) / (a + b);
}

const describe = (r) => ({
  method: r.info.method, envelopeCm3: +r.envelopeCm3.toFixed(3), holderSeconds: +r.holderSeconds.toFixed(1),
  pieces: r.info.pieces.map((p) => `${p.id} ${p.kind}${p.kind === 'plate' ? ` ${(2 * p.half[2] * r.voxelMm).toFixed(2)} mm` : ''} ${p.voxels} vox`),
  reports: (r.reports || []).map((s) => `${s.name}: ${s.outcome}${s.nearShare !== undefined ? ` near ${s.nearShare.toFixed(3)} RMS ${s.rmsMm.toFixed(2)} mm` : ''}`),
  warning: r.info.warning || null,
});
const within = (got, want, rel) => Math.abs(got - want) <= rel * want;

/** Found plate thicknesses matched to the expected ones (both sorted: the best one-to-one match on a line). */
function plateMatch(pieces, voxelMm, want) {
  const got = pieces.filter((p) => p.kind === 'plate').map((p) => 2 * p.half[2] * voxelMm).sort((a, b) => a - b), w = [...want].sort((a, b) => a - b);
  if (got.length < w.length) return { ok: false, got };
  // Every choice of want.length found plates, in order; the best is the one whose largest miss is smallest.
  let best = Infinity;
  const pick = (from, k, worst) => {
    if (k === w.length) { best = Math.min(best, worst); return; }
    for (let j = from; j <= got.length - (w.length - k); j++) pick(j + 1, k + 1, Math.max(worst, Math.abs(got[j] - w[k])));
  };
  pick(0, 0, 0);
  return { ok: best <= LIMITS.plateMm, got, worstMm: best };
}

let s6 = null; // the 32 s result, shared by the high-res check
const s6Scan = (() => { let p = null; return () => (p = p || readScan(path.join(HOLD, 's6_32s'))); })();

test('Sample 6 (32 s) matches the Nov 5 part mask', { skip: why('s6_32s', 's6_b4_part.npy') }, async () => {
  const e = EXPECTED.s6, r = build(await s6Scan(), e.body_threshold);
  const d = dice(r.body.filled, r.vol.dims, path.join(HOLD, 's6_b4_part.npy')), plates = plateMatch(r.info.pieces, r.voxelMm, e.plates_mm);
  s6 = r;
  console.log('S6 32 s', JSON.stringify({ ...describe(r), dice: +d.toFixed(4), plates }));
  assert.equal(r.info.method, 'shape', 'found by shape');
  assert.ok(plates.ok, `three plates within ${LIMITS.plateMm} mm of ${e.plates_mm}: found ${plates.got.map((t) => t.toFixed(2))}`);
  assert.ok(within(r.envelopeCm3, e.envelope_cm3, LIMITS.envelope), `envelope ${r.envelopeCm3.toFixed(3)} vs ${e.envelope_cm3} cm3`);
  assert.ok(d >= LIMITS.dice, `Dice ${d.toFixed(4)}`);
  assert.ok(r.times.find / 1000 <= LIMITS.holderSeconds, `findHolder took ${(r.times.find / 1000).toFixed(1)} s`);
});

test('Sample 6 high-res agrees with the 32 s scan', { skip: why('s6_32s', 's6_high') }, async () => {
  const e = EXPECTED.s6, r = build(await readScan(path.join(HOLD, 's6_high')), e.body_threshold);
  const ref = s6 ? s6.envelopeCm3 : e.envelope_cm3;
  console.log('S6 high-res', JSON.stringify({ ...describe(r), against: s6 ? '32 s result' : 'Nov 5 envelope (32 s test did not run)' }));
  // Agreeing with a 32 s result that itself misses the Nov 5 envelope proves nothing (both can keep the same holder).
  if (s6) assert.ok(within(s6.envelopeCm3, e.envelope_cm3, LIMITS.envelope), `the 32 s envelope ${s6.envelopeCm3.toFixed(3)} cm3 misses the Nov 5 ${e.envelope_cm3} cm3, so it is no reference`);
  assert.ok(within(r.envelopeCm3, ref, LIMITS.envelope), `envelope ${r.envelopeCm3.toFixed(3)} vs ${ref.toFixed(3)} cm3`);
  assert.ok(r.times.find / 1000 <= LIMITS.holderSeconds, `findHolder took ${(r.times.find / 1000).toFixed(1)} s`);
});

test('Sample 6 (32 s) with its holder STLs (platform + block candidates)', { skip: why('s6_32s', 's6_b4_part.npy', 'stl') }, async () => {
  const e = EXPECTED.s6, scan = await s6Scan(), runs = [];
  for (const platform of S6_PLATFORMS) for (const block of S6_BLOCKS) {
    const r = build(scan, e.body_threshold, [platform, block]);
    const fitted = r.info.pieces.filter((p) => p.kind === 'stl');
    const d = fitted.length ? dice(r.body.filled, r.vol.dims, path.join(HOLD, 's6_b4_part.npy')) : null;
    runs.push({ set: [platform, block], fitted: fitted.length, envelopeCm3: r.envelopeCm3, dice: d, holderSeconds: r.holderSeconds });
    console.log('S6 STL', JSON.stringify({ set: [platform, block], ...describe(r), dice: d && +d.toFixed(4) }));
  }
  const ok = runs.filter((x) => x.fitted && within(x.envelopeCm3, e.envelope_cm3, LIMITS.envelope) && x.dice >= LIMITS.dice);
  assert.ok(ok.length, `no STL set fits and reaches the targets: ${runs.map((x) => `${x.set.join('+')}: ${x.fitted} fitted`).join('; ')}`);
  assert.ok(ok.every((x) => x.holderSeconds <= LIMITS.holderSeconds), `holder time over ${LIMITS.holderSeconds} s`);
});

let s4Scan = null;
test('Sample 4 matches the Nov 5 part mask', { skip: why('s4', 's4_b4_part.npy') }, async () => {
  const e = EXPECTED.s4;
  s4Scan = await readScan(path.join(HOLD, 's4'));
  const r = build(s4Scan, e.body_threshold), d = dice(r.body.filled, r.vol.dims, path.join(HOLD, 's4_b4_part.npy'));
  console.log('S4', JSON.stringify({ ...describe(r), dice: +d.toFixed(4) }));
  assert.equal(r.info.method, 'bright', 'found by bright resin');
  assert.ok(within(r.envelopeCm3, e.envelope_cm3, LIMITS.envelope), `envelope ${r.envelopeCm3.toFixed(3)} vs ${e.envelope_cm3} cm3`);
  assert.ok(d >= LIMITS.dice, `Dice ${d.toFixed(4)}`);
  assert.ok(r.times.find / 1000 <= LIMITS.holderSeconds, `findHolder took ${(r.times.find / 1000).toFixed(1)} s`);
});

// Informative only (a stand-in STL for the scanner's own stick, which has no STL): logged, not a pass requirement.
test('Sample 4 with a stand-in post STL (informative)', { skip: why('s4', 's4_b4_part.npy', 'stl') }, async () => {
  if (!fs.readdirSync(path.join(HOLD, 'stl')).some((n) => n.startsWith('ct_base_big'))) return;
  const scan = s4Scan || await readScan(path.join(HOLD, 's4')), r = build(scan, EXPECTED.s4.body_threshold, ['ct_base_big']);
  const d = dice(r.body.filled, r.vol.dims, path.join(HOLD, 's4_b4_part.npy'));
  console.log('S4 STL (informative)', JSON.stringify({ ...describe(r), dice: +d.toFixed(4) }));
});
