'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CT = require('../app/ct_core.js');

const LOCAL = process.env.VOXELBENCH_LOCAL_DIR || '';
const REAL_DIR = LOCAL && path.join(LOCAL, 'scan'); // a local scan folder; tests that need it skip without it
const REF_PATH = LOCAL && path.join(LOCAL, 'real_stack_reference.json');
const haveReal = Boolean(REAL_DIR) && fs.existsSync(REAL_DIR) && fs.existsSync(REF_PATH);
const REF = haveReal ? JSON.parse(fs.readFileSync(REF_PATH, 'utf8')) : null;
const DIMS = { nx: 4, ny: 3, nz: 2 };

/** Little-endian TIFF with the same tag layout as the real scans; `over` replaces or removes tags. */
function tiff(w, h, values, over = {}) {
  const tags = { 256: [3, w], 257: [3, h], 258: [3, 16], 259: [3, 1], 273: [4, 8], 277: [3, 1], 278: [3, h],
    279: [4, w * h * 2], 282: [5, 'res'], 283: [5, 'res'], 296: [3, 3], 339: [3, 1], ...over };
  const ids = Object.keys(tags).map(Number).filter((k) => tags[k]).sort((a, b) => a - b);
  const ifd = 8 + w * h * 2;
  const res = ifd + 2 + ids.length * 12 + 4;
  const buf = new ArrayBuffer(res + 8);
  const d = new DataView(buf);
  d.setUint16(0, 0x4949, true); d.setUint16(2, 42, true); d.setUint32(4, ifd, true);
  values.forEach((v, i) => d.setUint16(8 + i * 2, v, true));
  d.setUint16(ifd, ids.length, true);
  ids.forEach((id, i) => {
    const e = ifd + 2 + i * 12; const [type, val] = tags[id];
    d.setUint16(e, id, true); d.setUint16(e + 2, type, true); d.setUint32(e + 4, 1, true);
    if (val === 'res') d.setUint32(e + 8, res, true);
    else if (type === 3) d.setUint16(e + 8, val, true);
    else d.setUint32(e + 8, val, true);
  });
  d.setUint32(res, 16378677, true); d.setUint32(res + 4, 65536, true);
  return buf;
}

/** 4 x 3 x 2 volume whose value encodes its position: 100z + 10y + x + 1. */
function volume() {
  const slices = [];
  for (let z = 0; z < 2; z++) {
    const s = new Uint16Array(12);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) s[y * 4 + x] = 100 * z + 10 * y + x + 1;
    slices.push(s);
  }
  return slices;
}

test('parseTiff reads pixels and the voxel size from the resolution tag', () => {
  const t = CT.parseTiff(tiff(2, 2, [0, 7, 65535, 3000]));
  assert.equal(t.width, 2); assert.equal(t.height, 2);
  assert.deepEqual(Array.from(t.pixels), [0, 7, 65535, 3000]);
  assert.ok(Math.abs(t.voxelMm - 0.040013) < 1e-5);
});

test('parseTiff converts inch resolution units', () => {
  const t = CT.parseTiff(tiff(1, 1, [1], { 296: [3, 2] }));
  assert.ok(Math.abs(t.voxelMm - 25.4 / (16378677 / 65536)) < 1e-9);
});

test('parseTiff refuses files it cannot read correctly, and says why', () => {
  assert.throws(() => CT.parseTiff(tiff(1, 1, [1], { 259: [3, 5] })), /compress/i);
  assert.throws(() => CT.parseTiff(tiff(1, 1, [1], { 258: [3, 8] })), /16-bit/);
  assert.throws(() => CT.parseTiff(tiff(1, 1, [1], { 339: [3, 3] })), /unsigned/);
  assert.throws(() => CT.parseTiff(tiff(1, 1, [1], { 282: null })), /resolution/i);
  assert.throws(() => CT.parseTiff(new ArrayBuffer(16)), /not a little-endian TIFF/i);
});

