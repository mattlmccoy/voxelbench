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

test('each step has a short name for under its icon; an unknown section falls back to its title', () => {
  const items = K.navItems([{ id: 'step2', title: '2Pore segmentation', open: false }, { id: 'step5', title: '5Density calibration', open: false }, { id: 'stepX', title: '9Something new', open: false }]);
  assert.deepEqual(items.map((i) => i.short), ['Pores', 'Density', 'Something new']);
});

test('a step counts as done from its status tag; scan information gets no dot', () => {
  assert.equal(K.stepDone('step2', 'not run'), false);
  assert.equal(K.stepDone('step2', 'running'), false);
  assert.equal(K.stepDone('step2', '5.25 % porosity'), true);
  assert.equal(K.stepDone('step1', 'optional'), false);
  assert.equal(K.stepDone('step1', '1 drawn'), true);
  assert.equal(K.stepDone('step3', ''), false);
  assert.equal(K.stepDone('step5', 'calibrated, 3 points'), true);
  assert.equal(K.stepDone('secScan', 'synthetic_scan'), null);
});

test('next steps after a finished step; nothing for a step that has not run', () => {
  const done = { step1: false, step2: true, step3: false, step4: false, step5: false };
  assert.deepEqual(K.nextFor('step3', done), []);
  assert.deepEqual(K.nextFor('step2', done).map((n) => n.id), ['step5', 'step3', 'step4']);
  assert.match(K.nextFor('step2', done)[0].note, /phantoms/);
  assert.deepEqual(K.nextFor('step2', { ...done, step5: true }).map((n) => n.id), ['step3', 'step4']);
  assert.deepEqual(K.nextFor('step1', { step1: true, step2: false }).map((n) => n.id), ['step2']);
  assert.deepEqual(K.nextFor('step5', { step5: true, step2: false }).map((n) => n.id), ['step2']);
  assert.deepEqual(K.nextFor('step5', { step5: true, step2: true }).map((n) => n.id), ['step3', 'step4']);
  assert.deepEqual(K.nextFor('step8', { step8: true }).map((n) => n.id), ['step4']);
  assert.deepEqual(K.nextFor('step4', { step4: true }), []);
});

test('the rail width stays between 320 px and 60 % of the window', () => {
  assert.equal(K.clampRailWidth(200, 1440), 320);
  assert.equal(K.clampRailWidth(500.4, 1440), 500);
  assert.equal(K.clampRailWidth(1200, 1440), 864);
  assert.equal(K.clampRailWidth(400, 500), 320); // a narrow window never squeezes below the minimum
  assert.equal(K.clampRailWidth(NaN, 1440), null);
});

test('the mode is system, light or dark; system by default and for anything unknown', () => {
  assert.deepEqual(K.MODES, ['system', 'light', 'dark']);
  assert.equal(K.pickMode(null), 'system');
  assert.equal(K.pickMode('dark'), 'dark');
  assert.equal(K.pickMode('sepia'), 'system');
});

test('system follows the computer; light and dark override it', () => {
  assert.equal(K.resolveMode('system', true), 'dark');
  assert.equal(K.resolveMode('system', false), 'light');
  assert.equal(K.resolveMode('light', true), 'light');
  assert.equal(K.resolveMode('dark', false), 'dark');
});

test('bootMode sets data-mode from storage and the system, even when storage throws', () => {
  const attrs = {};
  const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
  const win = { matchMedia: () => ({ matches: true, addEventListener() {} }) };
  assert.equal(K.bootMode({ doc, storage: { getItem: () => 'light' }, win }), 'light');
  assert.equal(attrs['data-mode'], 'light');
  assert.equal(K.bootMode({ doc, storage: { getItem: () => { throw new Error('blocked'); } }, win }), 'dark');
  assert.equal(attrs['data-mode'], 'dark');
});
