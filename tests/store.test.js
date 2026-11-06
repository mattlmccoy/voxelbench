'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../app/vb_store.js');
const { makeFakeDb } = require('./fake_db.js');

const sample = (id) => ({ id, folder: id, name: `Sample ${id}`, material: 'PA12', process: 'SLS', notes: '' });
const region = (id) => ({ id, label: 'region_a', sample: { folder: 'S1' }, points: [{ col: 1, row: 2 }] });
const run = { doc: { schema: 2, chunk_count: 1, settings: { poreThreshold: 1300 } }, chunks: [{ rows: [1, 2, 3] }] };

async function filled() {
  const s = S.makeFileStore();
  await s.put('samples', sample('S1')); await s.put('samples', sample('S2'));
  await s.put('labels', { id: 'region_a', label: 'Region A', color: '#6ec3ff' });
  for (const id of ['r1', 'r2', 'r3']) await s.put('regions', region(id));
  await s.putRun('S1', run.doc, run.chunks);
  return s;
}

test('file store round-trips a project', async () => {
  const p = await (await filled()).exportProject('0.1.0');
  assert.equal(p.schema, 'voxelbench-project');
  assert.equal(p.version, 1);
  assert.equal(p.tool_version, '0.1.0');
  assert.equal(p.samples.length, 2); assert.equal(p.labels.length, 1); assert.equal(p.regions.length, 3);
  assert.deepEqual(p.annotations, []);
  assert.deepEqual(p.runs, { S1: run });
  const fresh = S.makeFileStore();
  await fresh.importProject(p);
  assert.deepEqual(await fresh.exportProject('0.1.0'), p);
});

test('import never overwrites a run', async () => {
  const target = S.makeFileStore();
  await target.putRun('S1', { schema: 2, chunk_count: 0, mine: true }, []);
  const result = await target.importProject(await (await filled()).exportProject('0.1.0'));
  assert.deepEqual(result.renamedRuns, ['S1 (imported 1)']);
  assert.equal((await target.getRun('S1')).mine, true);
  assert.deepEqual(await target.getRun('S1 (imported 1)'), run.doc);
});

test('import refuses foreign or newer files and changes nothing', async () => {
  const s = await filled();
  const before = await s.exportProject('0.1.0');
  await assert.rejects(s.importProject({}), { message: 'Not a VoxelBench project' });
  await assert.rejects(s.importProject({ schema: 'voxelbench-project', version: 2 }), { message: 'Project schema version 2 is newer than this VoxelBench (1)' });
  assert.deepEqual(await s.exportProject('0.1.0'), before);
});

test('file store watchers see copies, never the stored records', async () => {
  const s = S.makeFileStore();
  let seen = null;
  s.watch('regions', (m) => { seen = m; });
  await s.put('regions', region('r1'));
  seen.get('r1').label = 'changed';
  let again = null;
  s.watch('regions', (m) => { again = m; });
  assert.equal(again.get('r1').label, 'region_a');
});

test('artifact store writes through a frozen database', async () => {
  const s = S.makeArtifactStore(makeFakeDb());
  assert.equal(s.kind, 'artifact');
  let seen = new Map();
  s.watch('regions', (m) => { seen = m; });
  await s.put('regions', region('r1'));
  assert.equal(seen.get('r1').label, 'region_a');
  assert.ok(Object.isFrozen(seen.get('r1')));
  await s.putRun('S1', run.doc, run.chunks);
  assert.deepEqual(await s.getRun('S1'), run.doc);
  assert.equal(await s.getRun('nope'), null);
  const p = await s.exportProject('0.1.0', ['S1']);
  assert.deepEqual(p.runs.S1, run);
  await s.remove('regions', 'r1');
  assert.equal(seen.has('r1'), false);
});

test('saveBlob uses downloads when given and reports a decline', async () => {
  const calls = [];
  assert.equal(await S.saveBlob({ save: async (r) => { calls.push(r.filename); } }, 'a.json', new Blob(['x'])), 'saved');
  assert.deepEqual(calls, ['a.json']);
  assert.equal(await S.saveBlob({ save: async () => { throw Object.assign(new Error('no'), { code: 'declined' }); } }, 'a.json', new Blob(['x'])), 'declined');
});

