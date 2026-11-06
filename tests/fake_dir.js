'use strict';
/* An in-memory stand-in for a File System Access directory handle. It models the one behavior the library depends on:
   a writable's content replaces the file only on close(), so a write that fails (or is aborted) leaves the old file
   intact, as Chromium's swap-file writable does. Not a test file: node --test only runs tests/*.test.js. */

function notFound(name) {
  const e = new Error(`A requested file or directory could not be found: ${name}`);
  e.name = 'NotFoundError';
  return e;
}

function makeFakeDir(name = 'root', shared = { failNextWrite: false, aborts: 0 }) {
  const entries = new Map(); // name -> { kind: 'file', blob } | { kind: 'directory', dir }
  const dir = {
    kind: 'directory',
    name,
    shared, // failNextWrite: the next write() throws; aborts: how many writables were aborted
    unreadable: false, // true: listing this folder fails, as a folder the browser may not read does
    gone: false, // true: the folder is no longer there (drive unplugged): every call on it is NotFoundError
    async *values() {
      if (dir.gone) throw notFound(name);
      if (dir.unreadable) { const err = new Error(`The requested file could not be read: ${name}`); err.name = 'NotReadableError'; throw err; }
      for (const [n, e] of entries) yield e.kind === 'file' ? fileHandle(n, e) : e.dir;
    },
    async getDirectoryHandle(n, { create = false } = {}) {
      if (dir.gone) throw notFound(name);
      const e = entries.get(n);
      if (e && e.kind === 'directory') return e.dir;
      if (e) { const err = new Error(`${n} is a file`); err.name = 'TypeMismatchError'; throw err; }
      if (!create) throw notFound(n);
      const child = makeFakeDir(n, shared);
      entries.set(n, { kind: 'directory', dir: child });
      return child;
    },
    async getFileHandle(n, { create = false } = {}) {
      if (dir.gone) throw notFound(name);
      const e = entries.get(n);
      if (e && e.kind === 'file') return fileHandle(n, e);
      if (e) { const err = new Error(`${n} is a directory`); err.name = 'TypeMismatchError'; throw err; }
      if (!create) throw notFound(n);
      const fresh = { kind: 'file', blob: new Blob([]) };
      entries.set(n, fresh);
      return fileHandle(n, fresh);
    },
    async removeEntry(n) {
      if (!entries.has(n)) throw notFound(n);
      entries.delete(n);
    },
  };
  function fileHandle(n, e) {
    return {
      kind: 'file',
      name: n,
      async getFile() { return new File([e.blob], n); },
      async createWritable() {
        let pending = new Blob([]);
        let done = false;
        return {
          async write(data) {
            if (done) throw new Error('writable is closed');
            if (shared.failNextWrite) { shared.failNextWrite = false; throw new Error('simulated write failure'); }
            pending = new Blob([pending, data]);
          },
          async close() { if (done) throw new Error('writable is closed'); done = true; e.blob = pending; },
          async abort() { done = true; shared.aborts++; },
        };
      },
    };
  }
  return dir;
}

module.exports = { makeFakeDir };
