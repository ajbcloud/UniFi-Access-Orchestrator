'use strict';

// Guards buildLockCard: the per-lock card that carries a paired lock's
// identity, live badges, action buttons, and after-unlock control in the
// multi-lock Smart Deadbolt panel. Two locks must render two fully
// independent cards with their own lock_id threaded through every control.
// Extracts the REAL functions from public/index.html via the shared
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
  // 'buildLockCard(' with the paren: a bare 'buildLockCard' would match
  // 'buildLockCardButtons' first (prefix collision).
  const deps = ['escapeHtml', 'cssId', 'describeLockBolt', 'describeLockBattery',
    'describeLockLink', 'describeLockModel', 'describeLockSecurity',
    'buildAutoRelockControl', 'buildLockCardButtons', 'buildLockCard('];
  const src = deps.map(extractFn).join('\n');
  return new Function(src + '; return buildLockCard;')();
}

function summary(overrides = {}) {
  return Object.assign({
    lock_id: 'front_deadbolt',
    name: 'Front Door',
    node_id: 14,
    paired: true,
    configured: true,
    pairing_active: false,
    bound: true,
    automated: true,
    trigger_door: 'Front Door',
    lock_state: { boltState: 'locked', battery: 90, batteryLow: false, linkState: 'online', model: 'Schlage BE469ZP Touchscreen Deadbolt', securityClass: 'S2 Access Control', name: 'Front Door' },
    auto_relock: false,
    auto_relock_support: { supported: true, note: null, configured: false },
  }, overrides);
}

test('a card carries identity, live badges, buttons, and the after-unlock control', () => {
  const build = load();
  const out = build(summary());
  assert.match(out, /id="zwaveLockCard_front_deadbolt"/);
  assert.match(out, /Front Door/);
  assert.match(out, /node 14/);
  assert.match(out, /retracts on entry at <strong>Front Door<\/strong>/);
  assert.match(out, /Test Lock/);
  assert.match(out, /After unlock:/);
  assert.match(out, /id="zwaveAutoRelockSel_front_deadbolt"/, 'auto-relock select id is per-lock');
  assert.match(out, /applyAutoRelock\(&quot;front_deadbolt&quot;\)/, 'apply targets this lock');
  assert.match(out, /id="zwaveUserCodes_front_deadbolt"/, 'keypad-codes container is per-lock');
});

test('a manual-only (not automated) lock says so instead of claiming a trigger', () => {
  const build = load();
  const out = build(summary({ automated: false, trigger_door: null }));
  assert.match(out, /Not automated: manual control only/);
  assert.ok(!out.includes('retracts on entry at'));
});

test('two locks render two independent cards with distinct ids and handlers', () => {
  const build = load();
  const a = build(summary());
  const b = build(summary({ lock_id: 'side_deadbolt', name: 'Side Door', node_id: 17, trigger_door: 'Side Door' }));
  assert.match(a, /zwaveLockCard_front_deadbolt/);
  assert.match(b, /zwaveLockCard_side_deadbolt/);
  assert.match(b, /deadboltControl\('unlock', &quot;side_deadbolt&quot;\)/);
  assert.ok(!b.includes('front_deadbolt'), 'no cross-contamination between cards');
  assert.match(b, /startUnpairNode\(17\)/);
});

test('names are escaped and pairing_active disables the whole card', () => {
  const build = load();
  const out = build(summary({ name: 'Evil <img src=x>', pairing_active: true }));
  assert.ok(!out.includes('<img src=x>'), 'name escaped');
  assert.match(out, /Evil &lt;img src=x&gt;/);
  for (const b of (out.match(/<button[^>]*>/g) || [])) {
    assert.ok(/\bdisabled\b/.test(b), `card control should be disabled while pairing: ${b}`);
  }
});