test('saveBlob falls back to a link', async () => {
  const anchor = { clicked: false, click() { this.clicked = true; }, remove() {} };
  global.document = { createElement: (tag) => (tag === 'a' ? anchor : null), body: { append() {} } };
  try {
    assert.equal(await S.saveBlob(null, 'p.json', new Blob(['x'])), 'link');
    assert.equal(anchor.download, 'p.json');
    assert.ok(anchor.clicked);
  } finally {
    delete global.document;
  }
});

test('isEmpty is true only for a store with no records and no runs', async () => {
  const s = S.makeFileStore();
  assert.equal(s.isEmpty(), true);
  await s.put('regions', region('r1'));
  assert.equal(s.isEmpty(), false);
  const t = S.makeFileStore();
  await t.putRun('S1', run.doc, run.chunks);
  assert.equal(t.isEmpty(), false);
});

test('connect falls back to a project file when the database is absent, fails or never answers', async () => {
  assert.equal((await S.connect(null, 50)).store.kind, 'file');
  const failed = await S.connect(async () => { throw new Error('denied'); }, 50);
  assert.equal(failed.store.kind, 'file');
  assert.match(failed.note, /denied/);
  const silent = await S.connect(() => new Promise(() => {}), 20);
  assert.equal(silent.store.kind, 'file');
  assert.match(silent.note, /did not answer/);
  const ok = await S.connect(async (name) => (name === 'db' ? makeFakeDb() : { save: async () => {} }), 50);
  assert.equal(ok.store.kind, 'artifact');
  assert.ok(ok.downloads);
});

test('presets are their own collection: kept, exported and imported; a project from before presets still imports', async () => {
  const s = S.makeFileStore();
  await s.put('presets', { id: 'p1', name: 'Nylon, 40 um', settings: { poreThreshold: 1250 }, created_at: 't' });
  const p = await s.exportProject('0.1.0');
  assert.equal(p.presets.length, 1);
  const fresh = S.makeFileStore();
  await fresh.importProject(p);
  assert.equal((await fresh.exportProject('0.1.0')).presets[0].name, 'Nylon, 40 um');
  const old = { schema: 'voxelbench-project', version: 1, samples: [sample('S9')], labels: [], regions: [], annotations: [], runs: {} };
  const again = S.makeFileStore();
  await again.importProject(old);
  assert.deepEqual((await again.exportProject('0.1.0')).presets, []);
});

// ---- library store (a shared drive folder) ----
const { makeFakeDir } = require('./fake_dir.js');
const FS = require('../app/vb_fsdir.js');
const libText = (root, path) => FS.readText(root, `${S.LIBRARY_DIR}/${path}`);

test('library store: a region put is written to its scan\'s record file and watched back', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  assert.equal(s.kind, 'library');
  assert.ok(s.isEmpty());
  const seen = [];
  s.watch('regions', (m) => seen.push([...m.keys()]));
  assert.deepEqual(seen, [[]], 'watch calls at once');
  await s.put('samples', sample('S 1/a'));
  await s.put('regions', { ...region('r1'), sample: { folder: 'S 1/a' } });
  assert.deepEqual(seen.at(-1), ['r1']);
  const file = JSON.parse(await libText(root, `records/${encodeURIComponent('S 1/a')}.json`));
  assert.equal(file.samples.length, 1);
  assert.deepEqual(file.regions.map((r) => r.id), ['r1']);
  await s.put('labels', { id: 'region_a', label: 'Region A', color: '#6ec3ff' });
  assert.equal(JSON.parse(await libText(root, 'labels.json')).length, 1);
  assert.equal(JSON.parse(await libText(root, 'library.json')).schema, 'voxelbench-library');
  // a second open reads everything back whole
  const again = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  let got; again.watch('regions', (m) => { got = m; });
  assert.equal(got.get('r1').points[0].col, 1);
  await s.remove('regions', 'r1');
  assert.deepEqual(seen.at(-1), []);
  assert.equal(JSON.parse(await libText(root, `records/${encodeURIComponent('S 1/a')}.json`)).regions.length, 0);
});

test('library store: a failing write leaves the old file and the in-memory view unchanged', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.put('regions', region('r1'));
  root.shared.failNextWrite = true;
  await assert.rejects(s.put('regions', region('r2')), /simulated/);
  let got; s.watch('regions', (m) => { got = m; });
  assert.deepEqual([...got.keys()], ['r1']);
  assert.equal(JSON.parse(await libText(root, 'records/S1.json')).regions.length, 1);
});

