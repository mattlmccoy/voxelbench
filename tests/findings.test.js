'use strict';
// The Findings page of the review sheet: each step's insights gathered from the page state (the same lists the rail
// shows), the extras (saved regions, Dragonfly comparison, density calibration), the steps not run, and the layout of
// all of it into pages. Field names follow the producing code: pores from ct_pores.js + vb_connectivity.js, the step
// results from vb_insightrail.js, regions from ct_regions.js regionStats, the comparison from vb_masks.js compareRuns.
const test = require('node:test');
const assert = require('node:assert/strict');
const FD = require('../app/vb_findings.js');
const I = require('../app/vb_insights.js');
const P = require('../app/ct_pores.js');
const C = require('../app/vb_calibration.js');

const pore = (id, volume_mm3, diameter_mm, over = {}) => ({ id, volume_mm3, diameter_mm, x_mm: id, y_mm: 2, z_mm: 3, crack_like: false, clipped: false, surface_distance_mm: 2, ...over });
const PORES = [pore(1, 8, 2.5), pore(2, 1, 0.3), pore(3, 1, 0.3)];
const base = { pores: PORES, rejected: new Set(), bodyMm3: 300, voxelMm: 0.04, connectivity: null, zones: null, cad: null, filler: null, wall: null };
const WALL = { result: { stats: { count: 500, min_mm: 3.68, p05_mm: 3.68, p50_mm: 3.7 }, resolved_min_mm: 0.28, beyond_stack: 0 } };
const texts = (section) => section.items.map((i) => i.text || `${i.key}: ${i.value}`).join(' | ');

test('step insights are the lists the rail shows, and null for a step that has not run', () => {
  const s = FD.stepInsights({ ...base, wall: WALL });
  const summary = P.summarize(PORES, 300, new Set());
  assert.deepEqual(s.pores, I.poreInsights({ pores: PORES, rejected: new Set(), summary, voxelMm: 0.04, split: null, through: null, shellShare: null }));
  assert.deepEqual(s.wall, I.wallInsights({ stats: WALL.result.stats, resolvedMinMm: 0.28, beyondStack: 0 }));
  assert.equal(s.zones, null);
  assert.equal(s.cad, null);
  assert.equal(s.filler, null);
  assert.equal(FD.stepInsights({ ...base, pores: null }).pores, null);
});

test('sections follow the step order, name their step, and list what was not run', () => {
  const f = FD.findings({ steps: FD.stepInsights({ ...base, wall: WALL }), regions: [], part: {}, fit: null, calibration: {}, crosscheck: null });
  assert.deepEqual(f.sections.map((s) => s.title), ['Pores (step 2)', 'Walls (step 8)']);
  assert.match(texts(f.sections[0]), /One void holds 80 % of the void volume/);
  assert.ok(f.sections[0].items.every((i) => i.kind === 'bullet'));
  assert.deepEqual(f.notRun, ['Gray-value zones', 'Saved regions', 'Dragonfly cross-check', 'Density calibration', 'CAD comparison', 'Filler']);
});

// Air at gray 700, a 1.01 g/cm³ rod at 2000: an exact line.
const fit = C.fitCalibration([{ name: 'Air', gray: 700, density: 0.0012 }, { name: 'rod', gray: 2000, density: 1.01 }]);
const part = { porosityPercent: 2.5, matrixGray: 2000, airGray: 700 };
const stats = (over) => ({ voxels: 20000, volume_mm3: 1.28, gray_mean: 1990, gray_sd: 60, matrix_gray_mean: 2000, pore_fraction: 0.05, pore_count: 3, ...over });

