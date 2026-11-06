'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../app/vb_library.js');

const slice = (n, seed) => Uint16Array.from({ length: n }, (_, i) => (i * 7 + seed) % 65536);

test('scan id: the same volume from VOX and TIFF has one id', async () => {
  // Both readers hand back Uint16Array slices of the same voxels; the id may not depend on which reader made them.
  const first = slice(16, 3), middle = slice(16, 11);
  const fromVox = await L.scanId({ width: 4, height: 4, count: 9, first, middle });
  const fromTiff = await L.scanId({ width: 4, height: 4, count: 9, first: Uint16Array.from(first), middle: Uint16Array.from(middle) });
  assert.equal(fromVox, fromTiff);
});

test('scan id: a different size or middle slice changes it', async () => {
  const zero = new Uint16Array(16);
  const a = await L.scanId({ width: 4, height: 4, count: 9, first: zero, middle: slice(16, 1) });
  const b = await L.scanId({ width: 4, height: 4, count: 9, first: zero, middle: slice(16, 2) });
  const c = await L.scanId({ width: 4, height: 4, count: 10, first: zero, middle: slice(16, 1) });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('scan id: the format is s + 16 hex', async () => {
  const id = await L.scanId({ width: 2, height: 2, count: 1, first: slice(4, 0), middle: slice(4, 0) });
  assert.match(id, /^s[0-9a-f]{16}$/);
});

const found = (over = {}) => ({ id: 'sa', path: 'scans/a', kind: 'vox', bytes: 100, mtime: 1000, study: 'ct', ...over });

test('index: a new scan is added', () => {
  const idx = L.mergeIndex(L.emptyIndex(5), [found()], 10);
  assert.equal(idx.schema, 'voxelbench-library-index');
  assert.equal(idx.version, L.INDEX_VERSION);
  assert.deepEqual(idx.scans.sa, { path: 'scans/a', kind: 'vox', bytes: 100, mtime: 1000, study: 'ct', first_seen: 10, last_seen: 10, missing: false });
});

test('index: a scan found at a new path keeps its id and gets the new path', () => {
  const before = L.mergeIndex(L.emptyIndex(1), [found()], 10);
  const snapshot = JSON.stringify(before);
  const after = L.mergeIndex(before, [found({ path: 'scans/b' })], 20);
  assert.deepEqual(Object.keys(after.scans), ['sa']);
  assert.equal(after.scans.sa.path, 'scans/b');
  assert.equal(after.scans.sa.first_seen, 10);
  assert.equal(after.scans.sa.last_seen, 20);
  assert.equal(JSON.stringify(before), snapshot, 'input index must not be mutated');
  assert.notEqual(after, before);
});

test('index: a scan not found is marked missing and kept', () => {
  const before = L.mergeIndex(L.emptyIndex(1), [found(), found({ id: 'sb', path: 'scans/b' })], 10);
  const after = L.mergeIndex(before, [found()], 20);
  assert.equal(after.scans.sb.missing, true);
  assert.equal(after.scans.sb.path, 'scans/b');
  assert.equal(after.scans.sb.last_seen, 10);
  assert.equal(after.scans.sa.missing, false);
  assert.equal(after.scans.sa.last_seen, 20);
});

test('index: a missing scan found again is not missing', () => {
  const gone = L.mergeIndex(L.mergeIndex(L.emptyIndex(1), [found()], 10), [], 20);
  assert.equal(gone.scans.sa.missing, true);
  const back = L.mergeIndex(gone, [found()], 30);
  assert.equal(back.scans.sa.missing, false);
  assert.equal(back.scans.sa.first_seen, 10);
  assert.equal(back.scans.sa.last_seen, 30);
});

test('index: an unchanged scan needs no read', () => {
  const idx = L.mergeIndex(L.emptyIndex(1), [found()], 10);
  assert.equal(L.needsRead(idx, { path: 'scans/a', bytes: 100, mtime: 1000 }), false);
  assert.equal(L.needsRead(idx, { path: 'scans/a', bytes: 101, mtime: 1000 }), true);
  assert.equal(L.needsRead(idx, { path: 'scans/a', bytes: 100, mtime: 2000 }), true);
  assert.equal(L.needsRead(idx, { path: 'scans/z', bytes: 100, mtime: 1000 }), true);
});

// ---------- Task 4: the library page's pure logic ----------
const CTCore = require('../app/ct_core.js');

const row = (id, { entry = {}, record = null, run = null } = {}) => ({
  id,
  entry: { path: `scans/${id}`, kind: 'vox', bytes: 1, mtime: 1, study: null, first_seen: '2026-01-01', last_seen: '2026-01-01', missing: false, ...entry },
  record, run,
});

test('cardFacts: the title is the sample name, else the study, else the folder name', () => {
  const entry = { path: 'drive/run 4/part_a', study: 'study-7', info: null };
  assert.equal(L.cardFacts({ entry, record: { id: 'sa', name: 'Bracket' }, run: null }).title, 'Bracket');
  assert.equal(L.cardFacts({ entry, record: null, run: null }).title, 'study-7');
  assert.equal(L.cardFacts({ entry: { ...entry, study: null }, record: null, run: null }).title, 'part_a');
  // Saving any field of a record stores name = its id (CT.sampleRecord); that is not a name.
  assert.equal(L.cardFacts({ entry, record: { id: 'sa', name: 'sa', starred: true }, run: null }).title, 'study-7');
});

test('cardFacts: settings from the scan record; porosity only from a saved run', () => {
  const entry = { path: 'a/b', study: null, voxel_um: 41, info: { scannedAt: '2026-10-30T09:00:00', scanSeconds: 256, voxelUm: 40, kv: 80 } };
  const none = L.cardFacts({ entry, record: null, run: null });
  assert.deepEqual(none, { title: 'b', date: '2026-10-30T09:00:00', scanSeconds: 256, voxelUm: 40, kv: 80, porosity: null, analyzed: false, starred: false, tags: [], missing: false });
  const ran = L.cardFacts({ entry: { ...entry, missing: true }, record: { id: 's', starred: true, tags: ['x'] }, run: { summary: { all_void_percent_of_body: 3.25 } } });
  assert.equal(ran.porosity, 3.25);
  assert.equal(ran.analyzed, true);
  assert.equal(ran.starred, true);
  assert.deepEqual(ran.tags, ['x']);
  assert.equal(ran.missing, true);
  assert.equal(L.cardFacts({ entry, record: null, run: { summary: {} } }).porosity, null, 'a run without the number shows none');
  assert.equal(L.cardFacts({ entry, record: null, run: { summary: {} } }).analyzed, true);
});

test('cardFacts: without a scanner record, the voxel comes from the slices and the rest is null', () => {
  const f = L.cardFacts({ entry: { path: 'a', voxel_um: 41.5, info: null }, record: null, run: null });
  assert.equal(f.voxelUm, 41.5);
  assert.equal(f.date, null);
  assert.equal(f.kv, null);
  assert.equal(f.scanSeconds, null);
});

test('filterScans: search over title, study, tags and notes, ignoring case', () => {
  const rows = [
    row('s1', { record: { id: 's1', name: 'Gear housing' } }),
    row('s2', { entry: { study: 'Lattice-Study' } }),
    row('s3', { record: { id: 's3', tags: ['fatigue'] } }),
    row('s4', { record: { id: 's4', notes: 'cracked at the boss' } }),
  ];
  const ids = (q) => L.filterScans(rows, { query: q }).map((r) => r.id);
  assert.deepEqual(ids(''), ['s1', 's2', 's3', 's4']);
  assert.deepEqual(ids('GEAR'), ['s1']);
  assert.deepEqual(ids('lattice'), ['s2']);
  assert.deepEqual(ids('fatig'), ['s3']);
  assert.deepEqual(ids('boss'), ['s4']);
  assert.deepEqual(ids('nothing like it'), []);
});

test('filterScans: each filter, a tag and a project', () => {
  const rows = [
    row('s1', { record: { id: 's1', starred: true, tags: ['a'], project: 'P1' } }),
    row('s2', { run: { summary: { all_void_percent_of_body: 1 } }, record: { id: 's2', tags: ['a', 'b'] } }),
    row('s3', { entry: { missing: true }, record: { id: 's3', project: 'P1' } }),
  ];
  const ids = (o) => L.filterScans(rows, o).map((r) => r.id);
  assert.deepEqual(ids({ filter: 'all' }), ['s1', 's2', 's3']);
  assert.deepEqual(ids({}), ['s1', 's2', 's3']);
  assert.deepEqual(ids({ filter: 'starred' }), ['s1']);
  assert.deepEqual(ids({ filter: 'analyzed' }), ['s2']);
  assert.deepEqual(ids({ filter: 'unanalyzed' }), ['s1', 's3']);
  assert.deepEqual(ids({ filter: 'missing' }), ['s3']);
  assert.deepEqual(ids({ tag: 'b' }), ['s2']);
  assert.deepEqual(ids({ project: 'P1' }), ['s1', 's3']);
  assert.deepEqual(ids({ filter: 'starred', project: 'P1', query: 'nope' }), []);
});

const seen = (over) => ({ id: 'sa', path: 'x', kind: 'vox', bytes: 10, mtime: 5, study: null, ...over });

test('dedupeScans: a VOX and its TIFF copy are one entry, read from the VOX', () => {
  const out = L.dedupeScans([seen({ path: 'b/tiff_export', kind: 'tiff', bytes: 99, mtime: 7 }), seen({ path: 'a/longer/vox_folder', kind: 'vox' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'a/longer/vox_folder');
  assert.equal(out[0].kind, 'vox');
  assert.deepEqual(out[0].copies, ['b/tiff_export']);
  assert.deepEqual(out[0].copy_stamps, [{ path: 'b/tiff_export', bytes: 99, mtime: 7 }]);
});

test('dedupeScans: among the same kind the shortest path wins; distinct ids pass through unchanged', () => {
  const lone = seen({ id: 'sb', path: 'z' });
  const out = L.dedupeScans([seen({ path: 'aa/bb', kind: 'tiff' }), lone, seen({ path: 'c', kind: 'tiff' })]);
  assert.deepEqual(out.map((e) => e.id), ['sa', 'sb']);
  assert.equal(out[0].path, 'c');
  assert.deepEqual(out[0].copies, ['aa/bb']);
  assert.deepEqual(out[1], lone);
  assert.equal('copies' in out[1], false);
});

test('index: fields beyond the basics (scanner record, copies) are kept', () => {
  const idx = L.mergeIndex(L.emptyIndex(1), [found({ info: { kv: 80 }, copies: ['t'], copy_stamps: [{ path: 't', bytes: 3, mtime: 4 }] })], 10);
  assert.deepEqual(idx.scans.sa.info, { kv: 80 });
  assert.deepEqual(idx.scans.sa.copies, ['t']);
  assert.equal('id' in idx.scans.sa, false);
});

test('index: an unchanged copy needs no read and resolves to its scan', () => {
  const idx = L.mergeIndex(L.emptyIndex(1), [found({ copies: ['t'], copy_stamps: [{ path: 't', bytes: 3, mtime: 4 }] })], 10);
  assert.equal(L.needsRead(idx, { path: 't', bytes: 3, mtime: 4 }), false);
  assert.equal(L.needsRead(idx, { path: 't', bytes: 3, mtime: 5 }), true);
  assert.equal(L.findIndexed(idx, { path: 't', bytes: 3, mtime: 4 }), 'sa');
  assert.equal(L.findIndexed(idx, { path: 'scans/a', bytes: 100, mtime: 1000 }), 'sa');
  assert.equal(L.findIndexed(idx, { path: 'nowhere', bytes: 1, mtime: 1 }), null);
});

test('checkIndex: refuses a newer, foreign or malformed scans.json', () => {
  assert.doesNotThrow(() => L.checkIndex(L.emptyIndex(1)));
  assert.throws(() => L.checkIndex({ ...L.emptyIndex(1), version: L.INDEX_VERSION + 1 }), /newer/);
  assert.throws(() => L.checkIndex({ schema: 'other', version: 1, scans: {} }), /not a VoxelBench scan index/);
  assert.throws(() => L.checkIndex({ ...L.emptyIndex(1), scans: [] }), /not a VoxelBench scan index/);
  assert.throws(() => L.checkIndex(null), /not a VoxelBench scan index/);
  assert.throws(() => L.checkIndex([]), /not a VoxelBench scan index/);
});

// Files as the library walk hands them over (ruling 1): a webkitRelativePath plus size and time.
const file = (path, size = 4, lastModified = 1) => ({ webkitRelativePath: path, name: path.split('/').pop(), size, lastModified, text: async () => '' });

test('scanFolders: TIFF folders of the same name in different places stay separate scans', () => {
  const files = [file('a/slices/1.tif'), file('a/slices/2.tif'), file('b/slices/1.tif'), file('b/DataInfo.xml'), file('c/v/scan.vox', 100, 9)];
  const out = L.scanFolders(CTCore.groupStacks(files), files);
  const byDir = Object.fromEntries(out.map((s) => [s.dir, s]));
  assert.deepEqual(Object.keys(byDir).sort(), ['a/slices', 'b/slices', 'c/v']);
  assert.equal(byDir['a/slices'].files.length, 2);
  assert.equal(byDir['b/slices'].files.length, 1);
  assert.equal(byDir['b/slices'].dataInfo.webkitRelativePath, 'b/DataInfo.xml', 'the record beside the slice folder');
  assert.equal(byDir['a/slices'].dataInfo, null);
  assert.equal(byDir['c/v'].kind, 'vox');
});

test('stampOf: a VOX is its file; a TIFF folder is its slices together', () => {
  assert.deepEqual(L.stampOf({ dir: 'v', kind: 'vox', vox: file('v/s.vox', 100, 9), files: [] }), { path: 'v', bytes: 100, mtime: 9 });
  assert.deepEqual(L.stampOf({ dir: 't', kind: 'tiff', files: [file('t/1.tif', 4, 3), file('t/2.tif', 6, 8)] }), { path: 't', bytes: 10, mtime: 8 });
});

test('rescan: lists, reads only what changed, keeps a moved scan and folds copies', async () => {
  let reads = 0;
  const ids = { 'r/vox1': 's1', 'r/tiff1': 's1', 'r/vox2': 's2' };
  const readScan = async (stack) => { reads++; return { id: ids[stack.dir], study: `st-${stack.dir}`, info: null, width: 2, height: 2, count: 3, voxel_um: 40 }; };
  const files = [file('r/vox1/a.vox', 50, 1), file('r/tiff1/1.tif'), file('r/tiff1/2.tif'), file('r/vox2/b.vox', 60, 2)];
  const opts = { groupStacks: CTCore.groupStacks, readScan };
  const one = await L.rescan({ files, index: L.emptyIndex('t0'), now: 't1', ...opts });
  assert.equal(reads, 3);
  assert.equal(one.read, 3);
  assert.deepEqual(Object.keys(one.index.scans).sort(), ['s1', 's2']);
  assert.equal(one.index.scans.s1.path, 'r/vox1');
  assert.deepEqual(one.index.scans.s1.copies, ['r/tiff1']);
  assert.equal(one.stacks.get('s1').dir, 'r/vox1');
  assert.equal(one.stacks.get('s1').folder, 's1', 'library scans use the scan id as the folder key');

  const two = await L.rescan({ files, index: one.index, now: 't2', ...opts });
  assert.equal(two.read, 0, 'a second rescan reads nothing');
  assert.equal(one.places, 3, 'three scan folders, one of them a copy');
  assert.equal(two.places, 3);
  assert.equal(reads, 3);
  assert.deepEqual(two.index.scans.s1.copies, ['r/tiff1']);

  const moved = files.map((f) => (f.webkitRelativePath.startsWith('r/vox2/') ? file(f.webkitRelativePath.replace('r/vox2/', 'r/renamed/'), f.size, f.lastModified) : f));
  ids['r/renamed'] = 's2';
  const three = await L.rescan({ files: moved, index: two.index, now: 't3', ...opts });
  assert.equal(three.read, 1);
  assert.equal(three.index.scans.s2.path, 'r/renamed');
  assert.equal(three.index.scans.s2.first_seen, 't1');
  assert.equal(three.index.scans.s2.missing, false);
});

test('rescan: a scan that cannot be read is reported, not listed, and does not stop the others', async () => {
  const readScan = async (stack) => { if (stack.dir === 'bad') throw new Error('incomplete copy'); return { id: 'sg', study: null, info: null, width: 1, height: 1, count: 1, voxel_um: 1 }; };
  const files = [file('bad/x.vox'), file('good/y.vox')];
  const out = await L.rescan({ files, index: L.emptyIndex(0), now: 1, groupStacks: CTCore.groupStacks, readScan });
  assert.deepEqual(Object.keys(out.index.scans), ['sg']);
  assert.deepEqual(out.failed, [{ path: 'bad', message: 'incomplete copy' }]);
});

test('grayWindow: 1st to 99.9th percentile of the nonzero values', () => {
  const px = new Uint16Array(3000);
  for (let i = 0; i < 1000; i++) px[i] = i + 1; // 1..1000, the rest is outside the scan (0)
  const w = L.grayWindow(px);
  assert.ok(w.low >= 9 && w.low <= 12, `low ${w.low}`);
  assert.ok(w.high >= 998 && w.high <= 1000, `high ${w.high}`);
  assert.deepEqual(L.grayWindow(new Uint16Array(4)), { low: 0, high: 1 }, 'an empty slice still gives a usable window');
});

test('parseTags: comma-separated, trimmed, without blanks or repeats', () => {
  assert.deepEqual(L.parseTags(' a, b ,,a,  c '), ['a', 'b', 'c']);
  assert.deepEqual(L.parseTags(''), []);
});
