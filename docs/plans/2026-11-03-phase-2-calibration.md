# VoxelBench Phase 2: Density Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert gray value to an equivalent density in g/cm³ from reference phantoms scanned with the sample, and report it everywhere gray is reported, with "uncalibrated" kept wherever no calibration exists.

**Architecture:** A phantom is a region with the built-in label `phantom` and a measured density. A pure module (`app/vb_calibration.js`) fits density against the phantoms' median gray, plus air when chosen. The page computes the fit live from the phantom regions on the scan and applies it to region, matrix and zone gray. Saved runs carry a snapshot of the fit.

**Tech Stack:** As Phase 0–1: plain browser JavaScript, `node:test`.

**Spec:** `docs/DESIGN.md`, Phase 2 and the anti-goals.

## Global Constraints

- Everything in the Phase 0–1 plan's Global Constraints still holds: public repository hygiene, test-first, screenshots before publishing, and Matt approves each push and publish.
- Output is labeled **equivalent density of the reference polymer**. Doped or filled material attenuates differently per gram, so its value is not true density, and every place that shows the number says so.
- A scan with no calibration shows "uncalibrated" and no g/cm³ anywhere. A calibration from fewer than 2 points is not a calibration.
- A value whose gray lies outside the phantoms' gray range is marked extrapolated.
- Air, when included, is the median gray outside the part (`state.airGray`) at 0.0012 g/cm³.

## Review Focus

1. Two phantoms at the same gray, or one phantom and no air: no fit, a clear message, still "uncalibrated". Pinned in Task 1.
2. A phantom outlined partly over air or the part edge: median gray, not mean, so a few edge voxels do not move it. Pinned in Task 1 (median input) and Task 4 (synthetic rods).
3. A region far outside the phantom range (pores, air pockets): marked extrapolated, never shown as a plain number. Pinned in Task 1.
4. A phantom deleted after values were exported: the fit updates and the provenance line changes its point count. Checked in Task 5.
5. Phantom regions must not be painted as drawn zones or count as crops. Pinned in Task 2.

---

### Task 1: Calibration fit (pure)

**Files:** Create `app/vb_calibration.js` and `tests/calibration.test.js`.

**Interfaces:** Produces `window.VBCalibration`, also `module.exports`:
- `AIR_DENSITY = 0.0012`
- `calibrationPoints(phantoms, { airGray, includeAir })`
  - `phantoms`: `[{ name, density_g_cm3, gray }]`
  - Returns `[{ name, gray, density }]`. Air is added first when `includeAir` and `airGray` is finite.
- `fitCalibration(points)` returns one of:
  - `{ ok: true, method: 'linear', n, intercept, slope, r2, residuals: [density - predicted], gray_range: [min, max] }`
  - `{ ok: false, reason }`
  - The fit is ordinary least squares of density on gray. With n = 2 the fit is exact and `r2` is null.
- `applyCalibration(fit, gray)` returns `{ value, extrapolated }`, or `null` when `fit` is not ok or `gray` is null.
  - `extrapolated` is true when gray is outside `gray_range` by more than 2 % of its span.

- [ ] **Step 1: Write failing tests.**
  - Two points (700, 0.0012) and (2000, 1.01): slope and intercept exact to 1e-9, `r2` null, `residuals` near zero.
  - Three collinear points: `r2` equals 1.
  - Three noisy points: residuals sum to about 0.
  - One point: `ok` false, reason mentions "2 points". Two points at the same gray: `ok` false, reason mentions "different gray".
  - `applyCalibration` inside the range gives `extrapolated` false; at gray 300 with range [700, 2000] it gives true; with no fit it gives null.
  - `calibrationPoints` with `includeAir` and airGray 711 puts `{ name: 'Air', gray: 711, density: 0.0012 }` first; airGray null adds nothing.
- [ ] **Step 2: Run them.** Expected: FAIL, module missing.
- [ ] **Step 3: Implement. Step 4: Run.** Expected: PASS. Commit `feat(calibration): least-squares gray-to-density fit`.

### Task 2: Phantom regions

**Files:** Modify `app/ct_regions.js` and `tests/regions.test.js`.

**Interfaces:** Produces:
- `R.PHANTOM = { id: 'phantom', label: 'Phantom', color: '#f5f7fa' }`
- `makeRegion({..., label: 'phantom', phantom: { name, density_g_cm3 } }, labels)`
  - Accepts the phantom label like crop.
  - Requires a non-empty name and a finite density above 0. Otherwise it throws `Error('A phantom needs a name and a measured density above 0 g/cm³.')`.
  - Stores `phantom` on the record, with `belief_not_measurement: false`.
- `labelOf('phantom', labels)` returns `R.PHANTOM`.
- Zones: `paintZones` paints only labels in `labelIds`, so phantoms are never painted. Add a test that pins it.

- [ ] Steps: tests first (accept, refuse a bad density, labelOf, paintZones ignores phantoms), run red, implement, run green, commit `feat(calibration): phantom regions`.

### Task 3: Provenance and exports

**Files:** Modify `app/ct_core.js` (`provenanceLine`), `app/ct_export.js` (`regionCsv`, `zoneCsv`), `tests/volume.test.js` and `tests/export.test.js`.

