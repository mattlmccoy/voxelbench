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
