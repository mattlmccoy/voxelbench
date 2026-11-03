/* Shared state, loading, the worker, and the database. Drawing lives in ct_views.js, ct_model.js and ct_rail.js. */
window.CTApp = (function () {
  'use strict';
  const CT = window.CT, P = window.CTPores, R = window.CTRegions, V = window.VBStore, VB = window.VBVolume;
  const $ = (id) => document.getElementById(id);
  const READ_CONCURRENCY = 8;
  const WINDOW_SAMPLE_STEP = 8;
  const BIN = 2;

  // Everything the views can show, in plain words. The legend is built from this list.
  const LAYERS = [
    { id: 'pores', label: 'Pores, AR ≤ 2.5', color: '#ffb454', outline: '#ffffff', hint: 'Segmented pores with aspect ratio (AR) at or below the elongation cutoff.' },
    { id: 'cracks', label: 'Pores, AR > 2.5', color: '#ff5f56', outline: '#ff40ff', hint: 'Segmented pores with aspect ratio above the elongation cutoff.' },
    { id: 'clipped', label: 'Pores at FOV edge', color: '#b48cff', outline: '#c8aaff', hint: 'Pores truncated by the field-of-view (FOV) edge; volumes are lower bounds.' },
    { id: 'patches', label: 'Low-density regions', color: '#35d0c0', outline: '#000000', hint: 'Gray below 0.8 of matrix (air = 0) but above the pore threshold. Excluded from porosity.' },
    { id: 'zones', label: 'Gray-value zones', color: '#ff8ad8', hint: 'Step 3 zones. Pink: high-gray; blue: low-gray. Gray value reflects bulk attenuation, not composition.' },
    { id: 'crop', label: 'Crop', color: '#8b97a5', hint: 'Region excluded by the crop polygon, dimmed.' },
    { id: 'regions', label: 'Drawn regions', color: '#c9d64f', hint: 'Region polygons from steps 1 and 3.' },
    { id: 'notes', label: 'Annotations', color: '#f5f7fa', hint: 'Points, length measurements and outlines from the toolbar.' },
    { id: 'part', label: 'Sample surface', color: '#aab4bf', hint: '3D view: sample mask surface, translucent.', group: '3D' },
    { id: 'planes', label: 'Slice planes', color: '#6ec3ff', hint: '3D view: positions of the XY, XZ and YZ slices.', group: '3D' },
  ];
  const ZONE_COLOR = { 1: null, 2: [255, 138, 216], 3: [110, 140, 255] };

  const state = {
    stacks: [], loadToken: 0, loading: null, folder: null, slices: null, dims: null, voxelMm: null, binFactor: 1, nativeVoxelMm: null, files: null, native: null, circle: null, sampleMax: 0, autoWindow: null, rainbowAuto: null, view: 'gray', viewWindows: {},
    cursor: { x: 0, y: 0, z: 0 }, window: { low: 0, high: 3000 }, tool: 'navigate', type: 'pore', regionLabel: 'region_a',
    draft: null, annotations: new Map(), regions: new Map(), samples: new Map(), labels: new Map(), unsaved: new Map(), store: null, projectDirty: false, projectFile: null, dbState: 'connecting', deleting: null,
    settings: { ...P.DEFAULT_SETTINGS }, pores: null, runs: null, rejected: new Set(), rejectedVoxels: [], selected: null, porePhase: 'idle',
    bodyMm3: null, airGray: null, regionStats: new Map(), referenceId: '', referenceDensity: NaN,
    main: 'XY', fill: 0.5, minVoidMm: 0, patches: null, patchLabels: null, patchGrid: null, voidMeshes: null, zones: null, zoneLabels: {}, zoneThreshold: null, zoneBaseline: 'auto',
    show: Object.fromEntries(LAYERS.map((l) => [l.id, true])),
  };
  let worker = null;
  const listeners = {};
  const on = (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); };
  const emit = (name, ...args) => { for (const fn of listeners[name] || []) fn(...args); };
  const off = (name, fn) => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); };

  // ---------- records ----------
  // The store is the artifact database when the page runs on claude.ai, otherwise a project file (vb_store.js).
  function setDbState(next, detail) {
    state.dbState = next;
    state.dbDetail = detail || '';
    renderSaveState();
  }

  function renderSaveState() {
    const unsaved = state.unsaved.size ? ` · ${state.unsaved.size} NOT SAVED` : '';
    const counts = `${state.annotations.size} annotations, ${state.regions.size} regions`;
    const text = {
      connecting: 'Connecting to database',
      connected: `Shared database · ${counts}`,
      file: `${state.projectDirty ? 'Project file (unsaved changes)' : state.projectFile ? `Project file saved (${state.projectFile})` : 'No project file yet'} · ${counts}`,
      unavailable: `Not saving: ${state.dbDetail}`,
    }[state.dbState];
    $('saveState').textContent = text + unsaved;
    const good = (state.dbState === 'connected' || (state.dbState === 'file' && state.projectFile && !state.projectDirty)) && !state.unsaved.size;
    $('dbDot').className = `dot ${good ? 'live' : state.dbState === 'connecting' || state.dbState === 'file' ? 'warn' : 'err'}`;
    $('saveProject').hidden = !state.store;
    $('saveProject').textContent = state.store && state.store.kind === 'artifact' ? 'Export project' : 'Save project';
  }

  function watchRecords(store) {
    const watch = (name, into) => store.watch(name, (records) => {
      state[into] = records;
      for (const id of records.keys()) state.unsaved.delete(id);
      if (state.dbState === 'connecting') setDbState(store.kind === 'file' ? 'file' : 'connected');
      else renderSaveState();
      emit('recordsChanged');
    }, (e) => setDbState('unavailable', e.message));
    watch('annotations', 'annotations');
    watch('regions', 'regions');
    watch('samples', 'samples');
    watch('labels', 'labels');
  }

  async function connectStore() {
    const use = window.claude && window.claude.use ? (name) => window.claude.use(name) : null;
    const { store, downloads, note } = await V.connect(use);
    state.store = store;
    state.downloads = downloads;
    if (store.kind === 'file') setDbState('file');
    else setTimeout(() => { if (state.dbState === 'connecting') setDbState('unavailable', 'the database sent no records within 10 seconds.'); }, 10000);
    if (note) projectNote(`Not saving to the database: ${note}.`);
    watchRecords(store);
    emit('changed');
  }

  // Messages about project files go next to the project buttons, where they are always visible.
  const projectNote = (text) => { $('projectNote').textContent = text; $('projectNote').title = text; };

  const markDirty = () => { if (state.store && state.store.kind === 'file') { state.projectDirty = true; renderSaveState(); } };

  async function saveRecord(collection, record) {
    state.unsaved.set(record.id, { ...record, _collection: collection });
    emit('recordsChanged'); renderSaveState();
    if (!state.store) return;
    try {
      await state.store.put(collection, record);
      markDirty();
    } catch (e) {
      setDbState('unavailable', `the last save failed: ${e.message}`);
    }
  }

  /** Saves fields of the open sample's record, keeping its other fields, including an edit not yet stored. */
  function saveSample(changes) {
    const pending = state.unsaved.get(state.folder);
    saveRecord('samples', CT.sampleRecord(state.folder, state.samples, changes, pending && pending._collection === 'samples' ? pending : null));
  }

  async function removeRecord(collection, id) {
    state.deleting = null;
    const pending = state.unsaved.delete(id); // a save still in flight must be deleted too
    state.regionStats.delete(id);
    const stored = state[collection].has(id) || pending;
    emit('recordsChanged'); renderSaveState();
    if (!stored || !state.store) return;
    try {
      await state.store.remove(collection, id);
      markDirty();
    } catch (e) {
      setDbState('unavailable', `the last delete failed: ${e.message}`);
    }
  }

  // Project files (static build): everything for the open scans, saved and reopened by the user.
  async function saveProject() {
    const folders = state.stacks.map((s) => s.folder);
    const project = await state.store.exportProject(window.VB_VERSION, folders);
    const name = `${folders[0] || 'voxelbench'}_voxelbench.json`;
    const how = await V.saveBlob(state.downloads, name, new Blob([JSON.stringify(project)], { type: 'application/json' }));
    if (how === 'declined') { projectNote('Save canceled.'); return; }
    if (state.store.kind === 'file') { state.projectDirty = false; state.projectFile = name; renderSaveState(); }
    projectNote(how === 'link' ? `Your browser was asked to download ${name}. Keep it next to the scan.` : `Saved ${name}.`);
  }

  async function openProject(file) {
    try {
      let obj;
      try { obj = JSON.parse(await file.text()); } catch (e) { throw new Error('Not a VoxelBench project'); }
      // Only a project opened into an empty, saved page matches its file; anything merged into is unsaved.
      const clean = state.store.kind === 'file' && !state.projectDirty && state.store.isEmpty();
      const { added, renamedRuns } = await state.store.importProject(obj);
      if (clean) { state.projectFile = file.name; state.projectDirty = false; renderSaveState(); } else markDirty();
      projectNote(`Opened ${file.name}: ${added} records${renamedRuns.length ? `; runs kept under new names: ${renamedRuns.join(', ')}` : ''}${clean ? '' : '. Merged with the open records; save the project to keep them'}.`);
    } catch (e) {
      projectNote(`Could not open ${file.name}: ${e.message}`);
    }
  }

  // The project's region labels in their stored order; the defaults until the user changes them.
  const regionLabels = () => (state.labels.size ? [...state.labels.values()].sort((a, b) => a.order - b.order) : R.DEFAULT_LABELS);
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const ZONE_TITLES = { 1: 'Baseline', 2: 'High-gray', 3: 'Low-gray' };
  /** Color and display name of a zone value; drawn zones (4 and up) take their label's. */
  const zoneColor = (z) => (z < 4 ? ZONE_COLOR[z] : regionLabels()[z - 4] ? hexRgb(regionLabels()[z - 4].color) : null);
  const zoneTitle = (z) => ZONE_TITLES[z] || `Drawn: ${(regionLabels()[z - 4] || { label: '(deleted label)' }).label}`;

  /** One native XY slice (file index i) for the zoomed main view of a binned scan; only the latest is kept. */
  async function readNative(i) {
    if (state.native && state.native.index === i) return state.native;
    const t = CT.parseTiff(await state.files[i].arrayBuffer());
    state.native = { index: i, pixels: t.pixels, width: t.width, height: t.height };
    return state.native;
  }

  /** The density calibration from this scan's phantom regions (median gray) and air, when included; null without
      phantoms. The fit carries its points so they can be shown and saved with a run. */
  function calibration() {
    if (!state.folder) return null;
    const Cal = window.VBCalibration;
    const phantoms = regionsOf(state.folder).filter((r) => r.label === 'phantom' && r.phantom)
      .map((r) => ({ id: r.id, name: r.phantom.name, density_g_cm3: r.phantom.density_g_cm3, gray: statsOf(r).gray_p50, sd: statsOf(r).gray_sd, stats: statsOf(r) }));
    if (!phantoms.length) return null;
    const points = Cal.calibrationPoints(phantoms, { airGray: state.airGray, includeAir: CT.sampleInfo(state.folder, state.samples).calibration_air !== false });
    return { ...Cal.fitCalibration(points), points, phantoms };
  }

  const provenance = () => CT.provenanceLine({ voxelMm: state.voxelMm, binFactor: state.binFactor, calibration: calibration(), toolVersion: window.VB_VERSION });

  const unsavedOf = (collection) => [...state.unsaved.values()].filter((r) => r._collection === collection);
  // Records are kept on the grid they were drawn on and shown on the grid now loaded (CT.toGrid).
  const annotationsOf = (folder) => [...state.annotations.values(), ...unsavedOf('annotations')].filter((a) => a.sample.folder === folder).map((a) => CT.toGrid(a, state.binFactor));
  const regionsOf = (folder) => [...state.regions.values(), ...unsavedOf('regions')].filter((r) => r.sample.folder === folder).map((r) => CT.toGrid(r, state.binFactor));
  const cropsOf = (folder) => regionsOf(folder).filter((r) => r.label === 'crop');
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `a${Date.now()}${Math.floor(Math.random() * 1e9)}`);

  // ---------- loading ----------
  function showError(message) {
    $('loadError').hidden = !message;
    $('loadError').textContent = message || '';
  }

  function openFiles(files) {
    state.stacks = CT.groupStacks([...files]);
    showError(state.stacks.length ? '' : 'No TIFF (Tagged Image File Format) slices were found in that folder.');
    emit('samplesChanged');
    if (state.stacks.length === 1) loadStack(state.stacks[0]);
    else if (state.stacks.length) $('openerText').textContent = `Found ${state.stacks.length} scan folders. Choose one below.`;
  }

  async function loadStack(stack) {
    const token = ++state.loadToken;
    if (worker) { worker.terminate(); worker = null; }
    Object.assign(state, { slices: null, folder: null, draft: null, loading: stack.folder, pores: null, runs: null, rejected: new Set(), rejectedVoxels: [], selected: null, bodyMm3: null, airGray: null, porePhase: 'idle', regionStats: new Map(), patches: null, patchLabels: null, patchGrid: null, voidMeshes: null, zones: null, zoneLabels: {}, zoneThreshold: null });
    $('startup').hidden = false;
    showError('');
    emit('samplesChanged');
    const bar = $('progressBar');
    bar.hidden = false;
    const n = stack.files.length;
    const parse = async (i) => {
      try {
        return CT.parseTiff(await stack.files[i].arrayBuffer());
      } catch (e) {
        throw new Error(`${stack.files[i].name}: ${e.message}`);
      }
    };
    // The first slice sets the shape; the binning factor is chosen, and said, before the rest is read.
    let shape, f, slices, nativeMid = null;
    try {
      shape = await parse(0);
      f = VB.planBinning({ width: shape.width, height: shape.height, depth: n }, VB.budgetBytes(navigator.userAgent, location.search));
      const groups = Math.floor(n / f), mid = Math.floor(n / 2);
      const binning = f > 1 ? ` at ${f}× binning (${Math.round(1000 * shape.voxelMm * f)} µm voxels) to fit memory` : '';
      slices = new Array(groups);
      let next = 0, done = 0;
      const reader = async () => {
        while (next < groups && token === state.loadToken) {
          const k = next++;
          const group = [];
          for (let j = 0; j < f; j++) {
            const i = k * f + j, t = await parse(i);
            VB.checkSlice(shape, t, stack.files[i].name, stack.files[0].name);
            if (i === mid) nativeMid = t.pixels;
            group.push(t.pixels);
          }
          slices[k] = f === 1 ? group[0] : VB.binGroup(group, shape.width, shape.height, f);
          done += f;
          bar.firstElementChild.style.width = `${(100 * done) / n}%`;
          $('openerText').textContent = `Reading ${stack.folder}${binning}: slice ${done} of ${n}.`;
        }
      };
      await Promise.all(Array.from({ length: READ_CONCURRENCY }, reader));
    } catch (e) {
      if (token !== state.loadToken) return;
      state.loading = null;
      emit('samplesChanged');
      bar.hidden = true;
      showError(`Could not load ${stack.folder}. ${e.name === 'RangeError' ? 'The browser ran out of memory for this stack.' : e.message}`);
      return;
    }
    if (token !== state.loadToken) return;

    state.loading = null;
    state.folder = stack.folder;
    state.slices = slices;
    state.files = stack.files;
    state.binFactor = f;
    state.nativeVoxelMm = shape.voxelMm;
    state.native = null;
    state.dims = { nx: Math.floor(shape.width / f), ny: Math.floor(shape.height / f), nz: slices.length };
    state.voxelMm = shape.voxelMm * f;
    // The circle is fitted on a native slice, then scaled to the binned grid.
    const c = CT.fitCircle(nativeMid || slices[slices.length >> 1], nativeMid ? shape.width : state.dims.nx, nativeMid ? shape.height : state.dims.ny);
    state.circle = c && nativeMid ? { cx: c.cx / f, cy: c.cy / f, r: c.r / f } : c;
    state.cursor = { x: state.dims.nx >> 1, y: state.dims.ny >> 1, z: state.dims.nz >> 1 };
    const auto = CT.autoWindow(slices, state.dims, WINDOW_SAMPLE_STEP);
    state.autoWindow = { low: auto.low, high: auto.high };
    state.sampleMax = auto.max;
    const rainbow = window.CTDisplay.rainbowWindow(slices, state.dims, WINDOW_SAMPLE_STEP);
    state.rainbowAuto = { low: rainbow.low, high: rainbow.high };
    state.viewWindows = {};
    state.window = { ...state.autoWindow };
    bar.hidden = true;
    $('startup').hidden = true;
    emit('loaded');
    await restoreRun();
    startWorker();
  }

  // Bring back saved settings and rejections for this sample, so reopening a scan keeps the review.
  async function restoreRun() {
    if (!state.store) return;
    try {
      const saved = await state.store.getRun(state.folder);
      if (!saved) return;
      if (saved.settings) state.settings = { ...P.DEFAULT_SETTINGS, ...saved.settings };
      // Rejections are voxel positions on the grid the run was saved on; voxel-count settings stay as saved.
      const savedGrid = saved.bin_factor || 1;
      if (saved.rejected_voxels) state.rejectedVoxels = CT.toGrid({ voxels: saved.rejected_voxels, bin_factor: savedGrid }, state.binFactor).voxels;
      if (saved.zones && saved.zones.labels) state.zoneLabels = { ...saved.zones.labels };
      // Zone assignments belong to the baseline they were made with; version 10 runs used the end baseline.
      if (saved.zones) { state.zoneBaseline = saved.zones.method || 'ends'; $('zoneBaseline').value = state.zoneBaseline; }
      emit('poresChanged');
      if (savedGrid !== state.binFactor) { const text = `The saved run was made at ${CT.gridText(savedGrid)}; this scan is loaded at ${CT.gridText(state.binFactor)}. Regions and rejections were moved to this grid; settings in voxels (smoothing, closing, margin, neck) keep their saved values.`; emit('statusText', text); projectNote(text); }
    } catch (e) {
      setDbState('unavailable', `could not read the saved run: ${e.message}`);
    }
  }

  // ---------- worker ----------
  const cropOutlines = () => cropsOf(state.folder).map((c) => ({ plane: c.plane, points: c.points }));

  function startWorker() {
    try {
      worker = new Worker('ct_worker.js');
    } catch (e) {
      state.porePhase = 'error';
      emit('statusText', `The analysis worker failed to start: ${e.message}${location.protocol === 'file:' ? ' Pages opened from a file cannot start it; serve the folder over http (for example npx serve) or use the hosted page.' : ''}`);
      emit('poresChanged');
      return;
    }
    worker.onmessage = onWorker;
    worker.onerror = (e) => { state.porePhase = 'error'; emit('statusText', `The analysis worker failed: ${e.message}`); emit('poresChanged'); };
    emit('statusText', 'Binning 2 × 2 × 2 for the sample mask');
    setTimeout(() => {
      const b = P.binVolume(state.slices, state.dims, BIN, state.circle);
      state.binned = b.dims;
      worker.postMessage({ type: 'volume', gray: b.gray, outside: b.outside, dims: b.dims, full: state.dims, bin: BIN, voxelMm: state.voxelMm, circle: state.circle, settings: state.settings, crops: cropOutlines() }, [b.gray.buffer, b.outside.buffer]);
    }, 30);
  }

  function runDetect() {
    state.porePhase = 'running';
    state.detectStart = performance.now();
    Object.assign(state, { pores: null, runs: null, rejected: new Set(), selected: null, zones: null, patches: null, patchLabels: null, voidMeshes: null, regionStats: new Map() });
    emit('poresChanged');
    emit('voidMeshesChanged');
    worker.postMessage({ type: 'detect', settings: state.settings, crops: cropOutlines() });
  }

  function updateModel() {
    if (worker) worker.postMessage({ type: 'model', settings: state.settings, crops: cropOutlines() });
  }

  // Results describe the crop they ran with, so a new crop replaces them rather than leaving old voids over a new body.
  function cropChanged() {
    if (state.filler && state.filler.result) { state.filler = { busy: false, result: null, refused: 'The crop changed: run Find filler again.' }; emit('fillerChanged'); }
    if (state.cad && state.cad.result) { state.cad.result = null; state.cad.stale = 'The crop changed: press Align or Refine fit again.'; emit('cadChanged'); }
    updateModel();
    if (state.porePhase === 'running') state.rerunAfterDetect = true;
    else if (state.pores) runDetect();
  }

  function requestVoidMeshes() {
    if (worker && state.runs) worker.postMessage({ type: 'voidMeshes', rejected: [...state.rejected], minDiameterMm: state.minVoidMm });
  }

  function requestZones() {
    if (!worker || !state.patches) return;
    const regions = regionsOf(state.folder).filter((r) => r.label !== 'crop').map((r) => ({ label: r.label, plane: r.plane, slice_from: r.slice_from, slice_to: r.slice_to, points: r.points }));
    worker.postMessage({ type: 'zones', threshold: state.zoneThreshold, regions, labelIds: regionLabels().map((l) => l.id), baseline: state.zoneBaseline });
  }

  // Data for the review sheet; resolves when the worker answers. Thresholds are swept there without touching results.
  function requestSheet() {
    return new Promise((resolve) => {
      state.onSheet = resolve;
      worker.postMessage({ type: 'sheet', settings: state.settings, crops: cropOutlines(), rejected: [...state.rejected], zoneThreshold: state.zoneThreshold, zoneBaseline: state.zoneBaseline });
    });
  }

  function setMain(name) {
    state.main = name;
    for (const n of ['XY', 'XZ', 'YZ', '3D']) $(`pane${n}`).classList.toggle('main', n === name);
    emit('mainChanged');
  }

  async function sendSlices() {
    const n = state.dims.nz;
    let sent = 0, acked = 0;
    const WINDOW = 4;
    return new Promise((resolve) => {
      const pump = () => {
        while (sent < n && sent - acked < WINDOW) {
          const pixels = state.slices[sent].slice();
          worker.postMessage({ type: 'slice', z: sent, pixels }, [pixels.buffer]);
          sent++;
        }
      };
      state.onSliceDone = () => {
        acked++;
        emit('statusText', `Smoothing at ${CT.gridText(state.binFactor)}: slice ${acked} of ${n}`);
        if (acked === n) { worker.postMessage({ type: 'slicesDone' }); resolve(); } else pump();
      };
      pump();
    });
  }

  function onWorker({ data }) {
    if (data.type === 'status') emit('statusText', data.text);
    else if (data.type === 'model') {
      state.model = data;
      state.bodyMm3 = data.bodyMm3;
      state.airGray = data.airGray;
      state.regionStats = new Map();
      emit('modelChanged');
      if (state.porePhase !== 'running') emit('statusText', 'Ready. Press Segment pores.');
    } else if (data.type === 'modelDone') emit('changed');
    else if (data.type === 'needSlices') sendSlices();
    else if (data.type === 'sliceDone') state.onSliceDone();
    else if (data.type === 'pores') {
      state.pores = data.pores;
      state.connectivity = data.connectivity;
      state.poreRunSettings = data.settings;
      state.runs = data.runs;
      state.byId = new Map(data.pores.map((p) => [p.id, p]));
      state.rejected = P.rejectedAfterRerun(state.rejectedVoxels, data.runs, state.dims);
      state.rejectedVoxels = [...state.rejected].map((id) => P.firstVoxelOf(data.runs, state.dims, id));
      state.selected = null;
      state.regionStats = new Map();
      state.porePhase = 'done';
      state.detectSeconds = (performance.now() - state.detectStart) / 1000;
      emit('statusText', `Finished in ${state.detectSeconds.toFixed(0)} s`);
      emit('poresChanged');
    } else if (data.type === 'patches') {
      state.patches = data.patches;
      state.patchLabels = data.labels;
      state.patchGrid = { dims: data.dims, factor: data.factor };
      state.solidGray = data.solidGray;
      if (state.rerunAfterDetect) { state.rerunAfterDetect = false; runDetect(); return; }
      emit('poresChanged');
      requestVoidMeshes();
    } else if (data.type === 'voidMeshes') {
      state.voidMeshes = data;
      emit('voidMeshesChanged');
      emit('statusText', `Segmentation finished in ${state.detectSeconds.toFixed(0)} s; 3D surfaces built`);
    } else if (data.type === 'sheet') {
      if (state.onSheet) { state.onSheet(data); state.onSheet = null; }
    } else if (data.type === 'zones') {
      state.zones = data;
      if (!data.refused) state.zoneThreshold = data.threshold;
      emit('statusText', data.refused ? 'Zone segmentation failed' : 'Zones segmented');
      emit('poresChanged');
    } else if (data.type === 'filler') {
      if (state.filler && data.id === state.fillerSeq) { state.filler = { busy: false, result: data.refused ? null : data, refused: data.refused || null }; }
      emit('fillerChanged');
    } else if (data.type === 'cad') {
      const cad = state.cad;
      if (cad && data.id === state.cadSeq) {
        cad.busy = false;
        const fits = data.deviations && data.deviations.length === cad.measure.points.length / 3;
        cad.result = data.refused || !fits ? null : data;
        cad.refused = data.refused || (fits ? null : 'The CAD points changed during the run: press Align again.');
        cad.stale = null;
      }
      emit('cadChanged');
    } else if (data.type === 'error') {
      if (state.cad && state.cad.busy) { state.cad.busy = false; state.cad.refused = data.message; emit('cadChanged'); }
      state.porePhase = 'error';
      emit('statusText', data.message);
      emit('poresChanged');
    }
  }

  function toggleReject(id) {
    if (state.rejected.has(id)) {
      state.rejected.delete(id);
    } else {
      state.rejected.add(id);
    }
    state.rejectedVoxels = [...state.rejected].map((r) => P.firstVoxelOf(state.runs, state.dims, r));
    state.regionStats = new Map();
    emit('poresChanged');
    requestVoidMeshes();
  }

  const poreLookup = () => (state.runs ? { idAt: (x, y, z) => P.poreIdAt(state.runs, state.dims, x, y, z), list: state.pores, rejected: state.rejected } : undefined);

  function statsOf(region) {
    let s = state.regionStats.get(region.id);
    if (!s) {
      s = R.regionStats({ slices: state.slices, dims: state.dims, region, voxelMm: state.voxelMm, pores: poreLookup(), circle: state.circle });
      state.regionStats.set(region.id, s);
    }
    return s;
  }

  function start() {
    $('folder').addEventListener('change', (e) => openFiles(e.target.files));
    $('saveProject').addEventListener('click', saveProject);
    $('trySynthetic').addEventListener('click', () => openFiles(window.VBSynthetic.makeScan({}).files));
    $('trySyntheticPhantoms').addEventListener('click', () => openFiles(window.VBSynthetic.makeScan({ phantoms: true }).files));
    $('trySyntheticFiller').addEventListener('click', () => openFiles(window.VBSynthetic.makeScan({ filler: true }).files));
    $('trySyntheticCad').addEventListener('click', () => {
      state.cadDemo = { name: 'synthetic_part.stl', buffer: window.VBSynthetic.partStl() };
      openFiles(window.VBSynthetic.makePart({ scale: 0.97, bendMm: 0.12 }).files);
    });
    $('projectFile').addEventListener('change', (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; });
    connectStore();
    renderSaveState();
    emit('start');
  }

  /** Runs the CAD comparison in the worker: pre-alignment when pose is null, otherwise ICP from pose. */
  function requestCad(pose) {
    const cad = state.cad;
    if (!worker || !cad || !cad.measure || cad.busy) return;
    cad.busy = true; cad.refused = null; state.cadSeq = (state.cadSeq || 0) + 1;
    worker.postMessage({ type: 'cad', id: state.cadSeq, settings: state.settings, crops: cropOutlines(), points: cad.measure.points, normals: cad.measure.normals, edge: cad.measure.edge, weight: cad.measure.weight, pose,
      options: { scale: cad.scale, toleranceMm: cad.toleranceMm, rangeMm: cad.rangeMm } });
    emit('cadChanged');
  }

  /** Runs the filler analysis in the worker on the smoothed slices pore segmentation left there. */
  function requestFiller({ k, minVoxels, threshold }) {
    if (!worker || (state.filler && state.filler.busy)) return;
    state.fillerSeq = (state.fillerSeq || 0) + 1;
    state.filler = { busy: true, result: null, refused: null };
    worker.postMessage({ type: 'filler', id: state.fillerSeq, settings: state.settings, crops: cropOutlines(), k, minVoxels, threshold });
    emit('fillerChanged');
  }

  return { requestFiller, requestCad, saveSample, state, on, off, emit, start, $, BIN, LAYERS, ZONE_COLOR, saveRecord, removeRecord, annotationsOf, regionsOf, cropsOf, newId, loadStack, runDetect, updateModel, cropChanged, requestVoidMeshes, requestSheet, requestZones, setMain, toggleReject, statsOf, renderSaveState, markDirty, regionLabels, zoneColor, zoneTitle, readNative, provenance, calibration };
}());
