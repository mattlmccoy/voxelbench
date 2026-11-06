# VoxelBench library and opening flow (design, 2026-11-05)

## Why
VoxelBench opens straight into the full analysis studio: an empty viewer, nine step icons, a top bar of six buttons
and a box of eight more. A new lab member cannot tell what to do first, and there is no way to look through past
scans and results. The lab's scans and records will live on a shared external SSD that people plug into their own
laptops. The owner wants a scan library like the FLIR Research Interface's experiment library, and a calmer, more
polished first experience.

## Goals
- Open to a **library** of every scan on the lab drive, findable by name, date, settings, project, tag and star.
- A **scan overview** that shows a scan's settings, previews and saved results without loading the volume.
- A **studio** whose rail says what to do next for this scan and how far along it is.
- **No lab data in the tool.** The public page ships code and synthetic demos only; every sample name, material,
  density, preset, project and result lives in the lab's library on the drive.
- Works on lab members' own laptops with **no install**.

## Non-goals
- Copying, moving or renaming scans. Scans stay where the scanner export put them.
- Several people editing one library at the same moment (one drive, one laptop at a time).
- Remote or cloud storage; analysis on a server.
- Rewriting the analysis code or its numbers. The studio's steps compute exactly what they do today.

## Anti-goals (a failure even if it works)
- Lab-specific words or values in the code or defaults (sample names, "natural/doped", a holder's density).
- A library that silently loses or detaches a scan's records when a folder moves.
- A first screen that still needs a tour to understand.
- Breaking today's single-folder use for people without the drive.

## Constraints
- Static site on GitHub Pages; the repository is public (the hygiene test bans scan data and lab records).
- **Chrome or Edge only for the library** (the File System Access API: `showDirectoryPicker`, a directory handle kept
  in IndexedDB, `requestPermission` once per session, `createWritable` to write). Safari and Firefox show that the
  library needs Chrome or Edge and still open a single folder as today.
- The drive is exFAT. Large scans (to several GB) must not be read just to list them.
- Red-green TDD for logic; the page wiring is checked in the browser on real scans before it ships.

## Decided by the owner (2026-11-05)
1. **Library first** (FLIR-style), then **scan overview**, then the **studio**.
2. **Scans stay in place.** The library indexes them where they are.
3. **No install**: the page reads and writes the drive itself (Chrome/Edge), no operator program.
4. **One root folder**: the user picks one top folder on the drive; every scan anywhere under it is listed.
5. **Studio rail as a checklist**: the core path in order with done marks; specialist steps fold under "More
   analyses".
6. **The claude.ai artifact build is retired**: GitHub Pages is the one VoxelBench; the artifact gets a note
   pointing there.

7. **Sample details stay per scan**, as today: no separate sample entity; a rescan carries its own name, material,
   process and notes.
8. **Other tools split by purpose**: "Measure regions" joins the checklist as an optional step after Segment;
   Archimedes lives in the scan overview with the sample details; Compare runs and Batch move to the library
   (select cards, or a project); bookmarks and exports stay in the studio's top bar.

## Calls made in review (2026-11-05), for the owner to check
- **Scan identity = a hash of the first slice plus the volume's size**; the scanner record is only metadata. A VOX and
  a full-resolution TIFF export of the same volume are voxel-identical (checked on a lab scan, 548,937,984 voxels), so
  they are one card, read from the VOX; a binned or flipped export differs and stays its own card, so records never
  merge across grids.
- **Runs keep a history**: Save run appends; the studio reopens the latest; the review-sheet PDF is saved beside its
  run; "analyzed" means the scan has a saved run.
- **Cards show porosity only.** A whole-part relative density is not computed today, so it is not shown; the overview
  lists the relative densities of the regions the run saved. No value is shown without a defined source.
- **Old records**: importing a project file matches records to scans by folder name and asks when there is no match
  or more than one. In a library, scans are keyed by their path under the root, so equal folder names never collide.
- **"Open a folder…"** outside the root works as today, with a project file; the library covers scans under its root.
- **Retiring the artifact**: its last version keeps "Export project", so records in its database can be exported and
  imported into a library.

## The flow
**Library (first screen).** The first visit asks for the root folder; later visits ask once per session to allow
access. Cards: thumbnail (middle XY slice), the sample's name (else the scanner's study name, else the folder name),
scan date, scan time, voxel size, kV, and, once analyzed, porosity; a star. Side list: all,
starred, analyzed, not analyzed, projects, tags; search over name, study, tags and notes; sort newest first. Buttons:
Rescan, "Open a folder…" for a scan outside the library (today's path), and, on selected cards or a project,
Compare runs and Batch.

**Scan overview.** The scanner record (date, kV, µA, scan time, voxel, size, format, leveled or not), middle slices on
XY, XZ and YZ, the last saved run's results and the list of earlier runs, and the editable sample details, notes,
project, tags and star. **Analyze** opens the studio; nothing heavy loads before that.

**Studio.** Today's analysis view with a checklist rail for this scan: scan information, level the part (optional),
crop out holder and packaging, segment pores, density reference, review sheet; each marked done from the step's own
status, with "Measure regions" as an optional step after Segment. Zones, CAD, filler, walls and the Dragonfly
cross-check fold under "More analyses"; bookmarks and exports sit in the top bar. Back returns to the overview.

## The library on the drive
```
<root>/                     the folder the user picked; scans anywhere below it
  VoxelBench/               created on first use (visible, so it is not mistaken for junk)
    library.json            schema version, created, name
    scans.json              the index: scan id -> relative path, kind (vox|tiff), size, fingerprint, last seen
    records/<scan id>.json  samples, regions, annotations, orientation, notes, tags, star, project
    runs/<scan id>/…        saved runs and their chunks
    projects.json, presets.json, materials.json, labels.json
    thumbs/<scan id>.png    card and overview previews (regenerated when missing)
```
- **Scans found:** a folder holding a `.VOX`, or a folder of TIFF slices, as `CT.groupStacks` already decides; the
  scanner's `DataInfo.xml` beside it supplies the settings.
- **A scan's identity is not its path.** Its id is a hash of its first slice plus the volume's size, so copies of the
  same volume (VOX and TIFF) are one scan and a moved scan keeps its records on the next Rescan; a scan that vanished
  is listed as missing, never deleted.
- **Records go through the existing store interface** (`vb_store.js`: put, watch, getRun, putRun): a third back end,
  `library`, beside the project file and the retired artifact database, so the analysis code does not change. Today's
  project files import into a library.
- **Materials start empty.** Phantom materials and dense-reference materials are the library's own list.

## Leaks to remove (found 2026-11-05)
The dense-material suggestions hard-coded to natural/doped, the step-5 hint naming them, the phantom example "resin
holder", and the README's "printed holder". Generic physics wording stays.

## Left to the builder
- Exact card and overview layout within the mockups' structure, in the Lab/Mac/Glass looks.
- Thumbnail size and when they are made (on first listing, in the background).
- How XZ and YZ previews are read for TIFF-only scans (they need every slice) versus VOX (byte ranges).
- Write safety on exFAT (write to a temporary file, then replace).
- How the checklist reads each step's done state.
