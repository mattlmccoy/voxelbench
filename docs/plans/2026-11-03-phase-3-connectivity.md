# VoxelBench Phase 3: Open vs. Closed Porosity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split porosity into open (connected to the part surface) and closed, check for pore networks that run
through the part, and give every pore its sphericity and distance to the surface.

**Architecture:** A pure module, `app/vb_connectivity.js`, works from the pore runs (full grid) and the filled sample
mask (binned grid, the same one segmentation uses). The worker and `tools/headless_run.js` call it after
segmentation. The page shows the results in the porosity summary, the pore table and the CSV.

**Spec:** `docs/DESIGN.md`, Phase 3, plus the Lumafield ideas (sphericity, surface proximity, leak path).

## Global Constraints

Same as the Phase 2 plan.
- Every number states its definition: "open" means touching the part surface **at the loaded resolution**, so a
  crack narrower than about a voxel reads as closed.
- The page must say so.

## Definitions (decided here)

- **Surface distance.** The smallest depth of a pore's voxels inside the filled sample mask (binned grid), in mm.
  The depth comes from `Z.distanceInside`.
- **Open.** The surface distance is at most 1 binned voxel. Open porosity is the open pore volume divided by the
  mask volume; closed porosity is the remainder of the pore volume.
- **Network.** Pores whose voxels touch (6-connected across different ids) form one network.
- **Through-path along an axis.** A network that contains an open pore within 2 binned voxels of the mask's lowest
  extent along that axis, and an open pore within 2 binned voxels of its highest extent.
- **Sphericity.** Wadell: π^(1/3)(6V)^(2/3)/A. V is the voxel count, and A is the area of the surface-nets mesh of the
  pore's own mask. Null below 27 voxels, which is too few to have a shape.

## Review Focus

1. A pore touching the FOV edge (clipped): open/closed refers to the part surface, not the FOV; it keeps its clipped
   flag. Pinned in Task 1.
2. A part with no pores: open 0 %, closed 0 %, no networks. No division by zero. Pinned in Task 1.
3. A crop face: the crop boundary is a mask boundary, so pores cut by it read as open. The page says so. Task 3.
4. Pores split at necks are separate ids that touch, so they join one network. Pinned in Task 1.

### Task 1: Connectivity module

**Files:** Create `app/vb_connectivity.js` and `tests/connectivity.test.js`.

**Interfaces:** `window.VBConnectivity`, also `module.exports`:
- `sphericity(mask, dims, voxels)` returns a number, or null.
- `annotatePores({ pores, runs, dims, filled, binnedDims, bin, voxelMm })` returns
  `{ pores, summary: { open_mm3, closed_mm3, open_percent, closed_percent, networks, through: { x, y, z } } }`.
  - `pores` are new objects with `surface_distance_mm`, `open`, `sphericity`, `network`.
  - The open and closed percentages are of the mask volume.

**Tests:**
- A digital sphere of r = 8 has sphericity > 0.9; an ellipsoid with semi-axes 12 × 4 × 4 has at least 0.1 less.
- In a box part, a pore touching the top face is open and an interior pore is closed. The percentages add up to the
  total porosity.
- A pore chain from the top face to the bottom face (two ids touching) is one network, through along z.
- A part with no pores gives zeros and no networks.
- A clipped pore keeps `clipped`.

### Task 2: Pipeline integration

**Files:** Modify `app/ct_worker.js` (annotate after segmentation, before posting) and `tools/headless_run.js`
(`analyze` returns `connectivity`). The worker loads `vb_connectivity.js` through `importScripts`.

**Test:** The synthetic scan gives 40 closed pores, open porosity 0 %, and the sphericity of every pore with at
least 27 voxels ≥ 0.8.

### Task 3: Page and exports

**Files:** Modify `app/ct_rail.js`, `app/ct_export.js` and `tests/export.test.js`.

**Changes:**
- The porosity summary gains rows: "Open porosity", "Closed porosity", "Through-path" (axes or "none").
- A note under the summary gives the definition and the resolution and crop caveats.
- The pore table gains "Sphericity" and "Surface (mm)" columns, and an "open" mark.
- The pore CSV gains `sphericity`, `surface_distance_mm`, `open` and `network` columns, plus a definitions comment.

**Test:** The CSV columns. Then a browser check on the synthetic scan, and on the synthetic scan with a crop
through the part, where cut pores read as open.

### Task 4: Docs

Update the README and the design (Phase 3 built).
