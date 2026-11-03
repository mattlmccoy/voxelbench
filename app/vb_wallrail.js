/* Step 8 of the rail: wall thickness. Runs VBWall in the worker (App.requestWall) and shows the distribution, a
   histogram and the thinnest places, which jump the slices there on click. */
(function (App) {
  'use strict';
  const CT = window.CT;
  const { state, $, on, emit } = App;
  const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

  function drawHistogram(h) {
    const canvas = $('wallHist'), g = canvas.getContext('2d'), W = canvas.width, H = canvas.height, pad = 16, peak = Math.max(1, ...h.counts);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#6ec3ff';
    h.counts.forEach((n, k) => g.fillRect((k / h.counts.length) * W, H - pad - ((H - pad) * n) / peak, W / h.counts.length - 1, ((H - pad) * n) / peak));
    g.fillStyle = getComputedStyle(canvas).color || '#999';
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'left'; g.fillText('0', 0, H - 3);
    g.textAlign = 'right'; g.fillText(`${h.top_mm.toFixed(2)} mm`, W, H - 3);
    canvas.title = 'Ridge voxels by local wall thickness.';
  }

  function render() {
    const w = state.wall, r = w && w.result;
    $('runWall').disabled = !state.dims || Boolean(w && w.busy);
    $('wallExport').disabled = !r;
    $('wallTag').textContent = r && r.stats.min_mm !== null ? `min ${fmt(r.stats.min_mm, 2)} mm` : 'optional';
    $('wallHist').hidden = !r || !r.stats.count;
    $('wallWrap').hidden = !r || !r.thinnest.length;
    $('wallStats').textContent = '';
    if (!w) { $('wallFit').textContent = ''; return; }
    if (w.busy) { $('wallFit').textContent = 'Measuring walls…'; return; }
    const atLimit = r.stats.min_mm !== null && r.stats.min_mm <= r.resolved_min_mm + 1e-6;
    $('wallFit').textContent = `On ${CT.gridText(state.binFactor * App.BIN)} (analysis voxel ${fmt(r.analysis_voxel_mm * 1000, 0)} µm); ${r.stats.count.toLocaleString('en-US')} ridge voxels${r.beyond_stack ? `; ${r.beyond_stack.toLocaleString('en-US')} left out where the wall runs past the first or last slice` : ''}.`;
    for (const [k, v] of [['Thinnest', `${fmt(r.stats.min_mm)} mm${atLimit ? ' (at the resolved limit: walls this thin or thinner)' : ''}`], ['5th / 50th / 95th', `${fmt(r.stats.p05_mm)} / ${fmt(r.stats.p50_mm)} / ${fmt(r.stats.p95_mm)} mm`], ['Thickest', `${fmt(r.stats.max_mm)} mm`]]) {
      const a = document.createElement('span'); a.className = 'k'; a.textContent = k;
      const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
      $('wallStats').append(a, b);
    }
    if (r.stats.count) drawHistogram(r.histogram);
    const table = $('wallTable');
    table.textContent = '';
    const head = table.insertRow();
    for (const h of ['#', 'Thickness (mm)', 'x, y, z (voxels)']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    r.thinnest.forEach((t, k) => {
      const tr = table.insertRow();
      tr.className = 'pick';
      [k + 1, fmt(t.thickness_mm), `${Math.round(t.x)}, ${Math.round(t.y)}, ${Math.round(t.z)}`].forEach((c) => { tr.insertCell().textContent = c; });
      tr.addEventListener('click', () => emit('jump', { x: Math.round(t.x), y: Math.round(t.y), z: Math.round(t.z) }));
    });
  }

  async function exportCsv() {
    const r = state.wall.result, v = state.voxelMm;
    const lines = [`# Thinnest walls of ${state.folder}; ${App.provenance()}`, '# thickness_mm: about 2 x the distance to the outside at a ridge voxel - 1/2 analysis voxel (+-1/2 voxel), sample mask with pores filled.',
      `# Statistics: ${JSON.stringify(r.stats)}`, 'rank,thickness_mm,x_voxel,y_voxel,z_voxel,x_mm,y_mm,z_mm',
      ...r.thinnest.map((t, k) => [k + 1, t.thickness_mm.toFixed(5), t.x, t.y, t.z, (t.x * v).toFixed(4), (t.y * v).toFixed(4), (t.z * v).toFixed(4)].join(','))];
    const name = `${state.folder}_walls.csv`;
    const how = await window.VBStore.saveBlob(state.downloads, name, new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
    $('wallExportNote').textContent = how === 'declined' ? 'Save canceled.' : how === 'link' ? `Downloaded ${name}.` : `Saved ${name}.`;
  }

  on('start', () => { $('runWall').addEventListener('click', () => App.requestWall()); $('wallExport').addEventListener('click', exportCsv); });
  on('loaded', () => { state.wall = null; render(); });
  on('wallChanged', render);
  on('modelChanged', render);
}(window.CTApp));
