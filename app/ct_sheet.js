/* The review sheet as a three-page PDF built in the page: overview, section slices, supporting data. Layout and wording
   follow ct_pipeline/sample_sheet.py, which Claude uses for the vector version. Pages are drawn at 250 dpi. */
(function (App) {
  'use strict';
  const CT = window.CT, P = window.CTPores, D = window.CTSheetData, G = window.CTPlot, D3 = window.CTDisplay;
  const { state } = App;
  const DPI = 250, PAGE = [8.5, 11], MARGIN = 0.5, CONTENT_W = PAGE[0] - 2 * MARGIN, HEAD = '#1f2933';
  const GRAY_WINDOW = [800, 2900];
  const CLASS_RGB = { 1: [255, 158, 26], 2: [230, 26, 26], 3: [140, 77, 242], 4: [0, 204, 179], 5: [255, 138, 216], 6: [110, 140, 255] };
  // Rainbow page: outline colors match the app's rainbow view; widths in slice pixels so they survive the page scale
  // (zones are large and low-contrast on turbo, so their outlines are wider).
  const RAINBOW_RGB = { 1: [255, 255, 255], 2: [255, 64, 255], 3: [200, 170, 255], 4: [0, 0, 0], 5: [255, 138, 216], 6: [110, 140, 255] };
  const OUTLINE = { seg: 3, zones: 6 };
  const PLANE_COLOR = { XY: '#f28e00', XZ: '#1f77d4' };

  function newPage() {
    const c = document.createElement('canvas');
    c.width = PAGE[0] * DPI; c.height = PAGE[1] * DPI;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.scale(DPI, DPI);
    return { canvas: c, ctx };
  }

  const heading = (ctx, x, y, s) => G.text(ctx, x, y + 0.13, s, { size: 10.5, color: HEAD });

  function caption(ctx, x, y, s, w = CONTENT_W, size = 7.5) {
    const words = s.split(' ');
    let line = '', row = 0;
    const lh = (size * 1.35) / 72;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (G.width(ctx, next, size, 'normal') > w && line) { G.text(ctx, x, y + size / 72 + row * lh, line, { size, weight: 'normal' }); row++; line = word; } else line = next;
    }
    if (line) G.text(ctx, x, y + size / 72 + row * lh, line, { size, weight: 'normal' });
    return y + (row + 1) * lh;
  }

  function table(ctx, x, y, w, header, rows, widths, { size = 8, rowH = 0.24, bold = [] } = {}) {
    ctx.save();
    ctx.lineWidth = 0.6 / 72; ctx.strokeStyle = '#000';
    const cols = widths.map((f) => f * w);
    [header, ...rows].forEach((r, k) => {
      let cx = x;
      const cy = y + k * rowH;
      r.forEach((cell, j) => {
        if (k === 0) { ctx.fillStyle = HEAD; ctx.fillRect(cx, cy, cols[j], rowH); }
        ctx.strokeRect(cx, cy, cols[j], rowH);
        G.text(ctx, k === 0 ? cx + cols[j] / 2 : cx + 0.05, cy + rowH / 2, String(cell), { size, weight: k === 0 || bold.includes(k - 1) ? 'bold' : 'normal', color: k === 0 ? '#fff' : '#000', align: k === 0 ? 'center' : 'left', base: 'middle' });
        cx += cols[j];
      });
    });
    ctx.restore();
    return y + (rows.length + 1) * rowH;
  }

  function header(ctx, sample, page) {
    const pages = sample.pages || 3;
    G.text(ctx, MARGIN, 0.6, sample.title, { size: page === 1 ? 17 : 13, color: HEAD });
    if (page === 1) {
      G.text(ctx, MARGIN, 0.92, sample.subtitle, { size: 9, weight: 'normal' });
      G.text(ctx, MARGIN, 1.12, sample.scanLine, { size: 8, weight: 'normal', color: '#555' });
    }
    G.text(ctx, PAGE[0] - MARGIN, 10.7, `Page ${page} of ${pages}`, { size: 7.5, weight: 'normal', color: '#555', align: 'right' });
  }

  // Cut white margins off a render, as the Python sheet does.
  function trimmed(src) {
    const d = src.getContext('2d').getImageData(0, 0, src.width, src.height).data;
    let x0 = src.width, x1 = 0, y0 = src.height, y1 = 0;
    for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    const pad = 12;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(src.width - 1, x1 + pad); y1 = Math.min(src.height - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(src, -x0, -y0);
    return out;
  }

  // Draw an image inside a box keeping its aspect ratio, centered or against the left edge; framed.
  function placeImage(ctx, img, box, { frame = '#000', frameW = 0.8, align = 'center' } = {}) {
    const s = Math.min(box.w / img.width, box.h / img.height);
    const w = img.width * s, h = img.height * s;
    ctx.drawImage(img, align === 'left' ? box.x + 0.06 : box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
    ctx.save(); ctx.strokeStyle = frame; ctx.lineWidth = frameW / 72; ctx.strokeRect(box.x, box.y, box.w, box.h); ctx.restore();
  }

  const letter = (ctx, x, y, l) => {
    ctx.save(); ctx.fillStyle = '#fff'; ctx.fillRect(x + 0.03, y + 0.03, 0.26, 0.17); ctx.restore();
    G.text(ctx, x + 0.06, y + 0.17, `(${l})`, { size: 9 });
  };

  // A full-resolution slice with segmentation (mode 'seg') or zones (mode 'zones'). Gray view: classes painted over
  // gray. Rainbow view: turbo over the display-smoothed slice, classes as outlines in RAINBOW_RGB.
  function sliceImage(plane, slice, mode, rainbow = false) {
    const shape = CT.planeShape(plane, state.dims), n = shape.width * shape.height;
    const gray = CT.extractPlane(state.slices, state.dims, plane, slice);
    const ids = mode === 'seg' ? P.planePoreIds(state.runs, state.dims, plane, slice, new Uint32Array(n)) : null;
    const kind = new Uint8Array(state.pores.length + 2);
    for (const p of state.pores) kind[p.id] = state.rejected.has(p.id) ? 0 : p.clipped ? 3 : p.crack_like ? 2 : 1;
    const coarse = (values, grid, o) => {
      const f = grid.factor, { nx, ny, nz } = grid.dims;
      const x = Math.floor(o.x / f), y = Math.floor(o.y / f), z = Math.floor(o.z / f);
      return x < nx && y < ny && z < nz ? values[(z * ny + y) * nx + x] : 0;
    };
    // Class per pixel, and a label that separates neighboring objects of one class for outlining.
    const cls = new Uint8Array(n), label = new Uint32Array(n);
    for (let row = 0, at = 0; row < shape.height; row++) {
      for (let col = 0; col < shape.width; col++, at++) {
        const o = () => CT.voxelOf(plane, slice, col, row);
        if (mode === 'seg') {
          if (ids[at] && kind[ids[at]]) { cls[at] = kind[ids[at]]; label[at] = ids[at]; } else if (state.patchLabels) {
            const pl = coarse(state.patchLabels, state.patchGrid, o());
            if (pl) { cls[at] = 4; label[at] = state.pores.length + 2 + pl; }
          }
        } else if (state.zones && state.zones.map) {
          const z = coarse(state.zones.map, state.zones, o());
          if (z === 2 || z === 3) { cls[at] = z + 3; label[at] = z; }
        }
      }
    }
    const img = new ImageData(shape.width, shape.height);
    let edge = cls;
    if (rainbow) {
      D3.rainbowToRgba(D3.smoothPlane(gray, shape.width, shape.height), state.window.low, state.window.high, img.data);
      edge = D3.outlineMask(label, shape.width, shape.height, OUTLINE[mode]);
    }
    const a = mode === 'seg' ? 0.85 : 0.35;
    for (let at = 0, j = 0; at < n; at++, j += 4) {
      const k = cls[at];
      if (rainbow) {
        if (k && edge[at]) img.data.set(RAINBOW_RGB[k], j);
      } else {
        const g = 255 * Math.max(0, Math.min(1, (gray[at] - GRAY_WINDOW[0]) / (GRAY_WINDOW[1] - GRAY_WINDOW[0])));
        img.data.set(k ? CLASS_RGB[k].map((c) => (1 - a) * g + a * c) : [g, g, g], j);
      }
      img.data[j + 3] = 255;
    }
    const c = document.createElement('canvas');
    c.width = shape.width; c.height = shape.height;
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }

  function projectionImage(sheet) {
    const { nx, ny } = sheet.coarseDims;
    const c = document.createElement('canvas');
    c.width = nx; c.height = ny;
    const img = new ImageData(nx, ny);
    for (let i = 0; i < nx * ny; i++) {
      const v = sheet.projection[i];
      const rgb = Number.isNaN(v) ? [255, 255, 255] : D.magmaR(v / 25);
      img.data.set([...rgb, 255], i * 4);
    }
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }

  App.CTSheet = { newPage, heading, caption, table, header, trimmed, placeImage, letter, sliceImage, projectionImage, RAINBOW_RGB, PAGE, MARGIN, CONTENT_W, DPI, PLANE_COLOR, CLASS_RGB, HEAD };
}(window.CTApp));
