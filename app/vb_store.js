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
  const segments = (path) => FS.segments(path);
  // Records of a scan's own collections belong to the folder they name; a sample's id is its folder.
  const folderOf = (c, r) => (c === 'samples' ? r.id : (r.sample && r.sample.folder) || '_unfiled');
  // ISO times sort as text; ':' is not allowed in file names on every drive, so the file name uses '-' there.
  const runFileName = (d) => `${d.toISOString().replace(/:/g, '-')}.json`;
  const runTime = (name) => name.slice(0, -5).replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');
  // A review sheet sits beside the scan's runs, named by the time it was made: runs/<scan>/<time>-review.pdf.
  const SHEET_SUFFIX = '-review.pdf';
  const sheetPath = (folder, d) => `runs/${enc(folder)}/${d.toISOString().replace(/:/g, '-')}${SHEET_SUFFIX}`;
  const sheetTime = (name) => name.slice(0, -SHEET_SUFFIX.length).replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');
  const validTime = (iso) => typeof iso === 'string' && !Number.isNaN(new Date(iso).getTime());

  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  /** What a library card needs from a saved run (Ruling 19), so opening a library reads this and not every full run:
      at (the run's filed time), porosity, pore_count, crack_like_count (only when the run has it) and kv. */
  function runSummary(doc, at) {
    const s = (doc && doc.summary) || {}, scan = (doc && doc.scan) || {};
    const out = { at, porosity: finite(s.all_void_percent_of_body), pore_count: finite(s.pore_count) };
    if (finite(s.crack_like_count) !== null) out.crack_like_count = s.crack_like_count;
    out.kv = finite(scan.kv);
    return out;
  }

  // undefined means the file is absent; a file holding JSON null is present and is returned as null.
  async function readJson(root, path) {
    const text = await FS.readText(root, path);
    if (text === null) return undefined;
    try { return JSON.parse(text); } catch (e) { throw new Error(`${path} is not readable JSON (${e.message}); it was left untouched`); }
  }

  /** Open (or start) the library under dir. Refuses, writing nothing, when it cannot be read safely. */
  async function makeLibraryStore(dir, opts = {}) {
    const base = (p) => `${LIBRARY_DIR}/${p}`;
    const lib = await readJson(dir, base('library.json'));
    if (lib !== undefined) {
      if (!lib || typeof lib !== 'object' || Array.isArray(lib) || lib.schema !== LIBRARY_SCHEMA) throw new Error(`${LIBRARY_DIR}/library.json is not a VoxelBench library; it was left untouched`);
      if (!(lib.version <= LIBRARY_VERSION)) throw new Error(`The library is from a newer VoxelBench (library version ${lib.version}, this one reads ${LIBRARY_VERSION}); open it with the newer VoxelBench`);
    }

    const data = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
    const watchers = Object.fromEntries(COLLECTIONS.map((c) => [c, new Set()]));
    // Load everything before writing anything, so a bad file refuses the whole open.
    for (const e of await FS.list(dir, base('records'))) {
      if (e.kind !== 'file' || FS.isHidden(e.name) || !e.name.endsWith('.json')) continue;
      const path = base(`records/${e.name}`);
      const doc = await readJson(dir, path);
      if (!doc || typeof doc !== 'object' || PER_SCAN.some((c) => doc[c] !== undefined && !Array.isArray(doc[c]))) throw new Error(`${path} is not a VoxelBench records file; it was left untouched`);
      for (const c of PER_SCAN) for (const r of doc[c] || []) data[c].set(r.id, r);
    }
    for (const [c, file] of Object.entries(GLOBAL_FILE)) {
      const arr = await readJson(dir, base(file));
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) throw new Error(`${base(file)} is not a VoxelBench records file; it was left untouched`);
      for (const r of arr) data[c].set(r.id, r);
    }
    const runFolders = new Set();
    for (const e of await FS.list(dir, base('runs'))) if (e.kind === 'directory' && !FS.isHidden(e.name)) runFolders.add(decodeURIComponent(e.name));

    if (lib === undefined) await FS.writeText(dir, base('library.json'), JSON.stringify({ schema: LIBRARY_SCHEMA, version: LIBRARY_VERSION, created: new Date().toISOString() }, null, 2));

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

    // An absent run folder is normal, but not when the whole library has vanished (drive unplugged): that is
    // unknown, not empty, and must never read as "no runs" or be silently recreated by a write.
    const ensureLibrary = async () => {
      try { await dir.getDirectoryHandle(LIBRARY_DIR); } catch (e) {
        throw new Error(`The library drive is not available (${LIBRARY_DIR} folder not found: ${e.message}); reconnect it and reopen the library`);
      }
    };
    const runDir = (folder) => base(`runs/${enc(folder)}`);
    const readRun = async (folder, name) => {
      const path = `${runDir(folder)}/${name}`;
      const r = await readJson(dir, path);
      if (!r || typeof r !== 'object' || !r.doc) throw new Error(`${path} is not a saved run; it was left untouched`);
      return r;
    };
    // summaries/<scan>.json: the latest run's runSummary. A cache: one missing, unreadable or older than the latest run
    // is made again from the run, never trusted.
    const summaryPath = (folder) => base(`summaries/${enc(folder)}.json`);
    const readSummary = async (folder) => {
      try { const o = await readJson(dir, summaryPath(folder)); return o && typeof o === 'object' && typeof o.at === 'string' ? o : undefined; } catch (e) { return undefined; }
    };
    const writeSummary = (folder, summary) => FS.writeText(dir, summaryPath(folder), JSON.stringify(summary, null, 2)).catch(() => {}); // a failed write leaves an older summary, which latestSummary does not trust
    const runNames = async (folder) => {
      const entries = await FS.list(dir, runDir(folder));
      if (!entries.length) await ensureLibrary();
      return entries.filter((e) => e.kind === 'file' && !FS.isHidden(e.name) && e.name.endsWith('.json')).map((e) => e.name).sort();
    };

    const store = {
      kind: 'library',
      watch(c, fn) { watchers[c].add(fn); fn(view(c)); return () => watchers[c].delete(fn); },
      put: (c, record) => serial(async () => { await ensureLibrary(); return change(c, record.id, copy(record), folderOf(c, record)); }),
      remove: (c, id) => serial(async () => {
        const r = data[c].get(id);
        if (!r) return undefined;
        await ensureLibrary();
        return change(c, id, null, folderOf(c, r));
      }),
      async getRun(folder) {
        const names = await runNames(folder);
        if (!names.length) return null;
        return (await readRun(folder, names[names.length - 1])).doc;
      },
      // A run is filed at the time it was made: now, or opts.at for a run made earlier (an import), so the latest run is
      // always the one made last, whatever order they arrive in.
      putRun: (folder, doc, chunks, opts = {}) => serial(async () => {
        await ensureLibrary();
        const have = new Set(await runNames(folder));
        const t = validTime(opts.at) ? new Date(opts.at) : new Date();
        while (have.has(runFileName(t))) t.setTime(t.getTime() + 1); // two runs in one millisecond still get two files
        const name = runFileName(t);
        await FS.writeText(dir, `${runDir(folder)}/${name}`, JSON.stringify({ doc, chunks }));
        runFolders.add(folder);
        if ([...have].every((n) => n < name)) await writeSummary(folder, runSummary(doc, runTime(name))); // only the latest run's
      }),
      /** The latest run's summary, or null when the scan has no saved run. Read from summaries/ when it is current; else
          (a run saved before summaries, or a stale one) from the run itself, and written for the next time. A run that
          cannot be read throws: unknown is never "not analyzed". */
      async latestSummary(folder) {
        const names = await runNames(folder);
        if (!names.length) return null;
        const latest = names[names.length - 1], at = runTime(latest);
        const have = await readSummary(folder);
        if (have && have.at === at) return have;
        const fresh = runSummary((await readRun(folder, latest)).doc, at);
        await serial(async () => { // not over a newer run's, and never into a library folder that has gone
          const now = await runNames(folder).catch(() => []);
          if (now[now.length - 1] === latest) await writeSummary(folder, fresh);
        });
        return fresh;
      },
      async listRuns(folder) { return (await runNames(folder)).map((n) => ({ at: runTime(n) })); },
      /** The review sheets saved beside a scan's runs, oldest first: [{ at, name }]. */
      async listSheets(folder) {
        const entries = await FS.list(dir, runDir(folder));
        if (!entries.length) await ensureLibrary();
        return entries.filter((e) => e.kind === 'file' && !FS.isHidden(e.name) && e.name.toLowerCase().endsWith(SHEET_SUFFIX)).map((e) => e.name).sort()
          .map((name) => ({ at: sheetTime(name), name }));
      },
      // Only two places take loose files: thumbnails, and non-JSON files (review sheets) beside a scan's runs. Records,
      // labels, presets, library.json and saved runs are all JSON, so none can be reached; names compare case-insensitively
      // because the drive may fold case. A file beside the runs is never replaced.
      putFile(path, blob) {
        return serial(async () => {
          const parts = segments(path);
          const low = parts.map((p) => p.toLowerCase());
          const thumb = low[0] === 'thumbs' && parts.length >= 2;
          const beside = low[0] === 'runs' && parts.length === 3 && !low[2].endsWith('.json');
          if (!thumb && !beside) throw new Error(`Refusing to write ${path}: the library takes only thumbs/ files and non-JSON files under runs/<scan>/`);
          await ensureLibrary();
          if (beside) {
            const have = (await FS.list(dir, base(`runs/${parts[1]}`))).map((e) => e.name.toLowerCase());
            if (have.includes(low[2])) throw new Error(`Refusing to replace the saved file ${path}`);
          }
          await FS.writeBlob(dir, base(path), blob);
        });
      },
      // folders: the scans to export (their records and latest runs; labels and presets always); omitted, every scan.
      async exportProject(toolVersion = opts.toolVersion, folders = null) {
        const out = header(toolVersion);
        const wanted = folders ? new Set(folders) : null;
        const keep = (c, r) => !wanted || GLOBAL_FILE[c] || wanted.has(folderOf(c, r));
        for (const c of COLLECTIONS) out[c] = [...data[c].values()].filter((r) => keep(c, r)).map(copy);
        out.runs = {};
        for (const f of wanted ? [...wanted] : runFolders) {
          const names = await runNames(f);
          if (names.length) out.runs[f] = await readRun(f, names[names.length - 1]);
        }
        return out;
      },
      importProject: (obj) => importIntoLibrary(store, obj, data, (folder) => runNames(folder), (folder, name) => readRun(folder, name)),
      isEmpty: () => !runFolders.size && COLLECTIONS.every((c) => !data[c].size),
    };
    return store;
  }

  /** A project into a library, whose folders are already the library's scan ids (VBLibrary.remapProject). Nothing in
      the library is overwritten: a sample record already there keeps its fields and takes only the ones it lacks, any
      other record already there is kept as it is (a label that differs is listed in labelClashes), and runs join the
      scan's history at the time they were made. A run whose content is already in the scan's history is not added again. */
  async function importIntoLibrary(store, obj, data, runNames, readRun) {
    checkProject(obj);
    let added = 0;
    const keptRecords = [], runsAdded = [], runsAlready = [], labelClashes = [];
    for (const c of COLLECTIONS) {
      for (const r of obj[c] || []) {
        const have = data[c].get(r.id);
        if (!have) { await store.put(c, r); added++; continue; }
        keptRecords.push(`${c}/${r.id}`);
        if (c === 'labels' && sorted(have) !== sorted(r)) labelClashes.push({ id: r.id, library: have.label, project: r.label });
        if (c === 'samples' && Object.keys(r).some((k) => !(k in have))) await store.put(c, { ...r, ...have });
      }
    }
    for (const [folder, r] of Object.entries(obj.runs || {})) {
      const at = r.doc && validTime(r.doc.created_at) ? r.doc.created_at : null;
      // Ruling 17: content decides, against every run of the scan. A run's file time is not its created_at (Save run
      // stamps created_at, the file is named a moment later; a clash moves it 1 ms), so time only orders the search.
      const names = await runNames(folder);
      const same = sorted(r.doc);
      const near = (n) => (at ? Math.abs(new Date(runTime(n)).getTime() - new Date(at).getTime()) : 0);
      let there = false;
      for (const n of [...names].sort((a, b) => near(a) - near(b))) if (sorted((await readRun(folder, n)).doc) === same) { there = true; break; }
      if (there) { runsAlready.push(folder); continue; }
      await store.putRun(folder, r.doc, r.chunks || [], { at });
      runsAdded.push(folder);
    }
    return { added, renamedRuns: [], keptRecords, runsAdded, runsAlready, labelClashes };
  }

  /** JSON with keys in order, so two records compare equal whatever order their fields were written in. */
  function sorted(v) {
    if (Array.isArray(v)) return `[${v.map(sorted).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sorted(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
  }

  /** A name usable as a file name on every drive: the characters Windows, macOS or exFAT refuse become _. */
  const fileSafe = (text) => String(text || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_');

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

  return { PROJECT_SCHEMA, PROJECT_VERSION, COLLECTIONS, LIBRARY_DIR, sheetPath, runSummary, checkProject, fileSafe, makeFileStore, makeArtifactStore, makeLibraryStore, connect, saveBlob };
}));