test('groupStacks groups by folder, sorts by the number in the name, ignores other files', () => {
  const f = (p) => ({ webkitRelativePath: p });
  const out = CT.groupStacks([f('scans/S2/S2_10.tiff'), f('scans/S2/S2_9.tiff'), f('scans/S2/.DS_Store'),
    f('scans/S2/._S2_1.tiff'), f('scans/S1/a1.tif'), f('scans/notes.txt')]);
  assert.deepEqual(out.map((s) => s.folder), ['S1', 'S2']);
  assert.deepEqual(out[1].files.map((x) => x.webkitRelativePath), ['scans/S2/S2_9.tiff', 'scans/S2/S2_10.tiff']);
});

test('sampleInfo gives the folder name and blank fields for a sample nobody described', () => {
  assert.deepEqual(CT.sampleInfo('S9', new Map()), { folder: 'S9', name: 'S9', material: '', process: '', notes: '', calibration_air: true, cad: null, bookmarks: [] });
});

test('sampleInfo returns the fields a user stored for the folder', () => {
  const m = new Map([['S2', { id: 'S2', folder: 'S2', name: 'Cube A', material: 'PA12', process: 'SLS', notes: 'first build', calibration_air: false, updated_at: 't' }]]);
  assert.deepEqual(CT.sampleInfo('S2', m), { folder: 'S2', name: 'Cube A', material: 'PA12', process: 'SLS', notes: 'first build', calibration_air: false, cad: null, bookmarks: [] });
});

test('extractPlane returns the right voxels in every plane', () => {
  const v = volume();
  assert.deepEqual(Array.from(CT.extractPlane(v, DIMS, 'XY', 1)), Array.from(v[1]));
  assert.deepEqual(Array.from(CT.extractPlane(v, DIMS, 'XZ', 2)), [21, 22, 23, 24, 121, 122, 123, 124]);
  assert.deepEqual(Array.from(CT.extractPlane(v, DIMS, 'YZ', 3)), [4, 14, 24, 104, 114, 124]);
});

test('voxelOf agrees with the value extractPlane shows at that pixel, in every plane', () => {
  const v = volume();
  for (const plane of ['XY', 'XZ', 'YZ']) {
    const { width, height, depth } = CT.planeShape(plane, DIMS);
    for (let slice = 0; slice < depth; slice++) {
      const img = CT.extractPlane(v, DIMS, plane, slice);
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        const { x, y, z } = CT.voxelOf(plane, slice, col, row);
        assert.equal(img[row * width + col], v[z][y * 4 + x], `${plane} ${slice} ${col},${row}`);
        assert.deepEqual(CT.planeOf(plane, { x, y, z }), { col, row, slice });
      }
    }
  }
});

test('canvasToPlane inverts the view transform and floors to a voxel', () => {
  const view = { scale: 2.5, offsetX: 10, offsetY: 20 };
  assert.deepEqual(CT.canvasToPlane(view, 10, 20, 100, 100), { col: 0, row: 0 });
  assert.deepEqual(CT.canvasToPlane(view, 12.4, 22.4, 100, 100), { col: 0, row: 0 });
  assert.deepEqual(CT.canvasToPlane(view, 12.5, 22.5, 100, 100), { col: 1, row: 1 });
  assert.equal(CT.canvasToPlane(view, 9, 20, 100, 100), null);
  assert.equal(CT.canvasToPlane(view, 10 + 250, 20, 100, 100), null);
});

test('zoomAt keeps the voxel under the cursor fixed', () => {
  const v = CT.zoomAt({ scale: 1, offsetX: 5, offsetY: 7 }, 105, 207, 4);
  assert.equal(v.scale, 4);
  assert.equal((105 - v.offsetX) / v.scale, 100);
  assert.equal((207 - v.offsetY) / v.scale, 200);
});

test('fitView centers the whole image inside the canvas', () => {
  assert.deepEqual(CT.fitView(100, 50, 400, 400), { scale: 4, offsetX: 0, offsetY: 100 });
});

