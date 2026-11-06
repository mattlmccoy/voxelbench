'use strict';
// Static build for GitHub Pages: app/index.html is the page body (the artifact host adds the document skeleton), so
// wrap it in one here and copy the scripts and the stylesheet next to it. Usage: node tools/build_static.js [out dir, default dist]
const fs = require('node:fs');
const path = require('node:path');

const app = path.join(__dirname, '..', 'app');
const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));
fs.mkdirSync(out, { recursive: true });
const head = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<style>body{margin:0}[hidden]{display:none!important}</style></head><body>';
fs.writeFileSync(path.join(out, 'index.html'), `${head}${fs.readFileSync(path.join(app, 'index.html'), 'utf8')}</body></html>\n`);
for (const f of fs.readdirSync(app)) if (/\.(js|css)$/.test(f)) fs.copyFileSync(path.join(app, f), path.join(out, f));
console.log(`Wrote ${out}`);
