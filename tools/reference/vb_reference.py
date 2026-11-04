"""Independent reference for VoxelBench's numbers (scipy), on the same TIFF stacks.

It re-derives each quantity from its stated definition with scipy and numpy, not by porting the JavaScript, and
compares three ways where truth is known: truth, VoxelBench (case.json, written by export_cases.js) and this reference.

Usage:
    python tools/reference/vb_reference.py <cases-dir>            # the synthetic cases from export_cases.js
    python tools/reference/vb_reference.py <dir-with-real.json>    # a real scan: VoxelBench vs reference only

Exit code 0 when every check is inside its tolerance, 1 otherwise.
"""
from __future__ import annotations

import json
import logging
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import tifffile
from scipy import ndimage as ndi

logger = logging.getLogger("vb_reference")

BIN = 2
DEFAULTS = {"sigma": 1.0, "bodyThreshold": 1400, "closeRadius": 8, "margin": 2, "poreThreshold": 1300,
            "fineSigma": 1.0, "minVolumeMm3": 0.0005}
CONN26 = np.ones((3, 3, 3), dtype=bool)


@dataclass(frozen=True)
class Check:
    name: str
    truth: Optional[float]
    js: Optional[float]
    ref: Optional[float]
    ok: bool
    rule: str


def read_scan(folder: Path) -> tuple[np.ndarray, float]:
    """The stack (z, y, x) as uint16 and the voxel size in mm from the TIFF resolution tags (pixels per cm)."""
    names = sorted(p for p in folder.iterdir() if p.suffix.lower() in (".tif", ".tiff"))
    with tifffile.TiffFile(names[0]) as t:
        num, den = t.pages[0].tags["XResolution"].value
    voxel_mm = 10.0 / (num / den)
    stack = np.stack([tifffile.imread(n) for n in names]).astype(np.uint16)
    return stack, voxel_mm


