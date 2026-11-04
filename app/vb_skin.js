/* The page's look, chosen under Appearance in the top bar:
   - lab: the original dark instrument look (default);
   - mac: a light Mac inspector (system font, grouped lists, one step at a time);
   - glass: frosted panels floating on a blurred copy of the scan.
   Chosen by ?skin= in the address, else the viewer's last choice, else lab. The choice is a per-viewer convenience in
   localStorage; when storage is blocked the page still works, it just forgets. Mac and glass show the rail one section at
   a time through a step bar; lab keeps the accordion. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBSkin = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SKINS = ['lab', 'mac', 'glass'], KEY = 'voxelbench.skin';
  const SKIN_LABELS = { lab: 'Lab', mac: 'Mac', glass: 'Glass' };
  const SKIN_NOTES = { lab: 'The original dark instrument look', mac: 'Light, like a Mac app; one step at a time', glass: 'Frosted panels floating on the scan' };
  const valid = (s) => (SKINS.includes(s) ? s : null);

  function pickSkin({ url, stored }) {
    const m = /[?&]skin=([^&#]*)/.exec(url || '');
    return valid(m && decodeURIComponent(m[1])) || valid(stored) || 'lab';
  }

  // Step-bar icons by rail section id (16 x 16 strokes).
  const ICONS = {
    crop: '<path d="M4 1.5V12h10.5M1.5 4H12v10.5"/>',
    pores: '<circle cx="8" cy="8" r="6.2"/><circle cx="6" cy="6.5" r="1.4"/><circle cx="10" cy="9.5" r="1.8"/><circle cx="6.5" cy="10.8" r=".8"/>',
    zones: '<circle cx="8" cy="8" r="6.2"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" fill-opacity=".35"/>',
    notes: '<path d="M3 1.5h7l3 3v10H3z"/><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3"/>',
    density: '<path d="M6 1.5h4M6.8 1.5v4.2L2.8 13a1 1 0 0 0 .9 1.5h8.6a1 1 0 0 0 .9-1.5L9.2 5.7V1.5"/><path d="M4.6 10.5h6.8"/>',
    cad: '<path d="M8 1.5 14 5v6l-6 3.5L2 11V5z"/><path d="M2 5l6 3.5L14 5M8 8.5v6"/>',
    filler: '<circle cx="5" cy="5" r="1.6"/><circle cx="11" cy="6" r="1.2"/><circle cx="7" cy="11" r="1.4"/><path d="M10 10.5l3.5 2.5"/>',
    wall: '<path d="M2 3h12M2 13h12"/><path d="M8 4.5v7M6.5 6 8 4.5 9.5 6M6.5 10 8 11.5 9.5 10"/>',
    info: '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.2v4M8 4.8v.1"/>',
    dot: '<circle cx="8" cy="8" r="2.5"/>',
  };
  const SECTION_ICON = { step1: 'crop', step2: 'pores', step3: 'zones', step4: 'notes', step5: 'density', step6: 'cad', step7: 'filler', step8: 'wall', secScan: 'info' };

  /** Step-bar items from the rail sections [{ id, title (summary text), open }]. */
  function navItems(sections) {
    return sections.map((s) => ({ id: s.id, icon: SECTION_ICON[s.id] || 'dot', title: s.title.replace(/^\s*\d+\s*/, '').trim(), active: Boolean(s.open) }));
  }

  /** Open state after picking one section: that one open, every other closed. */
  function openOnly(ids, pick) { return Object.fromEntries(ids.map((id) => [id, id === pick])); }

  function read(storage) { try { return storage ? storage.getItem(KEY) : null; } catch (e) { return null; } }
  function write(storage, skin) { try { if (storage) storage.setItem(KEY, skin); } catch (e) { /* forgets the choice */ } }
  function apply(doc, skin) { doc.documentElement.setAttribute('data-skin', skin); return skin; }

  /** Sets the look before the page body renders, so the page never flashes another look. */
  function boot({ doc, storage, url }) { return apply(doc, pickSkin({ url, stored: read(storage) })); }

  const svg = (name) => `<svg class="skinicon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ICONS.dot}</svg>`;
  const current = (doc) => doc.documentElement.getAttribute('data-skin') || 'lab';

  /** The Appearance menu: one choice per look. Emits 'vbskin' on the document when the look changes. */
  function wireSettings({ doc, storage, button, menu }) {
    menu.innerHTML = `<p class="skinmenuhead">Appearance</p>${SKINS.map((s) => `<button type="button" role="menuitemradio" data-skin="${s}"><span class="skintitle">${SKIN_LABELS[s]}</span><span class="skinnote">${SKIN_NOTES[s]}</span></button>`).join('')}`;
    const show = () => { for (const b of menu.querySelectorAll('[data-skin]')) b.setAttribute('aria-checked', String(b.dataset.skin === current(doc))); };
    const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
    button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden)); show(); });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-skin]');
      if (!b) return;
      write(storage, apply(doc, b.dataset.skin));
      show(); close();
      doc.dispatchEvent(new CustomEvent('vbskin', { detail: b.dataset.skin }));
    });
    doc.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) close(); });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); button.focus(); } });
    show();
  }

  /** The step bar for the mac and glass looks: one button per rail section; picking one shows only that section. */
  function wireStepBar({ doc, rail }) {
    const sections = [...rail.querySelectorAll('.steps > details')];
    const nav = doc.createElement('nav');
    nav.className = 'stepbar'; nav.setAttribute('aria-label', 'Steps');
    // The summary text without its status tag; navItems drops the leading step number.
    const titleOf = (d) => [...d.querySelector('summary').childNodes].filter((n) => !(n.classList && n.classList.contains('tag'))).map((n) => n.textContent).join('');
    const items = navItems(sections.map((d) => ({ id: d.id, title: titleOf(d), open: d.open })));
    nav.innerHTML = items.map((i) => `<button type="button" data-section="${i.id}" title="${i.title}" aria-label="${i.title}">${svg(i.icon)}</button>`).join('');
    const refresh = () => { for (const b of nav.children) b.setAttribute('aria-current', String(doc.getElementById(b.dataset.section).open)); };
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('[data-section]');
      if (!b) return;
      const state = openOnly(sections.map((d) => d.id), b.dataset.section);
      for (const d of sections) d.open = state[d.id];
      rail.querySelector('.steps').scrollTop = 0;
      refresh();
    });
    for (const d of sections) d.addEventListener('toggle', refresh);
    rail.prepend(nav);
    refresh();
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

  return { SKINS, SKIN_LABELS, pickSkin, navItems, openOnly, boot, wireSettings, wireStepBar, wireBackdrop };
}));
