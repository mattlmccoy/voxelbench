# VoxelBench: design

Status: draft for Matt's review, 2026-11-03. Not approved; nothing is built from it yet.
Moves into the VoxelBench repository as its first file once that repository exists.

## Intent

VoxelBench is the lab's general-purpose tool for reviewing and measuring X-ray CT scans of polymer parts.
It grows out of the Sinter CT Annotator (claude.ai artifact, version 10), which was built around one sample
(one RF-sintered cube, "Sample 2"). The lab works mostly with polymers. Lab members should be able to open a scan,
get porosity and density numbers they can trust and cite, and leave a record another person can reproduce.

Name: VoxelBench (Matt, 2026-11-03). A plain lab tool, not a product brand. No CT or imaging software of
that name turned up in a web search on 2026-11-03.

## Users and access

- Lab members, including new students, working on their own computers.
- Two builds from one codebase (Matt's decision):
  - **Static web page** hosted from the public repository (GitHub Pages). Any browser, no account. Records
    (settings, regions, annotations, calibrations, results) are saved as a project file the user keeps next to
    the scan and reopens later.
  - **claude.ai artifact.** Adds the shared database: runs and annotations visible to everyone the artifact is
    shared with, with author names. Only Matt changes sharing.
- Scans are read from the user's disk in the browser and never uploaded, in either build.

## Goals

1. Open the lab scanner's TIFF stacks, including scans over 2 GB.
2. Pore segmentation, low-density regions, gray-value zones, annotations, the 3D view, the rainbow view and
   the PDF review sheet, as in version 10, with nothing tied to Sample 2.
3. Density calibration from reference phantoms (first new analysis).
4. Open vs. closed porosity.
5. Comparison to CAD: surface deviation against the nominal STL.
6. Fiber and filler analysis.

## Non-goals

- Importers for other vendors' formats (Zeiss, Bruker SkyScan, Nikon). The lab has one scanner.
- Reconstruction. VoxelBench starts from reconstructed slices.
- Upload or cloud processing of scans.
- Composition from gray value. Gray (or calibrated density) is bulk attenuation, not composition.

## Anti-goals (a failure even if it works; all four chosen by Matt)

- **Numbers people can't trust.** Every reported number carries its settings, the resolution it was computed
  at (full or binned), its calibration status and the tool version. Unknown never displays as zero or healthy.
- **Too hard to start.** A new student opens a scan and gets porosity without help.
- **Locked to one person.** It works without Claude or Matt driving it; the static build needs no account.
- **Slow on real scans.** Long steps show progress and run off the main thread; no step freezes the page.

## Constraints

- Scan data are read-only: never rescaled, rewritten or copied into the repository.
- **Public repository.** It never holds CT data, lab sample tables, saved runs or private notes (for example
  locked prediction files). Tests that need real scans skip when the scans are absent. Two existing fixtures
  hold numbers derived from Sample 2 (`tests/fixtures/real_stack_reference.json`, and the matplotlib/scipy
  reference `display_reference.json`, which has no scan data). Whether the first ships is Matt's call (open
  question 3). Matt, 2026-11-03: replace it with a synthetic fixture; the Sample 2 check stays local only.
- Browser memory: version 10 holds the whole full-resolution stack in memory. Sample 2 (1392 × 784 × 503,
  16-bit) is about 1.1 GB, near the limit, and it fails with an out-of-memory message (`ct_app.js:164`).
- Red-green TDD for all testable logic; screenshots reviewed by Matt for every visual change; Matt approves
  every publish and every push.

## What exists (starting point)

