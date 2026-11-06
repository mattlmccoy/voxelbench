/* The studio's checklist for the open scan, at the top of the rail: the core path in order, each step marked done from
   its own result, the next required step highlighted, and the specialist steps under "More analyses". A click opens the
   step's rail section (and, for a step that shares a section, scrolls to its block). Also the studio's top bar around
   it: Back (to the scan's overview for a library scan, else to the library), Save run and Review sheet, the other
   exports and the bookmarks; and, for a library scan, its name with a link to the overview in place of the sample form. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBChecklist = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The core path. anchor: the block inside a shared section that the step scrolls to.
  const STEPS = [
    { id: 'scan', section: 'secScan', label: 'Scan info', optional: false, done: (s) => Boolean(s.scanInfo) },
    { id: 'level', section: 'secScan', label: 'Level the part', optional: true, anchor: 'orientBox', done: (s) => Boolean(s.leveled) },
    { id: 'crop', section: 'step1', label: 'Crop out holder & bag', optional: false, done: (s) => Boolean(s.crops && s.crops.length > 0) },
    { id: 'pores', section: 'step2', label: 'Segment pores', optional: false, done: (s) => s.pores != null }, // [] is a result: no pores found
    { id: 'regions', section: 'step3', label: 'Measure regions', optional: true, anchor: 'regionBlock', done: (s) => Boolean(s.regions && s.regions.length > 0) },
    { id: 'density', section: 'step5', label: 'Density reference', optional: false, done: (s) => s.dense > 0 },
    { id: 'sheet', section: 'step4', label: 'Review sheet', optional: false, done: (s) => Boolean(s.sheetSaved) },
  ];

  /** The specialist steps, folded under "More analyses". */
  const MORE = [
    { id: 'zones', section: 'step3', label: 'zones' },
    { id: 'cad', section: 'step6', label: 'CAD' },
    { id: 'filler', section: 'step7', label: 'filler' },
    { id: 'walls', section: 'step8', label: 'walls' },
    { id: 'dragonfly', section: 'step4', label: 'Dragonfly', anchor: 'dfPanel' },
  ];

  /** The checklist for one scan: [{ id, section, label, optional, done, anchor? }] in path order.
      scanInfo: the sample is described; leveled: the part is in its own frame; crops: crop outlines; pores: the
      segmented pores (null before segmentation); regions: measured regions; dense: density references (a relative scale
      per dense material plus a phantom calibration); sheetSaved: a review sheet was saved for this scan. */
  function checklist(status) {
    return STEPS.map(({ done, ...step }) => ({ ...step, done: done(status) }));
  }

  /** The step to do next: the first required step not done (optional steps never block it); null when all are done. */
  function nowStep(items) {
    const next = items.find((i) => !i.optional && !i.done);
    return next ? next.id : null;
  }

  /** Whether a sample is described: a name other than its folder, a material or a process. */
  function described(info) {
    if (!info) return false;
    return Boolean((info.name && info.name !== info.folder) || info.material || info.process);
  }

  /** Scan info is done when the scanner's record was read (its kV or voxel size) or the sample is described. */
  function scanInfoDone(record, sample) {
    return Boolean(record && (Number.isFinite(record.kv) || Number.isFinite(record.voxelUm))) || described(sample);
  }

  /** Where the studio's Back goes: an open library scan's overview (the store is the library and a scan is open),
      else the library. */
  function backTarget(storeKind, folder) {
    return storeKind === 'library' && folder
      ? { page: 'overview', label: '‹ Overview', title: "Back to this scan's overview" }
      : { page: 'library', label: '‹ Library', title: 'Back to the scan library' };
  }

  /** The scan in one line for the top bar: kV, scan time and the scan's voxel, each left out when not recorded.
      duration formats seconds (VBVox.duration). */
  function scanFacts(info, voxelMm, duration) {
    const um = Number.isFinite(voxelMm) && voxelMm > 0 ? voxelMm * 1000 : null;
    return [info && Number.isFinite(info.kv) && `${info.kv} kV`, info && Number.isFinite(info.scanSeconds) && duration(info.scanSeconds),
      um !== null && `${um.toFixed(um < 10 ? 2 : 1)} µm`].filter(Boolean).join(' · ');
  }

  // ---------- drawing (browser only) ----------

  /** Mirrors a control's disabled state onto its copy in the top bar. */
  function mirrorDisabled(source, copy) {
    const sync = () => { copy.disabled = source.disabled; };
    new MutationObserver(sync).observe(source, { attributes: true, attributeFilter: ['disabled'] });
    sync();
  }

  /** Draws the checklist into the rail and wires the studio's top bar. show(id) opens one rail section. */
  function wire({ doc, app, rail, show }) {
    const { state, $, on } = app;
    const CT = window.CT, R = window.CTRegions;

    function status() {
      const folder = state.folder;
      if (!folder) return { scanInfo: false, leveled: false, crops: [], pores: null, regions: [], dense: 0, sheetSaved: false };
      const fit = app.calibration();
      return {
        scanInfo: scanInfoDone(state.scanInfo, CT.sampleInfo(folder, state.samples)), // the scanner record, or saved details
        leveled: Boolean(state.orientation),
        crops: app.cropsOf(folder),
        pores: state.pores,
        regions: app.regionsOf(folder).filter((r) => !R.isReference(r.label)),
        dense: app.relative().length + (fit && fit.ok ? 1 : 0),
        sheetSaved: Boolean(state.sheetSaved),
      };
    }

    // The list: one button per step (number or ✓, label, "(optional)"), then the More analyses line.
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const nav = el('nav', 'checklist');
    nav.setAttribute('aria-label', 'This scan');
    const list = el('ol', 'clsteps');
    const buttons = new Map();
    STEPS.forEach((step, k) => {
      const b = el('button', 'clstep');
      b.type = 'button'; b.dataset.item = step.id;
      const n = el('span', 'n', String(k + 1));
      n.setAttribute('aria-hidden', 'true');
      b.append(n, el('span', 'cllabel', step.label));
      if (step.optional) b.append(' ', el('span', 'clopt', '(optional)'));
      const li = el('li'); li.append(b); list.append(li);
      buttons.set(step.id, { b, n, k, step });
    });
    const more = el('p', 'clmore');
    more.append(el('span', 'clmorelabel', 'More analyses ▸'), ' ');
    const moreButtons = new Map();
    MORE.forEach((m, k) => {
      if (k) { const sep = el('span', 'clsep', ' · '); sep.setAttribute('aria-hidden', 'true'); more.append(sep); }
      const b = el('button', 'clmorelink', m.label);
      b.type = 'button'; b.dataset.more = m.id;
      more.append(b); moreButtons.set(m.id, { b, step: m });
    });
    nav.append(el('h5', 'clhead', 'This scan'), list, more);
    rail.prepend(nav);

    let picked = null; // the entry last opened from here, for marking which one the open section belongs to
    function go(entry) {
      picked = entry.id;
      show(entry.section);
      const a = entry.anchor && $(entry.anchor);
      if (a) { if (a.tagName === 'DETAILS') a.open = true; a.scrollIntoView({ block: 'start' }); }
      refresh();
    }
    app.openStep = (section, anchor) => go({ id: null, section, anchor }); // the result card's "Open in the … table"
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const entry = b.dataset.item ? buttons.get(b.dataset.item).step : b.dataset.more ? moreButtons.get(b.dataset.more).step : null;
      if (entry) go(entry);
    });

    function refresh() {
      const items = checklist(status()), now = nowStep(items);
      const open = (id) => { const d = $(id); return Boolean(d && d.open); };
      const entries = [...items, ...MORE];
      const current = entries.find((e) => e.id === picked && open(e.section)) || entries.find((e) => open(e.section)) || null;
      for (const item of items) {
        const { b, n, k } = buttons.get(item.id);
        b.dataset.state = item.done ? 'done' : item.id === now ? 'now' : '';
        n.textContent = item.done ? '✓' : String(k + 1);
        b.setAttribute('aria-label', `${item.label}${item.optional ? ', optional' : ''}${item.done ? ', done' : item.id === now ? ', next' : ''}`);
        b.setAttribute('aria-current', String(Boolean(current && current.id === item.id)));
      }
      for (const [id, { b }] of moreButtons) b.setAttribute('aria-current', String(Boolean(current && current.id === id)));
    }

    // ---------- the top bar and the sample details ----------
    const back = $('studioBack');
    const target = () => backTarget(state.store && state.store.kind, state.folder);
    function renderStudio() {
      const t = target();
      back.textContent = t.label; back.title = t.title;
      $('crumbFacts').textContent = state.folder ? scanFacts(state.scanInfo, state.nativeVoxelMm, window.VBVox.duration) : '';
      // Ruling 13: a library scan's details are edited in its overview, the record the library shows.
      const lib = t.page === 'overview';
      $('sampleForm').hidden = lib;
      $('sampleLibrary').hidden = !lib;
      if (lib) {
        const info = CT.sampleInfo(state.folder, state.samples);
        $('sampleLibName').textContent = info.name === state.folder && state.stack && state.stack.title ? state.stack.title : info.name;
      }
    }
    function goBack() {
      if (target().page === 'overview' && app.openOverview) app.openOverview(state.folder);
      if (state.page !== 'overview') app.showPage('library'); // not a library scan, or no longer listed
    }
    back.addEventListener('click', goBack);
    $('sampleToOverview').addEventListener('click', goBack);

    // Save run and Review sheet are copies of step 4's buttons; the other exports are listed under Exports. Each opens
    // step 4 first, where its progress and result are reported.
    const viaStep4 = (source) => () => { show('step4'); refresh(); source.click(); };
    for (const [copyId, sourceId] of [['tbSaveRun', 'savePoreRun'], ['tbSheet', 'exportSheet']]) {
      mirrorDisabled($(sourceId), $(copyId));
      $(copyId).addEventListener('click', viaStep4($(sourceId)));
    }
    const popover = (button, panel) => window.VBSkin.wirePopover({ doc, button: $(button), panel: $(panel) });
    const menu = $('tbExportMenu');
    const closeExports = popover('tbExports', 'tbExportMenu');
    for (const source of $('step4').querySelectorAll('.exportrow button')) {
      if (source.id === 'savePoreRun' || source.id === 'exportSheet') continue;
      const item = el('button');
      item.type = 'button'; item.setAttribute('role', 'menuitem');
      item.textContent = source.textContent;
      mirrorDisabled(source, item);
      item.addEventListener('click', () => { closeExports(); viaStep4(source)(); });
      menu.append(item);
    }
    popover('tbBookmarks', 'tbBookmarkPanel');
    // File: openers, the project and the tour. A pick closes it (a file input on its change, after the dialog).
    const closeFile = popover('tbFile', 'tbFileMenu');
    for (const input of $('tbFileMenu').querySelectorAll('input[type=file]')) input.addEventListener('change', closeFile);
    for (const b of $('tbFileMenu').querySelectorAll('button')) b.addEventListener('click', closeFile);

    for (const name of ['loaded', 'poresChanged', 'modelChanged', 'recordsChanged', 'samplesChanged', 'changed', 'sheetSaved']) on(name, refresh);
    for (const name of ['loaded', 'recordsChanged', 'samplesChanged', 'changed', 'pageChanged']) on(name, renderStudio);
    for (const d of rail.querySelectorAll('.steps > details')) d.addEventListener('toggle', refresh);
    refresh(); renderStudio();
  }

  return { checklist, nowStep, MORE, described, scanInfoDone, backTarget, scanFacts, wire };
}));
