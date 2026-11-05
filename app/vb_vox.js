/* Rigaku scans. A .VOX volume is a Vox1999a text header (one section, then one per volume, each ending "##\f\n")
   followed by the voxels: unsigned 16-bit, x fastest, then y, then slice 0 first. DataInfo.xml beside it is the
   scanner's record of the scan: tube voltage and current, scan time, voxel size, filter and reconstruction options,
   the settings a gray value depends on. Pure: the page passes bytes and text in. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VBVox = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const END = '##\f\n';
  const HEADER_MAX = 64 * 1024; // read this much of a file to find its header

  /** The header of a Vox1999a file from its first bytes: size, bits, byte order, voxel spacing (mm), the scale and
      offset the scanner gives for its value units, and dataStart, the byte where the voxels begin. */
  function parseVoxHeader(head) {
    const text = String.fromCharCode(...head.subarray(0, Math.min(head.length, HEADER_MAX)));
    if (!text.startsWith('Vox1999a')) throw new Error('This file is not a Vox1999a volume (Rigaku .VOX).');
    const count = Number((text.match(/VolumeCount (\d+)/) || [])[1] || 1);
    let at = 0;
    for (let k = 0; k <= count; k++) {
      const next = text.indexOf(END, at);
      if (next < 0) throw new Error('The VOX header has no end mark.');
      at = next + END.length;
    }
    const nums = (key) => { const m = text.match(new RegExp(`${key} ([^\\n]+)`)); return m ? m[1].trim().split(/\s+/).map(Number) : null; };
    const size = nums('VolumeSize'), scale = nums('VolumeScale'), bits = (nums('VoxelSize') || [])[0];
    if (!size || size.length !== 3) throw new Error('The VOX header has no VolumeSize.');
    if (bits !== 16) throw new Error(`Only 16-bit VOX volumes can be read; this one is ${bits}-bit.`);
    const field = text.match(/Format (\w+) Scale ([-\d.eE]+) Offset ([-\d.eE]+)/);
    return {
      nx: size[0], ny: size[1], nz: size[2], bits, littleEndian: !/Endian B/.test(text),
      voxelMm: scale && scale.length === 3 ? scale : null,
      format: field ? field[1] : null, valueScale: field ? Number(field[2]) : null, valueOffset: field ? Number(field[3]) : null,
      dataStart: at,
    };
  }

  /** Byte range [start, end) of slice z. */
  const sliceRange = (h, z) => { const n = 2 * h.nx * h.ny; return [h.dataStart + z * n, h.dataStart + (z + 1) * n]; };

  /** One slice's bytes as 16-bit values, swapped from big-endian when the file says so. */
  function sliceValues(buf, h) {
    if (h.littleEndian) return new Uint16Array(buf.slice(0));
    const v = new DataView(buf), out = new Uint16Array(buf.byteLength / 2);
    for (let i = 0; i < out.length; i++) out[i] = v.getUint16(2 * i, false);
    return out;
  }

  /** A .VOX file (a File or Blob) opened for reading one slice at a time: { header, count, read(z) }, where read gives
      { width, height, voxelMm, pixels } as a TIFF slice does. The file size must match the header (a copy cut short
      is refused), and the voxels must be cubic, as the analysis assumes. */
  async function openVox(file) {
    const header = parseVoxHeader(new Uint8Array(await file.slice(0, HEADER_MAX).arrayBuffer()));
    const expected = header.dataStart + 2 * header.nx * header.ny * header.nz;
    if (file.size !== expected) throw new Error(`The VOX file is ${file.size} bytes; its header says ${header.nx} × ${header.ny} × ${header.nz} voxels, so expected ${expected} bytes. It may be an incomplete copy.`);
    const [sx, sy, sz] = header.voxelMm || [];
    if (!sx || Math.abs(sy - sx) > 1e-3 * sx || Math.abs(sz - sx) > 1e-3 * sx) throw new Error(`The VOX voxels are not cubic (${header.voxelMm}); VoxelBench assumes equal spacing on all three axes.`);
    return {
      header, count: header.nz,
      async read(z) {
        const [start, end] = sliceRange(header, z);
        return { width: header.nx, height: header.ny, voxelMm: sx, pixels: sliceValues(await file.slice(start, end).arrayBuffer(), header) };
      },
    };
  }

  /** "32sec 16msec", "4min 16sec", "1h 2min" as seconds; null when nothing is readable. */
  function scanSeconds(text) {
    const unit = { h: 3600, min: 60, sec: 1, msec: 0.001 };
    let s = 0, found = false;
    for (const m of String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*(msec|min|sec|h)/g)) { s += Number(m[1]) * unit[m[2]]; found = true; }
    return found ? Math.round(s * 1000) / 1000 : null;
  }

  /** The scan record (DataInfo.xml): the fields a gray value depends on; unreadable ones are null. */
  function parseDataInfo(xml) {
    const tag = (t) => { const m = xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? m[1].trim() : null; };
    const num = (t) => { const v = tag(t); return v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); };
    const bool = (t) => { const v = tag(t); return v === 'true' ? true : v === 'false' ? false : null; };
    return {
      study: tag('Study'), scannedAt: tag('SeriesCreateDate'), volumeFile: tag('VolumeFileName'),
      kv: num('KV'), ua: num('UA'), fovMm: num('FOV'), voxelUm: num('VoxelSize'), scanMode: tag('ScanMode'),
      scanSeconds: scanSeconds(tag('ScanTime')), filter: tag('XrayFilter'), angleRange: num('AngleRange'),
      beamHardeningCorrection: bool('BeamHardeningCorrection'), denoise: bool('Denoise'),
    };
  }

  /** Why two scans' gray values are not on one scale: different tube voltage, current or scan time (the gray scale
      moves with each). Empty when they match. */
  function settingsDiffer(a, b) {
    if (!a || !b) return ['scan settings unknown for one of them'];
    const out = [];
    const same = (x, y) => x !== null && y !== null && Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x));
    const sec = (v) => (v === null ? '?' : String(Math.round(v)));
    if (!same(a.kv, b.kv)) out.push(`${a.kv ?? '?'} kV vs ${b.kv ?? '?'} kV`);
    if (!same(a.ua, b.ua)) out.push(`${a.ua ?? '?'} µA vs ${b.ua ?? '?'} µA`);
    if (!same(a.scanSeconds, b.scanSeconds)) out.push(`scan time ${sec(a.scanSeconds)} s vs ${sec(b.scanSeconds)} s`);
    return out;
  }

  /** A duration as "4 min 16 s" or "32 s". */
  const duration = (s) => { const r = Math.round(s); return r >= 60 ? `${Math.floor(r / 60)} min ${r % 60} s` : `${r} s`; };

  /** The scan settings in one line, for the Scan information panel. */
  function settingsText(info) {
    if (!info) return 'not recorded (no DataInfo.xml beside the scan)';
    const parts = [];
    if (info.kv !== null && info.kv !== undefined) parts.push(`${info.kv} kV`);
    if (info.ua !== null && info.ua !== undefined) parts.push(`${info.ua} µA`);
    if (info.scanSeconds !== null && info.scanSeconds !== undefined) parts.push(`${duration(info.scanSeconds)} scan${info.scanMode ? ` (${info.scanMode} detector binning)` : ''}`);
    if (info.filter) parts.push(info.filter === 'None' ? 'no X-ray filter' : `${info.filter} filter`);
    if (typeof info.beamHardeningCorrection === 'boolean') parts.push(`beam-hardening correction ${info.beamHardeningCorrection ? 'on' : 'off'}`);
    if (typeof info.denoise === 'boolean') parts.push(`denoise ${info.denoise ? 'on' : 'off'}`);
    return parts.join(', ') || 'not recorded';
  }

  return { HEADER_MAX, parseVoxHeader, sliceRange, sliceValues, openVox, scanSeconds, parseDataInfo, settingsDiffer, settingsText };
}));
