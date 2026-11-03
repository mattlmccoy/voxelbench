/* Before/after: this scan's saved run against another folder's saved run (for example the same part before and after
   sintering), metric by metric. Only saved runs are compared, so both sides were made the same way. */
(function (App) {
  'use strict';
  const CT = window.CT;
  const { state, $, on } = App;
  const fmt = (v) => (v === null ? 'n/a' : Number.isInteger(v) || Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));

  function options() {
    const sel = $('compareWith'), keep = sel.value;
    const folders = [...new Set([...state.stacks.map((s) => s.folder), ...state.samples.keys()])].filter((f) => f && f !== state.folder).sort();
    sel.textContent = '';
    const first = document.createElement('option'); first.value = ''; first.textContent = "another scan's saved run…"; sel.append(first);
    for (const f of folders) { const o = document.createElement('option'); o.value = f; o.textContent = CT.sampleInfo(f, state.samples).name; sel.append(o); }
    sel.value = folders.includes(keep) ? keep : '';
  }

  let token = 0;
  async function compare() {
    const mine0 = ++token; // a later call replaces this one's table
    const other = $('compareWith').value, table = $('compareTable');
    table.textContent = '';
    $('compareWrap').hidden = true;
    $('compareNote').textContent = '';
    if (!other || !state.store || !state.folder) return;
    const [mine, theirs] = await Promise.all([state.store.getRun(state.folder), state.store.getRun(other)]);
    if (mine0 !== token) return;
    if (!mine || !theirs) { $('compareNote').textContent = `No saved run for ${!mine ? 'this scan (press Save run)' : other}.`; return; }
    const head = table.insertRow();
    for (const h of ['Metric', CT.sampleInfo(other, state.samples).name, CT.sampleInfo(state.folder, state.samples).name, 'Change']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    for (const r of CT.compareRuns(theirs, mine)) {
      const tr = table.insertRow();
      [r.label, fmt(r.before), fmt(r.after), r.change === null ? 'n/a' : `${r.change >= 0 ? '+' : ''}${fmt(r.change)}`].forEach((c, i) => { const td = tr.insertCell(); td.textContent = c; if (!i) td.style.textAlign = 'left'; });
    }
    $('compareWrap').hidden = false;
    const grid = (run) => (Number.isFinite(run.voxel_mm) ? `${(run.voxel_mm * 1000).toFixed(0)} µm${run.bin_factor > 1 ? `, ${run.bin_factor}× binned` : ''}` : 'voxel size not recorded');
    const day = (run) => (run.created_at || 'date not recorded').slice(0, 10);
    $('compareNote').textContent = `Saved runs: ${other} (${day(theirs)}, ${grid(theirs)}) and this scan (${day(mine)}, ${grid(mine)}). n/a: the run was saved before that measurement existed or without it.`;
  }

  on('start', () => $('compareWith').addEventListener('change', compare));
  for (const e of ['loaded', 'samplesChanged', 'recordsChanged']) on(e, options);
  on('loaded', compare);
  on('runSaved', compare);
}(window.CTApp));
