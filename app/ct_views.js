/* The three slice planes: drawing, overlays, pointer input, shared scale, keyboard. */
(function (App) {
  'use strict';
  const CT = window.CT, P = window.CTPores, R = window.CTRegions, D = window.CTDisplay;
  const { state, $, on, emit } = App;
  const PLANES = ['XY', 'XZ', 'YZ'];
  const TITLE = { XY: 'XY', XZ: 'XZ', YZ: 'YZ' };
  const AXIS = { XY: 'z', XZ: 'y', YZ: 'x' };
  const DRAG_PIXELS = 4, CLOSE_PIXELS = 8, FREEHAND_TOLERANCE = 2, DEFAULT_HALF_RANGE = 25;
  const COLOR = { cross: 'rgba(255,196,84,.6)', edge: '#3fe0ff', text: '#d7dde5', outside: 'rgba(12,18,38,1)' };
  const PORE_RGB = { pore: [255, 180, 84], crack: [255, 95, 86], clipped: [180, 140, 255], rejected: [120, 130, 140], selected: [255, 255, 255], patch: [53, 208, 192] };
  const ZONE_TINT = 0.35; // zones stay fainter than voids, so voids read on top of them
  // Rainbow view: outline colors that turbo does not use (white, magenta, lavender, black).
  const RAINBOW_RGB = { pore: [255, 255, 255], crack: [255, 64, 255], clipped: [200, 170, 255], rejected: [140, 140, 140], selected: [255, 255, 255], patch: [0, 0, 0] };
  const MAX_OUTLINE = 4;
  const views = {};
  const cropRasters = new Map();
  let activePlane = 'XY';

  function buildPlane(plane) {
    const pane = $(`pane${plane}`);
    const head = document.createElement('div');
    head.className = 'panehead';
    const title = document.createElement('b');
    title.textContent = TITLE[plane];
    const pos = document.createElement('span');
    pos.className = 'mono';
    head.append(title, pos);
    const box = document.createElement('div');
    box.className = 'canvasbox';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', `${plane} slice of the scan`);
    box.append(canvas);
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = 0; slider.id = `slice${plane}`; slider.className = plane === 'XY' ? 'slicebar vertical' : 'slicebar';
    slider.setAttribute('aria-label', plane === 'XY' ? 'XY slice: top of the slider is the top of the part' : `${plane} position`);
    if (plane === 'XY') slider.title = 'Top is the top of the part; bottom is the holder';
    slider.addEventListener('input', () => { activePlane = plane; moveSlice(plane, Number(slider.value)); });
    if (plane === 'XY') pane.append(head, slider, box);
    else pane.append(head, box, slider);
    const v = { plane, pane, canvas, box, pos, slider, image: document.createElement('canvas'), overlay: document.createElement('canvas'), offsetX: 0, offsetY: 0, cssW: 0, cssH: 0, dirty: true, overlayDirty: true, drag: null, scale: 1 };
    views[plane] = v;
    attachPointer(v);
  }

  const viewOf = (v) => ({ scale: v.scale, offsetX: v.offsetX, offsetY: v.offsetY });
  const toX = (v, col) => v.offsetX + col * v.scale;
  const toY = (v, row) => v.offsetY + row * v.scale;
  const isMain = (v) => state.main === v.plane;
  const mainView = () => views[state.main] || null;
  const currentSlice = (plane) => CT.planeOf(plane, state.cursor).slice;

  function markOverlays() { for (const p of PLANES) views[p].overlayDirty = true; }

  // ---------- scale ----------
  function fitView(v) {
    const { width, height } = CT.planeShape(v.plane, state.dims);
    v.scale = CT.fitView(width, height, v.cssW, v.cssH).scale;
    v.offsetX = (v.cssW - width * v.scale) / 2;
    v.offsetY = (v.cssH - height * v.scale) / 2;
  }

  function fitAll() {
    state.fit = true;
    for (const p of PLANES) if (views[p].cssW) fitView(views[p]);
    renderScale(); drawAll();
  }

  const fitScaleOf = (v) => {
    const { width, height } = CT.planeShape(v.plane, state.dims);
    return CT.fitView(width, height, v.cssW, v.cssH).scale;
  };

  // Only the main view zooms; the thumbnails always show their whole slice. The point under the pointer stays fixed.
  function setScale(next, px, py) {
    const v = mainView();
    if (!v) return;
    const scale = CT.clampScale(next, fitScaleOf(v));
    const z = CT.zoomAt(viewOf(v), px, py, scale / v.scale);
    v.offsetX = z.offsetX; v.offsetY = z.offsetY; v.scale = scale;
    state.fit = false;
    renderScale(); requestDraw();
  }

  function zoomCentered(factor) {
    const v = mainView();
    if (!v) return;
    const { col, row } = CT.planeOf(v.plane, state.cursor);
    setScale(v.scale * factor, toX(v, col + 0.5), toY(v, row + 0.5));
  }

  function renderScale() {
    const v = mainView();
    if (!v || !v.cssW) { $('widthMm').value = ''; $('scaleNote').textContent = ''; return; }
    const width = CT.widthMmAtScale(v.scale, state.voxelMm, v.cssW);
    if (document.activeElement !== $('widthMm')) $('widthMm').value = width.toFixed(1);
    $('scaleNote').textContent = `${((state.voxelMm * 1000) / v.scale).toFixed(0)} µm per screen pixel`;
  }

  // ---------- drawing ----------
  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; drawAll(); });
  }

  function drawAll() {
    if (state.folder) for (const p of PLANES) drawPlane(views[p]);
    emit('cursorMoved');
  }

  function statusBytes() {
    const out = new Uint8Array(state.pores ? state.pores.length + 1 : 1);
    if (!state.pores) return out;
    for (const p of state.pores) {
      let k = 0;
      if (state.rejected.has(p.id)) k = 4;
      else if (p.clipped) k = state.show.clipped ? 3 : 0;
      else if (p.crack_like) k = state.show.cracks ? 2 : 0;
      else k = state.show.pores ? 1 : 0;
      if (p.id === state.selected) k = 5;
      out[p.id] = k;
    }
    return out;
  }

  // Value of a coarse-grid volume under a full-resolution voxel.
  function coarseAt(values, grid, o) {
    const { nx, ny, nz } = grid.dims;
    const f = grid.factor;
    const x = Math.floor(o.x / f), y = Math.floor(o.y / f), z = Math.floor(o.z / f);
    return x < nx && y < ny && z < nz ? values[(z * ny + y) * nx + x] : 0;
  }

  // Overlay pixels for one slice. outline = 0 paints filled classes over gray; outline = n draws n-pixel outlines
  // (rainbow view), so the color map under a pore stays visible. A selected pore stays filled.
  function overlayImage(plane, slice, shape, outline) {
    const n = shape.width * shape.height;
    const rgba = new ImageData(shape.width, shape.height);
    const px = rgba.data;
    const keep = state.show.crop ? P.planeCropKeep(App.cropsOf(state.folder), plane, slice, state.dims, cropRasters) : null;
    const zones = state.show.zones && state.zones && state.zones.map ? state.zones : null;
    const patches = state.show.patches && state.patchLabels ? state.patchLabels : null;
    const ids = state.runs ? P.planePoreIds(state.runs, state.dims, plane, slice, new Uint32Array(n)) : null;
    const kinds = statusBytes();
    const palette = outline ? RAINBOW_RGB : PORE_RGB;
    const rgbOf = [null, palette.pore, palette.crack, palette.clipped, palette.rejected, palette.selected];
    const fill = Math.round(255 * state.fill);
    const paint = (j, c, a) => { px[j] = c[0]; px[j + 1] = c[1]; px[j + 2] = c[2]; px[j + 3] = a; };
    const lookup = zones || patches;
    const zoneOf = new Uint8Array(zones ? n : 0), patchOf = new Uint32Array(patches ? n : 0), poreOf = new Uint32Array(ids ? n : 0);
    for (let row = 0, at = 0; row < shape.height; row++) {
      for (let col = 0; col < shape.width; col++, at++) {
        if (lookup) {
          const o = CT.voxelOf(plane, slice, col, row);
          if (zones) { const z = coarseAt(zones.map, zones, o); if (App.zoneColor(z)) zoneOf[at] = z; }
          if (patches) patchOf[at] = coarseAt(patches, state.patchGrid, o);
        }
        if (ids && ids[at] && kinds[ids[at]]) poreOf[at] = ids[at];
      }
    }
    const edge = (labels) => (outline && labels.length ? D.outlineMask(labels, shape.width, shape.height, outline) : labels);
    // Zones are large and low-contrast on turbo, so their outlines are twice as wide.
    const zoneEdge = outline && zoneOf.length ? D.outlineMask(zoneOf, shape.width, shape.height, 2 * outline) : zoneOf;
    const patchEdge = edge(patchOf), poreEdge = edge(poreOf);
    for (let at = 0, j = 0; at < n; at++, j += 4) {
      if (keep && !keep[at]) { paint(j, [8, 10, 14], 200); continue; }
      if (zones && zoneEdge[at]) paint(j, App.zoneColor(zoneOf[at]), outline ? 255 : Math.round(fill * ZONE_TINT));
      if (patches && patchEdge[at]) paint(j, palette.patch, outline ? 255 : fill);
      const kind = ids && poreOf[at] ? kinds[poreOf[at]] : 0;
      if (kind && (poreEdge[at] || kind === 5)) paint(j, rgbOf[kind], kind === 5 ? 235 : outline ? 255 : fill);
    }
    return rgba;
  }

  // The slice itself: gray, or turbo over the smoothed slice with air black.
  function sliceRgba(plane, slice, shape, view) {
    return grayRgba(CT.extractPlane(state.slices, state.dims, plane, slice), shape.width, shape.height, view);
  }

  function grayRgba(gray, width, height, view) {
    const rgba = new ImageData(width, height);
    if (view === 'rainbow') D.rainbowToRgba(D.smoothPlane(gray, width, height), state.window.low, state.window.high, rgba.data);
    else CT.grayToRgba(gray, state.window.low, state.window.high, rgba.data);
    return rgba;
  }

  // A binned scan's zoomed XY main view shows the middle native file of the slice under the binned overlay,
  // once that file has been read; XZ and YZ always stay binned.
  function nativeFor(v, slice) {
    const f = state.binFactor;
    if (f < 2 || v.plane !== 'XY' || !isMain(v) || v.scale <= 1) return null;
    const i = slice * f + (f >> 1);
    if (state.native && state.native.index === i) return state.native;
    if (v.pending !== i) {
      v.pending = i;
      App.readNative(i).then(() => { v.dirty = true; requestDraw(); }).catch((e) => emit('statusText', `Could not read the full-resolution slice: ${e.message}`));
    }
    return null;
  }

  // Outlines must survive the downscale to the pane, so they are as wide as one screen pixel in slice pixels.
  const outlineWidth = (v) => (state.view === 'rainbow' ? Math.min(MAX_OUTLINE, Math.max(1, Math.ceil(1 / v.scale))) : 0);

  function buildOverlay(v, shape, slice) {
    v.outline = outlineWidth(v);
    v.overlay.width = shape.width; v.overlay.height = shape.height;
    v.overlay.getContext('2d').putImageData(overlayImage(v.plane, slice, shape, v.outline), 0, 0);
  }

  function drawPlane(v) {
    if (!v.cssW) return;
    const { plane, canvas, image } = v;
    const shape = CT.planeShape(plane, state.dims);
    const slice = currentSlice(plane);
    const native = nativeFor(v, slice);
    if (v.dirty || v.shownSlice !== slice || v.shownNative !== native) {
      image.width = native ? native.width : shape.width; image.height = native ? native.height : shape.height;
      image.getContext('2d').putImageData(native ? grayRgba(native.pixels, native.width, native.height, state.view) : sliceRgba(plane, slice, shape, state.view), 0, 0);
      v.dirty = false;
      v.shownNative = native;
    }
    if (v.overlayDirty || v.shownSlice !== slice || v.outline !== outlineWidth(v)) { buildOverlay(v, shape, slice); v.overlayDirty = false; }
    v.shownSlice = slice;
    const ctx = canvas.getContext('2d');
    const dpr = canvas.width / v.cssW;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.cssW, v.cssH);
    ctx.imageSmoothingEnabled = v.scale < 1;
    ctx.imageSmoothingQuality = 'high';
    const w = shape.width * v.scale, h = shape.height * v.scale;
    ctx.drawImage(image, v.offsetX, v.offsetY, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(v.overlay, v.offsetX, v.offsetY, w, h);
    drawOutside(ctx, v, shape, slice);
    drawCrosshair(ctx, v);
    drawRecords(ctx, v, slice);
    if (state.draft && state.draft.plane === plane && state.draft.slice === slice) drawDraft(ctx, v);
    drawScaleBar(ctx, v);
    if (state.view === 'rainbow' && isMain(v)) drawColorBar(ctx, v.cssW - 14, v.cssH - 12, 150);
    const f = state.binFactor, file = (k) => String(k + 1).padStart(3, '0');
    const files = f > 1 ? `files ${file(slice * f)}–${file(slice * f + f - 1)}` : `file ${file(slice)}`;
    const binned = f > 1 ? ` · binned ${f}×${native ? ', native slice shown' : ''}` : '';
    v.pos.textContent = `${AXIS[plane]} ${slice}/${shape.depth - 1} · ${(slice * state.voxelMm).toFixed(2)} mm${plane === 'XY' ? ` · ${files}` : ''}${binned}`;
    v.slider.max = shape.depth - 1;
    v.slider.value = slice;
  }

  // Outside the reconstruction comes from the fitted circle: exact 0 also occurs inside dark pores.
  function drawOutside(ctx, v, shape, slice) {
    if (!state.circle) return;
    const { circle } = state;
    const x0 = toX(v, 0), y0 = toY(v, 0), w = shape.width * v.scale, h = shape.height * v.scale;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    ctx.fillStyle = COLOR.outside;
    ctx.strokeStyle = COLOR.edge; ctx.lineWidth = 1;
    if (v.plane === 'XY') {
      ctx.beginPath(); ctx.rect(x0, y0, w, h);
      ctx.arc(toX(v, circle.cx), toY(v, circle.cy), circle.r * v.scale, 0, 2 * Math.PI, true);
      ctx.fill('evenodd');
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.arc(toX(v, circle.cx), toY(v, circle.cy), circle.r * v.scale, 0, 2 * Math.PI); ctx.stroke();
    } else {
      const ends = CT.chordAt(circle, slice + 0.5, v.plane === 'XZ' ? 'y' : 'x');
      if (!ends) ctx.fillRect(x0, y0, w, h);
      else {
        ctx.fillRect(x0, y0, Math.max(0, toX(v, ends[0]) - x0), h);
        const right = toX(v, ends[1]);
        ctx.fillRect(right, y0, Math.max(0, x0 + w - right), h);
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        for (const c of ends) { ctx.moveTo(toX(v, c), y0); ctx.lineTo(toX(v, c), y0 + h); }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawCrosshair(ctx, v) {
    const { col, row } = CT.planeOf(v.plane, state.cursor);
    const x = toX(v, col + 0.5), y = toY(v, row + 0.5);
    ctx.save();
    ctx.strokeStyle = COLOR.cross; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, y - 8); ctx.moveTo(x, y + 8); ctx.lineTo(x, v.cssH);
    ctx.moveTo(0, y); ctx.lineTo(x - 8, y); ctx.moveTo(x + 8, y); ctx.lineTo(v.cssW, y);
    ctx.stroke();
    ctx.restore();
  }

  function drawShape(ctx, v, kind, points, color, closed) {
    const px = points.map((p) => [toX(v, p.col + 0.5), toY(v, p.row + 0.5)]);
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0,0,0,.95)'; ctx.shadowBlur = 3;
    if (kind === 'point') {
      ctx.beginPath(); ctx.arc(px[0][0], px[0][1], 6, 0, 2 * Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.arc(px[0][0], px[0][1], 1.5, 0, 2 * Math.PI); ctx.fill();
    } else {
      ctx.beginPath();
      px.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (closed) { ctx.closePath(); ctx.globalAlpha = 0.14; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.stroke();
      if (points.length < 40) for (const [x, y] of px) { ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 2 * Math.PI); ctx.fill(); }
    }
    ctx.restore();
    return px;
  }

  function drawLabel(ctx, text, x, y, color) {
    ctx.save();
    ctx.font = '11px "Space Mono", monospace'; ctx.fillStyle = color;
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
    ctx.fillText(text, x + 6, y - 6);
    ctx.restore();
  }

  function drawRecords(ctx, v, slice) {
    for (const a of state.show.notes ? App.annotationsOf(state.folder) : []) {
      if (a.plane !== v.plane || a.slice !== slice) continue;
      const color = CT.FEATURE_TYPES.find((t) => t.id === a.type).color;
      const points = a.voxels.map((p) => CT.planeOf(a.plane, p));
      const px = drawShape(ctx, v, a.kind, points, color, a.kind === 'polygon');
      if (a.kind === 'caliper') drawLabel(ctx, `${a.length_mm.toFixed(2)} mm`, px[0][0], px[0][1], color);
      if (a.kind === 'polygon') drawLabel(ctx, `${a.area_mm2.toFixed(2)} mm²`, px[0][0], px[0][1], color);
    }
    if (!state.show.regions) return;
    for (const r of App.regionsOf(state.folder)) {
      if (r.plane !== v.plane || (r.label !== 'crop' && (slice < r.slice_from || slice > r.slice_to))) continue;
      const def = R.labelOf(r.label, App.regionLabels());
      const px = drawShape(ctx, v, 'polygon', r.points, def.color, r.label !== 'crop');
      drawLabel(ctx, def.label, px[0][0], px[0][1], def.color);
    }
  }

  function drawDraft(ctx, v) {
    const d = state.draft;
    const color = d.kind === 'region' ? R.labelOf(state.regionLabel, App.regionLabels()).color : CT.FEATURE_TYPES.find((t) => t.id === state.type).color;
    drawShape(ctx, v, d.kind === 'region' ? 'polygon' : d.kind, d.points, color, d.closed);
  }

  // k scales the bar and its text (1 on screen; larger for saved full-resolution images).
  function drawScaleBar(ctx, v, k = 1) {
    const mm = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20].find((m) => (m / state.voxelMm) * v.scale >= 60 * k) || 20;
    const w = (mm / state.voxelMm) * v.scale;
    ctx.save();
    ctx.fillStyle = 'rgba(5,7,12,.72)';
    ctx.fillRect(4 * k, v.cssH - 32 * k, Math.max(w, 44 * k) + 12 * k, 28 * k);
    ctx.fillStyle = COLOR.text; ctx.font = `${11 * k}px "Space Mono", monospace`;
    ctx.fillRect(10 * k, v.cssH - 12 * k, w, 2 * k);
    ctx.fillText(`${mm} mm`, 10 * k, v.cssH - 17 * k);
    ctx.restore();
  }

  // Turbo scale with the window ends, right-aligned at (right, bottom) in CSS pixels; also used for saved PNGs.
  function drawColorBar(ctx, right, bottom, width, size = 11) {
    const h = Math.round(size * 0.9), x = right - width, y = bottom - h;
    ctx.save();
    ctx.fillStyle = 'rgba(5,7,12,.72)';
    ctx.fillRect(x - 8, y - size * 2.6, width + 16, h + size * 2.6 + 6);
    for (let i = 0; i < width; i++) { const [r, g, b] = D.turbo(i / (width - 1)); ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x + i, y, 1.5, h); }
    ctx.fillStyle = COLOR.text; ctx.font = `${size}px "Space Mono", monospace`;
    ctx.textAlign = 'left'; ctx.fillText(String(state.window.low), x, y - size * 0.35);
    ctx.textAlign = 'right'; ctx.fillText(String(state.window.high), x + width, y - size * 0.35);
    ctx.textAlign = 'center'; ctx.fillText('gray, uncalibrated', x + width / 2, y - size * 1.5);
    ctx.restore();
  }

  // The main slice as shown, at full resolution: slice, overlay (2-pixel outlines in rainbow), outside of the
  // reconstruction, drawn records, scale bar, color bar and a caption line. No crosshair.
  function slicePng() {
    const plane = state.main, slice = currentSlice(plane), shape = CT.planeShape(plane, state.dims);
    // Caption, scale bar and color bar sit in a footer under the slice so they cover none of it.
    const k = Math.max(1, shape.width / 1000), foot = Math.round(64 * k);
    const c = document.createElement('canvas');
    c.width = shape.width; c.height = shape.height + foot;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, c.width, c.height);
    const flat = { plane, scale: 1, offsetX: 0, offsetY: 0, cssW: shape.width, cssH: shape.height };
    const draw = (rgba) => { const t = document.createElement('canvas'); t.width = shape.width; t.height = shape.height; t.getContext('2d').putImageData(rgba, 0, 0); ctx.drawImage(t, 0, 0); };
    draw(sliceRgba(plane, slice, shape, state.view));
    draw(overlayImage(plane, slice, shape, state.view === 'rainbow' ? 2 : 0));
    drawOutside(ctx, flat, shape, slice);
    drawRecords(ctx, flat, slice);
    drawScaleBar(ctx, { ...flat, cssH: c.height }, k);
    if (state.view === 'rainbow') drawColorBar(ctx, shape.width - 14 * k, c.height - 8 * k, 150 * k, 11 * k);
    const view = state.view === 'rainbow' ? `turbo, smoothed σ = ${D.SMOOTH_SIGMA} voxel for display` : 'grayscale';
    const text = `${state.folder} · ${plane} ${AXIS[plane]} = ${slice} (${(slice * state.voxelMm).toFixed(2)} mm) · ${CT.gridText(state.binFactor)} · ${view} · window ${state.window.low} to ${state.window.high}, uncalibrated`;
    ctx.save();
    let size = 11 * k;
    ctx.font = `${size}px "Space Mono", monospace`;
    while (ctx.measureText(text).width > shape.width - 20 * k && size > 6) { size -= 0.5; ctx.font = `${size}px "Space Mono", monospace`; }
    ctx.fillStyle = COLOR.text; ctx.fillText(text, 10 * k, shape.height + 16 * k);
    ctx.restore();
    return new Promise((resolve) => c.toBlob((blob) => resolve({ blob, filename: `${state.folder}_${plane}_${AXIS[plane]}${slice}_${state.view}.png` }), 'image/png'));
  }

  App.slicePng = slicePng;
  App.sliceLayers = { sliceRgba, overlayImage };

  // ---------- pointer ----------
  function moveSlice(plane, slice) {
    const { col, row } = CT.planeOf(plane, state.cursor);
    const depth = CT.planeShape(plane, state.dims).depth;
    state.cursor = CT.voxelOf(plane, Math.min(depth - 1, Math.max(0, slice)), col, row);
    requestDraw();
  }

  function eventPlace(v, e) {
    const rect = v.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const { width, height } = CT.planeShape(v.plane, state.dims);
    return { px, py, hit: CT.canvasToPlane(viewOf(v), px, py, width, height) };
  }

  function showReadout(v, hit) {
    if (!hit) { $('readout').textContent = 'Off the image.'; return; }
    const p = CT.voxelOf(v.plane, currentSlice(v.plane), hit.col, hit.row);
    const gray = state.slices[p.z][p.y * state.dims.nx + p.x];
    const mm = (n) => (n * state.voxelMm).toFixed(2);
    const outside = !CT.insideCircle(state.circle, p.x, p.y);
    const id = state.runs ? P.poreIdAt(state.runs, state.dims, p.x, p.y, p.z) : 0;
    const pore = id ? state.byId.get(id) : null;
    const patch = state.patchLabels ? coarseAt(state.patchLabels, state.patchGrid, p) : 0;
    const poreText = pore ? ` | ${pore.clipped ? 'cut by scan edge' : pore.crack_like ? 'crack' : 'pore'} ${id}, ${pore.diameter_mm.toFixed(3)} mm` : patch ? ` | low-density patch ${patch}` : '';
    $('readout').textContent = `x ${p.x} y ${p.y} z ${p.z} | ${mm(p.x)}, ${mm(p.y)}, ${mm(p.z)} mm | gray ${gray}${outside ? ' outside reconstruction' : ' uncalibrated'}${poreText}`;
  }

  function clickAt(v, place) {
    if (!place.hit) return;
    const slice = currentSlice(v.plane);
    if (state.tool === 'navigate') {
      state.cursor = CT.voxelOf(v.plane, slice, place.hit.col, place.hit.row);
      requestDraw();
      return;
    }
    if (state.tool === 'review') {
      if (!state.runs) return;
      const p = CT.voxelOf(v.plane, slice, place.hit.col, place.hit.row);
      const id = P.poreIdAt(state.runs, state.dims, p.x, p.y, p.z);
      if (id) { App.toggleReject(id); state.selected = id; markOverlays(); emit('poresChanged'); }
      return;
    }
    if (state.tool === 'freehand') return;
    if (state.draft && (state.draft.plane !== v.plane || state.draft.slice !== slice || state.draft.complete)) state.draft = null;
    if (!state.draft) state.draft = { plane: v.plane, slice, kind: state.tool, points: [], complete: false, closed: false };
    const d = state.draft;
    if (d.kind === 'polygon' && d.points.length >= 3) {
      const first = d.points[0];
      if (Math.hypot(toX(v, first.col + 0.5) - place.px, toY(v, first.row + 0.5) - place.py) <= CLOSE_PIXELS) { closePolygon(); return; }
    }
    d.points.push(place.hit);
    if (d.kind === 'point' || (d.kind === 'caliper' && d.points.length === 2)) d.complete = true;
    emit('draftChanged');
    requestDraw();
  }

  function closePolygon() {
    if (state.draft && state.draft.kind === 'polygon' && state.draft.points.length >= 3) {
      state.draft.complete = true; state.draft.closed = true;
      emit('draftChanged'); requestDraw();
    }
  }

  function attachPointer(v) {
    const c = v.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!state.folder) return;
      activePlane = v.plane;
      if (!isMain(v)) { v.thumbPress = true; return; }
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic pointer has nothing to capture */ }
      if (state.tool === 'freehand') {
        const { hit } = eventPlace(v, e);
        if (!hit) return;
        const slice = currentSlice(v.plane);
        const depth = CT.planeShape(v.plane, state.dims).depth;
        state.draft = { plane: v.plane, slice, kind: 'region', points: [hit], complete: false, closed: false, drawing: true, sliceFrom: Math.max(0, slice - DEFAULT_HALF_RANGE), sliceTo: Math.min(depth - 1, slice + DEFAULT_HALF_RANGE) };
        emit('draftChanged');
        return;
      }
      v.drag = { x: e.clientX, y: e.clientY, moved: false, startX: v.offsetX, startY: v.offsetY };
    });
    c.addEventListener('pointermove', (e) => {
      if (!state.folder) return;
      const place = eventPlace(v, e);
      if (state.draft && state.draft.drawing && state.draft.plane === v.plane) {
        if (place.hit) { state.draft.points.push(place.hit); requestDraw(); }
      } else if (v.drag) {
        const dx = e.clientX - v.drag.x, dy = e.clientY - v.drag.y;
        if (Math.hypot(dx, dy) > DRAG_PIXELS) v.drag.moved = true;
        if (v.drag.moved) {
          v.offsetX = v.drag.startX + dx; v.offsetY = v.drag.startY + dy;
          state.fit = false;
          v.pane.classList.add('dragging');
          requestDraw();
        }
      }
      activePlane = v.plane;
      showReadout(v, place.hit);
    });
    c.addEventListener('pointerup', (e) => {
      if (!state.folder) return;
      if (v.thumbPress) { v.thumbPress = false; App.setMain(v.plane); return; }
      if (state.draft && state.draft.drawing) {
        const d = state.draft;
        d.drawing = false;
        d.points = R.simplifyFreehand(d.points, FREEHAND_TOLERANCE);
        if (d.points.length < 3) state.draft = null;
        else { d.complete = true; d.closed = true; }
        emit('draftChanged'); requestDraw();
        return;
      }
      if (!v.drag) return;
      const moved = v.drag.moved;
      v.drag = null;
      v.pane.classList.remove('dragging');
      if (!moved) clickAt(v, eventPlace(v, e));
    });
    c.addEventListener('pointercancel', () => { v.drag = null; v.pane.classList.remove('dragging'); });
    c.addEventListener('dblclick', () => { if (state.folder && state.tool === 'navigate') fitAll(); });
    c.addEventListener('wheel', (e) => {
      if (!state.folder) return;
      e.preventDefault();
      activePlane = v.plane;
      if (e.ctrlKey || e.metaKey) {
        if (!isMain(v)) return;
        const { px, py } = eventPlace(v, e);
        setScale(v.scale * Math.exp(-e.deltaY * 0.01), px, py);
      } else {
        moveSlice(v.plane, currentSlice(v.plane) + (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
      }
    }, { passive: false });
  }

  function layout() {
    if (!state.dims) return;
    for (const p of PLANES) {
      const v = views[p];
      const { width, height } = v.box.getBoundingClientRect();
      if (!width || !height) continue;
      const dpr = window.devicePixelRatio || 1;
      v.cssW = width; v.cssH = height;
      v.canvas.width = Math.round(width * dpr); v.canvas.height = Math.round(height * dpr);
      if (!isMain(v) || state.fit !== false) fitView(v);
    }
    renderScale(); drawAll();
  }

  function jumpTo(voxel) {
    state.cursor = { x: voxel.x, y: voxel.y, z: voxel.z };
    const v = mainView();
    if (v && state.fit === false) {
      const { col, row } = CT.planeOf(v.plane, state.cursor);
      const c = CT.centerOn(v.scale, col, row, v.cssW, v.cssH);
      v.offsetX = c.offsetX; v.offsetY = c.offsetY;
    }
    requestDraw();
  }

  function onKey(e) {
    const typing = e.target.tagName === 'INPUT' && (e.target.type === 'text' || e.target.type === 'number');
    if (e.key === 'Enter' && state.draft) {
      e.preventDefault();
      if (state.draft.complete) emit('saveDraft'); else closePolygon();
      return;
    }
    if (e.key === 'Escape' && state.draft) { state.draft = null; emit('draftChanged'); requestDraw(); return; }
    if (typing || !state.folder || e.target.tagName === 'SELECT') return;
    if (e.key === 'Backspace' && state.draft && !state.draft.complete) { state.draft.points.pop(); emit('draftChanged'); requestDraw(); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveSlice(activePlane, currentSlice(activePlane) + (e.key === 'ArrowDown' ? 1 : -1) * (e.shiftKey ? 10 : 1));
      return;
    }
    if (e.key === '+' || e.key === '=') zoomCentered(1.25);
    if (e.key === '-') zoomCentered(0.8);
    if (e.key === 'f' && !e.metaKey && !e.ctrlKey) fitAll();
    if (!e.metaKey && !e.ctrlKey) emit('toolKey', e.key.toLowerCase());
  }

  on('mainChanged', () => { state.fit = true; requestAnimationFrame(layout); });
  on('loaded', () => {
    state.fit = true;
    for (const p of PLANES) { views[p].dirty = true; views[p].overlayDirty = true; views[p].shownSlice = null; }
    requestAnimationFrame(layout);
  });
  on('windowChanged', () => { for (const p of PLANES) views[p].dirty = true; requestDraw(); });
  on('viewChanged', () => { for (const p of PLANES) { views[p].dirty = true; views[p].overlayDirty = true; } requestDraw(); });
  on('recordsChanged', () => { markOverlays(); requestDraw(); });
  on('poresChanged', () => { markOverlays(); requestDraw(); });
  on('layersChanged', () => { markOverlays(); requestDraw(); });
  on('redraw', requestDraw);
  on('jump', jumpTo);
  on('closePolygon', closePolygon);

  for (const p of PLANES) buildPlane(p);
  $('zoomIn').addEventListener('click', () => zoomCentered(1.25));
  $('zoomOut').addEventListener('click', () => zoomCentered(0.8));
  $('zoomFit').addEventListener('click', fitAll);
  $('widthMm').addEventListener('change', () => {
    const mm = Number($('widthMm').value);
    const v = mainView();
    if (!(mm > 0) || !state.dims || !v) return;
    const { col, row } = CT.planeOf(v.plane, state.cursor);
    v.scale = CT.clampScale(CT.scaleForWidthMm(mm, state.voxelMm, v.cssW), fitScaleOf(v));
    const c = CT.centerOn(v.scale, col, row, v.cssW, v.cssH);
    v.offsetX = c.offsetX; v.offsetY = c.offsetY;
    state.fit = false;
    renderScale(); requestDraw();
  });
  document.addEventListener('keydown', onKey);
  const resize = new ResizeObserver(layout);
  for (const p of PLANES) resize.observe(views[p].box);
}(window.CTApp));
