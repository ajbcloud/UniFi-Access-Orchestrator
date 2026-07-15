'use strict';

// Guards buildUserCodesPanel: the Keypad PIN codes section of the Smart
// Deadbolt panel. PIN digits must never appear (the server only sends
// pin_length), names are operator/UniFi-derived and must be escaped,
// unsupported models show their catalog note instead of controls, and the
// whole panel goes inert while a pairing session owns the controller.
// Extracts the REAL function from public/index.html via the shared extractFn
// harness.

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
  const src = extractFn('escapeHtml') + '\n' + extractFn('buildUserCodesPanel');
  return new Function(src + '; return buildUserCodesPanel;')();
}

const CAP = {
  supported: true,
  slots: 30,
  min_length: 4,
  max_length: 8,
  fixed_length: true,
  configured_length: 4,
  codes: [],
};
const USERS = [{ id: 'u-1', name: 'Alice' }, { id: 'u-2', name: 'Bob <b>' }];

test('unsupported model renders the catalog note, no controls', () => {
  const build = load();
  const out = build({ supported: false, note: 'manage keypad codes in the U-tec app' }, USERS, false);
  assert.match(out, /U-tec app/);
  assert.ok(!out.includes('<select'), 'no user picker');
  assert.ok(!out.includes('<input'), 'no PIN input');
  assert.strictEqual(build({ supported: false }, USERS, false), '', 'no note -> nothing');
});

test('supported model renders slot usage, length rule, picker, and PIN input', () => {
  const build = load();
  const out = build(CAP, USERS, false);
  assert.match(out, /0 of 30 slots used/);
  assert.match(out, /4-digit codes/);
  assert.match(out, /id="ucUser"/);
  assert.match(out, /id="ucPin"/);
  assert.match(out, /onclick="saveUserCode\(\)"/);
  assert.match(out, /Alice/);
  assert.ok(!out.includes('Rewrite Codes'), 'no rewrite button with zero codes');
});

test('assigned codes render masked with badges; digits never appear', () => {
  const build = load();
  const info = Object.assign({}, CAP, {
    codes: [
      { slot: 3, user_id: 'u-1', name: 'Alice', pin_length: 4, pushed_to_unifi: true, user_missing: false },
      { slot: 7, user_id: 'u-9', name: 'Ghost <i>', pin_length: 6, pushed_to_unifi: false, user_missing: true },
    ],
  });
  const out = build(info, USERS, false);
  assert.match(out, /\*{4}/, 'masked to the code length');
  assert.match(out, /\*{6}/);
  assert.ok(!/[0-9]{4,}/.test(out.replace(/slot \d+|of 30|4-digit|maxlength="10"/g, '')), 'no PIN-like digit runs');
  assert.match(out, />UniFi</, 'pushed badge');
  assert.match(out, /user missing/, 'stale badge');
  assert.match(out, /Ghost &lt;i&gt;/, 'names escaped');
  assert.match(out, /onclick="removeUserCode\(7\)"/);
  assert.match(out, /Rewrite Codes to Lock/);
});

test('pairing_active disables every control', () => {
  const build = load();
  const info = Object.assign({}, CAP, {
    codes: [{ slot: 1, name: 'A', pin_length: 4, pushed_to_unifi: false, user_missing: false }],
  });
  const out = build(info, USERS, true);
  const controls = out.match(/<(button|select|input)[^>]*>/g) || [];
  assert.ok(controls.length >= 4, 'expected several controls');
  for (const c of controls) {
    assert.ok(/\bdisabled\b/.test(c), `control should be disabled while pairing: ${c}`);
  }
});

test('flexible-length models describe the range instead of a fixed length', () => {
  const build = load();
  const out = build(Object.assign({}, CAP, { fixed_length: false, configured_length: null }), USERS, false);
  assert.match(out, /4 to 8 digit codes/);
});
