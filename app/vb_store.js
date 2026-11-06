/* Where records live. One interface, three back ends: the claude.ai artifact database when the page is served as an
   artifact, otherwise a project file the user saves next to the scan, or a library folder on a shared drive. A project moves between the two through
   exportProject / importProject. Runs keep version 10's database paths: pore_runs/<folder>, chunks in a subcollection. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_fsdir.js'));
  else root.VBStore = factory(root.VBFsDir);
}(typeof self !== 'undefined' ? self : this, function (FS) {
  'use strict';

  const PROJECT_SCHEMA = 'voxelbench-project';
  const PROJECT_VERSION = 1;
  const COLLECTIONS = ['samples', 'labels', 'regions', 'annotations', 'presets'];
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

  // ---- The library: a folder on a shared drive ----
  const LIBRARY_DIR = 'VoxelBench';
  const LIBRARY_SCHEMA = 'voxelbench-library';
  const LIBRARY_VERSION = 1;
  const PER_SCAN = ['samples', 'regions', 'annotations']; // stored together in records/<scan folder>.json
  const GLOBAL_FILE = { labels: 'labels.json', presets: 'presets.json' };
  const enc = encodeURIComponent;
  // Records of a scan's own collections belong to the folder they name; a sample's id is its folder.
  const folderOf = (c, r) => (c === 'samples' ? r.id : (r.sample && r.sample.folder) || '_unfiled');
  // ISO times sort as text; ':' is not allowed in file names on every drive, so the file name uses '-' there.
  const runFileName = (d) => `${d.toISOString().replace(/:/g, '-')}.json`;
  const runTime = (name) => name.slice(0, -5).replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');

  async function readJson(root, path) {
    const text = await FS.readText(root, path);
    if (text === null) return null;
    try { return JSON.parse(text); } catch (e) { throw new Error(`${path} is not readable JSON (${e.message}); it was left untouched`); }
  }

  /** Open (or start) the library under dir. Refuses, writing nothing, when it cannot be read safely. */
  async function makeLibraryStore(dir, opts = {}) {
    const base = (p) => `${LIBRARY_DIR}/${p}`;
    const lib = await readJson(dir, base('library.json'));
    if (lib) {
      if (lib.schema !== LIBRARY_SCHEMA) throw new Error(`${LIBRARY_DIR}/library.json is not a VoxelBench library; it was left untouched`);
      if (!(lib.version <= LIBRARY_VERSION)) throw new Error(`The library is from a newer VoxelBench (library version ${lib.version}, this one reads ${LIBRARY_VERSION}); open it with the newer VoxelBench`);
    }

    const data = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
    const watchers = Object.fromEntries(COLLECTIONS.map((c) => [c, new Set()]));
    // Load everything before writing anything, so a bad file refuses the whole open.
    for (const e of await FS.list(dir, base('records'))) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const path = base(`records/${e.name}`);
      const doc = await readJson(dir, path);
      if (!doc || typeof doc !== 'object' || PER_SCAN.some((c) => doc[c] !== undefined && !Array.isArray(doc[c]))) throw new Error(`${path} is not a VoxelBench records file; it was left untouched`);
      for (const c of PER_SCAN) for (const r of doc[c] || []) data[c].set(r.id, r);
    }
    for (const [c, file] of Object.entries(GLOBAL_FILE)) {
      const arr = await readJson(dir, base(file));
      if (arr === null) continue;
      if (!Array.isArray(arr)) throw new Error(`${base(file)} is not a VoxelBench records file; it was left untouched`);
      for (const r of arr) data[c].set(r.id, r);
    }
    const runFolders = new Set();
    for (const e of await FS.list(dir, base('runs'))) if (e.kind === 'directory') runFolders.add(decodeURIComponent(e.name));

    if (!lib) await FS.writeText(dir, base('library.json'), JSON.stringify({ schema: LIBRARY_SCHEMA, version: LIBRARY_VERSION, created: new Date().toISOString() }, null, 2));

    const view = (c) => new Map([...data[c]].map(([id, r]) => [id, copy(r)]));
    const notify = (c) => { for (const fn of watchers[c]) fn(view(c)); };
    // Writes go one at a time so two changes to the same file cannot interleave.
    let queue = Promise.resolve();
    const serial = (fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };

    async function writeRecords(c, folder) {
      if (GLOBAL_FILE[c]) return FS.writeText(dir, base(GLOBAL_FILE[c]), JSON.stringify([...data[c].values()], null, 2));
      const doc = Object.fromEntries(PER_SCAN.map((k) => [k, [...data[k].values()].filter((r) => folderOf(k, r) === folder)]));
      return FS.writeText(dir, base(`records/${enc(folder)}.json`), JSON.stringify(doc, null, 2));
    }

    // Change memory, write the file, and put memory back if the write fails, so the page never shows what the drive lacks.
    async function change(c, id, next, folder) {
      const prev = data[c].get(id);
      if (next) data[c].set(id, next); else data[c].delete(id);
      try {
        await writeRecords(c, folder);
      } catch (e) {
        if (prev) data[c].set(id, prev); else data[c].delete(id);
        throw e;
      }
      notify(c);
    }

    const runDir = (folder) => base(`runs/${enc(folder)}`);
    const runNames = async (folder) => (await FS.list(dir, runDir(folder))).filter((e) => e.kind === 'file' && e.name.endsWith('.json')).map((e) => e.name).sort();

    const store = {
      kind: 'library',
      watch(c, fn) { watchers[c].add(fn); fn(view(c)); return () => watchers[c].delete(fn); },
      put: (c, record) => serial(() => change(c, record.id, copy(record), folderOf(c, record))),
      remove: (c, id) => serial(() => {
        const r = data[c].get(id);
        return r ? change(c, id, null, folderOf(c, r)) : undefined;
      }),
      async getRun(folder) {
        const names = await runNames(folder);
        if (!names.length) return null;
        return (await readJson(dir, `${runDir(folder)}/${names[names.length - 1]}`)).doc;
      },
      putRun: (folder, doc, chunks) => serial(async () => {
        const have = new Set(await runNames(folder));
        const t = new Date();
        while (have.has(runFileName(t))) t.setTime(t.getTime() + 1); // two runs in one millisecond still get two files
        await FS.writeText(dir, `${runDir(folder)}/${runFileName(t)}`, JSON.stringify({ doc, chunks }));
        runFolders.add(folder);
      }),
      async listRuns(folder) { return (await runNames(folder)).map((n) => ({ at: runTime(n) })); },
      putFile(path, blob) {
        if (path === 'library.json') return Promise.reject(new Error('library.json is written only by the library itself'));
        return serial(() => FS.writeBlob(dir, base(path), blob));
      },
      async exportProject(toolVersion = opts.toolVersion) {
        const out = header(toolVersion);
        for (const c of COLLECTIONS) out[c] = [...data[c].values()].map(copy);
        out.runs = {};
        for (const f of runFolders) {
          const names = await runNames(f);
          if (names.length) out.runs[f] = await readJson(dir, `${runDir(f)}/${names[names.length - 1]}`);
        }
        return out;
      },
      importProject: (obj) => importInto(store, obj),
      isEmpty: () => !runFolders.size && COLLECTIONS.every((c) => !data[c].size),
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

  return { PROJECT_SCHEMA, PROJECT_VERSION, COLLECTIONS, LIBRARY_DIR, makeFileStore, makeArtifactStore, makeLibraryStore, connect, saveBlob };
}));
