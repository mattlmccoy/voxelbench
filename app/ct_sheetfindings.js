/* The review sheet's Findings pages, after page 1: each step's result in words, the saved regions, the Dragonfly
   comparison and the density calibration, then the steps not run. Content and layout come from VBFindings; this file
   gathers the page state and draws the text. */
(function (App) {
  'use strict';
  const FD = window.VBFindings, G = window.CTPlot, R = window.CTRegions;
  const { state } = App;
  const K = () => App.CTSheet;
  const AXIS = { XY: 'z', XZ: 'y', YZ: 'x' };
  const SIZE = 8.5, TOP = 1.45, BOTTOM = 10.4;
  const STYLE = { heading: { size: 10.5, weight: 'bold', color: '#1f2933' }, sub: { size: SIZE, weight: 'bold' }, key: { size: SIZE, weight: 'bold', color: '#333' },
    value: { size: SIZE, weight: 'normal' }, bullet: { size: SIZE, weight: 'normal' }, text: { size: SIZE, weight: 'normal' }, note: { size: SIZE, weight: 'normal', color: '#555' } };

  function content() {
    const steps = FD.stepInsights({ pores: state.pores, rejected: state.rejected, bodyMm3: state.bodyMm3, voxelMm: state.voxelMm, connectivity: state.connectivity, zones: state.zones, cad: state.cad, filler: state.filler, wall: state.wall });
    const regions = App.regionsOf(state.folder).filter((r) => r.label !== 'crop' && r.label !== 'phantom').map((r) => ({
      title: `${R.labelOf(r.label, App.regionLabels()).label}${r.note ? `: ${r.note}` : ''}`, sub: `${r.plane} ${AXIS[r.plane]} ${r.slice_from}–${r.slice_to}`, stats: App.statsOf(r) }));
    const porosity = window.CTPores.summarize(state.pores, state.bodyMm3, state.rejected).all_void_percent_of_body;
    const arch = App.sampleNow().archimedes;
    return FD.findings({ steps, regions, part: { porosityPercent: porosity, matrixGray: state.solidGray ?? null, airGray: state.airGray ?? null }, fit: App.calibration(),
      calibration: { solidGray: state.solidGray ?? null, porosityPercent: porosity, archimedesDensity: arch ? arch.density_g_cm3 : null }, crosscheck: state.crosscheck || null });
  }

  /** The Findings laid out into pages of text operations (measured with the sheet's font). */
  function lay() {
    const f = content(), S = K(), ctx = document.createElement('canvas').getContext('2d');
    const measure = (s, kind) => G.width(ctx, s, SIZE, kind === 'key' ? 'bold' : 'normal');
    return FD.layout(f.sections, f.notRun, { measure, width: S.CONTENT_W, top: TOP, bottom: BOTTOM, lineH: (SIZE * 1.4) / 72, headH: 0.27, gap: 0.16, keyW: 2.1, indent: 0.16 });
  }

  /** One canvas per laid-out page, numbered from `numbers`. */
  function draw(pages, sample, numbers) {
    const S = K();
    return pages.map((ops, k) => {
      const { canvas, ctx } = S.newPage();
      S.header(ctx, sample, numbers[k]);
      S.heading(ctx, S.MARGIN, 0.75, k ? 'Findings, continued' : 'Findings');
      if (!k) S.caption(ctx, S.MARGIN, 1.0, 'Each step\'s result in words, from the same segmentation and settings as the rest of this sheet. Steps with no result are listed at the end, so a missing section is not a clean result.');
      for (const o of ops) {
        const st = STYLE[o.kind], x = S.MARGIN + o.x;
        if (o.kind === 'heading') { S.heading(ctx, x, o.y, o.text); continue; }
        if (o.kind === 'bullet') G.text(ctx, x - 0.12, o.y + st.size / 72, '•', { size: st.size, weight: 'normal' });
        G.text(ctx, x, o.y + st.size / 72, o.text, st);
      }
      return canvas;
    });
  }

  App.CTSheetFindings = { lay, draw };
}(window.CTApp));
