'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../app/vb_feedback.js');
const C = require('../app/vb_calibration.js');

// Air at gray 700, a 1.01 g/cm³ rod at 2000: an exact line.
const fit = C.fitCalibration([{ name: 'Air', gray: 700, density: 0.0012 }, { name: 'rod', gray: 2000, density: 1.01 }]);
const part = { porosityPercent: 2.5, matrixGray: 2000, airGray: 700 };
const stats = (over) => ({ voxels: 20000, volume_mm3: 1.28, gray_mean: 1990, gray_sd: 60, matrix_gray_mean: 2000, pore_fraction: 0.025, pore_count: 3, ...over });
const row = (card, key) => (card.rows.find((r) => r[0] === key) || [])[1];

test('a region card lists volume, gray, porosity, pores, solid gray and equivalent density', () => {
  const card = F.regionCard({ title: 'Region A', stats: stats(), part, fit });
  assert.equal(card.title, 'Region A');
  assert.equal(row(card, 'Volume'), '1.28 mm³ (20,000 voxels)');
  assert.equal(row(card, 'Gray'), '1990 ± 60');
  assert.equal(row(card, 'Porosity'), '2.50 %');
  assert.equal(row(card, 'Pores inside'), '3');
  assert.equal(row(card, 'Solid gray'), '2000');
  assert.equal(row(card, 'Eq. density (solid)'), '1.010 g/cm³');
});

