/* Helpers over a File System Access directory handle. Everything the library writes goes through writeText /
   writeBlob, which never leave a half-written file behind. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBFsDir = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIBRARY_FOLDER = 'VoxelBench'; // the library's data lives here, so a scan walk must not descend into it

  // A path is '/'-separated segments; '..', '.' and empty segments are refused so a stored name can never leave the folder.
  function segments(path) {
    const parts = String(path).split('/');
    if (!parts.length || parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`Unsafe path: "${path}"`);
    return parts;
  }

  const isNotFound = (e) => e && e.name === 'NotFoundError';
  /** Names the drive's owner never made: dot-files and dot-folders, among them the AppleDouble "._<name>" companions
      and .DS_Store that macOS writes on an exFAT drive. Every listing of the library and the scan walk skips them. */
  const isHidden = (name) => String(name).startsWith('.');

  async function entriesOf(dir) {
    const out = [];
    for await (const h of dir.values()) out.push(h);
    return out;
  }
  async function holdsFile(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
  }

  /** Every file under dir as { path, file }. Dot-files and dot-folders are skipped, and so is dir's own VoxelBench
      folder (the library's data). A VoxelBench folder deeper down that holds library.json is another library: it is
      reported to report.nested(path) and not listed; one without library.json is an ordinary folder. A folder that
      cannot be listed is reported to report.unreadable(path, error) and skipped (without that report the walk stops).
      Each folder is listed whole before its files are handed on, so a skipped folder hands on none of them. */
  async function* walk(dir, prefix = '', report = {}) {
    yield* walkEntries(await entriesOf(dir), prefix, report, true);
  }
  async function* walkEntries(entries, prefix, report, top) {
    for (const h of entries) {
      if (isHidden(h.name)) continue;
      if (h.kind === 'file') { yield { path: prefix + h.name, file: await h.getFile() }; continue; }
      const path = prefix + h.name;
      if (h.name === LIBRARY_FOLDER && (top || await holdsFile(h, 'library.json'))) {
        if (!top && report.nested) report.nested(path);
        continue;
      }
      let inner;
      try { inner = await entriesOf(h); } catch (e) {
        if (!report.unreadable) throw e;
        report.unreadable(path, e);
        continue;
      }
      yield* walkEntries(inner, `${path}/`, report, false);
    }
  }

  async function dirAt(dir, parts, create) {
    let d = dir;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }

  /** The entries directly inside dir/path as [{ name, kind }]; [] when the folder is not there. */
  async function list(dir, path) {
    let d;
    try { d = await dirAt(dir, segments(path), false); } catch (e) { if (isNotFound(e)) return []; throw e; }
    const out = [];
    for await (const h of d.values()) out.push({ name: h.name, kind: h.kind });
    return out;
  }

  /** The file's text, or null when it does not exist. */
  async function readText(dir, path) {
    const parts = segments(path);
    try {
      const d = await dirAt(dir, parts.slice(0, -1), false);
      return await (await (await d.getFileHandle(parts[parts.length - 1])).getFile()).text();
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /** The file's bytes (ArrayBuffer), or null when it does not exist. */
  async function readBytes(dir, path) {
    const parts = segments(path);
    try {
      const d = await dirAt(dir, parts.slice(0, -1), false);
      return await (await (await d.getFileHandle(parts[parts.length - 1])).getFile()).arrayBuffer();
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  // The writable is a swap file the browser commits only on close(), so an abort leaves the old file whole.
  async function writeData(dir, path, data) {
    const parts = segments(path);
    const name = parts[parts.length - 1];
    const d = await dirAt(dir, parts.slice(0, -1), true);
    let existed = true;
    try { await d.getFileHandle(name); } catch (e) { if (!isNotFound(e)) throw e; existed = false; }
    const w = await (await d.getFileHandle(name, { create: true })).createWritable();
    try {
      await w.write(data);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (_) { /* the original error is the one to report */ }
      // Creating the handle made an empty file; left behind it would read as corrupt JSON. Remove only what this write created.
      if (!existed) { try { await d.removeEntry(name); } catch (_) { /* nothing more to undo */ } }
      throw e;
    }
  }

  const writeText = (dir, path, text) => writeData(dir, path, text);
  const writeBlob = (dir, path, blob) => writeData(dir, path, blob);

  return { LIBRARY_FOLDER, isHidden, segments, walk, list, readText, readBytes, writeText, writeBlob };
}));
