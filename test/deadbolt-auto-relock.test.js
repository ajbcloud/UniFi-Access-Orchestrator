'use strict';

// Guards buildAutoRelockControl: the After-unlock (auto-relock) control in the
// Smart Deadbolt panel. The ~30s re-lock after an unlock is the lock's OWN
// feature; the control must only appear for a paired lock, offer the toggle
// only when the driver reports a known configuration parameter, fall back to
// the catalog's per-model note otherwise, reflect the saved choice, and stay
// disabled while a pairing session owns the controller. Extracts the REAL
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
  const src = extractFn('escapeHtml') + '\n' + extractFn('buildAutoRelockControl');
  return new Function(src + '; return buildAutoRelockControl;')();
}

const SUPPORTED = { supported: true, model_key: 'schlage-be469zp', note: null, configured: null };

test('nothing renders when not paired or when the driver reports nothing', () => {
  const build = load();
  assert.strictEqual(build(null), '');
  assert.strictEqual(build({ paired: false, auto_relock_support: SUPPORTED }), '');
  assert.strictEqual(build({ paired: true }), '', 'no capability report -> no control');
});

test('unsupported model renders the catalog note instead of a control', () => {
  const build = load();
  const out = build({
    paired: true,
    auto_relock_support: { supported: false, note: 'set auto-lock timing in the U-tec app' },
  });
  assert.match(out, /U-tec app/);
  assert.ok(!out.includes('<select'), 'no toggle for a model without a parameter');
  assert.ok(!out.includes('<button'), 'no Apply for a model without a parameter');
});

test('supported model renders the toggle, Apply, and both choices', () => {
  const build = load();
  const out = build({ paired: true, auto_relock: null, auto_relock_support: SUPPORTED });
  assert.match(out, /Stay unlocked until locked/);
  assert.match(out, /Auto-relock \(lock timer\)/);
  assert.match(out, /onclick="applyAutoRelock\(\)"/);
  // never applied -> the placeholder is pre-selected so Apply is a no-op
  assert.match(out, /value="null" selected/);
});

test('the saved choice is pre-selected once applied', () => {
  const build = load();
  const off = build({ paired: true, auto_relock: false, auto_relock_support: SUPPORTED });
  assert.match(off, /value="false" selected/);
  assert.ok(!off.includes('value="null"'), 'placeholder disappears once a choice was applied');
  const on = build({ paired: true, auto_relock: true, auto_relock_support: SUPPORTED });
  assert.match(on, /value="true" selected/);
});

test('pairing_active disables the control', () => {
  const build = load();
  const out = build({ paired: true, pairing_active: true, auto_relock: false, auto_relock_support: SUPPORTED });
  assert.ok(/<select[^>]*\bdisabled\b/.test(out), 'select disabled while pairing');
  assert.ok(/<button[^>]*\bdisabled\b/.test(out), 'Apply disabled while pairing');
});
