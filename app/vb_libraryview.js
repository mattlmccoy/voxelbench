/* The library page, the first screen: every scan under one root folder the user picks on the lab drive, as cards with
   a thumbnail, the scanner's settings and, once analyzed, porosity. Chrome and Edge only (File System Access); the
   root's handle is kept in IndexedDB and access is asked for again once per session. Scans stay where they are; the
   index (VoxelBench/scans.json), thumbnails and records live in the VoxelBench folder under the root. The logic is in
   vb_library.js; this file reads the drive and draws. */
(function (App) {
  'use strict';
  const CT = window.CT, L = window.VBLibrary, FS = window.VBFsDir, V = window.VBStore, VX = window.VBVox;
  const { state, $, on } = App;
  const INDEX_PATH = `${V.LIBRARY_DIR}/scans.json`;
  const THUMB_WIDTH = 256;
  const HANDLE_DB = { name: 'voxelbench', store: 'handles', key: 'libraryRoot' };
  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  const lib = App.library = {
    dir: null, index: null, entries: [], store: null, stacks: new Map(), samples: new Map(), runs: new Map(), runErrors: new Map(),
    thumbs: new Map(), refused: null, busy: false, lastRescan: null, gen: 0, saved: null,
  };
  const view = { query: '', filter: 'all', tag: null, project: null };
  const thumbQueue = new Map(); // id -> a thumbnail image made while reading the scan, written once the cards show
  let unwatchSamples = null;

  const rootName = () => (lib.dir && lib.dir.name) || 'browser storage'; // a test root (OPFS) has no name
  const say = (text, bad = false) => { const el = $('libStatus'); el.textContent = text; el.classList.toggle('bad', bad); };
  const notice = (text) => { $('libNotice').hidden = !text; $('libNotice').textContent = text || ''; };

  // ---------- the root folder's handle, kept between visits ----------
  function handles(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(HANDLE_DB.name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(HANDLE_DB.store);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction(HANDLE_DB.store, mode), req = fn(tx.objectStore(HANDLE_DB.store));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const keepHandle = (h) => handles('readwrite', (s) => s.put(h, HANDLE_DB.key)).catch(() => {}); // a private window may refuse; the library still opens
  const savedHandle = () => handles('readonly', (s) => s.get(HANDLE_DB.key)).catch(() => null);

  // ---------- reading the drive ----------
  // Ruling 1: a walked file looks like a file from a folder input, so CT.groupStacks and loadStack take it unchanged.
  const wrap = (path, file) => ({ webkitRelativePath: path, name: file.name, size: file.size, lastModified: file.lastModified, type: file.type,
    arrayBuffer: () => file.arrayBuffer(), slice: (...a) => file.slice(...a), text: () => file.text() });

  async function listFiles(dir, prefix = '') {
    const out = [];
    for await (const { path, file } of FS.walk(dir, prefix)) {
      out.push(wrap(path, file));
      if (out.length % 500 === 0) say(`Listing files: ${out.length}…`);
    }
    return out;
  }

  async function dirAt(path) {
    let d = lib.dir;
    for (const p of path ? FS.segments(path) : []) d = await d.getDirectoryHandle(p);
    return d;
  }

  // An unplugged drive must not read as an empty library, and a write must not recreate the folder elsewhere.
  async function ensureDrive() {
    try { await lib.dir.getDirectoryHandle(V.LIBRARY_DIR); } catch (e) {
      throw new Error(`The library drive is not available (${V.LIBRARY_DIR} folder not found: ${e.message}); reconnect it and reopen the library`);
    }
  }

  /** A thumbnail: the slice box-averaged to 256 px wide, gray window from its own 1st to 99.9th percentile. */
  function thumbImage({ width: w, height: h, pixels }) {
    const W = THUMB_WIDTH, H = Math.max(1, Math.round((h * W) / w)), { low, high } = L.grayWindow(pixels);
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const y0 = Math.floor((y * h) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / H));
      for (let x = 0; x < W; x++) {
        const x0 = Math.floor((x * w) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / W));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += pixels[yy * w + xx]; n++; }
        const i = 4 * (y * W + x);
        rgba[i] = rgba[i + 1] = rgba[i + 2] = (255 * (sum / n - low)) / (high - low);
        rgba[i + 3] = 255;
      }
    }
    return { width: W, height: H, rgba };
  }

  function pngOf({ width, height, rgba }) {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    c.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser made no PNG'))), 'image/png'));
  }

  /** The two slices that give the id, and what the scanner recorded. The middle slice becomes the thumbnail. */
  async function readScan(stack) {
    const reader = await App.openReader(stack);
    const count = reader.count, first = await reader.read(0), middle = await reader.read(count >> 1);
    if (middle.width !== first.width || middle.height !== first.height) throw new Error(`its slices differ in size (${first.width} × ${first.height} and ${middle.width} × ${middle.height})`);
    const id = await L.scanId({ width: first.width, height: first.height, count, first: first.pixels, middle: middle.pixels });
    let info = null;
    if (stack.dataInfo) { try { info = VX.parseDataInfo(await stack.dataInfo.text()); } catch (e) { info = null; } }
    thumbQueue.set(id, thumbImage(middle));
    return { id, study: (info && info.study) || null, info, width: first.width, height: first.height, count, voxel_um: first.voxelMm ? first.voxelMm * 1000 : null };
  }

  /** A scan's files, from the last Rescan or found again at its indexed path (not changed since). */
  async function stackFor(id) {
    if (lib.stacks.has(id)) return lib.stacks.get(id);
    const e = lib.index.scans[id];
    if (!e || e.missing) throw new Error('this scan was not found at the last Rescan');
    let d;
    try { d = await dirAt(e.path); } catch (err) { throw new Error(`${e.path} is not on the drive now (${err.message}); press Rescan`); }
    const files = await listFiles(d, `${e.path}/`);
    const parent = e.path.split('/').slice(0, -1).join('/'); // a TIFF export's DataInfo.xml may sit one level up
    try { files.push(wrap(`${parent ? `${parent}/` : ''}DataInfo.xml`, await (await (await dirAt(parent)).getFileHandle('DataInfo.xml')).getFile())); } catch (err) { /* none there */ }
    const stack = L.scanFolders(CT.groupStacks(files), files).find((s) => s.dir === e.path);
    if (!stack) throw new Error(`no scan was found in ${e.path}; press Rescan`);
    const now = L.stampOf(stack);
    if (now.bytes !== e.bytes || now.mtime !== e.mtime) throw new Error(`${e.path} changed since the last Rescan; press Rescan`);
    const s = { ...stack, folder: id };
    lib.stacks.set(id, s);
    return s;
  }

  // ---------- opening a library ----------
  function close() {
    lib.gen++;
    if (unwatchSamples) unwatchSamples();
    unwatchSamples = null;
    for (const url of lib.thumbs.values()) URL.revokeObjectURL(url);
    Object.assign(lib, { dir: null, index: null, entries: [], store: null, stacks: new Map(), samples: new Map(), runs: new Map(), runErrors: new Map(), thumbs: new Map(), refused: null, lastRescan: null });
    thumbQueue.clear();
  }

  /** Opens handle as the library root, without the picker (also the test hook). Refuses, writing nothing, a newer or
      unreadable library or scan index. */
  async function openLibraryDir(handle) {
    close();
    lib.dir = handle;
    const gen = lib.gen;
    say(`Opening ${handle.name || 'browser storage'}…`);
    try {
      const text = await FS.readText(handle, INDEX_PATH);
      let index;
      if (text === null) index = L.emptyIndex(new Date().toISOString());
      else {
        let obj;
        try { obj = JSON.parse(text); } catch (e) { throw new Error(`${INDEX_PATH} is not readable JSON (${e.message}); it was left untouched`); }
        index = L.checkIndex(obj);
      }
      const store = await V.makeLibraryStore(handle, { toolVersion: window.VB_VERSION });
      if (gen !== lib.gen) return;
      lib.index = index;
      lib.store = store;
      unwatchSamples = store.watch('samples', (records) => { lib.samples = records; render(); });
    } catch (e) {
      if (gen !== lib.gen) return;
      lib.refused = `The library in ${handle.name || 'browser storage'} was not opened: ${e.message}.`;
      say('');
      render();
      return;
    }
    say(`${Object.keys(lib.index.scans).length} scans in the index.`);
    render();
    if (!Object.keys(lib.index.scans).length) await rescan();
    else background(gen);
  }

  async function pick() {
    let h;
    try { h = await window.showDirectoryPicker({ id: 'voxelbench-library', mode: 'readwrite' }); } catch (e) {
      if (e.name !== 'AbortError') say(`Could not open that folder: ${e.message}`, true);
      return;
    }
    await keepHandle(h);
    lib.saved = h;
    await openLibraryDir(h);
  }

  async function resume() {
    const h = await savedHandle();
    if (!h) return;
    lib.saved = h;
    const allowed = h.queryPermission ? await h.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt') : 'prompt';
    if (allowed === 'granted') { await openLibraryDir(h); return; }
    render(); // offers "Allow access to <name>": the browser asks only after a click
  }

  async function allowSaved() {
    const h = lib.saved;
    if (!h) return;
    const allowed = await h.requestPermission({ mode: 'readwrite' }).catch((e) => { say(`Access was not allowed: ${e.message}`, true); return 'denied'; });
    if (allowed === 'granted') await openLibraryDir(h);
    else say(`Access to ${h.name} was not allowed. Choose the library folder again.`, true);
  }

  // ---------- Rescan ----------
  async function rescan() {
    if (lib.busy || !lib.dir || lib.refused) return;
    const gen = lib.gen;
    lib.busy = true;
    render();
    try {
      await ensureDrive();
      say(`Listing files under ${rootName()}…`);
      const files = await listFiles(lib.dir);
      const r = await L.rescan({ files, index: lib.index, groupStacks: CT.groupStacks, readScan, now: new Date().toISOString(),
        onRead: (stack, k) => say(`Reading ${stack.dir} (new or changed; ${k} read so far)…`) });
      if (gen !== lib.gen) return;
      await ensureDrive();
      await FS.writeText(lib.dir, INDEX_PATH, JSON.stringify(r.index, null, 2));
      lib.index = r.index;
      lib.stacks = r.stacks;
      const missing = Object.values(r.index.scans).filter((e) => e.missing).length;
      lib.lastRescan = { found: r.found, places: r.places, read: r.read, missing, failed: r.failed };
      const failed = r.failed.length ? ` Could not read ${r.failed.length}: ${r.failed.map((f) => `${f.path} (${f.message})`).join('; ')}.` : '';
      const copies = r.places - r.found;
      say(`Rescan: ${r.found} scans found${copies ? ` (${copies} more folder${copies > 1 ? 's are copies' : ' is a copy'})` : ''}; ${r.read} folder${r.read === 1 ? '' : 's'} read (new or changed), ${r.places - r.read} unchanged${missing ? `; ${missing} missing` : ''}.${failed}`, Boolean(r.failed.length));
      for (const id of r.stacks.keys()) { lib.runs.delete(id); lib.runErrors.delete(id); }
    } catch (e) {
      if (gen === lib.gen) say(`Rescan stopped: ${e.message}`, true);
    } finally {
      if (gen === lib.gen) lib.busy = false;
    }
    if (gen !== lib.gen) return;
    render();
    background(gen);
  }

  // ---------- after the cards show: saved runs, then thumbnails ----------
  // One pass at a time; a request during a pass runs another pass after it.
  let bgRunning = false, bgAgain = false;
  async function background(gen) {
    if (!lib.index || !lib.store) return;
    if (bgRunning) { bgAgain = true; return; }
    bgRunning = true;
    try { await backgroundPass(gen); } finally {
      bgRunning = false;
      if (bgAgain) { bgAgain = false; background(lib.gen); }
    }
  }

  async function backgroundPass(gen) {
    const all = Object.keys(lib.index.scans), ids = all.filter((id) => !lib.index.scans[id].missing);
    for (const id of ids) {
      if (gen !== lib.gen) return;
      if (lib.runs.has(id)) continue;
      try {
        const listed = await lib.store.listRuns(id);
        lib.runs.set(id, listed.length ? await lib.store.getRun(id) : null);
      } catch (e) { lib.runErrors.set(id, e.message); }
      render();
    }
    let unmade = 0;
    for (const id of all) { // a missing scan shows the preview it had; only a present one gets a new one
      if (gen !== lib.gen) return;
      if (lib.thumbs.has(id)) continue;
      try {
        let blob = await readThumb(id);
        if (!blob && lib.index.scans[id].missing) continue;
        if (!blob) {
          let img = thumbQueue.get(id);
          if (!img) { const r = await App.openReader(await stackFor(id)); img = thumbImage(await r.read(r.count >> 1)); }
          blob = await pngOf(img);
          if (gen !== lib.gen) return;
          await lib.store.putFile(`thumbs/${id}.png`, blob);
          thumbQueue.delete(id);
        }
        lib.thumbs.set(id, URL.createObjectURL(blob));
        render();
      } catch (e) { unmade++; } // the card keeps its placeholder; opening the scan says what is wrong
    }
    if (unmade && gen === lib.gen) say(`${$('libStatus').textContent} ${unmade} preview${unmade > 1 ? 's' : ''} could not be made.`.trim(), true);
  }

  async function readThumb(id) {
    try {
      const f = await (await (await dirAt(`${V.LIBRARY_DIR}/thumbs`)).getFileHandle(`${id}.png`)).getFile();
      return f.size ? f : null;
    } catch (e) { return null; }
  }

  // ---------- the scan's record: star, tags (and, from the overview, notes and project) ----------
  function saveScanRecord(id, changes) {
    if (state.store === lib.store) { App.saveSample(changes, id); return; }
    lib.store.put('samples', CT.sampleRecord(id, lib.samples, changes)).catch((e) => say(`Not saved: ${e.message}`, true));
  }

  async function openScan(id) {
    const row = lib.entries.find((r) => r.id === id);
    try {
      const stack = { ...(await stackFor(id)), store: lib.store, title: row ? L.cardFacts(row).title : id };
      state.stacks = [stack];
      state.demoPhantoms = null;
      App.emit('samplesChanged');
      App.loadStack(stack);
    } catch (e) {
      say(`Could not open ${row ? L.cardFacts(row).title : id}: ${e.message}.`, true);
    }
  }

  window.VBLibraryView = { thumbImage, wrap, rescan, openLibraryDir, openScan, saveScanRecord };
  App.openLibrary = () => (supported ? pick() : undefined);
  App.openLibraryDir = openLibraryDir;
  App.rescanLibrary = rescan;

  // ---------- drawing ----------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const minutes = (s) => { const r = Math.round(s); return r >= 60 ? `${Math.floor(r / 60)} min ${r % 60} s` : `${r} s`; };

  function factsLine(f) {
    const parts = [f.date && f.date.slice(0, 16).replace('T', ' '), f.scanSeconds !== null && `${minutes(f.scanSeconds)} scan`,
      f.voxelUm !== null && `${f.voxelUm.toFixed(f.voxelUm < 10 ? 2 : 1)} µm`, f.kv !== null && `${f.kv} kV`].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'Scanner settings not recorded';
  }

  function resultLine(r, f) {
    if (f.missing) return `Missing: not found at the last Rescan (last seen ${String(r.entry.last_seen).slice(0, 10)})`;
    if (lib.runErrors.has(r.id)) return `Saved run unreadable: ${lib.runErrors.get(r.id)}`;
    if (!lib.runs.has(r.id)) return 'Checking for saved runs…';
    if (!f.analyzed) return 'Not analyzed';
    return f.porosity === null ? 'Analyzed; porosity not in the saved run' : `Porosity ${f.porosity.toFixed(2)} %`;
  }

  function tagEditor(r, f, box) {
    const input = el('input');
    input.type = 'text'; input.value = f.tags.join(', '); input.placeholder = 'tags, comma separated'; input.setAttribute('aria-label', `Tags of ${f.title}`);
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      if (keep) saveScanRecord(r.id, { tags: L.parseTags(input.value) });
      input.blur(); // render() leaves a focused field alone
      render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    box.replaceChildren(input);
    input.focus();
  }

  function card(r) {
    const f = L.cardFacts(r);
    const c = el('article', `libcard${f.missing ? ' missing' : ''}`);
    c.dataset.id = r.id;
    const thumb = el('button', 'link libthumb');
    thumb.type = 'button'; thumb.disabled = f.missing; thumb.setAttribute('aria-label', `Open ${f.title}`);
    if (lib.thumbs.has(r.id)) { const img = el('img'); img.src = lib.thumbs.get(r.id); img.alt = ''; thumb.append(img); } else thumb.append(el('span', 'muted', f.missing ? 'Missing' : 'No preview yet'));
    thumb.addEventListener('click', () => openScan(r.id));
    const head = el('div', 'libcardhead');
    const title = el('b', 'libtitle', f.title);
    title.title = r.entry.path + (r.entry.copies ? `\nAlso at: ${r.entry.copies.join(', ')}` : '');
    const star = el('button', 'link libstar', f.starred ? '★' : '☆');
    star.type = 'button'; star.setAttribute('aria-pressed', String(f.starred)); star.setAttribute('aria-label', f.starred ? `Unstar ${f.title}` : `Star ${f.title}`);
    star.addEventListener('click', () => saveScanRecord(r.id, { starred: !f.starred }));
    head.append(title, star);
    const tags = el('div', 'libtags');
    for (const t of f.tags) tags.append(el('span', 'libtag', t));
    const edit = el('button', 'link libtagedit', f.tags.length ? 'Edit tags' : '+ Tag');
    edit.type = 'button';
    edit.addEventListener('click', () => tagEditor(r, f, tags));
    tags.append(edit);
    const body = el('div', 'libcardbody');
    body.append(head, el('div', 'libfacts mono', factsLine(f)), el('div', `libresult${f.analyzed ? ' analyzed' : ''}`, resultLine(r, f)), tags);
    c.append(thumb, body);
    return c;
  }

  function filterButton(label, count, pressed, onClick) {
    const b = el('button', 'link libfilter');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(pressed));
    b.append(el('span', '', label), el('span', 'muted mono', String(count)));
    b.addEventListener('click', onClick);
    return b;
  }

  function renderSide(rows) {
    const filters = $('libFilters');
    filters.replaceChildren();
    for (const [key, label] of [['all', 'All scans'], ['starred', 'Starred'], ['analyzed', 'Analyzed'], ['unanalyzed', 'Not analyzed'], ['missing', 'Missing']]) {
      filters.append(filterButton(label, L.filterScans(rows, { filter: key }).length, view.filter === key, () => { view.filter = key; render(); }));
    }
    const listOf = (id, values, key) => {
      const box = $(id);
      box.replaceChildren();
      box.previousElementSibling.hidden = !values.size;
      for (const [v, n] of [...values].sort((a, b) => a[0].localeCompare(b[0]))) box.append(filterButton(v, n, view[key] === v, () => { view[key] = view[key] === v ? null : v; render(); }));
    };
    const count = (pick) => { const m = new Map(); for (const r of rows) for (const v of pick(r)) m.set(v, (m.get(v) || 0) + 1); return m; };
    listOf('libProjects', count((r) => (r.record && r.record.project ? [r.record.project] : [])), 'project');
    listOf('libTags', count((r) => L.cardFacts(r).tags), 'tag');
  }

  function render() {
    const open = Boolean(lib.dir && lib.index && !lib.refused);
    $('libRoot').textContent = lib.dir ? `Library: ${rootName()}` : supported ? 'No library open' : 'Library unavailable in this browser';
    $('libPick').hidden = !supported;
    $('libPick').textContent = lib.dir ? 'Choose another folder…' : 'Choose the library folder…';
    $('libPick').classList.toggle('primary', !lib.dir && !lib.saved);
    $('libReopen').hidden = !(supported && lib.saved && !lib.dir);
    if (lib.saved) $('libReopen').textContent = `Allow access to ${lib.saved.name}`;
    $('libRescan').hidden = !open;
    $('libRescan').disabled = lib.busy;
    $('libRescan').textContent = lib.busy ? 'Scanning…' : 'Rescan';
    $('libStudio').hidden = !state.folder;
    $('libStudio').textContent = 'Back to the open scan';
    $('libSide').hidden = !open;
    $('libIntro').hidden = open;
    notice(lib.refused || (supported ? '' : 'The library needs Chrome or Edge: it reads and writes a folder on your drive, which this browser does not allow. Open a folder… still opens one scan folder here, with a project file.'));

    const rows = open ? Object.entries(lib.index.scans).map(([id, entry]) => ({ id, entry, record: lib.samples.get(id) || null, run: lib.runs.get(id) || null })) : [];
    const key = (r) => (r.entry.info && r.entry.info.scannedAt) || r.entry.first_seen || '';
    rows.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0)); // newest first
    lib.entries = rows;
    const grid = $('libGrid');
    if (!open) { grid.replaceChildren(); $('libEmpty').hidden = true; return; }
    // An edit in progress (a tag field) is not redrawn away under the cursor.
    if (grid.contains(document.activeElement) && document.activeElement.matches('input')) return;
    renderSide(rows);
    const shown = L.filterScans(rows, view);
    grid.replaceChildren(...shown.map(card));
    $('libEmpty').hidden = Boolean(shown.length) || lib.busy;
    $('libEmpty').textContent = rows.length ? 'No scans match the search and filters.' : `No scans found under ${rootName()}. A scan is a folder holding a .VOX file, or a folder of TIFF slices.`;
  }

  function wire() {
    $('libPick').addEventListener('click', pick);
    $('libReopen').addEventListener('click', allowSaved);
    $('libRescan').addEventListener('click', rescan);
    $('libStudio').addEventListener('click', () => App.showPage('studio'));
    $('toLibrary').addEventListener('click', () => App.showPage('library'));
    $('libFolder').addEventListener('change', (e) => { state.demoPhantoms = null; App.openFiles(e.target.files); e.target.value = ''; });
    $('libSearch').addEventListener('input', (e) => { view.query = e.target.value; render(); });
    on('pageChanged', (page) => {
      if (page !== 'library') return;
      // A run saved in the studio since: read this scan's runs again.
      if (state.stack && state.stack.store && state.stack.store === lib.store && state.folder) { lib.runs.delete(state.folder); lib.runErrors.delete(state.folder); background(lib.gen); }
      render();
    });
    on('samplesChanged', () => { $('libFolderScans').hidden = !(state.stacks.length > 1 && !state.stacks[0].store); });
    App.showPage('library');
    render();
    if (supported) resume();
  }

  on('start', wire);
}(window.CTApp));
