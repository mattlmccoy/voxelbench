# VoxelBench: Dragonfly 3D Cross-Check Plan

**Goal:** the design's commercial-software acceptance check, starting with Dragonfly 3D on one shared scan (Sample 2).
It has two runs:
1. **Matched.** Dragonfly gets VoxelBench's exact counting region and pore threshold, so any difference comes from
   smoothing, labeling and counting.
2. **Independent.** Dragonfly segments the scan its own way, so the difference shows what a typical user would get.

Approved by Matt on 2026-11-03 ("Yes, build it", after the design playback).

## Data contract (read from the code, 2026-11-03)

**Pore voxels.** A full-resolution voxel is a pore voxel when all three hold (`app/ct_pores.js` fineDetect, line ~520):
- its smoothed gray is strictly below `poreThreshold`;
- its 2 × 2 × 2 binned block is in `coarse.interior` (the body eroded by `margin` blocks);
- that block is not in `coarse.edgeZone` (outside dilated by `margin + 1`).

There is no requirement that a coarse pore was found first.

**Region size.** Only voxels with `x < floor(nx/2)·2`, `y < floor(ny/2)·2` and `z < floor(nz/2)·2` can be counted.

**Smoothing.** `createSliceSmoother` applies a separable 3-D Gaussian:
- `sigma = fineSigma` (default 1 voxel);
- the kernel is cut at `ceil(3σ)` and normalized;
- edges are replicated.

`smoothAll` stores the result as Uint16 by truncation, which leaves the strict `<` test unchanged for nonnegative values.

**Connectivity.** Runs along x join face neighbors at y−1 and z−1, which is 6-connectivity. Two different coarse pores
never merge, but this changes labels, not which voxels count.

**Kept sets.** A set is kept when its volume is at least `minVolumeMm3` (default 0.0005 mm³).

**Porosity.** `summarize` reports `all_void_percent_of_body`:
- **numerator:** pores, crack-like and clipped voids, minus the voids rejected by hand (`rejectedAfterRerun`);
- **denominator:** `bodyMm3`, the filled binned body count × (2 · voxel)³.

**Runs.** `{ offsets[nz·ny+1], start, end (exclusive), id }`, where row index = z·ny + y.

**Size.** Each 8-bit mask stack takes one byte per scan voxel, about 550 MB for a 1400 × 800 × 500 scan.

## Dragonfly facts (help pages; NOT verified in Matt's version)

- ROIs import and export natively only as `.ORSObject`.
- An ROI can become an image through "New Binary Image from ROI", and images export as TIFF, one file per slice or
  one multi-page file.
- TIFF export drops the z spacing, so the comparison checks the slice count rather than trust the spacing.
- An imported mask image becomes an ROI by range thresholding. Matt must confirm this in his version.

## Definitions (builder's calls)

**Kit (`tools/crosscheck/dragonfly_kit.js <scan> <run.json> <out>`).** It writes:
- `region/region_0000.tif …`: 8-bit, 255 = counted region;
- `voxelbench_pores/pores_0000.tif …`: 8-bit, 255 = VoxelBench pore voxel, rejected voids left out;
- `kit.json`: the settings, smoothing, connectivity, minimum volume, voxel size, body volume, VoxelBench's porosity and
  voxel counts, and the first and last scan file names.

All TIFFs are uncompressed with the voxel size in the resolution tags, and slices follow the order the pipeline reads
them.

**Comparison (`tools/crosscheck/compare.js <kit> <dragonfly-pores>`).** It reads Dragonfly's pore mask: a folder of
slices or one multi-page TIFF, 8- or 16-bit, uncompressed, any nonzero value counting as pore. It refuses a slice count
or size that differs from the kit's. It reports:
- **Porosity of each mask** over the same body volume.
- **Dice** = 2|A∩B| / (|A| + |B|).
- **Voxels found by one tool only**, sorted by cause:
  - *whole pore, small*: a 6-connected component under 0.01 mm³ with no overlap in the other mask;
  - *whole pore, large*: the same, at 0.01 mm³ or more;
  - *pore boundary*: the component overlaps the other mask, so both tools found that pore and differ on its edge;
  - *outside VoxelBench's region*: Dragonfly-only voxels outside the counting region (the independent run).

  The 0.01 mm³ cut is a builder's call: about 0.27 mm across, or 156 voxels at 0.04 mm.
- **A self-check:** the kit's own pore mask has to reproduce VoxelBench's porosity exactly.

## Tasks (red-green for each)

1. **TIFF masks.** `writeMaskTiff` / `readMaskPages`: an 8-bit round trip, a multi-page read, a 16-bit read, and a
   compressed file refused.
2. **Region and pore slices.** `regionSlice` from the binned interior/edgeZone, including odd dims. `poreSlice` from
   runs with an excluded id.
3. **Run labeling.** `labelRuns` joins face neighbors and keeps diagonal-only neighbors apart.
4. **Comparison.** For `compareMasks`:
   - identical masks give Dice 1 with no disagreement;
   - an extra small blob is *whole pore, small*;
   - a pore grown by one voxel is *pore boundary*;
   - a blob outside the region is *outside region*.
5. **Kit on the synthetic scan.** The pore mask voxel count reproduces `all_void_percent_of_body`, and the comparison
   of the kit with itself gives Dice 1.
6. **Protocol** in `docs/DRAGONFLY_CROSSCHECK.md`, covering the matched and the independent run.
7. **Real scan.** Run the kit on the shared lab scan into a private folder outside the repository, and check the self-check.
