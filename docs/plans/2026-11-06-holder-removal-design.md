# Holder removal (2026-11-06)

## Why
A part is scanned sitting on something: flat on the top of a round post and taped down (Samples 1, 2, 4), or leaning
in an angled SLA-printed holder (Sample 6). In every case the holder and the tape or bag end up stuck to the part in the
sample mask (Matt, 11-06). Everything downstream then counts them: envelope volume, porosity, mass, wall thickness,
leveling (the principal axes include the holder). The Nov 5 Python analysis removed holders with two scan-specific
scripts (`sample_pipeline.py` step 1 for the 80 kV post, `s6_partmask.py` for the Sample 6 plates), full of numbers set
by hand for one scan (gray 1100 and 2400, "below slice 265", "extend upright plates 40 voxels"). This brings that into
VoxelBench as one method that works on any scan, with no hand-set numbers.

## What the holders look like (from the Nov 5 overview figures)
- **Post** (S1, S2, S4): an upright round post on the turntable axis; the part sits flat on its top face. S4 shows a
  stepped post, a ~25 mm cap on a ~10 mm stem. At 80 kV the printed resin reads clearly brighter than the part (the
  Nov 5 pipeline cut it at gray 2400; the part peaks near 2100). In S1 and S2 only the post's top is in view.
- **Plates** (S6): flat printed plates 2.8-3.3 mm thick (a straight bar, a tilted cradle plate, a base slab), plus two
  thin strips. At 120 kV they read like the part, so only their shape gives them away.
- **Tape / bag**: a shell about one voxel thick wrapping over the part, part-gray, touching it in places.

What they share: simple shapes (flat plates, round posts) with straight walls and even gray, running off the edge of
the scan, touching the part across a flat face. The part is lumpy and porous.

## Decisions (Matt's, polls 11-06; 9-10 after the builder check)
1. **Shapes: plates and round posts.** Each holder piece is fitted as a slab or a cylinder; every solid voxel inside
   the fitted shape is holder. Fitting gives a clean cut where holder meets part.
2. **Evidence chosen per scan.** If the scan holds a clean bright population above the part (resin at 80 kV), the
   bright body seeds the holder. Otherwise the pieces are found by shape. The review says which was used.
3. **Tape and bag are stripped as holder:** shells about 2 voxels thick or thinner, leaving the part.
4. **Auto, then review.** VoxelBench finds the holder itself and shows it as a colored overlay; the user accepts it or
   clicks a piece to give it back to the part.
5. **Corrections toggle whole pieces** (each fitted plate, post or tape strip is one piece). No brush.
6. **Runs every time the sample mask is built,** so pores, mass, wall thickness and leveling all see the part alone.
7. **The accepted holder is saved with the sample** (with the orientation and marks): reopening reuses it and keeps
   the user's toggles.
8. **Acceptance: Sample 6 high-res and Sample 4** reproduce the Nov 5 numbers (below).
9. **Up to ~15 s extra per mask build on Sample 6 high-res, with a progress bar** showing the wait (stage name and
   share done, e.g. "Finding the holder: slices 120 / 348"). The local gate times it and fails above 15 s.
10. **Scans already leveled are re-leveled automatically.** Their saved orientation was found with the holder in the
    mask. On the next open, the axes are recomputed from the holder-free mask and the new orientation replaces the old
    one. Slider nudges are lost; a one-time note says so and names the old and new angles.

## Method (my calls unless marked)
Runs inside `buildBody` (`app/ct_pores.js`), on the smoothed binned volume, after `solid` is thresholded and before
the opening / largest component / closing / hole filling. New module `app/vb_holder.js`, loaded by the worker.

1. **Seeds.**
   - *Brightness:* look for a population brighter than the part in the solid's gray histogram (a separate peak or
     shoulder above the part's main peak, measured per scan). If its largest connected body is big enough to be a
     holder (not a few bright inclusions: agglomerates are small and scattered), it is the seed. Decision 2.
   - *Shape:* otherwise, scan slices in all three directions (the Nov 5 script used z only, which suits one scan's
     geometry). A 2-D component that is bar-like (long and thin, roughly uniform width) or a disk that repeats with the
     same radius over many consecutive slices is a seed voxel set. Group seeds into 3-D clusters; drop small ones.
