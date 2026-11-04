/* Archimedes density, opt-in per sample: the measured and solid density and the method are kept on the sample record,
   and the pore step shows the Archimedes porosity beside the matching CT number with the CT envelope it depends on. */
(function (App) {
  'use strict';
  const CT = window.CT, P = window.CTPores, K = window.VBConnectivity;
  const { state, $, on } = App;
  const num = (id) => { const t = $(id).value.trim(); return t === '' ? null : Number(t); };

  /** The comparison for the open sample, or null without a measurement or segmentation. */
  function archimedesNow() {
    const arch = state.folder ? App.sampleNow().archimedes : null;
    if (!arch || !state.pores) return null;
    const total = P.summarize(state.pores, state.bodyMm3, state.rejected).all_void_percent_of_body;
    const closed = state.connectivity ? K.openClosed(state.pores, state.bodyMm3, state.rejected).closed_percent : null;
    const c = CT.archimedesComparison(arch, { total_percent: total, closed_percent: closed });
    return c && { ...c, density_g_cm3: arch.density_g_cm3, solid_g_cm3: arch.solid_g_cm3, envelope_closing_mm: 2 * state.settings.closeRadius * App.BIN * state.voxelMm };
  }

  function renderForm() {
    const arch = state.folder ? App.sampleNow().archimedes : null;
    $('archSave').disabled = !state.folder;
    if (document.activeElement !== $('archDensity')) $('archDensity').value = arch ? arch.density_g_cm3 : '';
    if (document.activeElement !== $('archSolid')) $('archSolid').value = arch ? arch.solid_g_cm3 : '';
    $('archMethod').value = arch ? arch.method : 'sealed';
  }

  function renderLine() {
    const c = archimedesNow(), line = $('archLine');
    line.hidden = !c;
    if (!c) return;
    if (c.refused) { line.textContent = `Archimedes: ${c.refused}`; return; }
    line.textContent = `Archimedes (${c.method}): ${c.porosity_percent.toFixed(2)} % · CT ${c.ct_label}: ${c.ct_percent === null ? 'n/a (segment pores for open/closed)' : `${c.ct_percent.toFixed(2)} % (difference ${c.difference >= 0 ? '+' : ''}${c.difference.toFixed(2)} points)`}. CT envelope: the sample mask closes surface openings up to about ${c.envelope_closing_mm.toFixed(1)} mm wide (Mask closing width).`;
  }

  function save() {
    const density = num('archDensity'), solid = num('archSolid');
    if (density === null && solid === null) { App.saveSample({ archimedes: null }); return; }
    if (!(density > 0) || !(solid > 0)) { $('archHint').textContent = 'Enter both densities in g/cm³ (numbers above 0), or clear both to remove the measurement.'; return; }
    App.saveSample({ archimedes: { density_g_cm3: density, solid_g_cm3: solid, method: $('archMethod').value, saved_at: new Date().toISOString() } });
  }

  on('start', () => $('archSave').addEventListener('click', save));
  for (const e of ['loaded', 'recordsChanged']) on(e, () => { renderForm(); renderLine(); });
  on('poresChanged', renderLine);
  App.archimedesNow = archimedesNow;
}(window.CTApp));
