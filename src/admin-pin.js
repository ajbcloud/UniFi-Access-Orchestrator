'use strict';

/**
 * Super-admin PIN helpers, kept pure so they are testable without booting the
 * server. The admin PIN gates sensitive keypad operations (add/change/delete a
 * user PIN) that any technician on the shared machine could otherwise perform.
 *
 * Storage: never the digits. A scrypt hash with a per-hash random salt lives in
 * config.security.admin_pin. Verification is constant-time. A short numeric PIN
 * over a local API is brute-forceable, so AdminPinGuard throttles failures.
 *
 * SCOPE: this is a UI AUTHORIZATION control, not a filesystem control. Someone
 * with access to the config folder can blank this hash to bypass the gate. See
 * docs/hardening.md for the OS-level protections that actually cover the files.
 */

const crypto = require('crypto');

// scrypt parameters. N=16384 (2^14) is the Node default work factor: strong for
// an offline attack yet fast enough for an interactive verify.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

// A valid admin PIN is 6 to 10 digits: stronger than the 4-10 digit user PINs,
// and still enterable on a numeric pad.
const ADMIN_PIN_RX = /^[0-9]{6,10}$/;

function isValidAdminPin(pin) {
  return typeof pin === 'string' && ADMIN_PIN_RX.test(pin);
}

// Hash a PIN into the stored shape. Salt is per-hash and random, so two admins
// choosing the same PIN never share a hash.
function hashAdminPin(pin) {
  if (!isValidAdminPin(pin)) throw new Error('admin PIN must be 6 to 10 digits');
  const salt = crypto.randomBytes(16);
  const params = { ...SCRYPT_PARAMS };
  const hash = crypto.scryptSync(pin, salt, params.keylen, {
    N: params.N, r: params.r, p: params.p,
  });
  return {
    algo: 'scrypt',
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    params,
    updated_at: new Date().toISOString(),
  };
}

// Constant-time verify of a candidate PIN against a stored record. Returns
// false for any malformed input or record rather than throwing, so callers can
// treat it as a plain boolean gate.
function verifyAdminPin(pin, stored) {
  if (typeof pin !== 'string' || !pin) return false;
  if (!stored || stored.algo !== 'scrypt' || typeof stored.salt !== 'string' || typeof stored.hash !== 'string') {
    return false;
  }
  const params = stored.params || SCRYPT_PARAMS;
  let candidate;
  try {
    candidate = crypto.scryptSync(pin, Buffer.from(stored.salt, 'hex'), params.keylen || 64, {
      N: params.N || SCRYPT_PARAMS.N, r: params.r || SCRYPT_PARAMS.r, p: params.p || SCRYPT_PARAMS.p,
    });
  } catch (_) {
    return false;
  }
  const expected = Buffer.from(stored.hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/**
 * In-memory brute-force throttle for admin-PIN attempts. Mirrors the small,
 * injectable-clock style of ReplayGuard. After `maxAttempts` consecutive
 * failures the guard locks for `lockoutMs`; a success clears the counter.
 *
 * Keyed so the same guard can protect more than one identity if needed; the app
 * uses a single key ('admin') since there is one shared admin PIN.
 */
class AdminPinGuard {
  constructor({ maxAttempts = 5, lockoutMs = 60000, now = () => Date.now() } = {}) {
    this.maxAttempts = maxAttempts;
    this.lockoutMs = lockoutMs;
    this.now = now;
    this.state = new Map(); // key -> { fails, lockedUntil }
  }

  _get(key) {
    let s = this.state.get(key);
    if (!s) { s = { fails: 0, lockedUntil: 0 }; this.state.set(key, s); }
    return s;
  }

  // True when the key is currently locked out (too many recent failures).
  isLocked(key = 'admin') {
    const s = this._get(key);
    return s.lockedUntil > this.now();
  }

  // Milliseconds remaining on an active lockout, else 0.
  retryAfterMs(key = 'admin') {
    const s = this._get(key);
    return Math.max(0, s.lockedUntil - this.now());
  }

  // Record a failed attempt; arms a lockout once the threshold is hit.
  recordFailure(key = 'admin') {
    const s = this._get(key);
    s.fails += 1;
    if (s.fails >= this.maxAttempts) {
      s.lockedUntil = this.now() + this.lockoutMs;
      s.fails = 0; // reset the counter; the lockout window is the penalty now
    }
  }

  // Clear all penalty state for a key after a correct PIN.
  recordSuccess(key = 'admin') {
    this.state.set(key, { fails: 0, lockedUntil: 0 });
  }
}

module.exports = {
  SCRYPT_PARAMS,
  ADMIN_PIN_RX,
  isValidAdminPin,
  hashAdminPin,
  verifyAdminPin,
  AdminPinGuard,
};
