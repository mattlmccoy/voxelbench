# VoxelBench

VoxelBench reviews and measures X-ray computed tomography (CT) scans of polymer parts in the browser. It reads a
folder of reconstructed slices, segments pores and low-density regions, maps gray-value zones, and exports tables
and a PDF review sheet. Scans are read on your computer and never uploaded.

## What it does

- Slice views (XY, XZ, YZ) and a 3D view, in grayscale or a rainbow (turbo) color map.
- Pore segmentation: porosity, pore count and size, pores elongated or cut by the field of view (FOV).
- Open and closed porosity: a pore is open when outside air reaches it through gray below the pore threshold,
  starting at the part surface or a crop face; a pore cut by the first or last slice is unknown unless air reaches
  it. Networks of touching pores, a through-path check along each axis, and each pore's sphericity and distance to
  the surface.
- Low-density regions: gray below 0.8 of the matrix but above the pore threshold, reported apart from porosity.
- Gray-value zones relative to a baseline (the whole part, or the pore-free ends of the long axis).
- Regions with your own labels, annotations and length measurements.
- Density calibration from reference phantoms scanned with the sample: gray becomes equivalent density (g/cm³).
  See [docs/PHANTOM_PROTOCOL.md](docs/PHANTOM_PROTOCOL.md).
- Comparison to CAD: open the nominal STL; VoxelBench aligns it to the scanned surface (rigid, optionally with one
  uniform scale reported as shrinkage) and measures the signed distance from each nominal point, along its outward
  normal, to the scanned surface (gray halfway between air and matrix). Color map on the 3D model, probe,
  statistics with a tolerance band, histogram and a CSV of every point.
- Filler and fibers: the bright phase inside the sample as 26-connected particles (detection at matrix + 4 robust SD,
  measured halfway to the particles' own gray): count, volume fraction, size distribution, nearest-neighbor dispersion
  (Clark–Evans ratio, from particles away from the sample surface), flakes apart from fibers, and the orientation
  tensor of resolved fibers, for the whole part and per drawn region.
- Wall thickness (step 8): distribution and the thinnest places of the part's walls, each a click from its slice.
- Lab workflow: measured lengths checked against a nominal and tolerance band; a before/after table of two scans'
  saved runs; batch runs over every scan in a folder with one summary CSV; view bookmarks; named setting presets.
- Exports: pore, region, zone, CAD-deviation, filler, wall and batch tables (CSV), a slice image (PNG) and a review sheet (PDF).
- Three looks under Appearance in the top bar: Lab (the original instrument look, default), Mac (a Mac-style
  inspector) and Glass (frosted panels floating on a blurred copy of the scan), each light or dark (Mode: System
  follows the computer). `?skin=mac` or
  `?skin=glass` in the address also picks one; the choice is remembered in this browser. In every look a step bar
  shows one step at a time, with a green dot on each step that has a result and a Next line at the end of a finished
  step; drag the panel's left edge to widen it for wide tables (double-click to reset).
- "What this shows" in every step: the step's result read in words (one dominant void or spread porosity, voids
  gathering near the surface, a zone's porosity against the baseline, over- or undersize against CAD, clustered
  filler, aligned fibers, walls at the resolution limit) with what to check next.
- The review sheet (PDF) carries the same reads on a Findings page after page 1, together with the saved regions, the
  Dragonfly comparison and the density calibration, and lists the steps not run, so a missing section is never read
  as a clean result.
- Level a part scanned at an angle (Scan information > Orientation): Level the part finds the part's axes from its
  sample mask (long axis to x, thinnest direction up), three previews follow the tilt and turn sliders, Flip over and
  Turn 90°, and Apply rebuilds the scan in the part's frame (nearest neighbor, so every gray value is a measured one).
  The orientation is saved with the sample; marks stay with the frame they were drawn in. See
  docs/plans/2026-11-05-reorient.md.
- The sample envelope is closed with a ball (Segmentation parameters > Mask closing shape), so open porosity does not
  change with the part's angle in the scanner. Runs saved before 2026-11-05 used a box and keep it when reopened.
- Dragonfly 3D cross-check in the page (step 4): download the kit, load Dragonfly's pore mask, read Dice and the
  causes of any difference; see docs/DRAGONFLY_CROSSCHECK.md.
- A result card for every mark: save a region, outline, point or measurement (or click a saved one on the image) and
  a card over the view shows what it measured, compared with the whole part (porosity, solid gray, density), what to
  run for a missing number, and, for a measurement with a nominal, pass or fail.

