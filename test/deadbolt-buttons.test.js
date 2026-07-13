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

test('not configured: no buttons', () => {
  const build = load();
  assert.strictEqual(build({ configured: false }), '');
  assert.strictEqual(build({}), '');
  assert.strictEqual(build(null), '');
});

test('configured + not paired: Pair New Lock AND Unpair / Exclude Device', () => {
  const build = load();
  const out = build({ configured: true, paired: false });
  assert.match(out, /onclick="startPairing\(\)"/);
  assert.match(out, /Pair New Lock/);
  assert.match(out, /onclick="startUnpair\(\)"/);
  assert.match(out, /Unpair \/ Exclude Device/);
  // no lock-control buttons in this state
  assert.ok(!out.includes('Test Lock'));
});

test('configured + paired: Test Lock / Test Unlock / Unpair, no Pair', () => {
  const build = load();
  const out = build({ configured: true, paired: true, node_id: 8, lock_id: 'front' });
  assert.match(out, /Test Lock/);
  assert.match(out, /Test Unlock/);
  assert.match(out, /onclick="startUnpair\(\)"/);
  assert.ok(!out.includes('Pair New Lock'), 'no Pair New Lock while paired');
});

test('pairing_active disables every button in both configured states', () => {
  const build = load();
  for (const paired of [true, false]) {
    const out = build({ configured: true, paired, pairing_active: true });
    const buttons = out.match(/<button[^>]*>/g) || [];
    assert.ok(buttons.length >= 2, 'expected multiple buttons');
    for (const b of buttons) {
      assert.ok(/\bdisabled\b/.test(b), `button should be disabled while pairing_active: ${b}`);
    }
  }
  // and enabled when idle
  const idle = build({ configured: true, paired: false, pairing_active: false });
  assert.ok(!/\bdisabled\b/.test(idle), 'no disabled buttons when idle');
});