test('porosity is compared with the whole part: same, more porous, denser, no pores', () => {
  const said = (pf) => F.regionCard({ title: 'R', stats: stats({ pore_fraction: pf }), part, fit }).insights.join(' ');
  assert.match(said(0.026), /about the same as the whole part \(2\.50 %\)/);
  assert.match(said(0.10), /4\.0× the whole part's 2\.50 %: more porous here/);
  assert.match(said(0.005), /5\.0× lower than the whole part's 2\.50 %: denser here/);
  assert.match(said(0), /No pores inside; the whole part has 2\.50 %/);
});

test('solid gray is compared with the part solid, referenced to air', () => {
  const said = (m) => F.regionCard({ title: 'R', stats: stats({ matrix_gray_mean: m }), part, fit }).insights.join(' ');
  assert.match(said(2005), /within 1 % of the part's solid/);
  assert.match(said(2065), /\+5\.0 % vs the part's solid/); // (2065 - 700) / (2000 - 700) - 1
  assert.match(said(1935), /-5\.0 % vs the part's solid/);
});

test('a region card says what to run when numbers are missing, and warns on small or empty regions', () => {
  const bare = F.regionCard({ title: 'R', stats: stats({ pore_fraction: null, pore_count: null, matrix_gray_mean: null }), part: { porosityPercent: null, matrixGray: null, airGray: null }, fit: null });
  assert.equal(row(bare, 'Porosity'), undefined);
  assert.match(bare.insights.join(' '), /Segment pores \(step 2\)/);
  assert.match(bare.insights.join(' '), /phantoms in step 5/);
  // the to-do hints are also named apart, so the review sheet can leave them out
  assert.deepEqual(bare.todo, bare.insights.filter((t) => /Segment pores|phantoms in step 5/.test(t)));
  assert.equal(bare.todo.length, 2);
  assert.match(F.regionCard({ title: 'R', stats: stats({ voxels: 400 }), part, fit }).insights.join(' '), /Small region \(400 voxels\)/);
  const empty = F.regionCard({ title: 'R', stats: stats({ voxels: 0 }), part, fit });
  assert.deepEqual(empty.rows, []);
  assert.match(empty.insights[0], /no voxels inside the field of view/);
});

test('an outline annotation shows its area and its own slice, and points to Draw region for 3-D', () => {
  const card = F.annotationCard({ annotation: { kind: 'polygon', area_mm2: 3.4217, plane: 'XY', slice: 80 }, title: 'Mid-gray region', sliceStats: stats(), part, fit });
  assert.equal(card.rows[0][0], 'Area');
  assert.equal(card.rows[0][1], '3.42 mm² (XY slice 80, 20,000 voxels)');
  assert.equal(row(card, 'Volume'), undefined); // one slice has no volume worth reading
  assert.equal(row(card, 'Porosity'), '2.50 %');
  assert.match(card.insights.join(' '), /on this one slice/);
  assert.match(card.insights.join(' '), /Draw region in step 3/);
});

test('a point shows its gray, its equivalent density and the pore it sits in', () => {
  const card = F.annotationCard({ annotation: { kind: 'point', mm: [{ x: 1, y: 2.5, z: 3.25 }] }, title: 'Pore', point: { gray: 2000, pore: { id: 7, diameter_mm: 0.1234 } }, part, fit });
  assert.equal(row(card, 'Position'), '1.00, 2.50, 3.25 mm');
  assert.equal(row(card, 'Gray'), '2000');
  assert.equal(row(card, 'Eq. density'), '1.010 g/cm³');
  assert.equal(row(card, 'Inside'), 'pore 7, ESD 0.123 mm');
  assert.match(card.insights.join(' '), /one voxel/);
});

test('a measurement shows its length and how to check it against a nominal', () => {
  const card = F.annotationCard({ annotation: { kind: 'caliper', length_mm: 4.567, plane: 'XZ', slice: 12 }, title: 'Crack', part, fit: null });
  assert.equal(row(card, 'Length'), '4.57 mm (XZ slice 12)');
  assert.match(card.insights.join(' '), /nominal and tolerance in the dimension table \(step 4\)/);
});

test('a measurement with a nominal shows the band, the deviation and pass or fail', () => {
  const a = { kind: 'caliper', length_mm: 10.08, plane: 'XY', slice: 3, nominal_mm: 10, tol_minus_mm: 0.05, tol_plus_mm: 0.1 };
  const pass = F.annotationCard({ annotation: a, title: 'Width', check: { deviation: 0.08, pass: true }, part, fit: null });
  assert.equal(row(pass, 'Nominal'), '10.000 −0.050 / +0.100 mm');
  assert.equal(row(pass, 'Deviation'), '+0.080 mm');
  assert.match(pass.insights.join(' '), /Within tolerance/);
  const fail = F.annotationCard({ annotation: { ...a, length_mm: 9.9 }, title: 'Width', check: { deviation: -0.1, pass: false }, part, fit: null });
  assert.match(fail.insights.join(' '), /Out of tolerance by 0\.050 mm \(undersize\)/);
});

// Marks on XY: a square region over slices 10-20, an outline, a point and a line on slice 15.
const marks = {
  regions: [{ id: 'r1', plane: 'XY', slice_from: 10, slice_to: 20, points: [{ col: 10, row: 10 }, { col: 30, row: 10 }, { col: 30, row: 30 }, { col: 10, row: 30 }] }],
  annotations: [
    { id: 'o1', kind: 'polygon', plane: 'XY', slice: 15, voxels: [{ x: 50, y: 50, z: 15 }, { x: 60, y: 50, z: 15 }, { x: 60, y: 60, z: 15 }] },
    { id: 'p1', kind: 'point', plane: 'XY', slice: 15, voxels: [{ x: 80, y: 80, z: 15 }] },
    { id: 'c1', kind: 'caliper', plane: 'XY', slice: 15, voxels: [{ x: 0, y: 100, z: 15 }, { x: 40, y: 100, z: 15 }] },
  ],
};
const at = (col, row, slice = 15, plane = 'XY') => { const m = F.markAt({ plane, slice, col, row }, marks); return m && m.id; };

test('a click on the image picks the mark under it', () => {
  assert.equal(at(20, 20), 'r1');
  assert.equal(at(58, 52), 'o1');
  assert.equal(at(81, 79), 'p1'); // within a few voxels of the point
  assert.equal(at(20, 101), 'c1'); // near the line
  assert.equal(at(5, 5), null);
});

test('marks only count on their own plane and slices', () => {
  assert.equal(at(20, 20, 25), null); // past the region's slices
  assert.equal(at(58, 52, 16), null); // an outline lives on one slice
  assert.equal(at(20, 20, 15, 'XZ'), null);
});

test('the point or line wins over the region it sits in', () => {
  const inside = { regions: marks.regions, annotations: [{ id: 'p2', kind: 'point', plane: 'XY', slice: 15, voxels: [{ x: 20, y: 20, z: 15 }] }] };
  assert.equal(F.markAt({ plane: 'XY', slice: 15, col: 20, row: 20 }, inside).id, 'p2');
});

test('a region card reads its mean gray as relative density against each dense reference', () => {
  const rel = C.relativeScale({ airGray: 700, dense: [{ material: 'natural', gray: 2000 }] });
  const card = F.regionCard({ title: 'R', stats: stats({ gray_mean: 1350 }), part, fit: null, relative: rel });
  assert.equal(row(card, 'Relative density (natural)'), '0.50 of dense (mean gray, pores included)');
});
