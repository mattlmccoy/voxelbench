/* The scan library. A scan is known by what it contains, not by where its file sits or which format carried it, so
   the same volume opened from a .VOX or from its TIFF stack is one entry. Pure: the page passes voxels in. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vb_calibration.js'), require('./vb_vox.js'));
  else root.VBLibrary = factory(root.VBCalibration, root.VBVox);
}(typeof self !== 'undefined' ? self : this, function (Calibration, Vox) {
  'use strict';

  /** An id for a scan: 's' + 16 hex characters of SHA-256 over "WxHxN" and the bytes of the first and middle slices.
      Two slices are enough to tell scans apart (a dark first slice alone would not, hence the middle) and cheap to
      read from either format; the size guards against equal slices in volumes of different depth. */
  async function scanId({ width, height, count, first, middle }) {
    const head = new TextEncoder().encode(`${width}x${height}x${count}`);
    const a = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
    const b = new Uint8Array(middle.buffer, middle.byteOffset, middle.byteLength);
    const bytes = new Uint8Array(head.length + a.length + b.length);
    bytes.set(head, 0); bytes.set(a, head.length); bytes.set(b, head.length + a.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return 's' + Array.from(digest.subarray(0, 8), (v) => v.toString(16).padStart(2, '0')).join('');
  }

  const INDEX_VERSION = 1;

  /** A library with no scans. `now` is passed in (never read from the clock) so callers and tests control time. */
  function emptyIndex(now) {
    return { schema: 'voxelbench-library-index', version: INDEX_VERSION, created: now, scans: {} };
  }

  /** Whether a file seen during a scan of the root must be opened again. Same path, size and modified time as an
      indexed entry means nothing changed, so the (slow) read that yields the id can be skipped. */
  function needsRead(index, stamp) {
    return findIndexed(index, stamp) === null;
  }

  /** The id of the indexed scan seen at this path with this size and modified time, as its own file or as one of its
      copies (copy_stamps), or null. */
  function findIndexed(index, { path, bytes, mtime }) {
    const same = (s) => s.path === path && s.bytes === bytes && s.mtime === mtime;
    for (const [id, e] of Object.entries(index.scans)) if (same(e) || (e.copy_stamps || []).some(same)) return id;
    return null;
  }

  /** Refuses a scans.json this VoxelBench cannot read safely (another file, or one from a newer version), so it is never
      overwritten. */
  function checkIndex(obj) {
    const bad = () => new Error('VoxelBench/scans.json is not a VoxelBench scan index; it was left untouched');
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.schema !== 'voxelbench-library-index' || typeof obj.version !== 'number') throw bad();
    if (obj.version > INDEX_VERSION) throw new Error(`The scan index is from a newer VoxelBench (index version ${obj.version}, this one reads ${INDEX_VERSION}); it was left untouched`);
    if (!obj.scans || typeof obj.scans !== 'object' || Array.isArray(obj.scans)) throw bad();
    return obj;
  }

  /** Fold the scans found this time into the index. Returns a new index; the input is not changed. Nothing is ever
      dropped: a scan not found now is kept with missing:true, because its records live elsewhere and must stay
      attached for when the drive is back or the scan is moved. first_seen survives; last_seen moves only for scans
      found now. */
  function mergeIndex(index, scans, now) {
    const next = {};
    for (const [id, e] of Object.entries(index.scans)) next[id] = { ...e, missing: true };
    for (const { id, ...seen } of scans) { // every field found now (scanner record, copies) replaces the old ones
      const old = index.scans[id];
      next[id] = { ...seen, first_seen: old ? old.first_seen : now, last_seen: now, missing: false };
    }
    return { ...index, scans: next };
  }

  /** One entry per scan id. A VOX and a full-resolution TIFF export of it share an id; the entry is read from the VOX
      (else from the shortest path) and the other places are kept as copies, with the size and time each was seen
      at so an unchanged copy is not read again. Entries with a unique id pass through unchanged. */
  function dedupeScans(scans) {
    const byId = new Map();
    for (const s of scans) { if (!byId.has(s.id)) byId.set(s.id, []); byId.get(s.id).push(s); }
    const better = (a, b) => (a.kind === 'vox') !== (b.kind === 'vox') ? (a.kind === 'vox' ? -1 : 1) : a.path.length - b.path.length || (a.path < b.path ? -1 : 1);
    return [...byId.values()].map((group) => {
      if (group.length === 1) return group[0];
      const [best, ...rest] = [...group].sort(better);
      return { ...best, copies: rest.map((s) => s.path), copy_stamps: rest.map(({ path, bytes, mtime }) => ({ path, bytes, mtime })) };
    });
  }

  const leaf = (path) => String(path || '').split('/').filter(Boolean).pop() || '';
  const dirOf = (path) => path.split('/').slice(0, -1).join('/');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  /** What a card shows. The title is the sample's name, else the scanner's study, else the folder name (a record saved
      without a name stores its id as the name, which is not one). Porosity comes only from a saved run. */
  function cardFacts({ entry, record, run }) {
    const info = entry.info || {};
    const named = record && record.name && record.name !== record.id ? record.name : null;
    return {
      title: named || entry.study || leaf(entry.path),
      date: info.scannedAt || null,
      scanSeconds: num(info.scanSeconds),
      voxelUm: num(info.voxelUm) ?? num(entry.voxel_um),
      kv: num(info.kv),
      porosity: run && run.summary ? num(run.summary.all_void_percent_of_body) : null,
      analyzed: Boolean(run),
      starred: Boolean(record && record.starred),
      tags: record && Array.isArray(record.tags) ? [...record.tags] : [],
      missing: Boolean(entry.missing),
    };
  }

  const FILTERS = {
    all: () => true,
    starred: (f) => f.starred,
    analyzed: (f) => f.analyzed,
    unanalyzed: (f) => !f.analyzed,
    missing: (f) => f.missing,
  };

  /** The rows ({ id, entry, record, run }) that pass the side filter, the tag, the project and the search, which looks
      in the title, the study, the tags and the notes. Order is kept. */
  function filterScans(rows, { query = '', filter = 'all', tag = null, project = null } = {}) {
    const q = String(query).trim().toLowerCase();
    const pass = FILTERS[filter] || FILTERS.all;
    return rows.filter((r) => {
      const f = cardFacts(r), rec = r.record || {};
      if (!pass(f)) return false;
      if (tag && !f.tags.includes(tag)) return false;
      if (project && rec.project !== project) return false;
      if (!q) return true;
      return [f.title, r.entry.study, ...f.tags, rec.notes].filter(Boolean).join('\n').toLowerCase().includes(q);
    });
  }

  /** Tags typed as "a, b, c": trimmed, without blanks or repeats. */
  const parseTags = (text) => [...new Set(String(text || '').split(',').map((t) => t.trim()).filter(Boolean))];

  /** CT.groupStacks keys TIFF scans by their folder's name, so equal names in different places would merge into one
      volume; a library walks a whole drive, where that happens. Each stack is split back into its real folders (dir),
      and a TIFF folder takes the DataInfo.xml beside it or one level up, as groupStacks does. */
  function scanFolders(stacks, files) {
    const records = new Map();
    for (const f of files) if (leaf(f.webkitRelativePath) === 'DataInfo.xml') records.set(dirOf(f.webkitRelativePath), f);
    const out = [];
    for (const s of stacks) {
      if (s.kind === 'vox') { out.push({ ...s, dir: dirOf(s.vox.webkitRelativePath) }); continue; }
      const byDir = new Map();
      for (const f of s.files) { const d = dirOf(f.webkitRelativePath); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(f); }
      for (const [dir, list] of byDir) out.push({ ...s, folder: leaf(dir), dir, files: list, dataInfo: records.get(dir) || records.get(dirOf(dir)) || null });
    }
    return out;
  }

  /** What tells whether a scan's files changed: its folder, and the VOX file's size and time, or the slices' total size
      and latest time. */
  function stampOf(stack) {
    if (stack.kind === 'vox') return { path: stack.dir, bytes: stack.vox.size, mtime: stack.vox.lastModified };
    return { path: stack.dir, bytes: stack.files.reduce((a, f) => a + f.size, 0), mtime: Math.max(...stack.files.map((f) => f.lastModified)) };
  }

  const CARRIED = ['study', 'info', 'width', 'height', 'count', 'voxel_um'];

  /** One pass over the files under the library root. A scan whose stamp is already indexed (as itself or as a copy)
      keeps what is known about it; any other is read with readScan(stack) -> { id, study, info, width, height, count,
      voxel_um }. A scan that cannot be read is reported in failed and left out of this pass (an indexed one is then
      kept as missing, never dropped). Returns the new index, the scans by id (stack.folder = the id), how many scan
      folders were listed (places, copies included) and read, and what failed. */
  async function rescan({ files, index, groupStacks, readScan, now, onRead = () => {} }) {
    const stacks = scanFolders(groupStacks(files), files);
    const seen = [], byPath = new Map(), failed = [];
    let read = 0;
    for (const stack of stacks) {
      const stamp = stampOf(stack);
      byPath.set(stamp.path, stack);
      let id = findIndexed(index, stamp), meta;
      if (id) {
        const e = index.scans[id];
        meta = Object.fromEntries(CARRIED.map((k) => [k, e[k] ?? null]));
      } else {
        onRead(stack, read);
        try { ({ id, ...meta } = await readScan(stack)); } catch (e) { failed.push({ path: stamp.path, message: e.message }); continue; }
        read++;
      }
      seen.push({ id, ...stamp, kind: stack.kind, ...Object.fromEntries(CARRIED.map((k) => [k, meta[k] ?? null])) });
    }
    const scans = dedupeScans(seen);
    const byId = new Map(scans.map((s) => [s.id, { ...byPath.get(s.path), folder: s.id }]));
    return { index: mergeIndex(index, scans, now), stacks: byId, read, places: seen.length, found: scans.length, failed };
  }

  /** Rescans for one page. open() marks a new root: a Rescan begun before it is stale (it writes nothing, to either
      root) and no longer counts as running. run(dir, index) works on the dir it was given, re-reads scans.json just
      before writing and refuses (writing nothing) one that is now newer, unreadable, or changed on the drive since this
      page read or wrote it. I/O is passed in: listFiles(dir), ensureDrive(dir), readIndex(dir) -> text | null,
      writeIndex(dir, text), plus rescan()'s groupStacks, readScan and onRead, and now() for the time stamp. listFiles gets
      live(), false once the Rescan is stale. */
  function makeRescanner(io) {
    let gen = 0, running = 0;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(JSON.parse(JSON.stringify(b)));
    async function run(dir, index) {
      if (running && running === gen) return { skipped: true };
      const mine = gen;
      running = mine;
      try {
        const live = () => mine === gen; // progress from a stale Rescan is not shown
        const files = await io.listFiles(dir, live);
        if (!live()) return { stale: true };
        const r = await rescan({ files, index, groupStacks: io.groupStacks, readScan: io.readScan, now: io.now(), onRead: (...a) => { if (live() && io.onRead) io.onRead(...a); } });
        if (mine !== gen) return { stale: true };
        await io.ensureDrive(dir);
        const text = await io.readIndex(dir);
        if (text !== null) {
          let obj;
          try { obj = JSON.parse(text); } catch (e) { throw new Error(`VoxelBench/scans.json is not readable JSON (${e.message}); it was left untouched`); }
          checkIndex(obj);
          if (!same(obj, index)) throw new Error('VoxelBench/scans.json changed on the drive since this page read it (another VoxelBench?); it was left untouched. Reopen the library and Rescan');
        }
        if (mine !== gen) return { stale: true };
        await io.writeIndex(dir, JSON.stringify(r.index, null, 2));
        return r;
      } finally {
        if (running === mine) running = 0;
      }
    }
    return { open: () => ++gen, busy: () => Boolean(running) && running === gen, run };
  }

  /** The display window for a thumbnail: the 1st to 99.9th percentile of the nonzero values (zero is outside the
      reconstruction). Sampled on a stride for large slices. */
  function grayWindow(pixels, maxSamples = 262144) {
    const step = Math.max(1, Math.floor(pixels.length / maxSamples));
    const vals = [];
    for (let i = 0; i < pixels.length; i += step) if (pixels[i]) vals.push(pixels[i]);
    if (!vals.length) return { low: 0, high: 1 };
    const v = Float64Array.from(vals).sort();
    const at = (p) => v[Math.floor(p * (v.length - 1))];
    const low = at(0.01), high = at(0.999);
    return { low, high: high > low ? high : low + 1 };
  }

  const NOT_RECORDED = 'not recorded';
  const stamp = (iso) => String(iso).slice(0, 16).replace('T', ' '); // the scanner's own time, as recorded
  const pad = (n) => String(n).padStart(2, '0');
  /** A saved run's time (an ISO instant) in this computer's local time, like the scanner's time beside it. */
  const localStamp = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const percent = (v) => (num(v) === null ? NOT_RECORDED : `${v.toFixed(2)} %`);

  /** What the scan overview shows, each value from a stated source or "not recorded": the scanner record (scanInfo, the
      parsed DataInfo.xml) and the index entry; the VOX header gives the voxel size when the record has none. Results
      are the latest saved run's: porosity, open and closed, pore count, and for each saved region its relative density
      on each of the run's relative scales (the run's own air and dense-reference grays). A whole-part relative
      density is not computed anywhere, so it is not listed. runs ([{ at }], any order) become newest-first with a label. */
  function overviewFacts({ entry, scanInfo, header, record, run, runs }) {
    const info = scanInfo || {};
    const voxelUm = num(info.voxelUm) ?? num(entry.voxel_um) ?? (header && header.voxelMm ? header.voxelMm[0] * 1000 : null);
    const dims = header ? [header.nx, header.ny, header.nz] : [entry.width, entry.height, entry.count];
    const tube = [num(info.kv) !== null && `${info.kv} kV`, num(info.ua) !== null && `${info.ua} µA`].filter(Boolean).join(', ');
    // The sample record's orientation says it; a saved run's own value only when the record has no word on it.
    const leveled = record ? (record.orientation ? 'yes' : 'no') : run ? (run.leveled ? 'yes' : 'no') : NOT_RECORDED;
    const rows = [
      ['Scanned', info.scannedAt ? stamp(info.scannedAt) : NOT_RECORDED],
      ['Tube', tube || NOT_RECORDED],
      ['Scan time', num(info.scanSeconds) === null ? NOT_RECORDED : Vox.duration(info.scanSeconds)],
      ['Voxel', voxelUm === null ? NOT_RECORDED : `${voxelUm.toFixed(voxelUm < 10 ? 2 : 1)} µm`],
      ['Size', dims.every((d) => num(d) !== null) ? `${dims.join(' × ')} voxels` : NOT_RECORDED],
      ['Format', entry.kind === 'vox' ? 'VOX' : entry.kind === 'tiff' ? 'TIFF stack' : NOT_RECORDED],
      ['Leveled', leveled],
    ];
    const results = [];
    if (run) {
      const s = run.summary || {};
      const oc = run.open_closed || {};
      results.push(['Porosity', percent(s.all_void_percent_of_body)], ['Open', percent(oc.open_percent)], ['Closed', percent(oc.closed_percent)],
        ['Pores', num(s.pore_count) === null ? NOT_RECORDED : String(s.pore_count)]);
      const names = new Map((run.labels || []).map((l) => [l.id, l.label]));
      for (const r of run.regions || []) {
        const gray = r.stats && num(r.stats.gray_mean);
        const name = `${names.get(r.label) || r.label}${r.note ? ` (${r.note})` : ''}`;
        for (const scale of run.relative_scale || []) {
          const v = gray === null || gray === undefined ? null : Calibration.relativeDensity(scale, gray);
          if (v !== null) results.push([`${name}, relative to ${scale.material} dense`, v.toFixed(2)]);
        }
      }
    }
    const history = [...(runs || [])].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map(({ at }) => ({ at, label: localStamp(at) }));
    return { rows, results, runs: history };
  }

  /** The bytes [start, end) to read for one row of a preview plane of a VOX volume, so the preview needs a few slices'
      worth of reads and not the volume. XY: slice `index`, row ignored (the whole slice). XZ: the plane y = index, row
      = z: one contiguous run of x. YZ: the plane x = index, row = z: the voxels (index, y) are not adjacent, so this is
      the span from y = 0 to y = ny - 1 in slice z, and the caller keeps every nx-th value (the XZ row of y = ny / 2
      lies inside the same span for ny >= 4). */
  function voxRowRange(h, plane, index, row) {
    const slice = 2 * h.nx * h.ny, outside = () => new Error(`index ${index}, row ${row} is outside the volume`);
    const inside = (v, n) => Number.isInteger(v) && v >= 0 && v < n;
    if (plane === 'XY') { if (!inside(index, h.nz)) throw outside(); return Vox.sliceRange(h, index); }
    if (plane !== 'XZ' && plane !== 'YZ') throw new Error(`plane must be XY, XZ or YZ, not ${plane}`);
    if (!inside(row, h.nz) || !inside(index, plane === 'XZ' ? h.ny : h.nx)) throw outside();
    const base = h.dataStart + row * slice;
    if (plane === 'XZ') return [base + index * 2 * h.nx, base + (index + 1) * 2 * h.nx];
    return [base + 2 * index, base + 2 * ((h.ny - 1) * h.nx + index + 1)];
  }

  /** Saves of one scan's record that do not erase each other. The page's copy of the records (samples()) refreshes only
      when the store reports a write back, so a second save made before that would start from the old copy and drop the
      first. Each save is built on the previous one still in flight (pending), cleared once its own put settles.
      save(id, changes) returns the put's promise, so the caller can show this save's outcome. */
  function makeRecordSaver({ samples, put, sampleRecord }) {
    const pending = new Map();
    return (id, changes) => {
      const record = sampleRecord(id, samples(), changes, pending.get(id) || null);
      pending.set(id, record);
      return Promise.resolve(put(record)).finally(() => { if (pending.get(id) === record) pending.delete(id); });
    };
  }

  /** The remembered-drive card on the welcome screen. summary is what the last visit saved in this browser
      ({ name, scans, analyzed, opened_at }) or null; access is the folder handle's permission now: 'granted', 'prompt',
      'denied' or 'gone'. The remembered counts are always labeled "at last visit", and a drive that cannot be read now
      shows none. state: 'open' (one click opens it), 'allow' (the browser asks first), 'unavailable'. */
  function driveCard(summary, access, handleName = null) {
    if (summary && handleName && summary.name !== handleName) summary = null; // saved for another folder: no counts for this one
    const title = handleName || (summary && summary.name) || 'Your scan drive';
    if (access === 'denied') return { title, state: 'unavailable', facts: 'Access was not allowed. Choose your scan drive… to pick it again.' };
    if (access === 'gone') return { title, state: 'unavailable', facts: 'This folder is not available now (unplugged, moved or renamed). Choose your scan drive… to pick it again.' };
    const state = access === 'granted' ? 'open' : 'allow';
    const n = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`;
    const counted = summary && Number.isFinite(summary.scans);
    const analyzed = counted && Number.isFinite(summary.analyzed) ? `, ${summary.analyzed} analyzed` : '';
    const when = summary && typeof summary.opened_at === 'string' && summary.opened_at ? ` · last opened ${summary.opened_at.slice(0, 10)}` : '';
    const facts = counted ? `${n(summary.scans, 'scan')}${analyzed} at last visit${when}` : `Opened before${when}`;
    return { title, state, facts };
  }

  /** The banner for a library that would not open, or null when the drive is simply gone (the card says that). */
  function refusalMessage(name, e) {
    if (e && e.name === 'NotFoundError') return null;
    return `The library in ${name} was not opened: ${String(e.message).replace(/\.+$/, '')}.`;
  }

  /** What the page keeps per browser for the card: the drive's folder name, how many scans it had and how many were
      analyzed. rows are the library rows; loaded(id) says whether that scan's saved runs have been read yet, and until
      every one has, analyzed is null (unknown) rather than a low count. */
  function driveSummary(name, rows, loaded, now) {
    const present = rows.filter((r) => !r.entry.missing);
    const known = present.every((r) => loaded(r.id));
    return { name, scans: present.length, analyzed: known ? present.filter((r) => cardFacts(r).analyzed).length : null, opened_at: now };
  }

  return { driveCard, driveSummary, refusalMessage, NOT_RECORDED, makeRecordSaver, overviewFacts, voxRowRange, scanId, INDEX_VERSION, emptyIndex, needsRead, findIndexed, checkIndex, mergeIndex, dedupeScans, cardFacts, filterScans, parseTags, scanFolders, stampOf, rescan, makeRescanner, grayWindow };
}));
