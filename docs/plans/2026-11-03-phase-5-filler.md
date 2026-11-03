# VoxelBench Phase 5: Filler and Fiber Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Segment the bright phase (filler particles, fibers) inside the sample. Report:
- the count, volume fraction and size distribution;
- nearest-neighbor dispersion;
- for resolved fibers, the orientation tensor, for the whole part and per drawn region.

The page also states the resolution limit.

**Architecture:**
- A pure module, `app/vb_filler.js`, holds a streaming connected-component labeler over full-resolution slices that
  keeps moments, not voxels. It also holds the particle shape, dispersion and orientation-tensor functions.
- The worker runs the labeler on the smoothed slices that pore segmentation already keeps.
- A new rail step, `app/vb_fillerrail.js`, shows the results.
- The slice views tint the bright phase.

**Spec:** `docs/DESIGN.md`, Phase 5.

## Global Constraints

These are the same as the earlier plans.

The page says what cannot be resolved:
- A particle needs at least 2 voxels across to be counted.
- A fiber needs about 3 voxels across to have a measured direction.
- Short glass fibers of 10–15 µm do not resolve at 40 µm voxels.

## Definitions (decided here; builder's calls)

- **Bright threshold.** The default is matrix median + 4 × the robust SD of the matrix (1.4826 × MAD of the gray in
  the sample mask, pores excluded). It can be changed on the page. Voxels at or above the threshold inside the
  filled sample mask are bright.
- **Particles.** 26-connected bright voxels on the full-resolution smoothed slices.
  - Components under `minVoxels` (default 8) are dropped and counted.
  - The shape comes from the second moments: ESD; principal axes; aspect ratio = √(λ1/λ3); main direction = the
    first axis.
  - A particle touching the FOV edge or the first or last slice is clipped.
- **Fibers.** Particles with aspect ratio ≥ 3 and length (4√λ1) ≥ 3 voxels.
- **Orientation tensor.** a2 = Σ wᵢ pᵢ pᵢᵀ / Σ wᵢ over fibers, weighted by voxel count. The report gives its
  eigenvalues and principal direction. A value of 1 means all fibers are aligned; 1/3 each means random in 3D.
- **Dispersion.**
  - Each particle's nearest-neighbor distance between centroids is measured.
  - The Clark–Evans ratio is R = mean NN / (0.554 ρ^(−1/3)), where ρ = count / mask volume. R ≈ 1 is random, < 1
    clustered, > 1 regular.
  - Edge effects bias R upward for small counts, so the page says so.
- **Not built:** structure-tensor orientation of unresolved fibers. At the lab's voxel sizes it would not deliver,
  and the page states that limit instead.

### Task 1: Labeler and particle shape

**Files:** Create `app/vb_filler.js` and `tests/filler.test.js`.

**Interfaces:** `window.VBFiller`.
- `robustThreshold(gray, filled, poreThreshold, k)` returns `{ threshold, median, sd }`.
- `labelBright({ getSlice, dims, keep(x, y, z), threshold, minVoxels, circle })` returns `{ particles, dropped }`.
  - `getSlice(z)` returns the full-grid slice.
  - `keep` is the sample-mask test.
- `particleShape(moments)` returns `{ esd_vox, axes, lambdas, aspect, direction }`.

**Tests:**
- Two separate spheres and one rod (20 × 2 × 2 voxels along x) are found as three particles. The rod's aspect is ≥ 5
  and its direction is ±x.
- Diagonal neighbors join (26-connectivity).
- Components smaller than `minVoxels` are dropped and counted.
- A particle touching slice 0 is clipped.
- The threshold of a matrix with known noise is median + 4σ, to 5 %.

### Task 2: Dispersion and orientation

**Files:** Modify `app/vb_filler.js` and `tests/filler.test.js`.

**Interfaces:**
- `dispersion(particles, maskVolumeVox)` returns `{ nn: Float64Array, mean_nn, clark_evans }`.
- `orientationTensor(fibers)` returns `{ a2, eigenvalues, direction, count }`.
- `summarize(particles, { maskVoxels, voxelMm })` returns the counts, the volume fraction, ESD percentiles and the
  fiber count.

**Tests:**
- Particles on a regular lattice give R > 1.5. Pairs placed close together give R < 0.6.
- Fibers all along z give a2 ≈ diag(0, 0, 1). Fibers spread evenly in direction give eigenvalues ≈ 1/3.

### Task 3: Pipeline and synthetic scan

**Files:** Modify `app/ct_worker.js`, `tools/headless_run.js` and `app/vb_synthetic.js`.

**Changes:**
- `makeScan({ filler: true })` adds bright spheres and fibers aligned near x into the cylinder, and returns their
  truth.
- `headless_run.js` gains `analyzeFiller(analysis, options)`.

**Test:** The synthetic scan with filler:
- recovers the sphere count within 10 % and the volume fraction within 15 %;
- reads the fibers' principal direction within 10° of x;
- gives a largest eigenvalue > 0.8.

### Task 4: Page

**Files:**
- Create `app/vb_fillerrail.js`.
- Modify `app/index.html` (step 7, "Filler and fibers", optional), `app/ct_app.js` (messages) and `app/ct_views.js`
  (bright-phase tint, a layer).

**Changes:**
- Threshold (automatic by default, editable), minimum size, Run.
- Results:
  - count, volume fraction, ESD percentiles, a size histogram;
  - mean NN distance and Clark–Evans R;
  - fibers: count, eigenvalues, principal direction;
  - a table per drawn region.
- The resolution note.

**Verification:** This is not unit-testable (DOM). Run a browser check on the synthetic filled scan and on Sample 2,
and take screenshots.

### Task 5: Export and docs

**Changes:**
- `fillerCsv(particles, context)` writes one row per particle, with the definitions and summary as comments. It is
  tested.
- The README and DESIGN mark Phase 5 as built.
