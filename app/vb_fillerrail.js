/* Step 7 of the rail: filler and fibers. Runs the bright-phase analysis in the worker (App.requestFiller), shows the
   thresholds, counts, sizes, dispersion, the fiber orientation tensor, a table per drawn region and the resolution
   limits, exports the particles, and draws them in the 3D view (fibers as segments, the rest as points). */
(function (App) {
  'use strict';
  const CT = window.CT, F = window.VBFiller;
  const { state, $, on } = App;
  const NEGLIGIBLE_PERCENT = 0.001; // a bright phase below this share of the mask is reported as none
  const fmt = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));
  const vec = (d) => `(${d.map((v) => fmt(v, 2)).join(', ')})`;

  function resolutionText() {
    if (!state.voxelMm) return '';
    const um = state.voxelMm * 1000;
    return `At ${um.toFixed(0)} µm voxels a particle needs about 2 voxels across (${(2 * um).toFixed(0)} µm) to be counted and a fiber about 3 voxels across (${(3 * um).toFixed(0)} µm) for its direction; fibers thinner than that (short glass fibers are 10 to 15 µm) do not resolve. Volumes of particles under about 4 voxels across read low, because the slices are smoothed.`;
  }

  function addRows(host, rows) {
    host.textContent = '';
    for (const [k, v] of rows) {
      const a = document.createElement('span'); a.className = 'k'; a.textContent = k;
      const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
      host.append(a, b);
    }
  }

  function tensorText(o) {
    return o.too_few ? `${o.count} fiber${o.count === 1 ? '' : 's'}: too few for a tensor (needs ${F.MIN_FIBERS_FOR_TENSOR})` : `eigenvalues ${o.eigenvalues.map((v) => fmt(v, 2)).join(' / ')} along ${vec(o.direction)}`;
  }

  function drawHistogram(particles) {
    const canvas = $('fillerHist'), g = canvas.getContext('2d'), esd = particles.filter((p) => !p.clipped).map((p) => p.esd_mm);
    canvas.hidden = !esd.length;
    if (!esd.length) return;
    const top = Math.max(...esd), bins = 24, w = top / bins || 1, counts = new Array(bins).fill(0);
    for (const d of esd) counts[Math.min(bins - 1, Math.floor(d / w))]++;
    const W = canvas.width, H = canvas.height, pad = 16, peak = Math.max(...counts);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#e0a458';
    counts.forEach((n, k) => g.fillRect((k / bins) * W, H - pad - ((H - pad) * n) / peak, W / bins - 1, ((H - pad) * n) / peak));
    g.fillStyle = getComputedStyle(canvas).color || '#999';
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'left'; g.fillText('0', 0, H - 3);
    g.textAlign = 'right'; g.fillText(`${top.toFixed(2)} mm ESD`, W, H - 3);
    canvas.title = 'Equivalent sphere diameter of the particles not cut by the FOV edge or the volume faces.';
  }

  function renderRegions(r) {
    const regions = App.regionsOf(state.folder).filter((x) => x.label !== 'crop' && x.label !== 'phantom');
    const table = $('fillerRegions');
    table.textContent = '';
    $('fillerRegionWrap').hidden = !regions.length;
    if (!regions.length) return;
    const head = table.insertRow();
    for (const h of ['Region', 'Particles', 'Fibers', 'Orientation']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    for (const region of regions) {
      const inside = F.particlesInRegion(r.particles, region), fibers = inside.filter((p) => p.fiber);
      const tr = table.insertRow();
      [region.label + (region.note ? ` (${region.note})` : ''), inside.length, fibers.length, tensorText(F.orientationTensor(fibers))].forEach((c, i) => { const td = tr.insertCell(); td.textContent = c; if (!i || i === 3) td.style.textAlign = 'left'; });
    }
  }

  function render() {
    const f = state.filler, r = f && f.result;
    $('runFiller').disabled = !state.pores || Boolean(f && f.busy);
    $('fillerExport').disabled = !r;
    $('fillerHint').textContent = `Finds the bright phase inside the sample (filler particles, fibers) after pore segmentation. ${resolutionText()}`;
    $('fillerWarn').hidden = true;
    $('fillerTag').textContent = r ? `${r.summary.count} particles` : 'optional';
    if (!f) { $('fillerFit').textContent = state.pores ? '' : 'Segment pores first (step 2).'; addRows($('fillerStats'), []); $('fillerHist').hidden = true; $('fillerRegionWrap').hidden = true; $('fillerNote').textContent = ''; return; }
    if (f.busy) { $('fillerFit').textContent = 'Labeling the bright phase…'; return; }
    if (!r) { $('fillerFit').textContent = f.refused || ''; return; }
    const t = r.threshold, s = r.summary, d = r.dispersion;
    $('fillerFit').textContent = `Detection ${fmt(t.detection, 0)} (matrix ${fmt(t.median, 0)} + ${t.k} × ${fmt(t.sd, 0)}) · measurement ${fmt(t.threshold, 0)}${t.manual ? ' (set by hand)' : t.bright_gray === null ? ' (no particles: detection used)' : t.threshold === t.detection ? ` (the halfway level to the median particle peak ${fmt(t.bright_gray, 0)} is below detection, so detection is used)` : ` (halfway to the median particle peak ${fmt(t.bright_gray, 0)})`}`;
    addRows($('fillerStats'), [
      ['Particles', `${s.count.toLocaleString('en-US')} (${s.clipped} at the FOV edge or volume faces; ${r.dropped.toLocaleString('en-US')} under ${r.minVoxels} voxels dropped)`],
      ['Near noise', `${s.near_noise.toLocaleString('en-US')} (peak within 1 SD of detection)`],
      ['Volume fraction', `${fmt(s.volume_percent, 4)} % of the sample mask`],
      ['ESD 10th / 50th / 90th', `${fmt(s.esd_p10_mm)} / ${fmt(s.esd_p50_mm)} / ${fmt(s.esd_p90_mm)} mm`],
      ['Mean nearest neighbor', `${fmt(d.mean_nn_mm)} mm`],
      ['Clark–Evans R', d.clark_evans === null ? `too few particles (needs ${F.MIN_FOR_DISPERSION})` : `${fmt(d.clark_evans, 2)} (1 random, < 1 clustered, > 1 regular)`],
      ['Fibers', tensorText(s.orientation)],
    ]);
    if (s.count && (s.near_noise === s.count || s.volume_percent < NEGLIGIBLE_PERCENT)) {
      $('fillerWarn').hidden = false;
      $('fillerWarn').textContent = `No significant bright phase: ${s.count} candidate${s.count === 1 ? '' : 's'} (${s.near_noise} within 1 SD of the detection threshold), ${fmt(s.volume_percent, 5)} % of the sample mask. Treat them as noise or stray inclusions, not filler.`;
    }
    drawHistogram(r.particles);
    renderRegions(r);
    $('fillerNote').textContent = 'Orientation tensor: weighted mean of p pᵀ over the fibers\' main axes; eigenvalue 1 = all aligned, 1/3 each = random in 3D. Clark–Evans R compares the mean nearest-neighbor distance with a random arrangement at the same density; the part\'s edges push it up for small counts. The 3D view shows fibers as cyan segments and other particles as white points.';
  }

  // 3D: fibers as line segments along their main axis, other particles as points.
  function draw3D() {
    const ctx = state.dims ? App.model3D.ctx() : null;
    if (!ctx) return;
    if (ctx.filler) { for (const o of ctx.filler) { ctx.scene.remove(o); o.geometry.dispose(); } ctx.filler = null; }
    const r = state.filler && state.filler.result;
    if (r && r.particles.length) {
      const T = ctx.T, world = (p) => App.model3D.toWorld(...p);
      const fibers = r.particles.filter((p) => p.fiber && !p.near_noise), dots = r.particles.filter((p) => !p.fiber && !p.near_noise);
      const seg = new Float32Array(6 * fibers.length);
      fibers.forEach((p, i) => {
        const h = p.length_vox / 2;
        seg.set(world(p.centroid.map((c, k) => c - h * p.direction[k])), 6 * i);
        seg.set(world(p.centroid.map((c, k) => c + h * p.direction[k])), 6 * i + 3);
      });
      const lg = new T.BufferGeometry(); lg.setAttribute('position', new T.BufferAttribute(seg, 3));
      const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(Float32Array.from(dots.flatMap((p) => world(p.centroid))), 3));
      ctx.filler = [new T.LineSegments(lg, new T.LineBasicMaterial({ color: 0x7ee0ff })), new T.Points(pg, new T.PointsMaterial({ color: 0xffffff, size: 4, sizeAttenuation: false }))];
      for (const o of ctx.filler) ctx.scene.add(o);
    }
    App.model3D.render();
  }

  async function exportCsv() {
    const r = state.filler.result;
    const csv = window.CTExport.fillerCsv(r.particles, r, { sample: CT.sampleInfo(state.folder, state.samples), provenance: App.provenance() });
    const name = `${state.folder}_filler.csv`;
    const how = await window.VBStore.saveBlob(state.downloads, name, new Blob([csv], { type: 'text/csv' }));
    $('fillerExportNote').textContent = how === 'declined' ? 'Save canceled.' : how === 'link' ? `Downloaded ${name}.` : `Saved ${name}.`;
  }

  on('start', () => {
    $('runFiller').addEventListener('click', () => {
      const t = $('fillerThreshold').value.trim();
      App.requestFiller({ k: Number($('fillerK').value) || 4, minVoxels: Math.max(1, Math.round(Number($('fillerMin').value) || 8)), threshold: t === '' ? null : Number(t) });
    });
    $('fillerExport').addEventListener('click', exportCsv);
  });
  on('loaded', () => { state.filler = null; render(); draw3D(); });
  on('fillerChanged', () => { render(); draw3D(); });
  for (const e of ['poresChanged', 'recordsChanged']) on(e, render);
  on('modelChanged', draw3D);
}(window.CTApp));
