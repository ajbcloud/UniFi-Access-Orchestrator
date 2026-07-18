'use strict';

// Guards buildDeadboltButtons: the deadbolt action-button row must offer
// Unpair / Exclude Device even when nothing is saved as paired, because a
// failed S2 inclusion can leave a live node on the controller that blocks the
// next pairing and can only be cleared by exclusion. Extracts the REAL
// function from public/index.html via the shared extractFn harness.

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
  const src = extractFn('buildDeadboltButtons');
  return new Function(src + '; return buildDeadboltButtons;')();
}

// Per-lock card buttons (the paired lock's controls moved onto its card).
function loadCardButtons() {
  const src = extractFn('escapeHtml') + '\n' + extractFn('cssId') + '\n' + extractFn('buildLockCardButtons');
  return new Function(src + '; return buildLockCardButtons;')();
}

const CARD_LOCK = { lock_id: 'front_deadbolt', node_id: 14, pairing_active: false };

test('not configured: no buttons', () => {
  const build = load();
  assert.strictEqual(build({ configured: false }), '');
  assert.strictEqual(build({}), '');
  assert.strictEqual(build(null), '');
});

test('configured + not paired: only Unpair / Exclude Device (pairing lives in the Add a deadbolt picker)', () => {
  const build = load();
  const out = build({ configured: true, paired: false });
  assert.match(out, /onclick="startUnpair\(\)"/);
  assert.match(out, /Unpair \/ Exclude Device/);
  // The security dropdown and the redundant Pair button were removed; pairing
  // is driven entirely by the manufacturer picker's "Pair this deadbolt".
  assert.ok(!out.includes('Pair New Lock'), 'the redundant Pair New Lock button is gone');
  assert.ok(!out.includes('startPairing'), 'the pair row no longer triggers pairing');
  assert.ok(!out.includes('zwavePairSecurity'), 'the Yale/Schlage security dropdown is gone');
  // no lock-control buttons in this state
  assert.ok(!out.includes('Test Lock'));
});

test('configured + paired: the TOP row is empty (controls live on per-lock cards)', () => {
  const build = load();
  const out = build({ configured: true, paired: true, node_id: 8, lock_id: 'front' });
  assert.strictEqual(out, '', 'paired locks carry their buttons on their own cards');
});

test('lock card buttons: full control set with the lock_id threaded through', () => {
  const build = loadCardButtons();
  const out = build(CARD_LOCK);
  assert.match(out, /Test Lock/);
  assert.match(out, /Test Unlock/);
  assert.match(out, /Re-interview \/ Heal/);
  assert.match(out, /Health Check/);
  assert.match(out, /deadboltControl\('lock', &quot;front_deadbolt&quot;\)/);
  assert.match(out, /deadboltControl\('unlock', &quot;front_deadbolt&quot;\)/);
  assert.match(out, /startReinterview\(&quot;front_deadbolt&quot;\)/);
  assert.match(out, /startHealthCheck\(&quot;front_deadbolt&quot;\)/);
  assert.match(out, /startUnpairNode\(14\)/, 'per-card unpair targets the lock\'s own node');
});

test('card action buttons carry expected-result tooltips', () => {
  const build = loadCardButtons();
  const out = build(CARD_LOCK);
  const buttons = out.match(/<button[^>]*>/g) || [];
  assert.ok(buttons.length >= 5, 'full control set present');
  for (const b of buttons) {
    assert.ok(/title="[^"]+"/.test(b), `button needs a tooltip stating the expected result: ${b}`);
  }
  assert.match(out, /within a few seconds/i, 'test buttons state the expected timing');
  assert.match(out, /auto-relock/i, 'the unlock tooltip explains the ~30s self re-lock');
});

test('pairing_active disables every button (pair row and lock cards)', () => {
  const build = load();
  const out = build({ configured: true, paired: false, pairing_active: true });
  const buttons = out.match(/<button[^>]*>/g) || [];
  assert.ok(buttons.length >= 1, 'expected at least the Unpair / Exclude button');
  for (const b of buttons) {
    assert.ok(/\bdisabled\b/.test(b), `button should be disabled while pairing_active: ${b}`);
  }
  const idle = build({ configured: true, paired: false, pairing_active: false });
  assert.ok(!/\bdisabled\b/.test(idle), 'no disabled buttons when idle');

  const cardButtons = loadCardButtons()(Object.assign({}, CARD_LOCK, { pairing_active: true }));
  for (const b of (cardButtons.match(/<button[^>]*>/g) || [])) {
    assert.ok(/\bdisabled\b/.test(b), `card button should be disabled while pairing_active: ${b}`);
  }
});