test('library store: putRun appends and getRun returns the latest; listRuns lists both', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  assert.equal(await s.getRun('S1'), null);
  await s.putRun('S1', { schema: 2, n: 1 }, [{ rows: [1] }]);
  await s.putRun('S1', { schema: 2, n: 2 }, [{ rows: [2] }]);
  assert.equal((await s.getRun('S1')).n, 2);
  const runs = await s.listRuns('S1');
  assert.equal(runs.length, 2);
  assert.ok(runs[0].at < runs[1].at);
  assert.match(runs[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const names = (await FS.list(root, `${S.LIBRARY_DIR}/runs/S1`)).map((e) => e.name);
  const stored = JSON.parse(await libText(root, `runs/S1/${names.sort()[1]}`));
  assert.deepEqual(stored.chunks, [{ rows: [2] }]);
  assert.deepEqual(await s.listRuns('nope'), []);
  assert.ok(!s.isEmpty());
});

test('library store: a library.json from a newer version refuses to open; unreadable JSON refuses', async () => {
  const newer = makeFakeDir();
  await FS.writeText(newer, 'VoxelBench/library.json', JSON.stringify({ schema: 'voxelbench-library', version: 2, created: 'x' }));
  await assert.rejects(S.makeLibraryStore(newer, { toolVersion: '0.1.0' }), /newer/);
  assert.equal(JSON.parse(await libText(newer, 'library.json')).version, 2, 'nothing was rewritten');

  const junk = makeFakeDir();
  await FS.writeText(junk, 'VoxelBench/library.json', '{not json');
  await assert.rejects(S.makeLibraryStore(junk, { toolVersion: '0.1.0' }), /library\.json/);
  assert.equal(await libText(junk, 'library.json'), '{not json');

  const badRecords = makeFakeDir();
  await S.makeLibraryStore(badRecords, { toolVersion: '0.1.0' });
  await FS.writeText(badRecords, 'VoxelBench/records/S1.json', 'oops');
  await assert.rejects(S.makeLibraryStore(badRecords, { toolVersion: '0.1.0' }), /S1\.json/);
  assert.equal(await libText(badRecords, 'records/S1.json'), 'oops');

  const foreign = makeFakeDir();
  await FS.writeText(foreign, 'VoxelBench/library.json', JSON.stringify({ schema: 'something-else', version: 1 }));
  await assert.rejects(S.makeLibraryStore(foreign, { toolVersion: '0.1.0' }));
});

test('library store: importProject keeps runs and records', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  const p = await (await filled()).exportProject('0.1.0');
  const res = await s.importProject(p);
  assert.equal(res.added, 6);
  const out = await s.exportProject('0.1.0');
  assert.deepEqual(out.runs, { S1: run });
  assert.equal(out.regions.length, 3);
  assert.equal(out.samples.length, 2);
  assert.equal(out.labels.length, 1);
  // in a library runs keep a history: importing again adds no run that is already there (same scan, same time)
  // and never renames one into a folder of no scan
  const res2 = await s.importProject(p);
  assert.deepEqual(res2.renamedRuns, []);
  assert.deepEqual(res2.runsAlready, ['S1']);
  assert.equal((await s.listRuns('S1')).length, 1);
  assert.deepEqual((await FS.list(root, `${S.LIBRARY_DIR}/runs`)).map((e) => e.name), ['S1']);
});

test('library store: putFile writes under VoxelBench and refuses library.json', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.putFile('thumbs/S1.png', new Blob([new Uint8Array([7])]));
  const f = await (await (await (await root.getDirectoryHandle('VoxelBench')).getDirectoryHandle('thumbs')).getFileHandle('S1.png')).getFile();
  assert.equal(f.size, 1);
  await assert.rejects(s.putFile('library.json', new Blob(['x'])));
});

