'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Page-only modules (the rail steps) have no unit tests of their own; at least every file must parse.
test('every app script parses', () => {
  const dir = path.join(__dirname, '..', 'app');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }), f);
  }
});
