'use strict';
// Strings that must never reach the public repository: private paths, lab records, private links. Assembled from
// parts so this file does not contain them itself. Used by tests/hygiene.test.js and tools/check_history.js.
const { execFileSync } = require('node:child_process');

const BANNED_TEXT = [['GaTech', ' ', 'Dropbox'], ['matt', '', 'mccoy'], ['PREDICTIONS', '_', 'LOCKED'], ['CT', '_', 'SCANS'],
  ['1026', '-', 'PILE'], ['1027', '-', 'DISK'], ['1021', '-', 'MOUND'], ['1020', '-', 'CUBE'], ['1022', '-', 'CUBE'], ['10/27', ' ', 'cube'],
  ['CT', '_', 'prep'], ['Sample2', '_', '1027_cube'], ['venv', '', '312'], ['1NQ7ww', '', 'AbgJES4B7Gfs1tbs'], ['John', '', 'stone']]
  .map(([a, sep, b]) => a + sep + b);

/** Commits reachable from ref whose added lines contain a banned string: [{ commit, text }]. Run before any push. */
function checkHistory(dir, ref) {
  const out = execFileSync('git', ['log', '-p', '--format=commit %H', ref], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 30 });
  const found = [];
  let commit = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('commit ')) { commit = line.slice(7); continue; }
    if (!line.startsWith('+')) continue;
    for (const text of BANNED_TEXT) if (line.includes(text) && !found.some((f) => f.commit === commit && f.text === text)) found.push({ commit, text });
  }
  return found;
}

module.exports = { BANNED_TEXT, checkHistory };
