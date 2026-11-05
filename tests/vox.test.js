'use strict';
// Rigaku scans: the .VOX volume (a Vox1999a text header, then 16-bit voxels) and DataInfo.xml (the scan record).
// The header and record below are captured from a Rigaku CT Lab HV export (2026-11); only the title path and the
// sample name are replaced. Everything else, spacing, scale and line breaks included, is as the scanner wrote it.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../app/vb_vox.js');
const CT = require('../app/ct_core.js');

const HEADER = 'Vox1999a\nVolumeCount 1\nTitle D:\\scanner\\CT_20261102_121613\\CT_20261102_121613.VOX\nCopyRight Rigaku Corp.\n##\f\n'
  + '##\nEndian L\nVolumeSize 1392 784 503\nVoxelSize 16\nVolumePosition 0 0 0\nVolumeScale 0.0400130004 0.0400130004 0.0400130004\n'
  + 'Field 0 (Position 0 Size 16 Name "data" Format ui Scale 0.588235 Offset -1294.118)\n//NOMIRROR\n//HX\n//Ver.1.3.0\n'
  + 'ModelMatrix (1.000,0.000,0.000,0.000,0.000,1.000,0.000,0.000,0.000,0.000,1.000,0.000,0.000,0.000,0.000,1.000)##\f\n';
const bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

test('the VOX header gives the size, voxel spacing, value scale and where the voxels start', () => {
  const h = X.parseVoxHeader(bytes(`${HEADER}\u0001\u0002`));
  assert.deepEqual([h.nx, h.ny, h.nz], [1392, 784, 503]);
  assert.equal(h.bits, 16);
  assert.equal(h.littleEndian, true);
  assert.deepEqual(h.voxelMm, [0.0400130004, 0.0400130004, 0.0400130004]);
  assert.equal(h.valueScale, 0.588235);
  assert.equal(h.valueOffset, -1294.118);
  assert.equal(h.dataStart, HEADER.length); // the header ends at its second "##\f\n"; its length follows the title
});

test('a header with a longer title still finds the voxels; a file that is not Vox1999a is refused', () => {
  const longer = HEADER.replace('D:\\scanner\\', 'D:\\a\\much\\longer\\folder\\');
  assert.equal(X.parseVoxHeader(bytes(longer)).dataStart, longer.length);
  assert.throws(() => X.parseVoxHeader(bytes('II*\u0000')), /not a Vox1999a/);
  assert.throws(() => X.parseVoxHeader(bytes(HEADER.replace('VoxelSize 16', 'VoxelSize 8'))), /16-bit/);
});

test('slice z is the bytes after the header, x fastest; a big-endian file is swapped', () => {
  const h = { ...X.parseVoxHeader(bytes(HEADER)), nx: 3, ny: 2, nz: 2 };
  assert.deepEqual(X.sliceRange(h, 1), [h.dataStart + 12, h.dataStart + 24]);
  const buf = new Uint8Array([1, 0, 2, 0, 0, 1, 255, 255, 7, 0, 8, 0]).buffer;
  assert.deepEqual([...X.sliceValues(buf, h)], [1, 2, 256, 65535, 7, 8]);
  assert.deepEqual([...X.sliceValues(buf, { ...h, littleEndian: false })], [256, 512, 1, 65535, 1792, 2048]);
});

const DATA_INFO = `<?xml version="1.0"?>
<CtAllInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <SampleInfo><Id>3</Id><SampleName1>Lab</SampleName1></SampleInfo>
  <StudyInfo><Id>5</Id><Study>sample_slab</Study><StudyCreateDate>2026-11-05T14:55:28.110</StudyCreateDate></StudyInfo>
  <SeriesInfo>
    <Series>145728</Series>
    <VolumeFileName>CT_20261105_145728.VOX</VolumeFileName>
    <SeriesCreateDate>2026-11-05T14:57:28.761</SeriesCreateDate>
    <KV>120</KV>
    <UA>350</UA>
    <FOV>56</FOV>
    <VoxelSize>40.00717</VoxelSize>
    <ScanMode>2x2</ScanMode>
    <ScanTime>4min 16sec </ScanTime>
    <Filter3D>0</Filter3D>
    <XrayFilter>None</XrayFilter>
    <Geometry>Short</Geometry>
    <AngleRange>360</AngleRange>
  </SeriesInfo>
  <ReconInfo>
    <Denoise>false</Denoise>
    <BeamHardeningCorrection>false</BeamHardeningCorrection>
  </ReconInfo>
</CtAllInfo>`;

