'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../app/vb_libraryroot.js');
const FS = require('../app/vb_fsdir.js');
const { makeFakeDir } = require('./fake_dir.js');

// final review I4, owner decision 2026-11-05 "Ask first, warn on splits".
test('rootDecision: a folder with a library opens; one without asks first; the library\'s own folder is refused with a pointer', () => {
  assert.deepEqual(R.rootDecision({ name: 'Lab drive', ownLibrary: true, isLibraryFolder: false }), { action: 'open' });
  const ask = R.rootDecision({ name: 'Lab drive', ownLibrary: false, isLibraryFolder: false });
  assert.equal(ask.action, 'confirm');
  assert.equal(ask.question, 'Start a new VoxelBench library in Lab drive? If your lab already has one, choose the folder that holds its VoxelBench folder.');
  const own = R.rootDecision({ name: 'VoxelBench', ownLibrary: false, isLibraryFolder: true });
  assert.equal(own.action, 'refuse');
  assert.match(own.message, /You picked the library's own folder/);
  assert.match(own.message, /choose the folder that holds VoxelBench/i);
  assert.equal(R.rootDecision({ name: '', ownLibrary: false, isLibraryFolder: false }).question.includes('browser storage'), true, 'a root without a name (browser storage) is named');
});

test('inspectRoot: reads only whether library.json is there, and writes nothing', async () => {
  const lab = makeFakeDir('Lab drive');
  await FS.writeText(lab, 'VoxelBench/library.json', '{"schema":"voxelbench-library","version":1}');
  assert.deepEqual(await R.inspectRoot(lab), { name: 'Lab drive', ownLibrary: true, isLibraryFolder: false });
  const own = await lab.getDirectoryHandle('VoxelBench');
  assert.deepEqual(await R.inspectRoot(own), { name: 'VoxelBench', ownLibrary: false, isLibraryFolder: true });
  const fresh = makeFakeDir('Empty');
  assert.deepEqual(await R.inspectRoot(fresh), { name: 'Empty', ownLibrary: false, isLibraryFolder: false });
  assert.deepEqual(await FS.list(fresh, 'VoxelBench'), [], 'nothing was created');
  const named = makeFakeDir('VoxelBench'); // named so, but not a library: an ordinary folder
  assert.equal((await R.inspectRoot(named)).isLibraryFolder, false);
});

test('nestedNote: a nested library is named, with how to open it', () => {
  assert.equal(R.nestedNote([]), '');
  assert.equal(R.nestedNote(['old lab/VoxelBench']), 'Another VoxelBench library is inside this one at old lab/VoxelBench; its records are separate. Open that folder\'s parent to use it.');
  assert.equal(R.nestedNote(['a/VoxelBench', 'b/VoxelBench']).split('Another').length - 1, 2);
});
