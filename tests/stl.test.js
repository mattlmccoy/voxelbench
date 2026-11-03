'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const St = require('../app/vb_stl.js');

/** The 12 triangles of an axis-aligned box, wound counter-clockwise seen from outside. */
function boxTriangles([x0, y0, z0], [x1, y1, z1]) {
  const v = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const out = [];
  for (const [a, b, c, d] of quads) out.push(...v(a), ...v(b), ...v(c), ...v(a), ...v(c), ...v(d));
  return Float32Array.from(out);
}

test('a binary box round-trips, with outward normals recomputed from the winding', () => {
  const mesh = St.parseStl(St.writeStl(boxTriangles([0, 0, 0], [10, 10, 10])));
  assert.equal(mesh.triangles, 12);
  assert.deepEqual([...mesh.bounds.min], [0, 0, 0]);
  assert.deepEqual([...mesh.bounds.max], [10, 10, 10]);
  for (let t = 0; t < 12; t++) {
    const n = mesh.normals.subarray(3 * t, 3 * t + 3);
    const c = [0, 1, 2].map((k) => (mesh.positions[9 * t + k] + mesh.positions[9 * t + 3 + k] + mesh.positions[9 * t + 6 + k]) / 3);
    assert.ok(n[0] * (c[0] - 5) + n[1] * (c[1] - 5) + n[2] * (c[2] - 5) > 0, `triangle ${t} normal points in`);
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-6);
  }
});

test('the same box as ASCII STL parses to the same triangles', () => {
  const tri = boxTriangles([0, 0, 0], [10, 10, 10]);
  let s = 'solid box\n';
  for (let t = 0; t < 12; t++) {
    s += ' facet normal 0 0 0\n  outer loop\n';
    for (let k = 0; k < 3; k++) s += `   vertex ${tri[9 * t + 3 * k]} ${tri[9 * t + 3 * k + 1]} ${tri[9 * t + 3 * k + 2]}\n`;
    s += '  endloop\n endfacet\n';
  }
  s += 'endsolid box\n';
  const mesh = St.parseStl(new TextEncoder().encode(s).buffer);
  assert.equal(mesh.triangles, 12);
  assert.deepEqual([...mesh.positions], [...tri]);
});

test('measurement points cover the surface at the spacing, each with its face normal', () => {
  const mesh = St.parseStl(St.writeStl(boxTriangles([0, 0, 0], [10, 10, 10])));
  const m = St.measurePoints(mesh, { spacing: 2 });
  const n = m.points.length / 3;
  assert.ok(n > 6 * 25, `${n} points`);
  for (let i = 0; i < n; i++) {
    const p = m.points.subarray(3 * i, 3 * i + 3);
    const onFace = [0, 1, 2].some((k) => Math.abs(p[k]) < 1e-4 || Math.abs(p[k] - 10) < 1e-4);
    assert.ok(onFace && p.every((x) => x > -1e-4 && x < 10 + 1e-4), `point ${i} off the surface`);
    const nn = m.normals.subarray(3 * i, 3 * i + 3);
    assert.deepEqual([...nn], [...mesh.normals.subarray(3 * m.tri[i], 3 * m.tri[i] + 3)]);
  }
  for (let f = 0; f < m.faces.length; f += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const i = m.faces[f + a], j = m.faces[f + b];
      const d = Math.hypot(m.points[3 * i] - m.points[3 * j], m.points[3 * i + 1] - m.points[3 * j + 1], m.points[3 * i + 2] - m.points[3 * j + 2]);
      assert.ok(d <= 2 * Math.SQRT2 + 1e-4, `display edge ${d}`);
    }
  }
});

test('the spacing grows to keep the point count under maxPoints, and inch units scale to mm', () => {
  const mesh = St.parseStl(St.writeStl(boxTriangles([0, 0, 0], [10, 10, 10])));
  const m = St.measurePoints(mesh, { spacing: 0.1, maxPoints: 5000 });
  assert.ok(m.points.length / 3 <= 5000, `${m.points.length / 3}`);
  assert.ok(m.spacing > 0.1);
  const inch = St.measurePoints(St.parseStl(St.writeStl(boxTriangles([0, 0, 0], [1, 1, 1]))), { spacing: 5, unitMm: 25.4 });
  assert.ok(Math.max(...inch.points) > 25.3);
});

test('a truncated binary file throws', () => {
  const buf = new ArrayBuffer(84);
  new DataView(buf).setUint32(80, 1000, true);
  assert.throws(() => St.parseStl(buf), /Not an STL file/);
});

test('points on sharp edges (a crease over 30°) are flagged; the diagonal inside a flat face is not', () => {
  const m = St.measurePoints(St.parseStl(St.writeStl(boxTriangles([0, 0, 0], [10, 10, 10]))), { spacing: 2 });
  for (let i = 0; i < m.points.length / 3; i++) {
    const p = [...m.points.subarray(3 * i, 3 * i + 3)];
    const onBoundary = p.filter((v) => Math.abs(v) < 1e-4 || Math.abs(v - 10) < 1e-4).length >= 2; // on two faces at once
    assert.equal(m.edge[i], onBoundary ? 1 : 0, `point ${p} edge ${m.edge[i]}`);
  }
});
