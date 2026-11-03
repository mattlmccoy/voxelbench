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
- Exports: pore, region and zone tables (CSV), a slice image (PNG) and a review sheet (PDF).

Every reported number carries a provenance line: the voxel size it was computed at, any binning, the calibration
status and the VoxelBench version.

## Start

1. Open the page and press **Try a synthetic test scan** to see every step on a generated scan with 40 known pores,
   or **With phantom rods** to try the density calibration on two rods of known density.
2. For a real scan, press **Open scan folder** and pick a folder of single-page, uncompressed 16-bit TIFF slices with
   the voxel size in the resolution tags.
3. Crop out holders or packaging (step 1), segment pores (step 2), map zones (step 3), export (step 4), and
   calibrate density from phantoms (step 5, optional).

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
