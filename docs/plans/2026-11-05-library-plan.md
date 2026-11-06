# Library and opening flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VoxelBench opens to a library of the scans under one root folder on the lab drive, then a scan overview,
then the studio with a checklist rail, with every lab-specific record kept in the library, not the tool.

**Architecture:** Chrome/Edge's File System Access API gives the page a directory handle to the root (kept in
IndexedDB). Pure modules decide everything testable (scan identity, the index, filters, card and overview facts, the
checklist, import matching); `vb_fsdir.js` wraps the directory handle; a third store back end, `library`, writes
records under `<root>/VoxelBench/` behind the existing store interface, so the analysis code is unchanged.

**Tech Stack:** plain browser JavaScript (UMD modules in `app/`), `node:test`, Web Crypto (SHA-256), File System
Access API, IndexedDB, OPFS for browser verification.

**Spec:** `docs/plans/2026-11-05-library-design.md`

## Global Constraints
- The library needs Chrome or Edge (`'showDirectoryPicker' in window`); other browsers show that and still open a
  single folder.
- The tool ships no lab data: no sample names, materials, densities, presets or results in code, defaults or docs.
- Scans are never copied, moved, renamed or deleted; only `<root>/VoxelBench/` is written.
- A scan's id = SHA-256 over its size and its first and middle slices; the scanner record is metadata only.
- Runs keep a history: Save run appends; the latest is restored; nothing overwrites a run.
- No value is shown without a defined source (cards show porosity only).
- Public repository: `npm test` (hygiene included) green and `node tools/check_history.js HEAD` clean before push.
- Red-green TDD for logic; page wiring is checked in the browser. American English.

## Review Focus
1. A library of hundreds of multi-GB scans: listing reads only two slices per new scan and nothing for known ones
   (Task 2 test: a known id with an unchanged size and mtime is not re-read).
2. Access lost mid-session (drive unplugged, permission revoked): writes fail with a message and the in-memory
   records stay; nothing is half-written (Task 3 test: a write that throws leaves the previous file intact).
3. A `VoxelBench/` folder written by a newer VoxelBench, or with unreadable JSON: refuse to open it, never overwrite
   (Task 3 test).
4. Scans whose first slices are identical (all-zero slices outside the reconstruction): the middle slice keeps their
   ids apart (Task 1 test).
5. A scan moved within the root, or deleted: moved keeps its records; deleted is listed as missing with its records
   kept (Task 2 test).

---

### Task 1: Scan identity

**Files:** Create `app/vb_library.js`; Test `tests/library.test.js`

**Interfaces:** Produces `scanId({ width, height, count, first, middle }) -> Promise<string>` (`first`, `middle`:
`Uint16Array`; returns `'s'` + 16 hex characters).

- [ ] **Step 1: Write the failing tests** `scan id: the same volume from VOX and TIFF has one id`, `scan id: a
  different size or middle slice changes it` (two volumes with all-zero first slices and different middle slices get
  different ids), `scan id: the format is s + 16 hex`.
- [ ] **Step 2: Run** `node --test tests/library.test.js`; expected FAIL (module missing; add a stub so each test
  fails on its assertion).
- [ ] **Step 3: Implement** `scanId` with `crypto.subtle.digest('SHA-256', …)` over the text
  `${width}x${height}x${count}` followed by the bytes of `first` and `middle`.
- [ ] **Step 4: Run** the tests; expected PASS.
- [ ] **Step 5: Real data:** with `fs.openAsBlob` and `VBVox.openVox`, the 30 wt% reference VOX and the same data via
  its TIFF stack give the same id (print both).
- [ ] **Step 6: Commit** `feat(library): scan identity from size and two slices`.

### Task 2: The library index

**Files:** Modify `app/vb_library.js`; Test `tests/library.test.js`

**Interfaces:**
- Consumes `scanId` (Task 1).
- Produces `INDEX_VERSION = 1`, `emptyIndex(now) -> Index` where `Index = { schema: 'voxelbench-library-index',
  version, scans: { [id]: { path, kind, bytes, mtime, study, first_seen, last_seen, missing } } }`;
  `needsRead(index, found) -> boolean` (`found = { path, bytes, mtime }`: false when an entry with the same path,
  bytes and mtime exists); `mergeIndex(index, scans, now) -> Index` (`scans = [{ id, path, kind, bytes, mtime,
  study }]`).

- [ ] **Step 1: Write the failing tests** `index: a new scan is added`, `index: a scan found at a new path keeps its id
  and gets the new path`, `index: a scan not found is marked missing and kept`, `index: a missing scan found again is
  not missing`, `index: an unchanged scan needs no read` (Review Focus 1, 5).
- [ ] **Step 2: Run** them; expected FAIL.
- [ ] **Step 3: Implement** `emptyIndex`, `needsRead`, `mergeIndex` (pure; `now` is passed in).
- [ ] **Step 4: Run** them; expected PASS.
- [ ] **Step 5: Commit** `feat(library): scan index (moved scans keep their records, missing ones stay listed)`.

### Task 3: The drive and the library store

