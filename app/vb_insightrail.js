/* "What this shows" under each step's numbers: the step's result read in words (VBFindings.stepInsights), refreshed whenever that
   result changes and hidden while the step has none. */
(function (App) {
  'use strict';
  const FD = window.VBFindings;
  const { state, $, on } = App;

  function put(id, lines) {
    const box = $(id), list = box.querySelector('ul');
    list.textContent = '';
    box.hidden = !lines || !lines.length;
    for (const t of lines || []) { const li = document.createElement('li'); li.textContent = t; list.append(li); }
  }

  // The same lists go on the review sheet's Findings page (VBFindings.stepInsights).
  const BOX = { pores: 'poreInsights', zones: 'zoneInsights', cad: 'cadInsights', filler: 'fillerInsights', wall: 'wallInsights' };
  function all() {
    const s = FD.stepInsights({ pores: state.pores, rejected: state.rejected, bodyMm3: state.bodyMm3, voxelMm: state.voxelMm, connectivity: state.connectivity, zones: state.zones, cad: state.cad, filler: state.filler, wall: state.wall });
    for (const [k, id] of Object.entries(BOX)) put(id, s[k]);
  }
  for (const e of ['loaded', 'poresChanged', 'cadChanged', 'fillerChanged', 'wallChanged']) on(e, all);
}(window.CTApp));
