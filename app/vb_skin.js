/* The page's look: "lab" (the original dark instrument look, the default) or "glass" (Montserrat, frosted panels,
   light or dark with the system). Chosen by ?skin= in the address, else the viewer's last choice, else lab. The choice
   is a per-viewer convenience kept in localStorage; when storage is blocked the page still works, it just forgets. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBSkin = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SKINS = ['lab', 'glass'], KEY = 'voxelbench.skin';
  const valid = (s) => (SKINS.includes(s) ? s : null);

  function pickSkin({ url, stored }) {
    const m = /[?&]skin=([^&#]*)/.exec(url || '');
    return valid(m && decodeURIComponent(m[1])) || valid(stored) || 'lab';
  }

  const nextSkin = (s) => SKINS[(SKINS.indexOf(s) + 1) % SKINS.length];

  function read(storage) { try { return storage ? storage.getItem(KEY) : null; } catch (e) { return null; } }
  function write(storage, skin) { try { if (storage) storage.setItem(KEY, skin); } catch (e) { /* forgets the choice */ } }

  function apply(doc, skin) { doc.documentElement.setAttribute('data-skin', skin); return skin; }

  /** Sets the skin before the page body renders, so the page never flashes the other look. */
  function boot({ doc, storage, url }) { return apply(doc, pickSkin({ url, stored: read(storage) })); }

  /** Wires the top-bar button: its label names the look it switches to. */
  function wire({ doc, storage, button }) {
    const show = () => {
      const now = doc.documentElement.getAttribute('data-skin') || 'lab';
      button.textContent = now === 'glass' ? 'Lab look' : 'Glass look';
      button.title = now === 'glass' ? 'Switch to the original dark lab look' : 'Switch to the Glass look: lighter type, frosted panels, follows light or dark mode';
    };
    button.addEventListener('click', () => {
      const skin = apply(doc, nextSkin(doc.documentElement.getAttribute('data-skin') || 'lab'));
      write(storage, skin);
      show();
    });
    show();
  }

  return { SKINS, pickSkin, nextSkin, boot, wire };
}));
