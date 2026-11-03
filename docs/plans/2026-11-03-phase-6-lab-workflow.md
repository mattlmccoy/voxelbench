# VoxelBench Phase 6: Lab Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The design's Phase 6 plus bookmarks and presets from the feature list drawn up with Matt:
- wall thickness;
- dimensions with tolerances;
- before/after comparison of two scans of one part;
- batch runs across the scans of a folder;
- view bookmarks;
- named setting presets.

**Spec:** `docs/DESIGN.md`, Phase 6.

## Data contract (read from the code, 2026-11-03)

- **Saved run.** `store.putRun(folder, doc, chunks)` and `store.getRun(folder)` keep one run per folder
  (`app/ct_rail.js` saveRun). `doc` holds:
  - `settings`;
  - `summary` (the `P.summarize` fields);
  - `voxel_mm`, `bin_factor`, `regions`, `zones` and `calibration`.

  It has **no** open/closed, filler or CAD numbers, so runs saved before this phase read n/a for them.
- **Measurement.** `CT.makeAnnotation` with `kind: 'measure'` stores `length_mm` (`app/ct_core.js:314`). There is no
  nominal field yet.
- **Store collections.** `samples, labels, regions, annotations` (`app/vb_store.js:12`). Projects without a
  collection import as empty.

## Definitions (builder's calls)

- **Wall thickness.**
  - Taken on the binned sample mask (pores filled, i.e. the part's walls).
  - Ridge voxels are local maxima of the distance to outside (`Z.distanceInside`, 26-neighborhood, distance ≥ 1).
  - Thickness at a ridge voxel is 2 × distance × analysis voxel size.
  - The report gives the distribution, the minimum and the 20 thinnest places, each with a location to jump to.
  - Stated limit: walls under about 2 analysis voxels are not resolved.
- **Dimension check.** `deviation = measured − nominal`. It passes when −tolMinus ≤ deviation ≤ +tolPlus.
- **Before/after.** A table of the saved run's metrics for two folders, with after − before.
- **Batch.** Each scan in the opened folder is loaded and segmented with the current settings and its own saved crop.
  One summary row is kept per scan, and the rows export as CSV. A scan that fails is listed with its error.
- **Bookmarks.** Kept in the sample record (`bookmarks: [{ name, main, cursor, created_at }]`).
- **Presets.** A new `presets` collection: `{ id, name, settings, created_at }`.

### Task 1: Dimensions with tolerances

- `CT.dimensionCheck(measured, nominal, tolMinus, tolPlus)` returns `{ deviation, pass }`.
- The annotation table gets nominal and tolerance inputs for measurements, saved on the annotation.
- The annotation CSV gains `nominal_mm, tol_minus_mm, tol_plus_mm, deviation_mm, pass`.
- **Tests:** the pure check, including the edges of the band; the CSV columns.

### Task 2: Wall thickness

- `Z.wallThickness(filled, dims, binVoxelMm)` (or a new module) returns `{ ridge: [{ x, y, z, thickness_mm }],
  stats }`.
- **Tests:** a plate 6 analysis voxels thick reads 6 ± 1 voxel. A part with a thin and a thick wall lists the thin
  wall first.
- **Page:** the "Wall thickness" section in step 2, with a table of the thinnest places that jumps on click, and a CSV.

### Task 3: Saved runs carry the new numbers, and before/after

- `saveRun` adds `open_closed` (`VBConnectivity.openClosed`, rejected pores left out), `through`, `filler`
  (summary, thresholds) and `wall` (stats).
- `compareRuns(before, after)` returns the rows: metric, before, after, change. A missing value is n/a, never 0.
- **Tests:** compareRuns with a full run and an old run.
- **Page:** "Compare with another scan" in step 4, choosing among the folders that have a saved run.

### Task 4: Bookmarks and presets

- **Bookmarks.** Save view (name), list, and click to restore the main view and cursor. Stored on the sample.
- **Presets.** A `presets` collection in both stores and the project file.
  - "Save settings as preset" and a preset selector in the segmentation parameters.
- **Tests:** store round trip and export with presets; a project without presets imports.

### Task 5: Batch

- `vb_batch.js` on the start screen ("Run all scans"): it loads each folder in turn, segments it, saves its run, and
  collects summary rows; it ends with a CSV.
- A pure `batchRow(folder, summary, extras)` is tested.
- **Verification:** a browser run on a folder of two synthetic scans.

### Task 6: Docs

The README and DESIGN mark Phase 6 as built.