test('scaleForWidthMm sets how many mm the XY pane shows across, and widthMmAtScale inverts it', () => {
  const s = CT.scaleForWidthMm(40, 0.04, 800);
  assert.equal(s, 0.8);
  assert.ok(Math.abs(CT.widthMmAtScale(s, 0.04, 800) - 40) < 1e-9);
});

test('centerOn puts a voxel in the middle of the pane at a given scale', () => {
  const v = CT.centerOn(2, 100, 50, 400, 300);
  assert.equal(v.offsetX + 100.5 * 2, 200);
  assert.equal(v.offsetY + 50.5 * 2, 150);
});

test('clampScale allows zooming out past fit, down to a limit, and up to a limit', () => {
  assert.equal(CT.clampScale(0.01, 0.5), 0.125);
  assert.equal(CT.clampScale(100, 0.5), 32);
  assert.equal(CT.clampScale(0.3, 0.5), 0.3);
});

test('autoWindow ignores exact zero and runs from 0 to the 99.9th percentile', () => {
  const s = new Uint16Array(4000);
  for (let i = 0; i < 2000; i++) s[i] = i + 1;
  const w = CT.autoWindow([s], { nx: 4000, ny: 1, nz: 1 }, 1);
  assert.equal(w.low, 0);
  assert.equal(w.high, 1998); // numpy.percentile convention: rank 0.999 x (n - 1)
  assert.equal(w.max, 2000);
});

test('grayToRgba maps the window linearly and clips; exact zero is just dark, because dark pores read zero too', () => {
  const out = new Uint8ClampedArray(16);
  CT.grayToRgba(Uint16Array.from([0, 1000, 2000, 4000]), 1000, 3000, out);
  assert.deepEqual(Array.from(out.slice(0, 4)), [0, 0, 0, 255]);
  assert.deepEqual(Array.from(out.slice(4, 8)), [0, 0, 0, 255]);
  assert.deepEqual(Array.from(out.slice(8, 12)), [128, 128, 128, 255]);
  assert.deepEqual(Array.from(out.slice(12, 16)), [255, 255, 255, 255]);
});

test('fitCircle recovers a circle that overflows the image, and chordAt gives its edges', () => {
  const w = 200, h = 120, cx = 100.5, cy = 70.5, r = 100;
  const s = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < r * r) s[y * w + x] = 500;
  const c = CT.fitCircle(s, w, h);
  assert.ok(Math.abs(c.cx - cx) < 1 && Math.abs(c.cy - cy) < 1 && Math.abs(c.r - r) < 1, JSON.stringify(c));
  const [a, b] = CT.chordAt(c, c.cy);
  assert.ok(Math.abs(a - (c.cx - c.r)) < 1e-9 && Math.abs(b - (c.cx + c.r)) < 1e-9);
  assert.equal(CT.chordAt(c, c.cy + c.r + 1), null);
  const [top, bottom] = CT.chordAt(c, c.cx, 'x');
  assert.ok(Math.abs(top - (c.cy - c.r)) < 1e-9 && Math.abs(bottom - (c.cy + c.r)) < 1e-9);
});

test('insideCircle uses the voxel center', () => {
  const c = { cx: 10, cy: 10, r: 5 };
  assert.equal(CT.insideCircle(c, 9, 9), true);
  assert.equal(CT.insideCircle(c, 14, 14), false);
  assert.equal(CT.insideCircle(null, 99, 99), true);
});

test('fitCircle returns null when the reconstruction circle does not show', () => {
  assert.equal(CT.fitCircle(new Uint16Array(100).fill(9), 10, 10), null);
});

const BASE = { sample: { folder: 'S2', name: 'Cube A', material: 'PA12', process: 'SLS', notes: '' },
  dims: { nx: 1392, ny: 784, nz: 503 }, voxelMm: 0.04, window: { low: 0, high: 3000 }, id: 'a1', now: '2026-11-02T12:00:00Z' };

