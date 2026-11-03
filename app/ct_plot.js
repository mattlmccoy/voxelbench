/* Journal-style plots drawn on a canvas in inches: closed frame, inward major and minor ticks, bold Arial labels.
   The review sheet draws every figure with these so the in-app PDF matches the Python sheet. */
(function (root, factory) {
  root.CTPlot = factory(root.CTSheetData);
}(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';

  const FONT = 'Arial, Helvetica, sans-serif';
  const PT = 1 / 72;

  function text(ctx, x, y, s, { size = 9, weight = 'bold', color = '#000', align = 'left', base = 'alphabetic', rotate = 0 } = {}) {
    ctx.save();
    ctx.font = `${weight} ${size * PT}px ${FONT}`;
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
    ctx.translate(x, y);
    if (rotate) ctx.rotate(rotate);
    ctx.fillText(s, 0, 0);
    ctx.restore();
  }

  function width(ctx, s, size, weight = 'bold') {
    ctx.save();
    ctx.font = `${weight} ${size * PT}px ${FONT}`;
    const w = ctx.measureText(s).width;
    ctx.restore();
    return w;
  }

  /** Axes in inches on the page: box {x, y, w, h}; xlim/ylim in data; xlog for decades. */
  function axes(ctx, box, { xlim, ylim, xlog = false }) {
    const lx = (v) => (xlog ? Math.log10(v) : v);
    const fx = (v) => box.x + ((lx(v) - lx(xlim[0])) / (lx(xlim[1]) - lx(xlim[0]))) * box.w;
    const fy = (v) => box.y + box.h - ((v - ylim[0]) / (ylim[1] - ylim[0])) * box.h;
    return { ctx, box, xlim, ylim, xlog, fx, fy };
  }

  function clip(ax, draw) {
    const { ctx, box } = ax;
    ctx.save();
    ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
    draw(ctx);
    ctx.restore();
  }

  function decadeLabel(e) {
    const sup = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
    return '10' + String(e).split('').map((c) => sup[c]).join('');
  }

  /** Frame, inward ticks on all four sides, tick labels, axis labels and the panel letter. */
  function frame(ax, { xlabel, ylabel, xticks, yticks, letter, letterAt = 'tr', xticklabels = true }) {
    const { ctx, box, fx, fy, xlim, ylim, xlog } = ax;
    ctx.save();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.4 * PT;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    const major = 4 * PT, minor = 2.2 * PT;
    const tickX = (x, len) => { ctx.beginPath(); ctx.moveTo(x, box.y + box.h); ctx.lineTo(x, box.y + box.h - len); ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + len); ctx.stroke(); };
    const tickY = (y, len) => { ctx.beginPath(); ctx.moveTo(box.x, y); ctx.lineTo(box.x + len, y); ctx.moveTo(box.x + box.w, y); ctx.lineTo(box.x + box.w - len, y); ctx.stroke(); };
    ctx.lineWidth = 0.9 * PT;
    if (xlog) {
      for (let e = Math.floor(Math.log10(xlim[0])); e <= Math.ceil(Math.log10(xlim[1])); e++) {
        for (let m = 1; m < 10; m++) {
          const v = m * 10 ** e;
          if (v < xlim[0] || v > xlim[1]) continue;
          tickX(fx(v), m === 1 ? major : minor);
          if (m === 1 && xticklabels) text(ctx, fx(v), box.y + box.h + 11 * PT, decadeLabel(e), { size: 8.5, align: 'center' });
        }
      }
    } else {
      const xt = xticks || D.niceTicks(xlim[0], xlim[1], 5);
      const step = xt[1] - xt[0];
      for (const v of xt) { tickX(fx(v), major); if (xticklabels) text(ctx, fx(v), box.y + box.h + 11 * PT, fmt(v), { size: 8.5, align: 'center' }); }
      for (let v = xt[0] - step; v <= xlim[1]; v += step / 2) if (v >= xlim[0] && !xt.some((t) => Math.abs(t - v) < 1e-9)) tickX(fx(v), minor);
    }
    const yt = yticks || D.niceTicks(ylim[0], ylim[1], 4);
    const ystep = yt.length > 1 ? yt[1] - yt[0] : 1;
    for (const v of yt) { tickY(fy(v), major); text(ctx, box.x - 3.5 * PT, fy(v), fmt(v), { size: 8.5, align: 'right', base: 'middle' }); }
    for (let v = yt[0] - ystep; v <= ylim[1]; v += ystep / 2) if (v >= ylim[0] && !yt.some((t) => Math.abs(t - v) < 1e-9)) tickY(fy(v), minor);
    ctx.restore();
    if (xlabel) text(ctx, box.x + box.w / 2, box.y + box.h + 24 * PT, xlabel, { size: 9, align: 'center' });
    if (ylabel) {
      const lines = ylabel.split('\n');
      const widest = Math.max(...yt.map((v) => width(ctx, fmt(v), 8.5)));
      lines.forEach((l, k) => text(ctx, box.x - widest - (9 + 10 * (lines.length - 1 - k)) * PT, box.y + box.h / 2, l, { size: 9, align: 'center', rotate: -Math.PI / 2 }));
    }
    if (letter) {
      const right = letterAt.includes('r'), top = letterAt.includes('t');
      text(ctx, right ? box.x + box.w - 5 * PT : box.x + 5 * PT, top ? box.y + 12 * PT : box.y + box.h - 5 * PT, `(${letter})`, { size: 9, align: right ? 'right' : 'left' });
    }
  }

  function fmt(v) {
    if (Math.abs(v) >= 100 || Number.isInteger(v)) return String(Math.round(v)).replace('-', '−');
    return String(Number(v.toFixed(2))).replace('-', '−');
  }

  function bars(ax, edges, values, color) {
    clip(ax, (ctx) => {
      ctx.fillStyle = color; ctx.strokeStyle = '#000'; ctx.lineWidth = 0.8 * PT;
      values.forEach((v, k) => {
        const x0 = ax.fx(edges[k]), x1 = ax.fx(edges[k + 1]), y = ax.fy(v), y0 = ax.fy(0);
        ctx.fillRect(x0, y, x1 - x0, y0 - y); ctx.strokeRect(x0, y, x1 - x0, y0 - y);
      });
    });
  }

  function line(ax, xs, ys, { color = '#000', width: w = 1.6, dash = null } = {}) {
    clip(ax, (ctx) => {
      ctx.strokeStyle = color; ctx.lineWidth = w * PT; ctx.lineJoin = 'round';
      if (dash) ctx.setLineDash(dash.map((d) => d * PT));
      ctx.beginPath();
      let on = false;
      xs.forEach((x, k) => {
        if (!Number.isFinite(ys[k])) { on = false; return; }
        const px = ax.fx(x), py = ax.fy(ys[k]);
        if (on) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        on = true;
      });
      ctx.stroke();
    });
  }

  function markers(ax, xs, ys, { color = '#000', r = 2.6, hollow = false, width: w = 1.2 } = {}) {
    clip(ax, (ctx) => {
      xs.forEach((x, k) => {
        ctx.beginPath(); ctx.arc(ax.fx(x), ax.fy(ys[k]), r * PT, 0, 2 * Math.PI);
        if (hollow) { ctx.strokeStyle = color; ctx.lineWidth = w * PT; ctx.stroke(); } else { ctx.fillStyle = color; ctx.fill(); }
      });
    });
  }

  function vline(ax, x, { color = '#000', width: w = 1.2, dash = null } = {}) {
    line(ax, [x, x], [ax.ylim[0], ax.ylim[1]], { color, width: w, dash });
  }

  /** Step outline over bin centers, with optional fills where keep(x) holds. */
  function step(ax, centers, values, binWidth, { color = '#000', fills = [] } = {}) {
    clip(ax, (ctx) => {
      for (const f of fills) {
        ctx.fillStyle = f.color; ctx.globalAlpha = f.alpha;
        centers.forEach((c, k) => {
          if (!f.keep(c)) return;
          const x0 = ax.fx(c - binWidth / 2), x1 = ax.fx(c + binWidth / 2), y = ax.fy(values[k]);
          ctx.fillRect(x0, y, x1 - x0, ax.fy(0) - y);
        });
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = color; ctx.lineWidth = 1.2 * PT;
      ctx.beginPath();
      centers.forEach((c, k) => {
        const x0 = ax.fx(c - binWidth / 2), x1 = ax.fx(c + binWidth / 2), y = ax.fy(values[k]);
        if (k === 0) ctx.moveTo(x0, ax.fy(0));
        ctx.lineTo(x0, y); ctx.lineTo(x1, y);
      });
      ctx.stroke();
    });
  }

  /** Boxed legend; items: {label, kind: 'line'|'dash'|'dot'|'patch'|'ring'|'circle', color}. at: {x, y} top-left in inches. */
  // at: {x, y, align: 'left' | 'center' | 'right', valign: 'top' | 'bottom'}
  function legend(ctx, items, at, { size = 8, columns = items.length, title = '' } = {}) {
    const pad = 4 * PT, swatch = 14 * PT, gap = 10 * PT, rowH = size * 1.5 * PT;
    const widths = items.map((it) => swatch + 4 * PT + width(ctx, it.label, size));
    const colW = [];
    widths.forEach((w, k) => { colW[k % columns] = Math.max(colW[k % columns] || 0, w); });
    const rows = Math.ceil(items.length / columns), head = title ? rowH : 0;
    const total = colW.reduce((a, b) => a + b, 0) + gap * (columns - 1) + 2 * pad, height = head + rows * rowH + 2 * pad;
    const x0 = at.align === 'center' ? at.x - total / 2 : at.align === 'right' ? at.x - total : at.x;
    const y0 = at.valign === 'bottom' ? at.y - height : at.y;
    ctx.save();
    ctx.fillStyle = '#fff'; ctx.fillRect(x0, y0, total, height);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1 * PT; ctx.strokeRect(x0, y0, total, height);
    if (title) text(ctx, x0 + total / 2, y0 + pad + rowH / 2, title, { size, align: 'center', base: 'middle' });
    items.forEach((it, k) => {
      const c = k % columns, r = Math.floor(k / columns);
      const x = x0 + pad + colW.slice(0, c).reduce((a, b) => a + b, 0) + gap * c, y = y0 + pad + head + r * rowH + rowH / 2;
      ctx.strokeStyle = it.color; ctx.fillStyle = it.color; ctx.lineWidth = 1.4 * PT; ctx.setLineDash([]);
      if (it.kind === 'patch') { ctx.globalAlpha = it.alpha ?? 1; ctx.fillRect(x, y - 4 * PT, swatch, 8 * PT); ctx.globalAlpha = 1; }
      else if (it.kind === 'ring') { ctx.beginPath(); ctx.arc(x + swatch / 2, y, 4.5 * PT, 0, 2 * Math.PI); ctx.stroke(); }
      // An outline swatch on a fill, as outlines appear over a colored image.
      else if (it.kind === 'outline') { ctx.fillStyle = it.fill; ctx.fillRect(x, y - 4 * PT, swatch, 8 * PT); ctx.lineWidth = 2 * PT; ctx.strokeRect(x + PT, y - 3 * PT, swatch - 2 * PT, 6 * PT); }
      else if (it.kind === 'circle') { ctx.beginPath(); ctx.arc(x + swatch / 2, y, (it.r || 3) * PT, 0, 2 * Math.PI); ctx.fill(); }
      else {
        if (it.kind === 'dash') ctx.setLineDash([4 * PT, 2.5 * PT]);
        if (it.kind === 'dot') ctx.setLineDash([1.2 * PT, 2 * PT]);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + swatch, y); ctx.stroke(); ctx.setLineDash([]);
      }
      text(ctx, x + swatch + 4 * PT, y, it.label, { size, base: 'middle' });
    });
    ctx.restore();
  }

  return { PT, FONT, text, width, axes, frame, bars, line, markers, vline, step, legend };
}));
