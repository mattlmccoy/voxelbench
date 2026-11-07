# Holder Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VoxelBench finds and removes the part holder (plates, round posts, tape) every time it builds the sample
mask, shows it for review, saves the reviewed result with the sample, and re-levels scans leveled with the holder in.

**Architecture:** A new pure module `app/vb_holder.js` (UMD, like `vb_orient.js`) finds holder pieces on the binned
volume, fits each as a slab, cylinder or thin-shell box, and rebuilds the holder mask from pieces. `buildBody` in
`app/ct_pores.js` calls it between thresholding and the opening. The worker sends the holder labels and pieces with the
model; the page draws them, toggles pieces on click, and saves them to the sample record in native scan voxels.

**Tech Stack:** plain JavaScript (no dependencies), web worker, `node --test`.

**Spec:** `docs/plans/2026-11-06-holder-removal-design.md` (approved by Matt 2026-11-06).

## Global Constraints
- No lab data in the repository: no scan numbers, sample names, private paths or real-scan fixtures in code or tests
  (`tests/hygiene.test.js`, `tools/banned.js`). Acceptance numbers live outside the repo in `VOXELBENCH_LOCAL_DIR`.
- No constant tuned to one scan: every gray, size and count limit is derived from the scan (voxel size, part gray,
  noise) or is a scale-free ratio.
- American English in all copy and comments.
- Modules follow the repo's UMD pattern (`module.exports` in node, a `root.VB…` global in the page and worker).
- Run the suite with `npm test` (never `node --test tests/`). Local gate: `npm run test:local`.
- Never push. Matt reviews first; `release` is pushed later as `git push origin release:main` after
  `node tools/check_history.js release`.
- New files stay under 400 lines.
- Time budget: holder finding adds at most 15 s per mask build on Sample 6, with a progress bar.

## Rulings made while planning (spec silent or wrong; reviewable)
- **R1. Acceptance scan for Sample 6.** The Nov 5 part mask (`out/s6_b4_part.npy`, `s6_partmask.json`) was built from
  the 32 s scan (`s6_32s_b4.npy`), not the high-res one. The gate compares the 32 s scan to that mask, and checks that
  the high-res scan's part envelope agrees with the 32 s result within 2 % (same sample, same mount).
- **R2. Gate body threshold** = the Nov 5 threshold for that scan, read from the local `expected.json`, so the
  comparison isolates holder removal from threshold differences.
- **R3. Tape pieces are stored as a box** (center, axes, half extents) plus the rule "solid voxels in the box with local
  thickness at most 2 voxels"; plates and posts store their fitted shapes.
- **R4. Synthetic holder scenes** are a new `VBSynthetic.makeHolderScene` returning in-memory arrays, not new
  `makeScan` options: holder tests need the volume and truth masks, not TIFF files.
- **R5. Removal warning** when the holder takes more than 50 % of the solid, or the largest remaining body is smaller
  than half the largest body without removal.
- **R6. Re-level note** reports how far the up axis and the long axis moved, in degrees.

## Review Focus
1. **A part that itself runs off the scan edge with no holder** (Sample 4 touches the field of view): no pieces found,
   mask unchanged. Pinned in Task 3.
2. **Bright inclusions at 80 kV** (agglomerates scattered in the part) must not be taken as a bright holder. Task 3.
3. **A crop that cuts through the post:** detection ignores crops, the post is still found and removed. Task 4.
4. **A saved holder reopened at another binning or in a leveled frame** rebuilds the same pieces (one binned voxel).
   Task 5.
5. **Toggling a piece leaves no stale downstream state** (pores, zones, mass computed on the old mask). Task 6.

---

### Task 1: Synthetic holder scenes

**Files:**
- Modify: `app/vb_synthetic.js` (export `makeHolderScene`)
- Test: `tests/synthetic.test.js`