test('makeAnnotation stores full-resolution voxels and mm for a point in the XZ plane', () => {
  const a = CT.makeAnnotation({ ...BASE, plane: 'XZ', slice: 300, kind: 'point', type: 'pore', note: 'round', points: [{ col: 200, row: 100 }] });
  assert.equal(a.schema, 1); assert.equal(a.plane, 'XZ'); assert.equal(a.slice, 300);
  assert.deepEqual(a.voxels, [{ x: 200, y: 300, z: 100 }]);
  assert.deepEqual(a.mm, [{ x: 8, y: 12, z: 4 }]);
  assert.equal(a.tiff_file_number, 101);
  assert.equal(a.sample.material, 'PA12');
  assert.deepEqual(a.window, { low: 0, high: 3000 });
  assert.equal(a.gray_calibrated, false);
});

test('makeAnnotation measures a caliper in mm', () => {
  const a = CT.makeAnnotation({ ...BASE, plane: 'XY', slice: 10, kind: 'caliper', type: 'crack', note: '', points: [{ col: 0, row: 0 }, { col: 30, row: 40 }] });
  assert.ok(Math.abs(a.length_mm - 2) < 1e-9);
});

test('makeAnnotation measures a polygon area in mm squared, in the YZ plane', () => {
  const a = CT.makeAnnotation({ ...BASE, plane: 'YZ', slice: 5, kind: 'polygon', type: 'mid_gray_blob', note: '',
    points: [{ col: 0, row: 0 }, { col: 10, row: 0 }, { col: 10, row: 10 }, { col: 0, row: 10 }] });
  assert.ok(Math.abs(a.area_mm2 - 0.16) < 1e-9);
  assert.deepEqual(a.voxels[1], { x: 5, y: 10, z: 0 });
});

test('makeAnnotation drops repeated consecutive polygon points from a double click', () => {
  const a = CT.makeAnnotation({ ...BASE, plane: 'XY', slice: 5, kind: 'polygon', type: 'other', note: '',
    points: [{ col: 0, row: 0 }, { col: 0, row: 0 }, { col: 10, row: 0 }, { col: 10, row: 10 }] });
  assert.equal(a.voxels.length, 3);
});

test('makeAnnotation refuses malformed input', () => {
  const ok = { ...BASE, plane: 'XY', slice: 0, note: '' };
  assert.throws(() => CT.makeAnnotation({ ...ok, kind: 'caliper', type: 'crack', points: [{ col: 0, row: 0 }] }), /2 points/);
  assert.throws(() => CT.makeAnnotation({ ...ok, kind: 'polygon', type: 'crack', points: [{ col: 0, row: 0 }, { col: 1, row: 1 }] }), /3 points/);
  assert.throws(() => CT.makeAnnotation({ ...ok, kind: 'point', type: 'doped', points: [{ col: 0, row: 0 }] }), /type/);
  assert.throws(() => CT.makeAnnotation({ ...ok, kind: 'point', type: 'pore', points: [{ col: 1392, row: 0 }] }), /outside/);
  assert.throws(() => CT.makeAnnotation({ ...ok, kind: 'point', type: 'pore', voxelMm: NaN, points: [{ col: 0, row: 0 }] }), /voxel/);
});

test('the feature types make no composition claim', () => {
  for (const t of CT.FEATURE_TYPES) assert.doesNotMatch(t.id + t.label, /dop|natural|graphite|density/i);
});