Sinter CT Annotator, version 10 (the lab's single-sample annotator):
16 scripts, 111 passing tests (`node --test tests/*.test.js`). Pure logic in `ct_core`, `ct_pores`,
`ct_regions`, `ct_zones`, `ct_display`, `ct_sheetdata`, `ct_export`; page code in `ct_app`, `ct_views`,
`ct_model`, `ct_rail`, `ct_sheet*`, `ct_plot`; segmentation in `ct_worker`.

Sample 2 specifics to remove:
- `CT.SAMPLES` and `identifySample` in `ct_core.js` (the lab run table and folder-name mapping).
- `REGION_LABELS` in `ct_regions.js` (believed natural / believed doped).
- The zone method in `ct_zones.js`: gray offset from the pore-free ends of the long axis at equal depth.
  This suits a part that grades along one axis and is one option, not the default.
- Review-sheet wording that names doped/natural assignments.

## Ideas taken from Lumafield Voyager

Voyager is Lumafield's browser-based CT analysis software. These features fit the lab; VoxelBench implements
its own versions, not copies of Voyager's interface.

- **Porosity reports sphericity and surface proximity** (distance from each pore to the part surface). Near-surface
  pores matter for polymer parts. Added to the pore table and the size plots.
- **Saved named analyses** ("authoring": an analysis saved with its own thresholds). VoxelBench: analysis
  presets, named and stored with the project, plus material presets (PA12 SLS, TPU, PEEK, foams, fiber
  composites) as starting values.
- **Inclusion analysis** (bright phase). Becomes the filler half of goal 6.
- **Crack and leak detection.** VoxelBench: a through-path check as part of open porosity (goal 4): is there a
  connected pore path from one surface to another?
- **Wall thickness** with mesh and CSV export. Added as a later analysis (Phase 6).
- **CAD comparison** as a color deviation map, with the advice that the nominal STL be exported finely
  tessellated. Adopted in Phase 4.
- **Probe**: click a point and get statistics (thickness, deviation) within a sphere. VoxelBench: a probe for
  gray, density, porosity and deviation.
- **Bookmarks**: a saved view state with a comment, shared with colleagues. VoxelBench: bookmarks in the project
  file and, in the artifact build, in the shared database.
- **Dimensions with tolerance and pass/fail coloring.** Extends the existing caliper tool.

Sources: lumafield.com product-feature pages for porosity analysis and CAD comparison; support.lumafield.com
pages for CAD comparison, wall thickness analysis and the probe tool; lumafield.com articles on Voyager
collaboration. Read 2026-11-03.

## Phases (in Matt's order)

Each phase ships as its own version after Matt reviews screenshots.

**Phase 0: repository and two builds.** Create the public repository (only after Matt approves) and move the
code there under the VoxelBench name. One storage interface with two implementations: project file (static
build) and artifact database (artifact build). Done when both builds open a scan and save and reload a project.

**Phase 1: lab-ready basics.**
- Per-sample metadata entered by the user (name, material, process, notes) in place of `CT.SAMPLES`.
- User-defined region labels in place of natural/doped.
- Zone method chosen per project: whole-part median baseline (default) or end baseline (the Sample 2 method).
- Large scans: when the full stack does not fit the memory budget, analyze on a binned copy and read full
  resolution only for displayed slices and zoomed regions. The page states which resolution each number came
  from and the smallest pore size it can resolve.
- A start path for new users: open scan, check voxel size, crop, segment, export, in that order, with a
  built-in synthetic test volume so the steps can be tried without a real scan.

**Phase 2: density calibration.** (Built 2026-11-03; protocol in `docs/PHANTOM_PROTOCOL.md`.)
- A phantom protocol document (scan setup, phantom set, density measurement) written alongside the software.
  The lab does not scan phantoms yet (Matt, 2026-11-03).
- In the tool: outline each phantom on a slice, enter its measured density, fit gray to density (linear;
  residuals shown when three or more phantoms), store the fit with the scan.
- Output in g/cm³ labeled "equivalent density of the reference polymer". Doped or filled regions attenuate
  differently per gram, so their values are not true density, and the label says so.
- Scans without a calibration stay "uncalibrated" everywhere.

**Phase 3: open vs. closed porosity.** (Built 2026-11-03; plan in `docs/plans/2026-11-03-phase-3-connectivity.md`.
Builder's calls: the through-path is checked along each axis between the mask's two ends rather than between two
chosen faces; a pore within one binned voxel of the mask edge counts as open, as does one reached by an outside-air
flood fill through gray below the pore threshold; each pore also gets Wadell sphericity and surface distance.)
Open pores connect to the outside air through below-threshold voxels;
closed pores do not. Report open, closed and total porosity; a through-path check between two chosen faces;
state that the split depends on threshold and resolution (a crack below resolution reads as closed).

**Phase 4: comparison to CAD.** Load the nominal STL, align (rough manual placement, then a rigid fit),
extract the scan surface at the air-matrix midpoint, compute signed surface deviation, show a color map,
histogram and probe, and export. Optionally report the best-fit uniform scale as a shrinkage estimate.

**Phase 5: fiber and filler analysis.** Bright-phase segmentation with particle size distribution and
nearest-neighbor dispersion; fiber orientation tensor per region from local structure. The tool states the
resolution limit: fibers need several voxels across, so short glass fibers (about 10 to 15 µm) do not resolve
at 40 µm voxels.

**Phase 6 (later): wall thickness, dimensions with tolerances, batch runs across samples, before/after
comparison of two scans of one part.**

## Decided by Matt

Name VoxelBench; polymers focus; TIFF stacks from one scanner; scans over 2 GB; density calibration first;
the four analyses in goals 3 to 6; new public repository; static and artifact builds from one codebase; the
four anti-goals; rainbow view and review sheet carry over; version 10 stays live until VoxelBench matches
its Sample 2 numbers; acceptance against synthetic volumes, a Python reference, commercial software and
opt-in Archimedes density; the Sample 2 fixture is replaced by a synthetic one in the public repository.

## Version 10 and the regression gate

The Sinter CT Annotator (version 10) stays live, with its saved Sample 2 runs, until VoxelBench reproduces
its Sample 2 numbers with the same settings (Matt, 2026-11-03). With Sample 2 settings and the end-baseline
zone method, VoxelBench must match version 10: porosity 5.25 %, pore volume 726.5 mm³, 14,383 pores, 222
low-density regions, and the zone volumes at the +4 % threshold. That comparison runs locally (the scan is not
in the public repository) before every release, and v10 retires only after it passes.

## What the numbers must agree with

Acceptance checks per analysis (Matt, 2026-11-03):
- **Synthetic volumes** with known porosity, density and geometry, in the public test suite.
- **An independent Python reference** (scipy), as `ct_pipeline` does today, on the same inputs.
- **A cross-check against commercial CT software** on at least one shared scan.
- **Archimedes density, opt-in per sample**, since not every sample can be measured that way. When a sample has
  it, the report shows CT and Archimedes side by side. The part envelope used for porosity (how surface
  openings are closed) is stated in every report and chosen per project, so it can be set to match the
  physical measurement.

## Scan file layout

Matt chose "TIFF stacks, one scanner: same export format as the Rigaku scans". The Sample 2 export is a folder
of single-page, uncompressed, little-endian 16-bit TIFFs, one file per XY slice, with the voxel size in the
resolution tags; `parseTiff` (`ct_core.js:43`) reads exactly that. Scans over 2 GB are assumed to be the same
layout with more or larger slices, so Phase 1 needs binned loading, not a BigTIFF reader.

## Left to the builder (Claude's calls, for Matt to check)

- Browsers: desktop Chrome and Edge are the primary targets. Firefox and Safari are supported, but the
  project file is saved by download and reopened by picking it, since writing beside the scan needs an API
  only Chromium has. The memory budget assumes Safari's lower ceiling when the browser is Safari.
- Records: one versioned project schema with two back ends. A project exported from the artifact build
  imports into the static build and the reverse. An import into the shared database becomes a new run and
  never overwrites one.
- Document location until the repository exists (here).
- Repository name `voxelbench`, MIT license, GitHub Pages for the static build.
- Memory budget and binning rule for large scans.
- Alignment method for CAD comparison and the orientation method for fibers.
- Project file format (JSON, versioned schema).

## Open questions

1. Lab scanner and export: model, typical voxel sizes and largest stack size, so the memory budget is set
   from real numbers.
2. Phantom set: which polymers and densities the lab will use.
3. Who besides Matt gets the artifact build, which decides the database rules.
4. Which commercial package the lab can use for the cross-check.

Items 1, 2 and 4 are needed by Phase 1, Phase 2 and the first release respectively; item 3 before the artifact
build is shared.
