/* Step 1 > Holder: the review of automatic holder removal. The holder is found on every sample-mask build (ct_worker.js);
   this lists its pieces (kind, size, volume) with how they were found, gives a piece back to the part or takes it again
   (also by clicking it in the views with the review tool, ct_views.js), and Accept saves the reviewed holder with the
   sample (vb_holderreview.js holderRecord). The holder can also be one or more holder STLs from the library's holders
   folder (vb_holderlib.js), one per printed part: ticking or unticking one saves { stls: [{ name, hash }, ...] } in
   choice order and drops the saved pieces, so the next build fits each of them. */
(function (App) {
  'use strict';
  const HR = window.VBHolderReview, HL = window.VBHolderLib, HW = window.VBHolderWire;
  const { state, $, on, emit } = App;
  let names = null; // the library's holder STLs; null when the open scan is not from a library
  let busy = '', note = '';

  const libDir = () => (state.store && state.store.kind === 'library' && App.library && App.library.dir) || null;
  const saved = () => (state.folder ? App.sampleNow().holder || null : null);
  const chosen = () => HW.savedStls(saved()).map((s) => s.name);
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

  /** One ticked row per library holder STL, plus any the record chose that the library no longer has. */
  function renderChoice() {
    const box = $('holderStls'), want = chosen(), have = names || [], off = !libDir() || !state.folder || waiting();
    box.textContent = '';
    for (const n of [...have, ...want.filter((w) => !have.includes(w))]) {
      const row = document.createElement('label'), tick = document.createElement('input'), text = document.createElement('span');
      row.className = 'pickrow';
      tick.type = 'checkbox';
      tick.checked = want.includes(n);
      tick.disabled = off;
      tick.addEventListener('change', () => pick(n, tick.checked));
      text.textContent = `Holder STL: ${n}${have.includes(n) ? '' : ' (not in the library)'}`;
      row.append(tick, text);
      box.append(row);
    }
    if (!box.childElementCount && libDir()) box.textContent = 'No holder STLs in the library yet.';
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
    renderChoice();
    $('holderMethod').textContent = h && !failed && !run ? HR.methodLines(h).join('\n') : ''; // one line per holder STL
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

  /** Ticks (on) or unticks a library holder STL. A new choice drops the saved pieces and toggles (each STL is fitted
      again); none ticked is detection. The record's own STL, added back to the library, is loaded without saving: its
      saved review then applies. */
  async function pick(name, on) {
    const want = chosen();
    note = '';
    if (!on) { state.holderStls = state.holderStls.filter((s) => s.name !== name); saveChoice(want.filter((n) => n !== name)); render(); return; }
    if (want.includes(name) && state.holderStls.some((s) => s.name === name)) return;
    busy = `Reading holder STL ${name}…`; render();
    const still = sameScan();
    try {
      const loaded = await HL.readHolder(libDir(), name);
      if (!still()) return; // another scan opened during the read: its holder is not this choice
      if (!loaded) throw new Error('it is not in the library\'s holders folder');
      state.holderStls = [...state.holderStls.filter((s) => s.name !== name), loaded]; // set before the request: it carries the triangles
      if (want.includes(name)) App.holderChanged();
      else saveChoice([...want, name]);
    } catch (e) {
      note = `Could not read holder STL ${name}: ${e.message}`;
    } finally { busy = ''; render(); }
  }

  /** Saves the chosen STLs by name, in order, with the hash of the file loaded (or the saved one while it is not). */
  function saveChoice(list) {
    const hashOf = (n) => (state.holderStls.find((s) => s.name === n) || HW.savedStls(saved()).find((s) => s.name === n)).hash;
    const stls = list.map((n) => ({ name: n, hash: hashOf(n) }));
    App.saveSample({ holder: stls.length ? { stls } : null });
  }

  async function addFile(file) {
    busy = `Adding ${file.name} to the library's holders…`; render();
    const still = sameScan();
    let name = null;
    try { name = await HL.addHolder(libDir(), file); await refreshNames(); } catch (e) { note = `Could not add ${file.name}: ${e.message}`; }
    busy = ''; render();
    if (name && still()) await pick(name, true); // added to the library either way; ticked only for the scan it was added on
  }

  /** On opening a scan: the library's holders, and the STLs its record names, read before the first mask build. A file
      missing or changed is left to the worker, which falls back to detection and says so. */
  App.beforeFirstMask(async () => {
    note = '';
    const still = sameScan();
    await refreshNames();
    const dir = libDir(), got = [];
    for (const s of dir ? HW.savedStls(saved()) : []) {
      try {
        const loaded = await HL.readHolder(dir, s.name);
        if (loaded) got.push(loaded);
      } catch (e) { if (still()) note = `Could not read holder STL ${s.name}: ${e.message}`; }
    }
    if (!still()) return;
    state.holderStls = got;
    render();
  });
  App.toggleHolderPiece = toggle;

  on('start', () => {
    $('holderAdd').addEventListener('click', () => $('holderFile').click());
    $('holderFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addFile(f); });
    $('holderAccept').addEventListener('click', accept);
  });
  // A model's holder arrives before holderWait clears (ct_app.js onWorker), so the render waits for that.
  on('holderModel', () => queueMicrotask(render));
  for (const e of ['loaded', 'changed', 'recordsChanged', 'samplesChanged']) on(e, render);
}(window.CTApp));
