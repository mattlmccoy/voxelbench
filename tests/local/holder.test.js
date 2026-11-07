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
//   expected.json       { s6: { envelope_cm3, body_threshold, plates_touching_mm }, s4: { envelope_cm3, body_threshold } }
//                       (plates_touching_mm: the Nov 5 plates that hold the part, by the Nov 5 rule)
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
const O = require('../../app/vb_orient.js');
const Fr = require('../../app/vb_holderframe.js');
const Rv = require('../../app/vb_holderreview.js');
const { readNpy } = require('../../tools/npy.js');

const LOCAL = process.env.VOXELBENCH_LOCAL_DIR || '';
const HOLD = LOCAL && path.join(LOCAL, 'holder');
const has = (...names) => Boolean(LOCAL) && names.every((n) => fs.existsSync(path.join(HOLD, n)));
const EXPECTED = has('expected.json') ? JSON.parse(fs.readFileSync(path.join(HOLD, 'expected.json'), 'utf8')) : null;
const why = (...names) => !(EXPECTED && has(...names)) && `VOXELBENCH_LOCAL_DIR with holder/${names.join(', holder/')} and holder/expected.json not set`;

const F = 2;           // read binned x2 while reading (to 0.08 mm), as the page does for a stack this size
const BIN = 2;         // the worker's grid: 0.16 mm, the Nov 5 grid
// Holder time: detection alone 15 s; with a holder STL ticked up to about 20 s (Matt, 11-07).
const LIMITS = { envelope: 0.02, dice: 0.97, plateMm: 0.3, holderSeconds: 15, stlHolderSeconds: 20 };

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

/** One sample-mask build with holder removal, as the worker runs it (prepareHolder, then buildBody), findHolder, every
    STL fit and the whole build timed. stls: STL names to fit ([] = detection only); orient: the saved native
    orientation when the scan is a leveled frame (ct_app.js frame.orient), else null; record: the sample's saved holder
    record (sent as holderMessage makes it), which replaces the STL choice. */
