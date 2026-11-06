'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/vb_fsdir.js');
const { makeFakeDir } = require('./fake_dir.js');

test('walk lists files with relative paths and skips dot-files and VoxelBench', async () => {
  const root = makeFakeDir();
  await D.writeText(root, 'A/scan1/slice_0001.tif', 'x');
  await D.writeText(root, 'A/notes.txt', 'n');
  await D.writeText(root, 'top.txt', 't');
  await D.writeText(root, '.hidden/skip.txt', 's');
  await D.writeText(root, 'A/.DS_Store', 's');
  await D.writeText(root, 'A/scan1/._slice_0001.tif', 'AppleDouble'); // macOS's companion file on an exFAT drive
  await D.writeText(root, 'VoxelBench/library.json', '{}');
  const paths = [];
  for await (const { path, file } of D.walk(root)) { paths.push(path); assert.equal(typeof file.text, 'function'); }
  assert.deepEqual(paths.sort(), ['A/notes.txt', 'A/scan1/slice_0001.tif', 'top.txt']);
});

test('readText returns null for a missing file or folder and the text otherwise', async () => {
  const root = makeFakeDir();
  assert.equal(await D.readText(root, 'a/b.txt'), null);
  await D.writeText(root, 'a/b.txt', 'hello');
  assert.equal(await D.readText(root, 'a/b.txt'), 'hello');
});

test('writeText replaces a file and a failing write leaves the old one', async () => {
  const root = makeFakeDir();
  await D.writeText(root, 'x/f.json', 'old');
  await D.writeText(root, 'x/f.json', 'new');
  assert.equal(await D.readText(root, 'x/f.json'), 'new');
  root.shared.failNextWrite = true;
  await assert.rejects(D.writeText(root, 'x/f.json', 'partial'), /simulated write failure/);
  assert.equal(await D.readText(root, 'x/f.json'), 'new');
  assert.equal(root.shared.aborts, 1, 'the failed writable is aborted');
  await D.writeText(root, 'x/f.json', 'after'); // a failure does not poison later writes
  assert.equal(await D.readText(root, 'x/f.json'), 'after');
});

test('writeBlob stores bytes and a failing write leaves the old file', async () => {
  const root = makeFakeDir();
  await D.writeBlob(root, 'img/a.png', new Blob([new Uint8Array([1, 2, 3])]));
  root.shared.failNextWrite = true;
  await assert.rejects(D.writeBlob(root, 'img/a.png', new Blob([new Uint8Array([9])])));
  const f = await (await (await root.getDirectoryHandle('img')).getFileHandle('a.png')).getFile();
  assert.deepEqual([...new Uint8Array(await f.arrayBuffer())], [1, 2, 3]);
});

test('paths that climb out of the folder are refused', async () => {
  const root = makeFakeDir();
  for (const p of ['../x.txt', 'a/../x.txt', 'a//x.txt', '']) await assert.rejects(D.writeText(root, p, 'x'), /path/i);
});

test('a failed first write of a new file leaves no file behind', async () => {
  const root = makeFakeDir();
  root.shared.failNextWrite = true;
  await assert.rejects(D.writeText(root, 'x/new.json', 'data'), /simulated/);
  assert.deepEqual((await D.list(root, 'x')).map((e) => e.name), []);
  assert.equal(await D.readText(root, 'x/new.json'), null);
});

// ---------- final review I4 (c) and M4: which VoxelBench folders the walk skips, and folders it cannot read ----------
test('walk skips only the root\'s own VoxelBench; a nested library is reported and not listed; a nested VoxelBench without library.json is walked', async () => {
  const root = makeFakeDir('Lab drive');
  await D.writeText(root, 'VoxelBench/library.json', '{}');
  await D.writeText(root, 'VoxelBench/thumbs/s1.png', 'p');
  await D.writeText(root, 'old lab/VoxelBench/library.json', '{}');
  await D.writeText(root, 'old lab/VoxelBench/runs/s9/2026-01-01T00-00-00.000Z.json', '{}');
  await D.writeText(root, 'old lab/scan9/a.vox', 'v');
  await D.writeText(root, 'exports/VoxelBench/scan3/a.vox', 'v'); // a user's folder that happens to be named VoxelBench
  const nested = [];
  const paths = [];
  for await (const { path } of D.walk(root, '', { nested: (p) => nested.push(p) })) paths.push(path);
  assert.deepEqual(paths.sort(), ['exports/VoxelBench/scan3/a.vox', 'old lab/scan9/a.vox']);
  assert.deepEqual(nested, ['old lab/VoxelBench']);
});

test('walk skips a folder it cannot read and reports it; without a report the walk stops as before', async () => {
  const root = makeFakeDir();
  await D.writeText(root, 'A/scan1/a.vox', 'v');
  await D.writeText(root, 'B/locked/s.vox', 'v');
  await D.writeText(root, 'C/scan2/b.vox', 'v');
  (await (await root.getDirectoryHandle('B')).getDirectoryHandle('locked')).unreadable = true;
  const unreadable = [];
  const paths = [];
  for await (const { path } of D.walk(root, '', { unreadable: (p, e) => unreadable.push([p, e.name]) })) paths.push(path);
  assert.deepEqual(paths.sort(), ['A/scan1/a.vox', 'C/scan2/b.vox']);
  assert.deepEqual(unreadable, [['B/locked', 'NotReadableError']]);
  await assert.rejects((async () => { for await (const x of D.walk(root)) void x; })(), /could not be read/);
});
