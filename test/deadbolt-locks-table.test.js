'use strict';

// Guards buildDeadboltLocksTable: the Smart Deadbolt panel's paired-locks
// inventory. Every saved lock and every unmanaged node on the stick must be
// visible, each row individually unpairable, and operator-typed lock ids
// escaped. Extracts the REAL functions from public/index.html via the shared
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
  const src = extractFn('escapeHtml') + '\n' + extractFn('describeLockBolt')
    + '\n' + extractFn('buildDeadboltLocksTable');
  return new Function(src + '; return buildDeadboltLocksTable;')();
}

test('empty or missing inventory renders nothing', () => {
  const build = load();
  assert.strictEqual(build([], false), '');
  assert.strictEqual(build(null, false), '');
});

test('a bound paired lock shows state and its own Unpair button', () => {
  const build = load();
  const out = build([{
    lock_id: 'front_deadbolt', node_id: 10, paired: true, on_stick: true,
    bolt: 'locked', battery: 88, battery_low: false, link_state: 'online',
  }], false);
  assert.match(out, /front_deadbolt/);
  assert.match(out, /node 10/);
  assert.match(out, /locked \/ 88% \/ online/);
  assert.match(out, /onclick="startUnpairNode\(10\)"/);
});

test('model, security class, and friendly name render; name wins the first cell', () => {
  const build = load();
  const out = build([{
    lock_id: 'front_deadbolt', name: 'Front Door Deadbolt', node_id: 10, paired: true, on_stick: true,
    model: 'Yale Assure Deadbolt (ZW2)', security_class: 'S0 Legacy',
    bolt: 'locked', battery: 88, battery_low: false, link_state: 'online',
  }], false);
  assert.match(out, /Front Door Deadbolt/);
  assert.match(out, /Yale Assure Deadbolt \(ZW2\)/);
  assert.match(out, /S0 Legacy/);
});

test('a paired lock with no identity yet shows identifying, not unknown', () => {
  const build = load();
  const out = build([{
    lock_id: 'front_deadbolt', node_id: 10, paired: true, on_stick: true,
    model: null, security_class: null,
    bolt: 'unknown', battery: null, battery_low: false, link_state: 'online',
  }], false);
  assert.match(out, /identifying\.\.\./);
  assert.match(out, /reading\.\.\./, 'link up + unread bolt shows reading, not unknown');
});

test('a foreign node on the stick is visible and unpairable', () => {
  const build = load();
  const out = build([{
    lock_id: null, node_id: 7, paired: false, on_stick: true, foreign: true,
    bolt: null, battery: null, battery_low: false, link_state: null,
  }], false);
  assert.match(out, /unrecognized device/);
  assert.match(out, /on stick, not managed/);
  assert.match(out, /onclick="startUnpairNode\(7\)"/);
});

test('a saved-but-unpaired lock gets Remove instead of Unpair', () => {
  const build = load();
  const out = build([{
    lock_id: 'front_deadbolt', node_id: 0, paired: false, on_stick: false,
    bolt: null, battery: null, battery_low: false, link_state: null,
  }], false);
  assert.match(out, /not paired/);
  assert.ok(!out.includes('startUnpairNode'), 'nothing to unpair');
  assert.match(out, /onclick="removeSavedLock\(&quot;front_deadbolt&quot;\)"/, 'ghost rows are removable');
});

test('a foreign node row (no saved id) gets neither Remove nor a broken Unpair', () => {
  const build = load();
  const out = build([{
    lock_id: null, node_id: 0, paired: false, on_stick: false,
    bolt: null, battery: null, battery_low: false, link_state: null,
  }], false);
  assert.ok(!out.includes('removeSavedLock'), 'no saved entry to remove');
  assert.ok(!out.includes('startUnpairNode'));
});

test('operator-typed lock ids are escaped', () => {
  const build = load();
  const out = build([{
    lock_id: '<img src=x onerror=alert(1)>', node_id: 3, paired: true, on_stick: true,
    bolt: 'locked', battery: 50, battery_low: false, link_state: 'online',
  }], false);
  assert.ok(!out.includes('<img'), 'raw HTML must not survive');
  assert.match(out, /&lt;img/);
});

test('per-model exclude + reset gestures show as the Unpair tooltip when a catalog is passed', () => {
  const build = load();
  const catalog = [{
    manufacturer: 'Yale',
    models: [{ key: 'yale-assure-zw2', name: 'Yale Assure (ZW2)',
      exclude: 'Master PIN # 7 # 3 #', reset: 'hold reset while repowering' }],
  }];
  const out = build([{
    lock_id: 'front_deadbolt', node_id: 10, paired: true, on_stick: true, model_key: 'yale-assure-zw2',
    bolt: 'locked', battery: 88, battery_low: false, link_state: 'online',
  }], false, catalog);
  assert.match(out, /title="Exclude: Master PIN # 7 # 3 #/);
  assert.match(out, /Factory reset: hold reset while repowering/);
});

test('no catalog -> a plain Unpair button with no tooltip (back-compat 2-arg call)', () => {
  const build = load();
  const out = build([{
    lock_id: 'front_deadbolt', node_id: 10, paired: true, on_stick: true, model_key: 'yale-assure-zw2',
    bolt: 'locked', battery: 88, battery_low: false, link_state: 'online',
  }], false);
  assert.match(out, /onclick="startUnpairNode\(10\)"/);
  assert.ok(!out.includes('title="Exclude'));
});

test('the Door Flows editor offers no unpaired ghost in the add-deadbolt picker', () => {
  // Source-level contract on buildDoorFlowCard: only paired or bound locks
  // are usable targets for a new retract edge, so an unpaired ghost (or a
  // saved-but-dead entry) can never be wired to a door. Dev FakeLock
  // bindings read as bound and stay offered.
  const src = extractFn('buildDoorFlowCard');
  assert.match(src, /l\.paired \|\| l\.bound/, 'usable-lock filter present');
  assert.match(src, /freeLocks/, 'already-wired locks are excluded from the picker');
});

test('pairing_active disables every Unpair button', () => {
  const build = load();
  const out = build([
    { lock_id: 'a', node_id: 3, paired: true, on_stick: true, bolt: 'locked', battery: 50, battery_low: false, link_state: 'online' },
    { lock_id: null, node_id: 7, paired: false, on_stick: true, foreign: true, bolt: null, battery: null, battery_low: false, link_state: null },
  ], true);
  const buttons = out.match(/<button[^>]*>/g) || [];
  assert.ok(buttons.length >= 2);
  for (const b of buttons) assert.ok(/\bdisabled\b/.test(b), `disabled while pairing: ${b}`);
});
