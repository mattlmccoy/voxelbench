/* The three review-sheet pages and the PDF. Numbers come from the current segmentation; figure notes state what each
   figure plots, in the same terms as ct_pipeline/sample_sheet.py. */
(function (App) {
  'use strict';
  const CT = window.CT, P = window.CTPores, D = window.CTSheetData, G = window.CTPlot;
  const { state } = App;
  const K = () => App.CTSheet;
  const f2 = (v) => v.toFixed(2), f1 = (v) => v.toFixed(1);
  const sign = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} %`;

  function sampleText() {
    const s = CT.sampleInfo(state.folder, state.samples);
    const { nx, ny, nz } = state.dims;
    return {
      title: s.name,
      subtitle: `${s.material || 'Material not recorded'}; ${s.process || 'process not recorded'}.${s.notes ? ` ${s.notes}` : ''}`,
      scanLine: `X-ray CT, ${nx} × ${ny} × ${nz} voxels. ${App.provenance()}. Sheet made ${new Date().toISOString().slice(0, 10)}.`,
    };
  }

  function voidTable(summary) {
    const s = summary;
    return [['Pores, AR ≤ 2.5', s.pore_count.toLocaleString('en-US'), f1(s.pore_volume_mm3), f2((100 * s.pore_volume_mm3) / s.body_volume_mm3)],
      ['Pores, AR > 2.5', s.crack_like_count.toLocaleString('en-US'), f1(s.crack_like_volume_mm3), f2((100 * s.crack_like_volume_mm3) / s.body_volume_mm3)],
      ['Pores at FOV edge', String(s.clipped_count), f1(s.clipped_volume_mm3), f2((100 * s.clipped_volume_mm3) / s.body_volume_mm3)],
      ['Total', (s.pore_count + s.crack_like_count + s.clipped_count).toLocaleString('en-US'), f1(s.all_void_volume_mm3), f2(s.all_void_percent_of_body)],
      ['Low-density regions*', String(state.patches.length), f1(state.patches.reduce((t, p) => t + p.volume_mm3, 0)), 'n/a']];
  }

  function pageOne(sheet, renders, summary, sample) {
    const S = K(), { canvas, ctx } = S.newPage();
    S.header(ctx, sample, 1);
    const gap = 0.1, w = (S.CONTENT_W - gap) / 2, c = state.cursor, v = state.voxelMm;
    S.heading(ctx, S.MARGIN, 1.3, '3D reconstruction');
    [renders.solid, renders.pores].forEach((img, i) => {
      const box = { x: S.MARGIN + i * (w + gap), y: 1.55, w, h: 1.95 };
      S.placeImage(ctx, S.trimmed(img), box, { align: i ? 'left' : 'center' });
      S.letter(ctx, box.x, box.y, 'ab'[i]);
    });
    const kept = state.pores.filter((p) => !state.rejected.has(p.id));
    const bins = D.sizeBins(state.pores, state.rejected, sheet.surfaceEdgesMm);
    const items = [['< 0.5 mm', 0], ['0.5 to 1 mm', 1], ['1 to 2 mm', 2]].map(([label, k]) => ({ label, kind: 'circle', color: renders.markerColors[k], r: 1.6 + 0.7 * k }))
      .concat(bins.map((b, k) => ({ label: b.label, kind: 'patch', color: renders.sizeColors[k], alpha: 0.7 })));
    G.legend(ctx, items, { x: S.MARGIN + 2 * w + gap - 0.06, y: 1.55 + 1.95 - 0.06, align: 'right', valign: 'bottom' }, { size: 6.5, columns: 1, title: 'ESD' });
    const count = bins.reduce((t, b) => t + b.count, 0), share = bins.reduce((t, b) => t + b.volume_share, 0);
    S.caption(ctx, S.MARGIN, 3.58, `(a) Sample mask surface, 35 % opacity, with the section planes of page 2: XY at z = ${f2(c.z * v)} mm, XZ at y = ${f2(c.y * v)} mm. Arrows: scan axes, 8 mm. (b) Pores with ESD ≥ ${sheet.surfaceEdgesMm[0]} mm as surfaces: ${count.toLocaleString('en-US')} of ${kept.length.toLocaleString('en-US')} pores, ${Math.round(100 * share)} % of pore volume; 2 to 4 mm at 50 % opacity, ≥ 4 mm at 32 %. Pores below ${sheet.surfaceEdgesMm[0]} mm as centroid markers, colored by ESD bin. Sample shell at 15 % opacity with its silhouette outlined.`);

    S.heading(ctx, S.MARGIN, 4.2, 'Pore distribution, top view');
    const { nx, ny } = sheet.coarseDims, cv = sheet.coarseVoxelMm;
    const pw = 5.6, ph = (pw * ny) / nx, box = { x: S.MARGIN + 0.55, y: 4.5, w: pw, h: ph };
    ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(S.projectionImage(sheet), box.x, box.y, pw, ph); ctx.restore();
    const ax = G.axes(ctx, box, { xlim: [0, nx * cv], ylim: [ny * cv, 0] });
    ctx.save(); ctx.strokeStyle = S.PLANE_COLOR.XZ; ctx.lineWidth = 1.6 / 72; ctx.setLineDash([5 / 72, 3 / 72]);
    ctx.beginPath(); ctx.moveTo(box.x, ax.fy(c.y * v)); ctx.lineTo(box.x + pw, ax.fy(c.y * v)); ctx.stroke(); ctx.restore();
    G.frame(ax, { xlabel: 'Scan x (mm)', ylabel: 'Scan y (mm)', letter: 'c', letterAt: 'tl', xticks: D.niceTicks(0, nx * cv, 6), yticks: D.niceTicks(0, ny * cv, 6) });
    const cb = { x: box.x + pw + 0.15, y: box.y, w: 0.14, h: ph };
    for (let k = 0; k < 100; k++) { ctx.fillStyle = `rgb(${D.magmaR(1 - k / 99).join(',')})`; ctx.fillRect(cb.x, cb.y + (k * ph) / 100, cb.w, ph / 100 + 0.002); }
    ctx.save(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1 / 72; ctx.strokeRect(cb.x, cb.y, cb.w, cb.h); ctx.restore();
    for (const t of [0, 5, 10, 15, 20, 25]) G.text(ctx, cb.x + cb.w + 0.05, cb.y + ph - (t / 25) * ph, String(t), { size: 8.5, base: 'middle' });
    G.text(ctx, cb.x + cb.w + 0.38, cb.y + ph / 2, 'Column porosity (%)', { size: 9, align: 'center', rotate: -Math.PI / 2 });
    S.caption(ctx, S.MARGIN, box.y + ph + 0.48, `(c) Column porosity: total pore thickness divided by sample thickness along scan z at each (x, y), ${f2(cv)} mm grid. Columns thinner than ${sheet.minColumnMm} mm are blank. Dashed line: XZ section of page 2 (y = ${f2(c.y * v)} mm).`);

    const half = 3.3, y = box.y + ph + 1.05;
    S.heading(ctx, S.MARGIN, y, 'Porosity');
    S.table(ctx, S.MARGIN, y + 0.24, half, ['Class', 'Count', 'mm³', 'Porosity (%)'], voidTable(summary), [0.42, 0.2, 0.18, 0.2], { bold: [3] });
    S.caption(ctx, S.MARGIN, y + 1.75, `Porosity: pore volume / sample mask volume (${Math.round(summary.body_volume_mm3).toLocaleString('en-US')} mm³). AR: aspect ratio from second moments. FOV: field of view. *Gray below 0.8 of matrix (air = 0); excluded from porosity.`, half);
    const x = S.MARGIN + half + 0.2, z = state.zones;
    const rank = (v) => (v < 4 ? [2, 3, 1].indexOf(v) : v);
    const assigned = (id) => (!id || id === 'undecided' ? 'Unassigned' : window.CTRegions.labelOf(id, App.regionLabels()).label);
    if (z && z.stats) {
      S.heading(ctx, x, y, `Gray-value zones (threshold ${sign(100 * z.threshold)})`);
      const rows = [...z.stats].sort((a, b) => rank(a.zone) - rank(b.zone)).map((st) => [App.zoneTitle(st.zone), assigned(state.zoneLabels[st.zone]), f2(st.volume_mm3 / 1000), f1(st.void_percent), st.excess_median == null ? 'n/a' : sign(100 * st.excess_median)]);
      const end = S.table(ctx, x, y + 0.24, S.PAGE[0] - S.MARGIN - x, ['Zone', 'Assigned', 'cm³', 'Porosity (%)', 'Gray offset'], rows, [0.19, 0.27, 0.12, 0.22, 0.2]);
      S.caption(ctx, x, end + 0.1, `Gray offset: median gray relative to ${window.CTZones.baselineText(z.method, z.axis)}. Gray value reflects bulk attenuation, not composition. Assignments are by the operator.`, S.PAGE[0] - S.MARGIN - x);
    } else {
      S.heading(ctx, x, y, 'Gray-value zones');
      S.caption(ctx, x, y + 0.3, z && z.refused ? z.refused : 'Zones not segmented for this sheet.', S.PAGE[0] - S.MARGIN - x);
    }
    return canvas;
  }

  function pageTwo(sheet, sample) {
    const S = K(), { canvas, ctx } = S.newPage();
    S.header(ctx, sample, 2);
    S.heading(ctx, S.MARGIN, 0.75, 'Orthogonal slices: pore segmentation and gray-value zones');
    const items = [['Pores, AR ≤ 2.5', 1], ['Pores, AR > 2.5', 2], ['Pores at FOV edge', 3], ['Low-density regions', 4], ['High-gray zone', 5], ['Low-gray zone', 6]]
      .map(([label, k]) => ({ label, kind: 'patch', color: `rgb(${S.CLASS_RGB[k].join(',')})`, alpha: k > 4 ? 0.6 : 1 }));
    G.legend(ctx, items, { x: S.PAGE[0] / 2, y: 1.05, align: 'center' }, { size: 7.5 });
    const { nx, ny, nz } = state.dims, gap = 0.1, w = (S.CONTENT_W - gap) / 2, c = state.cursor, v = state.voxelMm;
    const hxy = (w * ny) / nx, hxz = (w * nz) / nx, top = 1.45;
    const panels = [['XY', c.z, 'seg', 'a', top, `XY, z = ${f2(c.z * v)} mm`], ['XY', c.z, 'zones', 'b', top, `XY, z = ${f2(c.z * v)} mm`],
      ['XZ', c.y, 'seg', 'c', top + hxy + 0.32, `XZ, y = ${f2(c.y * v)} mm`], ['XZ', c.y, 'zones', 'd', top + hxy + 0.32, `XZ, y = ${f2(c.y * v)} mm`]];
    panels.forEach(([plane, slice, mode, l, y, label], i) => {
      const box = { x: S.MARGIN + (i % 2) * (w + gap), y, w, h: plane === 'XY' ? hxy : hxz };
      ctx.save(); ctx.imageSmoothingEnabled = mode === 'zones';
      ctx.drawImage(S.sliceImage(plane, slice, mode), box.x, box.y, box.w, box.h); ctx.restore();
      ctx.save(); ctx.strokeStyle = S.PLANE_COLOR[plane]; ctx.lineWidth = 2.2 / 72; ctx.strokeRect(box.x, box.y, box.w, box.h); ctx.restore();
      S.letter(ctx, box.x, box.y, l);
      G.text(ctx, box.x + box.w / 2, box.y + box.h + 0.15, label, { size: 8, align: 'center' });
      if (i === 0) {
        const bar = (10 / v) * (box.w / nx);
        ctx.save(); ctx.fillStyle = '#fff'; ctx.fillRect(box.x + 0.15, box.y + box.h - 0.18, bar, 0.03); ctx.restore();
        G.text(ctx, box.x + 0.15 + bar / 2, box.y + box.h - 0.22, '10 mm', { size: 8, align: 'center', color: '#fff' });
      }
    });
    let y = top + hxy + hxz + 0.62;
    const th = state.zones && state.zones.threshold != null ? state.zones.threshold : null;
    y = S.caption(ctx, S.MARGIN, y, `(a), (c) Segmented pores and low-density regions at ${(1000 * v).toFixed(0)} µm. (b), (d) Gray-value zones on a ${f2(sheet.coarseVoxelMm)} mm grid${th == null ? '' : `: high-gray, median gray offset above ${sign(100 * th)} from the end baseline; low-gray, below −8 % with a core at least 0.5 mm below the surface`}. Gray window ${800} to ${2900}. Frame colors match the section planes on page 1.`) + 0.35;
    S.heading(ctx, S.MARGIN, y, 'Axial profile');
    const pr = sheet.profile, use = pr.count.map((n) => n > 200);
    const xs = pr.x.filter((_, k) => use[k]);
    const full = S.CONTENT_W - 0.67, x0 = S.MARGIN + 0.62, xlim = [-2, nx * v + 2];
    const a1 = G.axes(ctx, { x: x0, y: y + 0.3, w: full, h: 1.0 }, { xlim, ylim: [0, Math.max(...pr.porosity.filter((_, k) => use[k])) * 1.05] });
    G.line(a1, xs, pr.porosity.filter((_, k) => use[k]), { color: '#c81e1e' });
    G.frame(a1, { ylabel: 'Porosity (%)', letter: 'e', xticklabels: false });
    const a2 = G.axes(ctx, { x: x0, y: y + 1.38, w: full, h: 1.0 }, { xlim, ylim: [1500, 2300] });
    G.line(a2, xs, pr.gray.filter((_, k) => use[k]), { color: '#1b5fc1' });
    G.frame(a2, { xlabel: 'Scan x (mm)', ylabel: 'Matrix gray value\n(uncalibrated)', letter: 'f' });
    S.caption(ctx, S.MARGIN, y + 2.82, `(e) Porosity per ${f2(sheet.coarseVoxelMm)} mm slab normal to scan x: pore volume / sample mask volume in the slab. (f) Mean matrix gray value per slab, pores and pore edges excluded. Values fall at both ends where slabs hold mostly sample surface.`);
    return canvas;
  }

  // Added when the rainbow view is on at export: the page 2 slices under turbo, classes as outlines.
  function pageRainbow(sheet, sample, page) {
    const S = K(), { canvas, ctx } = S.newPage();
    S.header(ctx, sample, page);
    S.heading(ctx, S.MARGIN, 0.75, 'Orthogonal slices: gray value on the turbo color map');
    const items = [['Pores, AR ≤ 2.5', 1], ['Pores, AR > 2.5', 2], ['Pores at FOV edge', 3], ['Low-density regions', 4], ['High-gray zone', 5], ['Low-gray zone', 6]]
      .map(([label, k]) => ({ label, kind: 'outline', fill: 'rgb(251,129,34)', color: `rgb(${S.RAINBOW_RGB[k].join(',')})` }));
    G.legend(ctx, items, { x: S.PAGE[0] / 2, y: 1.05, align: 'center' }, { size: 7.5, title: 'Outlines' });
    const { nx, ny, nz } = state.dims, gap = 0.1, w = (S.CONTENT_W - gap) / 2, c = state.cursor, v = state.voxelMm;
    const hxy = (w * ny) / nx, hxz = (w * nz) / nx, top = 1.6;
    const panels = [['XY', c.z, 'seg', 'a', top, `XY, z = ${f2(c.z * v)} mm`], ['XY', c.z, 'zones', 'b', top, `XY, z = ${f2(c.z * v)} mm`],
      ['XZ', c.y, 'seg', 'c', top + hxy + 0.32, `XZ, y = ${f2(c.y * v)} mm`], ['XZ', c.y, 'zones', 'd', top + hxy + 0.32, `XZ, y = ${f2(c.y * v)} mm`]];
    panels.forEach(([plane, slice, mode, l, y, label], i) => {
      const box = { x: S.MARGIN + (i % 2) * (w + gap), y, w, h: plane === 'XY' ? hxy : hxz };
      ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(S.sliceImage(plane, slice, mode, true), box.x, box.y, box.w, box.h); ctx.restore();
      ctx.save(); ctx.strokeStyle = S.PLANE_COLOR[plane]; ctx.lineWidth = 2.2 / 72; ctx.strokeRect(box.x, box.y, box.w, box.h); ctx.restore();
      S.letter(ctx, box.x, box.y, l);
      G.text(ctx, box.x + box.w / 2, box.y + box.h + 0.15, label, { size: 8, align: 'center' });
      if (i === 0) {
        const bar = (10 / v) * (box.w / nx);
        ctx.save(); ctx.fillStyle = '#fff'; ctx.fillRect(box.x + 0.15, box.y + box.h - 0.18, bar, 0.03); ctx.restore();
        G.text(ctx, box.x + 0.15 + bar / 2, box.y + box.h - 0.22, '10 mm', { size: 8, align: 'center', color: '#fff' });
      }
    });
    let y = top + hxy + hxz + 0.62;
    // Color bar: turbo across the window; gray below the window low shows black.
    const bw = 3.2, bx = (S.PAGE[0] - bw) / 2;
    for (let i = 0; i < 256; i++) { const [r, g, b] = window.CTDisplay.turbo(i / 255); ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(bx + (i * bw) / 256, y, bw / 256 + 0.002, 0.14); }
    ctx.save(); ctx.strokeStyle = '#000'; ctx.lineWidth = 0.6 / 72; ctx.strokeRect(bx, y, bw, 0.14); ctx.restore();
    ctx.fillStyle = '#000'; ctx.fillRect(bx - 0.62, y, 0.22, 0.14);
    G.text(ctx, bx - 0.51, y + 0.3, `< ${state.window.low}`, { size: 7.5, weight: 'normal', align: 'center' });
    [0, 0.25, 0.5, 0.75, 1].forEach((t) => G.text(ctx, bx + t * bw, y + 0.3, String(Math.round(state.window.low + t * (state.window.high - state.window.low))), { size: 7.5, weight: 'normal', align: 'center' }));
    G.text(ctx, S.PAGE[0] / 2, y + 0.5, 'Gray value (uncalibrated)', { size: 8, align: 'center' });
    y += 0.75;
    S.caption(ctx, S.MARGIN, y, `Same sections as page 2. Gray value on the turbo color map, window ${state.window.low} to ${state.window.high}; gray below ${state.window.low} (air) is black. Each section is smoothed in-plane with a Gaussian, σ = ${window.CTDisplay.SMOOTH_SIGMA} voxels (${(1000 * window.CTDisplay.SMOOTH_SIGMA * v).toFixed(0)} µm), for display only; segmentation and every reported value use the unsmoothed data and the pore settings. (a), (c) Outlines of segmented pores and low-density regions. (b), (d) Outlines of gray-value zones on a ${f2(sheet.coarseVoxelMm)} mm grid.`);
    return canvas;
  }

  App.CTSheetPages = { pageOne, pageTwo, pageRainbow, sampleText, voidTable };
}(window.CTApp));