test('library store: a failed first write leaves no empty file, and the library still opens', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.putRun('S1', { n: 1 }, []);
  root.shared.failNextWrite = true;
  await assert.rejects(s.putRun('S1', { n: 2 }, []), /simulated/);
  assert.equal((await s.getRun('S1')).n, 1);
  assert.equal((await s.listRuns('S1')).length, 1);
  root.shared.failNextWrite = true;
  await assert.rejects(s.put('samples', sample('NEW')), /simulated/);
  const again = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  assert.equal((await again.getRun('S1')).n, 1);
  assert.equal(await libText(root, 'records/NEW.json'), null);
  // a failed creation of library.json itself leaves nothing that blocks the next open
  const fresh = makeFakeDir();
  fresh.shared.failNextWrite = true;
  await assert.rejects(S.makeLibraryStore(fresh, { toolVersion: '0.1.0' }), /simulated/);
  await S.makeLibraryStore(fresh, { toolVersion: '0.1.0' });
});

test('library store: putFile writes only thumbs/ and non-json files under runs/<folder>/, never over a saved file', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.putRun('S1', { n: 1 }, []);
  await s.put('labels', { id: 'a', label: 'A' });
  await s.put('presets', { id: 'p' });
  await s.put('samples', sample('S1'));
  const runName = (await FS.list(root, `${S.LIBRARY_DIR}/runs/S1`))[0].name;
  await s.putFile('thumbs/S1.png', new Blob(['1']));
  await s.putFile('thumbs/S1.png', new Blob(['2'])); // thumbnails may be refreshed
  await s.putFile('runs/S1/2026-11-05T12-00-00.000Z-review.pdf', new Blob(['pdf']));
  const before = {};
  const paths = [`runs/S1/${runName}`, 'records/S1.json', 'labels.json', 'presets.json', 'library.json'];
  for (const p of paths) before[p] = await libText(root, p);
  const refused = [...paths, 'LIBRARY.json', 'Library.JSON', 'Labels.json', 'RECORDS/S1.json', 'runs/S1/' + runName.toUpperCase(),
    'runs/S1/2026-11-05T12-00-00.000Z-review.pdf', 'runs/x.pdf', 'other/x.pdf', 'thumbs/../library.json', 'thumbs'];
  for (const p of refused) await assert.rejects(s.putFile(p, new Blob(['BAD'])), undefined, p);
  for (const p of paths) assert.equal(await libText(root, p), before[p], p);
  assert.equal(await libText(root, 'thumbs/S1.png'), '2');
});

test('library store: a library.json, labels.json or presets.json that is JSON but not the expected shape refuses', async () => {
  for (const bad of ['null', '0', 'false', '""', '[]', '7']) {
    const root = makeFakeDir();
    await FS.writeText(root, 'VoxelBench/library.json', bad);
    await assert.rejects(S.makeLibraryStore(root, { toolVersion: '0.1.0' }), /library\.json/, bad);
    assert.equal(await libText(root, 'library.json'), bad, 'untouched');
  }
  for (const f of ['labels.json', 'presets.json', 'records/S1.json']) {
    for (const bad of ['null', '0', 'false', '""', '{}x']) {
      const root = makeFakeDir();
      await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
      await FS.writeText(root, `VoxelBench/${f}`, bad);
      await assert.rejects(S.makeLibraryStore(root, { toolVersion: '0.1.0' }), new RegExp(f.replace('.', '\\.')), `${f} ${bad}`);
      assert.equal(await libText(root, f), bad, 'untouched');
    }
  }
});

test('library store: reads and writes throw when the library folder is gone, rather than reporting no data', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.putRun('S1', { n: 1 }, []);
  assert.equal(await s.getRun('nope'), null, 'a missing run in a present library is just absent');
  await root.removeEntry(S.LIBRARY_DIR);
  await assert.rejects(s.getRun('S1'), /library drive is not available/);
  await assert.rejects(s.listRuns('S1'), /library drive is not available/);
  await assert.rejects(s.exportProject('0.1.0'), /library drive is not available/);
  await assert.rejects(s.putRun('S1', { n: 2 }, []), /library drive is not available/);
  await assert.rejects(s.put('samples', sample('S9')), /library drive is not available/);
  await assert.rejects(root.getDirectoryHandle(S.LIBRARY_DIR), /could not be found/, 'nothing was recreated');
});

