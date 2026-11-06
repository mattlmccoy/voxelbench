/* Saving records from the page. The studio's saveRecord, and the one path a library scan's own record (sample details,
   star, tags, Archimedes) takes from the overview and the library cards, so the caller can show this save's outcome. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBRecordSave = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The page's saveRecord(collection, record). io: store() is the active store; unsaved() its map of edits not yet
      reported back (the record shows as NOT SAVED until the store's watch reports it); changed() redraws;
      markDirty(store) after a write; failed(store, text) reports a failed write where it happened. The promise is this
      save's: it rejects when the write fails (after failed() reported it), so "saved" is never shown for a failed write.
      It is marked handled, so the many callers that do not wait for it raise no unhandled rejection. */
  function makeSaveRecord(io) {
    return function saveRecord(collection, record) {
      io.unsaved().set(record.id, { ...record, _collection: collection });
      io.changed();
      const store = io.store();
      const p = (async () => {
        if (!store) throw new Error('records are not available yet, so nothing was saved');
        try {
          await store.put(collection, record);
        } catch (e) {
          io.failed(store, `the last save failed: ${e.message}`);
          throw e;
        }
        io.markDirty(store);
      })();
      p.catch(() => {}); // reported by failed(); a caller that waits still sees the rejection
      return p;
    };
  }

  /** Saves fields of a library scan's record. When the studio's active store is the library's (a library scan is open),
      the studio's own save (saveSample) is used, so its edits in flight and these build on each other; otherwise the
      library's own saver. Either way the returned promise is this save's. */
  function makeScanRecordSave({ activeStore, libraryStore, saveSample, saveLibrary }) {
    return (id, changes) => (activeStore() === libraryStore() ? saveSample(changes, id) : saveLibrary(id, changes));
  }

  return { makeSaveRecord, makeScanRecordSave };
}));
