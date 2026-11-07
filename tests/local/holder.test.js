'use strict';
// Holder removal acceptance gate on real scans. It judges the holder effect: the envelope VoxelBench builds with its own
// holder removal must be within 2 % of the envelope VoxelBench builds when it is handed the Nov 5 Python holder mask
// (the same mask pipeline both times), and the part mask must match the Nov 5 part mask (Dice). The plain difference to
// the Nov 5 envelope is logged as information. Needs, in VOXELBENCH_LOCAL_DIR/holder/ (never in this repository):
//   s6_32s/, s6_high/   TIFF stacks of the angled-stand scan (32 s and high-res)
//   s6_b4_part.npy      the Nov 5 part mask on the 0.16 mm grid (4x4x4 block mean from native index 0)
//   s4/                 the post scan's export folder (a .VOX volume)
//   s4_b4_part.npy      the Nov 5 part mask for it, same grid
//   s6_b4_holder.npy, s4_b4_holder.npy   the Nov 5 holder masks, same grid
//   stl/                holder STL files (<name>__*.stl); a stand-in post STL is fitted on the post scan, informative only
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


/** The envelope VoxelBench builds when handed the Nov 5 holder mask instead of finding its own: the same buildBody (tape
    still found and stripped), with every solid voxel of the Nov 5 holder cut. */
function nov5HolderEnvelope(r, threshold, file) {
  const nov5 = readNpy(fs.readFileSync(file)), { nx, ny, nz } = r.vol.dims, [rz, ry, rx] = nov5.shape;
  const holderMask = (a) => {
    const out = H.holderMask(a);
    for (let z = 0; z < Math.min(nz, rz); z++) for (let y = 0; y < Math.min(ny, ry); y++) for (let x = 0; x < Math.min(nx, rx); x++) {
      const i = x + nx * (y + ny * z);
      if (a.solid[i] && nov5.data[x + rx * (y + ry * z)]) out.holder[i] = 1;
    }
    return out;
  };
  const input = { pieces: null, givenBack: [], voxelMm: r.voxelMm, find: () => ({ method: 'given', pieces: [] }), modules: { holder: { holderMask } } };
  const body = P.buildBody(r.vol.gray, r.vol.outside, r.vol.dims, { ...P.DEFAULT_SETTINGS, bodyThreshold: threshold }, null, input);
  let filled = 0;
  for (let i = 0; i < body.filled.length; i++) filled += body.filled[i];
  return (filled * r.voxelMm ** 3) / 1000;
}

/** The Nov 5 plate thickness rule applied to a found plate: the 0.5-99.5 % range of its solid voxel centers along its
    normal, plus 2 voxels (s6_partmask.py). Its voxels are the solid within 2 voxels of its faces, over the in-plane cells
    with no solid further out (a resting part, a crossing plate or the base there would widen the range). In voxels. */
function nov5Thickness(p, solid, { nx, ny, nz }) {
  const a = p.axes, h = p.half, G = 2, r = [0, 1, 2].map((j) => Math.abs(a[j]) * h[0] + Math.abs(a[3 + j]) * h[1] + Math.abs(a[6 + j]) * (h[2] + G + 1) + 1);
  const lo = [0, 1, 2].map((j) => Math.max(0, Math.floor(p.center[j] - r[j]))), hi = [nx, ny, nz].map((m, j) => Math.min(m - 1, Math.ceil(p.center[j] + r[j])));
  const dirty = new Set(), vals = [];
  for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
    if (!solid[x + nx * (y + ny * z)]) continue;
    const d = [x - p.center[0], y - p.center[1], z - p.center[2]], q = [0, 3, 6].map((o) => d[0] * a[o] + d[1] * a[o + 1] + d[2] * a[o + 2]);
    if (Math.abs(q[0]) > h[0] || Math.abs(q[1]) > h[1] || Math.abs(q[2]) > h[2] + G + 1) continue;
    const cell = `${Math.round(q[0])},${Math.round(q[1])}`;
    if (Math.abs(q[2]) > h[2] + G) dirty.add(cell); else vals.push([cell, q[2]]);
  }
  const v = Float64Array.from(vals.filter(([c]) => !dirty.has(c)).map(([, t]) => t)).sort();
  return v.length ? v[Math.ceil(0.995 * (v.length - 1))] - v[Math.floor(0.005 * (v.length - 1))] + 2 : 0;
}

/** Found plate thicknesses (Nov 5 rule) matched to the expected ones: the best one-to-one match of sorted values. */
function plateMatch(r, threshold, want) {
  const solid = r.body.smoothed.map((g, i) => (g > threshold && !r.vol.outside[i] ? 1 : 0));
  const got = r.info.pieces.filter((p) => p.kind === 'plate').map((p) => nov5Thickness(p, solid, r.vol.dims) * r.voxelMm).sort((a, b) => a - b);
  const w = [...want].sort((a, b) => a - b);
  let best = Infinity;
  const pick = (from, k, worst) => {
    if (k === w.length) { best = Math.min(best, worst); return; }
    for (let j = from; j <= got.length - (w.length - k); j++) pick(j + 1, k + 1, Math.max(worst, Math.abs(got[j] - w[k])));
  };
  pick(0, 0, 0);
  return { ok: best <= LIMITS.plateMm, got: got.map((t) => +t.toFixed(2)), worstMm: best === Infinity ? null : +best.toFixed(2) };
}