// ---------- Task 7: run history on import, review sheets beside runs, export of a selection ----------
test('library store: putRun files a run at its own time when given; an imported older run does not become the latest', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.putRun('S1', { n: 'new' }, []);
  await s.putRun('S1', { n: 'old', created_at: '2020-01-02T03:04:05.678Z' }, [], { at: '2020-01-02T03:04:05.678Z' });
  const runs = await s.listRuns('S1');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].at, '2020-01-02T03:04:05.678Z');
  assert.equal((await s.getRun('S1')).n, 'new');
  // a second run at the same instant gets its own file, never replacing the first
  await s.putRun('S1', { n: 'old2' }, [], { at: '2020-01-02T03:04:05.678Z' });
  assert.equal((await s.listRuns('S1')).length, 3);
});

test('library store: importProject keeps the library\'s own sample details, fills the missing ones, and adds runs to the history', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.put('samples', { id: 'S1', folder: 'S1', name: 'Kept name', starred: true });
  await s.put('regions', { ...region('r1'), note: 'library' });
  await s.putRun('S1', { n: 'library run' }, []);
  const p = await (await filled()).exportProject('0.1.0');
  p.runs.S1.doc.created_at = '2021-05-06T07:08:09.010Z';
  const res = await s.importProject(p);
  let samples; s.watch('samples', (m) => { samples = m; });
  assert.equal(samples.get('S1').name, 'Kept name');
  assert.equal(samples.get('S1').material, 'PA12', 'a field the library lacked is filled from the project');
  assert.equal(samples.get('S1').starred, true);
  let regions; s.watch('regions', (m) => { regions = m; });
  assert.equal(regions.get('r1').note, 'library', 'a record already in the library is not overwritten');
  assert.deepEqual(res.keptRecords, ['samples/S1', 'regions/r1']);
  assert.deepEqual(res.runsAdded, ['S1']);
  const runs = await s.listRuns('S1');
  assert.deepEqual(runs.map((r) => r.at)[0], '2021-05-06T07:08:09.010Z');
  assert.equal((await s.getRun('S1')).n, 'library run', 'the imported older run is history, not the latest');
});

test('library store: listSheets lists the review sheets saved beside a scan\'s runs, and nothing else', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  assert.deepEqual(await s.listSheets('S 1'), []);
  await s.putRun('S 1', { n: 1 }, []);
  assert.deepEqual(await s.listSheets('S 1'), [], 'a run alone is not a sheet');
  const at = new Date('2026-11-05T12:00:00.000Z');
  assert.equal(S.sheetPath('S 1', at), `runs/${encodeURIComponent('S 1')}/2026-11-05T12-00-00.000Z-review.pdf`);
  await s.putFile(S.sheetPath('S 1', at), new Blob(['pdf']));
  await s.putFile(`runs/${encodeURIComponent('S 1')}/notes.pdf`, new Blob(['other']));
  assert.deepEqual(await s.listSheets('S 1'), [{ at: '2026-11-05T12:00:00.000Z', name: '2026-11-05T12-00-00.000Z-review.pdf' }]);
  assert.equal((await s.listRuns('S 1')).length, 1, 'the sheet is not a run');
  assert.deepEqual(await s.listSheets('S2'), []);
});

test('library store: exportProject(folders) exports only those scans\' records and runs, plus labels and presets', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.put('samples', sample('S1')); await s.put('samples', sample('S2'));
  await s.put('regions', region('r1')); await s.put('regions', { ...region('r2'), sample: { folder: 'S2' } });
  await s.put('labels', { id: 'region_a', label: 'Region A' });
  await s.putRun('S1', { n: 1 }, []); await s.putRun('S2', { n: 2 }, []);
  const p = await s.exportProject('0.1.0', ['S2']);
  assert.deepEqual(p.samples.map((r) => r.id), ['S2']);
  assert.deepEqual(p.regions.map((r) => r.id), ['r2']);
  assert.deepEqual(Object.keys(p.runs), ['S2']);
  assert.equal(p.labels.length, 1);
  const all = await s.exportProject('0.1.0');
  assert.deepEqual(Object.keys(all.runs).sort(), ['S1', 'S2'], 'no folders: the whole library, as before');
});

