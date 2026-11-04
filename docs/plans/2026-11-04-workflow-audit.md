# Workflow audit: every step in every look (2026-11-04)

Why: a user outlined a density phantom and saw no result afterwards, and could not tell what a reference region is
or how to make one. This audit walks each rail step in Lab, Mac and Glass on the synthetic scans (1440 × 900 and
phone width) and records where the next action or the result is not obvious.

Method: the built-in browser, the synthetic scan with phantom rods, every step run in order; a script lists, per
step, the disabled buttons and the visible status text, and every element with the `hidden` attribute that still
shows.

## Findings

| # | Severity | Where | Finding | Fix |
|---|---|---|---|---|
| F1 | P0 | the bare page | `.row`, `.draftpanel` and `.setting` set `display`, which beat the `hidden` attribute: the drawing panel (feature types, slice range, Save, Discard, Done drawing), the batch row, the min-ESD slider, the pore filter and the zone threshold showed when they should not, even before a scan was open. The Pages build hid them through its own wrapper; any host without that reset did not. | The rule now lives in the page: `[hidden] { display: none !important; }`. |
| F2 | P0 | step 5 | After saving a phantom, "Outline … then Save" stays on screen. | Leave drawing before the save is recorded, so the note clears. |
| F3 | P0 | status bar | The voxel readout says "uncalibrated" after a calibration and never shows density. | Show the equivalent density at the voxel when calibrated. |
| F4 | P0 | step 5 | A calibration shows only its line and point table. The results land elsewhere (step 2's "Matrix eq. density", only after pores; step 3's table columns), and step 5 does not say so. | A "Results for this scan" block in step 5: matrix density, bulk density, Archimedes beside it when entered, and where else the densities appear; it says what to run first when a number is missing. |
| F5 | P0 | test scan with phantom rods | The two rods are not named on the page, so the densities to type are a guess; outlining the 0.50 rod as 1.40 gives a wrong line and no warning. | Name the rods, their place and density in step 5 when the test scan is open. |
| F6 | P1 | step 3 | "Relative density from a reference region" sits in a closed sub-panel; it never says a region must be drawn first, what a reference is, or how it differs from a phantom calibration. The region table shows "n/a" in two columns with no reason. | Say what a reference region is and the steps; the n/a columns say "pick a reference below". |
| F7 | P1 | step 3, drawing | The region hint is "Drag on the main view to draw a polygon, then save": no label choice, no slice range, no word on the result. | Region-specific hint naming the label, the slices and the table the result lands in. |
| F8 | P1 | step bar, all looks | Icons only, names on hover; no sign of which steps have run. | Short name under each icon; a dot per step, green once it has a result (read from the step's status tag). |
| F9 | P1 | all steps | No next step after a step finishes. | A Next line at the end of each finished step, with buttons that open the usual next steps (phantom calibration marked "only if phantoms are in the scan"). |
| F10 | P1 | Mac, Glass | The 380 px rail makes the 10-column region table scroll sideways, hiding the density columns. | A grip on the rail's left edge in every look: drag to widen (320 px to 60 % of the window), double-click to reset; kept per viewer. The two relative-density columns now appear only once a reference is picked. |
| F11 | P1 | all looks | The Layers legend takes 40 to 50 % of the rail height when expanded, squeezing the step. | Starts collapsed (one row of swatches); the viewer's last choice is kept. |
| F12 | P2 | step 3 | Zones refuse on the synthetic scans ("Outline regions by hand instead") without naming the Draw region button. | Name the button. |

Not a page bug: the local test server served HTML without a charset, which garbled "g/cm³"; the Pages build and the
artifact both declare UTF-8.

F8 to F11 were chosen by poll on 2026-11-04 (all four recommended options).

## Verified

- Unit tests for the new logic: the readout text, the results rows, step done, next steps and the rail width clamp (written first, seen failing).
- Browser, synthetic phantom scan, Lab, Mac and Glass at 1440 × 900 and 375 × 812 (the static build): no `hidden` element shows; the step names fit their buttons; no sideways page scroll; the rail drag widens and resets in each look.
- Phantom flow: Rod A 0.50 and Rod B 1.40 plus air give a 3-point line, R² 1.0000; step 5 shows the solid matrix at 1.007 g/cm³ (synthetic truth 1.008) and bulk 0.983 g/cm³ at 2.45 % pores; the status bar reads "≈ 0.987 g/cm³ eq." at the cursor.
- Reference flow: one drawn region picked as reference at 1.01 g/cm³ gives relative 0.999 and 1.009 g/cm³ in the region table.

## Follow-up: result cards (2026-11-04, after "we need a lot more feedback")

Drawing gave no visible result: the toolbar Outline recorded only an area in the step 4 list, and Draw region put a
row in the step 3 table, often off-screen. Now every saved mark, and any saved mark clicked on the image in Move
mode, opens a card over the main view (`app/vb_feedback.js` for the numbers and insights, unit-tested; `app/vb_cardrail.js`
for the page):

- region: volume, gray, porosity, pores inside, solid gray, equivalent density; porosity and solid gray compared
  with the whole part; what to run when a number is missing; a warning under 1,000 voxels;
- outline: its area and voxel count, and the same numbers on its one slice, with a pointer to Draw region for 3-D;
- point: gray, equivalent density and the pore it sits in;
- measurement: length, and with a nominal the band, the deviation and pass or fail.

The card follows the numbers when pores, the calibration or the record change, and closes when its mark is deleted.
Verified in the browser in all three looks and at phone width (the card docks at the bottom).

## Follow-up: insights in the review sheet (2026-11-04)

The PDF had the numbers but none of the reads, and nothing from steps 6 to 8. Poll picks: a Findings page right after
page 1; with the density calibration, the Dragonfly comparison and the saved regions.

- `app/vb_findings.js` (unit-tested): the step insights (now also the source for the rail's "What this shows"
  boxes, so the two cannot drift), the sections in step order, the steps not run, the text layout (an item never
  splits across pages; a heading never ends a page) and the page numbers after it.
- Region cards name their to-do hints apart (`todo`), so the sheet leaves out "outline phantoms" and "segment pores".
- `app/ct_sheetfindings.js` draws it; the captions that pointed to "page 2" now name the slice page.
- Verified on Sample 2 (pores, a region, walls, the Dragonfly stand-in): Findings on page 2 of 4, page 1 points to
  the slices on page 3, the rainbow page is 5 of 5 and points to page 3; rail and sheet show the same 8 pore and 3 wall
  reads. The calibration section is covered by unit tests only (no phantoms on Sample 2).
