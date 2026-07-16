'use strict';

// Guards src/keypad-users.js: the one-PIN-per-user planning layer. Canonical
// PIN is the newest entry across locks; the aggregate never exposes digits
// (pin_length only); planUserSave reuses slots, respects reserved slots and
// per-lock length/duplicate rules; planNewLockProvision seeds a fresh lock
// from every other lock's users without double-assigning slots or PINs.

const test = require('node:test');
const assert = require('node:assert');
const {
  canonicalPins,
  aggregateKeypadUsers,
  combinedLengthRule,
  planUserSave,
  planNewLockProvision,
} = require('../src/keypad-users');

const CAP = { supported: true, slots: 30, min_length: 4, max_length: 8 };

function locksCfg() {
  return {
    front: {
      node_id: 14,
      user_codes: {
        1: { user_id: 'u1', name: 'Alice', pin_code: '1111', pushed_to_unifi: false, updated_at: '2026-07-15T02:00:00Z' },
        2: { user_id: 'u2', name: 'Bob', pin_code: '2222', pushed_to_unifi: true, updated_at: '2026-07-15T03:00:00Z' },
      },
    },
    side: {
      node_id: 15,
      user_codes: {
        1: { user_id: 'u1', name: 'Alice', pin_code: '9999', pushed_to_unifi: true, updated_at: '2026-07-15T05:00:00Z', confirmed: true },
      },
    },
  };
}

test('canonicalPins: newest updated_at wins across locks', () => {
  const canon = canonicalPins(locksCfg());
  assert.equal(canon.get('u1').pin, '9999', 'side lock entry is newer');
  assert.equal(canon.get('u1').source_lock, 'side');
  assert.equal(canon.get('u1').pushed_to_unifi, true);
  assert.equal(canon.get('u2').pin, '2222');
});

test('canonicalPins: an older same-PIN pushed entry still counts as in-UniFi', () => {
  const cfg = {
    a: { user_codes: { 1: { user_id: 'u1', pin_code: '1234', pushed_to_unifi: true, updated_at: '2026-01-01T00:00:00Z' } } },
    b: { user_codes: { 1: { user_id: 'u1', pin_code: '1234', pushed_to_unifi: false, updated_at: '2026-02-01T00:00:00Z' } } },
  };
  const canon = canonicalPins(cfg);
  assert.equal(canon.get('u1').pin, '1234');
  assert.equal(canon.get('u1').pushed_to_unifi, true, 'same PIN pushed earlier means UniFi holds it');
});

test('aggregateKeypadUsers: per-lock status and pin_length only (no digits)', () => {
  const relevant = [{ lock_id: 'front', label: 'Front' }, { lock_id: 'side', label: 'Side' }];
  const users = aggregateKeypadUsers(locksCfg(), relevant);
  const alice = users.find((u) => u.user_id === 'u1');
  const bob = users.find((u) => u.user_id === 'u2');
  assert.equal(alice.pin_length, 4);
  assert.ok(!JSON.stringify(users).includes('9999'), 'digits never appear');
  assert.deepEqual(alice.locks, [
    { lock_id: 'front', slot: 1, status: 'differs', code_present: true, revoke_pending: false },  // holds old 1111
    { lock_id: 'side', slot: 1, status: 'ok', code_present: true, revoke_pending: false },
  ]);
  assert.deepEqual(bob.locks, [
    { lock_id: 'front', slot: 2, status: 'ok', code_present: true, revoke_pending: false },       // pre-confirmed-field entry reads ok
    { lock_id: 'side', slot: null, status: 'missing', code_present: false, revoke_pending: false },
  ]);
  assert.equal(alice.in_unifi, true);
});

test('aggregateKeypadUsers: confirmed null/false reads pending', () => {
  const cfg = {
    a: { user_codes: { 3: { user_id: 'u1', name: 'A', pin_code: '4321', updated_at: '2026-01-01T00:00:00Z', confirmed: null } } },
  };
  const users = aggregateKeypadUsers(cfg, [{ lock_id: 'a', label: 'A' }]);
  assert.equal(users[0].locks[0].status, 'pending');
});

test('aggregateKeypadUsers: code_present reflects a held slot', () => {
  const cfg = {
    a: { user_codes: { 1: { user_id: 'u1', name: 'A', pin_code: '1111', updated_at: '2026-01-01T00:00:00Z', confirmed: true } } },
    b: { user_codes: {} },
  };
  const relevant = [{ lock_id: 'a', label: 'A' }, { lock_id: 'b', label: 'B' }];
  const u1 = aggregateKeypadUsers(cfg, relevant).find((u) => u.user_id === 'u1');
  const byLock = Object.fromEntries(u1.locks.map((l) => [l.lock_id, l]));
  assert.equal(byLock.a.code_present, true, 'a held slot means a code is on the lock');
  assert.equal(byLock.b.code_present, false, 'no held slot means no code');
});