test('REAL STACK: parser, planes and circle match tifffile', { skip: !haveReal }, () => {
  const names = fs.readdirSync(REAL_DIR).filter((n) => n.endsWith('.tiff')).sort();
  assert.equal(names.length, REF.shape_zyx[0]);
  const slices = [];
  let voxelMm;
  for (const n of names) {
    const b = fs.readFileSync(path.join(REAL_DIR, n));
    assert.equal(b.length, REF.file_bytes);
    const t = CT.parseTiff(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    assert.equal(t.width, REF.shape_zyx[2]); assert.equal(t.height, REF.shape_zyx[1]);
    slices.push(t.pixels); voxelMm = t.voxelMm;
  }
  const dims = { nx: REF.shape_zyx[2], ny: REF.shape_zyx[1], nz: REF.shape_zyx[0] };
  assert.ok(Math.abs(voxelMm - REF.voxel_mm) < 1e-5);
  for (const p of REF.pixels) assert.equal(slices[p.z][p.y * dims.nx + p.x], p.value);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  assert.equal(sum(CT.extractPlane(slices, dims, 'XY', 251)), REF.xy_z251_sum);
  assert.equal(sum(CT.extractPlane(slices, dims, 'XZ', 300)), REF.xz_y300_sum);
  assert.equal(sum(CT.extractPlane(slices, dims, 'YZ', 696)), REF.yz_x696_sum);
  const c = CT.fitCircle(slices[251], dims.nx, dims.ny);
  assert.ok(Math.abs(c.cx - REF.circle.cx) < 1 && Math.abs(c.cy - REF.circle.cy) < 1 && Math.abs(c.r - REF.circle.r) < 1, JSON.stringify(c));
  const w = CT.autoWindow(slices, dims, 8);
  assert.ok(Math.abs(w.high - REF.autowindow_high_about) < 60, JSON.stringify(w));
});

test('sampleRecord merges changes into the saved sample, keeping fields other steps wrote', () => {
  const samples = new Map([['S1', { id: 'S1', folder: 'S1', name: 'Bar', material: 'PA12', process: '', notes: '', calibration_air: false, cad: { file: 'bar.stl', rms_mm: 0.01 } }]]);
  const r = CT.sampleRecord('S1', samples, { name: 'Bar 2' });
  assert.equal(r.name, 'Bar 2');
  assert.equal(r.calibration_air, false);
  assert.deepEqual(r.cad, { file: 'bar.stl', rms_mm: 0.01 });
  assert.equal(r.id, 'S1'); assert.ok(r.updated_at);
  const fresh = CT.sampleRecord('S2', samples, { cad: { file: 'x.stl' } });
  assert.equal(fresh.name, 'S2'); assert.equal(fresh.calibration_air, true); assert.deepEqual(fresh.cad, { file: 'x.stl' });
  assert.equal(CT.sampleInfo('S1', samples).cad.file, 'bar.stl');
  assert.equal(CT.sampleInfo('S2', samples).cad, null);
});

test('sampleRecord merges a pending (not yet stored) edit before the new changes', () => {
  const samples = new Map([['S1', { id: 'S1', folder: 'S1', name: 'Old', notes: 'old notes' }]]);
  const pending = { id: 'S1', folder: 'S1', name: 'New', notes: 'new notes', _collection: 'samples' };
  const r = CT.sampleRecord('S1', samples, { cad: { file: 'p.stl' } }, pending);
  assert.equal(r.name, 'New'); assert.equal(r.notes, 'new notes'); assert.equal(r.cad.file, 'p.stl');
  assert.equal(r._collection, undefined);
});

test('dimensionCheck: deviation from nominal, passing inside the asymmetric band and on its edges', () => {
  assert.deepEqual(CT.dimensionCheck(10.05, 10, 0.1, 0.05), { deviation: 0.05000000000000071, pass: true });
  assert.equal(CT.dimensionCheck(9.9, 10, 0.1, 0.05).pass, true);
  assert.equal(CT.dimensionCheck(9.89, 10, 0.1, 0.05).pass, false);
  assert.equal(CT.dimensionCheck(10.06, 10, 0.1, 0.05).pass, false);
  assert.deepEqual(CT.dimensionCheck(10, null, 0.1, 0.1), { deviation: null, pass: null });
});

test('compareRuns lists before, after and change; a metric an old run lacks is n/a, never 0', () => {
  const after = { summary: { all_void_percent_of_body: 5.25, pore_count: 100, crack_like_count: 10, body_volume_mm3: 800 }, open_closed: { open_percent: 4.5, closed_percent: 0.75 }, filler: { summary: { volume_percent: 0.6 } }, wall: { min_mm: 0.28 } };
  const before = { summary: { all_void_percent_of_body: 7.0, pore_count: 120, crack_like_count: 8, body_volume_mm3: 900 } };
  const rows = CT.compareRuns(before, after);
  const row = (k) => rows.find((r) => r.key === k);
  assert.deepEqual([row('porosity').before, row('porosity').after], [7, 5.25]);
  assert.ok(Math.abs(row('porosity').change + 1.75) < 1e-12);
  assert.equal(row('open').before, null); assert.equal(row('open').change, null); assert.equal(row('open').after, 4.5);
  assert.ok(rows.every((r) => typeof r.label === 'string' && r.label.length));
});

test('sampleRecord keeps every stored field, bookmarks included, when another field is saved', () => {
  const samples = new Map([['S1', { id: 'S1', folder: 'S1', name: 'Bar', bookmarks: [{ name: 'crack', main: 'XY', cursor: { x: 1, y: 2, z: 3 } }], future_field: 7 }]]);
  const r = CT.sampleRecord('S1', samples, { notes: 'n' });
  assert.equal(r.bookmarks.length, 1); assert.equal(r.future_field, 7); assert.equal(r.notes, 'n');
  assert.deepEqual(CT.sampleInfo('S1', samples).bookmarks, samples.get('S1').bookmarks);
  assert.deepEqual(CT.sampleInfo('S2', samples).bookmarks, []);
});

test('dimensionCheck treats a tolerance never entered as 0, the same on the page and in the CSV', () => {
  assert.equal(CT.dimensionCheck(3.84, 3.8, undefined, 0.05).pass, true);
  assert.equal(CT.dimensionCheck(3.76, 3.8, undefined, 0.05).pass, false);
  assert.equal(CT.dimensionCheck(3.8, 3.8, null, null).pass, true);
});

test('errorStep sends a worker error to the step whose request failed', () => {
  assert.equal(CT.errorStep('cad'), 'cad');
  assert.equal(CT.errorStep('filler'), 'filler');
  assert.equal(CT.errorStep('wall'), 'wall');
  for (const t of ['volume', 'model', 'detect', 'slice', 'slicesDone', 'voidMeshes']) assert.equal(CT.errorStep(t), 'pores', t);
  assert.equal(CT.errorStep('zones'), 'zones');
  assert.equal(CT.errorStep('sheet'), 'sheet');
  assert.equal(CT.errorStep('regionRuns'), 'crosscheck');
  assert.equal(CT.errorStep('crosscheck'), 'crosscheck');
  assert.equal(CT.errorStep('partMask'), 'orient');
  assert.equal(CT.errorStep(undefined), null, 'unknown: every waiting step');
});

test('archimedesComparison: sealed bulk density against CT total, unsealed apparent density against CT closed', () => {
  const sealed = CT.archimedesComparison({ density_g_cm3: 0.95, solid_g_cm3: 1.01, method: 'sealed' }, { total_percent: 5.49, closed_percent: 0.75 });
  assert.ok(Math.abs(sealed.porosity_percent - 100 * (1 - 0.95 / 1.01)) < 1e-9);
  assert.equal(sealed.ct_label, 'total');
  assert.equal(sealed.ct_percent, 5.49);
  assert.ok(Math.abs(sealed.difference - (5.49 - sealed.porosity_percent)) < 1e-9);
  const open = CT.archimedesComparison({ density_g_cm3: 1.0, solid_g_cm3: 1.01, method: 'unsealed' }, { total_percent: 5.49, closed_percent: 0.75 });
  assert.equal(open.ct_label, 'closed'); assert.equal(open.ct_percent, 0.75);
  assert.equal(CT.archimedesComparison({ density_g_cm3: 1.0, solid_g_cm3: 1.01, method: 'unsealed' }, { total_percent: 5.49, closed_percent: null }).ct_percent, null);
  assert.equal(CT.archimedesComparison(null, { total_percent: 5 }), null);
  assert.equal(CT.archimedesComparison({ density_g_cm3: 1.2, solid_g_cm3: 1.01, method: 'sealed' }, { total_percent: 5 }).refused, 'The measured density is above the solid density.');
});