/** The holder-effect checks shared by both scans: envelope against VoxelBench-with-the-Nov-5-holder, Dice, find time. */
function judge(label, r, e, part, holder) {
  const ref = nov5HolderEnvelope(r, e.body_threshold, path.join(HOLD, holder)), d = dice(r.body.filled, r.vol.dims, path.join(HOLD, part));
  const info = { ...describe(r), dice: +d.toFixed(4), referenceCm3: +ref.toFixed(3), vsReference: `${(100 * (r.envelopeCm3 / ref - 1)).toFixed(2)} %`,
    vsNov5Envelope: `${(100 * (r.envelopeCm3 / e.envelope_cm3 - 1)).toFixed(2)} % (information)`, findSeconds: +(r.times.find / 1000).toFixed(1) };
  console.log(label, JSON.stringify(info));
  return () => {
    assert.ok(within(r.envelopeCm3, ref, LIMITS.envelope), `envelope ${r.envelopeCm3.toFixed(3)} vs ${ref.toFixed(3)} cm3 with the Nov 5 holder`);
    assert.ok(d >= LIMITS.dice, `Dice ${d.toFixed(4)}`);
    assert.ok(r.times.find / 1000 <= LIMITS.holderSeconds, `findHolder took ${(r.times.find / 1000).toFixed(1)} s`);
  };
}

let s6 = null; // the 32 s result, shared by the high-res check

test('Sample 6 (32 s) matches the Nov 5 part mask', { skip: why('s6_32s', 's6_b4_part.npy', 's6_b4_holder.npy') }, async () => {
  const e = EXPECTED.s6, r = build(await readScan(path.join(HOLD, 's6_32s')), e.body_threshold), plates = plateMatch(r, e.body_threshold, e.plates_mm);
  console.log('S6 32 s plates (Nov 5 rule)', JSON.stringify(plates));
  const checks = judge('S6 32 s', r, e, 's6_b4_part.npy', 's6_b4_holder.npy');
  s6 = { envelopeCm3: r.envelopeCm3, passed: false };
  assert.equal(r.info.method, 'shape', 'found by shape');
  checks();
  s6.passed = true;
  assert.ok(plates.ok, `three plates within ${LIMITS.plateMm} mm of ${e.plates_mm} (Nov 5 rule): found ${plates.got}`);
});

test('Sample 6 high-res agrees with the 32 s scan', { skip: why('s6_32s', 's6_high', 's6_b4_part.npy', 's6_b4_holder.npy') }, async () => {
  const e = EXPECTED.s6, r = build(await readScan(path.join(HOLD, 's6_high')), e.body_threshold);
  judge('S6 high-res (information: against the 32 s Nov 5 masks)', r, e, 's6_b4_part.npy', 's6_b4_holder.npy');
  // Agreeing with a 32 s result that failed its own checks proves nothing (both can keep the same holder).
  assert.ok(s6 && s6.passed, 'the 32 s scan did not pass, so it is no reference');
  assert.ok(within(r.envelopeCm3, s6.envelopeCm3, LIMITS.envelope), `envelope ${r.envelopeCm3.toFixed(3)} vs ${s6.envelopeCm3.toFixed(3)} cm3 (32 s)`);
  assert.ok(r.times.find / 1000 <= LIMITS.holderSeconds, `findHolder took ${(r.times.find / 1000).toFixed(1)} s`);
});

let s4Scan = null;
test('Sample 4 matches the Nov 5 part mask', { skip: why('s4', 's4_b4_part.npy', 's4_b4_holder.npy') }, async () => {
  const e = EXPECTED.s4;
  s4Scan = await readScan(path.join(HOLD, 's4'));
  const r = build(s4Scan, e.body_threshold), checks = judge('S4', r, e, 's4_b4_part.npy', 's4_b4_holder.npy');
  assert.equal(r.info.method, 'bright', 'found by bright resin');
  checks();
});

// Informative only (a stand-in STL for the scanner's own stick, which has no STL): logged, not a pass requirement.
test('Sample 4 with a stand-in post STL (informative)', { skip: why('s4', 's4_b4_part.npy', 'stl') }, async () => {
  if (!fs.readdirSync(path.join(HOLD, 'stl')).some((n) => n.startsWith('ct_base_big'))) return;
  const scan = s4Scan || await readScan(path.join(HOLD, 's4')), r = build(scan, EXPECTED.s4.body_threshold, ['ct_base_big']);
  const d = dice(r.body.filled, r.vol.dims, path.join(HOLD, 's4_b4_part.npy'));
  console.log('S4 STL (informative)', JSON.stringify({ ...describe(r), dice: +d.toFixed(4) }));
});
