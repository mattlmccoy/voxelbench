'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../app/vb_checklist.js');

// Nothing done yet: a scan just opened, no sample details, no marks, no results.
const NONE = { scanInfo: false, leveled: false, crops: [], pores: null, regions: [], dense: 0, sheetSaved: false };
const doneIds = (items) => items.filter((i) => i.done).map((i) => i.id);

test('the checklist lists the core path in order, each with its rail section and label', () => {
  const items = C.checklist(NONE);
  assert.deepEqual(items.map((i) => [i.id, i.section, i.label, i.optional]), [
    ['scan', 'secScan', 'Scan info', false],
    ['level', 'secScan', 'Level the part', true],
    ['crop', 'step1', 'Crop out holder & bag', false],
    ['pores', 'step2', 'Segment pores', false],
    ['regions', 'step3', 'Measure regions', true],
    ['density', 'step5', 'Density reference', false],
    ['sheet', 'step4', 'Review sheet', false],
  ]);
  assert.deepEqual(doneIds(items), []);
});

test('steps inside a shared section point at their own block', () => {
  const by = Object.fromEntries(C.checklist(NONE).map((i) => [i.id, i]));
  assert.equal(by.level.anchor, 'orientBox');
  assert.equal(by.regions.anchor, 'regionBlock');
  assert.equal(by.pores.anchor, undefined);
});

test('scan info and leveling are done from their own flags', () => {
  assert.deepEqual(doneIds(C.checklist({ ...NONE, scanInfo: true })), ['scan']);
  assert.deepEqual(doneIds(C.checklist({ ...NONE, leveled: true })), ['level']);
});

test('crop is done once a crop outline exists', () => {
  assert.deepEqual(doneIds(C.checklist({ ...NONE, crops: [{ id: 'c1' }] })), ['crop']);
  assert.deepEqual(doneIds(C.checklist({ ...NONE, crops: undefined })), []);
});

test('segment pores is done once a segmentation exists, even one with no pores', () => {
  assert.deepEqual(doneIds(C.checklist({ ...NONE, pores: [] })), ['pores']);
  assert.deepEqual(doneIds(C.checklist({ ...NONE, pores: undefined })), [], 'missing is not a result');
});

test('measure regions is done once a measured region exists', () => {
  assert.deepEqual(doneIds(C.checklist({ ...NONE, regions: [{ id: 'r1' }] })), ['regions']);
});

test('density reference is done with at least one reference', () => {
  assert.deepEqual(doneIds(C.checklist({ ...NONE, dense: 1 })), ['density']);
  assert.deepEqual(doneIds(C.checklist({ ...NONE, dense: 0 })), []);
  assert.deepEqual(doneIds(C.checklist({ ...NONE, dense: NaN })), []);
});

test('review sheet is done once a sheet was saved', () => {
  assert.deepEqual(doneIds(C.checklist({ ...NONE, sheetSaved: true })), ['sheet']);
});

test('the next step is the first required step not done; optional steps never block it', () => {
  assert.equal(C.nowStep(C.checklist(NONE)), 'scan');
  // Leveling skipped: crop is next.
  assert.equal(C.nowStep(C.checklist({ ...NONE, scanInfo: true })), 'crop');
  // The mockup's state: scan info and crop done, the part not leveled.
  assert.equal(C.nowStep(C.checklist({ ...NONE, scanInfo: true, crops: [{}] })), 'pores');
  // Regions skipped: density reference is next.
  assert.equal(C.nowStep(C.checklist({ ...NONE, scanInfo: true, crops: [{}], pores: [] })), 'density');
  assert.equal(C.nowStep(C.checklist({ ...NONE, scanInfo: true, crops: [{}], pores: [], dense: 2 })), 'sheet');
});

test('with every required step done there is no next step', () => {
  assert.equal(C.nowStep(C.checklist({ ...NONE, scanInfo: true, crops: [{}], pores: [], dense: 1, sheetSaved: true })), null);
});

test('more analyses: zones, CAD, filler, walls and Dragonfly, each mapped to its section', () => {
  assert.deepEqual(C.MORE.map((m) => m.id), ['zones', 'cad', 'filler', 'walls', 'figure', 'dragonfly']);
  assert.deepEqual(C.MORE.map((m) => [m.section, m.label]), [['step3', 'zones'], ['step6', 'CAD'], ['step7', 'filler'], ['step8', 'walls'], ['step9', '3D figure'], ['step4', 'Dragonfly']]);
  assert.equal(C.MORE.find((m) => m.id === 'dragonfly').anchor, 'dfPanel');
});

test('a sample counts as described by a name of its own, a material or a process', () => {
  assert.equal(C.described(null), false);
  assert.equal(C.described({ folder: 'scan_a', name: 'scan_a', material: '', process: '' }), false, 'the default name is the folder');
  assert.equal(C.described({ folder: 'scan_a', name: 'Bracket 3', material: '', process: '' }), true);
  assert.equal(C.described({ folder: 'scan_a', name: 'scan_a', material: 'PA12', process: '' }), true);
  assert.equal(C.described({ folder: 'scan_a', name: 'scan_a', material: '', process: 'SLS' }), true);
});

test('Back returns to the overview for an open library scan and to the library otherwise', () => {
  assert.deepEqual(C.backTarget('library', 'scan-id'), { page: 'overview', label: '‹ Overview', title: "Back to this scan's overview" });
  const library = { page: 'library', label: '‹ Library', title: 'Back to the scan library' };
  for (const kind of ['file', 'db', undefined]) assert.deepEqual(C.backTarget(kind, 'scan-id'), library);
  assert.deepEqual(C.backTarget('library', null), library, 'no scan open: there is no overview to go back to');
});

test('scan info is done when the scanner record was read (kV or voxel size) or the sample is described', () => {
  const sample = { folder: 'scan_a', name: 'scan_a', material: '', process: '' };
  assert.equal(C.scanInfoDone({ kv: 120, voxelUm: null }, sample), true, 'kV read');
  assert.equal(C.scanInfoDone({ kv: null, voxelUm: 40 }, sample), true, 'voxel size read');
  assert.equal(C.scanInfoDone(null, { ...sample, material: 'PA12' }), true, 'described');
  assert.equal(C.scanInfoDone(null, sample), false, 'neither');
  assert.equal(C.scanInfoDone({ valueScale: 1, valueOffset: 0 }, sample), false, 'a VOX value scale alone is not a scanner record');
});

test('the top bar sums up the scan as in the mockup: kV, scan time, voxel; missing facts are left out', () => {
  const VX = require('../app/vb_vox.js');
  assert.equal(C.scanFacts({ kv: 80, scanSeconds: 32.016 }, 0.04, VX.duration), '80 kV · 32 s · 40.0 µm');
  assert.equal(C.scanFacts(null, 0.0045, VX.duration), '4.50 µm');
  assert.equal(C.scanFacts(null, null, VX.duration), '');
});
