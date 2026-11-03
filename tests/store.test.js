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
