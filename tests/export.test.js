'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../app/ct_export.js');

test('poreCsv writes settings as comments, one row per pore, and the review status', () => {
  const pores = [{ id: 1, x: 10.5, y: 20.5, z: 30.5, x_mm: 0.42, y_mm: 0.82, z_mm: 1.22, volume_mm3: 0.5, diameter_mm: 0.98, elongation: 1.2, crack_like: false, clipped: false },
    { id: 2, x: 1.5, y: 2.5, z: 3.5, x_mm: 0.06, y_mm: 0.1, z_mm: 0.14, volume_mm3: 0.1, diameter_mm: 0.57, elongation: 4, crack_like: true, clipped: false }];
  const csv = E.poreCsv(pores, new Set([2]), { sample: { folder: 'S2', name: 'Cube A', material: 'PA12', process: 'SLS' }, settings: { poreThreshold: 1300 }, summary: { pore_count: 1 } });
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /^# /);
  assert.ok(lines.some((l) => l.startsWith('#') && l.includes('PA12') && l.includes('SLS')));
  assert.ok(lines.some((l) => l.startsWith('#') && l.includes('poreThreshold')));
  assert.ok(lines.some((l) => l.startsWith('#') && /uncalibrated/i.test(l)));
  const rows = lines.filter((l) => !l.startsWith('#'));
  assert.equal(rows[0], 'id,x_voxel,y_voxel,z_voxel,x_mm,y_mm,z_mm,volume_mm3,equivalent_diameter_mm,elongation,crack_like,clipped,rejected');
  assert.equal(rows[1], '1,10.5,20.5,30.5,0.42,0.82,1.22,0.5,0.98,1.2,false,false,false');
  assert.equal(rows[2], '2,1.5,2.5,3.5,0.06,0.1,0.14,0.1,0.57,4,true,false,true');
});

test('annotationCsv quotes notes with commas and quotes, and flattens the points', () => {
  const a = { id: 'a1', created_at: 't', sample: { folder: 'S2', name: 'Cube A', material: 'PA12', process: 'SLS' }, plane: 'XY', slice: 5, kind: 'caliper', type: 'crack',
    note: 'long, "wide" crack', length_mm: 2, voxels: [{ x: 1, y: 2, z: 5 }, { x: 3, y: 4, z: 5 }], mm: [{ x: 0.04, y: 0.08, z: 0.2 }, { x: 0.12, y: 0.16, z: 0.2 }], window: { low: 0, high: 3000 } };
  const lines = E.annotationCsv([a]).trim().split('\n');
  assert.equal(lines[0], 'id,created_at,folder,name,material,process,plane,slice,kind,type,length_mm,area_mm2,window_low,window_high,note,voxels_xyz,mm_xyz');
  assert.ok(lines[1].includes('"long, ""wide"" crack"'));
  assert.ok(lines[1].includes('1 2 5;3 4 5'));
  assert.ok(lines[1].includes(',2,,0,3000,'));
});

test('poreChunks splits rows so each stored document stays under the size limit', () => {
  const pores = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, x: 1000.5, y: 500.5, z: 200.5, volume_mm3: 0.123456789, diameter_mm: 0.5, elongation: 1.5, crack_like: false }));
  const chunks = E.poreChunks(pores, new Set([3]));
  assert.ok(chunks.length > 1);
  assert.equal(chunks.reduce((s, c) => s + c.rows.length, 0), 5000);
  for (const c of chunks) assert.ok(JSON.stringify(c).length < 200 * 1024);
  assert.deepEqual(chunks[0].columns.slice(0, 2), ['id', 'x_voxel']);
  assert.equal(chunks[0].rows[2][chunks[0].columns.indexOf('rejected')], true);
});

test('regionCsv reports each region with its assigned label and density estimate columns', () => {
  const lines = E.regionCsv([{ id: 'r1', label: 'region_a', plane: 'XZ', slice_from: 1, slice_to: 5, note: 'n', stats: { voxels: 10, volume_mm3: 1, gray_mean: 2000, gray_sd: 5, matrix_gray_mean: 2100, pore_fraction: 0.02, pore_count: 3 }, density: { relative: 1, g_cm3: 1.01 } }]).trim().split('\n');
  assert.ok(lines.some((l) => l.startsWith('#') && /assignments, not measurements/i.test(l)));
  assert.ok(lines.some((l) => l.startsWith('#') && /estimate/i.test(l)));
  const rows = lines.filter((l) => !l.startsWith('#'));
  assert.ok(rows[0].includes('relative_density'));
  assert.ok(rows[1].startsWith('r1,region_a,XZ,1,5,'));
});