// ---------- Task 7 fix 1: import dedupes runs by content (Ruling 17) ----------
// Shaped like a real Save run (ct_rail.js saveRun): created_at is stamped when the run is built, and putRun names the
// file with its own clock a moment later, so a native run's file time never equals its created_at.
const savedRun = (createdAt, porosity) => ({
  schema: 2, created_at: createdAt, settings: { poreThreshold: 1300, bodyThreshold: 900 }, binFactor: 1,
  sample: { folder: 'S1', name: 'S1' }, summary: { all_void_percent_of_body: porosity, pore_count: 12 },
  voxel_mm: 0.04, bin_factor: 1, scan: null, relative_scale: [], chunk_count: 1, regions: [], zones: { labels: {} },
});

test('library store: a native run exported and imported back into the same library is not added again', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.putRun('S1', savedRun('2020-01-02T03:04:05.000Z', 7.5), [{ rows: [1] }]); // filed at now, not at created_at
  assert.notEqual((await s.listRuns('S1'))[0].at, '2020-01-02T03:04:05.000Z', 'the fixture is a real-shaped run');
  const res = await s.importProject(await s.exportProject('0.1.0', ['S1']));
  assert.deepEqual(res.runsAlready, ['S1']);
  assert.deepEqual(res.runsAdded, []);
  assert.equal((await s.listRuns('S1')).length, 1);
});

test('library store: a run whose time collides with a different run is imported once, not again on every import', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  const t = '2021-05-06T07:08:09.010Z';
  await s.putRun('S1', savedRun(t, 1), [], { at: t });
  const p = { schema: 'voxelbench-project', version: 1, runs: { S1: { doc: savedRun(t, 2), chunks: [] } } };
  assert.deepEqual((await s.importProject(p)).runsAdded, ['S1']); // filed 1 ms later
  for (let k = 0; k < 2; k++) assert.deepEqual((await s.importProject(p)).runsAlready, ['S1']);
  assert.equal((await s.listRuns('S1')).length, 2);
});

test('library store: an imported label that differs from the library\'s label of the same id is named, and the library\'s is kept', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.put('labels', { id: 'label_4', label: 'Dense', color: '#a0e070' });
  await s.put('labels', { id: 'region_a', label: 'Region A', color: '#6ec3ff' });
  const p = { schema: 'voxelbench-project', version: 1,
    labels: [{ id: 'label_4', label: 'Phantom', color: '#a0e070' }, { color: '#6ec3ff', label: 'Region A', id: 'region_a' }] };
  const res = await s.importProject(p);
  assert.deepEqual(res.labelClashes, [{ id: 'label_4', library: 'Dense', project: 'Phantom' }]);
  let labels; s.watch('labels', (m) => { labels = m; });
  assert.equal(labels.get('label_4').label, 'Dense');
});

test('fileSafe: a name usable as a file name on every drive', () => {
  assert.equal(S.fileSafe('Cube 3/4: top?'), 'Cube 3_4_ top_');
  assert.equal(S.fileSafe('  '), '');
  assert.equal(S.fileSafe('a\\b*c"d<e>f|g'), 'a_b_c_d_e_f_g');
});

// ---------- final review C1: macOS AppleDouble files (._<name>) and .DS_Store on an exFAT drive ----------
// macOS writes a "._<name>" companion beside every file it touches on a drive without extended attributes. Its bytes
// start with the AppleDouble magic 00 05 16 07, so it is never JSON.
const APPLE_DOUBLE = new Blob([new Uint8Array([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, 0x4d, 0x61, 0x63, 0x20, 0x4f, 0x53, 0x20, 0x58])]);