2. **Fit each cluster** (shared by both seed paths):
   - *Slab:* normal = least-variance PCA axis (as `s6_partmask.py`); thickness and in-plane bounds from robust
     percentiles of the cluster's coordinates, plus one voxel on thickness.
   - *Cylinder:* axis = greatest-variance PCA axis; radius from the median distance to the axis. Any axis direction,
     not only z, so a leveled scan (where the post is tilted) works too. A stepped post is two cylinders.
   - Keep a fit only when the cluster fills the fitted shape well and its gray inside is even (spread below the
     part's). Otherwise it is not a holder piece.
3. **Extend each fit along its long directions** while the solid keeps filling the shape's cross-section, so the plate
   or post is taken right up to and under the part. This replaces the hand-set "+40 voxels": the extension stays
   within the piece's own thickness or radius, so it can only take voxels that lie inside the plate or post itself.
4. **Holder = solid voxels inside any accepted fit**, dilated by one voxel at the contact (as both scripts).
5. **Tape and bag:** after the holder is out, solid pieces whose local thickness is at most ~2 voxels everywhere and
   that reach away from the part are tape pieces. They come out **before** closing and hole filling, so closing can
   never bridge the tape to the part and count the air gap between them as part.
6. **Then the existing steps:** opening, largest component, closing, hole filling, minus the holder.

Each piece records: kind (plate, post, tape), which seed path found it, its fitted parameters (center, axes,
thickness or radius, extents), its voxel count and volume.

## Review (what the user sees)
- The slice views draw holder pieces in a color of their own, distinct from pores and every other class (the "show
  every class in overlays" rule from the port brief). Hovering a piece names it; clicking it toggles it between
  holder and part, and the mask rebuilds.
- The rail lists the pieces: kind, size (thickness or radius, extents), volume, and how the holder was found
  ("bright resin" or "shape").
- Status is honest about what was checked: "no holder found", "3 holder pieces, not reviewed", "3 holder pieces,
  reviewed (1 given back)". "No holder found" and "removal failed" never read as a clean result.
- A warning when removal takes more than a set share of the solid, or leaves a largest body much smaller than before.

## Saving
- Saved with the sample once the user accepts or toggles: the fitted pieces (kind, parameters) and which are given
  back, in native scan voxels like the orientation (`vb_orient.js` `toNative`). Pieces, not voxel masks: small, and they
  rebuild the mask exactly.
- The worker's mask cache key (`ensureBody`) includes the saved holder, so a changed toggle rebuilds and an unchanged
  one does not; reopening the same scan in a session reuses everything (the 35438d4 behavior).
- An unreviewed proposal is not saved; it is found again on the next build.

## Acceptance (Matt's decision 8)
Run in the **local gate** (`VOXELBENCH_LOCAL_DIR`), never CI: the scans and the Nov 5 reference numbers stay outside
the repo (no lab data in VoxelBench code). Compared on the 0.16 mm grid the Nov 5 scripts used.
- **Sample 6 high-res:** found by shape (no bright population at 120 kV). Five pieces as `out/s6_partmask.json`: three
  plates 3.21, 3.32, 2.79 mm thick, two thin strips. Part envelope 13.336 cm3 within 2 %; part mask Dice >= 0.97
  against `out/s6_b4_part.npy`.
- **Sample 4:** found by bright resin. Part envelope 20.9 cm3 (pipeline log, 0.16 mm grid) within 2 %. The Nov 5 part
  mask was not saved; the gate rebuilds it by running `sample_pipeline.py` step 1 once and saving it outside the repo.
- Tolerances (2 %, Dice 0.97) are my call.

Unit tests (CI) use synthetic scans (`VBSynthetic.makeScan`), with no lab numbers:
- a porous blob on a stepped post, post brighter than the blob: found by brightness, post removed, blob kept;
- the same at equal gray: found by shape;
- a blob leaning in two tilted plates and a base slab: plates removed, blob volume within a voxel shell;
- a one-voxel shell wrapped over the blob: stripped, and the envelope does not grow by the air under it;
- **a flat-faced cube part on a post: the cube survives** (see Risks);
- no holder at all: "no holder found", mask unchanged;
- toggling a piece back restores its voxels to the part.

## Non-goals
- Shapes other than plates and posts (a brush or free-form holder can come later).
- Using the holder's resin as a known-density reference (port item 1, next design doc).
- Removing a holder that does not touch the part (it is already left out as a separate body).

## Anti-goals
- Eating part of the part: a flat face of a printed cube must never be fitted as a plate. The guards are that a
  holder piece must reach toward the scan edge or be the bright population, must fill its fitted shape, and must have
  even gray; the part is compact and porous. The review is the backstop.
- Any constant tuned to one scan in the code.

## Risks
- A smooth, dense, flat-faced part with no pores could pass the even-gray test. The cube test above and the review
  cover it; if it bites on real data, a holder piece could additionally be required to run off the scan edge.
- Slab fits on a part leaning flat on a plate: the contact is a whole face, so a one-voxel dilation at the contact
  may shave a thin layer of the part. The S6 Dice target measures that.
- Memory and time: per-slice component tests in three directions over the binned volume. Expected seconds, not
  minutes, but not yet measured in the browser.

## Settled after the builder check (my calls)
- **Frame.** Removal runs on whatever frame the scan is built in. On a first open that is the scan frame, so leveling
  (which reads the sample mask) already sees the part without the holder. On a leveled scan the saved pieces are
  mapped through the saved orientation into the leveled grid; that is why cylinders and slabs take any axis.
- **Units.** Pieces are stored in native scan voxels (centers with `toNative`'s `f` and `(f-1)/2` rule; lengths times
  `f`), so the same pieces rebuild the mask at any binning. Two binnings agree to within one binned voxel at the
  piece surfaces.
- **Crops.** Detection and fitting ignore the user's crops and use the reconstruction edge as "the scan edge", so the
  pieces do not depend on a crop; the crop is applied afterwards, as today. A crop can still cut a holder piece off.
- **Other `buildBody` callers.** The sheet's threshold sweep (`variantSummary`) and every other caller apply the
  current pieces; they do not re-detect per threshold. When the pieces or their toggles change, everything derived
  from the body is rebuilt: `body`, `poreCoarse`, `coarse`, `voidShare`, `zoneReady`, `patchLabels`, `solidGray`,
  `airGray` and the pores.
- **Settings in the gate.** Acceptance runs at the default settings with the scan's own body threshold. The result
  depends on the threshold as every sample mask does.
- **Sample 4 reference.** `sample_pipeline.py` and `out/s4_cube_b4.npy` are on disk; the gate saves its step-1 part mask
  once outside the repo and checks Dice >= 0.97 as for Sample 6.
- **Synthetic scans.** `VBSynthetic.makeScan` gains options for a stepped post, tilted plates and a thin shell.
- **Empty mask.** When the solid is empty, the existing "no part found" path applies; holder status reads "not run".

## Left to the builder
The exact seed tests and their limits (bar shape, disk repeat length, minimum cluster size, fill and gray-spread
limits), each derived from the scan (voxel size, part gray, noise) and pinned by the synthetic tests; where the piece
list sits in the rail; the overlay color.

## Amendment 2026-11-07: fit the holder's STL first (Matt, poll)
Matt has STL files for both holders (the angled SLA holder and the post). When a holder STL is chosen, it is the
primary method; shape detection (above) is the fallback when none is chosen; tape is always stripped.
- **Holder library.** Holder STLs live in the user's VoxelBench library folder (`holders/`), never in the repo. The
  scan's Holder section offers "Detect automatically" or one of the library's holders; the choice is saved with the
  sample, so scans on the same holder pick it once.
- **Fit.** The STL (mm) is aligned to the scan's solid surface with the existing rigid alignment (`vb_align.js`:
  pre-alignment, then trimmed ICP so the part touching the holder is treated as outliers). The start pose comes from
  the detected pieces when shape or brightness detection finds any (align the STL to those points first), else from
  the pre-alignment's scored starting poses. No scaling.
- **Removal.** Every solid voxel inside the aligned, closed STL is holder (voxelized by ray parity per grid column),
  with the same one-voxel contact rule as fitted pieces. The STL holder is one piece of kind `'stl'`, toggled like any
  other piece; its saved form is the holder's library name, a content hash of the STL, and the pose in native scan
  voxels, so reopening rebuilds it without refitting. A missing or changed STL falls back to detection and says so.
- **Fit quality is reported:** the trimmed RMS distance (mm) and the share of STL surface points within one voxel of
  the scan surface. Below a set share, the status reads "holder STL did not fit" and detection runs instead.
- **Acceptance adds:** Samples 6 and 4 with their STLs reach the same Nov 5 targets (envelope within 2 %, Dice ≥ 0.97).

## Amendment 2026-11-07 (b): several STLs per holder (Matt, poll)
Holders are often assemblies of printed parts (a base and an angled top; the older stand: stick, platform and block).
A scan may choose several holder STLs; each is fitted separately (the other parts are outliers to its trimmed ICP) and
becomes its own `'stl'` piece, toggled like any other. The sample saves `holder.stls = [{ name, hash }, …]` (an older
single `holder.stl` reads as a list of one). The status gives one line per STL (fitted with RMS, did not fit, not
loaded, changed). Samples 1, 2 and 4 sat on the scanner's own stick, which has no STL; they rely on detection.
