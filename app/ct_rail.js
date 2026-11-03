/* The toolbar and right rail: the four steps (crop, pore segmentation, gray-value zones, annotations and export) and the layer legend. */
(function (App) {
  'use strict';
  const CT = window.CT, P = window.CTPores, R = window.CTRegions, E = window.CTExport, Z = window.CTZones;
  const { state, $, on, emit } = App;
  const AXIS = { XY: 'z', XZ: 'y', YZ: 'x' };
  const TABLE_ROWS = 200;
  const TOOLS = [
    { id: 'navigate', mark: 'N', label: 'Move', strip: true, hint: 'Click: set the slice crosshair. Drag: pan. Scroll or arrow keys: change slice (Shift: 10). Ctrl+scroll: zoom. Click a thumbnail to enlarge it.' },
    { id: 'point', mark: 'P', label: 'Point', strip: true, hint: 'Click a point, add an optional note, press Enter to save.' },
    { id: 'caliper', mark: 'C', label: 'Measure', strip: true, hint: 'Click two points to measure length, press Enter to save.' },
    { id: 'polygon', mark: 'G', label: 'Outline', strip: true, hint: 'Click vertices; click the first vertex or press Enter to close. Backspace removes the last vertex.' },
    { id: 'freehand', mark: 'D', label: 'Freehand', hint: 'Drag on the main view to draw a polygon, then save.' },
    { id: 'review', mark: 'R', label: 'Reject pores', hint: 'Click a pore to reject it; click again to restore. Rejected pores stay in the export, flagged.' },
  ];
  // Gray zones first (high-gray, low-gray, baseline), then drawn zones in label order.
  const zoneRank = (z) => (z < 4 ? [2, 3, 1].indexOf(z) : z);
  const LEGEND_KEY = 'ct-legend-collapsed';
  const SETTINGS = [
    { key: 'poreThreshold', label: 'Pore threshold (gray)', min: 600, max: 2000, step: 50, format: (v) => `${v}` },
    { key: 'fineSigma', label: 'Gaussian smoothing σ', min: 0, max: 2, step: 0.25, format: (v) => `${(v * state.voxelMm * 1000).toFixed(0)} µm` },
    { key: 'minVolumeMm3', label: 'Minimum pore size', min: -4, max: -1, step: 0.1, log: true, format: (v) => `${(((6 * v) / Math.PI) ** (1 / 3)).toFixed(3)} mm ESD` },
    { key: 'neck', label: 'Neck split width', min: 0, max: 6, step: 1, format: (v) => `${((2 * v + 1) * 2 * state.voxelMm).toFixed(2)} mm` },
    { key: 'maxElongation', label: 'Elongation cutoff (AR)', min: 1.5, max: 6, step: 0.1, format: (v) => v.toFixed(1) },
    { key: 'bodyThreshold', label: 'Sample mask threshold (gray)', min: 800, max: 2000, step: 50, format: (v) => `${v}` },
    { key: 'closeRadius', label: 'Mask closing width', min: 0, max: 24, step: 1, format: (v) => `${(2 * v * 2 * state.voxelMm).toFixed(1)} mm` },
  ];
  let poreFilter = 'all';

  // ---------- tools ----------
  function renderTools() {
    const strip = $('strip');
    strip.textContent = '';
    for (const t of TOOLS.filter((x) => x.strip)) {
      const b = document.createElement('button');
      b.textContent = t.label;
      b.title = `${t.hint} Shortcut: ${t.mark}`;
      b.setAttribute('aria-pressed', String(state.tool === t.id));
      b.addEventListener('click', () => setTool(t.id));
      strip.append(b);
    }
    const tool = TOOLS.find((t) => t.id === state.tool);
    const hint = document.createElement('span');
    hint.className = 'toolhint';
    hint.textContent = tool.hint;
    hint.title = tool.hint;
    strip.append(hint);
    const annotating = state.tool === 'point' || state.tool === 'caliper' || state.tool === 'polygon';
    const drawing = annotating || state.tool === 'freehand';
    $('draftPanel').hidden = !drawing;
    const hints = { crop: 'Drag a polygon around the sample on the main view, then save. Voxels outside it are excluded through the full depth of that view.',
      phantom: `Drag a polygon inside the phantom${state.phantomDraft ? ` (${state.phantomDraft.name}, ${state.phantomDraft.density_g_cm3} g/cm³)` : ''}, away from its edge, set the slices where it is solid, then save.` };
    $('toolHintLong').textContent = state.tool === 'freehand' && hints[state.regionLabel] ? hints[state.regionLabel] : tool.hint;
    $('types').hidden = !annotating;
    $('regionLabels').hidden = state.tool !== 'freehand' || state.regionLabel === 'crop' || state.regionLabel === 'phantom';
    $('reviewVoids').setAttribute('aria-pressed', String(state.tool === 'review'));
    const chips = (host, list, current, pick) => {
      host.textContent = '';
      for (const t of list) {
        const b = document.createElement('button');
        const dot = document.createElement('span');
        dot.className = 'swatch'; dot.style.background = t.color;
        b.append(dot, t.label);
        b.setAttribute('aria-pressed', String(current === t.id));
        b.addEventListener('click', () => { pick(t.id); renderTools(); renderDraft(); emit('redraw'); });
        host.append(b);
      }
    };
    chips($('types'), CT.FEATURE_TYPES, state.type, (id) => { state.type = id; });
    chips($('regionLabels'), App.regionLabels(), state.regionLabel, (id) => { state.regionLabel = id; });
  }

  function setTool(id) {
    state.tool = id;
    state.draft = null;
    renderTools(); renderDraft(); emit('redraw');
  }

  function startDrawing(label) {
    state.regionLabel = label;
    if (state.main === '3D') App.setMain('XY');
    setTool('freehand');
  }

  function renderDraft() {
    const d = state.draft;
    $('draftBar').hidden = !d;
    const ranged = d && d.kind === 'region' && state.regionLabel !== 'crop';
    $('rangeBar').hidden = !ranged;
    if (!d) { $('note').value = ''; return; }
    if (ranged && d.complete) { $('rangeFrom').value = d.sliceFrom; $('rangeTo').value = d.sliceTo; }
    $('finishPolygon').hidden = d.kind !== 'polygon' || d.complete;
    $('finishPolygon').disabled = d.points.length < 3;
    $('saveDraft').disabled = !d.complete;
    if (d.complete) $('note').focus();
  }

  function saveDraft() {
    const d = state.draft;
    if (!d || !d.complete) return;
    const sample = CT.sampleInfo(state.folder, state.samples);
    const common = { sample, id: App.newId(), now: new Date().toISOString(), note: $('note').value.trim(), points: d.points, binFactor: state.binFactor };
    if (d.kind === 'region') {
      const crop = state.regionLabel === 'crop';
      const depth = CT.planeShape(d.plane, state.dims).depth;
      const phantom = state.regionLabel === 'phantom' ? state.phantomDraft : undefined;
      const record = R.makeRegion({ ...common, plane: d.plane, sliceFrom: crop ? 0 : Number($('rangeFrom').value), sliceTo: crop ? depth - 1 : Number($('rangeTo').value), label: state.regionLabel, voxelMm: state.voxelMm, dims: state.dims, phantom }, App.regionLabels());
      App.saveRecord('regions', record);
      if (crop || phantom) { state.regionLabel = R.drawLabel(state.regionLabel, App.regionLabels()); state.phantomDraft = null; setTool('navigate'); }
      if (crop) App.cropChanged();
      else if (state.zones && state.zones.map) App.requestZones();
    } else {
      App.saveRecord('annotations', CT.makeAnnotation({ ...common, dims: state.dims, voxelMm: state.voxelMm, window: { ...state.window }, plane: d.plane, slice: d.slice, kind: d.kind, type: state.type }));
    }
    state.draft = null;
    $('note').value = '';
    renderDraft();
  }

  // ---------- samples ----------
  const sampleLabel = (s) => [s.name, s.material, s.process].filter(Boolean).join(' · ');

  function renderSampleTables() {
    for (const id of ['startSamples', 'railSamples']) {
      const table = $(id);
      table.textContent = '';
      if (!state.stacks.length) continue;
      const head = table.insertRow();
      for (const h of ['Folder', 'Name', 'Material', 'Process', 'Slices']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
      for (const stack of state.stacks) {
        const s = CT.sampleInfo(stack.folder, state.samples);
        const tr = table.insertRow();
        for (const c of [stack.folder, s.name, s.material || '-', s.process || '-']) tr.insertCell().textContent = c;
        const cell = tr.insertCell();
        if (stack.folder === state.folder) cell.textContent = 'open now';
        else if (stack.folder === state.loading) cell.textContent = 'reading';
        else {
          const b = document.createElement('button');
          b.className = 'link';
          b.textContent = `load ${stack.files.length} slices`;
          b.addEventListener('click', () => App.loadStack(stack));
          cell.append(b);
        }
      }
    }
    const select = $('sampleSelect');
    select.hidden = state.stacks.length < 2;
    select.textContent = '';
    for (const stack of state.stacks) {
      const o = document.createElement('option');
      o.value = stack.folder;
      o.textContent = sampleLabel(CT.sampleInfo(stack.folder, state.samples));
      if (stack.folder === (state.folder || state.loading)) o.selected = true;
      select.append(o);
    }
  }

  function renderSampleForm() {
    const s = state.folder ? CT.sampleInfo(state.folder, state.samples) : null;
    for (const [id, key] of [['sampleName', 'name'], ['sampleMaterial', 'material'], ['sampleProcess', 'process'], ['sampleNotes', 'notes']]) {
      if (document.activeElement !== $(id)) $(id).value = s ? s[key] : '';
      $(id).disabled = !s;
    }
    $('saveSample').disabled = !s;
    $('sampleState').textContent = !s ? '' : state.samples.has(state.folder) ? 'saved' : 'not described yet';
  }

  function saveSample() {
    if (!state.folder) return;
    const v = (id) => $(id).value.trim();
    App.saveSample({ name: v('sampleName') || state.folder, material: v('sampleMaterial'), process: v('sampleProcess'), notes: v('sampleNotes') });
  }

  function renderFacts() {
    const facts = $('facts');
    facts.textContent = '';
    if (!state.folder) return;
    const s = CT.sampleInfo(state.folder, state.samples);
    const fit = App.calibration();
    $('calHint').textContent = fit && fit.ok ? `Gray is calibrated to the equivalent density of the phantom material (${fit.n} points).` : 'Gray values are uncalibrated (no reference phantoms).';
    const { nx, ny, nz } = state.dims;
    const rows = [['Sample', sampleLabel(s)], ['Voxels', `${nx} × ${ny} × ${nz}`], ['Grid', CT.gridText(state.binFactor)],
      ['Voxel', `${(state.voxelMm * 1000).toFixed(2)} µm, isotropic assumed (${state.binFactor > 1 ? `${state.binFactor}× the TIFF resolution tag` : 'TIFF resolution tag'})`],
      ['FOV diameter', state.circle ? `${(2 * state.circle.r * state.voxelMm).toFixed(1)} mm` : 'not found'], ['Gray window', `${state.window.low} to ${state.window.high}, uncalibrated`]];
    for (const [k, v] of rows) {
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
      facts.append(a, b);
    }
    $('crumb').textContent = rows[0][1];
    $('scanTag').textContent = state.folder;
  }

  function setWindow({ low, high }) {
    const lo = Math.max(0, Math.round(low));
    state.window = { low: lo, high: Math.max(lo + 1, Math.round(high)) };
    $('low').value = state.window.low; $('high').value = state.window.high;
    $('lowRange').value = state.window.low; $('highRange').value = state.window.high;
    renderFacts();
    emit('windowChanged');
  }

  const autoFor = (view) => (view === 'rainbow' ? state.rainbowAuto : state.autoWindow);

  // Each view keeps its own window: the rainbow window starts between the air and matrix peaks.
  function setView(view) {
    if (view === state.view) return;
    state.viewWindows[state.view] = { ...state.window };
    state.view = view;
    $('viewGray').setAttribute('aria-pressed', String(view === 'gray'));
    $('viewRainbow').setAttribute('aria-pressed', String(view === 'rainbow'));
    $('autoWindow').title = view === 'rainbow' ? 'Between the air and matrix peaks of the histogram' : '0 to the 99.9th percentile';
    renderLayers();
    setWindow(state.viewWindows[view] || autoFor(view));
    emit('viewChanged');
  }

  function layerCounts() {
    const counts = {};
    if (state.pores) {
      const v = P.summarize(state.pores, state.bodyMm3, state.rejected);
      counts.pores = v.pore_count; counts.cracks = v.crack_like_count; counts.clipped = v.clipped_count;
    }
    if (state.patches) counts.patches = state.patches.length;
    return counts;
  }

  function renderLayers() {
    const host = $('layerToggles');
    host.textContent = '';
    const counts = layerCounts();
    let group = null;
    for (const l of App.LAYERS) {
      if (l.group && l.group !== group) {
        group = l.group;
        const g = document.createElement('div');
        g.className = 'legendgroup';
        g.textContent = `${group} view`;
        host.append(g);
      }
      const b = document.createElement('button');
      b.className = 'layer';
      b.dataset.tip = `${l.label}: ${l.hint}`;
      b.setAttribute('aria-label', `${l.label}. ${l.hint}`);
      b.setAttribute('aria-pressed', String(state.show[l.id]));
      const chip = document.createElement('span');
      chip.className = 'chip';
      // Rainbow view draws these layers as outlines in their own colors.
      const color = state.view === 'rainbow' && l.outline ? l.outline : l.color;
      chip.style.background = color; chip.style.borderColor = color === '#000000' ? 'var(--line-control)' : color;
      const name = document.createElement('span');
      name.className = 'lname'; name.textContent = l.label;
      if (counts[l.id] !== undefined) { const c = document.createElement('span'); c.className = 'count'; c.textContent = counts[l.id].toLocaleString('en-US'); name.append(c); }
      const desc = document.createElement('span');
      desc.className = 'ldesc'; desc.textContent = l.hint;
      b.append(chip, name, desc);
      b.addEventListener('click', () => { state.show[l.id] = !state.show[l.id]; renderLayers(); emit('layersChanged'); });
      host.append(b);
    }
  }

  function setLegendCollapsed(collapsed) {
    $('legend').classList.toggle('collapsed', collapsed);
    $('legendToggle').textContent = collapsed ? 'Expand' : 'Collapse';
    try { localStorage.setItem(LEGEND_KEY, collapsed ? '1' : '0'); } catch (e) { /* storage can be blocked; the legend still works */ }
  }

  // ---------- pores ----------
  function renderSettings() {
    const host = $('poreSettings');
    host.textContent = '';
    if (!state.voxelMm) return;
    for (const s of SETTINGS) {
      const wrap = document.createElement('label');
      wrap.className = 'setting';
      const name = document.createElement('span');
      name.textContent = s.label;
      const value = document.createElement('span');
      value.className = 'v mono';
      const input = document.createElement('input');
      input.type = 'range'; input.min = s.min; input.max = s.max; input.step = s.step; input.id = `set_${s.key}`;
      input.value = s.log ? Math.log10(state.settings[s.key]) : state.settings[s.key];
      const show = () => { value.textContent = s.format(state.settings[s.key]); };
      show();
      input.addEventListener('input', () => {
        state.settings[s.key] = s.log ? 10 ** Number(input.value) : Number(input.value);
        show();
        $('poreStatus').textContent = 'Parameters changed. Press Segment pores to apply.';
      });
      wrap.append(name, value, input);
      host.append(wrap);
    }
  }

  function renderPoreSummary() {
    const host = $('poreSummary');
    host.textContent = '';
    const running = state.porePhase === 'running';
    $('runPores').disabled = !state.model || running;
    $('runPores').textContent = state.pores ? 'Segment pores again' : 'Segment pores';
    for (const id of ['savePoreRun', 'exportPores', 'exportMask', 'reviewVoids']) $(id).disabled = !state.pores;
    $('exportPatches').disabled = !state.patches;
    $('exportSheet').disabled = !state.patches;
    $('exportZones').disabled = !(state.zones && state.zones.map);
    $('draftZones').disabled = !state.patches;
    $('drawCrop').disabled = !state.model;
    $('drawRegion').disabled = !state.folder;
    $('voidHeadline').hidden = !state.pores;
    $('minVoidRow').hidden = !state.pores;
    if (!state.pores) { $('poreTag').textContent = running ? 'running' : 'not run'; renderPoreTable(); renderLayers(); return; }
    const s = P.summarize(state.pores, state.bodyMm3, state.rejected);
    const small = state.pores.filter((p) => p.diameter_mm < 0.16 && !state.rejected.has(p.id)).length;
    $('poreTag').textContent = `${s.all_void_percent_of_body.toFixed(2)} % porosity`;
    const head = $('voidHeadline');
    head.textContent = `${s.all_void_percent_of_body.toFixed(2)} %`;
    const note = document.createElement('small');
    const cropped = App.cropsOf(state.folder).length > 0;
    note.textContent = `porosity: ${s.all_void_volume_mm3.toFixed(0)} mm³ pore volume in ${s.body_volume_mm3.toFixed(0)} mm³ sample mask.${cropped ? '' : ' No crop: the mask may include the holder.'}`;
    const origin = document.createElement('small');
    origin.className = 'provenance';
    origin.textContent = App.provenance();
    head.append(note, origin);
    const patchVolume = state.patches ? state.patches.reduce((t, p) => t + p.volume_mm3, 0) : null;
    const rows = [['Pores, AR ≤ 2.5', `${s.pore_count}, ${s.pore_volume_mm3.toFixed(1)} mm³`], ['Pores, AR > 2.5', `${s.crack_like_count}, ${s.crack_like_volume_mm3.toFixed(1)} mm³`], ['Pores at FOV edge', `${s.clipped_count}, ${s.clipped_volume_mm3.toFixed(1)} mm³`],
      ['ESD < 0.16 mm', `${small}`], ['Rejected', `${s.rejected_count}`], ['Low-density regions (excluded)', state.patches ? `${state.patches.length}, ${patchVolume.toFixed(1)} mm³` : 'segmenting']];
    const k = state.connectivity;
    if (k) {
      const split = window.VBConnectivity.openClosed(state.pores, s.body_volume_mm3, state.rejected);
      const axes = ['x', 'y', 'z'].filter((a) => k.through[a]);
      rows.push(['Open porosity', `${split.open_percent.toFixed(2)} %, ${split.open_mm3.toFixed(1)} mm³`], ['Closed porosity', `${split.closed_percent.toFixed(2)} %, ${split.closed_mm3.toFixed(1)} mm³`]);
      if (split.unknown_mm3 > 0) rows.push(['Open or closed unknown (scan end)', `${split.unknown_percent.toFixed(2)} %, ${split.unknown_mm3.toFixed(1)} mm³`]);
      rows.push(['Through-path', axes.length ? `along ${axes.join(', ')}` : 'none']);
    }
    $('poreOpenNote').hidden = !k;
    const runThreshold = state.poreRunSettings ? state.poreRunSettings.poreThreshold : state.settings.poreThreshold;
    if (k) $('poreOpenNote').textContent = `Open: outside air reaches the pore through gray below the pore threshold (${runThreshold}), starting at the sample surface or a crop face, at ${CT.gridText(state.binFactor * 2)} resolution; a crack narrower than that reads as closed. A pore cut by the first or last slice is unknown unless air reaches it. Through-path: a network of open pores reaching both ends of the part's bounding box along an axis.`;
    const fit = App.calibration();
    if (fit && fit.ok && state.solidGray != null) rows.push(['Matrix eq. density', `${App.densityText(fit, state.solidGray)} g/cm³`]);
    $('poreCalNote').hidden = !(fit && fit.ok);
    if (fit && fit.ok) $('poreCalNote').textContent = calibrationNote(fit);
    for (const [k, v] of rows) {
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
      host.append(a, b);
    }
    renderPoreTable();
    renderLayers();
  }

  function renderPoreTable() {
    const table = $('poreTable');
    table.textContent = '';
    const filterHost = $('poreFilter');
    filterHost.textContent = '';
    filterHost.hidden = !state.pores;
    $('poreTableNote').textContent = '';
    if (!state.pores) return;
    const filters = [['all', 'All pores'], ['pore', 'AR ≤ 2.5'], ['small', 'ESD < 0.16 mm'], ['crack', 'AR > 2.5'], ['rejected', 'Rejected'], ['patch', 'Low-density']];
    for (const [id, label] of filters) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(poreFilter === id));
      b.addEventListener('click', () => { poreFilter = id; renderPoreTable(); });
      filterHost.append(b);
    }
    const jumpTo = (p) => emit('jump', { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
    const head = table.insertRow();
    if (poreFilter === 'patch') {
      for (const h of ['ID', 'ESD (mm)', 'Vol. (mm³)', 'Gray', 'Rel. gray']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
      const list = state.patches || [];
      for (const p of list.slice(0, TABLE_ROWS)) {
        const tr = table.insertRow();
        tr.className = 'pick';
        for (const c of [p.id, p.diameter_mm.toFixed(3), p.volume_mm3.toFixed(3), p.gray_mean.toFixed(0), p.relative_gray.toFixed(2)]) tr.insertCell().textContent = c;
        tr.addEventListener('click', () => jumpTo(p));
      }
      $('poreTableNote').textContent = 'Relative gray: air 0, matrix 1 (uncalibrated).';
      return;
    }
    const test = { all: () => true, pore: (p) => !p.crack_like && !p.clipped, small: (p) => p.diameter_mm < 0.16, crack: (p) => p.crack_like, rejected: (p) => state.rejected.has(p.id) }[poreFilter];
    const list = state.pores.filter(test);
    for (const h of ['ID', 'ESD (mm)', 'Vol. (mm³)', 'AR', 'Sphericity', 'Surface (mm)', 'Class', '']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    for (const p of list.slice(0, TABLE_ROWS)) {
      const tr = table.insertRow();
      tr.className = `pick${p.id === state.selected ? ' selected' : ''}${state.rejected.has(p.id) ? ' rejected' : ''}`;
      const cls = `${p.clipped ? 'FOV edge' : p.crack_like ? 'AR > cutoff' : 'AR ≤ cutoff'}${p.open ? ', open' : p.open === false ? ', closed' : p.at_scan_end ? ', scan end' : ''}`;
      for (const c of [p.id, p.diameter_mm.toFixed(3), p.volume_mm3.toFixed(4), p.elongation.toFixed(1), p.sphericity == null ? '–' : p.sphericity.toFixed(2), p.surface_distance_mm == null ? '–' : p.surface_distance_mm.toFixed(2), cls]) tr.insertCell().textContent = c;
      const cell = tr.insertCell();
      const reject = document.createElement('button');
      reject.className = 'link';
      reject.textContent = state.rejected.has(p.id) ? 'restore' : 'reject';
      reject.addEventListener('click', (e) => { e.stopPropagation(); App.toggleReject(p.id); });
      cell.append(reject);
      tr.addEventListener('click', () => {
        state.selected = p.id;
        jumpTo(p);
        emit('layersChanged');
        renderPoreTable();
      });
    }
    $('poreTableNote').textContent = list.length > TABLE_ROWS ? `Largest ${TABLE_ROWS} of ${list.length} shown; the CSV export holds all.` : `${list.length} shown.`;
  }

  // ---------- regions ----------
  function densityOf(region, stats, reference) {
    if (!reference || state.airGray === null) return null;
    const refStats = App.statsOf(reference);
    const referenceGray = refStats.matrix_gray_mean ?? refStats.gray_mean;
    return R.densityEstimate({ gray: stats.gray_mean, airGray: state.airGray, referenceGray, referenceDensity: state.referenceDensity });
  }

  function regionRows() {
    const regions = state.folder ? App.regionsOf(state.folder).filter((r) => r.label !== 'crop' && r.label !== 'phantom') : [];
    const reference = regions.find((r) => r.id === state.referenceId) || null;
    return regions.map((r) => {
      const stats = App.statsOf(r);
      return { ...r, stats, density: densityOf(r, stats, reference) };
    });
  }

  function regionDelete(r) {
    const del = document.createElement('button');
    del.className = 'link';
    del.textContent = state.deleting === r.id ? 'confirm delete' : 'delete';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.deleting !== r.id) { state.deleting = r.id; renderRegions(); return; }
      App.removeRecord('regions', r.id);
      if (r.label === 'crop') App.cropChanged();
      else if (state.zones && state.zones.map) App.requestZones();
    });
    return del;
  }

  function renderCrops() {
    const crops = state.folder ? App.cropsOf(state.folder) : [];
    $('cropTag').textContent = crops.length ? `${crops.length} drawn` : 'optional';
    $('cropWrap').hidden = !crops.length;
    const table = $('cropTable');
    table.textContent = '';
    for (const c of crops) {
      const tr = table.insertRow();
      const name = tr.insertCell();
      name.style.textAlign = 'left';
      name.textContent = `Crop polygon, ${c.plane}`;
      tr.insertCell().append(regionDelete(c));
    }
  }

  function renderRegions() {
    renderCrops();
    const measured = state.folder ? App.regionsOf(state.folder).filter((r) => r.label !== 'crop' && r.label !== 'phantom') : [];
    $('exportRegions').disabled = !measured.length;
    $('regionWrap').hidden = !measured.length;
    const select = $('referenceRegion');
    const previous = state.referenceId;
    select.textContent = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = 'None';
    select.append(none);
    for (const r of measured) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = `${R.labelOf(r.label, App.regionLabels()).label}${r.note ? `: ${r.note}` : ''} (${r.plane} ${AXIS[r.plane]} ${r.slice_from}–${r.slice_to})`;
      if (r.id === previous) o.selected = true;
      select.append(o);
    }
    $('airNote').textContent = state.airGray === null ? '' : `Air reads ${state.airGray.toFixed(0)} gray here (median outside the part body).`;

    const table = $('regionTable');
    table.textContent = '';
    if (!measured.length) return;
    const head = table.insertRow();
    const fit = App.calibration(), calibrated = Boolean(fit && fit.ok);
    $('tableCalNote').hidden = !calibrated;
    if (calibrated) $('tableCalNote').textContent = calibrationNote(fit);
    for (const h of ['Region', 'mm³', 'Gray', 'Matrix gray', 'Porosity (%)', 'Pores', 'Rel. density', 'g/cm³ (est.)', ...(calibrated ? ['Eq. density (g/cm³)'] : []), '']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    const fmt = (v, d) => (v === null || v === undefined ? 'n/a' : v.toFixed(d));
    for (const r of regionRows()) {
      const def = R.labelOf(r.label, App.regionLabels());
      const tr = table.insertRow();
      tr.className = 'pick';
      const name = tr.insertCell();
      name.style.textAlign = 'left';
      const dot = document.createElement('span'); dot.className = 'swatch'; dot.style.background = def.color;
      name.append(dot, def.label);
      const cells = [fmt(r.stats.volume_mm3, 2), `${fmt(r.stats.gray_mean, 0)}±${fmt(r.stats.gray_sd, 0)}`, fmt(r.stats.matrix_gray_mean, 0), r.stats.pore_fraction === null ? 'n/a' : (100 * r.stats.pore_fraction).toFixed(2), r.stats.pore_count ?? 'n/a', fmt(r.density && r.density.relative, 3), fmt(r.density && r.density.g_cm3, 3)];
      if (calibrated) cells.push(App.densityText(fit, r.stats.matrix_gray_mean ?? r.stats.gray_mean));
      for (const c of cells) tr.insertCell().textContent = c;
      tr.insertCell().append(regionDelete(r));
      tr.addEventListener('click', () => {
        const mid = Math.round((r.slice_from + r.slice_to) / 2);
        emit('jump', CT.voxelOf(r.plane, mid, Math.round(r.points[0].col), Math.round(r.points[0].row)));
      });
    }
  }

  // Shown under every table with equivalent densities, so the caveat and the * travel with the numbers.
  const calibrationNote = (fit) => `Eq. density: equivalent density of the phantom material, from ${fit.n} points; not true density for doped or filled material, no beam-hardening correction. * outside the phantom gray range ${fit.gray_range[0].toFixed(0)} to ${fit.gray_range[1].toFixed(0)}.`;

  function renderZones() {
    const z = state.zones;
    const ok = z && z.map;
    $('zoneTag').textContent = ok ? `${z.stats.length} zones` : '';
    $('zoneThresholdRow').hidden = !ok;
    $('zoneWrap').hidden = !ok;
    $('draftZones').textContent = ok ? 'Segment zones again' : 'Segment zones';
    if (!z) { $('zoneNote').textContent = state.patches ? 'Press Segment zones.' : 'Run pore segmentation first.'; return; }
    if (!ok) { $('zoneNote').textContent = z.refused; return; }
    $('zoneNote').textContent = `Baseline: ${Z.baselineText(z.method, z.axis)}. Pink: high-gray zone; blue: low-gray zone. Adjust the threshold, assign labels, or draw a region to override.`;
    $('zoneThreshold').value = z.threshold;
    $('zoneThresholdValue').textContent = `${(100 * z.threshold).toFixed(1)} %`;
    const table = $('zoneTable');
    table.textContent = '';
    const head = table.insertRow();
    const fit = App.calibration(), calibrated = Boolean(fit && fit.ok);
    $('tableCalNote').hidden = !calibrated;
    if (calibrated) $('tableCalNote').textContent = calibrationNote(fit);
    for (const h of ['Zone', 'mm³', 'Porosity (%)', 'Gray offset', ...(calibrated ? ['Eq. g/cm³'] : []), 'Label']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    for (const s of [...z.stats].sort((a, b) => zoneRank(a.zone) - zoneRank(b.zone))) {
      const tr = table.insertRow();
      const name = tr.insertCell();
      name.style.textAlign = 'left';
      const rgb = App.zoneColor(s.zone);
      if (rgb) { const dot = document.createElement('span'); dot.className = 'swatch'; dot.style.background = `rgb(${rgb.join(',')})`; name.append(dot); }
      name.append(App.zoneTitle(s.zone));
      const percent = s.excess_median === null ? 'n/a' : `${s.excess_median >= 0 ? '+' : ''}${(100 * s.excess_median).toFixed(1)} %`;
      for (const c of [s.volume_mm3.toFixed(0), s.void_percent.toFixed(1), percent, ...(calibrated ? [App.densityText(fit, s.solid_gray_mean)] : [])]) tr.insertCell().textContent = c;
      const pick = document.createElement('select');
      pick.setAttribute('aria-label', `Label assigned to the ${App.zoneTitle(s.zone)} zone`);
      for (const [value, label] of [['undecided', 'Unassigned'], ...App.regionLabels().map((l) => [l.id, l.label])]) {
        const o = document.createElement('option');
        o.value = value; o.textContent = label;
        if ((state.zoneLabels[s.zone] || 'undecided') === value) o.selected = true;
        pick.append(o);
      }
      pick.addEventListener('change', () => { state.zoneLabels[s.zone] = pick.value; });
      tr.insertCell().append(pick);
    }
  }

  // ---------- region labels ----------
  // Editing writes the whole ordered list, so the defaults become the project's own on the first change.
  function saveLabels(list) {
    list.forEach((l, order) => App.saveRecord('labels', { id: l.id, label: l.label, color: l.color, order }));
  }

  function addLabel() {
    const list = App.regionLabels().map((l) => ({ ...l }));
    const used = new Set(list.map((l) => l.id));
    let k = list.length + 1;
    while (used.has(`label_${k}`)) k++;
    if (list.length >= Z.MAX_DRAWN) { $('labelNote').textContent = `At most ${Z.MAX_DRAWN} labels.`; return; }
    saveLabels([...list, { id: `label_${k}`, label: `Label ${k}`, color: '#a0e070' }]);
  }

  function renderLabels() {
    const host = $('labelList');
    host.textContent = '';
    const list = App.regionLabels();
    list.forEach((l, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      const color = document.createElement('input');
      color.type = 'color'; color.value = l.color; color.setAttribute('aria-label', `Color of ${l.label}`);
      const name = document.createElement('input');
      name.type = 'text'; name.value = l.label; name.setAttribute('aria-label', 'Label name'); name.style.flex = '1 1 120px';
      const edit = () => saveLabels(list.map((x, j) => (j === i ? { ...x, label: name.value.trim() || x.label, color: color.value } : x)));
      color.addEventListener('change', edit);
      name.addEventListener('change', edit);
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.disabled = list.length < 2;
      del.title = 'Regions already drawn with this label keep it and show as (deleted label)';
      del.addEventListener('click', () => {
        const plan = R.labelDelete(list, l.id, state.labels.size > 0);
        if (plan.save) saveLabels(plan.save);
        if (plan.remove) App.removeRecord('labels', plan.remove);
        if (state.regionLabel === l.id) state.regionLabel = list.find((x) => x.id !== l.id).id;
      });
      row.append(color, name, del);
      host.append(row);
    });
    $('labelNote').textContent = '';
  }

  // ---------- annotations ----------
  function renderLog() {
    const list = $('log');
    list.textContent = '';
    const records = state.folder ? App.annotationsOf(state.folder).sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];
    $('logEmpty').hidden = records.length > 0;
    $('logTag').textContent = records.length ? `${records.length}` : '';
    for (const a of records) {
      const type = CT.FEATURE_TYPES.find((t) => t.id === a.type);
      const li = document.createElement('li');
      const jump = document.createElement('button');
      jump.className = 'jump';
      const title = document.createElement('span');
      title.className = 'title';
      const dot = document.createElement('span');
      dot.className = 'swatch'; dot.style.background = type.color;
      title.append(dot, `${type.label} · ${a.kind}`);
      const where = document.createElement('span');
      where.className = 'mono';
      const what = a.kind === 'caliper' ? `${a.length_mm.toFixed(2)} mm` : a.kind === 'polygon' ? `${a.area_mm2.toFixed(2)} mm²` : `${a.mm[0].x.toFixed(2)}, ${a.mm[0].y.toFixed(2)}, ${a.mm[0].z.toFixed(2)} mm`;
      where.textContent = `${a.plane}, ${AXIS[a.plane]} = ${a.slice} · ${what}`;
      jump.append(title, where);
      if (a.note) { const n = document.createElement('span'); n.textContent = a.note; jump.append(n); }
      if (state.unsaved.has(a.id)) { const s = document.createElement('span'); s.className = 'bad'; s.textContent = 'Not saved yet'; jump.append(s); }
      jump.addEventListener('click', () => emit('jump', a.voxels[0]));
      const del = document.createElement('button');
      del.textContent = state.deleting === a.id ? 'Confirm' : 'Delete';
      del.addEventListener('click', () => {
        if (state.deleting === a.id) App.removeRecord('annotations', a.id);
        else { state.deleting = a.id; renderLog(); }
      });
      li.append(jump, del);
      list.append(li);
    }
  }

  // ---------- export ----------
  const sayExport = (t) => { $('exportStatus').textContent = t; };

  async function saveFile(filename, data) {
    try {
      const how = await window.VBStore.saveBlob(state.downloads, filename, data instanceof Blob ? data : new Blob([data], { type: 'text/csv' }));
      sayExport(how === 'declined' ? 'Save canceled.' : how === 'link' ? `Downloaded ${filename} to the browser's download folder.` : `Saved ${filename}.`);
    } catch (e) {
      sayExport(`Could not save: ${e.message}`);
    }
  }

  const runContext = () => ({ calibration: App.calibration(), binFactor: state.binFactor, provenance: App.provenance(), labels: App.regionLabels(), sample: CT.sampleInfo(state.folder, state.samples), settings: state.settings, summary: P.summarize(state.pores, state.bodyMm3, state.rejected) });

  async function saveRun() {
    if (!state.store) { sayExport('Records are not available yet, so nothing was saved.'); return; }
    sayExport('Saving the run');
    const chunks = E.poreChunks(state.pores, state.rejected);
    const context = runContext();
    const rows = regionRows();
    const run = { schema: 2, created_at: new Date().toISOString(), ...context, voxel_mm: state.voxelMm, stack_shape: state.dims, bin_factor: state.binFactor, chunk_count: chunks.length, rejected_voxels: state.rejectedVoxels,
      crops: App.cropsOf(state.folder).map((c) => ({ plane: c.plane, points: c.points })), air_gray: state.airGray, reference_region: state.referenceId || null,
      reference_density_assumed: Number.isFinite(state.referenceDensity) ? state.referenceDensity : null,
      regions: rows.map((r) => ({ id: r.id, label: r.label, plane: r.plane, slice_from: r.slice_from, slice_to: r.slice_to, note: r.note, stats: r.stats, density: r.density })),
      patches: state.patches, solid_gray: state.solidGray ?? null, gray_calibrated: Boolean(App.calibration() && App.calibration().ok), calibration: (() => { const c = App.calibration(); return c ? { fit: c.ok ? { intercept: c.intercept, slope: c.slope, r2: c.r2, n: c.n, gray_range: c.gray_range, method: c.method } : null, reason: c.ok ? null : c.reason, points: c.points } : null; })(),
      open_closed: state.connectivity ? { ...window.VBConnectivity.openClosed(state.pores, state.bodyMm3, state.rejected), through: state.connectivity.through } : null,
      filler: state.filler && state.filler.result ? { summary: state.filler.result.summary, threshold: state.filler.result.threshold, dispersion: state.filler.result.dispersion } : null,
      wall: state.wall && state.wall.result ? state.wall.result.stats : null,
      zones: state.zones ? { refused: state.zones.refused ?? null, threshold: state.zones.threshold ?? null, axis: state.zones.axis ?? null, stats: state.zones.stats ?? null, baseline: state.zones.baseline ?? null, method: state.zones.method ?? null, labels: state.zoneLabels, candidates_not_composition: true } : { labels: state.zoneLabels } };
    try {
      await state.store.putRun(state.folder, run, chunks);
      App.markDirty();
      sayExport(state.store.kind === 'file' ? `Run stored in the project: ${state.pores.length} regions. Save the project to keep it.` : `Saved to the shared database: ${state.pores.length} regions in ${chunks.length} parts.`);
    } catch (e) {
      sayExport(`Could not save the run: ${e.message}`);
    }
  }

  async function exportMask() {
    sayExport('Building the pore label volume (about 1 minute).');
    const maxId = state.pores.length;
    const dims = { nx: state.dims.nx, ny: state.dims.ny, nz: state.dims.nz };
    const parts = E.maskParts(dims, maxId, (z, out) => P.planePoreIds(state.runs, state.dims, 'XY', z, out));
    const blob = await E.zipStream(`${state.folder}_pore_ids.npy`, parts);
    state.lastMask = blob;
    await saveFile(`${state.folder}_void_ids.zip`, blob);
  }

  // ---------- wiring ----------
  function renderAll() {
    renderTools(); renderSampleTables(); renderFacts(); renderLayers(); renderSettings(); renderPoreSummary(); renderRegions(); renderZones(); renderLog(); renderDraft();
  }

  on('start', () => {
    renderAll();
    let collapsed = false;
    try { collapsed = localStorage.getItem(LEGEND_KEY) === '1'; } catch (e) { /* storage can be blocked; start expanded */ }
    setLegendCollapsed(collapsed);
    $('legendToggle').addEventListener('click', () => setLegendCollapsed(!$('legend').classList.contains('collapsed')));
    const showFill = () => { $('fillValue').textContent = `${Math.round(state.fill * 100)} %`; };
    showFill();
    $('fill').addEventListener('input', (e) => { state.fill = Number(e.target.value); showFill(); emit('layersChanged'); });
    $('drawCrop').addEventListener('click', () => startDrawing('crop'));
    $('drawRegion').addEventListener('click', () => startDrawing(R.drawLabel(state.regionLabel, App.regionLabels())));
    $('addLabel').addEventListener('click', addLabel);
    $('zoneBaseline').addEventListener('change', (e) => { state.zoneBaseline = e.target.value; if (state.zones) App.requestZones(); });
    $('doneTool').addEventListener('click', () => setTool('navigate'));
    $('reviewVoids').addEventListener('click', () => setTool(state.tool === 'review' ? 'navigate' : 'review'));
    $('draftZones').addEventListener('click', () => { state.zoneThreshold = null; $('zoneNote').textContent = 'Segmenting zones.'; App.requestZones(); });
    $('zoneThreshold').addEventListener('input', (e) => { $('zoneThresholdValue').textContent = `${(100 * Number(e.target.value)).toFixed(1)} %`; });
    $('zoneThreshold').addEventListener('change', (e) => { state.zoneThreshold = Number(e.target.value); App.requestZones(); });
    const showMinVoid = () => { $('minVoidValue').textContent = state.minVoidMm ? `${state.minVoidMm.toFixed(2)} mm` : 'all'; };
    showMinVoid();
    $('minVoid').addEventListener('input', (e) => { state.minVoidMm = Number(e.target.value); showMinVoid(); });
    $('minVoid').addEventListener('change', App.requestVoidMeshes);
    $('sampleSelect').addEventListener('change', (e) => { const s = state.stacks.find((x) => x.folder === e.target.value); if (s) App.loadStack(s); });
    $('low').addEventListener('change', () => setWindow({ low: Number($('low').value), high: state.window.high }));
    $('high').addEventListener('change', () => setWindow({ low: state.window.low, high: Number($('high').value) }));
    $('lowRange').addEventListener('input', () => setWindow({ low: Number($('lowRange').value), high: state.window.high }));
    $('highRange').addEventListener('input', () => setWindow({ low: state.window.low, high: Number($('highRange').value) }));
    $('autoWindow').addEventListener('click', () => setWindow(autoFor(state.view)));
    $('viewGray').addEventListener('click', () => setView('gray'));
    $('viewRainbow').addEventListener('click', () => setView('rainbow'));
    $('saveSlice').addEventListener('click', async () => { if (!state.folder) return; const png = await App.slicePng(); saveFile(png.filename, png.blob); });
    $('saveDraft').addEventListener('click', saveDraft);
    $('saveSample').addEventListener('click', saveSample);
    $('finishPolygon').addEventListener('click', () => emit('closePolygon'));
    $('discardDraft').addEventListener('click', () => { state.draft = null; renderDraft(); emit('redraw'); });
    $('rangeFrom').addEventListener('change', () => { if (state.draft) state.draft.sliceFrom = Number($('rangeFrom').value); });
    $('rangeTo').addEventListener('change', () => { if (state.draft) state.draft.sliceTo = Number($('rangeTo').value); });
    $('runPores').addEventListener('click', App.runDetect);
    App.on('settingsApplied', renderSettings);
    App.saveRun = saveRun; // the batch saves each scan's run
    $('resetSettings').addEventListener('click', () => { state.settings = { ...P.DEFAULT_SETTINGS }; renderSettings(); $('poreStatus').textContent = 'Default parameters restored. Press Segment pores to apply.'; });
    $('referenceRegion').addEventListener('change', (e) => { state.referenceId = e.target.value; renderRegions(); });
    $('referenceDensity').addEventListener('change', (e) => { state.referenceDensity = e.target.value === '' ? NaN : Number(e.target.value); renderRegions(); });
    $('savePoreRun').addEventListener('click', saveRun);
    $('exportSheet').addEventListener('click', () => App.exportSheet());
    $('exportPores').addEventListener('click', () => saveFile(`${state.folder}_pores.csv`, E.poreCsv(state.pores, state.rejected, runContext())));
    $('exportPatches').addEventListener('click', () => saveFile(`${state.folder}_patches.csv`, E.patchCsv(state.patches, runContext())));
    $('exportZones').addEventListener('click', () => saveFile(`${state.folder}_zones.csv`, E.zoneCsv(state.zones, state.zoneLabels, runContext())));
    $('exportRegions').addEventListener('click', () => saveFile(`${state.folder}_regions.csv`, E.regionCsv(regionRows(), { calibration: App.calibration() })));
    $('exportNotes').addEventListener('click', () => saveFile('ct_annotations.csv', E.annotationCsv([...state.annotations.values()])));
    $('exportMask').addEventListener('click', exportMask);
  });
  on('samplesChanged', renderSampleTables);
  on('recordsChanged', () => { renderLog(); renderRegions(); renderPoreSummary(); renderSampleForm(); renderSampleTables(); renderFacts(); renderLabels(); renderTools(); renderZones(); });
  on('draftChanged', renderDraft);
  on('saveDraft', saveDraft);
  on('startDrawing', (label) => startDrawing(label));
  on('toolKey', (key) => { const t = TOOLS.find((x) => x.mark.toLowerCase() === key); if (t) setTool(t.id); });
  on('statusText', (t) => { $('poreStatus').textContent = t; });
  on('loaded', () => {
    for (const id of ['lowRange', 'highRange']) $(id).max = state.sampleMax;
    setWindow(autoFor(state.view));
    renderAll();
    renderSampleForm();
  });
  on('modelChanged', () => { renderPoreSummary(); renderRegions(); });
  on('poresChanged', () => { renderSettings(); renderPoreSummary(); renderRegions(); renderZones(); });
  on('changed', renderPoreSummary);
}(window.CTApp));
