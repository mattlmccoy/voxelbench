/* Step 9 of the rail: 3D figures. Asks the worker for the phase label volume and its two renders (vb_figure.js), draws
   the callouts, the field arrow and the 10 mm bar on the cutaway, and keeps a figure set in this browser (IndexedDB)
   from which it draws all samples at one scale: a row of cutaways with their numbers, and a turntable film. */
(function (App) {
  'use strict';
  const { state, $, on, emit } = App;
  const F = window.VBFigure;
  const INK = '#1b2430', MUTE = '#5a6472', FONT = 'Montserrat, "Helvetica Neue", Arial, sans-serif';
  const PREFS_KEY = 'vb.figure';
  const PX_PER_MM = 25; // canvas pixels per mm in every figure: 2 px per 80 µm cell, as the lab's deck figures
  let result = null, busy = false, film = null;

  // ---------- settings ----------
  const PREFS = [['figField', 'field', 'value'], ['figTop', 'top', 'checked'], ['figSplit', 'split', 'value'], ['figCupping', 'cupping', 'checked'],
    ['figNameDoped', 'doped', 'value'], ['figNameBase', 'base', 'value'], ['figNameClump', 'clump', 'value'], ['figBaseDensity', 'baseDensity', 'value']];
  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(window.localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (e) { p = {}; }
    for (const [id, key, prop] of PREFS) if (key in p) $(id)[prop] = p[key];
  }
  function savePrefs() {
    const p = {};
    for (const [id, key, prop] of PREFS) p[key] = $(id)[prop];
    try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* private window */ }
  }
  const names = () => ({ doped: $('figNameDoped').value.trim() || 'doped', base: $('figNameBase').value.trim() || 'base', clump: $('figNameClump').value.trim() || 'clump' });
  const num = (id) => { const v = Number($(id).value); return $(id).value !== '' && Number.isFinite(v) ? v : null; };

  function classLabels(n) {
    return [
      [F.CODE.DOPED_DENSE, `dense ${n.doped} melt`], [F.CODE.DOPED_POROUS, `porous ${n.doped}`], [F.CODE.BASE_DENSE, `${n.base}, melted`],
      [F.CODE.BASE_POROUS, `${n.base}, partly sintered`], [F.CODE.DOPED_PORE, 'enclosed gas'], [F.CODE.CLUMP, n.clump]];
  }
  const CALLOUT = (n) => ({ 1: `dense\n${n.doped} melt`, 2: `porous ${n.doped},\nnot fully melted`, 3: `${n.base}\nmelted on`, 4: `${n.base},\npartly sintered`, 5: 'enclosed\ngas' });
  const rgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;

  function renderScaleOptions() {
    const sel = $('figScale'), keep = sel.value;
    sel.textContent = '';
    const auto = document.createElement('option'); auto.value = 'auto'; auto.textContent = 'found in the part'; sel.append(auto);
    for (const s of App.relative()) { const o = document.createElement('option'); o.value = s.material; o.textContent = `${s.material} dense reference (step 5)`; sel.append(o); }
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'auto';
  }

  function renderMasses() {
    const f = (state.folder && CT().sampleInfo(state.folder, state.samples)) || null, rec = state.folder && state.samples.get(state.folder), m = (rec && rec.figure) || {};
    for (const [id, key] of [['figMassIn', 'mass_in_g'], ['figMassOut', 'mass_out_g']]) if (document.activeElement !== $(id)) $(id).value = Number.isFinite(m[key]) ? m[key] : '';
    $('figMassIn').disabled = $('figMassOut').disabled = !f;
  }
  const CT = () => window.CT;
  function saveMasses() {
    if (!state.folder) return;
    const rec = state.samples.get(state.folder), old = (rec && rec.figure) || {};
    App.saveSample({ figure: { ...old, mass_in_g: num('figMassIn'), mass_out_g: num('figMassOut') } });
    if (result) renderResult();
  }

  // ---------- run ----------
  async function run() {
    if (busy || !state.dims) return;
    busy = true; result = null; savePrefs(); render();
    const scaleSel = $('figScale').value, rel = App.relative().find((s) => s.material === scaleSel);
    const options = { fieldAxis: $('figField').value, upIsLowZ: $('figTop').checked, denseGray: rel ? rel.denseGray : null, coneBand: !state.orientId,
      baseDensity: num('figBaseDensity') || 1.01, classify: { split: num('figSplit') || F.DEFAULTS.split, cupping: $('figCupping').checked } };
    try {
      const r = await App.callWorker('figure', { ...App.bodyArgs(), options });
      result = { ...r, folder: state.folder, names: names(), options, provenance: App.provenance() };
      $('figWarn').hidden = true;
    } catch (e) {
      $('figWarn').textContent = e.message; $('figWarn').hidden = false;
    }
    busy = false; render();
  }

  // ---------- numbers ----------
  function numbersOf(r, rec) {
    const s = r.stats, m = (rec && rec.figure) || {};
    const weighed = Number.isFinite(m.mass_in_g) && Number.isFinite(m.mass_out_g) ? m.mass_out_g - m.mass_in_g : null;
    return { dense: s.dense_percent_of_doped, gas: s.gas_percent_of_doped, fused: weighed ?? s.base_mass_g, fusedSource: weighed !== null ? 'weighed' : 'CT' };
  }
  const pct = (v) => (v === null || !Number.isFinite(v) ? 'n/a' : v.toFixed(v < 10 ? 1 : 0));
  const numbersLine = (nb, n) => `${pct(nb.dense)} % dense · ${pct(nb.gas)} % gas · ${Number.isFinite(nb.fused) ? nb.fused.toFixed(1) : 'n/a'} g ${n.base} fused on${nb.fusedSource === 'CT' ? ' (CT)' : ''}`;

  // ---------- drawing ----------
  function imageCanvas(img) {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return c;
  }

  /** The annotated cutaway: the render at 25 px/mm, callouts below spread by x (widened when they need the room), the
      field arrow and a 10 mm bar above. */
  function drawCutaway(canvas, r) {
    const S = PX_PER_MM * r.cellMm, w = r.cut.width, h = r.cut.height, P = (p) => (p * 200) / 72; // points at 2 px per 80 µm
    const call = CALLOUT(r.names), pts = [...r.anchors].sort((a, b) => a.x - b.x), lh = P(13) * 1.2, gap = P(8);
    const g0 = document.createElement('canvas').getContext('2d');
    g0.font = `${P(13)}px ${FONT}`;
    const boxes = pts.map((a) => { const lines = call[a.code].split('\n'); return { lines, w: Math.max(...lines.map((l) => g0.measureText(l).width)) + P(10), h: lines.length * lh + P(8) }; });
    const need = boxes.reduce((t, b) => t + b.w, 0) + gap * (boxes.length + 1);
    const [dx, dy] = r.field, mm = [10, 5, 2, 1].find((v) => v / r.cellMm <= 0.6 * w) || 1, bar = (mm / r.cellMm) * S;
    g0.font = `bold ${P(16)}px ${FONT}`;
    const room = w * S - bar - g0.measureText('E field').width - P(30); // the arrow and its label end left of the scale bar
    const L = Math.max(3 / r.cellMm * S, Math.min(12 / r.cellMm * S, 0.5 * w * S, room / Math.max(0.2, Math.abs(dx))));
    const imgW = w * S, padX = P(14), padT = Math.max(P(48), Math.abs(dy) * L + P(30)), padB = P(60);
    const eRight = P(6) + Math.abs(dx) * L + P(8) + g0.measureText('E field').width; // from the image's left edge
    canvas.width = Math.round(Math.max(imgW + 2 * padX, need, eRight + P(24) + bar + 2 * padX)); canvas.height = Math.round(h * S + padT + padB);
    const ox = Math.min((canvas.width - imgW) / 2, padX), X = (x) => ox + x * S, Y = (y) => padT + y * S;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingEnabled = true; g.drawImage(imageCanvas(r.cut), X(0), Y(0), imgW, h * S);
    // callouts: boxes in a row below the part, in the order of their points, each with an arrow to its point
    const slot = boxes.length ? (canvas.width - need) / boxes.length : 0;
    let at = gap + slot / 2;
    g.textBaseline = 'middle'; g.textAlign = 'center';
    pts.forEach((a, i) => {
      const b = boxes[i], cx = at + b.w / 2, by = Y(h) + padB * 0.5 - b.h / 2;
      at += b.w + gap + slot;
      const px = X(a.x + 0.5), py = Y(a.y + 0.5), ang = Math.atan2(py - by, px - cx), head = P(7);
      g.strokeStyle = INK; g.fillStyle = INK; g.lineWidth = P(1.6);
      g.beginPath(); g.moveTo(cx, by); g.lineTo(px - head * Math.cos(ang), py - head * Math.sin(ang)); g.stroke();
      g.beginPath(); g.moveTo(px, py); g.lineTo(px - head * Math.cos(ang - 0.35), py - head * Math.sin(ang - 0.35)); g.lineTo(px - head * Math.cos(ang + 0.35), py - head * Math.sin(ang + 0.35)); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.95)'; g.strokeStyle = '#aab3bf'; g.lineWidth = P(1);
      g.fillRect(cx - b.w / 2, by, b.w, b.h); g.strokeRect(cx - b.w / 2, by, b.w, b.h);
      g.fillStyle = INK; g.font = `${P(13)}px ${FONT}`; b.lines.forEach((l, k) => g.fillText(l, cx, by + P(4) + lh * (k + 0.5)));
      g.beginPath(); g.arc(px, py, P(3), 0, 2 * Math.PI); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = INK; g.lineWidth = P(1.6); g.stroke();
    });
    // field arrow (double-headed) over the top left of the part, as long as half the part (at most 12 mm)
    const x0 = X(0) + P(6), y0 = padT - P(6) - Math.max(0, dy) * L;
    const x1 = x0 + dx * L, y1 = y0 + dy * L;
    g.strokeStyle = MUTE; g.fillStyle = MUTE; g.lineWidth = P(2.2);
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    const head = P(9), ang = Math.atan2(y1 - y0, x1 - x0);
    for (const [hx, hy, a] of [[x1, y1, ang], [x0, y0, ang + Math.PI]]) { g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx - head * Math.cos(a - 0.4), hy - head * Math.sin(a - 0.4)); g.lineTo(hx - head * Math.cos(a + 0.4), hy - head * Math.sin(a + 0.4)); g.fill(); }
    g.font = `bold ${P(16)}px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('E field', x1 + P(8), y1);
    // scale bar at the top right: 10 mm, or 5 or 2 mm on a small part
    const bx1 = canvas.width - padX, byb = P(14);
    g.strokeStyle = INK; g.lineWidth = P(4); g.beginPath(); g.moveTo(bx1 - bar, byb); g.lineTo(bx1, byb); g.stroke();
    g.fillStyle = INK; g.font = `${P(14)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(`${mm} mm`, bx1 - bar / 2, byb + P(5));
  }

  function drawSee(canvas, r) {
    const S = PX_PER_MM * r.cellMm, pad = 12;
    canvas.width = Math.round(r.xray.width * S + 2 * pad); canvas.height = Math.round(r.xray.height * S + 2 * pad);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(imageCanvas(r.xray), pad, pad, r.xray.width * S, r.xray.height * S);
  }

  /** The shared legend, drawn at (x, y) across width w; returns its height. */
  function drawLegend(g, n, x, y, w) {
    const items = classLabels(n), size = 22, sw = 26;
    g.font = `${size}px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'left';
    const widths = items.map(([, l]) => sw + 10 + g.measureText(l).width + 34), total = widths.reduce((a, b) => a + b, 0);
    let at = x + Math.max(0, (w - total) / 2);
    items.forEach(([code, label], k) => {
      g.fillStyle = rgb(F.COLORS[code]); g.fillRect(at, y, sw, sw);
      g.fillStyle = INK; g.fillText(label, at + sw + 10, y + sw / 2); at += widths[k];
    });
    return sw;
  }

  function renderResult() {
    const r = result;
    $('figOut').hidden = !r;
    if (!r) return;
    drawCutaway($('figCut'), r); drawSee($('figSee'), r);
    const rec = state.samples.get(r.folder), nb = numbersOf(r, rec), s = r.stats;
    $('figNumbers').textContent = `${numbersLine(nb, r.names)} | doped ${(s.doped_mm3 / 1000).toFixed(2)} cm³: ${pct(s.dense_percent_of_doped)} % dense, ${pct(s.porous_percent_of_doped)} % porous, ${pct(s.clump_percent_of_doped)} % ${r.names.clump}; open pores ${(s.volume_mm3.open_pores / 1000).toFixed(3)} cm³ left out`;
    $('figProv').textContent = `Grid ${(r.cellMm * 1000).toFixed(0)} µm; dense = 1 from ${r.scale.source} (gray ${Math.round(r.scale.denseGray)}, air ${Math.round(r.scale.airGray)}); `
      + `${r.cupping ? `depth cupping divided out (${r.cupping.length} bands)` : 'no cupping correction'}; ${r.clumps} ${r.names.clump}s, ${r.clustered} clustered; doped split ${r.options.classify.split}. `
      + `Dense and gas are shares of the doped volume; gas is enclosed gas only. ${nb.fusedSource === 'weighed' ? `Fused on: part out − doped charge in (weighed).` : `Fused on: ${r.names.base} mass in view from CT (${r.options.baseDensity} g/cm³ at dense = 1); enter the weighed masses to use them instead.`} `
      + `${r.notes.join(' ')} ${r.provenance}`;
  }

  async function savePng(canvas, name) {
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const how = await window.VBStore.saveBlob(state.downloads, name, blob);
    return how === 'declined' ? 'Save canceled.' : how === 'link' ? `Downloaded ${name}.` : `Saved ${name}.`;
  }

  // ---------- figure set (IndexedDB, in-memory when that is unavailable) ----------
  const memory = new Map();
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open('voxelbench-figures', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('set', { keyPath: 'folder' });
        req.onsuccess = () => resolve(req.result); req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbp;
  }
  async function setAll() {
    const d = await db();
    if (!d) return [...memory.values()];
    return new Promise((resolve) => { try { const q = d.transaction('set').objectStore('set').getAll(); q.onsuccess = () => resolve(q.result); q.onerror = () => resolve([...memory.values()]); } catch (e) { resolve([...memory.values()]); } });
  }
  async function setPut(entry) {
    memory.set(entry.folder, entry);
    const d = await db(); if (!d) return;
    await new Promise((resolve) => { try { const t = d.transaction('set', 'readwrite'); t.objectStore('set').put(entry); t.oncomplete = resolve; t.onerror = resolve; } catch (e) { resolve(); } });
  }
  async function setDelete(folder) {
    memory.delete(folder);
    const d = await db(); if (!d) return;
    await new Promise((resolve) => { try { const t = d.transaction('set', 'readwrite'); t.objectStore('set').delete(folder); t.oncomplete = resolve; t.onerror = resolve; } catch (e) { resolve(); } });
  }

  async function addToSet() {
    const r = result;
    if (!r) return;
    const info = window.CT.sampleInfo(r.folder, state.samples), rec = state.samples.get(r.folder);
    const blob = await new Promise((res) => imageCanvas(r.cut).toBlob(res, 'image/png'));
    await setPut({ folder: r.folder, name: info.name, process: info.process, cellMm: r.cellMm, cut: blob, cutW: r.cut.width, cutH: r.cut.height,
      numbers: numbersOf(r, rec), names: r.names, turn: r.turn, added_at: new Date().toISOString(), provenance: r.provenance });
    $('figNote').textContent = `Added ${info.name} to the figure set.`;
    renderSet();
  }

  async function renderSet() {
    const list = (await setAll()).sort((a, b) => a.added_at.localeCompare(b.added_at));
    const table = $('figSet');
    table.textContent = '';
    $('figSetCount').textContent = list.length ? `${list.length} sample${list.length > 1 ? 's' : ''}` : 'empty';
    $('figRowPng').disabled = !list.length; $('figFilm').disabled = !list.length || Boolean(film && film.busy) || !window.MediaRecorder;
    if (!list.length) return;
    const head = table.insertRow();
    for (const h of ['Sample', 'Numbers', '']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    for (const e of list) {
      const tr = table.insertRow();
      tr.insertCell().textContent = `${e.name}${e.process ? ` · ${e.process}` : ''}`;
      tr.insertCell().textContent = numbersLine(e.numbers, e.names);
      const b = document.createElement('button'); b.textContent = 'Remove'; b.addEventListener('click', async () => { await setDelete(e.folder); renderSet(); });
      tr.insertCell().append(b);
    }
  }

  async function imageOf(blob) {
    if (window.createImageBitmap) return createImageBitmap(blob);
    return new Promise((resolve) => { const im = new Image(); im.onload = () => resolve(im); im.src = URL.createObjectURL(blob); });
  }

  /** All samples of the set in a row at one scale, each with its name, run conditions and numbers, the legend and a 10 mm bar. */
  async function drawRow() {
    const list = (await setAll()).sort((a, b) => a.added_at.localeCompare(b.added_at));
    const ims = await Promise.all(list.map((e) => imageOf(e.cut)));
    const size = ims.map((im, k) => [im.width * list[k].cellMm * PX_PER_MM, im.height * list[k].cellMm * PX_PER_MM]);
    const m = document.createElement('canvas').getContext('2d');
    const textW = list.map((e) => { m.font = `600 26px ${FONT}`; const a = m.measureText(e.name).width; m.font = `22px ${FONT}`; const b = m.measureText(e.process || '').width; m.font = `24px ${FONT}`; return Math.max(a, b, m.measureText(numbersLine(e.numbers, e.names)).width); });
    m.font = `22px ${FONT}`;
    const legendW = classLabels(list[list.length - 1].names).reduce((t, [, l]) => t + 26 + 10 + m.measureText(l).width + 34, 0) + 40;
    const cw0 = Math.max(...size.map((s) => s[0]), ...textW) + 60, cw = Math.max(cw0, legendW / list.length);
    const ch = Math.max(...size.map((s) => s[1])), text = 120, legend = 60, bar = 50;
    const c = document.createElement('canvas'); c.width = Math.round(cw * list.length); c.height = Math.round(ch + bar + text + legend + 20);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    list.forEach((e, k) => {
      const [w, h] = size[k], x = k * cw + (cw - w) / 2, y = ch - h;
      g.drawImage(ims[k], x, y, w, h);
      g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = INK;
      g.font = `600 26px ${FONT}`; g.fillText(e.name, k * cw + 30, ch + bar);
      g.fillStyle = MUTE; g.font = `22px ${FONT}`; if (e.process) g.fillText(e.process, k * cw + 30, ch + bar + 34);
      g.fillStyle = INK; g.font = `24px ${FONT}`; g.fillText(numbersLine(e.numbers, e.names), k * cw + 30, ch + bar + 66);
    });
    const L = 10 * PX_PER_MM, x1 = c.width - 30, yb = ch + 20;
    g.strokeStyle = INK; g.lineWidth = 6; g.beginPath(); g.moveTo(x1 - L, yb); g.lineTo(x1, yb); g.stroke();
    g.fillStyle = INK; g.font = `22px ${FONT}`; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText('10 mm', x1 - L - 12, yb);
    drawLegend(g, list[list.length - 1].names, 0, ch + bar + text, c.width);
    return c;
  }

  async function rowPng() {
    const c = await drawRow();
    $('figSetNote').textContent = await savePng(c, 'figure_set_row.png');
  }

  /** Turntable film: the worker renders 120 see-through frames per sample; they are composed into a grid with titles and a
      10 mm bar, then played once into a video (MP4 where the browser records it, else WebM) and looped in the preview. */
  async function makeFilm() {
    const list = (await setAll()).sort((a, b) => a.added_at.localeCompare(b.added_at));
    if (!list.length || (film && film.busy)) return;
    film = { busy: true, frames: [], id: null };
    renderSet();
    $('figSetNote').textContent = 'Rendering the turntable…';
    const cols = list.length === 1 ? 1 : list.length <= 4 ? 2 : 3, rows = Math.ceil(list.length / cols);
    let cell = null, canvas = null;
    const frames = [];
    const onFrame = (d) => {
      if (film.id === null) film.id = d.id; // callWorker numbers its calls; the frames carry that number
      if (d.id !== film.id) return;
      const sized = d.images.map((im, k) => [im.width * list[k].turn.cellMm * PX_PER_MM, im.height * list[k].turn.cellMm * PX_PER_MM]);
      if (!cell) {
        cell = { w: Math.ceil(Math.max(...sized.map((s) => s[0]), (10 * PX_PER_MM + 120) / cols) + 24), h: Math.ceil(Math.max(...sized.map((s) => s[1])) + 24), top: 40 };
        canvas = document.createElement('canvas');
        canvas.width = (cols * cell.w) & ~1; canvas.height = (rows * (cell.h + cell.top) + 30) & ~1;
      }
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
      d.images.forEach((im, k) => {
        const cx = (k % cols) * cell.w, cy = Math.floor(k / cols) * (cell.h + cell.top);
        g.drawImage(imageCanvas(im), cx + (cell.w - sized[k][0]) / 2, cy + cell.top + (cell.h - sized[k][1]) / 2, sized[k][0], sized[k][1]);
        g.fillStyle = INK; g.font = `bold 22px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(list[k].name, cx + 12, cy + 8, cell.w - 24);
      });
      const L = 10 * PX_PER_MM; g.strokeStyle = INK; g.lineWidth = 5; g.beginPath(); g.moveTo(canvas.width - 20 - L, canvas.height - 14); g.lineTo(canvas.width - 20, canvas.height - 14); g.stroke();
      g.font = `18px ${FONT}`; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText('10 mm', canvas.width - 30 - L, canvas.height - 16);
      frames.push(window.createImageBitmap ? createImageBitmap(canvas) : Promise.resolve(g.getImageData(0, 0, canvas.width, canvas.height)));
    };
    on('figureFrame', onFrame);
    try {
      const call = App.callWorker('figureTurn', { grids: list.map((e) => e.turn) });
      await call;
    } catch (e) {
      $('figSetNote').textContent = e.message; film = null; renderSet(); App.off('figureFrame', onFrame); return;
    }
    App.off('figureFrame', onFrame);
    const bitmaps = await Promise.all(frames);
    film.frames = bitmaps;
    const blob = await record(bitmaps, canvas.width, canvas.height);
    film.busy = false;
    preview(bitmaps, canvas.width, canvas.height);
    if (blob) {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      $('figSetNote').textContent = await window.VBStore.saveBlob(state.downloads, `figure_set_turntable.${ext}`, blob).then((how) => (how === 'declined' ? 'Save canceled.' : `Saved figure_set_turntable.${ext}.`));
    } else $('figSetNote').textContent = 'This browser cannot record video; the film plays in the preview.';
    renderSet();
  }
  async function record(bitmaps, w, h) {
    if (!window.MediaRecorder) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), stream = c.captureStream(0), track = stream.getVideoTracks()[0];
    const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) return null;
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 }), chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve) => { rec.onstop = resolve; });
    rec.start();
    for (const b of bitmaps) {
      if (b instanceof ImageData) g.putImageData(b, 0, 0); else g.drawImage(b, 0, 0);
      if (track.requestFrame) track.requestFrame();
      await new Promise((r) => setTimeout(r, 1000 / 24));
    }
    rec.stop(); await done;
    return new Blob(chunks, { type: type.split(';')[0] });
  }

  function preview(bitmaps, w, h) {
    const c = $('figPreview'); c.width = w; c.height = h; c.hidden = false;
    const g = c.getContext('2d'); let k = 0;
    clearInterval(preview.timer);
    preview.timer = setInterval(() => { if (c.hidden || !bitmaps.length) return; const b = bitmaps[k++ % bitmaps.length]; if (b instanceof ImageData) g.putImageData(b, 0, 0); else g.drawImage(b, 0, 0); }, 1000 / 24);
  }

  // ---------- rail ----------
  function render() {
    $('runFigure').disabled = !state.dims || !state.model || busy;
    $('figState').textContent = busy ? 'Making the figure…' : '';
    $('figTag').textContent = result ? 'drawn' : 'optional';
    renderResult();
  }

  on('start', () => {
    loadPrefs();
    $('runFigure').addEventListener('click', run);
    $('figCutPng').addEventListener('click', async () => { $('figNote').textContent = await savePng($('figCut'), `${state.folder}_cutaway.png`); });
    $('figSeePng').addEventListener('click', async () => { $('figNote').textContent = await savePng($('figSee'), `${state.folder}_see_through.png`); });
    $('figAdd').addEventListener('click', addToSet);
    $('figRowPng').addEventListener('click', rowPng);
    $('figFilm').addEventListener('click', makeFilm);
    for (const id of ['figMassIn', 'figMassOut']) $(id).addEventListener('change', saveMasses);
    for (const [id] of PREFS) $(id).addEventListener('change', () => { savePrefs(); if (result && /^figName/.test(id)) { result.names = names(); renderResult(); } });
    renderSet();
  });
  on('loaded', () => { result = null; renderScaleOptions(); renderMasses(); render(); });
  on('modelChanged', render);
  on('recordsChanged', () => { renderScaleOptions(); renderMasses(); });
  App.figure = { drawRow, numbersOf, numbersLine, setAll, lastFilm: () => film };
}(window.CTApp));
