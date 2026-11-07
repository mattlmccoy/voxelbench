/* The library's holder STLs: VoxelBench/holders/ in the library folder (never the repository). A holder is named by its
   file name without ".stl"; the scan's Holder section lists them, reads the chosen one ({ name, hash, triangles in mm })
   and adds a file the user picks. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_fsdir.js'), require('./vb_stl.js'), require('./vb_holderstl.js'));
  else root.VBHolderLib = factory(root.VBFsDir, root.VBStl, root.VBHolderStl);
}(typeof self !== 'undefined' ? self : this, function (FS, St, HS) {
  'use strict';

  const FOLDER = `${FS.LIBRARY_FOLDER}/holders`;
  /** The holder's name for an STL file name, or null for any other file. */
  const holderName = (file) => (/\.stl$/i.test(file) && file.length > 4 ? file.slice(0, -4) : null);

  async function files(dir) {
    return (await FS.list(dir, FOLDER)).filter((e) => e.kind === 'file' && !FS.isHidden(e.name) && holderName(e.name));
  }

  /** The holders in the library, sorted by name. */
  async function listHolders(dir) {
    return (await files(dir)).map((e) => holderName(e.name)).sort((a, b) => a.localeCompare(b));
  }

  /** The holder as the worker takes it: { name, hash (of the file's bytes), triangles (mm) }, or null when it is not in
      the library. A file that is not an STL throws. */
  async function readHolder(dir, name) {
    const e = (await files(dir)).find((f) => holderName(f.name) === name);
    if (!e) return null;
    const bytes = await FS.readBytes(dir, `${FOLDER}/${e.name}`);
    if (!bytes) return null;
    return { name, hash: HS.stlHash(bytes), triangles: St.parseStl(bytes).positions };
  }

  /** Copies a picked STL file into the library's holders; returns its name. Refuses another kind of file, a file that
      does not read as an STL, and a name already there (a holder's file is never replaced: saved fits name it). */
  async function addHolder(dir, file) {
    const name = holderName(file.name);
    if (!name) throw new Error(`Holder files end in .stl; ${file.name} does not.`);
    St.parseStl(await file.arrayBuffer());
    const have = (await listHolders(dir)).map((n) => n.toLowerCase());
    if (have.includes(name.toLowerCase())) throw new Error(`A holder named ${name} is already in the library; rename the file to add it as another holder.`);
    await FS.writeBlob(dir, `${FOLDER}/${file.name}`, file);
    return name;
  }

  return { FOLDER, holderName, listHolders, readHolder, addHolder };
}));