test('library store: AppleDouble and .DS_Store files are not records, runs or sheets', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.put('samples', { id: 's1', folder: 's1', name: 'Part one' });
  await s.putRun('s1', savedRun('2026-11-05T14:03:22.123Z', 2.5), [{ rows: [1] }]);
  await s.putFile('runs/s1/2026-11-05T14-10-00.000Z-review.pdf', new Blob(['%PDF']));
  const [runName] = (await FS.list(root, `${S.LIBRARY_DIR}/runs/s1`)).map((e) => e.name).filter((n) => n.endsWith('.json'));
  for (const p of ['records/._s1.json', 'records/.DS_Store', `runs/s1/._${runName}`, 'runs/s1/._2026-11-05T14-10-00.000Z-review.pdf', 'runs/s1/.DS_Store', 'runs/._s1', '._library.json']) {
    await FS.writeBlob(root, `${S.LIBRARY_DIR}/${p}`, APPLE_DOUBLE);
  }
  const again = await S.makeLibraryStore(root, { toolVersion: '0.1.0' }); // opens: the ._s1.json is not read as a records file
  let samples; again.watch('samples', (m) => { samples = m; });
  assert.deepEqual([...samples.keys()], ['s1']);
  const runs = await again.listRuns('s1');
  assert.equal(runs.length, 1, 'the ._ companion of a run is not a run');
  assert.equal((await again.getRun('s1')).summary.all_void_percent_of_body, 2.5, 'the latest run is the real one, not ._<time>.json');
  assert.deepEqual((await again.listSheets('s1')).map((x) => x.name), ['2026-11-05T14-10-00.000Z-review.pdf']);
  const out = await again.exportProject('0.1.0');
  assert.deepEqual(Object.keys(out.runs), ['s1'], 'no run folder named ._s1');
  // an import compares against the real runs only (a ._ file would throw "not a saved run")
  const res = await again.importProject(await again.exportProject('0.1.0', ['s1']));
  assert.deepEqual(res.runsAlready, ['s1']);
});

test('isHidden: dot-names (AppleDouble ._x, .DS_Store) are hidden; ordinary names are not', () => {
  for (const n of ['._s1.json', '.DS_Store', '._2026-11-05T14-03-22.123Z.json', '.Trashes']) assert.equal(FS.isHidden(n), true, n);
  for (const n of ['s1.json', 'VoxelBench', 'scan_._1', '2026-11-05T14-03-22.123Z.json']) assert.equal(FS.isHidden(n), false, n);
});

// ---------- final review I2 (Ruling 19): a small summary per analyzed scan, so opening a library reads no full run ----------
const fullRun = (createdAt, porosity, extra = {}) => ({ ...savedRun(createdAt, porosity), scan: { kv: 80, ua: 220, scanSeconds: 240 },
  summary: { all_void_percent_of_body: porosity, pore_count: 12, crack_like_count: 3, body_volume_mm3: 512 }, ...extra });

test('library store: putRun also writes summaries/<scan>.json, outside the run folder', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.putRun('s1', fullRun('2026-11-05T14:03:00.000Z', 2.5), [{ rows: [1] }]);
  const [{ at }] = await s.listRuns('s1');
  assert.deepEqual(JSON.parse(await libText(root, 'summaries/s1.json')), { at, porosity: 2.5, pore_count: 12, crack_like_count: 3, kv: 80 });
  assert.equal((await s.listRuns('s1')).length, 1, 'the summary is not counted as a run');
  // an imported older run joins the history but the summary stays the latest run's
  await s.putRun('s1', fullRun('2020-01-02T03:04:05.678Z', 9), [], { at: '2020-01-02T03:04:05.678Z' });
  assert.equal(JSON.parse(await libText(root, 'summaries/s1.json')).porosity, 2.5);
  // a run without a crack count or a scanner record says so with nulls / no field, never a made-up value
  await s.putRun('s2', savedRun('2026-11-05T15:00:00.000Z', 1.25), []);
  const two = JSON.parse(await libText(root, 'summaries/s2.json'));
  assert.equal(two.kv, null);
  assert.equal('crack_like_count' in two, false);
  assert.equal(two.pore_count, 12);
});

test('library store: latestSummary reads the summary, not the run; a run saved before summaries is read once and summarized', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  assert.equal(await s.latestSummary('s1'), null, 'no run: null, not analyzed');
  // a run saved by the previous version: a run file and no summary
  const name = '2026-10-30T09-00-00.000Z.json';
  await FS.writeText(root, `${S.LIBRARY_DIR}/runs/s1/${name}`, JSON.stringify({ doc: fullRun('2026-10-30T08:59:59.000Z', 4.5), chunks: [] }));
  const again = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  const first = await again.latestSummary('s1');
  assert.deepEqual(first, { at: '2026-10-30T09:00:00.000Z', porosity: 4.5, pore_count: 12, crack_like_count: 3, kv: 80 });
  assert.deepEqual(JSON.parse(await libText(root, 'summaries/s1.json')), first, 'the derived summary is written');
  // from now on the run itself is not read: an unreadable run file does not matter while the summary is current
  await FS.writeText(root, `${S.LIBRARY_DIR}/runs/s1/${name}`, 'not json');
  assert.deepEqual(await again.latestSummary('s1'), first);
});

