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
    if (v !== null && !(Number.isFinite(v) && (field === 'nominal_mm' || v >= 0))) { render(); return; } // not a number (or a negative tolerance): show the saved value again
    App.saveRecord('annotations', { ...raw, [field]: v });
  }

  function render() {
    const lines = state.folder ? App.annotationsOf(state.folder).filter((a) => a.kind === 'caliper' && Number.isFinite(a.length_mm)) : []; // the Measure tool saves kind 'caliper'
    $('dimWrap').hidden = !lines.length;
    const table = $('dimTable');
    table.textContent = '';
    table.style.width = '100%';
    if (!lines.length) return;
    const head = table.insertRow();
    for (const h of ['Line', 'Nominal (mm)', '− / + tol (mm)']) { const th = document.createElement('th'); th.textContent = h; if (h === 'Line') th.style.textAlign = 'left'; head.append(th); }
    let checked = 0, passed = 0;
    for (const a of lines) {
      const c = CT.dimensionCheck(a.length_mm, a.nominal_mm, a.tol_minus_mm ?? 0, a.tol_plus_mm ?? 0);
      if (c.pass !== null) { checked++; if (c.pass) passed++; }
      const tr = table.insertRow();
      const name = tr.insertCell();
      name.textContent = a.note || `${a.plane} ${a.slice}`;
      name.title = name.textContent;
      // The name takes the room the inputs leave and ends in "…" (width 100 % with max-width 0), so the table never runs
      // past the rail, whatever the look's cell padding or the rail's width.
      Object.assign(name.style, { width: '100%', maxWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' });
      const field = (key, title, width) => {
        const input = document.createElement('input');
        input.type = 'text'; input.inputMode = 'decimal'; input.style.width = width; input.title = title; // no spinner: the value stays readable in a narrow rail
        input.value = a[key] ?? '';
        input.addEventListener('change', () => save(a.id, key, input.value));
        return input;
      };
      tr.insertCell().append(field('nominal_mm', 'Nominal (mm)', '52px'));
      const tol = tr.insertCell();
      tol.style.whiteSpace = 'nowrap';
      tol.append(field('tol_minus_mm', 'Minus tolerance (mm)', '46px'), field('tol_plus_mm', 'Plus tolerance (mm)', '46px'));
      // The result on its own line under the inputs, so the table fits the rail.
      const result = table.insertRow().insertCell();
      result.colSpan = 3;
      result.style.textAlign = 'left';
      result.textContent = `measured ${fmt(a.length_mm)} mm${c.deviation === null ? '' : `, deviation ${c.deviation >= 0 ? '+' : ''}${fmt(c.deviation)} mm: ${c.pass ? 'pass' : 'FAIL'}`}`;
      if (c.pass === false) result.className = 'error';
    }
    $('dimSummary').textContent = checked ? `Dimensions: ${passed} of ${checked} within tolerance` : 'Dimensions: enter a nominal to check a Measure line.';
  }

  for (const e of ['loaded', 'recordsChanged']) on(e, render);
}(window.CTApp));
