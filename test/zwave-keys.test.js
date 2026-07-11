'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { loadSecurityKeys, ensureSecurityKeys } = require('../src/drivers/zwave-keys');

const HEX_A = 'aa'.repeat(16);
const HEX_B = 'bb'.repeat(16);

test('config keys win over env for the same key, per key', () => {
  const zwCfg = { security_keys: { s2_access_control: HEX_A } };
  const env = { ZWAVE_S2_ACCESS_CONTROL: HEX_B, ZWAVE_S2_AUTHENTICATED: HEX_B };
  const { classic, missing } = loadSecurityKeys(zwCfg, env);
  assert.strictEqual(classic.S2_AccessControl.toString('hex'), HEX_A); // config wins
  assert.strictEqual(classic.S2_Authenticated.toString('hex'), HEX_B); // env fallback
  assert.deepStrictEqual(missing.sort(), ['s0_legacy', 's2_unauthenticated']);
});

test('all keys missing reports all four names', () => {
  const { classic, missing } = loadSecurityKeys({}, {});
  assert.deepStrictEqual(Object.keys(classic), []);
  assert.strictEqual(missing.length, 4);
});

test('invalid hex in config throws a readable error', () => {
  assert.throws(
    () => loadSecurityKeys({ security_keys: { s2_access_control: 'nothex' } }, {}),
    /32 hex characters/
  );
});

test('long-range keys come from env only', () => {
  const env = { ZWAVE_LR_S2_ACCESS_CONTROL: HEX_A };
  const { longRange } = loadSecurityKeys({ security_keys: {} }, env);
  assert.strictEqual(longRange.S2_AccessControl.toString('hex'), HEX_A);
  assert.strictEqual(longRange.S2_Authenticated, undefined);
});

test('ensureSecurityKeys generates only the missing keys and never touches existing ones', () => {
  const zwCfg = { security_keys: { s2_access_control: HEX_A } };
  const { keys, generated } = ensureSecurityKeys(zwCfg, {});
  // existing key byte-identical
  assert.strictEqual(keys.classic.S2_AccessControl.toString('hex'), HEX_A);
  assert.strictEqual('s2_access_control' in generated, false);
  // the three gaps generated as distinct 32-char hex
  const names = Object.keys(generated).sort();
  assert.deepStrictEqual(names, ['s0_legacy', 's2_authenticated', 's2_unauthenticated']);
  const values = Object.values(generated);
  for (const v of values) assert.match(v, /^[0-9a-f]{32}$/);
  assert.strictEqual(new Set(values).size, values.length); // mutually distinct
  // resolved set is now complete
  assert.strictEqual(Object.keys(keys.classic).length, 4);
});

test('ensureSecurityKeys is a no-op when the set is complete', () => {
  const zwCfg = {
    security_keys: {
      s2_access_control: HEX_A, s2_authenticated: HEX_A,
      s2_unauthenticated: HEX_A, s0_legacy: HEX_A,
    },
  };
  const { generated } = ensureSecurityKeys(zwCfg, {});
  assert.strictEqual(generated, null);
});
