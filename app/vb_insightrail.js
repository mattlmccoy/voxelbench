/* "What this shows" under each step's numbers: the step's result read in words (VBInsights), refreshed whenever that
   result changes and hidden while the step has none. */
(function (App) {
  'use strict';
  const P = window.CTPores, I = window.VBInsights;
  const { state, $, on } = App;

  function put(id, lines) {
    const box = $(id), list = box.querySelector('ul');
    list.textContent = '';
    box.hidden = !lines || !lines.length;
    for (const t of lines || []) { const li = document.createElement('li'); li.textContent = t; list.append(li); }
  }

  function pores() {
    if (!state.pores) return put('poreInsights', null);
    const summary = P.summarize(state.pores, state.bodyMm3, state.rejected), k = state.connectivity;
    const split = k ? window.VBConnectivity.openClosed(state.pores, state.bodyMm3, state.rejected) : null;
    put('poreInsights', I.poreInsights({ pores: state.pores, rejected: state.rejected, summary, voxelMm: state.voxelMm, split, through: k ? k.through : null, shellShare: k && k.near_surface ? k.near_surface.body_share : null }));
  }

  function zones() {
    const z = state.zones;
    put('zoneInsights', z && z.map ? I.zoneInsights({ stats: z.stats }) : null);
  }

  function cad() {
    const c = state.cad, r = c && c.result;
    if (!r) return put('cadInsights', null);
    const total = r.stats.measured + r.stats.unmeasured;
    put('cadInsights', I.cadInsights({ stats: r.stats, toleranceMm: c.toleranceMm, shrinkagePercent: r.options.scale ? (1 - r.transform.s) * 100 : null, unmeasuredPercent: total ? (100 * r.stats.unmeasured) / total : 0 }));
  }

  function filler() {
    const r = state.filler && state.filler.result;
    put('fillerInsights', r ? I.fillerInsights({ summary: r.summary, dispersion: r.dispersion }) : null);
  }

  function wall() {
    const r = state.wall && state.wall.result;
    put('wallInsights', r ? I.wallInsights({ stats: r.stats, resolvedMinMm: r.resolved_min_mm, beyondStack: r.beyond_stack }) : null);
  }

  const all = () => { pores(); zones(); cad(); filler(); wall(); };
  on('loaded', all);
  on('poresChanged', () => { pores(); zones(); });
  on('cadChanged', cad);
  on('fillerChanged', filler);
  on('wallChanged', wall);
}(window.CTApp));
