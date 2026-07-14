'use strict';

// Guards the Electron crypto shim. The packaged app runs on Electron's
// BoringSSL-backed Node, which lacks aes-128-ccm, so every S2 frame failed
// with "Unknown cipher" and secure inclusion could never complete. The shim
// substitutes zwave-js's own portable (browser) implementations for exactly
// the missing ciphers. CI runs on real Node where every cipher exists, which
// lets these tests prove byte-for-byte that the portable implementations
// produce identical results to the native ones.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const shim = require('../src/drivers/zwave-crypto-shim');

const { nodePath: NODE_PRIMS_PATH, browserPath: BROWSER_PRIMS_PATH } = shim.resolvePrimitivesPaths();
const nodePrimitives = require(NODE_PRIMS_PATH).primitives;
const browserPrimitives = require(BROWSER_PRIMS_PATH).primitives;

function eq(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

// ---------------------------------------------------------------------------
// Portable CCM must match native CCM exactly (S2 uses 13-byte nonces and
// 8- or 16-byte auth tags)
// ---------------------------------------------------------------------------

test('portable AES-128-CCM matches native output on random vectors', async () => {
  for (const authTagLength of [8, 16]) {
    for (let i = 0; i < 10; i++) {
      const key = crypto.randomBytes(16);
      const iv = crypto.randomBytes(13);
      const aad = crypto.randomBytes(1 + Math.floor(Math.random() * 40));
      const plaintext = crypto.randomBytes(1 + Math.floor(Math.random() * 60));

      const native = await nodePrimitives.encryptAES128CCM(plaintext, key, iv, aad, authTagLength);
      const portable = await browserPrimitives.encryptAES128CCM(plaintext, key, iv, aad, authTagLength);

      assert.ok(eq(native.ciphertext, portable.ciphertext), `ciphertext mismatch (tag ${authTagLength}, run ${i})`);
      assert.ok(eq(native.authTag, portable.authTag), `authTag mismatch (tag ${authTagLength}, run ${i})`);
    }
  }
});

test('portable CCM decrypts native ciphertext and vice versa (interop)', async () => {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(13);
  const aad = crypto.randomBytes(16);
  const plaintext = Buffer.from('unlock the front door, securely');

  const native = await nodePrimitives.encryptAES128CCM(plaintext, key, iv, aad, 8);
  const viaPortable = await browserPrimitives.decryptAES128CCM(native.ciphertext, key, iv, aad, native.authTag);
  assert.strictEqual(viaPortable.authOK, true, 'portable must authenticate native ciphertext');
  assert.ok(eq(viaPortable.plaintext, plaintext));

  const portable = await browserPrimitives.encryptAES128CCM(plaintext, key, iv, aad, 8);
  const viaNative = await nodePrimitives.decryptAES128CCM(portable.ciphertext, key, iv, aad, portable.authTag);
  assert.strictEqual(viaNative.authOK, true, 'native must authenticate portable ciphertext');
  assert.ok(eq(viaNative.plaintext, plaintext));
});

test('portable CCM rejects a tampered auth tag', async () => {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(13);
  const aad = crypto.randomBytes(8);
  const plaintext = crypto.randomBytes(24);
  const { ciphertext, authTag } = await browserPrimitives.encryptAES128CCM(plaintext, key, iv, aad, 8);
  const badTag = Buffer.from(authTag);
  badTag[0] ^= 0xff;
  const res = await browserPrimitives.decryptAES128CCM(ciphertext, key, iv, aad, badTag);
  assert.strictEqual(res.authOK, false);
});

// ---------------------------------------------------------------------------
// install() behavior
// ---------------------------------------------------------------------------

test('install is a no-op when the runtime has every cipher (real Node)', () => {
  shim._resetForTests();
  const res = shim.install();
  assert.deepStrictEqual(res.patched, []);
  assert.strictEqual(res.error, undefined);
  // the module cache still holds the ORIGINAL node primitives
  assert.strictEqual(require(NODE_PRIMS_PATH).primitives.encryptAES128CCM, nodePrimitives.encryptAES128CCM);
});

test('install swaps only the functions of missing ciphers (simulated Electron)', () => {
  shim._resetForTests();
  const originalCache = require.cache[NODE_PRIMS_PATH];
  try {
    const res = shim.install({ detect: () => ['aes-128-ccm'] });
    assert.deepStrictEqual(res.patched, ['aes-128-ccm']);
    assert.deepStrictEqual(res.replaced_functions, ['encryptAES128CCM', 'decryptAES128CCM']);

    // A fresh require of the node-primitives path yields the hybrid:
    const hybrid = require(NODE_PRIMS_PATH).primitives;
    assert.strictEqual(hybrid.encryptAES128CCM, browserPrimitives.encryptAES128CCM, 'CCM encrypt replaced');
    assert.strictEqual(hybrid.decryptAES128CCM, browserPrimitives.decryptAES128CCM, 'CCM decrypt replaced');
    // ...while everything else stays native (ECDH worked in the field):
    assert.strictEqual(hybrid.generateECDHKeyPair, nodePrimitives.generateECDHKeyPair, 'ECDH stays native');
    assert.strictEqual(hybrid.encryptAES128ECB, nodePrimitives.encryptAES128ECB, 'ECB stays native');
  } finally {
    // restore the pristine module cache for other tests
    if (originalCache) require.cache[NODE_PRIMS_PATH] = originalCache;
    else delete require.cache[NODE_PRIMS_PATH];
    shim._resetForTests();
  }
});

test('install is memoized and never throws on detector failure', () => {
  shim._resetForTests();
  const res1 = shim.install({ detect: () => { throw new Error('boom'); } });
  assert.deepStrictEqual(res1.patched, []);
  assert.match(res1.error, /boom/);
  // memoized: a second call returns the same result without re-detecting
  const res2 = shim.install({ detect: () => ['aes-128-ccm'] });
  assert.strictEqual(res2, res1);
  shim._resetForTests();
});

// S0 (Security CC) primitive coverage pin. The Yale YRD256 joins at S0, whose
// crypto path uses OFB (payload), CBC (computeMAC), and ECB (key derivation +
// nonce DRBG). If a future edit drops any of these from the shim's dependents
// map, an Electron runtime missing that cipher would brick S0 joins with the
// same "Unknown cipher" failure the shim was built to prevent for S2.
test('shim dependents cover every primitive the S0 path needs', () => {
  const deps = shim.CIPHER_DEPENDENTS;
  assert.ok(deps['aes-128-ofb'].includes('encryptAES128OFB'));
  assert.ok(deps['aes-128-ofb'].includes('decryptAES128OFB'));
  assert.ok(deps['aes-128-cbc'].includes('encryptAES128CBC'));
  assert.ok(deps['aes-128-ecb'].includes('encryptAES128ECB'));
});
