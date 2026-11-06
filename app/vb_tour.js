/* Guided tour: walks a new user through the eight steps on the generated test scans. Each stop points at the part of
   the page it describes; its buttons run the step for the user (load a scan, draw an outline, press the button) so the
   real results appear, and a live line reads them back next to the known answers of the generated scan.
   Start it from the top bar, the library page, or with ?tour in the address. */
(function (App) {
  'use strict';
  const { state, $, emit } = App;
  const P = window.CTPores, Cal = window.VBCalibration;
  const POLL_MS = 150, LOAD_TIMEOUT_MS = 120000, RUN_TIMEOUT_MS = 600000;
  const FOLDER = { dense: 'synthetic_dense_band', phantoms: 'synthetic_phantoms', filler: 'synthetic_filler', cad: 'synthetic_part' };
  const truth = {};
  let at = -1, timer = null, busy = false, error = '', ui = null;

  const fmt = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));
  const on = (kind) => state.folder === FOLDER[kind] && Boolean(state.model);
  const until = (pred, ms, what) => new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      let v;
      try { v = pred(); } catch (e) { reject(e); return; }
      if (v) resolve(v);
      else if (performance.now() - t0 > ms) reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s.`));
      else setTimeout(tick, POLL_MS);
    };
    tick();
  });

  // ---------- what the stops do ----------
  async function load(kind) {
    if (on(kind)) return;
    truth[kind] = App.openDemo(kind);
    await until(() => on(kind), LOAD_TIMEOUT_MS, 'Loading the scan');
  }

  async function pores() {
    if (state.porePhase === 'done' && state.pores) return;
    if (state.porePhase !== 'running') App.runDetect();
    await until(() => {
      if (state.porePhase === 'error') throw new Error('Pore segmentation failed; see step 2.');
      return state.porePhase === 'done' && state.pores;
    }, RUN_TIMEOUT_MS, 'Pore segmentation');
  }

  // An outline as the user would drag it: the draft shows on the main view and the rail offers Save.
  function draft(plane, points, { sliceFrom, sliceTo } = {}) {
    App.setMain(plane);
    const slice = plane === 'XY' ? state.cursor.z : plane === 'XZ' ? state.cursor.y : state.cursor.x;
    state.draft = { plane, slice, kind: 'region', points, complete: true, closed: true, drawing: false, sliceFrom, sliceTo };
    emit('draftChanged');
    emit('redraw');
  }

  const disk = (cx, cy, r) => Array.from({ length: 24 }, (_, k) => ({ col: cx + r * Math.cos((k * Math.PI) / 12), row: cy + r * Math.sin((k * Math.PI) / 12) }));
  const regions = (label) => (state.folder ? App.regionsOf(state.folder).filter((r) => r.label === label) : []);
  const hasPhantom = (name) => regions('phantom').some((r) => r.phantom && r.phantom.name === name);

  function rod(name) {
    const size = state.dims.nx, c = (size - 1) / 2, angle = name === 'Rod A' ? Math.PI / 4 : (5 * Math.PI) / 4;
    return { cx: c + 0.39 * size * Math.cos(angle), cy: c + 0.39 * size * Math.sin(angle), r: 0.06 * size * 0.65 };
  }

  function outlineRod(name, density) {
    $('phantomName').value = name;
    $('phantomDensity').value = String(density);
    $('drawPhantom').click();
    const r = rod(name), n = state.dims.nz;
    draft('XY', disk(r.cx, r.cy, r.r), { sliceFrom: Math.round(0.125 * n), sliceTo: Math.round(0.875 * n) - 1 });
  }

  const zonesDone = () => state.zones && !state.zones.refused && state.zones.stats;
  const cadDone = () => state.cad && state.cad.result && !state.cad.busy;
  const fillerDone = () => state.filler && state.filler.result && !state.filler.busy;
  const wallDone = () => state.wall && state.wall.result && !state.wall.busy;

  // ---------- live read-outs ----------
  function poreLine() {
    if (!state.pores) return '';
    const s = P.summarize(state.pores, state.bodyMm3, state.rejected);
    const t = truth.dense;
    const c = state.connectivity && state.connectivity.summary;
    return `Found ${state.pores.length} pores, porosity ${fmt(s.all_void_percent_of_body)} % of the sample mask${t ? ` (generated: ${t.pore_count} pores, ${fmt(t.porosity_percent)} %)` : ''}.${c ? ` Open ${fmt(c.open_percent)} %, closed ${fmt(c.closed_percent)} %.` : ''}`;
  }

  function zoneLine() {
    const z = state.zones;
    if (!z) return '';
    if (z.refused) return z.refused;
    const high = z.stats.find((s) => s.zone === 2), base = z.stats.find((s) => s.zone === 1);
    const t = truth.dense && truth.dense.dense_band;
    return `Baseline: ${z.method === 'ends' ? 'pore-free ends' : 'whole part'}. High-gray zone ${fmt(high && high.volume_mm3, 0)} mm³, matrix gray ${fmt(high && high.solid_gray_mean, 0)} against ${fmt(base && base.solid_gray_mean, 0)} at the baseline${t ? ` (generated: ${t.gray} against 2000, slices ${t.z_from} to ${t.z_to})` : ''}. Threshold ${fmt(100 * z.threshold, 1)} % gray offset.`;
  }

  function calLine() {
    const fit = App.calibration();
    if (!fit) return '';
    if (!fit.ok) return fit.reason;
    const m = Cal.applyCalibration(fit, 2000), t = truth.phantoms;
    return `Fit from ${fit.n} points${fit.r2 === null ? '' : `, R² ${fmt(fit.r2, 4)}`}. The matrix gray (2000) reads ${fmt(m && m.value, 3)} g/cm³${t ? ` (generated: ${fmt(t.matrix_density, 3)} g/cm³)` : ''}.`;
  }

  function cadLine() {
    if (!cadDone()) return state.cad && state.cad.busy ? 'Aligning…' : '';
    const r = state.cad.result, s = r.transform.s, st = r.stats;
    return `Scale ${fmt(s, 4)}, shrinkage ${fmt((1 - s) * 100)} % (generated: 3.00 %). Median deviation ${fmt(st.p50, 3)} mm, 5th to 95th percentile ${fmt(st.p05, 3)} to ${fmt(st.p95, 3)} mm, ${fmt(st.within_percent, 1)} % within ±${state.cad.toleranceMm} mm. Click the model in the 3D view to read one point.`;
  }

  function fillerLine() {
    if (!fillerDone()) return state.filler && state.filler.busy ? 'Labeling the bright phase…' : state.porePhase === 'running' ? 'Segmenting pores first…' : '';
    const s = state.filler.result.summary, t = truth.filler && truth.filler.filler;
    const o = s.orientation;
    return `${s.count} particles, ${fmt(s.volume_percent)} % of the sample mask${t ? ` (generated: ${t.spheres} spheres and ${t.fibers} fibers, ${fmt(t.volume_percent)} %)` : ''}.${o && o.count ? ` ${o.count} fibers resolved${o.eigenvalues ? `, largest orientation eigenvalue ${fmt(o.eigenvalues[0])} (1 = all aligned)` : ''}.` : ''}`;
  }

  function wallLine() {
    if (!wallDone()) return state.wall && state.wall.busy ? 'Measuring walls…' : '';
    const st = state.wall.result.stats;
    return `Thinnest ${fmt(st.min_mm)} mm, median ${fmt(st.p50_mm)} mm, thickest ${fmt(st.max_mm)} mm (generated: legs 30 and 40 voxels thick and 40 voxels deep, 1.16 and 1.55 mm after 3 % shrinkage). Click a row of the thinnest places to go to it.`;
  }

  // ---------- the stops ----------
  const STOPS = [
    { title: 'VoxelBench guided tour',
      body: ['This tour runs the eight steps on generated test scans with known answers: crop, pores, zones, export, density calibration, CAD comparison, filler and walls.',
        'Each stop points at the controls it describes. Press the button in this card to have the tour do the step, or do it yourself and press Next. Scans are generated in this browser; nothing is uploaded.',
        'Esc closes the tour; the arrow keys move between stops.'] },
    { title: 'Open a scan', target: () => (state.folder && state.page === 'studio' ? $('crumb') : $('libDemos')),
      body: ['A real scan is a folder of 16-bit TIFF slices (Open scan folder). The tour uses the generated dense-band scan: a 16 mm cylinder at 0.1 mm voxels with 40 spherical pores and a band over the middle 30 % of its length that reads 10 % denser.'],
      actions: [{ label: 'Load the dense-band scan', run: () => load('dense'), done: () => on('dense') }],
      result: () => (on('dense') ? `Loaded ${state.dims.nx} × ${state.dims.ny} × ${state.dims.nz} voxels at ${fmt(state.voxelMm * 1000, 0)} µm.` : '') },
    { title: 'Views', target: () => $('center'),
      body: ['The large view is the main slice (XY at first); XZ, YZ and the 3D model sit below. Click a small view to make it the main one. The slider beside each view moves through the slices; the mouse wheel zooms and dragging pans.',
        'The readout at the bottom gives the voxel position and gray value under the cursor. The Layers list on the right turns each overlay on and off.'],
      actions: [
        { label: 'Make XZ the main view', run: () => App.setMain('XZ') },
        { label: 'Switch to the rainbow color map', run: () => $('viewRainbow').click() },
        { label: 'Back to XY in grayscale', run: () => { $('viewGray').click(); App.setMain('XY'); } }],
      result: () => (state.view === 'rainbow' ? 'Rainbow (turbo) map, smoothed for display only: the denser band across the middle of the length reads warmer than the ends.' : ''),
      needs: 'dense' },
    { title: 'Step 1 · Crop', target: () => $('step1'), open: 'step1', needs: 'dense',
      body: ['Crop removes voxels that are not sample, such as a holder or packaging. The outline is extruded through the full depth of the view it is drawn on, so a holder below the part is cropped on XZ or YZ.',
        'This scan has no holder; to show the tool, the tour crops the first 1 mm of its length (slices 0 to 9) on XZ.'],
      actions: [
        { label: 'Draw the crop outline', run: () => { $('drawCrop').click(); const { nx, nz } = state.dims; draft('XZ', [{ col: 0, row: 10 }, { col: nx - 1, row: 10 }, { col: nx - 1, row: nz - 1 }, { col: 0, row: nz - 1 }]); },
          done: () => regions('crop').length > 0 || Boolean(state.draft && state.regionLabel === 'crop') },
        { label: 'Save the crop', run: () => { $('saveDraft').click(); App.setMain('XY'); }, done: () => regions('crop').length > 0 }],
      result: () => (regions('crop').length ? `${regions('crop').length} crop outline saved; the dimmed area is excluded.` : state.draft ? 'The outline is on the XZ view. Save it in the panel at the top of the rail.' : '') },
    { title: 'Step 2 · Pore segmentation', target: () => $('step2'), open: 'step2', needs: 'dense',
      body: ['Segment pores builds the sample mask, finds gray below the pore threshold inside it, and labels each pore in 3D. Each pore gets its volume, equivalent spherical diameter, aspect ratio, and whether outside air reaches it (open) or not (closed).',
        'Gray below 0.8 of the matrix but above the pore threshold is reported apart as low-density regions, not porosity.'],
      actions: [{ label: 'Segment pores', run: async () => { await pores(); App.setMain('3D'); }, done: () => state.porePhase === 'done' && Boolean(state.pores) }],
      result: () => (state.porePhase === 'running' ? 'Segmenting pores…' : poreLine()) },
    { title: 'Pore list and review', target: () => $('step2'), open: 'step2', needs: 'dense',
      body: ['Pore and low-density region list: click a row to center the views on that pore. Reject pores by click removes false detections (a reconstruction ring, a holder edge); rejected pores leave the totals and stay listed, struck through.',
        'Segmentation parameters holds the thresholds and smoothing. Settings can be saved as named presets and reused on other scans.'],
      actions: [
        { label: 'Open the pore list', run: () => { const d = $('step2').querySelector('details.sub'); d.open = true; d.scrollIntoView({ block: 'nearest' }); }, done: () => $('step2').querySelector('details.sub').open },
        { label: 'Go to the largest pore', run: () => { App.setMain('XY'); const row = $('poreTable').querySelector('tr.pick'); if (!row) throw new Error('Segment pores first (previous stop).'); row.click(); } }],
      result: () => { const p = state.selected && state.byId && state.byId.get(state.selected); return p ? `Pore ${p.id}: ESD ${fmt(p.diameter_mm, 3)} mm, ${fmt(p.volume_mm3, 4)} mm³, aspect ratio ${fmt(p.elongation, 1)}, ${p.open ? 'open' : p.open === false ? 'closed' : 'open/closed unknown'}. The views are centered on it.` : ''; } },
    { title: 'Step 3 · Gray-value zones', target: () => $('step3'), open: 'step3', needs: 'dense',
      body: ['Zones compare the local matrix gray with a baseline at equal depth below the surface: the pore-free ends of the long axis, else the whole part. Cells above the threshold form the high-gray zone (pink); cells 8 % below form the low-gray zone (blue).',
        'Gray reflects bulk attenuation, not composition. In this scan the dense band should come back as the high-gray zone. Draw region adds your own labeled outlines on top.'],
      actions: [{ label: 'Segment zones', run: async () => { await pores(); $('draftZones').click(); await until(() => state.zones, RUN_TIMEOUT_MS, 'Zone segmentation'); App.setMain('XZ'); }, done: () => Boolean(zonesDone()) }],
      result: zoneLine },
    { title: 'Step 4 · Annotations and export', target: () => $('step4'), open: 'step4', needs: 'dense',
      body: ['Save run keeps the segmentation, rejections and zones with the sample. The tables export as CSV; the review sheet is a three-page PDF with sections, the pore size distribution, threshold sensitivity and methods.',
        'Point, Measure and Outline in the toolbar add annotations; a Measure line with a nominal and tolerance is checked as a dimension. Bookmarks keep a view, and Compare with puts two scans\' saved runs side by side.'],
      actions: [
        { label: 'Save run', run: () => $('savePoreRun').click() },
        { label: 'Make the review sheet (PDF)', run: () => App.exportSheet() }],
      result: () => $('exportStatus').textContent },
    { title: 'Step 5 · Density calibration', target: () => $('step5'), open: 'step5',
      body: ['Phantoms of known density scanned next to the sample turn gray into equivalent density. Enter each phantom\'s name and measured density, outline it where it is solid, and set its slice range; air can be added as a third point.',
        'This scan has two rods, 0.50 and 1.40 g/cm³. The result is the equivalent density of the phantom material, without beam-hardening correction.'],
      actions: [
        { label: 'Load the phantom scan', run: () => load('phantoms'), done: () => on('phantoms') },
        { label: 'Outline rod A (0.50 g/cm³)', run: () => outlineRod('Rod A', 0.5), done: () => hasPhantom('Rod A') || Boolean(state.draft && state.regionLabel === 'phantom' && state.phantomDraft && state.phantomDraft.name === 'Rod A') },
        { label: 'Save rod A', run: () => { $('saveDraft').click(); }, done: () => hasPhantom('Rod A') },
        { label: 'Outline rod B (1.40 g/cm³)', run: () => outlineRod('Rod B', 1.4), done: () => hasPhantom('Rod B') || Boolean(state.draft && state.regionLabel === 'phantom' && state.phantomDraft && state.phantomDraft.name === 'Rod B') },
        { label: 'Save rod B', run: () => { $('saveDraft').click(); }, done: () => hasPhantom('Rod B') }],
      result: () => (on('phantoms') ? calLine() : '') },
    { title: 'Step 6 · Compare to CAD', target: () => $('step6'), open: 'step6',
      body: ['Open the part\'s nominal STL. Align fits it to the scanned surface (rigid, optionally with one uniform scale reported as shrinkage), then measures the signed distance from each nominal point, along its normal, to the scanned surface: red where material is extra, blue where it is missing.',
        'The generated L-shaped part is shrunk 3 % and its upright is bent 0.12 mm at the top. The STL opens with the scan.'],
      actions: [
        { label: 'Load the L part and its STL', run: () => load('cad'), done: () => on('cad') && Boolean(state.cad) },
        { label: 'Align', run: async () => { $('cadAlign').click(); await until(cadDone, RUN_TIMEOUT_MS, 'Alignment'); App.setMain('3D'); }, done: () => on('cad') && Boolean(cadDone()) }],
      result: () => (on('cad') ? cadLine() : '') },
    { title: 'Step 7 · Filler and fibers', target: () => $('step7'), open: 'step7',
      body: ['Finds the bright phase inside the sample after pore segmentation: particles detected at matrix + 4 robust SD, measured halfway to their own gray. Reports count, volume fraction, size distribution, nearest-neighbor dispersion (Clark–Evans) and the fiber orientation tensor.',
        'This scan has 50 bright spheres and 20 short fibers lying within 8° of x.'],
      actions: [
        { label: 'Load the filler scan', run: () => load('filler'), done: () => on('filler') },
        { label: 'Segment pores, then find filler', run: async () => { await pores(); $('runFiller').click(); await until(fillerDone, RUN_TIMEOUT_MS, 'Filler analysis'); App.setMain('3D'); }, done: () => on('filler') && Boolean(fillerDone()) }],
      result: () => (on('filler') ? fillerLine() : '') },
    { title: 'Step 8 · Wall thickness', target: () => $('step8'), open: 'step8',
      body: ['Local wall thickness of the sample mask, from the ridge of the distance to the outside: the distribution and the thinnest places, each a click from its slice. Walls thinner than about 3 analysis voxels are not reported; corners are not walls.',
        'The tour measures the generated L part: legs 1.2 and 1.6 mm thick and 1.6 mm deep before its 3 % shrinkage.'],
      actions: [
        { label: 'Load the L part', run: () => load('cad'), done: () => on('cad') },
        { label: 'Measure walls', run: async () => { $('runWall').click(); await until(wallDone, RUN_TIMEOUT_MS, 'Wall measurement'); }, done: () => on('cad') && Boolean(wallDone()) }],
      result: () => (on('cad') ? wallLine() : '') },
    { title: 'Your own scan', target: () => $('folder').parentElement,
      body: ['The Library button opens the scan library: in Chrome or Edge, choose the folder that holds your scans and every scan under it is listed as a card. Open scan folder reads one folder of 16-bit TIFF slices (or a Rigaku .VOX) without a library; a folder of scan folders lists each one. Large scans load block-mean binned, and the page says so first.',
        'Save project writes the regions, annotations and runs to a file kept next to the scan. The tour is under Guided tour in the top bar.'] },
  ];

  // ---------- drawing ----------
  function build() {
    const shade = document.createElement('div');
    shade.className = 'tourshade';
    const card = document.createElement('section');
    card.className = 'tourcard';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Guided tour');
    card.innerHTML = '<div class="tourhead"><span class="mono tourcount"></span><button class="tourclose" aria-label="Close the tour">×</button></div>'
      + '<h2 class="tourtitle"></h2><div class="tourbody"></div><div class="touractions"></div><p class="mono tourresult" aria-live="polite"></p>'
      + '<div class="tournav"><button class="tourback">Back</button><span class="tourdots" aria-hidden="true"></span><button class="tournext">Next</button></div>';
    document.body.append(shade, card);
    card.querySelector('.tourclose').addEventListener('click', stop);
    card.querySelector('.tourback').addEventListener('click', () => go(at - 1));
    card.querySelector('.tournext').addEventListener('click', () => (at === STOPS.length - 1 ? stop() : go(at + 1)));
    return { shade, card };
  }

  // An action without a done test counts as done once it has run in this tour.
  const isDone = (a) => (a.done ? Boolean(a.done()) : Boolean(a.ran));
  const nextAction = (stop) => (stop.actions || []).find((a) => !isDone(a));

  function renderActions() {
    const stop = STOPS[at], host = ui.card.querySelector('.touractions');
    host.textContent = '';
    const list = stop.actions || [];
    if (!list.length) return;
    const next = nextAction(stop);
    const steps = document.createElement('ol');
    steps.className = 'tourplan';
    for (const a of list) {
      const li = document.createElement('li');
      li.textContent = a.label;
      if (isDone(a)) li.className = 'done';
      else if (a === next) li.className = 'now';
      steps.append(li);
    }
    host.append(steps);
    if (next) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = busy ? 'Working…' : next.label;
      b.disabled = busy;
      b.addEventListener('click', () => run(next));
      host.append(b);
    }
  }

  async function run(action) {
    busy = true; error = ''; refresh();
    try { await action.run(); action.ran = true; } catch (e) { error = e.message; }
    busy = false;
    // Loading a scan can open another step of the rail; bring this stop's step back into view.
    const stop = STOPS[at];
    if (stop && stop.open && $(stop.open)) { $(stop.open).open = true; const el = stop.target && stop.target(); if (el) el.scrollIntoView({ block: 'nearest' }); }
    refresh();
  }

  function place() {
    const stop = STOPS[at], card = ui.card, el = stop.target ? stop.target() : null;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 14, pad = 8;
    const narrow = vw < 900;
    let r = el && !el.hidden && el.getClientRects().length ? el.getBoundingClientRect() : null;
    if (r) {
      // Clip to the page and to any scrolling box the target sits in (the rail's step list).
      r = { left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, vw), bottom: Math.min(r.bottom, vh) };
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowY;
        if (o !== 'auto' && o !== 'scroll' && o !== 'hidden') continue;
        const c = p.getBoundingClientRect();
        r = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
      }
    }
    if (r && (r.right - r.left < 2 || r.bottom - r.top < 2)) r = null;
    const s = ui.shade.style;
    if (r) { s.left = `${r.left - 4}px`; s.top = `${r.top - 4}px`; s.width = `${r.right - r.left + 8}px`; s.height = `${r.bottom - r.top + 8}px`; ui.shade.classList.remove('none'); }
    else { s.left = `${vw / 2}px`; s.top = `${vh / 2}px`; s.width = '0px'; s.height = '0px'; ui.shade.classList.add('none'); }
    card.classList.toggle('sheet', narrow);
    if (narrow) { card.style.left = ''; card.style.top = ''; return; }
    const w = card.offsetWidth, h = card.offsetHeight;
    let x, y;
    if (!r) { x = (vw - w) / 2; y = (vh - h) / 2; }
    else if (r.left - gap - w >= pad) { x = r.left - gap - w; y = r.top; }
    else if (r.right + gap + w <= vw - pad) { x = r.right + gap; y = r.top; }
    else if (r.bottom + gap + h <= vh - pad) { x = r.left; y = r.bottom + gap; }
    else if (r.top - gap - h >= pad) { x = r.left; y = r.top - gap - h; }
    else { x = vw - w - pad; y = 48; } // the target fills the page: top right, over the rail
    card.style.left = `${Math.round(Math.min(Math.max(x, pad), vw - w - pad))}px`;
    card.style.top = `${Math.round(Math.min(Math.max(y, pad), vh - h - pad))}px`;
  }

  function refresh() {
    if (!ui) return;
    const stop = STOPS[at], card = ui.card;
    renderActions();
    const lines = [];
    if (stop.needs && !on(stop.needs) && !busy) lines.push('This stop reads the dense-band scan: go Back one or two stops to load it.');
    const got = stop.result ? stop.result() : '';
    if (got) lines.push(got);
    if (error) lines.push(error);
    const res = card.querySelector('.tourresult');
    const text = lines.join(' ');
    if (res.textContent !== text) res.textContent = text;
    res.hidden = !text;
    res.classList.toggle('bad', Boolean(error));
    place();
  }

  function go(i) {
    if (i < 0 || i >= STOPS.length) return;
    at = i; error = '';
    const stop = STOPS[at], card = ui.card;
    card.querySelector('.tourcount').textContent = `${at + 1} / ${STOPS.length}`;
    card.querySelector('.tourtitle').textContent = stop.title;
    const body = card.querySelector('.tourbody');
    body.textContent = '';
    for (const p of stop.body) { const el = document.createElement('p'); el.textContent = p; body.append(el); }
    card.querySelector('.tourback').disabled = at === 0;
    card.querySelector('.tournext').textContent = at === STOPS.length - 1 ? 'Finish' : 'Next';
    const dots = card.querySelector('.tourdots');
    dots.textContent = '';
    STOPS.forEach((_, k) => { const d = document.createElement('i'); if (k === at) d.className = 'on'; else if (k < at) d.className = 'past'; dots.append(d); });
    if (stop.open && $(stop.open)) $(stop.open).open = true;
    const el = stop.target ? stop.target() : null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    refresh();
    card.querySelector('.tournext').focus({ preventScroll: true });
  }

  function key(e) {
    if (!ui || e.target.matches('input, select, textarea')) return;
    if (e.key === 'Escape') stop();
    else if (e.key === 'ArrowRight') go(at + 1);
    else if (e.key === 'ArrowLeft') go(at - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function start(from = 0) {
    if (!ui) ui = build();
    for (const stop of STOPS) for (const a of stop.actions || []) a.ran = false;
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', place);
    clearInterval(timer);
    timer = setInterval(refresh, 300);
    go(from);
  }

  function stop() {
    if (!ui) return;
    clearInterval(timer); timer = null;
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', place);
    ui.shade.remove(); ui.card.remove(); ui = null; at = -1;
  }

  App.on('start', () => {
    $('tourStart').addEventListener('click', () => start(0));
    $('tourStartup').addEventListener('click', () => start(0));
    if (new URLSearchParams(location.search).has('tour')) start(0);
  });

  App.tour = { start, stop, stops: STOPS };
}(window.CTApp));
