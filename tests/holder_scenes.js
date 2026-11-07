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
function diskOnPostScene({ size = 128, seed = 1 } = {}) {
  const n = size, c = (n - 1) / 2, zs = Math.round(0.15 * n), zb = Math.round(0.25 * n), zt = zb + Math.round(0.08 * n);
  const r = (x, y) => Math.hypot(x - c, y - c);
  const holder = (x, y, z) => (z < zs && r(x, y) <= 0.06 * n) || (z >= zs && z < zb && r(x, y) <= 0.11 * n);
  const part = (x, y, z) => z >= zb && z < zt && r(x, y) <= 0.23 * n;
  return buildScene({ size, holder, part, seed });
}

module.exports = { tiltedPostScene, diskOnPostScene };
