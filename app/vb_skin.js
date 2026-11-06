/* The page's look, chosen under Appearance in the top bar, each in light or dark (Mode: system, light or dark):
   - lab: the original instrument look (default);
   - mac: a Mac inspector (system font, grouped lists);
   - glass: frosted panels floating on a blurred copy of the scan.
   Chosen by ?skin= in the address, else the viewer's last choice, else lab. The choice is a per-viewer convenience in
   localStorage; when storage is blocked the page still works, it just forgets. Every look shows the rail one section at a
   time, picked from the checklist (vb_checklist.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBSkin = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SKINS = ['lab', 'mac', 'glass'], KEY = 'voxelbench.skin';
  const SKIN_LABELS = { lab: 'Lab', mac: 'Mac', glass: 'Glass' };
  const SKIN_NOTES = { lab: 'The original instrument look, amber on gray', mac: 'Like a Mac app: system font, grouped lists', glass: 'Frosted panels floating on the scan' };
  const valid = (s) => (SKINS.includes(s) ? s : null);

  function pickSkin({ url, stored }) {
    const m = /[?&]skin=([^&#]*)/.exec(url || '');
    return valid(m && decodeURIComponent(m[1])) || valid(stored) || 'lab';
  }

  /** Whether a step has a result, from its status tag ('optional', 'not run', 'running' and empty mean no);
      null for scan information, which is not a step. */
  function stepDone(id, tag) {
    if (id === 'secScan') return null;
    const t = (tag || '').trim();
    return Boolean(t) && !['optional', 'not run', 'running'].includes(t);
  }

  // What usually follows each finished step; a step already done is not suggested again.
  const NEXT = {
    step1: [{ id: 'step2' }],
    step2: [{ id: 'step5', note: 'only if phantoms are in the scan' }, { id: 'step3', note: 'zones and hand-drawn regions' }, { id: 'step4' }],
    step3: [{ id: 'step4' }], step6: [{ id: 'step4' }], step7: [{ id: 'step4' }], step8: [{ id: 'step4' }],
  };

  /** Next steps to offer at the end of a finished step, given which steps are done ({ id: bool }). */
  function nextFor(id, done) {
    if (!done[id]) return [];
    if (id === 'step5') return done.step2 ? [{ id: 'step3', note: 'densities per zone and region' }, { id: 'step4' }] : [{ id: 'step2', note: 'for the matrix and bulk densities' }];
    return (NEXT[id] || []).filter((n) => !done[n.id]);
  }

  /** Rail width the viewer dragged to: at least 320 px, at most 60 % of the window; null when not a number. */
  function clampRailWidth(px, viewport) {
    if (!Number.isFinite(px)) return null;
    return Math.round(Math.min(Math.max(px, 320), Math.max(320, 0.6 * viewport)));
  }

  /** Rail width while leveling a part: wide enough for the three previews side by side above the sliders (680 px),
      never narrower than the rail already is, within clampRailWidth's limits. */
  function levelingRailWidth(px, viewport) {
    return clampRailWidth(Math.max(Number.isFinite(px) ? px : 0, 680), viewport);
  }

  /** Open state after picking one section: that one open, every other closed. */
  function openOnly(ids, pick) { return Object.fromEntries(ids.map((id) => [id, id === pick])); }

  function read(storage) { try { return storage ? storage.getItem(KEY) : null; } catch (e) { return null; } }
  function write(storage, skin) { try { if (storage) storage.setItem(KEY, skin); } catch (e) { /* forgets the choice */ } }
  function apply(doc, skin) { doc.documentElement.setAttribute('data-skin', skin); return skin; }

  // Light or dark: system follows the computer (prefers-color-scheme); kept per viewer like the look.
  const MODES = ['system', 'light', 'dark'], MODE_KEY = 'voxelbench.mode';
  const MODE_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
  const pickMode = (stored) => (MODES.includes(stored) ? stored : 'system');
  const resolveMode = (mode, systemDark) => (mode === 'system' ? (systemDark ? 'dark' : 'light') : mode);
  const readMode = (storage) => { try { return storage ? storage.getItem(MODE_KEY) : null; } catch (e) { return null; } };
  const systemDark = (win) => Boolean(win && win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches);

  /** Sets data-mode (light or dark) before the body renders, and follows the computer while the choice is system. */
  function bootMode({ doc, storage, win }) {
    const apply = () => { const m = resolveMode(pickMode(readMode(storage)), systemDark(win)); doc.documentElement.setAttribute('data-mode', m); return m; };
    const query = win && win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)');
    if (query && query.addEventListener) query.addEventListener('change', () => { if (pickMode(readMode(storage)) === 'system') { apply(); if (doc.dispatchEvent) doc.dispatchEvent(new CustomEvent('vbskin', { detail: 'mode' })); } });
    return apply();
  }

  /** Sets the look before the page body renders, so the page never flashes another look. */
  function boot({ doc, storage, url }) { return apply(doc, pickSkin({ url, stored: read(storage) })); }

  const current = (doc) => doc.documentElement.getAttribute('data-skin') || 'lab';

  // The top bars' popovers (Appearance, Exports, Bookmarks, File): at most one is open; opening one closes the others.
  const openPopovers = new Set();

  /** A button that shows and hides the panel under it; a second click, an outside click or Escape closes it, and
      opening it closes any other popover. onOpen runs as it opens. Returns close(). */
  function wirePopover({ doc, button, panel, onOpen }) {
    const close = () => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); openPopovers.delete(close); };
    if (!button.getAttribute('aria-haspopup')) button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!panel.hidden) { close(); return; }
      for (const other of [...openPopovers]) other();
      panel.hidden = false; button.setAttribute('aria-expanded', 'true'); openPopovers.add(close);
      if (onOpen) onOpen();
    });
    doc.addEventListener('click', (e) => { if (!panel.hidden && !panel.contains(e.target)) close(); });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { close(); button.focus(); } });
    return close;
  }

  /** The Appearance menu: one choice per look. Emits 'vbskin' on the document when the look changes. */
  function wireSettings({ doc, storage, button, menu, win = typeof window !== 'undefined' ? window : null }) {
    menu.innerHTML = `<p class="skinmenuhead">Appearance</p>${SKINS.map((s) => `<button type="button" role="menuitemradio" data-skin="${s}"><span class="skintitle">${SKIN_LABELS[s]}</span><span class="skinnote">${SKIN_NOTES[s]}</span></button>`).join('')}`
      + `<p class="skinmenuhead">Mode</p><div class="modechoice" role="group" aria-label="Light or dark">${MODES.map((m) => `<button type="button" role="menuitemradio" data-mode="${m}">${MODE_LABELS[m]}</button>`).join('')}</div>`;
    const show = () => {
      for (const b of menu.querySelectorAll('[data-skin]')) b.setAttribute('aria-checked', String(b.dataset.skin === current(doc)));
      for (const b of menu.querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === pickMode(readMode(storage))));
    };
    const close = wirePopover({ doc, button, panel: menu, onOpen: show });
    menu.addEventListener('click', (e) => {
      const pick = menuPick(e.target, menu);
      if (!pick) return;
      if (pick.mode) {
        try { if (storage) storage.setItem(MODE_KEY, pick.mode); } catch (err) { /* forgets the choice */ }
        doc.documentElement.setAttribute('data-mode', resolveMode(pick.mode, systemDark(win)));
        show();
        doc.dispatchEvent(new CustomEvent('vbskin', { detail: 'mode' }));
        return;
      }
      write(storage, apply(doc, pick.skin));
      show(); close();
      doc.dispatchEvent(new CustomEvent('vbskin', { detail: pick.skin }));
    });
    show();
  }

  /** The rail's sections, one open at a time in every look; show(id) opens one (the checklist calls it). Each finished
      step ends with a Next line that opens the usual next step. Returns { show }. */
  function wireSections({ doc, rail }) {
    const sections = [...rail.querySelectorAll('.steps > details')];
    // The summary text without its status tag or step number.
    const titleOf = (d) => [...d.querySelector('summary').childNodes].filter((n) => !(n.classList && (n.classList.contains('tag') || n.classList.contains('num')))).map((n) => n.textContent).join('').trim();
    const titles = Object.fromEntries(sections.map((d) => [d.id, titleOf(d)]));
    const tagOf = (d) => { const t = d.querySelector('summary .tag'); return t ? t.textContent : ''; };
    const nexts = new Map();
    for (const d of sections) {
      const body = d.querySelector(':scope > .body');
      if (!body) continue;
      const row = doc.createElement('div');
      row.className = 'nextrow'; row.hidden = true;
      body.append(row);
      nexts.set(d.id, row);
    }
    const show = (id) => {
      const state = openOnly(sections.map((d) => d.id), id);
      for (const d of sections) d.open = state[d.id];
      rail.querySelector('.steps').scrollTop = 0;
      refresh();
    };
    let shown = '';
    function refresh() {
      const done = Object.fromEntries(sections.map((d) => [d.id, stepDone(d.id, tagOf(d))]));
      const key = JSON.stringify(done);
      if (key === shown) return; // the Next lines change only with the done set
      shown = key;
      for (const [id, row] of nexts) {
        const list = nextFor(id, done);
        row.hidden = !list.length;
        row.innerHTML = list.length ? `<span class="nextlabel">Next:</span>${list.map((n) => `<button type="button" data-next="${n.id}">${titles[n.id] || n.id}</button>${n.note ? `<span class="nextnote">${n.note}</span>` : ''}`).join('')}` : '';
      }
    }
    rail.addEventListener('click', (e) => { const b = e.target.closest('[data-next]'); if (b) show(b.dataset.next); });
    // Status tags are set by each step's own code; watching them keeps the Next lines current.
    const watch = new MutationObserver(refresh);
    for (const d of sections) { const t = d.querySelector('summary .tag'); if (t) watch.observe(t, { childList: true, characterData: true, subtree: true }); }
    refresh();
    return { show };
  }

  const WIDTH_KEY = 'voxelbench.railWidth';

  /** A grip on the rail's left edge: drag to widen the rail (wide tables), double-click to reset; the width is kept
      per viewer in localStorage and applied as --rail-w on the page. Hidden by CSS on narrow screens. */
  function wireRailResize({ doc, storage, rail, win }) {
    const root = doc.documentElement;
    const set = (px) => { const w = clampRailWidth(px, win.innerWidth); if (w === null) root.style.removeProperty('--rail-w'); else root.style.setProperty('--rail-w', `${w}px`); return w; };
    let saved = null;
    try { saved = storage ? Number(storage.getItem(WIDTH_KEY)) || null : null; } catch (e) { saved = null; }
    if (saved) set(saved);
    const grip = doc.createElement('div');
    grip.className = 'railgrip'; grip.title = 'Drag to resize the panel; double-click to reset';
    grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'vertical');
    rail.append(grip);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const right = rail.getBoundingClientRect().right;
      const move = (m) => set(right - m.clientX);
      // Listened on the document, so the drag keeps going when the pointer leaves the thin grip.
      const up = () => {
        doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', up);
        const w = parseInt(root.style.getPropertyValue('--rail-w'), 10);
        try { if (storage && w) storage.setItem(WIDTH_KEY, String(w)); } catch (err) { /* forgets the width */ }
        win.dispatchEvent(new Event('resize')); // views refit their canvases
      };
      doc.addEventListener('pointermove', move); doc.addEventListener('pointerup', up);
    });
    grip.addEventListener('dblclick', () => {
      root.style.removeProperty('--rail-w');
      try { if (storage) storage.removeItem(WIDTH_KEY); } catch (e) { /* nothing kept */ }
      win.dispatchEvent(new Event('resize'));
    });
  }

  /** A small, live copy of the main slice behind the glass look, blurred by CSS, refreshed twice a second while visible. */
  function wireBackdrop({ doc, source }) {
    const c = doc.createElement('canvas');
    c.className = 'skinbackdrop'; c.width = 192; c.height = 120; c.setAttribute('aria-hidden', 'true');
    doc.body.prepend(c);
    const g = c.getContext('2d');
    setInterval(() => {
      if (current(doc) !== 'glass' || doc.hidden) return;
      const s = source();
      if (!s || !s.width || !s.height) return;
      try { g.drawImage(s, 0, 0, c.width, c.height); } catch (e) { /* source not ready */ }
    }, 500);
  }

  /** Keeps --topbar-h equal to the top bar's height, so a look whose bar floats and wraps (glass) can place what sits
      below it; a no-op where ResizeObserver is missing. */
  function wireTopbarHeight({ doc, bar, win }) {
    if (!win.ResizeObserver) return;
    new win.ResizeObserver(() => { doc.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`); }).observe(bar);
  }

  /** What a click in the Appearance menu chose: the button under the click, and only one inside the menu. Searching
      up for [data-mode] or [data-skin] instead would reach <html>, which carries both. */
  function menuPick(target, menu) {
    const b = target && target.closest ? target.closest('button') : null;
    if (!b || !menu.contains(b)) return null;
    if (b.dataset.mode) return { mode: b.dataset.mode };
    if (b.dataset.skin) return { skin: b.dataset.skin };
    return null;
  }
  return { SKINS, SKIN_LABELS, MODES, pickMode, resolveMode, bootMode, wireTopbarHeight, pickSkin, stepDone, nextFor, clampRailWidth, levelingRailWidth, openOnly, boot, wireSettings, wirePopover, wireSections, wireRailResize, wireBackdrop, menuPick };
}));
