/* Dimensions with tolerances: every Measure line of the open sample, with a nominal and a tolerance band the user
   enters, saved on the annotation, and pass or fail from CT.dimensionCheck. */
(function (App) {
  'use strict';
  const CT = window.CT;
  const { state, $, on } = App;
  const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '');

  /** The stored record (not the grid-rescaled copy), so saving keeps its own grid. */
  function rawAnnotation(id) {
    const pending = state.unsaved.get(id);
    if (pending && pending._collection === 'annotations') { const { _collection, ...r } = pending; return r; }
    return state.annotations.get(id) || null;
  }

  function save(id, field, text) {
    const raw = rawAnnotation(id);
    if (!raw) return;
    const v = text.trim() === '' ? null : Number(text);
    if (v !== null && !(Number.isFinite(v) && (field === 'nominal_mm' || v >= 0))) return;
    App.saveRecord('annotations', { ...raw, [field]: v });
  }

  function render() {
    const lines = state.folder ? App.annotationsOf(state.folder).filter((a) => a.kind === 'caliper' && Number.isFinite(a.length_mm)) : []; // the Measure tool saves kind 'caliper'
    $('dimWrap').hidden = !lines.length;
    const table = $('dimTable');
    table.textContent = '';
    if (!lines.length) return;
    const head = table.insertRow();
    for (const h of ['Line', 'Nominal', '− / + tol', 'Measured, dev.']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    let checked = 0, passed = 0;
    for (const a of lines) {
      const c = CT.dimensionCheck(a.length_mm, a.nominal_mm, a.tol_minus_mm ?? 0, a.tol_plus_mm ?? 0);
      if (c.pass !== null) { checked++; if (c.pass) passed++; }
      const tr = table.insertRow();
      const name = tr.insertCell();
      name.textContent = a.note || `${a.plane} ${a.slice}`;
      name.title = name.textContent;
      Object.assign(name.style, { maxWidth: '64px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' });
      const field = (key, title, width) => {
        const input = document.createElement('input');
        input.type = 'number'; input.step = '0.001'; input.style.width = width; input.title = title;
        input.value = a[key] ?? '';
        input.addEventListener('change', () => save(a.id, key, input.value));
        return input;
      };
      tr.insertCell().append(field('nominal_mm', 'Nominal (mm)', '52px'));
      const tol = tr.insertCell();
      tol.style.whiteSpace = 'nowrap';
      tol.append(field('tol_minus_mm', 'Minus tolerance (mm)', '46px'), field('tol_plus_mm', 'Plus tolerance (mm)', '46px'));
      const result = tr.insertCell();
      result.style.whiteSpace = 'nowrap';
      result.textContent = `${fmt(a.length_mm)}${c.deviation === null ? '' : `, ${c.deviation >= 0 ? '+' : ''}${fmt(c.deviation)} ${c.pass ? 'pass' : 'FAIL'}`}`;
      if (c.pass === false) result.className = 'error';
    }
    $('dimSummary').textContent = checked ? `Dimensions: ${passed} of ${checked} within tolerance` : 'Dimensions: enter a nominal to check a Measure line.';
  }

  for (const e of ['loaded', 'recordsChanged']) on(e, render);
}(window.CTApp));