test('aggregateKeypadUsers: revoke_pending reflects a pending_clears marker', () => {
  const cfg = {
    a: {
      user_codes: {},
      pending_clears: { 3: { user_id: 'u1', requested_at: '2026-01-01T00:00:00Z', reason: 'no UniFi access' } },
    },
  };
  const u1 = aggregateKeypadUsers(cfg, [{ lock_id: 'a', label: 'A' }]).find((u) => u.user_id === 'u1');
  // The user still surfaces via the marker even though the code entry is gone.
  const lock = u1 ? u1.locks[0] : null;
  assert.ok(lock, 'the user with a pending clear is still listed');
  assert.equal(lock.revoke_pending, true, 'the pending clear marker is surfaced');
  assert.equal(lock.code_present, false, 'the managed entry was already removed');
});

test('aggregateKeypadUsers: verdicts surface blocked (denied) and unknown eligibility', () => {
  const cfg = {
    a: { user_codes: { 1: { user_id: 'u1', name: 'A', pin_code: '1111', updated_at: '2026-01-01T00:00:00Z', confirmed: true } } },
    b: { user_codes: { 1: { user_id: 'u1', name: 'A', pin_code: '1111', updated_at: '2026-01-01T00:00:00Z', confirmed: true } } },
    c: { user_codes: {} },
  };
  const relevant = [
    { lock_id: 'a', label: 'A', gating_door: 'Door A' },
    { lock_id: 'b', label: 'B', gating_door: 'Door B' },
    { lock_id: 'c', label: 'C', gating_door: 'Door C' },
  ];
  const verdicts = new Map([
    ['u1|a', 'allowed'],
    ['u1|b', 'denied'],
    ['u1|c', 'unknown'],
  ]);
  const users = aggregateKeypadUsers(cfg, relevant, verdicts);
  const u1 = users.find((u) => u.user_id === 'u1');
  const byLock = Object.fromEntries(u1.locks.map((l) => [l.lock_id, l]));
  assert.equal(byLock.a.status, 'ok', 'allowed + holds current PIN stays ok');
  assert.equal(byLock.b.status, 'blocked', 'denied overrides the code status');
  assert.equal(byLock.c.status, 'missing', 'unknown keeps the code status');
  assert.equal(byLock.c.eligibility, 'unknown', 'unknown is flagged, never blocked');
});

test('combinedLengthRule: tightest min/max, fixed length, and conflicts', () => {
  assert.deepEqual(
    combinedLengthRule([{ supported: true, min_length: 4, max_length: 8 }, { supported: true, min_length: 6, max_length: 10 }]),
    { min: 6, max: 8, fixed: null, conflict: false }
  );
  assert.deepEqual(
    combinedLengthRule([{ supported: true, fixed_length: true, configured_length: 4 }]),
    { min: 4, max: 10, fixed: 4, conflict: false }
  );
  const conflicted = combinedLengthRule([
    { supported: true, fixed_length: true, configured_length: 4 },
    { supported: true, fixed_length: true, configured_length: 6 },
  ]);
  assert.equal(conflicted.conflict, true);
});

test('planUserSave: reuses the user\'s slot, else lowest free skipping reserved', () => {
  const cfg = locksCfg();
  const caps = [
    { lock_id: 'front', cap: CAP },
    { lock_id: 'side', cap: Object.assign({}, CAP, { reserved_slots: [2] }) },
  ];
  const plan = planUserSave(cfg, caps, 'u1', '7777');
  assert.deepEqual(plan, [
    { lock_id: 'front', slot: 1 }, // reuse
    { lock_id: 'side', slot: 1 },  // reuse
  ]);
  const planNew = planUserSave(cfg, caps, 'u3', '7777');
  assert.deepEqual(planNew, [
    { lock_id: 'front', slot: 3 }, // 1 and 2 taken
    { lock_id: 'side', slot: 3 },  // 1 taken, 2 reserved
  ]);
});

