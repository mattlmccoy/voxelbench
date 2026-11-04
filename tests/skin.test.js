'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../app/vb_skin.js');

test('the skin defaults to lab', () => {
  assert.equal(K.pickSkin({ url: '', stored: null }), 'lab');
});

test('a stored skin is used, an unknown one ignored', () => {
  assert.equal(K.pickSkin({ url: '', stored: 'glass' }), 'glass');
  assert.equal(K.pickSkin({ url: '', stored: 'neon' }), 'lab');
});

test('the skin in the address wins over the stored one', () => {
  assert.equal(K.pickSkin({ url: '?skin=lab', stored: 'glass' }), 'lab');
  assert.equal(K.pickSkin({ url: '?x=1&skin=glass', stored: null }), 'glass');
  assert.equal(K.pickSkin({ url: '?skin=neon', stored: 'glass' }), 'glass');
});

test('the toggle alternates between the two skins', () => {
  assert.equal(K.nextSkin('lab'), 'glass');
  assert.equal(K.nextSkin('glass'), 'lab');
});

test('boot applies the chosen skin to the page even when storage throws', () => {
  const attrs = {};
  const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
  const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(K.boot({ doc, storage, url: '?skin=glass' }), 'glass');
  assert.equal(attrs['data-skin'], 'glass');
  assert.equal(K.boot({ doc, storage, url: '' }), 'lab');
});
