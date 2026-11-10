# 3D figures (step 9)

Step 9 draws a scan the way the lab's group-meeting and paper figures show CT: every part at one scale, cut open on a
quarter with each phase colored, the numbers under it, and a see-through view of the gas and clumps. The method is a
port of the lab's 2026-11-06 analysis scripts (phase map, clump finder, composition split) and the 2026-11-10 render
scripts, in plain JavaScript in the analysis worker (`app/vb_figure.js`; page code `app/vb_figurerail.js`).

## Grid
The sample mask's box plus 2 mm, block-averaged to about 80 µm (finer loaded slices are read from the page when the
worker's grid is coarser), and coarser only when the box would exceed 16 M cells.

## Classes
1. Gray minus air, smoothed with a Gaussian of 0.8 cells, divided by K: relative density, air 0 and dense base
   material 1. K comes from a step-5 dense reference when one is picked, else from the part itself: start at the 75th
   percentile of the part / 1.05, then three times take the mode of dense voxels at least 4 mm (relaxed to 3 and 2.5 mm)
   from clustered clumps, 3 mm in from the field of view, 7 mm from a cone-beam band and 12 (8, 5) cells below the
   surface.
2. Depth cupping (optional, on by default): the dense base material's median level in 0.5 mm depth bands to 5 mm,
   normalized at 2 mm and deeper, is divided out.
3. Pore below 0.40, porous 0.40 to 0.85, dense from 0.85.
4. Clumps (first pass of the lab's finder): 6-connected porous-range blobs of 0.1 to 20 mm³ with mean 0.45 to 0.80 that
   touch neither a pore nor the outer 2 cells of the mask. Clustered: at least two others within 4 mm.
5. Doped material: a window of 1.2 mm whose dense phase averages above the split (1.07) where at least 60 % of it is
   dense, 2 mm in from the field of view and 7 mm from a cone-beam band; within 1.5 mm of clustered clumps always; in
   the excluded edge bands by clumps within 2.5 mm; everything else takes the nearest decision; then a 0.88 mm majority
   filter.
6. Enclosed gas: pores joined to the volume's faces through pores or empty space are open and are not drawn; the rest
   is enclosed gas.

Label codes: 1 dense doped, 2 porous doped, 3 dense base, 4 porous base, 5 doped pore, 6 clump, 7 base pore.

## Renders
Turned 35° about the vertical, viewed from 28° above (orthographic, shear-warp). Cutaway: the near quarter removed
through the median of the doped region, first-hit shading from the depth map, edges darkened at depth jumps, callouts
at the visible point deepest inside each class's patch, the field arrow (the scan axis picked as "Field along") and a
10 mm bar (5 or 2 mm on a small part). See-through: front-to-back compositing, alpha per code 0.026, 0.013, 0.006,
0.003, 0.9, 0.85, 0 (doped orange, base material faint blue, gas red, clumps green). Turntable: the grid halved (gas
and clumps kept where any of the 8 cells holds them), 120 frames, played at 24 frames per second.

## Numbers
- % dense: dense doped cells over the doped volume (dense, porous, pores and clumps).
- % gas: enclosed doped pores over the doped volume without clumps.
- Fused on: part out minus doped charge in when both weights are entered (saved with the sample), else the base
  material's mass in view from CT: relative density x base density (1.01 g/cm³ by default).

## Differences from the lab scripts
- The second clump pass (opened cores beside pores) is not run; it only adds clumps to the figure, and the lab's
  composition used the first pass.
- The part's frame: the lab scripts used a PCA frame; here level the part first (Scan information > Orientation).
- The figure set lives in this browser (IndexedDB), not in the project file.
