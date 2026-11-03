# VoxelBench Phase 4: Comparison to CAD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Load the nominal STL of a part and align it to the scan. Then measure the signed distance from each
point of the nominal surface to the scanned surface, and show it as a color map, a histogram, statistics with a
tolerance band, a probe and a CSV. Optionally fit one uniform scale and report it as a shrinkage estimate.

**Architecture:** There are three pure modules, each tested in node.
- `app/vb_stl.js` reads and refines the mesh.
- `app/vb_align.js` holds the frames, Horn's quaternion fit and ICP.
- `app/vb_deviation.js` finds the scan surface points, the deviation along normals and the statistics.

The worker runs them on the binned gray volume that segmentation already uses. A new rail step, `app/vb_cadrail.js`,
holds the controls and results. `app/ct_model.js` draws the colored CAD mesh in the 3D view.

**Spec:** `docs/DESIGN.md`, Phase 4.

## Global Constraints

These are the same as the Phase 2 and 3 plans: red-green TDD, files of at most 400 lines, and no lab records or
private paths in the repo.

Every number states its definition:
- The scan surface is the gray level halfway between air and matrix.
- A deviation is measured along the outward normal of the nominal surface. It is positive where the scan has
  material outside the nominal and negative where material is missing.
- The page says which grid the measurement used.

## Definitions (decided here; builder's calls)

- **Units.** STL files carry no unit. The default is mm, and inch is selectable.
- **Measurement points.** Each STL triangle is subdivided into a barycentric grid until its edges are no longer than
  the spacing. The spacing defaults to 2 analysis voxels and is capped so there are at most 400,000 points. Each
  point carries its triangle's normal. Vertices are not welded across triangles, so a cube edge keeps two normals.
- **Iso level.** (air gray + matrix gray) / 2.
  - Air gray comes from `R.estimateAirGray`.
  - Matrix gray is the median binned gray inside the filled sample mask, excluding pore voxels.
- **Scan surface points.** Binned voxels at or above the level with a 6-neighbor below it, inside the FOV circle.
  They are thinned to at most 60,000 points by a fixed stride. They are used only for alignment.
- **Deviation.** Gray is sampled trilinearly along p + s·n for s in [−range, +range], in steps of 0.25 analysis
  voxels.
  - The range defaults to 2 mm.
  - The deviation is the crossing closest to s = 0 where the profile goes from ≥ level (behind) to < level (ahead).
    It is interpolated linearly.
  - A point with no such crossing is "not measured". It is counted, never shown as 0.
- **Alignment.**
  - Pre-alignment matches centroids and principal axes. It tries the four proper sign flips of the axes, runs 10
    ICP iterations on each, and keeps the lowest RMS.
  - The rigid fit is trimmed point-to-point ICP: pairs farther apart than 3 × the median pair distance are dropped.
    Each step uses Horn's closed form, and the fit stops when the RMS changes by less than 1e-4 mm or after 60
    iterations.
  - With "fit uniform scale" ticked, each step also solves for the least-squares scale s. Shrinkage is
    (1 − s) × 100 %.
- **Transform.** p_scan = s·R·p_cad + t, in scan mm. The scan frame is the full-grid voxel index × voxel size, with
  voxel centers at integer indices.
- **Manual placement.** Rotate 90° about X, Y or Z, then "Refine fit" runs ICP from the current pose with no
  pre-alignment.

## Review Focus

1. A point whose search segment leaves the volume or the FOV is not measured. Pinned in Task 3.
2. A cube has equal principal moments, so its axes are arbitrary. Pre-alignment must still find a correct pose,
   because a cube's symmetry makes any axis-aligned pose equivalent. Pinned in Task 2.
3. The sign convention: a scan that is larger than the nominal gives positive deviations. Pinned in Task 3.
4. A non-measured fraction above 20 % gets a warning on the page. Task 5.

### Task 1: STL reader and measurement points

**Files:** Create `app/vb_stl.js` and `tests/stl.test.js`.

**Interfaces:** `window.VBStl`, also `module.exports`.
- `parseStl(arrayBuffer)` returns `{ positions: Float32Array (9 per triangle), normals: Float32Array (3 per
  triangle), triangles, bounds: { min, max } }`.
  - It reads binary and ASCII STL. Normals are recomputed from the vertex winding, never taken from the file.
  - It throws `Error('Not an STL file: …')` on bad input.
- `measurePoints(mesh, { spacing, maxPoints, unitMm })` returns `{ points: Float32Array, normals: Float32Array, tri:
  Uint32Array (triangle per point), faces: Uint32Array (display triangles over the points), spacing }`.
- `writeStl(positions)` writes binary STL. Tests and the synthetic demo use it.

**Tests:**
- A binary cube with 12 triangles round-trips through `writeStl` and `parseStl`. The normals point outward.
- The same cube as ASCII parses to the same triangles.
- A 2 mm spacing on a 10 mm cube gives edges of at most 2 mm, and every point lies on the cube surface.
- `maxPoints` raises the spacing.
- An 84-byte buffer that claims 1,000 triangles throws.