test('library store: a summary older than the latest run is not trusted; the run is read and the summary rewritten', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.putRun('s1', fullRun('2026-11-05T14:03:00.000Z', 2.5), []);
  // a newer run filed without its summary (an older VoxelBench, or the summary write failed)
  await FS.writeText(root, `${S.LIBRARY_DIR}/runs/s1/2030-01-01T00-00-00.000Z.json`, JSON.stringify({ doc: fullRun('2030-01-01T00:00:00.000Z', 7), chunks: [] }));
  const got = await s.latestSummary('s1');
  assert.equal(got.at, '2030-01-01T00:00:00.000Z');
  assert.equal(got.porosity, 7);
  // a summary file that is not readable is a cache miss, not an error
  await FS.writeText(root, `${S.LIBRARY_DIR}/summaries/s1.json`, '{oops');
  assert.equal((await s.latestSummary('s1')).porosity, 7);
  // an unreadable run with no usable summary is an error, never "not analyzed"
  await FS.writeText(root, `${S.LIBRARY_DIR}/summaries/s1.json`, '{oops');
  await FS.writeText(root, `${S.LIBRARY_DIR}/runs/s1/2030-01-01T00-00-00.000Z.json`, 'not json');
  await assert.rejects(s.latestSummary('s1'), /not readable JSON/);
});

test('library store: latestSummary on an unplugged library throws and recreates nothing', async () => {
  const root = makeFakeDir();
  const s = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await s.putRun('s1', fullRun('2026-11-05T14:03:00.000Z', 2.5), []);
  await root.removeEntry(S.LIBRARY_DIR);
  await assert.rejects(s.latestSummary('s1'), /library drive is not available/);
  await assert.rejects(root.getDirectoryHandle(S.LIBRARY_DIR), /could not be found/, 'nothing was recreated');
});

// ---------- final review round 2, items 3 and 4 ----------
test('refreshSummaries: a re-check reads the summary again (a run saved on another computer), and an unreadable one becomes unknown', async () => {
  const L = require('../app/vb_library.js');
  const root = makeFakeDir();
  const here = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  await here.putRun('s1', fullRun('2026-11-05T14:03:00.000Z', 2.5), []);
  const summaries = new Map(), errors = new Map();
  await L.refreshSummaries({ ids: ['s1', 's2'], store: here, summaries, errors });
  assert.equal(summaries.get('s1').porosity, 2.5);
  assert.equal(summaries.get('s2'), null);
  const elsewhere = await S.makeLibraryStore(root, { toolVersion: '0.1.0' }); // another laptop on the same drive
  await elsewhere.putRun('s2', fullRun('2026-11-06T09:00:00.000Z', 4), []);
  await L.refreshSummaries({ ids: ['s1', 's2'], store: here, summaries, errors });
  assert.equal(summaries.get('s2'), null, 'without a re-check nothing is read again');
  await L.refreshSummaries({ ids: ['s1', 's2'], store: here, summaries, errors, recheck: new Set(['s1', 's2']) });
  assert.equal(summaries.get('s2').porosity, 4, 'the Rescan\'s re-check finds it');
  await FS.writeText(root, `${S.LIBRARY_DIR}/summaries/s2.json`, '{oops');
  await FS.writeText(root, `${S.LIBRARY_DIR}/runs/s2/${(await FS.list(root, `${S.LIBRARY_DIR}/runs/s2`))[0].name}`, 'not json');
  const recheck = new Set(['s2']);
  await L.refreshSummaries({ ids: ['s2'], store: here, summaries, errors, recheck });
  assert.equal(summaries.has('s2'), false, 'unreadable now: unknown, not the old value');
  assert.match(errors.get('s2'), /not readable JSON/);
  assert.equal(recheck.size, 0, 're-checked ids are done');
});

test('connect: a downloads capability that never answers does not hold up the page', async () => {
  const hung = S.connect(async (name) => (name === 'db' ? makeFakeDb() : new Promise(() => {})), 30);
  const out = await Promise.race([hung, new Promise((r) => setTimeout(() => r('still waiting'), 500))]);
  assert.notEqual(out, 'still waiting');
  assert.equal(out.store.kind, 'artifact');
  assert.equal(out.downloads, null);
});