**Interfaces:**
- `provenanceLine({ voxelMm, binFactor, calibration, toolVersion })`, where `calibration` is a fit or null.
  - Calibrated: `gray calibrated to equivalent density (3 points, linear)`
  - Otherwise: `gray uncalibrated`
  - `calibrated: false` from the old callers is treated as null.
- `regionCsv(regions, { calibration })` adds the columns `equivalent_density_g_cm3` and `equivalent_density_extrapolated`. They use `matrix_gray_mean`, or `gray_mean` when pores are not segmented. They are empty when uncalibrated. A comment line states the fit and the equivalent-density caveat.
- `zoneCsv(..., { calibration })` adds `matrix_equivalent_density_g_cm3` from `solid_gray_mean`.

- [ ] Steps: tests first for both strings and both columns (calibrated and uncalibrated), red, implement, green, commit `feat(calibration): provenance and CSV columns`.

### Task 4: Synthetic phantoms

**Files:** Modify `app/vb_synthetic.js` and `tests/synthetic.test.js`.

**Interfaces:**
- `makeScan({ phantoms: true })` adds two rods along z, radius 0.06·size, centered 0.39·size from the middle at 45° and 225°.
- Rod densities are 0.50 and 1.40 g/cm³. Gray everywhere follows `700 + 1290 · density` plus noise, so the matrix (gray 2000) is 1.0078 g/cm³.
- `truth.phantoms` is `[{ name, density_g_cm3, center: {x, y}, radius }]`, and `truth.matrix_density` is `(2000 - 700) / 1290`.
- The default stays `phantoms: false`, so Phase 0–1 tests are unchanged.

- [ ] **Step 1: Failing test.**
  - Build `makeScan({ phantoms: true })`.
  - Make phantom regions over each rod, with points on a circle of 0.7·radius on the middle XY slice, slices 20 to size − 20.
  - Run `R.regionStats`, then fit with air from the image corners inside the FOV.
  - Apply the fit to the matrix gray of a region in the part. Expected: 1.0078 ± 0.01 g/cm³, not extrapolated.
- [ ] Steps: red, implement, green, commit `feat(calibration): phantom rods in the synthetic scan`.

### Task 5: Calibration in the page

**Files:**
- Modify `app/index.html`: a new step 5, "Density calibration (optional)".
- Modify `app/ct_rail.js`: the phantom list, the fit line, and density columns in the region and zone tables.
- Modify `app/ct_app.js`: `App.calibration()`, provenance, and the run snapshot.
- Modify `app/ct_sheetexport.js` and `app/ct_sheetpages.js`: methods line and zone table.
- Modify `app/ct_views.js`: phantom outlines drawn in `R.PHANTOM.color`.
- Script tag for `vb_calibration.js`.

**Interfaces:**
- `App.calibration()` returns the current fit, or null.
  - Phantom points come from the phantom regions of this folder, using their `gray_p50`.
  - Air is included by `state.calAir`, saved as `calibration_air` on the sample record (default true).
- The rail step contains:
  - name and density fields with a "Draw phantom" button, which starts the freehand tool with label `phantom`;
  - a table: name, density, median gray, gray SD, voxels, residual;
  - the "Include air" checkbox;
  - the fit line `density = a + b · gray; n points; R² …`;
  - the caveat.
- When calibrated:
  - the region table gains "Eq. density (g/cm³)", with extrapolated values marked "*";
  - the porosity summary gains "Matrix eq. density", from `state.solidGray`;
  - the zone table gains a column;
  - the scan hint and the sheet methods line say calibrated.
- When uncalibrated, nothing in g/cm³ appears from calibration.
- The saved run doc gains `calibration: { fit, points }`, or null.

- [ ] **Step 1: Verify in the browser** on `makeScan({ phantoms: true })`, through a "phantoms" option on the synthetic button.
  - Draw both phantoms; the matrix reads about 1.01 g/cm³.
  - Delete one phantom: with air the fit is still made from 2 points; untick air and it shows "uncalibrated".
  - Screenshots for Matt.
- [ ] **Step 2:** `npm test` green. Commit `feat(calibration): calibration step in the page`.

### Task 6: Phantom protocol and README

**Files:** Create `docs/PHANTOM_PROTOCOL.md`. Modify `README.md` and `docs/DESIGN.md` (mark Phase 2 built).

The protocol covers:
- Phantoms in the FOV beside the sample at the same height, scanned in the same run.
- At least 20 voxels across, away from the FOV edge.
- Air, plus a solid of the base polymer with its density measured by Archimedes or pycnometry. A denser reference (PTFE, about 2.2 g/cm³) checks linearity.
- Measured densities, not datasheet values.
- How to outline phantoms in VoxelBench.
- What the equivalent density means and does not mean.

The lab's own phantom choice is still open question 2 in the design; this protocol gives the defaults until then.

- [ ] Steps: write, hygiene test green, commit `docs: phantom protocol`.

---

## Not in this plan

Beam-hardening correction, nonlinear fits, per-slice calibration, phantoms in a separate scan. These are noted in the protocol as limits.