test('each saved region gets its name, its numbers in one row, and its comparisons with the part, without to-do hints', () => {
  const f = FD.findings({ steps: FD.stepInsights(base), regions: [{ title: 'Skin: top', sub: 'XY z 10–40', stats: stats() }], part, fit: null, calibration: {}, crosscheck: null });
  const r = f.sections.find((s) => s.title === 'Saved regions (step 3)');
  assert.deepEqual(r.items[0], { kind: 'sub', text: 'Skin: top (XY z 10–40)' });
  assert.deepEqual(r.items[1], { kind: 'row', key: 'Numbers', value: '1.28 mm³ · porosity 5.00 % · 3 pores · solid gray 2000' });
  assert.match(texts(r), /Porosity is 2\.0× the whole part's 2\.50 %/);
  assert.doesNotMatch(texts(r), /Outline phantoms|Segment pores/); // what to do next belongs on screen, not on the sheet
  assert.ok(!f.notRun.includes('Saved regions'));
});

test('the density calibration section carries the calibration results; uncalibrated is listed as not run', () => {
  const calibration = { solidGray: 2000, porosityPercent: 2.5, archimedesDensity: 0.97 };
  const f = FD.findings({ steps: FD.stepInsights(base), regions: [], part, fit, calibration, crosscheck: null });
  const c = f.sections.find((s) => s.title === 'Density calibration (step 5)');
  assert.deepEqual(c.items.filter((i) => i.kind === 'row').map((i) => [i.key, i.value]), C.calibrationResults({ fit, ...calibration }).rows);
  assert.ok(!f.notRun.includes('Density calibration'));
  assert.ok(FD.findings({ steps: FD.stepInsights(base), regions: [], part, fit: null, calibration, crosscheck: null }).notRun.includes('Density calibration'));
});

test('the Dragonfly section carries the comparison rows and insights', () => {
  const result = { a: { voxels: 1000, percent: 5.0 }, b: { voxels: 1010, percent: 5.05 }, both_voxels: 995, dice: 0.9925,
    only_a: { voxels: 5, whole_small: 0, whole_large: 0, boundary: 5, outside_region: 0 }, only_b: { voxels: 15, whole_small: 3, whole_large: 0, boundary: 12, outside_region: 0 },
    small_mm3: 0.01, largest_only_a: [], largest_only_b: [], orientation: { x: false, y: true, z: true } };
  const f = FD.findings({ steps: FD.stepInsights(base), regions: [], part, fit: null, calibration: {}, crosscheck: { result, other: 'Dragonfly', files: 503 } });
  const d = f.sections.find((s) => s.title === 'Dragonfly cross-check (step 4)');
  assert.match(texts(d), /Dice: 0\.9925/);
  assert.match(texts(d), /Mask orientation: flipped in y, slices reversed/);
  assert.match(texts(d), /agree/);
});

// A fake measure: every character 0.1 in wide, whatever the size.
const measure = (s) => 0.1 * s.length;

test('text wraps at word breaks inside the width; a word longer than the width gets a line of its own', () => {
  assert.deepEqual(FD.wrap('aaa bbb ccc dd', 0.75, measure), ['aaa bbb', 'ccc dd']);
  assert.deepEqual(FD.wrap('a verylongwordhere b', 0.5, measure), ['a', 'verylongwordhere', 'b']);
  assert.deepEqual(FD.wrap('', 1, measure), []);
});

const GEO = { measure, width: 3, top: 1, bottom: 3, lineH: 0.2, headH: 0.3, gap: 0.1, keyW: 0.8, indent: 0.15 };
const bullets = (n) => Array.from({ length: n }, (_, k) => ({ kind: 'bullet', text: `point ${k}` }));

test('the layout places every line inside the page and starts a new page when the next item does not fit', () => {
  const sections = [{ title: 'A', items: bullets(6) }, { title: 'B', items: bullets(6) }];
  const pages = FD.layout(sections, ['C'], GEO);
  assert.ok(pages.length >= 2);
  for (const page of pages) for (const op of page) assert.ok(op.y >= GEO.top && op.y + GEO.lineH <= GEO.bottom + 1e-9, JSON.stringify(op));
  const all = pages.flat();
  assert.equal(all.filter((o) => o.kind === 'bullet').length, 12);
  assert.equal(all[all.length - 1].text, 'Not run for this sheet: C.');
});

test('a heading never ends a page: it moves to the next page with its first item', () => {
  // A fills the first page to just above the bottom, leaving room for B's heading but not its first line.
  const pages = FD.layout([{ title: 'A', items: bullets(6) }, { title: 'B', items: bullets(1) }], [], GEO);
  for (const page of pages) assert.notEqual(page[page.length - 1].kind, 'heading');
  assert.equal(pages[1][0].text, 'B');
});

test('a row puts its key in the key column and wraps its value beside it', () => {
  const [page] = FD.layout([{ title: 'A', items: [{ kind: 'row', key: 'Dice', value: 'aaaa bbbb cccc' }] }], [], { ...GEO, width: 1.8 });
  const key = page.find((o) => o.kind === 'key'), values = page.filter((o) => o.kind === 'value');
  assert.equal(key.text, 'Dice');
  assert.equal(key.x, 0);
  assert.deepEqual(values.map((v) => [v.text, v.x]), [['aaaa bbbb', 0.8], ['cccc', 0.8]]);
  assert.equal(values[0].y, key.y);
});

test('page numbers: the Findings follow page 1, then the slices, the supporting data and the rainbow page', () => {
  assert.deepEqual(FD.sheetPages(1, false), { findings: [2], slices: 3, data: 4, rainbow: null, total: 4 });
  assert.deepEqual(FD.sheetPages(2, true), { findings: [2, 3], slices: 4, data: 5, rainbow: 6, total: 6 });
});
