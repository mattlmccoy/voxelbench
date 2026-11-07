/* Scan information > Orientation: level a part scanned at an angle. Level the part reads the sample mask from the
   worker and takes the part's axes from it (long axis x, thinnest z); the sliders, Flip over and Turn 90° adjust them
   while three small previews show the leveled scan through the part's center. Apply saves the orientation with the
   sample and reopens the scan, which is then rebuilt in the part's frame (ct_app.js loadStack); Back to scan axes
   removes it. A scan leveled before holder removal (its orientation lacks holder_removed) opens in scan axes once and is
   leveled again here from the holder-free mask (keeping its flips and turns when the axes stayed close), then reopened
   with a one-time note. Both levelings save the scan-axes holder with the sample (carryHolder), so the leveled build
   uses it instead of finding the holder again on a grid that keeps only stubs of it.
   The math is in vb_orient.js. */
(function (App) {
  'use strict';
  const O = window.VBOrient, CT = window.CT;
  const { state, $, on, emit } = App;
  const MARGIN_MM = 2; // air kept around the part in the leveled grid
  const SLIDERS = [['rx', 'orientRx'], ['ry', 'orientRy'], ['rz', 'orientRz']];
  let draft = null; // { base, center, pts, bin, ambiguous } while leveling
  let busy = false, frame = 0;
  let relevelShown = null; // { token, text }: the one-time note for the scan reopened after an automatic re-level

  const angles = () => Object.fromEntries(SLIDERS.map(([k, id]) => [k, Number($(id).value)]));
  /** The orientation the sliders describe, with its grid around the part. */
  function current() {
    const R = O.nudge(draft.base, angles());
    return { R, center: draft.center, ...O.gridForPoints({ R, center: draft.center }, draft.pts, draft.bin, margin()) };
  }
  const margin = () => Math.round(MARGIN_MM / state.voxelMm);
  /** The scan-axes holder to save with a leveling ({ holder: record }, or {}): the leveled grid keeps only the part plus
      MARGIN_MM, too little of a stand to find it again, so the leveled build uses these pieces (vb_holderreview.js
      carriedRecord: not reviewed; never over a saved review, which maps into the new frame as it is). Call it with the
      open scan's state current: after an await, only once the load token and folder are checked. */
  function carryHolder() {
    const record = !state.holderError && !state.holderWait && window.VBHolderReview.carriedRecord(state.holder, App.sampleNow().holder || null);
    return record ? { holder: record } : {};
  }
  /** The part's axes from the worker's sample mask (holder removed), with its surface points for the leveled grid. */
  async function partAxes() {
    const r = await App.callWorker('partMask', App.bodyArgs());
    const L = O.levelFromMask(r.mask, r.dims, r.bin);
    return { R: L.R, center: L.center, ambiguous: L.ambiguous, pts: O.surfacePoints(r.mask, r.dims, r.bin), bin: r.bin };
  }

  // While leveling, the rail widens (VBSkin.levelingRailWidth) and html.leveling puts the three previews side by side,
  // so the previews and the sliders fit on screen together; the viewer's own width comes back afterwards.
  let railBefore = null; // the page's --rail-w before leveling widened it ('' when none was set)
  function widenRail(wide) {
    const root = document.documentElement;
    if (wide === (railBefore !== null)) return;
    if (wide) {
      railBefore = root.style.getPropertyValue('--rail-w');
      root.style.setProperty('--rail-w', `${window.VBSkin.levelingRailWidth($('rail').getBoundingClientRect().width, window.innerWidth)}px`);
    } else {
      if (railBefore) root.style.setProperty('--rail-w', railBefore); else root.style.removeProperty('--rail-w');
      railBefore = null;
    }
    root.classList.toggle('leveling', wide);
    window.dispatchEvent(new Event('resize')); // the views refit their canvases, as after dragging the rail's grip
  }

  function render() {
    const leveled = Boolean(state.orientation), waiting = Boolean(state.relevel);
    // Marks of a leveling a re-level replaced (or is about to) can never be shown again; the note says so apart.
    const replaced = state.folder ? [...(App.sampleNow().replaced_frames || []), ...(state.relevel ? [O.orientId(state.relevel.from)] : [])] : [];
    const hidden = state.folder ? O.hiddenMarksNote(App.hiddenFrames(state.folder), replaced) : '';
    $('orientState').textContent = leveled ? 'leveled' : 'scan axes';
    $('orientLevel').disabled = !state.folder || !state.model || busy || leveled || waiting;
    $('orientLevel').hidden = leveled || Boolean(draft); // the editor below replaces it while leveling
    $('orientReset').hidden = !leveled;
    $('orientReset').disabled = busy;
    $('orientEdit').hidden = !draft;
    widenRail(Boolean(draft));
    const d = state.dims, mm = (n) => (n * state.voxelMm).toFixed(1);
    const parts = [];
    if (leveled) parts.push(`Leveled in the part's frame: x is the long axis, z the thinnest direction (up). The leveled scan is ${mm(d.nx)} × ${mm(d.ny)} × ${mm(d.nz)} mm with ${MARGIN_MM} mm of air around the part; everything outside the original scan reads gray 0. Saved with the sample, so reopening the scan levels it again.`);
    if (relevelShown && relevelShown.token === state.loadToken) parts.push(relevelShown.text);
    if (waiting) parts.push('This scan was leveled with the holder still in its sample mask. It opened in scan axes and is leveled again without the holder once the mask is built.');
    else if (!leveled && state.folder && !draft) parts.push('A part scanned at an angle can be leveled: its long axis to x, its thinnest direction to z (up), so depth, sections and wall thickness follow the part. The part\'s axes come from its sample mask.');
    if (hidden) parts.push(hidden);
    if (parts.length) $('orientNote').textContent = parts.join(' ');
  }

  /** Draws one leveled plane through the part's center into a preview canvas, in the page's gray window. */
  function drawPreview(id, plane, orient) {
    const index = Math.floor((plane === 'XY' ? orient.dims.nz : plane === 'XZ' ? orient.dims.ny : orient.dims.nx) / 2);
    const p = O.samplePlane({ slices: state.slices, dims: state.dims, circle: state.circle, orient, plane, index });
    const canvas = $(id);
    canvas.width = p.width; canvas.height = p.height;
    const img = new ImageData(p.width, p.height);
    CT.grayToRgba(p.pixels, state.window.low, state.window.high, img.data);
    canvas.getContext('2d').putImageData(img, 0, 0);
  }

  // The previews follow the sliders at most once per frame.
  function preview() {
    if (!draft || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!draft) return;
      const orient = current();
      drawPreview('orientXZ', 'XZ', orient); drawPreview('orientYZ', 'YZ', orient); drawPreview('orientXY', 'XY', orient);
      for (const [k, id] of SLIDERS) $(`${id}Out`).textContent = `${angles()[k]}°`;
      const d = orient.dims, mm = (n) => (n * state.voxelMm).toFixed(1), gb = (2 * (d.nx * d.ny * d.nz + state.dims.nx * state.dims.ny * state.dims.nz)) / 1e9;
      const room = O.fits({ loaded: state.dims, out: d, limit: App.orientLimit() });
      const unsure = draft.ambiguous.length ? ` The part's ${draft.ambiguous.join(', ')} extents are within 10 % of each other, so those axes are a guess: check the previews.` : '';
      $('orientSize').textContent = `Leveled scan ${mm(d.nx)} × ${mm(d.ny)} × ${mm(d.nz)} mm; ${gb.toFixed(2)} GB while it is built${room ? '' : `, more than this browser allows (${(App.orientLimit() / 1e9).toFixed(1)} GB): reopening will bin the scan further`}.${unsure}`;
    });
  }

  async function level() {
    busy = true; render();
    emit('statusText', 'Finding the part\'s axes from its sample mask');
    try {
      const a = await partAxes();
      draft = { base: a.R, center: a.center, pts: a.pts, bin: a.bin, ambiguous: a.ambiguous };
      for (const [, id] of SLIDERS) $(id).value = '0';
      $('orientBox').open = true; // the previews are inside it
      $('orientNote').textContent = 'Preview: the side and end views should show the part lying flat, its top face up. Nudge with the sliders, Flip over if it is upside down, Turn 90° if its long side runs the wrong way. Apply rebuilds the scan in this frame and restarts the analysis.';
      emit('statusText', 'Part axes found: check the previews, then Apply');
    } catch (e) {
      emit('statusText', `Could not level the part: ${e.message}`);
    } finally {
      busy = false; render(); preview();
      if (draft) $('orientBox').scrollIntoView({ block: 'start' }); // the editor from its top: previews, then sliders
    }
  }

  /** Saves the orientation (native voxels) with the sample, then reopens the scan so it is rebuilt leveled. */
  function apply() {
    if (!draft) return;
    const orient = current();
    App.saveSample({ orientation: { ...O.toNative(orient, state.binFactor), angles_deg: angles(), holder_removed: true, method: 'principal axes of the sample mask, then nudged', made_at: new Date().toISOString() }, ...carryHolder() });
    draft = null;
    App.loadStack(state.stack);
  }

  /** The automatic re-level, on the first model of a scan opened in scan axes for it (ct_app.js loadStack sets
      state.relevel = { from, token }): the same axes as Level the part, turned and flipped as the old leveling was (O.matchTurns),
      saved with the old one's date and angles, then the scan is reopened leveled. Another scan opened meanwhile ends it. */
  async function relevel() {
    const job = state.relevel;
    if (!job || job.token !== state.loadToken || !state.model || !state.holder) return;
    state.relevel = null; // once per load
    const { from, token } = job, folder = state.folder, stack = state.stack, failed = state.holder.failed || null;
    busy = true; render();
    emit('statusText', 'Leveling the part again, without the holder');
    try {
      const a = await partAxes();
      if (token !== state.loadToken || folder !== state.folder) return;
      const { R, kept } = O.matchTurns(a.R, from.R);
      const orient = { R, center: a.center, ...O.gridForPoints({ R, center: a.center }, a.pts, a.bin, margin()) };
      const text = O.relevelNote(O.axisChange(from.R, R), from, { failed, turnsKept: kept });
      App.saveSample({ orientation: O.releveled(from, O.toNative(orient, state.binFactor), new Date().toISOString()), replaced_frames: O.withReplaced(App.sampleNow().replaced_frames, O.orientId(from)), ...carryHolder() }, folder);
      const reopened = App.loadStack(stack);
      relevelShown = { token: state.loadToken, text }; // loadStack took its token synchronously
      await reopened;
      if (relevelShown.token !== state.loadToken) return;
      // Added to, not over, what the reopened load said (a saved run from another orientation, not restored).
      const said = state.noteLoad === state.loadToken ? $('projectNote').textContent : '';
      App.projectNote(said ? `${text} ${said}` : text);
      $('orientBox').open = true;
      render();
    } catch (e) {
      if (token === state.loadToken) emit('statusText', `Could not level the part again without the holder (${e.message}). It stays in scan axes; reopening the scan tries again.`);
    } finally {
      busy = false;
      if (token === state.loadToken) render();
    }
  }

  function reset() {
    App.saveSample({ orientation: null });
    draft = null;
    App.loadStack(state.stack);
  }

  function adjust(fn) { draft.base = fn(draft.base); preview(); }

  on('start', () => {
    $('orientLevel').addEventListener('click', level);
    $('orientReset').addEventListener('click', reset);
    $('orientApply').addEventListener('click', apply);
    $('orientCancel').addEventListener('click', () => { draft = null; render(); });
    $('orientFlip').addEventListener('click', () => adjust(O.flip));
    $('orientTurn').addEventListener('click', () => adjust(O.turn));
    $('orientZero').addEventListener('click', () => { for (const [, id] of SLIDERS) $(id).value = '0'; preview(); });
    for (const [, id] of SLIDERS) $(id).addEventListener('input', preview);
  });
  on('loaded', () => { draft = null; if (relevelShown && relevelShown.token !== state.loadToken) relevelShown = null; render(); });
  on('modelChanged', relevel);
  for (const e of ['modelChanged', 'recordsChanged', 'samplesChanged']) on(e, render);
}(window.CTApp));