def block_mean(vol: np.ndarray, b: int = BIN) -> np.ndarray:
    nz, ny, nx = (s // b for s in vol.shape)
    v = vol[: nz * b, : ny * b, : nx * b].astype(np.float32)
    return v.reshape(nz, b, ny, b, nx, b).mean(axis=(1, 3, 5))


def ball(r: int) -> np.ndarray:
    z, y, x = np.ogrid[-r:r + 1, -r:r + 1, -r:r + 1]
    return x * x + y * y + z * z <= r * r


def sample_mask(binned: np.ndarray, fov: np.ndarray, s: dict) -> np.ndarray:
    """Solid where the smoothed binned gray exceeds the body threshold inside the FOV, closed by a ball of the closing
    radius (padded by edge values, so the stack ends do not erode it) and with interior holes filled."""
    solid = (ndi.gaussian_filter(binned, s["sigma"]) > s["bodyThreshold"]) & fov
    r = int(s["closeRadius"])
    if r > 0:
        padded = np.pad(solid, r, mode="edge")
        solid = ndi.binary_closing(padded, structure=ball(r))[r:-r, r:-r, r:-r]
    return ndi.binary_fill_holes(solid)


def robust_threshold(values: np.ndarray, k: float = 4.0) -> tuple[float, float, float]:
    """Median and 1.4826 x MAD of the matrix gray, re-estimated after clipping values above median + k SD."""
    v = np.sort(values.astype(np.float64))
    for _ in range(4):
        med = float(np.median(v))
        sd = max(1.0, 1.4826 * float(np.median(np.abs(v - med))))
        kept = v[v <= med + k * sd]
        if kept.size == v.size or kept.size == 0:
            break
        v = kept
    return med, sd, med + k * sd


def analyze(stack: np.ndarray, voxel_mm: float, settings: dict, cad: Optional[dict] = None, with_filler: bool = True) -> dict:
    """Porosity, open/closed, wall and (optionally) filler and CAD deviation. Large intermediates are freed as soon as
    used; a 1.1 GB scan peaks at about 7 GB (the stack, its smoothed float copy and one label volume)."""
    s = {**DEFAULTS, **settings}
    fov3 = stack.max(axis=0) > 0  # the reconstruction reads 0 outside its field of view
    binned = block_mean(stack)
    fov_b = block_mean(np.broadcast_to(fov3, stack.shape).astype(np.float32)) > 0.999
    mask = sample_mask(binned, fov_b, s)
    full_mask = np.repeat(np.repeat(np.repeat(mask, BIN, 0), BIN, 1), BIN, 2)
    smooth = ndi.gaussian_filter(stack[: full_mask.shape[0], : full_mask.shape[1], : full_mask.shape[2]].astype(np.float32), s["fineSigma"])
    v3 = voxel_mm ** 3
    mask_mm3 = float(full_mask.sum()) * v3

    # Pores: smoothed full-resolution gray below the pore threshold, inside the mask eroded by the margin.
    inner = ndi.binary_erosion(mask, structure=np.ones((3, 3, 3)), iterations=int(s["margin"]), border_value=1)
    inner_full = np.repeat(np.repeat(np.repeat(inner, BIN, 0), BIN, 1), BIN, 2)
    low = (smooth < s["poreThreshold"]) & inner_full
    del inner_full
    labels, n = ndi.label(low, structure=CONN26)
    del low
    sizes = np.bincount(labels.ravel())
    keep = sizes * v3 >= s["minVolumeMm3"]
    keep[0] = False
    pore_vox = float(sizes[keep].sum())

    # Open: a pore reached by low binned gray joined (6-connected) to voxels next to the outside of the mask.
    low_b = mask & (binned < s["poreThreshold"])
    seeds = low_b & ndi.binary_dilation(~mask)
    comp, _ = ndi.label(low_b)
    reached_ids = np.unique(comp[seeds])
    reached = np.isin(comp, reached_ids[reached_ids > 0])
    reached_full = np.repeat(np.repeat(np.repeat(reached, BIN, 0), BIN, 1), BIN, 2)
    open_ids = np.unique(labels[reached_full & (labels > 0)])
    del reached_full, labels
    is_open = np.zeros(n + 1, dtype=bool)
    is_open[open_ids] = True
    open_vox = float(sizes[keep & is_open].sum())
    out = {"porosity_percent": 100 * pore_vox / full_mask.sum(), "mask_mm3": mask_mm3,
           "open_percent": 100 * open_vox / full_mask.sum(), "closed_percent": 100 * (pore_vox - open_vox) / full_mask.sum()}

    # Wall: twice the largest inscribed distance (a single convex body: its thickness at the thickest place).
    edt = ndi.distance_transform_edt(np.pad(mask, ((1, 1), (1, 1), (1, 1)), mode="constant"))[1:-1, 1:-1, 1:-1]
    out["wall_max_mm"] = float(2 * edt.max() - 0.5) * BIN * voxel_mm

    out["filler"] = filler(smooth, full_mask, s) if with_filler else None
    if cad is not None:
        out["cad"] = deviations(binned, mask, voxel_mm, cad)
    return out


def filler(smooth: np.ndarray, full_mask: np.ndarray, s: dict) -> Optional[dict]:
    vals = smooth[full_mask & (smooth >= s["poreThreshold"])]
    if vals.size == 0:
        return None
    med, sd, detect = robust_threshold(vals[:: max(1, vals.size // 2_000_000)])
    lab, n = ndi.label((smooth >= detect) & full_mask, structure=CONN26)
    if n == 0:
        return {"count": 0, "volume_percent": 0.0}
    peaks = ndi.maximum(smooth, lab, index=np.arange(1, n + 1))
    measure = max(detect, (med + float(np.median(peaks))) / 2)
    lab, n = ndi.label((smooth >= measure) & full_mask, structure=CONN26)
    idx = np.arange(1, n + 1)
    counts = ndi.sum(np.ones_like(lab, dtype=np.float64), lab, idx)
    big = counts >= 8
    zz, yy, xx = np.nonzero(lab)
    ids = lab[zz, yy, xx]
    fibers, weights = [], []
    for i in idx[big]:
        sel = ids == i
        pts = np.stack([xx[sel], yy[sel], zz[sel]], axis=1).astype(np.float64)
        cov = np.cov(pts, rowvar=False, bias=True) + np.eye(3) / 12
        w, v = np.linalg.eigh(cov)  # ascending
        if np.sqrt(w[2] / w[1]) >= 3 and np.sqrt(12 * w[2]) >= 3:
            fibers.append(v[:, 2]); weights.append(sel.sum())
    out = {"count": int(big.sum()), "volume_percent": 100 * float(counts[big].sum()) / float(full_mask.sum()), "fibers": len(fibers), "threshold": measure}
    if len(fibers) >= 5:
        f, wt = np.array(fibers), np.array(weights, dtype=np.float64)
        a2 = (f.T * wt) @ f / wt.sum()
        ev, evec = np.linalg.eigh(a2)
        out["orientation"] = {"eigenvalues": ev[::-1].tolist(), "direction": evec[:, 2].tolist()}
    return out


def deviations(binned: np.ndarray, mask: np.ndarray, voxel_mm: float, cad: dict) -> np.ndarray:
    """Signed distance along each nominal normal to the nearest fall of the binned gray through the level into air
    joined to the volume faces or the outside of the mask; NaN where there is none within ±1 mm."""
    level = cad["level"]
    air_lab, _ = ndi.label(binned < level)
    edge_ids = np.unique(np.concatenate([air_lab[[0, -1]].ravel(), air_lab[:, [0, -1]].ravel(), air_lab[:, :, [0, -1]].ravel(), air_lab[~mask].ravel()]))
    air = np.isin(air_lab, edge_ids[edge_ids > 0])
    pose = cad["pose"]
    R, t, s = np.array(pose["R"]).reshape(3, 3), np.array(pose["t"]), pose["s"]
    p = np.array(cad["points"]).reshape(-1, 3) @ R.T * s + t
    nrm = np.array(cad["normals"]).reshape(-1, 3) @ R.T
    step = 0.25 * BIN * voxel_mm
    steps = np.arange(-int(round(1 / step)), int(round(1 / step)) + 1) * step
    xyz = p[:, None, :] + steps[None, :, None] * nrm[:, None, :]  # (n, k, 3) scan mm, x y z
    idx = (xyz / voxel_mm - (BIN - 1) / 2) / BIN  # binned index
    coords = [idx[..., 2].ravel(), idx[..., 1].ravel(), idx[..., 0].ravel()]
    g = ndi.map_coordinates(binned, coords, order=1, mode="constant", cval=np.nan).reshape(idx.shape[:2])
    inside = np.all((idx >= 0) & (idx <= np.array(binned.shape[::-1]) - 1), axis=2)
    g[~inside] = np.nan
    a = ndi.map_coordinates(air.astype(np.float32), coords, order=1, mode="constant", cval=0).reshape(idx.shape[:2]) > 0
    out = np.full(len(p), np.nan)
    edge = np.array(cad["edge"], dtype=bool)
    for i in range(len(p)):
        if edge[i]:
            continue
        gi = g[i]
        fall = np.nonzero((gi[:-1] >= level) & (gi[1:] < level) & a[i, 1:])[0]
        if fall.size:
            frac = (gi[fall] - level) / (gi[fall] - gi[fall + 1])
            s_cross = steps[fall] + frac * step
            out[i] = s_cross[np.argmin(np.abs(s_cross))]
    return out


def rel(a: Optional[float], b: Optional[float]) -> float:
    return abs(a - b) / max(abs(b), 1e-12) if a is not None and b is not None else float("inf")


def checks_synthetic(case: dict, ref: dict) -> list[Check]:
    tr, js, out = case["truth"], case["js"], []
    add = lambda name, t, j, r, ok, rule: out.append(Check(name, t, j, r, bool(ok), rule))
    if case["name"] == "filled":
        t = tr["porosity_percent"]
        add("porosity %", t, js["porosity_percent"], ref["porosity_percent"],
            rel(js["porosity_percent"], ref["porosity_percent"]) < 0.05 and rel(ref["porosity_percent"], t) < 0.10, "JS vs ref < 5 %, ref vs truth < 10 %")
        add("open %", 0.0, js["open_percent"], ref["open_percent"], abs(js["open_percent"] - ref["open_percent"]) < 0.2, "|JS - ref| < 0.2 points")
        add("closed %", None, js["closed_percent"], ref["closed_percent"], abs(js["closed_percent"] - ref["closed_percent"]) < 0.2, "|JS - ref| < 0.2 points")
        jf, rf = js["filler"], ref["filler"]
        add("filler count", tr["filler"]["spheres"] + tr["filler"]["fibers"], jf["count"], rf["count"], abs(jf["count"] - rf["count"]) <= 0.1 * rf["count"], "JS vs ref within 10 %")
        add("filler volume %", tr["filler"]["volume_percent"], jf["volume_percent"], rf["volume_percent"], rel(jf["volume_percent"], rf["volume_percent"]) < 0.15, "JS vs ref < 15 %")
        add("fibers", tr["filler"]["fibers"], jf["fibers"], rf["fibers"], abs(jf["fibers"] - rf["fibers"]) <= 2, "|JS - ref| <= 2")
        if jf.get("orientation") and rf.get("orientation"):
            cosang = abs(float(np.dot(jf["orientation"]["direction"], rf["orientation"]["direction"])))
            add("fiber direction (deg)", 0.0, None, float(np.degrees(np.arccos(min(1.0, cosang)))), cosang > np.cos(np.radians(5)), "JS vs ref < 5 deg")
        add("wall: cylinder diameter mm", 3.84, js["wall"]["max_mm"], ref["wall_max_mm"], abs(js["wall"]["max_mm"] - ref["wall_max_mm"]) <= 2 * BIN * js["voxel_mm"], "|JS - ref| <= 2 analysis voxels")
    if case["name"] == "part":
        jd = np.array([np.nan if v is None else v for v in js["cad"]["deviations"]])
        rd = ref["cad"]
        both = np.isfinite(jd) & np.isfinite(rd)
        agree = float(np.mean(np.abs(jd[both] - rd[both]) < 0.02)) if both.any() else 0.0
        add("CAD points measured (both)", None, float(np.isfinite(jd).sum()), float(np.isfinite(rd).sum()), both.sum() > 0.8 * np.isfinite(rd).sum(), "> 80 % of the reference's points measured by both")
        add("CAD median deviation mm", None, float(np.median(jd[both])), float(np.median(rd[both])), abs(np.median(jd[both]) - np.median(rd[both])) < 0.01, "|JS - ref| < 0.01 mm")
        add("CAD points agreeing within 0.02 mm", None, None, agree, agree > 0.9, "> 90 % of shared points")
    return out


def checks_real(js: dict, ref: dict) -> list[Check]:
    out = []
    out.append(Check("porosity %", None, js["porosity_percent"], ref["porosity_percent"], rel(js["porosity_percent"], ref["porosity_percent"]) < 0.10, "JS vs ref < 10 %"))
    out.append(Check("open %", None, js["open_percent"], ref["open_percent"], abs(js["open_percent"] - ref["open_percent"]) < 0.5, "|JS - ref| < 0.5 points"))
    out.append(Check("closed %", None, js["closed_percent"], ref["closed_percent"], abs(js["closed_percent"] - ref["closed_percent"]) < 0.5, "|JS - ref| < 0.5 points"))
    out.append(Check("sample mask mm³", None, js["mask_mm3"], ref["mask_mm3"], rel(js["mask_mm3"], ref["mask_mm3"]) < 0.05, "JS vs ref < 5 %"))
    return out


def report(title: str, checks: list[Check]) -> bool:
    fmt = lambda v: "n/a" if v is None else f"{v:.4g}"
    logger.info("%s", title)
    for c in checks:
        logger.info("  %-36s truth %-9s JS %-9s ref %-9s %s  (%s)", c.name, fmt(c.truth), fmt(c.js), fmt(c.ref), "ok  " if c.ok else "FAIL", c.rule)
    return all(c.ok for c in checks)


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    root = Path(argv[1])
    ok = True
    if (root / "real.json").exists():
        real = json.loads((root / "real.json").read_text())
        stack, vmm = read_scan(Path(real["folder"]))
        ref = analyze(stack, vmm, real["js"]["settings"], with_filler=False)
        ok = report(f"Real scan {real['folder']}", checks_real(real["js"], ref))
    else:
        for case_dir in sorted(p for p in root.iterdir() if (p / "case.json").exists()):
            case = json.loads((case_dir / "case.json").read_text())
            stack, vmm = read_scan(case_dir / "scan")
            ref = analyze(stack, vmm, case["js"]["settings"], case["js"].get("cad"))
            ok = report(f"Case {case['name']}", checks_synthetic(case, ref)) and ok
    logger.info("%s", "ALL CHECKS PASS" if ok else "SOME CHECKS FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
