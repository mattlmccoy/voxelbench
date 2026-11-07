/* The holder review on the page: the status that says what was checked, how the holder was found, which piece a voxel
   shows, the size of each piece in mm, and the record saved with the sample once the user accepts or toggles.
   The holder h is the model's (ct_worker.js sendModel): { method, given, pieces (native scan voxels), givenBack, labels
   (worker grid, piece index + 1), labelsDims, labelsBin, warning, failed, keep, stls: one report per chosen STL
   (vb_holderwire.js prepareHolder) }. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBHolderReview = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FOUND_BY = { bright: 'found by bright resin', shape: 'found by shape', given: 'found earlier',
    covered: 'detection added nothing (the other holder STLs cover every piece it found)' };
  const detected = (method) => FOUND_BY[method] || 'nothing found by detection';
  const pct = (v) => `${Math.round(100 * v)} %`;
  const mm = (v) => `${v.toFixed(1)} mm`;

  /** What was checked: "not run" (nothing built yet), "no holder found", "removal failed: <reason>", "3 holder pieces,
      not reviewed" or "3 holder pieces, reviewed (1 given back)". failed (the reason) wins over everything, so a failed
      build never reads as "not run" or as no holder. While a build is running (building), "finding the holder…": the last
      build's result is never shown as the current one. */
  function holderStatus(h, failed, building = false) {
    if (building) return 'finding the holder…';
    if (failed) return `removal failed: ${failed}`;
    if (!h) return 'not run';
    const n = h.pieces.length, back = (h.givenBack || []).length;
    if (!n) return 'no holder found';
    const pieces = `${n} holder piece${n === 1 ? '' : 's'}`;
    return h.reviewed ? `${pieces}, reviewed${back ? ` (${back} given back)` : ''}` : `${pieces}, not reviewed`;
  }

  /** How the holder was found, one line per chosen STL (fitted, did not fit, not loaded, changed), or the detection
      method when no STL is involved. Saved pieces carry the method they were found by. [] when nothing was found and no
      STL is involved. */
  function methodLines(h) {
    if (!h) return [];
    const stls = h.stls || [];
    if (!stls.length) return h.pieces.length ? [detected(h.method)] : [];
    const by = (m) => (m === 'stl' || m === 'given' ? '' : `; ${detected(m)}`); // a method another STL or the review set is not detection
    return stls.map((r) => {
      // The chosen file differs from the one the review was fitted with: it was fitted again and the review (pieces and
      // give-backs) no longer applies.
      const changed = r.changedFrom ? `holder STL ${r.name} changed since the review; refitted, review cleared` : null;
      if (changed && r.outcome === 'fitted') return `${changed} (RMS ${r.rmsMm.toFixed(2)} mm)`;
      if (changed && r.outcome === 'poor fit') return `${changed}; it did not fit; ${detected(r.fallback)}`;
      if (r.outcome === 'fitted') return `holder STL ${r.name} fitted (RMS ${r.rmsMm.toFixed(2)} mm)`;
      if (r.outcome === 'reused') return `holder STL ${r.name}, fitted earlier`;
      if (r.outcome === 'poor fit') return `holder STL ${r.name} did not fit; ${detected(r.fallback)}`;
      if (r.outcome === 'missing') return `holder STL ${r.name} not loaded${by(r.fallback || h.method)}`;
      return h.method === 'stl' ? `holder STL ${r.name} not used` : `${detected(h.method)}; holder STL ${r.name} not used`; // 'unused'
    });
  }
  const holderMethod = (h) => methodLines(h).join('; ');

  /** The rail's holder tag: a running build first, then a failed build (holder removal's own failure reads "removal
      failed: …", any other mask-build failure "Could not build the sample mask: …"), then holderStatus. error is the
      failed build's { stage ('holder' or null), message }. */
  function holderTag({ h, reviewed, error, building }) {
    if (building) return holderStatus(h, null, true);
    if (error && error.stage !== 'holder') return `Could not build the sample mask: ${error.message}`;
    return holderStatus(h && { ...h, reviewed }, (error && error.message) || (h && h.failed) || null);
  }

  /** The sample-mask status after a model (reviewed: isReviewed): "Holder: <status>; <method>." then the poor fit's scores, the kept review,
      any piece found but not removed, and removal's warning word for word. A failed removal shows its reason only. */
  function statusLine(h, reviewed = Boolean(h.given)) {
    if (h.failed) return `Holder: ${holderStatus(h, h.failed)}.`;
    const how = holderMethod(h), stls = h.stls || [];
    const notes = [];
    for (const r of stls.filter((x) => x.outcome === 'poor fit')) {
      const whose = stls.length > 1 ? `Holder STL ${r.name}: only` : 'Only';
      notes.push(`${whose} ${pct(r.nearShare)} of its surface in the field lies on the scan (${pct(r.inFieldShare)} of it is in the field).`);
    }
    if (h.keep) notes.push('The saved holder review is kept and applies when the STL loads.');
    // A piece detection found but did not remove (removed: false, vb_holderguard.js), while it is still given back.
    const kept = h.pieces.filter((p) => p.removed === false && (h.givenBack || []).includes(p.id));
    if (kept.length) {
      const many = kept.length > 1;
      notes.push(`Holder piece${many ? 's' : ''} ${kept.map((p) => p.id).join(', ')} ${many ? 'were' : 'was'} found but not removed: removing ${many ? 'them' : 'it'} ${kept[0].reason}. Click ${many ? 'one' : 'it'} to remove it.`);
    }
    if (h.warning) notes.push(h.warning);
    return [`Holder: ${holderStatus({ ...h, reviewed })}${how ? `; ${how}` : ''}.`, ...notes].join(' ');
  }

  /** Why the review cannot be saved now, or null: a saved review waiting for its STL is never overwritten, a failed
      removal is not a review, and nothing found is nothing to review. */
  function reviewBlock(h) {
    if (!h) return 'The holder has not been found yet.';
    if (h.keep) {
      const gone = (h.stls || []).filter((r) => r.outcome === 'missing' && r.name).map((r) => r.name);
      const which = gone.length > 1 ? `The holder STLs ${gone.join(', ')} are` : gone.length ? `The holder STL ${gone[0]} is` : 'A saved holder STL is';
      return `${which} not loaded; the saved review is kept and applies when ${gone.length > 1 ? 'they load' : 'it loads'}. Add the STL to the library's holders to review again.`;
    }
    if (h.failed) return `Holder removal failed: ${h.failed}`;
    if (!h.pieces.length) return 'No holder was found, so there is nothing to review.';
    return null;
  }

  /** What saveSample({ holder }) stores: the pieces (native, without runtime masks), the ids given back, the method and
      when it was reviewed, and the chosen STLs ([{ name, hash }], in order) when any were. null when reviewBlock refuses. */
  function holderRecord(h, givenBack, at = new Date().toISOString()) {
    if (reviewBlock(h)) return null;
    const pieces = h.pieces.map(({ mask, ...p }) => JSON.parse(JSON.stringify(p)));
    const out = { pieces, given_back: [...givenBack], method: h.method, reviewed_at: at };
    if (h.stls && h.stls.length) out.stls = h.stls.map(({ name, hash }) => ({ name, hash }));
    return out;
  }

  const canon = (v) => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

  /** Whether the holder the mask was built with is reviewed: built from the saved review (given), or the saved record
      (the sample's holder) holds exactly these pieces and toggles. Accept saves the build as it is, and the worker then
      keeps the mask and sends no new model, so the page compares. A kept review waiting for its STL is not this build. */
  function isReviewed(h, record) {
    if (!h || h.keep) return false;
    if (h.given) return true;
    if (!record || !Array.isArray(record.pieces) || !record.reviewed_at) return false;
    return same(record.pieces, h.pieces.map(({ mask, ...p }) => p)) && same([...(record.given_back || [])].sort(), [...h.givenBack].sort());
  }

  /** The index of the piece whose label covers loaded-grid voxel (x, y, z), or -1. */
  function labelAt(h, x, y, z) {
    if (!h || !h.labels) return -1;
    const b = h.labelsBin, { nx, ny, nz } = h.labelsDims, i = Math.floor(x / b), j = Math.floor(y / b), k = Math.floor(z / b);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
    return h.labels[i + nx * (j + ny * k)] - 1;
  }

  /** givenBack with id given back, or taken again when it was (a new array). */
  const toggleGiven = (givenBack, id) => (givenBack.includes(id) ? givenBack.filter((g) => g !== id) : [...givenBack, id]);

  /** A piece in words, from its native half extents (voxelMm: the native voxel size): a post's radius and length, a
      plate's or tape's thickness and extents, an STL's name; the volume as measured. */
  function pieceSummary(p, voxelMm) {
    const volume = `${p.mm3.toFixed(1)} mm³`;
    if (p.kind === 'stl') return { kind: 'STL', size: p.name, extents: '', volume };
    const full = p.half.map((v) => 2 * v * voxelMm);
    if (p.kind === 'post') return { kind: 'post', size: `radius ${mm(p.half[1] * voxelMm)}`, extents: `${mm(full[0])} long`, volume };
    const [a, b, t] = [...full].sort((u, v) => v - u);
    return { kind: p.kind, size: `${mm(t)} thick`, extents: `${a.toFixed(1)} × ${mm(b)}`, volume };
  }

  /** The hover readout's holder part: " | holder h2 (post, radius 5.1 mm)". */
  function readoutText(p, givenBack, voxelMm) {
    const s = pieceSummary(p, voxelMm);
    return ` | holder ${p.id}${givenBack ? ', given back to the part' : ''} (${p.kind === 'stl' ? `STL ${p.name}` : `${s.kind}, ${s.size}`})`;
  }

  return { holderStatus, holderTag, holderMethod, methodLines, statusLine, reviewBlock, holderRecord, isReviewed, labelAt, toggleGiven, pieceSummary, readoutText };
}));
