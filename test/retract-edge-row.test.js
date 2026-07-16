'use strict';

// Guards buildRetractEdgeRow: one door->deadbolt edge inside a Door Flow
// card. The edge carries ITS OWN after-unlock behavior (one door may make a
// deadbolt behave differently than another), the rare fields fold under an
// Advanced expander, and a hardware auto-relock conflict is called out
// inline. Extracts the REAL function from public/index.html via the shared
// extractFn harness.

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
  const src = extractFn('escapeHtml') + '\n' + extractFn('cssId') + '\n' + extractFn('buildRetractEdgeRow');
  return new Function(src + '; return buildRetractEdgeRow;')();
}

const LOCKS = [
  { lock_id: 'front_deadbolt', name: 'Front Bolt', paired: true, bound: true },
  { lock_id: 'ghost_bolt', name: 'Ghost', paired: false, bound: false },
];

function edge(overrides = {}) {
  return Object.assign({
    lock_id: 'front_deadbolt',
    after_unlock: 'lock_default',
    relock_seconds: null,
    require_result: 'ACCESS',
    mirror_unlock: false,
    relock_cooldown_seconds: 10,
  }, overrides);
}

test('a default edge renders the lock name, the three after-unlock modes, and Remove', () => {
  const out = load()('Front Door', edge(), 0, LOCKS);
  assert.match(out, /Retract <strong>Front Bolt<\/strong>/, 'friendly lock name shown');
  assert.match(out, /value="lock_default" selected/, 'migration default pre-selected');
  assert.match(out, /value="stay_unlocked"/);
  assert.match(out, /value="relock_after"/);
  assert.match(out, /removeRetractEdge\(&quot;Front Door&quot;, 0\)/, 'remove targets this door + edge');
  assert.match(out, /display:none/, 'relock-seconds input hidden outside relock_after');
});

test('relock_after shows the seconds input with the stored value', () => {
  const out = load()('Front Door', edge({ after_unlock: 'relock_after', relock_seconds: 90 }), 1, LOCKS);
  assert.match(out, /value="relock_after" selected/);
  assert.match(out, /value="90"/, 'stored relock seconds surface');
  assert.ok(!/id="dfRelockWrap_[^"]*" style="display:none"/.test(out), 'seconds input visible');
});

test('advanced fields live under a details expander with their stored values', () => {
  const out = load()('Front Door', edge({ require_result: 'GRANTED', mirror_unlock: true, relock_cooldown_seconds: 25 }), 0, LOCKS);
  assert.match(out, /<details/, 'Advanced is an expander (collapsed by default)');
  assert.match(out, /Advanced/);
  assert.match(out, /value="GRANTED"/, 'require_result editable');
  assert.match(out, /id="dfMirror_[^"]+" checked/, 'mirror_unlock reflects the stored flag');
  assert.match(out, /value="25"/, 'cooldown editable');
});

test('a hardware auto-relock conflict is called out inline', () => {
  const quiet = load()('Front Door', edge({ after_unlock: 'stay_unlocked' }), 0, LOCKS);
  assert.ok(!quiet.includes('notice-warn'), 'no warning without the conflict flag');
  const out = load()('Front Door', edge({ after_unlock: 'stay_unlocked', hardware_conflict: true }), 0, LOCKS);
  assert.match(out, /notice-warn/, 'conflict renders a warning');
  assert.match(out, /auto-relock is ON/, 'explains why stay unlocked cannot hold');
  assert.match(out, /Deadbolt Devices/, 'points at where to fix it');
});

test('an unpaired lock is badged, and unknown lock ids still render', () => {
  const ghost = load()('Front Door', edge({ lock_id: 'ghost_bolt' }), 0, LOCKS);
  assert.match(ghost, /not paired/, 'saved-but-unpaired lock is flagged');
  const orphan = load()('Front Door', edge({ lock_id: 'gone_bolt' }), 0, LOCKS);
  assert.match(orphan, /gone_bolt/, 'edge to a lock no longer saved still shows its id');
});

test('door names and values are escaped; edge ids are unique per door and index', () => {
  const out = load()('Evil <img src=x>', edge(), 3, LOCKS);
  assert.ok(!out.includes('<img src=x>'), 'door name escaped');
  const a = load()('Door A', edge(), 0, LOCKS);
  const b = load()('Door A', edge(), 1, LOCKS);
  const idOf = (s) => (s.match(/id="dfAfter_([^"]+)"/) || [])[1];
  assert.notEqual(idOf(a), idOf(b), 'two edges on one door get distinct control ids');
});