### Task 2: Alignment

**Files:** Create `app/vb_align.js` and `tests/align.test.js`.

**Interfaces:** `window.VBAlign`.
- `fitTransform(src, dst, { scale })` returns `{ R, t, s }`. This is Horn's quaternion fit on paired points.
- `nearestIndex(points, cell)` returns `{ nearest(x, y, z) → { index, d2 } }`, a uniform grid.
- `icp(src, dst, { init, iterations, scale, trim })` returns `{ R, t, s, rms, iterations }`.
- `preAlign(src, dst, { scale })` returns the same as `icp`.
- `apply({ R, t, s }, points)` returns a Float32Array.
- `compose(a, b)` combines two transforms.
- `rotate90(transform, axis, about)` rotates a pose 90° about an axis through the point `about`.

**Tests:**
- Paired points under a known rotation, translation and scale are recovered to 1e-9.
- An L-shaped point cloud is recovered from a 25° rotation by ICP alone, and from a 160° rotation by pre-alignment.
- A cube surface with 5 % of points moved 3 mm away is still recovered with trimming.
- A 0.97 scale is recovered to 1e-3 with `scale: true`. With `scale: false`, s stays 1.

### Task 3: Deviation

**Files:** Create `app/vb_deviation.js` and `tests/deviation.test.js`.

**Interfaces:** `window.VBDeviation`.
- `isoLevel(air, matrix)` returns the midpoint.
- `matrixGray(gray, filled, poreMask)` returns the median gray of the matrix.
- `surfacePoints({ gray, dims, bin, voxelMm, level, circle, maxPoints })` returns a Float32Array in scan mm.
- `deviations({ gray, dims, bin, voxelMm, level, circle, points, normals, transform, rangeMm })` returns a
  Float32Array of deviations in mm, NaN where not measured.
- `deviationStats(dev, toleranceMm)` returns `{ measured, unmeasured, mean, sd, min, p05, p50, p95, max,
  within_percent }`.
- `histogram(dev, { bins, range })` returns `{ edges, counts }`.

**Tests:**
- A gray box with a smooth edge (matrix 2000, air 700), measured against a CAD box 0.3 mm smaller on every side,
  gives deviations of +0.30 ± 0.05 mm. A CAD box 0.3 mm larger gives −0.30.
- A point whose segment leaves the volume is NaN, and it is counted in `unmeasured`.
- The statistics and histogram on a fixed array match hand values.

### Task 4: Pipeline

**Files:** Modify `app/ct_worker.js` and `tools/headless_run.js`.

**Changes:**
- The worker gets a `cad` message `{ points, normals, faces, options, pose? }`.
- It replies with `{ type: 'cad', transform, rms, scale, deviations, stats, level, grid }`.
- `headless_run.js` gains `compareCad(analysis, mesh, options)`.
- `vb_synthetic.js` gains `cadStl({ size })`, the nominal cylinder of the synthetic scan as STL.

**Test:**
- The synthetic scan against its own nominal cylinder, offset by 0.5 mm and rotated 10°, aligns to RMS below
  0.5 voxel.
- The median deviation is within 0.25 voxel of 0.
- The same cylinder scaled by 1.05 with "fit uniform scale" gives s within 0.01 of 1/1.05.

### Task 5: Page

**Files:**
- Create `app/vb_cadrail.js`.
- Modify `app/index.html` (step 6, "Compare to CAD", optional), `app/ct_model.js` (the colored CAD mesh and the
  click probe) and `app/ct_app.js` (state and messages).

**Changes:**
- Open STL, units, tolerance (default ±0.1 mm), "Fit uniform scale (shrinkage)", Align, rotate 90° X/Y/Z, Refine fit.
- Results:
  - the RMS of the fit, the scale and shrinkage when fitted, and the statistics table;
  - a histogram drawn with `CTPlot`;
  - a note giving the definitions and the grid;
  - a warning when more than 20 % of points are not measured.
- 3D view:
  - The CAD mesh is colored by deviation on a diverging map clipped at ±3 × tolerance. Points not measured are gray.
  - A color bar is shown.
  - Clicking the CAD mesh shows the deviation at that point and moves the slices there.
- The pose and statistics are saved with the scan as a `cad` record. The STL itself is not stored; the page names
  the file to open again.

**Verification:** This is not unit-testable (DOM and WebGL). Run a browser check on the synthetic scan with its STL,
and on Sample 2 against a cube STL with scale fitting, and take screenshots.

### Task 6: Export and docs

**Files:** Modify `app/ct_export.js` and `tests/export.test.js`.

**Changes:**
- `cadCsv(points, deviations, record)` writes x, y, z (scan mm), the nominal normal and deviation_mm. It adds a
  definitions comment and the summary rows: transform, scale and statistics.
- The README and DESIGN mark Phase 4 as built.

**Test:** The CSV header, the comment, and NaN written as empty.
