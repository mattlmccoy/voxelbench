/* View bookmarks (per sample, in its record: the main view and the cursor, on the grid they were made on) and named
   setting presets (a shared collection, so the lab can reuse one parameter set across scans). */
(function (App) {
  'use strict';
  const CT = window.CT, P = window.CTPores;
  const { state, $, on, emit } = App;

  function bookmarks() { return state.folder ? CT.sampleInfo(state.folder, state.samples).bookmarks || [] : []; }

  function renderBookmarks() {
    $('bookmarkSave').disabled = !state.folder;
    const list = $('bookmarkList');
    list.textContent = '';
    bookmarks().forEach((b, k) => {
      const li = document.createElement('li');
      const go = document.createElement('button'); go.className = 'link'; go.textContent = b.name;
      go.title = `${b.main} view at voxel ${b.cursor.x}, ${b.cursor.y}, ${b.cursor.z}`;
      go.addEventListener('click', () => {
        const c = CT.toGrid({ voxels: [b.cursor], bin_factor: b.bin_factor || 1 }, state.binFactor).voxels[0];
        App.setMain(b.main);
        emit('jump', c);
      });
      const del = document.createElement('button'); del.className = 'link'; del.textContent = 'delete';
      del.addEventListener('click', () => App.saveSample({ bookmarks: bookmarks().filter((_, i) => i !== k) }));
      li.append(go, document.createTextNode(' '), del);
      list.append(li);
    });
  }

  function saveBookmark() {
    const name = $('bookmarkName').value.trim() || `${state.main} ${state.cursor.x}, ${state.cursor.y}, ${state.cursor.z}`;
    App.saveSample({ bookmarks: [...bookmarks(), { name, main: state.main, cursor: { ...state.cursor }, bin_factor: state.binFactor, created_at: new Date().toISOString() }] });
    $('bookmarkName').value = '';
  }

  function renderPresets() {
    const sel = $('presetSelect'), keep = sel.value;
    sel.textContent = '';
    const first = document.createElement('option'); first.value = ''; first.textContent = 'Presets…'; sel.append(first);
    for (const p of [...state.presets.values()].sort((a, b) => a.name.localeCompare(b.name))) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.append(o); }
    sel.value = state.presets.has(keep) ? keep : '';
    $('presetApply').disabled = !sel.value;
  }

  function applyPreset() {
    const p = state.presets.get($('presetSelect').value);
    if (!p) return;
    state.settings = { ...P.DEFAULT_SETTINGS, ...p.settings };
    emit('settingsApplied');
    $('presetNote').textContent = `Applied "${p.name}". Press Segment pores to use it.`;
  }

  function savePreset() {
    const name = $('presetName').value.trim();
    if (!name) { $('presetNote').textContent = 'Name the preset first.'; return; }
    App.saveRecord('presets', { id: App.newId(), name, settings: { ...state.settings }, created_at: new Date().toISOString() });
    $('presetName').value = '';
    $('presetNote').textContent = `Saved "${name}" with the current parameters.`;
  }

  on('start', () => {
    $('bookmarkSave').addEventListener('click', saveBookmark);
    $('presetApply').addEventListener('click', applyPreset);
    $('presetSave').addEventListener('click', savePreset);
    $('presetSelect').addEventListener('change', () => { $('presetApply').disabled = !$('presetSelect').value; });
  });
  for (const e of ['loaded', 'recordsChanged']) on(e, () => { renderBookmarks(); renderPresets(); });
}(window.CTApp));
