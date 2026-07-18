'use strict';

/**
 * Data-encryption key (DEK) lifecycle for at-rest PIN encryption.
 *
 * The DEK is a random 32-byte key used by pin-crypto.js to encrypt keypad PINs
 * in config.json. It is stored in a sidecar keyfile (secret.key) next to the
 * config, written owner-only (0600) with the same atomic temp+rename discipline
 * as the config itself.
 *
 * Why a keyfile and not the OS keychain: the app must decrypt PINs unattended
 * after an unprompted restart (to reconcile locks and push to UniFi), so the key
 * cannot be gated behind an interactive credential. Electron's safeStorage would
 * bind the key to the desktop OS user, but that helps only against a DIFFERENT
 * OS user reading the file (exactly the case a shared login rules out), and it
 * has no headless/Raspberry Pi equivalent. Keeping a raw 0600 keyfile is honest
 * about what this protects (casual file browsing) and avoids a cross-environment
 * key-loss trap. The real file protection is OS-level (see docs/hardening.md).
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const KEY_BYTES = 32; // AES-256

function keyPathFor(configPath) {
  return path.join(path.dirname(configPath), 'secret.key');
}

function writeKeyFile(keyPath, keyBuf) {
  const body = JSON.stringify({ v: 1, wrapped: false, key: keyBuf.toString('base64') });
  const tmp = `${keyPath}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, keyPath);
}

/**
 * Load the DEK from keyPath, or create and persist a new one if absent. Returns
 * a 32-byte Buffer. Throws if an existing keyfile is present but unreadable or
 * malformed, rather than silently minting a new key, because a new key orphans
 * every PIN already encrypted under the old one (unrecoverable data loss).
 */
function loadOrCreateKey(keyPath) {
  if (fs.existsSync(keyPath)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    } catch (e) {
      throw new Error(`secret.key is present but unreadable (${e.message}); refusing to overwrite it and lose encrypted PINs`);
    }
    const buf = Buffer.from(String(parsed.key || ''), 'base64');
    if (buf.length !== KEY_BYTES) {
      throw new Error('secret.key is present but malformed (wrong key length); refusing to overwrite it and lose encrypted PINs');
    }
    return buf;
  }
  const keyBuf = crypto.randomBytes(KEY_BYTES);
  writeKeyFile(keyPath, keyBuf);
  return keyBuf;
}

module.exports = {
  KEY_BYTES,
  keyPathFor,
  loadOrCreateKey,
};
