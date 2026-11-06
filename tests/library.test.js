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

// ---------- Fix round 1: the Rescan runs on the root it started with, and never overwrites an index it did not read ----------
function rescanRig(onDisk = {}) {
  const writes = [], gates = [];
  const io = {
    groupStacks: CTCore.groupStacks,
    readScan: async (stack) => ({ id: `s_${stack.dir.replace(/\W/g, '')}`, study: null, info: null, width: 1, height: 1, count: 1, voxel_um: 1 }),
    listFiles: async (dir) => { if (dir.gate) await new Promise((r) => gates.push(r)); return [file(`${dir.name}/v/a.vox`)]; },
    ensureDrive: async () => {},
    readIndex: async (dir) => (dir.name in onDisk ? onDisk[dir.name] : null),
    writeIndex: async (dir, text) => { writes.push({ dir: dir.name, text }); onDisk[dir.name] = text; },
    now: () => 't',
  };
  return { io, writes, gates, onDisk, r: L.makeRescanner(io) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('rescanner: writes the new index once, to the root it scanned', async () => {
  const { r, writes } = rescanRig();
  r.open();
  const out = await r.run({ name: 'A' }, L.emptyIndex('t0'));
  assert.equal(out.found, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].dir, 'A');
  assert.deepEqual(Object.keys(JSON.parse(writes[0].text).scans), ['s_Av']);
});

test('rescanner: a root opened during a Rescan clears busy, the stale Rescan writes nothing, and the new root rescans', async () => {
  const { r, writes, gates } = rescanRig();
  r.open();
  const stale = r.run({ name: 'A', gate: true }, L.emptyIndex('t0'));
  await tick();
  assert.equal(r.busy(), true);
  assert.deepEqual(await r.run({ name: 'A' }, L.emptyIndex('t0')), { skipped: true }, 'one Rescan at a time');
  r.open(); // another library is picked while the first Rescan waits on the drive
  assert.equal(r.busy(), false);
  const fresh = await r.run({ name: 'B' }, L.emptyIndex('t0'));
  assert.equal(fresh.found, 1);
  gates.forEach((go) => go());
  assert.deepEqual(await stale, { stale: true });
  assert.deepEqual(writes.map((w) => w.dir), ['B'], 'nothing from the stale Rescan, in either root');
});

test('rescanner: a scans.json made newer or unreadable since it was read is refused, not overwritten', async () => {
  for (const [text, msg] of [[JSON.stringify({ ...L.emptyIndex(1), version: L.INDEX_VERSION + 1 }), /newer/], ['{oops', /not readable JSON/], ['[]', /not a VoxelBench scan index/]]) {
    const { r, writes, onDisk } = rescanRig({ A: text });
    r.open();
    await assert.rejects(r.run({ name: 'A' }, L.emptyIndex('t0')), msg);
    assert.equal(writes.length, 0);
    assert.equal(onDisk.A, text);
    assert.equal(r.busy(), false, 'a refusal ends the Rescan');
  }
});

test('rescanner: a scans.json changed on the drive since it was read is refused', async () => {
  const mine = L.mergeIndex(L.emptyIndex('t0'), [], 't1');
  const theirs = JSON.stringify(L.mergeIndex(mine, [{ id: 'sx', path: 'x', kind: 'vox', bytes: 1, mtime: 1, study: null }], 't2'));
  const { r, writes } = rescanRig({ A: theirs });
  r.open();
  await assert.rejects(r.run({ name: 'A' }, mine), /changed on the drive/);
  assert.equal(writes.length, 0);
  const same = rescanRig({ A: JSON.stringify(mine, null, 2) });
  same.r.open();
  await same.r.run({ name: 'A' }, mine);
  assert.equal(same.writes.length, 1, 'the index this page read (or last wrote) is replaced as before');
});

// ---------- scan overview ----------
const entry = { id: 's1', path: 'a/b', kind: 'vox', width: 3, height: 2, count: 2, voxel_um: 12.5, info: { scannedAt: '2026-10-20T14:30:05', kv: 80, ua: 220, scanSeconds: 256, voxelUm: 12.5 } };
const header = { nx: 3, ny: 2, nz: 2, voxelMm: [0.0125, 0.0125, 0.0125], dataStart: 100, littleEndian: true };
const asMap = (pairs) => Object.fromEntries(pairs);

test('overviewFacts: no run lists the scanner record and no results, and nothing is invented', () => {
  const f = L.overviewFacts({ entry, scanInfo: entry.info, header, run: null, runs: [] });
  const rows = asMap(f.rows);
  assert.equal(rows['Scanned'], '2026-10-20 14:30');
  assert.equal(rows['Tube'], '80 kV, 220 µA');
  assert.equal(rows['Scan time'], '4 min 16 s');
  assert.equal(rows['Voxel'], '12.5 µm');
  assert.equal(rows['Size'], '3 × 2 × 2 voxels');
  assert.equal(rows['Format'], 'VOX');
  assert.equal(rows['Leveled'], 'not recorded', 'with neither a record nor a run there is no word on leveling');
  assert.deepEqual(f.results, []);
  assert.deepEqual(f.runs, []);
});

test('overviewFacts: a missing scanner record shows "not recorded", never a guess', () => {
  const bare = { id: 's2', path: 'x', kind: 'tiff', width: 5, height: 4, count: 3, voxel_um: null, info: null };
  const rows = asMap(L.overviewFacts({ entry: bare, scanInfo: null, header: null, run: null, runs: [] }).rows);
  for (const k of ['Scanned', 'Tube', 'Scan time', 'Voxel']) assert.equal(rows[k], 'not recorded', k);
  assert.equal(rows['Size'], '5 × 4 × 3 voxels');
  assert.equal(rows['Format'], 'TIFF stack');
});

const run = {
  created_at: '2026-11-05T10:00:00.000Z', leveled: null,
  summary: { all_void_percent_of_body: 3.456, pore_count: 120 },
  open_closed: { open_percent: 1.2, closed_percent: 2.256 },
  labels: [{ id: 'region_a', label: 'Core' }],
  relative_scale: [{ material: 'm1', airGray: 100, denseGray: 300 }],
  regions: [{ id: 'r1', label: 'region_a', note: '', stats: { gray_mean: 250 } }, { id: 'r2', label: 'zz_gone', note: 'edge', stats: { gray_mean: 200 } }],
};

test('overviewFacts: results come from the latest run, relative densities from its scales and regions', () => {
  const f = L.overviewFacts({ entry, scanInfo: entry.info, header, run, runs: [{ at: '2026-11-04T09:00:00.000Z' }, { at: '2026-11-05T10:00:00.000Z' }] });
  const res = asMap(f.results);
  assert.equal(res['Porosity'], '3.46 %');
  assert.equal(res['Open'], '1.20 %');
  assert.equal(res['Closed'], '2.26 %');
  assert.equal(res['Pores'], '120');
  assert.equal(res['Core, relative to m1 dense'], '0.75');
  assert.equal(res['zz_gone (edge), relative to m1 dense'], '0.50', 'a deleted label shows its id');
  assert.equal(f.results.filter(([k]) => /whole|part/i.test(k)).length, 0, 'no whole-part relative density');
  assert.equal(asMap(f.rows)['Leveled'], 'no');
  assert.deepEqual(f.runs.map((r) => r.at), ['2026-11-05T10:00:00.000Z', '2026-11-04T09:00:00.000Z'], 'newest first');
  const local = (iso) => { const d = new Date(iso), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  assert.equal(f.runs[0].label, local('2026-11-05T10:00:00.000Z'), 'run times are local, like the scanner time');
});

test('overviewFacts: a run without dense references lists no relative densities; one without open/closed says so', () => {
  const plain = { ...run, relative_scale: [], open_closed: null, leveled: { angles_deg: [1, 2, 3] } };
  const f = L.overviewFacts({ entry, scanInfo: entry.info, header, run: plain, runs: [{ at: plain.created_at }] });
  const res = asMap(f.results);
  assert.equal(f.results.some(([k]) => /relative/.test(k)), false);
  assert.equal(res['Open'], 'not recorded');
  assert.equal(res['Closed'], 'not recorded');
  assert.equal(asMap(f.rows)['Leveled'], 'yes');
});

test('overviewFacts: a run with no porosity says not recorded', () => {
  const f = L.overviewFacts({ entry, scanInfo: entry.info, header, run: { created_at: 'x', summary: {} }, runs: [] });
  assert.equal(asMap(f.results)['Porosity'], 'not recorded');
});

test('voxRowRange: XZ rows are one contiguous x-run; YZ rows span the slice from the first to the last y at that x', () => {
  const h = header; // slice = 2 * 3 * 2 = 12 bytes; a row of x = 6 bytes
  assert.deepEqual(L.voxRowRange(h, 'XY', 0, 0), [100, 112]);
  assert.deepEqual(L.voxRowRange(h, 'XY', 1, 0), [112, 124]);
  // XZ at y = index, row = z
  assert.deepEqual(L.voxRowRange(h, 'XZ', 0, 0), [100, 106]);
  assert.deepEqual(L.voxRowRange(h, 'XZ', 1, 0), [106, 112]);
  assert.deepEqual(L.voxRowRange(h, 'XZ', 1, 1), [118, 124]);
  // YZ at x = index, row = z: voxel (x, y=0) .. (x, y=ny-1) in slice z
  assert.deepEqual(L.voxRowRange(h, 'YZ', 0, 0), [100, 108]);
  assert.deepEqual(L.voxRowRange(h, 'YZ', 2, 1), [100 + 12 + 4, 100 + 12 + 2 * (3 + 2 + 1)]);
  assert.throws(() => L.voxRowRange(h, 'XZ', 2, 0), /outside/);
  assert.throws(() => L.voxRowRange(h, 'YZ', 3, 0), /outside/);
  assert.throws(() => L.voxRowRange(h, 'XZ', 0, 2), /outside/);
  assert.throws(() => L.voxRowRange(h, 'AB', 0, 0), /plane/);
});

test('overviewFacts: Leveled comes from the sample record first, then the run, else not recorded', () => {
  const lv = (record, r) => asMap(L.overviewFacts({ entry, scanInfo: entry.info, header, record, run: r, runs: [] }).rows)['Leveled'];
  assert.equal(lv({ orientation: { angles_deg: [1, 0, 0] } }, null), 'yes');
  assert.equal(lv({ name: 'x' }, null), 'no', 'a record without an orientation is scan axes');
  assert.equal(lv({ orientation: { angles_deg: [1, 0, 0] } }, { ...run, leveled: null }), 'yes', 'the record wins over the run');
  assert.equal(lv(null, { ...run, leveled: { angles_deg: [1, 2, 3] } }), 'yes');
  assert.equal(lv(null, run), 'no');
  assert.equal(lv(null, null), 'not recorded');
});

test('overviewFacts: without a scanner or index voxel size, the VOX header gives it', () => {
  const bare = { ...entry, voxel_um: null, info: null };
  assert.equal(asMap(L.overviewFacts({ entry: bare, scanInfo: null, header, run: null, runs: [] }).rows)['Voxel'], '12.5 µm');
  assert.equal(asMap(L.overviewFacts({ entry: bare, scanInfo: null, header: null, run: null, runs: [] }).rows)['Voxel'], 'not recorded');
});

test('record saver: two saves in a row without waiting keep both fields; a failed save is passed on and forgotten', async () => {
  const stored = new Map(), puts = [];
  const sampleRecord = (id, samples, changes, pending) => ({ ...samples.get(id), ...pending, ...changes, id });
  let fail = false;
  const save = L.makeRecordSaver({ samples: () => stored, sampleRecord, put: async (r) => { puts.push(r); await tick(); if (fail) throw new Error('disk full'); stored.set(r.id, r); } });
  const first = save('s1', { name: 'A', tags: ['t'] });
  const second = save('s1', { starred: true }); // the page's copy (stored) has not seen the first yet
  await Promise.all([first, second]);
  assert.deepEqual(puts[1], { name: 'A', tags: ['t'], starred: true, id: 's1' });
  assert.deepEqual(stored.get('s1'), puts[1]);
  fail = true;
  await assert.rejects(save('s1', { notes: 'lost' }), /disk full/);
  fail = false;
  await save('s1', { material: 'm' });
  assert.equal(puts[puts.length - 1].notes, undefined, 'a failed save does not leak into the next');
  assert.equal(puts[puts.length - 1].name, 'A');
});
