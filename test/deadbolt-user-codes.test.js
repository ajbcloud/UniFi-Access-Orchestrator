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
  const src = extractFn('escapeHtml')
    + '\n' + extractFn('keypadBlockedLabel')
    + '\n' + extractFn('keypadLockBadge')
    + '\n' + extractFn('buildKeypadUsersPanel');
  return new Function(src + '; return buildKeypadUsersPanel;')();
}

const LOCKS = [
  { lock_id: 'front_deadbolt', name: 'Front Door', supported: true, note: null, gating_door: 'Door A' },
  { lock_id: 'front_door', name: 'Yale', supported: true, note: null, gating_door: 'Door B' },
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

test('picker sources from agg.available_users when present (server-fresh)', () => {
  const build = load();
  const out = build({
    locks: LOCKS,
    pin_rule: RULE,
    available_users: [{ id: 'srv-1', name: 'ServerUser <s>' }],
    users: [],
  }, USERS, false);
  assert.match(out, /value="srv-1"/, 'server-supplied user is pickable');
  assert.match(out, /ServerUser &lt;s&gt;/, 'server-supplied names escaped');
  assert.ok(!out.includes('value="u-1"'), 'stale usersData snapshot ignored when the server list exists');
});

test('picker falls back to the users param when available_users is absent/empty', () => {
  const build = load();
  const absent = build({ locks: LOCKS, pin_rule: RULE, users: [] }, USERS, false);
  assert.match(absent, /value="u-1"/, 'fallback to usersData when the key is absent');
  const empty = build({ locks: LOCKS, pin_rule: RULE, available_users: [], users: [] }, USERS, false);
  assert.match(empty, /value="u-1"/, 'empty server list also falls back');
});

test('picker shows a not-synced hint when both user sources are empty', () => {
  const build = load();
  const out = build({ locks: LOCKS, pin_rule: RULE, available_users: [], users: [] }, [], false);
  assert.match(out, /UniFi users not synced yet/, 'hint instead of a silently empty dropdown');
  const withUsers = build({ locks: LOCKS, pin_rule: RULE, available_users: [{ id: 'x', name: 'X' }], users: [] }, [], false);
  assert.ok(!withUsers.includes('UniFi users not synced yet'), 'no picker hint once users exist');
});

test('gating: blocked status renders a blocked badge naming the door', () => {
  const build = load();
  const out = build({
    locks: LOCKS,
    pin_rule: RULE,
    access_gating: { available: true, incomplete_users: 0 },
    users: [{
      user_id: 'u-1', name: 'Alice', pin_length: 4, in_unifi: true, user_missing: false,
      locks: [
        { lock_id: 'front_deadbolt', slot: 3, status: 'ok' },
        { lock_id: 'front_door', slot: null, status: 'blocked' },
      ],
    }],
  }, USERS, false);
  assert.match(out, /blocked/, 'blocked badge shown');
  assert.match(out, /Door B/, 'names the door the user cannot access');
  assert.match(out, /Access-gated:/, 'header explains gating');
});

test('gating: blocked badge distinguishes code present, pending, and removed', () => {
  const build = load();
  const out = build({
    locks: LOCKS,
    pin_rule: RULE,
    access_gating: { available: true, incomplete_users: 0 },
    users: [
      {
        user_id: 'u-1', name: 'Alice', pin_length: 4, in_unifi: true, user_missing: false,
        locks: [{ lock_id: 'front_door', slot: 3, status: 'blocked', code_present: true, revoke_pending: false }],
      },
      {
        user_id: 'u-2', name: 'Bob', pin_length: 4, in_unifi: true, user_missing: false,
        locks: [{ lock_id: 'front_door', slot: null, status: 'blocked', code_present: false, revoke_pending: true }],
      },
      {
        user_id: 'u-3', name: 'Cara', pin_length: 4, in_unifi: true, user_missing: false,
        locks: [{ lock_id: 'front_door', slot: null, status: 'blocked', code_present: false, revoke_pending: false }],
      },
    ],
  }, USERS, false);
  assert.match(out, /blocked, code still on lock/, 'code_present says the code is still on the lock');
  assert.match(out, /blocked, removal pending/, 'revoke_pending says the clear is queued');
  assert.match(out, /blocked, code removed/, 'neither flag says the code was cleared');
});

test('gating: warning banner when access policies are unavailable', () => {
  const build = load();
  const out = build({
    locks: LOCKS,
    pin_rule: RULE,
    access_gating: { available: false, incomplete_users: 0, error: null },
    users: [],
  }, USERS, false);
  assert.match(out, /Access policies not synced/, 'banner warns gating is not enforced');
});

test('gating: banner notes incomplete users fail open', () => {
  const build = load();
  const out = build({
    locks: LOCKS,
    pin_rule: RULE,
    access_gating: { available: true, incomplete_users: 2 },
    users: [],
  }, USERS, false);
  assert.match(out, /fail open/, 'incomplete users are never blocked');
});

test('gating: no banner and no Access-gated line when no lock has a door', () => {
  const build = load();
  const ungatedLocks = LOCKS.map((l) => Object.assign({}, l, { gating_door: null }));
  const out = build({
    locks: ungatedLocks,
    pin_rule: RULE,
    access_gating: { available: false, incomplete_users: 0 },
    users: [],
  }, USERS, false);
  assert.ok(!out.includes('Access policies not synced'), 'no gating -> no warning even if data missing');
  assert.ok(!out.includes('Access-gated:'), 'no gating line when no door is set');
});
