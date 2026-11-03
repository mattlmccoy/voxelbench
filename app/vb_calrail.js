/* Step 5 of the rail: density calibration. Phantoms are regions with the built-in phantom label; the fit is made
   live from them (App.calibration) and applied wherever the page reports gray. */
(function (App) {
  'use strict';
  const CT = window.CT, R = window.CTRegions, Cal = window.VBCalibration;
  const { state, $, on, emit } = App;

  /** A density cell: three decimals, '*' when extrapolated, empty text when there is no calibration. */
  function densityText(fit, gray) {
    const d = Cal.applyCalibration(fit, gray);
    return d ? `${d.value.toFixed(3)}${d.extrapolated ? '*' : ''}` : '';
  }

  function startPhantom() {
    const name = $('phantomName').value.trim(), density = Number($('phantomDensity').value);
    if (!name || !(density > 0)) { $('calNote').textContent = 'Enter the phantom name and its measured density (g/cm³) first.'; return; }
    state.phantomDraft = { name, density_g_cm3: density };
    $('calNote').textContent = `Outline ${name} on a slice where it is solid, set its slice range, then Save.`;
    emit('startDrawing', 'phantom');
  }

  function setAir(include) {
    if (!state.folder) return;
    App.saveSample({ calibration_air: include });
  }

  function render() {
    $('drawPhantom').disabled = !state.folder;
    if (state.tool !== 'freehand' && $('calNote').textContent.startsWith('Outline')) $('calNote').textContent = ''; // drawing finished
    const fit = App.calibration();
    const air = state.folder ? CT.sampleInfo(state.folder, state.samples).calibration_air : true;
    $('calAir').checked = air;
    $('calTag').textContent = fit && fit.ok ? `calibrated, ${fit.n} points` : 'optional';
    const table = $('calTable');
    table.textContent = '';
    $('calWrap').hidden = !fit;
    if (!fit) { $('calFit').textContent = 'Uncalibrated: no phantoms outlined.'; return; }
    $('calFit').textContent = fit.ok
      ? `density = ${fit.intercept.toFixed(5)} + ${fit.slope.toExponential(4)} × gray · ${fit.n} points${fit.r2 === null ? ' (exact line)' : ` · R² ${fit.r2.toFixed(4)}`}`
      : `Uncalibrated: ${fit.reason}`;
    const head = table.insertRow();
    for (const h of ['Point', 'g/cm³', 'Median gray', 'Gray SD', 'Voxels', 'Residual', '']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    fit.points.forEach((p, k) => {
      const tr = table.insertRow();
      const phantom = fit.phantoms.find((x) => x.name === p.name && x.gray === p.gray);
      const cells = [p.name, p.density.toFixed(4), p.gray === null ? 'n/a' : p.gray.toFixed(0), phantom && phantom.stats.gray_sd != null ? phantom.stats.gray_sd.toFixed(0) : '', phantom ? phantom.stats.voxels.toLocaleString('en-US') : '',
        fit.ok ? fit.residuals[k].toFixed(4) : ''];
      cells.forEach((c, i) => { const td = tr.insertCell(); td.textContent = c; if (!i) td.style.textAlign = 'left'; });
      const cell = tr.insertCell();
      if (phantom) {
        const del = document.createElement('button');
        del.className = 'link';
        del.textContent = state.deleting === phantom.id ? 'confirm delete' : 'delete';
        del.addEventListener('click', () => { if (state.deleting === phantom.id) App.removeRecord('regions', phantom.id); else { state.deleting = phantom.id; render(); } });
        cell.append(del);
      }
    });
  }

  on('start', () => {
    $('drawPhantom').addEventListener('click', startPhantom);
    $('calAir').addEventListener('change', (e) => setAir(e.target.checked));
  });
  for (const e of ['loaded', 'recordsChanged', 'poresChanged', 'modelChanged', 'changed']) on(e, render);

  App.densityText = densityText;
}(window.CTApp));