**Interfaces:**
- Produces: `VBSynthetic.makeHolderScene({ size = 96, voxelMm = 0.16, seed = 1, part = 'blob' | 'cube', holder = 'post' | 'plates' | 'none', holderGray = 'same' | 'bright', tape = false, inclusions = false, touchEdge = false }) -> { gray: Float32Array, outside: Uint8Array, dims, voxelMm, truth: { part: Uint8Array, holder: Uint8Array, tape: Uint8Array, pieces: { kind, thicknessVox?, radiusVox? }[] } }`.
  Grays: part matrix `MATRIX_GRAY` with pores at `AIR_GRAY`, air `AIR_GRAY`, holder `MATRIX_GRAY` ('same') or
  `MATRIX_GRAY + 600` ('bright'), tape `MATRIX_GRAY`, noise SD `NOISE_SD`; FOV circle as `makeScan`, outside = 1.
  - `post`: a stepped cylinder on the z axis from z = 0 up to the part's bottom face (cap radius 0.14 size, height
    0.1 size; stem radius 0.06 size to z = 0).
  - `plates`: a base slab at the bottom (thickness 0.035 size) and two plates tilted 25° and 60° from it that the part
    leans on, each running to the FOV edge.
  - `blob`: a lumpy porous body (union of 3 offset ellipsoids, pores radius 2-4 voxels) resting on the holder;
    `cube`: a pore-free cube of side 0.3 size, flat faces, resting on the holder.
  - `tape`: a one-voxel shell 1 voxel above the part's top, draped down the sides, touching the part at 3 points.
  - `inclusions`: 30 bright spheres (radius 1-2 voxels, `MATRIX_GRAY + 600`) inside the part.
  - `touchEdge`: the part extends past the FOV circle on one side.

- [ ] **Step 1: Write the failing tests** `holder scenes are reproducible and their truth masks are disjoint` (same
  seed gives identical `gray`; `part`, `holder`, `tape` never overlap; `post` scene has holder voxels on slice 0;
  `plates` scene has `truth.pieces` kinds `['plate', 'plate', 'plate']`) and `a bright holder reads brighter than the
  part` (median gray of holder voxels exceeds median of part voxels by more than 400 for 'bright', less than 50 for
  'same').
- [ ] **Step 2: Run** `npm test` — expect FAIL: `makeHolderScene is not a function`.
- [ ] **Step 3: Implement** `makeHolderScene` in `app/vb_synthetic.js`, reusing `random` and the gray constants.
- [ ] **Step 4: Run** `npm test` — expect PASS, whole suite green.
- [ ] **Step 5: Commit** `test: synthetic holder scenes (post, plates, tape, cube)`.

### Task 2: Piece fits and mask rebuild

**Files:**
- Create: `app/vb_holder.js`
- Test: `tests/holder.test.js`

**Interfaces:**
- Consumes: `makeHolderScene` (Task 1).
- Produces (all in binned-grid voxel coordinates `[x, y, z]`):
  - `Piece = { id: string, kind: 'plate' | 'post' | 'tape', foundBy: 'bright' | 'shape', center: number[3], axes: number[9] /* rows: long, mid, short (plate normal = row 3; post axis = row 1) */, half: number[3] /* half extents along axes; post: [halfLength, radius, radius] */, voxels: number, mm3: number }`
  - `fitSlab(points: Float32Array /* xyz triples */) -> Piece-like { center, axes, half }` — PCA, normal = least-variance
    axis; half extents from the 0.5 and 99.5 percentiles along each axis, plus 0.5 voxel on thickness.
  - `fitCylinder(points) -> { center, axes, half }` — axis = greatest-variance axis; radius = median distance to it.
  - `insidePiece(piece, x, y, z) -> boolean`.
  - `holderMask({ solid: Uint8Array, dims, pieces: Piece[], givenBack: string[] }) -> { holder: Uint8Array, labels: Uint8Array /* piece index + 1, given-back pieces included */ }` — holder = solid voxels inside a piece not
    given back, dilated by one voxel into solid; tape pieces take only solid voxels whose local thickness is at most 2.

