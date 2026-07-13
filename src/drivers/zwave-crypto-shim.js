'use strict';

/**
 * Work around missing ciphers in Electron's crypto (BoringSSL).
 *
 * zwave-js encrypts/decrypts every S2 frame through its Node crypto backend,
 * which calls crypto.createCipheriv('aes-128-ccm', ...). Electron's embedded
 * Node is built on BoringSSL, which does not expose AES-CCM through that API,
 * so every S2 frame fails with "Error: Unknown cipher" and secure inclusion
 * can never complete (observed in the field: the lock always joined without
 * security after the S2 timer elapsed).
 *
 * zwave-js ships a second, portable crypto backend for browsers
 * (primitives.browser.js) that implements the same functions in pure JS over
 * WebCrypto, including an RFC 3610 AES-CCM composed from AES-CTR + CBC-MAC.
 * Electron's main process has globalThis.crypto.subtle, so that backend runs
 * there.
 *
 * install() feature-detects which ciphers the current runtime actually
 * supports, and when any are missing, swaps in a HYBRID primitives object:
 * the native backend for everything that works (hashes, HMAC, X25519 ECDH,
 * and any supported AES modes), the portable backend only for the functions
 * whose cipher is unavailable. The hybrid is injected into require.cache for
 * the resolved primitives.node.js path BEFORE zwave-js is required, so the
 * package's own `require("#crypto_primitives")` picks it up unchanged.
 *
 * On a real Node.js runtime (OpenSSL: headless installs, CI) every cipher is
 * present and install() is a no-op, which also lets CI verify byte-for-byte
 * that the portable implementations match the native ones.
 */

const crypto = require('crypto');
const path = require('path');

// @zwave-js/core's exports map blocks deep subpath requires, so the primitive
// modules are located relative to the package's resolved CJS entry point and
// loaded by absolute path (absolute paths bypass exports maps, and
// require.cache is keyed by absolute path, so the injection still matches
// what require("#crypto_primitives") resolves to).
function resolvePrimitivesPaths() {
  const coreEntry = require.resolve('@zwave-js/core'); // .../build/cjs/index.js
  const dir = path.join(path.dirname(coreEntry), 'crypto', 'primitives');
  return {
    nodePath: path.join(dir, 'primitives.node.js'),
    browserPath: path.join(dir, 'primitives.browser.js'),
  };
}

// Function names in the primitives object, grouped by the cipher they need.
const CIPHER_DEPENDENTS = {
  'aes-128-ecb': ['encryptAES128ECB'],
  'aes-128-cbc': ['encryptAES128CBC'],
  'aes-128-ofb': ['encryptAES128OFB', 'decryptAES128OFB'],
  'aes-256-cbc': ['decryptAES256CBC'],
  'aes-128-ccm': ['encryptAES128CCM', 'decryptAES128CCM'],
  'chacha20-poly1305': ['encryptChaCha20Poly1305', 'decryptChaCha20Poly1305'],
};

// Probe parameters that satisfy each algorithm's key/iv requirements.
const PROBES = {
  'aes-128-ecb': () => crypto.createCipheriv('aes-128-ecb', Buffer.alloc(16), Buffer.alloc(0)),
  'aes-128-cbc': () => crypto.createCipheriv('aes-128-cbc', Buffer.alloc(16), Buffer.alloc(16)),
  'aes-128-ofb': () => crypto.createCipheriv('aes-128-ofb', Buffer.alloc(16), Buffer.alloc(16)),
  'aes-256-cbc': () => crypto.createCipheriv('aes-256-cbc', Buffer.alloc(32), Buffer.alloc(16)),
  'aes-128-ccm': () => crypto.createCipheriv('aes-128-ccm', Buffer.alloc(16), Buffer.alloc(13), { authTagLength: 8 }),
  'chacha20-poly1305': () => crypto.createCipheriv('chacha20-poly1305', Buffer.alloc(32), Buffer.alloc(12), { authTagLength: 16 }),
};

function detectMissingCiphers() {
  const missing = [];
  for (const [algorithm, probe] of Object.entries(PROBES)) {
    try {
      probe();
    } catch (e) {
      missing.push(algorithm);
    }
  }
  return missing;
}

let _result = null; // memoized: the swap must happen at most once per process

/**
 * Install the hybrid primitives when the runtime lacks ciphers zwave-js
 * needs. Must run BEFORE the first require('zwave-js'). Idempotent. Never
 * throws: on any failure it reports { patched: [], error } and leaves the
 * stock behavior in place.
 *
 * deps.detect is injectable for tests.
 */
function install(deps = {}) {
  if (_result) return _result;
  const detect = deps.detect || detectMissingCiphers;

  let missing;
  try {
    missing = detect();
  } catch (e) {
    _result = { patched: [], error: `cipher detection failed: ${e.message}` };
    return _result;
  }
  if (!missing.length) {
    _result = { patched: [] };
    return _result;
  }

  try {
    const { nodePath, browserPath } = resolvePrimitivesPaths();
    const nodePrimitives = require(nodePath).primitives;
    const browserPrimitives = require(browserPath).primitives;

    const hybrid = Object.assign({}, nodePrimitives);
    const replacedFns = [];
    for (const algorithm of missing) {
      for (const fnName of CIPHER_DEPENDENTS[algorithm] || []) {
        if (typeof browserPrimitives[fnName] === 'function') {
          hybrid[fnName] = browserPrimitives[fnName];
          replacedFns.push(fnName);
        }
      }
    }

    // Replace the cached module so the package's own
    // require("#crypto_primitives") (which resolves to nodePath under the
    // require condition) hands out the hybrid from now on.
    const Module = require('module');
    const injected = new Module(nodePath, null);
    injected.filename = nodePath;
    injected.loaded = true;
    injected.exports = { primitives: hybrid };
    require.cache[nodePath] = injected;

    _result = { patched: missing, replaced_functions: replacedFns };
  } catch (e) {
    // zwave-js not installed in this build, or an unexpected layout change.
    _result = { patched: [], error: e.message };
  }
  return _result;
}

// Test-only: forget the memoized result so install() can run again.
function _resetForTests() {
  _result = null;
}

module.exports = { install, detectMissingCiphers, resolvePrimitivesPaths, _resetForTests, CIPHER_DEPENDENTS };
