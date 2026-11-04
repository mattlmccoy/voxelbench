/* The Findings page of the review sheet: each step's result read in words (the same lists the rail shows under each
   step), the saved regions, the Dragonfly comparison and the density calibration, then the steps not run, so a missing
   section is never mistaken for a clean result. Pure: the page passes its state in, and a text measure for the layout. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./ct_pores.js'), require('./vb_connectivity.js'), require('./vb_insights.js'), require('./vb_feedback.js'), require('./vb_masks.js'), require('./vb_calibration.js'));
  } else root.VBFindings = factory(root.CTPores, root.VBConnectivity, root.VBInsights, root.VBFeedback, root.VBMasks, root.VBCalibration);
}(typeof self !== 'undefined' ? self : this, function (P, C, I, F, M, Cal) {
  'use strict';

  /** Each step's insights from the page state, or null for a step with no result. */
  function stepInsights({ pores, rejected, bodyMm3, voxelMm, connectivity: k, zones, cad, filler, wall }) {
    const out = { pores: null, zones: null, cad: null, filler: null, wall: null };
    if (pores) {
      const summary = P.summarize(pores, bodyMm3, rejected);
      out.pores = I.poreInsights({ pores, rejected, summary, voxelMm, split: k ? C.openClosed(pores, bodyMm3, rejected) : null, through: k ? k.through : null, shellShare: k && k.near_surface ? k.near_surface.body_share : null });
    }
    if (zones && zones.map) out.zones = I.zoneInsights({ stats: zones.stats });
    const r = cad && cad.result;
    if (r) {
      const total = r.stats.measured + r.stats.unmeasured;
      out.cad = I.cadInsights({ stats: r.stats, toleranceMm: cad.toleranceMm, shrinkagePercent: r.options.scale ? (1 - r.transform.s) * 100 : null, unmeasuredPercent: total ? (100 * r.stats.unmeasured) / total : 0 });
    }
    if (filler && filler.result) out.filler = I.fillerInsights({ summary: filler.result.summary, dispersion: filler.result.dispersion });
    if (wall && wall.result) out.wall = I.wallInsights({ stats: wall.result.stats, resolvedMinMm: wall.result.resolved_min_mm, beyondStack: wall.result.beyond_stack });
    return out;
  }

  const bullets = (lines) => lines.map((text) => ({ kind: 'bullet', text }));
  const rows = (list) => list.map(([key, value]) => ({ kind: 'row', key, value }));

  function regionItems({ title, sub, stats }, part, fit) {
    const card = F.regionCard({ title, stats, part, fit });
    const items = [{ kind: 'sub', text: sub ? `${title} (${sub})` : title }];
    if (stats && stats.voxels) {
      const n = [`${stats.volume_mm3.toFixed(2)} mm³`];
      if (stats.pore_fraction !== null && stats.pore_fraction !== undefined) n.push(`porosity ${(100 * stats.pore_fraction).toFixed(2)} %`, `${stats.pore_count} pores`);
      if (Number.isFinite(stats.matrix_gray_mean)) n.push(`solid gray ${Math.round(stats.matrix_gray_mean)}`);
      const d = Cal.applyCalibration(fit, stats.matrix_gray_mean ?? stats.gray_mean);
      if (d) n.push(`${d.value.toFixed(3)}${d.extrapolated ? '*' : ''} g/cm³ eq.`);
      items.push({ kind: 'row', key: 'Numbers', value: n.join(' · ') });
    }
    return items.concat(bullets(card.insights.filter((t) => !(card.todo || []).includes(t))));
  }

  /** Sections in step order, each { title, items: [{ kind: 'bullet' | 'sub', text } | { kind: 'row', key, value }] },
      and the names of the sections with nothing to show. */
  function findings({ steps, regions, part, fit, calibration, crosscheck }) {
    const sections = [], notRun = [];
    const add = (name, step, items) => { if (items && items.length) sections.push({ title: `${name} (step ${step})`, items }); else notRun.push(name); };
    add('Pores', 2, steps.pores && bullets(steps.pores));
    add('Gray-value zones', 3, steps.zones && bullets(steps.zones));
    add('Saved regions', 3, regions.length ? regions.flatMap((r) => regionItems(r, part, fit)) : null);
    if (crosscheck) {
      const read = M.crosscheckRead(crosscheck.result, crosscheck.other);
      add('Dragonfly cross-check', 4, [...rows(read.rows), ...bullets(read.insights)]);
    } else add('Dragonfly cross-check', 4, null);
    const cal = fit && fit.ok ? Cal.calibrationResults({ fit, ...calibration }).rows : [];
    const star = cal.some(([, v]) => v.includes('*')) ? ['* Outside the phantom gray range: extrapolated.'] : [];
    add('Density calibration', 5, cal.length ? [...rows(cal), ...bullets(['Equivalent density from the phantom line; bulk counts the pores as air.', ...star])] : null);
    add('CAD comparison', 6, steps.cad && bullets(steps.cad));
    add('Filler', 7, steps.filler && bullets(steps.filler));
    add('Walls', 8, steps.wall && bullets(steps.wall));
    return { sections, notRun };
  }

  /** Lines of text no wider than width (measure(text) gives a width); a word wider than width gets its own line. */
  function wrap(text, width, measure, kind) {
    const out = [];
    let line = '';
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next, kind) > width) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  /** Pages of text operations { kind, text, x, y } (y the top of the line, x from the left of the text block). An item
      is never split across pages, and a heading or region name always shares its page with the item after it.
      geo: { measure(text, kind), width, top, bottom, lineH, headH, gap, keyW, indent }. */
  function layout(sections, notRun, geo) {
    const { measure, width, top, bottom, lineH, headH, gap, keyW, indent } = geo;
    const pages = [[]];
    let y = top;
    const fits = (h) => y + h <= bottom + 1e-9;
    const newPage = () => { pages.push([]); y = top; };
    const put = (ops) => { for (const { dy, ...o } of ops) pages[pages.length - 1].push({ ...o, y: y + dy }); };
    // An item as operations relative to its top, and its height.
    function block(item) {
      if (item.kind === 'row') {
        const keys = wrap(item.key, keyW - 0.1, measure, 'key'), values = wrap(item.value, width - keyW, measure, 'body');
        const ops = [...keys.map((text, k) => ({ kind: 'key', text, x: 0, dy: k * lineH })), ...values.map((text, k) => ({ kind: 'value', text, x: keyW, dy: k * lineH }))];
        return { ops, h: Math.max(keys.length, values.length) * lineH };
      }
      const x = item.kind === 'bullet' ? indent : 0, lines = wrap(item.text, width - x, measure, item.kind === 'sub' ? 'key' : 'body');
      return { ops: lines.map((text, k) => ({ kind: k === 0 || item.kind === 'sub' ? item.kind : 'text', text, x, dy: k * lineH })), h: lines.length * lineH };
    }
    const place = (b) => { put(b.ops); y += b.h; };
    sections.forEach((s, si) => {
      const blocks = s.items.map(block);
      const head = { ops: [{ kind: 'heading', text: s.title, x: 0, dy: 0 }], h: headH };
      if (si && y !== top) y += gap;
      if (!fits(head.h + (blocks.length ? blocks[0].h : 0))) newPage();
      place(head);
      blocks.forEach((b, k) => {
        const keep = s.items[k].kind === 'sub' && k + 1 < blocks.length ? blocks[k + 1].h : 0;
        if (!fits(b.h + keep)) newPage();
        place(b);
      });
    });
    if (notRun.length) {
      if (y !== top) y += gap;
      const b = block({ kind: 'note', text: `Not run for this sheet: ${notRun.join(', ')}.` });
      if (!fits(b.h)) newPage();
      place(b);
    }
    return pages;
  }

  /** Page numbers of the review sheet with n Findings pages after page 1 (and the rainbow page last when shown). */
  function sheetPages(n, rainbow) {
    const findings = Array.from({ length: n }, (_, k) => 2 + k), slices = 2 + n;
    return { findings, slices, data: slices + 1, rainbow: rainbow ? slices + 2 : null, total: slices + (rainbow ? 2 : 1) };
  }

  return { stepInsights, findings, wrap, layout, sheetPages };
}));