Every quantity is checked against an independent Python (scipy) reference on the same scans; see
[docs/REFERENCE.md](docs/REFERENCE.md). Porosity can be cross-checked against Dragonfly 3D voxel by voxel; see
[docs/DRAGONFLY_CROSSCHECK.md](docs/DRAGONFLY_CROSSCHECK.md). Every reported number carries a provenance line: the voxel size it was computed at, any binning, the calibration
status and the VoxelBench version.

## Start

1. Press **Take the guided tour** (or **Guided tour** in the top bar, or add `?tour` to the address) for a walkthrough
   of the eight steps on generated scans: each stop points at its controls, can run the step for you, and reads the
   result back next to the generated scan's known answer.
2. Or press **Try a synthetic test scan** to see every step on a generated scan with 40 known pores,
   **With a dense band** to try the gray-value zones on a 16 mm cylinder whose middle 30 % of the length reads 10 %
   denser,
   **With phantom rods** to try the density calibration on two rods of known density, **With filler** to try the
   filler analysis on 50 bright spheres and 20 aligned fibers, or **With a CAD model** to try
   the CAD comparison on a generated L-shaped part (shrunk 3 %, its upright bent 0.12 mm) and its nominal STL.
3. For a real scan, press **Open scan folder** and pick a folder of single-page, uncompressed 16-bit TIFF slices with
   the voxel size in the resolution tags.
4. Crop out holders or packaging (step 1), segment pores (step 2), map zones (step 3), export (step 4), and
   calibrate density from phantoms (step 5, optional), compare to CAD (step 6, optional), and analyze filler and
   fibers (step 7, optional, after step 2).

Scans larger than the memory budget (1.2 GB; 0.6 GB in Safari) load block-mean binned, and the page says so before
reading. Add `?budget=<GB>` to the address to change the budget. The zoomed XY view of a binned scan shows the
native slice under the binned results.

Serve the page over http (the hosted page, or `npx serve dist` after `node tools/build_static.js`); a page opened
straight from a file cannot start the analysis worker.

## Where records are kept

- **As a web page:** regions, annotations, sample details and runs go into a project file. Press **Save project**
  and keep the file next to the scan; press **Open project** to continue later.
- **As a claude.ai artifact:** the same records go to the artifact's shared database; **Export project** writes them
  to a file.

A project file opens in either one. Importing never overwrites a saved run; a run with the same name is kept under
a new name.

## Limits

- Without phantoms, gray values are uncalibrated. Gray reflects bulk attenuation, not composition; region labels
  are assignments. A calibrated value is the equivalent density of the phantom material, not true density for
  doped or filled material, and has no beam-hardening correction.
- Pores smaller than about 3 voxels across are at the noise limit.
- CAD comparison: points on sharp CAD edges are skipped (the scanned edge is rounded over about one analysis voxel),
  and a point counts as measured only where the scanned surface faces within 60° of its normal. The fitted scale is
  limited to 0.5 to 1.5. A least-squares fit shares a local distortion (a bent wall) over the whole part. Pore walls
  inside the part are not its surface (only air joined to the outside counts), and statistics are weighted by surface
  area. A mesh with more triangles than the point budget is measured at triangle centroids.
- Filler: a particle needs about 2 voxels across and a fiber about 3 voxels across to resolve (short glass fibers of
  10 to 15 µm do not resolve at 40 µm voxels); volumes of particles under about 4 voxels across read low. Candidates
  peaking within 1 SD of the detection threshold are flagged as possible noise; the Clark–Evans ratio needs 20
  particles at least twice the random spacing inside the sample, and the orientation tensor 5 fibers.
- Wall thickness: walls thinner than about 3 analysis voxels are not reported (the smallest value shown, 3.5 voxels,
  means at or below that limit); corners are not walls; where a wall runs past the first or last slice it is left out.
- The open/closed split depends on the pore threshold and the resolution: a crack narrower than about one analysis
  voxel reads as closed, and a crop face counts as part surface.

## Development

```bash
npm test
```

Tests that need a real scan read it from a folder outside this repository and skip without it:

```bash
VOXELBENCH_LOCAL_DIR=/path/to/local npm test
VOXELBENCH_LOCAL_DIR=/path/to/local npm run test:local
```

`tools/headless_run.js` runs the same pipeline without a browser. Design and plans are in `docs/`.

## License

MIT
