/* The library's actions on several scans: tick cards (or pick a project in the side list), then Compare runs (their
   latest saved runs, metric by metric, with the scan-settings warning) or Batch (one scan at a time, its total size
   stated first). Import project… brings a project file into the library, matching its folders to the library's scans by
   folder name and asking when there is no match or more than one. Also the checklist's Review sheet step for a library
   scan: done when a sheet was saved beside the scan's runs. The logic is in vb_library.js; this file asks and draws. */
(function (App) {
  'use strict';
  const CT = window.CT, L = window.VBLibrary, LV = window.VBLibraryView, V = window.VBStore, VX = window.VBVox;
  const { state, $, on, emit } = App;
  const lib = () => App.library;
  const selected = new Set();
  let last = { open: false, rows: [], project: null };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const say = (text, bad = false) => { const e = $('libActStatus'); e.textContent = text; e.classList.toggle('bad', bad); };
  const titleOf = (id) => { const r = lib().entries.find((x) => x.id === id); return r ? L.cardFacts(r).title : id; };
  const pathOf = (id) => (lib().index.scans[id] || {}).path || id;
  const targets = () => L.actionTargets(last.rows, selected, last.project);
  const projectUnsaved = () => Boolean(state.store && state.store.kind === 'file' && (state.unsaved.size || state.projectDirty));

  // ---------- selection and the action bar ----------
  function renderBar() {
    const open = last.open && last.rows.length > 0;
    $('libActions').hidden = !open;
    $('libImport').hidden = !last.open;
    if (!open) return;
    const t = targets(), n = t.ids.length, busy = App.batch.running();
    $('libActTargets').textContent = t.from === 'selected' ? `${n} selected` : t.from === 'project' ? `Project ${last.project}: ${n} scan${n === 1 ? '' : 's'}` : 'Tick cards, or pick a project, to compare or batch them';
    $('libCompare').disabled = n < 2;
    $('libCompare').title = n < 2 ? 'Needs two or more scans with saved runs' : 'Their latest saved runs, metric by metric';
    $('libBatch').disabled = n < 1 || busy;
    $('libBatch').textContent = busy ? 'Batch running…' : 'Batch';
    $('libClearSel').hidden = !selected.size;
    $('libBatchCsv').hidden = !App.batch.rows() || busy;
  }

  function addPickers() {
    for (const card of $('libGrid').querySelectorAll('.libcard')) {
      const id = card.dataset.id;
      let box = card.querySelector('input.libpick');
      if (!box) {
        box = el('input', 'libpick');
        box.type = 'checkbox';
        box.setAttribute('aria-label', `Select ${titleOf(id)}`);
        box.addEventListener('change', () => { if (box.checked) selected.add(id); else selected.delete(id); card.classList.toggle('picked', box.checked); renderBar(); });
        card.querySelector('.libcardhead').prepend(box);
      }
      box.checked = selected.has(id);
      card.classList.toggle('picked', box.checked);
    }
  }

  // ---------- Compare runs ----------
  const fmt = (v) => (v === null ? 'n/a' : Number.isInteger(v) || Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));
  const when = (id) => { const e = lib().index.scans[id] || {}; return (e.info && e.info.scannedAt) || e.first_seen || ''; };

  let compareToken = 0;
  async function compare() {
    const mine = ++compareToken, ids = [...targets().ids].sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0)); // oldest scan first
    const table = $('libCompareTable');
    $('libCompareBox').hidden = false;
    $('libCompareWrap').hidden = true;
    table.replaceChildren();
    $('libCompareNote').textContent = `Reading the latest saved run of ${ids.length} scans…`;
    const runs = [], none = [], failed = [];
    for (const id of ids) {
      try {
        const run = await lib().store.getRun(id);
        if (run) runs.push({ id, run }); else none.push(id);
      } catch (e) { failed.push(`${titleOf(id)} (${e.message})`); }
      if (mine !== compareToken) return;
    }
    const left = [none.length && `No saved run: ${none.map(titleOf).join(', ')}.`, failed.length && `Could not read: ${failed.join('; ')}.`].filter(Boolean).join(' ');
    if (runs.length < 2) { $('libCompareNote').textContent = `Compare runs needs two scans with saved runs. ${left}`.trim(); return; }
    const [first, ...rest] = runs, two = runs.length === 2;
    const head = table.insertRow();
    for (const h of ['Metric', ...runs.map((r) => titleOf(r.id)), ...(two ? ['Change'] : [])]) head.append(el('th', '', h));
    const cols = rest.map((r) => CT.compareRuns(first.run, r.run));
    cols[0].forEach((row, k) => {
      const tr = table.insertRow();
      const cells = [row.label, fmt(row.before), ...cols.map((c) => fmt(c[k].after))];
      if (two) cells.push(row.change === null ? 'n/a' : `${row.change >= 0 ? '+' : ''}${fmt(row.change)}`);
      cells.forEach((c, i) => { const td = tr.insertCell(); td.textContent = c; if (!i) td.style.textAlign = 'left'; });
    });
    $('libCompareWrap').hidden = false;
    // Gray values move with tube voltage, current and scan time: say so when the runs were scanned differently. The
    // settings come from the run's own scanner record, else the scan's record in the index.
    const scanOf = (r) => r.run.scan || (lib().index.scans[r.id] || {}).info || null;
    const grid = (run) => (Number.isFinite(run.voxel_mm) ? `${(run.voxel_mm * 1000).toFixed(0)} µm${run.bin_factor > 1 ? `, ${run.bin_factor}× binned` : ''}` : 'voxel size not recorded');
    const each = runs.map((r) => `${titleOf(r.id)}: run of ${(r.run.created_at || 'date not recorded').slice(0, 10)}, ${grid(r.run)}; scanned at ${VX.settingsText(scanOf(r))}`).join('. ');
    const differ = rest.map((r) => [r, VX.settingsDiffer(scanOf(first), scanOf(r))]).filter(([, d]) => d.length);
    const warn = differ.length ? ` Scanned differently (${differ.map(([r, d]) => `${titleOf(first.id)} and ${titleOf(r.id)}: ${d.join('; ')}`).join('; ')}): gray values, thresholds and calibrated or relative densities are not on one scale, so compare those with care.` : '';
    $('libCompareNote').textContent = `Latest saved runs, oldest scan first${two ? '; Change is the second minus the first' : `; values are each scan's own, beside ${titleOf(first.id)}`}. ${each}. n/a: the run was saved before that measurement existed or without it.${warn}${left ? ` ${left}` : ''}`;
  }

  // ---------- Batch ----------
  async function batch() {
    const t = targets(), plan = L.batchBytes(t.ids, lib().index.scans);
    const skipped = plan.missing.length ? ` ${plan.missing.length} not found at the last Rescan ${plan.missing.length === 1 ? 'is' : 'are'} left out: ${plan.missing.map(titleOf).join(', ')}.` : '';
    if (!plan.ids.length) { say(`Nothing to batch.${skipped}`, true); return; }
    const question = `Batch reads ${plan.ids.length} scan${plan.ids.length === 1 ? '' : 's'}, ${L.bytesText(plan.bytes)} in all, one at a time: each scan replaces the one before, so two are never in memory together. Each is segmented; a scan with no saved run gets one, and saved runs are kept.${skipped} Start the batch?`;
    if (!window.confirm(question)) { say('Batch not started.'); return; }
    if (projectUnsaved() && !window.confirm('The project file has unsaved changes. Start the batch anyway? Save the project first to keep them.')) { say('Batch not started.'); return; }
    const store = lib().store, items = plan.ids.map((id) => ({ folder: id, title: titleOf(id), get: async () => ({ ...(await LV.stackFor(id)), store, title: titleOf(id) }) }));
    const tell = (text) => { say(`Batch: ${text}`); emit('statusText', `Batch: ${text}`); };
    renderBar();
    const rows = await App.batch.run(items, tell);
    if (!rows) { say('A batch is already running.', true); return; }
    if (store === lib().store) LV.forgetRuns(plan.ids);
    App.showPage('library');
    renderBar();
  }

  // ---------- Import project ----------
  function question(folder, options) {
    const row = el('label', 'libq');
    const sel = el('select');
    sel.dataset.folder = folder;
    for (const [value, text] of options) { const o = el('option', '', text); o.value = value; sel.append(o); }
    row.append(el('b', 'mono', folder), sel);
    return row;
  }

  /** Asks about the folders that did not match one scan. Resolves { mapping, keep } or null (canceled). */
  function ask(name, m) {
    const shared = L.sharedTargets(m.matched), sharedFolders = new Set(shared.flatMap(([, fs]) => fs));
    const sure = Object.entries(m.matched).filter(([f]) => !sharedFolders.has(f));
    const unsure = [...Object.keys(m.ambiguous), ...sharedFolders];
    if (!m.unmatched.length && !unsure.length) return Promise.resolve({ mapping: Object.fromEntries(sure), keep: [] });
    const dlg = $('libImportDialog'), box = $('libImportQuestions');
    $('libImportIntro').textContent = `${name}: ${sure.length ? `${sure.length} folder${sure.length === 1 ? '' : 's'} match one scan each (${sure.map(([f, id]) => `${f} → ${pathOf(id)}`).join('; ')}). ` : ''}Choose for the others; a skipped folder's records are not imported.`;
    box.replaceChildren();
    for (const f of unsure) {
      const ids = m.ambiguous[f] || [m.matched[f]];
      box.append(el('p', 'muted', m.ambiguous[f] ? `${f} matches ${ids.length} scans: which one is it?` : `${f} and another folder of the project both match ${pathOf(ids[0])}: keep one.`),
        question(f, [...ids.map((id) => [id, pathOf(id)]), ['', 'Skip']]));
    }
    for (const f of m.unmatched) {
      box.append(el('p', 'muted', `${f} matches no scan in this library.`), question(f, [['', 'Skip'], ['keep', 'Keep for later (saved to a file to import after a Rescan finds it)']]));
    }
    $('libImportError').hidden = true;
    return new Promise((resolve) => {
      const done = (value) => { $('libImportGo').onclick = null; dlg.onclose = null; if (dlg.open) dlg.close(); resolve(value); };
      $('libImportGo').onclick = () => {
        const mapping = Object.fromEntries(sure), keep = [];
        for (const sel of box.querySelectorAll('select')) {
          if (sel.value === 'keep') keep.push(sel.dataset.folder);
          else if (sel.value) mapping[sel.dataset.folder] = sel.value;
        }
        const clash = L.sharedTargets(mapping);
        if (clash.length) {
          $('libImportError').textContent = clash.map(([id, fs]) => `${fs.join(' and ')} would both go to ${pathOf(id)}; skip all but one`).join('. ') + '.';
          $('libImportError').hidden = false;
          return;
        }
        done({ mapping, keep });
      };
      dlg.onclose = () => done(null);
      dlg.showModal();
    });
  }

  async function importFile(file) {
    const store = lib().store;
    if (!store) return;
    let obj;
    try {
      try { obj = JSON.parse(await file.text()); } catch (e) { throw new Error('Not a VoxelBench project'); }
      V.checkProject(obj);
    } catch (e) { say(`${file.name} was not imported: ${e.message}.`, true); return; }
    const folders = L.projectFolders(obj);
    if (!folders.length) { say(`${file.name} holds no scan's records; nothing was imported.`, true); return; }
    const choice = await ask(file.name, L.matchImport(folders, lib().index.scans));
    if (!choice) { say(`Import of ${file.name} canceled; nothing was imported.`); return; }
    const skipped = folders.filter((f) => !Object.prototype.hasOwnProperty.call(choice.mapping, f) && !choice.keep.includes(f));
    const parts = [];
    try {
      if (Object.keys(choice.mapping).length) {
        const res = await store.importProject(L.remapProject(obj, choice.mapping));
        parts.push(`${res.added} record${res.added === 1 ? '' : 's'} added`, `${res.runsAdded.length} run${res.runsAdded.length === 1 ? '' : 's'} added to the scans' history`);
        if (res.runsAlready.length) parts.push(`${res.runsAlready.length} run${res.runsAlready.length === 1 ? ' was' : 's were'} already there`);
        if (res.keptRecords.length) parts.push(`${res.keptRecords.length} record${res.keptRecords.length === 1 ? '' : 's'} already in the library kept as they were (a sample's empty fields filled from the project)`);
        if (store === lib().store) LV.forgetRuns(Object.values(choice.mapping));
      }
    } catch (e) { say(`Import of ${file.name} stopped: ${e.message}. ${parts.length ? `Done before it stopped: ${parts.join('; ')}.` : 'Nothing was imported.'}`, true); return; }
    if (skipped.length) parts.push(`skipped: ${skipped.join(', ')}`);
    if (choice.keep.length) {
      const name = `${file.name.replace(/\.json$/i, '')}_not_imported.json`;
      try {
        const how = await V.saveBlob(state.downloads, name, new Blob([JSON.stringify(L.remapProject(obj, Object.fromEntries(choice.keep.map((f) => [f, f]))))], { type: 'application/json' }));
        parts.push(how === 'declined' ? `the file for ${choice.keep.join(', ')} was not saved (canceled)` : `kept for later in ${name}: ${choice.keep.join(', ')}`);
      } catch (e) { parts.push(`the file for ${choice.keep.join(', ')} was not saved: ${e.message}`); }
    }
    say(Object.keys(choice.mapping).length || choice.keep.length ? `Imported ${file.name}: ${parts.join('; ')}.` : `Nothing imported from ${file.name}: ${parts.join('; ')}.`);
  }

  // ---------- the checklist's Review sheet step, from the sheets saved beside the runs (Ruling 2) ----------
  async function sheetFromLibrary() {
    const store = state.store, folder = state.folder;
    if (!store || store.kind !== 'library' || !folder) return;
    try {
      const sheets = await store.listSheets(folder);
      if (sheets.length && state.store === store && state.folder === folder && !state.sheetSaved) { state.sheetSaved = true; emit('sheetSaved'); }
    } catch (e) {
      emit('statusText', `The saved review sheets could not be listed: ${e.message}`);
    }
  }

  function wire() {
    $('libCompare').addEventListener('click', compare);
    $('libBatch').addEventListener('click', batch);
    $('libBatchCsv').addEventListener('click', () => App.batch.download((t) => say(t)));
    $('libClearSel').addEventListener('click', () => { selected.clear(); addPickers(); renderBar(); });
    $('libCompareClose').addEventListener('click', () => { compareToken++; $('libCompareBox').hidden = true; });
    $('libImport').addEventListener('click', () => $('libImportFile').click());
    $('libImportFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
  }

  on('start', wire);
  on('libraryRendered', (r) => {
    if (!r.open) { selected.clear(); $('libCompareBox').hidden = true; }
    last = r;
    addPickers();
    renderBar();
  });
  on('batchChanged', renderBar);
  on('loaded', sheetFromLibrary);
}(window.CTApp));
