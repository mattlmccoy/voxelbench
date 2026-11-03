/* Batch: every scan in the opened folder in turn: load, segment pores (with its saved run's settings when it has one,
   otherwise the settings at the start of the batch), keep one summary row, and save a run for scans that had none
   (an existing saved run is never overwritten: it may hold reviews, zones, filler or wall results the batch does not
   redo); then a CSV. Opening another scan during the batch ends that scan's row with an error. */
(function (App) {
  'use strict';
  const CT = window.CT, P = window.CTPores, E = window.CTExport, K = window.VBConnectivity;
  const { state, $, on, emit } = App;
  const say = (text) => { $('batchStatus').textContent = text; emit('statusText', `Batch: ${text}`); }; // the start screen hides once a scan loads
  const LOAD_TIMEOUT_MS = 30 * 60 * 1000;
  let rows = [], running = false;

  /** Resolves when test() holds, checked once a second; rejects after the timeout, or as soon as the open scan is no
      longer the batch's (the user opened another one, or the load failed). */
  function until(test, what, folder) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (state.folder !== folder) { clearInterval(tick); reject(new Error(`interrupted: ${state.folder ? `${state.folder} was opened` : 'the scan did not load'}`)); } else if (test()) { clearInterval(tick); resolve(); } else if (Date.now() - started > LOAD_TIMEOUT_MS) { clearInterval(tick); reject(new Error(`timed out waiting for ${what}`)); }
      }, 1000);
    });
  }

  async function runAll() {
    if (running || !state.stacks.length) return;
    running = true; rows = [];
    $('batchRun').disabled = true; $('batchCsv').disabled = true;
    const batchSettings = { ...state.settings }, stacks = [...state.stacks];
    for (const [i, stack] of stacks.entries()) {
      const sample = CT.sampleInfo(stack.folder, state.samples);
      say(`scan ${i + 1} of ${stacks.length}: ${sample.name}`);
      try {
        const saved = state.store ? await state.store.getRun(stack.folder) : null;
        await App.loadStack(stack);
        if (state.folder !== stack.folder) throw new Error('the scan did not load');
        if (!saved) state.settings = { ...batchSettings };
        await until(() => state.model, 'the sample mask', stack.folder);
        App.runDetect();
        await until(() => state.porePhase === 'done' || state.porePhase === 'error', 'segmentation', stack.folder);
        if (state.porePhase === 'error') throw new Error('segmentation failed');
        if (state.store && !saved) {
          await until(() => state.patches !== null, 'the low-density regions', stack.folder); // a run saved before them would lack them
          await App.saveRun();
        }
        const summary = P.summarize(state.pores, state.bodyMm3, state.rejected);
        rows.push(E.batchRow(sample, summary, state.connectivity ? K.openClosed(state.pores, state.bodyMm3, state.rejected) : null,
          { source: saved ? 'saved run (kept)' : 'batch (run saved)', poreThreshold: state.settings.poreThreshold, voxelMm: state.voxelMm, binFactor: state.binFactor }));
      } catch (e) {
        rows.push(E.batchRow(sample, null, null, { error: e.message }));
      }
    }
    running = false;
    $('batchRun').disabled = false; $('batchCsv').disabled = !rows.length;
    const failed = rows.filter((r) => r.error).length;
    say(`done: ${rows.length - failed} of ${rows.length} scans segmented${failed ? `, ${failed} failed (see the table)` : ''}. New runs saved for scans that had none; existing saved runs kept${state.store && state.store.kind === 'file' ? '. Save the project to keep the new runs' : ''}.`);
  }

  async function download() {
    const csv = E.batchCsv(rows, { provenance: App.provenance() });
    const how = await window.VBStore.saveBlob(state.downloads, 'voxelbench_batch.csv', new Blob([csv], { type: 'text/csv' }));
    $('batchStatus').textContent = how === 'declined' ? 'Save canceled.' : 'Saved voxelbench_batch.csv.';
  }

  function render() {
    $('batchRow').hidden = state.stacks.length < 2;
    if (!running) $('batchRun').textContent = `Run all ${state.stacks.length} scans`;
  }

  on('start', () => { $('batchRun').addEventListener('click', runAll); $('batchCsv').addEventListener('click', download); });
  on('samplesChanged', render);
}(window.CTApp));
