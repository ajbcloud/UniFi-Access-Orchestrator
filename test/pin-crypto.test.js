'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const {
  isEnvelope,
  encryptPin,
  decryptPin,
  encryptConfigPins,
  decryptConfigPins,
} = require('../src/pin-crypto');

const KEY = crypto.randomBytes(32);

// ---------------------------------------------------------------------------
// single-value round trip
// ---------------------------------------------------------------------------

test('encryptPin/decryptPin round-trip a PIN', () => {
  const env = encryptPin('482913', KEY);
  assert.strictEqual(isEnvelope(env), true);
  assert.ok(!JSON.stringify(env).includes('482913'), 'ciphertext does not contain the digits');
  assert.strictEqual(decryptPin(env, KEY), '482913');
});

test('empty and null PINs pass through unchanged', () => {
  assert.strictEqual(encryptPin('', KEY), '');
  assert.strictEqual(encryptPin(null, KEY), null);
  assert.strictEqual(decryptPin('', KEY), '');
});

test('decryptPin returns bare strings (legacy cleartext) untouched', () => {
  assert.strictEqual(decryptPin('1234', KEY), '1234');
});

test('a tampered envelope is rejected, never returned as a PIN', () => {
  const env = encryptPin('999999', KEY);
  const bad = Object.assign({}, env, { ct: Buffer.from('deadbeef', 'hex').toString('base64') });
  assert.throws(() => decryptPin(bad, KEY), /.*/);
  // wrong key also fails the auth tag
  assert.throws(() => decryptPin(env, crypto.randomBytes(32)), /.*/);
});

test('encrypt/decrypt require a 32-byte key', () => {
  assert.throws(() => encryptPin('123456', Buffer.alloc(16)), /32-byte key/);
});

// ---------------------------------------------------------------------------
// whole-config walkers (the write/load boundary)
// ---------------------------------------------------------------------------

function sampleConfig() {
  return {
    devices: { zwave: { locks: {
      front: { user_codes: { 1: { user_id: 'u1', pin_code: '1111' }, 2: { user_id: 'u2', pin_code: '2222' } } },
      back: { user_codes: { 1: { user_id: 'u1', pin_code: '1111' } } },
    } } },
    unifi_pin_state: { u1: { pin_code: '1111', updated_at: 'x' } },
  };
}

test('encryptConfigPins clones (never mutates) and encrypts every pin_code', () => {
  const cfg = sampleConfig();
  const enc = encryptConfigPins(cfg, KEY);
  // original stays cleartext (the live in-memory config must not change)
  assert.strictEqual(cfg.devices.zwave.locks.front.user_codes[1].pin_code, '1111');
  assert.strictEqual(cfg.unifi_pin_state.u1.pin_code, '1111');
  // clone is encrypted at both user_codes and unifi_pin_state
  assert.strictEqual(isEnvelope(enc.devices.zwave.locks.front.user_codes[1].pin_code), true);
  assert.strictEqual(isEnvelope(enc.devices.zwave.locks.back.user_codes[1].pin_code), true);
  assert.strictEqual(isEnvelope(enc.unifi_pin_state.u1.pin_code), true);
});

test('decryptConfigPins restores cleartext in place (full round trip)', () => {
  const cfg = sampleConfig();
  const enc = encryptConfigPins(cfg, KEY);
  decryptConfigPins(enc, KEY);
  assert.strictEqual(enc.devices.zwave.locks.front.user_codes[1].pin_code, '1111');
  assert.strictEqual(enc.devices.zwave.locks.front.user_codes[2].pin_code, '2222');
  assert.strictEqual(enc.unifi_pin_state.u1.pin_code, '1111');
});

test('encryptConfigPins is idempotent: already-encrypted values are not double-wrapped', () => {
  const cfg = sampleConfig();
  const once = encryptConfigPins(cfg, KEY);
  const twice = encryptConfigPins(once, KEY);
  // still a single-layer envelope that decrypts to the original PIN
  const env = twice.devices.zwave.locks.front.user_codes[1].pin_code;
  assert.strictEqual(isEnvelope(env), true);
  assert.strictEqual(decryptPin(env, KEY), '1111');
});

test('decryptConfigPins leaves a legacy cleartext file untouched (transparent migration)', () => {
  const legacy = sampleConfig(); // bare-string pin_codes, as an old file has
  decryptConfigPins(legacy, KEY);
  assert.strictEqual(legacy.devices.zwave.locks.front.user_codes[1].pin_code, '1111');
  // and the first encrypt-on-write migrates it forward
  const enc = encryptConfigPins(legacy, KEY);
  assert.strictEqual(isEnvelope(enc.devices.zwave.locks.front.user_codes[1].pin_code), true);
});