- [ ] **Step 1: Write the failing tests:** `a slab fit recovers a plate's normal and thickness` (points of a 4-voxel
  plate tilted 25°: normal within 2° of truth, `2 * half[2]` within 1 voxel of 4); `a cylinder fit recovers a post's
  axis and radius` (axis within 2°, radius within 0.5 voxel); `holderMask takes the solid inside the pieces and
  nothing given back` (on the `post` scene with truth-fitted pieces: holder covers ≥ 95 % of `truth.holder`, takes
  ≤ 1 % of `truth.part`; with the post's id in `givenBack`, holder is empty and `labels` still marks the post).
- [ ] **Step 2: Run** `npm test` — expect FAIL: `Cannot find module '../app/vb_holder.js'`.
- [ ] **Step 3: Implement** the four functions in `app/vb_holder.js`. Use the closed-form 3×3 symmetric eigen solver
  pattern already in `ct_pores.js` `elongation` (extract a shared helper only if it stays small).
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(holder): slab and cylinder fits, holder mask from pieces`.

### Task 3: Finding the holder

**Files:**
- Modify: `app/vb_holder.js`
- Test: `tests/holder.test.js`

**Interfaces:**
- Consumes: Task 2 fits and `holderMask`.
- Produces: `findHolder({ smoothed: Float32Array, solid: Uint8Array, outside: Uint8Array, dims, voxelMm, onProgress?: (stage: string, k: number, total: number) => void }) -> { method: 'bright' | 'shape' | 'none', pieces: Piece[] }`.
  Seeds by brightness when the solid's gray histogram has a population above the part's main peak whose largest
  connected body is holder-sized; otherwise per-slice bar and repeated-disk tests in all three slice directions,
  grouped into 3-D clusters. A cluster becomes a piece only when it fills its fitted shape well, its gray spread is
  below the part's, and it reaches the reconstruction edge (outside mask or volume border) or is the bright
  population. Each accepted fit is extended along its long axes while the solid fills its cross-section. Ids are
  `h1, h2, …` in order of size. `onProgress('Finding the holder', k, total)` once per slice per direction. The limits
  are derived from `voxelMm`, the part's gray and the noise; none is scan-tuned (Global Constraints).

- [ ] **Step 1: Write the failing tests** on `makeHolderScene`:
  - `a bright post is found by brightness` (`method === 'bright'`; one or two `post` pieces; holder mask covers ≥ 95 %
    of `truth.holder`, takes ≤ 1 % of `truth.part`);
  - `a post at part gray is found by shape` (`method === 'shape'`, same coverage limits);
  - `tilted plates and a base slab are found as three plates` (three `plate` pieces, each thickness within 1 voxel of
    truth; same coverage limits);
  - `a flat-faced cube on a post keeps every face` (takes ≤ 1 % of `truth.part`; no piece's box contains the cube's
    center);
  - `no holder, no pieces` (`holder: 'none'` → `method === 'none'`, `pieces.length === 0`);
  - `a part running off the scan edge is not a holder` (`holder: 'none', touchEdge: true` → no pieces);
  - `bright inclusions are not a bright holder` (`holder: 'none', inclusions: true` → no pieces;
    `holder: 'post', holderGray: 'same', inclusions: true` → `method === 'shape'`);
  - `progress reaches its total` (last `onProgress` call has `k === total`).
- [ ] **Step 2: Run** `npm test` — expect FAIL: `findHolder is not a function`.
- [ ] **Step 3: Implement** `findHolder` in `app/vb_holder.js` (split seeds into `app/vb_holderseeds.js` if
  `vb_holder.js` would pass 400 lines).
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(holder): find plates and posts by brightness or shape`.

### Task 4: Holder removal in buildBody, tape, warnings

**Files:**
- Modify: `app/ct_pores.js` (`buildBody`)
- Modify: `app/vb_holder.js` (`findTape`)
- Test: `tests/holder.test.js`, `tests/pores.test.js` (existing tests must stay green unchanged)

**Interfaces:**
- Consumes: `findHolder`, `holderMask`.
- Produces:
  - `findTape({ solid, holder, dims }) -> Piece[]` — thin-shell pieces (local thickness ≤ 2 voxels everywhere) that
    reach away from the part, as boxes (R3), kind `'tape'`.
  - `buildBody(gray, outside, dims, settings, crop, holderInput?)` where
    `holderInput = { pieces: Piece[] | null /* null: find */, givenBack: string[], voxelMm, onProgress? }`.
    Without `holderInput`, behavior is unchanged. With it: solid is thresholded **without** the crop; pieces are found
    (or the given ones used) plus tape; the holder (`holderMask`) is removed from solid **before** the opening,
    largest component, closing and hole filling; then the crop is applied as today; the holder is subtracted again
    at the end. Returns `{ smoothed, filled, holder: { method, pieces, givenBack, labels, removedVoxels, warning: string | null } }`.
    `warning` per R5.

- [ ] **Step 1: Write the failing tests:**
  - `the sample mask leaves the holder out` (bright post scene: `filled` overlaps `truth.holder` by ≤ 1 % of its
    voxels; `filled` covers ≥ 98 % of `truth.part`);
  - `tape is stripped and the air under it is not counted` (blob + tape: `filled` volume with tape ≤ 1.01 × without;
    a tape piece is listed);
  - `a crop through the post does not stop removal` (crop keeping the upper 60 % of z: post still in `pieces`,
    `filled` overlaps `truth.holder` by ≤ 1 %);
  - `a piece given back returns to the part` (`givenBack: [post id]` → `filled` includes the post's solid voxels
    that touch the part);
  - `given pieces are used, not found again` (passing the pieces from a first call gives an identical `filled`);
  - `removal that takes most of the solid warns` (pieces covering the whole part → `warning` not null).
- [ ] **Step 2: Run** `npm test` — expect FAIL on the new tests; existing `pores.test.js` still passes.
- [ ] **Step 3: Implement** `findTape` and the `holderInput` path in `buildBody`.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(holder): remove the holder and tape when building the sample mask`.

### Task 5: Pieces in native voxels and other frames

**Files:**
- Modify: `app/vb_holder.js`
- Test: `tests/holder.test.js`

**Interfaces:**
- Consumes: `Piece`; the orientation shape from `vb_orient.js` (`{ R, center, origin, dims }`; a native point `p` is
  at leveled grid position `q = R(p - center) - origin`, rows of `R` are the part axes).
- Produces:
  - `piecesToNative(pieces, gridScale: number /* native voxels per grid voxel = binFactor × BIN */, orient | null) -> Piece[]` — centers by `c * f + (f - 1) / 2`, half extents by `f`; leveled pieces mapped back
    through `orient` first.
  - `piecesFromNative(pieces, gridScale, orient | null) -> Piece[]` — the inverse.

- [ ] **Step 1: Write the failing tests:** `pieces survive a round trip through native voxels` (any piece →
  native → grid equals the original within 1e-6); `the same pieces rebuild the same holder at another binning`
  (post scene at size 96 and the same scene binned ×2: masks from converted pieces agree within one grid voxel on
  the piece surfaces — compare the ×2 mask upsampled, ≥ 97 % Dice); `pieces follow a leveled frame` (rotate a scene
  by a known `R`; pieces converted into that frame contain the rotated post's voxels, ≥ 95 %).
- [ ] **Step 2: Run** `npm test` — FAIL: functions missing.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(holder): store pieces in native scan voxels, map into leveled frames`.

### Task 6: Worker wiring, cache, progress

**Files:**
- Modify: `app/ct_worker.js` (`ensureBody`, `sendModel`, the `variantSummary`/sheet sweep path, a `holder` message)
- Modify: `app/vb_holder.js` (pure helpers below)
- Modify: `app/ct_app.js` (send the saved holder with every request that builds the body; handle `progress`)
- Modify: `app/index.html`, `app/vb_styles.css` (a progress bar under `#poreStatus`)
- Test: `tests/holder.test.js`

**Interfaces:**
- Consumes: `buildBody(..., holderInput)`, `piecesFromNative`.
- Produces:
  - `holderKey(saved: { pieces, givenBack } | null) -> string` — part of `ensureBody`'s key: equal for equal saved
    holders, different when a toggle changes.
  - `progressText(stage, k, total) -> string` — exactly `"Finding the holder: slices 120 / 348"` for
    `('Finding the holder', 120, 348)`.
  - Worker: every message that builds the body carries `holder: { pieces /* native */, givenBack } | null`. The worker
    converts with `piecesFromNative(…, vol.bin × binFactor, orientation)`. A rebuilt body clears `poreCoarse`,
    `coarse`, `voidShare`, `zoneReady`, `patchLabels`, `solidGray`, `airGray` and `pores`. The `model` message adds
    `holder: { method, pieces /* native */, givenBack, labels, labelsDims, warning }`. The sheet's threshold sweep calls
    `buildBody` with the current pieces (never `pieces: null`). Progress posts `{ type: 'progress', text, share }`.
  - Page: `state.holder` holds the last `model.holder`; a `progress` message fills the new bar and `#poreStatus`.

- [ ] **Step 1: Write the failing tests** `holderKey changes with a toggle and not otherwise` and `progressText reads
  stage, slice and total`.
- [ ] **Step 2: Run** `npm test` — FAIL.
- [ ] **Step 3: Implement** the helpers, then the worker and page wiring above.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Browser check** (not unit-testable): serve the app, open an OPFS test library with a synthetic scan
  (`window.CTApp`, `VBStore.LIBRARY_DIR`, `window.confirm = () => true`, `App.openLibraryDir(root)`), confirm the progress
  bar moves during "Finding the holder" and the status reads the holder result; change a toggle via
  `CTApp.saveSample` and confirm pores rerun on the new mask (pore count changes or the status says it reran).
- [ ] **Step 6: Commit** `feat(holder): worker builds the mask without the holder, with progress`.

### Task 7: Review overlay, piece list, saving

**Files:**
- Create: `app/vb_holderrail.js` (piece list, status, Accept)
- Modify: `app/ct_app.js` (`LAYERS` gains `{ id: 'holder', label: 'Holder', … }`), `app/ct_views.js` (`overlayImage`
  paints holder labels; `clickAt` in the `review` tool toggles the piece under the click before trying pores),
  `app/index.html` (rail section and script tag)
- Modify: `app/vb_holder.js` (pure helpers)
- Test: `tests/holder.test.js`

**Interfaces:**
- Consumes: `state.holder` (Task 6), `App.saveSample`, `piecesToNative`.
- Produces:
  - `holderStatus(h: { method, pieces, givenBack, reviewed } | null, failed?: string) -> string` with exactly these
    forms: `"not run"`, `"no holder found"`, `"removal failed: <reason>"`, `"3 holder pieces, not reviewed"`,
    `"3 holder pieces, reviewed (1 given back)"`; method shown as `"found by bright resin"` or `"found by shape"`.
  - `holderRecord(h, givenBack) -> { pieces, given_back, method, reviewed_at }` — what `saveSample({ holder })` stores
    (pieces already native). Saved on Accept or on any toggle; an unreviewed proposal is never saved.
  - A click in the `review` tool on a voxel whose holder label is a piece toggles it in `givenBack`, saves, and the
    worker rebuilds (Task 6).
  - Hover: `showReadout` appends ` | holder h2 (post, radius 5.1 mm)` over a holder voxel.
  - The rail lists each piece: kind, thickness or radius and extents in mm, volume in mm³, and the method line; the
    `warning` (Task 4) shows above the list.

- [ ] **Step 1: Write the failing tests** `holder status names what was checked` (each form above, including that
  `null` reads "not run" and never "no holder found") and `the saved record holds native pieces and the toggles`.
- [ ] **Step 2: Run** `npm test` — FAIL.
- [ ] **Step 3: Implement** the helpers, the rail, the layer, the overlay and the click toggle.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Browser check:** on the synthetic post scene in the OPFS library, screenshot the holder overlay in all
  three views; click the post in the review tool and confirm it turns part-colored, the status says "reviewed (1 given
  back)", the record shows `holder.given_back`, and reopening the scan keeps the toggle. Read the screenshots
  yourself before reporting.
