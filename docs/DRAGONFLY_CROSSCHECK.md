# Cross-checking VoxelBench with Dragonfly 3D

This is the design's commercial-software acceptance check. One scan is segmented by both tools, and the two pore masks
are compared voxel by voxel.

There are two runs:
1. **Matched run.** Dragonfly is given VoxelBench's exact counting region and pore threshold. Any difference then comes
   from smoothing, labeling and counting, so the matched run tests VoxelBench's arithmetic.
2. **Independent run.** You segment the scan in Dragonfly your usual way. That shows what a typical Dragonfly user would
   get, region and threshold choices included.

> **Menu names.** They were taken from the Dragonfly help pages, not from your copy, so names can differ between
> versions. Steps marked **(confirm)** are the ones the help pages did not settle. Write down what your version calls
> them so this page can be corrected.

## 1. Make the kit (any computer with Node.js)

The scan needs a saved VoxelBench run: set the crop and settings in the page, then save the run.

```bash
node tools/crosscheck/dragonfly_kit.js <scan-folder> <saved-run.json> <kit-folder>
```

Keep the kit folder outside this repository. It holds:

| Item | Contents |
|---|---|
| `region/` | One 8-bit TIFF per scan slice, 255 where VoxelBench counts pore voxels: the sample mask without its outer edge band. |
| `voxelbench_pores/` | VoxelBench's pore voxels, 255 = pore, with voids you rejected by hand left out. |
| `kit.json` | Everything listed below. |

`kit.json` holds:
- `settings.poreThreshold`, the pore threshold;
- `settings.fineSigma`, the smoothing sigma in voxels;
- `min_group_voxels`, the smallest group VoxelBench keeps;
- `voxel_mm`, the voxel size, and `dims`, the scan size;
- `body_mm3`, the sample-mask volume that porosity is divided by;
- `voxelbench`, VoxelBench's own result;
- `scan_files`, the first and last scan file names (slices are in that file-name order).

The masks are about one byte per scan voxel, so a 1400 × 800 × 500 scan gives about 550 MB per stack. Copy the kit and
the scan folder to the Dragonfly computer.

## 2. Matched run in Dragonfly

1. **Import the scan.** Import all of its TIFF files in file-name order (the order in `kit.json` `scan_files`). In the
   data properties, check that the spacing is `voxel_mm` in x, y **and z**, and set z if it is missing.
2. **Import `region/`** as a second image. Its size has to match the scan's. Make an ROI from it by **range, 255 to 255**
   **(confirm)** and name it `Region`.
3. **Smooth the scan:** a **3-D Gaussian**, sigma = `fineSigma` voxels (1 by default). Write it to a new image and keep
   the original. If Dragonfly asks for a kernel size instead, use 2 × ceil(3 × sigma) + 1, which is 7 for sigma 1.
4. **Pore ROI.** On the smoothed image, take the range from the minimum up to **just below** `poreThreshold`:
   - on an integer image, the top of the range is `poreThreshold − 1`;
   - on a floating-point image, use a value a hair under it.

   Intersect this with `Region` **(confirm the Boolean "intersect" name)** and name the result `Pores`.
5. **Separate the pores** into objects with **6-connectivity** (face neighbors only, not edges or corners)
   **(confirm the connected-components / multi-ROI tool and its connectivity option)**. Remove objects with fewer than
   `min_group_voxels` voxels.
6. **Write down** the total pore volume (mm³) and the object count (the count is for the record only; see section 4).
7. **Export the pore mask:**
   1. On the cleaned ROI, choose **New Binary Image from ROI**.
   2. Export that image as **TIFF, uncompressed, one file per slice**, into a new folder such as `dragonfly_matched/`.

   The comparison refuses compressed files and a slice count that differs from the scan's.

## 3. Independent run in Dragonfly

Segment the same scan the way you normally would: your own sample ROI and your own threshold method (for example Otsu
or a manual range). Write down:
- the threshold method and value, and whether you smoothed (filter and size);
- the sample ROI and its volume, and the pore volume and porosity **as Dragonfly reports them**;
- any objects you removed, and the size limit you used.

Export the pore mask the same way as in step 7, into `dragonfly_independent/`.

## 4. Compare

```bash
node tools/crosscheck/compare.js <kit-folder> <kit-folder>/dragonfly_matched "Dragonfly matched"
node tools/crosscheck/compare.js <kit-folder> <kit-folder>/dragonfly_independent "Dragonfly independent"
```

Each run prints a report and saves `comparison_<label>.json` in the kit. The report gives:
- **Porosity of both masks over VoxelBench's sample-mask volume**, so the two numbers share one denominator. Dragonfly's
  own porosity, over its own sample ROI, is the number you wrote down.
- **Dice**: 2 × (voxels in both) / (voxels in either mask, counted twice where shared). A value of 1 means the masks
  are identical.
- **Voxels found by one tool only**, by cause:

| Cause | Meaning | What it points to |
|---|---|---|
| whole pore under 0.01 mm³ | A small face-connected group the other mask does not touch. | Noise-level voids near the threshold; smoothing or minimum-size differences. |
| whole pore of 0.01 mm³ or more | A real-sized void the other tool missed entirely. | A real disagreement. In the matched run, check the voids you rejected by hand: VoxelBench leaves them out, Dragonfly does not. |
| pore boundary | Both tools found the pore and differ on its edge. | The smoothing kernel or the threshold rounding. |
| outside VoxelBench's region | Dragonfly-only voxels outside the counting region. | Mainly the independent run: a different sample ROI or edge band. |

**What to expect in the matched run.** It should agree almost voxel for voxel. A stand-in for Dragonfly checked this
before the first lab run: section 2's steps, done with scipy's own Gaussian (`gaussian_filter`, `mode="nearest"`,
`truncate=3`) and labeling (`ndimage.label`), matched VoxelBench on a 1400 × 800 × 500 lab scan to 10 voxels in
11.3 million (Dice 1.0000). All 10 sat at the threshold, from floating-point rounding.

A matched run with whole large pores on one side only means one of the steps above was done differently, so recheck
the threshold, the region and the connectivity before drawing a conclusion.

**Compare voxels, not object counts.** VoxelBench keeps two pores found separately on its coarse grid apart even where
they touch, so it lists more voids than a connected-components count over the same voxels. On the lab scan the counts
were 14,383 and 13,266 groups for the identical mask.
