'use strict';

// Guards buildAddDeadboltForm: the Add Deadbolt picker must render a
// manufacturer <select> from the catalog, render nothing on an empty catalog,
// and escape catalog-derived text. Extracts the REAL function from
// public/index.html via the shared extractFn harness.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFn(name) {
  const start = html.indexOf('function ' + name);
  assert.ok(start >= 0, 'function not found: ' + name);
  let depth = 0;
  const open = html.indexOf('{', start);
  for (let j = open; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

function load() {
  const src = extractFn('escapeHtml') + '\n' + extractFn('buildAddDeadboltForm');
  return new Function(src + '; return buildAddDeadboltForm;')();
}

test('empty or missing catalog renders nothing', () => {
  const build = load();
  assert.strictEqual(build([]), '');
  assert.strictEqual(build(null), '');
});

test('renders a manufacturer select, a model select, name input, and pair button', () => {
  const build = load();
  const out = build([
    { manufacturer: 'Schlage', models: [{ key: 'schlage-be469zp', name: 'Schlage BE469ZP' }] },
    { manufacturer: 'Yale', models: [{ key: 'yale-assure-zw2', name: 'Yale Assure (ZW2)' }] },
  ]);
  assert.match(out, /id="zwaveAddMfr"/);
  assert.match(out, /id="zwaveAddModel"/);
  assert.match(out, /id="zwaveAddName"/);
  assert.match(out, /onclick="startPairing\(\)"/);
  assert.match(out, /Schlage/);
  assert.match(out, /Yale/);
  // manufacturers are indexed by position so onAddMfrChange can look them up
  assert.match(out, /value="0"/);
  assert.match(out, /value="1"/);
});

test('manufacturer names are escaped', () => {
  const build = load();
  const out = build([{ manufacturer: '<b>x</b>', models: [] }]);
  assert.ok(!out.includes('<b>x</b>'));
  assert.match(out, /&lt;b&gt;x&lt;\/b&gt;/);
});