- [ ] **Step 6: Commit** `feat(holder): review overlay, piece list and saving with the sample`.

### Task 8: Re-level scans leveled with the holder in

**Files:**
- Modify: `app/vb_orient.js` (pure helpers), `app/vb_orientrail.js` (`apply` stamps `holder_removed: true`),
  `app/ct_app.js` (`loadStack` / after the first model)
- Test: `tests/orient.test.js`

**Interfaces:**
- Produces:
  - `needsRelevel(orientation) -> boolean` — true when a saved orientation lacks `holder_removed: true`.
  - `axisChange(Rold: number[9], Rnew: number[9]) -> { up_deg, long_deg }` — angle between the old and new z rows and
    x rows (sign-free, 0-90°).
  - Flow: a scan whose saved orientation `needsRelevel` opens in scan axes; after its first `model` (holder removed),
    the page levels from the holder-free mask (`levelFromMask`, `gridForPoints` as in `vb_orientrail.js` `level`),
    saves `{ …orientation, holder_removed: true, method: 'principal axes of the holder-free sample mask (re-leveled automatically)', replaced: { made_at, angles_deg } }`, reopens the scan leveled, and shows the one-time note
    `"Re-leveled without the holder: the up axis moved 3.1°, the long axis 1.4°. Slider nudges from <date> were dropped."`

