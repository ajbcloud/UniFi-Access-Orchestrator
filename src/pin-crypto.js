'use strict';

/**
 * At-rest PIN encryption, kept pure so it is testable without the app.
 *
 * The app keeps keypad PINs in cleartext IN MEMORY (every planner in
 * keypad-users.js / user-code-sync.js compares String(pin_code)), but the
 * persisted config.json must not carry the digits in the clear. Encryption is
 * therefore applied at exactly one boundary: writeConfigFile encrypts a clone
 * on the way to disk, loadConfig decrypts in place on the way back. Nothing
 * else in the app has to change, and an old cleartext file migrates forward the
 * first time it is written.
 *
 * HONEST LIMIT: because the app runs unattended (it reconciles locks and pushes
 * PINs after an unprompted restart), the data-encryption key lives on the same
 * device (see secret-store.js). This defeats casual file browsing, NOT a
 * determined local user on a shared OS account. It is obfuscation at rest, not
 * a substitute for OS-level file protection.
 *
 * Envelope shape (what lands on disk in place of a bare pin_code string):
 *   { "enc": "gcm", "iv": <base64>, "tag": <base64>, "ct": <base64> }
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length

// True when v is a pin_code envelope produced by encryptPin (not a bare string).
function isEnvelope(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && v.enc === 'gcm' && typeof v.iv === 'string'
    && typeof v.tag === 'string' && typeof v.ct === 'string';
}

// Encrypt one PIN string into an envelope. key must be a 32-byte Buffer.
// An empty/nullish PIN returns as-is so "unset" round-trips unchanged.
function encryptPin(plain, key) {
  if (plain === '' || plain == null) return plain;
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('encryptPin requires a 32-byte key');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: 'gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

// Decrypt an envelope back to the cleartext PIN. key must be the same 32-byte
// Buffer used to encrypt. A tampered envelope (wrong tag) throws, so a silently
// corrupted or forged value is never returned as if it were a real PIN.
function decryptPin(envelope, key) {
  if (!isEnvelope(envelope)) return envelope; // legacy cleartext or already-plain
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('decryptPin requires a 32-byte key');
  }
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return out.toString('utf8');
}

// Walk any object/array and apply fn to every value stored under a key named
// exactly "pin_code". Mutates in place. This is the single place that knows
// PINs live under user_codes[*].pin_code AND unifi_pin_state[*].pin_code; a
// name-based sweep covers both without hard-coding either path.
function walkPinCodes(node, fn) {
  if (Array.isArray(node)) {
    for (const item of node) walkPinCodes(item, fn);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'pin_code') {
        node[k] = fn(v);
      } else {
        walkPinCodes(v, fn);
      }
    }
  }
}

// Return a deep clone of config with every cleartext pin_code encrypted. Values
// that are already envelopes are left untouched (idempotent), so a mixed object
// (a freshly mutated slot next to still-encrypted siblings) encrypts cleanly.
// Never mutates the input, because callers pass the LIVE in-memory config, which
// must stay cleartext.
function encryptConfigPins(config, key) {
  const clone = JSON.parse(JSON.stringify(config));
  walkPinCodes(clone, (v) => (isEnvelope(v) ? v : encryptPin(v, key)));
  return clone;
}

// Decrypt every pin_code envelope in config IN PLACE. Bare strings (legacy
// cleartext) are left as-is, which is what makes an old file migrate forward
// transparently. Intended for a freshly JSON.parse'd object the caller owns.
function decryptConfigPins(config, key) {
  walkPinCodes(config, (v) => (isEnvelope(v) ? decryptPin(v, key) : v));
  return config;
}

module.exports = {
  ALGO,
  isEnvelope,
  encryptPin,
  decryptPin,
  encryptConfigPins,
  decryptConfigPins,
};