test('planUserSave: per-lock errors for duplicates, lengths, capacity, unsupported', () => {
  const cfg = locksCfg();
  const dup = planUserSave(cfg, [{ lock_id: 'front', cap: CAP }], 'u3', '2222');
  assert.match(dup[0].error, /already has that PIN in slot 2/);

  const fixed = planUserSave(cfg, [{ lock_id: 'front', cap: Object.assign({}, CAP, { fixed_length: true, configured_length: 6 }) }], 'u3', '1234');
  assert.match(fixed[0].error, /6-digit codes/);

  const short = planUserSave(cfg, [{ lock_id: 'front', cap: Object.assign({}, CAP, { min_length: 6 }) }], 'u3', '4444');
  assert.match(short[0].error, /at least 6 digits/);

  const long = planUserSave(cfg, [{ lock_id: 'front', cap: Object.assign({}, CAP, { max_length: 4 }) }], 'u3', '55555');
  assert.match(long[0].error, /at most 4 digits/);

  const full = planUserSave(cfg, [{ lock_id: 'front', cap: Object.assign({}, CAP, { slots: 2 }) }], 'u3', '7777');
  assert.match(full[0].error, /all 2 code slots are in use/);

  const unsupported = planUserSave(cfg, [{ lock_id: 'front', cap: { supported: false, note: 'app-managed' } }], 'u3', '7777');
  assert.equal(unsupported[0].error, 'app-managed');

  // A mixed fleet proceeds on the lock that can take the code.
  const mixed = planUserSave(cfg, [
    { lock_id: 'front', cap: Object.assign({}, CAP, { slots: 2 }) },
    { lock_id: 'side', cap: CAP },
  ], 'u3', '7777');
  assert.ok(mixed[0].error);
  assert.deepEqual(mixed[1], { lock_id: 'side', slot: 2 });
});

test('planNewLockProvision: seeds users from other locks, skipping conflicts', () => {
  const cfg = locksCfg();
  cfg.newlock = { node_id: 22, user_codes: {} };
  const { assignments, skipped } = planNewLockProvision(cfg, 'newlock', Object.assign({}, CAP, { reserved_slots: [1] }), '2026-07-15T22:00:00Z');
  const entries = Object.entries(assignments);
  assert.equal(entries.length, 2, 'both users seeded');
  assert.ok(!assignments['1'], 'reserved slot skipped');
  const pins = entries.map(([, e]) => e.pin_code).sort();
  assert.deepEqual(pins, ['2222', '9999'], 'canonical PINs copied');
  const alice = entries.map(([, e]) => e).find((e) => e.user_id === 'u1');
  assert.equal(alice.pushed_to_unifi, true, 'inherits the UniFi sync state');
  assert.equal(alice.confirmed, null, 'pending until the write confirms');
  assert.equal(alice.updated_at, '2026-07-15T22:00:00Z');
  assert.equal(skipped.length, 0);
});

test('planNewLockProvision: existing users kept, length/duplicate/capacity skips reported', () => {
  const cfg = {
    front: {
      user_codes: {
        1: { user_id: 'u1', name: 'Alice', pin_code: '123456', updated_at: '2026-01-02T00:00:00Z' },
        2: { user_id: 'u2', name: 'Bob', pin_code: '2222', updated_at: '2026-01-02T00:00:00Z' },
        3: { user_id: 'u3', name: 'Cara', pin_code: '3333', updated_at: '2026-01-02T00:00:00Z' },
      },
    },
    newlock: {
      user_codes: {
        1: { user_id: 'u2', name: 'Bob', pin_code: '2222', updated_at: '2026-01-01T00:00:00Z' },
        2: { user_id: 'u9', name: 'Dee', pin_code: '3333', updated_at: '2026-01-01T00:00:00Z' },
      },
    },
  };
  const { assignments, skipped } = planNewLockProvision(cfg, 'newlock', Object.assign({}, CAP, { max_length: 4, slots: 3 }), null);
  assert.equal(Object.keys(assignments).length, 0, 'nothing assignable');
  const reasons = skipped.map((s) => `${s.user_id}:${s.reason}`).join('|');
  assert.match(reasons, /u1:.*maximum/, 'too-long PIN skipped');
  assert.match(reasons, /u3:.*another user already holds that PIN/, 'duplicate on the new lock skipped');
  assert.ok(!skipped.find((s) => s.user_id === 'u2'), 'user already on the new lock is not re-planned');
});

test('planNewLockProvision: unsupported capability plans nothing', () => {
  const { assignments, skipped } = planNewLockProvision(locksCfg(), 'newlock', { supported: false }, null);
  assert.deepEqual(assignments, {});
  assert.deepEqual(skipped, []);
});