- [ ] **Step 1: Write the failing tests** `an orientation from before holder removal needs re-leveling` and
  `axisChange measures how far the axes moved` (identity vs a 3° tilt about x → `up_deg` 3 ± 1e-6, `long_deg` 0).
- [ ] **Step 2: Run** `npm test` — FAIL.
- [ ] **Step 3: Implement** the helpers and the flow.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Browser check:** save an orientation without `holder_removed` on a synthetic scan, reopen it, confirm it
  re-levels once, shows the note, and a second reopen does not re-level again.
- [ ] **Step 6: Commit** `feat(orient): re-level scans leveled with the holder in the mask`.

### Task 9: Local acceptance gate

**Files:**
- Create: `tests/local/holder.test.js`, `tools/npy.js` (minimal reader for uint8/bool `.npy`, C order)
- Test: `tests/npy.test.js` (CI, on a hand-built byte buffer)

**Interfaces:**
- Consumes: `tools/headless_run.js` `readStack`, `VBVox.openVox`, `P.binVolume`, `buildBody(…, holderInput)`.
- Local data (outside the repo): `$VOXELBENCH_LOCAL_DIR/holder/` with `s6_32s/` and `s6_high/` (TIFF stacks or
  symlinks), `s6_b4_part.npy`, `s4/` (the VOX scan folder), `s4_b4_part.npy`, and `expected.json`
  `{ s6: { envelope_cm3, body_threshold, plates_mm: [] }, s4: { envelope_cm3, body_threshold } }`. The S4 mask is made
  once by running `sample_pipeline.py` step 1 and saving `part4` (a scratch script, never in the repo).

