'use strict';
// Analytic holder scenes that makeHolderScene does not draw: a tilted post (as in a leveled scan) with a porous part
// resting flat on its top, and a flat round part on a stepped post. Same grays and noise as makeHolderScene: part and
// holder at matrix gray (holder + 600 when bright), air and pores at air gray, 0 outside the FOV circle (0.47 size).
const MATRIX_GRAY = 2000, AIR_GRAY = 700, NOISE_SD = 60, HOLDER_BRIGHT = 600;

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rasterize holder(x, y, z) and part(x, y, z) (part wins), minus pore balls, with noise. */
function buildScene({ size, holder, part, pores = [], holderGray = 'same', seed = 1, voxelMm = 0.16 }) {
  const n = size, c = (n - 1) / 2, fovR = 0.47 * n, N = n * n * n, rnd = random(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const gray = new Float32Array(N), outside = new Uint8Array(N), partMask = new Uint8Array(N), holderMask = new Uint8Array(N);
  const hGray = MATRIX_GRAY + (holderGray === 'bright' ? HOLDER_BRIGHT : 0);
  for (let z = 0, i = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++, i++) {
    if (Math.hypot(x - c, y - c) > fovR) { outside[i] = 1; continue; }
    let mean = AIR_GRAY;
    if (part(x, y, z)) { partMask[i] = 1; if (!pores.some((p) => (x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2 <= p.r * p.r)) mean = MATRIX_GRAY; }
    else if (holder(x, y, z)) { holderMask[i] = 1; mean = hGray; }
    gray[i] = Math.max(1, mean + NOISE_SD * gauss());
  }
  return { gray, outside, dims: { nx: n, ny: n, nz: n }, voxelMm, truth: { part: partMask, holder: holderMask, matrix_gray: MATRIX_GRAY, air_gray: AIR_GRAY } };
}

/** A round post of radius `radius` x size, its axis tilted tiltDeg about y, running off slice 0 to a flat top at 0.4
    size; a porous lumpy part (two ellipsoids, cut flat by the top's plane) rests on that top. */
function tiltedPostScene({ size = 128, radius = 0.15, tiltDeg = 10, seed = 1 } = {}) {
  const n = size, c = (n - 1) / 2, t = (tiltDeg * Math.PI) / 180, a = [Math.sin(t), 0, Math.cos(t)], top = 0.4 * n;
  const base = [c - top * Math.tan(t), c, 0], L = top / Math.cos(t), R = radius * n;
  const local = (x, y, z) => {
    const d = [x - base[0], y - base[1], z - base[2]], along = d[0] * a[0] + d[2] * a[2];
    return { along, off: [d[0] - along * a[0], d[1], d[2] - along * a[2]] };
  };
  // Part lumps in the post frame: centered on the axis above the top, cut flat at the top plane (facet 0.04 size deep).
  const e1 = { h: 0.13 * n, w: 0.2 * n, side: 0 }, e2 = { h: 0.11 * n, w: 0.16 * n, side: 0.07 * n };
  const lump = (e, along, off) => {
    const u = along - (L + e.h - 0.04 * n), v = [off[0], off[1] - e.side, off[2]]; // the second lump sits off to +y
    return (u / e.h) ** 2 + (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) / (e.w * e.w) <= 1;
  };
  const part = (x, y, z) => { const { along, off } = local(x, y, z); return along > L && (lump(e1, along, off) || lump(e2, along, off)); };
  const holder = (x, y, z) => { const { along, off } = local(x, y, z); return along <= L && Math.hypot(...off) <= R; };
  const rnd = random(seed + 99), pores = [];
  const center = [base[0] + (L + 0.08 * n) * a[0], c, (L + 0.08 * n) * a[2]];
  for (let k = 0; k < 400 && pores.length < 20; k++) {
    const p = { x: center[0] + (rnd() - 0.5) * 0.25 * n, y: center[1] + (rnd() - 0.5) * 0.25 * n, z: center[2] + (rnd() - 0.5) * 0.12 * n, r: 2 + 2 * rnd() };
    const ok = [[0, 0, 0], [p.r + 2, 0, 0], [-p.r - 2, 0, 0], [0, p.r + 2, 0], [0, -p.r - 2, 0], [0, 0, p.r + 2], [0, 0, -p.r - 2]].every(([dx, dy, dz]) => part(p.x + dx, p.y + dy, p.z + dz));
    if (ok && !pores.some((q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) < p.r + q.r + 2)) pores.push(p);
  }
  return buildScene({ size, holder, part, pores, seed });
}

/** A stepped post on the z axis (stem 0.06 size to 0.15 size, cap 0.11 size to 0.25 size) under a dense flat disk part
    of radius 0.23 size, 0.08 size thick, coaxial and wider than the cap: a printed disk sitting on the post. */
function diskOnPostScene({ size = 128, seed = 1, holderGray = 'same' } = {}) {
  const n = size, c = (n - 1) / 2, zs = Math.round(0.15 * n), zb = Math.round(0.25 * n), zt = zb + Math.round(0.08 * n);
  const r = (x, y) => Math.hypot(x - c, y - c);
  const holder = (x, y, z) => (z < zs && r(x, y) <= 0.06 * n) || (z >= zs && z < zb && r(x, y) <= 0.11 * n);
  const part = (x, y, z) => z >= zb && z < zt && r(x, y) <= 0.23 * n;
  return buildScene({ size, holder, part, seed, holderGray });
}

/** A two-tier round part, a flat disk (radius 0.23 size) with a coaxial boss (radius 0.15 size) on top, resting on the
    same stepped post as diskOnPostScene, all at one gray: the boss looks like one more post step, so shape detection
    may take a tier of the part. */
function twoTierRoundScene({ size = 128, seed = 1 } = {}) {
  const n = size, c = (n - 1) / 2, zs = Math.round(0.15 * n), zb = Math.round(0.25 * n), zd = zb + Math.round(0.08 * n), zt = zd + Math.round(0.12 * n);
  const r = (x, y) => Math.hypot(x - c, y - c);
  const holder = (x, y, z) => (z < zs && r(x, y) <= 0.06 * n) || (z >= zs && z < zb && r(x, y) <= 0.11 * n);
  const part = (x, y, z) => (z >= zb && z < zd && r(x, y) <= 0.23 * n) || (z >= zd && z < zt && r(x, y) <= 0.15 * n);
  return buildScene({ size, holder, part, seed });
}

// Synthetic holder STLs, built in grid voxel coordinates and returned in mm (voxel x voxelMm), wound counter-clockwise
// seen from outside.
const SEGMENTS = 48;
/** A closed surface of revolution about the z line through (cx, cy): profile is [r, z] from the bottom center to the
    top center. */
function lathe(profile, [cx, cy]) {
  const out = [], at = (r, z, k) => { const a = (2 * Math.PI * k) / SEGMENTS; return [cx + r * Math.cos(a), cy + r * Math.sin(a), z]; };
  for (let s = 0; s + 1 < profile.length; s++) {
    const [ra, za] = profile[s], [rb, zb] = profile[s + 1];
    for (let k = 0; k < SEGMENTS; k++) {
      const a = at(ra, za, k), b = at(ra, za, k + 1), c = at(rb, zb, k + 1), d = at(rb, zb, k);
      if (ra > 0) out.push(...a, ...b, ...c);
      if (rb > 0) out.push(...a, ...c, ...d);
    }
  }
  return out;
}
/** An oriented box: rows u, v (w = u x v), half extents h. */
function box(center, u, v, h) {
  const w = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], e = [u, v, w], out = [];
  const pt = (s) => [0, 1, 2].map((r) => center[r] + s[0] * h[0] * e[0][r] + s[1] * h[1] * e[1][r] + s[2] * h[2] * e[2][r]);
  for (let k = 0; k < 3; k++) for (const side of [1, -1]) {
    const a = (k + 1) % 3, b = (k + 2) % 3, corner = (p, q) => { const s = [0, 0, 0]; s[k] = side; s[a] = p; s[b] = q; return pt(s); };
    const quad = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    if (side < 0) quad.reverse();
    out.push(...quad[0], ...quad[1], ...quad[2], ...quad[0], ...quad[2], ...quad[3]);
  }
  return out;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
const mat = (R, v) => [0, 1, 2].map((r) => R[3 * r] * v[0] + R[3 * r + 1] * v[1] + R[3 * r + 2] * v[2]);
const matT = (R, v) => [0, 1, 2].map((c) => R[c] * v[0] + R[3 + c] * v[1] + R[6 + c] * v[2]);
function rotation(axis, deg) {
  const [x, y, z] = norm(axis), t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), k = 1 - c;
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
}

/** Voxel-coordinate triangles to a CAD frame 10 voxels and 15 degrees off the scan: CAD = D(voxel x voxelMm). Returns
    the CAD triangles (mm), the true pose (CAD mm -> grid voxels) and D for mapping reference points and directions. */
function displaced(voxTri, voxelMm, pivotVox) {
  const Rd = rotation([1, 1, 0], 15), shift = [6 * voxelMm, 0, 8 * voxelMm], pivot = pivotVox.map((v) => v * voxelMm);
  const D = (p) => mat(Rd, p.map((v, k) => v - pivot[k])).map((v, k) => v + pivot[k] + shift[k]);
  const tri = new Float32Array(voxTri.length);
  for (let i = 0; i < voxTri.length; i += 3) tri.set(D([voxTri[i], voxTri[i + 1], voxTri[i + 2]].map((v) => v * voxelMm)), i);
  // pose: voxel = Rdᵀ(cad - pivot - shift)/voxelMm + pivot/voxelMm
  const R = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => Rd[3 * c + r] / voxelMm));
  const t = matT(Rd, pivot.map((v, k) => -v - shift[k])).map((v, k) => v / voxelMm + pivotVox[k]);
  return { tri, truth: { R, t }, cadPoint: (vox) => D(vox.map((v) => v * voxelMm)), cadDir: (d) => mat(Rd, d) };
}

module.exports = { tiltedPostScene, diskOnPostScene, twoTierRoundScene, lathe, box, cross, mat, matT, norm, rotation, displaced };
