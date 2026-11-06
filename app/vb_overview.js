/* The scan overview, between the library and the studio: what is known about one scan without loading its volume. The
   scanner's record, middle slices on XY, XZ and YZ (VOX scans: a few byte ranges of the file; TIFF scans: the middle
   slice only), the latest saved run's results, earlier runs, and the sample's details. Analyze opens the studio. The
   facts are worked out in vb_library.js (overviewFacts, voxRowRange); this file reads the drive and draws. */
(function (App) {
  'use strict';
  const L = window.VBLibrary, LV = window.VBLibraryView, VX = window.VBVox;
  const { state, $, on } = App;
  const PREVIEW_ROWS = 128; // z rows read for the XZ and YZ previews; the rest repeat the nearest
  const cur = { id: null, gen: 0, run: null, runs: [], header: null, unwatch: null };
  const lib = () => App.library;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const say = (text, bad = false) => { const e = $('ovStatus'); e.textContent = text; e.classList.toggle('bad', bad); };
  const row = () => lib().entries.find((r) => r.id === cur.id) || null;
  const record = () => lib().samples.get(cur.id) || null;

  // ---------- facts and results ----------
  function pairs(box, list, empty) {
    box.replaceChildren();
    if (!list.length && empty) { box.append(el('span', 'muted', empty)); return; }
    for (const [k, v] of list) box.append(el('span', '', k), el('span', `v${v === 'not recorded' ? ' muted' : ''}`, v));
  }

  function renderFacts() {
    const r = row();
    if (!r) return;
    const f = L.overviewFacts({ entry: r.entry, scanInfo: r.entry.info || null, header: cur.header, run: cur.run, runs: cur.runs });
    pairs($('ovFacts'), f.rows);
    pairs($('ovResults'), f.results, cur.run === null ? 'No saved run yet. Analyze the scan and press Save run in the studio.' : '');
    const list = $('ovRuns');
    list.replaceChildren(...f.runs.map(({ label }, i) => el('li', '', i === 0 ? `${label} (latest, shown above)` : label)));
    $('ovRunsHead').hidden = !f.runs.length;
    const title = L.cardFacts({ entry: r.entry, record: record(), run: cur.run }).title;
    $('ovTitle').textContent = title;
    $('ovPath').textContent = r.entry.path;
    $('ovAnalyze').disabled = Boolean(r.entry.missing);
    $('ovMissing').hidden = !r.entry.missing;
  }

  // ---------- sample details ----------
  function renderDetails() {
    const rec = record(), r = row();
    if (!r) return;
    const facts = L.cardFacts({ entry: r.entry, record: rec, run: null });
    const fill = { ovName: rec && rec.name && rec.name !== rec.id ? rec.name : '', ovMaterial: (rec && rec.material) || '', ovProcess: (rec && rec.process) || '',
      ovNotes: (rec && rec.notes) || '', ovProject: (rec && rec.project) || '', ovTags: facts.tags.join(', ') };
    for (const [id, value] of Object.entries(fill)) if (document.activeElement !== $(id)) $(id).value = value;
    $('ovStar').textContent = facts.starred ? '★' : '☆';
    $('ovStar').setAttribute('aria-pressed', String(facts.starred));
    $('ovStar').setAttribute('aria-label', facts.starred ? 'Unstar this scan' : 'Star this scan');
    $('ovSaveState').textContent = rec ? 'saved' : 'not described yet';
    $('ovTitle').textContent = facts.title;
    App.emit('overviewChanged');
  }

  function saveDetails() {
    const v = (id) => $(id).value.trim();
    LV.saveScanRecord(cur.id, { name: v('ovName') || cur.id, material: v('ovMaterial'), process: v('ovProcess'), notes: v('ovNotes'), project: v('ovProject') || null, tags: L.parseTags($('ovTags').value) });
  }

  // ---------- previews ----------
  const PLANES = [['XY', 'ovXY', 'Top (x across, y down)'], ['XZ', 'ovXZ', 'Side (x across, z up)'], ['YZ', 'ovYZ', 'End (y across, z up)']];

  function draw(id, image) {
    const c = $(id), img = LV.thumbImage(image);
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
    c.hidden = false;
    $(`${id}Note`).textContent = '';
  }

  const bytesOf = async (file, [a, b]) => file.slice(a, b).arrayBuffer();

  /** One preview plane of a VOX scan: PREVIEW_ROWS z rows are read; every pixel row takes the nearest one read. */
  async function voxPlane(file, h, plane, gen) {
    const index = plane === 'XZ' ? h.ny >> 1 : h.nx >> 1, width = plane === 'XZ' ? h.nx : h.ny;
    const k = Math.min(PREVIEW_ROWS, h.nz), rows = new Map();
    for (let i = 0; i < k; i++) {
      const z = Math.min(h.nz - 1, Math.floor(((i + 0.5) * h.nz) / k));
      const values = VX.sliceValues(await bytesOf(file, L.voxRowRange(h, plane, index, z)), h);
      if (gen !== cur.gen) return null;
      rows.set(z, plane === 'XZ' ? values : Uint16Array.from({ length: width }, (_, y) => values[y * h.nx]));
    }
    const zs = [...rows.keys()], pixels = new Uint16Array(width * h.nz);
    for (let z = 0, j = 0; z < h.nz; z++) {
      while (j + 1 < zs.length && Math.abs(zs[j + 1] - z) <= Math.abs(zs[j] - z)) j++;
      pixels.set(rows.get(zs[j]), (h.nz - 1 - z) * width); // z up: slice 0 at the bottom
    }
    return { width, height: h.nz, pixels };
  }

  async function loadPreviews(gen) {
    const r = row();
    for (const [, id] of PLANES) { $(id).hidden = true; $(`${id}Note`).textContent = ''; }
    if (!r || r.entry.missing) { $('ovXYNote').textContent = 'The scan was not found at the last Rescan, so there is no preview.'; return; }
    $('ovXYNote').textContent = 'Reading the middle slice…';
    try {
      const stack = await LV.stackFor(cur.id);
      if (gen !== cur.gen) return;
      if (stack.kind === 'vox') {
        const h = VX.parseVoxHeader(new Uint8Array(await bytesOf(stack.vox, [0, VX.HEADER_MAX])));
        cur.header = h;
        renderFacts();
        const [start, end] = L.voxRowRange(h, 'XY', h.nz >> 1, 0);
        draw('ovXY', { width: h.nx, height: h.ny, pixels: VX.sliceValues(await bytesOf(stack.vox, [start, end]), h) });
        if (gen !== cur.gen) return;
        for (const [plane, id] of PLANES.slice(1)) {
          $(`${id}Note`).textContent = 'Reading…';
          const image = await voxPlane(stack.vox, h, plane, gen);
          if (!image || gen !== cur.gen) return;
          draw(id, image);
        }
      } else {
        const reader = await App.openReader(stack);
        const middle = await reader.read(reader.count >> 1);
        if (gen !== cur.gen) return;
        draw('ovXY', middle);
        for (const [, id] of PLANES.slice(1)) $(`${id}Note`).textContent = 'XZ and YZ after Analyze';
      }
    } catch (e) {
      if (gen === cur.gen) $('ovXYNote').textContent = `No preview: ${e.message}`;
    }
  }

  // ---------- opening ----------
  async function loadRuns(gen) {
    cur.run = null; cur.runs = [];
    say('Checking for saved runs…');
    try {
      const listed = await lib().store.listRuns(cur.id);
      const run = listed.length ? await lib().store.getRun(cur.id) : null;
      if (gen !== cur.gen) return;
      cur.runs = listed; cur.run = run;
      say('');
    } catch (e) {
      if (gen === cur.gen) say(`The saved runs could not be read: ${e.message}`, true);
    }
    if (gen === cur.gen) renderFacts();
  }

  function openOverview(id) {
    if (!lib().entries.some((r) => r.id === id)) return;
    if (cur.unwatch) cur.unwatch();
    Object.assign(cur, { id, gen: cur.gen + 1, run: null, runs: [], header: null });
    const gen = cur.gen;
    cur.unwatch = lib().store.watch('samples', () => { if (gen === cur.gen) { renderDetails(); renderFacts(); } });
    App.showPage('overview');
    renderFacts(); renderDetails();
    loadRuns(gen);
    loadPreviews(gen);
  }

  function wire() {
    for (const [, id, caption] of PLANES) {
      const fig = el('figure');
      const canvas = el('canvas'); canvas.id = id; canvas.hidden = true;
      canvas.setAttribute('aria-label', caption);
      const note = el('p', 'muted ovnote'); note.id = `${id}Note`;
      fig.append(canvas, note, el('figcaption', '', caption));
      $('ovPreviews').append(fig);
    }
    $('ovBack').addEventListener('click', () => App.showPage('library'));
    $('ovAnalyze').addEventListener('click', () => LV.openScan(cur.id));
    $('ovStar').addEventListener('click', () => { const rec = record(); LV.saveScanRecord(cur.id, { starred: !(rec && rec.starred) }); });
    $('ovSave').addEventListener('click', saveDetails);
  }

  on('start', wire);
  on('pageChanged', (page) => { if (page !== 'overview' && cur.unwatch) { cur.unwatch(); cur.unwatch = null; cur.gen++; } });
  // The scan the overview shows, for the parts of the page that act on a scan's record (Archimedes).
  App.overview = { id: () => cur.id, record, save: (changes) => LV.saveScanRecord(cur.id, changes) };
  App.openOverview = openOverview;
}(window.CTApp));
