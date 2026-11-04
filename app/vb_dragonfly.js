/* Step 4, Cross-check with Dragonfly 3D, in the page: the kit download (counting region and VoxelBench's pores as TIFF
   slices plus kit.json, in one zip) and the comparison with the pore mask Dragonfly exports. The masks are read page by
   page into runs, so a large stack never sits in memory as voxels; the counting region lives in the worker, which does
   the comparison. Protocol: docs/DRAGONFLY_CROSSCHECK.md. */
(function (App) {
  'use strict';
  const CT = window.CT, P = window.CTPores, M = window.VBMasks, E = window.CTExport;
  const { state, $, on, emit } = App;
  const SMALL_MM3 = 0.01; // pores under this count as small in the comparison (as in tools/crosscheck)
  const OTHER = 'Dragonfly';
  let last = null; // { result, files, at } of the last comparison, for the JSON save
  const keep = (v) => { last = v; state.crosscheck = v ? { result: v.result, other: OTHER } : null; }; // also for the review sheet
  let busy = false;

  const say = (t) => { $('dfStatus').textContent = t; };
  const sliceName = (prefix, z) => `${prefix}_${String(z).padStart(4, '0')}.tif`;
  const settingsUsed = () => state.poreRunSettings || state.settings;

  function render() {
    const ready = Boolean(state.folder && state.pores && !busy);
    $('dfKit').disabled = !ready; $('dfLoad').disabled = !ready;
    if (!state.pores && !busy) say(state.folder ? 'Segment pores (step 2) first: the kit and the comparison use that segmentation.' : '');
  }

  function clearResult(note) {
    keep(null);
    $('dfResult').hidden = true;
    if (note) say(note);
  }

  async function downloadKit() {
    busy = true; render();
    try {
      say('Collecting the counting region and the pore voxels');
      const r = await App.callWorker('regionRuns', { rejected: [...state.rejected] });
      const { nx, ny, nz } = state.dims;
      const summary = P.summarize(state.pores, state.bodyMm3, state.rejected);
      const info = { ...M.kitInfo({ dims: state.dims, voxelMm: state.voxelMm, bin: App.BIN, settings: settingsUsed(), bodyMm3: state.bodyMm3, porosityPercent: summary.all_void_percent_of_body,
        voidCount: state.pores.length - state.rejected.size, rejectedCount: state.rejected.size, poreVoxels: r.poreVoxels, regionVoxels: r.regionVoxels }),
      created_at: new Date().toISOString(), made_by: 'VoxelBench page', loaded_bin_factor: state.binFactor, scan_files: { count: nz * state.binFactor } };
      async function* files() {
        yield { name: 'kit.json', bytes: new TextEncoder().encode(`${JSON.stringify(info, null, 2)}\n`) };
        for (const [sub, prefix, runs] of [['region', 'region', r.region], ['voxelbench_pores', 'pores', r.pores]]) {
          for (let z = 0; z < nz; z++) {
            if (z % 25 === 0) say(`Writing ${sub} slices: ${z} of ${nz}`);
            yield { name: `${sub}/${sliceName(prefix, z)}`, bytes: new Uint8Array(M.writeMaskTiff(nx, ny, M.runsSlice(runs, state.dims, z), state.voxelMm)) };
          }
        }
      }
      const blob = await E.zipFiles(files());
      const name = `${state.folder}_dragonfly_kit.zip`;
      const how = await window.VBStore.saveBlob(state.downloads, name, blob);
      const binned = state.binFactor > 1 ? ` The scan is loaded binned ${state.binFactor}×: bin it the same way in Dragonfly, so the masks line up.` : '';
      say(how === 'declined' ? 'Kit not saved.' : `Kit saved: ${name} (${(blob.size / 1e6).toFixed(1)} MB; ${nz} slices of ${nx} × ${ny}; porosity ${summary.all_void_percent_of_body.toFixed(3)} %).${binned} Next: run the protocol in Dragonfly, then load its mask here.`);
    } catch (e) {
      say(`Could not make the kit: ${e.message}`);
    } finally { busy = false; render(); }
  }

  /** Reads the chosen TIFF files (one multi-page stack, or one file per slice) into runs, page by page. */
  async function readMask(files) {
    const byName = new Map([...files].map((f) => [f.name, f]));
    const ordered = CT.sliceOrder([...byName.keys()]).map((n) => byName.get(n));
    if (!ordered.length) throw new Error('Choose TIFF files (.tif or .tiff).');
    const { nx, ny, nz } = state.dims;
    const b = M.runsBuilder(state.dims);
    let voxelMm = null;
    for (const [k, f] of ordered.entries()) {
      if (k % 25 === 0 || ordered.length === 1) say(`Reading ${OTHER}'s mask: ${ordered.length === 1 ? f.name : `file ${k + 1} of ${ordered.length}`}`);
      M.eachMaskPage(await f.arrayBuffer(), (page) => {
        if (page.width !== nx || page.height !== ny) throw new Error(`The mask's pages are ${page.width} × ${page.height}; this scan's slices are ${nx} × ${ny}. Export the mask over the whole scan, at the loaded resolution.`);
        if (voxelMm === null) voxelMm = page.voxelMm;
        b.add(page.pixels);
      });
      if (b.slices > nz) break;
    }
    return { runs: b.done(), voxelMm, files: ordered.map((f) => f.name) };
  }

  async function loadMask(fileList) {
    busy = true; render(); clearResult();
    try {
      const mask = await readMask(fileList);
      say('Comparing the masks');
      const transfer = [mask.runs.offsets.buffer, mask.runs.start.buffer, mask.runs.end.buffer];
      const reply = await App.callWorker('crosscheck', { runs: mask.runs, rejected: [...state.rejected], bodyMm3: state.bodyMm3, smallMm3: SMALL_MM3 }, transfer);
      keep({ result: reply.result, files: mask.files, at: new Date().toISOString(), voxelMm: mask.voxelMm });
      show(reply.result, mask.voxelMm);
      const turned = reply.result.orientation ? ' The mask was turned back to the scan\'s orientation first (see below).' : '';
      say(`Compared with ${mask.files.length === 1 ? mask.files[0] : `${mask.files.length} files`}.${turned}`);
    } catch (e) {
      say(`Could not compare: ${e.message}`);
    } finally { busy = false; render(); }
  }

  function show(result, maskVoxelMm) {
    const read = M.crosscheckRead(result, OTHER);
    const rows = $('dfRows');
    rows.textContent = '';
    for (const [k, v] of read.rows) {
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
      rows.append(a, b);
    }
    const insights = [...read.insights];
    if (Number.isFinite(maskVoxelMm) && Math.abs(maskVoxelMm - state.voxelMm) > 0.01 * state.voxelMm) {
      insights.push(`The mask says its voxels are ${(1000 * maskVoxelMm).toFixed(2)} µm; this scan is loaded at ${(1000 * state.voxelMm).toFixed(2)} µm. The comparison is voxel by voxel, so check that both use the same grid.`);
    }
    const list = $('dfInsights');
    list.textContent = '';
    for (const t of insights) { const li = document.createElement('li'); li.textContent = t; list.append(li); }
    renderLargest(result);
    $('dfResult').hidden = false;
  }

  /** The biggest pores one tool found alone; a row jumps the views to it. */
  function renderLargest(result) {
    const rows = [...result.largest_only_a.map((p) => ({ ...p, who: 'VoxelBench' })), ...result.largest_only_b.map((p) => ({ ...p, who: OTHER }))]
      .sort((p, q) => q.voxels - p.voxels).slice(0, 10);
    const table = $('dfLargest');
    table.textContent = '';
    $('dfLargestWrap').hidden = !rows.length;
    if (!rows.length) return;
    const head = table.insertRow();
    for (const h of ['Found only by', 'mm³', 'x, y, z (mm)']) { const th = document.createElement('th'); th.textContent = h; head.append(th); }
    const mm = (v) => (v * state.voxelMm).toFixed(2);
    for (const p of rows) {
      const tr = table.insertRow();
      tr.className = 'pick';
      tr.title = 'Show it in the views';
      const who = tr.insertCell(); who.textContent = p.who; who.style.textAlign = 'left';
      tr.insertCell().textContent = (p.voxels * state.voxelMm ** 3).toFixed(4);
      tr.insertCell().textContent = `${mm(p.x)}, ${mm(p.y)}, ${mm(p.z)}`;
      tr.addEventListener('click', () => emit('jump', { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }));
    }
  }

  async function saveComparison() {
    if (!last) return;
    const body = { format: 'voxelbench-crosscheck/1', sample: state.folder, other: OTHER, compared_at: last.at, mask_files: { count: last.files.length, first: last.files[0], last: last.files[last.files.length - 1] },
      mask_voxel_mm: last.voxelMm, scan: { dims: state.dims, voxel_mm: state.voxelMm, loaded_bin_factor: state.binFactor }, settings: settingsUsed(), small_mm3: SMALL_MM3, comparison: last.result };
    const how = await window.VBStore.saveBlob(state.downloads, `${state.folder}_comparison_dragonfly.json`, new Blob([`${JSON.stringify(body, null, 2)}\n`], { type: 'application/json' }));
    if (how !== 'declined') say('Comparison saved.');
  }

  on('start', () => {
    $('dfKit').addEventListener('click', downloadKit);
    $('dfLoad').addEventListener('click', () => $('dfFile').click());
    $('dfFile').addEventListener('change', (e) => { if (e.target.files.length) loadMask(e.target.files); e.target.value = ''; });
    $('dfSave').addEventListener('click', saveComparison);
  });
  on('loaded', () => { clearResult(''); render(); });
  on('poresChanged', () => {
    if (last && state.porePhase === 'running') clearResult('Pores are being segmented again: load the mask again afterwards.');
    render();
  });
}(window.CTApp));
