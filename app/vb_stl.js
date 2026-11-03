/* STL meshes for the CAD comparison: read binary or ASCII STL, and refine the triangles into measurement points,
   each carrying its triangle's outward normal. STL has no unit; the caller passes mm per file unit. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBStl = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Unit normals from the vertex winding (counter-clockwise seen from outside), never the file's own. */
  function faceNormals(positions) {
    const n = positions.length / 9, out = new Float32Array(3 * n);
    for (let t = 0; t < n; t++) {
      const p = positions.subarray(9 * t, 9 * t + 9);
      const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, len = Math.hypot(x, y, z) || 1;
      out[3 * t] = x / len; out[3 * t + 1] = y / len; out[3 * t + 2] = z / len;
    }
    return out;
  }

  function meshOf(positions) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) { const k = i % 3; if (positions[i] < min[k]) min[k] = positions[i]; if (positions[i] > max[k]) max[k] = positions[i]; }
    return { positions, normals: faceNormals(positions), triangles: positions.length / 9, bounds: { min, max } };
  }

  function parseStl(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 15) throw new Error('Not an STL file: too short.');
    const view = new DataView(buffer);
    const count = buffer.byteLength >= 84 ? view.getUint32(80, true) : -1;
    if (count > 0 && 84 + 50 * count === buffer.byteLength) {
      const positions = new Float32Array(9 * count);
      for (let t = 0; t < count; t++) for (let k = 0; k < 9; k++) positions[9 * t + k] = view.getFloat32(84 + 50 * t + 12 + 4 * k, true);
      return meshOf(positions);
    }
    const text = new TextDecoder().decode(new Uint8Array(buffer));
    if (!/^\s*solid/.test(text)) throw new Error(`Not an STL file: a binary STL of ${count} triangles would be ${84 + 50 * count} bytes, this is ${buffer.byteLength}.`);
    const values = [];
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) values.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!values.length || values.length % 9 || values.some((v) => !Number.isFinite(v))) throw new Error('Not an STL file: the ASCII facets do not hold whole triangles of numbers.');
    return meshOf(Float32Array.from(values));
  }

  function writeStl(positions) {
    const n = positions.length / 9, buf = new ArrayBuffer(84 + 50 * n), view = new DataView(buf), normals = faceNormals(positions);
    view.setUint32(80, n, true);
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 3; k++) view.setFloat32(84 + 50 * t + 4 * k, normals[3 * t + k], true);
      for (let k = 0; k < 9; k++) view.setFloat32(84 + 50 * t + 12 + 4 * k, positions[9 * t + k], true);
    }
    return buf;
  }

  const segments = (p, t, spacing) => {
    const q = p.subarray(9 * t, 9 * t + 9);
    const e = Math.max(Math.hypot(q[3] - q[0], q[4] - q[1], q[5] - q[2]), Math.hypot(q[6] - q[0], q[7] - q[1], q[8] - q[2]), Math.hypot(q[6] - q[3], q[7] - q[4], q[8] - q[5]));
    return Math.max(1, Math.ceil(e / spacing - 1e-9));
  };

  const CREASE_COS = Math.cos(Math.PI / 6); // edges where the faces turn by more than 30° are sharp

  /** Per triangle, which of its edges (AB, BC, CA) are sharp: a crease over 30°, or an open edge with no neighbor. */
  function sharpEdges(mesh) {
    const key = (p, i) => `${Math.round(p[i] * 1e5)},${Math.round(p[i + 1] * 1e5)},${Math.round(p[i + 2] * 1e5)}`;
    const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const owners = new Map(), keys = [];
    for (let t = 0; t < mesh.triangles; t++) {
      const v = [0, 1, 2].map((k) => key(mesh.positions, 9 * t + 3 * k));
      const e = [edgeKey(v[0], v[1]), edgeKey(v[1], v[2]), edgeKey(v[2], v[0])];
      keys.push(e);
      for (const k of e) (owners.get(k) || owners.set(k, []).get(k)).push(t);
    }
    const n = mesh.normals;
    return keys.map((e, t) => e.map((k) => {
      const others = owners.get(k).filter((u) => u !== t);
      return !others.length || others.some((u) => n[3 * t] * n[3 * u] + n[3 * t + 1] * n[3 * u + 1] + n[3 * t + 2] * n[3 * u + 2] < CREASE_COS);
    }));
  }

  /** Barycentric grid on every triangle with edges no longer than the spacing (mm), raised until the points fit
      maxPoints. Points are not shared between triangles, so each keeps its own triangle's normal; edge marks the
      points on sharp edges, where a deviation along one face's normal is not defined. */
  function measurePoints(mesh, { spacing, maxPoints = 400000, unitMm = 1 }) {
    const p = unitMm === 1 ? mesh.positions : mesh.positions.map((v) => v * unitMm);
    let step = spacing, total = Infinity;
    for (;;) {
      total = 0;
      for (let t = 0; t < mesh.triangles; t++) { const n = segments(p, t, step); total += ((n + 1) * (n + 2)) / 2; }
      if (total <= maxPoints) break;
      step *= 1.25;
    }
    const points = new Float32Array(3 * total), normals = new Float32Array(3 * total), tri = new Uint32Array(total), edge = new Uint8Array(total), faces = [];
    const sharp = sharpEdges(mesh);
    let w = 0;
    for (let t = 0; t < mesh.triangles; t++) {
      const n = segments(p, t, step), q = p.subarray(9 * t, 9 * t + 9), base = w, [ab, bc, ca] = sharp[t];
      const at = (i, j) => base + j * (n + 1) - (j * (j - 1)) / 2 + i; // row j holds n + 1 - j points
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i + j <= n; i++, w++) {
          const a = i / n, b = j / n;
          for (let k = 0; k < 3; k++) { points[3 * w + k] = q[k] + a * (q[3 + k] - q[k]) + b * (q[6 + k] - q[k]); normals[3 * w + k] = mesh.normals[3 * t + k]; }
          tri[w] = t;
          edge[w] = (ab && j === 0) || (ca && i === 0) || (bc && i + j === n) ? 1 : 0;
          if (i + j < n) faces.push(at(i, j), at(i + 1, j), at(i, j + 1));
          if (i + j + 1 < n) faces.push(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
        }
      }
    }
    return { points, normals, tri, edge, faces: Uint32Array.from(faces), spacing: step };
  }

  return { parseStl, writeStl, measurePoints, faceNormals };
}));
