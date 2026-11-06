/* Which folder becomes a library (owner decision 2026-11-05, "Ask first, warn on splits"). A folder that already holds a
   VoxelBench library opens; any other asks before a library is started in it; the library's own VoxelBench folder is
   refused, with a pointer to the folder that holds it. Also the root folder's handle, kept between visits in IndexedDB. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_fsdir.js'));
  else root.VBLibraryRoot = factory(root.VBFsDir);
}(typeof self !== 'undefined' ? self : this, function (FS) {
  'use strict';

  const nameOf = (name) => name || 'browser storage'; // a test root (the browser's own storage) has no name

  /** What the picked folder holds, read without writing: ownLibrary (VoxelBench/library.json is there) and
      isLibraryFolder (the folder is itself a library's VoxelBench folder: so named, with library.json inside). */
  async function inspectRoot(dir) {
    const has = async (path) => (await FS.readText(dir, path)) !== null;
    return { name: dir.name, ownLibrary: await has(`${FS.LIBRARY_FOLDER}/library.json`), isLibraryFolder: dir.name === FS.LIBRARY_FOLDER && await has('library.json') };
  }

  /** open, confirm (with the question to ask) or refuse (with the message). A picked folder's parent cannot be reached
      from the browser, so the library's own folder is refused rather than swapped for its parent. */
  function rootDecision({ name, ownLibrary, isLibraryFolder }) {
    if (isLibraryFolder) {
      return { action: 'refuse', message: `You picked the library's own folder (${FS.LIBRARY_FOLDER}); the browser cannot open the folder above it from here. Choose your scan drive… again and choose the folder that holds ${FS.LIBRARY_FOLDER}.` };
    }
    if (ownLibrary) return { action: 'open' };
    return { action: 'confirm', question: `Start a new VoxelBench library in ${nameOf(name)}? If your lab already has one, choose the folder that holds its VoxelBench folder.` };
  }

  /** The Rescan's note on other libraries found inside this one (their VoxelBench folders' paths). */
  const nestedNote = (paths) => paths.map((p) => `Another VoxelBench library is inside this one at ${p}; its records are separate. Open that folder's parent to use it.`).join(' ');

  // ---------- the root folder's handle, kept between visits (browser only) ----------
  const HANDLE_DB = { name: 'voxelbench', store: 'handles', key: 'libraryRoot' };
  function handles(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(HANDLE_DB.name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(HANDLE_DB.store);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction(HANDLE_DB.store, mode), req = fn(tx.objectStore(HANDLE_DB.store));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const keepHandle = (h) => handles('readwrite', (s) => s.put(h, HANDLE_DB.key)).catch(() => {}); // a private window may refuse; the library still opens
  const savedHandle = () => handles('readonly', (s) => s.get(HANDLE_DB.key)).catch(() => null);

  return { inspectRoot, rootDecision, nestedNote, keepHandle, savedHandle };
}));
