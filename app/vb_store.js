/* Where records live. One interface, two back ends: the claude.ai artifact database when the page is served as an
   artifact, otherwise a project file the user saves next to the scan. A project moves between the two through
   exportProject / importProject. Runs keep version 10's database paths: pore_runs/<folder>, chunks in a subcollection. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROJECT_SCHEMA = 'voxelbench-project';
  const PROJECT_VERSION = 1;
  const COLLECTIONS = ['samples', 'labels', 'regions', 'annotations'];
  const copy = (o) => JSON.parse(JSON.stringify(o));

  function checkProject(obj) {
    if (!obj || obj.schema !== PROJECT_SCHEMA) throw new Error('Not a VoxelBench project');
    if (!(obj.version <= PROJECT_VERSION)) throw new Error(`Project schema version ${obj.version} is newer than this VoxelBench (${PROJECT_VERSION})`);
  }

  // Shared by both back ends: records first, then runs under a free name so no saved run is ever replaced.
  async function importInto(store, obj) {
    checkProject(obj);
    let added = 0;
    for (const c of COLLECTIONS) for (const r of obj[c] || []) { await store.put(c, r); added++; }
    const renamedRuns = [];
    for (const [folder, r] of Object.entries(obj.runs || {})) {
      let name = folder;
      for (let k = 1; await store.getRun(name); k++) name = `${folder} (imported ${k})`;
      if (name !== folder) renamedRuns.push(name);
      await store.putRun(name, r.doc, r.chunks || []);
    }
    return { added, renamedRuns };
  }

  const header = (toolVersion) => ({ schema: PROJECT_SCHEMA, version: PROJECT_VERSION, tool_version: toolVersion });

  function makeFileStore() {
    const data = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
    const runs = new Map();
    const watchers = Object.fromEntries(COLLECTIONS.map((c) => [c, new Set()]));
    const view = (c) => new Map([...data[c]].map(([id, r]) => [id, copy(r)]));
    const notify = (c) => { for (const fn of watchers[c]) fn(view(c)); };
    const store = {
      kind: 'file',
      watch(c, fn) { watchers[c].add(fn); fn(view(c)); return () => watchers[c].delete(fn); },
      async put(c, record) { data[c].set(record.id, copy(record)); notify(c); },
      async remove(c, id) { data[c].delete(id); notify(c); },
      async getRun(folder) { return runs.has(folder) ? copy(runs.get(folder).doc) : null; },
      async putRun(folder, doc, chunks) { runs.set(folder, copy({ doc, chunks })); },
      async exportProject(toolVersion) {
        const out = header(toolVersion);
        for (const c of COLLECTIONS) out[c] = [...data[c].values()].map(copy);
        out.runs = Object.fromEntries([...runs].map(([f, r]) => [f, copy(r)]));
        return out;
      },
      importProject: (obj) => importInto(store, obj),
      isEmpty: () => !runs.size && COLLECTIONS.every((c) => !data[c].size),
    };
    return store;
  }

  // Records the database returns are frozen: they are passed on as they are and never written to.
  function makeArtifactStore(db) {
    const cache = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
    const store = {
      kind: 'artifact',
      watch(c, fn, onError) {
        return db.collection(c).onSnapshot((snap) => {
          cache[c] = new Map(snap.docs.map((d) => [d.id, d.data()]));
          fn(cache[c]);
        }, onError);
      },
      put: (c, record) => db.collection(c).doc(record.id).set(record),
      remove: (c, id) => db.collection(c).doc(id).delete(),
      async getRun(folder) {
        const snap = await db.doc(`pore_runs/${folder}`).get();
        return snap.exists ? snap.data() : null;
      },
      async putRun(folder, doc, chunks) {
        const ref = db.doc(`pore_runs/${folder}`);
        for (let i = 0; i < chunks.length; i++) await ref.collection('chunks').doc(String(i)).set(chunks[i]);
        await ref.set(doc);
      },
      // The database cannot list runs, so the caller names the folders whose runs to include.
      async exportProject(toolVersion, folders = []) {
        const out = header(toolVersion);
        for (const c of COLLECTIONS) out[c] = [...cache[c].values()].map(copy);
        out.runs = {};
        for (const f of folders) {
          const doc = await store.getRun(f);
          if (!doc) continue;
          const chunks = [];
          for (let i = 0; i < (doc.chunk_count || 0); i++) chunks.push(copy((await db.doc(`pore_runs/${f}`).collection('chunks').doc(String(i)).get()).data()));
          out.runs[f] = { doc: copy(doc), chunks };
        }
        return out;
      },
      importProject: (obj) => importInto(store, obj),
      isEmpty: () => COLLECTIONS.every((c) => !cache[c].size),
    };
    return store;
  }

  /** Offer a file to the viewer: the downloads capability when there is one, else a plain download link. */
  async function saveBlob(downloads, filename, blob) {
    if (downloads) {
      try {
        await downloads.save({ filename, data: blob });
        return 'saved';
      } catch (e) {
        if (e.code === 'declined') return 'declined';
        throw e;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    const t = setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    if (t && t.unref) t.unref(); // Node tests: the timer must not hold the process open
    return 'link';
  }

  /** The store for this page: the artifact database when use('db') answers within timeoutMs, else a project file.
      note says why the file store was chosen when a database was asked for and failed. */
  async function connect(use, timeoutMs = 10000) {
    if (!use) return { store: makeFileStore(), downloads: null, note: '' };
    let note = '';
    const db = await Promise.race([
      Promise.resolve().then(() => use('db')).catch((e) => { note = `the database failed (${e.message}); records go to a project file`; return null; }),
      new Promise((r) => setTimeout(() => { note = note || `the database did not answer within ${timeoutMs / 1000} s; records go to a project file`; r(null); }, timeoutMs)),
    ]);
    if (!db) return { store: makeFileStore(), downloads: null, note };
    const downloads = await Promise.resolve().then(() => use('downloads')).catch(() => null);
    return { store: makeArtifactStore(db), downloads, note: '' };
  }

  return { PROJECT_SCHEMA, PROJECT_VERSION, COLLECTIONS, makeFileStore, makeArtifactStore, connect, saveBlob };
}));
