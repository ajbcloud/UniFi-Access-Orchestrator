'use strict';

// Guards buildRetractEdgeRow: one door->deadbolt edge inside a trigger block on
// a door card. The edge carries ITS OWN after-unlock behavior (one door may
// make a deadbolt behave differently than another), the rare fields fold under
// an Advanced expander, and a hardware auto-relock conflict is called out
// inline. Extracts the REAL function from public/index.html.

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
    after_unlock: 'stay_unlocked',
    relock_seconds: null,
    require_result: 'ACCESS',
    mirror_unlock: false,
    relock_cooldown_seconds: 10,
  }, overrides);
}

// signature: buildRetractEdgeRow(door, tIdx, edge, eIdx, locks)
test('a default edge renders the lock name, the two after-unlock modes, and Remove', () => {
  const out = load()('Front Door', 0, edge(), 0, LOCKS);
  assert.match(out, /Retract deadbolt/, 'action titled');
  assert.match(out, /Front Bolt/, 'friendly lock name shown');
  assert.match(out, /class="chip active" data-df-after="stay_unlocked"/, 'stay unlocked is the default');
  assert.match(out, /data-df-after="relock_after"/);
  assert.ok(!out.includes('lock_default'), 'lock_default retired from the UI');
  assert.match(out, /removeRetractEdge\(&quot;Front Door&quot;, 0, 0\)/, 'remove targets this door + trigger + edge');
  assert.match(out, /id="dfRelockWrap_[^"]*" style="display:none"/, 'relock-seconds input hidden outside relock_after');
});

test('a stale lock_default edge reads as stay unlocked', () => {
  const out = load()('Front Door', 0, edge({ after_unlock: 'lock_default' }), 0, LOCKS);
  assert.match(out, /class="chip active" data-df-after="stay_unlocked"/);
});

test('relock_after shows the seconds input with the stored value', () => {
  const out = load()('Front Door', 1, edge({ after_unlock: 'relock_after', relock_seconds: 90 }), 2, LOCKS);
  assert.match(out, /class="chip active" data-df-after="relock_after"/);
  assert.match(out, /value="90"/, 'stored relock seconds surface');
  assert.ok(!/id="dfRelockWrap_[^"]*" style="display:none"/.test(out), 'seconds input visible');
});

test('advanced fields live under a details expander with their stored values', () => {
  const out = load()('Front Door', 0, edge({ require_result: 'GRANTED', mirror_unlock: true, relock_cooldown_seconds: 25 }), 0, LOCKS);
  assert.match(out, /<details/, 'advanced is an expander (collapsed by default)');
  assert.match(out, /advanced/, 'advanced summary present');
  assert.match(out, /value="GRANTED"/, 'require_result editable');
  assert.match(out, /id="dfMirror_[^"]+" checked/, 'mirror_unlock reflects the stored flag');
  assert.match(out, /value="25"/, 'cooldown editable');
});

test('advanced carries a plain-language explainer alongside the fields', () => {
  const out = load()('Front Door', 0, edge(), 0, LOCKS);
  assert.match(out, /Require result only retracts/, 'require_result explained in visible text, not just a tooltip');
  assert.match(out, /Follow UniFi door unlocks also opens the deadbolt/);
  assert.match(out, /Relock cooldown gives a normal entry/);
});

test('a hardware auto-relock conflict is called out inline', () => {
  const quiet = load()('Front Door', 0, edge({ after_unlock: 'stay_unlocked' }), 0, LOCKS);
  assert.ok(!quiet.includes('notice-warn'), 'no warning without the conflict flag');
  const out = load()('Front Door', 0, edge({ after_unlock: 'stay_unlocked', hardware_conflict: true }), 0, LOCKS);
  assert.match(out, /notice-warn/, 'conflict renders a warning');
  assert.match(out, /hardware auto-relock is still on/i, 'explains why stay unlocked cannot hold yet');
  assert.match(out, /turning it off/i, 'reassures the app is resolving it');
});

test('an unpaired lock is badged, and unknown lock ids still render', () => {
  const ghost = load()('Front Door', 0, edge({ lock_id: 'ghost_bolt' }), 0, LOCKS);
  assert.match(ghost, /not paired/, 'saved-but-unpaired lock is flagged');
  const orphan = load()('Front Door', 0, edge({ lock_id: 'gone_bolt' }), 0, LOCKS);
  assert.match(orphan, /gone_bolt/, 'edge to a lock no longer saved still shows its id');
});

test('door names and values are escaped; edge ids are unique per door, trigger, and index', () => {
  const out = load()('Evil <img src=x>', 0, edge(), 3, LOCKS);
  assert.ok(!out.includes('<img src=x>'), 'door name escaped');
  const a = load()('Door A', 0, edge(), 0, LOCKS);
  const b = load()('Door A', 0, edge(), 1, LOCKS);
  const c = load()('Door A', 1, edge(), 0, LOCKS);
  const idOf = (s) => (s.match(/id="dfAfterRow_([^"]+)"/) || [])[1];
  assert.notEqual(idOf(a), idOf(b), 'two edges in one trigger get distinct control ids');
  assert.notEqual(idOf(a), idOf(c), 'the same edge index in different triggers is distinct');
});
