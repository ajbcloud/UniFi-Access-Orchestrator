'use strict';

// Guards buildKeypadUsersPanel: the global Keypad users section of the Smart
// Deadbolt panel (one PIN per user, applied to every paired lock and always
// synced to UniFi). PIN digits must never appear (the server only sends
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
  const src = extractFn('escapeHtml') + '\n' + extractFn('buildKeypadUsersPanel');
  return new Function(src + '; return buildKeypadUsersPanel;')();
}

const LOCKS = [
  { lock_id: 'front_deadbolt', name: 'Front Door', supported: true, note: null },
  { lock_id: 'front_door', name: 'Yale', supported: true, note: null },
];
const RULE = { min: 4, max: 8, fixed: 4, conflict: false };
const USERS = [{ id: 'u-1', name: 'Alice' }, { id: 'u-2', name: 'Bob <b>' }];

test('no supported lock renders the catalog note, no controls', () => {
  const build = load();
  const out = build({
    locks: [{ lock_id: 'a', name: 'A', supported: false, note: 'manage keypad codes in the U-tec app' }],
    pin_rule: {},
    users: [],
  }, USERS, false);
  assert.match(out, /U-tec app/);
  assert.ok(!out.includes('<select'), 'no user picker');
  assert.ok(!out.includes('<input'), 'no PIN input');
  assert.strictEqual(build({ locks: [], pin_rule: {}, users: [] }, USERS, false), '', 'no locks -> nothing');
});

test('supported locks render the length rule, picker, PIN input, and lock names', () => {
  const build = load();
  const out = build({ locks: LOCKS, pin_rule: RULE, users: [] }, USERS, false);
  assert.match(out, /One PIN per user/);
  assert.match(out, /4-digit codes/);
  assert.match(out, /Front Door/);
  assert.match(out, /Yale/);
  assert.match(out, /id="kuUser"/);
  assert.match(out, /id="kuPin"/);
  assert.match(out, /onclick="saveKeypadUser\(\)"/);
  assert.match(out, /Alice/);
});

test('users render masked with per-lock status and badges; digits never appear', () => {
  const build = load();
  const out = build({
    locks: LOCKS,
    pin_rule: RULE,
    users: [
      {
        user_id: 'u-1', name: 'Alice', pin_length: 4, in_unifi: true, user_missing: false,
        locks: [
          { lock_id: 'front_deadbolt', slot: 3, status: 'ok' },
          { lock_id: 'front_door', slot: 1, status: 'pending' },
        ],
      },
      {
        user_id: 'u-9', name: 'Ghost <i>', pin_length: 6, in_unifi: false, user_missing: true,
        locks: [
          { lock_id: 'front_deadbolt', slot: null, status: 'missing' },
          { lock_id: 'front_door', slot: 2, status: 'differs' },
        ],
      },
    ],
  }, USERS, false);
  assert.match(out, /\*{4}/, 'masked to the code length');
  assert.match(out, /\*{6}/);
  assert.ok(!/[0-9]{4,}/.test(out.replace(/maxlength="10"/g, '')), 'no PIN-like digit runs');
  assert.match(out, />UniFi</, 'in-sync badge');
  assert.match(out, /UniFi not synced/, 'out-of-sync badge');
  assert.match(out, /user missing/, 'stale badge');
  assert.match(out, /Ghost &lt;i&gt;/, 'names escaped');
  assert.match(out, /pending/, 'pending status shown');
  assert.match(out, /old PIN/, 'differs status shown');
  assert.match(out, /missing/, 'missing status shown');
  assert.match(out, /onclick="removeKeypadUser\(&quot;u-9&quot;\)"/);
});

test('pairing_active disables every control', () => {
  const build = load();
  const out = build({
    locks: LOCKS,
    pin_rule: RULE,
    users: [{
      user_id: 'u-1', name: 'A', pin_length: 4, in_unifi: false, user_missing: false,
      locks: [{ lock_id: 'front_deadbolt', slot: 1, status: 'ok' }],
    }],
  }, USERS, true);
  const controls = out.match(/<(button|select|input)[^>]*>/g) || [];
  assert.ok(controls.length >= 4, 'expected several controls');
  for (const c of controls) {
    assert.ok(/\bdisabled\b/.test(c), `control should be disabled while pairing: ${c}`);
  }
});

test('flexible-length locks describe the range; conflicting fixed lengths warn', () => {
  const build = load();
  const flexible = build({ locks: LOCKS, pin_rule: { min: 4, max: 8, fixed: null, conflict: false }, users: [] }, USERS, false);
  assert.match(flexible, /4 to 8 digit codes/);
  const conflicted = build({ locks: LOCKS, pin_rule: { min: 4, max: 8, fixed: 4, conflict: true }, users: [] }, USERS, false);
  assert.match(conflicted, /different fixed code lengths/);
});