**Files:** Create `app/vb_fsdir.js`, `tests/fake_dir.js`; Modify `app/vb_store.js`; Test `tests/fsdir.test.js`,
`tests/store.test.js`

**Interfaces:**
- Produces in `vb_fsdir.js` (all take a FileSystemDirectoryHandle-like `dir`): `walk(dir) -> AsyncIterable<{ path,
  file }>` (path relative to `dir`, '/'-separated, dot-files and the `VoxelBench` folder skipped);
  `readText(dir, path) -> Promise<string|null>`; `writeText(dir, path, text)` (creates folders; writes
  `<name>.tmp` then the file, so a failed write leaves the old file); `writeBlob(dir, path, blob)`.
- Produces in `vb_store.js`: `LIBRARY_DIR = 'VoxelBench'`, `makeLibraryStore(dir, { toolVersion }) -> Promise<store>`
  with `kind: 'library'`, the existing interface (`watch`, `put`, `remove`, `getRun` = latest, `putRun` appends
  `runs/<folder>/<ISO time>.json`, `exportProject`, `importProject`, `isEmpty`) plus `listRuns(folder) -> [{ at }]`
  and `putFile(path, blob)`. Records go to `records/<sample folder>.json` (`{ samples, regions, annotations }`),
  labels and presets to `labels.json` and `presets.json`, `library.json` = `{ schema: 'voxelbench-library',
  version: 1, created }`.
- `tests/fake_dir.js`: an in-memory directory with `values()`, `getDirectoryHandle(name, { create })`,
  `getFileHandle(name, { create })`, `removeEntry`, file handles with `getFile()` and `createWritable()`, and an
  option to make the next write throw.

- [ ] **Step 1: Write the failing tests:** `walk lists files with relative paths and skips dot-files and VoxelBench`,
  `writeText replaces a file and a failing write leaves the old one` (Review Focus 2), `library store: a region put
  is written to its scan's record file and watched back`, `library store: putRun appends and getRun returns the
  latest; listRuns lists both`, `library store: a library.json from a newer version refuses to open; unreadable JSON
  refuses` (Review Focus 3), `library store: importProject keeps runs and records`.
- [ ] **Step 2: Run** them; expected FAIL.
- [ ] **Step 3: Implement** `vb_fsdir.js` and `makeLibraryStore` (load every `records/*.json` at open, so `watch`
  gets whole collections as the other back ends do).
- [ ] **Step 4: Run** `npm test`; expected all PASS.
- [ ] **Step 5: Commit** `feat(library): drive helpers and the library store`.

### Task 4: Opening a library in the page

**Files:** Create `app/vb_libraryview.js`; Modify `app/ct_app.js`, `app/index.html`, `app/vb_library.js`;
Test `tests/library.test.js`

**Interfaces:**
- Consumes Tasks 1-3, `CT.groupStacks`, `VBVox.openVox`.
- Produces in `vb_library.js`: `filterScans(entries, { query, filter, tag, project }) -> entries` (`filter`: `all`,
  `starred`, `analyzed`, `unanalyzed`, `missing`) and `cardFacts({ entry, record, run }) -> { title, date,
  scanSeconds, voxelUm, kv, porosity, analyzed, starred, tags, missing }` (`title` = sample name, else study, else
  folder name; `porosity` from `run.summary.all_void_percent_of_body`, else null).
- Produces in the page: `App.showPage('library'|'overview'|'studio')`, `App.openLibrary()`, `App.library` =
  `{ dir, index, entries }`; `state.folder` is the scan id for library scans.
