'use strict';
// Refuse to publish a history that ever contained a banned string. Usage: node tools/check_history.js <ref>
const path = require('node:path');
const { checkHistory } = require('./banned.js');

const ref = process.argv[2] || 'HEAD';
const found = checkHistory(path.join(__dirname, '..'), ref);
for (const f of found) console.error(`${f.commit.slice(0, 7)}: ${f.text}`);
if (found.length) { console.error(`${ref}: ${found.length} banned string(s) in history; do not push it.`); process.exit(1); }
console.log(`${ref}: history is clean.`);