function build(scan, threshold, stls = [], orient = null, record = null) {
  const vol = P.binVolume(scan.slices, scan.dims, BIN, scan.circle), voxelMm = BIN * scan.voxelMm, times = { find: 0, fits: [] };
  const modules = {
    holder: { findHolder: (a) => { const t = Date.now(); const r = H.findHolder(a); times.find += Date.now() - t; times.found = r; return r; } },
    stl: { fitHolderStl: (a) => { const t = Date.now(); const r = HS.fitHolderStl(a); times.fits.push(Date.now() - t); return r; } },
  };
  const holder = record ? W.holderMessage(record, []) : stls.length ? { pieces: null, givenBack: [], method: null, stls: stls.map(loadStl) } : null;
  const prep = W.prepareHolder({ holder, scale: { bin: BIN, binFactor: F }, orient, dims: vol.dims, voxelMm, modules });
  if (!prep.input.find) prep.input.modules = { holder: modules.holder };
  const t0 = Date.now(), body = P.buildBody(vol.gray, vol.outside, vol.dims, { ...P.DEFAULT_SETTINGS, bodyThreshold: threshold }, null, prep.input);
  times.build = Date.now() - t0;
  let filled = 0;
  for (let i = 0; i < body.filled.length; i++) filled += body.filled[i];
  const holderSeconds = (times.find + times.fits.reduce((a, b) => a + b, 0)) / 1000;
  return { vol, voxelMm, body, info: body.holder, prep, reports: prep.reports, envelopeCm3: (filled * voxelMm ** 3) / 1000, holderSeconds, times };
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
  warning: r.info.warning || null, note: r.info.note || null, buildSeconds: +(r.times.build / 1000).toFixed(1),
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

/** Ids of the pieces that touch the part: a voxel the piece cut (labels, removeHolder's) is a 6-neighbor of the final
    part mask. A piece that touches nothing does not change the mask. */
function touching(r) {
  const { labels, pieces } = r.info, f = r.body.filled, { nx, ny } = r.vol.dims, steps = [1, -1, nx, -nx, nx * ny, -nx * ny], hit = new Set();
  for (let i = 0; i < labels.length; i++) if (labels[i] && !hit.has(labels[i]) && steps.some((d) => f[i + d])) hit.add(labels[i]);
  return new Set([...hit].map((l) => pieces[l - 1].id));
}

/** The plates touching the part, measured by the Nov 5 rule, matched one to one to the Nov 5 plates that hold the part:
    ok when each expected plate has its own found plate within LIMITS.plateMm (more touching plates are reported). */
function plateMatch(r, threshold, want) {
  const solid = r.body.smoothed.map((g, i) => (g > threshold && !r.vol.outside[i] ? 1 : 0)), touch = touching(r);
  const all = r.info.pieces.filter((p) => p.kind === 'plate').map((p) => ({ id: p.id, touches: touch.has(p.id), mm: +(nov5Thickness(p, solid, r.vol.dims) * r.voxelMm).toFixed(2) }));
  const got = all.filter((p) => p.touches).map((p) => p.mm);
  if (!Array.isArray(want) || !want.length) return { ok: false, plates: all, want, worstMm: null, why: 'expected.json lists no touching plates' };
  let best = Infinity;
  const pick = (k, used, worst) => {
    if (k === want.length) { best = Math.min(best, worst); return; }
    got.forEach((g, j) => { if (!used.has(j)) pick(k + 1, new Set([...used, j]), Math.max(worst, Math.abs(g - want[k]))); });
  };
  pick(0, new Set(), 0);
  return { ok: best <= LIMITS.plateMm, plates: all, want, worstMm: best === Infinity ? null : +best.toFixed(2) };
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
let s6Run = null; // the 32 s scan and its scan-axes build, shared by the leveled check

test('Sample 6 (32 s) matches the Nov 5 part mask', { skip: why('s6_32s', 's6_b4_part.npy', 's6_b4_holder.npy') }, async () => {
  const e = EXPECTED.s6, scan = await readScan(path.join(HOLD, 's6_32s')), r = build(scan, e.body_threshold), plates = plateMatch(r, e.body_threshold, e.plates_touching_mm);
  console.log('S6 32 s plates (Nov 5 rule)', JSON.stringify(plates));
  const checks = judge('S6 32 s', r, e, 's6_b4_part.npy', 's6_b4_holder.npy');
  s6 = { envelopeCm3: r.envelopeCm3 };
  s6Run = { scan, r };
  assert.equal(r.info.method, 'shape', 'found by shape');
  checks();
  assert.ok(plates.ok, `the plates touching the part within ${LIMITS.plateMm} mm of ${e.plates_touching_mm} (Nov 5 rule): ${plates.why || `found ${JSON.stringify(plates.plates)}`}`);
});

/** A leveled worker-grid mask read back on the scan-axes worker grid (dims), nearest leveled voxel. orient: the leveled
    grid on the loaded grid ({ R, center, origin }, loaded voxels); L: the leveled worker grid's dims. */
function mappedBack(mask, L, dims, orient) {
  const { nx, ny, nz } = dims, out = new Uint8Array(nx * ny * nz), off = (BIN - 1) / 2, { R, center: c, origin: o } = orient;
  for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
    const d = [BIN * x + off - c[0], BIN * y + off - c[1], BIN * z + off - c[2]];
    const b = [0, 1, 2].map((k) => Math.round((R[3 * k] * d[0] + R[3 * k + 1] * d[1] + R[3 * k + 2] * d[2] - o[k] - off) / BIN));
    if (b[0] >= 0 && b[1] >= 0 && b[2] >= 0 && b[0] < L.nx && b[1] < L.ny && b[2] < L.nz) out[i] = mask[b[0] + L.nx * (b[1] + L.ny * b[2])];
  }
  return out;
}

/** The inverse direction: a scan-axes worker-grid mask on the leveled worker grid L, nearest scan voxel. */
function mappedForward(mask, L, dims, orient) {
  const { nx, ny, nz } = dims, out = new Uint8Array(L.nx * L.ny * L.nz), off = (BIN - 1) / 2, { R, center: c, origin: o } = orient;
  for (let z = 0, i = 0; z < L.nz; z++) for (let y = 0; y < L.ny; y++) for (let x = 0; x < L.nx; x++, i++) {
    const q = [BIN * x + off + o[0], BIN * y + off + o[1], BIN * z + off + o[2]];
    const b = [0, 1, 2].map((k) => Math.round((R[k] * q[0] + R[3 + k] * q[1] + R[6 + k] * q[2] + c[k] - off) / BIN));
    if (b[0] >= 0 && b[1] >= 0 && b[2] >= 0 && b[0] < nx && b[1] < ny && b[2] < nz) out[i] = mask[b[0] + nx * (b[1] + ny * b[2])];
  }
  return out;
}
const diceOf = (a, b) => { let x = 0, y = 0, both = 0; for (let i = 0; i < a.length; i++) { x += a[i]; y += b[i]; both += a[i] & b[i]; } return (2 * both) / (x + y); };

// Leveling (Apply, or the automatic re-level of a scan leveled before holder removal) saves the scan-axes holder with
// the sample (vb_orientrail.js carryHolder, vb_holderreview.js carriedRecord) and reopens the scan leveled, where the
// grid keeps only the part plus 2 mm of air; the leveled build uses the carried pieces (finding the holder again there
// fitted plate stubs badly: Dice 0.953, 11-07). Level as the rail does (partMask, levelFromMask, surfacePoints,
// gridForPoints with its margin), carry the holder, save and reopen at binFactor F (toNative, onGrid, resample). Dice:
// the leveled mask mapped back onto the Nov 5 grid (nearest voxel) against the Nov 5 part mask.
test('Sample 6 (32 s) leveled with the carried holder: Dice, no warning, envelope as in scan axes', { skip: why('s6_32s', 's6_b4_part.npy', 's6_b4_holder.npy') }, async () => {
  const e = EXPECTED.s6;
  if (!s6Run) { const scan = await readScan(path.join(HOLD, 's6_32s')); s6Run = { scan, r: build(scan, e.body_threshold) }; }
  const { scan, r } = s6Run, marginVox = Math.round(2 / scan.voxelMm); // vb_orientrail.js MARGIN_MM over the loaded voxel
  const L = O.levelFromMask(r.body.filled, r.vol.dims, BIN), pts = O.surfacePoints(r.body.filled, r.vol.dims, BIN); // the worker grid: bin BIN
  const native = O.toNative({ R: L.R, center: L.center, ...O.gridForPoints({ R: L.R, center: L.center }, pts, BIN, marginVox) }, F);
  const page = { method: r.info.method, given: false, pieces: Fr.piecesToNative(r.info.pieces, { bin: BIN, binFactor: F }, null), givenBack: r.info.givenBack, stls: [] };
  const record = Rv.carriedRecord(page, null); // what Apply saves with the sample
  const orient = O.onGrid(native, F), t0 = Date.now();
  const slices = O.resample({ slices: scan.slices, dims: scan.dims, circle: scan.circle, orient });
  const resampleSeconds = (Date.now() - t0) / 1000;
  const lev = build({ slices, dims: { ...orient.dims }, voxelMm: scan.voxelMm, circle: null }, e.body_threshold, [], { ...native, holder_removed: true }, record);
  const back = mappedBack(lev.body.filled, lev.vol.dims, r.vol.dims, orient), d = dice(back, r.vol.dims, path.join(HOLD, 's6_b4_part.npy'));
  // The Dice the two nearest-neighbor mappings cost on their own: the scan-axes mask taken to the leveled grid and back.
  const floor = diceOf(mappedBack(mappedForward(r.body.filled, lev.vol.dims, r.vol.dims, orient), lev.vol.dims, r.vol.dims, orient), r.body.filled);
  console.log('S6 32 s leveled', JSON.stringify({ ...describe(lev), carried: lev.prep.carried, given: lev.prep.given, scanAxesCm3: +r.envelopeCm3.toFixed(3), vsScanAxes: `${(100 * (lev.envelopeCm3 / r.envelopeCm3 - 1)).toFixed(2)} %`,
    findSeconds: +(lev.times.find / 1000).toFixed(1), resampleSeconds: +resampleSeconds.toFixed(1), leveledDims: orient.dims, ambiguousAxes: L.ambiguous,
    diceVsScanAxes: +diceOf(back, r.body.filled).toFixed(4), diceVsNov5Part: +d.toFixed(4), diceMappingFloor: +floor.toFixed(4),
    information: 'Dice of the leveled mask mapped back (nearest voxel); diceMappingFloor: the scan-axes mask mapped there and back' }));
  assert.equal(lev.prep.carried, true, 'built from the carried pieces, not found again');
  assert.ok(d >= LIMITS.dice, `Dice ${d.toFixed(4)} against the Nov 5 part, mapped back`);
  assert.equal(lev.info.warning, null, `no warning: ${lev.info.warning}`);
  assert.ok(within(lev.envelopeCm3, r.envelopeCm3, LIMITS.envelope), `leveled envelope ${lev.envelopeCm3.toFixed(3)} vs ${r.envelopeCm3.toFixed(3)} cm3 in scan axes`);
  assert.equal(lev.times.find, 0, 'findHolder not run');
  assert.ok(lev.times.build / 1000 <= LIMITS.holderSeconds, `the leveled mask build took ${(lev.times.build / 1000).toFixed(1)} s`);
});

// Agreement with the 32 s scan is informative (Matt, 11-07): the high-res scan keeps an artifact strip in the last slices
// of the field as part (cone-beam end-slice gray; deferred to the field-of-view item of the next design). The holder
// time stays a pass requirement.
test('Sample 6 high-res: agreement with the 32 s scan (informative), holder time', { skip: why('s6_32s', 's6_high', 's6_b4_part.npy', 's6_b4_holder.npy') }, async () => {
  const e = EXPECTED.s6, r = build(await readScan(path.join(HOLD, 's6_high')), e.body_threshold);
  judge('S6 high-res (information: against the 32 s Nov 5 masks)', r, e, 's6_b4_part.npy', 's6_b4_holder.npy');
  console.log('S6 high-res vs 32 s (informative)', JSON.stringify({ envelopeCm3: +r.envelopeCm3.toFixed(3), thirtyTwoSecondsCm3: s6 && +s6.envelopeCm3.toFixed(3),
    difference: s6 ? `${(100 * (r.envelopeCm3 / s6.envelopeCm3 - 1)).toFixed(2)} %` : 'the 32 s test did not run',
    cause: 'an artifact strip in the last slices of the field is kept as part (end-slice gray fails the even-gray cue)' }));
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
test('Sample 4 with a stand-in post STL (informative)', { skip: why('s4', 's4_b4_part.npy', 'stl') }, async (t) => {
  if (!fs.readdirSync(path.join(HOLD, 'stl')).some((n) => n.startsWith('ct_base_big'))) { t.skip('holder/stl has no ct_base_big STL'); return; }
  const scan = s4Scan || await readScan(path.join(HOLD, 's4')), r = build(scan, EXPECTED.s4.body_threshold, ['ct_base_big']);
  const d = dice(r.body.filled, r.vol.dims, path.join(HOLD, 's4_b4_part.npy'));
  console.log('S4 STL (informative)', JSON.stringify({ ...describe(r), dice: +d.toFixed(4), stlBudgetSeconds: LIMITS.stlHolderSeconds }));
});
