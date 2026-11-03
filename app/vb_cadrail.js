/* Step 6 of the rail: comparison to CAD. Opens the nominal STL, runs the alignment and deviation in the worker
   (App.requestCad), shows the fit, statistics, a histogram and a probe, and saves the pose and numbers with the
   sample so reopening the same STL starts from the saved pose. */
(function (App) {
  'use strict';
  const CT = window.CT, St = window.VBStl, A = window.VBAlign, D = window.VBDeviation;
  const { state, $, on, emit } = App;
  const MAX_UNMEASURED_PERCENT = 20;
  const mm = (v, digits = 3) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`);

  function measure(cad) {
    const spacing = 2 * App.BIN * state.voxelMm;
    cad.measure = St.measurePoints(cad.mesh, { spacing, unitMm: cad.unitMm });
    cad.result = null; cad.busy = false;
    state.cadSeq = (state.cadSeq || 0) + 1; // a run still in the worker belongs to the old points: its result is dropped
  }

  function openStl(name, buffer) {
    let mesh;
    try { mesh = St.parseStl(buffer); } catch (e) { state.cad = { file: name, refused: e.message }; emit('cadChanged'); return; }
    const saved = CT.sampleInfo(state.folder, state.samples).cad;
    const reuse = saved && saved.file === name ? saved : null;
    state.cad = { file: name, mesh, unitMm: reuse ? reuse.unit_mm : Number($('cadUnit').value), toleranceMm: Number($('cadTol').value) || 0.1, rangeMm: 2,
      scale: reuse ? reuse.scale_fitted : $('cadScale').checked, pose: reuse ? reuse.transform : null, reused: Boolean(reuse) };
    $('cadUnit').value = String(state.cad.unitMm); $('cadScale').checked = state.cad.scale;
    measure(state.cad);
    emit('cadChanged');
  }

  function centroidOf(cad) {
    const p = A.apply(cad.result ? cad.result.transform : cad.pose || A.IDENTITY, cad.measure.points), c = [0, 0, 0];
    for (let i = 0; i < p.length; i++) c[i % 3] += p[i];
    return c.map((v) => v / (p.length / 3));
  }

  function rotate(axis) {
    const cad = state.cad;
    const pose = A.rotate90(cad.result ? cad.result.transform : cad.pose || A.IDENTITY, axis, centroidOf(cad));
    cad.result = null; cad.pose = pose;
    App.requestCad(pose);
  }

  function drawHistogram(cad) {
    const canvas = $('cadHist'), g = canvas.getContext('2d'), limit = 3 * cad.toleranceMm;
    const h = D.histogram(cad.result.deviations, { bins: 30, range: [-limit, limit] });
    const W = canvas.width, H = canvas.height, pad = 18, top = Math.max(1, ...h.counts);
    g.clearRect(0, 0, W, H);
    h.counts.forEach((n, k) => {
      const c = D.deviationColor((h.edges[k] + h.edges[k + 1]) / 2, limit).map((v) => Math.round(255 * v));
      g.fillStyle = `rgb(${c.join(',')})`;
      const x = (k / h.counts.length) * W, w = W / h.counts.length - 1, bh = ((H - pad) * n) / top;
      g.fillRect(x, H - pad - bh, w, bh);
    });
    g.fillStyle = getComputedStyle(canvas).color || '#999';
    g.font = '10px ui-monospace, monospace';
    for (const [v, align] of [[-limit, 'left'], [-cad.toleranceMm, 'center'], [0, 'center'], [cad.toleranceMm, 'center'], [limit, 'right']]) {
      g.textAlign = align;
      g.fillText(v === 0 ? '0' : v.toFixed(2), ((v + limit) / (2 * limit)) * W, H - 4);
      g.fillRect(((v + limit) / (2 * limit)) * W - 0.5, H - pad, 1, 3);
    }
    canvas.title = `Deviation histogram, ±${limit.toFixed(2)} mm; ${h.below} points below and ${h.above} above the range are not drawn.`;
  }

  function render() {
    const cad = state.cad, ready = Boolean(state.folder && state.dims);
    const can = Boolean(cad && cad.measure && !cad.busy);
    $('cadOpen').disabled = !ready || Boolean(cad && cad.busy);
    $('cadUnit').disabled = Boolean(cad && cad.busy);
    for (const id of ['cadAlign', 'cadRefine', 'cadRotX', 'cadRotY', 'cadRotZ']) $(id).disabled = !can;
    $('cadExport').disabled = !(cad && cad.result && !cad.busy);
    $('cadRefine').disabled = !can || !(cad.result || cad.pose);
    const r = cad && cad.result;
    $('cadTag').textContent = r ? `median ${mm(r.stats.p50)} mm` : cad && cad.file ? cad.file : 'optional';
    $('cadHist').hidden = !r;
    $('cadStats').textContent = '';
    $('cadWarn').hidden = true;
    if (!cad) { $('cadFit').textContent = ''; $('cadNote').textContent = ''; $('cadProbe').textContent = ''; return; }
    if (cad.refused) { $('cadFit').textContent = cad.refused; return; }
    const m = cad.measure, pts = m ? (m.points.length / 3).toLocaleString('en-US') : 0;
    const where = m && m.display === 'triangles' ? `at triangle centroids${m.sampled ? ` (every ${(m.sampled.of / (m.points.length / 3)).toFixed(1)}th of ${m.sampled.of.toLocaleString('en-US')} triangles)` : ''}` : m ? `at ${m.spacing.toFixed(3)} mm spacing` : '';
    if (cad.busy) $('cadFit').textContent = `${cad.file}: ${pts} points ${where}. Aligning…`;
    else if (!r) $('cadFit').textContent = `${cad.file}: ${pts} points ${where}.${cad.stale ? ` ${cad.stale}` : cad.reused ? ' A saved alignment for this file was found: Refine fit starts from it, Align searches anew.' : ' Press Align.'}`;
    else {
      const s = r.transform.s, scaled = Boolean(r.options.scale), limit = scaled && (s <= 0.5 + 1e-9 || s >= 1.5 - 1e-9);
      $('cadFit').textContent = `RMS of fit ${r.rms.toFixed(4)} mm over ${r.scanPoints.toLocaleString('en-US')} scan surface points${scaled ? ` · scale ${s.toFixed(4)} (shrinkage ${((1 - s) * 100).toFixed(2)} %)${limit ? ' AT THE FIT LIMIT (0.5 to 1.5): check the units and the pose' : ''}` : ' · rigid'}`;
      const st = r.stats, total = st.measured + st.unmeasured, unmeasured = (100 * st.unmeasured) / total;
      const rows = [['Points measured', `${st.measured.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`], ['Not measured (no surface found)', `${unmeasured.toFixed(1)} %`], ['On sharp edges (skipped)', st.on_edge.toLocaleString('en-US')],
        ['Mean ± SD', `${mm(st.mean)} ± ${st.sd === null ? 'n/a' : st.sd.toFixed(3)} mm`], ['Median', `${mm(st.p50)} mm`], ['5th to 95th percentile', `${mm(st.p05)} to ${mm(st.p95)} mm`],
        ['Min / max', `${mm(st.min)} / ${mm(st.max)} mm`], [`Within ±${cad.toleranceMm} mm`, `${st.within_percent === null ? 'n/a' : st.within_percent.toFixed(1)} %`]];
      for (const [k, v] of rows) {
        const a = document.createElement('span'); a.className = 'k'; a.textContent = k;
        const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
        $('cadStats').append(a, b);
      }
      if (unmeasured > MAX_UNMEASURED_PERCENT) { $('cadWarn').hidden = false; $('cadWarn').textContent = `${unmeasured.toFixed(0)} % of points found no scanned surface within ±${cad.rangeMm} mm: check the alignment, the units, or whether the scan covers the whole part.`; }
      drawHistogram(cad);
    }
    $('cadNote').textContent = r
      ? `Scanned surface: gray ${r.level.toFixed(0)}, halfway between air (${r.airGray.toFixed(0)}) and matrix (${r.matrixGray.toFixed(0)}), on ${CT.gridText(state.binFactor * App.BIN)}. Colors: blue = material missing, red = extra, clipped at ±${(3 * cad.toleranceMm).toFixed(2)} mm; gray = not measured: no scanned surface within ±${cad.rangeMm} mm along the normal that faces within 60° of it, or a point on a sharp CAD edge, where a deviation along one face's normal is not defined (the scanned edge is rounded over about one analysis voxel). Pore walls inside the part are not its surface: a crossing counts only into air joined to the outside. Statistics are weighted by surface area. Alignment: ${r.options.scale ? 'rigid, then one uniform scale (0.5 to 1.5)' : 'rigid'}, trimmed ICP. Click the CAD model in the 3D view to read a point.`
      : '';
  }

  function saveResult() {
    const cad = state.cad;
    if (!cad || !cad.result || !state.folder) return;
    const summary = D.cadSummary(cad.result, { file: cad.file, unitMm: cad.unitMm, spacingMm: cad.measure.spacing, points: cad.measure.points.length / 3 });
    App.saveSample({ cad: summary });
  }

  async function exportCsv() {
    const cad = state.cad;
    const summary = D.cadSummary(cad.result, { file: cad.file, unitMm: cad.unitMm, spacingMm: cad.measure.spacing, points: cad.measure.points.length / 3 });
    const csv = window.CTExport.cadCsv({ points: cad.measure.points, normals: cad.measure.normals, deviations: cad.result.deviations, edge: cad.measure.edge },
      { sample: CT.sampleInfo(state.folder, state.samples), summary, provenance: App.provenance() });
    const name = `${state.folder}_cad_deviation.csv`;
    const how = await window.VBStore.saveBlob(state.downloads, name, new Blob([csv], { type: 'text/csv' }));
    $('cadExportNote').textContent = how === 'declined' ? 'Save canceled.' : how === 'link' ? `Downloaded ${name}.` : `Saved ${name}.`;
  }

  on('start', () => {
    $('cadExport').addEventListener('click', exportCsv);
    $('cadOpen').addEventListener('click', () => $('cadFile').click());
    $('cadFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) openStl(f.name, await f.arrayBuffer());
    });
    $('cadUnit').addEventListener('change', () => { if (!state.cad || !state.cad.mesh) return; state.cad.unitMm = Number($('cadUnit').value); state.cad.pose = null; state.cad.reused = false; measure(state.cad); emit('cadChanged'); });
    $('cadTol').addEventListener('change', () => {
      if (!state.cad) return;
      state.cad.toleranceMm = Number($('cadTol').value) || 0.1;
      if (state.cad.result) state.cad.result.stats = D.deviationStats(state.cad.result.deviations, state.cad.toleranceMm, state.cad.measure.edge, state.cad.measure.weight);
      emit('cadChanged');
    });
    $('cadScale').addEventListener('change', () => { if (state.cad) state.cad.scale = $('cadScale').checked; });
    $('cadAlign').addEventListener('click', () => App.requestCad(null));
    $('cadRefine').addEventListener('click', () => App.requestCad(state.cad.result ? state.cad.result.transform : state.cad.pose));
    for (const axis of ['x', 'y', 'z']) $(`cadRot${axis.toUpperCase()}`).addEventListener('click', () => rotate(axis));
  });
  on('loaded', () => {
    state.cad = null;
    if (state.cadDemo) {
      const demo = state.cadDemo;
      state.cadDemo = null;
      $('cadScale').checked = true;
      openStl(demo.name, demo.buffer);
      $('step6').open = true;
    }
    render();
  });
  on('cadChanged', () => { render(); if (state.cad && state.cad.result && !state.cad.busy) saveResult(); });
  on('cadProbe', ({ vertex }) => {
    const cad = state.cad;
    if (!cad || !cad.measure) return;
    const p = A.apply((cad.result && cad.result.transform) || cad.pose || A.IDENTITY, cad.measure.points.subarray(3 * vertex, 3 * vertex + 3));
    const d = cad.result ? cad.result.deviations[vertex] : NaN;
    $('cadProbe').textContent = `At (${[...p].map((v) => v.toFixed(2)).join(', ')}) mm: ${cad.result ? (Number.isFinite(d) ? `${mm(d)} mm` : 'not measured') : 'run Align first'}`;
  });
  for (const e of ['recordsChanged', 'modelChanged']) on(e, render);
}(window.CTApp));
