'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../app/vb_skin.js');

test('there are three looks, lab first', () => {
  assert.deepEqual(K.SKINS, ['lab', 'mac', 'glass']);
  assert.equal(K.SKIN_LABELS.lab, 'Lab');
});

test('the look defaults to lab', () => {
  assert.equal(K.pickSkin({ url: '', stored: null }), 'lab');
});

test('a stored look is used, an unknown one ignored', () => {
  assert.equal(K.pickSkin({ url: '', stored: 'mac' }), 'mac');
  assert.equal(K.pickSkin({ url: '', stored: 'glass' }), 'glass');
  assert.equal(K.pickSkin({ url: '', stored: 'neon' }), 'lab');
});

test('the look in the address wins over the stored one', () => {
  assert.equal(K.pickSkin({ url: '?skin=lab', stored: 'glass' }), 'lab');
  assert.equal(K.pickSkin({ url: '?x=1&skin=mac', stored: null }), 'mac');
  assert.equal(K.pickSkin({ url: '?skin=neon', stored: 'glass' }), 'glass');
});

test('boot applies the chosen look to the page even when storage throws', () => {
  const attrs = {};
  const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
  const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(K.boot({ doc, storage, url: '?skin=glass' }), 'glass');
  assert.equal(attrs['data-skin'], 'glass');
  assert.equal(K.boot({ doc, storage, url: '' }), 'lab');
});

test('the step bar lists each rail section with its icon and a title without the step number', () => {
  const items = K.navItems([
    { id: 'step1', title: '1Crop', open: false }, { id: 'step2', title: '2Pore segmentation', open: true }, { id: 'secScan', title: 'Scan information', open: false },
    { id: 'stepX', title: '9Something new', open: false },
  ]);
  assert.deepEqual(items.map((i) => [i.id, i.icon, i.title, i.active]), [
    ['step1', 'crop', 'Crop', false], ['step2', 'pores', 'Pore segmentation', true], ['secScan', 'info', 'Scan information', false], ['stepX', 'dot', 'Something new', false]]);
});

test('picking a section leaves only that one open', () => {
  assert.deepEqual(K.openOnly(['step1', 'step2', 'secScan'], 'secScan'), { step1: false, step2: false, secScan: true });
});
