'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const RS = require('../app/vb_recordsave.js');
const L = require('../app/vb_library.js');
const S = require('../app/vb_store.js');
const CT = require('../app/ct_core.js');
const { makeFakeDir } = require('./fake_dir.js');

// The page as the overview and the cards see it: the studio's saveRecord / saveSample (ct_app.js) over state, and the
// library's own saver (vb_libraryview.js), joined by makeScanRecordSave.
async function page({ studioUsesLibrary }) {
  const root = makeFakeDir();
  const libStore = await S.makeLibraryStore(root, { toolVersion: '0.1.0' });
  const fileStore = S.makeFileStore();
  const state = { store: studioUsesLibrary ? libStore : fileStore, unsaved: new Map(), samples: new Map() };
  const reported = [];
  const saveRecord = RS.makeSaveRecord({ store: () => state.store, unsaved: () => state.unsaved, changed() {}, markDirty() {},
    failed: (store, text) => { if (store === state.store) reported.push(text); } });
  const saveSample = (changes, folder) => {
    const pending = state.unsaved.get(folder);
    return saveRecord('samples', CT.sampleRecord(folder, state.samples, changes, pending && pending._collection === 'samples' ? pending : null));
  };
  const librarySamples = new Map();
  libStore.watch('samples', (m) => { for (const [k, v] of m) librarySamples.set(k, v); });
  const saveLibrary = L.makeRecordSaver({ samples: () => librarySamples, put: (r) => libStore.put('samples', r), sampleRecord: CT.sampleRecord });
  const save = RS.makeScanRecordSave({ activeStore: () => state.store, libraryStore: () => libStore, saveSample, saveLibrary });
  return { root, save, reported, state };
}

test('a library scan\'s record save rejects when the write fails, also while the studio uses the library store', async () => {
  for (const studioUsesLibrary of [true, false]) {
    const p = await page({ studioUsesLibrary });
    await p.save('s1', { name: 'Part one' }); // a write that succeeds resolves
    p.root.shared.failNextWrite = true;
    await assert.rejects(p.save('s1', { starred: true }), /simulated write failure/, `studio uses the library: ${studioUsesLibrary}`);
    if (studioUsesLibrary) {
      assert.equal(p.reported.length, 1, 'the studio still reports its own failed write');
      assert.match(p.reported[0], /the last save failed: simulated/);
      assert.ok(p.state.unsaved.has('s1'), 'the edit stays NOT SAVED in the studio');
    }
  }
});

test('saveRecord: a save nobody waits for raises no unhandled rejection; with no store it rejects', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const bad = { put: async () => { throw new Error('drive gone'); } };
    const saveRecord = RS.makeSaveRecord({ store: () => bad, unsaved: () => new Map(), changed() {}, markDirty() {}, failed() {} });
    saveRecord('labels', { id: 'a' }); // fire and forget, as the studio's buttons do
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
    const none = RS.makeSaveRecord({ store: () => null, unsaved: () => new Map(), changed() {}, markDirty() {}, failed() {} });
    await assert.rejects(none('labels', { id: 'a' }), /not available/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
