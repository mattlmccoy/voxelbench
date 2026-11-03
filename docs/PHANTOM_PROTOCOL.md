# Phantom protocol for density calibration

VoxelBench turns gray value into an **equivalent density** with reference phantoms scanned together with the
sample. This page says how to scan them and how to use them. It is the starting protocol; the lab's own phantom
set will replace the defaults below once it is chosen.

## What the number means

The fit is a straight line from gray value to density through the phantoms (and air). A voxel's equivalent density
is the density a phantom of the reference material would need to show that gray.

- For material of the same composition as the phantom, it estimates bulk density.
- For doped or filled material, it is **not** true density: graphite, carbon black, glass or metal fillers attenuate
  X-rays differently per gram than the base polymer. Report it as "equivalent density of <phantom material>".
- It includes no beam-hardening correction. Large or dense parts read lower in the middle than at the edge, and
  phantoms beside the part do not see the same spectrum as the part's center.

## Scanning

1. **Same scan.** Put the phantoms in the field of view (FOV) beside the sample, at the same height, in the same scan.
   Phantoms scanned separately or on another day do not calibrate this scan.
2. **Size.** At least 20 voxels across: about 1 mm at 40 µm voxels, 2 mm at 100 µm.
3. **Position.** Keep them clear of the FOV edge and of the holder, and with air between phantom and sample.
4. **Set.** Use at least two points: air, plus one solid phantom.
   - **Base polymer:** a molded or machined rod of the same polymer as the part (for example PA12), full density.
   - **Check point (recommended):** a denser reference such as PTFE (about 2.2 g/cm³). With three or more points
     VoxelBench shows residuals and R², which tells you whether a straight line holds.
5. **Densities.** Measure each phantom's density yourself, by Archimedes (ASTM D792) or gas pycnometry. Datasheet
   values vary between lots and processes.
6. **Record.** Phantom names, measured densities, scan settings (kV, current, filter, voxel size), date.

## In VoxelBench

1. Open the scan and go to step 5, **Density calibration**.
2. For each phantom, enter its name and measured density, press **Draw phantom**, outline the inside of the phantom
   away from its edge on the main view, and set the slices where it is solid. Save.
3. **Crop the phantoms out of the sample in step 1** when they are as dense as the part (above the mask threshold),
   or they join the sample mask and change porosity and the zone baseline. Calibration reads phantoms either way.
4. Leave **Include air** on unless air in this scan is unreliable (for example packaging film everywhere). Air is
   the median gray outside the part, at 0.0012 g/cm³.
5. Read the fit line. With three or more points, residuals above about 0.01 g/cm³ mean the line does not hold for
   these phantoms.
6. Equivalent densities then appear in the region and zone tables, the porosity summary, the CSV exports and the
   review sheet. A value marked `*` is extrapolated: its gray lies outside the phantoms' range.

Without phantoms every gray value stays "uncalibrated", and no g/cm³ appears.

## Limits

No beam-hardening correction, no nonlinear fit, no per-slice calibration, and no phantoms from a separate scan.
