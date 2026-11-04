/* Page 3 (supporting data) and the PDF: gather the sheet data from the worker, render, and offer the file. */
(function (App) {
  'use strict';
  const P = window.CTPores, D = window.CTSheetData, G = window.CTPlot;
  const { state, $ } = App;
  const K = () => App.CTSheet, PG = () => App.CTSheetPages;
  const f2 = (v) => v.toFixed(2);

  function pageThree(sheet, summary, sample, page) {
    const S = K(), { canvas, ctx } = S.newPage();
    S.header(ctx, sample, page);
    const x0 = S.MARGIN + 0.62, gap = 0.85, full = S.CONTENT_W - 0.67, hw = (full - gap) / 2;
    let y = 0.85;
    S.heading(ctx, S.MARGIN, y, 'Pore size distribution');
    const d = D.sizeDistribution(state.pores, state.rejected);
    const vol = d.volume_mm3.reduce((a, b) => a + b, 0);
    const limit = 3 * state.voxelMm;
    [[d.count, 'Pore count', 'a'], [d.volume_mm3.map((v) => (100 * v) / vol), 'Fraction of pore volume (%)', 'b']].forEach(([values, label, l], i) => {
      const ax = G.axes(ctx, { x: x0 + i * (hw + gap), y: y + 0.3, w: hw, h: 1.35 }, { xlim: [0.06, 13], ylim: [0, Math.max(...values) * 1.16], xlog: true });
      G.bars(ax, d.edges_mm, values, '#d9730d');
      G.vline(ax, limit, { dash: [4, 2.5], width: 1.2 });
      G.frame(ax, { xlabel: 'Equivalent spherical diameter (mm)', ylabel: label, letter: l });
      if (i === 0) G.legend(ctx, [{ label: `3 voxels (${f2(limit)} mm)`, kind: 'dash', color: '#000' }], { x: ax.box.x + ax.box.w * 0.3, y: ax.box.y + 0.06 }, { size: 7.5 });
    });
    S.caption(ctx, S.MARGIN, y + 2.08, `(a) Pore count per bin of equivalent spherical diameter, ESD = (6V/π)^(1/3), logarithmic bins. (b) Pore volume per bin as a fraction of total pore volume. Dashed line: ESD of 3 voxels (${f2(limit)} mm); pores below it are at the noise limit.`);
    y += 2.65;
    S.heading(ctx, S.MARGIN, y, 'Threshold sensitivity');
    const base = { value: state.settings.poreThreshold, all_void_percent: summary.all_void_percent_of_body };
    const pts = [base, ...sheet.sweep.filter((s) => s.parameter === 'poreThreshold')].sort((a, b) => a.value - b.value);
    const a1 = G.axes(ctx, { x: x0, y: y + 0.6, w: hw, h: 1.3 }, { xlim: [pts[0].value - 30, pts[pts.length - 1].value + 30], ylim: [0, Math.max(...pts.map((p) => p.all_void_percent)) * 1.05] });
    G.line(a1, pts.map((p) => p.value), pts.map((p) => p.all_void_percent), { color: '#c81e1e', width: 1.8 });
    G.markers(a1, pts.map((p) => p.value), pts.map((p) => p.all_void_percent), { color: '#c81e1e' });
    G.markers(a1, [base.value], [base.all_void_percent], { color: '#000', r: 5.5, hollow: true });
    G.frame(a1, { xlabel: 'Pore threshold (gray value)', ylabel: 'Total porosity (%)', letter: 'a', letterAt: 'br' });
    G.legend(ctx, [{ label: 'Saved threshold', kind: 'ring', color: '#000' }], { x: a1.box.x + a1.box.w / 2, y: y + 0.28, align: 'center' }, { size: 7.5 });
    const h = sheet.histogram;
    if (h) {
      const centers = h.volume_mm3.map((_, k) => 100 * (h.low + (k + 0.5) * h.step)), v = h.volume_mm3.map((x) => x / 1000);
      // Zones may never have run, or been refused: then there is no saved threshold to draw.
      const th = state.zones && state.zones.threshold != null ? 100 * state.zones.threshold : null;
      const a2 = G.axes(ctx, { x: x0 + hw + gap, y: y + 0.6, w: hw, h: 1.3 }, { xlim: [-30, 30], ylim: [0, Math.max(...v) * 1.08] });
      G.step(a2, centers, v, 100 * h.step, { fills: [...(th !== null ? [{ keep: (x) => x >= th, color: '#ff8ad8', alpha: 0.55 }] : []), { keep: (x) => x <= -8, color: '#6e8cff', alpha: 0.45 }] });
      if (th !== null) G.vline(a2, th);
      if (sheet.automaticThreshold != null) G.vline(a2, 100 * sheet.automaticThreshold, { dash: [4, 2.5] });
      G.vline(a2, -8, { dash: [1.2, 2] });
      G.frame(a2, { xlabel: 'Gray offset from end baseline (%)', ylabel: 'Volume per 1 % bin (cm³)', letter: 'b', letterAt: 'tl', xticks: [-30, -20, -10, 0, 10, 20, 30] });
      G.legend(ctx, [...(th !== null ? [{ label: 'Saved threshold', kind: 'line', color: '#000' }] : []), { label: 'Histogram minimum', kind: 'dash', color: '#000' }, { label: 'Low-gray cutoff', kind: 'dot', color: '#000' }], { x: a2.box.x + a2.box.w / 2, y: y + 0.28, align: 'center' }, { size: 7 });
    }
    const mid = sheet.sweep.find((s) => s.parameter === 'poreThreshold' && s.value === sheet.midpoint);
    const all = [base.all_void_percent, ...sheet.sweep.map((s) => s.all_void_percent)];
    const span = (p) => { const vals = [state.settings[p], ...sheet.sweep.filter((s) => s.parameter === p).map((s) => s.value)]; return `${Math.min(...vals)} to ${Math.max(...vals)}`; };
    S.caption(ctx, S.MARGIN, y + 2.42, `(a) Total porosity against pore threshold, other parameters at saved values; circle: saved threshold (${state.settings.poreThreshold}), ${f2(base.all_void_percent)} %.${mid ? ` At the air-matrix midpoint (${Math.round(sheet.airGray)} and ${Math.round(sheet.solidGray)}; threshold ${sheet.midpoint}, ISO 50): ${f2(mid.all_void_percent)} %.` : ''} Over the sweep (pore threshold ${span('poreThreshold')}, mask threshold ${span('bodyThreshold')}; smoothing not swept in the app): ${Math.min(...all).toFixed(1)} to ${Math.max(...all).toFixed(1)} %.${h ? ` (b) Distribution of gray offset over the sample volume at least 1 mm below the surface, ${f2(sheet.coarseVoxelMm)} mm grid; gray offset is the local matrix gray relative to ${window.CTZones.baselineText(state.zones && state.zones.method, state.zones && state.zones.axis)}. ${state.zones && state.zones.threshold != null ? 'Shaded pink: high-gray zone, above the saved threshold' : 'Zones were not segmented, so no threshold is drawn'}; dashed: histogram minimum; shaded blue: low-gray zone, below −8 %.` : ''}`);
    y += 3.3;
    S.heading(ctx, S.MARGIN, y, 'Dimensions');
    const e = sheet.extents;
    S.table(ctx, S.MARGIN, y + 0.24, 3.45, ['Axis', 'Length (mm)', 'Boundary'], ['x', 'y', 'z'].map((a) => [`Scan ${a}`, e[a].mm.toFixed(1), e[a].cut ? 'Truncated by FOV' : 'Mask boundary']), [0.2, 0.26, 0.54]);
    const crops = App.cropsOf(state.folder);
    S.caption(ctx, S.MARGIN, y + 1.27, `Principal axes: ${e.principal_mm.map((v) => v.toFixed(1)).join(' × ')} mm.${crops.some((c) => c.plane !== 'XY') ? ' One z face is the crop boundary at the holder.' : ''}`, 3.45);
    const x = S.MARGIN + 3.7;
    S.heading(ctx, x, y, 'Methods');
    const st = state.settings;
    [`Voxel ${(1000 * state.voxelMm).toFixed(2)} µm (${state.binFactor > 1 ? `${state.binFactor}× the TIFF tag, binned` : 'TIFF tag'}). Acquisition parameters not recorded.`, (() => { const c = App.calibration(); return c && c.ok ? `Equivalent density: ${c.intercept.toFixed(4)} + ${c.slope.toExponential(3)} × gray, ${c.n} points${c.r2 === null ? '' : `, R² ${c.r2.toFixed(3)}`}; not true density for doped or filled material.` : 'Gray values uncalibrated; no reference phantoms.'; })(),
      `Sample mask: gray > ${st.bodyThreshold}; crop: ${crops.map((c) => `${c.plane} polygon`).join(', ') || 'none'}.`, `Pores: gray < ${st.poreThreshold}, σ = ${st.fineSigma} voxel, min. ${st.minVolumeMm3} mm³.`,
      `AR > ${st.maxElongation} classed as elongated. Rejected on review: ${state.rejected.size}.`, '*Gray < 0.8 of matrix (air = 0); not porosity.', `Generated in VoxelBench ${window.VB_VERSION}.`]
      .forEach((l, k) => G.text(ctx, x, y + 0.42 + k * 0.17, l, { size: 8, weight: 'normal' }));
    return canvas;
  }

  async function exportSheet() {
    const say = (t) => { $('exportStatus').textContent = t; };
    if (!state.pores || !state.patches) { say('Run pore segmentation first.'); return; }
    if (!window.jspdf) { say('The PDF library did not load.'); return; }
    say('Review sheet: computing sheet data and threshold sweep (several minutes).');
    // The sweep is the slow part; reuse it while the segmentation, rejections and zone threshold are unchanged.
    const key = JSON.stringify([state.settings, [...state.rejected].sort(), state.zoneThreshold]);
    let sheet = state.sheetCache && state.sheetCache.pores === state.pores && state.sheetCache.key === key ? state.sheetCache.data : null;
    if (!sheet) {
      const follow = (t) => { if (t.startsWith('Review sheet')) say(`${t}.`); };
      App.on('statusText', follow);
      try {
        sheet = await App.requestSheet();
      } catch (e) {
        say(`Review sheet: ${e.message}`);
        return;
      } finally {
        App.off('statusText', follow);
      }
      state.sheetCache = { pores: state.pores, key, data: sheet };
    }
    say('Review sheet: rendering 3D views.');
    await new Promise((r) => setTimeout(r, 30));
    const renders = App.sheetRenders(sheet);
    const rainbow = state.view === 'rainbow';
    const summary = P.summarize(state.pores, state.bodyMm3, state.rejected);
    say('Review sheet: drawing pages.');
    await new Promise((r) => setTimeout(r, 30));
    // The Findings follow page 1; how many pages they take sets the numbers of the pages after them.
    const laid = App.CTSheetFindings.lay();
    const at = window.VBFindings.sheetPages(laid.length, rainbow);
    const sample = { ...PG().sampleText(), pages: at.total, slicesPage: at.slices };
    const pages = [PG().pageOne(sheet, renders, summary, sample), ...App.CTSheetFindings.draw(laid, sample, at.findings),
      PG().pageTwo(sheet, sample, at.slices), pageThree(sheet, summary, sample, at.data)];
    if (rainbow) pages.push(PG().pageRainbow(sheet, sample, at.rainbow));
    state.lastSheetPages = pages;
    const pdf = new window.jspdf.jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait', compress: true });
    pages.forEach((c, k) => {
      if (k) pdf.addPage('letter', 'portrait');
      pdf.addImage(c.toDataURL('image/png'), 'PNG', 0, 0, 8.5, 11, undefined, 'FAST');
    });
    const blob = pdf.output('blob');
    state.lastSheet = blob;
    const name = `${state.folder}_review_sheet.pdf`;
    try {
      const how = await window.VBStore.saveBlob(state.downloads, name, blob);
      say(how === 'declined' ? 'Save canceled.' : how === 'link' ? `Downloaded ${name} to the browser's download folder.` : `Saved ${name}.`);
    } catch (e) {
      say(`Could not save: ${e.message}`);
    }
  }

  App.exportSheet = exportSheet;
  App.CTSheetPages.pageThree = pageThree;
}(window.CTApp));
