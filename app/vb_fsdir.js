/* Helpers over a File System Access directory handle. Everything the library writes goes through writeText /
   writeBlob, which never leave a half-written file behind. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBFsDir = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIBRARY_FOLDER = 'VoxelBench'; // the lab's data lives here, so a scan walk must not descend into it

  // A path is '/'-separated segments; '..', '.' and empty segments are refused so a stored name can never leave the folder.
  function segments(path) {
    const parts = String(path).split('/');
    if (!parts.length || parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`Unsafe path: "${path}"`);
    return parts;
  }

  const isNotFound = (e) => e && e.name === 'NotFoundError';

  /** Every file under dir as { path, file }; dot-files, dot-folders and the VoxelBench folder are skipped. */
  async function* walk(dir, prefix = '') {
    for await (const h of dir.values()) {
      if (h.name.startsWith('.') || (h.kind === 'directory' && h.name === LIBRARY_FOLDER)) continue;
      if (h.kind === 'file') yield { path: prefix + h.name, file: await h.getFile() };
      else yield* walk(h, `${prefix}${h.name}/`);
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

  // The writable is a swap file the browser commits only on close(), so an abort leaves the old file whole.
  async function writeData(dir, path, data) {
    const parts = segments(path);
    const d = await dirAt(dir, parts.slice(0, -1), true);
    const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    try {
      await w.write(data);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (_) { /* the original error is the one to report */ }
      throw e;
    }
  }

  const writeText = (dir, path, text) => writeData(dir, path, text);
  const writeBlob = (dir, path, blob) => writeData(dir, path, blob);

  return { LIBRARY_FOLDER, walk, list, readText, writeText, writeBlob };
}));
