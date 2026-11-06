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

  function startDense() {
    const material = $('denseMaterial').value.trim();
    if (!material) { $('calNote').textContent = 'Enter the dense material first.'; return; }
    state.denseDraft = { material };
    $('calNote').textContent = `Outline fully dense ${material} material on a slice where it is glossy and pore-free, set its slice range, then Save.`;
    emit('startDrawing', 'dense');
  }

  /** Phantom materials used before in this project fill the name list; picking one fills its density. */
  function renderMaterials() {
    const regions = [...state.regions.values(), ...[...state.unsaved.values()].filter((r) => r._collection === 'regions')];
    const known = Cal.knownMaterials(regions);
    const list = $('phantomMaterials');
    list.textContent = '';
    for (const m of known) { const o = document.createElement('option'); o.value = m.name; o.label = `${m.density_g_cm3} g/cm³`; list.append(o); }
    const dense = $('denseMaterials');
    dense.textContent = '';
    for (const m of Cal.knownDenseMaterials(regions)) { const o = document.createElement('option'); o.value = m; dense.append(o); }
    return known;
  }

  function setAir(include) {
    if (!state.folder) return;
    App.saveSample({ calibration_air: include });
  }

  /** On the phantom test scan, which rod is which: the densities to type are not on the image. */
  function renderDemo() {
    const demo = state.demoPhantoms, rods = demo && demo.folder === state.folder ? demo.rods : null;
    $('calDemo').hidden = !rods;
    if (!rods) return;
    const c = (state.dims.nx - 1) / 2;
    const place = (r) => `${r.center.y < c ? 'upper' : 'lower'} ${r.center.x < c ? 'left' : 'right'}`;
    $('calDemo').textContent = `Test scan: ${rods.map((r) => `the ${place(r)} rod is ${r.density_g_cm3.toFixed(2)} g/cm³`).join('; ')} (on XY). Outline each, with its density, to calibrate.`;
  }

  /** What the calibration gives for this scan, and where else its densities appear. */
  function renderResults(fit) {
    const ok = Boolean(fit && fit.ok);
    $('calResultWrap').hidden = !ok;
    if (!ok) return;
    const arch = App.sampleNow().archimedes;
    const porosity = state.pores ? window.CTPores.summarize(state.pores, state.bodyMm3, state.rejected).all_void_percent_of_body : null;
    const { rows, todo } = Cal.calibrationResults({ fit, solidGray: state.solidGray ?? null, porosityPercent: porosity, archimedesDensity: arch ? arch.density_g_cm3 : null });
    const host = $('calResults');
    host.textContent = '';
    for (const [k, v] of rows) {
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
      host.append(a, b);
    }
    $('calWhere').textContent = `${todo ? `${todo} ` : ''}Equivalent density also shows at the cursor in the status bar, in the step 3 zone and region tables, and in the review sheet and saved run. Bulk counts the pores as air. * outside the phantom gray range.`;
  }

  function render() {
    $('drawPhantom').disabled = !state.folder;
    $('drawDense').disabled = !state.folder || state.airGray === null;
    renderMaterials();
    const rel = App.relative();
    $('relNote').textContent = rel.length ? `Relative scale: ${rel.map((s) => `${s.material} dense = gray ${s.denseGray.toFixed(0)}`).join('; ')}; air = gray ${rel[0].airGray.toFixed(0)}.` : '';
    if (state.tool !== 'freehand' && $('calNote').textContent.startsWith('Outline')) $('calNote').textContent = ''; // drawing finished
    const fit = App.calibration();
    const air = state.folder ? CT.sampleInfo(state.folder, state.samples).calibration_air : true;
    $('calAir').checked = air;
    $('calTag').textContent = fit && fit.ok ? `calibrated, ${fit.n} points` : 'optional';
    const table = $('calTable');
    table.textContent = '';
    $('calWrap').hidden = !fit;
    renderDemo();
    renderResults(fit);
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
    $('drawDense').addEventListener('click', startDense);
    $('phantomName').addEventListener('input', () => {
      const m = renderMaterials().find((x) => x.name === $('phantomName').value.trim());
      if (m) $('phantomDensity').value = m.density_g_cm3;
    });
    $('calAir').addEventListener('change', (e) => setAir(e.target.checked));
  });
  for (const e of ['loaded', 'recordsChanged', 'poresChanged', 'modelChanged', 'changed']) on(e, render);

  App.densityText = densityText;
}(window.CTApp));
