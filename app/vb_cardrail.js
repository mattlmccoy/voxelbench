/* The result card over the main view: what a drawn mark measured, shown as soon as it is saved and again when its row
   is picked in the region table or the annotation list. It follows the numbers as pores, the calibration or the
   records change, and closes when its mark is deleted. Numbers and insights come from VBFeedback. */
(function (App) {
  'use strict';
  const CT = window.CT, P = window.CTPores, R = window.CTRegions, F = window.VBFeedback;
  const { state, $, on, emit } = App;
  const AXIS = { XY: 'z', XZ: 'y', YZ: 'x' };
  let shown = null; // { collection, id, fresh }

  const recordOf = ({ collection, id }) => (collection === 'regions' ? App.regionsOf(state.folder) : App.annotationsOf(state.folder)).find((r) => r.id === id) || null;

  /** The whole part's numbers the card compares against; null where not known yet. */
  function partNow() {
    const porosity = state.pores ? P.summarize(state.pores, state.bodyMm3, state.rejected).all_void_percent_of_body : null;
    return { porosityPercent: porosity, matrixGray: state.solidGray ?? null, airGray: state.airGray ?? null };
  }

  function regionContent(r) {
    const def = R.labelOf(r.label, App.regionLabels());
    const card = F.regionCard({ title: `${def.label}${r.note ? `: ${r.note}` : ''}`, stats: App.statsOf(r), part: partNow(), fit: App.calibration(), relative: App.relative() });
    return { ...card, sub: `Region, ${r.plane} ${AXIS[r.plane]} ${r.slice_from}–${r.slice_to}`, step: 'step3', where: r.points.length ? CT.voxelOf(r.plane, Math.round((r.slice_from + r.slice_to) / 2), Math.round(r.points[0].col), Math.round(r.points[0].row)) : null };
  }

  function annotationContent(a) {
    const type = CT.FEATURE_TYPES.find((t) => t.id === a.type);
    const kindWord = { point: 'Point', caliper: 'Measurement', polygon: 'Outline' }[a.kind];
    const title = `${kindWord}: ${type ? type.label : a.type}${a.note ? `, ${a.note}` : ''}`;
    let sliceStats = null, point = null, check = null;
    if (a.kind === 'caliper') check = CT.dimensionCheck(a.length_mm, a.nominal_mm, a.tol_minus_mm ?? 0, a.tol_plus_mm ?? 0);
    if (a.kind === 'polygon') {
      const points = a.voxels.map((v) => CT.planeOf(a.plane, v));
      sliceStats = App.statsOf({ id: `slice:${a.id}`, plane: a.plane, points, slice_from: a.slice, slice_to: a.slice });
    } else if (a.kind === 'point') {
      const v = a.voxels[0];
      const id = state.runs ? P.poreIdAt(state.runs, state.dims, v.x, v.y, v.z) : 0;
      point = { gray: state.slices[v.z][v.y * state.dims.nx + v.x], pore: id && state.byId ? state.byId.get(id) || null : null };
    }
    const kind = { point: `${a.plane} ${AXIS[a.plane]} ${a.slice}`, caliper: `${a.plane} ${AXIS[a.plane]} ${a.slice}`, polygon: `On one slice, ${a.plane} ${AXIS[a.plane]} ${a.slice}` }[a.kind];
    return { ...F.annotationCard({ annotation: a, title, sliceStats, point, check, part: partNow(), fit: App.calibration() }), sub: kind, step: 'step4', where: a.voxels[0] };
  }

  function render() {
    const card = $('resultCard');
    const record = shown && state.folder && state.slices ? recordOf(shown) : null;
    if (!record) { card.hidden = true; shown = null; return; }
    const c = shown.collection === 'regions' ? regionContent(record) : annotationContent(record);
    $('rcTitle').textContent = c.title;
    $('rcSub').textContent = `${shown.fresh ? 'Saved · ' : ''}${c.sub}`;
    const rows = $('rcRows');
    rows.textContent = '';
    for (const [k, v] of c.rows) {
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
      rows.append(a, b);
    }
    const list = $('rcInsights');
    list.textContent = '';
    for (const t of c.insights) { const li = document.createElement('li'); li.textContent = t; list.append(li); }
    $('rcStep').textContent = c.step === 'step3' ? 'Open in the region table' : 'Open in the annotation list';
    $('rcStep').dataset.step = c.step;
    card.dataset.where = c.where ? JSON.stringify(c.where) : '';
    card.hidden = false;
  }

  function show(which) {
    shown = which;
    render();
    const card = $('resultCard');
    card.classList.remove('arrive'); void card.offsetWidth; card.classList.add('arrive'); // replay the arrival cue
  }

  on('start', () => {
    $('rcClose').addEventListener('click', () => { shown = null; render(); });
    $('rcJump').addEventListener('click', () => { const w = $('resultCard').dataset.where; if (w) emit('jump', JSON.parse(w)); });
    $('rcStep').addEventListener('click', () => { const b = document.querySelector(`.stepbar [data-section="${$('rcStep').dataset.step}"]`); if (b) b.click(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && shown && !state.draft) { shown = null; render(); } });
  });
  on('markSaved', (which) => show({ ...which, fresh: true }));
  on('pickAt', (place) => {
    if (!state.folder) return;
    const regions = App.regionsOf(state.folder).filter((r) => !R.isReference(r.label));
    const mark = F.markAt(place, { regions, annotations: App.annotationsOf(state.folder) });
    if (mark) show({ ...mark, fresh: false });
  });
  on('showCard', (which) => show({ ...which, fresh: false }));
  on('loaded', () => { shown = null; render(); });
  for (const e of ['recordsChanged', 'poresChanged', 'modelChanged']) on(e, () => { if (shown) render(); });
}(window.CTApp));
