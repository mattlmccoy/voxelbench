/* Step 1 > Holder: the review of automatic holder removal. The holder is found on every sample-mask build (ct_worker.js);
   this lists its pieces (kind, size, volume) with how they were found, gives a piece back to the part or takes it again
   (also by clicking it in the views with the review tool, ct_views.js), and Accept saves the reviewed holder with the
   sample (vb_holderreview.js holderRecord). The holder can also be a holder STL from the library's holders folder
   (vb_holderlib.js): choosing one saves { stl: { name, hash } } and drops the saved pieces, so the next build fits it. */
(function (App) {
  'use strict';
  const HR = window.VBHolderReview, HL = window.VBHolderLib;
  const { state, $, on, emit } = App;
  let names = null; // the library's holder STLs; null when the open scan is not from a library
  let busy = '', note = '';

  const libDir = () => (state.store && state.store.kind === 'library' && App.library && App.library.dir) || null;
  const saved = () => (state.folder ? App.sampleNow().holder || null : null);
  const chosen = () => { const s = saved(); return s && s.stl ? s.stl.name : ''; };
  const waiting = () => state.holderWait || Boolean(busy);
  // A failed mask build leaves the last holder on screen; it is not the build, so it cannot be reviewed.
  const blockOf = (h) => (state.holderError ? `The sample mask could not be built: ${state.holderError.message}` : HR.reviewBlock(h));
  // A mask build is running: a rebuild after a change, or the first build of a scan (no model yet).
  const building = () => state.holderWait || Boolean(state.folder && !state.model && !state.holderError);
  /** True while the scan open when it was called is still the open one: a read that finishes after another scan opened
      must not change the new scan's holder. */
  const sameScan = () => { const token = state.loadToken, folder = state.folder; return () => state.loadToken === token && state.folder === folder; };

  async function refreshNames() {
    const dir = libDir();
    try { names = dir ? await HL.listHolders(dir) : null; } catch (e) { names = []; note = `Could not list the library's holders: ${e.message}`; }
  }

  function renderSelect() {
    const sel = $('holderStl'), want = chosen();
    sel.textContent = '';
    const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; sel.append(o); };
    add('', 'Detect automatically');
    for (const n of names || []) add(n, `Holder STL: ${n}`);
    if (want && !(names || []).includes(want)) add(want, `Holder STL: ${want} (not in the library)`);
    sel.value = want;
    sel.disabled = !libDir() || !state.folder || waiting();
    $('holderAdd').disabled = !libDir() || Boolean(busy);
  }

  function renderTable(h) {
    const table = $('holderTable');
    table.textContent = '';
    $('holderWrap').hidden = !(h && h.pieces.length);
    if (!h || !h.pieces.length) return;
    const head = table.insertRow();
    for (const t of ['', 'Piece', 'Kind', 'Size', 'Volume']) { const th = document.createElement('th'); th.textContent = t; head.append(th); }
    const block = blockOf(h);
    for (const p of h.pieces) {
      const s = HR.pieceSummary(p, state.nativeVoxelMm), back = h.givenBack.includes(p.id), tr = table.insertRow();
      const b = document.createElement('button'); // first, so a narrow rail never scrolls it out of sight
      b.className = 'link';
      b.textContent = back ? 'Take' : 'Give back';
      b.title = back ? `Take ${p.id} as holder again` : `Give ${p.id} back to the part`;
      b.disabled = Boolean(block) || waiting();
      b.addEventListener('click', () => toggle(p.id));
      tr.insertCell().append(b);
      for (const v of [p.id, s.kind, s.extents ? `${s.size}, ${s.extents}` : s.size, s.volume]) tr.insertCell().textContent = v;
      tr.classList.toggle('givenback', back);
    }
  }

  function render() {
    const h = state.holder, reviewed = HR.isReviewed(h, saved()), run = building();
    const failed = Boolean(state.holderError || (h && h.failed));
    $('holderState').textContent = HR.holderTag({ h, reviewed, error: state.holderError, building: run });
    renderSelect();
    $('holderMethod').textContent = h && !failed && !run ? HR.holderMethod(h) : '';
    $('holderWarning').hidden = !(h && h.warning);
    $('holderWarning').textContent = (h && h.warning) || '';
    renderTable(h);
    const block = blockOf(h);
    $('holderAccept').disabled = Boolean(block) || reviewed || waiting();
    $('holderAccept').textContent = reviewed ? 'Accepted' : 'Accept';
    const where = libDir() ? '' : ' Holder STLs live in a library: open the scan from the library to choose one.';
    $('holderNote').textContent = busy || (state.holderWait ? 'Rebuilding the sample mask with this holder…' : note)
      || (h && (h.keep || state.holderError) ? block : h && h.pieces.length && !reviewed ? `Check the green pieces in the views. Give back any that are part, then Accept to save the review with the sample.${where}` : where.trim());
  }

  /** Saves the review with one piece given back or taken again; the worker rebuilds the mask (ct_app.js saveSample). */
  function toggle(id) {
    const h = state.holder, record = !waiting() && !blockOf(h) && HR.holderRecord(h, HR.toggleGiven((h && h.givenBack) || [], id));
    if (!record) { note = blockOf(h) || 'Wait for the sample mask to finish.'; render(); return; }
    note = '';
    App.saveSample({ holder: record });
    render();
  }

  /** Saves the build as it is; the worker keeps the mask (no new model), so the status is said here. */
  function accept() {
    const h = state.holder, record = !waiting() && !blockOf(h) && HR.holderRecord(h, (h && h.givenBack) || []);
    if (!record) return;
    note = '';
    App.saveSample({ holder: record });
    if (state.porePhase !== 'running') emit('statusText', `${HR.statusLine(h, true)} Saved with the sample.`);
    render();
  }

  /** "Detect automatically" ('') or a library holder: the saved pieces and toggles go (a new holder invalidates them).
      The record's own holder, added back to the library, is loaded without saving: its saved review then applies. */
  async function choose(name) {
    const same = name === chosen();
    if (same && (!name || (state.holderStl && state.holderStl.name === name))) return;
    note = '';
    if (!name) { state.holderStl = null; App.saveSample({ holder: null }); render(); return; }
    busy = `Reading holder STL ${name}…`; render();
    const still = sameScan();
    try {
      const loaded = await HL.readHolder(libDir(), name);
      if (!still()) return; // another scan opened during the read: its holder is not this choice
      if (!loaded) throw new Error('it is not in the library\'s holders folder');
      state.holderStl = loaded; // set before the request: it carries the triangles
      if (same) App.holderChanged();
      else App.saveSample({ holder: { stl: { name: loaded.name, hash: loaded.hash } } });
    } catch (e) {
      note = `Could not read holder STL ${name}: ${e.message}`;
    } finally { busy = ''; render(); }
  }

  async function addFile(file) {
    busy = `Adding ${file.name} to the library's holders…`; render();
    const still = sameScan();
    let name = null;
    try { name = await HL.addHolder(libDir(), file); await refreshNames(); } catch (e) { note = `Could not add ${file.name}: ${e.message}`; }
    busy = ''; render();
    if (name && still()) await choose(name); // added to the library either way; chosen only for the scan it was added on
  }

  /** On opening a scan: the library's holders, and the STL its record names, read before the first mask build. A file
      missing or changed is left to the worker, which falls back to detection and says so. */
  App.beforeFirstMask(async () => {
    note = '';
    const still = sameScan();
    await refreshNames();
    const s = saved(), dir = libDir();
    if (s && s.stl && dir) {
      try {
        const loaded = await HL.readHolder(dir, s.stl.name);
        if (still()) state.holderStl = loaded;
      } catch (e) { if (still()) note = `Could not read holder STL ${s.stl.name}: ${e.message}`; }
    }
    if (still()) render();
  });
  App.toggleHolderPiece = toggle;

  on('start', () => {
    $('holderStl').addEventListener('change', (e) => choose(e.target.value));
    $('holderAdd').addEventListener('click', () => $('holderFile').click());
    $('holderFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addFile(f); });
    $('holderAccept').addEventListener('click', accept);
  });
  // A model's holder arrives before holderWait clears (ct_app.js onWorker), so the render waits for that.
  on('holderModel', () => queueMicrotask(render));
  for (const e of ['loaded', 'changed', 'recordsChanged', 'samplesChanged']) on(e, render);
}(window.CTApp));
