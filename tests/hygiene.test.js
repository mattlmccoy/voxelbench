'use strict';
// The repository is public: no scan data, no lab records, no private paths may enter it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BANNED_EXT = ['.tif', '.tiff', '.raw', '.npy', '.npz', '.vol', '.pdf', '.png', '.jpg'];
const MAX_BYTES = 2 * 1024 * 1024;
const { BANNED_TEXT, checkHistory } = require('../tools/banned.js');
const os = require('node:os');

function files() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
      const rel = path.join(dir, d.name);
      if (['.git', 'node_modules', '.superpowers'].includes(d.name)) return [];
      return d.isDirectory() ? walk(rel) : [rel];
    });
    return walk('');
  }
}

test('no scan or image files', () => {
  const bad = files().filter((f) => BANNED_EXT.includes(path.extname(f).toLowerCase()));
  assert.deepEqual(bad, []);
});

test('no file over 2 MB', () => {
  const bad = files().filter((f) => fs.statSync(path.join(ROOT, f)).size > MAX_BYTES);
  assert.deepEqual(bad, []);
});

test('no private paths or lab records', () => {
  const bad = [];
  for (const f of files()) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const s of BANNED_TEXT) if (text.includes(s)) bad.push(`${f}: ${s}`);
  }
  assert.deepEqual(bad, []);
});

test('checkHistory finds a banned string added in an earlier commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-history-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), `bag ${BANNED_TEXT[4]}\n`); git('add', '.'); git('commit', '-qm', 'one');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'clean\n'); git('commit', '-qam', 'two');
  const found = checkHistory(dir, 'HEAD');
  assert.equal(found.length, 1);
  assert.equal(found[0].text, BANNED_TEXT[4]);
  fs.rmSync(dir, { recursive: true, force: true });
});