test('DataInfo.xml gives the settings a gray value depends on', () => {
  const s = X.parseDataInfo(DATA_INFO);
  assert.equal(s.study, 'sample_slab');
  assert.equal(s.scannedAt, '2026-11-05T14:57:28.761');
  assert.equal(s.kv, 120);
  assert.equal(s.ua, 350);
  assert.equal(s.fovMm, 56);
  assert.equal(s.voxelUm, 40.00717);
  assert.equal(s.scanMode, '2x2');
  assert.equal(s.scanSeconds, 256);
  assert.equal(s.filter, 'None');
  assert.equal(s.beamHardeningCorrection, false);
  assert.equal(s.denoise, false);
  assert.equal(s.angleRange, 360);
});

test('scan times read as seconds; anything unreadable is null, not zero', () => {
  assert.equal(X.scanSeconds('32sec 16msec'), 32.016);
  assert.equal(X.scanSeconds('4min 16sec '), 256);
  assert.equal(X.scanSeconds('1h 2min'), 3720);
  assert.equal(X.scanSeconds(''), null);
  assert.equal(X.parseDataInfo('<CtAllInfo></CtAllInfo>').kv, null);
});

test('gray values compare only between scans with the same kV, current and scan time', () => {
  const a = X.parseDataInfo(DATA_INFO), b = { ...a, scanSeconds: 32.016 }, c = { ...a, kv: 80, ua: 220 };
  assert.deepEqual(X.settingsDiffer(a, a), []);
  assert.deepEqual(X.settingsDiffer(a, b), ['scan time 256 s vs 32 s']);
  assert.deepEqual(X.settingsDiffer(a, c), ['120 kV vs 80 kV', '350 µA vs 220 µA']);
  assert.deepEqual(X.settingsDiffer(a, null), ['scan settings unknown for one of them']);
});

// A Rigaku export folder: CT_<id>/ holds the .VOX, DataInfo.xml, CT_<id>.xml and a TIFF stack of the same volume.
const f = (p) => ({ webkitRelativePath: p, name: p.split('/').pop() });
test('a Rigaku scan folder opens as one scan from its VOX (the TIFF copy is not listed twice), with its records', () => {
  const out = CT.groupStacks([f('S/CT_1/CT_1.VOX'), f('S/CT_1/DataInfo.xml'), f('S/CT_1/CT_1.xml'), f('S/CT_1/CT_1_th.jpg'),
    f('S/CT_1/part_tiff_stack/p001.tiff'), f('S/CT_1/part_tiff_stack/p002.tiff'),
    f('S/CT_2/DataInfo.xml'), f('S/CT_2/slab_tiff_stack/s1.tif'), f('S/CT_2/slab_tiff_stack/s2.tif'),
    f('T/plain/a1.tif')]);
  assert.deepEqual(out.map((s) => [s.folder, s.kind]), [['CT_1', 'vox'], ['plain', 'tiff'], ['slab_tiff_stack', 'tiff']]);
  assert.equal(out[0].vox.name, 'CT_1.VOX');
  assert.equal(out[0].dataInfo.name, 'DataInfo.xml');
  assert.equal(out[2].dataInfo.webkitRelativePath, 'S/CT_2/DataInfo.xml'); // the scan record beside a TIFF-only export
  assert.equal(out[1].dataInfo, null);
  assert.equal(out[2].files.length, 2);
});

test('a VOX file opens slice by slice; a copy cut short is refused before any slice is read', async () => {
  const h = HEADER.replace('VolumeSize 1392 784 503', 'VolumeSize 3 2 2').replace(/VolumeScale [^\n]+/, 'VolumeScale 0.04 0.04 0.04');
  const data = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8, 0, 9, 0, 10, 0, 11, 0, 12, 0]);
  const blob = new Blob([bytes(h), data]);
  const r = await X.openVox(blob);
  assert.equal(r.count, 2);
  const s = await r.read(1);
  assert.deepEqual([s.width, s.height, s.voxelMm], [3, 2, 0.04]);
  assert.deepEqual([...s.pixels], [7, 8, 9, 10, 11, 12]);
  await assert.rejects(X.openVox(new Blob([bytes(h), data.subarray(0, 20)])), /expected .* bytes/);
  const tall = h.replace('VolumeScale 0.04 0.04 0.04', 'VolumeScale 0.04 0.04 0.08');
  await assert.rejects(X.openVox(new Blob([bytes(tall), data])), /not cubic/);
});

test('the scan settings read in one line, and say plainly what was not recorded', () => {
  assert.equal(X.settingsText(X.parseDataInfo(DATA_INFO)), '120 kV, 350 µA, 4 min 16 s scan (2x2 detector binning), no X-ray filter, beam-hardening correction off, denoise off');
  assert.equal(X.settingsText({ kv: 80, ua: 220, scanSeconds: 32.016 }), '80 kV, 220 µA, 32 s scan');
  assert.equal(X.settingsText(null), 'not recorded (no DataInfo.xml beside the scan)');
});
