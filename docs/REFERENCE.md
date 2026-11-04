# Independent reference

The design asks that VoxelBench's numbers agree with an independent Python reference on the same inputs. The
reference, `tools/reference/vb_reference.py`, re-derives each quantity from its stated definition with numpy and
scipy (`ndimage.label`, `gaussian_filter`, `binary_closing`, `distance_transform_edt`, `map_coordinates`). It does
not port the JavaScript.

## Run it

```bash
pip install -r tools/reference/requirements.txt
npm run reference
```

`npm run reference` writes the synthetic test scans as TIFF folders, with their known truth and VoxelBench's
results (`tools/reference/export_cases.js`, the same pipeline the page runs), into `.reference/`. It then runs the
Python reference on them and prints truth, VoxelBench and reference side by side. The exit code is 0 only when
every check is inside its tolerance.

For a real scan:

```bash
node tools/reference/export_cases.js <out-dir> <scan-folder>
python tools/reference/vb_reference.py <out-dir>
```

On a real scan only VoxelBench and the reference are compared, since there is no truth. A scan of about 1 GB
needs about 7 GB of memory in Python.

## What is checked

| Quantity | Reference method | Tolerance |
|---|---|---|
| Porosity | Smoothed full-resolution gray below the pore threshold inside the margin-eroded sample mask, 26-connected components of at least the minimum volume | VoxelBench vs reference < 5 % relative (10 % on a real scan); reference vs truth < 10 % |
| Open / closed porosity | 6-connected low binned gray joined to voxels next to the outside of the mask | < 0.2 percentage points (0.5 on a real scan) |
| Sample mask | Smoothed binned gray above the body threshold, closed by a ball, holes filled | < 5 % (real scan) |
| Filler | Robust detection threshold, halfway measurement threshold from the median peak, 26-connected labels, covariance per particle | Count within 10 %, volume within 15 %, fibers within 2, direction within 5° |
| Wall thickness | 2 × the largest distance-transform value − ½ voxel (the synthetic cylinder's diameter) | Within 2 analysis voxels |
| CAD deviation at the true pose | Trilinear sampling along the nominal normals, nearest fall through the level into air joined to the outside | Median within 0.01 mm; > 90 % of shared points within 0.02 mm |

The CAD check reuses VoxelBench's iso level and measurement points; the sampling, the air mask and the crossing
search are the reference's own.

## Results (synthetic, 2026-11-03)

| Quantity | Truth | VoxelBench | Reference |
|---|---|---|---|
| Porosity | 2.755 % | 2.614 % | 2.613 % |
| Open porosity | 0 % | 0 % | 0 % |
| Filler particles | 70 | 70 | 70 |
| Filler volume | 0.656 % | 0.583 % | 0.590 % |
| Fibers | 20 | 20 | 20 (directions 0.04° apart) |
| Cylinder wall | 3.84 mm | 3.68 mm | 3.68 mm |
| CAD median deviation | | 0.0092 mm | 0.0092 mm (all shared points within 0.02 mm) |

Both sides read the porosity, the filler volume and the wall about 4 to 11 % low against truth. The smoothing
shrinks small features and the sample mask edge sits inside the true surface, so this is the definition's bias,
not a disagreement between the two.
