'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  isValidAdminPin,
  hashAdminPin,
  verifyAdminPin,
  AdminPinGuard,
} = require('../src/admin-pin');

// ---------------------------------------------------------------------------
// format rule: 6 to 10 digits (stronger than the 4-10 user PINs)
// ---------------------------------------------------------------------------

test('isValidAdminPin enforces 6 to 10 digits', () => {
  assert.strictEqual(isValidAdminPin('123456'), true);
  assert.strictEqual(isValidAdminPin('1234567890'), true);
  assert.strictEqual(isValidAdminPin('12345'), false, 'too short');
  assert.strictEqual(isValidAdminPin('12345678901'), false, 'too long');
  assert.strictEqual(isValidAdminPin('12ab56'), false, 'non-numeric');
  assert.strictEqual(isValidAdminPin(''), false);
  assert.strictEqual(isValidAdminPin(123456), false, 'non-string');
  assert.strictEqual(isValidAdminPin(null), false);
});

// ---------------------------------------------------------------------------
// hash + verify
// ---------------------------------------------------------------------------

test('hashAdminPin produces a salted scrypt record that never stores the digits', () => {
  const rec = hashAdminPin('246810');
  assert.strictEqual(rec.algo, 'scrypt');
  assert.ok(rec.salt && rec.hash, 'salt and hash present');
  assert.ok(!JSON.stringify(rec).includes('246810'), 'the PIN itself is never stored');
  // per-hash random salt: same PIN twice yields different salt+hash
  const rec2 = hashAdminPin('246810');
  assert.notStrictEqual(rec.salt, rec2.salt);
  assert.notStrictEqual(rec.hash, rec2.hash);
});

test('hashAdminPin refuses an invalid PIN', () => {
  assert.throws(() => hashAdminPin('12345'), /6 to 10 digits/);
});

test('verifyAdminPin accepts the right PIN and rejects everything else', () => {
  const rec = hashAdminPin('778899');
  assert.strictEqual(verifyAdminPin('778899', rec), true);
  assert.strictEqual(verifyAdminPin('778890', rec), false);
  assert.strictEqual(verifyAdminPin('', rec), false);
  assert.strictEqual(verifyAdminPin('778899', null), false, 'no record');
  assert.strictEqual(verifyAdminPin('778899', { algo: 'md5' }), false, 'unknown algo');
  assert.strictEqual(verifyAdminPin(undefined, rec), false);
});

// ---------------------------------------------------------------------------
// AdminPinGuard: brute-force throttle
// ---------------------------------------------------------------------------

test('AdminPinGuard locks out after maxAttempts and clears on success', () => {
  let now = 1000;
  const g = new AdminPinGuard({ maxAttempts: 3, lockoutMs: 5000, now: () => now });
  assert.strictEqual(g.isLocked(), false);
  g.recordFailure();
  g.recordFailure();
  assert.strictEqual(g.isLocked(), false, 'still open below the threshold');
  g.recordFailure(); // third failure trips the lock
  assert.strictEqual(g.isLocked(), true);
  assert.ok(g.retryAfterMs() > 0 && g.retryAfterMs() <= 5000);

  // still locked before the window elapses
  now += 4000;
  assert.strictEqual(g.isLocked(), true);
  // window elapsed -> open again
  now += 2000;
  assert.strictEqual(g.isLocked(), false);
  assert.strictEqual(g.retryAfterMs(), 0);
});

test('AdminPinGuard.recordSuccess resets the failure counter', () => {
  let now = 0;
  const g = new AdminPinGuard({ maxAttempts: 3, lockoutMs: 5000, now: () => now });
  g.recordFailure();
  g.recordFailure();
  g.recordSuccess();
  g.recordFailure();
  g.recordFailure();
  assert.strictEqual(g.isLocked(), false, 'counter reset, so two more fails do not lock');
});