- Star, tags, notes and project are fields of the scan's sample record (`App.saveSample({ starred, tags, notes,
  project })`; `CT.sampleRecord` keeps unknown fields). The project list and the materials list are derived from the
  records, so the design's `projects.json` and `materials.json` are not needed.

- [ ] **Step 1: Write the failing tests** for `filterScans` (search over title, study, tags and notes; each filter)
  and `cardFacts` (title fallbacks; porosity null without a run; `analyzed` = a run exists).
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement** them. **Step 4: Run**; PASS.
- [ ] **Step 5: Wire the page:** a `#libraryPage` before `.studio` with the root picker (`showDirectoryPicker`, handle
  kept in IndexedDB, `requestPermission` on return visits), Rescan (walk, group, read two slices for scans whose
  `needsRead`, merge, write `scans.json`), the card grid with thumbnails (`VoxelBench/thumbs/<id>.png`, made from
  the middle XY slice at 256 px wide on first listing), side filters, search, star and tags; a non-Chrome notice; and
  "Open a folder…" (today's path, project-file store). The `#startup` box is removed; its demo buttons move to the
  library page.
- [ ] **Step 6: Browser check:** in the built-in browser, copy two lab VOX scans and one TIFF folder into OPFS
  (`navigator.storage.getDirectory()`), open it as the root through a test hook, Rescan: 3 cards with settings;
  Rescan again reads nothing (Review Focus 1); rename a folder, Rescan: same card, new path.
- [ ] **Step 7: Commit** `feat(library): the library page`.

### Task 5: Scan overview

**Files:** Create `app/vb_overview.js`; Modify `app/vb_library.js`, `app/index.html`; Test `tests/library.test.js`

**Interfaces:** Produces `overviewFacts({ entry, scanInfo, header, run, runs }) -> { rows: [[label, value]],
results: [[label, value]], runs: [{ at, label }] }` (rows: scanned, kV/µA, scan time, voxel, size, format, leveled;
results from the latest run: porosity, open, closed, pores, and each saved region's relative density from
`run.relative_scale` and its regions; nothing invented) and `voxRowRange(header, plane, index, row) -> [start, end]`
for XZ/YZ previews from a VOX.

- [ ] **Step 1: Write the failing tests** for `overviewFacts` (a run with and without dense references; no run) and
  `voxRowRange` (a 3 × 2 × 2 header: the right byte ranges for XZ and YZ).
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS.
- [ ] **Step 5: Wire** `#overviewPage`: the facts, XY/XZ/YZ middle slices (XZ/YZ only for VOX scans; a TIFF-only scan
  says "XZ and YZ after Analyze"), editable sample details, notes, tags, star and project, Archimedes (moved from Scan
  information), and Analyze (loads the scan, `showPage('studio')`); back to the library.
- [ ] **Step 6: Browser check** on the OPFS library: overview of a VOX scan without a run and of one after Save run.
- [ ] **Step 7: Commit** `feat(library): scan overview`.

### Task 6: Studio checklist rail

**Files:** Create `app/vb_checklist.js`; Modify `app/vb_skin.js` (`wireStepBar`), `app/index.html`;
Test `tests/checklist.test.js`

**Interfaces:** Produces `checklist({ scanInfo, leveled, crops, pores, regions, dense, sheetSaved }) -> [{ id,
section, label, optional, done }]` in this order: scan info (`secScan`), level (optional, `secScan`), crop (`step1`),
segment pores (`step2`), measure regions (optional, `step3`), density reference (`step5`), review sheet (`step4`);
`more = ['zones','cad','filler','walls','dragonfly']` mapped to their sections.

- [ ] **Step 1: Write the failing tests:** order and labels; each done rule (`crops.length > 0`, `pores !== null`,
  `dense > 0`, `sheetSaved`); optional steps never block the next one.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS.
- [ ] **Step 5: Wire** the rail: the checklist replaces the step icons at the top (the next undone step highlighted;
  a click opens its section); "More analyses" lists the rest; bookmarks and exports go to the top bar; Back returns to
  the overview. Check all three looks and phone width with the overflow audit.
- [ ] **Step 6: Commit** `feat(studio): checklist rail`.

### Task 7: Runs, review sheets, compare and batch in the library

**Files:** Modify `app/ct_rail.js` (Save run), `app/ct_sheetexport.js`, `app/vb_batch.js`, `app/vb_comparerail.js`,
`app/vb_libraryview.js`, `app/vb_library.js`; Test `tests/library.test.js`

**Interfaces:** Consumes `store.putRun/listRuns/putFile`. Produces `matchImport(projectFolders, entries) -> { matched:
{ [folder]: id }, unmatched: [folder], ambiguous: { [folder]: [id] } }` (by folder name, the last path segment).

- [ ] **Step 1: Write the failing tests** for `matchImport` (one match, none, two).
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS.
- [ ] **Step 5: Wire:** the review sheet PDF also goes to `runs/<id>/<time>-review.pdf` in a library; Compare runs and
  Batch act on selected cards or a project in the library (Batch reads one scan at a time and states the total size
  first); Import project asks about unmatched and ambiguous folders.
- [ ] **Step 6: Browser check:** Save run twice on one OPFS scan (two runs listed in the overview), make a review
  sheet (PDF in `runs/`), compare two scans with different kV (warning shown).
- [ ] **Step 7: Commit** `feat(library): run history, review sheets, compare and batch from the library`.

### Task 8: Remove lab vocabulary and retire the artifact

**Files:** Modify `app/index.html`, `app/vb_calrail.js`, `app/vb_calibration.js`, `README.md`; Test
`tests/calibration.test.js`

**Interfaces:** Produces `Cal.knownDenseMaterials(regions) -> [string]` (materials of dense-reference regions, most
recent first).

- [ ] **Step 1: Write the failing test** `dense materials used before are offered; none by default`.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**, and fill `#denseMaterials` from it. **Step 4: Run**; PASS.
- [ ] **Step 5:** remove the hard-coded natural/doped options, "natural or doped" placeholder and hint, "resin
  holder", and the README's "printed holder" (generic placeholders: "material name").
- [ ] **Step 6:** publish the artifact's last version: a banner "VoxelBench moved to <Pages URL>" with Export project
  kept; no further artifact publishes.
- [ ] **Step 7:** `npm test`, the local Sample 2 gate, `check_history`, push, confirm Pages serves it, and ask the
  owner to open the real drive as a root in Chrome.
- [ ] **Step 8: Commit** `chore: no lab vocabulary in the tool; artifact retired`.