- [ ] **Step 1: Write the failing CI test** `npy reader reads shape and bytes` — then implement `tools/npy.js` and
  see it pass.
- [ ] **Step 2: Write the gate tests**, each skipped unless its files exist:
  - `Sample 6 (32 s) matches the Nov 5 part mask`: read the stack binned ×2 while reading (to 0.08 mm), run
    `buildBody` at `BIN = 2` (0.16 mm grid) with `body_threshold`; found `method === 'shape'`; three plate pieces with
    thicknesses within 0.3 mm of `plates_mm`; envelope within 2 % of `envelope_cm3`; Dice ≥ 0.97 against
    `s6_b4_part.npy` over the overlapping grid; holder finding took ≤ 15 s (time `findHolder` alone).
  - `Sample 6 high-res agrees with the 32 s scan`: envelope within 2 % of the 32 s result (R1).
  - `Sample 4 matches the Nov 5 part mask`: `method === 'bright'`; envelope within 2 %; Dice ≥ 0.97 against
    `s4_b4_part.npy`.
- [ ] **Step 3: Run** `npm run test:local` without `VOXELBENCH_LOCAL_DIR` — all skipped; with it set — record the
  output. If a gate fails, debug against the Nov 5 figures before loosening anything; never tune to the scan.
- [ ] **Step 4: Run** `npm test` — whole suite green, hygiene included.
- [ ] **Step 5: Commit** `test(local): holder removal gate on Samples 6 and 4`.

---

## Done when
`npm test` is green; the local gate passes on Samples 6 and 4 within 15 s of holder finding; the browser checks in
Tasks 6-8 are done with screenshots read; nothing is pushed until Matt reviews.
