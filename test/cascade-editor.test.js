'use strict';

// Guards buildCascadeEditor: the cascade block of a Door Flow card. A cascade
// momentarily unlocks OTHER UniFi doors after an entry (never a lock
// command), so the checklist must exclude the door itself and the block must
// vanish when there is nowhere to cascade to. Extracts the REAL function
// from public/index.html via the shared extractFn harness.

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
  const src = extractFn('escapeHtml') + '\n' + extractFn('cssId') + '\n' + extractFn('buildCascadeEditor');
  return new Function(src + '; return buildCascadeEditor;')();
}

const DOORS = [
  { name: 'Front Door', id: 'd1', discovered: true },
  { name: 'Interior Door', id: 'd2', discovered: true },
  { name: 'Elevator', id: 'd3', discovered: true },
];

test('one known door -> no cascade block (nowhere to cascade to)', () => {
  const out = load()('Front Door', null, [DOORS[0]]);
  assert.equal(out, '', 'a single-door site never sees cascade UI');
});

test('the checklist offers every OTHER door, never the trigger itself', () => {
  const out = load()('Front Door', null, DOORS);
  assert.match(out, /value="Interior Door"/);
  assert.match(out, /value="Elevator"/, 'the elevator is just another door in the list');
  assert.ok(!out.includes('value="Front Door"'), 'a door cannot cascade to itself');
});

test('an existing cascade pre-checks its doors and shows its debounce', () => {
  const out = load()('Front Door', { unlock: ['Elevator'], debounce_seconds: 15 }, DOORS);
  assert.match(out, /value="Elevator" checked/, 'saved target checked');
  assert.ok(!/value="Interior Door" checked/.test(out), 'unselected door unchecked');
  assert.match(out, /value="15"/, 'saved debounce shown');
});

test('no cascade yet -> nothing checked, default 8s debounce', () => {
  const out = load()('Front Door', null, DOORS);
  assert.ok(!out.includes(' checked'), 'nothing pre-checked');
  assert.match(out, /value="8"/, 'default debounce');
});

test('copy states the safety contract: UniFi unlock only, never a lock command', () => {
  const out = load()('Front Door', null, DOORS);
  assert.match(out, /never a lock command/);
});

test('door names are escaped in the checklist', () => {
  const doors = [{ name: 'Front Door', id: 'd1' }, { name: 'Evil <img src=x>', id: 'd2' }];
  const out = load()('Front Door', null, doors);
  assert.ok(!out.includes('<img src=x>'));
  assert.match(out, /Evil &lt;img src=x&gt;/);
});
