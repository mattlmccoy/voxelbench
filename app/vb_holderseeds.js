/* Seeds for holder finding (vb_holder.js findHolder). Two kinds of evidence, chosen per scan:
   - brightness: a gray population above the part's main peak whose largest connected body is holder-sized;
   - shape: per-slice 2-D components in all three slice directions that are round disks or long straight bars,
     linked into chains when the same disk or bar repeats over consecutive slices.
   Every limit is a scale-free ratio, a few-voxel resolution allowance, or a multiple of the part's own gray spread.
   Volume index i = x + nx * (y + ny * z). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ct_pores.js'));
  else root.VBHolderSeeds = factory(root.CTPores);
}(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const HIST_BINS = 1024;      // gray histogram resolution over the solid's own gray range
  const DEEP = 3;              // voxels: gray statistics come from voxels this far inside the solid (past the smoothing
                               // blur and the partial-volume voxel; the same depth as vb_holder's even-gray core)
  const BRIGHT_SIGMAS = 5;     // bright = beyond 5 part-spreads above the part's peak (Gaussian tail share ~3e-7)
  const BRIGHT_DOMINANT = 0.5; // the largest bright body holds at least this share of all bright voxels
  const BRIGHT_MIN_SHARE = 0.01; // and at least this share of the solid: a holder, not an inclusion
  const EDGE_REACH = 2;        // voxels: "reaches the edge" = within this of the outside mask or the volume border
  const MIN_AREA = 12;         // pixels: a 2-D component smaller than a radius-2 disk has no measurable shape
  const DISK_ASPECT = 1.15;    // round: longest over shortest moment axis
  const DISK_FILL = 0.9;       // round: area over the disk of the same second moment
  const DISK_EDGE_ALLOW = 1;   // voxels: farthest pixel at most the moment ellipse's long semi-axis plus one voxel (a
                               // square's corner is 22 % out)
  const CLIPPED = 0.25;        // a component with more than this share of its outline on the scan edge is cut by the FOV, not round
  const BAR_ASPECT = 3;        // bar: length over width
  const BAR_FILL = 0.9;        // bar: area over the rectangle of the same second moments
  const BAR_MIN_WIDTH = 2;     // voxels: thinner than this is tape, not a plate
  const LINK_OVERLAP = 0.5;    // consecutive slices: shared pixels over the smaller component
  const RADIUS_TOL = [0.5, 0.03]; // same disk on the next slice: |dR| <= 0.5 voxel + 3 % of R
  const DISK_SHIFT = 1;        // voxels: same disk on the next slice: center moves at most this (a round section means
                               // the post's axis is within ~30 degrees of the slice normal, a shift under 0.6 voxel)
  const WIDTH_TOL = [0.5, 0.1];   // same bar on the next slice: |dW| <= 0.5 voxel + 10 % of W
  const ANGLE_TOL = (10 * Math.PI) / 180; // same bar on the next slice: in-slice direction within 10 degrees
  const CHAIN_SPREAD = [1, 0.05]; // a disk chain: max - min radius <= 1 voxel + 5 %: a straight wall (a bar's width
                                  // also shrinks where the FOV circle cuts its ends obliquely, so bars rely on the per-step link)
  const MIN_SLICES = 3;        // a chain repeats over at least this many slices
  const MAX_POINTS = 1 << 21;  // fit points kept over all chains (voxels are sampled evenly past this)

  /** The part's main gray peak in the solid and its spread (a Gaussian sigma from the peak's lower half width; the
      lower side is free of any brighter holder): the histogram mode, or the lower of two separated populations.
      Counted over voxels at least DEEP inside the solid (all solid when too few are), so partial-volume layers at
      surfaces, which pile up as narrow peaks on a large flat plate, do not pose as a material. null for an empty solid. */
  function grayStats(smoothed, solid, dims) {
    const deep = P.boxErode(solid, dims, DEEP);
    let all = 0, inner = 0;
    for (let i = 0; i < solid.length; i++) { all += solid[i]; inner += deep[i] & solid[i]; }
    if (!all) return null;
    const use = inner >= BRIGHT_MIN_SHARE * all ? (i) => deep[i] & solid[i] : (i) => solid[i];
    let lo = Infinity, hi = -Infinity, count = 0;
    for (let i = 0; i < solid.length; i++) if (use(i)) { const g = smoothed[i]; if (g < lo) lo = g; if (g > hi) hi = g; count++; }
    const width = Math.max((hi - lo) / HIST_BINS, 1e-6), hist = new Float64Array(HIST_BINS + 1);
    for (let i = 0; i < solid.length; i++) if (use(i)) hist[Math.floor((smoothed[i] - lo) / width)]++;
    // A peak's spread is its lower half width (a brighter holder cannot reach that side) as a Gaussian sigma, on the
    // histogram smoothed by half that sigma (refined a few times, the kernel's own width taken off), so a sparse,
    // spiky histogram gives a stable peak and spread.
    const smooth = (sk) => {
      const r = Math.ceil(3 * sk), k = Array.from({ length: 2 * r + 1 }, (_, j) => Math.exp(-((j - r) ** 2) / (2 * sk * sk)));
      return hist.map((_, b) => { let v = 0; for (let j = -r; j <= r; j++) v += (hist[b + j] || 0) * k[j + r]; return v; });
    };
    const peakOf = (g, from, to) => { let m = from; for (let b = from; b < to; b++) if (g[b] > g[m]) m = b; return m; };
    const sigmaAt = (g, m, sk) => { let b = m; while (b > 0 && g[b] > g[m] / 2) b--; return Math.sqrt(Math.max(1, ((m - b) / Math.sqrt(2 * Math.log(2))) ** 2 - sk * sk)); };
    let sk = 1, soft = smooth(sk), mode = peakOf(soft, 0, soft.length);
    for (let it = 0; it < 3; it++) { sk = Math.max(1, sigmaAt(soft, mode, sk) / 2); soft = smooth(sk); mode = peakOf(soft, 0, soft.length); }
    // A bright holder with more voxels than the part owns the mode. The part is then a separate population below it:
    // its own peak more than BRIGHT_SIGMAS spreads down, with a valley under half its height in between, holding at
    // least BRIGHT_MIN_SHARE of the solid. (A part's partial-volume tail rises toward its peak, so it has no valley.)
    const below = mode - Math.ceil(BRIGHT_SIGMAS * sigmaAt(soft, mode, sk));
    const low = below > 0 ? peakOf(soft, 0, below) : -1;
    if (low >= 0) {
      let valley = low, share = 0;
      for (let b = low; b < mode; b++) if (soft[b] < soft[valley]) valley = b;
      for (let b = 0; b <= valley; b++) share += hist[b];
      if (soft[valley] < soft[low] / 2 && share >= BRIGHT_MIN_SHARE * count) mode = low;
    }
    const sigma = () => Math.max(1, sigmaAt(soft, mode, sk)) * width;
    return { peak: lo + (mode + 0.5) * width, spread: sigma(), lo, width, hist, count };
  }

  /** Voxels within EDGE_REACH of the outside mask (the volume border is checked by coordinates). */
  const nearEdgeMask = (outside, dims) => P.boxDilate(outside, dims, EDGE_REACH);
  const nearBorder = (k, n) => k < EDGE_REACH || k >= n - EDGE_REACH;

  /** The bright holder body { mask, peak (the bright population's gray) }, or null. Bright voxels are the solid above the midpoint of the part's peak and the
      bright population's own peak; the largest connected body must hold most of them, be a real share of the solid
      and reach the scan edge (bright inclusions are many, small and inside the part). */
  function brightBody(smoothed, solid, nearEdge, dims, stats) {
    const { peak, spread, lo, width, hist, count } = stats, from = Math.floor((peak + BRIGHT_SIGMAS * spread - lo) / width) + 1;
    let top = -1;
    for (let b = Math.max(0, from); b < hist.length; b++) if (top < 0 || hist[b] > hist[top]) top = b;
    if (top < 0 || !hist[top]) return null;
    const cut = Math.max((peak + lo + (top + 0.5) * width) / 2, peak + BRIGHT_SIGMAS * spread);
    const bright = new Uint8Array(solid.length);
    let total = 0;
    for (let i = 0; i < solid.length; i++) if (solid[i] && smoothed[i] > cut) { bright[i] = 1; total++; }
    if (!total) return null;
    const { labels, count: n, sizes } = P.label(bright, dims);
    let big = 1;
    for (let l = 2; l <= n; l++) if (sizes[l] > sizes[big]) big = l;
    if (sizes[big] < BRIGHT_DOMINANT * total || sizes[big] < BRIGHT_MIN_SHARE * count) return null;
    let edge = false;
    for (let z = 0, i = 0; z < dims.nz; z++) for (let y = 0; y < dims.ny; y++) for (let x = 0; x < dims.nx; x++, i++) {
      bright[i] = labels[i] === big ? 1 : 0;
      if (bright[i] && (nearEdge[i] || nearBorder(x, dims.nx) || nearBorder(y, dims.ny) || nearBorder(z, dims.nz))) edge = true;
    }
    return edge ? { mask: bright, peak: lo + (top + 0.5) * width } : null;
  }

  /** Air's gray: the mode of the smoothed gray over the reconstruction outside the solid. */
  function airPeak(smoothed, solid, outside) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < solid.length; i++) if (!solid[i] && !outside[i]) { const g = smoothed[i]; if (g < lo) lo = g; if (g > hi) hi = g; }
    if (!(hi >= lo)) return 0;
    const width = Math.max((hi - lo) / HIST_BINS, 1e-6), hist = new Float64Array(HIST_BINS + 1);
    for (let i = 0; i < solid.length; i++) if (!solid[i] && !outside[i]) hist[Math.floor((smoothed[i] - lo) / width)]++;
    let mode = 0;
    for (let b = 1; b < hist.length; b++) if (hist[b] > hist[mode]) mode = b;
    return lo + (mode + 0.5) * width;
  }

  // Slice frames: direction d slices along axis d; (u, v) are the other two axes in order.
  const FRAMES = [[1, 2], [0, 2], [0, 1]];
  const within = (a, b, [abs, rel]) => Math.abs(a - b) <= abs + rel * Math.max(a, b);

  /** Shape and size of one 2-D component from its sums; kind 'disk', 'bar' or null (maxD2 checked later). */
  function classify(c) {
    if (c.n < MIN_AREA) return null;
    c.mu = c.su / c.n; c.mv = c.sv / c.n;
    const cuu = c.suu / c.n - c.mu * c.mu, cvv = c.svv / c.n - c.mv * c.mv, cuv = c.suv / c.n - c.mu * c.mv;
    const h = Math.sqrt(((cuu - cvv) / 2) ** 2 + cuv * cuv), l1 = (cuu + cvv) / 2 + h, l2 = Math.max(1e-9, (cuu + cvv) / 2 - h);
    c.angle = 0.5 * Math.atan2(2 * cuv, cuu - cvv);
    const R = Math.sqrt(2 * (l1 + l2));
    c.semi = 2 * Math.sqrt(l1); // the long semi-axis of the ellipse with these moments (a tilted post's section)
    if (Math.sqrt(l1 / l2) <= DISK_ASPECT && c.n >= DISK_FILL * Math.PI * R * R && c.perimEdge <= CLIPPED * c.perim) { c.size = R; return 'disk'; }
    const L = Math.sqrt(12 * l1), W = Math.sqrt(12 * l2);
    if (L >= BAR_ASPECT * W && W >= BAR_MIN_WIDTH && c.n >= BAR_FILL * L * W) { c.size = W; return 'bar'; }
    return null;
  }

  function linked(a, b, shared) {
    if (a.kind !== b.kind || shared < LINK_OVERLAP * Math.min(a.n, b.n)) return false;
    if (a.kind === 'disk') return within(a.size, b.size, RADIUS_TOL) && Math.hypot(a.mu - b.mu, a.mv - b.mv) <= DISK_SHIFT;
    const turn = Math.abs(a.angle - b.angle) % Math.PI;
    return within(a.size, b.size, WIDTH_TOL) && Math.min(turn, Math.PI - turn) <= ANGLE_TOL;
  }

  /** Chains of disks (kind 'post') and bars (kind 'plate') in mask, over all three slice directions. A chain is
      { kind, dir, edge, voxels, points: Float32Array xyz } with points sampled evenly when there are many. tick() is
      called once per slice per direction. */
  function sliceChains(mask, nearEdge, dims, tick) {
    const { nx, ny, nz } = dims, size = [nx, ny, nz], stride = [1, nx, nx * ny];
    let solidCount = 0;
    for (let i = 0; i < mask.length; i++) solidCount += mask[i];
    const every = Math.max(1, Math.ceil((3 * solidCount) / MAX_POINTS));
    const keep = (g) => every === 1 || ((Math.imul(g, 2654435761) >>> 0) % every) === 0;
    const chains = [];
    for (let d = 0; d < 3; d++) {
      const [ua, va] = FRAMES[d], nu = size[ua], nv = size[va], su = stride[ua], sv = stride[va], sd = stride[d];
      let lab = new Int32Array(nu * nv), prev = new Int32Array(nu * nv), prevComps = [];
      const parent = new Int32Array(nu * nv + 1), comps = [], up = [];
      const find = (a) => { while (up[a] !== a) { up[a] = up[up[a]]; a = up[a]; } return a; };
      for (let s = 0; s < size[d]; s++) {
        const base = s * sd, endSlice = nearBorder(s, size[d]);
        let next = 1;
        const root = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
        for (let v = 0, k = 0; v < nv; v++) for (let u = 0; u < nu; u++, k++) {
          if (!mask[base + u * su + v * sv]) { lab[k] = 0; continue; }
          const a = u > 0 ? lab[k - 1] : 0, b = v > 0 ? lab[k - nu] : 0;
          if (!a && !b) { parent[next] = next; lab[k] = next++; continue; }
          const ra = a ? root(a) : 0, rb = b ? root(b) : 0, r = ra && rb ? Math.min(ra, rb) : ra || rb;
          if (ra && ra !== r) parent[ra] = r;
          if (rb && rb !== r) parent[rb] = r;
          lab[k] = r;
        }
        const id = new Int32Array(next), cur = [];
        for (let l = 1; l < next; l++) if (root(l) === l) { id[l] = cur.length + 1; cur.push({ n: 0, su: 0, sv: 0, suu: 0, svv: 0, suv: 0, perim: 0, perimEdge: 0, edge: false, maxD2: 0 }); }
        for (let v = 0, k = 0; v < nv; v++) for (let u = 0; u < nu; u++, k++) {
          if (!lab[k]) continue;
          const c = cur[(lab[k] = id[root(lab[k])]) - 1], g = base + u * su + v * sv;
          c.n++; c.su += u; c.sv += v; c.suu += u * u; c.svv += v * v; c.suv += u * v;
          const rim = u === 0 || v === 0 || u === nu - 1 || v === nv - 1 || !mask[g - su] || !mask[g + su] || !mask[g - sv] || !mask[g + sv];
          const out = nearEdge[g] || nearBorder(u, nu) || nearBorder(v, nv);
          if (out || endSlice) c.edge = true;
          if (rim) { c.perim++; if (out) c.perimEdge++; }
        }
        cur.forEach((c) => { c.kind = classify(c); });
        if (cur.some((c) => c.kind)) {
          const shared = new Map();
          for (let v = 0, k = 0; v < nv; v++) for (let u = 0; u < nu; u++, k++) {
            const c = lab[k] && cur[lab[k] - 1];
            if (!c || !c.kind) continue;
            if (c.kind === 'disk') c.maxD2 = Math.max(c.maxD2, (u - c.mu) ** 2 + (v - c.mv) ** 2);
            const g = base + u * su + v * sv;
            if (keep(g)) (c.pts || (c.pts = [])).push(g);
            const p = prev[k] && prevComps[prev[k] - 1];
            if (!p || !p.kind) continue;
            let m = shared.get(c);
            if (!m) shared.set(c, (m = new Map()));
            m.set(p, (m.get(p) || 0) + 1);
          }
          cur.forEach((c) => {
            if (c.kind === 'disk' && Math.sqrt(c.maxD2) > c.semi + DISK_EDGE_ALLOW) c.kind = null;
            if (!c.kind) return;
            c.slice = s; c.gid = comps.length; up.push(c.gid); comps.push(c);
          });
          shared.forEach((m, c) => m.forEach((count, p) => {
            if (!c.kind || !linked(c, p, count)) return;
            const a = find(c.gid), b = find(p.gid);
            if (a !== b) up[Math.max(a, b)] = Math.min(a, b);
          }));
        }
        [lab, prev] = [prev, lab];
        prevComps = cur;
        if (tick) tick();
      }
      chains.push(...gather(comps, find, d, dims));
    }
    return chains;
  }

  /** A post's axis: the line through its per-slice disk centers (area-weighted), oriented along the slice normal. The
      voxels of a tilted post form a sheared stack of disks, whose own principal axis leans away from the true one. */
  function centerLine(g, d) {
    const [ua, va] = FRAMES[d], at = (c) => { const p = [0, 0, 0]; p[d] = c.slice; p[ua] = c.mu; p[va] = c.mv; return p; };
    let w = 0;
    const mean = [0, 0, 0], ss = new Array(9).fill(0);
    g.forEach((c) => { const p = at(c); w += c.n; for (let k = 0; k < 3; k++) mean[k] += c.n * p[k]; });
    for (let k = 0; k < 3; k++) mean[k] /= w;
    g.forEach((c) => { const p = at(c).map((v, k) => v - mean[k]); for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) ss[3 * r + k] += c.n * p[r] * p[k]; });
    // Power iteration from the slice normal: the centers spread along the axis (a one-slice spread is enough).
    let v = [0, 0, 0];
    v[d] = 1;
    for (let it = 0; it < 50; it++) {
      const m = [0, 1, 2].map((r) => ss[3 * r] * v[0] + ss[3 * r + 1] * v[1] + ss[3 * r + 2] * v[2]), len = Math.hypot(...m);
      if (!len) break;
      v = m.map((x) => x / len);
    }
    return v[d] < 0 ? v.map((x) => -x) : v;
  }

  /** Comps grouped by chain; chains kept when they repeat over MIN_SLICES and keep a straight wall. */
  function gather(comps, find, d, { nx, ny }) {
    const groups = new Map();
    comps.forEach((c) => { const r = find(c.gid); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
    const out = [];
    groups.forEach((g) => {
      const slices = new Set(g.map((c) => c.slice)).size, sizes = g.map((c) => c.size), top = Math.max(...sizes);
      if (slices < MIN_SLICES || (g[0].kind === 'disk' && top - Math.min(...sizes) > CHAIN_SPREAD[0] + CHAIN_SPREAD[1] * top)) return;
      const n = g.reduce((a, c) => a + (c.pts ? c.pts.length : 0), 0), points = new Float32Array(3 * n);
      let k = 0;
      g.forEach((c) => (c.pts || []).forEach((i) => { points[k++] = i % nx; points[k++] = Math.floor(i / nx) % ny; points[k++] = Math.floor(i / (nx * ny)); }));
      if (!n) return;
      out.push({ kind: g[0].kind === 'disk' ? 'post' : 'plate', dir: d, edge: g.some((c) => c.edge), voxels: g.reduce((a, c) => a + c.n, 0), points, ...(g[0].kind === 'disk' ? { axis: centerLine(g, d) } : {}) });
    });
    return out;
  }

  return { grayStats, nearEdgeMask, brightBody, airPeak, sliceChains };
}));
