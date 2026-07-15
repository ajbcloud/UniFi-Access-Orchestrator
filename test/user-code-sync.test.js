'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { planUnifiPinPush, markStaleAfterPush } = require('../src/user-code-sync');

// UniFi holds ONE PIN per user and errors on re-assigning the PIN it already
// holds (field: same user, same PIN saved to a second lock came back
// CODE_SYSTEM_ERROR). These decisions keep the per-lock PIN store honest.

function locks() {
  return {
    front_deadbolt: {
      user_codes: {
        1: { user_id: 'u1', pin_code: '1234', pushed_to_unifi: true },
      },
    },
    front_door: { user_codes: {} },
  };
}

test('same user + same pin already pushed elsewhere: skip, already in sync', () => {
  const plan = planUnifiPinPush(locks(), 'front_door', 'u1', '1234');
  assert.equal(plan.action, 'skip_in_sync');
  assert.equal(plan.source_lock, 'front_deadbolt');
});

test('re-saving an already-pushed pin on the SAME lock is also a no-op push', () => {
  const plan = planUnifiPinPush(locks(), 'front_deadbolt', 'u1', '1234');
  assert.equal(plan.action, 'skip_in_sync');
});

test('same user, different pin pushed elsewhere: push, and name the stale lock', () => {
  const plan = planUnifiPinPush(locks(), 'front_door', 'u1', '9999');
  assert.equal(plan.action, 'push');
  assert.deepEqual(plan.stale_locks, ['front_deadbolt']);
});

test('no prior pushed entries for the user: plain push', () => {
  const plan = planUnifiPinPush(locks(), 'front_door', 'u2', '4321');
  assert.equal(plan.action, 'push');
  assert.deepEqual(plan.stale_locks, []);
});

test('an un-pushed matching entry does not count as in sync', () => {
  const cfg = locks();
  cfg.front_deadbolt.user_codes[1].pushed_to_unifi = false;
  const plan = planUnifiPinPush(cfg, 'front_door', 'u1', '1234');
  assert.equal(plan.action, 'push');
});

test('markStaleAfterPush flips only other locks with a different pushed pin', () => {
  const cfg = {
    a: { user_codes: { 1: { user_id: 'u1', pin_code: '1111', pushed_to_unifi: true } } },
    b: { user_codes: { 2: { user_id: 'u1', pin_code: '2222', pushed_to_unifi: true } } },
    c: { user_codes: { 3: { user_id: 'u2', pin_code: '3333', pushed_to_unifi: true } } },
  };
  const touched = markStaleAfterPush(cfg, 'a', 'u1', '1111');
  assert.deepEqual(touched, ['b'], 'only the mismatching pushed entry goes stale');
  assert.equal(cfg.b.user_codes[2].pushed_to_unifi, false);
  assert.equal(cfg.a.user_codes[1].pushed_to_unifi, true, 'the pushing lock keeps its truth');
  assert.equal(cfg.c.user_codes[3].pushed_to_unifi, true, 'other users are untouched');
});

test('helpers tolerate empty/missing shapes', () => {
  assert.equal(planUnifiPinPush(undefined, 'x', 'u1', '1').action, 'push');
  assert.equal(planUnifiPinPush({}, 'x', 'u1', '1').action, 'push');
  assert.deepEqual(markStaleAfterPush({}, 'x', 'u1', '1'), []);
});