test('zipStream writes a deflated npy that inflates back to the original bytes', async () => {
  const zlib = require('node:zlib');
  const parts = [new Uint8Array(100000).fill(0), Uint8Array.from([1, 2, 3])];
  const blob = await E.zipStream('a.npy', parts);
  const zip = new Uint8Array(await blob.arrayBuffer());
  const d = new DataView(zip.buffer);
  assert.equal(d.getUint32(0, true), 0x04034b50);
  assert.equal(d.getUint16(8, true), 8);
  const packed = d.getUint32(18, true);
  const raw = zlib.inflateRawSync(zip.subarray(30 + 5, 30 + 5 + packed));
  assert.equal(raw.length, 100003);
  assert.equal(raw[100002], 3);
  assert.equal(d.getUint32(14, true), zlib.crc32(raw));
});

test('npyHeader starts a file whose data begins on a 64-byte boundary', () => {
  const h = E.npyHeader('<u2', [1, 2, 3]);
  assert.equal(h.length % 64, 0);
  assert.deepEqual([...h.slice(0, 8)], [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  const text = new TextDecoder().decode(h.slice(10));
  assert.match(text, /'descr': '<u2'/);
  assert.match(text, /'fortran_order': False/);
  assert.match(text, /'shape': \(1, 2, 3\)/);
  assert.ok(text.endsWith('\n'));
});

test('maskParts yields a NumPy header, then one slice of pore ids per z, 16-bit when the ids fit', () => {
  const dims = { nx: 2, ny: 1, nz: 2 };
  const parts = [...E.maskParts(dims, 3, (z, out) => { out[0] = z + 1; out[1] = 3; })];
  assert.equal(parts.length, 3);
  assert.match(new TextDecoder().decode(parts[0]), /'<u2'.*\(2, 1, 2\)/);
  assert.deepEqual([...new Uint16Array(parts[2].buffer)], [2, 3]);
  const wide = [...E.maskParts(dims, 70000, (z, out) => { out[0] = 70000; })];
  assert.match(new TextDecoder().decode(wide[0]), /'<u4'/);
});

test('patchCsv states that low-density regions are excluded from porosity and writes one row per region', () => {
  const lines = E.patchCsv([{ id: 1, x: 10, y: 20, z: 30, x_mm: 0.4, y_mm: 0.8, z_mm: 1.2, volume_mm3: 0.5, diameter_mm: 0.98, gray_mean: 1640, relative_gray: 0.68 }], { sample: { folder: 'S2', name: 'Cube A', material: 'PA12', process: 'SLS' } }).trim().split('\n');
  assert.ok(lines.some((l) => l.startsWith('#') && /excluded from porosity/i.test(l)));
  assert.ok(lines.some((l) => l.startsWith('#') && /uncalibrated/i.test(l)));
  const rows = lines.filter((l) => !l.startsWith('#'));
  assert.equal(rows[0], 'id,x_voxel,y_voxel,z_voxel,x_mm,y_mm,z_mm,volume_mm3,equivalent_diameter_mm,gray_mean,relative_gray');
  assert.equal(rows[1], '1,10,20,30,0.4,0.8,1.2,0.5,0.98,1640,0.68');
});

test('zoneCsv states that zones are not composition and carries the assigned label', () => {
  const labels = [{ id: 'region_a', label: 'Region A' }, { id: 'region_b', label: 'Region B' }];
  const stats = [{ zone: 2, volume_mm3: 3477, void_percent: 2.26, solid_gray_mean: 2155, excess_median: 0.117 }, { zone: 5, volume_mm3: 10, void_percent: 1, solid_gray_mean: 2000, excess_median: 0 }];
  const lines = E.zoneCsv({ threshold: 0.075, axis: 'x', stats }, { 2: 'region_b' }, { sample: { folder: 'S2', name: 'S2' }, labels }).trim().split('\n');
  assert.ok(lines.some((l) => l.startsWith('#') && /not composition/i.test(l)));
  assert.ok(lines.some((l) => l.startsWith('#') && l.includes('0.075')));
  const rows = lines.filter((l) => !l.startsWith('#'));
  assert.equal(rows[0], 'zone,assigned_label,volume_mm3,porosity_percent,matrix_gray_mean,median_gray_offset,matrix_equivalent_density_g_cm3,matrix_equivalent_density_extrapolated');
  assert.equal(rows[1], 'high_gray,Region B,3477,2.26,2155,0.117,,');
  assert.equal(rows[2], 'drawn_region_b,unassigned,10,1,2000,0,,');
});

test('CSV headers carry the provenance line', () => {
  const provenance = 'Computed at 80 µm voxels (2× binned from 40 µm); smallest resolved pore ESD 0.24 mm; gray uncalibrated; VoxelBench 0.1.0';
  const ctx = { sample: { folder: 'S2', name: 'S2' }, settings: {}, summary: {}, provenance };
  for (const csv of [E.poreCsv([], new Set(), ctx), E.patchCsv([], ctx), E.zoneCsv({ threshold: 0.04, axis: 'x', stats: [] }, {}, ctx)]) {
    assert.ok(csv.split('\n').includes(`# ${provenance}`), csv.slice(0, 200));
  }
});

test('region and zone CSVs carry equivalent density only when calibrated', () => {
  const C = require('../app/vb_calibration.js');
  const fit = C.fitCalibration([{ name: 'Air', gray: 700, density: 0.0012 }, { name: 'rod', gray: 2000, density: 1.01 }]);
  const region = { id: 'r1', label: 'region_a', plane: 'XY', slice_from: 1, slice_to: 5, note: '', stats: { voxels: 10, volume_mm3: 1, gray_mean: 1990, gray_sd: 30, matrix_gray_mean: 2000, pore_fraction: 0.01, pore_count: 1 }, density: null };
  const air = { ...region, id: 'r2', stats: { ...region.stats, matrix_gray_mean: 300 } };
  const rows = E.regionCsv([region, air], { calibration: fit }).trim().split('\n');
  const data = rows.filter((l) => !l.startsWith('#'));
  const head = data[0].split(',');
  const at = (line, col) => line.split(',')[head.indexOf(col)];
  assert.ok(Math.abs(Number(at(data[1], 'equivalent_density_g_cm3')) - 1.01) < 1e-9);
  assert.equal(at(data[1], 'equivalent_density_extrapolated'), 'false');
  assert.equal(at(data[2], 'equivalent_density_extrapolated'), 'true');
  assert.ok(rows.some((l) => l.startsWith('#') && /equivalent density of the reference/i.test(l)));
  const plain = E.regionCsv([region], {}).trim().split('\n').filter((l) => !l.startsWith('#'));
  assert.equal(plain[1].split(',')[plain[0].split(',').indexOf('equivalent_density_g_cm3')], '');
  const zone = E.zoneCsv({ threshold: 0.04, axis: 'x', stats: [{ zone: 2, volume_mm3: 1, void_percent: 1, solid_gray_mean: 2000, excess_median: 0.1 }] }, {}, { sample: { folder: 'S', name: 'S' }, calibration: fit }).trim().split('\n').filter((l) => !l.startsWith('#'));
  const zh = zone[0].split(',');
  assert.ok(Math.abs(Number(zone[1].split(',')[zh.indexOf('matrix_equivalent_density_g_cm3')]) - 1.01) < 1e-9);
});

test('a calibrated export never also says uncalibrated', () => {
  const Cal = require('../app/vb_calibration.js');
  const fit = Cal.fitCalibration([{ name: 'Air', gray: 700, density: 0.0012 }, { name: 'rod', gray: 2000, density: 1.01 }]);
  const ctx = { sample: { folder: 'S', name: 'S' }, settings: {}, summary: {}, calibration: fit };
  for (const csv of [E.poreCsv([], new Set(), ctx), E.patchCsv([], ctx), E.zoneCsv({ threshold: 0.04, axis: 'x', stats: [] }, {}, ctx), E.regionCsv([], { calibration: fit })]) {
    assert.ok(!/uncalibrated/i.test(csv), csv.slice(0, 400));
    assert.ok(/equivalent density/i.test(csv));
  }
});
